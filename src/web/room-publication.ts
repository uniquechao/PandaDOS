import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { IssueId } from '../../shared/issue-id';
import type { RoomIssueDraft, RoomSnapshot } from '../../shared/rooms';
import { projectAgentSupport } from '../core/executors';
import { ProjectMemberStore } from '../core/members';
import type { EngineIssue, IssueEngine } from '../issues/engine';
import { getProject } from '../issues/engine';
import { RoomError, type RoomCommandMeta, type RoomScope, type RoomService } from '../rooms/contracts';
import { ResourceDrain, type DrainResult } from '../rooms/lifecycle';
import { roomDiagnostics } from '../rooms/observability';

interface PublicationRow { request_digest: string; issue_id: IssueId; room_id: string }

/** Uses the existing issue creation transaction; neither preview nor Room models can publish. */
export class RoomPublicationService {
  private readonly flights=new Map<string,{digest:string;promise:Promise<EngineIssue>}>();
  private readonly scheduling = new Map<number, Promise<void>>();
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly drain = new ResourceDrain();
  constructor(private readonly deps: { db: Database; rooms: RoomService; issues: Pick<IssueEngine, 'createIssue' | 'scheduleNext'>; responseTimeoutMs?:number }) {}

  start(): void {
    if (this.recoveryTimer || this.stopped) return;
    const recover = () => { void this.recoverPending().catch(() => { roomDiagnostics.record({phase:'scheduler',outcome:'failed',code:'storage_error'}); }); };
    this.recoveryTimer = setInterval(recover, 30_000);
    this.recoveryTimer.unref?.();
    recover();
  }

  stop(waitMs = 5_000): Promise<DrainResult> {
    this.stopped = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    return this.drain.close(waitMs);
  }

  private schedule(projectId: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const existing = this.scheduling.get(projectId);
    if (existing) return existing;
    const pending = Promise.resolve().then(() => {
      if (!this.stopped) return this.deps.issues.scheduleNext(projectId, { source: 'publication' });
    }).catch(() => {
      // The committed publication is a durable scheduling intent; recovery retries it.
      roomDiagnostics.record({phase:'scheduler',outcome:'failed',code:'runtime_failed'});
    }).finally(() => { this.scheduling.delete(projectId); });
    this.scheduling.set(projectId, pending);
    this.drain.track(pending);
    return pending;
  }

  async recoverPending(): Promise<void> {
    if (this.stopped) return;
    const projects = this.deps.db.query<{ project_id: number }, []>(
      `SELECT DISTINCT publication.project_id FROM room_issue_publications publication
       JOIN issues issue ON issue.id=publication.issue_id AND issue.project_id=publication.project_id
       JOIN projects project ON project.id=publication.project_id
       WHERE issue.status='pending' AND project.status='active'`,
    ).all();
    await Promise.all(projects.map(project => this.schedule(project.project_id)));
  }

  private authorize(scope: RoomScope, actorId: number): void {
    if (this.stopped) throw new RoomError('unavailable');
    const project = getProject(this.deps.db, scope.projectId);
    const user = this.deps.db.query<{ role: string }, [number]>('SELECT role FROM users WHERE id=?').get(actorId);
    if (!project || !user || (user.role !== 'admin' && project.ownerUserId !== actorId && !new ProjectMemberStore(this.deps.db).isMember(scope.projectId, actorId))) throw new RoomError('forbidden');
    if (project.status !== 'active') throw new RoomError('state_conflict');
  }

  preview(scope: RoomScope, artifactId: string, version: number): RoomIssueDraft {
    const snapshot = this.deps.rooms.snapshot(scope);
    const artifact = snapshot.artifacts.find(a => a.id === artifactId);
    const revision = artifact?.versions.find(v => v.version === version);
    if (!artifact || !revision) throw new RoomError('not_found');
    // The original deliverable is preserved exactly. The user can reduce the execution scope.
    return { artifactId, artifactVersion: version, title: revision.title, body: revision.markdown, moduleId: null, agent: projectAgentSupport(this.deps.db, scope.projectId, 'claude').ok ? 'claude' : 'codex' };
  }

  async publish(scope: RoomScope, draft: RoomIssueDraft, expectedVersion: number, meta: RoomCommandMeta): Promise<{ issueId: IssueId; snapshot: RoomSnapshot }> {
    const { db, rooms, issues } = this.deps;
    this.authorize(scope, meta.actor.userId);
    const requestDigest = createHash('sha256').update(JSON.stringify({ roomId: scope.roomId, expectedVersion, artifactId: draft.artifactId, artifactVersion: draft.artifactVersion, title: draft.title, body: draft.body, moduleId: draft.moduleId ?? null, agent: draft.agent ?? 'claude' })).digest('hex');
    const replay = (): IssueId | null => {
      const row = db.query<PublicationRow, [number, number, string]>('SELECT request_digest,issue_id,room_id FROM room_issue_publications WHERE project_id=? AND actor_user_id=? AND idempotency_key=?').get(scope.projectId, meta.actor.userId, meta.key);
      if (!row) return null;
      if (row.request_digest !== requestDigest || row.room_id !== scope.roomId) throw new RoomError('idempotency_conflict');
      return row.issue_id;
    };
    const existing = replay();
    if (existing) {
      void this.schedule(scope.projectId);
      return { issueId: existing, snapshot: rooms.snapshot(scope) };
    }
    const validateExecution = () => {
      let agent=draft.agent ?? 'claude';
      if(draft.moduleId!=null){
        const module=db.query<{agent:'claude'|'codex';status:string},[number,number]>('SELECT agent,status FROM project_modules WHERE id=? AND project_id=?').get(draft.moduleId,scope.projectId);
        if(!module || module.status!=='active')throw new RoomError('invalid_request');
        if(draft.agent && draft.agent!==module.agent)throw new RoomError('conflict');
        agent=module.agent;
      }
      if(!projectAgentSupport(db,scope.projectId,agent).ok)throw new RoomError('unavailable');
      return agent;
    };
    const guard = () => {
      this.authorize(scope, meta.actor.userId);
      validateExecution();
      const snapshot = rooms.snapshot(scope);
      if (snapshot.room.status !== 'active' || !snapshot.mission || snapshot.mission.version !== expectedVersion) throw new RoomError('conflict');
      const artifact = snapshot.artifacts.find(a => a.id === draft.artifactId);
      if (!artifact || !artifact.versions.some(v => v.version === draft.artifactVersion)) throw new RoomError('not_found');
      return artifact;
    };
    guard();
    if (!draft.title.trim() || draft.title.length > 200 || !draft.body.trim() || draft.body.length > 8_000) throw new RoomError('invalid_request');
    const agent=validateExecution();
    const flightKey=`${scope.projectId}:${meta.actor.userId}:${meta.key}`;
    let flight=this.flights.get(flightKey);
    if(flight && flight.digest!==requestDigest)throw new RoomError('idempotency_conflict');
    let issueId: IssueId;
    try {
      if(!flight){
        const promise=issues.createIssue(scope.projectId, {
        title: draft.title, body: draft.body, category: 'task', implMode: 'seq', agent,
        createdBy: meta.actor.userId, ...(draft.moduleId == null ? {} : { moduleId: draft.moduleId }),
      }, false, created => {
        if (replay()) throw new RoomError('conflict'); // Rolls back a racing duplicate insert.
        const artifact = guard();
        if(!projectAgentSupport(db,scope.projectId,created.agent).ok)throw new RoomError('unavailable');
        rooms.linkIssue(scope, { missionId: artifact.missionId, artifactId: artifact.id, artifactVersion: draft.artifactVersion, issueId: created.id, title: created.title }, `${meta.actor.userId}:${meta.key}`, meta.actor.userId);
        db.query('INSERT INTO room_issue_publications(project_id,room_id,actor_user_id,idempotency_key,request_digest,issue_id,mission_id,artifact_id,artifact_version,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?)').run(scope.projectId, scope.roomId, meta.actor.userId, meta.key, requestDigest, created.id, artifact.missionId, artifact.id, draft.artifactVersion, Date.now());
        });
        this.drain.track(promise);
        flight={digest:requestDigest,promise};this.flights.set(flightKey,flight);
        const clear=()=>this.flights.delete(flightKey);void promise.then(clear,clear);
      }
      let timeout:ReturnType<typeof setTimeout>|undefined;
      const issue = await Promise.race([
        flight.promise,
        new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new RoomError('publication_pending')),this.deps.responseTimeoutMs??10_000);}),
      ]).finally(()=>{if(timeout)clearTimeout(timeout);});
      issueId = issue.id;
    } catch (error) {
      if (this.stopped) throw new RoomError('unavailable');
      // Creation may commit before a module projection fails. Never duplicate the persisted issue.
      const committed = replay();
      if (!committed) throw error;
      issueId = committed;
    }
    // The issue was authorized and committed atomically. Its execution intent
    // survives a later membership change; response visibility is checked separately.
    void this.schedule(scope.projectId);
    this.authorize(scope,meta.actor.userId);
    return { issueId, snapshot: rooms.snapshot(scope) };
  }
}

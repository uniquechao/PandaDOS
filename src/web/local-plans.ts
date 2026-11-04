import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { LocalPlanStore } from '../core/local-plans';
import { ProjectMemberStore } from '../core/members';
import { projectAgentSupport } from '../core/executors';
import type { Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { getProject, type DesignIssueDraft, type IssueEngine } from '../issues/engine';
import { ResourceDrain, type DrainResult } from '../rooms/lifecycle';
import { MAX_PLAN_BYTES, parseLocalPlan, type LocalPlan } from '../../shared/local-plan-format.mjs';
import type { LocalPlanCandidate, LocalPlanEffect, LocalPlanExecution, LocalPlansView } from '../../shared/local-plans';

export type LocalPlanDriver = Pick<ExecutorDriver, 'readFileNoFollowWithin' | 'listDirectoryNoFollowWithin'>;
export type LocalPlanEngine = Pick<IssueEngine, 'prepareIssueBatch' | 'commitPreparedDesignBatch' | 'completeDesignBatch' | 'scheduleNext'>;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,139}\.md$/;
const MAX_FILES = 100;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const digestOf = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

export class LocalPlanError extends Error {
  constructor(readonly code: 'invalid' | 'changed' | 'published' | 'unavailable' | 'forbidden' | 'not_found', readonly details?: string) {
    super(code);
  }
}

/** File discovery never creates issues. Publication owns one atomic batch and a durable effect outbox. */
export class LocalPlanService {
  readonly store: LocalPlanStore;
  private readonly drain = new ResourceDrain();
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private recovery?: Promise<void>;
  private readonly scans = new Map<number, Promise<LocalPlanCandidate[]>>();
  private readonly effects = new Map<string, Promise<void>>();
  private readonly cache = new Map<number, { cwd: string; executorId: number; ts: number; candidates: LocalPlanCandidate[] }>();

  constructor(private readonly deps: {
    db: Database; engine: LocalPlanEngine; driverForProject(project: Project): LocalPlanDriver;
  }) { this.store = new LocalPlanStore(deps.db); }

  start(): void {
    if (this.timer || this.stopped) return;
    const recover = () => {
      if (!this.recovery && !this.stopped) {
        const flight = this.recover().catch(error => console.error('[local-plans] recovery failed', error))
          .finally(() => { this.recovery = undefined; });
        this.recovery = this.drain.track(flight);
      }
    };
    this.timer = setInterval(recover, 30_000);
    this.timer.unref?.();
    recover();
  }

  stop(waitMs?: number): Promise<DrainResult> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.cache.clear();
    return this.drain.close(waitMs);
  }

  private project(projectId: number): Project {
    if (this.stopped) throw new LocalPlanError('unavailable');
    const project = getProject(this.deps.db, projectId);
    if (!project) throw new LocalPlanError('not_found');
    return project;
  }

  private authorize(projectId: number, actorId: number): Project {
    const project = this.project(projectId);
    const user = this.deps.db.query<{ role: string }, [number]>('SELECT role FROM users WHERE id=?').get(actorId);
    if (!user || (user.role !== 'admin' && project.ownerUserId !== actorId && !new ProjectMemberStore(this.deps.db).isMember(projectId, actorId))) {
      throw new LocalPlanError('forbidden');
    }
    return project;
  }

  private driver(project: Project): LocalPlanDriver {
    const driver = this.deps.driverForProject(project);
    if (!driver.listDirectoryNoFollowWithin || !driver.readFileNoFollowWithin) throw new LocalPlanError('unavailable', 'Driver does not support bounded no-follow file access');
    return driver;
  }

  private async read(project: Project, path: string): Promise<{ digest: string; plan: LocalPlan }> {
    const name = path.slice('.panda/plans/'.length);
    if (path !== `.panda/plans/${name}` || !FILE_RE.test(name)) throw new LocalPlanError('invalid', 'Invalid plan path');
    const range = await this.driver(project).readFileNoFollowWithin!(project.cwd, path, MAX_PLAN_BYTES + 1).catch(error => {
      // ENOENT (Local) / SSH_FX_NO_SUCH_FILE (SFTP) is a definitive pre-commit failure,
      // not an uncertain publication that should keep the browser's retry request pinned.
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
      if (code === 'ENOENT' || code === 2) throw new LocalPlanError('not_found');
      throw error;
    });
    if (range.size > MAX_PLAN_BYTES || range.data.length > MAX_PLAN_BYTES) throw new LocalPlanError('invalid', 'Plan exceeds 2 MiB');
    try {
      return { digest: digestOf(range.data), plan: parseLocalPlan(new TextDecoder('utf-8', { fatal: true }).decode(range.data)) };
    } catch (error) { throw new LocalPlanError('invalid', String(error)); }
  }

  private drafts(project: Project, plan: LocalPlan, actorId?: number): DesignIssueDraft[] {
    return plan.issues.map(item => {
      const module = item.module === null ? null : this.deps.db.query<{ id: number; agent: 'claude' | 'codex'; status: string }, [number, string]>(
        'SELECT id,agent,status FROM project_modules WHERE project_id=? AND slug=?',
      ).get(project.id, item.module);
      if (item.module !== null && (!module || module.status !== 'active')) throw new LocalPlanError('invalid', `Task ${item.position}: module ${item.module} is not active in this project`);
      const agent = module?.agent ?? item.agent ?? (projectAgentSupport(this.deps.db, project.id, 'claude').ok ? 'claude' : 'codex');
      if (module && item.agent && item.agent !== module.agent) throw new LocalPlanError('invalid', `Task ${item.position}: agent conflicts with module ${item.module}`);
      return { nodeId: String(item.position), title: item.title, body: item.issueBody, category: item.category,
        moduleId: module?.id ?? null, agent, implMode: 'direct', createdBy: actorId };
    });
  }

  private scan(project: Project): Promise<LocalPlanCandidate[]> {
    const cached = this.cache.get(project.id);
    if (cached && cached.cwd === project.cwd && cached.executorId === project.executorId && Date.now() - cached.ts < 5_000) return Promise.resolve(cached.candidates);
    const existing = this.scans.get(project.id);
    if (existing) return existing;
    const flight = this.scanFiles(project).then(candidates => {
      if (!this.stopped) this.cache.set(project.id, { cwd: project.cwd, executorId: project.executorId, ts: Date.now(), candidates });
      return candidates;
    }).finally(() => this.scans.delete(project.id));
    this.scans.set(project.id, flight);
    return flight;
  }

  private async scanFiles(project: Project): Promise<LocalPlanCandidate[]> {
    const driver = this.driver(project);
    const entries = (await driver.listDirectoryNoFollowWithin!(project.cwd, '.panda/plans') ?? [])
      .filter(entry => entry.type === 'file' && FILE_RE.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    if (entries.length > MAX_FILES) throw new LocalPlanError('invalid', 'At most 100 plan files may be scanned');
    const result: LocalPlanCandidate[] = [];
    let bytes = 0;
    for (const entry of entries) {
      if (this.stopped) throw new LocalPlanError('unavailable');
      const path = `.panda/plans/${entry.name}`;
      let digest = '';
      let plan: LocalPlan | null = null;
      let error: string | null = null;
      try {
        const range = await driver.readFileNoFollowWithin!(project.cwd, path, MAX_PLAN_BYTES + 1);
        bytes += range.data.length;
        if (bytes > MAX_SCAN_BYTES) throw new LocalPlanError('invalid', 'Plan scan exceeds 16 MiB');
        digest = digestOf(range.data);
        if (range.size > MAX_PLAN_BYTES || range.data.length > MAX_PLAN_BYTES) throw new Error('Plan exceeds 2 MiB');
        plan = parseLocalPlan(new TextDecoder('utf-8', { fatal: true }).decode(range.data));
        // Validate execution configuration without module resolution, writes or scheduling.
        await this.deps.engine.prepareIssueBatch(project.id, this.drafts(project, plan));
      } catch (reason) {
        if (bytes > MAX_SCAN_BYTES) throw reason;
        error = reason instanceof LocalPlanError ? reason.details ?? reason.message : String(reason);
      }
      result.push({ path, digest, plan, error, execution: null, changed: false });
    }
    const byId = new Map<string, LocalPlanCandidate[]>();
    for (const item of result) if (item.plan) byId.set(item.plan.planId, [...(byId.get(item.plan.planId) ?? []), item]);
    for (const items of byId.values()) if (items.length > 1) for (const item of items) item.error = `Duplicate planId: ${item.plan!.planId}`;
    return result;
  }

  view(projectId: number, actorId: number, refresh = false): Promise<LocalPlansView> {
    const project = this.authorize(projectId, actorId);
    if (refresh) this.cache.delete(projectId);
    return this.drain.track((refresh ? this.scanFiles(project) : this.scan(project)).then(candidates => {
      this.authorize(projectId, actorId);
      const executions = this.store.list(projectId);
      return { candidates: candidates.map(candidate => {
        const execution = executions.find(item => item.planId === candidate.plan?.planId) ?? null;
        return { ...candidate, execution, changed: execution !== null && execution.digest !== candidate.digest };
      }), executions };
    }));
  }

  execute(projectId: number, actorId: number, input: { path: string; planId: string; digest: string }): Promise<LocalPlanExecution> {
    this.authorize(projectId, actorId);
    return this.drain.track(this.publish(projectId, actorId, input));
  }

  private async publish(projectId: number, actorId: number, input: { path: string; planId: string; digest: string }): Promise<LocalPlanExecution> {
    const replay = (): LocalPlanExecution | null => {
      const existing = this.store.get(projectId, input.planId);
      if (existing && existing.digest !== input.digest) throw new LocalPlanError('published');
      return existing;
    };
    if (replay()) {
      this.kick(projectId, input.planId);
      return replay()!;
    }
    const project = this.authorize(projectId, actorId);
    if (project.status !== 'active') throw new LocalPlanError('invalid', 'Archived project cannot execute plans');
    this.cache.delete(projectId);
    const { digest, plan } = await this.read(project, input.path);
    if (digest !== input.digest || plan.planId !== input.planId) throw new LocalPlanError('changed');
    // A second file with the same plan identity is ambiguous even before publication.
    this.cache.delete(projectId);
    const candidates = await this.scanFiles(project);
    if (candidates.filter(item => item.plan?.planId === plan.planId).length !== 1) throw new LocalPlanError('invalid', 'Duplicate or missing plan identity');
    let prepared;
    try { prepared = await this.deps.engine.prepareIssueBatch(projectId, this.drafts(project, plan, actorId)); }
    catch (error) { throw error instanceof LocalPlanError ? error : new LocalPlanError('invalid', String(error)); }
    const fresh = await this.read(project, input.path);
    if (fresh.digest !== digest) throw new LocalPlanError('changed');
    const current = this.authorize(projectId, actorId);
    if (current.cwd !== project.cwd || current.executorId !== project.executorId) throw new LocalPlanError('changed');
    // Concurrent clicks can have prepared the same bytes; only one transaction publishes them.
    if (!replay()) this.deps.engine.commitPreparedDesignBatch(prepared,
      plan.issues.flatMap(item => item.dependsOn.map(number => ({ fromNodeId: String(number), toNodeId: String(item.position) }))),
      created => {
        this.authorize(projectId, actorId);
        const issueIds = [...created.values()].map(issue => issue.id);
        const effects: LocalPlanEffect[] = [...created.values()].flatMap(issue => issue.moduleId == null ? [] : [{
          key: `module-doc:${issue.id}`, kind: 'module-doc' as const, projectId, issueId: issue.id,
          issueIds, moduleId: issue.moduleId, agent: issue.agent,
        }]);
        effects.push({ key: 'scheduler', kind: 'scheduler', projectId, issueId: null, issueIds });
        this.store.record({ projectId, plan, digest, path: input.path, actorId,
          items: [...created.entries()].map(([key, issue]) => ({ key, issueId: issue.id })), effects });
      });
    this.cache.delete(projectId);
    this.kick(projectId, plan.planId);
    return this.store.get(projectId, plan.planId)!;
  }

  private kick(projectId: number, planId: string): void {
    if (this.stopped) return;
    const key = `${projectId}:${planId}`;
    if (this.effects.has(key)) return;
    const execution = this.store.get(projectId, planId);
    if (!execution || !execution.effectsPending) return;
    const flight = this.deps.engine.completeDesignBatch(projectId, execution.issues.map(item => item.issueId), {
      listOperations: () => this.store.operations(projectId, planId),
      isComplete: operation => this.store.isComplete(projectId, planId, operation.key),
      markComplete: operation => this.store.finish(projectId, planId, operation.key),
      markRetry: (operation, error) => this.store.finish(projectId, planId, operation.key, error),
    }).catch(error => {
      // Failure is durable and visible. Retry the committed effects, never recreate the issues.
      console.error('[local-plans] publication effects deferred', error);
    }).finally(() => this.effects.delete(key));
    this.effects.set(key, this.drain.track(flight));
  }

  async recover(): Promise<void> {
    if (this.stopped) return;
    for (const item of this.store.pending()) this.kick(item.projectId, item.planId);
    for (const projectId of this.store.pendingProjects()) {
      if (this.stopped) return;
      await this.deps.engine.scheduleNext(projectId, { source: 'publication' });
    }
    // Polling also works for SSH executors and catches files created while the UI was closed.
    const projects = this.deps.db.query<{ id: number }, []>("SELECT id FROM projects WHERE status='active'").all();
    for (const item of projects) {
      if (this.stopped) return;
      const project = getProject(this.deps.db, item.id);
      if (project) await this.scan(project).catch(() => {});
    }
  }
}

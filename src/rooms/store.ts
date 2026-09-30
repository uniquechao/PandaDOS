import type { Database } from 'bun:sqlite';
import type { RoomArtifact, RoomArtifactVersion, RoomAssessment, RoomAudience, RoomBudgetLimits, RoomContribution, RoomGoal, RoomIssueLink, RoomMember, RoomMemberModel, RoomMission, RoomPlan, RoomPlanTask, RoomRecord, RoomRole, RoomSnapshot, RoomSourceGrant, RoomState, RoomSummary } from '../../shared/rooms';
import { RoomError, type RoomScope } from './contracts';
import { roomCapabilities } from './machine';

type Value = string | number | null;
/** A configured identifier is data, never a command or an implicit runtime binding. */
export function roomMemberModel(value: unknown): RoomMemberModel {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomError('invalid_request');
  const model = value as Record<string, unknown>;
  if (Object.keys(model).some(key => !['provider', 'model', 'effort'].includes(key)) || !['claude', 'codex', 'deepseek'].includes(model.provider as string) || !['low', 'medium', 'high'].includes(model.effort as string) || typeof model.model !== 'string' || /[\s\x00-\x1f\x7f-\x9f]/.test(model.model) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.model)) throw new RoomError('invalid_request');
  return { provider: model.provider as RoomMemberModel['provider'], model: model.model, effort: model.effort as RoomMemberModel['effort'] };
}
export interface MissionRow {
  id: string; project_id: number; room_id: string; state: RoomState; phase: RoomMission['phase'];
  version: number; control_epoch: number; current_goal_revision: number; actor_user_id: number;
  locale: string; template_key: 'product' | 'writing'; budget_json: string; active_since: number | null; active_ms: number; round: number;
  next_role: RoomRole; target_state: RoomState | null; pending_goal_json: string | null;
  reason_code: string | null; question_json: string | null; created_ts: number; updated_ts: number;
}
export interface MemberRow {
  id: string; project_id: number; room_id: string; role_key: RoomRole; display_name: string;
  model_profile_ref: string; status: 'active' | 'retired'; fence_counter: number; created_ts: number; version: number; instructions: string;
}
export interface AssignmentRow {
  id: string; project_id: number; room_id: string; mission_id: string; round_id: string | null;
  member_id: string; kind: 'work' | 'reply'; instruction: string; goal_revision: number; state: string;
  artifact_id: string | null; artifact_revision: number | null; retry_limit: number; failure_code: string | null;
  input_contribution_id: string | null; audience_json: string; created_ts: number; task_key: string | null; independent: number;
}
export interface AttemptRow {
  id: string; project_id: number; room_id: string; mission_id: string; assignment_id: string; member_id: string;
  number: number; state: 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
  epoch: number; fence: number; lease_owner: string; lease_until: number; deadline_ts: number; execution_id: string;
  result_digest: string | null; failure_code: string | null; model_requests: number; tool_calls: number; cancel_mode: 'detach' | 'confirm';
  created_ts: number; updated_ts: number;
}
interface RoomRow { id: string; project_id: number; title: string; status: 'active' | 'archived'; version: number; event_seq: number; created_ts: number; updated_ts: number }
interface ContributionRow { id: string; room_id: string; mission_id: string; goal_revision: number; seq: number; author_type: RoomContribution['authorType']; author_id: string; kind: RoomContribution['kind']; summary: string; audience_json: string; reply_to: string | null; artifact_id: string | null; artifact_revision: number | null; question_json: string | null; answers_question_id: string | null; evidence_json: string | null; task_key?: string | null; created_ts: number }
interface ArtifactRow { id: string; room_id: string; mission_id: string; title: string; owner_member_id: string; current_revision: number; adopted_revision: number | null }
interface RevisionRow { artifact_id: string; revision: number; goal_revision: number; title: string; markdown: string; digest: string; created_ts: number; author_user_id: number | null; author_member_id: string; evidence_json: string | null }
interface AssessmentRow { id: string; artifact_id: string; artifact_revision: number; goal_revision: number; criterion_id: string; verdict: RoomAssessment['verdict']; evidence: string; verifier_id: string; created_ts: number }
interface IssueLinkRow { id: string; room_id: string; mission_id: string; artifact_id: string; artifact_revision: number; issue_id: string; title: string; status?: string; created_ts: number }

/** SQL rows are deliberately separate from public DTOs; no SELECT * object is serialized. */
export class RoomStore {
  constructor(readonly db: Database) {}
  get<T>(sql: string, ...values: Value[]): T | null { return this.db.query<T, Value[]>(sql).get(...values); }
  all<T>(sql: string, ...values: Value[]): T[] { return this.db.query<T, Value[]>(sql).all(...values); }
  run(sql: string, ...values: Value[]) { return this.db.query(sql).run(...values); }
  atomic<T>(body: () => T): T { return this.db.transaction(body).immediate(); }
  read<T>(body: () => T): T { return this.db.transaction(body).deferred(); }
  room(scope: RoomScope): RoomRecord {
    const row = this.get<RoomRow>('SELECT * FROM rooms WHERE project_id=? AND id=?', scope.projectId, scope.roomId);
    if (!row) throw new RoomError('not_found');
    return { id: row.id, projectId: row.project_id, title: row.title, status: row.status, version: row.version, eventCursor: row.event_seq, createdAt: row.created_ts, updatedAt: row.updated_ts };
  }
  latestMission(scope: RoomScope): MissionRow | null {
    return this.get<MissionRow>('SELECT * FROM room_missions WHERE project_id=? AND room_id=? ORDER BY created_ts DESC,rowid DESC LIMIT 1', scope.projectId, scope.roomId);
  }
  mission(scope: RoomScope, missionId: string): MissionRow {
    const row = this.get<MissionRow>('SELECT * FROM room_missions WHERE project_id=? AND room_id=? AND id=?', scope.projectId, scope.roomId, missionId);
    if (!row) throw new RoomError('not_found');
    return row;
  }
  used(missionId: string, dimension: string): number {
    return this.get<{ n: number }>("SELECT COALESCE(SUM(amount),0) AS n FROM room_budget_entries WHERE mission_id=? AND dimension=? AND op='consume'", missionId, dimension)!.n;
  }
  reservedRequests(missionId: string): number {
    return this.get<{ n: number }>("SELECT COALESCE(SUM(CASE op WHEN 'reserve' THEN amount WHEN 'consume' THEN -amount WHEN 'release' THEN -amount ELSE 0 END),0) AS n FROM room_budget_entries WHERE mission_id=? AND dimension='modelRequests'", missionId)!.n;
  }
  missionDto(row: MissionRow, now: number): RoomMission {
    const limits = JSON.parse(row.budget_json) as RoomBudgetLimits;
    return { id: row.id, roomId: row.room_id, projectId: row.project_id, state: row.state, phase: row.phase, version: row.version, controlEpoch: row.control_epoch, goalRevision: row.current_goal_revision, round: row.round, nextRole: row.next_role, actorUserId: row.actor_user_id, locale: row.locale, templateKey: row.template_key, budget: { limits, modelRequests: this.used(row.id, 'modelRequests'), reservedRequests: this.reservedRequests(row.id), activeMs: row.active_ms + (row.active_since === null ? 0 : Math.max(0, now - row.active_since)) }, question: row.question_json ? JSON.parse(row.question_json) : null, reasonCode: row.reason_code, createdAt: row.created_ts, updatedAt: row.updated_ts };
  }
  members(scope: RoomScope): RoomMember[] {
    return this.all<MemberRow>('SELECT * FROM room_members WHERE project_id=? AND room_id=? ORDER BY created_ts,rowid', scope.projectId, scope.roomId).map(row => {
      let model: RoomMemberModel | undefined;
      if (row.model_profile_ref !== 'default') {
        try { model = roomMemberModel(JSON.parse(row.model_profile_ref)); } catch { throw new RoomError('unavailable'); }
      }
      const task = this.get<AssignmentRow>("SELECT a.* FROM room_assignments a JOIN room_missions m ON m.id=a.mission_id WHERE a.member_id=? AND a.state IN ('running','pending') AND m.state NOT IN ('completed','stopped') ORDER BY CASE a.state WHEN 'running' THEN 0 ELSE 1 END,a.created_ts,a.rowid LIMIT 1", row.id);
      return { id: row.id, projectId: row.project_id, roomId: row.room_id, role: row.role_key, displayName: row.display_name, address: `room/${row.room_id}/agent/${row.id}`, modelProfile: row.model_profile_ref, ...(model ? { model } : {}), status: row.status, version: row.version, instructions: row.instructions, activity: { state: task?.state === 'running' ? 'working' : task ? 'queued' : 'idle', ...(task ? { kind: task.kind, ...(task.task_key ? { taskId: task.task_key } : {}) } : {}) } };
    });
  }
  goal(mission: MissionRow): RoomGoal {
    const row = this.get<{ goal_json: string; created_ts: number }>('SELECT goal_json,created_ts FROM room_goal_revisions WHERE project_id=? AND room_id=? AND mission_id=? AND revision=?', mission.project_id, mission.room_id, mission.id, mission.current_goal_revision);
    if (!row) throw new RoomError('not_found');
    return this.goalDto(mission.id, mission.current_goal_revision, row.goal_json, row.created_ts);
  }
  private goalDto(missionId: string, revision: number, json: string, createdAt: number): RoomGoal {
    const goal = JSON.parse(json) as Pick<RoomGoal, 'request' | 'criteria' | 'baselineArtifactRefs'>;
    return { ...goal, criteria: goal.criteria.map(criterion => ({ ...criterion, origin: criterion.origin ?? (criterion.id === 'original-request' ? 'request' : 'user') })), baselineArtifactRefs: goal.baselineArtifactRefs ?? [], id: `${missionId}:${revision}`, missionId, revision, createdAt };
  }
  goals(scope: RoomScope): RoomGoal[] {
    return this.all<{ mission_id: string; revision: number; goal_json: string; created_ts: number }>('SELECT mission_id,revision,goal_json,created_ts FROM room_goal_revisions WHERE project_id=? AND room_id=? ORDER BY created_ts,mission_id,revision', scope.projectId, scope.roomId).map(row => this.goalDto(row.mission_id, row.revision, row.goal_json, row.created_ts));
  }
  missions(scope: RoomScope, now: number): RoomMission[] {
    return this.all<MissionRow>('SELECT * FROM room_missions WHERE project_id=? AND room_id=? ORDER BY created_ts,rowid', scope.projectId, scope.roomId).map(row => this.missionDto(row, now));
  }
  contributions(scope: RoomScope, missionId?: string, page?: { beforeSeq?: number; limit: number }): RoomContribution[] {
    const rows = this.all<ContributionRow>('SELECT c.*,a.task_key FROM room_contributions c LEFT JOIN room_assignments a ON a.id=c.assignment_id WHERE c.project_id=? AND c.room_id=?' + (missionId ? ' AND c.mission_id=?' : '') + (page?.beforeSeq === undefined ? '' : ' AND c.seq<?') + (page ? ' ORDER BY c.seq DESC LIMIT ?' : ' ORDER BY c.seq'), scope.projectId, scope.roomId, ...(missionId ? [missionId] : []), ...(page?.beforeSeq === undefined ? [] : [page.beforeSeq]), ...(page ? [page.limit] : []));
    if (page) rows.reverse();
    return rows.map(row => ({ id: row.id, roomId: row.room_id, missionId: row.mission_id, goalRevision: row.goal_revision, seq: row.seq, authorType: row.author_type, authorId: row.author_id, kind: row.kind, text: row.summary, audience: JSON.parse(row.audience_json) as RoomAudience, ...(row.reply_to ? { replyTo: row.reply_to } : {}), ...(row.artifact_id ? { artifactId: row.artifact_id, artifactVersion: row.artifact_revision! } : {}), ...(row.question_json ? { question: JSON.parse(row.question_json) } : {}), ...(row.answers_question_id ? { answersQuestionId: row.answers_question_id } : {}), ...(row.evidence_json ? { evidence: JSON.parse(row.evidence_json) } : {}), ...(row.task_key ? { taskId: row.task_key } : {}), createdAt: row.created_ts }));
  }
  artifacts(scope: RoomScope, missionId?: string, options?: { metadataOnly?: boolean; artifactId?: string }): RoomArtifact[] {
    return this.all<ArtifactRow>('SELECT * FROM room_artifacts WHERE project_id=? AND room_id=?' + (missionId ? ' AND mission_id=?' : '') + (options?.artifactId ? ' AND id=?' : '') + ' ORDER BY created_ts,id', scope.projectId, scope.roomId, ...(missionId ? [missionId] : []), ...(options?.artifactId ? [options.artifactId] : [])).map(row => ({ id: row.id, roomId: row.room_id, missionId: row.mission_id, title: row.title, currentVersion: row.current_revision, adoptedVersion: row.adopted_revision, versions: this.all<RevisionRow>(`SELECT r.artifact_id,r.revision,r.goal_revision,r.title,${options?.metadataOnly ? "''" : 'r.markdown'} AS markdown,r.digest,r.created_ts,r.author_user_id,r.evidence_json,a.member_id AS author_member_id FROM room_artifact_revisions r JOIN room_attempts a ON a.id=r.source_attempt_id WHERE r.project_id=? AND r.room_id=? AND r.mission_id=? AND r.artifact_id=? ORDER BY r.revision`, scope.projectId, scope.roomId, row.mission_id, row.id).map((rev): RoomArtifactVersion => ({ artifactId: rev.artifact_id, version: rev.revision, goalRevision: rev.goal_revision, title: rev.title, markdown: rev.markdown, digest: rev.digest, authorMemberId: rev.author_member_id, authorType: rev.author_user_id === null ? 'member' : 'user', ...(rev.author_user_id === null ? {} : { authorUserId: rev.author_user_id }), ...(rev.evidence_json ? { evidence: JSON.parse(rev.evidence_json) } : {}), contentLoaded: !options?.metadataOnly, createdAt: rev.created_ts })) }));
  }
  sources(scope: RoomScope, options?: { metadataOnly?: boolean; sourceId?: string }): RoomSourceGrant[] {
    return this.all<{ id: string; room_id: string; mission_id: string; goal_revision: number; version: number; title: string; content: string; digest: string; audience_json: string; status: RoomSourceGrant['status']; created_ts: number }>(`SELECT id,room_id,mission_id,goal_revision,version,title,${options?.metadataOnly ? "''" : 'content'} AS content,digest,audience_json,status,created_ts FROM room_sources WHERE project_id=? AND room_id=?${options?.sourceId ? ' AND id=?' : ''} ORDER BY created_ts,rowid`, scope.projectId, scope.roomId, ...(options?.sourceId ? [options.sourceId] : [])).map(row => ({ id: row.id, roomId: row.room_id, missionId: row.mission_id, goalRevision: row.goal_revision, version: row.version, title: row.title, content: row.content, contentLoaded: !options?.metadataOnly, digest: row.digest, audience: JSON.parse(row.audience_json), status: row.status, createdAt: row.created_ts }));
  }
  plans(scope: RoomScope): RoomPlan[] {
    return this.all<{ id: string; mission_id: string; goal_revision: number; ordinal: number; state: string; plan_json: string; created_ts: number }>('SELECT * FROM room_rounds WHERE project_id=? AND room_id=? ORDER BY created_ts,rowid', scope.projectId, scope.roomId).map(row => ({ id: row.id, missionId: row.mission_id, goalRevision: row.goal_revision, round: row.ordinal, state: row.state, createdAt: row.created_ts, tasks: (JSON.parse(row.plan_json).tasks as RoomPlanTask[] | undefined ?? []).map(task => { const assignment = this.get<AssignmentRow>('SELECT * FROM room_assignments WHERE round_id=? AND task_key=?', row.id, task.id); return { ...task, ...(assignment ? { memberId: assignment.member_id } : {}), assignmentId: assignment?.id ?? '', state: assignment?.state ?? 'pending' }; }) }));
  }
  assessments(scope: RoomScope, missionId?: string): RoomAssessment[] {
    return this.all<AssessmentRow>('SELECT * FROM room_assessments WHERE project_id=? AND room_id=?' + (missionId ? ' AND mission_id=?' : '') + ' ORDER BY created_ts,rowid', scope.projectId, scope.roomId, ...(missionId ? [missionId] : [])).map(row => ({ id: row.id, artifactId: row.artifact_id, artifactVersion: row.artifact_revision, goalRevision: row.goal_revision, criterionId: row.criterion_id, verdict: row.verdict, note: row.evidence, reviewerMemberId: row.verifier_id, createdAt: row.created_ts }));
  }
  issueLinks(scope: RoomScope): RoomIssueLink[] {
    return this.all<IssueLinkRow>('SELECT l.*,i.status FROM room_issue_links l JOIN issues i ON i.id=l.issue_id WHERE l.project_id=? AND l.room_id=? ORDER BY l.created_ts,l.rowid', scope.projectId, scope.roomId).map(row => ({ id: row.id, roomId: row.room_id, missionId: row.mission_id, artifactId: row.artifact_id, artifactVersion: row.artifact_revision, issueId: row.issue_id, title: row.title, status: row.status, createdAt: row.created_ts }));
  }
  snapshot(scope: RoomScope, now: number, options?: { limit?: number; metadataOnly?: boolean }): RoomSnapshot {
    const room = this.room(scope);
    const mission = this.latestMission(scope);
    return { room, members: this.members(scope), mission: mission ? this.missionDto(mission, now) : null, goal: mission ? this.goal(mission) : null, goals: this.goals(scope), missions: this.missions(scope, now), contributions: this.contributions(scope, undefined, options?.limit ? { limit: options.limit } : undefined), artifacts: this.artifacts(scope, undefined, options), sources: this.sources(scope, options), plans: this.plans(scope), assessments: this.assessments(scope), issueLinks: this.issueLinks(scope), capabilities: roomCapabilities(mission?.state ?? null, room.status === 'archived'), eventCursor: room.eventCursor };
  }
  list(projectId: number, now: number): RoomSummary[] {
    return this.all<{ id: string }>('SELECT id FROM rooms WHERE project_id=? ORDER BY updated_ts DESC,rowid DESC', projectId).map(({ id }) => {
      const scope = { projectId, roomId: id };
      const mission = this.latestMission(scope);
      const artifact = this.get<{ id: string; title: string; current_revision: number }>('SELECT id,title,current_revision FROM room_artifacts WHERE project_id=? AND room_id=? ORDER BY created_ts DESC,id DESC LIMIT 1', projectId, id);
      const memberCount = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_members WHERE project_id=? AND room_id=? AND status='active'", projectId, id)!.n;
      return { room: this.room(scope), mission: mission ? this.missionDto(mission, now) : null, goal: mission ? this.goal(mission) : null, memberCount, latestArtifact: artifact ? { id: artifact.id, title: artifact.title, version: artifact.current_revision } : null };
    });
  }
  event(scope: RoomScope, type: string, entityId: string | null, now: number): number {
    this.run('UPDATE rooms SET event_seq=event_seq+1,updated_ts=? WHERE project_id=? AND id=?', now, scope.projectId, scope.roomId);
    const seq = this.room(scope).eventCursor;
    this.run('INSERT INTO room_events(room_id,seq,type,entity_id,created_ts) VALUES(?,?,?,?,?)', scope.roomId, seq, type, entityId, now);
    return seq;
  }
}

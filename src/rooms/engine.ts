import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_ROOM_BUDGET, MAX_ROOM_BUDGET, ROOM_ROLES, type RoomArtifact, type RoomArtifactRef, type RoomAudience, type RoomBudgetLimits, type RoomCommand, type RoomCommandInput, type RoomContribution, type RoomCreateInput, type RoomGoal, type RoomIssueLink, type RoomQuestion, type RoomRole, type RoomSnapshot, type RoomState } from '../../shared/rooms';
import { RoomError, type RoomActor, type RoomAttempt, type RoomCommandMeta, type RoomFormalResult, type RoomScope, type RoomService, type RoomToolCall } from './contracts';
import type { RoomEvidence, RoomPlanTask, RoomMembersInput, RoomMemberChange } from '../../shared/rooms';
import { isRoomActive, isRoomClosed, isRoomRunnable, roomTransition } from './machine';
import { RoomStore, roomMemberModel, type AssignmentRow, type AttemptRow, type MemberRow, type MissionRow } from './store';
import { parseRoomFormalResult } from './protocol';

const LEASE_MS = 30_000;
const ATTEMPT_MS = 180_000;
const scopeOf = (row: { project_id: number; room_id: string }): RoomScope => ({ projectId: row.project_id, roomId: row.room_id });
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RoomError('invalid_request');
  return value;
}
function int(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new RoomError('invalid_request');
  return value;
}
function goalInput(request: unknown, criteria?: unknown, baselineArtifactRefs: RoomArtifactRef[] = []): Pick<RoomGoal, 'request' | 'criteria' | 'baselineArtifactRefs'> {
  const original = text(request, 8000);
  if (criteria !== undefined && (!Array.isArray(criteria) || criteria.length > 12)) throw new RoomError('invalid_request');
  return { request: original, baselineArtifactRefs, criteria: [{ id: 'original-request', description: original, required: true, origin: 'request' }, ...((criteria ?? []) as unknown[]).map((c, i) => ({ id: `criterion-${i + 1}`, description: text(c, 500), required: true, origin: 'user' as const }))] };
}
function userCriteria(input: { criteria?: string[]; userCriteria?: string[] }, fallback: string[] = []): string[] {
  if (input.criteria !== undefined && input.userCriteria !== undefined) throw new RoomError('invalid_request');
  return input.userCriteria ?? input.criteria ?? fallback;
}
function limitsInput(input?: Partial<RoomBudgetLimits>): RoomBudgetLimits {
  const limits = { ...DEFAULT_ROOM_BUDGET, ...input };
  for (const key of Object.keys(limits)) if (!Object.hasOwn(MAX_ROOM_BUDGET, key)) throw new RoomError('invalid_request');
  for (const key of Object.keys(MAX_ROOM_BUDGET) as (keyof RoomBudgetLimits)[]) int(limits[key], MAX_ROOM_BUDGET[key]);
  return limits;
}

/** Short SQLite transactions are the authority; network execution always lives outside this class. */
export class RoomEngine implements RoomService {
  readonly store: RoomStore;
  private readonly now: () => number;
  constructor(options: { store: RoomStore; now?: () => number }) { this.store = options.store; this.now = options.now ?? Date.now; }
  list(projectId: number) { return this.store.read(() => this.store.list(projectId, this.now())); }
  snapshot(scope: RoomScope) { return this.store.read(() => this.store.snapshot(scope, this.now())); }

  private idempotent(projectId: number, operation: string, request: unknown, meta: RoomCommandMeta, action: () => RoomSnapshot): RoomSnapshot {
    text(meta.key, 160);
    const hash = digest(request);
    return this.store.atomic(() => {
      const saved = this.store.get<{ request_digest: string; response_json: string }>('SELECT request_digest,response_json FROM room_commands WHERE project_id=? AND actor_user_id=? AND operation=? AND idempotency_key=?', projectId, meta.actor.userId, operation, meta.key);
      if (saved) {
        if (saved.request_digest !== hash) throw new RoomError('idempotency_conflict');
        const receipt = JSON.parse(saved.response_json) as { receiptVersion?: number; roomId?: string; room?: { id: string; projectId: number } };
        // Legacy receipts contained the complete history. Read them without replaying
        // the action, then compact them. Responses always reflect current authority/state.
        const roomId = receipt.receiptVersion === 1 ? receipt.roomId : receipt.room?.id;
        if (!roomId) throw new RoomError('unavailable');
        if (receipt.receiptVersion !== 1) this.store.run('UPDATE room_commands SET response_json=? WHERE project_id=? AND actor_user_id=? AND operation=? AND idempotency_key=?', JSON.stringify({ receiptVersion: 1, roomId }), projectId, meta.actor.userId, operation, meta.key);
        return this.store.snapshot({ projectId, roomId }, this.now());
      }
      const response = action();
      this.store.run('INSERT INTO room_commands VALUES(?,?,?,?,?,?,?)', projectId, meta.actor.userId, operation, meta.key, hash, JSON.stringify({ receiptVersion: 1, roomId: response.room.id }), this.now());
      return response;
    });
  }
  private baselineRefs(scope: RoomScope, value: unknown): RoomArtifactRef[] {
    if (!Array.isArray(value) || value.length > 8) throw new RoomError('invalid_request');
    const artifacts = this.store.artifacts(scope);
    const seen = new Set<string>();
    return value.map(entry => {
      if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => key !== 'artifactId' && key !== 'version')) throw new RoomError('invalid_request');
      const artifactId = text(entry.artifactId, 128);
      const version = int(entry.version, Number.MAX_SAFE_INTEGER);
      const key = `${artifactId}:${version}`;
      if (seen.has(key)) throw new RoomError('invalid_request');
      if (!artifacts.some(artifact => artifact.id === artifactId && artifact.versions.some(item => item.version === version))) throw new RoomError('scope_mismatch');
      seen.add(key);
      return { artifactId, version };
    });
  }
  private insertMission(scope: RoomScope, input: Pick<RoomCreateInput, 'request' | 'criteria' | 'userCriteria' | 'baselineArtifactRefs' | 'locale' | 'budget' | 'templateKey'>, actor: RoomActor, now: number): MissionRow {
    const id = randomUUID();
    const goal = goalInput(input.request, userCriteria(input), this.baselineRefs(scope, input.baselineArtifactRefs ?? []));
    const budget = limitsInput(input.budget);
    const locale = input.locale ?? actor.locale ?? 'en';
    if (!['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'es', 'fr', 'de', 'pt-BR', 'ru'].includes(locale)) throw new RoomError('invalid_request');
    this.store.run("INSERT INTO room_missions(id,project_id,room_id,state,actor_user_id,locale,template_key,budget_json,created_ts,updated_ts) VALUES(?,?,?,'draft',?,?,?,?,?,?)", id, scope.projectId, scope.roomId, actor.userId, locale, input.templateKey ?? this.store.latestMission(scope)?.template_key ?? 'product', JSON.stringify(budget), now, now);
    this.store.run('INSERT INTO room_goal_revisions VALUES(?,?,?,?,?,?,?)', scope.projectId, scope.roomId, id, 1, JSON.stringify(goal), actor.userId, now);
    this.store.event(scope, 'mission_created', id, now);
    return this.store.mission(scope, id);
  }
  create(projectId: number, input: RoomCreateInput, meta: RoomCommandMeta) {
    return this.idempotent(projectId, 'create', input, meta, () => {
      const title = text(input.title, 160);
      if (input.templateKey && !['product', 'writing'].includes(input.templateKey)) throw new RoomError('invalid_request');
      const now = this.now();
      const scope = { projectId, roomId: randomUUID() };
      this.store.run('INSERT INTO rooms(id,project_id,title,created_by,created_ts,updated_ts) VALUES(?,?,?,?,?,?)', scope.roomId, projectId, title, meta.actor.userId, now, now);
      for (const role of ROOM_ROLES) this.store.run('INSERT INTO room_members(id,project_id,room_id,role_key,display_name,created_ts) VALUES(?,?,?,?,?,?)', randomUUID(), projectId, scope.roomId, role, role, now);
      const mission = this.insertMission(scope, input, meta.actor, now);
      if (input.start) this.setState(mission, 'queued', now);
      return this.store.snapshot(scope, now);
    });
  }
  newMission(scope: RoomScope, input: Pick<RoomCreateInput, 'request' | 'criteria' | 'userCriteria' | 'baselineArtifactRefs' | 'budget' | 'locale'>, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'new_mission', { scope, input }, meta, () => {
      const room = this.store.room(scope);
      const current = this.store.latestMission(scope);
      if (room.status === 'archived' || (current && !isRoomClosed(current.state))) throw new RoomError('state_conflict');
      this.insertMission(scope, input, meta.actor, this.now());
      return this.store.snapshot(scope, this.now());
    });
  }
  private setState(m: MissionRow, state: RoomState, now: number, reason: string | null = null, target: RoomState | null = null) {
    const activeMs = m.active_ms + (m.active_since !== null && !isRoomActive(state) ? Math.max(0, now - m.active_since) : 0);
    const activeSince = isRoomActive(state) ? m.active_since ?? now : null;
    this.store.run('UPDATE room_missions SET state=?,version=version+1,active_ms=?,active_since=?,reason_code=?,target_state=?,updated_ts=? WHERE id=?', state, activeMs, activeSince, reason, target, now, m.id);
    this.store.event(scopeOf(m), 'mission_state', m.id, now);
  }
  private invalidate(m: MissionRow) { this.store.run('UPDATE room_missions SET control_epoch=control_epoch+1 WHERE id=?', m.id); }
  private activeAttempts(missionId: string) { return this.store.all<AttemptRow>("SELECT * FROM room_attempts WHERE mission_id=? AND state IN ('reserved','running','uncertain')", missionId); }
  private settleQuiescing(missionId: string, now: number) {
    const m = this.store.get<MissionRow>('SELECT * FROM room_missions WHERE id=?', missionId)!;
    if (m.state !== 'quiescing' || this.activeAttempts(missionId).length) return;
    if (m.pending_goal_json) {
      const pending = JSON.parse(m.pending_goal_json) as { goal: Pick<RoomGoal, 'request' | 'criteria' | 'baselineArtifactRefs'>; actor: number };
      this.store.run('INSERT INTO room_goal_revisions VALUES(?,?,?,?,?,?,?)', m.project_id, m.room_id, m.id, m.current_goal_revision + 1, JSON.stringify(pending.goal), pending.actor, now);
      this.store.run("UPDATE room_assignments SET state='superseded' WHERE mission_id=? AND state NOT IN ('succeeded','superseded')", m.id);
      this.store.run("UPDATE room_rounds SET state='superseded' WHERE mission_id=? AND state='running'", m.id);
      this.store.run("UPDATE room_missions SET current_goal_revision=current_goal_revision+1,pending_goal_json=NULL,next_role='coach',phase='aligning',question_json=NULL WHERE id=?", m.id);
    }
    this.setState(m, m.target_state ?? 'paused', now, m.reason_code);
  }
  private quiesce(m: MissionRow, target: RoomState, reason: string | null, now: number) {
    this.invalidate(m);
    // Stateless API workers can detach after fencing. External execution keeps
    // its occupancy until an exact termination acknowledgement arrives.
    this.store.run("UPDATE room_attempts SET state='cancelled',updated_ts=? WHERE mission_id=? AND state='uncertain' AND cancel_mode='detach'", now, m.id);
    this.setState(m, 'quiescing', now, reason, target);
    this.settleQuiescing(m.id, now);
  }
  private ensureBudget(m: MissionRow, now: number) {
    const budget = this.store.missionDto(m, now).budget;
    if (budget.activeMs >= budget.limits.activeMs || budget.modelRequests + (budget.reservedRequests ?? 0) >= budget.limits.modelRequests) throw new RoomError('budget_exhausted');
  }
  command(scope: RoomScope, missionId: string, command: RoomCommand, input: RoomCommandInput, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, command, { scope, missionId, input }, meta, () => {
      if (this.store.room(scope).status === 'archived') throw new RoomError('state_conflict');
      const m = this.store.mission(scope, missionId);
      if (m.version !== input.expectedVersion) throw new RoomError('conflict');
      const now = this.now();
      if (command === 'goal') {
        if (isRoomClosed(m.state) || m.state === 'quiescing') throw new RoomError('state_conflict');
        const previous = this.store.goal(m);
        // Legacy clients must send only user-authored criteria, never the generated request criterion.
        if (input.criteria?.includes(previous.request)) throw new RoomError('invalid_request');
        const latest = this.store.artifacts(scope, m.id).at(-1);
        const defaults = latest ? [{ artifactId: latest.id, version: latest.currentVersion }] : previous.baselineArtifactRefs ?? [];
        const goal = goalInput(input.request, userCriteria(input, previous.criteria.filter(item => item.origin === 'user').map(item => item.description)), this.baselineRefs(scope, input.baselineArtifactRefs ?? defaults));
        this.store.run('UPDATE room_missions SET pending_goal_json=? WHERE id=?', JSON.stringify({ goal, actor: meta.actor.userId }), m.id);
        this.quiesce(m, isRoomRunnable(m.state) ? 'queued' : m.state === 'draft' ? 'draft' : 'paused', null, now);
      } else if (command === 'budget') {
        if (isRoomClosed(m.state) || m.state === 'quiescing' || !input.budget || !Object.keys(input.budget).length) throw new RoomError('state_conflict');
        const limits = JSON.parse(m.budget_json) as RoomBudgetLimits;
        for (const [key, amount] of Object.entries(input.budget)) {
          if (!Object.hasOwn(MAX_ROOM_BUDGET, key)) throw new RoomError('invalid_request');
          const dimension = key as keyof RoomBudgetLimits;
          const increase = int(amount, MAX_ROOM_BUDGET[dimension]);
          limits[dimension] = int(limits[dimension] + increase, MAX_ROOM_BUDGET[dimension]);
          this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,?,?,?,'grant',?)", m.id, dimension, increase, `${meta.actor.userId}:${meta.key}`, now);
        }
        this.store.run('UPDATE room_missions SET budget_json=?,version=version+1,updated_ts=? WHERE id=?', JSON.stringify(limits), now, m.id);
        if (m.state === 'exhausted') {
          const updated = this.store.mission(scope, m.id);
          this.ensureBudget(updated, now);
          if (m.reason_code === 'round_limit' && m.round >= limits.rounds) throw new RoomError('budget_exhausted');
          this.prepareResume(updated, now);
        } else this.store.event(scope, 'budget_granted', m.id, now);
      } else {
        const next = roomTransition(m.state, command);
        if (!next) throw new RoomError('state_conflict');
        if (command === 'start') { this.ensureTeam(scope); this.ensureBudget(m, now); this.setState(m, next, now); }
        else if (command === 'pause' || command === 'stop') this.quiesce(m, command === 'pause' ? 'paused' : 'stopped', null, now);
        else if (command === 'resume') {
          this.ensureBudget(m, now);
          if (input.guidance !== undefined) this.addContribution(m, { authorType: 'user', authorId: String(meta.actor.userId), kind: 'message', text: text(input.guidance, 8000), audience: { kind: 'room' } }, now);
          this.prepareResume(m, now);
        }
        else if (command === 'answer') {
          const question = m.question_json ? JSON.parse(m.question_json) as { id: string } : null;
          if (!question || question.id !== input.questionId) throw new RoomError('conflict');
          const answer = text(input.answer, 8000);
          this.ensureBudget(m, now);
          const original = this.store.contributions(scope, m.id).find(item => item.question?.id === question.id && item.goalRevision === m.current_goal_revision);
          if (!original) throw new RoomError('conflict');
          this.addContribution(m, { authorType: 'user', authorId: String(meta.actor.userId), kind: 'message', text: answer, audience: { kind: 'room' }, replyTo: original.id, answersQuestionId: question.id }, now);
          this.store.run('UPDATE room_missions SET question_json=NULL WHERE id=?', m.id);
          this.prepareResume(m, now);
        }
      }
      if (command === 'start' || command === 'resume' || command === 'answer' || command === 'budget' || command === 'goal') this.store.run('UPDATE room_missions SET actor_user_id=? WHERE id=?', meta.actor.userId, m.id);
      return this.store.snapshot(scope, now);
    });
  }
  private prepareResume(m: MissionRow, now: number) {
    this.ensureTeam(scopeOf(m));
    // Only API calls can detach on resume; uncertain external executions retain their locks.
    this.store.run("UPDATE room_attempts SET state='cancelled',updated_ts=? WHERE mission_id=? AND state='uncertain' AND cancel_mode='detach'", now, m.id);
    if (this.activeAttempts(m.id).length) throw new RoomError('state_conflict');
    this.store.run("UPDATE room_assignments SET state='pending',retry_limit=retry_limit+1 WHERE mission_id=? AND goal_revision=? AND state IN ('failed','cancelled')", m.id, m.current_goal_revision);
    this.invalidate(m);
    this.setState(m, 'queued', now);
  }
  private audience(scope: RoomScope, value: RoomAudience): RoomAudience {
    if (!value || typeof value !== 'object') throw new RoomError('invalid_request');
    if (value.kind === 'room' && Object.keys(value).length === 1) return { kind: 'room' };
    if (value.kind !== 'members' || !Array.isArray(value.memberIds) || !value.memberIds.length || value.memberIds.length > 12 || Object.keys(value).some(k => k !== 'kind' && k !== 'memberIds')) throw new RoomError('invalid_request');
    const members = this.store.members(scope).filter(m => m.status === 'active');
    const ids = [...new Set(value.memberIds)].sort();
    if (ids.some(id => !members.some(m => m.id === id))) throw new RoomError('scope_mismatch');
    return { kind: 'members', memberIds: ids };
  }
  private addContribution(m: MissionRow, input: { authorType: 'user' | 'member' | 'system'; authorId: string; kind: string; text: string; audience: RoomAudience; assignmentId?: string; replyTo?: string; artifactId?: string; artifactVersion?: number; question?: RoomQuestion; answersQuestionId?: string; evidence?: RoomEvidence[] }, now: number): string {
    const id = randomUUID();
    const seq = this.store.event(scopeOf(m), 'contribution', id, now);
    this.store.run('INSERT INTO room_contributions(id,project_id,room_id,mission_id,author_type,author_id,assignment_id,kind,summary,audience_json,reply_to,artifact_id,artifact_revision,seq,goal_revision,created_ts,question_json,answers_question_id,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, m.project_id, m.room_id, m.id, input.authorType, input.authorId, input.assignmentId ?? null, input.kind, input.text, JSON.stringify(input.audience), input.replyTo ?? null, input.artifactId ?? null, input.artifactVersion ?? null, seq, m.current_goal_revision, now, input.question ? JSON.stringify(input.question) : null, input.answersQuestionId ?? null, input.evidence ? JSON.stringify(input.evidence) : null);
    return id;
  }
  contribute(scope: RoomScope, input: { text: string; audience: RoomAudience; clientMessageId: string; replyTo?: string; missionId?: string; goalRevision?: number }, actor: RoomActor) {
    return this.idempotent(scope.projectId, 'contribute', { scope, input }, { actor, key: input.clientMessageId }, () => {
      if (this.store.room(scope).status === 'archived') throw new RoomError('state_conflict');
      const m = this.store.latestMission(scope);
      if (!m || isRoomClosed(m.state) || m.state === 'quiescing') throw new RoomError('state_conflict');
      if ((input.missionId !== undefined && input.missionId !== m.id) || (input.goalRevision !== undefined && input.goalRevision !== m.current_goal_revision)) throw new RoomError('conflict');
      const audience = this.audience(scope, input.audience);
      if (input.replyTo) {
        const replied = this.store.contributions(scope).find(c => c.id === input.replyTo);
        if (!replied) throw new RoomError('scope_mismatch');
        if (replied.audience.kind === 'members' && (audience.kind === 'room' || audience.memberIds.some(id => !(replied.audience as { memberIds: string[] }).memberIds.includes(id) && replied.authorId !== id))) throw new RoomError('forbidden');
      }
      const now = this.now();
      const id = this.addContribution(m, { authorType: 'user', authorId: String(actor.userId), kind: 'message', text: text(input.text, 8000), audience, replyTo: input.replyTo }, now);
      if (audience.kind === 'members') for (const memberId of audience.memberIds) this.insertAssignment(m, memberId, 'reply', audience, now, id);
      return this.store.snapshot(scope, now);
    });
  }
  archive(scope: RoomScope, expectedVersion: number, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'archive', { scope, expectedVersion }, meta, () => {
      const room = this.store.room(scope);
      if (room.version !== expectedVersion) throw new RoomError('conflict');
      const mission = this.store.latestMission(scope);
      if (mission && !isRoomClosed(mission.state)) throw new RoomError('state_conflict');
      this.store.run("UPDATE rooms SET status='archived',version=version+1 WHERE id=?", scope.roomId);
      this.store.event(scope, 'archived', scope.roomId, this.now());
      return this.store.snapshot(scope, this.now());
    });
  }
  adopt(scope: RoomScope, artifactId: string, version: number, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'adopt', { scope, artifactId, version }, meta, () => {
      const artifact = this.store.artifacts(scope).find(a => a.id === artifactId);
      if (!artifact || !artifact.versions.some(v => v.version === version)) throw new RoomError('not_found');
      if (this.store.room(scope).status === 'archived') throw new RoomError('state_conflict');
      const m = this.store.latestMission(scope);
      if (!m || m.state !== 'completed' || artifact.missionId !== m.id || version !== artifact.currentVersion || artifact.versions.find(v => v.version === version)!.goalRevision !== m.current_goal_revision || !this.deliveryReady(m)) throw new RoomError('state_conflict');
      this.store.run('UPDATE room_artifacts SET adopted_revision=? WHERE id=? AND project_id=? AND room_id=?', version, artifactId, scope.projectId, scope.roomId);
      this.store.event(scope, 'artifact_adopted', artifactId, this.now());
      return this.store.snapshot(scope, this.now());
    });
  }
  grantSource(scope: RoomScope, input: { missionId: string; goalRevision: number; title: string; content: string; audience: RoomAudience }, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'grant_source', { scope, input }, meta, () => {
      const m = this.store.latestMission(scope);
      if (!m || m.id !== input.missionId || m.current_goal_revision !== input.goalRevision) throw new RoomError('conflict');
      if (this.store.room(scope).status === 'archived' || isRoomClosed(m.state) || m.state === 'quiescing') throw new RoomError('state_conflict');
      if (this.store.sources(scope).filter(source => source.missionId === m.id && source.goalRevision === m.current_goal_revision && source.status === 'active').length >= 12) throw new RoomError('invalid_request');
      const title = text(input.title, 160); const content = text(input.content, 64000);
      if (Buffer.byteLength(content, 'utf8') > 64000) throw new RoomError('invalid_request');
      const audience = this.audience(scope, input.audience); const id = randomUUID(); const now = this.now();
      this.store.run('INSERT INTO room_sources(id,project_id,room_id,mission_id,goal_revision,title,content,digest,audience_json,actor_user_id,created_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, scope.projectId, scope.roomId, m.id, m.current_goal_revision, title, content, createHash('sha256').update(content).digest('hex'), JSON.stringify(audience), meta.actor.userId, now);
      if (isRoomRunnable(m.state)) this.quiesce(m, 'paused', null, now);
      else this.store.run('UPDATE room_missions SET version=version+1 WHERE id=?', m.id);
      this.store.event(scope, 'source_granted', id, now);
      return this.store.snapshot(scope, now);
    });
  }
  revokeSource(scope: RoomScope, sourceId: string, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'revoke_source', { scope, sourceId }, meta, () => {
      if (this.store.room(scope).status === 'archived') throw new RoomError('state_conflict');
      const source = this.store.sources(scope).find(item => item.id === sourceId);
      if (!source) throw new RoomError('not_found');
      const now = this.now();
      if (source.status !== 'revoked') {
        this.store.run("UPDATE room_sources SET status='revoked' WHERE id=?", sourceId);
        const m = this.store.latestMission(scope);
        if (m && isRoomRunnable(m.state)) this.quiesce(m, 'paused', null, now);
        this.store.event(scope, 'source_revoked', sourceId, now);
      }
      return this.store.snapshot(scope, now);
    });
  }
  configureMember(scope: RoomScope, memberId: string, input: { expectedVersion: number; displayName: string; instructions: string; model?: RoomMemberChange['model'] }, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'configure_member', { scope, memberId, input }, meta, () => {
      return this.applyMemberChanges(scope, { expectedRoomVersion: this.store.room(scope).version, changes: [{ id: memberId, ...input }] });
    });
  }
  applyMembers(scope: RoomScope, input: RoomMembersInput, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'apply_members', { scope, input }, meta, () => this.applyMemberChanges(scope, input));
  }
  private applyMemberChanges(scope: RoomScope, input: RoomMembersInput): RoomSnapshot {
    const room = this.store.room(scope), m = this.store.latestMission(scope);
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['expectedRoomVersion', 'changes'].includes(key)) || !Array.isArray(input.changes) || !input.changes.length || input.changes.length > 24) throw new RoomError('invalid_request');
    if (room.version !== input.expectedRoomVersion) throw new RoomError('conflict');
    if (room.status === 'archived' || (m && (['queued', 'running', 'quiescing'].includes(m.state) || this.activeAttempts(m.id).length))) throw new RoomError('state_conflict');
    const members = this.store.members(scope), changedIds = new Set<string>();
    let rebuild = false;
    const updates = input.changes.map((change: RoomMemberChange) => {
      if (!change || typeof change !== 'object' || Array.isArray(change) || Object.keys(change).some(key => !['id', 'expectedVersion', 'remove', 'role', 'displayName', 'instructions', 'model'].includes(key)) || (change.remove !== undefined && typeof change.remove !== 'boolean')) throw new RoomError('invalid_request');
      const existing = change.id === undefined ? undefined : members.find(member => member.id === text(change.id, 200));
      if (change.id !== undefined && !existing) throw new RoomError('not_found');
      if (existing && (existing.status !== 'active' || changedIds.has(existing.id))) throw new RoomError('state_conflict');
      if (change.expectedVersion !== undefined && (!existing || change.expectedVersion !== existing.version)) throw new RoomError('conflict');
      if (change.remove && (!existing || Object.keys(change).some(key => !['id', 'expectedVersion', 'remove'].includes(key)))) throw new RoomError('invalid_request');
      if (change.role !== undefined && !ROOM_ROLES.includes(change.role)) throw new RoomError('invalid_request');
      const role = change.role ?? existing?.role;
      if (!role) throw new RoomError('invalid_request');
      const displayName = change.displayName === undefined ? existing?.displayName ?? role : text(change.displayName, 80);
      const instructions = change.instructions === undefined ? existing?.instructions ?? '' : change.instructions;
      if (typeof instructions !== 'string' || instructions.length > 4000) throw new RoomError('invalid_request');
      const model = change.model === undefined ? existing?.model : change.model === null ? undefined : roomMemberModel(change.model);
      const id = existing?.id ?? randomUUID(); changedIds.add(id);
      if (!existing || change.remove || role !== existing.role || instructions !== (existing.instructions ?? '') || digest(model ?? null) !== digest(existing.model ?? null)) rebuild = true;
      return { id, existing, role, displayName, instructions, model, status: change.remove ? 'retired' as const : 'active' as const };
    });
    const active = [...members.filter(member => member.status === 'active' && !changedIds.has(member.id)), ...updates.filter(member => member.status === 'active')];
    if (active.length < 1 || active.length > 12 || active.filter(member => member.role === 'coach').length !== 1) throw new RoomError('invalid_request');
    const now = this.now();
    // Remove the old coach/capacity occupants before promotions and additions;
    // the whole batch remains one transaction and never publishes a partial team.
    updates.sort((a, b) => Number(b.status === 'retired' || (b.existing?.role === 'coach' && b.role !== 'coach')) - Number(a.status === 'retired' || (a.existing?.role === 'coach' && a.role !== 'coach')));
    for (const member of updates) {
      const profile = member.model ? JSON.stringify(member.model) : 'default';
      if (member.existing) this.store.run('UPDATE room_members SET role_key=?,display_name=?,instructions=?,model_profile_ref=?,status=?,version=version+1 WHERE id=?', member.role, member.displayName, member.instructions, profile, member.status, member.id);
      else this.store.run('INSERT INTO room_members(id,project_id,room_id,role_key,display_name,instructions,model_profile_ref,created_ts) VALUES(?,?,?,?,?,?,?,?)', member.id, scope.projectId, scope.roomId, member.role, member.displayName, member.instructions, profile, now);
      if (member.status === 'retired') {
        this.store.run("UPDATE room_assignments SET state='superseded',failure_code='member_retired' WHERE member_id=? AND state NOT IN ('succeeded','superseded','skipped')", member.id);
        this.store.event(scope, 'member_retired', member.id, now);
      }
    }
    if (m) {
      if (rebuild) {
        this.store.run("UPDATE room_assignments SET state='superseded',failure_code=COALESCE(failure_code,'team_changed') WHERE mission_id=? AND kind='work' AND state NOT IN ('succeeded','superseded','skipped')", m.id);
        this.store.run("UPDATE room_rounds SET state='superseded' WHERE mission_id=? AND state='running'", m.id);
        this.store.run("UPDATE room_missions SET next_role='coach',phase='aligning' WHERE id=?", m.id);
      }
      // Preserve the current state and question, including waiting_user.
      this.store.run('UPDATE room_missions SET version=version+1,control_epoch=control_epoch+1,updated_ts=? WHERE id=?', now, m.id);
    }
    this.store.run('UPDATE rooms SET version=version+1 WHERE project_id=? AND id=?', scope.projectId, scope.roomId);
    this.store.event(scope, 'members_updated', null, now);
    return this.store.snapshot(scope, now);
  }
  private ensureTeam(scope: RoomScope): void {
    const members = this.store.members(scope).filter(member => member.status === 'active');
    if (members.length > 12 || members.filter(member => member.role === 'coach').length !== 1 || !members.some(member => member.role === 'writer') || !members.some(member => member.role === 'reviewer')) throw new RoomError('state_conflict');
  }
  editArtifact(scope: RoomScope, artifactId: string, input: { expectedVersion: number; expectedMissionVersion: number; title: string; markdown: string }, meta: RoomCommandMeta) {
    return this.idempotent(scope.projectId, 'edit_artifact', { scope, artifactId, input }, meta, () => {
      const m = this.store.latestMission(scope);
      if (this.store.room(scope).status === 'archived' || !m || !['paused', 'completed'].includes(m.state) || this.activeAttempts(m.id).length) throw new RoomError('state_conflict');
      if (m.version !== input.expectedMissionVersion) throw new RoomError('conflict');
      const artifact = this.store.artifacts(scope, m.id).find(item => item.id === artifactId);
      if (!artifact) throw new RoomError('not_found');
      if (artifact.currentVersion !== input.expectedVersion || artifact.versions.at(-1)!.goalRevision !== m.current_goal_revision) throw new RoomError('conflict');
      const title = text(input.title, 200); const markdown = text(input.markdown, 48000);
      if (Buffer.byteLength(markdown, 'utf8') > 64000) throw new RoomError('invalid_request');
      const now = this.now(); const revision = artifact.currentVersion + 1;
      // source_attempt_id retains the origin lineage; author_user_id records the actual editor.
      const origin = this.store.get<{ source_attempt_id: string }>('SELECT source_attempt_id FROM room_artifact_revisions WHERE artifact_id=? AND revision=?', artifact.id, artifact.currentVersion)!;
      this.store.run('INSERT INTO room_artifact_revisions(project_id,room_id,mission_id,artifact_id,revision,goal_revision,title,markdown,digest,byte_size,source_attempt_id,created_ts,author_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', scope.projectId, scope.roomId, m.id, artifact.id, revision, m.current_goal_revision, title, markdown, createHash('sha256').update(markdown).digest('hex'), Buffer.byteLength(markdown, 'utf8'), origin.source_attempt_id, now, meta.actor.userId);
      this.store.run('UPDATE room_artifacts SET current_revision=?,adopted_revision=NULL,title=? WHERE id=?', revision, title, artifact.id);
      this.store.run("UPDATE room_assignments SET state='superseded' WHERE mission_id=? AND state NOT IN ('succeeded','superseded')", m.id);
      this.store.run("UPDATE room_rounds SET state='superseded' WHERE mission_id=? AND state='running'", m.id);
      this.store.run("UPDATE room_missions SET control_epoch=control_epoch+1,next_role='reviewer',phase='reviewing' WHERE id=?", m.id);
      this.setState(m, 'paused', now);
      this.addContribution(m, { authorType: 'user', authorId: String(meta.actor.userId), kind: 'artifact', text: title, audience: { kind: 'room' }, artifactId, artifactVersion: revision }, now);
      return this.store.snapshot(scope, now);
    });
  }
  linkIssue(scope: RoomScope, input: Omit<RoomIssueLink, 'id' | 'roomId' | 'createdAt'>, publicationKey: string, actorUserId: number): RoomIssueLink {
    const artifact = this.store.artifacts(scope, input.missionId).find(a => a.id === input.artifactId);
    if (!artifact || !artifact.versions.some(v => v.version === input.artifactVersion)) throw new RoomError('scope_mismatch');
    const issue = this.store.get<{ project_id: number }>('SELECT project_id FROM issues WHERE id=?', input.issueId);
    if (!issue || issue.project_id !== scope.projectId) throw new RoomError('scope_mismatch');
    const old = this.store.get<{ id: string; issue_id: string; room_id: string }>('SELECT id,issue_id,room_id FROM room_issue_links WHERE project_id=? AND publication_key=?', scope.projectId, publicationKey);
    if (old) {
      if (old.issue_id !== input.issueId || old.room_id !== scope.roomId) throw new RoomError('idempotency_conflict');
      return this.store.issueLinks(scope).find(l => l.id === old.id)!;
    }
    const id = randomUUID(); const now = this.now();
    this.store.run('INSERT INTO room_issue_links VALUES(?,?,?,?,?,?,?,?,?,?,?)', id, scope.projectId, scope.roomId, input.missionId, input.artifactId, input.artifactVersion, input.issueId, text(input.title, 500), text(publicationKey, 160), actorUserId, now);
    this.store.event(scope, 'issue_linked', id, now);
    return { ...input, id, roomId: scope.roomId, createdAt: now };
  }

  private insertAssignment(m: MissionRow, memberId: string, kind: 'work' | 'reply', audience: RoomAudience, now: number, inputId?: string, task?: RoomPlanTask): AssignmentRow {
    const id = randomUUID();
    const round = this.store.get<{ id: string }>('SELECT id FROM room_rounds WHERE mission_id=? AND ordinal=?', m.id, m.round);
    const artifact = this.store.artifacts(scopeOf(m), m.id).at(-1);
    this.store.run('INSERT INTO room_assignments(id,project_id,room_id,mission_id,round_id,member_id,kind,instruction,goal_revision,input_contribution_id,audience_json,artifact_id,artifact_revision,created_ts,task_key,independent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, m.project_id, m.room_id, m.id, round?.id ?? null, memberId, kind, task?.instruction ?? kind, m.current_goal_revision, inputId ?? null, JSON.stringify(audience), artifact?.id ?? null, artifact?.currentVersion ?? null, now, task?.id ?? null, task?.independent ? 1 : 0);
    return this.store.get<AssignmentRow>('SELECT * FROM room_assignments WHERE id=?', id)!;
  }
  private readyAssignment(m: MissionRow): AssignmentRow | null {
    return this.store.get<AssignmentRow>("SELECT a.* FROM room_assignments a WHERE a.mission_id=? AND a.goal_revision=? AND a.state='pending' AND NOT EXISTS (SELECT 1 FROM room_assignment_dependencies d JOIN room_assignments p ON p.id=d.depends_on_id WHERE d.assignment_id=a.id AND p.state NOT IN ('succeeded','skipped')) ORDER BY CASE a.kind WHEN 'work' THEN 0 ELSE 1 END,a.created_ts,a.rowid LIMIT 1", m.id, m.current_goal_revision);
  }
  private selectMember(scope: RoomScope, role: RoomRole, memberId?: string): MemberRow {
    if (memberId !== undefined) {
      const member = this.store.get<MemberRow>("SELECT * FROM room_members WHERE project_id=? AND room_id=? AND id=? AND role_key=? AND status='active'", scope.projectId, scope.roomId, memberId, role);
      if (!member) throw new RoomError('invalid_request');
      return member;
    }
    // Durable least-recently-assigned rotation includes queued plan nodes, so
    // several same-role tasks in one accepted plan also use distinct members.
    const member = this.store.get<MemberRow>("SELECT m.* FROM room_members m LEFT JOIN room_assignments a ON a.member_id=m.id AND a.kind='work' WHERE m.project_id=? AND m.room_id=? AND m.role_key=? AND m.status='active' GROUP BY m.id ORDER BY COALESCE(MAX(a.rowid),0),m.created_ts,m.rowid LIMIT 1", scope.projectId, scope.roomId, role);
    if (!member) throw new RoomError('state_conflict');
    return member;
  }
  private insertPlan(m: MissionRow, tasks: RoomPlanTask[], now: number) {
    const artifact = this.store.artifacts(scopeOf(m), m.id).at(-1);
    const requiredIds = new Set(this.store.goal(m).criteria.filter(criterion => criterion.required).map(criterion => criterion.id));
    const latestReviews = new Map(this.store.assessments(scopeOf(m), m.id).filter(review => review.goalRevision === m.current_goal_revision && review.artifactId === artifact?.id && review.artifactVersion === artifact?.currentVersion && requiredIds.has(review.criterionId)).map(review => [review.criterionId, review.verdict]));
    const hasFailedReview = [...latestReviews.values()].includes('failed');
    const assignments = new Map(tasks.map(task => {
      const member = this.selectMember(scopeOf(m), task.role, task.memberId);
      const assignment = this.insertAssignment(m, member.id, 'work', { kind: 'room' }, now, undefined, task);
      if (task.condition === 'has_failed_review' && !hasFailedReview) this.store.run("UPDATE room_assignments SET state='skipped' WHERE id=?", assignment.id);
      return [task.id, assignment] as const;
    }));
    for (const task of tasks) for (const dependency of task.dependsOn) {
      const parent = assignments.get(dependency);
      if (!parent) throw new RoomError('invalid_request');
      this.store.run('INSERT INTO room_assignment_dependencies VALUES(?,?,?,?,?)', m.project_id, m.room_id, m.id, assignments.get(task.id)!.id, parent.id);
    }
  }
  /** Adapter-generated native session identity; templates/model names are never runtime keys. */
  bindRuntime(scope: RoomScope, memberId: string, runtimeKey: string): void {
    this.store.atomic(() => {
      if (!this.store.members(scope).some(m => m.id === memberId)) throw new RoomError('scope_mismatch');
      text(runtimeKey, 512);
      const old = this.store.get<{ project_id: number; room_id: string; member_id: string }>('SELECT * FROM room_runtime_bindings WHERE runtime_key=?', runtimeKey);
      if (old) { if (old.project_id !== scope.projectId || old.room_id !== scope.roomId || old.member_id !== memberId) throw new RoomError('scope_mismatch'); return; }
      this.store.run('INSERT INTO room_runtime_bindings VALUES(?,?,?,?,?)', runtimeKey, scope.projectId, scope.roomId, memberId, this.now());
    });
  }
  private attemptDto(row: AttemptRow): RoomAttempt {
    const member = this.store.get<MemberRow>('SELECT * FROM room_members WHERE id=?', row.member_id)!;
    const assignment = this.store.get<AssignmentRow>('SELECT * FROM room_assignments WHERE id=?', row.assignment_id)!;
    const m = this.store.mission(scopeOf(row), row.mission_id);
    return { id: row.id, assignmentId: row.assignment_id, roomId: row.room_id, projectId: row.project_id, missionId: row.mission_id, memberId: row.member_id, role: member.role_key, kind: assignment.kind, goalRevision: assignment.goal_revision, round: m.round, controlEpoch: row.epoch, fence: row.fence, workerId: row.lease_owner, leaseUntil: row.lease_until, deadlineTs: row.deadline_ts, cancelMode: row.cancel_mode, audience: JSON.parse(assignment.audience_json), ...(assignment.input_contribution_id ? { inputContributionId: assignment.input_contribution_id } : {}) };
  }
  claimNext(workerId: string, now: number = this.now()): RoomAttempt | null {
    text(workerId, 160);
    return this.store.atomic(() => {
      const missions = this.store.all<MissionRow>("SELECT m.* FROM room_missions m JOIN rooms r ON r.id=m.room_id WHERE m.state IN ('queued','running') AND r.status='active' ORDER BY m.updated_ts,m.created_ts,m.rowid");
      for (const m of missions) {
        if (this.activeAttempts(m.id).length) continue; // Finite pipeline: one worker at a time per room.
        try { this.ensureTeam(scopeOf(m)); } catch { this.quiesce(m, 'interrupted', 'member_unavailable', now); continue; }
        try { this.ensureBudget(m, now); } catch { this.quiesce(m, 'exhausted', 'budget_exhausted', now); continue; }
        const scope = scopeOf(m);
        let assignment = this.readyAssignment(m);
        if (!assignment) {
          if (this.store.get("SELECT id FROM room_assignments WHERE mission_id=? AND goal_revision=? AND state='pending'", m.id, m.current_goal_revision)) { this.quiesce(m, 'interrupted', 'execution_failed', now); continue; }
          let member: MemberRow;
          try { member = this.selectMember(scope, m.next_role); } catch { this.quiesce(m, 'interrupted', 'member_unavailable', now); continue; }
          assignment = this.insertAssignment(m, member.id, 'work', { kind: 'room' }, now);
        }
        if (!this.store.get("SELECT id FROM room_members WHERE id=? AND status='active'", assignment.member_id)) { this.quiesce(m, 'interrupted', 'member_unavailable', now); continue; }
        if (this.store.get("SELECT id FROM room_attempts WHERE member_id=? AND state IN ('reserved','running','uncertain')", assignment.member_id)) continue;
        if (assignment.task_key) {
          const currentArtifact = this.store.artifacts(scope, m.id).at(-1);
          this.store.run('UPDATE room_assignments SET artifact_id=?,artifact_revision=? WHERE id=?', currentArtifact?.id ?? null, currentArtifact?.currentVersion ?? null, assignment.id);
        }
        const attempts = this.store.get<{ n: number }>('SELECT COUNT(*) AS n FROM room_attempts WHERE assignment_id=?', assignment.id)!.n;
        if (attempts > assignment.retry_limit) { this.quiesce(m, 'interrupted', 'retry_exhausted', now); continue; }
        const id = randomUUID();
        this.bindRuntime(scope, assignment.member_id, `model-api:${id}`);
        this.store.run('UPDATE room_members SET fence_counter=fence_counter+1 WHERE id=?', assignment.member_id);
        const fence = this.store.get<{ fence_counter: number }>('SELECT fence_counter FROM room_members WHERE id=?', assignment.member_id)!.fence_counter;
        const remaining = this.store.missionDto(m, now).budget;
        const deadline = now + Math.min(ATTEMPT_MS, remaining.limits.activeMs - remaining.activeMs);
        this.store.run("INSERT INTO room_attempts(id,project_id,room_id,mission_id,assignment_id,member_id,number,state,epoch,fence,lease_owner,lease_until,deadline_ts,execution_id,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,'running',?,?,?,?,?,?,?,?)", id, m.project_id, m.room_id, m.id, assignment.id, assignment.member_id, attempts + 1, m.control_epoch, fence, workerId, Math.min(now + LEASE_MS, deadline), deadline, id, now, now);
        this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'modelRequests',1,?,'reserve',?)", m.id, id, now);
        this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'attempts',1,?,'consume',?)", m.id, id, now);
        this.store.run("UPDATE room_assignments SET state='running' WHERE id=?", assignment.id);
        this.setState(m, 'running', now);
        return this.attemptDto(this.store.get<AttemptRow>('SELECT * FROM room_attempts WHERE id=?', id)!);
      }
      return null;
    });
  }
  private bound(attempt: RoomAttempt): { row: AttemptRow; m: MissionRow; assignment: AssignmentRow } | null {
    const row = this.store.get<AttemptRow>('SELECT * FROM room_attempts WHERE id=?', attempt.id);
    if (!row || row.project_id !== attempt.projectId || row.room_id !== attempt.roomId || row.mission_id !== attempt.missionId || row.member_id !== attempt.memberId || row.assignment_id !== attempt.assignmentId || row.lease_owner !== attempt.workerId || row.fence !== attempt.fence || row.epoch !== attempt.controlEpoch) return null;
    const assignment = this.store.get<AssignmentRow>('SELECT * FROM room_assignments WHERE id=?', row.assignment_id)!;
    const member = this.store.get<MemberRow>('SELECT * FROM room_members WHERE id=?', row.member_id)!;
    if (assignment.goal_revision !== attempt.goalRevision || assignment.kind !== attempt.kind || member.role_key !== attempt.role || member.status !== 'active' || digest(JSON.parse(assignment.audience_json)) !== digest(attempt.audience) || (assignment.input_contribution_id ?? undefined) !== attempt.inputContributionId) return null;
    return { row, assignment, m: this.store.mission(scopeOf(row), row.mission_id) };
  }
  isCurrent(attempt: RoomAttempt, now: number = this.now()): boolean {
    const current = this.bound(attempt);
    return !!current && current.row.state === 'running' && current.row.lease_until > now && current.row.deadline_ts > now && current.m.control_epoch === attempt.controlEpoch && current.m.current_goal_revision === attempt.goalRevision && isRoomRunnable(current.m.state) && this.store.room(scopeOf(current.m)).status === 'active';
  }
  renew(attempt: RoomAttempt, now: number = this.now()): boolean {
    return this.store.atomic(() => {
      if (!this.isCurrent(attempt, now)) return false;
      this.store.run('UPDATE room_attempts SET lease_until=?,updated_ts=? WHERE id=? AND fence=? AND lease_owner=?', Math.min(now + LEASE_MS, attempt.deadlineTs), now, attempt.id, attempt.fence, attempt.workerId);
      return true;
    });
  }
  setCancellationMode(attempt: RoomAttempt, mode: 'detach' | 'confirm'): boolean {
    return this.store.atomic(() => {
      const current = this.bound(attempt);
      if (!current || !this.isCurrent(attempt) || current.row.model_requests !== 0 || (mode !== 'detach' && mode !== 'confirm')) return false;
      if (current.row.cancel_mode === 'confirm' && mode !== 'confirm') return false;
      this.store.run('UPDATE room_attempts SET cancel_mode=? WHERE id=? AND fence=?', mode, attempt.id, attempt.fence);
      return true;
    });
  }
  pendingStops(): RoomAttempt[] {
    return this.store.read(() => this.store.all<AttemptRow>("SELECT a.* FROM room_attempts a JOIN room_missions m ON m.id=a.mission_id WHERE a.cancel_mode='confirm' AND (a.state='uncertain' OR (a.state IN ('reserved','running') AND m.state='quiescing')) ORDER BY a.created_ts,a.id").map(row => this.attemptDto(row)));
  }
  confirmStopped(attempt: RoomAttempt, now: number = this.now()): boolean {
    return this.store.atomic(() => {
      const current = this.bound(attempt);
      if (!current || current.row.cancel_mode !== 'confirm') return false;
      if (current.row.state === 'cancelled') return true;
      if (!['reserved', 'running', 'uncertain'].includes(current.row.state)) return false;
      if (current.m.state !== 'quiescing' && current.row.state !== 'uncertain') return false;
      this.releaseUnsent(current.row, now);
      this.store.run("UPDATE room_attempts SET state='cancelled',updated_ts=? WHERE id=? AND fence=?", now, attempt.id, attempt.fence);
      this.store.run("UPDATE room_assignments SET state='failed',failure_code=COALESCE(failure_code,'cancelled') WHERE id=? AND state='running'", attempt.assignmentId);
      if (current.m.state === 'quiescing') this.settleQuiescing(current.m.id, now);
      this.store.event(scopeOf(current.m), 'execution_stopped', attempt.id, now);
      return true;
    });
  }
  dispatched(attempt: RoomAttempt, now: number = this.now(), requestId = 'request-1'): boolean {
    return this.store.atomic(() => {
      const bound = this.bound(attempt);
      if (!bound || !this.isCurrent(attempt, now) || bound.row.model_requests >= 6 || requestId !== `request-${bound.row.model_requests + 1}`) return false;
      const operationKey = bound.row.model_requests === 0 ? attempt.id : `${attempt.id}:${requestId}`;
      if (bound.row.model_requests > 0) {
        try { this.ensureBudget(bound.m, now); } catch { this.quiesce(bound.m, 'exhausted', 'budget_exhausted', now); return false; }
        this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'modelRequests',1,?,'reserve',?)", attempt.missionId, operationKey, now);
      }
      this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'modelRequests',1,?,'consume',?)", attempt.missionId, operationKey, now);
      this.store.run('UPDATE room_attempts SET model_requests=model_requests+1,updated_ts=? WHERE id=?', now, attempt.id);
      return true;
    });
  }
  tool(attempt: RoomAttempt, call: RoomToolCall): unknown {
    return this.store.atomic(() => {
      if (!this.isCurrent(attempt)) throw new RoomError('scope_mismatch');
      text(call.id, 160);
      if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) throw new RoomError('invalid_request');
      const prior = this.store.get<{ request_digest: string }>('SELECT request_digest FROM room_tool_calls WHERE attempt_id=? AND call_id=?', attempt.id, call.id);
      const hash = digest(call);
      if (prior && prior.request_digest !== hash) throw new RoomError('idempotency_conflict');
      const row = this.bound(attempt)!.row;
      if (!prior && row.tool_calls >= 12) throw new RoomError('budget_exhausted');
      const context = this.context(attempt);
      let result: unknown;
      if (call.name === 'read_source') {
        if (Object.keys(call.args).some(key => key !== 'sourceId' && key !== 'version')) throw new RoomError('invalid_request');
        const sourceId = text(call.args.sourceId, 128); const version = int(call.args.version, Number.MAX_SAFE_INTEGER);
        if (!context.sources.some(source => source.id === sourceId && source.version === version)) throw new RoomError('scope_mismatch');
        result = this.store.sources({ projectId: attempt.projectId, roomId: attempt.roomId }).find(source => source.id === sourceId)!;
      } else if (call.name === 'read_artifact') {
        if (Object.keys(call.args).some(key => key !== 'artifactId' && key !== 'version')) throw new RoomError('invalid_request');
        const artifactId = text(call.args.artifactId, 128); const version = int(call.args.version, Number.MAX_SAFE_INTEGER);
        result = [...context.artifacts.flatMap(artifact => artifact.versions), ...context.baselineArtifacts].find(artifact => artifact.artifactId === artifactId && artifact.version === version);
        if (!result) throw new RoomError('scope_mismatch');
      } else if (call.name === 'search_sources') {
        if (Object.keys(call.args).some(key => key !== 'query')) throw new RoomError('invalid_request');
        const query = text(call.args.query, 200).toLocaleLowerCase();
        result = this.store.sources({ projectId: attempt.projectId, roomId: attempt.roomId }).filter(source => context.sources.some(item => item.id === source.id) && (source.title.toLocaleLowerCase().includes(query) || source.content.toLocaleLowerCase().includes(query))).slice(0, 8).map(source => {
          const index = Math.max(0, source.content.toLocaleLowerCase().indexOf(query));
          return { id: source.id, version: source.version, title: source.title, digest: source.digest, excerpt: source.content.slice(Math.max(0, index - 80), index + 432) };
        });
      } else throw new RoomError('invalid_request');
      if (!prior) {
        this.store.run('INSERT INTO room_tool_calls(attempt_id,call_id,request_digest,name,created_ts) VALUES(?,?,?,?,?)', attempt.id, call.id, hash, call.name, this.now());
        this.store.run('UPDATE room_attempts SET tool_calls=tool_calls+1 WHERE id=?', attempt.id);
      }
      return result;
    });
  }
  private releaseUnsent(row: AttemptRow, now: number): void {
    if (row.model_requests === 0) this.store.run("INSERT OR IGNORE INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'modelRequests',1,?,'release',?)", row.mission_id, row.id, now);
  }
  context(attempt: RoomAttempt) {
    return this.store.atomic(() => {
      if (!this.isCurrent(attempt)) throw new RoomError('scope_mismatch');
      const scope = { projectId: attempt.projectId, roomId: attempt.roomId };
      const m = this.store.mission(scope, attempt.missionId);
      const members = this.store.members(scope);
      const assignment = this.store.get<AssignmentRow>('SELECT * FROM room_assignments WHERE id=?', attempt.assignmentId)!;
      const task = assignment.task_key ? this.store.plans(scope).flatMap(plan => plan.tasks).find(item => item.assignmentId === assignment.id) : undefined;
      const canRead = (c: RoomContribution) => {
        if (task?.independent && c.authorType === 'member' && members.find(member => member.id === c.authorId)?.role !== 'coach') return false;
        if (c.audience.kind === 'room') return true;
        if (attempt.kind !== 'reply' || attempt.audience.kind !== 'members') return false;
        const allowed = new Set([...c.audience.memberIds, ...(c.authorType === 'member' ? [c.authorId] : [])]);
        return allowed.has(attempt.memberId) && attempt.audience.memberIds.every(id => allowed.has(id));
      };
      const history = this.store.contributions(scope);
      const contributions = history.filter(c => c.missionId === m.id && c.goalRevision === m.current_goal_revision && canRead(c));
      const byId = new Map(history.map(item => [item.id, item]));
      const visibleIds = new Set(contributions.map(item => item.id));
      const seen = new Set<string>();
      const queue = contributions.flatMap(item => item.replyTo ? [item.replyTo] : []);
      const referenceContributions: RoomContribution[] = [];
      while (queue.length && seen.size < 32) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const referenced = byId.get(id);
        if (!referenced || !canRead(referenced)) continue;
        if (!visibleIds.has(id)) referenceContributions.push(referenced);
        if (referenced.replyTo) queue.push(referenced.replyTo);
      }
      const goal = this.store.goal(m);
      const allArtifacts = this.store.artifacts(scope);
      const baselineArtifacts = (goal.baselineArtifactRefs ?? []).flatMap(ref => allArtifacts.find(artifact => artifact.id === ref.artifactId)?.versions.filter(version => version.version === ref.version) ?? []);
      const sources = this.store.sources(scope).filter(source => source.missionId === m.id && source.goalRevision === m.current_goal_revision && source.status === 'active' && (source.audience.kind === 'room' || (attempt.kind === 'reply' && attempt.audience.kind === 'members' && source.audience.memberIds.includes(attempt.memberId) && attempt.audience.memberIds.every(id => source.audience.kind === 'members' && source.audience.memberIds.includes(id))))).map(({ content: _content, ...source }) => source);
      const artifacts = task?.independent ? [] : this.store.artifacts(scope, m.id).map(a => ({ ...a, versions: a.versions.filter(v => v.goalRevision === m.current_goal_revision) })).filter(a => a.versions.length);
      return { attempt, member: members.find(a => a.id === attempt.memberId)!, members, mission: this.store.missionDto(m, this.now()), goal, contributions, referenceContributions, baselineArtifacts, sources, ...(task ? { task: { id: task.id, role: task.role, memberId: attempt.memberId, instruction: task.instruction, dependsOn: task.dependsOn, independent: task.independent, condition: task.condition } } : {}), artifacts, assessments: task?.independent ? [] : this.store.assessments(scope, m.id).filter(a => a.goalRevision === m.current_goal_revision) };
    });
  }
  private deliveryReady(m: MissionRow): boolean {
    const artifacts = this.store.artifacts(scopeOf(m), m.id);
    const artifact = artifacts.at(-1);
    const version = artifact?.versions.find(v => v.version === artifact.currentVersion);
    if (!artifact || !version || version.goalRevision !== m.current_goal_revision) return false;
    const reviews = this.store.assessments(scopeOf(m), m.id).filter(a => a.artifactId === artifact.id && a.artifactVersion === artifact.currentVersion && a.goalRevision === m.current_goal_revision && a.reviewerMemberId !== version.authorMemberId);
    return this.store.goal(m).criteria.filter(c => c.required).every(c => reviews.filter(a => a.criterionId === c.id).at(-1)?.verdict === 'passed');
  }
  private noProgress(m: MissionRow): boolean {
    const scope = scopeOf(m);
    const artifact = this.store.artifacts(scope, m.id).at(-1);
    const versions = artifact?.versions.filter(v => v.goalRevision === m.current_goal_revision) ?? [];
    if (!artifact || versions.length < 2) return false;
    const previous = versions.at(-2)!; const latest = versions.at(-1)!;
    if (previous.digest !== latest.digest) return false;
    const contributions = this.store.contributions(scope, m.id);
    const baseline = contributions.find(c => c.artifactId === artifact.id && c.artifactVersion === previous.version && c.kind === 'artifact')?.seq ?? 0;
    if (contributions.some(c => c.authorType === 'user' && c.audience.kind === 'room' && c.seq > baseline)) return false;
    if (this.store.get("SELECT seq FROM room_events WHERE room_id=? AND seq>? AND type IN ('source_granted','source_revoked')", m.room_id, baseline)) return false;
    const required = this.store.goal(m).criteria.filter(c => c.required).map(c => c.id);
    const assessments = this.store.assessments(scope, m.id).filter(a => a.artifactId === artifact.id && a.goalRevision === m.current_goal_revision);
    const gaps = (version: number) => required.filter(id => assessments.filter(a => a.artifactVersion === version && a.criterionId === id).at(-1)?.verdict !== 'passed');
    const before = gaps(previous.version); const after = gaps(latest.version);
    return before.length > 0 && digest(before) === digest(after);
  }
  accept(attempt: RoomAttempt, result: RoomFormalResult, now: number = this.now()): boolean {
    return this.store.atomic(() => {
      const bound = this.bound(attempt);
      if (!bound) return false;
      const hash = digest(result);
      if (bound.row.state === 'succeeded') {
        if (bound.row.result_digest !== hash) throw new RoomError('idempotency_conflict');
        return true;
      }
      if (!this.isCurrent(attempt, now) || bound.row.model_requests < 1) return false;
      // Repeat the strict formal projection at the persistence boundary, even for custom runtimes.
      let formal: RoomFormalResult;
      try { formal = parseRoomFormalResult(JSON.stringify(result), this.context(attempt)); }
      catch { throw new RoomError('invalid_request'); }
      const m = bound.m;
      const scope = scopeOf(m);
      if (formal.evidence?.length) {
        const context = this.context(attempt);
        const sources = this.store.sources(scope);
        for (const evidence of formal.evidence) {
          const source = sources.find(item => item.id === evidence.sourceId && item.version === evidence.sourceVersion && context.sources.some(allowed => allowed.id === item.id));
          if (!source || !source.content.includes(evidence.quote)) throw new RoomError('invalid_request');
        }
      }
      if (formal.decision === 'complete' && !this.deliveryReady(m)) throw new RoomError('state_conflict');
      let artifact: RoomArtifact | undefined;
      if (formal.artifact) {
        artifact = this.store.artifacts(scope, m.id).at(-1);
        if (artifact && (artifact.id !== bound.assignment.artifact_id || artifact.currentVersion !== bound.assignment.artifact_revision)) throw new RoomError('conflict');
        const id = artifact?.id ?? randomUUID();
        const revision = (artifact?.currentVersion ?? 0) + 1;
        if (!artifact) this.store.run('INSERT INTO room_artifacts(id,project_id,room_id,mission_id,owner_member_id,title,created_ts) VALUES(?,?,?,?,?,?,?)', id, m.project_id, m.room_id, m.id, attempt.memberId, formal.artifact.title, now);
        this.store.run('INSERT INTO room_artifact_revisions(project_id,room_id,mission_id,artifact_id,revision,goal_revision,title,markdown,digest,byte_size,source_attempt_id,created_ts,evidence_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', m.project_id, m.room_id, m.id, id, revision, m.current_goal_revision, formal.artifact.title, formal.artifact.markdown, createHash('sha256').update(formal.artifact.markdown).digest('hex'), Buffer.byteLength(formal.artifact.markdown, 'utf8'), attempt.id, now, formal.evidence ? JSON.stringify(formal.evidence) : null);
        this.store.run('UPDATE room_artifacts SET current_revision=?,title=? WHERE id=?', revision, formal.artifact.title, id);
        artifact = this.store.artifacts(scope, m.id).find(a => a.id === id)!;
      }
      if (formal.review) {
        if (formal.review.artifactId !== bound.assignment.artifact_id || formal.review.artifactVersion !== bound.assignment.artifact_revision) throw new RoomError('conflict');
        for (const assessment of formal.review.criteria) this.store.run('INSERT INTO room_assessments VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', randomUUID(), m.project_id, m.room_id, m.id, assessment.criterionId, m.current_goal_revision, formal.review.artifactId, formal.review.artifactVersion, attempt.memberId, assessment.verdict, assessment.note, now);
      }
      const kind = attempt.kind === 'reply' ? 'message' : formal.artifact ? 'artifact' : formal.review ? 'review' : formal.question ? 'question' : formal.decision ? 'decision' : 'plan';
      const question: RoomQuestion | undefined = formal.question ? { id: randomUUID(), text: formal.question.text, options: formal.question.options ?? [] } : undefined;
      this.addContribution(m, { authorType: 'member', authorId: attempt.memberId, kind, text: formal.message, audience: attempt.audience, assignmentId: attempt.assignmentId, replyTo: attempt.inputContributionId, artifactId: artifact?.id ?? formal.review?.artifactId, artifactVersion: artifact?.currentVersion ?? formal.review?.artifactVersion, question, evidence: formal.evidence }, now);
      for (const message of formal.messages ?? []) {
        const audience = this.audience(scope, message.audience);
        if (audience.kind !== 'members' || attempt.kind !== 'work' || attempt.audience.kind !== 'room') throw new RoomError('invalid_request');
        const id = this.addContribution(m, { authorType: 'member', authorId: attempt.memberId, kind: 'message', text: message.text, audience, assignmentId: attempt.assignmentId }, now);
        for (const memberId of audience.memberIds) if (memberId !== attempt.memberId) this.insertAssignment(m, memberId, 'reply', audience, now, id);
      }
      this.store.run("UPDATE room_attempts SET state='succeeded',result_digest=?,updated_ts=? WHERE id=? AND fence=?", hash, now, attempt.id, attempt.fence);
      this.store.run("UPDATE room_assignments SET state='succeeded' WHERE id=?", attempt.assignmentId);
      if (attempt.kind === 'work') {
        if (attempt.role === 'coach') {
          if (formal.decision === 'ask_user') {
            this.store.run('UPDATE room_missions SET question_json=? WHERE id=?', JSON.stringify(question), m.id);
            this.quiesce(m, 'waiting_user', 'user_input_required', now);
          } else if (formal.decision === 'complete') {
            const pending = this.store.get<{ n: number }>("SELECT COUNT(*) AS n FROM room_assignments WHERE mission_id=? AND state='pending'", m.id)!.n;
            this.store.run("UPDATE room_missions SET next_role='coach',phase='finalizing' WHERE id=?", m.id);
            if (!pending) {
              this.store.run("UPDATE room_rounds SET state='completed' WHERE mission_id=? AND state='running'", m.id);
              this.setState(m, 'completed', now);
            }
          } else {
            const limits = JSON.parse(m.budget_json) as RoomBudgetLimits;
            if (this.noProgress(m)) this.quiesce(m, 'interrupted', 'no_progress', now);
            else if (m.round >= limits.rounds) this.quiesce(m, 'exhausted', 'round_limit', now);
            else {
              this.store.run("UPDATE room_rounds SET state='completed' WHERE mission_id=? AND state='running'", m.id);
              const hasPlanner = this.store.members(scope).some(member => member.status === 'active' && member.role === 'planner');
              const tasks: RoomPlanTask[] = formal.plan?.tasks ?? [
                ...(hasPlanner ? [{ id: 'plan', role: 'planner' as const, instruction: formal.message, dependsOn: [] }] : []),
                { id: 'write', role: 'writer', instruction: formal.message, dependsOn: hasPlanner ? ['plan'] : [] },
                { id: 'review', role: 'reviewer', instruction: formal.message, dependsOn: ['write'] },
              ];
              this.store.run('INSERT INTO room_rounds(id,project_id,room_id,mission_id,ordinal,goal_revision,plan_json,created_ts) VALUES(?,?,?,?,?,?,?,?)', randomUUID(), m.project_id, m.room_id, m.id, m.round + 1, m.current_goal_revision, JSON.stringify({ tasks }), now);
              this.store.run("UPDATE room_missions SET round=round+1,next_role='planner',phase='producing' WHERE id=?", m.id);
              const updated = this.store.mission(scope, m.id);
              this.insertPlan(updated, tasks, now);
              const ready = this.readyAssignment(updated);
              if (ready) this.store.run('UPDATE room_missions SET next_role=? WHERE id=?', this.store.get<MemberRow>('SELECT * FROM room_members WHERE id=?', ready.member_id)!.role_key, m.id);
              this.store.run("INSERT INTO room_budget_entries(mission_id,dimension,amount,operation_key,op,created_ts) VALUES(?,'rounds',1,?,'consume',?)", m.id, attempt.id, now);
            }
          }
        } else {
          const pending = this.readyAssignment(m);
          const nextRole: RoomRole = bound.assignment.task_key ? (pending?.kind === 'work' ? this.store.get<MemberRow>('SELECT * FROM room_members WHERE id=?', pending.member_id)!.role_key : 'coach') : attempt.role === 'planner' ? 'writer' : attempt.role === 'writer' ? 'reviewer' : 'coach';
          this.store.run('UPDATE room_missions SET next_role=?,phase=? WHERE id=?', nextRole, nextRole === 'reviewer' ? 'reviewing' : nextRole === 'coach' ? 'finalizing' : 'producing', m.id);
        }
      }
      this.store.run('UPDATE room_missions SET version=version+1,updated_ts=? WHERE id=?', now, m.id);
      this.store.event(scope, 'assignment_completed', attempt.assignmentId, now);
      return true;
    });
  }
  fail(attempt: RoomAttempt, code: string, now: number = this.now()): void {
    this.store.atomic(() => {
      const current = this.bound(attempt);
      if (!current || (current.row.state !== 'running' && current.row.state !== 'reserved') || (current.row.cancel_mode === 'detach' && current.row.lease_until <= now)) return;
      // Only stable classifications enter public state. Never persist raw exception messages.
      const allowed = new Set(['cancelled', 'access_revoked', 'not_configured', 'provider_auth', 'provider_rate_limited', 'provider_unavailable', 'provider_rejected', 'protocol_invalid', 'context_too_large', 'response_too_large', 'scope_mismatch', 'timeout', 'runtime_failed', 'execution_failed', 'capability_unsupported', 'tool_forbidden', 'tool_limit', 'budget_exhausted']);
      const reason = allowed.has(code) ? code : 'execution_failed';
      if (current.row.cancel_mode === 'confirm') {
        // A rejected/aborted Promise is not evidence that a subprocess stopped.
        this.store.run("UPDATE room_attempts SET state='uncertain',failure_code=?,updated_ts=? WHERE id=? AND fence=?", reason, now, attempt.id, attempt.fence);
        this.store.run("UPDATE room_assignments SET state='failed',failure_code=? WHERE id=?", reason, attempt.assignmentId);
        if (current.m.state !== 'quiescing') this.quiesce(current.m, 'interrupted', reason, now);
        return;
      }
      const cancelled = current.m.state === 'quiescing' || reason === 'cancelled';
      this.releaseUnsent(current.row, now);
      this.store.run('UPDATE room_attempts SET state=?,failure_code=?,updated_ts=? WHERE id=? AND fence=?', cancelled ? 'cancelled' : 'failed', reason, now, attempt.id, attempt.fence);
      this.store.run("UPDATE room_assignments SET state='failed',failure_code=? WHERE id=? AND state='running'", reason, attempt.assignmentId);
      if (current.m.state === 'quiescing') this.settleQuiescing(current.m.id, now);
      else if (isRoomRunnable(current.m.state)) this.quiesce(current.m, 'interrupted', reason, now);
    });
  }
  recover(now: number = this.now()): void {
    this.store.atomic(() => {
      const expired = this.store.all<AttemptRow>("SELECT * FROM room_attempts WHERE state IN ('reserved','running') AND (lease_until<=? OR deadline_ts<=?)", now, now);
      for (const row of expired) {
        const m = this.store.mission(scopeOf(row), row.mission_id);
        if (row.cancel_mode === 'detach') this.releaseUnsent(row, now);
        this.store.run("UPDATE room_attempts SET state='uncertain',failure_code='lease_expired',updated_ts=? WHERE id=?", now, row.id);
        this.store.run("UPDATE room_assignments SET state='failed',failure_code='lease_expired' WHERE id=?", row.assignment_id);
        this.store.run('UPDATE room_members SET fence_counter=fence_counter+1 WHERE id=?', row.member_id);
        this.invalidate(m);
        if (m.state === 'quiescing') {
          if (row.cancel_mode === 'detach') {
            this.store.run("UPDATE room_attempts SET state='cancelled' WHERE id=?", row.id);
            this.settleQuiescing(m.id, now);
          }
        } else if (isRoomRunnable(m.state)) {
          const timeExpired = this.store.missionDto(m, now).budget.activeMs >= (JSON.parse(m.budget_json) as RoomBudgetLimits).activeMs;
          if (row.cancel_mode === 'confirm') this.quiesce(m, timeExpired ? 'exhausted' : 'interrupted', timeExpired ? 'time_limit' : 'lease_expired', now);
          else this.setState(m, timeExpired ? 'exhausted' : 'interrupted', now, timeExpired ? 'time_limit' : 'lease_expired');
        }
      }
      const active = this.store.all<MissionRow>("SELECT * FROM room_missions WHERE state IN ('queued','running')");
      for (const m of active) {
        if (this.store.missionDto(m, now).budget.activeMs >= (JSON.parse(m.budget_json) as RoomBudgetLimits).activeMs) this.quiesce(m, 'exhausted', 'time_limit', now);
      }
      for (const m of this.store.all<MissionRow>("SELECT * FROM room_missions WHERE state='quiescing'")) this.settleQuiescing(m.id, now);
    });
  }
}

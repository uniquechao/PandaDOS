import type { Database } from 'bun:sqlite';
import { diagnosticData, redactDiagnostic, redactDiagnosticValue } from '../../shared/issue-diagnostics';
import { parseLines, type JsonlReader } from '../core/jsonl';
import type { AgentKind, IssueId, Project, User } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { getProject, type EngineIssue, type IssueEngine } from '../issues/engine';
import type { ModuleMergeAgent } from '../issues/module-merge-agent';
import type { KeyedMutex } from '../issues/mutex';
import { observeRemoteCandidate } from '../issues/git-target-evidence';
import type { IssueIncidentService } from './issue-incidents';

export type WorktreeAction = 'pause' | 'resume' | 'takeover' | 'return' | 'recheck' | 'verify-push';
const actions = new Set<WorktreeAction>(['pause', 'resume', 'takeover', 'return', 'recheck', 'verify-push']);
const evidenceKinds = [
  'integration_wait', 'validation_started', 'validation_failed', 'validation_error',
  'validation_invalidated', 'validation_passed', 'validation_reused', 'validation_diagnostic',
  'environment_preparation_failed', 'workspace_integrated', 'workspace_retained', 'workspace_released',
  'auto_push_failed', 'workspace_push_requested', 'workspace_push_receipt', 'workspace_push_verified', 'merge_agent_started', 'merge_agent_resolved',
  'merge_agent_failed', 'merge_agent_timed_out', 'merge_agent_superseded', 'worktree_action',
  'worktree_action_failed', 'pm_loop_instruction',
];
const observedKinds = [...evidenceKinds, 'merge_agent_guidance'];
type Actor = Pick<User, 'id' | 'role'>;
type IssuePort = Pick<IssueEngine, 'store' | 'incidentHeld' | 'incidentWorkspace' | 'pauseWorktreeIntegration' | 'confirmWorktreeStopped' | 'retryWorkspace' | 'recheckWorktreeIntegration' | 'openIncident'>;

interface IntegrationRow {
  id: string;
  phase: string;
  cwd: string;
  target_sha: string;
  candidate_sha: string | null;
  diagnostic: string | null;
}
interface MergeRun {
  id: string;
  integration_id: string;
  agent: AgentKind;
  state: string;
  conversation_id: string;
  stop_confirmed: number;
  diagnostic: string | null;
  question: string | null;
  answer: string | null;
}
interface WorktreeDeps {
  db: Database;
  engine: IssuePort;
  mergeAgent: Pick<ModuleMergeAgent, 'sendGuidance'>;
  incidents: Pick<IssueIncidentService, 'resolve'>;
  mutex: KeyedMutex;
  driverForProject: (project: Project) => ExecutorDriver;
  historyForProject: (project: Project) => { reader: JsonlReader; locator: { locate(id: string): Promise<string | null> } };
}

export class WorktreeRequestError extends Error {
  constructor(readonly code: string, readonly status: number = 409, readonly detail?: string) { super(code); }
}

export class IssueWorktreeService {
  constructor(private readonly deps: WorktreeDeps) {}

  private issue(projectId: number, id: IssueId): { issue: EngineIssue; project: Project } {
    const issue = this.deps.engine.store.get(id);
    const project = issue?.projectId === projectId ? getProject(this.deps.db, projectId) : undefined;
    if (!issue || !project) throw new WorktreeRequestError('worktree.not_found', 404);
    return { issue, project };
  }

  private snapshot(issue: EngineIssue, project: Project, actor: Actor) {
    const { db, engine } = this.deps;
    const attempt = engine.incidentWorkspace(issue.id);
    const run = attempt && db.query<MergeRun, [string]>(`
      SELECT r.*, COALESCE(r.agent,c.agent,a.agent) AS agent
      FROM workspace_merge_agents r JOIN workspace_attempts a ON a.id=r.attempt_id
      LEFT JOIN conversations c ON c.id=r.conversation_id AND c.project_id=r.project_id
      WHERE r.attempt_id=? ORDER BY r.rowid DESC LIMIT 1`).get(attempt.id);
    const integration = attempt && db.query<IntegrationRow, [string, string | null]>(`
      SELECT id,phase,cwd,target_sha,candidate_sha,diagnostic FROM workspace_integrations
      WHERE attempt_id=? ORDER BY (id=COALESCE(?,'')) DESC, rowid DESC LIMIT 1`).get(attempt.id,run && !run.stop_confirmed ? run.integration_id : null);
    const incident = attempt && db.query<{ id: string; state: string }, [IssueId, string]>(`
      SELECT n.id,n.state FROM issue_incidents n JOIN issue_events e ON e.issue_id=n.issue_id
       AND e.kind='worktree_action' AND json_extract(e.data_json,'$.incidentId')=n.id
      WHERE n.issue_id=? AND n.attempt_id=? AND n.state IN ('open','queued')
      ORDER BY n.created_ts DESC LIMIT 1`).get(issue.id, attempt.id);
    const events = db.query<{ id: number; ts: number; kind: string; dataJson: string | null }, (IssueId | string)[]>(`
      SELECT id,ts,kind,data_json AS dataJson FROM issue_events
      WHERE issue_id=? AND kind IN (${observedKinds.map(() => '?').join(',')})
      ORDER BY id DESC LIMIT 64`).all(issue.id, ...observedKinds);
    const canManage = actor.role === 'admin' || actor.id === project.ownerUserId;
    const validAttempt = Boolean(attempt && attempt.released_ts === null && attempt.executor_id === project.executorId &&
      db.query('SELECT 1 FROM module_workspaces WHERE current_attempt=? AND project_id=?').get(attempt.id,project.id));
    const held = engine.incidentHeld(issue.id);
    const allowedActions: WorktreeAction[] = [];
    if (canManage && validAttempt) {
      if (issue.status === 'merging' && !attempt?.integrated_sha && !held) {
        if (attempt?.result_sha) allowedActions.push('pause', 'takeover');
        if (!run || run.stop_confirmed) allowedActions.push('recheck');
      }
      if (issue.status === 'paused' && !held) {
        allowedActions.push('resume');
        if (attempt?.result_sha && !attempt.integrated_sha) allowedActions.push('takeover');
      }
      if (issue.status === 'paused' && incident?.state === 'open') allowedActions.push('return');
    }
    const push = events.find(e => ['auto_push_failed','workspace_push_verified','workspace_integrated'].includes(e.kind));
    if (attempt?.integrated_sha && push?.kind === 'auto_push_failed' && canManage) allowedActions.push('verify-push');
    const guidanceUnconfirmed = run && db.query(`SELECT 1 FROM issue_effect_journal WHERE issue_id=?
      AND status IN ('running','uncertain') AND instr(operation_key,?)=1`).get(issue.id,`merge-chat:${run.id}:`);
    return { attempt, run, integration, incident, events, allowedActions,
      canSend: Boolean(validAttempt && !held && !guidanceUnconfirmed && run && ((run.state === 'running' && !run.stop_confirmed) ||
        (run.state === 'clarification' && run.stop_confirmed && !run.answer))
        && issue.status === 'merging' && integration && ['conflict','validation_failed'].includes(integration.phase)),
    };
  }

  async view(projectId: number, id: IssueId, actor: Actor) {
    const { issue, project } = this.issue(projectId, id);
    const { attempt, run, integration, incident, events, allowedActions, canSend } = this.snapshot(issue, project, actor);
    const messages: Array<{ id: string; role: 'user' | 'assistant'; text: string; ts: number }> = [];
    if (run) {
      for (const event of events) {
        if (event.kind !== 'merge_agent_guidance') continue;
        const data = diagnosticData(event);
        if (data.runId === run.id && typeof data.text === 'string')
          messages.push({ id: 'guidance-' + event.id, role: 'user', text: redactDiagnostic(data.text), ts: event.ts });
      }
      if (attempt?.executor_id === project.executorId) {
        try {
          const history = this.deps.historyForProject(project);
          const jsonl = await history.locator.locate(run.conversation_id);
          if (jsonl) {
            const size = (await history.reader.statPath(jsonl))?.size ?? 0;
            const offset = Math.max(0, size - 256 * 1024);
            if (size) {
              const { data } = await history.reader.readFileRange(jsonl, offset, size - offset);
              const lines = new TextDecoder().decode(data).split('\n');
              lines.pop(); // Only expose completed JSONL records.
              if (offset) lines.shift(); // The byte window may start inside a record.
              for (const entry of parseLines(lines, 0).msgs.slice(-80)) {
                if (entry.role !== 'assistant' || !entry.text?.trim()) continue;
                messages.push({ id: 'assistant-' + run.id + '-' + offset + '-' + entry.seq, role: 'assistant',
                  text: redactDiagnostic(entry.text.slice(0, 6000)), ts: entry.ts ?? 0 });
              }
            }
          }
        } catch { /* Session facts and persisted human guidance are still available. */ }
      }
    }
    return {
      workspace: attempt ? { attemptId: attempt.id, phase: attempt.phase, cwd: attempt.cwd, branch: attempt.branch,
        resultSha: attempt.result_sha, integratedSha: attempt.integrated_sha, stopConfirmed: Boolean(attempt.stop_confirmed),
        released: attempt.released_ts !== null, diagnostic: attempt.diagnostic ? redactDiagnostic(attempt.diagnostic) : null } : null,
      integration: integration ? { id: integration.id, phase: integration.phase, cwd: integration.cwd, targetSha: integration.target_sha,
        candidateSha: integration.candidate_sha, diagnostic: integration.diagnostic ? redactDiagnostic(integration.diagnostic) : null } : null,
      mergeAgent: run ? { id: run.id, agent: run.agent, state: run.state, conversationId: run.conversation_id, canSend,
        stopConfirmed: Boolean(run.stop_confirmed), diagnostic: run.diagnostic ? redactDiagnostic(run.diagnostic) : null,
        question: run.question ? redactDiagnostic(run.question) : null } : null,
      targetBranch: project.integrationBranch ?? project.workBranch,
      incidentId: incident?.id ?? null,
      nextCheckTs: this.deps.db.query<{ next_check_ts: number }, [IssueId]>('SELECT next_check_ts FROM issue_pm_loops WHERE issue_id=?').get(id)?.next_check_ts ?? null,
      writer: !attempt || attempt.released_ts !== null ? 'none' : incident?.state === 'open' && attempt.stop_confirmed && (!run || run.stop_confirmed) ? 'human' :
        run && !run.stop_confirmed ? (run.state === 'running' ? 'merge-agent' : 'unknown') :
        issue.status === 'merging' && integration && ['merging', 'validating'].includes(integration.phase) ? 'system' :
        !attempt.result_sha && !attempt.stop_confirmed ? (issue.status === 'implementing' ? 'execution-agent' : 'unknown') : 'none',
      messages: messages.sort((a, b) => a.ts - b.ts).slice(-60),
      events: events.filter(e => e.kind !== 'merge_agent_guidance').map(e => ({ kind: e.kind, ts: e.ts, data: redactDiagnosticValue(diagnosticData(e)) })),
      allowedActions,
    };
  }

  async send(projectId: number, id: IssueId, actor: Actor, runId: string, requestId: string, text: string) {
    const { issue, project } = this.issue(projectId, id);
    const previous = this.deps.db.query<{ dataJson: string }, [IssueId, string, string]>(`SELECT data_json AS dataJson FROM issue_events
      WHERE issue_id=? AND kind='merge_agent_guidance' AND json_extract(data_json,'$.runId')=? AND json_extract(data_json,'$.requestId')=?`).get(id,runId,requestId);
    if (previous) {
      const receipt = JSON.parse(previous.dataJson);
      if (receipt.actor === actor.id && receipt.text === text.trim()) return;
      throw new WorktreeRequestError('worktree.operation_unconfirmed');
    }
    const state = this.snapshot(issue, project, actor);
    if (!state.canSend || state.run?.id !== runId) throw new WorktreeRequestError('worktree.stale');
    await this.deps.mergeAgent.sendGuidance({ issueId: id, projectId, runId, requestId, text, actor: actor.id });
  }

  async action(projectId: number, id: IssueId, actor: Actor, attemptId: string, requestId: string, action: WorktreeAction) {
    const { engine, db } = this.deps;
    if (!actions.has(action) || !/^[\w-]{1,100}$/.test(requestId)) throw new WorktreeRequestError('worktree.invalid_request', 400);
    await this.deps.mutex.runExclusive('worktree-action:' + id, async () => {
      const { issue, project } = this.issue(projectId, id);
      if (actor.role !== 'admin' && actor.id !== project.ownerUserId) throw new WorktreeRequestError('worktree.forbidden', 403);
      const saved = db.query<{ kind: string; dataJson: string }, [IssueId, string]>(`
        SELECT kind,data_json AS dataJson FROM issue_events WHERE issue_id=? AND
        kind IN ('worktree_action_requested','worktree_action','worktree_action_failed') AND json_extract(data_json,'$.requestId')=?
        ORDER BY id DESC LIMIT 1`).get(id, requestId);
      const details = { attemptId, requestId, action, actor: actor.id };
      if (saved) {
        const prior = JSON.parse(saved.dataJson);
        const same = prior.attemptId === attemptId && prior.action === action && prior.actor === actor.id;
        if (same && saved.kind === 'worktree_action') return;
        // A remote read can always be repeated. Takeover confirms the same physical stop again;
        // successful incident creation and the action receipt commit in the same transaction.
        if (!same || !['verify-push','recheck','takeover'].includes(action))
          throw new WorktreeRequestError('worktree.operation_unconfirmed');
      }
      const state = this.snapshot(issue, project, actor);
      if (!state.attempt || state.attempt.id !== attemptId || !state.allowedActions.includes(action)) throw new WorktreeRequestError('worktree.stale');
      engine.store.logEvent(id, 'worktree_action_requested', details);
      try {
        if (action === 'pause' || action === 'takeover') {
          if (issue.status === 'merging') {
            const result = await engine.pauseWorktreeIntegration(id, attemptId, actor.id);
            if (!result.ok) throw new WorktreeRequestError('worktree.stale');
          }
          if (action === 'takeover') {
            await engine.openIncident(id, actor.id, 'en', attemptId, incidentId => {
              engine.store.logEvent(id, 'worktree_action', { ...details, incidentId });
            });
            return;
          }
          await engine.confirmWorktreeStopped(id,attemptId);
        } else if (action === 'return') {
          if (!state.incident) throw new WorktreeRequestError('worktree.stale');
          await this.deps.incidents.resolve(id, state.incident.id, requestId, 'Human maintainer returned the merge candidate. Recheck the retained candidate and run required verification.', actor.id);
        } else if (action === 'verify-push') {
          await this.verifyPush(project, id, state.attempt.integrated_sha!);
        } else {
          if (action === 'recheck' && state.run && !state.run.stop_confirmed)
            throw new WorktreeRequestError('worktree.agent_not_ready');
          const result = action === 'recheck' ? await engine.recheckWorktreeIntegration(id, attemptId) : await engine.retryWorkspace(id, actor.id);
          if (!result.ok) throw new WorktreeRequestError('worktree.operation_unconfirmed', 409, result.error);
        }
        engine.store.logEvent(id, 'worktree_action', details);
      } catch (error) {
        engine.store.logEvent(id, 'worktree_action_failed', { ...details, detail: redactDiagnostic(String(error)).slice(0, 500) });
        throw error;
      }
    });
  }

  private async verifyPush(project: Project, id: IssueId, candidate: string): Promise<void> {
    const target = project.integrationBranch ?? project.workBranch;
    if (!target) throw new WorktreeRequestError('worktree.stale');
    const driver = this.deps.driverForProject(project);
    const observed = await observeRemoteCandidate(driver,project.cwd,target,candidate);
    if (!observed?.included) throw new WorktreeRequestError('worktree.operation_unconfirmed');
    this.deps.engine.store.logEvent(id, 'workspace_push_verified', { candidate, target, tip:observed.tip });
  }
}

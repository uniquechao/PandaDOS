import { createHash, randomUUID } from 'node:crypto';
import type { SupportedLocale } from '../../shared/i18n/locales';
import type { DesignPersonaRegistry, ResolvedPersona } from './personas';
import type { DesignRunner, RunDesignResult } from './runner';
import { DesignRevisionConflictError, type DesignStore } from './store';
import type { DesignAgentRunGroup, DesignAgentRunMode, DesignTask } from './types';

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_PERSONAS = 10;
const MAX_CONTEXT_BYTES = 1024 * 1024;

export type DesignRunCoordinatorErrorCode =
  | 'DESIGN_RUN_NOT_FOUND'
  | 'DESIGN_RUN_FORBIDDEN'
  | 'DESIGN_RUN_INVALID'
  | 'DESIGN_RUN_STALE'
  | 'DESIGN_RUN_IDEMPOTENCY_CONFLICT'
  | 'DESIGN_RUN_NOT_ACTIONABLE'
  | 'DESIGN_RUN_FAILED';

export class DesignRunCoordinatorError extends Error {
  constructor(
    readonly code: DesignRunCoordinatorErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'DesignRunCoordinatorError';
  }
}

export interface StartDesignRunInput {
  expectedRevision: number;
  mode: DesignAgentRunMode;
  message?: string;
  personas?: string[];
  idempotencyKey: string;
  actorUserId: number;
  locale?: SupportedLocale;
}

export interface DesignRunView {
  id: string;
  designId: number;
  projectId: number;
  mode: DesignAgentRunMode;
  sourceRevision: number;
  status: DesignAgentRunGroup['status'];
  personas: string[];
  cancelRequested: boolean;
  failureCode: string | null;
  createdTs: number;
  startedTs: number | null;
  finishedTs: number | null;
  updatedTs: number;
}

export interface DesignRunCoordinatorDeps {
  store: DesignStore;
  personas: DesignPersonaRegistry;
  project(projectId: number): { id: number; cwd: string } | null;
  runnerForProject(projectId: number): DesignRunner;
  now?: () => number;
  idFactory?: () => string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function view(group: DesignAgentRunGroup): DesignRunView {
  return {
    id: group.id,
    designId: group.designTaskId,
    projectId: group.projectId,
    mode: group.mode,
    sourceRevision: group.sourceRevision,
    status: group.status,
    personas: [...group.personaKeys],
    cancelRequested: group.cancelRequested,
    failureCode: group.failureCode,
    createdTs: group.createdTs,
    startedTs: group.startedTs,
    finishedTs: group.finishedTs,
    updatedTs: group.updatedTs,
  };
}

function allowedSpecialist(mode: DesignAgentRunMode, role: ResolvedPersona['manifest']['role']): boolean {
  if (mode === 'goal') return role === 'goal_coach' || role === 'reviewer';
  if (mode === 'graph') return role === 'issue_planner' || role === 'reviewer' || role === 'independent_verifier';
  return role === 'reviewer' || role === 'independent_verifier';
}

function personaKeyPlan(mode: DesignAgentRunMode, selectors: readonly string[]): string[] {
  const required = mode === 'goal'
    ? ['builtin:goal-coach']
    : mode === 'graph'
      ? ['builtin:issue-planner']
      : mode === 'review'
        ? ['builtin:general-reviewer', 'builtin:independent-verifier']
        : ['builtin:general-reviewer'];
  return [...new Set([...required, ...selectors.map((value) => value.trim()), 'builtin:design-steward'])];
}

export class DesignRunCoordinator {
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly flights = new Map<string, Promise<void>>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly localeByRun = new Map<string, SupportedLocale | undefined>();
  private stopped = false;

  constructor(private readonly deps: DesignRunCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
    this.idFactory = deps.idFactory ?? randomUUID;
  }

  start(projectId: number, designId: number, input: StartDesignRunInput): DesignRunView {
    if (this.stopped) throw new DesignRunCoordinatorError('DESIGN_RUN_FAILED', 'design run coordinator is stopped');
    if (!Number.isSafeInteger(projectId) || projectId <= 0
      || !Number.isSafeInteger(designId) || designId <= 0
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0
      || !Number.isSafeInteger(input.actorUserId) || input.actorUserId <= 0
      || !IDEMPOTENCY_RE.test(input.idempotencyKey)
      || !['goal', 'solution', 'review', 'graph'].includes(input.mode)) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_INVALID', 'invalid design run request');
    }
    const message = input.message?.trim() || null;
    if (message !== null && message.length > MAX_MESSAGE_CHARS) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_INVALID', 'design run message is too long');
    }
    const selectors = input.personas ?? [];
    if (selectors.length > MAX_PERSONAS
      || selectors.some((selector) => typeof selector !== 'string' || !selector.trim() || selector.length > 160)
      || new Set(selectors).size !== selectors.length) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_INVALID', 'invalid design run personas');
    }
    const task = this.deps.store.getTask(designId);
    if (!task || task.projectId !== projectId || !this.deps.project(projectId)) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'design not found');
    }
    const personaKeys = personaKeyPlan(input.mode, selectors);
    const requestDigest = digest({
      designId,
      projectId: task.projectId,
      expectedRevision: input.expectedRevision,
      mode: input.mode,
      message,
      personas: personaKeys,
      actorUserId: input.actorUserId,
    });
    const replay = this.deps.store.getAgentRunGroupByIdempotency(task.projectId, input.idempotencyKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) {
        throw new DesignRunCoordinatorError('DESIGN_RUN_IDEMPOTENCY_CONFLICT', 'idempotency key conflict');
      }
      if (input.locale) this.localeByRun.set(replay.id, input.locale);
      this.launch(replay.id);
      return view(replay);
    }
    if (task.status !== 'active') {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'design not found');
    }
    if (task.currentRevision !== input.expectedRevision) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_STALE', 'design revision changed', task.currentRevision);
    }
    this.requireModeStage(task, input.mode);
    let resolved: ResolvedPersona[];
    try {
      resolved = this.resolvePersonas(task, input.mode, selectors);
    } catch (error) {
      if (error instanceof DesignRunCoordinatorError) throw error;
      throw new DesignRunCoordinatorError('DESIGN_RUN_INVALID', 'design run persona selection is invalid');
    }
    const id = this.idFactory();
    if (!RUN_ID_RE.test(id)) throw new DesignRunCoordinatorError('DESIGN_RUN_FAILED', 'invalid run allocation');
    let ensured;
    try {
      ensured = this.deps.store.ensureAgentRunGroup({
        id,
        designTaskId: designId,
        projectId: task.projectId,
        idempotencyKey: input.idempotencyKey,
        requestDigest,
        mode: input.mode,
        sourceRevision: input.expectedRevision,
        message,
        personaKeys,
        createdByUserId: input.actorUserId,
        now: this.now(),
      });
    } catch (error) {
      if (error instanceof DesignRevisionConflictError) {
        throw new DesignRunCoordinatorError('DESIGN_RUN_STALE', 'design revision changed', error.currentRevision);
      }
      if (/idempotency conflict/i.test(String(error))) {
        throw new DesignRunCoordinatorError('DESIGN_RUN_IDEMPOTENCY_CONFLICT', 'idempotency key conflict');
      }
      throw new DesignRunCoordinatorError('DESIGN_RUN_FAILED', 'design run could not be queued');
    }
    if (input.locale) this.localeByRun.set(ensured.group.id, input.locale);
    this.launch(ensured.group.id);
    return view(ensured.group);
  }

  getScoped(projectId: number, designId: number, runId: string): DesignRunView {
    const group = this.deps.store.getAgentRunGroup(runId);
    if (!group || group.projectId !== projectId || group.designTaskId !== designId) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'design run not found');
    }
    return view(group);
  }

  listScoped(projectId: number, designId: number, limit = 20): DesignRunView[] {
    const task = this.deps.store.getTask(designId);
    if (!task || task.projectId !== projectId) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'design not found');
    }
    return this.deps.store.listAgentRunGroups(designId, limit)
      .filter((group) => group.projectId === projectId)
      .map(view);
  }

  cancel(projectId: number, designId: number, runId: string, expectedRevision: number): DesignRunView {
    const group = this.deps.store.getAgentRunGroup(runId);
    const task = this.deps.store.getTask(designId);
    if (!group || !task || group.projectId !== projectId || group.designTaskId !== designId
      || task.projectId !== projectId) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'design run not found');
    }
    if (task.currentRevision !== expectedRevision) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_STALE', 'design revision changed', task.currentRevision);
    }
    if (group.status === 'completed' || group.status === 'failed' || group.status === 'cancelled') {
      throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_ACTIONABLE', 'design run is already terminal');
    }
    const updated = this.deps.store.requestAgentRunCancellation(runId, this.now());
    if (!updated) throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_ACTIONABLE', 'design run cannot be cancelled');
    this.aborts.get(runId)?.abort('cancel');
    return view(updated);
  }

  async recoverStartup(limit = 25): Promise<number> {
    if (this.stopped) return 0;
    const groups = this.deps.store.listRecoverableAgentRunGroups(limit);
    for (const group of groups) {
      if (group.status === 'running') {
        const task = this.deps.store.getTask(group.designTaskId);
        const project = this.deps.project(group.projectId);
        if (task && project && task.projectId === group.projectId) {
          try {
            await this.deps.runnerForProject(group.projectId).recoverInterrupted(
              project.cwd,
              group.designTaskId,
            );
          } catch {
            // The durable group remains recoverable even when scratch recovery is unavailable.
          }
          const intents = this.deps.store.listRunIntentsByOperationGroup(group.designTaskId, group.id);
          if (group.personaKeys.every((key) => intents.some((intent) => (
            intent.key === key && intent.state === 'ingested'
          )))) {
            this.deps.store.completeAgentRunGroup(group.id, 'completed', null, this.now());
            continue;
          }
        }
        this.deps.store.interruptAgentRunGroup(group.id, this.now());
      }
      this.launch(group.id);
    }
    return groups.length;
  }

  async wait(runId: string): Promise<void> {
    await this.flights.get(runId);
  }

  async stop(timeoutMs = 5_000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const activeIds = [...this.flights.keys()];
    for (const abort of this.aborts.values()) abort.abort('shutdown');
    const active = [...this.flights.values()];
    if (active.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(1, timeoutMs)); }),
      ]);
      if (timer) clearTimeout(timer);
    }
    for (const runId of activeIds) {
      try { this.deps.store.interruptAgentRunGroup(runId, this.now()); } catch { /* DB may already be closing. */ }
    }
  }

  private launch(runId: string): void {
    if (this.stopped || this.flights.has(runId)) return;
    const flight = Promise.resolve().then(() => this.execute(runId)).catch(() => {
      // Leave infrastructure failures durably recoverable without exposing raw errors
      // or creating an unhandled background rejection.
      try {
        this.deps.store.interruptAgentRunGroup(runId, this.now());
      } catch {
        // A closing database is handled by the next process startup recovery.
      }
    }).finally(() => {
      this.flights.delete(runId);
      this.aborts.delete(runId);
      this.localeByRun.delete(runId);
    });
    this.flights.set(runId, flight);
  }

  private async execute(runId: string): Promise<void> {
    if (this.stopped) return;
    const group = this.deps.store.claimAgentRunGroup(runId, this.now());
    if (!group) return;
    const task = this.deps.store.getTask(group.designTaskId);
    const project = this.deps.project(group.projectId);
    if (!task || !project || task.projectId !== group.projectId || task.currentRevision !== group.sourceRevision) {
      this.deps.store.completeAgentRunGroup(runId, 'failed', 'design.run_stale', this.now());
      return;
    }
    let personas: ResolvedPersona[];
    try {
      personas = group.personaKeys.map((key) => this.deps.personas.resolveForRun(group.projectId, key, task.agent));
    } catch {
      this.deps.store.completeAgentRunGroup(runId, 'failed', 'design.run_persona_invalid', this.now());
      return;
    }
    let contextMarkdown: string;
    try {
      contextMarkdown = this.context(task, group);
    } catch {
      this.deps.store.completeAgentRunGroup(runId, 'failed', 'design.run_stale', this.now());
      return;
    }
    if (byteLength(contextMarkdown) > MAX_CONTEXT_BYTES) {
      this.deps.store.completeAgentRunGroup(runId, 'failed', 'design.run_context_too_large', this.now());
      return;
    }
    const abort = new AbortController();
    this.aborts.set(runId, abort);
    let result: RunDesignResult;
    try {
      result = await this.deps.runnerForProject(group.projectId).run({
        projectId: group.projectId,
        designId: group.designTaskId,
        cwd: project.cwd,
        agent: task.agent,
        sourceRevision: group.sourceRevision,
        operationGroupId: group.id,
        contextMarkdown,
        personas,
        locale: this.localeByRun.get(runId),
      }, { signal: abort.signal });
    } catch {
      result = { ok: false, reason: 'runner-error' };
    }
    if (this.stopped) return;
    const latest = this.deps.store.getAgentRunGroup(runId);
    if (abort.signal.aborted || latest?.cancelRequested) {
      this.deps.store.completeAgentRunGroup(runId, 'cancelled', null, this.now());
    } else if (result.ok) {
      this.deps.store.completeAgentRunGroup(runId, 'completed', null, this.now());
    } else {
      this.deps.store.completeAgentRunGroup(runId, 'failed', 'design.run_failed', this.now());
    }
  }

  private context(task: DesignTask, group: DesignAgentRunGroup): string {
    const revision = this.deps.store.getRevision(task.id, group.sourceRevision);
    if (!revision) throw new DesignRunCoordinatorError('DESIGN_RUN_STALE', 'design revision not found');
    const events = this.deps.store.listRecentEvents(task.id, 100).map((event) => ({
      id: event.id, kind: event.kind, data: event.data, ts: event.ts,
    }));
    return [
      '# Canonical Design Run Context',
      `Mode: ${group.mode}`,
      `Design ID: ${task.id}`,
      `Source revision: ${group.sourceRevision}`,
      `Agent: ${task.agent}`,
      `Graph granularity: ${task.graphGranularity}`,
      group.message ? `\n## Owner input\n${group.message}` : '',
      `\n## Original request\n${task.originalRequest}`,
      `\n## Canonical document\n${revision.documentMarkdown}`,
      `\n## Canonical JSON\n${JSON.stringify(revision.documentJson)}`,
      `\n## Current graph\n${JSON.stringify(revision.graph)}`,
      `\n## Recent events\n${JSON.stringify(events)}`,
    ].join('\n');
  }

  private requireModeStage(task: DesignTask, mode: DesignAgentRunMode): void {
    const valid = mode === 'goal'
      ? task.stage === 'goal_setting'
      : mode === 'solution'
        ? task.stage === 'solution_draft'
        : mode === 'review'
          ? task.stage === 'solution_draft' || task.stage === 'review'
          : task.stage === 'review' || task.stage === 'graph_draft';
    if (!valid) throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_ACTIONABLE', 'run mode is not available in this stage');
  }

  private resolvePersonas(task: DesignTask, mode: DesignAgentRunMode, selectors: readonly string[]): ResolvedPersona[] {
    const keys = personaKeyPlan(mode, selectors);
    const specialistKeys = keys.filter((key) => key !== 'builtin:design-steward');
    const specialists = specialistKeys.map((key) => this.deps.personas.resolveForRun(task.projectId, key, task.agent));
    if (specialists.some((persona) => !allowedSpecialist(mode, persona.manifest.role))) {
      throw new DesignRunCoordinatorError('DESIGN_RUN_INVALID', 'persona role is not valid for this run mode');
    }
    const steward = this.deps.personas.resolveForRun(task.projectId, 'builtin:design-steward', task.agent);
    return [...specialists, steward];
  }
}

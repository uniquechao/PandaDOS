import type { AgentKind } from '../core/types';
import { validateDesignGraph } from './graph';
import {
  canPublishGraph,
  evaluateReadiness,
  type ReadinessInput,
  type RiskOverride,
} from './readiness';
import {
  DesignOperationConflictError,
  DesignRevisionConflictError,
  DesignStageConflictError,
  DesignStore,
  DesignTaskImmutableError,
} from './store';
import { normalizeDesignGraphGranularity } from './types';
import type {
  DesignPublisherPort,
  IssuePublishConfirmationInput,
  PublishDesignGraphInput,
} from './publisher';
import type {
  DesignCreationSaga,
  DesignAgentOperationInput,
  DesignGraph,
  DesignGraphDraft,
  DesignGraphGranularity,
  DesignPersonaProvenance,
  DesignPublicationResult,
  DesignPublishConfirmation,
  DesignRevision,
  DesignTask,
  DesignTaskStage,
} from './types';

export type DesignActorRole =
  | 'owner'
  | 'design_steward'
  | 'goal_coach'
  | 'reviewer'
  | 'issue_planner'
  | 'independent_verifier';

export interface Actor {
  id: string;
  role: DesignActorRole;
}

/** Project/module lookup only; the design domain does not import IssueEngine. */
export interface DesignScopeOps {
  projectExists(projectId: number): boolean | Promise<boolean>;
  getModule(moduleId: number): { projectId: number; agent: AgentKind } | null
    | Promise<{ projectId: number; agent: AgentKind } | null>;
  supportsAgent(projectId: number, agent: AgentKind): boolean | Promise<boolean>;
}

export interface DesignConversationOps {
  createDesignConversation(input: {
    conversationId: string;
    sagaToken: string;
    projectId: number;
    designId: number;
    agent: AgentKind;
    cwd?: string;
  }): Promise<{
    conversationId: string;
    created: boolean;
    ownershipProof: string | null;
  }>;
  activateDesignConversation(conversationId: string): Promise<void>;
  archiveDesignConversation(conversationId: string): Promise<void>;
  deleteDesignConversation(input: {
    conversationId: string;
    ownershipProof: string;
  }): Promise<boolean>;
}

export interface CreateDesignTaskInput {
  idempotencyKey?: string;
  moduleId?: number | null;
  title: string;
  originalRequest: string;
  agent: AgentKind;
  readinessThreshold?: number;
  /** Untrusted transport value; create() narrows this before persistence. */
  graphGranularity?: string;
}

interface PersistedCreationInput {
  moduleId: number | null;
  title: string;
  originalRequest: string;
  agent: AgentKind;
  readinessThreshold: number;
  graphGranularity: DesignGraphGranularity;
}

interface PersistedCreationRequest {
  input: PersistedCreationInput;
  actorKey: string;
}

export interface UpdateDesignBriefInput {
  expectedRevision: number;
  title?: string;
  originalRequest?: string;
}

export interface UpdateDesignGranularityInput {
  expectedRevision: number;
  granularity: DesignGraphGranularity;
}

export interface ConfirmGoalInput {
  expectedRevision: number;
}

export interface QueueReviewInput {
  expectedRevision: number;
  personas?: string[];
}

export interface GraphProposalInput {
  expectedRevision: number;
  graph: DesignGraphDraft;
}

export interface ExecutionTransitionInput {
  expectedRevision: number;
}

export interface StewardRevisionInput {
  operationId?: string;
  expectedRevision: number;
  documentJson: unknown;
  documentMarkdown: string;
  readiness: ReadinessInput;
  nextStage?: DesignTaskStage;
  reason?: string;
  personaProvenance?: DesignPersonaProvenance;
}

export type DesignFindingSeverity = 'info' | 'warning' | 'blocker';

export interface DesignFinding {
  dimension: string;
  severity: DesignFindingSeverity;
  finding: string;
  evidence: string[];
  proposedPatch: unknown;
}

export interface ReviewRequest {
  operationId?: string;
  sourceRevision: number;
  persona: string;
  findings: DesignFinding[];
  personaProvenance?: DesignPersonaProvenance;
}

export interface DesignReviewRun {
  designId: number;
  sourceRevision: number;
  persona: string;
  actor: Actor;
  findings: DesignFinding[];
  eventId: number;
  createdTs: number;
}

export interface ReplaceGraphInput {
  expectedRevision: number;
  graph: DesignGraphDraft;
  readiness: ReadinessInput;
  reason?: string;
}

export interface ApproveGraphInput {
  expectedRevision: number;
  readiness: ReadinessInput;
  override?: RiskOverride;
}

export type DesignEngineErrorCode =
  | 'DESIGN_NOT_FOUND'
  | 'DESIGN_PROJECT_NOT_FOUND'
  | 'DESIGN_MODULE_NOT_FOUND'
  | 'DESIGN_MODULE_PROJECT_MISMATCH'
  | 'DESIGN_MODULE_AGENT_MISMATCH'
  | 'DESIGN_AGENT_UNAVAILABLE'
  | 'DESIGN_REVISION_CONFLICT'
  | 'DESIGN_ARCHIVED'
  | 'DESIGN_STEWARD_REQUIRED'
  | 'DESIGN_OWNER_REQUIRED'
  | 'DESIGN_INVALID_STAGE_TRANSITION'
  | 'DESIGN_INVALID_FINDING'
  | 'DESIGN_INVALID_GRAPH'
  | 'DESIGN_NOT_READY'
  | 'DESIGN_CONVERSATION_FAILED'
  | 'DESIGN_CONVERSATION_CLEANUP_FAILED'
  | 'DESIGN_IDEMPOTENCY_CONFLICT'
  | 'DESIGN_FORBIDDEN';

export class DesignEngineError extends Error {
  constructor(
    readonly code: DesignEngineErrorCode,
    message: string,
    readonly currentRevision?: number,
  ) {
    super(message);
    this.name = 'DesignEngineError';
  }
}

export interface DesignEngineDeps {
  store: DesignStore;
  scope: DesignScopeOps;
  conversations: DesignConversationOps;
  publisher?: DesignPublisherPort;
  revisionSync?: {
    drainRevisionSyncJobs(options?: { limit?: number; abandonedAfterMs?: number }): unknown;
  };
  idFactory?: () => string;
}

export interface DesignCreationRecoveryOptions {
  maxSagas?: number;
  attemptBudget?: number;
  perSagaTimeoutMs?: number;
  signal?: AbortSignal;
}

class DesignCreationRecoveryTimeoutError extends Error {
  constructor() {
    super('design creation recovery timed out');
    this.name = 'DesignCreationRecoveryTimeoutError';
  }
}

function actorKey(actor: Actor): string {
  return `${actor.role}:${actor.id}`;
}

function initialMarkdown(title: string, originalRequest: string): string {
  return `# ${title}\n\n${originalRequest}`;
}

/** Orchestrates the single live document while leaving Issue lifecycle semantics untouched. */
export class DesignEngine {
  private readonly creationRuns = new Map<string, { requestJson: string; promise: Promise<DesignTask> }>();

  constructor(private readonly deps: DesignEngineDeps) {}

  private drainRevisionSyncPostCommit(): void {
    try {
      this.deps.revisionSync?.drainRevisionSyncJobs({ limit: 25 });
    } catch {
      // The durable per-link jobs retain bounded error/retry state. A committed canonical
      // document revision must never be reported as rolled back because post-commit sync failed.
    }
  }

  issuePublishConfirmation(
    designId: number,
    input: IssuePublishConfirmationInput,
    actor: Actor,
  ): DesignPublishConfirmation {
    if (!this.deps.publisher) throw new Error('design publisher is not configured');
    return this.deps.publisher.issuePublishConfirmation(designId, input.expectedRevision, actor);
  }

  async publishGraph(
    designId: number,
    input: PublishDesignGraphInput,
    actor: Actor,
  ): Promise<DesignPublicationResult> {
    if (!this.deps.publisher) throw new Error('design publisher is not configured');
    return this.deps.publisher.publishGraph(designId, input, actor);
  }

  listPublications(designId: number): readonly DesignPublicationResult[] {
    if (!this.deps.publisher) throw new Error('design publisher is not configured');
    return this.deps.publisher.listPublications(designId);
  }

  async create(projectId: number, input: CreateDesignTaskInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const moduleId = input.moduleId ?? null;
    const readiness = evaluateReadiness({ threshold: input.readinessThreshold });
    const graphGranularity = normalizeDesignGraphGranularity(input.graphGranularity ?? 'balanced');
    if (graphGranularity === null) {
      throw new DesignEngineError('DESIGN_INVALID_GRAPH', 'invalid design graph granularity');
    }
    const normalized = {
      moduleId,
      title: input.title,
      originalRequest: input.originalRequest,
      agent: input.agent,
      readinessThreshold: readiness.threshold,
      graphGranularity,
    };
    const requestJson = JSON.stringify(normalized);
    const idempotencyKey = input.idempotencyKey ?? `generated:${this.id()}`;
    const existing = this.deps.store.getCreationSaga(projectId, idempotencyKey);
    if (existing) {
      const stored = this.parseCreationRequest(existing);
      if (JSON.stringify(stored.input) !== requestJson) {
        this.throwIdempotencyConflict(projectId, idempotencyKey);
      }
      if (existing.phase === 'completed') return this.completedCreationTask(existing);
    }
    const runKey = `${projectId}\u0000${idempotencyKey}`;
    const running = this.creationRuns.get(runKey);
    if (running) {
      if (running.requestJson !== requestJson) this.throwIdempotencyConflict(projectId, idempotencyKey);
      return running.promise;
    }
    const promise = this.createOrResume(projectId, idempotencyKey, normalized, actor)
      .finally(() => {
        if (this.creationRuns.get(runKey)?.promise === promise) this.creationRuns.delete(runKey);
      });
    this.creationRuns.set(runKey, { requestJson, promise });
    return promise;
  }

  async recoverIncompleteCreations(options: DesignCreationRecoveryOptions = {}): Promise<void> {
    const maxSagas = Math.max(0, options.maxSagas ?? 25);
    const attemptBudget = Math.max(0, options.attemptBudget ?? maxSagas);
    const perSagaTimeoutMs = Math.max(1, options.perSagaTimeoutMs ?? 5_000);
    const sagas = this.deps.store.listIncompleteCreationSagas().slice(0, maxSagas);
    let attempts = 0;
    for (const saga of sagas) {
      if (options.signal?.aborted) break;
      if (attempts >= attemptBudget) break;
      attempts++;
      try {
        const persisted = this.parseCreationRequest(saga);
        await this.validateCreationScope(saga.projectId, persisted.input);
        await this.withTimeout(
          this.resumeCreationSaga(saga, persisted.input, persisted.actorKey, options.signal),
          perSagaTimeoutMs,
          options.signal,
        );
      } catch (error) {
        if (options.signal?.aborted) break;
        if (error instanceof DesignCreationRecoveryTimeoutError) continue;
        const current = this.deps.store.getCreationSagaByToken(saga.sagaToken);
        if (current && current.phase !== 'completed') {
          this.deps.store.markCreationSagaError(current.sagaToken, current.phase, String(error));
        }
      }
    }
  }

  private async createOrResume(
    projectId: number,
    idempotencyKey: string,
    input: PersistedCreationInput,
    actor: Actor,
  ): Promise<DesignTask> {
    await this.validateCreationScope(projectId, input);
    const persisted = { input, actorKey: actorKey(actor) };
    const ensured = this.deps.store.ensureCreationSaga({
      sagaToken: this.id(),
      projectId,
      idempotencyKey,
      requestJson: JSON.stringify(persisted),
      conversationId: this.id(),
    });
    const stored = this.parseCreationRequest(ensured.saga);
    if (JSON.stringify(stored.input) !== JSON.stringify(input)) {
      this.throwIdempotencyConflict(projectId, idempotencyKey);
    }
    if (ensured.saga.phase === 'completed') return this.completedCreationTask(ensured.saga);
    return this.resumeCreationSaga(ensured.saga, stored.input, stored.actorKey);
  }

  private async resumeCreationSaga(
    initialSaga: DesignCreationSaga,
    input: PersistedCreationInput,
    persistedActorKey: string,
    signal?: AbortSignal,
  ): Promise<DesignTask> {
    for (let attempt = 0; attempt < 64; attempt++) {
      this.throwIfCreationRecoveryAborted(signal);
      let saga = this.deps.store.getCreationSagaByToken(initialSaga.sagaToken);
      if (!saga) throw new Error(`design creation saga not found: ${initialSaga.sagaToken}`);
      if (saga.phase === 'completed') return this.completedCreationTask(saga);

      if (saga.taskId === null && saga.conversationOwned) {
        try {
          const cleaned = await this.deps.conversations.deleteDesignConversation({
            conversationId: saga.conversationId,
            ownershipProof: saga.sagaToken,
          });
          this.throwIfCreationRecoveryAborted(signal);
          if (!cleaned) throw new Error('conversation ownership proof was rejected');
          this.deps.store.resetCreationSaga(saga.sagaToken, saga.phase);
          continue;
        } catch (error) {
          this.throwIfCreationRecoveryAborted(signal);
          const message = `design creation orphan cleanup failed: ${String(error)}`;
          this.deps.store.markCreationSagaError(saga.sagaToken, saga.phase, message);
          throw new DesignEngineError('DESIGN_CONVERSATION_CLEANUP_FAILED', message);
        }
      }

      if (saga.taskId === null) {
        if (saga.phase !== 'intent') {
          this.deps.store.resetCreationSaga(saga.sagaToken, saga.phase);
          continue;
        }
        const documentJson = { title: input.title, originalRequest: input.originalRequest };
        this.deps.store.createCreationSagaTask(saga.sagaToken, saga.phase, {
          projectId: saga.projectId,
          moduleId: input.moduleId,
          title: input.title,
          originalRequest: input.originalRequest,
          agent: input.agent,
          readinessThreshold: input.readinessThreshold,
          documentJson,
          documentMarkdown: initialMarkdown(input.title, input.originalRequest),
          graphGranularity: input.graphGranularity,
          readiness: 0,
          graph: { nodes: [], edges: [] },
          actor: persistedActorKey,
          createdEventData: { projectId: saga.projectId, moduleId: input.moduleId, stage: 'goal_setting' },
        });
        continue;
      }

      if (!this.deps.store.ownsCreationSagaTask(saga.sagaToken)) {
        const message = `design creation bootstrap ownership conflict: ${saga.sagaToken}`;
        const marked = this.deps.store.markCreationSagaError(saga.sagaToken, saga.phase, message);
        if (!marked) continue;
        throw new DesignEngineError('DESIGN_CONVERSATION_CLEANUP_FAILED', message);
      }

      if (saga.phase === 'recoverable_error') {
        const task = this.deps.store.getTask(saga.taskId)!;
        const target = !saga.conversationOwned
          ? 'task_created'
          : task.conversationId === saga.conversationId ? 'bound' : 'conversation_created';
        this.deps.store.reconcileCreationSagaPhase(saga.sagaToken, saga.phase, target);
        continue;
      }

      if (saga.phase === 'task_created') {
        let collision = false;
        try {
          const result = await this.deps.conversations.createDesignConversation({
            conversationId: saga.conversationId,
            sagaToken: saga.sagaToken,
            projectId: saga.projectId,
            designId: saga.taskId,
            agent: input.agent,
          });
          this.throwIfCreationRecoveryAborted(signal);
          if (result.conversationId !== saga.conversationId || result.ownershipProof !== saga.sagaToken) {
            collision = result.conversationId === saga.conversationId && result.ownershipProof === null;
            throw new Error(collision
              ? `design conversation ID collision: ${saga.conversationId}`
              : 'design conversation adapter returned invalid ownership proof');
          }
        } catch (error) {
          this.throwIfCreationRecoveryAborted(signal);
          return this.compensateCreationSaga(saga, error, collision, input, persistedActorKey, signal);
        }
        this.deps.store.markCreationConversationOwned(saga.sagaToken, saga.phase);
        continue;
      }

      if (saga.phase === 'conversation_created') {
        this.deps.store.bindCreationConversation(saga.sagaToken, saga.phase);
        continue;
      }
      if (saga.phase === 'bound') {
        this.deps.store.markCreationActivating(saga.sagaToken, saga.phase);
        continue;
      }
      if (saga.phase === 'activating') {
        try {
          await this.deps.conversations.activateDesignConversation(saga.conversationId);
          this.throwIfCreationRecoveryAborted(signal);
        } catch (error) {
          this.throwIfCreationRecoveryAborted(signal);
          return this.compensateCreationSaga(saga, error, false, input, persistedActorKey, signal);
        }
        this.deps.store.markCreationActivated(saga.sagaToken, saga.phase);
        continue;
      }
      if (saga.phase === 'activated') {
        const completed = this.deps.store.completeCreationSaga(saga.sagaToken, saga.phase);
        if (completed) return completed;
        continue;
      }
    }
    throw new DesignEngineError(
      'DESIGN_CONVERSATION_CLEANUP_FAILED',
      `design creation saga exceeded reconciliation budget: ${initialSaga.sagaToken}`,
    );
  }

  private async compensateCreationSaga(
    failedSaga: DesignCreationSaga,
    setupError: unknown,
    rotateConversationId: boolean,
    input: PersistedCreationInput,
    persistedActorKey: string,
    signal?: AbortSignal,
  ): Promise<DesignTask> {
    this.throwIfCreationRecoveryAborted(signal);
    const claimed = this.deps.store.markCreationSagaError(
      failedSaga.sagaToken,
      failedSaga.phase,
      `setup=${String(setupError)}`,
    );
    if (!claimed) return this.resumeCreationSaga(failedSaga, input, persistedActorKey, signal);
    let saga = claimed;
    try {
      if (saga.taskId !== null && !this.deps.store.deleteCreationSagaTask(saga.sagaToken, saga.phase)) {
        throw new Error(`bootstrap task ownership/state changed: ${saga.taskId}`);
      }
      saga = this.deps.store.getCreationSagaByToken(saga.sagaToken)!;
      if (saga.conversationOwned) {
        const deleted = await this.deps.conversations.deleteDesignConversation({
          conversationId: saga.conversationId,
          ownershipProof: saga.sagaToken,
        });
        this.throwIfCreationRecoveryAborted(signal);
        if (!deleted) throw new Error('conversation ownership proof was rejected');
      }
      const reset = this.deps.store.resetCreationSaga(saga.sagaToken, saga.phase, {
        ...(rotateConversationId ? { conversationId: this.id() } : {}),
        error: String(setupError),
      });
      if (!reset) return this.resumeCreationSaga(saga, input, persistedActorKey, signal);
    } catch (cleanupError) {
      this.throwIfCreationRecoveryAborted(signal);
      const message = `setup=${String(setupError)}; cleanup=${String(cleanupError)}`;
      const current = this.deps.store.getCreationSagaByToken(saga.sagaToken);
      if (current && current.phase !== 'completed') {
        this.deps.store.markCreationSagaError(current.sagaToken, current.phase, message);
      }
      throw new DesignEngineError('DESIGN_CONVERSATION_CLEANUP_FAILED', message);
    }
    throw new DesignEngineError('DESIGN_CONVERSATION_FAILED', `design conversation setup failed: ${String(setupError)}`);
  }

  private parseCreationRequest(saga: DesignCreationSaga): PersistedCreationRequest {
    try {
      const parsed = JSON.parse(saga.requestJson) as Partial<PersistedCreationRequest>;
      if (!parsed.input || typeof parsed.actorKey !== 'string') throw new Error('invalid creation request');
      const graphGranularity = normalizeDesignGraphGranularity(parsed.input.graphGranularity);
      if (graphGranularity === null) throw new Error('invalid graph granularity');
      return {
        ...parsed,
        input: { ...parsed.input, graphGranularity },
      } as PersistedCreationRequest;
    } catch (error) {
      throw new DesignEngineError(
        'DESIGN_CONVERSATION_CLEANUP_FAILED',
        `invalid persisted design creation request: ${String(error)}`,
      );
    }
  }

  private completedCreationTask(saga: DesignCreationSaga): DesignTask {
    const task = saga.taskId === null ? null : this.deps.store.getTask(saga.taskId);
    if (!task) {
      throw new DesignEngineError(
        'DESIGN_CONVERSATION_CLEANUP_FAILED',
        `completed design creation saga has no task: ${saga.sagaToken}`,
      );
    }
    return task;
  }

  private async validateCreationScope(projectId: number, input: PersistedCreationInput): Promise<void> {
    if (!await this.deps.scope.projectExists(projectId)) {
      throw new DesignEngineError('DESIGN_PROJECT_NOT_FOUND', `project not found: ${projectId}`);
    }
    if (input.moduleId !== null) {
      const module = await this.deps.scope.getModule(input.moduleId);
      if (!module) throw new DesignEngineError('DESIGN_MODULE_NOT_FOUND', `module not found: ${input.moduleId}`);
      if (module.projectId !== projectId) {
        throw new DesignEngineError(
          'DESIGN_MODULE_PROJECT_MISMATCH',
          `module ${input.moduleId} does not belong to project ${projectId}`,
        );
      }
      if (module.agent !== input.agent) {
        throw new DesignEngineError(
          'DESIGN_MODULE_AGENT_MISMATCH',
          `module ${input.moduleId} requires ${module.agent}`,
        );
      }
    }
    if (!await this.deps.scope.supportsAgent(projectId, input.agent)) {
      throw new DesignEngineError(
        'DESIGN_AGENT_UNAVAILABLE',
        `agent ${input.agent} is unavailable for project ${projectId}`,
      );
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new DesignCreationRecoveryTimeoutError()), timeoutMs);
        }),
        ...(signal ? [new Promise<never>((_, reject) => {
          onAbort = () => reject(new DesignCreationRecoveryTimeoutError());
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        })] : []),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private throwIfCreationRecoveryAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new DesignCreationRecoveryTimeoutError();
  }

  private throwIdempotencyConflict(projectId: number, idempotencyKey: string): never {
    throw new DesignEngineError(
      'DESIGN_IDEMPOTENCY_CONFLICT',
      `idempotency key ${idempotencyKey} already identifies another design request in project ${projectId}`,
    );
  }

  private id(): string {
    return this.deps.idFactory?.() ?? crypto.randomUUID();
  }

  async updateBrief(designId: number, input: UpdateDesignBriefInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'goal_setting');
    this.translateStoreError(() => this.deps.store.appendEventAtRevision(
      designId,
      input.expectedRevision,
      'input_appended',
      {
        actor,
        sourceRevision: input.expectedRevision,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.originalRequest === undefined ? {} : { originalRequest: input.originalRequest }),
      },
    ));
    return this.task(designId);
  }

  updateGranularity(
    designId: number,
    input: UpdateDesignGranularityInput,
    actor: Actor,
  ): DesignTask {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    const snapshot = this.deps.store.getRevision(designId, input.expectedRevision);
    if (!snapshot) throw new DesignEngineError('DESIGN_NOT_FOUND', 'design revision not found');
    const committed = this.translateStoreError(() => this.deps.store.commitDocumentMutation({
      action: 'set_granularity',
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      taskPatch: { graphGranularity: input.granularity },
      documentJson: snapshot.documentJson,
      documentMarkdown: snapshot.documentMarkdown,
      readiness: snapshot.readiness,
      graph: snapshot.graph,
      actor: actorKey(actor),
      reason: 'graph_granularity_changed',
      event: {
        kind: 'document_revised',
        data: {
          source: 'owner_granularity_control',
          graphGranularity: input.granularity,
        },
      },
    }));
    this.drainRevisionSyncPostCommit();
    return committed.task;
  }

  async confirmGoal(designId: number, input: ConfirmGoalInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'goal_setting');
    return this.translateStoreError(() => this.deps.store.transitionStage({
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      action: 'confirm_goal',
      actor: actorKey(actor),
      eventData: { source: 'owner_confirmation' },
    }));
  }

  async applyStewardRevision(
    designId: number,
    input: StewardRevisionInput,
    actor: Actor,
  ): Promise<DesignRevision> {
    if (actor.role !== 'design_steward') {
      throw new DesignEngineError('DESIGN_STEWARD_REQUIRED', 'only the design steward may replace the live document');
    }
    const operation = this.agentOperation(input.operationId, 'steward_revision', {
      expectedRevision: input.expectedRevision,
      documentJson: input.documentJson,
      documentMarkdown: input.documentMarkdown,
      readiness: input.readiness,
      nextStage: input.nextStage,
      reason: input.reason,
      personaProvenance: input.personaProvenance,
      actor,
    });
    if (operation) {
      const replay = this.translateStoreError(() => this.deps.store.replayAgentOperation(designId, operation));
      if (replay) {
        if (!replay.revision) throw new Error('steward operation is missing its revision');
        this.drainRevisionSyncPostCommit();
        return replay.revision;
      }
    }
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    const nextStage = input.nextStage ?? task.stage;
    const mayEnterReview = task.stage === 'solution_draft' && nextStage === 'review';
    if (nextStage !== task.stage && !mayEnterReview) {
      throw new DesignEngineError(
        'DESIGN_INVALID_STAGE_TRANSITION',
        `cannot transition design from ${task.stage} to ${nextStage}`,
      );
    }
    const report = evaluateReadiness({ ...input.readiness, threshold: task.readinessThreshold });
    const committed = this.translateStoreError(() => this.deps.store.commitDocumentMutation({
      action: task.stage === 'goal_setting'
        ? 'refine_goal'
        : nextStage === 'review' ? 'submit_review' : 'revise_document',
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      documentJson: input.documentJson,
      documentMarkdown: input.documentMarkdown,
      readiness: report.aggregate,
      actor: actorKey(actor),
      reason: input.reason,
      event: {
        kind: 'document_revised',
        data: {
          fromStage: task.stage,
          toStage: nextStage,
          readinessReport: report,
          ...(input.personaProvenance ? { personaProvenance: input.personaProvenance } : {}),
        },
      },
      operation,
    }));
    this.drainRevisionSyncPostCommit();
    return committed.revision;
  }

  async requestReview(designId: number, input: ReviewRequest, actor: Actor): Promise<DesignReviewRun> {
    if (actor.role === 'owner' || actor.role === 'design_steward') {
      throw new DesignEngineError('DESIGN_FORBIDDEN', 'a specialist persona must submit review findings');
    }
    const operation = this.agentOperation(input.operationId, 'review', {
      sourceRevision: input.sourceRevision,
      persona: input.persona,
      findings: input.findings,
      personaProvenance: input.personaProvenance,
      actor,
    });
    if (operation) {
      const replay = this.translateStoreError(() => this.deps.store.replayAgentOperation(designId, operation));
      if (replay) {
        return {
          designId,
          sourceRevision: input.sourceRevision,
          persona: input.persona,
          actor: { ...actor },
          findings: input.findings.map((finding) => ({ ...finding, evidence: finding.evidence.slice() })),
          eventId: replay.event.id,
          createdTs: replay.event.ts,
        };
      }
    }
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.sourceRevision);
    if (
      task.stage !== 'goal_setting'
      && task.stage !== 'solution_draft'
      && task.stage !== 'review'
      && task.stage !== 'graph_draft'
    ) {
      throw new DesignEngineError(
        'DESIGN_INVALID_STAGE_TRANSITION',
        `design ${task.id} is not accepting specialist findings in ${task.stage}`,
        task.currentRevision,
      );
    }
    if (
      !input.persona.trim()
      || input.findings.length === 0
      || input.findings.some((finding) =>
        !finding.dimension.trim()
        || !finding.finding.trim()
        || finding.evidence.length === 0
        || finding.evidence.some((item) => !item.trim())
        || finding.proposedPatch === undefined)
    ) {
      throw new DesignEngineError('DESIGN_INVALID_FINDING', 'review findings require evidence and a proposed patch');
    }
    const event = this.translateStoreError(() => this.deps.store.appendEventAtRevision(
      designId,
      input.sourceRevision,
      'finding_appended',
      {
        sourceRevision: input.sourceRevision,
        persona: input.persona,
        actor,
        findings: input.findings,
        ...(input.personaProvenance ? { personaProvenance: input.personaProvenance } : {}),
      },
      operation,
    ));
    return {
      designId,
      sourceRevision: input.sourceRevision,
      persona: input.persona,
      actor: { ...actor },
      findings: input.findings.map((finding) => ({ ...finding, evidence: finding.evidence.slice() })),
      eventId: event.id,
      createdTs: event.ts,
    };
  }

  /** Human-facing review requests are queued as input; specialist findings arrive through requestReview. */
  async queueReview(designId: number, input: QueueReviewInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'review');
    this.translateStoreError(() => this.deps.store.appendEventAtRevision(
      designId,
      input.expectedRevision,
      'input_appended',
      {
        requestKind: 'review',
        sourceRevision: input.expectedRevision,
        actor,
        ...(input.personas === undefined ? {} : { personas: input.personas.slice() }),
      },
    ));
    return this.task(designId);
  }

  /** Human graph edits are proposals only; the design steward owns canonical graph replacement. */
  async proposeGraph(designId: number, input: GraphProposalInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    if (task.stage !== 'review' && task.stage !== 'graph_draft') {
      throw new DesignEngineError(
        'DESIGN_INVALID_STAGE_TRANSITION',
        `cannot propose a graph while design is in ${task.stage}`,
        task.currentRevision,
      );
    }
    const validation = validateDesignGraph(input.graph);
    if (!validation.valid) {
      throw new DesignEngineError(
        'DESIGN_INVALID_GRAPH',
        `invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`,
      );
    }
    this.translateStoreError(() => this.deps.store.appendEventAtRevision(
      designId,
      input.expectedRevision,
      'input_appended',
      {
        requestKind: 'graph_proposal',
        sourceRevision: input.expectedRevision,
        actor,
        graph: input.graph,
      },
    ));
    return this.task(designId);
  }

  async replaceGraph(designId: number, input: ReplaceGraphInput, actor: Actor): Promise<DesignGraph> {
    if (actor.role !== 'design_steward') {
      throw new DesignEngineError('DESIGN_STEWARD_REQUIRED', 'only the design steward may replace the live graph');
    }
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    if (task.stage !== 'review' && task.stage !== 'graph_draft') {
      throw new DesignEngineError(
        'DESIGN_INVALID_STAGE_TRANSITION',
        `cannot replace graph while design is in ${task.stage}`,
      );
    }
    const validation = validateDesignGraph(input.graph);
    if (!validation.valid) {
      throw new DesignEngineError(
        'DESIGN_INVALID_GRAPH',
        `invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`,
      );
    }
    const report = evaluateReadiness({ ...input.readiness, threshold: task.readinessThreshold });
    if (!canPublishGraph(report)) {
      throw new DesignEngineError('DESIGN_NOT_READY', 'design readiness does not permit graph drafting');
    }
    const snapshot = this.currentSnapshot(task);
    const committed = this.translateStoreError(() => this.deps.store.commitDocumentMutation({
      action: 'replace_graph',
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      documentJson: snapshot.documentJson,
      documentMarkdown: snapshot.documentMarkdown,
      readiness: report.aggregate,
      graph: input.graph,
      actor: actorKey(actor),
      reason: input.reason,
      event: { kind: 'graph_replaced', data: { readinessReport: report } },
    }));
    this.drainRevisionSyncPostCommit();
    return committed.graph;
  }

  async approveGraph(designId: number, input: ApproveGraphInput, actor: Actor): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'graph_draft');
    const graph = this.deps.store.getGraph(designId);
    const validation = validateDesignGraph(graph);
    if (!validation.valid) {
      throw new DesignEngineError(
        'DESIGN_INVALID_GRAPH',
        `invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`,
      );
    }
    const report = evaluateReadiness({ ...input.readiness, threshold: task.readinessThreshold });
    if (!canPublishGraph(report, input.override)) {
      throw new DesignEngineError('DESIGN_NOT_READY', 'design readiness does not permit graph approval');
    }
    return this.translateStoreError(() => this.deps.store.transitionStage({
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      action: 'approve_graph',
      actor: actorKey(actor),
      readinessOverride: input.override !== undefined,
      eventData: { readinessReport: report, override: input.override ?? null },
    }));
  }

  async startExecution(
    designId: number,
    input: ExecutionTransitionInput,
    actor: Actor,
  ): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'approved');
    return this.translateStoreError(() => this.deps.store.transitionStage({
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      action: 'start_execution',
      actor: actorKey(actor),
      eventData: { source: 'owner_start' },
    }));
  }

  async completeExecution(
    designId: number,
    input: ExecutionTransitionInput,
    actor: Actor,
  ): Promise<DesignTask> {
    this.requireOwnerAction(actor);
    const task = this.mutableTask(designId);
    this.requireExpectedRevision(task, input.expectedRevision);
    this.requireStage(task, 'executing');
    return this.translateStoreError(() => this.deps.store.transitionStage({
      designTaskId: designId,
      expectedRevision: input.expectedRevision,
      action: 'complete_execution',
      actor: actorKey(actor),
      eventData: { source: 'owner_completion' },
    }));
  }

  async archive(designId: number, actor: Actor): Promise<DesignTask> {
    if (actor.role !== 'owner' && actor.role !== 'design_steward') {
      throw new DesignEngineError('DESIGN_FORBIDDEN', 'only an owner or design steward may archive a design');
    }
    const current = this.task(designId);
    const task = this.translateStoreError(() => this.deps.store.archiveTask(designId, actorKey(actor)));
    if (current.conversationId) {
      try {
        await this.deps.conversations.archiveDesignConversation(current.conversationId);
      } catch (error) {
        throw new DesignEngineError(
          'DESIGN_CONVERSATION_CLEANUP_FAILED',
          `design conversation archive failed: ${String(error)}`,
        );
      }
    }
    return task;
  }

  private task(designId: number): DesignTask {
    const task = this.deps.store.getTask(designId);
    if (!task) throw new DesignEngineError('DESIGN_NOT_FOUND', `design task not found: ${designId}`);
    return task;
  }

  private mutableTask(designId: number): DesignTask {
    const task = this.task(designId);
    if (task.status === 'archived' || task.stage === 'archived') {
      throw new DesignEngineError('DESIGN_ARCHIVED', `design task is archived: ${designId}`);
    }
    return task;
  }

  private requireStage(task: DesignTask, expected: DesignTaskStage): void {
    if (task.stage !== expected) {
      throw new DesignEngineError(
        'DESIGN_INVALID_STAGE_TRANSITION',
        `design ${task.id} must be in ${expected}, not ${task.stage}`,
        task.currentRevision,
      );
    }
  }

  private requireExpectedRevision(task: DesignTask, expectedRevision: number): void {
    if (task.currentRevision !== expectedRevision) {
      throw new DesignEngineError(
        'DESIGN_REVISION_CONFLICT',
        `revision conflict; current revision is ${task.currentRevision}`,
        task.currentRevision,
      );
    }
  }

  private requireOwnerAction(actor: Actor): void {
    if (actor.role !== 'owner') {
      throw new DesignEngineError(
        'DESIGN_OWNER_REQUIRED',
        'specialist personas may only append structured findings; this action requires the owner',
      );
    }
  }

  private currentSnapshot(task: DesignTask): { documentJson: unknown; documentMarkdown: string; readiness: number } {
    const revision = this.deps.store.getRevision(task.id, task.currentRevision);
    return {
      documentJson: task.documentJson ?? {},
      documentMarkdown: task.documentMarkdown ?? '',
      readiness: revision?.readiness ?? 0,
    };
  }

  private agentOperation(
    operationId: string | undefined,
    operationKind: DesignAgentOperationInput['operationKind'],
    request: unknown,
  ): DesignAgentOperationInput | undefined {
    if (operationId === undefined) return undefined;
    if (operationId !== operationId.trim() || !operationId || operationId.length > 256) {
      throw new DesignEngineError('DESIGN_IDEMPOTENCY_CONFLICT', 'invalid design operation ID');
    }
    return { operationId, operationKind, requestJson: JSON.stringify(request) };
  }

  private translateStoreError<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof DesignRevisionConflictError) {
        throw new DesignEngineError(
          'DESIGN_REVISION_CONFLICT',
          error.message,
          error.currentRevision,
        );
      }
      if (error instanceof DesignTaskImmutableError) {
        throw new DesignEngineError('DESIGN_ARCHIVED', error.message);
      }
      if (error instanceof DesignStageConflictError) {
        throw new DesignEngineError(
          'DESIGN_INVALID_STAGE_TRANSITION',
          error.message,
          error.currentRevision,
        );
      }
      if (error instanceof DesignOperationConflictError) {
        throw new DesignEngineError('DESIGN_IDEMPOTENCY_CONFLICT', error.message);
      }
      throw error;
    }
  }
}

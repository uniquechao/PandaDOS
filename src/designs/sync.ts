import { createHash } from 'node:crypto';
import type { AgentKind, IssueState } from '../core/types';
import type {
  DesignIssueDraft,
  EngineIssue,
  IssueDesignSyncSnapshot,
  IssueDesignSyncUpdate,
  IssueExecutionSync,
  IssueExecutionSyncDecision,
  IssueExecutionSyncEffectContext,
  IssueExecutionSyncRequest,
  PreparedDesignBatch,
  PreparedIssueDependency,
  SynchronousCallbackResult,
} from '../issues/engine';
import { validateDesignGraph } from './graph';
import { renderDesignIssueBody } from './publisher';
import type { DesignStore } from './store';
import type {
  DesignGraphNode,
  DesignIssueBaselineContract,
  DesignIssueLink,
  DesignIssueSyncDecision,
  DesignIssueSyncResult,
  DesignIssueSyncState,
  DesignTask,
} from './types';

/** Issue-owned projection used for revision sync. Rich design details remain losslessly represented by body. */
export interface DesignIssueSyncContract {
  title: string;
  body: string;
  moduleId: number | null;
  agent: AgentKind;
  implMode: 'direct' | 'team';
  dependencies: string[];
}

export type DesignSyncFieldKind =
  | 'unchanged'
  | 'local_only'
  | 'incoming_only'
  | 'converged'
  | 'conflict';

export interface DesignSyncFieldDiff<T> {
  kind: DesignSyncFieldKind;
  base: T;
  local: T;
  incoming: T;
}

export type DesignIssueSyncField = keyof DesignIssueSyncContract;
export type DesignIssueSyncPatch = Partial<DesignIssueSyncContract>;

export interface DesignIssueThreeWayDiff {
  removed: boolean;
  hasConflicts: boolean;
  fields: Partial<{ [K in DesignIssueSyncField]: DesignSyncFieldDiff<DesignIssueSyncContract[K]> }>;
  autoPatch: DesignIssueSyncPatch;
}

const SYNC_FIELDS = [
  'title',
  'body',
  'moduleId',
  'agent',
  'implMode',
  'dependencies',
] as const satisfies readonly DesignIssueSyncField[];

function equalValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  return left === right;
}

function copyValue<T>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T;
}

export function threeWayDesignDiff(
  base: DesignIssueSyncContract,
  local: DesignIssueSyncContract,
  incoming: DesignIssueSyncContract | null,
): DesignIssueThreeWayDiff {
  if (incoming === null) {
    return { removed: true, hasConflicts: false, fields: {}, autoPatch: {} };
  }
  const fields: DesignIssueThreeWayDiff['fields'] = {};
  const autoPatch: DesignIssueSyncPatch = {};
  let hasConflicts = false;
  for (const field of SYNC_FIELDS) {
    const baseValue = base[field];
    const localValue = local[field];
    const incomingValue = incoming[field];
    const localChanged = !equalValue(localValue, baseValue);
    const incomingChanged = !equalValue(incomingValue, baseValue);
    const kind: DesignSyncFieldKind = !localChanged && !incomingChanged
      ? 'unchanged'
      : localChanged && !incomingChanged
        ? 'local_only'
        : !localChanged && incomingChanged
          ? 'incoming_only'
          : equalValue(localValue, incomingValue)
            ? 'converged'
            : 'conflict';
    (fields as Record<string, DesignSyncFieldDiff<unknown>>)[field] = {
      kind,
      base: copyValue(baseValue),
      local: copyValue(localValue),
      incoming: copyValue(incomingValue),
    };
    if (kind === 'incoming_only') {
      (autoPatch as Record<string, unknown>)[field] = copyValue(incomingValue);
    } else if (kind === 'conflict') {
      hasConflicts = true;
    }
  }
  return { removed: false, hasConflicts, fields, autoPatch };
}

export type DesignSyncErrorCode =
  | 'DESIGN_SYNC_NOT_FOUND'
  | 'DESIGN_SYNC_STALE'
  | 'DESIGN_SYNC_CONFLICT'
  | 'DESIGN_SYNC_NOT_ACTIONABLE'
  | 'DESIGN_SYNC_INVALID';

export class DesignSyncError extends Error {
  constructor(readonly code: DesignSyncErrorCode, message: string, readonly currentRevision?: number) {
    super(message);
    this.name = 'DesignSyncError';
  }
}

export interface DesignSyncFieldView {
  field: DesignIssueSyncField;
  kind: DesignSyncFieldKind;
  base: unknown;
  local: unknown;
  incoming: unknown;
}

export interface DesignSyncListItem extends DesignIssueSyncResult {
  decisionState: IssueExecutionSync['state'] | null;
  fields: DesignSyncFieldView[];
  recovery: { pending: boolean; resolutionRequired: boolean };
}

export interface IssueDesignSyncPort {
  getDesignSyncSnapshot(issueId: number): IssueDesignSyncSnapshot | null;
  updateFromDesign<Result>(
    input: IssueDesignSyncUpdate,
    afterUpdate: (updated: IssueDesignSyncSnapshot) => SynchronousCallbackResult<Result>,
  ): Result;
  requestLatestExecutionSync(issueId: number, input: IssueExecutionSyncRequest): IssueExecutionSync;
  latestExecutionSync(issueId: number, sourceKind: string, sourceKey: string): IssueExecutionSync | null;
  getExecutionSync(syncId: number): IssueExecutionSync | null;
  holdExecutionSyncBoundary(issueId: number, boundaryKind: string, deferredAction: unknown): IssueExecutionSync | null;
  decideExecutionSync(syncId: number, decision: IssueExecutionSyncDecision, actor: number): IssueExecutionSync;
  resumeExecutionSync<T>(
    syncId: number,
    resume: (
      deferredAction: unknown,
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<T>,
  ): { resumed: boolean; result?: T };
  recoverExecutionSyncs<T>(
    resume: (
      deferredAction: unknown,
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<T>,
    limit?: number,
  ): { examined: number; resumed: number };
  drainExecutionSyncEffectOutbox(limit?: number): Promise<{ examined: number; delivered: number }>;
  hasUnresolvedExecutionSyncEffect(issueId: number): boolean;
  listUncertainExecutionSyncEffects(limit?: number): readonly {
    resumeKey: string;
    syncId: number;
    intentKey: string;
  }[];
  getUncertainExecutionSyncEffect(syncId: number): {
    resumeKey: string;
    syncId: number;
    intentKey: string;
  } | null;
  resolveUncertainExecutionSyncEffect(
    resumeKey: string,
    intentKey: string,
    resolution: 'confirm_delivered' | 'retry',
  ): boolean;
  prepareDesignBatch(projectId: number, drafts: readonly DesignIssueDraft[]): Promise<PreparedDesignBatch>;
  commitPreparedDesignBatch<Result>(
    prepared: PreparedDesignBatch,
    dependencies: readonly PreparedIssueDependency[],
    onCreatedInTransaction: (issuesByNodeId: ReadonlyMap<string, EngineIssue>) => SynchronousCallbackResult<Result>,
  ): readonly EngineIssue[];
  completeDesignBatch(projectId: number, issueIds: readonly number[]): Promise<void>;
}

export interface DesignSyncCoordinatorDeps {
  store: DesignStore;
  issues: IssueDesignSyncPort;
  now?: () => number;
}

export interface DesignSyncDrainOptions {
  limit?: number;
  abandonedAfterMs?: number;
}

export interface DesignSyncDrainResult {
  examined: number;
  completed: number;
  retried: number;
  stale: number;
}

interface PersistedDesignSyncDiff {
  schemaVersion: 1;
  designId: number;
  linkId: number;
  nodeId: string;
  issueId: number;
  targetRevision: number;
  issueStatus: IssueState;
  base: DesignIssueSyncContract;
  local: DesignIssueSyncContract;
  incoming: DesignIssueSyncContract | null;
  incomingBaseline: DesignIssueBaselineContract | null;
  diff: DesignIssueThreeWayDiff;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function syncContract(contract: DesignIssueBaselineContract): DesignIssueSyncContract {
  return {
    title: contract.title,
    body: contract.body,
    moduleId: contract.moduleId,
    agent: contract.agent,
    implMode: contract.implMode,
    dependencies: [...contract.dependencies],
  };
}

function incomingBaseline(task: DesignTask, revision: number, node: DesignGraphNode): DesignIssueBaselineContract {
  const withoutBody: Omit<DesignIssueBaselineContract, 'body'> = {
    schemaVersion: 1,
    designId: task.id,
    revision,
    nodeId: node.nodeId,
    title: node.title,
    goal: node.goal ?? '',
    background: [...(node.background ?? [])],
    sourceSections: [...(node.sourceSections ?? [])],
    scope: [...(node.scope ?? [])],
    nonGoals: [...(node.nonGoals ?? [])],
    inputs: [...(node.inputs ?? [])],
    outputs: [...(node.outputs ?? [])],
    dependencies: [...(node.dependencies ?? [])],
    implementationNotes: [...(node.implementationNotes ?? [])],
    moduleId: node.moduleId ?? task.moduleId,
    runtime: node.runtime ?? 'current',
    agent: node.agent ?? task.agent,
    complexity: node.complexity ?? 'medium',
    complexityRationale: [...(node.complexityRationale ?? [])],
    acceptanceCriteria: [...(node.acceptanceCriteria ?? [])],
    testRecommendations: [...(node.testRecommendations ?? [])],
    evidenceRequirements: [...(node.evidenceRequirements ?? [])],
    completionInstructions: [...(node.completionInstructions ?? [])],
    implMode: node.implMode ?? 'direct',
  };
  return { ...withoutBody, body: renderDesignIssueBody(withoutBody) };
}

function actionableState(status: IssueState, hasConflict: boolean): DesignIssueSyncState {
  if (status === 'done' || status === 'merging') return 'supplement_needed';
  if (status === 'cancelled') return 'cancelled';
  if (hasConflict) return 'conflict';
  return 'confirmation_needed';
}

function immediateBoundary(status: IssueState, manualReview: boolean): { kind: string; action: unknown } | null {
  if (status === 'plan_review' || status === 'merge_review') {
    return {
      kind: status,
      action: manualReview
        ? { kind: 'safe_state', status }
        : { kind: 'resume_entry', from: status === 'plan_review' ? 'planning' : 'testing', to: status },
    };
  }
  if (status === 'blocked' || status === 'cancelled' || status === 'done' || status === 'merging') {
    return { kind: status, action: { kind: 'safe_state', status } };
  }
  return null;
}

export class DesignSyncCoordinator {
  private readonly now: () => number;

  constructor(private readonly deps: DesignSyncCoordinatorDeps) {
    this.now = deps.now ?? Date.now;
  }

  reconcileRevision(designId: number, targetRevision: number, requestedBy: number | null): DesignIssueSyncResult[] {
    const task = this.deps.store.getTask(designId);
    const revision = this.deps.store.getRevision(designId, targetRevision);
    if (!task || !revision) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design revision not found');
    if (task.status === 'archived' || task.stage === 'archived') {
      throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'archived design cannot synchronize Issues');
    }
    if (targetRevision !== task.currentRevision) {
      throw new DesignSyncError('DESIGN_SYNC_STALE', 'only the current design revision can synchronize Issues');
    }
    const validation = validateDesignGraph(revision.graph);
    if (!validation.valid) throw new DesignSyncError('DESIGN_SYNC_INVALID', 'design revision graph is invalid');
    const nodes = new Map(revision.graph.nodes.map((node) => [node.nodeId, node]));
    const links = this.deps.store.listPrimaryIssueLinks(designId);
    const nodeByIssue = new Map(links.map((link) => [link.issueId, link.nodeId]));
    const issueByNode = new Map(links.map((link) => [link.nodeId, link.issueId]));
    return links.map((link) => this.reconcileLink(
      task, targetRevision, link, nodes.get(link.nodeId) ?? null, nodeByIssue, issueByNode, requestedBy,
    ));
  }

  listSyncs(designId: number): DesignSyncListItem[] {
    const task = this.deps.store.getTask(designId);
    if (!task) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design not found');
    return this.deps.store.listPrimaryIssueLinks(designId).map((rawLink) => {
      const recovery = this.getLinkRecovery(rawLink.id);
      const link = this.deps.store.getIssueLink(rawLink.id) ?? rawLink;
      const execution = this.deps.issues.latestExecutionSync(link.issueId, 'design', this.sourceKey(link));
      let payload: PersistedDesignSyncDiff | null = null;
      if (execution) {
        try {
          const parsed = JSON.parse(execution.diffJson) as PersistedDesignSyncDiff;
          if (parsed.schemaVersion === 1 && parsed.designId === designId && parsed.linkId === link.id) payload = parsed;
        } catch {
          payload = null;
        }
      }
      const fields: DesignSyncFieldView[] = payload
        ? SYNC_FIELDS.flatMap((field) => {
          const value = payload!.diff.fields[field];
          return value ? [{ field, kind: value.kind, base: value.base, local: value.local, incoming: value.incoming }] : [];
        })
        : [];
      const pending = this.deps.issues.hasUnresolvedExecutionSyncEffect(link.issueId);
      const resolutionRequired = execution !== null
        && this.deps.issues.getUncertainExecutionSyncEffect(execution.id) !== null;
      const projected = recovery ?? this.result(
        link,
        payload?.targetRevision ?? task.currentRevision,
        execution?.id ?? null,
        null,
        true,
      );
      return {
        ...projected,
        decisionState: execution?.state ?? null,
        fields,
        recovery: { pending, resolutionRequired },
      };
    });
  }

  async decideScoped(
    designId: number,
    syncId: number,
    expectedRevision: number,
    decision: DesignIssueSyncDecision,
    actor: number,
  ): Promise<DesignIssueSyncResult> {
    this.requireScopedSync(designId, syncId, expectedRevision);
    return this.decide(syncId, expectedRevision, decision, actor);
  }

  async resolveScopedRecovery(
    designId: number,
    syncId: number,
    expectedRevision: number,
    resolution: 'confirm_delivered' | 'retry',
  ): Promise<DesignIssueSyncResult> {
    const scoped = this.requireScopedSync(designId, syncId, expectedRevision);
    const effect = this.deps.issues.getUncertainExecutionSyncEffect(syncId);
    if (!effect) throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'sync recovery is not awaiting a decision');
    const resolved = this.resolveLinkRecovery(
      scoped.link.id,
      effect.resumeKey,
      effect.intentKey,
      resolution,
    );
    if (resolution !== 'retry') return resolved;
    // This resend is authorized by the explicit owner retry request; uncertain effects are never auto-rearmed.
    await this.deps.issues.drainExecutionSyncEffectOutbox();
    const pending = this.getLinkRecovery(scoped.link.id);
    if (pending) return pending;
    const refreshed = this.deps.store.getIssueLink(scoped.link.id);
    if (!refreshed) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync link not found');
    const current = refreshed.syncState === 'current'
      ? refreshed
      : this.deps.store.markIssueLinkState(
        refreshed.id,
        refreshed.lastSyncedRevision,
        'current',
        {
          nodeId: refreshed.nodeId,
          issueId: refreshed.issueId,
          targetRevision: refreshed.lastSyncedRevision,
          recoveryResolution: 'retry_delivered',
        },
        this.now(),
      );
    return this.result(current, current.lastSyncedRevision, syncId, null, false);
  }

  drainRevisionSyncJobs(options: DesignSyncDrainOptions = {}): DesignSyncDrainResult {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const abandonedAfterMs = Math.max(1_000, Math.min(86_400_000, Math.trunc(
      options.abandonedAfterMs ?? 60_000,
    )));
    const result: DesignSyncDrainResult = { examined: 0, completed: 0, retried: 0, stale: 0 };
    for (let index = 0; index < limit; index++) {
      const now = this.now();
      const job = this.deps.store.claimNextIssueSyncJob(now, now - abandonedAfterMs);
      if (!job?.claimToken) break;
      result.examined++;
      try {
        const task = this.deps.store.getTask(job.designTaskId);
        const revision = this.deps.store.getRevision(job.designTaskId, job.targetRevision);
        const link = this.deps.store.getIssueLink(job.linkId);
        if (!task || !revision || !link || task.currentRevision !== job.targetRevision) {
          this.deps.store.staleIssueSyncJob(job.id, job.claimToken, now);
          result.stale++;
          continue;
        }
        const validation = validateDesignGraph(revision.graph);
        if (!validation.valid) throw new DesignSyncError('DESIGN_SYNC_INVALID', 'design revision graph is invalid');
        const links = this.deps.store.listPrimaryIssueLinks(job.designTaskId);
        const nodeByIssue = new Map(links.map((candidate) => [candidate.issueId, candidate.nodeId]));
        const issueByNode = new Map(links.map((candidate) => [candidate.nodeId, candidate.issueId]));
        const node = revision.graph.nodes.find((candidate) => candidate.nodeId === link.nodeId) ?? null;
        this.reconcileLink(task, job.targetRevision, link, node, nodeByIssue, issueByNode, null);
        if (!this.deps.store.completeIssueSyncJob(job.id, job.claimToken, now)) {
          throw new Error('design sync job completion claim lost');
        }
        result.completed++;
      } catch (error) {
        const current = this.deps.store.getTask(job.designTaskId);
        if (!current || current.currentRevision !== job.targetRevision
          || (error instanceof DesignSyncError && error.code === 'DESIGN_SYNC_STALE')) {
          this.deps.store.staleIssueSyncJob(job.id, job.claimToken, now);
          result.stale++;
          continue;
        }
        const backoffMs = Math.min(60_000, 1_000 * (2 ** Math.min(6, Math.max(0, job.attemptCount - 1))));
        this.deps.store.retryIssueSyncJob(job.id, job.claimToken, String(error), now + backoffMs, now);
        result.retried++;
      }
    }
    return result;
  }

  async decide(
    syncId: number,
    targetRevision: number,
    decision: DesignIssueSyncDecision,
    actor: number,
  ): Promise<DesignIssueSyncResult> {
    const sync = this.deps.issues.getExecutionSync(syncId);
    if (!sync || sync.sourceKind !== 'design') {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync request not found');
    }
    let payload: PersistedDesignSyncDiff;
    try {
      payload = JSON.parse(sync.diffJson) as PersistedDesignSyncDiff;
    } catch {
      throw new DesignSyncError('DESIGN_SYNC_INVALID', 'design sync request is malformed');
    }
    if (payload.schemaVersion !== 1 || payload.targetRevision !== targetRevision
      || sync.sourceRevision !== String(targetRevision)) {
      throw new DesignSyncError('DESIGN_SYNC_STALE', 'design sync decision revision is stale');
    }
    const link = this.deps.store.getIssueLink(payload.linkId);
    if (!link || link.designTaskId !== payload.designId
      || link.issueId !== sync.issueId || link.nodeId !== payload.nodeId) {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync link not found');
    }
    const latest = this.deps.issues.latestExecutionSync(sync.issueId, 'design', this.sourceKey(link));
    if (!latest || latest.id !== sync.id || sync.state === 'stale') {
      throw new DesignSyncError('DESIGN_SYNC_STALE', 'a newer design revision superseded this request');
    }
    const status = this.deps.issues.getDesignSyncSnapshot(sync.issueId)?.status;
    if (!status) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'linked Issue not found');
    if ((status === 'done' || status === 'cancelled' || status === 'merging') && decision === 'apply') {
      throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'immutable Issue history cannot be patched');
    }
    let preparedSupplement: PreparedDesignBatch | null = null;
    if (decision === 'supplement') {
      if (!payload.incomingBaseline) {
        throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'removed nodes cannot create an empty supplement');
      }
      preparedSupplement = await this.deps.issues.prepareDesignBatch(link.projectId, [{
        nodeId: `${payload.nodeId}-supplement-r${targetRevision}`.slice(0, 120),
        title: payload.incomingBaseline.title,
        body: payload.incomingBaseline.body,
        moduleId: payload.incomingBaseline.moduleId,
        implMode: payload.incomingBaseline.implMode,
        agent: payload.incomingBaseline.agent,
        createdBy: actor,
      }]);
    }
    const currentTask = this.deps.store.getTask(payload.designId);
    if (!currentTask || currentTask.currentRevision !== targetRevision) {
      throw new DesignSyncError(
        'DESIGN_SYNC_STALE',
        'design revision changed while preparing the sync decision',
        currentTask?.currentRevision,
      );
    }
    try {
      this.deps.issues.decideExecutionSync(syncId, decision, actor);
    } catch (error) {
      const reread = this.deps.issues.getExecutionSync(syncId);
      const targetState = decision === 'apply' ? 'applied' : decision === 'ignore' ? 'ignored' : 'supplemented';
      if (reread?.state !== targetState) {
        throw new DesignSyncError('DESIGN_SYNC_CONFLICT', String(error));
      }
    }
    const resumed = this.deps.issues.resumeExecutionSync(syncId, (action, claimed, context) =>
      this.applyDecisionEffect(link, payload, decision, actor, action, claimed, context, preparedSupplement));
    await this.deps.issues.drainExecutionSyncEffectOutbox();
    if (!resumed.result) {
      throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'design sync decision is awaiting recovery');
    }
    return this.projectRecoveryPending(resumed.result);
  }

  /** Narrow recovery projection for a single Design link; suitable for a future owner-only route. */
  getLinkRecovery(linkId: number): DesignIssueSyncResult | null {
    const link = this.deps.store.getIssueLink(linkId);
    if (!link || !this.deps.issues.hasUnresolvedExecutionSyncEffect(link.issueId)) return null;
    const latest = this.deps.issues.latestExecutionSync(link.issueId, 'design', this.sourceKey(link));
    const effect = latest ? this.deps.issues.getUncertainExecutionSyncEffect(latest.id) : null;
    return this.projectRecoveryPending(this.result(
      link,
      link.lastSyncedRevision,
      effect?.syncId ?? latest?.id ?? null,
      null,
      true,
    ));
  }

  /** Explicit operator resolution. This never dispatches a retry by itself. */
  resolveLinkRecovery(
    linkId: number,
    resumeKey: string,
    intentKey: string,
    resolution: 'confirm_delivered' | 'retry',
  ): DesignIssueSyncResult {
    const link = this.deps.store.getIssueLink(linkId);
    if (!link) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync link not found');
    const effect = this.deps.issues.listUncertainExecutionSyncEffects(500).find((candidate) =>
      candidate.resumeKey === resumeKey && candidate.intentKey === intentKey);
    const sync = effect ? this.deps.issues.getExecutionSync(effect.syncId) : null;
    if (!effect || sync?.issueId !== link.issueId) {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync recovery effect not found');
    }
    if (!this.deps.issues.resolveUncertainExecutionSyncEffect(resumeKey, intentKey, resolution)) {
      throw new DesignSyncError('DESIGN_SYNC_CONFLICT', 'design sync recovery effect changed');
    }
    const unresolved = this.deps.issues.hasUnresolvedExecutionSyncEffect(link.issueId);
    const nextState: DesignIssueSyncState = unresolved ? 'recovery_pending' : 'current';
    const refreshed = this.deps.store.getIssueLink(linkId)!;
    const projected = refreshed.syncState === nextState
      ? refreshed
      : this.deps.store.markIssueLinkState(
        refreshed.id,
        refreshed.lastSyncedRevision,
        nextState,
        {
          nodeId: refreshed.nodeId,
          issueId: refreshed.issueId,
          targetRevision: refreshed.lastSyncedRevision,
          recoveryResolution: resolution,
        },
        this.now(),
      );
    return this.result(projected, projected.lastSyncedRevision, effect.syncId, null, false);
  }

  private applyDecisionEffect(
    link: DesignIssueLink,
    payload: PersistedDesignSyncDiff,
    decision: DesignIssueSyncDecision,
    actor: number,
    deferredAction: unknown,
    _sync: IssueExecutionSync,
    context: IssueExecutionSyncEffectContext,
    preparedSupplement: PreparedDesignBatch | null,
  ): DesignIssueSyncResult {
    const baseline = payload.incomingBaseline;
    if (!baseline) throw new DesignSyncError('DESIGN_SYNC_NOT_ACTIONABLE', 'removed node has no incoming contract');
    let supplementIssueId: number | null = null;
    if (decision === 'apply') {
      const fresh = this.deps.issues.getDesignSyncSnapshot(link.issueId);
      if (!fresh) throw new Error('linked Issue disappeared');
      const localNow: DesignIssueSyncContract = {
        title: fresh.title,
        body: fresh.body,
        moduleId: fresh.moduleId,
        agent: fresh.agent,
        implMode: fresh.implMode,
        dependencies: fresh.dependencyIssueIds.map((issueId) => {
          const dependency = this.deps.store.listPrimaryIssueLinks(link.designTaskId)
            .find((candidate) => candidate.issueId === issueId);
          return dependency?.nodeId ?? `issue:${issueId}`;
        }),
      };
      if (JSON.stringify(localNow) !== JSON.stringify(payload.local)) {
        throw new DesignSyncError('DESIGN_SYNC_CONFLICT', 'Issue changed after the sync request');
      }
      const primaryLinks = this.deps.store.listPrimaryIssueLinks(link.designTaskId);
      const issueByNode = new Map(primaryLinks.map((candidate) => [candidate.nodeId, candidate.issueId]));
      const dependencyIssueIds = baseline.dependencies.map((nodeId) => {
        const issueId = issueByNode.get(nodeId);
        if (!issueId) throw new DesignSyncError('DESIGN_SYNC_CONFLICT', `dependency node is not published: ${nodeId}`);
        return issueId;
      }).sort((a, b) => a - b);
      const expected = {
        issueId: fresh.issueId,
        projectId: fresh.projectId,
        title: fresh.title,
        body: fresh.body,
        moduleId: fresh.moduleId,
        agent: fresh.agent,
        implMode: fresh.implMode,
        dependencyIssueIds: [...fresh.dependencyIssueIds].sort((a, b) => a - b),
      };
      this.deps.issues.updateFromDesign({
        issueId: fresh.issueId,
        expectedStatus: fresh.status as IssueDesignSyncUpdate['expectedStatus'],
        expected,
        next: { ...syncContract(baseline), dependencyIssueIds },
        sourceRevision: String(payload.targetRevision),
      }, () => this.deps.store.completeIssueSyncInTransaction({
        linkId: link.id,
        expectedLastSyncedRevision: link.lastSyncedRevision,
        targetRevision: payload.targetRevision,
        baselineContract: baseline,
        baselineContractDigest: sha256Json(baseline),
        state: 'current',
        eventKind: 'issue_sync_applied',
        eventData: { nodeId: link.nodeId, issueId: link.issueId, targetRevision: payload.targetRevision, actor },
        now: this.now(),
      }));
    } else if (decision === 'ignore') {
      this.deps.store.completeIssueSyncInTransaction({
        linkId: link.id,
        expectedLastSyncedRevision: link.lastSyncedRevision,
        targetRevision: payload.targetRevision,
        baselineContract: baseline,
        baselineContractDigest: sha256Json(baseline),
        state: 'current',
        eventKind: 'issue_sync_ignored',
        eventData: { nodeId: link.nodeId, issueId: link.issueId, targetRevision: payload.targetRevision, actor },
        now: this.now(),
      });
    } else {
      if (!preparedSupplement) throw new Error('design supplement prepare capability is missing');
      const created = this.deps.issues.commitPreparedDesignBatch(preparedSupplement, [], (byNode) => {
        const supplement = [...byNode.values()][0];
        if (!supplement) throw new Error('design supplement Issue missing');
        supplementIssueId = supplement.id;
        this.deps.store.createSupplementLinkInTransaction({
          parentLinkId: link.id,
          issueId: supplement.id,
          targetRevision: payload.targetRevision,
          baselineContract: baseline,
          baselineContractDigest: sha256Json(baseline),
          now: this.now(),
        });
        return supplement.id;
      });
      supplementIssueId = created[0]!.id;
      this.deps.store.completeIssueSyncInTransaction({
        linkId: link.id,
        expectedLastSyncedRevision: link.lastSyncedRevision,
        targetRevision: payload.targetRevision,
        baselineContract: baseline,
        baselineContractDigest: sha256Json(baseline),
        state: 'current',
        eventKind: 'issue_sync_applied',
        eventData: {
          nodeId: link.nodeId, issueId: link.issueId, supplementIssueId,
          targetRevision: payload.targetRevision, actor,
        },
        now: this.now(),
      });
    }
    context.enqueueExternalEffect(
      `boundary:${link.issueId}:${payload.targetRevision}`,
      'issue-sync-boundary',
      { issueId: link.issueId, action: deferredAction },
    );
    const updated = this.deps.store.getIssueLink(link.id)!;
    return this.result(updated, payload.targetRevision, _sync.id, supplementIssueId, false);
  }

  private reconcileLink(
    task: DesignTask,
    targetRevision: number,
    link: DesignIssueLink,
    node: DesignGraphNode | null,
    nodeByIssue: ReadonlyMap<number, string>,
    issueByNode: ReadonlyMap<string, number>,
    requestedBy: number | null,
  ): DesignIssueSyncResult {
    if (targetRevision < link.lastSyncedRevision) {
      throw new DesignSyncError('DESIGN_SYNC_STALE', 'design sync target revision is stale');
    }
    if (targetRevision === link.lastSyncedRevision) {
      return this.projectRecoveryPending(this.result(link, targetRevision, null, null, true));
    }
    if (!node) {
      if (link.syncState !== 'stale') {
        this.deps.store.markIssueLinkState(link.id, link.lastSyncedRevision, 'stale', {
          nodeId: link.nodeId, issueId: link.issueId, targetRevision, reason: 'node_removed',
        }, this.now());
      }
      return this.result(this.deps.store.getIssueLink(link.id)!, targetRevision, null, null, link.syncState === 'stale');
    }
    const issue = this.deps.issues.getDesignSyncSnapshot(link.issueId);
    if (!issue || issue.projectId !== task.projectId) {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'linked Issue not found');
    }
    const base = syncContract(link.baselineContract);
    const local: DesignIssueSyncContract = {
      title: issue.title,
      body: issue.body,
      moduleId: issue.moduleId,
      agent: issue.agent,
      implMode: issue.implMode,
      dependencies: issue.dependencyIssueIds.map((id) => nodeByIssue.get(id) ?? `issue:${id}`),
    };
    const baseline = incomingBaseline(task, targetRevision, node);
    const incoming = syncContract(baseline);
    const diff = threeWayDesignDiff(base, local, incoming);
    const payload: PersistedDesignSyncDiff = {
      schemaVersion: 1,
      designId: task.id,
      linkId: link.id,
      nodeId: link.nodeId,
      issueId: link.issueId,
      targetRevision,
      issueStatus: issue.status,
      base,
      local,
      incoming,
      incomingBaseline: baseline,
      diff,
    };
    if (issue.status === 'pending' && !diff.hasConflicts) {
      const desired = { ...local, ...diff.autoPatch };
      const dependencyIssueIds = desired.dependencies.map((nodeId) => {
        const issueId = issueByNode.get(nodeId);
        if (!issueId) throw new DesignSyncError('DESIGN_SYNC_CONFLICT', `dependency node is not published: ${nodeId}`);
        return issueId;
      }).sort((a, b) => a - b);
      const expected = {
        issueId: issue.issueId,
        projectId: issue.projectId,
        title: issue.title,
        body: issue.body,
        moduleId: issue.moduleId,
        agent: issue.agent,
        implMode: issue.implMode,
        dependencyIssueIds: [...issue.dependencyIssueIds].sort((a, b) => a - b),
      };
      try {
        const updated = this.deps.issues.updateFromDesign({
          issueId: issue.issueId,
          expectedStatus: 'pending',
          expected,
          next: { ...desired, dependencyIssueIds },
          sourceRevision: String(targetRevision),
        }, () => this.deps.store.completeIssueSyncInTransaction({
          linkId: link.id,
          expectedLastSyncedRevision: link.lastSyncedRevision,
          targetRevision,
          baselineContract: baseline,
          baselineContractDigest: sha256Json(baseline),
          state: 'auto_synced',
          eventKind: 'issue_sync_applied',
          eventData: { nodeId: link.nodeId, issueId: link.issueId, targetRevision, automatic: true },
          now: this.now(),
        }));
        return this.result(updated, targetRevision, null, null, false);
      } catch (error) {
        const raced = this.deps.issues.getDesignSyncSnapshot(link.issueId);
        if (raced && raced.status !== 'pending') {
          return this.requestDecision(link, targetRevision, raced, payload, requestedBy, false);
        }
        throw error;
      }
    }
    return this.requestDecision(link, targetRevision, issue, payload, requestedBy, diff.hasConflicts);
  }

  private requestDecision(
    link: DesignIssueLink,
    targetRevision: number,
    issue: IssueDesignSyncSnapshot,
    payload: PersistedDesignSyncDiff,
    requestedBy: number | null,
    hasConflict: boolean,
  ): DesignIssueSyncResult {
    const sourceKey = this.sourceKey(link);
    const state = actionableState(issue.status, hasConflict);
    const execution = this.deps.store.commitIssueSyncRequest({
      linkId: link.id,
      expectedLastSyncedRevision: link.lastSyncedRevision,
      targetRevision,
      state,
      eventData: { nodeId: link.nodeId, issueId: link.issueId, targetRevision, state },
      now: this.now(),
    }, () => {
      const row = this.deps.issues.requestLatestExecutionSync(link.issueId, {
        sourceKind: 'design',
        sourceKey,
        sourceRevision: String(targetRevision),
        sourceDigest: sha256Json(payload.incomingBaseline),
        diff: payload,
        requestedBy,
      });
      const immediate = issue.status === 'pending'
        ? { kind: 'pending_conflict', action: { kind: 'safe_state', status: 'pending' } }
        : immediateBoundary(issue.status, issue.manualReview);
      if (immediate) {
        return this.deps.issues.holdExecutionSyncBoundary(link.issueId, immediate.kind, immediate.action) ?? row;
      }
      return row;
    });
    return this.result(this.deps.store.getIssueLink(link.id)!, targetRevision, execution.id, null, false);
  }

  private sourceKey(link: DesignIssueLink): string {
    return `design:${link.designTaskId}:node:${link.nodeId}:issue:${link.issueId}`;
  }

  private requireScopedSync(
    designId: number,
    syncId: number,
    expectedRevision: number,
  ): { link: DesignIssueLink; sync: IssueExecutionSync; payload: PersistedDesignSyncDiff } {
    const task = this.deps.store.getTask(designId);
    if (!task) throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design not found');
    if (task.currentRevision !== expectedRevision) {
      throw new DesignSyncError('DESIGN_SYNC_STALE', 'design revision changed', task.currentRevision);
    }
    const sync = this.deps.issues.getExecutionSync(syncId);
    if (!sync || sync.sourceKind !== 'design') {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync not found');
    }
    let payload: PersistedDesignSyncDiff;
    try {
      payload = JSON.parse(sync.diffJson) as PersistedDesignSyncDiff;
    } catch {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync not found');
    }
    const link = this.deps.store.getIssueLink(payload.linkId);
    if (payload.schemaVersion !== 1 || payload.designId !== designId
      || payload.targetRevision !== expectedRevision || sync.sourceRevision !== String(expectedRevision)
      || !link || link.designTaskId !== designId || link.issueId !== sync.issueId || link.nodeId !== payload.nodeId) {
      throw new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'design sync not found');
    }
    return { link, sync, payload };
  }

  private projectRecoveryPending(result: DesignIssueSyncResult): DesignIssueSyncResult {
    if (!this.deps.issues.hasUnresolvedExecutionSyncEffect(result.issueId)) return result;
    const link = this.deps.store.getIssueLink(result.linkId);
    if (!link) return { ...result, state: 'recovery_pending' };
    const projected = link.syncState === 'recovery_pending'
      ? link
      : this.deps.store.markIssueLinkState(
        link.id,
        link.lastSyncedRevision,
        'recovery_pending',
        {
          nodeId: link.nodeId,
          issueId: link.issueId,
          targetRevision: result.targetRevision,
          recoveryPending: true,
        },
        this.now(),
      );
    return { ...result, state: projected.syncState as DesignIssueSyncState };
  }

  private result(
    link: DesignIssueLink,
    targetRevision: number,
    executionSyncId: number | null,
    supplementIssueId: number | null,
    repeated: boolean,
  ): DesignIssueSyncResult {
    return {
      linkId: link.id,
      nodeId: link.nodeId,
      issueId: link.issueId,
      targetRevision,
      state: link.syncState as DesignIssueSyncState,
      executionSyncId,
      supplementIssueId,
      repeated,
    };
  }
}

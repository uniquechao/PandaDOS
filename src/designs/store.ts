import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { migrate, type MigrationStatus } from '../core/migrate';
import { designGraphDigest, validateDesignGraph } from './graph';
import {
  DESIGN_CREATION_SAGA_PHASES,
  DESIGN_EVENT_KINDS,
  DESIGN_TASK_STAGES,
  DESIGN_TASK_STATUSES,
  normalizeDesignGraphGranularity,
} from './types';
import type {
  CreateDesignTaskRecord,
  CreateRevisionedDesignTaskRecord,
  DesignCreationSaga,
  DesignCreationSagaPhase,
  DesignAgentOperationInput,
  DesignDocumentMutationInput,
  DesignDocumentMutationResult,
  DesignEvent,
  DesignEventKind,
  DesignGraph,
  DesignGraphDraft,
  DesignGraphEdge,
  DesignGraphNode,
  DesignGraphNodeDraft,
  DesignIssueBaselineContract,
  DesignIssueLink,
  DesignIssueSyncJob,
  DesignIssueSyncJobState,
  DesignIssueSyncState,
  DesignPublication,
  DesignPublicationOutboxItem,
  DesignPublicationStatus,
  DesignRevision,
  DesignRuntimeMetadataPatch,
  DesignRunIntent,
  DesignAgentRunGroup,
  DesignAgentRunMode,
  DesignAgentRunStatus,
  DesignStageTransitionInput,
  DesignTask,
  DesignTaskPatch,
  DesignTaskStage,
  DesignTaskStatus,
  SaveDesignRevision,
} from './types';

export class DesignRevisionConflictError extends Error {
  readonly code = 'DESIGN_REVISION_CONFLICT';

  constructor(readonly currentRevision: number) {
    super(`revision conflict; current revision is ${currentRevision}`);
    this.name = 'DesignRevisionConflictError';
  }
}

export class DesignTaskImmutableError extends Error {
  readonly code = 'DESIGN_ARCHIVED';

  constructor(readonly designId: number) {
    super(`design task is archived: ${designId}`);
    this.name = 'DesignTaskImmutableError';
  }
}

export class DesignStageConflictError extends Error {
  readonly code = 'DESIGN_INVALID_STAGE_TRANSITION';

  constructor(
    readonly currentStage: DesignTaskStage,
    readonly currentRevision: number,
  ) {
    super(`design stage conflict; current stage is ${currentStage}`);
    this.name = 'DesignStageConflictError';
  }
}

export class DesignOperationConflictError extends Error {
  readonly code = 'DESIGN_IDEMPOTENCY_CONFLICT';

  constructor(readonly operationId: string) {
    super(`design operation ${operationId} was already used with a different request`);
    this.name = 'DesignOperationConflictError';
  }
}

interface DesignTaskRow {
  id: number;
  project_id: number;
  module_id: number | null;
  title: string;
  original_request: string;
  agent: string;
  stage: string;
  status: string;
  current_revision: number;
  readiness_threshold: number;
  readiness_override: number;
  document_json: string | null;
  document_markdown: string | null;
  graph_granularity: string;
  conversation_id: string | null;
  worktree_cwd: string | null;
  worktree_branch: string | null;
  worktree_metadata_json: string | null;
  created_ts: number;
  updated_ts: number;
  last_error: string | null;
}

interface DesignRunIntentRow {
  design_task_id: number;
  run_id: string;
  project_id: number;
  operation_group_id: string;
  persona_key: string;
  persona_content_hash: string;
  persona_origin: string;
  persona_git_commit: string | null;
  persona_role: string;
  resolved_agent: string;
  source_revision: number;
  state: string;
  created_ts: number;
  updated_ts: number;
}

interface DesignAgentRunGroupRow {
  id: string;
  design_task_id: number;
  project_id: number;
  idempotency_key: string;
  request_digest: string;
  mode: string;
  source_revision: number;
  message: string | null;
  persona_keys_json: string;
  status: string;
  cancel_requested: number;
  failure_code: string | null;
  created_by_user_id: number;
  created_ts: number;
  started_ts: number | null;
  finished_ts: number | null;
  updated_ts: number;
}

function mapRunIntent(row: DesignRunIntentRow): DesignRunIntent {
  return {
    designId: row.design_task_id,
    runId: row.run_id,
    projectId: row.project_id,
    operationGroupId: row.operation_group_id,
    key: row.persona_key,
    contentHash: row.persona_content_hash,
    origin: row.persona_origin as DesignRunIntent['origin'],
    gitCommit: row.persona_git_commit,
    role: row.persona_role as DesignRunIntent['role'],
    resolvedAgent: row.resolved_agent as DesignRunIntent['resolvedAgent'],
    sourceRevision: row.source_revision,
    state: row.state as DesignRunIntent['state'],
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function mapAgentRunGroup(row: DesignAgentRunGroupRow): DesignAgentRunGroup {
  return {
    id: row.id,
    designTaskId: row.design_task_id,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    mode: row.mode as DesignAgentRunMode,
    sourceRevision: row.source_revision,
    message: row.message,
    personaKeys: JSON.parse(row.persona_keys_json) as string[],
    status: row.status as DesignAgentRunStatus,
    cancelRequested: row.cancel_requested === 1,
    failureCode: row.failure_code,
    createdByUserId: row.created_by_user_id,
    createdTs: row.created_ts,
    startedTs: row.started_ts,
    finishedTs: row.finished_ts,
    updatedTs: row.updated_ts,
  };
}

export interface EnsureDesignCreationSagaInput {
  sagaToken: string;
  projectId: number;
  idempotencyKey: string;
  requestJson: string;
  conversationId: string;
  createdTs?: number;
}

interface DesignCreationSagaRow {
  saga_token: string;
  project_id: number;
  idempotency_key: string;
  request_json: string;
  conversation_id: string;
  task_id: number | null;
  phase: string;
  conversation_owned: number;
  error: string | null;
  created_ts: number;
  updated_ts: number;
}

interface DesignRevisionRow {
  id: number;
  design_task_id: number;
  revision: number;
  document_json: string;
  document_markdown: string;
  readiness: number;
  graph_json: string;
  actor: string;
  reason: string | null;
  created_ts: number;
}

interface DesignEventRow {
  id: number;
  design_task_id: number;
  kind: string;
  data_json: string | null;
  ts: number;
}

interface DesignPublicationRow {
  id: number;
  design_task_id: number;
  project_id: number;
  revision: number;
  graph_digest: string;
  actor_key: string;
  idempotency_key: string;
  status: string;
  error: string | null;
  created_ts: number;
  updated_ts: number;
}

interface DesignIssueLinkRow {
  id: number;
  publication_id: number;
  design_task_id: number;
  project_id: number;
  node_id: string;
  issue_id: number;
  source_revision: number;
  last_synced_revision: number;
  original_impl_mode: string;
  baseline_contract_json: string;
  baseline_contract_digest: string;
  sync_state: string;
  sync_error: string | null;
  next_retry_ts: number | null;
  parent_issue_id: number | null;
  parent_link_id: number | null;
  created_ts: number;
  updated_ts: number;
}

interface DesignIssueSyncJobRow {
  id: number;
  link_id: number;
  design_task_id: number;
  target_revision: number;
  state: string;
  attempt_count: number;
  next_retry_ts: number;
  claim_token: string | null;
  claimed_ts: number | null;
  completed_ts: number | null;
  last_error: string | null;
  created_ts: number;
  updated_ts: number;
}

interface DesignPublicationOutboxRow {
  id: number;
  publication_id: number;
  kind: string;
  target_key: string;
  payload_json: string;
  attempt_count: number;
  next_retry_ts: number;
  completed_ts: number | null;
  last_error: string | null;
  created_ts: number;
  updated_ts: number;
}

export interface DesignPublishConfirmationRecord {
  tokenHash: string;
  designTaskId: number;
  revision: number;
  graphDigest: string;
  actorKey: string;
  expiresTs: number;
  consumedPublicationId: number | null;
  consumedTs: number | null;
  createdTs: number;
}

interface DesignPublishConfirmationRow {
  token_hash: string;
  design_task_id: number;
  revision: number;
  graph_digest: string;
  actor_key: string;
  expires_ts: number;
  consumed_publication_id: number | null;
  consumed_ts: number | null;
  created_ts: number;
}

export interface DesignPublicationLinkInput {
  nodeId: string;
  issueId: number;
  implMode: 'direct' | 'team';
  baselineContract: DesignIssueBaselineContract;
  baselineContractDigest: string;
}

export interface CommitDesignPublicationInput {
  designTaskId: number;
  projectId: number;
  revision: number;
  graphDigest: string;
  actorKey: string;
  actorUserId: number;
  idempotencyKey: string;
  tokenHash: string;
  links: readonly DesignPublicationLinkInput[];
  now: number;
}

export interface CompleteDesignIssueSyncInput {
  linkId: number;
  expectedLastSyncedRevision: number;
  targetRevision: number;
  baselineContract: DesignIssueBaselineContract;
  baselineContractDigest: string;
  state: DesignIssueSyncState;
  eventKind: 'issue_sync_applied' | 'issue_sync_ignored';
  eventData: unknown;
  now: number;
}

export interface MarkDesignIssueSyncInput {
  linkId: number;
  expectedLastSyncedRevision: number;
  targetRevision: number;
  state: DesignIssueSyncState;
  eventData: unknown;
  now: number;
}

export interface CreateDesignSupplementLinkInput {
  parentLinkId: number;
  issueId: number;
  targetRevision: number;
  baselineContract: DesignIssueBaselineContract;
  baselineContractDigest: string;
  now: number;
}

interface DesignAgentOperationRow {
  design_task_id: number;
  operation_id: string;
  operation_kind: string;
  request_json: string;
  event_id: number;
  revision_id: number | null;
  created_ts: number;
}

interface DesignGraphNodeRow {
  node_id: string;
  ordinal: number;
  title: string;
  detail_json: string | null;
  issue_id: number | null;
  last_synced_revision: number | null;
}

interface DesignGraphEdgeRow {
  from_node_id: string;
  to_node_id: string;
  kind: string;
}

function parseJson(value: string | null): unknown | null {
  if (value === null) return null;
  return JSON.parse(value) as unknown;
}

function json(value: unknown | null | undefined): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function requiredJson(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('required JSON value cannot be undefined');
  return result;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return ((typeof value === 'object' && value !== null) || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

function designTaskStage(value: string): DesignTaskStage {
  if ((DESIGN_TASK_STAGES as readonly string[]).includes(value)) return value as DesignTaskStage;
  throw new Error(`invalid design task stage: ${value}`);
}

function designTaskStatus(value: string): DesignTaskStatus {
  if ((DESIGN_TASK_STATUSES as readonly string[]).includes(value)) return value as DesignTaskStatus;
  throw new Error(`invalid design task status: ${value}`);
}

function designEventKind(value: string): DesignEventKind {
  if ((DESIGN_EVENT_KINDS as readonly string[]).includes(value)) return value as DesignEventKind;
  throw new Error(`invalid design event kind: ${value}`);
}

function creationSagaPhase(value: string): DesignCreationSagaPhase {
  if ((DESIGN_CREATION_SAGA_PHASES as readonly string[]).includes(value)) {
    return value as DesignCreationSagaPhase;
  }
  throw new Error(`invalid design creation saga phase: ${value}`);
}

function mapCreationSaga(row: DesignCreationSagaRow): DesignCreationSaga {
  return {
    sagaToken: row.saga_token,
    projectId: row.project_id,
    idempotencyKey: row.idempotency_key,
    requestJson: row.request_json,
    conversationId: row.conversation_id,
    taskId: row.task_id,
    phase: creationSagaPhase(row.phase),
    conversationOwned: row.conversation_owned === 1,
    error: row.error,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

interface PersistedGraphNodeDetail {
  __designGraphNode: 1;
  detail: unknown | null;
  contract: Omit<DesignGraphNode, 'nodeId' | 'ordinal' | 'title' | 'detail' | 'issueId' | 'lastSyncedRevision'>;
}

function graphNodeDetail(node: DesignGraphNodeDraft): string | null {
  const contract = {
    ...(node.goal === undefined ? {} : { goal: node.goal }),
    ...(node.background === undefined ? {} : { background: node.background }),
    ...(node.sourceSections === undefined ? {} : { sourceSections: node.sourceSections }),
    ...(node.scope === undefined ? {} : { scope: node.scope }),
    ...(node.nonGoals === undefined ? {} : { nonGoals: node.nonGoals }),
    ...(node.inputs === undefined ? {} : { inputs: node.inputs }),
    ...(node.outputs === undefined ? {} : { outputs: node.outputs }),
    ...(node.dependencies === undefined ? {} : { dependencies: node.dependencies }),
    ...(node.implementationNotes === undefined ? {} : { implementationNotes: node.implementationNotes }),
    ...(node.moduleId === undefined ? {} : { moduleId: node.moduleId }),
    ...(node.runtime === undefined ? {} : { runtime: node.runtime }),
    ...(node.agent === undefined ? {} : { agent: node.agent }),
    ...(node.complexity === undefined ? {} : { complexity: node.complexity }),
    ...(node.complexityRationale === undefined ? {} : { complexityRationale: node.complexityRationale }),
    ...(node.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: node.acceptanceCriteria }),
    ...(node.testRecommendations === undefined ? {} : { testRecommendations: node.testRecommendations }),
    ...(node.evidenceRequirements === undefined ? {} : { evidenceRequirements: node.evidenceRequirements }),
    ...(node.completionInstructions === undefined ? {} : { completionInstructions: node.completionInstructions }),
    ...(node.implMode === undefined ? {} : { implMode: node.implMode }),
  };
  if (Object.keys(contract).length === 0) return json(node.detail);
  return requiredJson({
    __designGraphNode: 1,
    detail: node.detail ?? null,
    contract,
  } satisfies PersistedGraphNodeDetail);
}

function parseGraphNodeDetail(value: string | null): { detail: unknown | null; contract: PersistedGraphNodeDetail['contract'] } {
  const parsed = parseJson(value);
  if (
    typeof parsed === 'object'
    && parsed !== null
    && '__designGraphNode' in parsed
    && parsed.__designGraphNode === 1
    && 'contract' in parsed
    && typeof parsed.contract === 'object'
    && parsed.contract !== null
  ) {
    const stored = parsed as unknown as PersistedGraphNodeDetail;
    return { detail: stored.detail, contract: stored.contract };
  }
  return { detail: parsed, contract: {} };
}

function mapTask(row: DesignTaskRow): DesignTask {
  const graphGranularity = normalizeDesignGraphGranularity(row.graph_granularity);
  if (graphGranularity === null) {
    throw new Error(`invalid design graph granularity: ${row.graph_granularity}`);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    moduleId: row.module_id,
    title: row.title,
    originalRequest: row.original_request,
    agent: row.agent === 'codex' ? 'codex' : 'claude',
    stage: designTaskStage(row.stage),
    status: designTaskStatus(row.status),
    currentRevision: row.current_revision,
    readinessThreshold: row.readiness_threshold,
    readinessOverride: row.readiness_override === 1,
    documentJson: parseJson(row.document_json),
    documentMarkdown: row.document_markdown,
    graphGranularity,
    conversationId: row.conversation_id,
    worktreeCwd: row.worktree_cwd,
    worktreeBranch: row.worktree_branch,
    worktreeMetadata: parseJson(row.worktree_metadata_json),
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    lastError: row.last_error,
  };
}

function mapRevision(row: DesignRevisionRow): DesignRevision {
  return {
    id: row.id,
    designTaskId: row.design_task_id,
    revision: row.revision,
    documentJson: parseJson(row.document_json),
    documentMarkdown: row.document_markdown,
    readiness: row.readiness,
    graph: parseJson(row.graph_json) as DesignGraph,
    actor: row.actor,
    reason: row.reason,
    createdTs: row.created_ts,
  };
}

function mapEvent(row: DesignEventRow): DesignEvent {
  return {
    id: row.id,
    designTaskId: row.design_task_id,
    kind: designEventKind(row.kind),
    data: parseJson(row.data_json),
    ts: row.ts,
  };
}

function mapPublication(row: DesignPublicationRow): DesignPublication {
  return {
    id: row.id,
    designTaskId: row.design_task_id,
    projectId: row.project_id,
    revision: row.revision,
    graphDigest: row.graph_digest,
    actorKey: row.actor_key,
    idempotencyKey: row.idempotency_key,
    status: row.status as DesignPublicationStatus,
    error: row.error,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function mapConfirmation(row: DesignPublishConfirmationRow): DesignPublishConfirmationRecord {
  return {
    tokenHash: row.token_hash,
    designTaskId: row.design_task_id,
    revision: row.revision,
    graphDigest: row.graph_digest,
    actorKey: row.actor_key,
    expiresTs: row.expires_ts,
    consumedPublicationId: row.consumed_publication_id,
    consumedTs: row.consumed_ts,
    createdTs: row.created_ts,
  };
}

function mapIssueLink(row: DesignIssueLinkRow): DesignIssueLink {
  return {
    id: row.id,
    publicationId: row.publication_id,
    designTaskId: row.design_task_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    issueId: row.issue_id,
    sourceRevision: row.source_revision,
    lastSyncedRevision: row.last_synced_revision,
    originalImplMode: row.original_impl_mode as 'direct' | 'team',
    baselineContract: JSON.parse(row.baseline_contract_json) as DesignIssueBaselineContract,
    baselineContractDigest: row.baseline_contract_digest,
    syncState: row.sync_state,
    syncError: row.sync_error,
    nextRetryTs: row.next_retry_ts,
    parentIssueId: row.parent_issue_id,
    parentLinkId: row.parent_link_id,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function mapIssueSyncJob(row: DesignIssueSyncJobRow): DesignIssueSyncJob {
  return {
    id: row.id,
    linkId: row.link_id,
    designTaskId: row.design_task_id,
    targetRevision: row.target_revision,
    state: row.state as DesignIssueSyncJobState,
    attemptCount: row.attempt_count,
    nextRetryTs: row.next_retry_ts,
    claimToken: row.claim_token,
    claimedTs: row.claimed_ts,
    completedTs: row.completed_ts,
    lastError: row.last_error,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function mapPublicationOutbox(row: DesignPublicationOutboxRow): DesignPublicationOutboxItem {
  return {
    id: row.id,
    publicationId: row.publication_id,
    kind: row.kind as 'module_index' | 'scheduler',
    targetKey: row.target_key,
    payload: JSON.parse(row.payload_json) as unknown,
    attemptCount: row.attempt_count,
    nextRetryTs: row.next_retry_ts,
    completedTs: row.completed_ts,
    lastError: row.last_error,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function normalizeGraph(graph: DesignGraphDraft): DesignGraph {
  const nodeIds = new Set<string>();
  const ordinals = new Set<number>();
  const nodes = graph.nodes.map((node, index): DesignGraphNode => {
    const ordinal = node.ordinal ?? index;
    if (!node.nodeId || nodeIds.has(node.nodeId)) {
      throw new Error(`duplicate graph node: ${node.nodeId}`);
    }
    if (ordinals.has(ordinal)) throw new Error(`duplicate graph node ordinal: ${ordinal}`);
    nodeIds.add(node.nodeId);
    ordinals.add(ordinal);
    return {
      ...node,
      nodeId: node.nodeId,
      ordinal,
      title: node.title,
      detail: node.detail ?? null,
      issueId: node.issueId ?? null,
      lastSyncedRevision: node.lastSyncedRevision ?? null,
    };
  });
  const edges = graph.edges.map((edge): DesignGraphEdge => {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      throw new Error(`unknown graph node in edge: ${edge.fromNodeId} -> ${edge.toNodeId}`);
    }
    return {
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind ?? 'depends_on',
    };
  });
  return { nodes, edges };
}

/** Design workbench's independent migration directory in the shared schema sequence. */
export const DESIGN_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * An intermediate legacy migration stored saga ownership on conversations. Migration 051 cannot
 * conditionally reference that column in plain SQL because the restored/original 050 lacks it, so
 * bridge only schemas where PRAGMA proves the legacy column exists. Both IDs and project scope must
 * match the durable saga; arbitrary legacy token text is never promoted to ownership.
 */
function backfillLegacyDesignConversationOwners(db: Database): void {
  const hasLegacyOwnershipColumn = db.query<{ name: string }, []>(
    `PRAGMA table_info('conversations')`,
  ).all().some((column) => column.name === 'design_creation_saga_token');
  if (!hasLegacyOwnershipColumn) return;
  db.run(
    `INSERT OR IGNORE INTO design_saga_conversation_owners
       (conversation_id, saga_token, created_ts)
     SELECT conversation.id, saga.saga_token, saga.created_ts
     FROM conversations conversation
     JOIN design_creation_sagas saga
       ON saga.saga_token = conversation.design_creation_saga_token
      AND saga.conversation_id = conversation.id
      AND saga.project_id = conversation.project_id
     WHERE conversation.design_creation_saga_token IS NOT NULL`,
  );
}

/**
 * Migration 050's recorded default is `issue`. Keep 054 additive and normalize that compatibility
 * value immediately so every post-migration row observed by SQL or application code is five-level.
 * These triggers are installed as complete SQLite statements here because the shared migration
 * splitter intentionally does not parse trigger bodies.
 */
function ensureDesignGranularityNormalization(db: Database): void {
  db.transaction(() => {
    db.run(`CREATE TRIGGER IF NOT EXISTS trg_design_tasks_granularity_insert
      AFTER INSERT ON design_tasks
      WHEN NEW.graph_granularity = 'issue'
      BEGIN
        UPDATE design_tasks SET graph_granularity = 'balanced' WHERE id = NEW.id;
      END`);
    db.run(`CREATE TRIGGER IF NOT EXISTS trg_design_tasks_granularity_update
      AFTER UPDATE OF graph_granularity ON design_tasks
      WHEN NEW.graph_granularity = 'issue'
      BEGIN
        UPDATE design_tasks SET graph_granularity = 'balanced' WHERE id = NEW.id;
      END`);
  })();
}

/** Applies the design domain migration after the core and issue-domain migrations. */
export function migrateDesigns(db: Database): MigrationStatus {
  const status = migrate(db, DESIGN_MIGRATIONS_DIR);
  ensureDesignGranularityNormalization(db);
  backfillLegacyDesignConversationOwners(db);
  return status;
}

/** SQLite boundary for design tasks, immutable revision history, and dependency graphs. */
export class DesignStore {
  constructor(private readonly db: Database) {}

  getProjectOwnerUserId(projectId: number): number | null {
    return this.db.query<{ owner_user_id: number }, [number]>(
      'SELECT owner_user_id FROM projects WHERE id = ?',
    ).get(projectId)?.owner_user_id ?? null;
  }

  createRunIntent(intent: DesignRunIntent): boolean {
    const result = this.db.query(`INSERT OR IGNORE INTO design_run_intents
      (design_task_id, run_id, project_id, operation_group_id, persona_key,
       persona_content_hash, persona_origin, persona_git_commit, persona_role, resolved_agent,
       source_revision, state, created_ts, updated_ts)
      SELECT task.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        FROM design_tasks task
       WHERE task.id = ?
         AND task.project_id = ?
         AND task.current_revision = ?
         AND task.agent = ?
         AND task.status = 'active'`
    ).run(
      intent.runId,
      intent.projectId,
      intent.operationGroupId,
      intent.key,
      intent.contentHash,
      intent.origin,
      intent.gitCommit,
      intent.role,
      intent.resolvedAgent,
      intent.sourceRevision,
      intent.state,
      intent.createdTs,
      intent.updatedTs,
      intent.designId,
      intent.projectId,
      intent.sourceRevision,
      intent.resolvedAgent,
    );
    return result.changes === 1;
  }

  getRunIntent(designId: number, runId: string): DesignRunIntent | null {
    const row = this.db.query<DesignRunIntentRow, [number, string]>(
      'SELECT * FROM design_run_intents WHERE design_task_id = ? AND run_id = ?',
    ).get(designId, runId);
    return row ? mapRunIntent(row) : null;
  }

  listRunIntentsByOperationGroup(designId: number, operationGroupId: string): DesignRunIntent[] {
    return this.db.query<DesignRunIntentRow, [number, string]>(
      `SELECT * FROM design_run_intents
       WHERE design_task_id = ? AND operation_group_id = ?
       ORDER BY created_ts, run_id`,
    ).all(designId, operationGroupId).map(mapRunIntent);
  }

  updateRunIntentState(
    designId: number,
    runId: string,
    from: DesignRunIntent['state'],
    to: DesignRunIntent['state'],
    updatedTs = Date.now(),
  ): boolean {
    return this.db.query(`UPDATE design_run_intents SET state = ?, updated_ts = ?
      WHERE design_task_id = ? AND run_id = ? AND state = ?`
    ).run(to, updatedTs, designId, runId, from).changes === 1;
  }

  ensureAgentRunGroup(input: {
    id: string;
    designTaskId: number;
    projectId: number;
    idempotencyKey: string;
    requestDigest: string;
    mode: DesignAgentRunMode;
    sourceRevision: number;
    message: string | null;
    personaKeys: readonly string[];
    createdByUserId: number;
    now: number;
  }): { group: DesignAgentRunGroup; created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.query<DesignAgentRunGroupRow, [number, string]>(
        'SELECT * FROM design_agent_run_groups WHERE project_id = ? AND idempotency_key = ?',
      ).get(input.projectId, input.idempotencyKey);
      if (existing) {
        if (existing.request_digest !== input.requestDigest) throw new Error('design run idempotency conflict');
        return { group: mapAgentRunGroup(existing), created: false };
      }
      const task = this.getTask(input.designTaskId);
      if (!task || task.projectId !== input.projectId || task.status !== 'active') {
        throw new Error('design run scope not found');
      }
      if (task.currentRevision !== input.sourceRevision) throw new DesignRevisionConflictError(task.currentRevision);
      const row = this.db.query<DesignAgentRunGroupRow, [
        string, number, number, string, string, string, number, string | null, string, number, number, number,
      ]>(
        `INSERT INTO design_agent_run_groups (
           id, design_task_id, project_id, idempotency_key, request_digest, mode,
           source_revision, message, persona_keys_json, status, created_by_user_id, created_ts, updated_ts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?) RETURNING *`,
      ).get(
        input.id,
        input.designTaskId,
        input.projectId,
        input.idempotencyKey,
        input.requestDigest,
        input.mode,
        input.sourceRevision,
        input.message,
        requiredJson(input.personaKeys),
        input.createdByUserId,
        input.now,
        input.now,
      );
      if (!row) throw new Error('create design run failed');
      this.appendEventUnchecked(input.designTaskId, 'input_appended', {
        requestKind: 'agent_run',
        runId: input.id,
        mode: input.mode,
        sourceRevision: input.sourceRevision,
        message: input.message,
        personaKeys: input.personaKeys,
        actorUserId: input.createdByUserId,
      });
      return { group: mapAgentRunGroup(row), created: true };
    })();
  }

  getAgentRunGroup(id: string): DesignAgentRunGroup | null {
    const row = this.db.query<DesignAgentRunGroupRow, [string]>(
      'SELECT * FROM design_agent_run_groups WHERE id = ?',
    ).get(id);
    return row ? mapAgentRunGroup(row) : null;
  }

  getAgentRunGroupByIdempotency(projectId: number, idempotencyKey: string): DesignAgentRunGroup | null {
    const row = this.db.query<DesignAgentRunGroupRow, [number, string]>(
      'SELECT * FROM design_agent_run_groups WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, idempotencyKey);
    return row ? mapAgentRunGroup(row) : null;
  }

  listRecoverableAgentRunGroups(limit = 25): DesignAgentRunGroup[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.query<DesignAgentRunGroupRow, [number]>(
      `SELECT * FROM design_agent_run_groups
       WHERE status IN ('queued', 'running', 'interrupted')
       ORDER BY updated_ts, id LIMIT ?`,
    ).all(bounded).map(mapAgentRunGroup);
  }

  listAgentRunGroups(designTaskId: number, limit = 20): DesignAgentRunGroup[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.query<DesignAgentRunGroupRow, [number, number]>(
      `SELECT * FROM design_agent_run_groups
       WHERE design_task_id = ?
       ORDER BY created_ts DESC, id DESC LIMIT ?`,
    ).all(designTaskId, bounded).map(mapAgentRunGroup);
  }

  claimAgentRunGroup(id: string, now: number): DesignAgentRunGroup | null {
    const row = this.db.query<DesignAgentRunGroupRow, [number, number, string]>(
      `UPDATE design_agent_run_groups
       SET status = 'running', started_ts = COALESCE(started_ts, ?), updated_ts = ?
       WHERE id = ? AND status IN ('queued', 'interrupted') AND cancel_requested = 0
       RETURNING *`,
    ).get(now, now, id);
    return row ? mapAgentRunGroup(row) : null;
  }

  interruptAgentRunGroup(id: string, now: number): boolean {
    return this.db.query(
      `UPDATE design_agent_run_groups SET status = 'interrupted', updated_ts = ?
       WHERE id = ? AND status = 'running'`,
    ).run(now, id).changes === 1;
  }

  completeAgentRunGroup(
    id: string,
    status: 'completed' | 'failed' | 'cancelled',
    failureCode: string | null,
    now: number,
  ): boolean {
    return this.db.query(
      `UPDATE design_agent_run_groups
       SET status = ?, failure_code = ?, finished_ts = ?, updated_ts = ?
       WHERE id = ? AND status = 'running'`,
    ).run(status, failureCode, now, now, id).changes === 1;
  }

  requestAgentRunCancellation(id: string, now: number): DesignAgentRunGroup | null {
    const row = this.db.query<DesignAgentRunGroupRow, [number, number, string]>(
      `UPDATE design_agent_run_groups
       SET cancel_requested = 1,
           status = CASE WHEN status IN ('queued', 'interrupted') THEN 'cancelled' ELSE status END,
           finished_ts = CASE WHEN status IN ('queued', 'interrupted') THEN ? ELSE finished_ts END,
           updated_ts = ?
       WHERE id = ? AND status IN ('queued', 'running', 'interrupted')
       RETURNING *`,
    ).get(now, now, id);
    return row ? mapAgentRunGroup(row) : this.getAgentRunGroup(id);
  }

  ensureCreationSaga(input: EnsureDesignCreationSagaInput): { saga: DesignCreationSaga; created: boolean } {
    const now = input.createdTs ?? Date.now();
    const inserted = this.db.query<DesignCreationSagaRow, [string, number, string, string, string, number, number]>(
      `INSERT INTO design_creation_sagas (
         saga_token, project_id, idempotency_key, request_json, conversation_id, phase,
         conversation_owned, created_ts, updated_ts
       ) VALUES (?, ?, ?, ?, ?, 'intent', 0, ?, ?)
       ON CONFLICT(project_id, idempotency_key) DO NOTHING
       RETURNING *`,
    ).get(
      input.sagaToken,
      input.projectId,
      input.idempotencyKey,
      input.requestJson,
      input.conversationId,
      now,
      now,
    );
    if (inserted) return { saga: mapCreationSaga(inserted), created: true };
    const existing = this.getCreationSaga(input.projectId, input.idempotencyKey);
    if (!existing) throw new Error('ensure design creation saga failed');
    return { saga: existing, created: false };
  }

  getCreationSaga(projectId: number, idempotencyKey: string): DesignCreationSaga | null {
    const row = this.db.query<DesignCreationSagaRow, [number, string]>(
      'SELECT * FROM design_creation_sagas WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, idempotencyKey);
    return row ? mapCreationSaga(row) : null;
  }

  getCreationSagaByToken(sagaToken: string): DesignCreationSaga | null {
    const row = this.db.query<DesignCreationSagaRow, [string]>(
      'SELECT * FROM design_creation_sagas WHERE saga_token = ?',
    ).get(sagaToken);
    return row ? mapCreationSaga(row) : null;
  }

  listIncompleteCreationSagas(): DesignCreationSaga[] {
    return this.db.query<DesignCreationSagaRow, []>(
      `SELECT * FROM design_creation_sagas
       WHERE phase <> 'completed' ORDER BY updated_ts, saga_token`,
    ).all().map(mapCreationSaga);
  }

  createCreationSagaTask(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
    input: CreateRevisionedDesignTaskRecord,
  ): DesignDocumentMutationResult | null {
    const create = this.db.transaction(() => {
      const saga = this.getCreationSagaByToken(sagaToken);
      if (!saga || saga.taskId !== null || saga.phase !== expectedPhase) return null;
      const created = this.createRevisionedTask({
        ...input,
        status: 'active',
        createdEventData: {
          ...(typeof input.createdEventData === 'object' && input.createdEventData !== null
            ? input.createdEventData as Record<string, unknown>
            : {}),
          creationSagaToken: saga.sagaToken,
          conversationId: saga.conversationId,
        },
      });
      const ts = Date.now();
      const sagaRow = this.db.query<DesignCreationSagaRow, [number, number, string, string]>(
        `UPDATE design_creation_sagas
         SET task_id = ?, phase = 'task_created', error = NULL, updated_ts = ?
         WHERE saga_token = ? AND task_id IS NULL AND phase = ? RETURNING *`,
      ).get(created.task.id, ts, sagaToken, expectedPhase);
      if (!sagaRow) throw new Error(`design creation saga task bind failed: ${sagaToken}`);
      return created;
    });
    return create();
  }

  markCreationConversationOwned(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
  ): DesignCreationSaga | null {
    const row = this.db.query<DesignCreationSagaRow, [number, string, string]>(
      `UPDATE design_creation_sagas
       SET phase = 'conversation_created', conversation_owned = 1, error = NULL, updated_ts = ?
       WHERE saga_token = ? AND phase = ? AND task_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM design_saga_conversation_owners owner
           WHERE owner.conversation_id = design_creation_sagas.conversation_id
             AND owner.saga_token = design_creation_sagas.saga_token
         )
       RETURNING *`,
    ).get(Date.now(), sagaToken, expectedPhase);
    return row ? mapCreationSaga(row) : null;
  }

  bindCreationConversation(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
  ): DesignTask | null {
    const bind = this.db.transaction(() => {
      const saga = this.getCreationSagaByToken(sagaToken);
      if (saga?.phase !== expectedPhase) return null;
      if (!saga || !saga.taskId || !saga.conversationOwned) {
        throw new Error(`design creation saga cannot bind conversation: ${sagaToken}`);
      }
      if (!this.isOwnedBootstrapTask(saga)) {
        throw new Error(`design creation task ownership conflict: ${sagaToken}`);
      }
      const taskRow = this.db.query<DesignTaskRow, [string, number, number, string]>(
        `UPDATE design_tasks SET conversation_id = ?, updated_ts = ?
         WHERE id = ? AND status = 'active' AND current_revision = 1
           AND (conversation_id IS NULL OR conversation_id = ?)
         RETURNING *`,
      ).get(saga.conversationId, Date.now(), saga.taskId, saga.conversationId);
      if (!taskRow) throw new Error(`design creation conversation bind conflict: ${sagaToken}`);
      const advanced = this.updateCreationSaga(sagaToken, expectedPhase, "phase = 'bound', error = NULL");
      if (!advanced) return null;
      return mapTask(taskRow);
    });
    return bind();
  }

  markCreationActivating(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
  ): DesignCreationSaga | null {
    return this.updateCreationSaga(sagaToken, expectedPhase, "phase = 'activating', error = NULL");
  }

  markCreationActivated(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
  ): DesignCreationSaga | null {
    return this.updateCreationSaga(sagaToken, expectedPhase, "phase = 'activated', error = NULL");
  }

  completeCreationSaga(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
  ): DesignTask | null {
    const complete = this.db.transaction(() => {
      const saga = this.getCreationSagaByToken(sagaToken);
      if (saga?.phase !== expectedPhase) return null;
      if (!saga.taskId || !saga.conversationOwned || expectedPhase !== 'activated') {
        throw new Error(`design creation saga cannot complete: ${sagaToken}`);
      }
      if (!this.isOwnedBootstrapTask(saga, true)) {
        throw new Error(`design creation task completion conflict: ${sagaToken}`);
      }
      const ts = Date.now();
      const taskRow = this.db.query<DesignTaskRow, [number, number, string]>(
        `UPDATE design_tasks SET last_error = NULL, updated_ts = ?
         WHERE id = ? AND status = 'active' AND stage = 'goal_setting'
           AND current_revision = 1 AND conversation_id = ? RETURNING *`,
      ).get(ts, saga.taskId, saga.conversationId);
      if (!taskRow) throw new Error(`design creation task activation conflict: ${sagaToken}`);
      const sagaRow = this.db.query<DesignCreationSagaRow, [number, string, string]>(
        `UPDATE design_creation_sagas SET phase = 'completed', error = NULL, updated_ts = ?
         WHERE saga_token = ? AND phase = ? RETURNING *`,
      ).get(ts, sagaToken, expectedPhase);
      if (!sagaRow) throw new Error(`design creation saga completion conflict: ${sagaToken}`);
      return mapTask(taskRow);
    });
    return complete();
  }

  markCreationSagaError(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
    error: string,
  ): DesignCreationSaga | null {
    const row = this.db.query<DesignCreationSagaRow, [string, number, string, string]>(
      `UPDATE design_creation_sagas
       SET phase = 'recoverable_error', error = ?, updated_ts = ?
       WHERE saga_token = ? AND phase = ? AND phase <> 'recoverable_error' RETURNING *`,
    ).get(error, Date.now(), sagaToken, expectedPhase);
    return row ? mapCreationSaga(row) : null;
  }

  deleteCreationSagaTask(sagaToken: string, expectedPhase: DesignCreationSagaPhase): boolean {
    const remove = this.db.transaction(() => {
      const saga = this.getCreationSagaByToken(sagaToken);
      if (!saga?.taskId || saga.phase !== expectedPhase || !this.isOwnedBootstrapTask(saga)) return false;
      const result = this.db.query(
        `DELETE FROM design_tasks
         WHERE id = ? AND status = 'active' AND stage = 'goal_setting' AND current_revision = 1
           AND (conversation_id IS NULL OR conversation_id = ?)`,
      ).run(saga.taskId, saga.conversationId);
      return result.changes > 0;
    });
    return remove();
  }

  ownsCreationSagaTask(sagaToken: string, requireBound = false): boolean {
    const saga = this.getCreationSagaByToken(sagaToken);
    return saga !== null && this.isOwnedBootstrapTask(saga, requireBound);
  }

  resetCreationSaga(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
    options: { conversationId?: string; error?: string | null } = {},
  ): DesignCreationSaga | null {
    const saga = this.getCreationSagaByToken(sagaToken);
    if (!saga || saga.phase !== expectedPhase) return null;
    if (saga.taskId !== null) throw new Error(`design creation saga cannot reset with a task: ${sagaToken}`);
    const conversationId = options.conversationId ?? saga.conversationId;
    const row = this.db.query<DesignCreationSagaRow, [string, string | null, number, string, string]>(
      `UPDATE design_creation_sagas
       SET conversation_id = ?, phase = 'intent', conversation_owned = 0, error = ?, updated_ts = ?
       WHERE saga_token = ? AND task_id IS NULL AND phase = ? RETURNING *`,
    ).get(conversationId, options.error ?? null, Date.now(), sagaToken, expectedPhase);
    return row ? mapCreationSaga(row) : null;
  }

  reconcileCreationSagaPhase(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
    targetPhase: 'intent' | 'task_created' | 'conversation_created' | 'bound',
  ): DesignCreationSaga | null {
    const saga = this.getCreationSagaByToken(sagaToken);
    if (!saga || saga.phase !== expectedPhase) return null;
    const targetAllowed = targetPhase === 'intent'
      ? saga.taskId === null && !saga.conversationOwned
      : targetPhase === 'task_created'
        ? saga.taskId !== null && !saga.conversationOwned
        : targetPhase === 'conversation_created'
          ? saga.taskId !== null && saga.conversationOwned
            && this.getTask(saga.taskId)?.conversationId === null
          : saga.taskId !== null && saga.conversationOwned
            && this.getTask(saga.taskId)?.conversationId === saga.conversationId;
    if (!targetAllowed) return null;
    return this.updateCreationSaga(sagaToken, expectedPhase, `phase = '${targetPhase}', error = NULL`);
  }

  private updateCreationSaga(
    sagaToken: string,
    expectedPhase: DesignCreationSagaPhase,
    assignment: string,
  ): DesignCreationSaga | null {
    const row = this.db.query<DesignCreationSagaRow, [number, string, string]>(
      `UPDATE design_creation_sagas SET ${assignment}, updated_ts = ?
       WHERE saga_token = ? AND phase = ? RETURNING *`,
    ).get(Date.now(), sagaToken, expectedPhase);
    return row ? mapCreationSaga(row) : null;
  }

  private isOwnedBootstrapTask(saga: DesignCreationSaga, requireBound = false): boolean {
    if (!saga.taskId) return false;
    const task = this.getTask(saga.taskId);
    if (
      !task
      || task.projectId !== saga.projectId
      || task.status !== 'active'
      || task.stage !== 'goal_setting'
      || task.currentRevision !== 1
      || (requireBound ? task.conversationId !== saga.conversationId
        : task.conversationId !== null && task.conversationId !== saga.conversationId)
    ) return false;
    const events = this.listEvents(task.id);
    if (events.length !== 1 || events[0]?.kind !== 'task_created') return false;
    const data = events[0].data;
    return typeof data === 'object' && data !== null
      && (data as Record<string, unknown>).creationSagaToken === saga.sagaToken
      && (data as Record<string, unknown>).conversationId === saga.conversationId;
  }

  createTask(input: CreateDesignTaskRecord): DesignTask {
    const now = Date.now();
    const row = this.db
      .query<DesignTaskRow, [
        number, number | null, string, string, string, string, string, number, number, string | null,
        string | null, string, string | null, string | null, string | null, string | null, number, number,
        string | null,
      ]>(
        `INSERT INTO design_tasks (
           project_id, module_id, title, original_request, agent, stage, status, readiness_threshold,
           readiness_override, document_json, document_markdown, graph_granularity, conversation_id,
           worktree_cwd, worktree_branch, worktree_metadata_json, created_ts, updated_ts, last_error
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.projectId,
        input.moduleId ?? null,
        input.title,
        input.originalRequest,
        input.agent === 'codex' ? 'codex' : 'claude',
        input.stage ?? 'goal_setting',
        input.status ?? 'active',
        input.readinessThreshold ?? 80,
        input.readinessOverride ? 1 : 0,
        json(input.documentJson),
        input.documentMarkdown ?? null,
        input.graphGranularity ?? 'balanced',
        input.conversationId ?? null,
        input.worktreeCwd ?? null,
        input.worktreeBranch ?? null,
        json(input.worktreeMetadata),
        input.createdTs ?? now,
        input.updatedTs ?? input.createdTs ?? now,
        input.lastError ?? null,
      );
    if (!row) throw new Error('create design task failed');
    return mapTask(row);
  }

  createRevisionedTask(input: CreateRevisionedDesignTaskRecord): DesignDocumentMutationResult {
    const create = this.db.transaction(() => {
      const task = this.createTask({
        ...input,
        stage: input.stage ?? 'goal_setting',
        status: input.status ?? 'active',
        documentJson: input.documentJson,
        documentMarkdown: input.documentMarkdown,
      });
      return this.commitDocumentMutation({
        action: 'create_design',
        designTaskId: task.id,
        expectedRevision: 0,
        documentJson: input.documentJson,
        documentMarkdown: input.documentMarkdown,
        readiness: input.readiness,
        graph: input.graph ?? { nodes: [], edges: [] },
        actor: input.actor,
        reason: input.reason,
        event: { kind: 'task_created', data: input.createdEventData ?? {} },
        createdTs: input.createdTs,
      });
    });
    return create();
  }

  bindConversation(id: number, conversationId: string): DesignTask {
    const row = this.db
      .query<DesignTaskRow, [string, number, number]>(
        `UPDATE design_tasks SET conversation_id = ?, updated_ts = ?
         WHERE id = ? AND conversation_id IS NULL AND status = 'active'
         RETURNING *`,
      )
      .get(conversationId, Date.now(), id);
    if (row) return mapTask(row);
    const current = this.getTask(id);
    if (!current) throw new Error(`design task not found: ${id}`);
    if (current.status === 'archived') throw new DesignTaskImmutableError(id);
    throw new Error(`design conversation already bound: ${id}`);
  }

  appendEventAtRevision(
    id: number,
    expectedRevision: number,
    kind: DesignEventKind,
    data: unknown,
    operation?: DesignAgentOperationInput,
  ): DesignEvent {
    const append = this.db.transaction(() => {
      if (operation) {
        const replay = this.replayAgentOperation(id, operation);
        if (replay) return replay.event;
      }
      const task = this.getTask(id);
      if (!task) throw new Error(`design task not found: ${id}`);
      if (task.status === 'archived' || task.stage === 'archived') throw new DesignTaskImmutableError(id);
      if (task.currentRevision !== expectedRevision) throw new DesignRevisionConflictError(task.currentRevision);
      const event = this.appendEventUnchecked(id, kind, data);
      if (operation) this.saveAgentOperation(id, operation, event.id, null, event.ts);
      return event;
    });
    return append();
  }

  archiveTask(id: number, actor: string): DesignTask {
    const archive = this.db.transaction(() => {
      const current = this.getTask(id);
      if (!current) throw new Error(`design task not found: ${id}`);
      if (current.status === 'archived' || current.stage === 'archived') return current;
      const ts = Date.now();
      const row = this.db
        .query<DesignTaskRow, [number, number]>(
          `UPDATE design_tasks
           SET stage = 'archived', status = 'archived', updated_ts = ?
           WHERE id = ? AND status <> 'archived' RETURNING *`,
        )
        .get(ts, id);
      if (!row) throw new DesignTaskImmutableError(id);
      const event = this.db
        .query<DesignEventRow, [number, string, string, number]>(
          `INSERT INTO design_events (design_task_id, kind, data_json, ts)
           VALUES (?, ?, ?, ?) RETURNING *`,
        )
        .get(id, 'task_archived', requiredJson({ actor, revision: current.currentRevision }), ts);
      if (!event) throw new Error('append design event failed');
      return mapTask(row);
    });
    return archive();
  }

  getTask(id: number): DesignTask | null {
    const row = this.db.query<DesignTaskRow, [number]>('SELECT * FROM design_tasks WHERE id = ?').get(id);
    return row ? mapTask(row) : null;
  }

  isTaskProvisional(id: number): boolean {
    return this.db.query<{ found: number }, [number]>(
      `SELECT 1 AS found FROM design_creation_sagas
       WHERE task_id = ? AND phase <> 'completed' LIMIT 1`,
    ).get(id)?.found === 1;
  }

  listTasks(projectId: number): DesignTask[] {
    return this.db
      .query<DesignTaskRow, [number]>(
        `SELECT * FROM design_tasks
         WHERE project_id = ? AND NOT EXISTS (
           SELECT 1 FROM design_creation_sagas s
           WHERE s.task_id = design_tasks.id AND s.phase <> 'completed'
         )
         ORDER BY updated_ts DESC, id DESC`,
      )
      .all(projectId)
      .map(mapTask);
  }

  updateTask(id: number, patch: DesignTaskPatch): DesignTask {
    const current = this.getTask(id);
    if (!current) throw new Error(`design task not found: ${id}`);
    if (current.status === 'archived' || current.stage === 'archived') throw new DesignTaskImmutableError(id);
    if (
      patch.moduleId !== undefined
      || patch.title !== undefined
      || patch.originalRequest !== undefined
      || patch.agent !== undefined
      || patch.stage !== undefined
      || patch.status !== undefined
      || patch.readinessThreshold !== undefined
      || patch.readinessOverride !== undefined
      || patch.documentJson !== undefined
      || patch.documentMarkdown !== undefined
      || patch.graphGranularity !== undefined
    ) {
      throw new Error('revision-bearing changes require commitDocumentMutation or an explicit lifecycle action');
    }
    return this.updateRuntimeMetadata(id, patch);
  }

  updateRuntimeMetadata(id: number, patch: DesignRuntimeMetadataPatch): DesignTask {
    const fields: string[] = ['updated_ts = ?'];
    const values: Array<string | number | null> = [Date.now()];
    const set = (column: string, value: string | number | null) => {
      fields.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.conversationId !== undefined) set('conversation_id', patch.conversationId);
    if (patch.worktreeCwd !== undefined) set('worktree_cwd', patch.worktreeCwd);
    if (patch.worktreeBranch !== undefined) set('worktree_branch', patch.worktreeBranch);
    if (patch.worktreeMetadata !== undefined) set('worktree_metadata_json', json(patch.worktreeMetadata));
    if (patch.lastError !== undefined) set('last_error', patch.lastError);

    const row = this.db
      .query<DesignTaskRow, Array<string | number | null>>(
        `UPDATE design_tasks SET ${fields.join(', ')}
         WHERE id = ? AND current_revision = ? AND status <> 'archived'
         RETURNING *`,
      )
      .get(...values, id, patch.expectedRevision);
    if (row) return mapTask(row);
    const current = this.getTask(id);
    if (!current) throw new Error(`design task not found: ${id}`);
    if (current.status === 'archived' || current.stage === 'archived') throw new DesignTaskImmutableError(id);
    throw new DesignRevisionConflictError(current.currentRevision);
  }

  transitionStage(input: DesignStageTransitionInput): DesignTask {
    const transitions = {
      confirm_goal: { from: 'goal_setting', to: 'solution_draft', eventKind: 'goal_confirmed' },
      approve_graph: { from: 'graph_draft', to: 'approved', eventKind: 'graph_approved' },
      start_execution: { from: 'approved', to: 'executing', eventKind: 'execution_started' },
      complete_execution: { from: 'executing', to: 'completed', eventKind: 'execution_completed' },
    } as const;
    const rule = transitions[input.action];
    if (!rule) throw new Error(`unknown closed lifecycle action: ${String(input.action)}`);
    const transition = this.db.transaction(() => {
      const current = this.getTask(input.designTaskId);
      if (!current) throw new Error(`design task not found: ${input.designTaskId}`);
      if (current.status === 'archived' || current.stage === 'archived') {
        throw new DesignTaskImmutableError(input.designTaskId);
      }
      if (current.currentRevision !== input.expectedRevision) {
        throw new DesignRevisionConflictError(current.currentRevision);
      }
      if (current.status !== 'active' || current.stage !== rule.from) {
        throw new DesignStageConflictError(current.stage, current.currentRevision);
      }
      const ts = input.createdTs ?? Date.now();
      const readinessOverride = input.action === 'approve_graph'
        ? input.readinessOverride === true
        : current.readinessOverride;
      const row = this.db
        .query<DesignTaskRow, [string, number, number, number, number, string]>(
          `UPDATE design_tasks
           SET stage = ?, readiness_override = ?, updated_ts = ?
           WHERE id = ? AND current_revision = ? AND stage = ? AND status = 'active'
           RETURNING *`,
        )
        .get(rule.to, readinessOverride ? 1 : 0, ts, input.designTaskId, input.expectedRevision, rule.from);
      if (!row) {
        const latest = this.getTask(input.designTaskId);
        if (!latest) throw new Error(`design task not found: ${input.designTaskId}`);
        if (latest.status === 'archived' || latest.stage === 'archived') {
          throw new DesignTaskImmutableError(input.designTaskId);
        }
        if (latest.currentRevision !== input.expectedRevision) {
          throw new DesignRevisionConflictError(latest.currentRevision);
        }
        throw new DesignStageConflictError(latest.stage, latest.currentRevision);
      }
      const data = {
        ...(typeof input.eventData === 'object' && input.eventData !== null
          ? input.eventData as Record<string, unknown>
          : { value: input.eventData ?? null }),
        actor: input.actor,
        from: rule.from,
        to: rule.to,
        revision: input.expectedRevision,
      };
      const eventRow = this.db
        .query<DesignEventRow, [number, string, string, number]>(
          `INSERT INTO design_events (design_task_id, kind, data_json, ts)
           VALUES (?, ?, ?, ?) RETURNING *`,
        )
        .get(input.designTaskId, rule.eventKind, requiredJson(data), ts);
      if (!eventRow) throw new Error('append design event failed');
      return mapTask(row);
    });
    return transition();
  }

  /**
   * The sole persistence boundary for replacing the live design document.
   * CAS, task state, immutable snapshot, readiness, graph dirtiness, and audit
   * event commit or roll back as one SQLite transaction.
  */
  commitDocumentMutation(input: DesignDocumentMutationInput): DesignDocumentMutationResult {
    const commit = this.db.transaction(() => {
      if (input.operation) {
        const replay = this.replayAgentOperation(input.designTaskId, input.operation);
        if (replay) {
          if (!replay.revision) throw new Error('steward operation is missing its revision');
          const task = this.getTask(input.designTaskId);
          if (!task) throw new Error(`design task not found: ${input.designTaskId}`);
          return { task, revision: replay.revision, event: replay.event, graph: replay.revision.graph };
        }
      }
      const current = this.getTask(input.designTaskId);
      if (!current) throw new Error(`design task not found: ${input.designTaskId}`);
      if (current.status === 'archived' || current.stage === 'archived') {
        throw new DesignTaskImmutableError(input.designTaskId);
      }
      if (current.currentRevision !== input.expectedRevision) {
        throw new DesignRevisionConflictError(current.currentRevision);
      }
      const unsafePatch = input.taskPatch as (DesignDocumentMutationInput['taskPatch'] & {
        stage?: DesignTaskStage;
        status?: DesignTaskStatus;
      }) | undefined;
      if (unsafePatch?.stage !== undefined || unsafePatch?.status !== undefined) {
        throw new Error('stage and status changes require a closed document action or lifecycle action');
      }

      let nextStage = current.stage;
      let requiredEventKind: DesignEventKind;
      switch (input.action) {
        case 'create_design':
          requiredEventKind = 'task_created';
          if (current.stage !== 'goal_setting' || current.status !== 'active' || current.currentRevision !== 0) {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          break;
        case 'revise_document':
          requiredEventKind = 'document_revised';
          if (
            (current.stage !== 'solution_draft' && current.stage !== 'review')
            || current.status !== 'active'
          ) {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          break;
        case 'refine_goal':
          requiredEventKind = 'document_revised';
          if (current.stage !== 'goal_setting' || current.status !== 'active') {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          break;
        case 'submit_review':
          requiredEventKind = 'document_revised';
          if (current.stage !== 'solution_draft' || current.status !== 'active') {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          nextStage = 'review';
          break;
        case 'replace_graph':
          requiredEventKind = 'graph_replaced';
          if (
            (current.stage !== 'review' && current.stage !== 'graph_draft')
            || current.status !== 'active'
          ) {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          nextStage = 'graph_draft';
          break;
        case 'set_granularity':
          requiredEventKind = 'document_revised';
          if (current.status !== 'active'
            || current.stage === 'completed'
            || current.stage === 'executing'
            || current.stage === 'error') {
            throw new DesignStageConflictError(current.stage, current.currentRevision);
          }
          if (current.stage === 'approved') nextStage = 'graph_draft';
          break;
        default:
          throw new Error(`unknown closed document action: ${String(input.action)}`);
      }
      if (input.event.kind !== requiredEventKind) {
        throw new Error(`closed document action ${input.action} requires event ${requiredEventKind}`);
      }

      const revisionNumber = input.expectedRevision + 1;
      const ts = input.createdTs ?? Date.now();
      const graphDraft = input.graph ?? this.getGraph(input.designTaskId);
      const validation = validateDesignGraph(graphDraft);
      if (!validation.valid) {
        throw new Error(`invalid design graph: ${validation.errors.map((error) => error.code).join(', ')}`);
      }
      const graph = normalizeGraph(graphDraft);
      const dirtyGraph: DesignGraph = {
        nodes: graph.nodes.map((node) => ({ ...node, lastSyncedRevision: null })),
        edges: graph.edges.map((edge) => ({ ...edge })),
      };
      const patch = input.taskPatch ?? {};
      const fields = [
        'current_revision = ?',
        'document_json = ?',
        'document_markdown = ?',
        'updated_ts = ?',
      ];
      const values: Array<string | number | null> = [
        revisionNumber,
        requiredJson(input.documentJson),
        input.documentMarkdown,
        ts,
      ];
      const set = (column: string, value: string | number | null) => {
        fields.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.title !== undefined) set('title', patch.title);
      if (patch.originalRequest !== undefined) set('original_request', patch.originalRequest);
      if (nextStage !== current.stage) set('stage', nextStage);
      if (patch.readinessThreshold !== undefined) set('readiness_threshold', patch.readinessThreshold);
      if (patch.readinessOverride !== undefined) set('readiness_override', patch.readinessOverride ? 1 : 0);
      if (patch.graphGranularity !== undefined) set('graph_granularity', patch.graphGranularity);
      if (patch.lastError !== undefined) set('last_error', patch.lastError);

      const taskRow = this.db
        .query<DesignTaskRow, Array<string | number | null>>(
          `UPDATE design_tasks SET ${fields.join(', ')}
           WHERE id = ? AND current_revision = ? AND status <> 'archived'
           RETURNING *`,
        )
        .get(...values, input.designTaskId, input.expectedRevision);
      if (!taskRow) {
        const latest = this.getTask(input.designTaskId);
        if (!latest) throw new Error(`design task not found: ${input.designTaskId}`);
        if (latest.status === 'archived' || latest.stage === 'archived') {
          throw new DesignTaskImmutableError(input.designTaskId);
        }
        throw new DesignRevisionConflictError(latest.currentRevision);
      }

      this.replaceGraphRows(input.designTaskId, dirtyGraph, ts);
      const revisionRow = this.db
        .query<DesignRevisionRow, [number, number, string, string, number, string, string, string | null, number]>(
          `INSERT INTO design_revisions (
             design_task_id, revision, document_json, document_markdown, readiness, graph_json,
             actor, reason, created_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          input.designTaskId,
          revisionNumber,
          requiredJson(input.documentJson),
          input.documentMarkdown,
          input.readiness,
          requiredJson(dirtyGraph),
          input.actor,
          input.reason ?? null,
          ts,
        );
      if (!revisionRow) throw new Error('save design revision failed');
      // Legacy crash-window recovery may construct this store before additive migrations run.
      // Once 056 exists, enqueue remains in the same document transaction.
      const hasSyncJobs = Boolean(this.db.query<{ found: number }, []>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'design_issue_sync_jobs'",
      ).get());
      if (hasSyncJobs) {
        this.db.query(
          `UPDATE design_issue_sync_jobs
           SET state = 'stale', claim_token = NULL, claimed_ts = NULL, updated_ts = ?
           WHERE design_task_id = ? AND target_revision < ? AND state IN ('pending', 'retry')`,
        ).run(ts, input.designTaskId, revisionNumber);
        this.db.query(
          `INSERT INTO design_issue_sync_jobs (
             link_id, design_task_id, target_revision, state, attempt_count,
             next_retry_ts, created_ts, updated_ts
           )
           SELECT id, design_task_id, ?, 'pending', 0, ?, ?, ?
           FROM design_issue_links
           WHERE design_task_id = ? AND link_kind = 'primary'
           ON CONFLICT(link_id, target_revision) DO NOTHING`,
        ).run(revisionNumber, ts, ts, ts, input.designTaskId);
      }
      const eventData = {
        ...(typeof input.event.data === 'object' && input.event.data !== null
          ? input.event.data as Record<string, unknown>
          : { value: input.event.data }),
        revision: revisionNumber,
        readiness: input.readiness,
        graphSyncDirty: true,
        linkedIssueSyncDirty: true,
      };
      const eventRow = this.db
        .query<DesignEventRow, [number, string, string, number]>(
          `INSERT INTO design_events (design_task_id, kind, data_json, ts)
           VALUES (?, ?, ?, ?) RETURNING *`,
        )
        .get(input.designTaskId, input.event.kind, requiredJson(eventData), ts);
      if (!eventRow) throw new Error('append design event failed');

      if (input.operation) {
        this.saveAgentOperation(input.designTaskId, input.operation, eventRow.id, revisionRow.id, ts);
      }

      return {
        task: mapTask(taskRow),
        revision: mapRevision(revisionRow),
        event: mapEvent(eventRow),
        graph: dirtyGraph,
      };
    });
    return commit();
  }

  replayAgentOperation(
    designTaskId: number,
    operation: DesignAgentOperationInput,
  ): { event: DesignEvent; revision: DesignRevision | null } | null {
    const row = this.db.query<DesignAgentOperationRow, [number, string]>(
      `SELECT * FROM design_agent_operations
       WHERE design_task_id = ? AND operation_id = ?`,
    ).get(designTaskId, operation.operationId);
    if (!row) return null;
    if (row.operation_kind !== operation.operationKind || row.request_json !== operation.requestJson) {
      throw new DesignOperationConflictError(operation.operationId);
    }
    const eventRow = this.db.query<DesignEventRow, [number, number]>(
      'SELECT * FROM design_events WHERE design_task_id = ? AND id = ?',
    ).get(designTaskId, row.event_id);
    if (!eventRow) throw new Error(`design operation event not found: ${operation.operationId}`);
    const revisionRow = row.revision_id === null
      ? null
      : this.db.query<DesignRevisionRow, [number, number]>(
        'SELECT * FROM design_revisions WHERE design_task_id = ? AND id = ?',
      ).get(designTaskId, row.revision_id) ?? null;
    if (row.revision_id !== null && !revisionRow) {
      throw new Error(`design operation revision not found: ${operation.operationId}`);
    }
    return {
      event: mapEvent(eventRow),
      revision: revisionRow ? mapRevision(revisionRow) : null,
    };
  }


  private saveAgentOperation(
    designTaskId: number,
    operation: DesignAgentOperationInput,
    eventId: number,
    revisionId: number | null,
    createdTs: number,
  ): void {
    this.db.query(
      `INSERT INTO design_agent_operations (
         design_task_id, operation_id, operation_kind, request_json, event_id, revision_id, created_ts
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      designTaskId,
      operation.operationId,
      operation.operationKind,
      operation.requestJson,
      eventId,
      revisionId,
      createdTs,
    );
  }

  createPublishConfirmation(input: {
    tokenHash: string;
    designTaskId: number;
    revision: number;
    graphDigest: string;
    actorKey: string;
    expiresTs: number;
    createdTs: number;
  }): DesignPublishConfirmationRecord {
    const row = this.db.query<DesignPublishConfirmationRow, [string, number, number, string, string, number, number]>(
      `INSERT INTO design_publish_confirmations
         (token_hash, design_task_id, revision, graph_digest, actor_key, expires_ts, created_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
    ).get(
      input.tokenHash,
      input.designTaskId,
      input.revision,
      input.graphDigest,
      input.actorKey,
      input.expiresTs,
      input.createdTs,
    );
    if (!row) throw new Error('create design publish confirmation failed');
    return mapConfirmation(row);
  }

  getPublishConfirmation(tokenHash: string): DesignPublishConfirmationRecord | null {
    const row = this.db.query<DesignPublishConfirmationRow, [string]>(
      'SELECT * FROM design_publish_confirmations WHERE token_hash = ?',
    ).get(tokenHash);
    return row ? mapConfirmation(row) : null;
  }

  getPublication(id: number): DesignPublication | null {
    const row = this.db.query<DesignPublicationRow, [number]>(
      'SELECT * FROM design_publications WHERE id = ?',
    ).get(id);
    return row ? mapPublication(row) : null;
  }

  getPublicationByIdempotency(projectId: number, idempotencyKey: string): DesignPublication | null {
    const row = this.db.query<DesignPublicationRow, [number, string]>(
      'SELECT * FROM design_publications WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, idempotencyKey);
    return row ? mapPublication(row) : null;
  }

  getPublicationByRevision(designTaskId: number, revision: number, graphDigest: string): DesignPublication | null {
    const row = this.db.query<DesignPublicationRow, [number, number, string]>(
      `SELECT * FROM design_publications
       WHERE design_task_id = ? AND revision = ? AND graph_digest = ?`,
    ).get(designTaskId, revision, graphDigest);
    return row ? mapPublication(row) : null;
  }

  listPublications(designTaskId: number): DesignPublication[] {
    return this.db.query<DesignPublicationRow, [number]>(
      `SELECT * FROM design_publications
       WHERE design_task_id = ?
       ORDER BY created_ts DESC, id DESC`,
    ).all(designTaskId).map(mapPublication);
  }

  listPublicationLinks(publicationId: number): DesignIssueLink[] {
    return this.db.query<DesignIssueLinkRow, [number]>(
      'SELECT * FROM design_issue_links WHERE publication_id = ? ORDER BY id',
    ).all(publicationId).map(mapIssueLink);
  }

  listPrimaryIssueLinks(designTaskId: number): DesignIssueLink[] {
    return this.db.query<DesignIssueLinkRow, [number]>(
      `SELECT * FROM design_issue_links
       WHERE design_task_id = ? AND link_kind = 'primary'
       ORDER BY node_id, id`,
    ).all(designTaskId).map(mapIssueLink);
  }

  getIssueLink(linkId: number): DesignIssueLink | null {
    const row = this.db.query<DesignIssueLinkRow, [number]>(
      'SELECT * FROM design_issue_links WHERE id = ?',
    ).get(linkId);
    return row ? mapIssueLink(row) : null;
  }

  getPrimaryIssueLink(designTaskId: number, nodeId: string): DesignIssueLink | null {
    const row = this.db.query<DesignIssueLinkRow, [number, string]>(
      `SELECT * FROM design_issue_links
       WHERE design_task_id = ? AND node_id = ? AND link_kind = 'primary'
       ORDER BY source_revision DESC, id DESC LIMIT 1`,
    ).get(designTaskId, nodeId);
    return row ? mapIssueLink(row) : null;
  }

  listIssueSyncJobs(designTaskId?: number): DesignIssueSyncJob[] {
    const rows = designTaskId === undefined
      ? this.db.query<DesignIssueSyncJobRow, []>(
        'SELECT * FROM design_issue_sync_jobs ORDER BY target_revision, id',
      ).all()
      : this.db.query<DesignIssueSyncJobRow, [number]>(
        `SELECT * FROM design_issue_sync_jobs
         WHERE design_task_id = ? ORDER BY target_revision, id`,
      ).all(designTaskId);
    return rows.map(mapIssueSyncJob);
  }

  claimNextIssueSyncJob(now: number, abandonedBefore: number): DesignIssueSyncJob | null {
    const claim = this.db.transaction(() => {
      const candidate = this.db.query<DesignIssueSyncJobRow, [number, number]>(
        `SELECT * FROM design_issue_sync_jobs
         WHERE ((state IN ('pending', 'retry') AND next_retry_ts <= ?)
                OR (state = 'running' AND claimed_ts <= ?))
         ORDER BY target_revision, id LIMIT 1`,
      ).get(now, abandonedBefore);
      if (!candidate) return null;
      const token = randomUUID();
      const row = this.db.query<
        DesignIssueSyncJobRow,
        [string, number, number, number, string, string | null]
      >(
        `UPDATE design_issue_sync_jobs
         SET state = 'running', attempt_count = attempt_count + 1,
             claim_token = ?, claimed_ts = ?, updated_ts = ?
         WHERE id = ? AND state = ? AND claim_token IS ?
         RETURNING *`,
      ).get(token, now, now, candidate.id, candidate.state, candidate.claim_token);
      return row ? mapIssueSyncJob(row) : null;
    });
    return claim();
  }

  completeIssueSyncJob(jobId: number, claimToken: string, now: number): boolean {
    return this.db.query(
      `UPDATE design_issue_sync_jobs
       SET state = 'complete', completed_ts = ?, claim_token = NULL, claimed_ts = NULL,
           last_error = NULL, updated_ts = ?
       WHERE id = ? AND state = 'running' AND claim_token = ?`,
    ).run(now, now, jobId, claimToken).changes === 1;
  }

  staleIssueSyncJob(jobId: number, claimToken: string, now: number): boolean {
    return this.db.query(
      `UPDATE design_issue_sync_jobs
       SET state = 'stale', claim_token = NULL, claimed_ts = NULL, updated_ts = ?
       WHERE id = ? AND state = 'running' AND claim_token = ?`,
    ).run(now, jobId, claimToken).changes === 1;
  }

  retryIssueSyncJob(
    jobId: number,
    claimToken: string,
    error: string,
    nextRetryTs: number,
    now: number,
  ): boolean {
    return this.db.query(
      `UPDATE design_issue_sync_jobs
       SET state = 'retry', next_retry_ts = ?, claim_token = NULL, claimed_ts = NULL,
           last_error = ?, updated_ts = ?
       WHERE id = ? AND state = 'running' AND claim_token = ?`,
    ).run(nextRetryTs, error.slice(0, 4000), now, jobId, claimToken).changes === 1;
  }

  commitIssueSyncRequest<Result>(
    input: MarkDesignIssueSyncInput,
    request: () => Result,
  ): Result {
    const commit = this.db.transaction(() => {
      const link = this.getIssueLink(input.linkId);
      if (!link || link.lastSyncedRevision !== input.expectedLastSyncedRevision) {
        throw new Error('design sync baseline changed');
      }
      const result = request();
      if (isThenable(result)) throw new Error('design sync request callback must be synchronous');
      const updated = this.db.query(
        `UPDATE design_issue_links
         SET sync_state = ?, sync_error = NULL, next_retry_ts = NULL, updated_ts = ?
         WHERE id = ? AND last_synced_revision = ?`,
      ).run(input.state, input.now, input.linkId, input.expectedLastSyncedRevision);
      if (updated.changes !== 1) throw new Error('design sync baseline raced');
      this.appendEventUnchecked(link.designTaskId, 'issue_sync_requested', input.eventData);
      return result;
    });
    return commit();
  }

  completeIssueSyncInTransaction(input: CompleteDesignIssueSyncInput): DesignIssueLink {
    if (!this.db.inTransaction) throw new Error('design sync completion requires shared active transaction');
    const link = this.getIssueLink(input.linkId);
    if (!link || link.lastSyncedRevision !== input.expectedLastSyncedRevision) {
      throw new Error('design sync baseline changed');
    }
    const revision = this.getRevision(link.designTaskId, input.targetRevision);
    if (!revision) throw new Error('design sync revision disappeared');
    const updated = this.db.query(
      `UPDATE design_issue_links
       SET last_synced_revision = ?, baseline_contract_json = ?, baseline_contract_digest = ?,
           sync_state = ?, sync_error = NULL, next_retry_ts = NULL, updated_ts = ?
       WHERE id = ? AND last_synced_revision = ?`,
    ).run(
      input.targetRevision,
      requiredJson(input.baselineContract),
      input.baselineContractDigest,
      input.state,
      input.now,
      input.linkId,
      input.expectedLastSyncedRevision,
    );
    if (updated.changes !== 1) throw new Error('design sync baseline raced');
    this.db.query(
      `UPDATE design_graph_nodes SET last_synced_revision = ?, updated_ts = ?
       WHERE design_task_id = ? AND node_id = ?`,
    ).run(input.targetRevision, input.now, link.designTaskId, link.nodeId);
    this.appendEventUnchecked(link.designTaskId, input.eventKind, input.eventData);
    return this.getIssueLink(input.linkId)!;
  }

  markIssueLinkState(
    linkId: number,
    expectedLastSyncedRevision: number,
    state: DesignIssueSyncState,
    eventData: unknown,
    now: number,
  ): DesignIssueLink {
    const commit = this.db.transaction(() => {
      const link = this.getIssueLink(linkId);
      if (!link || link.lastSyncedRevision !== expectedLastSyncedRevision) {
        throw new Error('design sync baseline changed');
      }
      const changed = this.db.query(
        `UPDATE design_issue_links SET sync_state = ?, sync_error = NULL, updated_ts = ?
         WHERE id = ? AND last_synced_revision = ?`,
      ).run(state, now, linkId, expectedLastSyncedRevision);
      if (changed.changes !== 1) throw new Error('design sync baseline raced');
      this.appendEventUnchecked(link.designTaskId, 'issue_sync_requested', eventData);
      return this.getIssueLink(linkId)!;
    });
    return commit();
  }

  createSupplementLinkInTransaction(input: CreateDesignSupplementLinkInput): DesignIssueLink {
    if (!this.db.inTransaction) throw new Error('design supplement link requires shared active transaction');
    const parent = this.getIssueLink(input.parentLinkId);
    if (!parent) throw new Error('design supplement parent link disappeared');
    if (!this.getRevision(parent.designTaskId, input.targetRevision)) {
      throw new Error('design supplement revision disappeared');
    }
    const issue = this.db.query<{ project_id: number }, [number]>(
      'SELECT project_id FROM issues WHERE id = ?',
    ).get(input.issueId);
    if (!issue || issue.project_id !== parent.projectId) throw new Error('design supplement Issue scope mismatch');
    const row = this.db.query<DesignIssueLinkRow, [
      number, number, number, string, number, number, number, string, string, string,
      number, number, number, number, number, number,
    ]>(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, link_kind,
          source_revision, last_synced_revision, original_impl_mode,
          baseline_contract_json, baseline_contract_digest, sync_state,
          parent_issue_id, parent_issue_project_id, parent_link_id, parent_design_task_id,
          created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, 'supplement', ?, ?, ?, ?, ?, 'current', ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    ).get(
      parent.publicationId,
      parent.designTaskId,
      parent.projectId,
      parent.nodeId,
      input.issueId,
      input.targetRevision,
      input.targetRevision,
      input.baselineContract.implMode,
      requiredJson(input.baselineContract),
      input.baselineContractDigest,
      parent.issueId,
      parent.projectId,
      parent.id,
      parent.designTaskId,
      input.now,
      input.now,
    );
    if (!row) throw new Error('create design supplement link failed');
    const issueIds = [input.issueId];
    if (input.baselineContract.moduleId !== null) {
      const key = `issue-publication:${parent.projectId}:module-doc:${input.issueId}`;
      this.db.query(
        `INSERT INTO design_publication_outbox
           (publication_id, kind, target_key, payload_json, next_retry_ts, created_ts, updated_ts)
         VALUES (?, 'module_index', ?, ?, ?, ?, ?)
         ON CONFLICT(publication_id, kind, target_key) DO NOTHING`,
      ).run(parent.publicationId, key, requiredJson({
        projectId: parent.projectId,
        issueId: input.issueId,
        issueIds,
        moduleId: input.baselineContract.moduleId,
        agent: input.baselineContract.agent,
      }), input.now, input.now, input.now);
    }
    const schedulerKey = `issue-publication:${parent.projectId}:scheduler:${input.issueId}`;
    this.db.query(
      `INSERT INTO design_publication_outbox
         (publication_id, kind, target_key, payload_json, next_retry_ts, created_ts, updated_ts)
       VALUES (?, 'scheduler', ?, ?, ?, ?, ?)
       ON CONFLICT(publication_id, kind, target_key) DO NOTHING`,
    ).run(parent.publicationId, schedulerKey, requiredJson({
      projectId: parent.projectId, issueId: null, issueIds,
    }), input.now, input.now, input.now);
    this.db.query(
      `UPDATE design_publications SET status = 'post_commit_pending', error = NULL, updated_ts = ? WHERE id = ?`,
    ).run(input.now, parent.publicationId);
    this.appendEventUnchecked(parent.designTaskId, 'issue_supplement_created', {
      nodeId: parent.nodeId,
      parentIssueId: parent.issueId,
      supplementIssueId: input.issueId,
      targetRevision: input.targetRevision,
    });
    return mapIssueLink(row);
  }

  listPublicationOutbox(publicationId: number): DesignPublicationOutboxItem[] {
    return this.db.query<DesignPublicationOutboxRow, [number]>(
      'SELECT * FROM design_publication_outbox WHERE publication_id = ? ORDER BY id',
    ).all(publicationId).map(mapPublicationOutbox);
  }

  getPublicationOutboxByTarget(publicationId: number, targetKey: string): DesignPublicationOutboxItem | null {
    const row = this.db.query<DesignPublicationOutboxRow, [number, string]>(
      `SELECT * FROM design_publication_outbox
       WHERE publication_id = ? AND target_key = ?`,
    ).get(publicationId, targetKey);
    return row ? mapPublicationOutbox(row) : null;
  }

  listRecoverablePublications(now: number, limit = 100): DesignPublication[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<DesignPublicationRow, [number, number]>(
      `SELECT DISTINCT publication.*
         FROM design_publications publication
         JOIN design_publication_outbox outbox ON outbox.publication_id = publication.id
        WHERE publication.status <> 'complete'
          AND outbox.completed_ts IS NULL
          AND outbox.next_retry_ts <= ?
        ORDER BY publication.updated_ts, publication.id
        LIMIT ?`,
    ).all(now, bounded).map(mapPublication);
  }

  /** Must be called only by the synchronous Issue batch linkage callback on the shared DB. */
  commitPublicationInTransaction(input: CommitDesignPublicationInput): DesignPublication {
    if (!this.db.inTransaction) {
      throw new Error('design publication linkage requires the shared active transaction');
    }
    const task = this.db.query<{
      project_id: number;
      current_revision: number;
      stage: string;
      status: string;
      readiness_threshold: number;
      readiness_override: number;
      owner_user_id: number;
    }, [number]>(
      `SELECT design.project_id, design.current_revision, design.stage, design.status,
              design.readiness_threshold, design.readiness_override, project.owner_user_id
         FROM design_tasks design
         JOIN projects project ON project.id = design.project_id
        WHERE design.id = ?`,
    ).get(input.designTaskId);
    if (!task
      || task.project_id !== input.projectId
      || task.current_revision !== input.revision
      || task.stage !== 'approved'
      || task.status !== 'active'
      || task.owner_user_id !== input.actorUserId) {
      throw new Error('approved design publication state changed before commit');
    }
    const revisionRow = this.db.query<DesignRevisionRow, [number, number]>(
      `SELECT * FROM design_revisions WHERE design_task_id = ? AND revision = ?`,
    ).get(input.designTaskId, input.revision);
    if (!revisionRow) throw new Error('approved design publication revision disappeared before commit');
    const revision = mapRevision(revisionRow);
    const validation = validateDesignGraph(revision.graph);
    if (!validation.valid
      || designGraphDigest(input.designTaskId, input.revision, revision.graph) !== input.graphDigest) {
      throw new Error('approved design publication graph changed before commit');
    }
    if (revision.readiness < task.readiness_threshold && task.readiness_override !== 1) {
      throw new Error('approved design publication readiness changed before commit');
    }
    const existingKey = this.getPublicationByIdempotency(input.projectId, input.idempotencyKey);
    if (existingKey) throw new Error('design publication idempotency raced');
    const publicationRow = this.db.query<DesignPublicationRow, [number, number, number, string, string, string, number, number]>(
      `INSERT INTO design_publications
         (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
          status, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, 'post_commit_pending', ?, ?) RETURNING *`,
    ).get(
      input.designTaskId,
      input.projectId,
      input.revision,
      input.graphDigest,
      input.actorKey,
      input.idempotencyKey,
      input.now,
      input.now,
    );
    if (!publicationRow) throw new Error('create design publication failed');
    const consumed = this.db.query(
      `UPDATE design_publish_confirmations
          SET consumed_publication_id = ?, consumed_ts = ?
        WHERE token_hash = ?
          AND design_task_id = ?
          AND revision = ?
          AND graph_digest = ?
          AND actor_key = ?
          AND expires_ts > ?
          AND consumed_publication_id IS NULL`,
    ).run(
      publicationRow.id,
      input.now,
      input.tokenHash,
      input.designTaskId,
      input.revision,
      input.graphDigest,
      input.actorKey,
      input.now,
    );
    if (consumed.changes !== 1) throw new Error('design publish confirmation changed before commit');

    const issueIds = input.links.map((link) => link.issueId).sort((left, right) => left - right);
    for (const link of input.links) {
      this.db.query(
        `INSERT INTO design_issue_links
           (publication_id, design_task_id, project_id, node_id, issue_id, link_kind,
            source_revision, last_synced_revision, original_impl_mode,
            baseline_contract_json, baseline_contract_digest, sync_state, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, 'primary', ?, ?, ?, ?, ?, 'current', ?, ?)`,
      ).run(
        publicationRow.id,
        input.designTaskId,
        input.projectId,
        link.nodeId,
        link.issueId,
        input.revision,
        input.revision,
        link.implMode,
        requiredJson(link.baselineContract),
        link.baselineContractDigest,
        input.now,
        input.now,
      );
      const graphRow = this.db.query(
        `UPDATE design_graph_nodes
            SET issue_id = ?, last_synced_revision = ?, updated_ts = ?
          WHERE design_task_id = ? AND node_id = ?`,
      ).run(link.issueId, input.revision, input.now, input.designTaskId, link.nodeId);
      if (graphRow.changes !== 1) throw new Error(`published graph node disappeared: ${link.nodeId}`);

      if (link.baselineContract.moduleId !== null) {
        const targetKey = `issue-publication:${input.projectId}:module-doc:${link.issueId}`;
        this.db.query(
          `INSERT INTO design_publication_outbox
             (publication_id, kind, target_key, payload_json, next_retry_ts, created_ts, updated_ts)
           VALUES (?, 'module_index', ?, ?, ?, ?, ?)`,
        ).run(
          publicationRow.id,
          targetKey,
          requiredJson({
            projectId: input.projectId,
            issueId: link.issueId,
            issueIds,
            moduleId: link.baselineContract.moduleId,
            agent: link.baselineContract.agent,
          }),
          input.now,
          input.now,
          input.now,
        );
      }
    }

    const schedulerKey = `issue-publication:${input.projectId}:scheduler:${issueIds.join(',')}`;
    this.db.query(
      `INSERT INTO design_publication_outbox
         (publication_id, kind, target_key, payload_json, next_retry_ts, created_ts, updated_ts)
       VALUES (?, 'scheduler', ?, ?, ?, ?, ?)`,
    ).run(
      publicationRow.id,
      schedulerKey,
      requiredJson({ projectId: input.projectId, issueId: null, issueIds }),
      input.now,
      input.now,
      input.now,
    );
    this.appendEventUnchecked(input.designTaskId, 'graph_published', {
      publicationId: publicationRow.id,
      revision: input.revision,
      graphDigest: input.graphDigest,
      issueCount: input.links.length,
    });
    return mapPublication(publicationRow);
  }

  markPublicationOutboxComplete(publicationId: number, targetKey: string, now: number): boolean {
    const result = this.db.query(
      `UPDATE design_publication_outbox
          SET completed_ts = COALESCE(completed_ts, ?), last_error = NULL, updated_ts = ?
        WHERE publication_id = ? AND target_key = ?`,
    ).run(now, now, publicationId, targetKey);
    return result.changes === 1;
  }

  markPublicationOutboxRetry(
    publicationId: number,
    targetKey: string,
    error: string,
    now: number,
  ): boolean {
    const row = this.getPublicationOutboxByTarget(publicationId, targetKey);
    if (!row || row.completedTs !== null) return false;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(row.attemptCount, 6)));
    const result = this.db.query(
      `UPDATE design_publication_outbox
          SET attempt_count = attempt_count + 1, next_retry_ts = ?, last_error = ?, updated_ts = ?
        WHERE publication_id = ? AND target_key = ? AND completed_ts IS NULL`,
    ).run(now + delay, error.slice(0, 4000), now, publicationId, targetKey);
    return result.changes === 1;
  }

  refreshPublicationStatus(publicationId: number, error: string | null, now: number): DesignPublication {
    const pending = this.db.query<{ n: number }, [number]>(
      `SELECT COUNT(*) AS n FROM design_publication_outbox
       WHERE publication_id = ? AND completed_ts IS NULL`,
    ).get(publicationId)?.n ?? 0;
    const status: DesignPublicationStatus = pending === 0 ? 'complete' : error ? 'recoverable_error' : 'post_commit_pending';
    this.db.query(
      'UPDATE design_publications SET status = ?, error = ?, updated_ts = ? WHERE id = ?',
    ).run(status, error?.slice(0, 4000) ?? null, now, publicationId);
    const publication = this.getPublication(publicationId);
    if (!publication) throw new Error('design publication disappeared');
    return publication;
  }

  private appendEventUnchecked(id: number, kind: DesignEventKind, data: unknown): DesignEvent {
    const row = this.db
      .query<DesignEventRow, [number, string, string | null, number]>(
        `INSERT INTO design_events (design_task_id, kind, data_json, ts)
         VALUES (?, ?, ?, ?) RETURNING *`,
      )
      .get(id, kind, json(data), Date.now());
    if (!row) throw new Error('append design event failed');
    return mapEvent(row);
  }

  listEvents(id: number, afterId?: number): DesignEvent[] {
    return this.db
      .query<DesignEventRow, [number, number]>(
        `SELECT * FROM design_events
         WHERE design_task_id = ? AND id > ?
         ORDER BY id`,
      )
      .all(id, afterId ?? 0)
      .map(mapEvent);
  }

  listRecentEvents(id: number, limit = 100): DesignEvent[] {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    return this.db.query<DesignEventRow, [number, number]>(
      `SELECT * FROM (
         SELECT * FROM design_events WHERE design_task_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    ).all(id, bounded).map(mapEvent);
  }

  saveRevision(input: SaveDesignRevision): DesignRevision {
    return this.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: input.designTaskId,
      expectedRevision: input.revision - 1,
      documentJson: input.documentJson,
      documentMarkdown: input.documentMarkdown,
      readiness: input.readiness,
      graph: input.graph,
      actor: input.actor,
      reason: input.reason,
      event: { kind: 'document_revised', data: { source: 'saveRevision' } },
      createdTs: input.createdTs,
    }).revision;
  }

  getRevision(id: number, revision: number): DesignRevision | null {
    const row = this.db
      .query<DesignRevisionRow, [number, number]>(
        `SELECT * FROM design_revisions WHERE design_task_id = ? AND revision = ?`,
      )
      .get(id, revision);
    return row ? mapRevision(row) : null;
  }

  replaceGraph(id: number, graph: DesignGraphDraft): DesignGraph {
    const replace = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`design task not found: ${id}`);
      if (task.status === 'archived' || task.stage === 'archived') throw new DesignTaskImmutableError(id);
      if (task.currentRevision > 0) {
        throw new Error('live graph replacement requires commitDocumentMutation');
      }
      const now = Date.now();
      this.replaceGraphRows(id, normalizeGraph(graph), now);
      return this.getGraph(id);
    });
    return replace();
  }

  private replaceGraphRows(id: number, graph: DesignGraphDraft, now: number): void {
    const normalized = normalizeGraph(graph);
    this.db.query('DELETE FROM design_graph_edges WHERE design_task_id = ?').run(id);
    this.db.query('DELETE FROM design_graph_nodes WHERE design_task_id = ?').run(id);
    for (const node of normalized.nodes) {
      this.db
        .query<unknown, [number, string, number, string, string | null, number | null, number | null, number, number]>(
          `INSERT INTO design_graph_nodes (
             design_task_id, node_id, ordinal, title, detail_json, issue_id, last_synced_revision,
             created_ts, updated_ts
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          node.nodeId,
          node.ordinal,
          node.title,
          graphNodeDetail(node),
          node.issueId,
          node.lastSyncedRevision,
          now,
          now,
        );
    }
    for (const edge of normalized.edges) {
      this.db
        .query<unknown, [number, string, string, string, number]>(
          `INSERT INTO design_graph_edges (design_task_id, from_node_id, to_node_id, kind, created_ts)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, edge.fromNodeId, edge.toNodeId, edge.kind, now);
    }
  }

  getGraph(id: number): DesignGraph {
    const nodes = this.db
      .query<DesignGraphNodeRow, [number]>(
        `SELECT node.node_id, node.ordinal, node.title, node.detail_json,
                COALESCE(
                  (SELECT link.issue_id
                     FROM design_issue_links link
                    WHERE link.design_task_id = node.design_task_id
                      AND link.node_id = node.node_id
                      AND link.link_kind = 'primary'
                    ORDER BY link.source_revision DESC, link.id DESC LIMIT 1),
                  node.issue_id
                ) AS issue_id,
                COALESCE(
                  (SELECT link.last_synced_revision
                     FROM design_issue_links link
                    WHERE link.design_task_id = node.design_task_id
                      AND link.node_id = node.node_id
                      AND link.link_kind = 'primary'
                    ORDER BY link.source_revision DESC, link.id DESC LIMIT 1),
                  node.last_synced_revision
                ) AS last_synced_revision
           FROM design_graph_nodes node
          WHERE node.design_task_id = ?
          ORDER BY node.ordinal, node.id`,
      )
      .all(id)
      .map((row): DesignGraphNode => {
        const stored = parseGraphNodeDetail(row.detail_json);
        return {
          nodeId: row.node_id,
          ordinal: row.ordinal,
          title: row.title,
          detail: stored.detail,
          ...stored.contract,
          issueId: row.issue_id,
          lastSyncedRevision: row.last_synced_revision,
        };
      });
    const edges = this.db
      .query<DesignGraphEdgeRow, [number]>(
        `SELECT from_node_id, to_node_id, kind
         FROM design_graph_edges WHERE design_task_id = ? ORDER BY id`,
      )
      .all(id)
      .map(
        (row): DesignGraphEdge => ({
          fromNodeId: row.from_node_id,
          toNodeId: row.to_node_id,
          kind: row.kind,
        }),
      );
    return { nodes, edges };
  }
}

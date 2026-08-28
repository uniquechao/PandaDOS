import type { AgentKind } from '../core/types';

/** The design workbench is its own lifecycle domain, deliberately separate from IssueState. */
export const DESIGN_TASK_STAGES = [
  'goal_setting',
  'solution_draft',
  'review',
  'graph_draft',
  'approved',
  'executing',
  'completed',
  'archived',
  'error',
] as const;
export type DesignTaskStage = typeof DESIGN_TASK_STAGES[number];

export const DESIGN_TASK_STATUSES = ['active', 'archived', 'error'] as const;
export type DesignTaskStatus = typeof DESIGN_TASK_STATUSES[number];

export const DESIGN_GRAPH_GRANULARITIES = [
  'milestone',
  'module',
  'balanced',
  'small',
  'atomic',
] as const;
export type DesignGraphGranularity = typeof DESIGN_GRAPH_GRANULARITIES[number];

/** Maps the sole pre-contract wire value while rejecting every other unknown value. */
export function normalizeDesignGraphGranularity(value: unknown): DesignGraphGranularity | null {
  if (value === 'issue') return 'balanced';
  return (DESIGN_GRAPH_GRANULARITIES as readonly unknown[]).includes(value)
    ? value as DesignGraphGranularity
    : null;
}

export const DESIGN_CREATION_SAGA_PHASES = [
  'intent',
  'task_created',
  'conversation_created',
  'bound',
  'activating',
  'activated',
  'completed',
  'recoverable_error',
] as const;
export type DesignCreationSagaPhase = typeof DESIGN_CREATION_SAGA_PHASES[number];

export interface DesignCreationSaga {
  sagaToken: string;
  projectId: number;
  idempotencyKey: string;
  requestJson: string;
  conversationId: string;
  taskId: number | null;
  phase: DesignCreationSagaPhase;
  conversationOwned: boolean;
  error: string | null;
  createdTs: number;
  updatedTs: number;
}

export const DESIGN_EVENT_KINDS = [
  'task_created',
  'input_appended',
  'brief_updated',
  'goal_confirmed',
  'document_revised',
  'finding_appended',
  'graph_replaced',
  'graph_approved',
  'execution_started',
  'execution_completed',
  'stage_changed',
  'readiness_updated',
  'sync_dirty',
  'graph_published',
  'issue_sync_requested',
  'issue_sync_applied',
  'issue_sync_ignored',
  'issue_supplement_created',
  'task_archived',
  'task_error',
] as const;
export type DesignEventKind = typeof DESIGN_EVENT_KINDS[number];

export interface DesignTask {
  id: number;
  projectId: number;
  moduleId: number | null;
  title: string;
  originalRequest: string;
  agent: AgentKind;
  stage: DesignTaskStage;
  status: DesignTaskStatus;
  currentRevision: number;
  readinessThreshold: number;
  readinessOverride: boolean;
  documentJson: unknown | null;
  documentMarkdown: string | null;
  graphGranularity: DesignGraphGranularity;
  conversationId: string | null;
  worktreeCwd: string | null;
  worktreeBranch: string | null;
  worktreeMetadata: unknown | null;
  createdTs: number;
  updatedTs: number;
  lastError: string | null;
}

export interface CreateDesignTaskRecord {
  projectId: number;
  moduleId?: number | null;
  title: string;
  originalRequest: string;
  agent: AgentKind;
  stage?: DesignTaskStage;
  status?: DesignTaskStatus;
  readinessThreshold?: number;
  readinessOverride?: boolean;
  documentJson?: unknown | null;
  documentMarkdown?: string | null;
  graphGranularity?: DesignGraphGranularity;
  conversationId?: string | null;
  worktreeCwd?: string | null;
  worktreeBranch?: string | null;
  worktreeMetadata?: unknown | null;
  lastError?: string | null;
  createdTs?: number;
  updatedTs?: number;
}

/** expectedRevision is the optimistic-lock version the caller last read. */
export interface DesignTaskPatch {
  expectedRevision: number;
  moduleId?: number | null;
  title?: string;
  originalRequest?: string;
  agent?: AgentKind;
  stage?: DesignTaskStage;
  status?: DesignTaskStatus;
  readinessThreshold?: number;
  readinessOverride?: boolean;
  documentJson?: unknown | null;
  documentMarkdown?: string | null;
  graphGranularity?: DesignGraphGranularity;
  conversationId?: string | null;
  worktreeCwd?: string | null;
  worktreeBranch?: string | null;
  worktreeMetadata?: unknown | null;
  lastError?: string | null;
}

export interface DesignRuntimeMetadataPatch {
  expectedRevision: number;
  conversationId?: string | null;
  worktreeCwd?: string | null;
  worktreeBranch?: string | null;
  worktreeMetadata?: unknown | null;
  lastError?: string | null;
}

export type DesignLifecycleAction =
  | 'confirm_goal'
  | 'approve_graph'
  | 'start_execution'
  | 'complete_execution';

export interface DesignStageTransitionInput {
  designTaskId: number;
  expectedRevision: number;
  action: DesignLifecycleAction;
  actor: string;
  eventData?: unknown;
  readinessOverride?: boolean;
  createdTs?: number;
}

export interface DesignGraphNodeDraft {
  nodeId: string;
  ordinal?: number;
  title: string;
  detail?: unknown | null;
  goal?: string;
  background?: string[];
  sourceSections?: string[];
  scope?: string[];
  nonGoals?: string[];
  inputs?: string[];
  outputs?: string[];
  dependencies?: string[];
  implementationNotes?: string[];
  moduleId?: number | null;
  runtime?: DesignGraphRuntime;
  /** null inherits the design task agent; a value is an explicit per-node override. */
  agent?: AgentKind | null;
  complexity?: DesignGraphComplexity;
  complexityRationale?: string[];
  acceptanceCriteria?: string[];
  testRecommendations?: string[];
  evidenceRequirements?: string[];
  completionInstructions?: string[];
  implMode?: 'direct' | 'team';
  issueId?: number | null;
  lastSyncedRevision?: number | null;
}

export const DESIGN_GRAPH_RUNTIMES = ['current', 'worktree'] as const;
export type DesignGraphRuntime = typeof DESIGN_GRAPH_RUNTIMES[number];

export const DESIGN_GRAPH_COMPLEXITIES = ['low', 'medium', 'high'] as const;
export type DesignGraphComplexity = typeof DESIGN_GRAPH_COMPLEXITIES[number];

export interface DesignGraphEdgeDraft {
  fromNodeId: string;
  toNodeId: string;
  kind?: string;
}

export interface DesignGraphDraft {
  nodes: DesignGraphNodeDraft[];
  edges: DesignGraphEdgeDraft[];
}

export interface DesignGraphNode extends Omit<DesignGraphNodeDraft, 'ordinal' | 'detail' | 'issueId' | 'lastSyncedRevision'> {
  ordinal: number;
  detail: unknown | null;
  issueId: number | null;
  lastSyncedRevision: number | null;
}

export interface DesignGraphEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: string;
}

export interface DesignGraph {
  nodes: DesignGraphNode[];
  edges: DesignGraphEdge[];
}

export interface SaveDesignRevision {
  designTaskId: number;
  revision: number;
  documentJson: unknown;
  documentMarkdown: string;
  readiness: number;
  graph: DesignGraphDraft;
  actor: string;
  reason?: string | null;
  createdTs?: number;
}

export interface DesignRevision {
  id: number;
  designTaskId: number;
  revision: number;
  documentJson: unknown;
  documentMarkdown: string;
  readiness: number;
  graph: DesignGraph;
  actor: string;
  reason: string | null;
  createdTs: number;
}

export interface DesignEvent {
  id: number;
  designTaskId: number;
  kind: DesignEventKind;
  data: unknown | null;
  ts: number;
}

export type DesignDocumentMutationAction =
  | 'create_design'
  | 'refine_goal'
  | 'revise_document'
  | 'submit_review'
  | 'replace_graph'
  | 'set_granularity';

export interface DesignDocumentMutationInput {
  action: DesignDocumentMutationAction;
  designTaskId: number;
  expectedRevision: number;
  taskPatch?: Pick<DesignTaskPatch, 'title' | 'originalRequest' | 'readinessThreshold' | 'readinessOverride' | 'graphGranularity' | 'lastError'>;
  documentJson: unknown;
  documentMarkdown: string;
  readiness: number;
  graph?: DesignGraphDraft;
  actor: string;
  reason?: string | null;
  event: { kind: DesignEventKind; data: unknown };
  operation?: DesignAgentOperationInput;
  createdTs?: number;
}

export interface DesignAgentOperationInput {
  operationId: string;
  operationKind: 'review' | 'steward_revision';
  requestJson: string;
}

export type DesignPersonaOrigin = 'builtin' | 'market' | 'project';
export type DesignPersonaRole = 'goal_coach' | 'design_steward' | 'reviewer' | 'issue_planner' | 'independent_verifier';

export interface DesignPersonaProvenance {
  key: string;
  contentHash: string;
  origin: DesignPersonaOrigin;
  gitCommit: string | null;
  role: DesignPersonaRole;
  projectId: number;
  resolvedAgent: AgentKind;
}

export interface DesignRunIntent extends DesignPersonaProvenance {
  designId: number;
  runId: string;
  operationGroupId: string;
  sourceRevision: number;
  state: 'launching' | 'ingested' | 'failed' | 'interrupted';
  createdTs: number;
  updatedTs: number;
}

export type DesignAgentRunMode = 'goal' | 'solution' | 'review' | 'graph';
export type DesignAgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface DesignAgentRunGroup {
  id: string;
  designTaskId: number;
  projectId: number;
  idempotencyKey: string;
  requestDigest: string;
  mode: DesignAgentRunMode;
  sourceRevision: number;
  message: string | null;
  personaKeys: string[];
  status: DesignAgentRunStatus;
  cancelRequested: boolean;
  failureCode: string | null;
  createdByUserId: number;
  createdTs: number;
  startedTs: number | null;
  finishedTs: number | null;
  updatedTs: number;
}

export interface DesignDocumentMutationResult {
  task: DesignTask;
  revision: DesignRevision;
  event: DesignEvent;
  graph: DesignGraph;
}

export interface CreateRevisionedDesignTaskRecord extends Omit<CreateDesignTaskRecord, 'documentJson' | 'documentMarkdown'> {
  documentJson: unknown;
  documentMarkdown: string;
  readiness: number;
  graph?: DesignGraphDraft;
  actor: string;
  reason?: string | null;
  createdEventData?: unknown;
}

export interface DesignPersonaSource {
  id: number;
  sourceKey: string;
  sourceUrl: string | null;
  contentHash: string;
  content: string;
  fetchedTs: number;
  updatedTs: number;
}

export interface DesignPersona {
  id: number;
  sourceId: number | null;
  name: string;
  contentHash: string;
  content: unknown;
  createdTs: number;
  updatedTs: number;
}

export interface DesignProjectPersona {
  projectId: number;
  personaId: number;
  approvedHash: string | null;
  enabled: boolean;
  createdTs: number;
  updatedTs: number;
}

export const DESIGN_ASSET_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type DesignAssetStatus = typeof DESIGN_ASSET_STATUSES[number];

export interface DesignAsset {
  id: number;
  designTaskId: number;
  designRevision: number | null;
  prompt: string;
  provider: string | null;
  status: DesignAssetStatus;
  path: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  metadata: unknown | null;
  error: string | null;
  kind: 'raster_reference' | 'input_reference';
  preset: 'full_page_mockup' | 'component_states' | 'visual_direction' | null;
  size: '1024x1024' | '1536x1024' | '1024x1536' | null;
  requestKey: string | null;
  requestDigest: string | null;
  assetVersion: number;
  byteSize: number | null;
  outputSha256: string | null;
  implementationReady: boolean;
  functionalDetails: unknown | null;
  retryOfAssetId: number | null;
  providerRequestId: string | null;
  runnable: boolean;
  stagingManifest: unknown | null;
  providerPrompt: string | null;
  promptCompilerVersion: number | null;
  includeRevisionContext: boolean;
  contextSha256: string | null;
  referenceManifest: unknown | null;
  providerModel: string | null;
  outputFormat: 'png' | 'webp' | null;
  quality: string | null;
  expectedOutputSha256: string | null;
  expectedByteSize: number | null;
  expectedMimeType: 'image/png' | 'image/webp' | null;
  expectedWidth: number | null;
  expectedHeight: number | null;
  readyByUserId: number | null;
  readyTs: number | null;
  createdTs: number;
  updatedTs: number;
}

export const DESIGN_PUBLICATION_STATUSES = [
  'committed',
  'post_commit_pending',
  'complete',
  'recoverable_error',
] as const;
export type DesignPublicationStatus = typeof DESIGN_PUBLICATION_STATUSES[number];

export interface DesignPublication {
  id: number;
  designTaskId: number;
  projectId: number;
  revision: number;
  graphDigest: string;
  actorKey: string;
  idempotencyKey: string;
  status: DesignPublicationStatus;
  error: string | null;
  createdTs: number;
  updatedTs: number;
}

export interface DesignIssueBaselineContract {
  schemaVersion: 1;
  designId: number;
  revision: number;
  nodeId: string;
  title: string;
  goal: string;
  background: string[];
  sourceSections: string[];
  scope: string[];
  nonGoals: string[];
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  implementationNotes: string[];
  moduleId: number | null;
  runtime: DesignGraphRuntime;
  agent: AgentKind;
  complexity: DesignGraphComplexity;
  complexityRationale: string[];
  acceptanceCriteria: string[];
  testRecommendations: string[];
  evidenceRequirements: string[];
  completionInstructions: string[];
  implMode: 'direct' | 'team';
  body: string;
}

export interface DesignIssueLink {
  id: number;
  publicationId: number;
  designTaskId: number;
  projectId: number;
  nodeId: string;
  issueId: number;
  sourceRevision: number;
  lastSyncedRevision: number;
  originalImplMode: 'direct' | 'team';
  baselineContract: DesignIssueBaselineContract;
  baselineContractDigest: string;
  syncState: string;
  syncError: string | null;
  nextRetryTs: number | null;
  parentIssueId: number | null;
  parentLinkId: number | null;
  createdTs: number;
  updatedTs: number;
}

export const DESIGN_ISSUE_SYNC_STATES = [
  'current',
  'auto_synced',
  'confirmation_needed',
  'conflict',
  'supplement_needed',
  'stale',
  'cancelled',
  'recovery_pending',
] as const;
export type DesignIssueSyncState = typeof DESIGN_ISSUE_SYNC_STATES[number];

export interface DesignIssueSyncResult {
  linkId: number;
  nodeId: string;
  issueId: number;
  targetRevision: number;
  state: DesignIssueSyncState;
  executionSyncId: number | null;
  supplementIssueId: number | null;
  repeated: boolean;
}

export type DesignIssueSyncDecision = 'apply' | 'ignore' | 'supplement';

export type DesignIssueSyncJobState = 'pending' | 'running' | 'retry' | 'complete' | 'stale';

export interface DesignIssueSyncJob {
  id: number;
  linkId: number;
  designTaskId: number;
  targetRevision: number;
  state: DesignIssueSyncJobState;
  attemptCount: number;
  nextRetryTs: number;
  claimToken: string | null;
  claimedTs: number | null;
  completedTs: number | null;
  lastError: string | null;
  createdTs: number;
  updatedTs: number;
}

export interface DesignPublicationOutboxItem {
  id: number;
  publicationId: number;
  kind: 'module_index' | 'scheduler';
  targetKey: string;
  payload: unknown;
  attemptCount: number;
  nextRetryTs: number;
  completedTs: number | null;
  lastError: string | null;
  createdTs: number;
  updatedTs: number;
}

export interface DesignPublishPreviewNode {
  nodeId: string;
  title: string;
  goal: string;
  scope: string[];
  nonGoals: string[];
  inputs: string[];
  outputs: string[];
  dependencies: string[];
  implementationNotes: string[];
  resolvedModuleId: number | null;
  resolvedAgent: AgentKind;
  runtime: DesignGraphRuntime;
  complexity: DesignGraphComplexity;
  complexityRationale: string[];
  implMode: 'direct' | 'team';
  acceptanceCriteria: string[];
  testRecommendations: string[];
  evidenceRequirements: string[];
  completionInstructions: string[];
  /** Digest of the exact immutable Issue body; the body itself is intentionally not exposed. */
  bodyDigest: string;
}

export interface DesignPublishConfirmation {
  designId: number;
  projectId: number;
  revision: number;
  graphDigest: string;
  token: string;
  expiresTs: number;
  orderedNodes: DesignPublishPreviewNode[];
  topologicalOrder: string[];
  dependencies: Array<{ fromNodeId: string; toNodeId: string }>;
  blockers: string[];
  readiness: {
    score: number;
    threshold: number;
    override: boolean;
  };
}

export interface DesignPublishedIssue {
  nodeId: string;
  issueId: number;
  title: string;
  implMode: 'direct' | 'team';
  moduleId: number | null;
  agent: AgentKind;
}

export interface DesignPublicationResult {
  publicationId: number;
  designId: number;
  projectId: number;
  revision: number;
  graphDigest: string;
  status: DesignPublicationStatus;
  error: string | null;
  issues: DesignPublishedIssue[];
}

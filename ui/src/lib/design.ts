import type { AgentKind } from './types';
import type { MessageKey } from '../../../shared/i18n/messages';

export type DesignTaskStage =
  | 'goal_setting'
  | 'solution_draft'
  | 'review'
  | 'graph_draft'
  | 'approved'
  | 'executing'
  | 'completed'
  | 'archived'
  | 'error';

export type DesignGraphGranularity = 'milestone' | 'module' | 'balanced' | 'small' | 'atomic';

export interface DesignTask {
  id: number;
  projectId: number;
  moduleId: number | null;
  title: string;
  originalRequest: string;
  agent: AgentKind;
  stage: DesignTaskStage;
  status: 'active' | 'archived' | 'error';
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

export type DesignTaskSafeMetadata = Pick<DesignTask,
  'id' | 'projectId' | 'moduleId' | 'title' | 'originalRequest' | 'agent' | 'stage' | 'status'
  | 'currentRevision' | 'readinessThreshold' | 'readinessOverride' | 'graphGranularity'
  | 'conversationId' | 'createdTs' | 'updatedTs'>;

export interface DesignRevisionView {
  revision: number;
  documentJson: unknown | null;
  documentMarkdown: string | null;
  readiness: number;
  createdTs: number;
}

export function mergeWorkbenchDesignTask(
  current: DesignTask,
  metadata: DesignTaskSafeMetadata,
  revision: DesignRevisionView,
): DesignTask {
  return {
    ...current,
    ...metadata,
    currentRevision: revision.revision,
    documentJson: revision.documentJson,
    documentMarkdown: revision.documentMarkdown,
  };
}

export interface DesignEvent {
  id: number;
  designTaskId: number;
  kind: string;
  data: unknown | null;
  ts: number;
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

export type KnownDesignEventKind = typeof DESIGN_EVENT_KINDS[number];

export const DESIGN_EVENT_LABEL_KEYS: Record<KnownDesignEventKind, MessageKey> = {
  task_created: 'design.event.task_created',
  input_appended: 'design.event.input_appended',
  brief_updated: 'design.event.brief_updated',
  goal_confirmed: 'design.event.goal_confirmed',
  document_revised: 'design.event.document_revised',
  finding_appended: 'design.event.finding_appended',
  graph_replaced: 'design.event.graph_replaced',
  graph_approved: 'design.event.graph_approved',
  execution_started: 'design.event.execution_started',
  execution_completed: 'design.event.execution_completed',
  stage_changed: 'design.event.stage_changed',
  readiness_updated: 'design.event.readiness_updated',
  sync_dirty: 'design.event.sync_dirty',
  graph_published: 'design.event.graph_published',
  issue_sync_requested: 'design.event.issue_sync_requested',
  issue_sync_applied: 'design.event.issue_sync_applied',
  issue_sync_ignored: 'design.event.issue_sync_ignored',
  issue_supplement_created: 'design.event.issue_supplement_created',
  task_archived: 'design.event.task_archived',
  task_error: 'design.event.task_error',
};

export function designEventLabelKey(kind: string): MessageKey {
  return Object.prototype.hasOwnProperty.call(DESIGN_EVENT_LABEL_KEYS, kind)
    ? DESIGN_EVENT_LABEL_KEYS[kind as KnownDesignEventKind]
    : 'design.event.unknown';
}

export interface DesignGraphNode {
  nodeId: string;
  title: string;
  ordinal: number;
  goal?: string;
  scope?: string[];
  acceptanceCriteria?: string[];
  testRecommendations?: string[];
  evidenceRequirements?: string[];
  dependencies?: string[];
  blockers?: string[];
  moduleId?: number | null;
  agent?: AgentKind | null;
  implMode?: 'direct' | 'team';
  detail: unknown | null;
  issueId: number | null;
  lastSyncedRevision: number | null;
}

export interface DesignGraph {
  nodes: DesignGraphNode[];
  edges: { fromNodeId: string; toNodeId: string; kind: string }[];
}

export interface DesignReadinessSummary {
  score: number;
  threshold: number;
  override: boolean;
  revision: number;
  dimensions?: Record<string, { score: number; summary?: string; evidence?: string[]; patch?: string[]; nextQuestions?: string[] }>;
  blockers?: Array<{ id: string; message: string }>;
  approvalInput?: unknown;
}

export interface DesignFindingView {
  id: string | number; persona: string; severity: string; finding: string;
  evidence?: string[]; patch?: string[]; blocker?: boolean;
}

export interface DesignLinkedIssueView { linkId: number; issueId: number; status: string; syncState: string; pendingDiffId?: number | null }

export interface DesignPersonaView {
  id: number; key: string; origin: 'builtin' | 'market' | 'project'; contentHash: string;
  gitCommit: string | null; enabled: boolean; approval: 'not_required' | 'pending' | 'approved' | 'stale';
  manifest: { slug: string; displayName: string; reviewSpecialty: string; compatibleAgents: AgentKind[]; role: string };
}

export interface DesignWorkbenchView {
  design: DesignTaskSafeMetadata; revision: DesignRevisionView; graph: DesignGraph;
  readinessReport: { aggregate: number; threshold: number; override: boolean; dimensions: Array<{ dimension: string; score: number; evidencePaths: string[]; missingItems: string[]; nextQuestions: string[] }>; hardBlockers: Array<{ id: string; message: string }> };
  findings: Array<{ eventId: number; persona: string; severity: string; finding: string; evidence: string[]; proposedPatch: unknown }>;
  linkedIssues: Array<DesignLinkedIssueView & { nodeId: string }>;
  enabledPersonas: Array<{ id: number; key: string; origin: DesignPersonaView['origin']; displayName: string; reviewSpecialty: string; compatibleAgents: AgentKind[]; role: string; contentHash: string; gitCommit: string | null; approval: DesignPersonaView['approval'] }>;
  latestRun: DesignRunView | null;
  capabilities: { runModes: DesignRunMode[] };
}

export interface DesignCapabilities {
  designWs: boolean;
  visualAssets: boolean;
  issuePublish: boolean;
}

export const TASK_10_CAPABILITIES: DesignCapabilities = Object.freeze({
  designWs: true,
  visualAssets: true,
  issuePublish: true,
});

export type DesignRunMode = 'goal' | 'solution' | 'review' | 'graph';
export interface DesignRunView {
  id: string; mode: DesignRunMode; sourceRevision: number;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  personas: string[]; cancelRequested: boolean; failureCode: string | null; updatedTs: number;
}

export interface DesignPublicationView {
  publicationId: number; revision: number; graphDigest: string; status: string;
  issues: { nodeId: string; issueId: number }[];
}

export interface DesignSyncView {
  linkId: number; executionSyncId: number | null; issueId: number; nodeId: string;
  targetRevision: number; state: string; decisionState: string | null;
  fields: { field: string; kind: string; base: unknown; local: unknown; incoming: unknown }[];
  recovery?: { pending: boolean; resolutionRequired: boolean };
}

export interface DesignPublishConfirmationNode {
  nodeId: string; title: string; resolvedModuleId: number | null; resolvedAgent: AgentKind;
  runtime: 'current' | 'worktree'; implMode: 'direct' | 'team';
  goal: string; scope: string[]; nonGoals: string[]; inputs: string[]; outputs: string[];
  dependencies: string[]; implementationNotes: string[]; complexity: 'low' | 'medium' | 'high';
  complexityRationale: string[]; acceptanceCriteria: string[]; testRecommendations: string[];
  evidenceRequirements: string[]; completionInstructions: string[]; bodyDigest: string;
}

export interface DesignPublishConfirmationView {
  designId: number; projectId: number; token: string; graphDigest: string; revision: number;
  expiresTs: number; orderedNodes: DesignPublishConfirmationNode[];
  topologicalOrder: string[];
  dependencies: Array<{ fromNodeId: string; toNodeId: string }>;
  blockers: string[];
  readiness: { score: number; threshold: number; override: boolean };
}

export function isCompletePublishConfirmation(value: unknown): value is DesignPublishConfirmationView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const confirmation = value as Record<string, unknown>;
  if (!Number.isSafeInteger(confirmation.designId) || (confirmation.designId as number) <= 0
    || !Number.isSafeInteger(confirmation.projectId) || (confirmation.projectId as number) <= 0
    || !Number.isSafeInteger(confirmation.revision) || (confirmation.revision as number) <= 0
    || !Number.isSafeInteger(confirmation.expiresTs) || (confirmation.expiresTs as number) <= 0
    || typeof confirmation.token !== 'string' || !confirmation.token
    || typeof confirmation.graphDigest !== 'string' || !/^[0-9a-f]{64}$/.test(confirmation.graphDigest)
    || !Array.isArray(confirmation.dependencies) || !Array.isArray(confirmation.orderedNodes)
    || confirmation.orderedNodes.length === 0) return false;
  const strings = (item: unknown): item is string[] => Array.isArray(item) && item.every((entry) => typeof entry === 'string');
  if (!strings(confirmation.topologicalOrder) || !strings(confirmation.blockers)
    || !confirmation.readiness || typeof confirmation.readiness !== 'object' || Array.isArray(confirmation.readiness)) return false;
  const readiness = confirmation.readiness as Record<string, unknown>;
  if (typeof readiness.score !== 'number' || !Number.isFinite(readiness.score) || readiness.score < 0 || readiness.score > 100
    || typeof readiness.threshold !== 'number' || !Number.isFinite(readiness.threshold) || readiness.threshold < 0 || readiness.threshold > 100
    || typeof readiness.override !== 'boolean') return false;
  if (!(confirmation.dependencies as unknown[]).every((edge) => {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return false;
    const dependency = edge as Record<string, unknown>;
    return typeof dependency.fromNodeId === 'string' && !!dependency.fromNodeId
      && typeof dependency.toNodeId === 'string' && !!dependency.toNodeId;
  })) return false;
  const orderedNodes = confirmation.orderedNodes as unknown[];
  const nodeIds = new Set<string>();
  const completeNodes = orderedNodes.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const node = item as Record<string, unknown>;
    const complete = typeof node.nodeId === 'string' && !!node.nodeId
      && typeof node.title === 'string' && !!node.title
      && (node.resolvedModuleId === null || (Number.isSafeInteger(node.resolvedModuleId) && (node.resolvedModuleId as number) > 0))
      && (node.resolvedAgent === 'claude' || node.resolvedAgent === 'codex')
      && (node.runtime === 'current' || node.runtime === 'worktree')
      && (node.implMode === 'direct' || node.implMode === 'team')
      && (node.complexity === 'low' || node.complexity === 'medium' || node.complexity === 'high')
      && typeof node.goal === 'string'
      && typeof node.bodyDigest === 'string' && /^[0-9a-f]{64}$/.test(node.bodyDigest)
      && strings(node.scope) && strings(node.nonGoals) && strings(node.inputs) && strings(node.outputs)
      && strings(node.dependencies) && strings(node.implementationNotes) && strings(node.complexityRationale)
      && strings(node.acceptanceCriteria) && strings(node.testRecommendations)
      && strings(node.evidenceRequirements) && strings(node.completionInstructions);
    if (!complete || nodeIds.has(node.nodeId as string)) return false;
    nodeIds.add(node.nodeId as string);
    return true;
  });
  if (!completeNodes) return false;
  const topologicalOrder = confirmation.topologicalOrder as string[];
  if (topologicalOrder.length !== orderedNodes.length
    || topologicalOrder.some((nodeId, index) => nodeId !== (orderedNodes[index] as Record<string, unknown>).nodeId)) return false;
  return (confirmation.dependencies as Array<Record<string, unknown>>).every((edge) => (
    nodeIds.has(edge.fromNodeId as string) && nodeIds.has(edge.toNodeId as string)
  ));
}

export interface DesignGraphRankNode { nodeId: string; rank: number; row: number; x: number; y: number }
export function graphRankLayout(graph: DesignGraph): { nodes: DesignGraphRankNode[]; width: number; height: number } {
  const ordered = [...graph.nodes].sort((a, b) => a.ordinal - b.ordinal);
  const rank = new Map(ordered.map((node) => [node.nodeId, 0]));
  for (let pass = 0; pass < ordered.length; pass += 1) {
    let changed = false;
    for (const edge of graph.edges) {
      const from = rank.get(edge.fromNodeId); const to = rank.get(edge.toNodeId);
      if (from === undefined || to === undefined || to >= from + 1) continue;
      rank.set(edge.toNodeId, from + 1); changed = true;
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  const nodes = ordered.map((node) => {
    const nodeRank = Math.min(rank.get(node.nodeId) ?? 0, Math.max(0, ordered.length - 1));
    const row = rows.get(nodeRank) ?? 0; rows.set(nodeRank, row + 1);
    return { nodeId: node.nodeId, rank: nodeRank, row, x: 24 + nodeRank * 240, y: 24 + row * 156 };
  });
  const maxRank = Math.max(0, ...nodes.map((node) => node.rank));
  const maxRows = Math.max(1, ...rows.values());
  return { nodes, width: 220 + maxRank * 240, height: 164 + (maxRows - 1) * 156 };
}

export interface DesignWorktreeView {
  id: string; publicationId: number | null; revision: number; graphDigest: string;
  executionMode: 'current' | 'worktree'; lifecycleState: string; assignmentActive: boolean;
  baseRef: string | null; worktreeBranch: string | null; errorCode: string | null;
}

export interface DesignFileDiff {
  revision: number; targetKind: 'project' | 'design_worktree'; conflictToken?: string;
  files: { path: string; classification: string; baseText?: string; localText?: string; incomingText?: string }[];
}

export interface DesignAssetView {
  id: number; designRevision: number; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  kind: 'raster_reference' | 'input_reference';
  preset: 'full_page_mockup' | 'component_states' | 'visual_direction' | null;
  size: '1024x1024' | '1536x1024' | '1024x1536' | null;
  provider: string | null; providerModel: string | null; outputFormat: 'png' | 'webp' | null;
  quality: string | null; mimeType: string | null; width: number | null; height: number | null;
  byteSize: number | null; outputSha256: string | null; implementationReady: boolean;
  functionalDetails: DesignAssetFunctionalDetails | null; retryOfAssetId: number | null;
  providerRequestId: string | null; assetVersion: number; error: string | null;
  createdTs: number; updatedTs: number; contentUrl: string | null;
}

export interface DesignAssetFunctionalDetails {
  altText: string; interactions: string[]; responsiveBehavior: string[];
  accessibilityNotes: string[]; acceptanceCriteria: string[];
}

export interface DesignAssetCapabilityView {
  enabled: boolean; provider: 'openai' | null; model: string | null;
  sizes: Array<'1024x1024' | '1536x1024' | '1024x1536'>;
  formats: Array<'image/png' | 'image/webp'>; maxReferences: number;
  requiresExplicitAcknowledgement: true; reason: 'not_configured' | null;
}

export interface LatestOnlyRequestTicket {
  generation: number;
  signal: AbortSignal;
}

/** Aborts superseded requests and makes late response commits fail closed. */
export class LatestOnlyRequestGuard {
  private generation = 0;
  private controller: AbortController | null = null;

  begin(): LatestOnlyRequestTicket {
    this.controller?.abort();
    this.controller = new AbortController();
    return Object.freeze({ generation: ++this.generation, signal: this.controller.signal });
  }

  isCurrent(ticket: LatestOnlyRequestTicket): boolean {
    return ticket.generation === this.generation && !ticket.signal.aborted;
  }

  invalidate(): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
}

/** A list/detail poll may enrich the UI, but it must never downgrade a newer mutation result. */
export function preferLatestDesignTask(current: DesignTask, incoming: DesignTask): DesignTask {
  if (incoming.currentRevision !== current.currentRevision) {
    return incoming.currentRevision > current.currentRevision ? incoming : current;
  }
  return incoming.updatedTs > current.updatedTs ? incoming : current;
}

/** Merge a list snapshot without losing a newer mutation/detail snapshot not visible to that request. */
export function mergeLatestDesignTasks(
  current: DesignTask[] | null,
  incoming: DesignTask[],
): DesignTask[] {
  if (current === null) return incoming;
  const currentById = new Map(current.map((task) => [task.id, task] as const));
  const merged = incoming.map((task) => {
    const existing = currentById.get(task.id);
    currentById.delete(task.id);
    return existing ? preferLatestDesignTask(existing, task) : task;
  });
  return [...merged, ...currentById.values()];
}

const ACTIVE_STAGES = new Set<DesignTaskStage>(['goal_setting', 'solution_draft', 'review', 'error']);
const GRAPH_STAGES = new Set<DesignTaskStage>(['graph_draft', 'approved', 'executing']);

function taskSort(a: DesignTask, b: DesignTask): number {
  const aNeedsAction = a.status === 'error' || !!a.lastError;
  const bNeedsAction = b.status === 'error' || !!b.lastError;
  if (aNeedsAction !== bNeedsAction) return aNeedsAction ? -1 : 1;
  return b.updatedTs - a.updatedTs || b.id - a.id;
}

export function groupDesignTasks(tasks: DesignTask[]): Record<'active' | 'graph' | 'closed', DesignTask[]> {
  const grouped: Record<'active' | 'graph' | 'closed', DesignTask[]> = { active: [], graph: [], closed: [] };
  for (const task of tasks) {
    if (ACTIVE_STAGES.has(task.stage)) grouped.active.push(task);
    else if (GRAPH_STAGES.has(task.stage)) grouped.graph.push(task);
    else grouped.closed.push(task);
  }
  grouped.active.sort(taskSort);
  grouped.graph.sort(taskSort);
  grouped.closed.sort(taskSort);
  return grouped;
}

export function sortedDesignTasks(tasks: DesignTask[]): DesignTask[] {
  const grouped = groupDesignTasks(tasks);
  return [...grouped.active, ...grouped.graph, ...grouped.closed];
}

export function resolveDesignSelection(input: {
  requestedId?: number;
  tasks: DesignTask[] | null;
  wide: boolean;
}): { selectedId: number | null; stale: boolean; shouldReplaceRoute: boolean } {
  if (input.tasks === null) return { selectedId: null, stale: false, shouldReplaceRoute: false };
  const ordered = sortedDesignTasks(input.tasks);
  if (input.requestedId !== undefined) {
    if (ordered.some((task) => task.id === input.requestedId)) {
      return { selectedId: input.requestedId, stale: false, shouldReplaceRoute: false };
    }
    return { selectedId: ordered[0]?.id ?? null, stale: true, shouldReplaceRoute: true };
  }
  if (!input.wide) return { selectedId: null, stale: false, shouldReplaceRoute: false };
  return { selectedId: ordered[0]?.id ?? null, stale: false, shouldReplaceRoute: ordered.length > 0 };
}

export interface DesignCreateInput {
  title: string;
  originalRequest: string;
  moduleId: number | null;
  agent: AgentKind;
}

export function designCreateFingerprint(input: DesignCreateInput): string {
  return JSON.stringify([input.title.trim(), input.originalRequest, input.moduleId, input.agent]);
}

export type DesignOutputTab = 'document' | 'graph' | 'assets';
export type DesignMobilePane =
  | { kind: 'conversation' }
  | { kind: 'output'; tab: DesignOutputTab };
export type DesignMobilePaneAction =
  | { type: 'show-conversation' }
  | { type: 'show-output'; tab: DesignOutputTab };

export function reduceDesignMobilePane(
  _state: DesignMobilePane,
  action: DesignMobilePaneAction,
): DesignMobilePane {
  return action.type === 'show-conversation'
    ? { kind: 'conversation' }
    : { kind: 'output', tab: action.tab };
}

export function graphSemanticRows(graph: DesignGraph): {
  nodeId: string;
  title: string;
  prerequisiteTitles: string[];
  issueId: number | null;
}[] {
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node] as const));
  return [...graph.nodes]
    .sort((a, b) => a.ordinal - b.ordinal || a.nodeId.localeCompare(b.nodeId))
    .map((node) => ({
      nodeId: node.nodeId,
      title: node.title,
      prerequisiteTitles: graph.edges
        .filter((edge) => edge.toNodeId === node.nodeId)
        .map((edge) => byId.get(edge.fromNodeId)?.title)
        .filter((title): title is string => !!title),
      issueId: node.issueId,
    }));
}

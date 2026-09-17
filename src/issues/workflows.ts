/**
 * 项目工作流模板：图结构的唯一校验入口 + 不可变版本持久化。
 *
 * 本模块只负责模板，不创建 issue 工作流快照、不调度节点。模板更新永远新增版本，旧版本及
 * issue_workflows.graph_json 均不原地改写。
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  AgentKind,
  IssueWorkflowSharedContext,
  IssueWorkflowNodeRun,
  IssueWorkflowRuntime,
  IssueWorkflowSnapshot,
  IssueWorkflowTransition,
  IssueWorkflowWorktree,
  ProjectWorkflowTemplate,
  ProjectWorkflowVersion,
  WorkflowEdgeDefinition,
  WorkflowGraphSnapshot,
  WorkflowNodeDefinition,
  WorkflowNodeExecutionMode,
  WorkflowNodeKind,
} from '../core/types';

export const MAX_WORKFLOW_NAME_LENGTH = 80;
export const MAX_WORKFLOW_DESCRIPTION_LENGTH = 500;
export const MAX_WORKFLOW_NODES = 100;
export const MAX_WORKFLOW_EDGES = 400;
export const MAX_WORKFLOW_INSTRUCTIONS_LENGTH = 8_000;
export const MAX_WORKFLOW_CONDITION_LENGTH = 2_000;
export const MAX_WORKFLOW_LOOP_ITERATIONS = 100;

const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NODE_KINDS = new Set<WorkflowNodeKind>(['issue', 'agent', 'fork', 'join', 'end']);
const EXECUTION_MODES = new Set<WorkflowNodeExecutionMode>(['read', 'write']);

export interface WorkflowValidationIssue {
  code: string;
  nodeKey?: string;
  edgeKey?: string;
  params?: Record<string, string | number>;
}

export type WorkflowGraphValidation =
  | { ok: true; graph: WorkflowGraphSnapshot; graphJson: string; graphHash: string }
  | { ok: false; issues: WorkflowValidationIssue[] };

export interface WorkflowTemplateDetail {
  template: ProjectWorkflowTemplate;
  version: ProjectWorkflowVersion;
  nodeCount: number;
  edgeCount: number;
}

export interface CreateWorkflowTemplateInput {
  projectId: number;
  name: string;
  description?: string | null;
  graph: WorkflowGraphSnapshot;
  graphJson: string;
  graphHash: string;
  createdBy?: number | null;
}

interface TemplateRow {
  id: number;
  sync_uid?: string | null;
  project_id: number;
  name: string;
  description: string | null;
  status: string;
  current_version: number;
  created_by: number | null;
  created_ts: number;
  updated_ts: number;
}

interface VersionRow {
  id: number;
  template_id: number;
  version: number;
  graph_json: string;
  graph_hash: string;
  created_by: number | null;
  created_ts: number;
}

interface IssueWorkflowRow {
  id: number;
  issue_id: number;
  template_id: number | null;
  template_version_id: number | null;
  template_name: string;
  template_version: number;
  graph_json: string;
  graph_hash: string;
  context_json: string;
  status: string;
  pause_reason: string | null;
  max_loop_iterations: number;
  created_ts: number;
  updated_ts: number;
  started_ts: number | null;
  completed_ts: number | null;
}

interface NodeRunRuntimeRow {
  id: number; issue_workflow_id: number; node_key: string; attempt: number; iteration: number;
  token_key: string; parent_run_id: number | null; predecessor_run_ids_json: string | null;
  parallel_group_key: string | null; agent: string | null; conversation_id: string | null;
  status: string; selected_edge_keys_json: string | null; output_text: string | null;
  route_reason: string | null; error_code: string | null; error_details: string | null;
  created_ts: number; updated_ts: number; started_ts: number | null; finished_ts: number | null;
}

interface TransitionRuntimeRow {
  id: number; issue_workflow_id: number; from_run_id: number; edge_key: string;
  to_node_key: string; decision_text: string | null; iteration: number;
  parallel_group_key: string | null; created_ts: number;
}

interface WorktreeRuntimeRow {
  id: number; issue_workflow_id: number; node_run_id: number; path: string; branch: string;
  base_ref: string; base_sha: string | null; head_sha: string | null; status: string;
  conflict_details: string | null; resolution_conversation_id: string | null;
  created_ts: number; updated_ts: number; merged_ts: number | null; cleaned_ts: number | null;
}

function stringArray(value: string | null): string[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function numberArray(value: string | null): number[] {
  try {
    const parsed = JSON.parse(value ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((item): item is number => Number.isInteger(item) && item > 0) : [];
  } catch {
    return [];
  }
}

function mapRuntimeRun(row: NodeRunRuntimeRow): IssueWorkflowNodeRun {
  return {
    id: row.id, issueWorkflowId: row.issue_workflow_id, nodeKey: row.node_key,
    attempt: row.attempt, iteration: row.iteration, tokenKey: row.token_key,
    parentRunId: row.parent_run_id, predecessorRunIds: numberArray(row.predecessor_run_ids_json),
    parallelGroupKey: row.parallel_group_key,
    agent: row.agent === 'claude' || row.agent === 'codex' ? row.agent : null,
    conversationId: row.conversation_id,
    status: row.status as IssueWorkflowNodeRun['status'],
    selectedEdgeKeys: stringArray(row.selected_edge_keys_json), outputText: row.output_text,
    routeReason: row.route_reason, errorCode: row.error_code, errorDetails: row.error_details,
    createdTs: row.created_ts, updatedTs: row.updated_ts,
    startedTs: row.started_ts, finishedTs: row.finished_ts,
  };
}

function mapRuntimeTransition(row: TransitionRuntimeRow): IssueWorkflowTransition {
  return {
    id: row.id, issueWorkflowId: row.issue_workflow_id, fromRunId: row.from_run_id,
    edgeKey: row.edge_key, toNodeKey: row.to_node_key, decisionText: row.decision_text,
    iteration: row.iteration, parallelGroupKey: row.parallel_group_key, createdTs: row.created_ts,
  };
}

function mapRuntimeWorktree(row: WorktreeRuntimeRow): IssueWorkflowWorktree {
  return {
    id: row.id, issueWorkflowId: row.issue_workflow_id, nodeRunId: row.node_run_id,
    path: row.path, branch: row.branch, baseRef: row.base_ref, baseSha: row.base_sha,
    headSha: row.head_sha, status: row.status as IssueWorkflowWorktree['status'],
    conflictDetails: row.conflict_details, resolutionConversationId: row.resolution_conversation_id,
    createdTs: row.created_ts, updatedTs: row.updated_ts, mergedTs: row.merged_ts,
    cleanedTs: row.cleaned_ts,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max ? text : undefined;
}

function finiteNumber(value: unknown, fallback: number): number | null {
  const n = value === undefined ? fallback : Number(value);
  return Number.isFinite(n) && Math.abs(n) <= 100_000 ? n : null;
}

function positiveInteger(value: unknown, fallback: number, max: number): number | null {
  const n = value === undefined ? fallback : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : null;
}

function mapTemplate(row: TemplateRow): ProjectWorkflowTemplate {
  return {
    id: row.id,
    ...(row.sync_uid ? { syncUid: row.sync_uid } : {}),
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    status: row.status === 'archived' ? 'archived' : 'active',
    currentVersion: row.current_version,
    createdBy: row.created_by,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function graphOf(json: string): WorkflowGraphSnapshot {
  return JSON.parse(json) as WorkflowGraphSnapshot;
}

function mapVersion(row: VersionRow): ProjectWorkflowVersion {
  return {
    id: row.id,
    templateId: row.template_id,
    version: row.version,
    graph: graphOf(row.graph_json),
    graphHash: row.graph_hash,
    createdBy: row.created_by,
    createdTs: row.created_ts,
  };
}

export function hashWorkflowGraph(graphJson: string): string {
  return createHash('sha256').update(graphJson).digest('hex');
}

function mapIssueWorkflow(row: IssueWorkflowRow): IssueWorkflowSnapshot {
  return {
    id: row.id,
    issueId: row.issue_id,
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    templateName: row.template_name,
    templateVersion: row.template_version,
    graph: graphOf(row.graph_json),
    graphHash: row.graph_hash,
    context: JSON.parse(row.context_json) as IssueWorkflowSharedContext,
    status:
      row.status === 'running' || row.status === 'paused' || row.status === 'completed' ||
      row.status === 'failed' || row.status === 'cancelled'
        ? row.status
        : 'pending',
    pauseReason: row.pause_reason,
    maxLoopIterations: row.max_loop_iterations,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    startedTs: row.started_ts,
    completedTs: row.completed_ts,
  };
}

function nodeFrom(value: unknown, issues: WorkflowValidationIssue[], index: number): WorkflowNodeDefinition | null {
  const row = record(value);
  if (!row) {
    issues.push({ code: 'workflow.node_invalid', params: { index } });
    return null;
  }
  const key = typeof row.key === 'string' ? row.key.trim() : '';
  const kind = typeof row.kind === 'string' && NODE_KINDS.has(row.kind as WorkflowNodeKind)
    ? (row.kind as WorkflowNodeKind)
    : null;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const instructions = optionalText(row.instructions, MAX_WORKFLOW_INSTRUCTIONS_LENGTH);
  const agent = row.agent === 'claude' || row.agent === 'codex' ? row.agent : row.agent == null ? null : undefined;
  const executionMode = typeof row.executionMode === 'string' && EXECUTION_MODES.has(row.executionMode as WorkflowNodeExecutionMode)
    ? (row.executionMode as WorkflowNodeExecutionMode)
    : null;
  const maxVisits = positiveInteger(row.maxVisits, 1, MAX_WORKFLOW_LOOP_ITERATIONS);
  const positionX = finiteNumber(row.positionX, 0);
  const positionY = finiteNumber(row.positionY, 0);
  const config = row.config == null ? null : record(row.config);
  if (
    !KEY_RE.test(key) || !kind || !title || title.length > 120 || instructions === undefined ||
    agent === undefined || !executionMode || maxVisits === null || positionX === null ||
    positionY === null || (row.config != null && !config) ||
    (config && JSON.stringify(config).length > 4_000)
  ) {
    issues.push({ code: 'workflow.node_invalid', ...(key ? { nodeKey: key } : {}), params: { index } });
    return null;
  }
  return { key, kind, title, instructions, agent, executionMode, maxVisits, positionX, positionY, config };
}

function edgeFrom(value: unknown, issues: WorkflowValidationIssue[], index: number): WorkflowEdgeDefinition | null {
  const row = record(value);
  if (!row) {
    issues.push({ code: 'workflow.edge_invalid', params: { index } });
    return null;
  }
  const key = typeof row.key === 'string' ? row.key.trim() : '';
  const fromNodeKey = typeof row.fromNodeKey === 'string' ? row.fromNodeKey.trim() : '';
  const toNodeKey = typeof row.toNodeKey === 'string' ? row.toNodeKey.trim() : '';
  const conditionText = optionalText(row.conditionText, MAX_WORKFLOW_CONDITION_LENGTH);
  const priority = row.priority === undefined ? 0 : Number(row.priority);
  const isDefault = row.isDefault === undefined ? false : row.isDefault;
  if (
    !KEY_RE.test(key) || !KEY_RE.test(fromNodeKey) || !KEY_RE.test(toNodeKey) ||
    conditionText === undefined || !Number.isInteger(priority) || Math.abs(priority) > 10_000 ||
    typeof isDefault !== 'boolean'
  ) {
    issues.push({ code: 'workflow.edge_invalid', ...(key ? { edgeKey: key } : {}), params: { index } });
    return null;
  }
  return { key, fromNodeKey, toNodeKey, conditionText, priority, isDefault };
}

function reachable(start: string, outgoing: Map<string, WorkflowEdgeDefinition[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    const key = queue.shift()!;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const edge of outgoing.get(key) ?? []) queue.push(edge.toNodeKey);
  }
  return seen;
}

function canReach(start: string, target: string, outgoing: Map<string, WorkflowEdgeDefinition[]>): boolean {
  const seen = new Set<string>();
  const queue = [...(outgoing.get(start) ?? []).map((edge) => edge.toNodeKey)];
  while (queue.length) {
    const key = queue.shift()!;
    if (key === target) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const edge of outgoing.get(key) ?? []) queue.push(edge.toNodeKey);
  }
  return false;
}

/**
 * 解析并验证外部图。返回值已经归一化，可直接持久化；调用方不得绕过此入口写模板版本。
 */
export function validateWorkflowGraph(
  input: unknown,
  supportedAgents: readonly AgentKind[],
): WorkflowGraphValidation {
  const issues: WorkflowValidationIssue[] = [];
  const root = record(input);
  if (!root) return { ok: false, issues: [{ code: 'workflow.graph_required' }] };
  if (root.schemaVersion !== 1) issues.push({ code: 'workflow.schema_version_invalid' });
  const entryNodeKey = typeof root.entryNodeKey === 'string' ? root.entryNodeKey.trim() : '';
  const maxLoopIterations = positiveInteger(root.maxLoopIterations, 10, MAX_WORKFLOW_LOOP_ITERATIONS);
  if (!KEY_RE.test(entryNodeKey)) issues.push({ code: 'workflow.entry_invalid' });
  if (maxLoopIterations === null) issues.push({ code: 'workflow.loop_limit_invalid' });

  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  if (rawNodes.length < 2 || rawNodes.length > MAX_WORKFLOW_NODES) {
    issues.push({ code: 'workflow.node_count_invalid', params: { max: MAX_WORKFLOW_NODES } });
  }
  if (rawEdges.length < 1 || rawEdges.length > MAX_WORKFLOW_EDGES) {
    issues.push({ code: 'workflow.edge_count_invalid', params: { max: MAX_WORKFLOW_EDGES } });
  }
  const nodes = rawNodes.slice(0, MAX_WORKFLOW_NODES + 1)
    .map((node, index) => nodeFrom(node, issues, index))
    .filter((node): node is WorkflowNodeDefinition => node !== null);
  const edges = rawEdges.slice(0, MAX_WORKFLOW_EDGES + 1)
    .map((edge, index) => edgeFrom(edge, issues, index))
    .filter((edge): edge is WorkflowEdgeDefinition => edge !== null);

  const byNode = new Map<string, WorkflowNodeDefinition>();
  for (const node of nodes) {
    if (byNode.has(node.key)) issues.push({ code: 'workflow.node_key_duplicate', nodeKey: node.key });
    else byNode.set(node.key, node);
  }
  const byEdge = new Set<string>();
  for (const edge of edges) {
    if (byEdge.has(edge.key)) issues.push({ code: 'workflow.edge_key_duplicate', edgeKey: edge.key });
    byEdge.add(edge.key);
    if (!byNode.has(edge.fromNodeKey) || !byNode.has(edge.toNodeKey)) {
      issues.push({ code: 'workflow.edge_node_missing', edgeKey: edge.key });
    }
  }

  const issueNodes = nodes.filter((node) => node.kind === 'issue');
  if (issueNodes.length !== 1) issues.push({ code: 'workflow.issue_node_count_invalid' });
  const entry = byNode.get(entryNodeKey);
  if (!entry || entry.kind !== 'issue' || issueNodes[0]?.key !== entryNodeKey) {
    issues.push({ code: 'workflow.entry_must_be_issue', ...(entryNodeKey ? { nodeKey: entryNodeKey } : {}) });
  }

  const available = new Set(supportedAgents);
  for (const node of nodes) {
    if (node.kind === 'agent') {
      if (!node.agent) issues.push({ code: 'workflow.agent_required', nodeKey: node.key });
      else if (!available.has(node.agent)) {
        issues.push({ code: 'workflow.agent_unavailable', nodeKey: node.key, params: { agent: node.agent } });
      }
    } else {
      if (node.agent !== null) issues.push({ code: 'workflow.control_agent_forbidden', nodeKey: node.key });
      if (node.executionMode !== 'read') issues.push({ code: 'workflow.control_write_forbidden', nodeKey: node.key });
    }
  }

  const outgoing = new Map<string, WorkflowEdgeDefinition[]>();
  const incoming = new Map<string, WorkflowEdgeDefinition[]>();
  for (const key of byNode.keys()) {
    outgoing.set(key, []);
    incoming.set(key, []);
  }
  for (const edge of edges) {
    if (!byNode.has(edge.fromNodeKey) || !byNode.has(edge.toNodeKey)) continue;
    outgoing.get(edge.fromNodeKey)!.push(edge);
    incoming.get(edge.toNodeKey)!.push(edge);
  }
  for (const list of outgoing.values()) list.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));

  const endNodes = nodes.filter((node) => node.kind === 'end');
  if (endNodes.length < 1) issues.push({ code: 'workflow.end_required' });
  for (const node of nodes) {
    const outs = outgoing.get(node.key) ?? [];
    const ins = incoming.get(node.key) ?? [];
    if (node.kind === 'issue') {
      if (ins.length !== 0 || outs.length !== 1) issues.push({ code: 'workflow.issue_degree_invalid', nodeKey: node.key });
    } else if (node.kind === 'fork') {
      if (outs.length < 2) issues.push({ code: 'workflow.fork_degree_invalid', nodeKey: node.key });
      if (outs.some((edge) => edge.conditionText !== null || edge.isDefault)) {
        issues.push({ code: 'workflow.fork_edge_conditional', nodeKey: node.key });
      }
      const joinKey = typeof node.config?.joinNodeKey === 'string' ? node.config.joinNodeKey : '';
      const join = byNode.get(joinKey);
      if (!joinKey || join?.kind !== 'join') {
        issues.push({ code: 'workflow.fork_join_invalid', nodeKey: node.key });
      } else {
        for (const edge of outs) {
          if (edge.toNodeKey !== joinKey && !canReach(edge.toNodeKey, joinKey, outgoing)) {
            issues.push({ code: 'workflow.fork_branch_misses_join', nodeKey: node.key, edgeKey: edge.key, params: { joinKey } });
          }
        }
      }
    } else if (node.kind === 'join') {
      if (ins.length < 2 || outs.length !== 1) issues.push({ code: 'workflow.join_degree_invalid', nodeKey: node.key });
    } else if (node.kind === 'end') {
      if (outs.length !== 0) issues.push({ code: 'workflow.end_degree_invalid', nodeKey: node.key });
    } else if (outs.length < 1) {
      issues.push({ code: 'workflow.agent_degree_invalid', nodeKey: node.key });
    }

    if (node.kind === 'agent' && outs.length > 1) {
      const defaults = outs.filter((edge) => edge.isDefault);
      if (defaults.length !== 1) issues.push({ code: 'workflow.default_edge_required', nodeKey: node.key });
      for (const edge of outs) {
        if (!edge.isDefault && !edge.conditionText) {
          issues.push({ code: 'workflow.condition_required', nodeKey: node.key, edgeKey: edge.key });
        }
      }
    } else if (outs.filter((edge) => edge.isDefault).length > 1) {
      issues.push({ code: 'workflow.default_edge_duplicate', nodeKey: node.key });
    }
  }

  if (entry) {
    const fromEntry = reachable(entry.key, outgoing);
    for (const node of nodes) {
      if (!fromEntry.has(node.key)) issues.push({ code: 'workflow.node_unreachable', nodeKey: node.key });
    }
  }
  if (endNodes.length) {
    const reverse = new Map<string, WorkflowEdgeDefinition[]>();
    for (const key of byNode.keys()) reverse.set(key, []);
    for (const edge of edges) {
      if (byNode.has(edge.fromNodeKey) && byNode.has(edge.toNodeKey)) {
        reverse.get(edge.toNodeKey)!.push({ ...edge, toNodeKey: edge.fromNodeKey });
      }
    }
    const canFinish = new Set<string>();
    for (const end of endNodes) {
      for (const key of reachable(end.key, reverse)) canFinish.add(key);
    }
    for (const node of nodes) {
      if (!canFinish.has(node.key)) issues.push({ code: 'workflow.node_cannot_finish', nodeKey: node.key });
    }
  }

  const cyclic = nodes.filter((node) => canReach(node.key, node.key, outgoing));
  if (cyclic.length && (maxLoopIterations ?? 1) < 2) issues.push({ code: 'workflow.loop_limit_required' });
  for (const node of cyclic) {
    if (node.maxVisits < 2) issues.push({ code: 'workflow.cycle_node_limit_required', nodeKey: node.key });
  }

  if (issues.length || maxLoopIterations === null) return { ok: false, issues };
  const graph: WorkflowGraphSnapshot = {
    schemaVersion: 1,
    entryNodeKey,
    maxLoopIterations,
    nodes,
    edges,
  };
  const graphJson = JSON.stringify(graph);
  return { ok: true, graph, graphJson, graphHash: hashWorkflowGraph(graphJson) };
}

function persistGraph(
  db: Database,
  versionId: number,
  graph: WorkflowGraphSnapshot,
  createdTs: number,
): void {
  const insertNode = db.query(
    `INSERT INTO project_workflow_nodes
       (version_id, node_key, kind, title, instructions, agent, execution_mode, max_visits,
        position_x, position_y, config_json, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const node of graph.nodes) {
    insertNode.run(
      versionId,
      node.key,
      node.kind,
      node.title,
      node.instructions,
      node.agent,
      node.executionMode,
      node.maxVisits,
      node.positionX,
      node.positionY,
      node.config === null ? null : JSON.stringify(node.config),
      createdTs,
    );
  }
  const insertEdge = db.query(
    `INSERT INTO project_workflow_edges
       (version_id, edge_key, from_node_key, to_node_key, condition_text, priority, is_default, created_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const edge of graph.edges) {
    insertEdge.run(
      versionId,
      edge.key,
      edge.fromNodeKey,
      edge.toNodeKey,
      edge.conditionText,
      edge.priority,
      edge.isDefault ? 1 : 0,
      createdTs,
    );
  }
}

export class WorkflowTemplateStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private template(projectId: number, templateId: number): TemplateRow | null {
    return this.db
      .query<TemplateRow, [number, number]>(
        'SELECT * FROM project_workflow_templates WHERE project_id = ? AND id = ?',
      )
      .get(projectId, templateId) ?? null;
  }

  private version(templateId: number, version: number): VersionRow | null {
    return this.db
      .query<VersionRow, [number, number]>(
        'SELECT * FROM project_workflow_versions WHERE template_id = ? AND version = ?',
      )
      .get(templateId, version) ?? null;
  }

  private detail(row: TemplateRow): WorkflowTemplateDetail | null {
    const version = this.version(row.id, row.current_version);
    if (!version) return null;
    const counts = this.db
      .query<{ nodes: number; edges: number }, [number, number]>(
        `SELECT
           (SELECT COUNT(*) FROM project_workflow_nodes WHERE version_id = ?) AS nodes,
           (SELECT COUNT(*) FROM project_workflow_edges WHERE version_id = ?) AS edges`,
      )
      .get(version.id, version.id)!;
    return {
      template: mapTemplate(row),
      version: mapVersion(version),
      nodeCount: counts.nodes,
      edgeCount: counts.edges,
    };
  }

  list(projectId: number): WorkflowTemplateDetail[] {
    return this.db
      .query<TemplateRow, [number]>(
        `SELECT * FROM project_workflow_templates
         WHERE project_id = ? ORDER BY status = 'archived', updated_ts DESC, id DESC`,
      )
      .all(projectId)
      .map((row) => this.detail(row))
      .filter((value): value is WorkflowTemplateDetail => value !== null);
  }

  get(projectId: number, templateId: number): WorkflowTemplateDetail | null {
    const row = this.template(projectId, templateId);
    return row ? this.detail(row) : null;
  }

  /** 只允许选择当前项目的 active 模板；Agent 可用性由调用方用 validateWorkflowGraph 重校。 */
  selectable(projectId: number, templateId: number): WorkflowTemplateDetail | null {
    const detail = this.get(projectId, templateId);
    return detail?.template.status === 'active' ? detail : null;
  }

  issueWorkflow(issueId: number): IssueWorkflowSnapshot | null {
    const row = this.db
      .query<IssueWorkflowRow, [number]>('SELECT * FROM issue_workflows WHERE issue_id = ?')
      .get(issueId);
    return row ? mapIssueWorkflow(row) : null;
  }

  issueWorkflowRuntime(issueId: number): IssueWorkflowRuntime | null {
    const workflow = this.issueWorkflow(issueId);
    if (!workflow) return null;
    const runs = this.db
      .query<NodeRunRuntimeRow, [number]>(
        'SELECT * FROM issue_workflow_node_runs WHERE issue_workflow_id = ? ORDER BY id',
      )
      .all(workflow.id)
      .map(mapRuntimeRun);
    const transitions = this.db
      .query<TransitionRuntimeRow, [number]>(
        'SELECT * FROM issue_workflow_transitions WHERE issue_workflow_id = ? ORDER BY id',
      )
      .all(workflow.id)
      .map(mapRuntimeTransition);
    const worktrees = this.db
      .query<WorktreeRuntimeRow, [number]>(
        'SELECT * FROM issue_workflow_worktrees WHERE issue_workflow_id = ? ORDER BY id',
      )
      .all(workflow.id)
      .map(mapRuntimeWorktree);
    return { workflow, runs, transitions, worktrees };
  }

  /** 必须与 issues 行在同一数据库事务内调用。 */
  attachIssue(
    issueId: number,
    detail: WorkflowTemplateDetail,
    context: IssueWorkflowSharedContext,
  ): IssueWorkflowSnapshot {
    const ts = this.now();
    const graphJson = JSON.stringify(detail.version.graph);
    this.db
      .query(
        `INSERT INTO issue_workflows
           (issue_id, template_id, template_version_id, template_name, template_version,
            graph_json, graph_hash, context_json, max_loop_iterations, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        issueId,
        detail.template.id,
        detail.version.id,
        detail.template.name,
        detail.version.version,
        graphJson,
        detail.version.graphHash,
        JSON.stringify(context),
        detail.version.graph.maxLoopIterations,
        ts,
        ts,
      );
    return this.issueWorkflow(issueId)!;
  }

  create(input: CreateWorkflowTemplateInput): WorkflowTemplateDetail {
    const ts = this.now();
    const create = this.db.transaction(() => {
      const template = this.db
        .query<{ id: number }, [number, string, string | null, number | null, number, number]>(
          `INSERT INTO project_workflow_templates
             (project_id, name, description, current_version, created_by, created_ts, updated_ts)
           VALUES (?, ?, ?, 1, ?, ?, ?) RETURNING id`,
        )
        .get(input.projectId, input.name, input.description ?? null, input.createdBy ?? null, ts, ts)!;
      const version = this.db
        .query<{ id: number }, [number, string, string, number | null, number]>(
          `INSERT INTO project_workflow_versions
             (template_id, version, graph_json, graph_hash, created_by, created_ts)
           VALUES (?, 1, ?, ?, ?, ?) RETURNING id`,
        )
        .get(template.id, input.graphJson, input.graphHash, input.createdBy ?? null, ts)!;
      persistGraph(this.db, version.id, input.graph, ts);
      return template.id;
    });
    return this.get(input.projectId, create())!;
  }

  publish(
    projectId: number,
    templateId: number,
    graph: WorkflowGraphSnapshot,
    graphJson: string,
    graphHash: string,
    createdBy?: number | null,
  ): WorkflowTemplateDetail | null {
    const ts = this.now();
    const publish = this.db.transaction(() => {
      const current = this.template(projectId, templateId);
      if (!current) return false;
      const next = current.current_version + 1;
      const version = this.db
        .query<{ id: number }, [number, number, string, string, number | null, number]>(
          `INSERT INTO project_workflow_versions
             (template_id, version, graph_json, graph_hash, created_by, created_ts)
           VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(templateId, next, graphJson, graphHash, createdBy ?? null, ts)!;
      persistGraph(this.db, version.id, graph, ts);
      this.db
        .query('UPDATE project_workflow_templates SET current_version = ?, updated_ts = ? WHERE id = ?')
        .run(next, ts, templateId);
      return true;
    });
    return publish() ? this.get(projectId, templateId) : null;
  }

  rename(
    projectId: number,
    templateId: number,
    patch: { name?: string; description?: string | null; status?: 'active' | 'archived' },
  ): WorkflowTemplateDetail | null {
    const row = this.template(projectId, templateId);
    if (!row) return null;
    this.db
      .query(
        `UPDATE project_workflow_templates SET
           name = ?, description = ?, status = ?, updated_ts = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        patch.name ?? row.name,
        patch.description !== undefined ? patch.description : row.description,
        patch.status ?? row.status,
        this.now(),
        templateId,
        projectId,
      );
    return this.get(projectId, templateId);
  }

  copy(
    projectId: number,
    templateId: number,
    name: string,
    createdBy?: number | null,
  ): WorkflowTemplateDetail | null {
    const source = this.get(projectId, templateId);
    if (!source) return null;
    const graphJson = JSON.stringify(source.version.graph);
    return this.create({
      projectId,
      name,
      description: source.template.description,
      graph: source.version.graph,
      graphJson,
      graphHash: hashWorkflowGraph(graphJson),
      createdBy,
    });
  }

  delete(projectId: number, templateId: number): boolean {
    return this.db
      .query('DELETE FROM project_workflow_templates WHERE id = ? AND project_id = ?')
      .run(templateId, projectId).changes > 0;
  }
}

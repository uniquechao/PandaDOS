import type { MessageKey } from '../../../shared/i18n/messages';
import type {
  IssueWorkflowStatus,
  WorkflowNodeRunStatus,
  WorkflowValidationCode,
  WorkflowWorktreeStatus,
} from './types';

export type WorkflowGraphNodeState = WorkflowNodeRunStatus | 'idle';

const ISSUE_STATUS_KEYS: Record<IssueWorkflowStatus, MessageKey> = {
  pending: 'status.pending',
  running: 'status.implementing',
  paused: 'workflow.state.paused',
  completed: 'status.done',
  failed: 'workflow.state.failed',
  cancelled: 'status.cancelled',
};

const NODE_STATUS_KEYS: Record<WorkflowGraphNodeState, MessageKey> = {
  idle: 'workflow.state.idle',
  queued: 'workflow.state.queued',
  running: 'status.implementing',
  routing: 'workflow.state.routing',
  waiting_join: 'workflow.state.waitingJoin',
  succeeded: 'workflow.state.succeeded',
  failed: 'workflow.state.failed',
  blocked: 'status.blocked',
  cancelled: 'status.cancelled',
  skipped: 'workflow.state.skipped',
};

const WORKTREE_STATUS_KEYS: Record<WorkflowWorktreeStatus, MessageKey> = {
  preparing: 'workflow.state.preparing',
  active: 'workflow.state.active',
  merging: 'status.merging',
  resolving: 'workflow.state.resolving',
  merged: 'workflow.state.merged',
  paused: 'workflow.state.paused',
  cleanup_pending: 'workflow.state.cleanupPending',
  cleaned: 'workflow.state.cleaned',
  failed: 'workflow.state.failed',
};

type ValidationGroup =
  | 'graph' | 'schema' | 'entry' | 'count' | 'node' | 'edge' | 'agent'
  | 'control' | 'forkJoin' | 'condition' | 'connectivity' | 'loop' | 'end';

const VALIDATION_GROUPS: Record<WorkflowValidationCode, ValidationGroup> = {
  'workflow.graph_required': 'graph',
  'workflow.schema_version_invalid': 'schema',
  'workflow.entry_invalid': 'entry',
  'workflow.entry_must_be_issue': 'entry',
  'workflow.node_count_invalid': 'count',
  'workflow.node_invalid': 'node',
  'workflow.node_key_duplicate': 'node',
  'workflow.edge_count_invalid': 'count',
  'workflow.edge_invalid': 'edge',
  'workflow.edge_key_duplicate': 'edge',
  'workflow.edge_node_missing': 'edge',
  'workflow.issue_node_count_invalid': 'entry',
  'workflow.issue_degree_invalid': 'entry',
  'workflow.agent_required': 'agent',
  'workflow.agent_unavailable': 'agent',
  'workflow.agent_degree_invalid': 'agent',
  'workflow.control_agent_forbidden': 'control',
  'workflow.control_write_forbidden': 'control',
  'workflow.fork_degree_invalid': 'forkJoin',
  'workflow.fork_edge_conditional': 'forkJoin',
  'workflow.fork_join_invalid': 'forkJoin',
  'workflow.fork_branch_misses_join': 'forkJoin',
  'workflow.join_degree_invalid': 'forkJoin',
  'workflow.end_required': 'end',
  'workflow.end_degree_invalid': 'end',
  'workflow.default_edge_required': 'condition',
  'workflow.default_edge_duplicate': 'condition',
  'workflow.condition_required': 'condition',
  'workflow.node_unreachable': 'connectivity',
  'workflow.node_cannot_finish': 'connectivity',
  'workflow.loop_limit_invalid': 'loop',
  'workflow.loop_limit_required': 'loop',
  'workflow.cycle_node_limit_required': 'loop',
};

export function issueWorkflowStatusKey(status: IssueWorkflowStatus): MessageKey {
  return ISSUE_STATUS_KEYS[status];
}

export function workflowNodeStatusKey(status: WorkflowGraphNodeState): MessageKey {
  return NODE_STATUS_KEYS[status];
}

export function workflowWorktreeStatusKey(status: WorkflowWorktreeStatus): MessageKey {
  return WORKTREE_STATUS_KEYS[status];
}

export function workflowValidationKey(code: string): MessageKey {
  const group = VALIDATION_GROUPS[code as WorkflowValidationCode] ?? 'graph';
  return `workflow.validation.${group}` as MessageKey;
}

import { describe, expect, test } from 'bun:test';
import {
  issueWorkflowStatusKey,
  workflowNodeStatusKey,
  workflowValidationKey,
  workflowWorktreeStatusKey,
} from './workflow';

describe('工作流前端类型映射', () => {
  test('issue、节点与 worktree 状态使用专属本地化键', () => {
    expect(issueWorkflowStatusKey('paused')).toBe('workflow.state.paused');
    expect(issueWorkflowStatusKey('failed')).toBe('workflow.state.failed');
    expect(workflowNodeStatusKey('waiting_join')).toBe('workflow.state.waitingJoin');
    expect(workflowNodeStatusKey('routing')).toBe('workflow.state.routing');
    expect(workflowWorktreeStatusKey('resolving')).toBe('workflow.state.resolving');
    expect(workflowWorktreeStatusKey('cleanup_pending')).toBe('workflow.state.cleanupPending');
  });

  test('结构错误按语义分类，未知服务端代码安全回退为图结构提示', () => {
    expect(workflowValidationKey('workflow.agent_unavailable')).toBe('workflow.validation.agent');
    expect(workflowValidationKey('workflow.fork_branch_misses_join')).toBe('workflow.validation.forkJoin');
    expect(workflowValidationKey('workflow.cycle_node_limit_required')).toBe('workflow.validation.loop');
    expect(workflowValidationKey('workflow.future_code')).toBe('workflow.validation.graph');
  });
});

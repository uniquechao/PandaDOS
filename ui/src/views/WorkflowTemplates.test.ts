import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  addWorkflowNode,
  connectWorkflowNodes,
  createStarterWorkflowGraph,
  moveWorkflowNode,
  removeWorkflowNode,
} from './WorkflowTemplates';

const source = readFileSync(new URL('./WorkflowTemplates.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

const starter = () => createStarterWorkflowGraph({ issue: 'Issue', agent: 'Implement', end: 'Complete' });

describe('工作流模板图编辑', () => {
  test('新模板具有固定 issue 起点、Agent 节点和结束节点', () => {
    const graph = starter();
    expect(graph.entryNodeKey).toBe('issue');
    expect(graph.nodes.map((node) => node.kind)).toEqual(['issue', 'agent', 'end']);
    expect(graph.edges.map((edge) => [edge.fromNodeKey, edge.toNodeKey])).toEqual([
      ['issue', 'agent-1'], ['agent-1', 'end'],
    ]);
  });

  test('增删节点同步维护唯一 key 和关联连线', () => {
    let graph = addWorkflowNode(starter(), 'agent', 'Review');
    graph = addWorkflowNode(graph, 'agent', 'Fix');
    expect(graph.nodes.slice(-2).map((node) => node.key)).toEqual(['agent-2', 'agent-3']);
    graph = connectWorkflowNodes(graph, 'agent-2', 'agent-3');
    expect(graph.edges.at(-1)?.key).toBe('edge-3');
    expect(removeWorkflowNode(graph, 'agent-2').edges.some((edge) => edge.fromNodeKey === 'agent-2')).toBeFalse();
    expect(removeWorkflowNode(graph, 'issue')).toBe(graph);
  });

  test('拖拽与键盘共用位置更新并限制在画布范围内', () => {
    const graph = moveWorkflowNode(starter(), 'agent-1', -100, 99_999);
    const node = graph.nodes.find((item) => item.key === 'agent-1');
    expect(node?.positionX).toBe(16);
    expect(node?.positionY).toBe(648);
  });
});

describe('工作流模板维护页契约', () => {
  test('接入完整模板接口和配置入口', () => {
    expect(source).toContain('`/api/projects/${pid}/workflows`');
    expect(source).toContain('/copy`, \'POST\'');
    expect(source).toContain("'PATCH'");
    expect(source).toContain("'PUT'");
    expect(source).toContain("'DELETE'");
    expect(source).toContain('/workflows/validate`');
  });

  test('画布支持缩放、拖拽和方向键移动，并提供语义名称', () => {
    expect(source).toContain('role="application"');
    expect(source).toContain("t('workflow.canvasAria')");
    expect(source).toContain('onPointerDown');
    expect(source).toContain('setPointerCapture');
    expect(source).toContain('ArrowLeft');
    expect(source).toContain('event.shiftKey ? 48 : 12');
    expect(source).toContain('aria-pressed');
    expect(source).toContain("t('workflow.templateAria'");
    expect(source).toContain("t('workflow.edgeAria'");
  });

  test('结构错误使用本地化语义映射而非直接展示稳定错误码', () => {
    expect(source).toContain('workflowValidationKey(item.code)');
    expect(source).toContain("t('workflow.validationMessage'");
    expect(source).not.toContain("t('workflow.validationItem', { target, code: item.code })");
  });

  test('PandaDOS 视觉、窄屏和减弱动效规则齐全', () => {
    expect(styles).toContain('.wf-layout {');
    expect(styles).toContain('background: var(--card)');
    expect(styles).toContain('border: 1px solid var(--line)');
    expect(styles).toContain('.wf-node.on { border-color: var(--accent)');
    expect(styles).toContain('@media (max-width: 760px)');
    expect(styles).toContain('.wf-layout { flex: none; display: flex; flex-direction: column;');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('.wf-template:focus-visible');
    expect(styles).toContain('min-height: 44px');
  });
});

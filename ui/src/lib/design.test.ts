import { describe, expect, test } from 'bun:test';
import { DESIGN_EVENT_KINDS as BACKEND_DESIGN_EVENT_KINDS } from '../../../src/designs/types';
import {
  DESIGN_EVENT_LABEL_KEYS,
  LatestOnlyRequestGuard,
  designEventLabelKey,
  designCreateFingerprint,
  groupDesignTasks,
  graphSemanticRows,
  graphRankLayout,
  isCompletePublishConfirmation,
  mergeWorkbenchDesignTask,
  mergeLatestDesignTasks,
  preferLatestDesignTask,
  reduceDesignMobilePane,
  resolveDesignSelection,
  type DesignTask,
} from './design';

const task = (id: number, stage: DesignTask['stage'], updatedTs = id): DesignTask => ({
  id,
  projectId: 1,
  moduleId: null,
  title: `Design ${id}`,
  originalRequest: `Need ${id}`,
  agent: 'codex',
  stage,
  status: stage === 'error' ? 'error' : stage === 'archived' ? 'archived' : 'active',
  currentRevision: 0,
  readinessThreshold: 80,
  readinessOverride: false,
  documentJson: null,
  documentMarkdown: null,
  graphGranularity: 'balanced',
  conversationId: null,
  worktreeCwd: null,
  worktreeBranch: null,
  worktreeMetadata: null,
  createdTs: 1,
  updatedTs,
  lastError: stage === 'error' ? 'failure' : null,
});

describe('resolveDesignSelection', () => {
  test('加载前不误判深链失效', () => {
    expect(resolveDesignSelection({ requestedId: 9, tasks: null, wide: true })).toEqual({
      selectedId: null, stale: false, shouldReplaceRoute: false,
    });
  });

  test('桌面列表自动选择最新任务并规范化 URL', () => {
    expect(resolveDesignSelection({ tasks: [task(1, 'goal_setting', 1), task(2, 'review', 4)], wide: true })).toEqual({
      selectedId: 2, stale: false, shouldReplaceRoute: true,
    });
  });

  test('移动端列表保持列表，详情深链只选择命中的任务', () => {
    const tasks = [task(1, 'goal_setting')];
    expect(resolveDesignSelection({ tasks, wide: false })).toEqual({
      selectedId: null, stale: false, shouldReplaceRoute: false,
    });
    expect(resolveDesignSelection({ requestedId: 1, tasks, wide: false })).toEqual({
      selectedId: 1, stale: false, shouldReplaceRoute: false,
    });
  });

  test('失效深链回退并要求 replace', () => {
    expect(resolveDesignSelection({ requestedId: 99, tasks: [task(3, 'review')], wide: false })).toEqual({
      selectedId: 3, stale: true, shouldReplaceRoute: true,
    });
  });
});

test('design rail 按阶段分组且错误优先', () => {
  const grouped = groupDesignTasks([
    task(1, 'completed', 6),
    task(2, 'graph_draft', 4),
    task(3, 'goal_setting', 9),
    task(4, 'error', 1),
  ]);
  expect(grouped.active.map((x) => x.id)).toEqual([4, 3]);
  expect(grouped.graph.map((x) => x.id)).toEqual([2]);
  expect(grouped.closed.map((x) => x.id)).toEqual([1]);
});

test('创建指纹绑定全部请求字段', () => {
  const base = { title: 'A', originalRequest: 'B', moduleId: null, agent: 'codex' as const };
  expect(designCreateFingerprint(base)).toBe(designCreateFingerprint({ ...base }));
  expect(designCreateFingerprint(base)).not.toBe(designCreateFingerprint({ ...base, title: 'C' }));
});

test('移动端 pane reducer 保留 output tab 返回位置', () => {
  expect(reduceDesignMobilePane({ kind: 'conversation' }, { type: 'show-output', tab: 'graph' })).toEqual({
    kind: 'output', tab: 'graph',
  });
  expect(reduceDesignMobilePane({ kind: 'output', tab: 'graph' }, { type: 'show-conversation' })).toEqual({
    kind: 'conversation',
  });
});

test('Graph 语义列表明确展示前置节点到当前节点', () => {
  expect(graphSemanticRows({
    nodes: [
      { nodeId: 'a', title: 'Foundation', ordinal: 0, detail: null, issueId: null, lastSyncedRevision: null },
      { nodeId: 'b', title: 'Feature', ordinal: 1, detail: null, issueId: null, lastSyncedRevision: null },
    ],
    edges: [{ fromNodeId: 'a', toNodeId: 'b', kind: 'depends_on' }],
  })).toEqual([
    { nodeId: 'a', title: 'Foundation', prerequisiteTitles: [], issueId: null },
    { nodeId: 'b', title: 'Feature', prerequisiteTitles: ['Foundation'], issueId: null },
  ]);
});

test('Workbench safe metadata 与 canonical revision 合成完整 task 且不会清空文档', () => {
  const current = { ...task(1, 'solution_draft', 10), currentRevision: 2, documentMarkdown: '# Old' };
  const merged = mergeWorkbenchDesignTask(current, {
    id: 1, projectId: 1, moduleId: null, title: 'Design 1', originalRequest: 'Need 1',
    agent: 'codex', stage: 'review', status: 'active', currentRevision: 3,
    readinessThreshold: 80, readinessOverride: false, graphGranularity: 'small',
    conversationId: null, createdTs: 1, updatedTs: 11,
  }, { revision: 3, documentJson: { goal: 'canonical' }, documentMarkdown: '# Canonical', readiness: 91, createdTs: 11 });
  expect(merged).toMatchObject({ currentRevision: 3, documentMarkdown: '# Canonical', documentJson: { goal: 'canonical' } });
  expect(merged.worktreeCwd).toBe(current.worktreeCwd);
});

test('Graph rank layout places every dependency before its dependent node', () => {
  const layout = graphRankLayout({
    nodes: [
      { nodeId: 'a', title: 'A', ordinal: 0, detail: null, issueId: null, lastSyncedRevision: null },
      { nodeId: 'b', title: 'B', ordinal: 1, detail: null, issueId: null, lastSyncedRevision: null },
      { nodeId: 'c', title: 'C', ordinal: 2, detail: null, issueId: null, lastSyncedRevision: null },
    ],
    edges: [{ fromNodeId: 'a', toNodeId: 'b', kind: 'depends_on' }, { fromNodeId: 'b', toNodeId: 'c', kind: 'depends_on' }],
  });
  expect(layout.nodes.map(({ nodeId, rank }) => ({ nodeId, rank }))).toEqual([
    { nodeId: 'a', rank: 0 }, { nodeId: 'b', rank: 1 }, { nodeId: 'c', rank: 2 },
  ]);
  expect(layout.width).toBeGreaterThan(600);
});

test('发布确认必须包含完整 immutable Issue 合同，缺验收字段时 fail closed', () => {
  const complete = {
    designId: 1, projectId: 1, token: 'token', graphDigest: 'a'.repeat(64), revision: 3, expiresTs: 99,
    topologicalOrder: ['a'], dependencies: [], blockers: [], readiness: { score: 91, threshold: 80, override: false },
    orderedNodes: [{
      nodeId: 'a', title: 'A', goal: 'Ship A', scope: ['A'], nonGoals: ['B'], inputs: ['brief'], outputs: ['code'],
      dependencies: [], implementationNotes: ['reuse API'], resolvedModuleId: null, resolvedAgent: 'codex',
      runtime: 'current', complexity: 'medium', complexityRationale: ['two systems'], implMode: 'direct',
      acceptanceCriteria: ['works'], testRecommendations: ['test'], evidenceRequirements: ['log'],
      completionInstructions: ['report evidence'], bodyDigest: 'b'.repeat(64),
    }],
  } as const;
  expect(isCompletePublishConfirmation(complete)).toBe(true);
  const { implementationNotes: _missing, ...incompleteNode } = complete.orderedNodes[0];
  expect(isCompletePublishConfirmation({ ...complete, orderedNodes: [incompleteNode] })).toBe(false);
  const { bodyDigest: _missingDigest, ...nodeWithoutDigest } = complete.orderedNodes[0];
  expect(isCompletePublishConfirmation({ ...complete, orderedNodes: [nodeWithoutDigest] })).toBe(false);
  expect(isCompletePublishConfirmation({ ...complete, topologicalOrder: [] })).toBe(false);
  expect(isCompletePublishConfirmation({ ...complete, readiness: { score: 91, threshold: 80 } })).toBe(false);
});

test('latest-only guard 丢弃反向到达的旧请求，并在失效后拒绝所有在途响应', () => {
  const guard = new LatestOnlyRequestGuard();
  const slow = guard.begin();
  const fast = guard.begin();

  expect(guard.isCurrent(fast)).toBe(true);
  expect(guard.isCurrent(slow)).toBe(false);

  guard.invalidate();
  expect(guard.isCurrent(fast)).toBe(false);
});

test('列表轮询不能用旧 revision 或同 revision 的旧快照覆盖 mutation/detail 新结果', () => {
  const revision3 = { ...task(3, 'review', 30), currentRevision: 3 };
  const revision2Late = { ...task(3, 'solution_draft', 99), currentRevision: 2 };
  const revision3Older = { ...task(3, 'solution_draft', 29), currentRevision: 3 };

  expect(preferLatestDesignTask(revision3, revision2Late)).toBe(revision3);
  expect(preferLatestDesignTask(revision3, revision3Older)).toBe(revision3);
  expect(preferLatestDesignTask(revision2Late, revision3)).toBe(revision3);
});

test('列表刷新逐项保留较新快照，并保留尚未出现在迟到列表中的 mutation 结果', () => {
  const current = [
    { ...task(1, 'review', 30), currentRevision: 3 },
    { ...task(2, 'goal_setting', 40), currentRevision: 1 },
  ];
  const incoming = [
    { ...task(1, 'solution_draft', 99), currentRevision: 2 },
    { ...task(3, 'goal_setting', 50), currentRevision: 0 },
  ];

  expect(mergeLatestDesignTasks(current, incoming)).toEqual([
    current[0],
    incoming[1],
    current[1],
  ]);
});

test('全部 design event kind 都有本地化 key，未知未来事件走本地化 fallback', () => {
  expect(Object.keys(DESIGN_EVENT_LABEL_KEYS)).toEqual([...BACKEND_DESIGN_EVENT_KINDS]);
  expect(DESIGN_EVENT_LABEL_KEYS).toEqual({
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
  });
  expect(designEventLabelKey('graph_published')).toBe('design.event.graph_published');
  expect(designEventLabelKey('future_event')).toBe('design.event.unknown');
});

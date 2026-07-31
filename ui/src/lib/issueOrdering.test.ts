import { describe, expect, test } from 'bun:test';
import type { Issue } from './types';
import { filterIssueList, pageSlice, sortBoardGroup } from './issueOrdering';

function issue(id: number, patch: Partial<Issue> = {}): Issue {
  return {
    id,
    projectId: 1,
    title: `issue-${id}`,
    body: null,
    category: 'task',
    status: 'pending',
    convId: null,
    planJson: null,
    subtasksJson: null,
    subIndex: 0,
    targetBranch: null,
    sourceRef: null,
    branch: null,
    note: null,
    imagesJson: null,
    createdBy: 1,
    createdTs: id,
    doneTs: null,
    module: '未分类',
    implMode: 'seq',
    agent: 'claude',
    pinnedTs: null,
    clarifyFeedback: null,
    resultSummary: null,
    autoApprove: 'medium',
    ...patch,
  };
}

describe('sortBoardGroup', () => {
  test('待确认和进行中按创建时间正序，且不修改输入', () => {
    const items = [issue(3, { createdTs: 30 }), issue(1, { createdTs: 10 }), issue(2, { createdTs: 10 })];
    expect(sortBoardGroup('doing', items, items).map((i) => i.id)).toEqual([1, 2, 3]);
    expect(sortBoardGroup('review', items, items).map((i) => i.id)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.id)).toEqual([3, 1, 2]);
  });

  test('完成按 doneTs 倒序；缺失结束时间的排后并按创建时间倒序', () => {
    const items = [
      issue(1, { status: 'done', createdTs: 100, doneTs: 300 }),
      issue(2, { status: 'blocked', createdTs: 400, doneTs: null }),
      issue(3, { status: 'cancelled', createdTs: 200, doneTs: 500 }),
      issue(4, { status: 'cancelled', createdTs: 450, doneTs: null }),
    ];
    expect(sortBoardGroup('finished', items, items).map((i) => i.id)).toEqual([3, 1, 4, 2]);
  });

  test('待办复用真实队列：置顶优先，随后延续当前执行模块', () => {
    const active = issue(9, { status: 'implementing', module: 'web', createdTs: 5 });
    const pending = [
      issue(1, { module: 'api', createdTs: 10 }),
      issue(2, { module: 'web', createdTs: 20 }),
      issue(3, { module: 'ops', createdTs: 30, pinnedTs: 100 }),
      issue(4, { module: 'ops', createdTs: 40 }),
    ];
    expect(sortBoardGroup('todo', pending, [active, ...pending]).map((i) => i.id)).toEqual([3, 4, 1, 2]);
  });

  test('受阻/已取消组（#105 拆桶）与完成组同一套倒序', () => {
    const items = [
      issue(1, { status: 'blocked', createdTs: 100, doneTs: null }),
      issue(2, { status: 'blocked', createdTs: 300, doneTs: null }),
      issue(3, { status: 'blocked', createdTs: 200, doneTs: 900 }),
    ];
    expect(sortBoardGroup('blocked', items, items).map((i) => i.id)).toEqual([3, 2, 1]);
    expect(sortBoardGroup('cancelled', items, items).map((i) => i.id)).toEqual([3, 2, 1]);
  });
});

describe('filterIssueList（完成组搜索）', () => {
  const list = [
    issue(103, { title: '澄清弹窗', module: 'issue-workbench' }),
    issue(89, { title: '整理方案卡片', module: 'project-management' }),
    issue(12, { title: 'Terminal 重构', module: 'native-terminal' }),
  ];

  test('空查询原样返回；标题/模块不分大小写包含；#编号可带可不带 #', () => {
    expect(filterIssueList(list, '')).toHaveLength(3);
    expect(filterIssueList(list, '  ')).toHaveLength(3);
    expect(filterIssueList(list, '弹窗').map((i) => i.id)).toEqual([103]);
    expect(filterIssueList(list, 'TERMINAL').map((i) => i.id)).toEqual([12]);
    expect(filterIssueList(list, 'workbench').map((i) => i.id)).toEqual([103]);
    expect(filterIssueList(list, '#89').map((i) => i.id)).toEqual([89]);
    expect(filterIssueList(list, '89').map((i) => i.id)).toEqual([89]);
    expect(filterIssueList(list, '没有的')).toEqual([]);
    // 单独一个 # 不当成「所有编号都命中」
    expect(filterIssueList(list, '#')).toEqual([]);
  });
});

describe('pageSlice（收尾组 50/页）', () => {
  const nums = Array.from({ length: 120 }, (_, i) => i);

  test('切片、页数、越界夹回', () => {
    expect(pageSlice(nums, 0)).toMatchObject({ page: 0, pages: 3 });
    expect(pageSlice(nums, 0).rows).toHaveLength(50);
    expect(pageSlice(nums, 2).rows).toHaveLength(20);
    // 越界（搜索后变少/数据删了）→ 夹回最后一页；负数 → 第一页
    expect(pageSlice(nums, 9).page).toBe(2);
    expect(pageSlice(nums, -1).page).toBe(0);
    // 空列表也有 1 页（渲染侧 pages>1 才出分页脚）
    expect(pageSlice([], 0)).toMatchObject({ page: 0, pages: 1, rows: [] });
    expect(pageSlice(nums, 1, 30).rows[0]).toBe(30);
  });
});

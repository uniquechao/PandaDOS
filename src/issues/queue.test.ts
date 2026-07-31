import { describe, expect, test } from 'bun:test';
import type { IssueState } from '../core/types';
import { groupPendingByModule, isBusy, moduleKeyOf, orderPending, pickNext, type QueueIssue } from './queue';

function q(id: number, status: IssueState, module = 'm', createdTs = id): QueueIssue {
  return { id, status, module, createdTs };
}

describe('queue：每项目单 active', () => {
  test('驱动中任一状态（含卡点等待/合并）都算忙', () => {
    for (const s of ['clarifying', 'planning', 'plan_review', 'implementing', 'testing', 'merge_review', 'merging'] as IssueState[]) {
      expect(isBusy([q(1, s), q(2, 'pending')])).toBe(true);
      expect(pickNext([q(1, s), q(2, 'pending')])).toBeUndefined();
    }
  });

  test('pending/done/blocked/cancelled 不算忙', () => {
    expect(isBusy([q(1, 'pending'), q(2, 'done'), q(3, 'blocked'), q(4, 'cancelled')])).toBe(false);
  });
});

describe('queue：同模块优先 + FIFO', () => {
  test('FIFO：无 preferModule 时按创建时间最早', () => {
    expect(pickNext([q(3, 'pending', 'a', 30), q(1, 'pending', 'b', 10), q(2, 'pending', 'c', 20)])!.id).toBe(1);
  });

  test('同模块优先压过 FIFO', () => {
    const got = pickNext(
      [q(1, 'pending', 'other', 10), q(2, 'pending', 'web', 20)],
      'web',
    );
    expect(got!.id).toBe(2);
  });

  test('同模块内部仍 FIFO', () => {
    const got = pickNext(
      [q(2, 'pending', 'web', 20), q(1, 'pending', 'web', 10), q(3, 'pending', 'x', 1)],
      'web',
    );
    expect(got!.id).toBe(1);
  });

  test('无候选返回 undefined', () => {
    expect(pickNext([q(1, 'done')])).toBeUndefined();
    expect(pickNext([])).toBeUndefined();
  });
});

describe('queue：模块聚合（模块间不被 FIFO 打散）', () => {
  test('交错创建的模块——挑选顺序按模块整体聚合，同模块连着出', () => {
    // 创建时序：a1, b1, a2, b2（模块 a/b 交错）；期望「模块 a 全跑完再跑 b」
    const base = [
      q(1, 'pending', 'a', 10),
      q(2, 'pending', 'b', 20),
      q(3, 'pending', 'a', 30),
      q(4, 'pending', 'b', 40),
    ];
    const order: number[] = [];
    let pool = [...base];
    let prevModule: string | undefined;
    // 模拟接力：每挑一条就「完成」它（移出 pending），preferModule = 上一条模块
    while (true) {
      const next = pickNext(pool, prevModule);
      if (!next) break;
      order.push(next.id);
      prevModule = next.module;
      pool = pool.map((i) => (i.id === next.id ? { ...i, status: 'done' as IssueState } : i));
    }
    expect(order).toEqual([1, 3, 2, 4]); // a1,a2 连着，再 b1,b2；不出现 a,b,a,b 交错
  });

  test('模块排位按各自最早任务：b 最早 → 先出 b 整组', () => {
    // b 的最早任务(5) 早于 a 的最早任务(10) → 先跑 b 组
    expect(pickNext([q(1, 'pending', 'a', 10), q(2, 'pending', 'a', 12), q(3, 'pending', 'b', 5)])!.id).toBe(3);
  });
});

describe('queue：置顶（pinned_ts）压过一切', () => {
  /** 造一条置顶的 pending：pinnedTs=置顶时刻 */
  const pin = (id: number, module: string, createdTs: number, pinnedTs: number): QueueIssue => ({
    ...q(id, 'pending', module, createdTs),
    pinnedTs,
  });

  test('置顶的 pending 排在所有非置顶前——无视模块聚合/FIFO/preferModule', () => {
    // 非置顶 #1 创建更早 + preferModule 命中它的模块，仍被置顶的 #2 压过
    const got = pickNext([q(1, 'pending', 'a', 10), pin(2, 'b', 50, 100)], 'a');
    expect(got!.id).toBe(2);
  });

  test('多个置顶：后置顶的在最前（置顶=移到队首）', () => {
    const got = pickNext([pin(1, 'a', 10, 100), pin(2, 'b', 20, 200)]);
    expect(got!.id).toBe(2); // pinnedTs 200 晚于 100 → 更靠前
  });

  test('置顶只影响 pending：非 pending 的置顶不参与挑选', () => {
    const got = pickNext([{ ...q(1, 'implementing', 'a', 10), pinnedTs: 999 }, q(2, 'pending', 'b', 20)]);
    // #1 在驱动中 → 项目忙 → undefined（置顶不改变忙判定）
    expect(got).toBeUndefined();
  });

  test('无置顶时行为不变（模块聚合/FIFO）', () => {
    expect(pickNext([q(3, 'pending', 'a', 30), q(1, 'pending', 'b', 10), q(2, 'pending', 'c', 20)])!.id).toBe(1);
  });

  test('置顶接力：置顶项跑完后其模块内其余按 preferModule 接着出', () => {
    const base = [q(1, 'pending', 'a', 10), pin(2, 'web', 20, 100), q(3, 'pending', 'web', 30)];
    const order: number[] = [];
    let pool = [...base];
    let prevModule: string | undefined;
    while (true) {
      const next = pickNext(pool, prevModule);
      if (!next) break;
      order.push(next.id);
      prevModule = next.module;
      pool = pool.map((i) => (i.id === next.id ? { ...i, status: 'done' as IssueState } : i));
    }
    expect(order).toEqual([2, 3, 1]); // 置顶 web#2 先跑 → 同模块 web#3 接力 → 最后非置顶 a#1
  });
});

describe('orderPending：完整执行队列', () => {
  const pin = (id: number, module: string, createdTs: number, pinnedTs: number): QueueIssue => ({
    ...q(id, 'pending', module, createdTs),
    pinnedTs,
  });

  test('置顶 → 同模块接力 → 模块聚合 → FIFO', () => {
    const issues = [
      q(1, 'pending', 'api', 10),
      q(2, 'pending', 'web', 20),
      pin(3, 'web', 30, 100),
      q(4, 'pending', 'api', 40),
      pin(5, 'ops', 50, 200),
      q(6, 'pending', 'ops', 60),
    ];

    expect(orderPending(issues, 'api').map((i) => i.id)).toEqual([5, 3, 2, 1, 4, 6]);
  });

  test('忽略非 pending，且不修改输入数组', () => {
    const issues = [q(3, 'pending', 'b', 30), q(1, 'done', 'a', 10), q(2, 'pending', 'a', 20)];
    const before = issues.map((i) => i.id);

    expect(orderPending(issues).map((i) => i.id)).toEqual([2, 3]);
    expect(issues.map((i) => i.id)).toEqual(before);
  });

  test('pickNext 的结果等于完整队列首项，忙时仍不挑选', () => {
    const idle = [q(1, 'pending', 'a', 10), q(2, 'pending', 'web', 20)];
    expect(pickNext(idle, 'web')?.id).toBe(orderPending(idle, 'web')[0]?.id);
    expect(pickNext([...idle, q(3, 'implementing')], 'web')).toBeUndefined();
  });
});

describe('queue：模块身份以 moduleId 为准（module 文本列可能与 slug 不同步）', () => {
  function qm(id: number, module: string, moduleId: number | null, createdTs: number): QueueIssue {
    return { id, status: 'pending', module, moduleId, createdTs };
  }

  test('同名文本的两个模块不混桶——035 回填留下的同名跨代理文本桶不能被当成一个模块', () => {
    // 生产实况：issues.module 文本「issue」同时覆盖模块 4(claude) 与模块 5(codex)
    const issues = [qm(1, 'issue', 4, 10), qm(2, 'issue', 5, 20), qm(3, 'issue', 4, 30)];
    // 模块 4 最早(10) → 整组先跑完，再换模块 5；而非按文本并成一桶后纯 FIFO
    expect(orderPending(issues).map((i) => i.id)).toEqual([1, 3, 2]);
  });

  test('同一模块的两种文本不拆桶——035 只回填 module_id、遗留旧文本不该把模块打散', () => {
    // 生产实况：模块 4 下 9 条文本是「issue」、3 条是「legacy-module-02」
    const issues = [qm(1, 'issue', 4, 10), qm(2, 'other', 9, 20), qm(3, 'legacy-module-02', 4, 30)];
    expect(orderPending(issues).map((i) => i.id)).toEqual([1, 3, 2]);
  });

  test('preferModule 按模块键命中：文本不同但同模块也算命中', () => {
    const issues = [qm(1, 'other', 9, 10), qm(2, 'legacy-module-02', 4, 20)];
    expect(pickNext(issues, moduleKeyOf(qm(0, 'issue', 4, 0)))!.id).toBe(2);
  });

  test('moduleId 缺省（旧库/旧测试）时回落到 module 文本', () => {
    const issues = [qm(1, 'a', null, 20), qm(2, 'b', null, 10), qm(3, 'a', null, 30)];
    expect(orderPending(issues, 'a').map((i) => i.id)).toEqual([1, 3, 2]);
  });
});

describe('groupPendingByModule', () => {
  test('按 moduleId 分组：同名文本不合并、同模块不同文本不拆开', () => {
    const g = groupPendingByModule([
      { id: 1, status: 'pending', module: 'issue', moduleId: 4, createdTs: 10 },
      { id: 2, status: 'pending', module: 'issue', moduleId: 5, createdTs: 5 },
      { id: 3, status: 'pending', module: 'legacy-module-02', moduleId: 4, createdTs: 30 },
    ]);
    expect(g.length).toBe(2);
    expect(g[0]![1].map((i) => i.id)).toEqual([2]); // 模块 5 最早(5) 在前
    expect(g[1]![1].map((i) => i.id)).toEqual([1, 3]); // 模块 4 两种文本归一组，组内 FIFO
  });

  test('只取 pending，按模块分组，模块间按最早任务排序，组内 FIFO', () => {
    const g = groupPendingByModule([
      q(1, 'pending', 'a', 10),
      q(2, 'done', 'a', 5),
      q(3, 'pending', 'b', 3),
      q(4, 'pending', 'a', 8),
      q(5, 'pending', 'b', 20),
    ]);
    expect(g.map(([m]) => m)).toEqual(['b', 'a']); // b 最早(3) 在前
    expect(g.find(([m]) => m === 'a')![1].map((i) => i.id)).toEqual([4, 1]); // 组内 FIFO：8 前于 10
    expect(g.find(([m]) => m === 'b')![1].map((i) => i.id)).toEqual([3, 5]);
  });
});

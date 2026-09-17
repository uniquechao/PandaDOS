/**
 * core/usage-store 单测（#282 / I-08、I-09）。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { MODULE_NONE, MODULE_UNATTRIBUTED, UsageStore } from './usage-store';
import { emptyUsage, type UsageTotals } from './usage';

function setup() {
  const db = openDb(':memory:');
  db.run('PRAGMA foreign_keys = ON');
  migrate(db);
  migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
  db.run(`INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'a', 1, '/ws/a', 1, 1), (2, 'b', 1, '/ws/b', 1, 1)`);
  db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent)
    VALUES ('c1', 1, 'x', 1, 'claude'), ('c2', 1, 'y', 1, 'claude'), ('c3', 2, 'z', 1, 'codex')`);
  db.run(`INSERT INTO issues (id, project_id, title, created_ts)
    VALUES (10, 1, 'i10', 1), (11, 1, 'i11', 1), (20, 2, 'i20', 1)`);
  return { db, store: new UsageStore(db) };
}

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ ...emptyUsage(), ...over });

describe('conversation 累计：覆盖写 + 游标', () => {
  test('重复写不翻倍（扫描侧持有累计，每次整体写回）', () => {
    const { store } = setup();
    const row = { convId: 'c1', projectId: 1, kind: 'issue' as const, scannedBytes: 100, ...totals({ requests: 3, outputTokens: 50 }) };
    store.upsertConversation(row, 1000);
    store.upsertConversation({ ...row, scannedBytes: 260, requests: 5, outputTokens: 90 }, 2000);

    const got = store.getConversation('c1')!;
    expect(got).toMatchObject({ scannedBytes: 260, requests: 5, outputTokens: 90, kind: 'issue', updatedTs: 2000 });
    expect(store.getConversation('nope')).toBeUndefined();
  });

  test('游标回退（文件被换掉重扫）也能自然纠正', () => {
    const { store } = setup();
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 900, ...totals({ outputTokens: 99 }) });
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 10, ...totals({ outputTokens: 1 }) });
    expect(store.getConversation('c1')).toMatchObject({ scannedBytes: 10, outputTokens: 1 });
  });
});

describe('issue 归因：增量累加', () => {
  test('多次追加相加，不同 issue 互不影响', () => {
    const { store } = setup();
    store.addIssue(10, 1, totals({ requests: 1, inputTokens: 100, outputTokens: 10 }));
    store.addIssue(10, 1, totals({ requests: 2, inputTokens: 50, toolCalls: 4 }));
    store.addIssue(11, 1, totals({ requests: 1, outputTokens: 7 }));

    expect(store.getIssue(10)).toMatchObject({ requests: 3, inputTokens: 150, outputTokens: 10, toolCalls: 4 });
    expect(store.getIssue(11)).toMatchObject({ requests: 1, outputTokens: 7 });
    expect(store.getIssue(999)).toEqual(emptyUsage()); // 没有记录 = 全零，不是 undefined
  });

  test('按项目列出，按 output 降序（成本视图默认想先看最贵的）', () => {
    const { store } = setup();
    store.addIssue(10, 1, totals({ outputTokens: 5 }));
    store.addIssue(11, 1, totals({ outputTokens: 50 }));
    store.addIssue(20, 2, totals({ outputTokens: 500 }));

    expect(store.listIssueUsage(1).map((b) => b.issueId)).toEqual([11, 10]);
    expect(store.listIssueUsage().map((b) => b.issueId)).toEqual([20, 11, 10]);
  });
});

describe('聚合：项目 / 非 Issue 会话 / 归不到 issue 的余量 / 全局', () => {
  test('项目汇总取 conversation 侧（会话总量才是真实开销）', () => {
    const { store } = setup();
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 1, ...totals({ outputTokens: 100, requests: 2 }) });
    store.upsertConversation({ convId: 'c2', projectId: 1, kind: 'chat', scannedBytes: 1, ...totals({ outputTokens: 30, requests: 1 }) });
    store.upsertConversation({ convId: 'c3', projectId: 2, kind: 'issue', scannedBytes: 1, ...totals({ outputTokens: 7 }) });

    expect(store.listProjectUsage()).toEqual([
      expect.objectContaining({ projectId: 1, outputTokens: 130, requests: 3 }),
      expect.objectContaining({ projectId: 2, outputTokens: 7 }),
    ]);
    expect(store.grandTotal()).toMatchObject({ outputTokens: 137, requests: 3 });
  });

  test('非 Issue 会话单列 kind=chat', () => {
    const { store } = setup();
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 1, ...totals({ outputTokens: 100 }) });
    store.upsertConversation({ convId: 'c2', projectId: 1, kind: 'chat', scannedBytes: 1, ...totals({ outputTokens: 30 }) });
    expect(store.listChatUsage()).toEqual([expect.objectContaining({ projectId: 1, outputTokens: 30 })]);
  });

  test('归不到 issue 的余量 = 会话总量 − 已归因；不为负', () => {
    const { store } = setup();
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 1, ...totals({ outputTokens: 100, requests: 4 }) });
    store.addIssue(10, 1, totals({ outputTokens: 70, requests: 3 }));

    expect(store.unattributedByProject()).toEqual([
      expect.objectContaining({ projectId: 1, outputTokens: 30, requests: 1 }),
    ]);

    // 归因反而更多（口径出问题）时不出负数，但也不会被悄悄抹平成「正常」
    store.addIssue(11, 1, totals({ outputTokens: 999 }));
    expect(store.unattributedByProject()[0]!.outputTokens).toBe(0);
  });

  test('空库聚合返回空数组与全零，不抛错', () => {
    const { store } = setup();
    expect(store.listProjectUsage()).toEqual([]);
    expect(store.listChatUsage()).toEqual([]);
    expect(store.unattributedByProject()).toEqual([]);
    expect(store.grandTotal()).toEqual(emptyUsage());
  });
});

describe('按天分桶（065 / #295）', () => {
  test('同一天同一条 issue 多次追加相加；不同天/不同 issue 各自成桶', () => {
    const { store } = setup();
    store.addDaily('2026-09-07', 1, 10, totals({ requests: 1, outputTokens: 10 }));
    store.addDaily('2026-09-07', 1, 10, totals({ requests: 2, outputTokens: 5, toolCalls: 3 }));
    store.addDaily('2026-09-07', 1, 11, totals({ outputTokens: 7 }));
    store.addDaily('2026-09-08', 1, 10, totals({ outputTokens: 100 }));

    expect(store.listDaily()).toEqual([
      expect.objectContaining({ day: '2026-09-07', projectId: 1, requests: 3, outputTokens: 22, toolCalls: 3 }),
      expect.objectContaining({ day: '2026-09-08', projectId: 1, outputTokens: 100 }),
    ]);
  });

  test('日期闭区间与项目筛选；按 day 升序（趋势要按时间读）', () => {
    const { store } = setup();
    store.addDaily('2026-09-06', 1, 10, totals({ outputTokens: 1 }));
    store.addDaily('2026-09-07', 1, 10, totals({ outputTokens: 2 }));
    store.addDaily('2026-09-08', 1, 10, totals({ outputTokens: 4 }));
    store.addDaily('2026-09-07', 2, 20, totals({ outputTokens: 8 }));

    expect(store.listDaily({ from: '2026-09-07', to: '2026-09-08' }).map((r) => [r.day, r.projectId, r.outputTokens]))
      .toEqual([['2026-09-07', 1, 2], ['2026-09-07', 2, 8], ['2026-09-08', 1, 4]]);
    expect(store.listDaily({ projectId: 2 })).toEqual([
      expect.objectContaining({ day: '2026-09-07', projectId: 2, outputTokens: 8 }),
    ]);
    expect(store.listDaily({ from: '2026-10-01' })).toEqual([]);
  });

  test('按天 × 模块：归属在读取侧 join，改 issue 归属后历史分桶跟着改', () => {
    const { db, store } = setup();
    db.run(`INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (5, 1, 'issue-engine', 'issue 引擎与调度', 'claude', 'manual', 1),
             (6, 1, 'web-ui', '前端', 'codex', 'manual', 1)`);
    db.run('UPDATE issues SET module_id = 5 WHERE id = 10');
    store.addDaily('2026-09-07', 1, 10, totals({ outputTokens: 30 }));

    expect(store.listDailyByModule()).toEqual([
      expect.objectContaining({
        day: '2026-09-07', moduleId: 5, moduleSlug: 'issue-engine', moduleName: 'issue 引擎与调度', outputTokens: 30,
      }),
    ]);

    // 挪到别的模块：历史分桶自动跟着走（模块没有被冻结在分桶行里）
    db.run('UPDATE issues SET module_id = 6 WHERE id = 10');
    expect(store.listDailyByModule()).toEqual([
      expect.objectContaining({ moduleId: 6, moduleSlug: 'web-ui', outputTokens: 30 }),
    ]);
  });

  test('两个哨兵桶含义不同，不许合并：未归因 vs 归了 issue 但没有模块', () => {
    const { db, store } = setup();
    db.run(`INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (5, 1, 'issue-engine', 'issue 引擎与调度', 'claude', 'manual', 1)`);
    db.run('UPDATE issues SET module_id = 5 WHERE id = 10');
    store.addDaily('2026-09-07', 1, 10, totals({ outputTokens: 30 }));
    store.addDaily('2026-09-07', 1, 11, totals({ outputTokens: 7 }));  // issue 没有模块
    store.addDaily('2026-09-07', 1, 0, totals({ outputTokens: 5 }));   // 未归因

    expect(store.listDailyByModule({ projectId: 1 }).map((r) => [r.moduleId, r.outputTokens])).toEqual([
      [MODULE_UNATTRIBUTED, 5],
      [MODULE_NONE, 7],
      [5, 30],
    ]);
    // 哨兵桶没有模块名
    expect(store.listDailyByModule().filter((r) => r.moduleId <= 0).every((r) => r.moduleName === '')).toBe(true);
  });

  test('issue 被删：分桶行留着（未归因/未归模块可见），不因外键消失', () => {
    const { db, store } = setup();
    store.addDaily('2026-09-07', 1, 10, totals({ outputTokens: 30 }));
    db.run('DELETE FROM issues WHERE id = 10');
    expect(store.listDaily()).toEqual([expect.objectContaining({ outputTokens: 30 })]);
    expect(store.listDailyByModule()).toEqual([expect.objectContaining({ moduleId: MODULE_NONE, outputTokens: 30 })]);
  });

  test('空库返回空数组，不抛错', () => {
    const { store } = setup();
    expect(store.listDaily()).toEqual([]);
    expect(store.listDailyByModule()).toEqual([]);
  });
});

describe('单价表与回扫（#282 / Q2、Q3）', () => {
  test('初值是 gpt-5 档；可改；负数拒绝', () => {
    const { store } = setup();
    expect(store.pricing()).toEqual({
      currency: 'USD', inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10, reasoningPerMTok: 0,
    });

    expect(store.setPricing({
      currency: 'USD', inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, reasoningPerMTok: 0,
    })).toMatchObject({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(store.pricing().inputPerMTok).toBe(3); // 落库了

    expect(() => store.setPricing({
      currency: 'USD', inputPerMTok: -1, cachedInputPerMTok: 0, outputPerMTok: 1, reasoningPerMTok: 0,
    })).toThrow(/非负数/);
    expect(store.pricing().inputPerMTok).toBe(3); // 拒绝后库内不动
  });

  test('回扫：游标与累计清零，且**必须**连 issue_usage 一起清（否则重扫会翻倍）', () => {
    const { store } = setup();
    store.upsertConversation({ convId: 'c1', projectId: 1, kind: 'issue', scannedBytes: 900, ...totals({ outputTokens: 50 }) });
    store.upsertConversation({ convId: 'c3', projectId: 2, kind: 'issue', scannedBytes: 900, ...totals({ outputTokens: 7 }) });
    store.addIssue(10, 1, totals({ outputTokens: 40 }));
    store.addIssue(20, 2, totals({ outputTokens: 7 }));
    store.addDaily('2026-09-07', 1, 10, totals({ outputTokens: 40 }));
    store.addDaily('2026-09-07', 2, 20, totals({ outputTokens: 7 }));

    expect(store.resetScan(1)).toBe(1); // 只重置项目 1
    expect(store.getConversation('c1')).toMatchObject({ scannedBytes: 0, outputTokens: 0 });
    expect(store.getIssue(10)).toEqual(emptyUsage());
    // 按天分桶也是累加表，同样必须被清掉（不清就会在回扫后翻倍）
    expect(store.listDaily({ projectId: 1 })).toEqual([]);
    // 别的项目不受影响
    expect(store.getConversation('c3')).toMatchObject({ scannedBytes: 900, outputTokens: 7 });
    expect(store.getIssue(20).outputTokens).toBe(7);
    expect(store.listDaily({ projectId: 2 })).toEqual([expect.objectContaining({ outputTokens: 7 })]);

    expect(store.resetScan()).toBe(2); // 全量重置
    expect(store.getIssue(20)).toEqual(emptyUsage());
    expect(store.grandTotal()).toEqual(emptyUsage());
    expect(store.listDaily()).toEqual([]);
  });
});

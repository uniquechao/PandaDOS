/**
 * core/usage-weekly 单测（#295）：周窗口纯函数 + 结局指标口径 + 周报合成。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { emptyUsage, type UsageTotals } from './usage';
import { MODULE_NONE, MODULE_UNATTRIBUTED, UsageStore } from './usage-store';
import {
  activeModuleBuckets,
  addDays,
  dayStartMs,
  moduleOutcomes,
  weekDays,
  weekStartOf,
  weeklyReport,
  weekWindowOf,
} from './usage-weekly';

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({ ...emptyUsage(), ...over });

/** 2026-09-07 是周一 */
const MON = '2026-09-07';

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
  db.run(`INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
    VALUES (5, 1, 'issue-engine', 'issue 引擎与调度', 'claude', 'manual', 1),
           (6, 1, 'web-ui', '前端', 'codex', 'manual', 1)`);
  return { db, store: new UsageStore(db) };
}

function issue(db: ReturnType<typeof openDb>, id: number, moduleId: number | null, projectId = 1): void {
  db.run(`INSERT INTO issues (id, project_id, title, module_id, created_ts) VALUES (?, ?, ?, ?, 1)`,
    [id, projectId, `i${id}`, moduleId]);
}

/** 落一条 transition 事件（只有 to 参与统计） */
function trans(db: ReturnType<typeof openDb>, issueId: number, to: string, ts: number): void {
  db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, 'transition', ?, ?)`,
    [issueId, JSON.stringify({ event: 'x', from: 'implementing', to }), ts]);
}

/** 该周内某天某时刻（北京时间）的 epoch 毫秒 */
const at = (day: string, hour = 10): number => dayStartMs(day) + hour * 3_600_000;

describe('周窗口纯函数（北京时间，周一起算）', () => {
  test('周起始：周一本身不动，周日回退到本周一，跨月也对', () => {
    expect(weekStartOf(MON)).toBe(MON);
    expect(weekStartOf('2026-09-13')).toBe(MON);      // 周日
    expect(weekStartOf('2026-09-10')).toBe(MON);      // 周四
    expect(weekStartOf('2026-09-14')).toBe('2026-09-14'); // 下一个周一
    expect(weekStartOf('2026-10-01')).toBe('2026-09-28'); // 跨月回退
    expect(weekDays(MON)).toEqual([
      '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
    ]);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  test('日键 → 北京时间 0 点（= 前一天 16:00 UTC）；窗口左闭右开', () => {
    expect(dayStartMs(MON)).toBe(Date.parse('2026-09-06T16:00:00.000Z'));

    const w = weekWindowOf('2026-09-11');
    expect(w).toMatchObject({ start: MON, end: '2026-09-13' });
    expect(w.fromMs).toBe(Date.parse('2026-09-06T16:00:00.000Z'));
    expect(w.toMs).toBe(Date.parse('2026-09-13T16:00:00.000Z')); // 下周一 0 点
    expect(w.days).toHaveLength(7);

    // 用时刻定位：北京 09-14 00:30（= UTC 09-13 16:30）已经算下一周
    expect(weekWindowOf(Date.parse('2026-09-13T16:30:00.000Z')).start).toBe('2026-09-14');
    expect(weekWindowOf(Date.parse('2026-09-13T15:30:00.000Z')).start).toBe(MON);
  });
});

describe('结局指标口径', () => {
  test('去重 + 失败率分母 = 本周有结局的 issue 数（还在跑的不进分母）', () => {
    const { db } = setup();
    issue(db, 10, 5);
    issue(db, 11, 5);
    issue(db, 12, 5);
    issue(db, 13, 5);
    trans(db, 10, 'done', at(MON));
    trans(db, 11, 'done', at('2026-09-08'));
    trans(db, 11, 'done', at('2026-09-08', 12)); // 同一条重复进 done：去重后仍是一条
    trans(db, 12, 'blocked', at('2026-09-09'));
    trans(db, 13, 'cancelled', at('2026-09-10'));
    trans(db, 13, 'implementing', at('2026-09-10', 12)); // 中间状态不算结局
    const w = weekWindowOf(MON);

    const stats = moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs }).get('1:5')!;
    expect(stats).toMatchObject({
      doneCount: 2, blockedCount: 1, cancelledCount: 1, failedCount: 2, outcomeCount: 4,
    });
    expect(stats.failureRate).toBeCloseTo(0.5, 10);
  });

  test('同一条 issue 本周先 blocked 后 done：分子分母各只算一条，且算恢复', () => {
    const { db } = setup();
    issue(db, 10, 5);
    trans(db, 10, 'blocked', at(MON));
    trans(db, 10, 'done', at('2026-09-09'));
    const w = weekWindowOf(MON);

    const s = moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs }).get('1:5')!;
    expect(s).toMatchObject({ doneCount: 1, blockedCount: 1, failedCount: 1, outcomeCount: 1, recoveredCount: 1 });
    expect(s.failureRate).toBe(1);
    expect(s.recoveryRate).toBe(1);
  });

  test('跨周恢复照样算：周五卡住、下周一救回来，功劳记在卡住那一周', () => {
    const { db } = setup();
    issue(db, 10, 5);
    issue(db, 11, 5);
    trans(db, 10, 'blocked', at('2026-09-11'));
    trans(db, 10, 'done', at('2026-09-15')); // 下一周才 done
    trans(db, 11, 'blocked', at('2026-09-11'));
    trans(db, 11, 'cancelled', at('2026-09-16')); // 没救回来
    const w = weekWindowOf(MON);

    const s = moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs }).get('1:5')!;
    expect(s).toMatchObject({ blockedCount: 2, recoveredCount: 1, doneCount: 0 });
    expect(s.recoveryRate).toBeCloseTo(0.5, 10);
    // 下一周窗口里：#10 的 done 计入下周完成数，blocked 不重复计
    const next = moduleOutcomes(db, { fromMs: w.toMs, toMs: w.toMs + 7 * 86_400_000 }).get('1:5')!;
    expect(next).toMatchObject({ doneCount: 1, blockedCount: 0, cancelledCount: 1 });
  });

  test('blocked 之前的 done 不算恢复（顺序按事件 id 判）', () => {
    const { db } = setup();
    issue(db, 10, 5);
    trans(db, 10, 'done', at(MON));
    trans(db, 10, 'blocked', at('2026-09-09')); // 之后再没 done
    const w = weekWindowOf(MON);
    expect(moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs }).get('1:5')).toMatchObject({
      recoveredCount: 0, recoveryRate: 0,
    });
  });

  test('按模块与项目分桶；未归模块落 0 桶；窗口外与他项目不串味', () => {
    const { db } = setup();
    issue(db, 10, 5);
    issue(db, 11, 6);
    issue(db, 12, null);       // 未归模块
    issue(db, 20, null, 2);    // 别的项目
    trans(db, 10, 'done', at(MON));
    trans(db, 11, 'blocked', at(MON));
    trans(db, 12, 'done', at(MON));
    trans(db, 20, 'done', at(MON));
    trans(db, 10, 'done', at('2026-09-06')); // 上一周，不该进来
    const w = weekWindowOf(MON);

    const all = moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs });
    expect([...all.keys()].sort()).toEqual(['1:0', '1:5', '1:6', '2:0']);
    expect(all.get(`1:${MODULE_NONE}`)).toMatchObject({ doneCount: 1 });

    const onlyP1 = moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs, projectId: 1 });
    expect([...onlyP1.keys()].sort()).toEqual(['1:0', '1:5', '1:6']);
  });

  test('坏事件与只有中间状态的桶：不抛错，也不出现在结局表里', () => {
    const { db } = setup();
    issue(db, 10, 5);
    db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (10, 'transition', '{坏 json', ?)`, [at(MON)]);
    trans(db, 10, 'implementing', at('2026-09-08'));
    const w = weekWindowOf(MON);
    expect(moduleOutcomes(db, { fromMs: w.fromMs, toMs: w.toMs }).size).toBe(0);
  });
});

describe('周报合成', () => {
  test('7 天缺的补零；模块行含钱与结局；未归因桶没有结局指标', () => {
    const { db, store } = setup();
    issue(db, 10, 5);
    issue(db, 11, 6);
    store.addDaily(MON, 1, 10, totals({ outputTokens: 1_000_000, requests: 3 }));       // $10
    store.addDaily('2026-09-09', 1, 11, totals({ inputTokens: 2_000_000 }));            // $2.5
    store.addDaily('2026-09-09', 1, 0, totals({ outputTokens: 100_000 }));              // $1，未归因
    store.addDaily('2026-09-20', 1, 10, totals({ outputTokens: 9_000_000 }));           // 下下周，不该进来
    trans(db, 10, 'done', at(MON));
    trans(db, 11, 'blocked', at('2026-09-09'));

    const r = weeklyReport(db, { week: '2026-09-10' });
    expect(r.week.start).toBe(MON);
    expect(r.days).toHaveLength(7);
    expect(r.days.map((d) => Number(d.costUsd.toFixed(2)))).toEqual([10, 0, 2.5 + 1, 0, 0, 0, 0]);
    expect(r.days[1]!.usage).toEqual(emptyUsage()); // 没干活的那天是零，不是缺行

    const byModule = new Map(r.modules.map((m) => [m.moduleId, m]));
    expect(r.modules[0]!.moduleId).toBe(5); // 按成本降序
    expect(byModule.get(5)).toMatchObject({ moduleSlug: 'issue-engine', moduleName: 'issue 引擎与调度' });
    expect(byModule.get(5)!.outcomes).toMatchObject({ doneCount: 1, failedCount: 0, outcomeCount: 1, failureRate: 0 });
    expect(byModule.get(6)!.outcomes).toMatchObject({ doneCount: 0, blockedCount: 1, failureRate: 1, recoveryRate: 0 });
    // 未归因桶只有钱：不许编一个 0/0 的失败率冒充健康
    expect(byModule.get(MODULE_UNATTRIBUTED)).toMatchObject({ outcomes: null });
    expect(Number(byModule.get(MODULE_UNATTRIBUTED)!.costUsd.toFixed(2))).toBe(1);

    // 合计：钱含未归因，结局按桶相加
    expect(Number(r.totals.costUsd.toFixed(2))).toBe(13.5);
    expect(r.totals).toMatchObject({ doneCount: 1, blockedCount: 1, failedCount: 1, outcomeCount: 2 });
    expect(r.totals.failureRate).toBeCloseTo(0.5, 10);
  });

  test('只有结局没有用量的模块也要出现（否则「白干一周」的模块会凭空消失）', () => {
    const { db } = setup();
    issue(db, 10, 5);
    trans(db, 10, 'done', at(MON));

    const r = weeklyReport(db, { week: MON });
    expect(r.modules).toEqual([
      expect.objectContaining({ moduleId: 5, moduleName: 'issue 引擎与调度', costUsd: 0 }),
    ]);
    expect(r.modules[0]!.outcomes).toMatchObject({ doneCount: 1 });
  });

  test('本周只是动过（无结局、无用量）的模块也要出现——它正在烧钱却还没交代', () => {
    const { db } = setup();
    issue(db, 10, 5);
    // 只有中间状态流转：没有结局，也没有任何分桶用量
    trans(db, 10, 'implementing', at(MON));
    trans(db, 10, 'testing', at('2026-09-09'));

    expect([...activeModuleBuckets(db, {
      fromMs: weekWindowOf(MON).fromMs, toMs: weekWindowOf(MON).toMs,
    })]).toEqual(['1:5']);

    const r = weeklyReport(db, { week: MON });
    expect(r.modules).toEqual([expect.objectContaining({ moduleId: 5, costUsd: 0 })]);
    expect(r.modules[0]!.outcomes).toMatchObject({ outcomeCount: 0, doneCount: 0, failureRate: 0 });
    // 上一周它没动过，就不该出现
    expect(weeklyReport(db, { week: '2026-08-31' }).modules).toEqual([]);
  });

  test('只有用量没有结局的模块给空结局（还在跑，不是零失败）', () => {
    const { db, store } = setup();
    issue(db, 10, 5);
    store.addDaily(MON, 1, 10, totals({ outputTokens: 100 }));
    const r = weeklyReport(db, { week: MON });
    expect(r.modules[0]).toMatchObject({ moduleId: 5 });
    expect(r.modules[0]!.outcomes).toMatchObject({ outcomeCount: 0, failureRate: 0, recoveryRate: 0 });
  });

  test('项目过滤只留该项目；缺省窗口取 now 所在周', () => {
    const { db, store } = setup();
    issue(db, 10, 5);
    issue(db, 20, null, 2);
    store.addDaily(MON, 1, 10, totals({ outputTokens: 100 }));
    store.addDaily(MON, 2, 20, totals({ outputTokens: 900 }));

    const p1 = weeklyReport(db, { week: MON, projectId: 1 });
    expect(p1.modules.map((m) => [m.projectId, m.moduleId])).toEqual([[1, 5]]);
    expect(p1.totals.usage.outputTokens).toBe(100);

    const auto = weeklyReport(db, { now: () => at('2026-09-11') });
    expect(auto.week.start).toBe(MON);
    expect(auto.totals.usage.outputTokens).toBe(1000);
  });

  test('空库：7 天全零、无模块行、合计零，不抛错', () => {
    const { db } = setup();
    const r = weeklyReport(db, { week: MON });
    expect(r.days.every((d) => d.costUsd === 0)).toBe(true);
    expect(r.modules).toEqual([]);
    expect(r.totals).toMatchObject({ costUsd: 0, outcomeCount: 0, failureRate: 0, recoveryRate: 0 });
    expect(r.pricing.outputPerMTok).toBe(10); // 单价表初值（后台可配）
  });
});

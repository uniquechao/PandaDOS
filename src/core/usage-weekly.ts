/**
 * core/usage-weekly —— 用量周度视图（#295，承接 #282）。
 *
 * #282 只落了「Issue 级 / 对话级」的累计埋点，回答不了它自己的初衷问题：
 * **只优化 token，有没有把可靠性一起优化没了？** 要回答就得把「花了多少钱」和
 * 「完成了多少、卡住了多少、卡住之后救回来多少」放在同一张表上按模块并排看。
 * 本文件就是那份合成逻辑：用量来自 `usage_daily`（065 的按天分桶），
 * 结局指标来自 `issue_events` 的 `transition` 事件（事件溯源，不加表）。
 *
 * ## 时间口径（发起人拍板）
 * - 一天按**北京时间**切（`Asia/Shanghai`，复用 core/daily-greeting.localDay 与
 *   core/activity.localDayStartMs，不自造时区逻辑）。
 * - 一周**周一起算**，到周日为止；`WeekWindow.fromMs / toMs` 是这七天对应的
 *   epoch 毫秒区间，**左闭右开**（`toMs` = 下周一 0 点）。
 *
 * ## 结局指标口径（分母写死在这里，UI 与离线核对都读它，别在调用方各自数一遍）
 * 只看本周内发生的 `transition` 事件的 `to` 字段，按 issue 去重：
 * - `doneCount`：本周内**进入过** done 的 issue 数。
 * - `blockedCount` / `cancelledCount`：本周内进入过 blocked / cancelled 的 issue 数。
 * - `failedCount`：进入过 blocked **或** cancelled 的 issue 数（同一条两样都占只算一次）。
 * - `outcomeCount`（**失败率的分母**）：本周内有过结局的 issue 去重数
 *   = done ∪ blocked ∪ cancelled。用「有结局的」而不是「本周动过的」当分母，是因为
 *   还在跑的 issue 结局未知，把它算进分母只会让失败率随排队长度上下乱跳。
 *   同一条 issue 一周内既 blocked 又救回 done 时，分子分母都只算一条。
 * - `failureRate = failedCount / outcomeCount`（分母 0 → 0）。
 * - `recoveredCount`：本周进过 blocked 的 issue 里，**在那次 blocked 之后**又进入 done 的。
 *   这里的 done **不限于本周**——周五卡住、周一救回来，功劳仍算在卡住的那一周，
 *   否则跨周恢复会被永久记成失败。
 * - `recoveryRate = recoveredCount / blockedCount`（分母 0 → 0）。cancelled 不进恢复率：
 *   取消是「不干了」，不是「救回来了」。
 *
 * ## 模块归属
 * 走 `issues.module_id`（模块身份只认 id，见 CLAUDE.md），**读取侧 join**：
 * issue 之后被挪模块，历史一起跟着改归属。两个哨兵桶沿用 usage-store：
 * `MODULE_NONE = 0`（有 issue 但没归模块）、`MODULE_UNATTRIBUTED = -1`（用量没归到任何 issue）。
 * 未归因桶只有钱、没有结局指标（它压根没有 issue），`outcomes` 为 null——
 * 别给它编一个 0/0 的失败率，那是把「不适用」伪装成「很健康」。
 */
import type { Database } from 'bun:sqlite';
import { localDayStartMs } from './activity';
import { DEFAULT_TZ, localDay } from './daily-greeting';
import { costOf, emptyUsage, mergeUsage, type UsagePricing, type UsageTotals } from './usage';
import { MODULE_NONE, MODULE_UNATTRIBUTED, UsageStore } from './usage-store';

const DAY_MS = 86_400_000;

/** 一周的窗口：日键（展示与查分桶用）+ epoch 区间（查事件用，左闭右开） */
export interface WeekWindow {
  /** 周一日键 */
  start: string;
  /** 周日日键 */
  end: string;
  /** 周一到周日共 7 个日键 */
  days: string[];
  /** 周一 0 点（北京时间）的 epoch 毫秒 */
  fromMs: number;
  /** 下周一 0 点（北京时间）的 epoch 毫秒；区间左闭右开 */
  toMs: number;
}

/** 日键 → 该日 0 点的 epoch 毫秒。用当日 12:00 UTC 当探针再取本地日起点，绕开时区符号问题。 */
export function dayStartMs(day: string, tz: string = DEFAULT_TZ): number {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`不是合法日键: ${day}`);
  return localDayStartMs(Date.UTC(y, m - 1, d, 12, 0, 0), tz);
}

/** 日键 + n 天（纯日历运算，不碰时区：日键本身已经是墙上日期） */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`不是合法日键: ${day}`);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 该日键所在周的周一（周一起算，发起人拍板） */
export function weekStartOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`不是合法日键: ${day}`);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = 周日
  return addDays(day, -((dow + 6) % 7));
}

/** 周一日键 → 该周 7 个日键 */
export function weekDays(start: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** 任意一天（日键或时刻）所在的周窗口 */
export function weekWindowOf(dayOrTs: string | number, tz: string = DEFAULT_TZ): WeekWindow {
  const day = typeof dayOrTs === 'number' ? localDay(dayOrTs, tz) : dayOrTs;
  const start = weekStartOf(day);
  const days = weekDays(start);
  return {
    start,
    end: days[6]!,
    days,
    fromMs: dayStartMs(start, tz),
    toMs: dayStartMs(addDays(start, 7), tz),
  };
}

/** 一个模块（或哨兵桶）在本周的结局指标。分母口径见文件头。 */
export interface ModuleOutcomeStats {
  doneCount: number;
  blockedCount: number;
  cancelledCount: number;
  failedCount: number;
  /** 失败率的分母：本周内有结局的 issue 去重数 */
  outcomeCount: number;
  failureRate: number;
  recoveredCount: number;
  recoveryRate: number;
}

export function emptyOutcomes(): ModuleOutcomeStats {
  return {
    doneCount: 0,
    blockedCount: 0,
    cancelledCount: 0,
    failedCount: 0,
    outcomeCount: 0,
    failureRate: 0,
    recoveredCount: 0,
    recoveryRate: 0,
  };
}

interface TransitionRow {
  issue_id: number;
  project_id: number;
  module_id: number | null;
  data_json: string | null;
  id: number;
}

/** 事件 data_json 里的 `to`；坏事件只丢这一条，不影响整周统计 */
function transitionTo(dataJson: string | null): string {
  try {
    const d = JSON.parse(dataJson ?? '{}') as { to?: unknown };
    return typeof d.to === 'string' ? d.to : '';
  } catch {
    return '';
  }
}

/** 分桶键：模块 id 是全局唯一的，但哨兵桶（0 / -1）要按项目分开 */
function bucketKey(projectId: number, moduleId: number): string {
  return `${projectId}:${moduleId}`;
}

export interface OutcomeQuery {
  fromMs: number;
  /** 左闭右开 */
  toMs: number;
  projectId?: number;
}

/**
 * 按「项目 × 模块」统计本周结局指标。返回 key 为 `bucketKey()` 的 Map。
 * 只读 `transition` 事件，不加表；恢复率的 done 允许落在窗口之外（见文件头）。
 */
export function moduleOutcomes(db: Database, q: OutcomeQuery): Map<string, ModuleOutcomeStats> {
  const params: number[] = [q.fromMs, q.toMs];
  let where = `e.kind = 'transition' AND e.ts >= ? AND e.ts < ?`;
  if (q.projectId !== undefined) {
    where += ' AND i.project_id = ?';
    params.push(q.projectId);
  }
  const rows = db
    .query<TransitionRow, number[]>(
      `SELECT e.id AS id, e.issue_id AS issue_id, e.data_json AS data_json,
              i.project_id AS project_id, i.module_id AS module_id
         FROM issue_events e
         JOIN issues i ON i.id = e.issue_id
        WHERE ${where}
        ORDER BY e.id`,
    )
    .all(...params);

  /** 每个桶里各状态命中的 issue 集合（去重靠 Set，同一条 issue 一周内反复进出只算一次） */
  const buckets = new Map<string, { done: Set<number>; blocked: Set<number>; cancelled: Set<number> }>();
  /** issue → 本周第一次 blocked 的事件 id；恢复只认「那次之后」的 done */
  const firstBlockedEvent = new Map<number, number>();
  const issueBucket = new Map<number, string>();

  for (const r of rows) {
    const key = bucketKey(r.project_id, r.module_id ?? MODULE_NONE);
    issueBucket.set(r.issue_id, key);
    let b = buckets.get(key);
    if (!b) {
      b = { done: new Set(), blocked: new Set(), cancelled: new Set() };
      buckets.set(key, b);
    }
    const to = transitionTo(r.data_json);
    if (to === 'done') b.done.add(r.issue_id);
    else if (to === 'blocked') {
      b.blocked.add(r.issue_id);
      if (!firstBlockedEvent.has(r.issue_id)) firstBlockedEvent.set(r.issue_id, r.id);
    } else if (to === 'cancelled') b.cancelled.add(r.issue_id);
  }

  // 恢复率：本周进过 blocked 的 issue，在那次 blocked 之后是否又 done（done 不限本周）
  const recovered = new Set<number>();
  if (firstBlockedEvent.size > 0) {
    const ids = [...firstBlockedEvent.keys()];
    const placeholders = ids.map(() => '?').join(', ');
    for (const r of db
      .query<{ issue_id: number; id: number; data_json: string | null }, number[]>(
        `SELECT id, issue_id, data_json FROM issue_events
          WHERE kind = 'transition' AND issue_id IN (${placeholders})
          ORDER BY id`,
      )
      .all(...ids)) {
      const since = firstBlockedEvent.get(r.issue_id);
      if (since === undefined || r.id <= since) continue;
      if (transitionTo(r.data_json) === 'done') recovered.add(r.issue_id);
    }
  }

  const out = new Map<string, ModuleOutcomeStats>();
  for (const [key, b] of buckets) {
    const failed = new Set<number>([...b.blocked, ...b.cancelled]);
    const outcome = new Set<number>([...b.done, ...failed]);
    if (outcome.size === 0) continue; // 本周只有中间状态流转的桶：没有结局，不出现在结局表里
    const recoveredHere = [...b.blocked].filter((id) => recovered.has(id)).length;
    out.set(key, {
      doneCount: b.done.size,
      blockedCount: b.blocked.size,
      cancelledCount: b.cancelled.size,
      failedCount: failed.size,
      outcomeCount: outcome.size,
      failureRate: outcome.size === 0 ? 0 : failed.size / outcome.size,
      recoveredCount: recoveredHere,
      recoveryRate: b.blocked.size === 0 ? 0 : recoveredHere / b.blocked.size,
    });
  }
  return out;
}

/**
 * 本周「有执行动作」的模块桶（发起人拍板：周报要列本周有执行动作的**全部**模块）。
 *
 * 判据放得比结局宽：只要这一周落过任意一条 `transition` 事件就算动过——一条 issue 跑了整周
 * 还没跑完（只有中间状态流转）、用量又还没扫到时，它照样在烧钱，把它从表里藏起来正好藏掉
 * 最该看见的那一行。结局指标另算（见 `moduleOutcomes`），没有结局的显示为空结局。
 */
export function activeModuleBuckets(db: Database, q: OutcomeQuery): Set<string> {
  const params: number[] = [q.fromMs, q.toMs];
  let where = `e.kind = 'transition' AND e.ts >= ? AND e.ts < ?`;
  if (q.projectId !== undefined) {
    where += ' AND i.project_id = ?';
    params.push(q.projectId);
  }
  const out = new Set<string>();
  for (const r of db
    .query<{ project_id: number; module_id: number | null }, number[]>(
      `SELECT DISTINCT i.project_id AS project_id, i.module_id AS module_id
         FROM issue_events e
         JOIN issues i ON i.id = e.issue_id
        WHERE ${where}`,
    )
    .all(...params)) {
    out.add(bucketKey(r.project_id, r.module_id ?? MODULE_NONE));
  }
  return out;
}

/** 周报里的一行：一个模块（或哨兵桶）的钱 + 结局 */
export interface ModuleWeekRow {
  projectId: number;
  moduleId: number;
  moduleSlug: string;
  moduleName: string;
  usage: UsageTotals;
  costUsd: number;
  /** 未归因桶没有 issue，也就没有结局指标——不许编一个 0/0 冒充健康 */
  outcomes: ModuleOutcomeStats | null;
}

export interface DayCostRow {
  day: string;
  usage: UsageTotals;
  costUsd: number;
}

export interface WeeklyReport {
  week: WeekWindow;
  pricing: UsagePricing;
  /** 固定 7 行（缺的天补零），按日期升序——趋势要按时间读 */
  days: DayCostRow[];
  /** 按成本降序 */
  modules: ModuleWeekRow[];
  totals: {
    usage: UsageTotals;
    costUsd: number;
    doneCount: number;
    blockedCount: number;
    cancelledCount: number;
    failedCount: number;
    outcomeCount: number;
    failureRate: number;
    recoveredCount: number;
    recoveryRate: number;
  };
}

export interface WeeklyReportOpts {
  /** 周内任意一天的日键，或任意时刻的 epoch 毫秒；缺省 = 现在所在那一周 */
  week?: string | number;
  projectId?: number;
  tz?: string;
  now?: () => number;
}

/**
 * 合成周报：按天分桶（`usage_daily`）+ 按模块的钱与结局。
 *
 * 用量与结局是**两条独立的来源**，所以一个模块可能只有其中一样：
 * 本周完成了但用量在上周就扫掉了（只有结局）、或者一直在跑还没有结局（只有钱）。
 * 两种都要出现在表里——只列交集会让「这周烧了钱却什么都没完成」的模块凭空消失。
 *
 * 发起人拍板口径：**列出本周有执行动作的全部模块**。所以第三种也要在：本周只有中间状态流转
 * （既没结局、也还没扫到用量）的模块同样出现，结局显示为空——它正在烧钱却还没有任何交代，
 * 是最该被看见的那一行。
 */
export function weeklyReport(db: Database, opts: WeeklyReportOpts = {}): WeeklyReport {
  const tz = opts.tz ?? DEFAULT_TZ;
  const now = opts.now ?? (() => Date.now());
  const week = weekWindowOf(opts.week ?? now(), tz);
  const store = new UsageStore(db);
  const pricing = store.pricing();
  const range = { from: week.start, to: week.end, ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }) };

  // ---- 按天（缺的天补零：7 格都要在，空着才看得出「那天没干活」）----
  const byDay = new Map<string, UsageTotals>();
  for (const r of store.listDaily(range)) {
    byDay.set(r.day, mergeUsage(byDay.get(r.day) ?? emptyUsage(), r));
  }
  const days: DayCostRow[] = week.days.map((day) => {
    const usage = byDay.get(day) ?? emptyUsage();
    return { day, usage, costUsd: costOf(usage, pricing) };
  });

  // ---- 按模块：钱 ----
  const usageByBucket = new Map<string, { projectId: number; moduleId: number; slug: string; name: string; usage: UsageTotals }>();
  for (const r of store.listDailyByModule(range)) {
    const key = bucketKey(r.projectId, r.moduleId);
    const cur = usageByBucket.get(key);
    if (cur) cur.usage = mergeUsage(cur.usage, r);
    else {
      usageByBucket.set(key, {
        projectId: r.projectId,
        moduleId: r.moduleId,
        slug: r.moduleSlug,
        name: r.moduleName,
        usage: { ...r },
      });
    }
  }

  // ---- 按模块：结局 ----
  const outcomes = moduleOutcomes(db, {
    fromMs: week.fromMs,
    toMs: week.toMs,
    ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
  });

  // 只在结局侧出现的桶要补名字（那个模块本周没被扫到用量）
  const names = new Map<number, { slug: string; name: string }>();
  for (const m of db
    .query<{ id: number; slug: string; display_name: string }, []>(
      'SELECT id, slug, display_name FROM project_modules',
    )
    .all()) {
    names.set(m.id, { slug: m.slug, name: m.display_name });
  }

  // 本周有执行动作的模块**全部**要出现（发起人拍板）：有钱的、有结局的、只是动过的，三者取并集
  const active = activeModuleBuckets(db, {
    fromMs: week.fromMs,
    toMs: week.toMs,
    ...(opts.projectId === undefined ? {} : { projectId: opts.projectId }),
  });
  const keys = new Set<string>([...usageByBucket.keys(), ...outcomes.keys(), ...active]);
  const modules: ModuleWeekRow[] = [];
  for (const key of keys) {
    const [projectIdRaw, moduleIdRaw] = key.split(':');
    const projectId = Number(projectIdRaw);
    const moduleId = Number(moduleIdRaw);
    const fromUsage = usageByBucket.get(key);
    const named = names.get(moduleId);
    const usage = fromUsage?.usage ?? emptyUsage();
    modules.push({
      projectId,
      moduleId,
      moduleSlug: fromUsage?.slug || named?.slug || '',
      moduleName: fromUsage?.name || named?.name || '',
      usage,
      costUsd: costOf(usage, pricing),
      // 未归因桶没有 issue，结局指标不适用
      outcomes: moduleId === MODULE_UNATTRIBUTED ? null : (outcomes.get(key) ?? emptyOutcomes()),
    });
  }
  modules.sort((a, b) => (b.costUsd - a.costUsd) || (a.projectId - b.projectId) || (a.moduleId - b.moduleId));

  // ---- 合计：钱按天加（含未归因），结局按桶加 ----
  let usageTotal = emptyUsage();
  for (const d of days) usageTotal = mergeUsage(usageTotal, d.usage);
  const sum = (pick: (o: ModuleOutcomeStats) => number): number =>
    [...outcomes.values()].reduce((acc, o) => acc + pick(o), 0);
  const doneCount = sum((o) => o.doneCount);
  const blockedCount = sum((o) => o.blockedCount);
  const cancelledCount = sum((o) => o.cancelledCount);
  const failedCount = sum((o) => o.failedCount);
  const outcomeCount = sum((o) => o.outcomeCount);
  const recoveredCount = sum((o) => o.recoveredCount);

  return {
    week,
    pricing,
    days,
    modules,
    totals: {
      usage: usageTotal,
      costUsd: costOf(usageTotal, pricing),
      doneCount,
      blockedCount,
      cancelledCount,
      failedCount,
      outcomeCount,
      failureRate: outcomeCount === 0 ? 0 : failedCount / outcomeCount,
      recoveredCount,
      recoveryRate: blockedCount === 0 ? 0 : recoveredCount / blockedCount,
    },
  };
}

export { MODULE_NONE, MODULE_UNATTRIBUTED };

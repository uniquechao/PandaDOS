/**
 * core/usage-store —— 成本埋点的落库与聚合（#282 / I-08、I-09）。
 *
 * 三张表都是**派生数据**（真值是执行机上的 jsonl / rollout 原文），所以这里的写入一律幂等：
 * conversation 侧按 `conv_id` 覆盖累计值 + 推进游标，issue 侧与按天分桶侧（`usage_daily`，
 * 065 / #295）按增量累加。累加表都必须被 `resetScan` 清掉，否则回扫一次数字就翻倍。
 * 计数口径见 `core/usage.ts` 的文件头——离线对齐校验按那里核对。
 */
import type { Database } from 'bun:sqlite';
import { emptyUsage, type UsagePricing, type UsageTotals } from './usage';

export type UsageKind = 'issue' | 'chat';

export interface ConversationUsageRow extends UsageTotals {
  convId: string;
  projectId: number;
  kind: UsageKind;
  /** 已扫描到的字节位置（增量游标） */
  scannedBytes: number;
  updatedTs: number;
}

/** 聚合结果：一行 = 一个维度（项目 / issue / 非 Issue 会话） */
export interface UsageBucket extends UsageTotals {
  projectId: number;
  /** issue 维度才有 */
  issueId?: number;
}

/**
 * 按天分桶的一行（`usage_daily`）。`day` 是北京时间日键 `YYYY-MM-DD`（见 065 迁移文件头）。
 */
export interface DailyUsageRow extends UsageTotals {
  day: string;
  projectId: number;
}

/** 「未归模块」：归到了 issue，但那条 issue 没有 module_id（或 issue 已被删） */
export const MODULE_NONE = 0;
/** 「未归因」：`usage_daily.issue_id = 0`——chat 会话、模块空档期、agent 收尾输出 */
export const MODULE_UNATTRIBUTED = -1;

/** 按天 × 模块分桶的一行；`moduleId` 可能是上面两个哨兵值 */
export interface DailyModuleUsageRow extends UsageTotals {
  day: string;
  projectId: number;
  moduleId: number;
  /** 哨兵桶为空串 */
  moduleSlug: string;
  moduleName: string;
}

/** 分桶查询的筛选条件；`from` / `to` 都是日键，闭区间（字符串比较即日期比较） */
export interface DailyRange {
  from?: string;
  to?: string;
  projectId?: number;
}

const COUNTER_COLUMNS = [
  'requests',
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'compactions',
  'tool_calls',
  'skill_reads',
] as const;

interface CounterRow {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  compactions: number;
  tool_calls: number;
  skill_reads: number;
}

function mapTotals(r: CounterRow): UsageTotals {
  return {
    requests: r.requests,
    inputTokens: r.input_tokens,
    cachedInputTokens: r.cached_input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    compactions: r.compactions,
    toolCalls: r.tool_calls,
    skillReads: r.skill_reads,
  };
}

/** 聚合查询共用的求和列（顺序与 CounterRow 一致） */
const SUM_COLUMNS = COUNTER_COLUMNS.map((c) => `COALESCE(SUM(${c}), 0) AS ${c}`).join(', ');

/**
 * 分桶查询的 WHERE 片段。日键是 `YYYY-MM-DD` 定长格式，字符串比较即日期比较，
 * 不需要再折算成毫秒（也就不会出现「两个读取方折算口径不一致」的老问题）。
 */
function dailyWhere(
  range: DailyRange,
  dayCol: string,
  projectCol: string,
): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (range.from !== undefined) {
    clauses.push(`${dayCol} >= ?`);
    params.push(range.from);
  }
  if (range.to !== undefined) {
    clauses.push(`${dayCol} <= ?`);
    params.push(range.to);
  }
  if (range.projectId !== undefined) {
    clauses.push(`${projectCol} = ?`);
    params.push(range.projectId);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

/**
 * 单价初值（gpt-5 档，#282 / Q2）：**只在这里写一次**。
 * 050 的 `usage_pricing` 没配过、或整张表还没建（旧库、离线核对脚本读生产库）时都退回它——
 * 单价随模型与套餐变，真值以后台配置为准，这里只保证「读不到不报错、也不给 0 元的假账」。
 */
export const DEFAULT_PRICING: UsagePricing = {
  currency: 'USD',
  inputPerMTok: 1.25,
  cachedInputPerMTok: 0.125,
  outputPerMTok: 10,
  reasoningPerMTok: 0,
};

export class UsageStore {
  constructor(private readonly db: Database) {}

  getConversation(convId: string): ConversationUsageRow | undefined {
    const r = this.db
      .query<CounterRow & {
        conv_id: string; project_id: number; kind: string; scanned_bytes: number; updated_ts: number;
      }, [string]>('SELECT * FROM conversation_usage WHERE conv_id = ?')
      .get(convId);
    if (!r) return undefined;
    return {
      convId: r.conv_id,
      projectId: r.project_id,
      kind: r.kind === 'chat' ? 'chat' : 'issue',
      scannedBytes: r.scanned_bytes,
      updatedTs: r.updated_ts,
      ...mapTotals(r),
    };
  }

  /**
   * 覆盖写一条 conversation 的累计值与游标。
   *
   * **覆盖而不是累加**：扫描侧持有整条会话的累计（含去重台账），每次把当前累计整体写回来，
   * 这样重复调用不会翻倍，游标回退重扫也能自然纠正。
   */
  upsertConversation(row: Omit<ConversationUsageRow, 'updatedTs'>, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO conversation_usage
           (conv_id, project_id, kind, scanned_bytes, ${COUNTER_COLUMNS.join(', ')}, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conv_id) DO UPDATE SET
           project_id = excluded.project_id,
           kind = excluded.kind,
           scanned_bytes = excluded.scanned_bytes,
           requests = excluded.requests,
           input_tokens = excluded.input_tokens,
           cached_input_tokens = excluded.cached_input_tokens,
           output_tokens = excluded.output_tokens,
           reasoning_tokens = excluded.reasoning_tokens,
           compactions = excluded.compactions,
           tool_calls = excluded.tool_calls,
           skill_reads = excluded.skill_reads,
           updated_ts = excluded.updated_ts`,
      )
      .run(
        row.convId, row.projectId, row.kind, row.scannedBytes,
        row.requests, row.inputTokens, row.cachedInputTokens, row.outputTokens,
        row.reasoningTokens, row.compactions, row.toolCalls, row.skillReads,
        now,
      );
  }

  /** 把一份增量累加到某条 issue 上（归因写入用；同一 issue 会被多次追加） */
  addIssue(issueId: number, projectId: number, delta: UsageTotals, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO issue_usage
           (issue_id, project_id, ${COUNTER_COLUMNS.join(', ')}, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(issue_id) DO UPDATE SET
           project_id = excluded.project_id,
           requests = issue_usage.requests + excluded.requests,
           input_tokens = issue_usage.input_tokens + excluded.input_tokens,
           cached_input_tokens = issue_usage.cached_input_tokens + excluded.cached_input_tokens,
           output_tokens = issue_usage.output_tokens + excluded.output_tokens,
           reasoning_tokens = issue_usage.reasoning_tokens + excluded.reasoning_tokens,
           compactions = issue_usage.compactions + excluded.compactions,
           tool_calls = issue_usage.tool_calls + excluded.tool_calls,
           skill_reads = issue_usage.skill_reads + excluded.skill_reads,
           updated_ts = excluded.updated_ts`,
      )
      .run(
        issueId, projectId,
        delta.requests, delta.inputTokens, delta.cachedInputTokens, delta.outputTokens,
        delta.reasoningTokens, delta.compactions, delta.toolCalls, delta.skillReads,
        now,
      );
  }

  getIssue(issueId: number): UsageTotals {
    const r = this.db
      .query<CounterRow, [number]>('SELECT * FROM issue_usage WHERE issue_id = ?')
      .get(issueId);
    return r ? mapTotals(r) : emptyUsage();
  }

  /** 按 issue 列出（可限定项目）；只列真有用量的 */
  listIssueUsage(projectId?: number): UsageBucket[] {
    const rows = projectId === undefined
      ? this.db.query<CounterRow & { issue_id: number; project_id: number }, []>(
        'SELECT * FROM issue_usage ORDER BY output_tokens DESC, issue_id',
      ).all()
      : this.db.query<CounterRow & { issue_id: number; project_id: number }, [number]>(
        'SELECT * FROM issue_usage WHERE project_id = ? ORDER BY output_tokens DESC, issue_id',
      ).all(projectId);
    return rows.map((r) => ({ projectId: r.project_id, issueId: r.issue_id, ...mapTotals(r) }));
  }

  /**
   * 把一份增量累加到「某天 × 某条 issue」上（`usage_daily`，065 / #295）。
   *
   * 与 `addIssue` 一样是**累加**写入：采集器每轮只处理新增的那一段字节，同一天会被追加很多次。
   * `issueId = 0` 表示未归因（chat 会话、模块空档期）——那块余量必须留在表里看得见。
   */
  addDaily(day: string, projectId: number, issueId: number, delta: UsageTotals, now = Date.now()): void {
    this.db
      .query(
        `INSERT INTO usage_daily
           (day, project_id, issue_id, ${COUNTER_COLUMNS.join(', ')}, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day, project_id, issue_id) DO UPDATE SET
           requests = usage_daily.requests + excluded.requests,
           input_tokens = usage_daily.input_tokens + excluded.input_tokens,
           cached_input_tokens = usage_daily.cached_input_tokens + excluded.cached_input_tokens,
           output_tokens = usage_daily.output_tokens + excluded.output_tokens,
           reasoning_tokens = usage_daily.reasoning_tokens + excluded.reasoning_tokens,
           compactions = usage_daily.compactions + excluded.compactions,
           tool_calls = usage_daily.tool_calls + excluded.tool_calls,
           skill_reads = usage_daily.skill_reads + excluded.skill_reads,
           updated_ts = excluded.updated_ts`,
      )
      .run(
        day, projectId, issueId,
        delta.requests, delta.inputTokens, delta.cachedInputTokens, delta.outputTokens,
        delta.reasoningTokens, delta.compactions, delta.toolCalls, delta.skillReads,
        now,
      );
  }

  /** 按天聚合（可限定日期闭区间与项目）；一天一行，按 day 升序——趋势要按时间读 */
  listDaily(range: DailyRange = {}): DailyUsageRow[] {
    const { where, params } = dailyWhere(range, 'day', 'project_id');
    return this.db
      .query<CounterRow & { day: string; project_id: number }, (string | number)[]>(
        `SELECT day, project_id, ${SUM_COLUMNS} FROM usage_daily
          ${where} GROUP BY day, project_id ORDER BY day, project_id`,
      )
      .all(...params)
      .map((r) => ({ day: r.day, projectId: r.project_id, ...mapTotals(r) }));
  }

  /**
   * 按「天 × 模块」聚合：模块归属**在读取侧 join 出来**（`issues.module_id`），
   * 不冻结在分桶行里——issue 之后被挪到别的模块，历史分桶会跟着改归属（见 065 文件头）。
   *
   * 两个哨兵桶：`MODULE_UNATTRIBUTED`（未归因，issue_id=0）与 `MODULE_NONE`
   * （归到了 issue 但那条 issue 没有模块，或 issue 已被删）。两者含义不同，不许合并。
   */
  listDailyByModule(range: DailyRange = {}): DailyModuleUsageRow[] {
    const { where, params } = dailyWhere(range, 'u.day', 'u.project_id');
    return this.db
      .query<CounterRow & {
        day: string; project_id: number; module_id: number; slug: string | null; display_name: string | null;
      }, (string | number)[]>(
        `SELECT b.day AS day, b.project_id AS project_id, b.module_id AS module_id,
                m.slug AS slug, m.display_name AS display_name, ${SUM_COLUMNS}
           FROM (
             SELECT u.day AS day, u.project_id AS project_id,
                    CASE WHEN u.issue_id = 0 THEN ${MODULE_UNATTRIBUTED}
                         ELSE COALESCE(i.module_id, ${MODULE_NONE}) END AS module_id,
                    ${COUNTER_COLUMNS.map((c) => `u.${c} AS ${c}`).join(', ')}
               FROM usage_daily u
               LEFT JOIN issues i ON i.id = u.issue_id
              ${where}
           ) b
           LEFT JOIN project_modules m ON m.id = b.module_id
          GROUP BY b.day, b.project_id, b.module_id
          ORDER BY b.day, b.project_id, b.module_id`,
      )
      .all(...params)
      .map((r) => ({
        day: r.day,
        projectId: r.project_id,
        moduleId: r.module_id,
        moduleSlug: r.slug ?? '',
        moduleName: r.display_name ?? '',
        ...mapTotals(r),
      }));
  }

  /** 按项目汇总 conversation 侧的总量（= 该项目所有会话的真实开销） */
  listProjectUsage(): UsageBucket[] {
    return this.db
      .query<CounterRow & { project_id: number }, []>(
        `SELECT project_id, ${SUM_COLUMNS} FROM conversation_usage
          GROUP BY project_id ORDER BY output_tokens DESC, project_id`,
      )
      .all()
      .map((r) => ({ projectId: r.project_id, ...mapTotals(r) }));
  }

  /**
   * 「非 Issue 会话」：`kind='chat'` 的项目对话。
   * 注意它与「归不到 issue 的余量」不是一回事——后者见 unattributedByProject。
   */
  listChatUsage(): UsageBucket[] {
    return this.db
      .query<CounterRow & { project_id: number }, []>(
        `SELECT project_id, ${SUM_COLUMNS} FROM conversation_usage
          WHERE kind = 'chat' GROUP BY project_id ORDER BY output_tokens DESC, project_id`,
      )
      .all()
      .map((r) => ({ projectId: r.project_id, ...mapTotals(r) }));
  }

  /**
   * 每个项目「会话总量 − 已归因到 issue 的量」。
   * 这块余量就是本条要暴露的东西：chat 会话、模块空档期、以及**归因口径出问题**的部分——
   * 它长期不为零本身就是个信号，别把它藏起来。
   */
  unattributedByProject(): UsageBucket[] {
    const attributed = new Map<number, UsageTotals>();
    for (const row of this.db
      .query<CounterRow & { project_id: number }, []>(
        `SELECT project_id, ${SUM_COLUMNS} FROM issue_usage GROUP BY project_id`,
      )
      .all()) {
      attributed.set(row.project_id, mapTotals(row));
    }
    return this.listProjectUsage().map((total) => {
      const used = attributed.get(total.projectId) ?? emptyUsage();
      const sub = (a: number, b: number): number => Math.max(0, a - b);
      return {
        projectId: total.projectId,
        requests: sub(total.requests, used.requests),
        inputTokens: sub(total.inputTokens, used.inputTokens),
        cachedInputTokens: sub(total.cachedInputTokens, used.cachedInputTokens),
        outputTokens: sub(total.outputTokens, used.outputTokens),
        reasoningTokens: sub(total.reasoningTokens, used.reasoningTokens),
        compactions: sub(total.compactions, used.compactions),
        toolCalls: sub(total.toolCalls, used.toolCalls),
        skillReads: sub(total.skillReads, used.skillReads),
      };
    });
  }

  /** 全局总量（所有项目一起看——本条的成本视图就是这个口径） */
  grandTotal(): UsageTotals {
    const r = this.db
      .query<CounterRow, []>(`SELECT ${SUM_COLUMNS} FROM conversation_usage`)
      .get();
    return r ? mapTotals(r) : emptyUsage();
  }

  /** 单价表（050）：读不到就退回 gpt-5 档初值——没配过不该让成本页整块报错 */
  pricing(): UsagePricing {
    const r = this.db
      .query<{
        currency: string; input_per_mtok: number; cached_input_per_mtok: number;
        output_per_mtok: number; reasoning_per_mtok: number;
      }, []>('SELECT * FROM usage_pricing WHERE id = 1')
      .get();
    return {
      currency: r?.currency ?? DEFAULT_PRICING.currency,
      inputPerMTok: r?.input_per_mtok ?? DEFAULT_PRICING.inputPerMTok,
      cachedInputPerMTok: r?.cached_input_per_mtok ?? DEFAULT_PRICING.cachedInputPerMTok,
      outputPerMTok: r?.output_per_mtok ?? DEFAULT_PRICING.outputPerMTok,
      reasoningPerMTok: r?.reasoning_per_mtok ?? DEFAULT_PRICING.reasoningPerMTok,
    };
  }

  /** 写单价（admin 可配；负数与非有限值直接拒绝） */
  setPricing(next: UsagePricing, now = Date.now()): UsagePricing {
    const ok = (v: number): boolean => Number.isFinite(v) && v >= 0;
    if (![next.inputPerMTok, next.cachedInputPerMTok, next.outputPerMTok, next.reasoningPerMTok].every(ok)) {
      throw new Error('单价必须是非负数');
    }
    this.db
      .query(
        `INSERT INTO usage_pricing
           (id, currency, input_per_mtok, cached_input_per_mtok, output_per_mtok, reasoning_per_mtok, updated_ts)
         VALUES (1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           currency = excluded.currency,
           input_per_mtok = excluded.input_per_mtok,
           cached_input_per_mtok = excluded.cached_input_per_mtok,
           output_per_mtok = excluded.output_per_mtok,
           reasoning_per_mtok = excluded.reasoning_per_mtok,
           updated_ts = excluded.updated_ts`,
      )
      .run(
        (next.currency || 'USD').slice(0, 8),
        next.inputPerMTok, next.cachedInputPerMTok, next.outputPerMTok, next.reasoningPerMTok,
        now,
      );
    return this.pricing();
  }

  /**
   * 回扫入口（#282 / Q3）：把游标与累计清零，下一轮采集从头重算。
   *
   * **必须同时清所有累加表**（`issue_usage` 与 `usage_daily`）：它们是累加的，只把 conversation
   * 游标归零而不清它们，重扫会把同一段用量再加一遍——这类「重跑一次数字就翻倍」的坑最难查。
   * 返回被重置的会话数。
   */
  resetScan(projectId?: number): number {
    if (projectId === undefined) {
      this.db.run('DELETE FROM issue_usage');
      this.db.run('DELETE FROM usage_daily');
      const r = this.db.query('UPDATE conversation_usage SET scanned_bytes = 0, requests = 0, input_tokens = 0, cached_input_tokens = 0, output_tokens = 0, reasoning_tokens = 0, compactions = 0, tool_calls = 0, skill_reads = 0').run();
      return r.changes;
    }
    this.db.query('DELETE FROM issue_usage WHERE project_id = ?').run(projectId);
    this.db.query('DELETE FROM usage_daily WHERE project_id = ?').run(projectId);
    const r = this.db
      .query('UPDATE conversation_usage SET scanned_bytes = 0, requests = 0, input_tokens = 0, cached_input_tokens = 0, output_tokens = 0, reasoning_tokens = 0, compactions = 0, tool_calls = 0, skill_reads = 0 WHERE project_id = ?')
      .run(projectId);
    return r.changes;
  }
}

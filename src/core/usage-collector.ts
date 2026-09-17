/**
 * core/usage-collector —— 按 conversation 增量扫 jsonl，落成本埋点（#282 / I-08、I-09）。
 *
 * 设计要点（改这里之前先读完）：
 *
 * 1. **必须增量**。真机上单个 rollout 文件能到 127MB，每轮全量重扫既烧执行机 IO，也烧 SSH 流量。
 *    游标 `conversation_usage.scanned_bytes` 记「已扫到第几个字节」，每轮只读新增的那一段。
 * 2. **行截断安全**：新增段的末尾几乎总是半行（agent 正在写），所以只处理到最后一个换行为止，
 *    游标停在那里；半行留到下一轮再读。`parseUsageLine` 对半行也返回空增量，双保险。
 * 3. **去重台账跨轮次续得上**：
 *    - codex 用单调累计计量，`seen.cumulative` 直接用库里已有的累计值续上，天然精确；
 *    - claude 按 `message.id` 去重，而重复行是**紧挨着**的，所以每轮回读一小段重叠窗口
 *      （`OVERLAP_BYTES`），**只登记 id、不累加**，把跨批次边界的重复挡住。
 * 4. **归因按 segment 时间边界**：一条 conv 上的 `conversation_segment_started/ended`（#277）
 *    划出每条 issue 的区间，行的时间戳落进哪个区间就算谁的。落不进任何区间的
 *    （chat 会话、模块空档期、agent 自己的收尾输出）**不写 issue_usage**，
 *    在读取侧显示为「非 Issue 会话」——这块余量是要给人看的，不许悄悄摊到某条 issue 上。
 * 5. **按天分桶与归因同源**（065 / #295）：同一份「本行新增」既累加到 issue，也累加到
 *    `usage_daily` 的 (北京时间日键, issueId) 桶里——两边用同一个增量，天然对得上。
 *    归不进任何 segment 的落 `issue_id = 0`（未归因桶，照样要看得见）。
 * 6. **失败只留痕不阻断**：定时任务，扫不动就下一轮再来；绝不因为统计失败影响任何执行路径。
 */
import type { Database } from 'bun:sqlite';
import {
  accumulateUsage,
  emptySeen,
  emptyUsage,
  mergeUsage,
  parseUsageLine,
  type UsageTotals,
} from './usage';
import { UsageStore, type UsageKind } from './usage-store';
import { localDay } from './daily-greeting';

/** 回读窗口：只用来登记 id 挡跨批次重复，不参与累加 */
export const OVERLAP_BYTES = 32 * 1024;
/** 单轮单会话最多读多少（防一次把巨大的历史文件全吸进内存） */
export const MAX_SCAN_BYTES_PER_PASS = 8 * 1024 * 1024;

/** 采集器只需要 Driver 的两件事 */
export interface UsageCollectorDriver {
  statPath(path: string): Promise<{ size: number; isFile: boolean } | null>;
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
}

export interface UsageCollectorDeps {
  db: Database;
  driver: UsageCollectorDriver;
  /** convId → jsonl 绝对路径（core/jsonl 的 JsonlLocator 结构兼容）；找不到返回 null */
  locate(convId: string): Promise<string | null>;
  now?: () => number;
  /** 失败留痕（默认 console.error）；绝不抛出 */
  onError?: (convId: string, error: unknown) => void;
}

export interface UsageCollectorConfig {
  /** 扫描间隔；<= 0 = 关闭采集 */
  intervalMs: number;
}

export const DEFAULT_USAGE_COLLECTOR_CONFIG: UsageCollectorConfig = {
  intervalMs: 5 * 60 * 1000,
};

/** 一条 conv 的扫描结果（返回给调用方/测试看，不落库） */
export interface ScanOutcome {
  convId: string;
  /** 本轮真正处理掉的字节数（不含重叠窗口） */
  scanned: number;
  /** 归因到 issue 的用量条数 */
  attributed: number;
  skipped?: 'no-file' | 'no-new-bytes' | 'error';
}

interface ConvRow {
  id: string;
  project_id: number;
  kind: string | null;
}

interface Segment {
  issueId: number;
  start: number;
  /** 未结束的段用 +∞：还在跑的 issue 也要算进去 */
  end: number;
}

/** 从行首附近抠出 timestamp（两种格式都把它放在行首）。抠不到返回 undefined。 */
export function lineTimestamp(line: string): number | undefined {
  const m = /"timestamp"\s*:\s*"([^"]{4,40})"/.exec(line.slice(0, 200));
  if (!m) return undefined;
  const ms = Date.parse(m[1]!);
  return Number.isNaN(ms) ? undefined : ms;
}

/** 按时间戳找归属 issue；落不进任何段返回 null（= 非 Issue 会话） */
export function attributeTo(segments: readonly Segment[], ts: number | undefined): number | null {
  if (ts === undefined) return null;
  for (const s of segments) {
    if (ts >= s.start && ts <= s.end) return s.issueId;
  }
  return null;
}

export class UsageCollector {
  private readonly store: UsageStore;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly deps: UsageCollectorDeps,
    private readonly cfg: UsageCollectorConfig = DEFAULT_USAGE_COLLECTOR_CONFIG,
  ) {
    this.store = new UsageStore(deps.db);
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer || this.cfg.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 扫一轮所有未归档会话（单飞：上一轮没跑完就跳过这一轮） */
  async tick(): Promise<ScanOutcome[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const convs = this.deps.db
        .query<ConvRow, []>('SELECT id, project_id, kind FROM conversations WHERE archived = 0 ORDER BY id')
        .all();
      const out: ScanOutcome[] = [];
      for (const conv of convs) out.push(await this.scanConversation(conv));
      return out;
    } finally {
      this.running = false;
    }
  }

  /** 扫一条会话（公开供路由/测试直接触发） */
  async scanConversation(conv: ConvRow): Promise<ScanOutcome> {
    const convId = conv.id;
    try {
      const path = await this.deps.locate(convId);
      if (!path) return { convId, scanned: 0, attributed: 0, skipped: 'no-file' };
      const stat = await this.deps.driver.statPath(path);
      if (!stat?.isFile) return { convId, scanned: 0, attributed: 0, skipped: 'no-file' };

      const saved = this.store.getConversation(convId);
      // 文件被换掉/截断（size 比游标还小）→ 游标归零重扫，累计一并从头来
      const truncated = saved !== undefined && stat.size < saved.scannedBytes;
      const cursor = truncated ? 0 : (saved?.scannedBytes ?? 0);
      let totals: UsageTotals = truncated || !saved ? emptyUsage() : {
        requests: saved.requests,
        inputTokens: saved.inputTokens,
        cachedInputTokens: saved.cachedInputTokens,
        outputTokens: saved.outputTokens,
        reasoningTokens: saved.reasoningTokens,
        compactions: saved.compactions,
        toolCalls: saved.toolCalls,
        skillReads: saved.skillReads,
      };
      if (stat.size <= cursor) return { convId, scanned: 0, attributed: 0, skipped: 'no-new-bytes' };

      // 重叠窗口只登记 id、不累加：挡住跨批次边界的 claude 重复行
      const overlapFrom = Math.max(0, cursor - OVERLAP_BYTES);
      const readFrom = overlapFrom;
      const limit = Math.min(MAX_SCAN_BYTES_PER_PASS, stat.size - readFrom);
      const chunk = await this.deps.driver.readFileRange(path, readFrom, limit);
      const text = new TextDecoder().decode(chunk.data);

      const seen = emptySeen();
      // codex 的单调计量从库里的累计值续上；claude 不受影响（它不看 cumulative）
      if (!truncated && saved) {
        seen.cumulative = {
          inputTokens: totals.inputTokens,
          cachedInputTokens: totals.cachedInputTokens,
          outputTokens: totals.outputTokens,
          reasoningTokens: totals.reasoningTokens,
        };
      }

      const segments = this.segmentsOf(convId);
      const perIssue = new Map<number, UsageTotals>();
      /** 按天分桶：key = `${day}\u0000${issueId}`（issueId 0 = 未归因），值是这一天这一桶的增量 */
      const perDay = new Map<string, UsageTotals>();
      const now = this.now();
      let consumed = readFrom; // 已处理到的绝对字节位置
      let attributed = 0;
      let offset = readFrom;
      for (const rawLine of text.split('\n')) {
        const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1; // +1 = '\n'
        const lineStart = offset;
        offset += lineBytes;
        if (offset > readFrom + chunk.data.length) break; // 末尾半行：留到下一轮
        consumed = offset;
        if (!rawLine.trim()) continue;
        const delta = parseUsageLine(rawLine);
        if (lineStart < cursor) {
          // 重叠窗口：只登记去重键，绝不累加
          if (delta.requestId !== undefined) seen.requests.add(delta.requestId);
          for (const id of delta.toolCallIds) seen.toolCalls.add(id);
          continue;
        }
        const before = totals;
        totals = accumulateUsage(totals, delta, seen);
        const gained = diff(before, totals);
        if (isEmpty(gained)) continue;
        const ts = lineTimestamp(rawLine);
        const issueId = attributeTo(segments, ts);
        // 日键按北京时间（发起人拍板；与 core/activity 的日切同口径）。
        // 抠不出时间戳的行（截断/新格式）只能落在扫描时刻当日：这类行极少，
        // 丢掉就等于凭空少一笔钱，摊到今天只影响当天一格，比丢账可接受。
        const day = localDay(ts ?? now);
        const key = `${day}\u0000${issueId ?? 0}`;
        perDay.set(key, mergeUsage(perDay.get(key) ?? emptyUsage(), gained));
        if (issueId === null) continue; // 非 Issue 会话：只进 conversation 侧与未归因日桶
        perIssue.set(issueId, mergeUsage(perIssue.get(issueId) ?? emptyUsage(), gained));
      }

      this.store.upsertConversation({
        convId,
        projectId: conv.project_id,
        kind: (conv.kind === 'chat' ? 'chat' : 'issue') as UsageKind,
        scannedBytes: Math.min(consumed, stat.size),
        ...totals,
      }, now);
      for (const [issueId, delta] of perIssue) {
        this.store.addIssue(issueId, conv.project_id, delta, now);
        attributed++;
      }
      for (const [key, delta] of perDay) {
        const sep = key.indexOf('\u0000');
        this.store.addDaily(key.slice(0, sep), conv.project_id, Number(key.slice(sep + 1)), delta, now);
      }
      return { convId, scanned: Math.max(0, consumed - cursor), attributed };
    } catch (e) {
      (this.deps.onError ?? ((id, err) => console.error(`[usage] 扫描 ${id} 失败:`, err)))(convId, e);
      return { convId, scanned: 0, attributed: 0, skipped: 'error' };
    }
  }

  /**
   * 这条 conv 上各 issue 的时间区间（#277 的 segment 事件）。
   * 未结束的段按 +∞ 处理——还在跑的 issue 同样要计费。
   */
  private segmentsOf(convId: string): Segment[] {
    const rows = this.deps.db
      .query<{ issue_id: number; kind: string; ts: number; data_json: string | null }, [string]>(
        `SELECT e.issue_id, e.kind, e.ts, e.data_json FROM issue_events e
           JOIN issues i ON i.id = e.issue_id
          WHERE i.conv_id = ?
            AND e.kind IN ('conversation_segment_started', 'conversation_segment_ended')
          ORDER BY e.id`,
      )
      .all(convId);
    const out: Segment[] = [];
    const open = new Map<number, number>();
    for (const r of rows) {
      if (r.kind === 'conversation_segment_started') {
        open.set(r.issue_id, r.ts);
        continue;
      }
      const start = open.get(r.issue_id);
      if (start === undefined) continue;
      open.delete(r.issue_id);
      out.push({ issueId: r.issue_id, start, end: r.ts });
    }
    for (const [issueId, start] of open) {
      out.push({ issueId, start, end: Number.POSITIVE_INFINITY });
    }
    return out.sort((a, b) => a.start - b.start);
  }
}

function diff(before: UsageTotals, after: UsageTotals): UsageTotals {
  return {
    requests: after.requests - before.requests,
    inputTokens: after.inputTokens - before.inputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    reasoningTokens: after.reasoningTokens - before.reasoningTokens,
    compactions: after.compactions - before.compactions,
    toolCalls: after.toolCalls - before.toolCalls,
    skillReads: after.skillReads - before.skillReads,
  };
}

function isEmpty(t: UsageTotals): boolean {
  return t.requests === 0 && t.inputTokens === 0 && t.cachedInputTokens === 0 && t.outputTokens === 0
    && t.reasoningTokens === 0 && t.compactions === 0 && t.toolCalls === 0 && t.skillReads === 0;
}

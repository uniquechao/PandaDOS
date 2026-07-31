/**
 * agents/progress —— 进度事件批量 flush + 「值不值得推」过滤（v1 agent.ts:46-109 平移）。
 *
 * 机制（v1 验证过的两级缓冲 + 定时批处理）：
 * - add() 进 per-项目缓冲；tool_result 报错走即时旁路 flush（v1 agent.ts:60）；
 * - 定时器每 max(5, throttleSeconds)s flush 一次（默认 30s，v1 config 平移）；
 * - flush：渲染活动行 → 截断 → analyze（ANALYZE_SYS 逐字平移，jsonMode）→
 *   push=false 静默；push=true 产出 {push, status, needsReply, headline} 给 NotifyRouter。
 *
 * 相对 v1 的修债：
 * - H14：先清缓冲再 analyze、失败整批蒸发 → LLM 失败**回插缓冲**，下轮重试；
 * - M18：截断保头弃尾（判「最新活动」的依据反而偏旧）→ **保尾**（slice(-maxChars)）；
 * - M18：确定性事件（状态变更/卡点/done/blocked）不走本管道——engine 直发 NotifyRouter，
 *   本管道只滤 implementing 阶段的 jsonl 噪音；
 * - H4：runningSummary 从内存 Map 可选落 DB（pm_progress 表，040 迁移），重启不丢；
 * - M6：flush 单飞（in-flight 时跳过，事件留在缓冲等下轮）。
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient } from './llm';

// ---------- 事件状态分类（v1 cards.ts isEventStatus 语义平移，与 ANALYZE_SYS 的 schema 配套） ----------

export type EventStatus = 'milestone' | 'waiting' | 'error' | 'done' | 'working';

const EVENT_STATUSES: readonly string[] = ['milestone', 'waiting', 'error', 'done', 'working'];

export function isEventStatus(s: unknown): s is EventStatus {
  return typeof s === 'string' && EVENT_STATUSES.includes(s);
}

export interface ProgressAnalysis {
  push: boolean;
  status: EventStatus;
  needsReply: boolean;
  headline: string;
}

// ---------- prompt 常量（v1 agent.ts:90-95 逐字平移；schema 与 isEventStatus 配套改） ----------

export const ANALYZE_SYS = `# 任务：判断要不要打扰主人，并分类
分析这个 Claude Code 会话的最新活动，只输出 JSON：
{"push": bool, "status": "milestone|waiting|error|done|working", "needsReply": bool, "headline": "≤40字中文一句话进度，口语，不要带会话名"}
规则（宁可漏推也别刷屏，拿不准就 push=false）：
· push=false（进行中的单步动作）：'正在读/查看/分析 X'、'调用了某工具'、'正在写/改代码'、'正在跑测试'。
· push=true（值得打扰）：阶段/任务完成、测试通过或失败、报错、被卡住、**需要主人决策或回话**。
needsReply=true 当 CC 在问主人或在等主人输入/批准。只输出 JSON。`;

// ---------- 事件渲染（v1 fmtEvent 平移，输入改 core/jsonl 的 ChatMessage 形状） ----------

export interface ProgressEventLike {
  role: string;
  text?: string;
  tool?: string;
  input?: string;
  result?: string;
  isError?: boolean;
}

/** 一条 jsonl 消息 → 喂 LLM 的活动行（thinking 等未知角色渲染为空 = 过滤） */
export function fmtChatEvent(m: ProgressEventLike): string {
  switch (m.role) {
    case 'assistant':
      return `助手说：${m.text ?? ''}`;
    case 'tool_use':
      return `调用工具 ${m.tool ?? ''}（${m.input ?? ''}）`;
    case 'tool_result':
      return `工具结果${m.isError ? '(报错)' : ''}：${m.result ?? ''}`;
    case 'user':
      return `用户输入：${m.text ?? ''}`;
    default:
      return '';
  }
}

// ---------- analyze（v1 Agent.analyze 平移） ----------

/**
 * 驱动大模型 结构化分析：判断要不要推 + 状态分类 + 是否在等主人。
 * systemPrefix = PM systemPrompt（v1 语义：analyze 带人设；审批分级才用裸 system）。
 * LLM 调用错误**上抛**（调用方决定回插）；返回 JSON 解析失败降级 {push:false}（v1 兜底）。
 */
export async function analyzeProgress(
  llm: LlmClient,
  opts: { label: string; prev: string; activity: string; systemPrefix?: string },
): Promise<ProgressAnalysis> {
  const sys = (opts.systemPrefix ? `${opts.systemPrefix}\n\n` : '') + ANALYZE_SYS;
  const r = await llm.chat(
    [
      { role: 'system', content: sys },
      {
        role: 'user',
        content: `会话 @${opts.label}\n此前进度：${opts.prev || '(无)'}\n\n最新活动：\n${opts.activity}`,
      },
    ],
    { jsonMode: true },
  );
  try {
    const j = JSON.parse(r.content || '{}');
    return {
      push: Boolean(j.push),
      status: isEventStatus(j.status) ? j.status : 'working',
      headline: String(j.headline ?? '').trim(),
      needsReply: Boolean(j.needsReply),
    };
  } catch {
    return { push: false, status: 'working', headline: '', needsReply: false };
  }
}

// ---------- runningSummary 存储（内存 / DB 双实现） ----------

export interface SummaryStore {
  get(): string;
  set(v: string): void;
}

export class MemorySummaryStore implements SummaryStore {
  private v = '';
  get(): string {
    return this.v;
  }
  set(v: string): void {
    this.v = v;
  }
}

/** runningSummary 入库（pm_progress 表，040 迁移；评审 H4：重启不丢滚动摘要） */
export class DbSummaryStore implements SummaryStore {
  constructor(
    private readonly db: Database,
    private readonly projectId: number,
  ) {}

  get(): string {
    try {
      const r = this.db
        .query<{ running_summary: string }, [number]>(
          'SELECT running_summary FROM pm_progress WHERE project_id = ?',
        )
        .get(this.projectId);
      return r?.running_summary ?? '';
    } catch {
      return '';
    }
  }

  set(v: string): void {
    this.db
      .query(
        `INSERT INTO pm_progress (project_id, running_summary, updated_ts) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           running_summary = excluded.running_summary, updated_ts = excluded.updated_ts`,
      )
      .run(this.projectId, v, Date.now());
  }
}

// ---------- 批量 flush 报告器 ----------

export interface ProgressReporterOpts {
  /** 批处理窗口秒数，默认 30，下限 5（v1 max(5, throttleSeconds) 平移） */
  throttleSeconds?: number;
  /** 喂 LLM 的活动文本上限，默认 12000（v1 context.maxChars 平移）；截断**保尾** */
  maxChars?: number;
  /** PM systemPrompt 前缀（惰性取，persona/memory 可能在运行中被改） */
  systemPrefix?: () => string;
}

export const DEFAULT_THROTTLE_SECONDS = 30;
export const DEFAULT_MAX_CHARS = 12000;

/**
 * 每项目一个实例：进度事件缓冲 → 定时/报错触发 flush → 值得推才回调 onPush。
 * onPush 异常上抛（评审铁律：失败不许 void 吞掉——start() 的定时回调里 console.error 可见）。
 */
export class ProgressReporter {
  private buffer: ProgressEventLike[] = [];
  private inFlight = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    /** 通知文案里的会话标签（项目名） */
    private readonly label: string,
    private readonly llm: LlmClient,
    /** push=true 时的出口（NotifyRouter 适配层） */
    private readonly onPush: (a: ProgressAnalysis) => void | Promise<void>,
    private readonly summary: SummaryStore = new MemorySummaryStore(),
    private readonly opts: ProgressReporterOpts = {},
  ) {}

  /** 进一条事件；tool_result 报错 → 即时 flush 旁路（v1 agent.ts:60） */
  add(ev: ProgressEventLike): void {
    this.buffer.push(ev);
    if (ev.role === 'tool_result' && ev.isError) {
      void this.flush().catch((e) => console.error(`[pm-progress @${this.label}] 即时 flush 失败:`, e));
    }
  }

  get pendingCount(): number {
    return this.buffer.length;
  }

  /** 当前滚动摘要（观测/测试用） */
  get runningSummary(): string {
    return this.summary.get();
  }

  start(): void {
    if (this.timer) return;
    const periodMs = Math.max(5, this.opts.throttleSeconds ?? DEFAULT_THROTTLE_SECONDS) * 1000;
    this.timer = setInterval(() => {
      void this.flush().catch((e) => console.error(`[pm-progress @${this.label}] flush 失败:`, e));
    }, periodMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 批量 flush：值得推返回分析结果（并已回调 onPush），否则 null。
   * - 单飞：in-flight 时跳过，事件留缓冲（评审 M6）；
   * - LLM 调用失败：事件**回插缓冲头部**，下轮重试（评审 H14）；
   * - JSON 解析失败：analyze 内部降级 push=false（v1 兜底，事件视为已消费）。
   */
  async flush(): Promise<ProgressAnalysis | null> {
    if (this.inFlight || this.buffer.length === 0) return null;
    this.inFlight = true;
    const events = this.buffer;
    this.buffer = [];
    try {
      const maxChars = this.opts.maxChars ?? DEFAULT_MAX_CHARS;
      const activity = events.map(fmtChatEvent).filter(Boolean).join('\n').slice(-maxChars); // 保尾（M18）
      if (!activity) return null;
      let a: ProgressAnalysis;
      try {
        a = await analyzeProgress(this.llm, {
          label: this.label,
          prev: this.summary.get(),
          activity,
          systemPrefix: this.opts.systemPrefix?.(),
        });
      } catch {
        this.buffer = events.concat(this.buffer); // 失败回插（H14）
        return null;
      }
      if (!a.push || !a.headline) return null;
      this.summary.set(a.headline);
      const out: ProgressAnalysis = { ...a, status: a.needsReply ? 'waiting' : a.status }; // 等回话→橙色置顶（v1）
      await this.onPush(out);
      return out;
    } finally {
      this.inFlight = false;
    }
  }
}

/**
 * core/usage —— agent jsonl 的用量解析（#282 / I-08、I-09）。
 *
 * 现状是「没有任何成本口径」：问题只能靠事后手工扫 rollout 文件发现。这里把口径收口成一份
 * 纯函数，**离线对齐校验就按本文件的注释核对**——对不上说明埋点口径有问题，那是本条的验收方式。
 *
 * ## claude（~/.claude/projects/<slug>/<convId>.jsonl）
 * - 用量在 `type:'assistant'` 行的 `message.usage`：
 *   `input_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `output_tokens`
 *   / `output_tokens_details.thinking_tokens`。
 * - **同一次请求会被写成多行**：实测 1670 个带 usage 的行只对应 1195 个不同的 `message.id`
 *   （475 行是同 id 同 usage 的重复）。直接求和会多算约 28%，所以必须按 `message.id` 去重——
 *   这正是「跟 rollout 对不上」的头号原因。
 * - 缓存口径：`cache_read_input_tokens` 记为 cached；`cache_creation_input_tokens` 是真花钱的
 *   写入，计入 input（与账单口径一致，别把它算成 cached）。
 * - 压缩：`{type:'system', subtype:'compact_boundary'}`（老版本另有 `isCompactSummary:true`）。
 * - 工具调用：`assistant` 行 content 里的 `tool_use`，按 `id` 去重（同上，多行会重复出现）。
 *
 * ## codex（~/.codex/sessions/**\/rollout-*.jsonl）
 * - 用量在 `{type:'event_msg', payload:{type:'token_count', info}}`。这里**以
 *   `info.total_token_usage` 为准**：它是 codex 自己维护的会话累计（实测单调递增），
 *   我们按「单调计数器」取差值累加，于是离线对账天然对得上。
 *   **不要逐行累加 `info.last_token_usage`**：实测 207 个 token_count 事件里有 9 个与上一条
 *   完全相同（流式更新重复上报），逐行相加会比文件里的 total 多算约 6.6%。
 *   字段：`input_tokens` / `cached_input_tokens` / `cache_write_input_tokens` /
 *   `output_tokens` / `reasoning_output_tokens`。
 * - 压缩：顶层 `{type:'compacted'}`。
 * - 工具调用：`response_item` 里 `payload.type` 为 `function_call` / `custom_tool_call` /
 *   `local_shell_call`，按 `call_id` 去重。
 *
 * ## 通用纪律
 * - **坏行不抛错**：jsonl 会被截断（增量 tail 读到半行）、也会有认不出的新字段，一律返回空增量。
 * - **金额折算走后台可配的单价表**（`usage_pricing`，050 迁移），绝不把单价写死在代码里：
 *   单价随模型与套餐变，硬编码只会给出一个看起来精确的错数。折算函数见本文件的 `costOf`。
 */

/** 一行解析出来的用量增量（全部是「本行新增」，去重键另给） */
export interface UsageDelta {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  compactions: number;
  toolCalls: number;
  skillReads: number;
  /** 请求去重键（claude = message.id）。缺省表示这行不带按请求计的用量。 */
  requestId?: string;
  /**
   * 单调累计计量（codex 的 `total_token_usage`）：调用方按「本次 − 上次」取差值累加。
   * 用它而不是逐轮 `last_token_usage`，是因为后者会重复上报（见文件头）。
   */
  cumulative?: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  /** 本行出现的工具调用 id：同一请求写多行时会重复出现，调用方按它去重 */
  toolCallIds: string[];
}

/** 累计值（落库形状与它一一对应） */
export interface UsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  compactions: number;
  toolCalls: number;
  skillReads: number;
}

/** 去重台账：跨行、跨批次都必须是同一个实例，否则去重失效 */
export interface UsageSeen {
  requests: Set<string>;
  toolCalls: Set<string>;
  /** 上一次见到的单调累计值（codex）；用于取差值 */
  cumulative?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningTokens: number };
}

export const EMPTY_USAGE: UsageTotals = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  compactions: 0,
  toolCalls: 0,
  skillReads: 0,
};

export function emptyUsage(): UsageTotals {
  return { ...EMPTY_USAGE };
}

export function emptySeen(): UsageSeen {
  return { requests: new Set(), toolCalls: new Set() };
}

const EMPTY_DELTA: UsageDelta = {
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  compactions: 0,
  toolCalls: 0,
  skillReads: 0,
  toolCallIds: [],
};

function emptyDelta(): UsageDelta {
  return { ...EMPTY_DELTA, toolCallIds: [] };
}

/** 认不出的值当 0：用量是统计口径，一个坏字段不该把整行作废 */
function n(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 这次工具调用算不算「读技能」：Skill 工具本身，或入参里点名了某个 SKILL.md */
export function isSkillRead(toolName: string, rawInput: unknown): boolean {
  if (toolName === 'Skill') return true;
  if (rawInput === undefined || rawInput === null) return false;
  const text = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput);
  return text.includes('SKILL.md');
}

/** claude：`type:'assistant'` 行 */
function parseClaudeAssistant(e: Record<string, unknown>): UsageDelta {
  const delta = emptyDelta();
  const message = isRecord(e.message) ? e.message : {};
  const usage = isRecord(message.usage) ? message.usage : null;
  if (usage) {
    const details = isRecord(usage.output_tokens_details) ? usage.output_tokens_details : {};
    delta.requests = 1;
    // cache_creation 是真花钱的写入，计入 input；只有 cache_read 才算 cached
    delta.inputTokens = n(usage.input_tokens) + n(usage.cache_creation_input_tokens);
    delta.cachedInputTokens = n(usage.cache_read_input_tokens);
    delta.outputTokens = n(usage.output_tokens);
    delta.reasoningTokens = n(details.thinking_tokens);
    if (typeof message.id === 'string' && message.id) delta.requestId = message.id;
  }
  if (Array.isArray(message.content)) {
    for (const raw of message.content) {
      if (!isRecord(raw) || raw.type !== 'tool_use') continue;
      const name = typeof raw.name === 'string' ? raw.name : '';
      delta.toolCalls++;
      if (typeof raw.id === 'string' && raw.id) delta.toolCallIds.push(raw.id);
      if (isSkillRead(name, raw.input)) delta.skillReads++;
    }
  }
  return delta;
}

/** codex：`event_msg` 的 token_count / `response_item` 的工具调用 */
function parseCodexLine(e: Record<string, unknown>): UsageDelta {
  const delta = emptyDelta();
  const payload = isRecord(e.payload) ? e.payload : {};
  if (e.type === 'event_msg' && payload.type === 'token_count') {
    const info = isRecord(payload.info) ? payload.info : {};
    const total = isRecord(info.total_token_usage) ? info.total_token_usage : null;
    if (total) {
      delta.cumulative = {
        inputTokens: n(total.input_tokens) + n(total.cache_write_input_tokens),
        cachedInputTokens: n(total.cached_input_tokens),
        outputTokens: n(total.output_tokens),
        reasoningTokens: n(total.reasoning_output_tokens),
      };
    }
    return delta;
  }
  if (e.type === 'response_item') {
    const kind = payload.type;
    if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call') {
      const name = typeof payload.name === 'string' ? payload.name : '';
      delta.toolCalls++;
      const id = typeof payload.call_id === 'string' ? payload.call_id
        : typeof payload.id === 'string' ? payload.id : '';
      if (id) delta.toolCallIds.push(id);
      if (isSkillRead(name, payload.input ?? payload.arguments)) delta.skillReads++;
    }
  }
  return delta;
}

/**
 * 解析一行 jsonl → 用量增量。**坏行、截断行、认不出的行一律返回空增量，绝不抛错**。
 * claude 与 codex 的行 type 空间不相交，可在同一函数里自动识别（与 core/jsonl 同款做法）。
 */
export function parseUsageLine(line: string): UsageDelta {
  const text = line.trim();
  if (!text || !text.startsWith('{')) return emptyDelta();
  let e: unknown;
  try {
    e = JSON.parse(text);
  } catch {
    return emptyDelta(); // 增量 tail 读到半行是常态
  }
  if (!isRecord(e)) return emptyDelta();

  // 压缩：两种格式各一处
  if (
    (e.type === 'system' && e.subtype === 'compact_boundary') ||
    e.isCompactSummary === true ||
    e.type === 'compacted'
  ) {
    return { ...emptyDelta(), compactions: 1 };
  }
  if (e.type === 'assistant') return parseClaudeAssistant(e);
  if (e.type === 'event_msg' || e.type === 'response_item') return parseCodexLine(e);
  return emptyDelta();
}

/**
 * 把一行的增量累加进总数，**同时按 seen 去重**（claude 同一请求会写多行，见文件头）。
 * `seen` 必须在整条会话的扫描过程中复用同一个实例——换实例就等于重新开始去重。
 */
export function accumulateUsage(total: UsageTotals, delta: UsageDelta, seen: UsageSeen): UsageTotals {
  const next = { ...total };
  // codex：单调累计计量取差值。累计值倒退（换会话/重置）时按「从头开始」处理，绝不产生负数。
  if (delta.cumulative) {
    const prev = seen.cumulative;
    const advance = (now: number, before: number): number => (now > before ? now - before : now < before ? now : 0);
    const dInput = advance(delta.cumulative.inputTokens, prev?.inputTokens ?? 0);
    const dCached = advance(delta.cumulative.cachedInputTokens, prev?.cachedInputTokens ?? 0);
    const dOutput = advance(delta.cumulative.outputTokens, prev?.outputTokens ?? 0);
    const dReason = advance(delta.cumulative.reasoningTokens, prev?.reasoningTokens ?? 0);
    seen.cumulative = { ...delta.cumulative };
    next.inputTokens += dInput;
    next.cachedInputTokens += dCached;
    next.outputTokens += dOutput;
    next.reasoningTokens += dReason;
    // 只有累计真的往前走了才算一次请求：重复上报的 token_count 不该把请求数灌水
    if (dInput > 0 || dOutput > 0) next.requests += 1;
    return next;
  }
  const duplicateRequest = delta.requestId !== undefined && seen.requests.has(delta.requestId);
  if (delta.requestId !== undefined && !duplicateRequest) {
    seen.requests.add(delta.requestId);
    next.requests += delta.requests;
    next.inputTokens += delta.inputTokens;
    next.cachedInputTokens += delta.cachedInputTokens;
    next.outputTokens += delta.outputTokens;
    next.reasoningTokens += delta.reasoningTokens;
  }
  next.compactions += delta.compactions;
  // 工具调用按 id 去重；没有 id 的（老数据/异常行）只能按行计数
  const identified = delta.toolCallIds.length;
  for (const id of delta.toolCallIds) {
    if (seen.toolCalls.has(id)) continue;
    seen.toolCalls.add(id);
    next.toolCalls++;
  }
  if (identified === 0) next.toolCalls += delta.toolCalls;
  // skillReads 跟随工具调用：重复行不重复计（同一请求的重复行里 id 已经见过）
  if (delta.skillReads > 0 && !duplicateRequest) next.skillReads += delta.skillReads;
  return next;
}

/** 两份累计相加（按 issue / 项目聚合时用） */
export function mergeUsage(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    compactions: a.compactions + b.compactions,
    toolCalls: a.toolCalls + b.toolCalls,
    skillReads: a.skillReads + b.skillReads,
  };
}

// ---------- 金额折算（#282 / Q2）----------

/** 每百万 token 的单价（来自 `usage_pricing` 表；调用方读库后传进来） */
export interface UsagePricing {
  currency: string;
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  /** 默认 0：推理 token 含在 output 里，单独再收一遍就是重复计费 */
  reasoningPerMTok: number;
}

/**
 * 折算金额。**reasoning 默认不单独计价**——claude 的 thinking_tokens 与 codex 的
 * reasoning_output_tokens 都是 output_tokens 的子集，再乘一遍等于把同一批 token 收两次钱。
 * 真出现单独计价的模型时，把 `reasoningPerMTok` 配上即可，不用改代码。
 */
export function costOf(totals: UsageTotals, pricing: UsagePricing): number {
  const per = (tokens: number, price: number): number => (tokens / 1_000_000) * price;
  return (
    per(totals.inputTokens, pricing.inputPerMTok)
    + per(totals.cachedInputTokens, pricing.cachedInputPerMTok)
    + per(totals.outputTokens, pricing.outputPerMTok)
    + per(totals.reasoningTokens, pricing.reasoningPerMTok)
  );
}

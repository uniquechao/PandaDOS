/**
 * agents/llm —— OpenAI-compatible 驱动大模型客户端。
 *
 * v1 保留的骨架：3 次尝试、线性退避 600ms×(n+1)、jsonMode（response_format=json_object）、
 * function-calling（tools 透传、choices[0].message 取回）。
 *
 * v1 还掉的债（评审 H13 / 5.3#8）：
 * - fetch 无超时 → AbortSignal.timeout（默认 30s），挂死连接不再卡整条调用链；
 * - 4xx 盲重试 → 只对 429/5xx/网络错误重试，其余 4xx 直接抛（LlmHttpError）；
 * - 429/503 尊重 Retry-After（秒数或 HTTP-date，上限 30s）；
 * - 无并发上限 → 全局信号量（PM 池 × 3s tick 的放大效应，默认并发 4）。
 *
 * provider 接口 = LlmClient（chat(messages, opts)）；OpenAiCompatibleClient 是默认实现，
 * baseUrl/model/apiKey 等一切参数走 LlmConfig，可从 DB（llm_config 表，040 迁移）
 * 或环境变量读取（loadLlmConfig，DB 覆盖 env 覆盖空默认值）。
 */
import type { Database } from 'bun:sqlite';

// ---------- 消息 / 结果形状（OpenAI chat.completions 兼容子集） ----------

export interface LlmToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** tool 角色回填结果时必带 */
  tool_call_id?: string;
  /** assistant 消息回灌历史时保留 tool_calls（function-calling 循环） */
  tool_calls?: LlmToolCall[];
}

export interface LlmChatOpts {
  /** response_format = json_object */
  jsonMode?: boolean;
  /** OpenAI function-calling 工具定义（tools.ts TOOL_SCHEMAS 直传） */
  tools?: unknown;
}

export interface LlmResult {
  /** message.content（空兜底 ''） */
  content: string;
  /** message.tool_calls（无则 []） */
  toolCalls: LlmToolCall[];
  /** 原始 message 对象——function-calling 循环需原样 push 回历史 */
  raw: LlmMessage;
}

/** provider 抽象：PM/审批/进度全部只依赖它（mock 测试替身也实现它） */
export interface LlmClient {
  chat(messages: LlmMessage[], opts?: LlmChatOpts): Promise<LlmResult>;
}

// ---------- 配置 ----------

/**
 * LLM provider 配置形状（唯一真相）：
 * - DB：llm_config 表单行（id=1，040_pm_agent.sql；admin 可改，saveLlmConfig）
 * - 环境变量（DB 未保存对应字段时兜底）：BUTLER2_LLM_BASE_URL / BUTLER2_LLM_MODEL /
 *   BUTLER2_LLM_API_KEY / BUTLER2_LLM_TEMPERATURE / BUTLER2_LLM_TIMEOUT_MS /
 *   BUTLER2_LLM_RETRIES / BUTLER2_LLM_MAX_CONCURRENT
 */
export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** v1 硬编码 0.3 收进配置 */
  temperature: number;
  /** 单次请求超时（评审 H13：必须有） */
  timeoutMs: number;
  /** 总尝试次数（v1 = 3） */
  retries: number;
  /** 线性退避基数（v1 = 600ms，重试等待 = backoffMs×已失败次数） */
  backoffMs: number;
  /** 全局并发上限（信号量） */
  maxConcurrent: number;
}

export const DEFAULT_LLM_CONFIG: LlmConfig = {
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.3,
  timeoutMs: 90_000,
  retries: 3,
  backoffMs: 600,
  maxConcurrent: 4,
};

/** Retry-After 等待上限（防服务端给出离谱值把 tick 卡死） */
export const MAX_RETRY_WAIT_MS = 30_000;

interface LlmConfigRow {
  base_url: string | null;
  model: string | null;
  api_key: string | null;
  temperature: number | null;
  timeout_ms: number | null;
  retries: number | null;
  max_concurrent: number | null;
}

function envNum(v: string | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 读配置：DB（llm_config 单行）覆盖 env 覆盖默认值。
 * NULL 表示尚未在 Admin 保存，可回落 env；空字符串表示管理员明确清空，不能被 env 复活。
 * db 缺省 / 表尚未迁移（040 未跑）时静默回落 env+空默认，方便测试与首启。
 */
export function loadLlmConfig(db?: Database): LlmConfig {
  let row: Partial<LlmConfigRow> = {};
  if (db) {
    try {
      row = db.query<LlmConfigRow, []>('SELECT * FROM llm_config WHERE id = 1').get() ?? {};
    } catch {
      row = {};
    }
  }
  const e = process.env;
  return {
    baseUrl: row.base_url ?? e.BUTLER2_LLM_BASE_URL ?? DEFAULT_LLM_CONFIG.baseUrl,
    model: row.model ?? e.BUTLER2_LLM_MODEL ?? DEFAULT_LLM_CONFIG.model,
    apiKey: row.api_key ?? e.BUTLER2_LLM_API_KEY ?? DEFAULT_LLM_CONFIG.apiKey,
    temperature: row.temperature ?? envNum(e.BUTLER2_LLM_TEMPERATURE) ?? DEFAULT_LLM_CONFIG.temperature,
    timeoutMs: row.timeout_ms ?? envNum(e.BUTLER2_LLM_TIMEOUT_MS) ?? DEFAULT_LLM_CONFIG.timeoutMs,
    retries: row.retries ?? envNum(e.BUTLER2_LLM_RETRIES) ?? DEFAULT_LLM_CONFIG.retries,
    backoffMs: DEFAULT_LLM_CONFIG.backoffMs,
    maxConcurrent:
      row.max_concurrent ?? envNum(e.BUTLER2_LLM_MAX_CONCURRENT) ?? DEFAULT_LLM_CONFIG.maxConcurrent,
  };
}

export const LLM_NOT_CONFIGURED_MESSAGE = '请联系管理员配置驱动大模型';

export class LlmNotConfiguredError extends Error {
  readonly code = 'llm_not_configured';

  constructor() {
    super(LLM_NOT_CONFIGURED_MESSAGE);
    this.name = 'LlmNotConfiguredError';
  }
}

export function isLlmConfigured(config: Pick<LlmConfig, 'baseUrl' | 'model' | 'apiKey'>): boolean {
  return Boolean(config.baseUrl.trim() && config.model.trim() && config.apiKey.trim());
}

export interface SafeLlmConfig {
  baseUrl: string;
  model: string;
  configured: boolean;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
}

export function safeLlmConfig(db?: Database): SafeLlmConfig {
  const config = loadLlmConfig(db);
  const apiKey = config.apiKey.trim();
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    configured: isLlmConfigured(config),
    apiKeyConfigured: apiKey.length > 0,
    apiKeyMasked: apiKey ? `••••${apiKey.slice(-4)}` : null,
  };
}

/** 写 DB 配置（单行 upsert，局部更新）；api_key 存 DB 属部署自担风险，推荐走 env */
export function saveLlmConfig(
  db: Database,
  patch: Partial<
    Pick<LlmConfig, 'baseUrl' | 'model' | 'apiKey' | 'temperature' | 'timeoutMs' | 'retries' | 'maxConcurrent'>
  >,
): void {
  const cur = db.query<LlmConfigRow, []>('SELECT * FROM llm_config WHERE id = 1').get();
  db.query(
    `INSERT INTO llm_config (id, base_url, model, api_key, temperature, timeout_ms, retries, max_concurrent, updated_ts)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       base_url = excluded.base_url, model = excluded.model, api_key = excluded.api_key,
       temperature = excluded.temperature, timeout_ms = excluded.timeout_ms,
       retries = excluded.retries, max_concurrent = excluded.max_concurrent,
       updated_ts = excluded.updated_ts`,
  ).run(
    patch.baseUrl ?? cur?.base_url ?? null,
    patch.model ?? cur?.model ?? null,
    patch.apiKey ?? cur?.api_key ?? null,
    patch.temperature ?? cur?.temperature ?? null,
    patch.timeoutMs ?? cur?.timeout_ms ?? null,
    patch.retries ?? cur?.retries ?? null,
    patch.maxConcurrent ?? cur?.max_concurrent ?? null,
    Date.now(),
  );
}

// ---------- 错误分类 ----------

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 服务端 Retry-After 换算的毫秒（无则 undefined） */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

/** 只有 429 / 5xx 值得重试；其余 4xx（400 prompt 超长等）重试只是白烧钱（评审 H13） */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Retry-After 头 → 毫秒（秒数或 HTTP-date；无效返回 undefined） */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

// ---------- 并发信号量 ----------

/** 简单 FIFO 信号量：PM 池 × tick 扇出的 LLM 调用全局限流（评审 5.3#8） */
export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      await new Promise<void>((r) => this.queue.push(r));
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    };
  }

  /** 观测用：当前持有数 */
  get inUse(): number {
    return this.active;
  }
}

// ---------- 客户端 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAiCompatibleClient implements LlmClient {
  private readonly sem: Semaphore;
  private readonly configProvider: () => LlmConfig;

  constructor(
    config: LlmConfig | (() => LlmConfig),
    /** 测试注入点：mock fetch，不调用外部服务 */
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {
    this.configProvider = typeof config === 'function' ? config : () => config;
    this.sem = new Semaphore(Math.max(1, this.configProvider().maxConcurrent));
  }

  async chat(messages: LlmMessage[], opts: LlmChatOpts = {}): Promise<LlmResult> {
    const config = this.configProvider();
    if (!isLlmConfigured(config)) throw new LlmNotConfiguredError();
    const release = await this.sem.acquire();
    try {
      return await this.request(config, messages, opts);
    } finally {
      release();
    }
  }

  private async request(config: LlmConfig, messages: LlmMessage[], opts: LlmChatOpts): Promise<LlmResult> {
    const { baseUrl, model, apiKey, temperature, timeoutMs, retries, backoffMs } = config;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = { model, messages, temperature, stream: false };
    if (opts.tools) body.tools = opts.tools;
    if (opts.jsonMode) body.response_format = { type: 'json_object' };
    const payload = JSON.stringify(body);
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < Math.max(1, retries); attempt++) {
      try {
        const res = await this.fetchFn(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = (await res.text().catch(() => '')).slice(0, 200);
          throw new LlmHttpError(
            res.status,
            `LLM ${res.status}: ${text}`,
            parseRetryAfter(res.headers.get('retry-after')),
          );
        }
        const j = (await res.json()) as { choices?: Array<{ message?: unknown }> };
        const raw = (j.choices?.[0]?.message ?? { role: 'assistant', content: '' }) as LlmMessage;
        return {
          content: typeof raw.content === 'string' ? raw.content : '',
          toolCalls: Array.isArray(raw.tool_calls) ? raw.tool_calls : [],
          raw,
        };
      } catch (e) {
        // 4xx（非 429）不可重试，直接抛给调用方（评审 H13）
        if (e instanceof LlmHttpError && !isRetryableStatus(e.status)) throw e;
        lastErr = e;
        if (attempt < retries - 1) {
          const ra = e instanceof LlmHttpError ? e.retryAfterMs : undefined;
          const wait = ra ?? backoffMs * (attempt + 1); // v1 线性退避平移
          await sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
        }
      }
    }
    throw lastErr;
  }
}

/** 一步到位：每次 chat 读取最新 DB/env 配置，Admin 保存后无需重启。 */
export function createLlmClient(db?: Database, fetchFn?: FetchLike): OpenAiCompatibleClient {
  return new OpenAiCompatibleClient(() => loadLlmConfig(db), fetchFn);
}

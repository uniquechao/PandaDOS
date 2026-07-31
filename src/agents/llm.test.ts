/**
 * agents/llm 测试 —— 全 mock fetch，不调用外部服务。
 * 覆盖：重试路径（网络错/5xx/429 可重试、其余 4xx 直抛）、Retry-After 解析、
 * jsonMode/tools 请求体、超时中止、并发信号量、配置读取（env 覆盖 DB 覆盖默认）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migratePmAgent } from './pm';
import {
  createLlmClient,
  DEFAULT_LLM_CONFIG,
  isRetryableStatus,
  LlmNotConfiguredError,
  LlmHttpError,
  loadLlmConfig,
  OpenAiCompatibleClient,
  parseRetryAfter,
  safeLlmConfig,
  saveLlmConfig,
  Semaphore,
  type FetchLike,
  type LlmConfig,
} from './llm';

const CFG: LlmConfig = {
  ...DEFAULT_LLM_CONFIG,
  baseUrl: 'https://llm.example.test/v1',
  model: 'driver-model',
  apiKey: 'test-key',
  backoffMs: 1, // 测试提速：退避 1ms
  timeoutMs: 5_000,
};

function ok(content: string, extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { role: 'assistant', content, ...extra } }] }),
    { status: 200 },
  );
}

const MSGS = [{ role: 'user' as const, content: 'hi' }];

describe('OpenAiCompatibleClient 重试路径', () => {
  test('瞬时网络错误重试：两次失败第三次成功（v1 三次尝试平移）', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNRESET');
      return ok('好了');
    };
    const r = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS);
    expect(calls).toBe(3);
    expect(r.content).toBe('好了');
  });

  test('5xx 可重试；连挂 3 次后抛最后一个 LlmHttpError', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return new Response('oops', { status: 502 });
    };
    const err = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS).catch((e) => e);
    expect(calls).toBe(3);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(502);
  });

  test('429 可重试（带 Retry-After）；下一次成功', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      if (calls === 1) {
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
      }
      return ok('恢复');
    };
    const r = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS);
    expect(calls).toBe(2);
    expect(r.content).toBe('恢复');
  });

  test('4xx（非 429）直接抛，不重试不白烧（评审 H13）', async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls++;
      return new Response('bad request', { status: 400 });
    };
    const err = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS).catch((e) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect((err as LlmHttpError).status).toBe(400);
    expect(String((err as Error).message)).toContain('400');
  });

  test('超时：AbortSignal 中止挂死请求（评审 H13：不再卡整条调用链）', async () => {
    const fetchFn: FetchLike = (_url, init) =>
      new Promise((_res, rej) => {
        init.signal!.addEventListener('abort', () => rej(init.signal!.reason));
      });
    const c = new OpenAiCompatibleClient({ ...CFG, timeoutMs: 20, retries: 1 }, fetchFn);
    const err = await c.chat(MSGS).catch((e) => e);
    expect(err).toBeTruthy();
    expect(err).not.toBeInstanceOf(LlmHttpError); // 超时是网络类错误
  });

  test('isRetryableStatus 分类矩阵', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  test('parseRetryAfter：秒数 / HTTP-date / 垃圾值', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    const now = Date.now();
    const later = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfter(later, now)!;
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(5000);
    expect(parseRetryAfter('garbage')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('OpenAiCompatibleClient 请求体', () => {
  async function captureBody(opts?: { jsonMode?: boolean; tools?: unknown }) {
    let body: Record<string, unknown> = {};
    let url = '';
    let auth = '';
    const fetchFn: FetchLike = async (u, init) => {
      url = u;
      auth = (init.headers as Record<string, string>).Authorization;
      body = JSON.parse(String(init.body));
      return ok('x');
    };
    await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS, opts);
    return { body, url, auth };
  }

  test('默认体：model/temperature 0.3/stream false，无 tools/response_format', async () => {
    const { body, url, auth } = await captureBody();
    expect(url).toBe('https://llm.example.test/v1/chat/completions');
    expect(auth).toBe('Bearer test-key');
    expect(body.model).toBe('driver-model');
    expect(body.temperature).toBe(0.3);
    expect(body.stream).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toBeUndefined();
  });

  test('jsonMode → response_format=json_object；tools 透传', async () => {
    const tools = [{ type: 'function', function: { name: 'x' } }];
    const { body } = await captureBody({ jsonMode: true, tools });
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.tools).toEqual(tools);
  });

  test('function-calling 返回：tool_calls 解析 + raw 原样保留（回灌历史用）', async () => {
    const tc = { id: 't1', type: 'function', function: { name: 'list_sessions', arguments: '{}' } };
    const fetchFn: FetchLike = async () => ok('', { tool_calls: [tc] });
    const r = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS);
    expect(r.toolCalls).toEqual([tc]);
    expect(r.raw.tool_calls).toEqual([tc]);
    expect(r.content).toBe('');
  });

  test('choices 为空时兜底空 content（v1 语义）', async () => {
    const fetchFn: FetchLike = async () => new Response(JSON.stringify({}), { status: 200 });
    const r = await new OpenAiCompatibleClient(CFG, fetchFn).chat(MSGS);
    expect(r.content).toBe('');
    expect(r.toolCalls).toEqual([]);
  });
});

describe('并发信号量（评审 5.3#8：全局限流）', () => {
  test('maxConcurrent=1 时请求严格串行', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchFn: FetchLike = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return ok('x');
    };
    const c = new OpenAiCompatibleClient({ ...CFG, maxConcurrent: 1 }, fetchFn);
    await Promise.all([c.chat(MSGS), c.chat(MSGS), c.chat(MSGS)]);
    expect(maxActive).toBe(1);
  });

  test('Semaphore release 幂等（重复调用不放大配额）', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release(); // 第二次是 no-op
    expect(sem.inUse).toBe(0);
    const r2 = await sem.acquire();
    expect(sem.inUse).toBe(1);
    r2();
  });
});

describe('配置读取（形状见 llm.ts LlmConfig 注释）', () => {
  const ENV_KEYS = [
    'BUTLER2_LLM_BASE_URL',
    'BUTLER2_LLM_MODEL',
    'BUTLER2_LLM_API_KEY',
    'BUTLER2_LLM_TEMPERATURE',
    'BUTLER2_LLM_TIMEOUT_MS',
    'BUTLER2_LLM_RETRIES',
    'BUTLER2_LLM_MAX_CONCURRENT',
  ];
  const saved = new Map<string, string | undefined>();
  for (const k of ENV_KEYS) saved.set(k, process.env[k]);

  function clearEnv() {
    for (const k of ENV_KEYS) delete process.env[k];
  }

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('无 DB 无 env → 地址、模型、Key 均为空，不绑定默认厂商', () => {
    clearEnv();
    const c = loadLlmConfig();
    expect(c.baseUrl).toBe('');
    expect(c.model).toBe('');
    expect(c.apiKey).toBe('');
    expect(c.temperature).toBe(0.3);
    expect(c.retries).toBe(3);
  });

  test('DB 字段优先，只有 NULL 字段才回落环境变量', () => {
    clearEnv();
    const db = openDb(':memory:');
    migratePmAgent(db);
    saveLlmConfig(db, { model: 'db-model', apiKey: 'db-key', temperature: 0.7 });
    process.env.BUTLER2_LLM_BASE_URL = 'https://env.example/v1';
    process.env.BUTLER2_LLM_MODEL = 'env-model';
    process.env.BUTLER2_LLM_API_KEY = 'env-key';
    let c = loadLlmConfig(db);
    expect(c.baseUrl).toBe('https://env.example/v1');
    expect(c.model).toBe('db-model');
    expect(c.apiKey).toBe('db-key');
    expect(c.temperature).toBe(0.7);

    // 局部更新不清其他列
    saveLlmConfig(db, { timeoutMs: 9000 });
    clearEnv();
    c = loadLlmConfig(db);
    expect(c.timeoutMs).toBe(9000);
    expect(c.model).toBe('db-model');
    db.close();
  });

  test('数据库空字符串是明确清空，不被环境变量复活', () => {
    clearEnv();
    process.env.BUTLER2_LLM_API_KEY = 'env-key';
    const db = openDb(':memory:');
    migratePmAgent(db);
    saveLlmConfig(db, { baseUrl: 'https://db.example/v1', model: 'db-model', apiKey: '' });
    expect(loadLlmConfig(db).apiKey).toBe('');
    expect(safeLlmConfig(db)).toMatchObject({
      configured: false,
      apiKeyConfigured: false,
      apiKeyMasked: null,
    });
    db.close();
  });

  test('安全视图只返回 Key 配置状态和掩码，不回传明文', () => {
    clearEnv();
    const db = openDb(':memory:');
    migratePmAgent(db);
    saveLlmConfig(db, {
      baseUrl: 'https://db.example/v1',
      model: 'db-model',
      apiKey: 'secret-1234',
    });
    const safe = safeLlmConfig(db);
    expect(safe).toEqual({
      baseUrl: 'https://db.example/v1',
      model: 'db-model',
      configured: true,
      apiKeyConfigured: true,
      apiKeyMasked: '••••1234',
    });
    expect(JSON.stringify(safe)).not.toContain('secret-1234');
    db.close();
  });

  test('任一身份字段缺失时在 fetch 前拒绝，并给统一配置提示', async () => {
    let calls = 0;
    const client = new OpenAiCompatibleClient(
      { ...CFG, model: '' },
      async () => {
        calls++;
        return ok('不应调用');
      },
    );
    const err = await client.chat(MSGS).catch((e) => e);
    expect(err).toBeInstanceOf(LlmNotConfiguredError);
    expect((err as Error).message).toBe('请联系管理员配置驱动大模型');
    expect(calls).toBe(0);
  });

  test('createLlmClient 每次调用读取 DB，保存后无需重启即可生效', async () => {
    clearEnv();
    const db = openDb(':memory:');
    migratePmAgent(db);
    const seen: Array<{ url: string; model: string; auth: string }> = [];
    const client = createLlmClient(db, async (url, init) => {
      seen.push({
        url,
        model: JSON.parse(String(init.body)).model,
        auth: (init.headers as Record<string, string>).Authorization,
      });
      return ok('ok');
    });
    await expect(client.chat(MSGS)).rejects.toBeInstanceOf(LlmNotConfiguredError);
    saveLlmConfig(db, {
      baseUrl: 'https://hot.example/v1',
      model: 'hot-model',
      apiKey: 'hot-key',
    });
    await client.chat(MSGS);
    expect(seen).toEqual([{
      url: 'https://hot.example/v1/chat/completions',
      model: 'hot-model',
      auth: 'Bearer hot-key',
    }]);
    db.close();
  });

  test('表未迁移时静默回落 env+空默认', () => {
    clearEnv();
    const db = openDb(':memory:'); // 不跑迁移
    const c = loadLlmConfig(db);
    expect(c.model).toBe('');
    db.close();
  });
});

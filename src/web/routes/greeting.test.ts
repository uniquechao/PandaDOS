/**
 * /api/greeting 路由测试：需登录（user 级）、正常返回 LLM 文案、LLM 失败回退静态兜底。
 * LLM 为结构替身，不碰真实 驱动大模型。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import type { LlmClient, LlmMessage, LlmResult } from '../../agents/llm';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { GREETING_FALLBACK, greetingRoutes } from './greeting';

function fakeLlm(
  respond: (messages: LlmMessage[]) => string,
): LlmClient & { calls: number } {
  return {
    calls: 0,
    async chat(messages: LlmMessage[]): Promise<LlmResult> {
      this.calls++;
      const content = respond(messages);
      return { content, toolCalls: [], raw: { role: 'assistant', content } };
    },
  };
}

function makeApp(llm: LlmClient) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const dispatch = createDispatcher(greetingRoutes({ db, llm }), authDepsFromDb(db, users));
  const alice = users.create('alice', 'user');
  return { db, users, dispatch, alice };
}

function getReq(token?: string): Request {
  return new Request('http://x/api/greeting', token ? { headers: { cookie: `${COOKIE}=${token}` } } : {});
}

describe('/api/greeting', () => {
  test('匿名 401（user 级）', async () => {
    const { dispatch } = makeApp(fakeLlm(() => '你好'));
    const r = await dispatch(getReq());
    expect(r!.status).toBe(401);
  });

  test('登录后返回 LLM 生成的欢迎语', async () => {
    const llm = fakeLlm(() => '欢迎回来，愿今天顺利');
    const { dispatch, alice } = makeApp(llm);
    const r = await dispatch(getReq(alice.token));
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { text: string }).text).toBe('欢迎回来，愿今天顺利');
  });

  test('同用户同天二次调用命中缓存：LLM 只调 1 次', async () => {
    const llm = fakeLlm(() => '欢迎回来');
    const { dispatch, alice } = makeApp(llm);
    await dispatch(getReq(alice.token));
    await dispatch(getReq(alice.token));
    expect(llm.calls).toBe(1);
  });

  test('LLM 失败 → 200 且回退静态兜底文案', async () => {
    const llm: LlmClient = {
      async chat() {
        throw new Error('llm 502');
      },
    };
    const { dispatch, alice } = makeApp(llm);
    const r = await dispatch(getReq(alice.token));
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { text: string }).text).toBe(GREETING_FALLBACK);
  });
});

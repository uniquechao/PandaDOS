/**
 * /api/greeting 路由测试：需登录（user 级）、登录后返回固定欢迎语。
 * LLM 为结构替身，不碰真实 驱动大模型。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import type { LlmClient, LlmMessage, LlmResult } from '../../agents/llm';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { GREETING_TEXT, greetingRoutes } from './greeting';

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

  test('登录后返回固定 hello，且不调用 LLM', async () => {
    const llm = fakeLlm(() => '欢迎回来，愿今天顺利');
    const { dispatch, alice } = makeApp(llm);
    const r = await dispatch(getReq(alice.token));
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { text: string }).text).toBe(GREETING_TEXT);
    expect(llm.calls).toBe(0);
  });
});

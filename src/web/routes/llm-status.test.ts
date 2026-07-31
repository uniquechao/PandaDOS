import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { migratePmAgent } from '../../agents/pm';
import { saveLlmConfig } from '../../agents/llm';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { llmStatusRoutes } from './llm-status';

describe('GET /api/llm-status', () => {
  test('匿名 401；登录用户只看到 configured，不泄露配置细节', async () => {
    const db = openDb(':memory:');
    migrate(db);
    migratePmAgent(db);
    const users = new UserStore(db);
    const alice = users.create('alice', 'user');
    const dispatch = createDispatcher(llmStatusRoutes({ db }), authDepsFromDb(db, users));

    expect((await dispatch(new Request('http://x/api/llm-status')))!.status).toBe(401);
    const request = () =>
      dispatch(new Request('http://x/api/llm-status', {
        headers: { cookie: `${COOKIE}=${alice.token}` },
      }))!;
    expect(await (await request()).json()).toEqual({ configured: false });

    saveLlmConfig(db, {
      baseUrl: 'https://llm.example/v1',
      model: 'private-model',
      apiKey: 'private-key',
    });
    const body = await (await request()).json();
    expect(body).toEqual({ configured: true });
    expect(JSON.stringify(body)).not.toContain('private');
    db.close();
  });
});

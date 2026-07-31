import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { MEMORY_MAX_CHARS, PERSONA_MAX_CHARS, UserStore } from '../../core/users';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { meRoutes } from './me';

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const dispatch = createDispatcher(meRoutes({ users }), authDepsFromDb(db, users));
  const alice = users.create('alice', 'user');
  return { users, dispatch, alice };
}

function getReq(token: string): Request {
  return new Request('http://x/api/me/settings', { headers: { cookie: `${COOKIE}=${token}` } });
}

function putReq(token: string, body: unknown): Request {
  return new Request('http://x/api/me/settings', {
    method: 'PUT',
    headers: { cookie: `${COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/me/settings', () => {
  test('匿名 401（user 级）', async () => {
    const { dispatch } = makeApp();
    expect((await dispatch(new Request('http://x/api/me/settings')))!.status).toBe(401);
  });

  test('GET 默认空设定；PUT 后读写往返', async () => {
    const { dispatch, alice } = makeApp();
    const r0 = await dispatch(getReq(alice.token));
    expect(r0!.status).toBe(200);
    expect(((await r0!.json()) as { persona: null }).persona).toBeNull();

    const put = await dispatch(
      putReq(alice.token, { persona: '我的风格', memory: '记住A', autopilotDefault: true }),
    );
    expect(put!.status).toBe(200);

    const r1 = await dispatch(getReq(alice.token));
    const s = (await r1!.json()) as { persona: string; memory: string; autopilotDefault: boolean };
    expect(s.persona).toBe('我的风格');
    expect(s.memory).toBe('记住A');
    expect(s.autopilotDefault).toBe(true);
  });

  test('局部 PUT 不动其他字段', async () => {
    const { dispatch, alice } = makeApp();
    await dispatch(putReq(alice.token, { persona: 'P', memory: 'M' }));
    await dispatch(putReq(alice.token, { autopilotDefault: true }));
    const s = (await (await dispatch(getReq(alice.token)))!.json()) as {
      persona: string;
      memory: string;
      autopilotDefault: boolean;
    };
    expect(s.persona).toBe('P');
    expect(s.memory).toBe('M');
    expect(s.autopilotDefault).toBe(true);
  });

  test('端点级截断：persona 超 8000 / memory 超 50000 截到上限', async () => {
    const { dispatch, alice } = makeApp();
    const put = await dispatch(
      putReq(alice.token, {
        persona: 'p'.repeat(PERSONA_MAX_CHARS + 1000),
        memory: 'm'.repeat(MEMORY_MAX_CHARS + 1000),
      }),
    );
    const body = (await put!.json()) as { settings: { persona: string; memory: string } };
    expect(body.settings.persona.length).toBe(PERSONA_MAX_CHARS);
    expect(body.settings.memory.length).toBe(MEMORY_MAX_CHARS);
  });

  test('类型不对给 400（不隐式扭转）', async () => {
    const { dispatch, alice } = makeApp();
    expect((await dispatch(putReq(alice.token, { persona: 42 })))!.status).toBe(400);
    expect((await dispatch(putReq(alice.token, { memory: ['x'] })))!.status).toBe(400);
    expect((await dispatch(putReq(alice.token, { autopilotDefault: 'yes' })))!.status).toBe(400);
    expect((await dispatch(putReq(alice.token, 'not-an-object')))!.status).toBe(400);
  });
});

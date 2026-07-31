import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { authRoutes } from './auth';

function makeApp() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const dispatch = createDispatcher(authRoutes({ users }), authDepsFromDb(db, users));
  return { db, users, dispatch };
}

function post(path: string, body: unknown): Request {
  return new Request(`http://x${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/login', () => {
  test('正确用户名+token：200、种 HttpOnly cookie、回角色', async () => {
    const { users, dispatch } = makeApp();
    const { user, token } = users.create('alice', 'user');

    const r = await dispatch(post('/api/login', { username: 'alice', token }));
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as { ok: boolean; userId: number; role: string };
    expect(body.ok).toBe(true);
    expect(body.userId).toBe(user.id);
    expect(body.role).toBe('user');

    const cookie = r!.headers.get('set-cookie')!;
    expect(cookie).toContain(`${COOKIE}=${token}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // http 请求不带 Secure

    // 登录成功记 last_login
    expect(users.byId(user.id)?.lastLoginTs).toBeGreaterThan(0);
  });

  test('token 错 / 用户名不存在 / 空 body：统一 401 + 同一话术（防枚举）', async () => {
    const { users, dispatch } = makeApp();
    users.create('alice', 'user');

    const cases = [
      post('/api/login', { username: 'alice', token: 'wrong' }),
      post('/api/login', { username: 'ghost', token: 'whatever' }),
      post('/api/login', {}),
      new Request('http://x/api/login', { method: 'POST', body: 'not-json' }),
    ];
    for (const req of cases) {
      const r = await dispatch(req);
      expect(r!.status).toBe(401);
      expect(((await r!.json()) as { error: string }).error).toBe('用户名或 token 不对');
      expect(r!.headers.get('set-cookie')).toBeNull();
    }
  });

  test('https（x-forwarded-proto）下 cookie 带 Secure', async () => {
    const { users, dispatch } = makeApp();
    const { token } = users.create('alice', 'user');
    const req = new Request('http://x/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'alice', token }),
    });
    const r = await dispatch(req);
    expect(r!.headers.get('set-cookie')).toContain('; Secure');
  });
});

describe('POST /api/logout', () => {
  test('清 cookie（Max-Age=0），无 token 也放行（幂等）', async () => {
    const { dispatch } = makeApp();
    const r = await dispatch(new Request('http://x/api/logout', { method: 'POST' }));
    expect(r!.status).toBe(200);
    const cookie = r!.headers.get('set-cookie')!;
    expect(cookie).toContain(`${COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
  });
});

describe('GET /api/me', () => {
  test('登录 cookie 往返：login 的 cookie 能过 /api/me', async () => {
    const { users, dispatch } = makeApp();
    const { user, token } = users.create('alice', 'user');
    const login = await dispatch(post('/api/login', { username: 'alice', token }));
    const setCookie = login!.headers.get('set-cookie')!;
    const cookiePair = setCookie.split(';')[0]!; // mando_token=<tok>

    const me = await dispatch(new Request('http://x/api/me', { headers: { cookie: cookiePair } }));
    expect(me!.status).toBe(200);
    const body = (await me!.json()) as { id: number; username: string; role: string };
    expect(body.id).toBe(user.id);
    expect(body.username).toBe('alice');
    expect(body.role).toBe('user');
  });

  test('Bearer 兼容脚本', async () => {
    const { users, dispatch } = makeApp();
    const { token } = users.create('bot', 'user');
    const r = await dispatch(
      new Request('http://x/api/me', { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(r!.status).toBe(200);
  });

  test('匿名 401；token 重置后旧 cookie 立即失效', async () => {
    const { users, dispatch } = makeApp();
    const { user, token } = users.create('alice', 'user');
    expect((await dispatch(new Request('http://x/api/me')))!.status).toBe(401);

    users.resetToken(user.id);
    const r = await dispatch(
      new Request('http://x/api/me', { headers: { cookie: `${COOKIE}=${token}` } }),
    );
    expect(r!.status).toBe(401);
  });
});

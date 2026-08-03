import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { SessionStore } from '../../core/sessions';
import { UserStore } from '../../core/users';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { OauthStateStore, type FeishuOauthPort, type FeishuOauthUser } from '../feishu-oauth';
import { feishuOauthRoutes, OAUTH_CALLBACK_PATH } from './feishu-oauth';

/** 假 OAuth 客户端：userByCode 按预置表返回；记录调用参数 */
function fakeOauth(users: Record<string, FeishuOauthUser>) {
  const calls: { code: string; redirectUri: string }[] = [];
  const port: FeishuOauthPort = {
    authorizeUrl: (redirectUri, state) =>
      `https://feishu.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    async userByCode(code, redirectUri) {
      calls.push({ code, redirectUri });
      const u = users[code];
      if (!u) throw new Error('飞书换取凭证失败：授权码已失效');
      return u;
    },
  };
  return { port, calls };
}

function makeApp(oauth: FeishuOauthPort | null, opts: { publicUrl?: string } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const sessions = new SessionStore(db);
  const states = new OauthStateStore();
  const dispatch = createDispatcher(
    feishuOauthRoutes({
      db,
      users,
      sessions,
      oauth,
      states,
      ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
    }),
    authDepsFromDb(db, users, sessions),
  );
  return { db, users, sessions, dispatch };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://panda.test${path}`, { headers });
}

/** 从 302 Location 提取 state 参数 */
function stateOf(r: Response): string {
  return new URL(r.headers.get('location')!).searchParams.get('state')!;
}

describe('GET /api/feishu/oauth/status', () => {
  test('配置有无 → enabled 真假（公开端点）', async () => {
    const on = makeApp(fakeOauth({}).port);
    const off = makeApp(null);
    expect(((await on.dispatch(get('/api/feishu/oauth/status'))!.then((r) => r.json())) as { enabled: boolean }).enabled).toBe(true);
    expect(((await off.dispatch(get('/api/feishu/oauth/status'))!.then((r) => r.json())) as { enabled: boolean }).enabled).toBe(false);
  });
});

describe('GET /api/feishu/oauth/start（登录流）', () => {
  test('302 到授权页，redirect_uri 按请求 Host 推导、state 已签发', async () => {
    const { dispatch } = makeApp(fakeOauth({}).port);
    const r = await dispatch(get('/api/feishu/oauth/start'))!;
    expect(r.status).toBe(302);
    const loc = new URL(r.headers.get('location')!);
    expect(loc.hostname).toBe('feishu.example');
    expect(loc.searchParams.get('redirect_uri')).toBe(`http://panda.test${OAUTH_CALLBACK_PATH}`);
    expect(loc.searchParams.get('state')).toMatch(/^[0-9a-f]{48}$/);
  });

  test('publicUrl 配置时回调地址用它（nginx 域名固定场景）', async () => {
    const { dispatch } = makeApp(fakeOauth({}).port, { publicUrl: 'https://stack.example/' });
    const r = await dispatch(get('/api/feishu/oauth/start'))!;
    const loc = new URL(r.headers.get('location')!);
    expect(loc.searchParams.get('redirect_uri')).toBe(`https://stack.example${OAUTH_CALLBACK_PATH}`);
  });

  test('未配置飞书 → 503', async () => {
    const { dispatch } = makeApp(null);
    expect((await dispatch(get('/api/feishu/oauth/start'))!).status).toBe(503);
  });
});

describe('GET /api/feishu/oauth/bind（绑定流）', () => {
  test('需登录：匿名 401；登录后 302 且 state 冻结本人 id', async () => {
    const { users, dispatch } = makeApp(fakeOauth({ ok: { openId: 'ou_a', name: 'A' } }).port);
    expect((await dispatch(get('/api/feishu/oauth/bind'))!).status).toBe(401);

    const { user, token } = users.create('alice', 'user');
    const r = await dispatch(get('/api/feishu/oauth/bind', { authorization: `Bearer ${token}` }))!;
    expect(r.status).toBe(302);

    // 回调（无 cookie）后 openid 落到发起绑定的 alice 身上
    const cb = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${stateOf(r)}`))!;
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/?feishu=bound#/settings');
    expect(users.byId(user.id)?.feishuOpenid).toBe('ou_a');
  });

  test('openid 已被别人绑定 → 拒绝并回跳错误', async () => {
    const { users, dispatch } = makeApp(fakeOauth({ ok: { openId: 'ou_dup', name: 'A' } }).port);
    const bob = users.create('bob', 'user').user;
    users.setFeishuOpenid(bob.id, 'ou_dup');
    const { user, token } = users.create('alice', 'user');

    const r = await dispatch(get('/api/feishu/oauth/bind', { authorization: `Bearer ${token}` }))!;
    const cb = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${stateOf(r)}`))!;
    expect(cb.headers.get('location')).toContain('feishu_err=');
    expect(cb.headers.get('location')).toContain('#/settings');
    expect(users.byId(user.id)?.feishuOpenid).toBeNull(); // 未写库
  });

  test('本人重复扫码绑定（幂等）→ 成功', async () => {
    const { users, dispatch } = makeApp(fakeOauth({ ok: { openId: 'ou_same', name: 'A' } }).port);
    const { user, token } = users.create('alice', 'user');
    users.setFeishuOpenid(user.id, 'ou_same');
    const r = await dispatch(get('/api/feishu/oauth/bind', { authorization: `Bearer ${token}` }))!;
    const cb = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${stateOf(r)}`))!;
    expect(cb.headers.get('location')).toBe('/?feishu=bound#/settings');
  });
});

describe('GET /api/feishu/oauth/callback（登录流）', () => {
  test('已绑定用户扫码 → 种会话 cookie，可过 auth:user 接口', async () => {
    const { users, sessions, dispatch, db } = makeApp(
      fakeOauth({ ok: { openId: 'ou_a', name: 'A' } }).port,
    );
    const { user } = users.create('alice', 'user');
    users.setFeishuOpenid(user.id, 'ou_a');

    const start = await dispatch(get('/api/feishu/oauth/start'))!;
    const cb = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${stateOf(start)}`))!;
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/');
    const setCookie = cb.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');

    // 会话 token 走 resolveUser 兜底：能过需要登录的接口（用 bind 端点验证）
    const cookiePair = setCookie.split(';')[0]!;
    const authed = await dispatch(get('/api/feishu/oauth/bind', { cookie: cookiePair }))!;
    expect(authed.status).toBe(302); // 401 就是会话没生效
    expect(users.byId(user.id)?.lastLoginTs).toBeGreaterThan(0);
    // DB 只存哈希
    const raw = db
      .query<{ token_hash: string }, []>('SELECT token_hash FROM auth_sessions')
      .get()!;
    expect(setCookie).not.toContain(raw.token_hash);
    expect(sessions.userIdByTokenHash(raw.token_hash)).toBe(user.id);
  });

  test('未绑定的飞书账号扫码登录 → 回跳错误提示', async () => {
    const { dispatch } = makeApp(fakeOauth({ ok: { openId: 'ou_ghost', name: '游客' } }).port);
    const start = await dispatch(get('/api/feishu/oauth/start'))!;
    const cb = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${stateOf(start)}`))!;
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('feishu_err=');
    expect(cb.headers.get('set-cookie')).toBeNull();
  });

  test('state 缺失/伪造/重放 → 拒绝；code 无效 → 错误回跳', async () => {
    const { dispatch } = makeApp(fakeOauth({}).port);
    for (const p of [`?code=ok`, `?code=ok&state=forged`]) {
      const r = await dispatch(get(`${OAUTH_CALLBACK_PATH}${p}`))!;
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toContain('feishu_err=');
    }
    // 同一 state 用两次：第二次拒绝
    const start = await dispatch(get('/api/feishu/oauth/start'))!;
    const st = stateOf(start);
    await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=bad&state=${st}`))!;
    const replay = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=bad&state=${st}`))!;
    expect(replay.headers.get('location')).toContain(
      encodeURIComponent('已过期或无效'),
    );
  });

  test('飞书回 error（用户取消）→ 错误回跳且 state 已烧掉', async () => {
    const { dispatch } = makeApp(fakeOauth({}).port);
    const start = await dispatch(get('/api/feishu/oauth/start'))!;
    const st = stateOf(start);
    const r = await dispatch(get(`${OAUTH_CALLBACK_PATH}?error=access_denied&state=${st}`))!;
    expect(r.headers.get('location')).toContain(encodeURIComponent('取消'));
    const replay = await dispatch(get(`${OAUTH_CALLBACK_PATH}?code=ok&state=${st}`))!;
    expect(replay.headers.get('location')).toContain(encodeURIComponent('已过期或无效'));
  });
});

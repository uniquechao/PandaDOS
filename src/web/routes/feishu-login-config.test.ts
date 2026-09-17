import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { SessionStore } from '../../core/sessions';
import { UserStore } from '../../core/users';
import { FeishuLoginConfigStore } from '../feishu-login-config';
import { FEISHU_TENANT_TOKEN_URL, FEISHU_TENANT_URL, FEISHU_TOKEN_URL, FEISHU_USERINFO_URL, type FetchLike } from '../feishu-oauth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { feishuLoginConfigRoutes } from './feishu-login-config';
import { feishuOauthRoutes } from './feishu-oauth';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const BODY = { enabled: true, allowRegistration: true, appId: 'cli_company', appSecret: 'secret-company', publicUrl: 'https://panda.example' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const happyFetch: FetchLike = async (url) => {
  if (url === FEISHU_TENANT_TOKEN_URL) return json({ code: 0, tenant_access_token: 'private-tenant-token' });
  if (url === FEISHU_TENANT_URL) return json({ code: 0, data: { tenant: { tenant_key: 'company', name: '测试企业' } } });
  if (url === FEISHU_TOKEN_URL) return json({ code: 0, access_token: 'private-user-token' });
  if (url === FEISHU_USERINFO_URL) return json({ code: 0, data: { open_id: 'ou_colleague', name: '同事', tenant_key: 'company' } });
  throw new Error('unexpected endpoint');
};
function setup(fetchFn: FetchLike = happyFetch) {
  const db = openDb(':memory:'); databases.push(db); migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const member = users.create('member');
  const sessions = new SessionStore(db);
  const store = new FeishuLoginConfigStore(db, { appId: 'cli_env', appSecret: 'secret-env' }, 'https://env.example', fetchFn);
  const dispatch = createDispatcher([
    ...feishuLoginConfigRoutes(store),
    ...feishuOauthRoutes({ db, users, sessions, oauth: null, config: store }),
  ], authDepsFromDb(db, users, sessions));
  const call = (method: string, path: string, body?: unknown, token: string | null = admin.token) => dispatch(new Request(`https://panda.test${path}`, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }))!;
  const loginStart = async () => {
    const response = await call('GET', '/api/feishu/oauth/start');
    return new URL(response.headers.get('location')!).searchParams.get('state')!;
  };
  const loginFinish = (state: string) => call('GET', `/api/feishu/oauth/callback?code=code&state=${state}`);
  return { db, users, store, call, admin, member, loginStart, loginFinish };
}
const CONFIG = '/api/admin/feishu-login-config';

describe('飞书登录管理配置', () => {
  test('读写和验证仅管理员可用，返回值不包含密钥和 token', async () => {
    const s = setup();
    for (const [method, path] of [['GET', CONFIG], ['PUT', CONFIG], ['POST', `${CONFIG}/verify`]]) {
      expect((await s.call(method!, path!, method === 'GET' ? undefined : BODY, null)).status).toBe(401);
      expect((await s.call(method!, path!, method === 'GET' ? undefined : BODY, s.member.token)).status).toBe(403);
    }
    const initial = await (await s.call('GET', CONFIG)).json();
    expect(initial).toMatchObject({ appId: 'cli_env', source: 'environment', appSecretConfigured: true, callbackUrl: 'https://env.example/api/feishu/oauth/callback' });
    const saved = await s.call('PUT', CONFIG, BODY);
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain('secret-company');
    expect(text).not.toContain('secret-env');
    expect(JSON.parse(text).config).toMatchObject({ source: 'database', enabled: true, appSecretConfigured: true });
    const verified = await s.call('POST', `${CONFIG}/verify`, { ...BODY, appSecret: '' });
    const verificationText = await verified.text();
    expect(verificationText).not.toContain('secret-company');
    expect(verificationText).not.toContain('private-tenant-token');
    expect(JSON.parse(verificationText)).toMatchObject({ ok: true, tenant: { name: '测试企业', key: 'company' } });
  });

  test('验证未保存表单且不更改配置，企业查询与实际凭据一致', async () => {
    const s = setup(async (url, init) => {
      if (url === FEISHU_TENANT_TOKEN_URL) expect(JSON.parse(String(init?.body))).toEqual({ app_id: 'cli_company', app_secret: 'secret-company' });
      if (url === FEISHU_TENANT_URL) expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-tenant-token');
      return happyFetch(url, init);
    });
    const revision = s.store.load().revision;
    const result = await (await s.call('POST', `${CONFIG}/verify`, BODY)).json();
    expect(result).toEqual({ ok: true, checks: [{ key: 'credentials', status: 'passed' }, { key: 'tenant', status: 'passed' }],
      tenant: { name: '测试企业', key: 'company' }, callbackUrl: 'https://panda.example/api/feishu/oauth/callback' });
    expect(s.store.load().revision).toBe(revision);
    expect(s.store.load().source).toBe('environment');
    expect(s.users.list()).toHaveLength(2);
  });

  test('空密钥保留，清除和关闭不会回退环境变量，配置在重新实例化后仍然存在', async () => {
    const s = setup();
    await s.call('PUT', CONFIG, BODY);
    await s.call('PUT', CONFIG, { ...BODY, appSecret: '', allowRegistration: false });
    expect(s.store.load().appSecret).toBe('secret-company');
    expect(s.store.load().allowRegistration).toBe(false);
    const cleared = await s.call('PUT', CONFIG, { ...BODY, appSecret: '', clearAppSecret: true, enabled: false });
    expect(cleared.status).toBe(200);
    const reopened = new FeishuLoginConfigStore(s.db, { appId: 'cli_env', appSecret: 'secret-env' });
    expect(reopened.load()).toMatchObject({ enabled: false, appSecret: '', source: 'database' });
    expect(await (await s.call('GET', '/api/feishu/oauth/status')).json()).toEqual({ enabled: false });
    expect((await s.call('GET', '/api/feishu/oauth/start')).status).toBe(503);
  });

  test('切换应用不复用旧密钥；拒绝错误类型、冲突操作和不合法回调地址', async () => {
    const s = setup();
    await s.call('PUT', CONFIG, BODY);
    const revision = s.store.load().revision;
    for (const patch of [
      { appId: 'cli_other', appSecret: '' }, { enabled: 'yes' }, { allowRegistration: 1 },
      { appId: 'invalid' }, { appSecret: 42 }, { clearAppSecret: 'yes' }, { clearAppSecret: true },
      { publicUrl: 'javascript:alert(1)' }, { publicUrl: 'https://user:pass@panda.example' },
      { publicUrl: 'https://panda.example/path?x=1' },
    ]) {
      expect((await s.call('PUT', CONFIG, { ...BODY, ...patch })).status).toBe(400);
      expect(s.store.load().revision).toBe(revision);
    }
    const saved = await s.call('PUT', CONFIG, { ...BODY, appId: 'cli_other', enabled: false, appSecret: '' });
    expect(saved.status).toBe(200);
    expect(s.store.load().appSecret).toBe('');
  });

  test('解析后的站点地址规范化后保存，验证和扫码都使用完整回调 URL', async () => {
    const s = setup();
    for (const publicUrl of ['https:example.com', 'https:/example.com', 'HTTPS://EXAMPLE.COM:443/']) {
      const saved = await (await s.call('PUT', CONFIG, { ...BODY, publicUrl })).json();
      expect(saved.config.publicUrl).toBe('https://example.com');
      expect(saved.config.callbackUrl).toBe('https://example.com/api/feishu/oauth/callback');
      const verified = await (await s.call('POST', `${CONFIG}/verify`, { ...BODY, publicUrl })).json();
      expect(verified.callbackUrl).toBe('https://example.com/api/feishu/oauth/callback');
      const start = await s.call('GET', '/api/feishu/oauth/start');
      expect(new URL(start.headers.get('location')!).searchParams.get('redirect_uri')).toBe('https://example.com/api/feishu/oauth/callback');
    }
  });

  test('凭据错误、网络异常和企业权限失败准确区分，错误不泄露上游密钥', async () => {
    for (const failAt of [FEISHU_TENANT_TOKEN_URL, FEISHU_TENANT_URL]) {
      for (const failure of ['api', 'network', 'malformed']) {
        const s = setup(async (url, init) => {
          if (url !== failAt) return happyFetch(url, init);
          if (failure === 'network') throw new Error('secret-company');
          if (failure === 'malformed') return new Response('secret-company', { status: 502 });
          return json({ code: 999, msg: 'secret-company' });
        });
        const response = await s.call('POST', `${CONFIG}/verify`, BODY);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).not.toContain('secret-company');
        const body = JSON.parse(text);
        expect(body.ok).toBe(false);
        expect(body.checks).toEqual(failAt === FEISHU_TENANT_TOKEN_URL
          ? [{ key: 'credentials', status: 'failed', code: 'credentials_invalid' }, { key: 'tenant', status: 'skipped' }]
          : [{ key: 'credentials', status: 'passed' }, { key: 'tenant', status: 'failed', code: 'tenant_unavailable' }]);
      }
    }
  });

  test('保存即时影响真实扫码流程，关闭自动建号仍允许已绑定账号登录', async () => {
    const s = setup();
    await s.call('PUT', CONFIG, { ...BODY, allowRegistration: false });
    const denied = await s.loginFinish(await s.loginStart());
    expect(denied.headers.get('location')).toContain('feishu_err=');
    expect(s.users.list()).toHaveLength(2);
    await s.call('PUT', CONFIG, BODY);
    const accepted = await s.loginFinish(await s.loginStart());
    expect(accepted.headers.get('location')).toBe('/');
    expect(accepted.headers.get('set-cookie')).toContain('HttpOnly');
    expect(s.users.list()).toHaveLength(3);
    await s.call('PUT', CONFIG, { ...BODY, allowRegistration: false });
    expect((await s.loginFinish(await s.loginStart())).headers.get('location')).toBe('/');
  });

  test('配置更新使旧扫码状态失效，避免跨应用换码', async () => {
    let exchanges = 0;
    const s = setup(async (url, init) => { if (url === FEISHU_TOKEN_URL) exchanges++; return happyFetch(url, init); });
    const state = await s.loginStart();
    await s.call('PUT', CONFIG, BODY);
    const old = await s.loginFinish(state);
    expect(old.headers.get('location')).toContain('feishu_err=');
    expect(exchanges).toBe(0);
    expect((await s.loginFinish(await s.loginStart())).headers.get('location')).toBe('/');
  });

  test('企业查询进行中关闭自动建号，返回后不再创建账号或会话', async () => {
    let changeConfig = () => {};
    const s = setup(async (url, init) => { if (url === FEISHU_TENANT_URL) changeConfig(); return happyFetch(url, init); });
    changeConfig = () => s.store.save(s.store.draft({ ...BODY, allowRegistration: false }));
    const result = await s.loginFinish(await s.loginStart());
    expect(result.headers.get('location')).toContain('feishu_err=');
    expect(result.headers.get('set-cookie')).toBeNull();
    expect(s.users.list()).toHaveLength(2);
  });
});

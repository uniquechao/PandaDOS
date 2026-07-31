import { describe, expect, test } from 'bun:test';
import {
  FEISHU_AUTHORIZE_URL,
  FEISHU_TOKEN_URL,
  FEISHU_USERINFO_URL,
  FeishuOauthClient,
  OauthStateStore,
  type FetchLike,
} from './feishu-oauth';

const CFG = { appId: 'cli_test', appSecret: 'sec_test' };
const CB = 'https://x.example/api/feishu/oauth/callback';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('FeishuOauthClient.authorizeUrl', () => {
  test('带 client_id/redirect_uri/state 且正确编码', () => {
    const c = new FeishuOauthClient(CFG);
    const u = new URL(c.authorizeUrl(CB, 'st-1'));
    expect(`${u.origin}${u.pathname}`).toBe(FEISHU_AUTHORIZE_URL);
    expect(u.searchParams.get('client_id')).toBe('cli_test');
    expect(u.searchParams.get('redirect_uri')).toBe(CB);
    expect(u.searchParams.get('state')).toBe('st-1');
  });
});

describe('FeishuOauthClient.userByCode', () => {
  test('happy path：code 换 token → user_info 得 open_id/name', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, ...(init ? { init } : {}) });
      if (url === FEISHU_TOKEN_URL) return jsonRes({ code: 0, access_token: 'uat-1' });
      if (url === FEISHU_USERINFO_URL) {
        return jsonRes({ code: 0, data: { open_id: 'ou_abc', name: '张三' } });
      }
      throw new Error(`unexpected url ${url}`);
    };
    const c = new FeishuOauthClient(CFG, fetchFn);
    const u = await c.userByCode('code-1', CB);
    expect(u).toEqual({ openId: 'ou_abc', name: '张三' });

    // 换 token 请求体带齐授权码模式全参数（redirect_uri 必须与授权时一致）
    const tokenBody = JSON.parse(String(calls[0]!.init!.body)) as Record<string, string>;
    expect(tokenBody.grant_type).toBe('authorization_code');
    expect(tokenBody.client_id).toBe('cli_test');
    expect(tokenBody.client_secret).toBe('sec_test');
    expect(tokenBody.code).toBe('code-1');
    expect(tokenBody.redirect_uri).toBe(CB);
    // user_info 带 Bearer user_access_token
    const h = calls[1]!.init!.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer uat-1');
  });

  test('换 token 失败（code!=0）→ 抛出可展示错误', async () => {
    const fetchFn: FetchLike = async () =>
      jsonRes({ code: 20050, error: 'invalid_grant', error_description: '授权码已失效' }, 400);
    const c = new FeishuOauthClient(CFG, fetchFn);
    await expect(c.userByCode('bad', CB)).rejects.toThrow('授权码已失效');
  });

  test('user_info 失败/非 JSON → 抛错不静默', async () => {
    const fetchFn: FetchLike = async (url) =>
      url === FEISHU_TOKEN_URL
        ? jsonRes({ code: 0, access_token: 'uat-1' })
        : new Response('gateway error', { status: 502 });
    const c = new FeishuOauthClient(CFG, fetchFn);
    await expect(c.userByCode('code-1', CB)).rejects.toThrow('HTTP 502');
  });
});

describe('OauthStateStore', () => {
  test('issue → consume 一次性：第二次 consume 返回 null', () => {
    const s = new OauthStateStore();
    const st = s.issue({ mode: 'bind', userId: 7, redirectUri: CB });
    expect(st).toMatch(/^[0-9a-f]{48}$/);
    expect(s.consume(st)).toEqual({ mode: 'bind', userId: 7, redirectUri: CB });
    expect(s.consume(st)).toBeNull();
    expect(s.consume('nonexistent')).toBeNull();
  });

  test('TTL 过期后 consume 返回 null', () => {
    let t = 0;
    const s = new OauthStateStore({ ttlMs: 100, now: () => t });
    const st = s.issue({ mode: 'login', redirectUri: CB });
    t = 101;
    expect(s.consume(st)).toBeNull();
  });

  test('容量上限：超限淘汰最旧（公开端点防灌满）', () => {
    const s = new OauthStateStore({ max: 2 });
    const a = s.issue({ mode: 'login', redirectUri: CB });
    const b = s.issue({ mode: 'login', redirectUri: CB });
    const c = s.issue({ mode: 'login', redirectUri: CB });
    expect(s.consume(a)).toBeNull(); // 最旧的 a 被淘汰
    expect(s.consume(b)).not.toBeNull();
    expect(s.consume(c)).not.toBeNull();
  });
});

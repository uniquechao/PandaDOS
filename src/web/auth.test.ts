import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import {
  COOKIE,
  COOKIE_MAX_AGE,
  loginCookie,
  logoutCookie,
  requestIsSecure,
  resolveUser,
  tokenFromReq,
} from './auth';

function req(headers: Record<string, string> = {}, url = 'http://x/api/me'): Request {
  return new Request(url, { headers });
}

describe('tokenFromReq', () => {
  test('从 cookie 提取', () => {
    expect(tokenFromReq(req({ cookie: `${COOKIE}=abc123` }))).toBe('abc123');
    expect(tokenFromReq(req({ cookie: `other=1; ${COOKIE}=abc123; x=2` }))).toBe('abc123');
  });

  test('左锚定：不吃 evil_panda_token 后缀同名 cookie', () => {
    expect(tokenFromReq(req({ cookie: `evil_${COOKIE}=steal` }))).toBeNull();
  });

  test('Bearer 兜底（脚本兼容）', () => {
    expect(tokenFromReq(req({ authorization: 'Bearer tok9' }))).toBe('tok9');
    expect(tokenFromReq(req({ authorization: 'Basic zzz' }))).toBeNull();
  });

  test('cookie 优先于 Bearer；URL ?token= 不接受', () => {
    expect(
      tokenFromReq(req({ cookie: `${COOKIE}=fromcookie`, authorization: 'Bearer frombearer' })),
    ).toBe('fromcookie');
    expect(tokenFromReq(req({}, 'http://x/api/me?token=leak'))).toBeNull();
  });
});

describe('cookie 收发', () => {
  test('loginCookie：HttpOnly + SameSite=Lax + 30 天', () => {
    const c = loginCookie('tok');
    expect(c).toContain(`${COOKIE}=tok`);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain(`Max-Age=${COOKIE_MAX_AGE}`);
    expect(c).not.toContain('Secure');
  });

  test('secure 下补 Secure；logoutCookie Max-Age=0', () => {
    expect(loginCookie('tok', { secure: true })).toContain('; Secure');
    const out = logoutCookie();
    expect(out).toContain(`${COOKIE}=;`);
    expect(out).toContain('Max-Age=0');
  });

  test('requestIsSecure：https 直连或 x-forwarded-proto', () => {
    expect(requestIsSecure(req(), new URL('https://x/'))).toBe(true);
    expect(requestIsSecure(req({ 'x-forwarded-proto': 'https' }), new URL('http://x/'))).toBe(true);
    expect(requestIsSecure(req(), new URL('http://x/'))).toBe(false);
  });
});

describe('resolveUser', () => {
  test('明文 token 进、哈希比对出用户；无效 token null', () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new UserStore(db);
    const { user, token } = store.create('alice', 'user');

    expect(resolveUser(req({ cookie: `${COOKIE}=${token}` }), store)?.id).toBe(user.id);
    expect(resolveUser(req({ authorization: `Bearer ${token}` }), store)?.id).toBe(user.id);
    expect(resolveUser(req({ cookie: `${COOKIE}=deadbeef` }), store)).toBeNull();
    expect(resolveUser(req(), store)).toBeNull();
    db.close();
  });

  test('认证成功记「最后使用时间」，无效 token 不记（012 last_seen_ts）', () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new UserStore(db);
    const { user, token } = store.create('bob', 'user');
    expect(store.byId(user.id)?.lastSeenTs).toBeNull();

    resolveUser(req({ cookie: `${COOKIE}=deadbeef` }), store);
    expect(store.byId(user.id)?.lastSeenTs).toBeNull();

    resolveUser(req({ cookie: `${COOKIE}=${token}` }), store);
    expect(store.byId(user.id)?.lastSeenTs).toBeGreaterThan(0);
    db.close();
  });
});

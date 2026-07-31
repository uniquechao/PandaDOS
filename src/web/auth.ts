/**
 * web/auth —— token 提取 / cookie 收发 / 请求→用户解析（v1 auth.ts 平移改造）。
 * - Cookie 名 butler_token，正则左锚定（防 evil_butler_token 后缀同名 cookie）
 * - Bearer 兼容脚本；显式不接受 ?token=（避免泄漏到日志/历史，v1 已还的债不回头）
 * - COOKIE 常量只此一处（v1 auth.ts:3 与 web.ts:24 重复定义是评审点名的雷）
 * - cookie 里放明文 token，DB 只存哈希——resolveUser 先 hashToken 再查
 */
import { hashToken, type UserStore } from '../core/users';
import type { User } from '../core/types';

export const COOKIE = 'butler_token';
/** 30 天（v1 web.ts:106 平移） */
export const COOKIE_MAX_AGE = 2592000;

const COOKIE_RE = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`);

/** 从请求提取明文 token：Cookie 优先，Bearer 兜底（脚本用），不看 URL。 */
export function tokenFromReq(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(COOKIE_RE);
  if (m?.[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  const auth = req.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return null;
}

/** 请求是否走在 TLS 上（直连 https 或反代 x-forwarded-proto）——决定 cookie 加不加 Secure */
export function requestIsSecure(req: Request, url: URL): boolean {
  if (url.protocol === 'https:') return true;
  const proto = req.headers.get('x-forwarded-proto');
  return proto?.split(',')[0]?.trim() === 'https';
}

/** 登录成功的 Set-Cookie 值：HttpOnly + SameSite=Lax + 30 天；TLS 下补 Secure（评审 5.5#4） */
export function loginCookie(token: string, opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ? '; Secure' : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}${secure}`;
}

/** 登出：清 cookie（Max-Age=0） */
export function logoutCookie(opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ? '; Secure' : '';
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/** 会话查找的最小面（core/sessions.SessionStore 结构兼容；飞书扫码登录签发的会话） */
export interface SessionLookup {
  userIdByTokenHash(hash: string): number | undefined;
}

/**
 * 请求 → 已认证用户；无 token / token 无效 → null。比对在 store 内常数时间完成。
 * 顺序：users 长期 token 优先，未命中再查登录会话（sessions 未接线 = 只认长期 token，fail closed）。
 * 认证成功顺手记「最后使用时间」（012 last_seen_ts）——HTTP 中间件与 WS 鉴权都走这里，
 * 写库节流在 UserStore.touchSeen 内。
 */
export function resolveUser(req: Request, users: UserStore, sessions?: SessionLookup): User | null {
  const tok = tokenFromReq(req);
  if (!tok) return null;
  const hash = hashToken(tok);
  let u: User | null = users.byTokenHash(hash) ?? null;
  if (!u) {
    const sid = sessions?.userIdByTokenHash(hash);
    u = sid !== undefined ? (users.byId(sid) ?? null) : null;
  }
  if (u) users.touchSeen(u.id);
  return u;
}

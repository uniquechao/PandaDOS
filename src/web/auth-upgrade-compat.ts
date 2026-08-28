/**
 * 产品改名后的一次性登录兼容层。
 *
 * 旧 Cookie 最长有效期为 30 天；为避免滚动升级让已登录用户突然掉线，
 * 2026-09-27 前保留读取和清理能力，之后可整个删除本文件。
 */

export const UPGRADE_COOKIE_NAME = 'butler_token';

const UPGRADE_COOKIE_RE = new RegExp(`(?:^|;\\s*)${UPGRADE_COOKIE_NAME}=([^;]+)`);

/** 仅在新 Cookie 缺失时由调用方使用。 */
export function tokenFromUpgradeCookie(cookieHeader: string): string | null {
  const match = cookieHeader.match(UPGRADE_COOKIE_RE);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** 登出时清理旧 Cookie，防止它在新 Cookie 被删除后重新生效。 */
export function upgradeLogoutCookie(opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ? '; Secure' : '';
  return `${UPGRADE_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

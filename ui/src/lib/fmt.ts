/** ui/lib/fmt —— 时间/文本小工具 */

import { runtimeI18n } from '../i18n/runtime';

/** 绝对时间：今年内 MM-DD HH:mm，跨年补年份 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  return runtimeI18n().formatDateTime(ts);
}

/** 相对时间（列表用） */
export function timeAgo(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts) return '—';
  return runtimeI18n().formatRelativeTime(ts, now);
}

export function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…';
}

/** 安全 JSON.parse（失败回 null） */
export function tryJson<T>(s: string | null | undefined): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

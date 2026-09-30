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

/** 文件大小（B/K/M/G，技术单位不随语言变化） */
export function fmtSize(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

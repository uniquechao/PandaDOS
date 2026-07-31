/** ui/lib/fmt —— 时间/文本小工具 */

const pad = (n: number): string => String(n).padStart(2, '0');

/** 绝对时间：今年内 MM-DD HH:mm，跨年补年份 */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const md = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 相对时间（列表用） */
export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}天前`;
  return fmtTime(ts);
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

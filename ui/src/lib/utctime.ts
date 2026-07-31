/**
 * lib/utctime —— 把消息正文里的 UTC 时间点就地换算成浏览器所在时区（issue #116）。
 *
 * 现场：CC 的额度提示（`<synthetic>` assistant 消息）写的是
 * `You've hit your session limit · resets 6:50am (UTC)`——用户得自己心算时差才知道几点能接着用。
 * 这里只做「就地补一份本地时间」，**保留原文**（`6:50am (UTC → 本地 14:50)`）：万一时区/跨日
 * 算歪了，原文还在，不会把人误导到错的时刻。
 *
 * 跨日：`resets` 说的是**下一次**到点，故按参照时刻（该消息行的 ts，缺省 now）取「≥ 参照的最近一次」，
 * 落到本地不是同一天就把日子标出来（明天 / M/D），否则「6:50am (UTC → 本地 14:50)」会让人以为是今天。
 */

/** 支持三种写法：`6:50am (UTC)` / `5pm (UTC)` / `06:50 (UTC)`（GMT 同义）；裸 `5 (UTC)` 太含糊不认 */
const UTC_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\((UTC|GMT)\)/gi;

/** 参照时刻之后（含当刻）最近一次「UTC 墙上时间 = hh:mm」的绝对毫秒 */
export function nextUtcOccurrence(hour24: number, minute: number, refMs: number): number {
  const ref = new Date(refMs);
  let at = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hour24, minute, 0, 0);
  if (at < refMs) at += 24 * 3600 * 1000;
  return at;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 绝对毫秒 → 本地「[明天/M-D] HH:MM」（同一本地日不带日期前缀） */
function localLabel(atMs: number, refMs: number): string {
  const at = new Date(atMs);
  const hm = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(at) - startOfDay(new Date(refMs))) / (24 * 3600 * 1000));
  if (days <= 0) return hm;
  if (days === 1) return `明天 ${hm}`;
  return `${at.getMonth() + 1}-${at.getDate()} ${hm}`;
}

/**
 * 正文里的 UTC 时间点 → 就地补本地时间：`6:50am (UTC)` → `6:50am (UTC → 本地 14:50)`。
 * 无匹配 / 时分越界 / 含糊写法一律**原样返回**（绝不改动用户看到的原句）。
 * refMs = 该消息的行级时间戳（缺省 now），决定「下一次到点」落在哪天。
 */
export function localizeUtcTimes(text: string, refMs: number = Date.now()): string {
  if (!text || !/\((UTC|GMT)\)/i.test(text)) return text;
  return text.replace(UTC_TIME_RE, (whole, h: string, m: string | undefined, ap: string | undefined) => {
    if (!ap && m === undefined) return whole; // 裸 `5 (UTC)`：分不清是几点还是别的数字，不动
    const hour = Number(h);
    const minute = m === undefined ? 0 : Number(m);
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return whole;
    let hour24 = hour;
    if (ap) {
      if (hour < 1 || hour > 12) return whole;
      const pm = ap.toLowerCase() === 'pm';
      hour24 = hour === 12 ? (pm ? 12 : 0) : pm ? hour + 12 : hour;
    } else if (hour > 23) return whole;
    const at = nextUtcOccurrence(hour24, minute, refMs);
    return `${whole.slice(0, -1)} → 本地 ${localLabel(at, refMs)})`; // whole 末字符恒是 ')'
  });
}

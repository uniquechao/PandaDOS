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

import {
  localizeUtcTimes as localizeUtcTimesWithI18n,
  nextUtcOccurrence,
} from '../../../shared/i18n/formatter';
import { runtimeI18n } from '../i18n/runtime';

export { nextUtcOccurrence };

/**
 * 正文里的 UTC 时间点 → 就地补本地时间：`6:50am (UTC)` → `6:50am (UTC → 本地 14:50)`。
 * 无匹配 / 时分越界 / 含糊写法一律**原样返回**（绝不改动用户看到的原句）。
 * refMs = 该消息的行级时间戳（缺省 now），决定「下一次到点」落在哪天。
 */
export function localizeUtcTimes(text: string, refMs: number = Date.now()): string {
  return localizeUtcTimesWithI18n(text, refMs, runtimeI18n());
}

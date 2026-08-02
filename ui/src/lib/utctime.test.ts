import { beforeAll, describe, expect, test } from 'bun:test';
import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { createI18n } from '../../../shared/i18n/formatter';
import { setRuntimeI18n } from '../i18n/runtime';
import { localizeUtcTimes, nextUtcOccurrence } from './utctime';

beforeAll(() => {
  setRuntimeI18n(createI18n({ locale: 'en', timeZone: 'Asia/Shanghai', catalog: enCatalog }));
});

const REF = Date.parse('2026-07-29T05:12:53.000Z'); // 参照时刻（消息行 ts）

describe('nextUtcOccurrence（≥ 参照时刻的最近一次 UTC 墙上时间）', () => {
  test('当天还没到 → 取当天', () => {
    expect(nextUtcOccurrence(6, 50, REF)).toBe(Date.parse('2026-07-29T06:50:00.000Z'));
  });
  test('当天已过 → 跨到次日', () => {
    expect(nextUtcOccurrence(5, 0, REF)).toBe(Date.parse('2026-07-30T05:00:00.000Z'));
  });
  test('刚好等于参照时刻 → 取当刻，不跨日', () => {
    const at = Date.parse('2026-07-29T05:00:00.000Z');
    expect(nextUtcOccurrence(5, 0, at)).toBe(at);
  });
});

describe('localizeUtcTimes（正文里的 UTC 时间点补本地时间，issue #116）', () => {
  test('额度提示现场：6:50am (UTC) 就地补本地时间且保留原文', () => {
    const out = localizeUtcTimes("You've hit your session limit · resets 6:50am (UTC)", REF);
    expect(out).toBe("You've hit your session limit · resets 6:50am (UTC → local time 2:50 PM)");
  });

  test('整点 5pm / 24 小时制 06:50 / GMT 同样认', () => {
    const pm = localizeUtcTimes('resets 5pm (UTC)', REF);
    expect(pm).toContain('local time tomorrow 1:00 AM');
    const h24 = localizeUtcTimes('resets 06:50 (UTC)', REF);
    expect(h24).toContain('local time 2:50 PM');
    expect(localizeUtcTimes('resets 6:50am (GMT)', REF)).toContain('local time ');
  });

  test('12 点边界：12am=0 点、12pm=正午', () => {
    // 12am 是次日 0 点：本地可能带「明天」前缀，故只钉时分
    expect(localizeUtcTimes('at 12am (UTC)', REF)).toContain('8:00 AM');
    expect(localizeUtcTimes('at 12pm (UTC)', REF)).toContain(
      'local time 8:00 PM',
    );
  });

  test('跨日：本地落到别的日历日时把日子标出来', () => {
    // 参照 UTC 05:12，目标 UTC 次日 04:00 —— 任何时区下本地都不可能还是同一天
    const out = localizeUtcTimes('resets 4am (UTC)', REF);
    expect(out).toContain('local time tomorrow 12:00 PM');
  });

  test('无匹配 / 含糊写法 / 越界一律原样返回', () => {
    expect(localizeUtcTimes('今天没有时间点', REF)).toBe('今天没有时间点');
    expect(localizeUtcTimes('端口 5 (UTC)', REF)).toBe('端口 5 (UTC)'); // 裸数字不认
    expect(localizeUtcTimes('resets 25:70 (UTC)', REF)).toBe('resets 25:70 (UTC)');
    expect(localizeUtcTimes('resets 13pm (UTC)', REF)).toBe('resets 13pm (UTC)');
    expect(localizeUtcTimes('', REF)).toBe('');
  });

  test('一段里多个时间点各自换算', () => {
    const out = localizeUtcTimes('限额 6:50am (UTC) 恢复，维护窗口 5pm (UTC)', REF);
    expect(out).toContain('6:50am (UTC → local time 2:50 PM)');
    expect(out).toContain('5pm (UTC → local time tomorrow 1:00 AM)');
  });
});

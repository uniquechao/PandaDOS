import { describe, expect, test } from 'bun:test';
import { enCatalog } from './catalogs/en';
import { deCatalog } from './catalogs/de';
import { zhHansCatalog } from './catalogs/zh-Hans';
import { createI18n, localizeUtcTimes } from './formatter';

describe('ICU messages', () => {
  test('formats English and Russian-style capable ICU plurals through IntlMessageFormat', () => {
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog });
    expect(en.t('common.issueCount', { count: 1 })).toBe('1 issue');
    expect(en.t('common.issueCount', { count: 2 })).toBe('2 issues');
  });

  test('falls back to English, then to a visible stable key', () => {
    const diagnostics: string[] = [];
    const de = createI18n({
      locale: 'de',
      timeZone: 'UTC',
      catalog: { ...deCatalog, 'common.cancel': undefined } as never,
      onDiagnostic: (message) => diagnostics.push(message),
    });
    expect(de.t('common.cancel')).toBe('Cancel');
    expect(de.t('missing.key' as never)).toBe('[missing.key]');
    expect(diagnostics).toHaveLength(2);
  });
});

describe('locale and timezone formatting', () => {
  const ts = Date.parse('2026-07-31T14:05:00.000Z');

  test('formats numbers and dates with locale conventions', () => {
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog });
    const de = createI18n({ locale: 'de', timeZone: 'UTC', catalog: deCatalog });
    expect(en.formatNumber(12345)).toBe('12,345');
    expect(de.formatNumber(12345)).toBe('12.345');
    expect(en.formatDateTime(ts)).toContain('Jul 31, 2026');
    expect(en.formatDateTime(ts)).toContain('2:05 PM');
    expect(de.formatDateTime(ts)).toContain('31.07.2026');
  });

  test('honors DST instead of applying a fixed numeric offset', () => {
    const ny = createI18n({ locale: 'en', timeZone: 'America/New_York', catalog: enCatalog });
    expect(ny.formatTime(Date.parse('2026-03-08T06:30:00Z'))).toBe('1:30 AM');
    expect(ny.formatTime(Date.parse('2026-03-08T07:30:00Z'))).toBe('3:30 AM');
  });

  test('formats relative time in the selected language', () => {
    const now = Date.parse('2026-07-31T14:05:00Z');
    const fiveMinutesAgo = now - 5 * 60_000;
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog });
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: zhHansCatalog });
    expect(en.formatRelativeTime(fiveMinutesAgo, now)).toBe('5 minutes ago');
    expect(zh.formatRelativeTime(fiveMinutesAgo, now)).toBe('5分钟前');
  });

  test('keeps UTC source text and appends a localized target time', () => {
    const ref = Date.parse('2026-07-31T00:00:00Z');
    const de = createI18n({ locale: 'de', timeZone: 'Europe/Berlin', catalog: deCatalog });
    const result = localizeUtcTimes('resets 6:50am (UTC)', ref, de);
    expect(result).toContain('6:50am (UTC');
    expect(result).toContain('Ortszeit 08:50');
  });
});

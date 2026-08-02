import { describe, expect, test } from 'bun:test';
import { createI18n } from '../../../shared/i18n/formatter';
import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { deCatalog } from '../../../shared/i18n/catalogs/de';
import { setRuntimeI18n } from '../i18n/runtime';
import { fmtTime, timeAgo } from './fmt';

describe('UI time formatting', () => {
  const ts = Date.parse('2026-07-31T14:05:00Z');

  test('uses the active locale and explicit timezone', () => {
    setRuntimeI18n(createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog }));
    expect(fmtTime(ts)).toContain('Jul 31, 2026');
    setRuntimeI18n(createI18n({ locale: 'de', timeZone: 'Europe/Berlin', catalog: deCatalog }));
    expect(fmtTime(ts)).toContain('16:05');
  });

  test('uses Intl relative wording instead of fixed Chinese suffixes', () => {
    setRuntimeI18n(createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog }));
    expect(timeAgo(ts, ts + 5 * 60_000)).toBe('5 minutes ago');
  });
});

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  isValidTimeZone,
  matchSupportedLocale,
} from './locales';

describe('supported locale matching', () => {
  test('publishes the exact ten launch locales with English fallback', () => {
    expect(SUPPORTED_LOCALES).toEqual([
      'en',
      'zh-Hans',
      'zh-Hant',
      'ja',
      'ko',
      'es',
      'fr',
      'de',
      'pt-BR',
      'ru',
    ]);
    expect(DEFAULT_LOCALE).toBe('en');
  });

  test('maps Chinese, Portuguese, and regional browser variants', () => {
    expect(matchSupportedLocale(['zh_TW'])).toBe('zh-Hant');
    expect(matchSupportedLocale(['zh-HK'])).toBe('zh-Hant');
    expect(matchSupportedLocale(['zh-CN'])).toBe('zh-Hans');
    expect(matchSupportedLocale(['zh'])).toBe('zh-Hans');
    expect(matchSupportedLocale(['pt-PT'])).toBe('pt-BR');
    expect(matchSupportedLocale(['fr-CA'])).toBe('fr');
  });

  test('checks candidates in order and falls back to English', () => {
    expect(matchSupportedLocale(['ar', 'de-DE', 'fr'])).toBe('de');
    expect(matchSupportedLocale(['ar', 'xx'])).toBe('en');
    expect(matchSupportedLocale([])).toBe('en');
    expect(isSupportedLocale('pt-BR')).toBe(true);
    expect(isSupportedLocale('pt-PT')).toBe(false);
  });
});

describe('IANA timezone validation', () => {
  test('accepts platform timezones and rejects invalid values', () => {
    expect(isValidTimeZone('Asia/Singapore')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
  });
});

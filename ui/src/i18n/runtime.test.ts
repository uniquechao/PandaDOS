import { describe, expect, test } from 'bun:test';
import { createI18n } from '../../../shared/i18n/formatter';
import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { zhHansCatalog } from '../../../shared/i18n/catalogs/zh-Hans';
import { setRuntimeI18n, tr } from './runtime';

describe('render-time translator', () => {
  test('uses the latest provider i18n instance', () => {
    setRuntimeI18n(createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog }));
    expect(tr('common.cancel')).toBe('Cancel');
    setRuntimeI18n(createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: zhHansCatalog }));
    expect(tr('common.cancel')).toBe('取消');
  });
});

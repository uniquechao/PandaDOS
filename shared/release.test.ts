import { describe, expect, test } from 'bun:test';
import { catalogs } from './i18n/catalogs';
import { RELEASE_NOTE_KEYS } from './release-notes';
import release from '../release.json';
import pkg from '../package.json';

describe('release metadata', () => {
  test('ships a dated product version and concise release notes', async () => {
    const file = Bun.file(new URL('../release.json', import.meta.url));
    expect(await file.exists()).toBe(true);
    const release = await file.json();
    expect(release.version).toMatch(/^\d+\.\d+\.\d+-\d{4}\.\d{4}$/);
    expect(release.version).toBe('2.6.8-2026.1112');
    expect(release.version.split('-')[0]).toBe(pkg.version);
    expect(release.notes).toEqual([
      'executor-cache-admission',
    ]);
  });

  test('every published note resolves to translated copy in every locale', () => {
    for (const note of release.notes) {
      const key = RELEASE_NOTE_KEYS[note as keyof typeof RELEASE_NOTE_KEYS];
      expect(key).toBeDefined();
      for (const [locale, catalog] of Object.entries(catalogs)) {
        expect(typeof catalog[key]).toBe('string');
        expect(catalog[key].trim().length).toBeGreaterThan(0);
        if (locale !== 'en') expect(catalog[key]).not.toBe(catalogs.en[key]);
      }
    }
  });
});

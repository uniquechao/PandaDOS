import { describe, expect, test } from 'bun:test';

describe('release metadata', () => {
  test('ships a dated product version and concise release notes', async () => {
    const file = Bun.file(new URL('../release.json', import.meta.url));
    expect(await file.exists()).toBe(true);
    const release = await file.json();
    expect(release.version).toMatch(/^\d+\.\d+\.\d+-\d{4}\.\d{4}$/);
    expect(release.version).toBe('2.3.2-2026.0917');
    expect(release.notes).toEqual([
      'issue-direct-execution',
      'issue-pause-resume',
      'skill-policies',
      'project-sync-reliability',
    ]);
  });
});

import { describe, expect, test } from 'bun:test';

describe('release metadata', () => {
  test('ships a dated product version and concise release notes', async () => {
    const file = Bun.file(new URL('../release.json', import.meta.url));
    expect(await file.exists()).toBe(true);
    const release = await file.json();
    expect(release.version).toMatch(/^\d+\.\d+\.\d+-\d{4}\.\d{4}$/);
    expect(release.version).toBe('2.4.1-2026.0929');
    expect(release.notes).toEqual([
      'unified-workspace',
      'issue-injection-recovery',
      'validation-delivery-evidence',
      'dedicated-ssh-isolation',
      'agent-chatroom-workspace',
      'local-session-member-models',
      'agent-roster-editing',
      'compact-member-contact-list',
      'conversation-segment-resume',
    ]);
  });
});

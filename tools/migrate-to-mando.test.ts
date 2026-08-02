import { describe, expect, test } from 'bun:test';
import { parseMigrationArgs } from './migrate-to-mando';

describe('migrate-to-mando CLI', () => {
  test('requires one mode and accepts repeated project roots', () => {
    expect(parseMigrationArgs(['--dry-run', '--project-root', '/a', '--project-root', '/b'], '/home')).toEqual({
      mode: 'dry-run',
      projectRoots: ['/a', '/b'],
      homeDir: '/home',
    });
    expect(() => parseMigrationArgs([], '/home')).toThrow('exactly one');
    expect(() => parseMigrationArgs(['--dry-run', '--apply'], '/home')).toThrow('exactly one');
  });
});

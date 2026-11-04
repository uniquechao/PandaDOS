/** Test-only short socket directories, shared across regular and deep integration worktrees. */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';

export function testTmuxDirectory(): string {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cannot locate test repository');
  const repository = dirname(result.stdout.trim());
  const root = join(repository, '.private', 'tm');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(resolve(root), 't-'));
}

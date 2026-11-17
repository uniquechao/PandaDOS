import type { ExecutorDriver } from '../executor/driver';

/** Resolve the authoritative remote ref without modifying local refs or reissuing a push. */
export async function observeRemoteCandidate(
  driver: Pick<ExecutorDriver, 'git'>, cwd: string, branch: string, candidate: string,
): Promise<{ tip: string; included: boolean } | null> {
  const ref = 'refs/heads/' + branch;
  const remote = await driver.git(cwd, ['ls-remote', '--refs', 'origin', ref]);
  const tip = remote.out.split('\n').map(line => line.split('\t')).find(([, name]) => name === ref)?.[0];
  if (remote.code !== 0 || !tip || !/^[a-f0-9]{40,64}$/.test(tip)) return null;
  if (tip === candidate) return { tip, included: true };
  const ancestry = await driver.git(cwd, ['merge-base', '--is-ancestor', candidate, tip]);
  return ancestry.code === 0 || ancestry.code === 1 ? { tip, included: ancestry.code === 0 } : null;
}

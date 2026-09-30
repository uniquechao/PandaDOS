import { describe, expect, test } from 'bun:test';
import type { EngineIssue, IssueStore } from './engine';
import { IssueSchedulingPolicy } from './scheduling-policy';

function issue(id: string, status: EngineIssue['status'], moduleId = 1, pinnedTs: number | null = null): EngineIssue {
  return { id, status, moduleId, pinnedTs, createdTs: Number(id) } as EngineIssue;
}

function setup(issues: EngineIssue[], pausedNote = '') {
  const store = {
    listByProject: () => issues,
    listRunnableByProject: () => issues,
    lastEnterInfo: () => ({ note: pausedNote }),
  } as unknown as Pick<IssueStore, 'listByProject' | 'listRunnableByProject' | 'lastEnterInfo'>;
  const active = new Set<string>();
  return { policy: new IssueSchedulingPolicy(store, (id) => active.has(id)), active };
}

describe('IssueSchedulingPolicy', () => {
  test('protects the paused session when input delivery is uncertain', () => {
    const { policy } = setup([issue('1', 'paused'), issue('2', 'pending'), issue('3', 'pending', 2)], 'PANDA_INPUT_SUBMIT_UNCONFIRMED: timeout');
    expect(policy.runnable(1).map(x => x.id)).toEqual(['1', '3']);
  });

  test('active transitions are not picked again and a pinned pending issue outranks resume', () => {
    const { policy, active } = setup([issue('1', 'blocked', 1, 10), issue('2', 'pending', 1, 20)]);
    expect(policy.canConsumeUnblock(1, '1', 10)).toBe(false);
    expect(policy.canConsumeUnblock(1, '1', 21)).toBe(true);
    active.add('1');
    expect(policy.canConsumeUnblock(1, '1', 21)).toBe(false);
  });
});

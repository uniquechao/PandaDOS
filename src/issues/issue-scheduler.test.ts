import { describe, expect, test } from 'bun:test';
import type { EngineIssue, IssueStore, PendingUnblockRequest } from './engine';
import type { IssueSchedulingPolicy } from './scheduling-policy';
import { IssueScheduler } from './issue-scheduler';

function issue(id: string, status: EngineIssue['status'], createdTs: number): EngineIssue {
  return { id, status, module: 'module', moduleId: 1, createdTs, pinnedTs: null } as EngineIssue;
}

function fixture(initial: EngineIssue[], requests: PendingUnblockRequest[] = []) {
  const issues = [...initial];
  const events: Array<{ id: string; kind: string; data?: Record<string, unknown> }> = [];
  const store = {
    get: (id: string) => issues.find(i => i.id === id),
    listByProject: () => issues,
    listPendingUnblockRequests: () => requests,
    logEvent: (id: string, kind: string, data?: Record<string, unknown>) => { events.push({ id, kind, data }); },
  } as unknown as Pick<IssueStore, 'get' | 'listByProject' | 'listPendingUnblockRequests' | 'logEvent'>;
  const policy = {
    runnable: () => issues,
    canConsumeUnblock: () => true,
  } as unknown as IssueSchedulingPolicy;
  return { issues, events, store, policy };
}

describe('IssueScheduler project flight', () => {
  for (const stopDuring of ['resume', 'merge'] as const) {
    test(`shutdown during ${stopDuring} does not start another issue or clarification`, async () => {
      const requests = stopDuring === 'resume'
        ? [{ issueId: '1', guidance: 'continue', actor: null, ts: 42 } as PendingUnblockRequest] : [];
      const f = fixture([issue('1', 'blocked', 1), issue('2', 'pending', 2)], requests);
      let accepting = true;
      const started: string[] = [];
      const clarified: string[] = [];
      const scheduler = new IssueScheduler({
        store: f.store, policy: f.policy, canSchedule: () => accepting,
        applyUnblock: async () => { accepting = false; return { ok: false, error: 'stopped' }; },
        mergeModule: async () => { accepting = false; return ['2']; },
        startIssue: async (id) => {
          started.push(id);
          return { ok: true, from: 'pending', to: 'implementing' };
        },
        scheduleClarify: (id) => { clarified.push(id); },
      });
      await scheduler.scheduleNext(7);
      expect(started).toEqual([]);
      expect(clarified).toEqual([]);
    });
  }

  test('nested relay after a synchronous block is suppressed, then outer flight starts the next issue', async () => {
    const f = fixture([issue('1', 'pending', 1), issue('2', 'pending', 2)]);
    const started: string[] = [];
    const clarify: string[] = [];
    let scheduler!: IssueScheduler;
    scheduler = new IssueScheduler({
      store: f.store, policy: f.policy, canSchedule: () => true,
      applyUnblock: async () => ({ ok: false, error: 'unused' }),
      mergeModule: async () => ['1'],
      scheduleClarify: (id) => { clarify.push(id); },
      startIssue: async (id) => {
        started.push(id);
        f.issues.find(i => i.id === id)!.status = id === '1' ? 'blocked' : 'implementing';
        if (id === '1') await scheduler.scheduleNext(7);
        return { ok: true, from: 'pending', to: id === '1' ? 'blocked' : 'implementing' };
      },
    });
    await scheduler.scheduleNext(7);
    expect(started).toEqual(['1', '2']);
    expect(clarify).toEqual(['1', '1']);
    expect(f.events).toEqual([]);
  });

  test('resumes a persisted unblock intent before starting a fresh issue', async () => {
    const request = { issueId: '1', guidance: 'continue', actor: 8, ts: 42 } as PendingUnblockRequest;
    const f = fixture([issue('1', 'blocked', 1), issue('2', 'pending', 2)], [request]);
    const calls: string[] = [];
    const scheduler = new IssueScheduler({
      store: f.store, policy: f.policy, canSchedule: () => true,
      applyUnblock: async (id, guidance, actor) => {
        calls.push(`resume:${id}:${guidance}:${actor}`);
        return { ok: true, from: 'blocked', to: 'implementing' };
      },
      startIssue: async (id) => { calls.push(`start:${id}`); return { ok: true, from: 'pending', to: 'planning' }; },
      mergeModule: async () => [], scheduleClarify: () => {},
    });
    await scheduler.scheduleNext(7, { source: 'manual' });
    expect(calls).toEqual(['resume:1:continue:8']);
    expect(f.events).toEqual([{ id: '1', kind: 'unblock_request_consumed', data: { source: 'manual', requestedTs: 42 } }]);
  });

  test('a failed resume remains pending and a normal scheduling deferral is not logged as an error', async () => {
    const request = { issueId: '1', guidance: 'continue', actor: null, ts: 42 } as PendingUnblockRequest;
    const f = fixture([issue('1', 'blocked', 1), issue('2', 'pending', 2)], [request]);
    const scheduler = new IssueScheduler({
      store: f.store, policy: f.policy, canSchedule: () => true,
      applyUnblock: async () => ({ ok: false, error: 'resume fault' }),
      startIssue: async () => ({ ok: false, error: 'busy', deferral: 'project-busy' }),
      mergeModule: async () => [], scheduleClarify: () => {},
    });
    await scheduler.scheduleNext(7);
    expect(f.events.map(e => [e.id, e.kind, e.data?.reason])).toEqual([
      ['1', 'scheduling_deferred', 'unblock-failed'],
      ['2', 'scheduling_deferred', 'project-busy'],
    ]);
  });
});

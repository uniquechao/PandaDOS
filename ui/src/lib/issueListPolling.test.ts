import { describe, expect, test } from 'bun:test';
import { createIssueListPolling, type IssueListState } from './issueListPolling';
import type { IssueListPage } from '../../../shared/issue-list';
const page: IssueListPage = { items: [], total: 0, page: 1, pageSize: 20 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('issue list single flight polling', () => {
  test('coalesces retries while a request is running and retains data on failed refresh', async () => {
    const pending = deferred<IssueListPage>();
    const states: IssueListState[] = [];
    let calls = 0;
    const poll = createIssueListPolling({
      read: () => { calls++; return pending.promise; }, onState: s => states.push(s), intervalMs: 60000,
    });
    try {
      const first = poll.refresh();
      expect(poll.refresh()).toBe(first);
      await Promise.resolve();
      expect(calls).toBe(1);
      pending.resolve(page);
      await first;
      expect(states.at(-1)).toMatchObject({ data: page, busy: false, error: null });
    } finally { poll.stop(); }
    let readCount = 0;
    const refresh = createIssueListPolling({
      read: async () => { if (readCount++ === 1) throw new Error('body failed'); return page; },
      onState: s => states.push(s), intervalMs: 60000,
    });
    try {
      await refresh.refresh();
      await refresh.refresh();
      expect(states.at(-1)).toMatchObject({ data: page, busy: false, error: 'body failed' });
      await refresh.refresh();
      expect(states.at(-1)).toMatchObject({ data: page, busy: false, error: null });
    } finally { refresh.stop(); }
  });

  test('timeout aborts the request and exits loading even when the reader never resolves', async () => {
    const states: IssueListState[] = [];
    let signal!: AbortSignal;
    const poll = createIssueListPolling({
      read: s => { signal = s; return new Promise(() => {}); }, onState: s => states.push(s),
      timeoutMs: 10, intervalMs: 60000,
    });
    try {
      await poll.refresh();
      expect(signal.aborted).toBe(true);
      expect(states.at(-1)).toMatchObject({ data: null, busy: false, error: 'TimeoutError' });
    } finally { poll.stop(); }
  });

  test('stopped and superseded requests cannot publish late results', async () => {
    const pending = deferred<IssueListPage>();
    const states: IssueListState[] = [];
    const poll = createIssueListPolling({ read: () => pending.promise, onState: s => states.push(s) });
    const result = poll.refresh();
    await Promise.resolve();
    poll.stop();
    const before = states.length;
    pending.resolve(page);
    await result;
    expect(states).toHaveLength(before);
  });

  test('hidden pages do not issue requests; visibility resume can refresh immediately', async () => {
    let visible = false;
    let calls = 0;
    const poll = createIssueListPolling({ read: async () => { calls++; return page; },
      onState: () => {}, visible: () => visible, intervalMs: 60000 });
    try {
      await poll.refresh(); expect(calls).toBe(0);
      visible = true;
      await poll.refresh(); expect(calls).toBe(1);
    } finally { poll.stop(); }
  });

  test('invalid or null success payload becomes a retryable failure, never an empty loading state', async () => {
    const states: IssueListState[] = [];
    const poll = createIssueListPolling({ read: async () => null as unknown as IssueListPage,
      onState: s => states.push(s), intervalMs: 60000 });
    try {
      await poll.refresh();
      expect(states.at(-1)).toMatchObject({ busy: false, error: 'InvalidIssueListResponse' });
    } finally { poll.stop(); }
  });
});

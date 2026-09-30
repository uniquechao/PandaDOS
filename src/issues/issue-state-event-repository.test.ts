import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { IssueStore } from './engine';
import { IssueStateEventRepository } from './issue-state-event-repository';

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE issues (
    id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, status TEXT NOT NULL, done_ts INTEGER,
    branch TEXT, note TEXT, plan_json TEXT, subtasks_json TEXT, sub_index INTEGER DEFAULT 0,
    result_summary TEXT, completion_report_json TEXT
  );`);
  db.exec('CREATE TABLE issue_events (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, kind TEXT NOT NULL, data_json TEXT, ts INTEGER NOT NULL);');
  db.run("INSERT INTO issues (id, project_id, status) VALUES ('a', 7, 'pending'), ('b', 7, 'pending')");
  return { db, repo: new IssueStateEventRepository(db), store: new IssueStore(db) };
}

describe('IssueStateEventRepository persistence boundary', () => {
  test('store compatibility delegates timeline and state to the same SQLite transaction', () => {
    const { db, store } = setup();
    expect(() => db.transaction(() => {
      expect(store.casStatus('a', 'pending', 'done')).toBe(true);
      store.logEvent('a', 'transition', { to: 'done' });
      throw new Error('fault after event');
    })()).toThrow('fault');
    expect(db.query<{ status: string; done_ts: number | null }, []>("SELECT status, done_ts FROM issues WHERE id = 'a'").get()).toEqual({ status: 'pending', done_ts: null });
    expect(store.listEvents('a')).toEqual([]);

    db.transaction(() => {
      expect(store.casStatus('a', 'pending', 'done')).toBe(true);
      store.logEvent('a', 'transition', { to: 'done' });
    })();
    expect(store.casStatus('a', 'pending', 'cancelled')).toBe(false);
    expect(db.query<{ status: string; done_ts: number | null }, []>("SELECT status, done_ts FROM issues WHERE id = 'a'").get()?.done_ts).toBeGreaterThan(0);
    expect(store.listEvents('a').map(e => e.kind)).toEqual(['transition']);
    db.close();
  });

  test('event ordering and project-scoped queries preserve the public IssueStore contract', () => {
    const { db, repo, store } = setup();
    store.logEvent('a', 'judged', { result: 'done' });
    const anchor = store.lastEventId('a', 'judged');
    store.logEvent('b', 'judged', { result: 'not_done' });
    store.logEvent('a', 'judged', { result: 'done' });
    expect(store.countEvents('a', 'judged')).toBe(2);
    expect(store.countEventsSince('a', 'judged', anchor)).toBe(1);
    expect(repo.recentEvents('a', 'judged').map(e => e.id)).toEqual(store.listEvents('a').map(e => e.id).reverse());
    expect(store.listProjectEvents(7, 'judged').length).toBe(3);
    expect(store.lastProjectEvent(7, 'judged')?.issueId).toBe('a');
    db.close();
  });

  test('run-state reset clears only transient state', () => {
    const { db, store } = setup();
    db.run("UPDATE issues SET branch = 'work', note = 'old', plan_json = '[]', completion_report_json = '{}', done_ts = 123 WHERE id = 'a'");
    store.clearRunState('a');
    const row = db.query<{ branch: string; note: string | null; plan_json: string | null; completion_report_json: string | null; done_ts: number | null }, []>("SELECT branch, note, plan_json, completion_report_json, done_ts FROM issues WHERE id = 'a'").get();
    expect(row).toEqual({ branch: 'work', note: null, plan_json: null, completion_report_json: null, done_ts: null });
    db.close();
  });
});

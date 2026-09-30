import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { EngineIssue } from './engine';
import { IssueTransitionRepository, type TransitionStorePort } from './transition-repository';

function setup() {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE issues (id TEXT PRIMARY KEY, status TEXT, done_ts INTEGER, execution_mode TEXT, completion_report_json TEXT);");
  db.exec("CREATE TABLE issue_events (issue_id TEXT, kind TEXT, data_json TEXT);");
  db.run("INSERT INTO issues (id, status, execution_mode) VALUES ('1', 'pending', 'direct')");
  const store: TransitionStorePort = {
    casStatus(id, from, to) {
      return db.query('UPDATE issues SET status = ? WHERE id = ? AND status = ?').run(to, id, from).changes > 0;
    },
    logEvent(id, kind, data) {
      db.run('INSERT INTO issue_events VALUES (?, ?, ?)', [id, kind, JSON.stringify(data)]);
    },
    setCompletionReport(id) {
      db.run('UPDATE issues SET completion_report_json = NULL WHERE id = ?', [id]);
    },
  };
  const repository = new IssueTransitionRepository(db, store);
  const fresh = { id: '1', status: 'pending', executionMode: 'direct', completionReport: null } as EngineIssue;
  return { db, repository, fresh };
}

describe('IssueTransitionRepository', () => {
  test('CAS, transition and execution route commit together', () => {
    const { db, repository, fresh } = setup();
    expect(repository.commit({ issueId: '1', from: 'pending', to: 'implementing', event: 'start_direct', options: {}, fresh, workflowStatus: () => null })).toBe(true);
    expect(db.query<{ status: string; execution_mode: string }, []>('SELECT status, execution_mode FROM issues').get()).toEqual({ status: 'implementing', execution_mode: 'direct' });
    expect(db.query<{ kind: string }, []>('SELECT kind FROM issue_events ORDER BY rowid').all().map(r => r.kind)).toEqual(['transition', 'execution_route']);
    db.close();
  });

  test('a failed finalizer rolls back status, event and route', () => {
    const { db, repository, fresh } = setup();
    expect(() => repository.commit({
      issueId: '1', from: 'pending', to: 'planning', event: 'skip_clarifying', options: {}, fresh,
      workflowStatus: () => null, finalize: () => { throw new Error('fault'); },
    })).toThrow('fault');
    expect(db.query<{ status: string; execution_mode: string }, []>('SELECT status, execution_mode FROM issues').get()).toEqual({ status: 'pending', execution_mode: 'direct' });
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM issue_events').get()?.n).toBe(0);
    db.close();
  });

  test('stale CAS emits no event or finalizer effect', () => {
    const { db, repository, fresh } = setup();
    let finalized = false;
    expect(repository.commit({ issueId: '1', from: 'planning', to: 'implementing', event: 'plan_approved', options: {}, fresh, workflowStatus: () => null, finalize: () => { finalized = true; } })).toBe(false);
    expect(finalized).toBe(false);
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM issue_events').get()?.n).toBe(0);
    db.close();
  });

  test('rejects async finalizers and rolls back thenable-returning finalizers', () => {
    const { db, repository, fresh } = setup();
    let started = false;
    expect(() => repository.commit({
      issueId: '1', from: 'pending', to: 'planning', event: 'skip_clarifying', options: {}, fresh,
      workflowStatus: () => null, finalizeDb: (async () => { started = true; }) as () => void,
    })).toThrow('must be synchronous');
    expect(started).toBe(false);
    expect(() => repository.commit({
      issueId: '1', from: 'pending', to: 'planning', event: 'skip_clarifying', options: {}, fresh,
      workflowStatus: () => null, finalize: (() => Promise.resolve()) as () => void,
    })).toThrow('must be synchronous');
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()?.status).toBe('pending');
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM issue_events').get()?.n).toBe(0);
    db.close();
  });
});

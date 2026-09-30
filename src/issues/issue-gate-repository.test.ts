import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { IssueStore } from './engine';

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE gates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, kind TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'waiting', payload_json TEXT,
    decided_by INTEGER, decided_ts INTEGER
  );`);
  return { db, store: new IssueStore(db) };
}

describe('IssueStore gate repository delegation', () => {
  test('only one competing decision wins; payload note and audit fields persist', () => {
    const { db, store } = setup();
    const gate = store.createGate('a', 'plan', { stage: 'planning' });
    expect(store.decideGate(gate.id, 'approved', 4, 'ship')).toBe(true);
    expect(store.decideGate(gate.id, 'rejected', 5, 'late')).toBe(false);
    const decided = store.getGate(gate.id)!;
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toBe(4);
    expect(JSON.parse(decided.payloadJson ?? '{}')).toEqual({ stage: 'planning', decisionNote: 'ship' });
    db.close();
  });

  test('closing an issue rejects only its waiting gates', () => {
    const { db, store } = setup();
    const a = store.createGate('a', 'plan', {});
    const b = store.createGate('b', 'plan', {});
    store.expireWaitingGates('a');
    expect(store.getGate(a.id)?.status).toBe('rejected');
    expect(store.getGate(b.id)?.status).toBe('waiting');
    db.close();
  });
});

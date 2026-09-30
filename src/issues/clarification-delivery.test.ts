import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { IssueStore, migrateIssueEngine, type ApplyResult } from './engine';
import { ClarificationDelivery } from './clarification-delivery';

function fixture() {
  const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','unused','admin',0)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
  const store = new IssueStore(db);
  const issue = store.create(1, { title: 'Clarify', body: 'Write a document', category: 'task' });
  store.logEvent(issue.id, 'clarify_questions', { questions: ['Which audience?'] });
  const questionId = store.listEvents(issue.id).at(-1)!.id;
  const input = { questionId, requestKey: 'room:a:key', actorUserId: 1 };
  const delivery = new ClarificationDelivery(db);
  return { db, store, issue, input, delivery };
}

describe('question-bound clarification delivery', () => {
  test('accepted delivery is durable, repeated keys do not inject again, changed content conflicts', async () => {
    const c = fixture();
    try {
      let calls = 0;
      const perform = async (guard: () => void, deliveryKey?: string): Promise<ApplyResult> => {
        guard(); calls++; c.store.logEvent(c.issue.id, 'clarified', { answer: 'Students', deliveryKey });
        return { ok: true, from: 'pending', to: 'pending' };
      };
      expect((await c.delivery.run(c.issue.id, 'Students', c.input, perform)).ok).toBe(true);
      expect((await new ClarificationDelivery(c.db).run(c.issue.id, 'Students', c.input, perform)).ok).toBe(true);
      expect(await c.delivery.run(c.issue.id, 'Experts', c.input, perform)).toMatchObject({ ok: false, error: 'clarification_request_conflict' });
      expect(calls).toBe(1);
    } finally { c.db.close(); }
  });
  test('an unknown transport result cannot be retried by another room or a restarted process', async () => {
    const c = fixture();
    try {
      let calls = 0;
      const perform = async () => { calls++; throw new Error('private transport content'); };
      expect(await c.delivery.run(c.issue.id, 'Students', c.input, perform)).toMatchObject({ error: 'clarification_delivery_uncertain' });
      expect(await new ClarificationDelivery(c.db).run(c.issue.id, 'Students', c.input, perform)).toMatchObject({ error: 'clarification_delivery_uncertain' });
      expect(await new ClarificationDelivery(c.db).run(c.issue.id, 'Experts', { ...c.input, requestKey: 'room:b:key' }, perform)).toMatchObject({ error: 'clarification_delivery_uncertain' });
      expect(await new ClarificationDelivery(c.db).run(c.issue.id, 'Experts', undefined, perform)).toMatchObject({ error: 'clarification_delivery_uncertain' });
      expect(calls).toBe(1);
      expect(JSON.stringify(c.store.listEvents(c.issue.id))).not.toContain('private transport content');
    } finally { c.db.close(); }
  });
  test('a newer question or lost authorization prevents actual delivery after async work', async () => {
    const c = fixture();
    try {
      let calls = 0;
      const result = await c.delivery.run(c.issue.id, 'Students', c.input, async guard => {
        c.store.logEvent(c.issue.id, 'clarify_questions', { questions: ['Which language?'] });
        await Promise.resolve(); guard(); calls++;
        return { ok: true, from: 'pending', to: 'pending' };
      });
      expect(result).toMatchObject({ ok: false, error: 'clarification_question_changed' });
      expect(calls).toBe(0);
    } finally { c.db.close(); }
  });
  test('a confirmed issue event reconciles a crash before the acknowledgement receipt', async () => {
    const c = fixture();
    try {
      await c.delivery.run(c.issue.id, 'Students', c.input, async (_guard, deliveryKey) => {
        c.store.logEvent(c.issue.id, 'clarified', { deliveryKey });
        throw new Error('crash after delivery confirmation');
      });
      let resent = false;
      expect((await new ClarificationDelivery(c.db).run(c.issue.id, 'Students', c.input, async () => { resent = true; return { ok: true, from: 'pending', to: 'pending' }; })).ok).toBe(true);
      expect(resent).toBe(false);
    } finally { c.db.close(); }
  });
  test('revoked authorization records non-delivery so a later authorized request can proceed', async () => {
    const c = fixture();
    try {
      let allowed = true;
      let calls = 0;
      const forbidden = new Error('forbidden');
      await expect(c.delivery.run(c.issue.id, 'Students', { ...c.input, authorize() { if (!allowed) throw forbidden; } }, async guard => {
        allowed = false; await Promise.resolve(); guard(); calls++;
        return { ok: true, from: 'pending', to: 'pending' };
      })).rejects.toBe(forbidden);
      expect(c.store.listEvents(c.issue.id).at(-1)?.kind).toBe('clarification_delivery_rejected');
      expect((await c.delivery.run(c.issue.id, 'Students', { ...c.input, requestKey: 'other-authorized' }, async guard => {
        guard(); calls++; return { ok: true, from: 'pending', to: 'pending' };
      })).ok).toBe(true);
      expect(calls).toBe(1);
    } finally { c.db.close(); }
  });
  test('close waits for actual delivery settlement and blocks new delivery and premature reopen', async () => {
    const c = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      let sent = false;
      const flight = c.delivery.run(c.issue.id, 'Students', c.input, async guard => {
        await gate; guard(); sent = true; return { ok: true, from: 'pending', to: 'pending' };
      });
      let closed = false;
      const drain = c.delivery.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(c.delivery.reopen()).toBe(false);
      expect(await c.delivery.run(c.issue.id, 'Students', undefined, async () => { throw new Error('must not run'); })).toMatchObject({ error: 'clarification_delivery_stopped' });
      release();
      expect(await flight).toMatchObject({ error: 'clarification_not_delivered' });
      await drain;
      expect(sent).toBe(false);
      expect(c.delivery.reopen()).toBe(true);
    } finally { release(); c.db.close(); }
  });
});

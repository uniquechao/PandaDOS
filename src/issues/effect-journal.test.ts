import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { InputSubmitUnconfirmedError } from '../executor/driver';
import { migrateIssueEngine } from './engine';
import { IssueEffectJournal } from './effect-journal';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  db.run("INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'owner', 'x', 'admin', 1)");
  db.run("INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir) VALUES (1, 'local', '127.0.0.1', 22, 'runner', '', '/work', '/home/runner/.claude/projects')");
  db.run("INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (1, 'demo', 1, '/work/app', 1, 1)");
  const issueId = db.query<{ id: string }, []>("INSERT INTO issues (project_id, title, created_ts) VALUES (1, 'task', 1) RETURNING id").get()!.id;
  return { db, issueId, journal: new IssueEffectJournal(db, () => 100) };
}

describe('Issue durable effect journal', () => {
  test('successful prompt is acknowledged once and never sent again after recovery', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'kickoff:9', projectId: 1, executorId: 1, target: 'cc-1', input: 'implement' };
    let calls = 0;
    expect(await s.journal.runOnce(input, async () => { calls++; })).toBe('performed');
    expect(await new IssueEffectJournal(s.db).runOnce(input, async () => { calls++; })).toBe('confirmed');
    expect(calls).toBe(1);
    s.db.close();
  });

  test('crash after claim leaves an uncertain action and never blindly resends', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'kickoff:10', projectId: 1, executorId: 1, target: 'cc-1', input: 'implement' };
    const digest = createHash('sha256').update(input.input).digest('hex');
    s.db.query(
      `INSERT INTO issue_effect_journal
       (issue_id, operation_key, project_id, executor_id, target, input_sha256, status, created_ts, updated_ts)
       VALUES (?, ?, 1, 1, 'cc-1', ?, 'running', 1, 1)`,
    ).run(input.issueId, input.operationKey, digest);
    let calls = 0;
    await expect(s.journal.runOnce(input, async () => { calls++; })).rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    expect(calls).toBe(0);
    expect(s.db.query<{ status: string }, []>('SELECT status FROM issue_effect_journal').get()?.status).toBe('uncertain');
    s.db.close();
  });

  test('a failed send and an executor-identity mismatch both remain fail-closed', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'kickoff:11', projectId: 1, executorId: 1, target: 'cc-1', input: 'implement' };
    await expect(s.journal.runOnce(input, async () => { throw new Error('transport lost after write'); }))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    await expect(s.journal.runOnce(input, async () => { throw new Error('must not run'); }))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    await expect(s.journal.runOnce({ ...input, executorId: 2 }, async () => { throw new Error('must not run'); }))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    expect(s.db.query<{ status: string; error: string }, []>('SELECT status, error FROM issue_effect_journal').get())
      .toMatchObject({ status: 'uncertain', error: 'Error: transport lost after write' });
    s.db.close();
  });

  test('startup turns an unacknowledged claim into a visible uncertain action', () => {
    const s = setup();
    s.db.query(
      `INSERT INTO issue_effect_journal
       (issue_id, operation_key, project_id, executor_id, target, input_sha256, status, created_ts, updated_ts)
       VALUES (?, 'nudge:1:1', 1, 1, 'cc-1', 'digest', 'running', 1, 1)`,
    ).run(s.issueId);
    expect(s.journal.reconcileInterrupted()).toEqual([{ issueId: s.issueId, operationKey: 'nudge:1:1' }]);
    expect(s.journal.reconcileInterrupted()).toEqual([]);
    expect(s.journal.hasUncertainInput(s.issueId)).toBe(true);
    expect(s.journal.statusOf(s.issueId, 'nudge:1:1')).toBe('uncertain');
    s.db.close();
  });

  test('delivery succeeded but receipt was lost: reconcile proves result without re-executing', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'git-push:20', projectId: 1, executorId: 1,
      target: 'git:/work/app:origin', input: 'push\0origin\0HEAD' };
    let deliveries = 0;
    await expect(s.journal.runOnce(input, async () => {
      deliveries++;
      throw new Error('transport timed out after delivery');
    })).rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    expect(s.journal.statusOf(s.issueId, input.operationKey)).toBe('uncertain');
    expect(await new IssueEffectJournal(s.db).runOnce(input, async () => { deliveries++; }, async () => 'confirmed'))
      .toBe('confirmed');
    expect(deliveries).toBe(1);
    expect(s.journal.statusOf(s.issueId, input.operationKey)).toBe('confirmed');
    s.db.close();
  });

  test('an unprovable delivery stays uncertain and is never blindly resent', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'notify:42', projectId: 1, executorId: 1,
      target: 'notify:issue_done', input: '{"kind":"issue_done"}' };
    let deliveries = 0;
    await expect(s.journal.runOnce(input, async () => { deliveries++; throw new Error('lost receipt'); }))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    await expect(new IssueEffectJournal(s.db).runOnce(input, async () => { deliveries++; }, async () => 'unknown'))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    expect(deliveries).toBe(1);
    expect(s.journal.hasUncertainInput(s.issueId)).toBe(false);
    s.db.close();
  });

  test('a queryable action may retry only after an explicit absence proof', async () => {
    const s = setup();
    const input = { issueId: s.issueId, operationKey: 'git-commit:22', projectId: 1, executorId: 1,
      target: 'git:/work/app#tree=abc', input: 'commit marker' };
    let calls = 0;
    await expect(s.journal.runOnce(input, async () => { calls++; throw new Error('unknown commit outcome'); }))
      .rejects.toBeInstanceOf(InputSubmitUnconfirmedError);
    expect(await s.journal.runOnce(input, async () => { calls++; }, async () => 'absent')).toBe('performed');
    expect(calls).toBe(2);
    expect(s.journal.statusOf(s.issueId, input.operationKey)).toBe('confirmed');
    s.db.close();
  });
});

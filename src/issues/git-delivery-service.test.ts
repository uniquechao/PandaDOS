import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import type { Project } from '../core/types';
import type { ExecutorDriver, GitResult } from '../executor/driver';
import type { EngineExecutionWorkspace, EngineIssue, IssueStore } from './engine';
import { IssueEffectJournal } from './effect-journal';
import { GitDeliveryService } from './git-delivery-service';

const tree = 'a'.repeat(40);
const head = 'b'.repeat(40);
const otherHead = 'c'.repeat(40);
const marker = 'PandaDOS-Effect: issue-1/9';
const ok = (out = ''): GitResult => ({ code: 0, out, err: '' });

function setup() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE issue_effect_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id TEXT NOT NULL, operation_key TEXT NOT NULL,
    project_id INTEGER NOT NULL, executor_id INTEGER NOT NULL, target TEXT NOT NULL,
    input_sha256 TEXT NOT NULL, status TEXT NOT NULL, error TEXT,
    created_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
    UNIQUE(issue_id, operation_key)
  );`);
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const calls: string[][] = [];
  let staged = true;
  let committed = false;
  let remote = false;
  let upstream = false;
  let remoteHead = '';
  let commitTree = tree;
  let currentHead = head;
  let losePushReceipt = false;
  const driver = {
    git: async (_cwd: string, args: string[]) => {
      calls.push(args);
      const [command] = args;
      if (command === 'add') return ok();
      if (command === 'diff') return staged ? { code: 1, out: '', err: '' } : ok();
      if (command === 'write-tree') return ok(`${tree}\n`);
      if (command === 'commit') { staged = false; committed = true; return ok(); }
      if (command === 'log') return ok(committed ? `${head}\n` : '');
      if (command === 'show') return ok(`issue delivery\n\n${marker}\n`);
      if (command === 'rev-parse' && args[1] === `${head}^{tree}`) return ok(`${commitTree}\n`);
      if (command === 'rev-parse' && args[1] === 'HEAD') return ok(`${currentHead}\n`);
      if (command === 'rev-parse' && args[1] === '--symbolic-full-name') {
        return upstream ? ok('refs/remotes/origin/main\n') : { code: 128, out: '', err: 'no upstream' };
      }
      if (command === 'symbolic-ref') return ok('main\n');
      if (command === 'remote') return remote ? ok('origin.git\n') : { code: 2, out: '', err: 'no remote' };
      if (command === 'push') {
        upstream = true;
        remoteHead = head;
        if (losePushReceipt) { losePushReceipt = false; throw new Error('push receipt lost'); }
        return ok();
      }
      if (command === 'ls-remote') return ok(`${remoteHead}\trefs/heads/main\n`);
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
  } as ExecutorDriver;
  const store = {
    lastEnterEventId: () => 9,
    logEvent: (_id: string, kind: string, data: Record<string, unknown>) => { events.push({ kind, data }); },
  } as unknown as Pick<IssueStore, 'lastEnterEventId' | 'logEvent'>;
  const journal = new IssueEffectJournal(db);
  const service = new GitDeliveryService({ store, journal, driverForProject: () => driver, ownerUsername: () => null });
  const project = { id: 7, executorId: 3 } as Project;
  const issue = { id: 'issue-1', projectId: 7, title: 'issue delivery', branch: 'main' } as EngineIssue;
  const workspace = { cwd: '/work', kind: 'project', branch: null, runId: null } as EngineExecutionWorkspace;
  const count = (command: string) => calls.filter(args => args[0] === command).length;
  const status = (key: string) => db.query<{ status: string; target: string; input_sha256: string }, [string]>(
    'SELECT status, target, input_sha256 FROM issue_effect_journal WHERE operation_key = ?',
  ).get(key);
  return {
    db, service, project, issue, workspace, events, calls, count, status,
    setRemote: (value: boolean) => { remote = value; },
    losePush: () => { losePushReceipt = true; },
    setRemoteHead: (value: string) => { remoteHead = value; },
    setCommitTree: (value: string) => { commitTree = value; },
    setHead: (value: string) => { currentHead = value; },
  };
}

describe('GitDeliveryService durable delivery', () => {
  test('lost commit receipt reconciles exact marker and tree after HEAD moves; never repeats commit', async () => {
    const f = setup();
    f.db.exec(`CREATE TRIGGER lose_commit_receipt BEFORE UPDATE ON issue_effect_journal
      WHEN NEW.operation_key = 'git-commit:9' AND NEW.status = 'confirmed'
      BEGIN SELECT RAISE(ABORT, 'receipt lost'); END`);
    expect((await f.service.deliverLocked(f.project, f.issue, f.workspace))?.where).toBe('auto_commit');
    expect(f.status('git-commit:9')?.status).toBe('uncertain');
    expect(f.status('git-commit:9')?.target).toBe(`git:/work#tree=${tree}`);
    f.db.exec('DROP TRIGGER lose_commit_receipt');
    f.setHead(otherHead);
    expect(await f.service.deliverLocked(f.project, f.issue, f.workspace)).toBeNull();
    expect(f.count('commit')).toBe(1);
    expect(f.status('git-commit:9')?.status).toBe('confirmed');
    expect(f.events.some(event => event.kind === 'push_skipped')).toBe(true);
    f.db.close();
  });

  test('matching marker with mismatched tree remains uncertain and cannot commit again', async () => {
    const f = setup();
    f.db.exec(`CREATE TRIGGER lose_commit_receipt BEFORE UPDATE ON issue_effect_journal
      WHEN NEW.operation_key = 'git-commit:9' AND NEW.status = 'confirmed'
      BEGIN SELECT RAISE(ABORT, 'receipt lost'); END`);
    await f.service.deliverLocked(f.project, f.issue, f.workspace);
    f.db.exec('DROP TRIGGER lose_commit_receipt');
    f.setCommitTree(otherHead);
    expect((await f.service.deliverLocked(f.project, f.issue, f.workspace))?.where).toBe('auto_commit');
    expect(f.status('git-commit:9')?.status).toBe('uncertain');
    expect(f.count('commit')).toBe(1);
    f.db.close();
  });

  test('push receipt loss is visible yet locally complete; upstream drift does not change journal input or resend', async () => {
    const f = setup();
    f.setRemote(true);
    f.losePush();
    expect((await f.service.deliverLocked(f.project, f.issue, { ...f.workspace, kind: 'design-worktree' }))?.where).toBe('auto_push');
    expect(f.events.some(event => event.kind === 'auto_push_failed')).toBe(true);
    expect(f.status('git-commit:9')?.status).toBe('confirmed');
    expect(f.status('git-push:9')?.status).toBe('uncertain');
    expect(f.status('git-push:9')?.input_sha256).toBe(createHash('sha256').update('push origin HEAD').digest('hex'));
    const before = f.count('push');
    expect(await f.service.deliverLocked(f.project, f.issue, { ...f.workspace, kind: 'design-worktree' })).toBeNull();
    expect(f.count('push')).toBe(before);
    expect(f.status('git-push:9')?.status).toBe('confirmed');
    f.db.close();
  });

  test('push timeout with unmatched remote ref remains uncertain and is never blindly retried', async () => {
    const f = setup();
    f.setRemote(true);
    f.losePush();
    await f.service.deliverLocked(f.project, f.issue, f.workspace);
    f.setRemoteHead(otherHead);
    const before = f.count('push');
    expect((await f.service.deliverLocked(f.project, f.issue, f.workspace))?.where).toBe('auto_push');
    expect(f.count('push')).toBe(before);
    expect(f.status('git-push:9')?.status).toBe('uncertain');
    f.db.close();
  });
});

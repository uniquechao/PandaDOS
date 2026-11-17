import { expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import type { IssueId } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { getProject, IssueStore, migrateIssueEngine, type IssueEngine } from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import { ModuleWorkspaceService } from '../issues/module-workspaces';
import { IssueWorktreeService } from './issue-worktree';

function fixture() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'owner','owner','user',1),(2,'member','member','user',1)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','localhost','test','','/work','/claude')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts,integration_branch) VALUES(1,'test',1,'/repo',1,1,'develop')");
  const store = new IssueStore(db);
  const issue = store.create(1, { title: 'Merge guidance', agent: 'codex' });
  db.run("UPDATE issues SET status='merging', workspace_mode='module' WHERE id=?", [issue.id]);
  db.run("INSERT INTO module_workspaces(id,project_id,module_key,executor_id,cwd,branch,current_attempt,created_ts,updated_ts) VALUES(1,1,0,1,'/work/module','module','attempt',1,1)");
  db.run("INSERT INTO workspace_attempts(id,workspace_id,issue_id,agent,result_sha,stop_confirmed,created_ts,updated_ts) VALUES('attempt',1,?,'codex','source',1,1,1)", [issue.id]);
  db.run("INSERT INTO workspace_integrations(id,attempt_id,target_sha,result_sha,cwd,phase,created_ts,updated_ts) VALUES('candidate','attempt','base','source','/work/candidate','conflict',1,1)");
  db.run("INSERT INTO workspace_merge_agents(id,integration_id,attempt_id,project_id,conversation_id,state,reason,remaining,started_ts,updated_ts,agent,launch_started) VALUES('repair','candidate','attempt',1,'session','running','conflict',2,1,1,'claude',1)");
  const driver = {} as ExecutorDriver;
  const mutex = new KeyedMutex();
  const workspace = new ModuleWorkspaceService({
    db, mutex, driverForProject: () => driver, legacy: {} as never, conversations: {} as never,
  });
  const calls: string[] = [];
  let blockStop = true;
  const confirmFullStop = async () => {
    calls.push('stop');
    if (blockStop) throw new Error('stop unconfirmed');
    db.run("UPDATE workspace_merge_agents SET stop_confirmed=1,state='superseded' WHERE id='repair'");
    db.run("UPDATE workspace_attempts SET stop_confirmed=1 WHERE id='attempt'");
  };
  const engine = {
    store,
    incidentWorkspace: (id: IssueId) => workspace.attempt(id),
    incidentHeld: () => Boolean(db.query("SELECT 1 FROM issue_incidents WHERE state='open'").get()),
    pauseWorktreeIntegration: async (id: IssueId) => {
      db.run("UPDATE issues SET status='paused' WHERE id=? AND status='merging'", [id]);
      return { ok: true, from: 'merging', to: 'paused' } as const;
    },
    confirmWorktreeStopped: confirmFullStop,
    openIncident: async (id: IssueId, _actor: number, _locale: string, _attempt: string, onOpened: (id: string) => void) => {
      await confirmFullStop();
      calls.push('open');
      db.run("INSERT INTO issue_incidents(id,issue_id,project_id,stop_event_id,attempt_id,locale,created_ts) VALUES('incident',?,1,1,'attempt','en',1)", [id]);
      onOpened('incident');
      return { id: 'incident' };
    },
  } as unknown as IssueEngine;
  const service = new IssueWorktreeService({
    db, engine, mutex, driverForProject: () => driver,
    historyForProject: () => ({ reader: driver, locator: { locate: async () => null } }),
    mergeAgent: {
      sendGuidance: async () => { calls.push('send'); },
    },
    incidents: {
      resolve: async () => {
        calls.push('return');
        db.run("UPDATE issue_incidents SET state='queued' WHERE id='incident'");
        return { ok: true, queued: true };
      },
    },
  });
  return { db, issue, service, calls, store, driver, workspace, confirmStop: () => { blockStop = false; } };
}

test('Worktree actions reject foreign issues and preserve ownership until physical stop is confirmed', async () => {
  const f = fixture();
  const id = f.issue.id;
  const owner = { id: 1, role: 'user' } as const;
  const member = { id: 2, role: 'user' } as const;
  try {
    await expect(f.service.view(2, id, owner)).rejects.toThrow('worktree.not_found');
    expect((await f.service.view(1, id, owner)).writer).toBe('merge-agent');
    expect((await f.service.view(1, id, owner)).mergeAgent?.agent).toBe('claude');
    expect((await f.service.view(1, id, member)).allowedActions).toEqual([]);
    await expect(f.service.action(1, id, member, 'attempt', 'unauthorized', 'takeover')).rejects.toThrow('worktree.forbidden');
    await expect(f.service.action(1, id, owner, 'old-attempt', 'stale', 'takeover')).rejects.toThrow('worktree.stale');
    f.db.run("UPDATE workspace_attempts SET result_sha=NULL WHERE id='attempt'");
    expect((await f.service.view(1, id, owner)).allowedActions).not.toContain('takeover');
    f.db.run("UPDATE workspace_attempts SET result_sha='source' WHERE id='attempt'");
    await expect(f.service.action(1, id, owner, 'attempt', 'take-1', 'takeover')).rejects.toThrow('stop unconfirmed');
    expect(f.calls).toEqual(['stop']);
    const held = await f.service.view(1, id, owner);
    expect(held.incidentId).toBeNull();
    expect(held.mergeAgent?.canSend).toBe(false);
    f.confirmStop();
    await f.service.action(1, id, owner, 'attempt', 'take-1', 'takeover');
    await f.service.action(1, id, owner, 'attempt', 'take-1', 'takeover');
    expect(f.calls).toEqual(['stop', 'stop', 'open']);
    expect((await f.service.view(1, id, owner)).writer).toBe('human');
    await f.service.action(1, id, owner, 'attempt', 'return-1', 'return');
    expect((await f.service.view(1, id, owner)).allowedActions).not.toContain('return');
    expect(f.calls.at(-1)).toBe('return');
  } finally { f.db.close(); }
});

test('an unknown push is checked against the remote and never blindly replayed', async () => {
  const f = fixture();
  const id = f.issue.id;
  const owner = { id: 1, role: 'user' } as const;
  const candidate = 'a'.repeat(40);
  let remote = 'b'.repeat(40);
  const calls: string[] = [];
  f.driver.git = async (_cwd, args) => {
    calls.push(args[0]!);
    if (args[0] === 'ls-remote') return { code: 0, out: remote + '\trefs/heads/develop\n', err: '' };
    return { code: 1, out: '', err: '' };
  };
  try {
    f.db.run("UPDATE issues SET status='done' WHERE id=?", [id]);
    f.db.run("UPDATE workspace_attempts SET released_ts=2,integrated_sha=? WHERE id='attempt'", [candidate]);
    f.store.logEvent(id, 'workspace_integrated', { sha: candidate });
    f.store.logEvent(id, 'auto_push_failed', { detail: 'timeout' });
    expect((await f.service.view(1, id, owner)).allowedActions).toEqual(['verify-push']);
    await expect(f.service.action(1, id, owner, 'attempt', 'verify-1', 'verify-push')).rejects.toThrow('worktree.operation_unconfirmed');
    remote = candidate;
    await f.service.action(1, id, owner, 'attempt', 'verify-1', 'verify-push');
    expect(calls).toEqual(['ls-remote', 'merge-base', 'ls-remote']);
    expect((await f.service.view(1, id, owner)).allowedActions).toEqual([]);
  } finally { f.db.close(); }
});

test('automatic push reentry reconciles its pending operation before issuing any further push', async () => {
  const f = fixture();
  const candidate = 'a'.repeat(40);
  const calls: string[] = [];
  f.driver.git = async (_cwd, args) => {
    calls.push(args[0]!);
    if (args[0] === 'push') throw new Error('remote response lost');
    if (args[0] === 'ls-remote') return { code: 0, out: candidate + '\trefs/heads/develop\n', err: '' };
    return { code: 0, out: '', err: '' };
  };
  try {
    f.db.run("UPDATE workspace_attempts SET integrated_sha=? WHERE id='attempt'", [candidate]);
    const project = getProject(f.db, 1)!;
    expect((await f.workspace.push(f.issue, project)).ok).toBe(false);
    expect((await f.workspace.push(f.issue, project)).ok).toBe(true);
    expect((await f.workspace.push(f.issue, project)).ok).toBe(true);
    expect(calls).toEqual(['remote', 'push', 'ls-remote']);
  } finally { f.db.close(); }
});

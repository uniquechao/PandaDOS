import { expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { getProject, IssueStore, migrateIssueEngine } from './engine';
import { ModuleMergeAgent } from './module-merge-agent';
import { IssueEffectJournal } from './effect-journal';
import { KeyedMutex } from './mutex';
import type { ExecutorDriver } from '../executor/driver';

test('merge guidance only reaches the active owned candidate and has one delivery receipt', async () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    migrateIssueEngine(db);
    db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'owner','x','admin',1)");
    db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','localhost','test','','/work','/claude')");
    db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'test',1,'/repo',1,1)");
    const issue = new IssueStore(db).create(1, { title: 'Merge guidance', agent: 'codex' });
    db.run("UPDATE issues SET status='merging', workspace_mode='module' WHERE id=?", [issue.id]);
    db.run("INSERT INTO module_workspaces(id,project_id,module_key,executor_id,cwd,branch,current_attempt,created_ts,updated_ts) VALUES(1,1,0,1,'/work/module','module','attempt',1,1)");
    db.run("INSERT INTO workspace_attempts(id,workspace_id,issue_id,agent,result_sha,created_ts,updated_ts) VALUES('attempt',1,?,'codex','source',1,1)", [issue.id]);
    db.run("INSERT INTO workspace_integrations(id,attempt_id,target_sha,result_sha,cwd,phase,created_ts,updated_ts) VALUES('candidate','attempt','base','source','/work/candidate','conflict',1,1)");
    db.run("INSERT INTO workspace_merge_agents(id,integration_id,attempt_id,project_id,conversation_id,state,reason,remaining,started_ts,updated_ts,agent,launch_started) VALUES('repair','candidate','attempt',1,'session','running','conflict',2,1,1,'codex',1)");
    const deliveries: string[] = [];
    const driver = {
      listSessions: async () => [{ name: 'cc-1-w-session', command: 'codex' }],
      capturePane: async () => '› ',
      statPath: async () => null,
      sendKeys: async (_session: string, text: string) => { deliveries.push(text); },
    } as unknown as ExecutorDriver;
    const merge = new ModuleMergeAgent({
      db, mutex: new KeyedMutex(), driverForProject: () => driver,
      projectForId: id => getProject(db, id), conversations: {} as never,
    });
    const command = { issueId: issue.id, projectId: 1, runId: 'repair', requestId: 'request', text: 'Keep the existing layout.', actor: 1 };
    await expect(merge.sendGuidance({...command, runId: 'stale'})).rejects.toThrow('worktree_stale');
    await merge.sendGuidance(command);
    await merge.sendGuidance(command);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toContain(command.text);
    expect(db.query("SELECT COUNT(*) AS n FROM issue_events WHERE kind='merge_agent_guidance'").get()).toEqual({n: 1});
    db.run("UPDATE issue_effect_journal SET status='running' WHERE issue_id=? AND operation_key='merge-chat:repair:request'", [issue.id]);
    const journal = new IssueEffectJournal(db);
    journal.reconcileInterrupted();
    expect(journal.hasUncertainInput(issue.id)).toBe(true);
    await expect(merge.sendGuidance({...command, requestId: 'new-after-crash'})).rejects.toThrow('worktree_operation_unconfirmed');
    db.run("UPDATE workspace_merge_agents SET stop_confirmed=1,state='superseded' WHERE id='repair'");
    expect(journal.hasUncertainInput(issue.id)).toBe(false);
    await expect(merge.sendGuidance({...command, requestId: 'late'})).rejects.toThrow('worktree_stale');
    expect(deliveries).toHaveLength(1);
  } finally {
    db.close();
  }
});

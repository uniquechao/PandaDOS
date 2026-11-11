import { test, expect } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { IssueStore, migrateIssueEngine } from './engine';
import { IssueIncidentStore } from './incidents';

export function incidentFixture() {
  const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','x','admin',0)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','local','test','','','')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
  const issues = new IssueStore(db); const issue = issues.create(1,{title:'Failure',category:'task'});
  db.query("UPDATE issues SET status='paused' WHERE id=?").run(issue.id);
  issues.logEvent(issue.id,'transition',{from:'testing',to:'paused',event:'pause',note:'Failure'});
  return {db,issues,issue:issues.get(issue.id)!,store:new IssueIncidentStore(db)};
}

test('incident opening is durable, stop-scoped and starts no duplicate first turn', () => {
  const {db,issues,issue,store} = incidentFixture();
  try {
    const event = issues.listEvents(issue.id).at(-1)!.id;
    const first = store.open(issue,event,null,1,'zh-Hans');
    expect(store.open(issue,event,null,1,'en').id).toBe(first.id);
    expect(new IssueIncidentStore(db).held(issue.id)).toBe(true);
    expect(store.messages(first.id)).toHaveLength(0);
    const turn = store.enqueue(first.id,'initial','分析原因',1);
    expect(store.enqueue(first.id,'initial','分析原因',1).id).toBe(turn.id);
    expect(() => store.enqueue(first.id,'initial','changed',1)).toThrow('incident_request_conflict');
    expect(store.messages(first.id)).toHaveLength(1);
    expect(store.claim(first.id)).not.toBeNull();
    expect(store.claim(first.id)).toBeNull();
    store.finish(first.id,turn.id,'已核实分支不同');
    expect(store.messages(first.id).at(-1)?.role).toBe('assistant');
    expect(store.held(issue.id)).toBe(true);
    expect(store.get(first.id)?.runState).toBe('idle');
  } finally { db.close(); }
});

test('interrupted diagnosis retains hold and never automatically replays a billed turn', () => {
  const {db,issues,issue,store} = incidentFixture();
  try {
    const incident = store.open(issue,issues.listEvents(issue.id).at(-1)!.id,null,1,'en');
    store.enqueue(incident.id,'initial','diagnose',1); store.claim(incident.id);
    store.interrupt();
    expect(store.get(incident.id)?.runState).toBe('interrupted');
    expect(store.claim(incident.id)).toBeNull();
    expect(store.held(issue.id)).toBe(true);
    store.enqueue(incident.id,'retry','Check again',1);
    expect(store.claim(incident.id)).not.toBeNull();
  } finally { db.close(); }
});

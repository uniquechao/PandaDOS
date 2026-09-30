import { expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { IssueStore, migrateIssueEngine } from '../issues/engine';
import { RoomEngine } from '../rooms/engine';
import { RoomStore } from '../rooms/store';
import { migrateRooms } from '../rooms/migrations';
import { RoomIssueFeedbackService } from './room-issue-feedback';

test('room issue feedback projects only formal facts, restores once, and binds answers to linked issues', async () => {
  const db = openDb(':memory:');
  try {
    migrate(db); migrateIssueEngine(db); migrateRooms(db);
    db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','unused','admin',0)");
    db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
    db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
    const rooms = new RoomEngine({ store: new RoomStore(db) });
    const meta = { actor: { userId: 1 }, key: 'create' };
    const room = rooms.create(1, { title: 'Feedback', request: 'Write prose', start: true }, meta);
    const scope = { projectId: 1, roomId: room.room.id };
    for (const result of [{ message: 'Plan', decision: 'continue' as const }, { message: 'Outline' }, { message: 'Draft', artifact: { title: 'Draft', markdown: 'Formal deliverable' } }]) {
      const attempt = rooms.claimNext('test')!; rooms.dispatched(attempt); rooms.accept(attempt, result);
    }
    const artifact = rooms.snapshot(scope).artifacts[0]!;
    const issues = new IssueStore(db);
    const issue = issues.create(1, { title: 'Execute', body: 'Execute this draft', category: 'task' });
    rooms.linkIssue(scope, { missionId: room.mission!.id, artifactId: artifact.id, artifactVersion: 1, issueId: issue.id, title: issue.title }, 'publication', 1);
    issues.logEvent(issue.id, 'transition', { from: 'pending', to: 'implementing', privateData: 'PRIVATE_REASONING' });
    issues.logEvent(issue.id, 'terminal', { text: 'PRIVATE_TOOL_OUTPUT' });
    issues.logEvent(issue.id, 'clarify_questions', { questions: ['Which audience?'], raw: 'PRIVATE_RAW' });
    const service = new RoomIssueFeedbackService(db, { clarify: async () => ({ ok: true, from: 'pending', to: 'pending' }) });
    service.sync(scope); const cursor = rooms.snapshot(scope).eventCursor;
    service.sync(scope); expect(rooms.snapshot(scope).eventCursor).toBe(cursor);
    const result = service.list(scope);
    expect(result[0]!.events.map(event => event.kind)).toEqual(['started', 'clarification_needed']);
    expect(result[0]!.question!.questions).toEqual(['Which audience?']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    const other = rooms.create(1, { title: 'Other', request: 'Other' }, { ...meta, key: 'other' });
    expect(service.list({ projectId: 1, roomId: other.room.id })).toEqual([]);
    await expect(service.answer({ projectId: 1, roomId: other.room.id }, issue.id, result[0]!.question!.id, 'Students', meta, () => {})).rejects.toThrow('not_found');
    const restarted = new RoomIssueFeedbackService(db, { clarify: async () => ({ ok: true, from: 'pending', to: 'pending' }) });
    restarted.sync(scope); expect(restarted.list(scope)).toEqual(result);
  } finally { db.close(); }
});

import { expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { ALL_MIGRATION_DIRS, assertNoMigrationCollisions, migrate } from '../core/migrate';
import { migrateRooms, ROOM_MIGRATIONS_DIR } from './migrations';
import { RoomStore } from './store';
import { RoomEngine } from './engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('081 upgrades a populated current database without changing issue/design data or foreign keys', () => {
  const db = openDb(':memory:');
  try {
    for (const dir of ALL_MIGRATION_DIRS) if (dir !== ROOM_MIGRATIONS_DIR) migrate(db, dir);
    db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','unused','admin',0)");
    db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
    db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
    db.run("INSERT INTO issues(id,project_id,title,created_ts) VALUES('20260926-preserve',1,'Existing issue',0)");
    const before = db.query('SELECT * FROM issues').all();
    const designsBefore = db.query('SELECT * FROM design_tasks').all();
    const directories = [...new Set([...ALL_MIGRATION_DIRS, ROOM_MIGRATIONS_DIR])];
    assertNoMigrationCollisions(db, directories);
    migrateRooms(db);
    migrateRooms(db);
    expect(db.query('SELECT * FROM issues').all()).toEqual(before);
    expect(db.query('SELECT * FROM design_tasks').all()).toEqual(designsBefore);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    const engine = new RoomEngine({ store: new RoomStore(db) });
    const a = engine.create(1, { title: 'A', request: 'A goal' }, { actor: { userId: 1 }, key: 'a' });
    const member = a.members[0]!;
    expect(() => db.run('DELETE FROM room_members WHERE id=?', [member.id])).toThrow('room_member_identity_retained');
    expect(() => db.run('UPDATE room_members SET project_id=2 WHERE id=?', [member.id])).toThrow('room_member_scope_immutable');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});

test('082 preserves an open legacy question and compacts old receipts through later room upgrades', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    db.exec(readFileSync(join(ROOM_MIGRATIONS_DIR, '081_room_collaboration.sql'), 'utf8'));
    db.run("INSERT INTO schema_migrations VALUES(81,'081_room_collaboration.sql',0)");
    db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'legacy','unused','admin',0)");
    db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
    db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
    db.run("INSERT INTO rooms(id,project_id,title,created_by,created_ts,updated_ts,event_seq) VALUES('r',1,'Room',1,0,0,1)");
    db.run("INSERT INTO room_members(id,project_id,room_id,role_key,display_name,created_ts) VALUES('c',1,'r','coach','coach',0)");
    // A real 081 room starts with the full default team. Keep the fixture valid
    // for later execution guards while exercising legacy question/receipt data.
    for (const role of ['planner', 'writer', 'reviewer']) db.run('INSERT INTO room_members(id,project_id,room_id,role_key,display_name,created_ts) VALUES(?,1,?,?,?,0)', [`legacy-${role}`, 'r', role, role]);
    const question = { id: 'q', text: 'Which direction?', options: ['Practical', 'Conceptual'] };
    db.run("INSERT INTO room_missions(id,project_id,room_id,state,actor_user_id,locale,budget_json,question_json,created_ts,updated_ts) VALUES('m',1,'r','waiting_user',1,'en',?,?,0,0)", [JSON.stringify({ modelRequests: 48, activeMs: 1_200_000, rounds: 4 }), JSON.stringify(question)]);
    db.run('INSERT INTO room_goal_revisions VALUES(?,?,?,?,?,?,?)', [1, 'r', 'm', 1, JSON.stringify({ request: 'Write prose', criteria: [{ id: 'original-request', description: 'Write prose', required: true }] }), 1, 0]);
    db.run("INSERT INTO room_contributions(id,project_id,room_id,mission_id,author_type,author_id,kind,summary,audience_json,seq,goal_revision,created_ts) VALUES('question',1,'r','m','member','c','question','Need input','{\"kind\":\"room\"}',1,1,0)");
    db.run('INSERT INTO room_commands VALUES(?,?,?,?,?,?,?)', [1, 1, 'create', 'legacy', 'hash', JSON.stringify({ room: { id: 'r' }, contributions: [{ text: 'Repeated history' }] }), 0]);
    migrateRooms(db);
    const engine = new RoomEngine({ store: new RoomStore(db), now: () => 1 });
    const before = engine.snapshot({ projectId: 1, roomId: 'r' });
    expect(before.contributions[0]!.question).toEqual(question);
    expect(before.goal!.criteria[0]!.origin).toBe('request');
    expect(before.members[0]!.version).toBe(1);
    expect(before.members.map(member => member.role)).toEqual(['coach', 'planner', 'writer', 'reviewer']);
    const after = engine.command({ projectId: 1, roomId: 'r' }, 'm', 'answer', { expectedVersion: before.mission!.version, questionId: 'q', answer: 'The first option' }, { actor: { userId: 1 }, key: 'answer' });
    expect(after.contributions.at(-1)).toMatchObject({ replyTo: 'question', answersQuestionId: 'q' });
    expect(after.mission!.state).toBe('queued');
    expect(JSON.parse(db.query<{response_json: string}, []>("SELECT response_json FROM room_commands WHERE idempotency_key='legacy'").get()!.response_json)).toEqual({ receiptVersion: 1, roomId: 'r' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { db.close(); }
});

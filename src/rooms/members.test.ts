import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../core/db';
import { loadMigrations, migrate } from '../core/migrate';
import { RoomEngine } from './engine';
import { RoomStore } from './store';
import { migrateRooms, ROOM_MIGRATIONS_DIR } from './migrations';
import { compileRoomMessages } from './runtime';
import type { RoomCommand, RoomMemberChange, RoomMemberModel, RoomSnapshot } from '../../shared/rooms';
import type { RoomFormalResult, RoomScope } from './contracts';

let db: Database, engine: RoomEngine, store: RoomStore;
let now = 1_800_000_000_000, serial = 0;
const meta = () => ({ actor: { userId: 1 }, key: `roster-${++serial}` });
const scope = (snapshot: RoomSnapshot): RoomScope => ({ projectId: 1, roomId: snapshot.room.id });
const create = () => engine.create(1, { title: 'Members', request: 'Produce a clear and specific introduction.', start: false }, meta());
const current = (snapshot: RoomSnapshot) => engine.snapshot(scope(snapshot));
const edit = (snapshot: RoomSnapshot, changes: RoomMemberChange[]) => engine.applyMembers(scope(snapshot), { expectedRoomVersion: current(snapshot).room.version, changes }, meta());
const command = (snapshot: RoomSnapshot, name: RoomCommand) => {
  const value = current(snapshot); return engine.command(scope(snapshot), value.mission!.id, name, { expectedVersion: value.mission!.version }, meta());
};
const claim = () => { const attempt = engine.claimNext('roster-worker'); expect(attempt).not.toBeNull(); expect(engine.dispatched(attempt!)).toBe(true); return attempt!; };
const accept = (result: RoomFormalResult) => { const attempt = claim(); expect(engine.accept(attempt, result)).toBe(true); return attempt; };
function setup(legacy = false) {
  db = openDb(':memory:'); migrate(db);
  if (legacy) for (const migration of loadMigrations(ROOM_MIGRATIONS_DIR).filter(item => item.id <= 85)) db.transaction(() => {
    db.exec(migration.sql); db.run('INSERT INTO schema_migrations VALUES(?,?,?)', [migration.id, migration.name, now]);
  })();
  else migrateRooms(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'roster','unused','admin',0)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'fixture','local','fixture','','','')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'roster',1,'/synthetic',1,0)");
  store = new RoomStore(db); engine = new RoomEngine({ store, now: () => now });
}
beforeEach(() => { serial = 0; now = 1_800_000_000_000; setup(); });
afterEach(() => db.close());

describe('atomic room membership', () => {
  test('single/batch updates persist exact models and replay through one room CAS receipt', () => {
    const room = create(), writer = room.members.find(member => member.role === 'writer')!;
    const model: RoomMemberModel = { provider: 'codex', model: 'gpt-5.4', effort: 'high' };
    const input = { expectedRoomVersion: room.room.version, changes: [
      { id: writer.id, expectedVersion: writer.version, displayName: '  Main author  ', instructions: '  Keep exact user wording.\n', model },
      { role: 'planner' as const, displayName: 'Research planner', model: { provider: 'deepseek' as const, model: 'deepseek-chat', effort: 'medium' as const } },
      { role: 'reviewer' as const, displayName: 'Second reviewer', model: { provider: 'claude' as const, model: 'claude-sonnet-4-5', effort: 'low' as const } },
    ] }, key = meta();
    const updated = engine.applyMembers(scope(room), input, key);
    expect(updated.members).toHaveLength(6); expect(updated.room.version).toBe(room.room.version + 1); expect(updated.members.find(member => member.id === writer.id)).toMatchObject({ displayName: '  Main author  ', instructions: '  Keep exact user wording.\n', model, version: 2 });
    expect(updated.members.every(member => member.roomId === room.room.id)).toBe(true);
    expect(engine.applyMembers(scope(room), input, key)).toEqual(updated);
    expect(() => engine.applyMembers(scope(room), { ...input, changes: [{ role: 'planner' }] }, key)).toThrow('idempotency_conflict');
    engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    expect(current(room).members.find(member => member.id === writer.id)?.model).toEqual(model);
    const reset = edit(room, [{ id: writer.id, model: null }]);
    expect(reset.members.find(member => member.id === writer.id)?.model).toBeUndefined();
    expect(reset.members.find(member => member.id === writer.id)?.modelProfile).toBe('default');
    const configured = engine.configureMember(scope(room), writer.id, { expectedVersion: reset.members.find(member => member.id === writer.id)!.version, displayName: 'Compatible member endpoint', instructions: '', model }, meta());
    expect(configured.members.find(member => member.id === writer.id)?.model).toEqual(model);
  });

  test('stale room/member CAS, invalid second change and duplicate IDs roll back the entire batch', () => {
    const room = create(), other = create(), writer = room.members.find(member => member.role === 'writer')!;
    const original = current(room), receipts = db.query('SELECT * FROM room_commands').all().length;
    expect(() => edit(room, [{ id: writer.id, displayName: 'Never committed' }, { id: other.members[0].id, displayName: 'Foreign member' }])).toThrow('not_found');
    expect(() => edit(room, [{ id: writer.id, displayName: 'First' }, { id: writer.id, displayName: 'Second' }])).toThrow();
    expect(() => edit(room, [{ id: writer.id, expectedVersion: 99, displayName: 'Wrong member CAS' }])).toThrow('conflict');
    expect(current(room)).toEqual(original); expect(db.query('SELECT * FROM room_commands').all()).toHaveLength(receipts);
    edit(room, [{ id: writer.id, displayName: 'Accepted change' }]);
    expect(() => engine.applyMembers(scope(room), { expectedRoomVersion: original.room.version, changes: [{ role: 'planner' }] }, meta())).toThrow('conflict');
  });

  test('maximum active members and one coach hold, including replacement at full capacity', () => {
    let room = create(); room = edit(room, Array.from({ length: 8 }, (_, index) => ({ role: 'planner' as const, displayName: `Planner ${index}` })));
    expect(room.members.filter(member => member.status === 'active')).toHaveLength(12);
    expect(() => edit(room, [{ role: 'writer' }])).toThrow('invalid_request');
    const coach = room.members.find(member => member.role === 'coach')!;
    // Deliberately put addition first: final-state validation and write order make
    // replacing the coach possible without weakening the unique DB constraint.
    room = edit(room, [{ role: 'coach', displayName: 'Replacement coach' }, { id: coach.id, remove: true }]);
    expect(room.members).toHaveLength(13); expect(room.members.filter(member => member.status === 'active')).toHaveLength(12);
    expect(room.members.filter(member => member.status === 'active' && member.role === 'coach')).toHaveLength(1);
    expect(room.members.find(member => member.id === coach.id)?.status).toBe('retired');
    expect(() => db.run("UPDATE room_members SET status='active' WHERE id=?", [coach.id])).toThrow();
    expect(() => db.run('DELETE FROM room_members WHERE id=?', [coach.id])).toThrow('room_member_identity_retained');
    expect(() => edit(room, [{ id: coach.id, displayName: 'Revived' }])).toThrow('state_conflict');
    const activeCoach = room.members.find(member => member.status === 'active' && member.role === 'coach')!;
    expect(() => edit(room, [{ id: activeCoach.id, remove: true }])).toThrow('invalid_request');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('role exchange can replace a coach in one batch, preserving both identities', () => {
    const room = create(), coach = room.members.find(member => member.role === 'coach')!, planner = room.members.find(member => member.role === 'planner')!;
    const updated = edit(room, [{ id: planner.id, role: 'coach' }, { id: coach.id, role: 'planner' }]);
    expect(updated.members.find(member => member.id === planner.id)?.role).toBe('coach');
    expect(updated.members.find(member => member.id === coach.id)?.role).toBe('planner');
    expect(updated.members.map(member => member.id)).toEqual(room.members.map(member => member.id));
  });

  test('temporary missing writer/reviewer is editable but start/resume/claim are guarded', () => {
    let room = create(); const writer = room.members.find(member => member.role === 'writer')!, reviewer = room.members.find(member => member.role === 'reviewer')!;
    room = edit(room, [{ id: writer.id, remove: true }, { id: reviewer.id, remove: true }]);
    expect(room.mission!.state).toBe('draft'); expect(() => command(room, 'start')).toThrow('state_conflict');
    room = edit(room, [{ role: 'writer' }, { role: 'reviewer' }]); command(room, 'start'); command(room, 'pause');
    const nextWriter = current(room).members.find(member => member.status === 'active' && member.role === 'writer')!;
    edit(room, [{ id: nextWriter.id, remove: true }]); expect(() => command(room, 'resume')).toThrow('state_conflict');
    room = edit(room, [{ role: 'writer' }]); command(room, 'resume');
    db.run("UPDATE room_members SET status='retired' WHERE room_id=? AND role_key='reviewer'", [room.room.id]);
    expect(engine.claimNext('direct-corruption-defense')).toBeNull();
    expect(current(room).mission).toMatchObject({ state: 'interrupted', reasonCode: 'member_unavailable' });
  });

  test('queued/running/quiescing and unconfirmed external cancellation refuse roster edits', () => {
    const room = create(); command(room, 'start'); expect(() => edit(room, [{ role: 'planner' }])).toThrow('state_conflict');
    const attempt = engine.claimNext('cli-worker')!; expect(engine.setCancellationMode(attempt, 'confirm')).toBe(true);
    expect(() => edit(room, [{ role: 'planner' }])).toThrow('state_conflict');
    command(room, 'pause'); engine.fail(attempt, 'cancelled');
    expect(current(room).mission!.state).toBe('quiescing'); expect(() => edit(room, [{ role: 'planner' }])).toThrow('state_conflict');
    expect(engine.confirmStopped(attempt)).toBe(true); expect(edit(room, [{ role: 'planner' }]).members).toHaveLength(5);
    expect(engine.accept(attempt, { message: 'Late old result', decision: 'continue' })).toBe(false);
  });

  test('retiring one pending recipient explicitly supersedes its reply while preserving other replies', () => {
    const room = create(), planner = room.members.find(member => member.role === 'planner')!, writer = room.members.find(member => member.role === 'writer')!;
    engine.contribute(scope(room), { text: 'Please clarify this concrete point.', audience: { kind: 'members', memberIds: [planner.id, writer.id] }, clientMessageId: 'shared-question' }, { userId: 1 });
    const before = store.all<{ id: string; member_id: string }>("SELECT id,member_id FROM room_assignments WHERE mission_id=? AND kind='reply'", room.mission!.id);
    edit(room, [{ id: planner.id, remove: true }]);
    expect(store.get<{ state: string; failure_code: string }>('SELECT state,failure_code FROM room_assignments WHERE id=?', before.find(item => item.member_id === planner.id)!.id)).toEqual({ state: 'superseded', failure_code: 'member_retired' });
    expect(store.get<{ state: string }>('SELECT state FROM room_assignments WHERE id=?', before.find(item => item.member_id === writer.id)!.id)).toEqual({ state: 'pending' });
    command(room, 'start'); const attempt = claim(); expect(attempt.kind).toBe('reply'); expect(attempt.memberId).toBe(writer.id);
    expect(engine.accept(attempt, { message: 'Formal direct clarification.' })).toBe(true);
    expect(current(room).contributions.filter(item => item.replyTo)).toHaveLength(1);
    accept({ message: 'No planner is needed for this small team.', decision: 'continue' });
    expect(claim().role).toBe('writer');
  });

  test('waiting question survives team edits and paused work plans rebuild without losing replies', () => {
    const waiting = create(); command(waiting, 'start'); accept({ message: 'Need one clarification.', decision: 'ask_user', question: { text: 'Which audience?', options: ['New users', 'Returning users'] } });
    const question = current(waiting).mission!.question;
    const changed = edit(waiting, [{ role: 'planner', displayName: 'New scenario planner' }]);
    expect(changed.mission!.state).toBe('waiting_user'); expect(changed.mission!.question).toEqual(question);
    const room = create(); command(room, 'start'); accept({ message: 'Plan then write and review.', decision: 'continue' }); command(room, 'pause');
    const writer = current(room).members.find(member => member.role === 'writer')!;
    engine.contribute(scope(room), { text: 'Please explain the outline.', audience: { kind: 'members', memberIds: [writer.id] }, clientMessageId: 'keep-reply' }, { userId: 1 });
    const rebuilt = edit(room, [{ id: writer.id, instructions: 'Use concrete examples.' }]);
    expect(rebuilt.plans![0].state).toBe('superseded'); expect(rebuilt.plans![0].tasks.every(task => task.state === 'superseded')).toBe(true);
    expect(rebuilt.mission).toMatchObject({ state: 'paused', nextRole: 'coach' });
    command(room, 'resume'); const reply = claim(); expect(reply.kind).toBe('reply'); expect(engine.accept(reply, { message: 'Here is the outline explanation.' })).toBe(true);
    expect(claim().role).toBe('coach');
  });

  test('invalid model configuration and attempts to add hidden fields fail atomically', () => {
    const room = create(), member = room.members[0], baseline = current(room);
    for (const model of [
      { provider: 'unknown', model: 'x', effort: 'low' }, { provider: 'codex', model: '-dangerous', effort: 'low' },
      { provider: 'claude', model: 'unsafe\nname', effort: 'high' }, { provider: 'deepseek', model: 'deepseek-chat', effort: 'max' },
      { provider: 'codex', model: 'gpt-5.4\n', effort: 'low' }, { provider: 'claude', model: 'claude-sonnet-4-5\r', effort: 'low' },
      { provider: 'codex', model: 'x'.repeat(201), effort: 'low' }, { provider: 'codex', model: 'gpt-5.4', effort: 'high', runtimeKey: 'foreign/session' },
    ]) expect(() => edit(room, [{ id: member.id, model: model as RoomMemberModel }])).toThrow('invalid_request');
    expect(current(room)).toEqual(baseline);
  });
});

describe('actual member assignment', () => {
  test('default plans rotate same-role members durably across rounds', () => {
    const room = create(); edit(room, [{ role: 'planner', displayName: 'P2' }, { role: 'writer', displayName: 'W2' }, { role: 'reviewer', displayName: 'R2' }]); command(room, 'start');
    const rounds: string[][] = [];
    for (let index = 0; index < 2; index++) {
      accept({ message: `Round ${index + 1} plan`, decision: 'continue' });
      const planner = accept({ message: `Scenarios ${index + 1}` });
      const writer = accept({ message: `Draft ${index + 1}`, artifact: { title: 'Introduction', markdown: `Specific user scenarios in revision ${index + 1}.` } });
      const reviewer = claim(), ctx = engine.context(reviewer), artifact = ctx.artifacts[0];
      expect(ctx.task?.memberId).toBe(reviewer.memberId);
      expect(engine.accept(reviewer, { message: 'Further refinement required.', review: { artifactId: artifact.id, artifactVersion: artifact.currentVersion, criteria: ctx.goal.criteria.map(criterion => ({ criterionId: criterion.id, verdict: 'failed', note: 'Add more concrete evidence.' })) } })).toBe(true);
      rounds.push([planner.memberId, writer.memberId, reviewer.memberId]);
      engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    }
    expect(rounds[0].every((id, index) => id !== rounds[1][index])).toBe(true);
    expect(current(room).plans!.every(plan => plan.tasks.every(task => !!task.memberId))).toBe(true);
  });

  test('multiple unassigned planner nodes rotate, explicit memberId binds the exact matching active member', () => {
    const room = create(), updated = edit(room, [{ role: 'planner', displayName: 'Second planner' }, { role: 'writer', displayName: 'Chosen writer' }]);
    const chosen = updated.members.find(member => member.displayName === 'Chosen writer')!;
    const foreign = create().members.find(member => member.role === 'writer')!;
    command(room, 'start'); const coach = claim();
    const tasks: NonNullable<RoomFormalResult['plan']>['tasks'] = [
      { id: 'p1', role: 'planner', instruction: 'First angle', dependsOn: [], independent: true },
      { id: 'p2', role: 'planner', instruction: 'Second angle', dependsOn: [], independent: true },
      { id: 'write', role: 'writer', memberId: chosen.id, instruction: 'Join the proposals', dependsOn: ['p1', 'p2'] },
      { id: 'review', role: 'reviewer', instruction: 'Verify the artifact', dependsOn: ['write'] },
    ];
    for (const memberId of [foreign.id, updated.members.find(member => member.role === 'reviewer')!.id, 'missing']) {
      const invalid = structuredClone(tasks); invalid[2].memberId = memberId;
      expect(() => engine.accept(coach, { message: 'Wrong member assignment', decision: 'continue', plan: { tasks: invalid } })).toThrow('invalid_request');
    }
    expect(engine.accept(coach, { message: 'Join independent proposals', decision: 'continue', plan: { tasks } })).toBe(true);
    const p1 = accept({ message: 'First independent proposal' }), p2 = accept({ message: 'Second independent proposal' }); expect(p1.memberId).not.toBe(p2.memberId);
    const writer = claim(); expect(writer.memberId).toBe(chosen.id);
    const input = JSON.parse(compileRoomMessages(engine.context(writer))[1].content); expect(input.task.memberId).toBe(chosen.id);
    expect(compileRoomMessages(engine.context(writer))[0].content).toContain('memberId');
  });
});

test('085 to 086 upgrades a populated room without losing references, counters or permanent identity guards', () => {
  db.close(); setup(true); const room = create(); command(room, 'start');
  accept({ message: 'Plan the introduction.', decision: 'continue' }); accept({ message: 'Use concrete examples.' });
  accept({ message: 'Artifact created.', artifact: { title: 'Original title', markdown: 'Preserve this artifact and author.' } }); command(room, 'pause');
  const before = current(room), bindings = store.all('SELECT * FROM room_runtime_bindings'), attempts = store.all('SELECT * FROM room_attempts');
  expect(migrateRooms(db).latest).toBe(86); expect(current(room)).toEqual(before);
  expect(store.all('SELECT * FROM room_runtime_bindings')).toEqual(bindings); expect(store.all('SELECT * FROM room_attempts')).toEqual(attempts);
  expect(db.query('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 }); expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(() => db.run('UPDATE room_members SET room_id=? WHERE id=?', ['foreign', room.members[0].id])).toThrow('room_member_scope_immutable');
  expect(() => db.run('DELETE FROM room_members WHERE id=?', [room.members[0].id])).toThrow('room_member_identity_retained');
  expect(() => db.run("UPDATE room_runtime_bindings SET runtime_key='another-key'")).toThrow('room_runtime_scope_immutable');
  expect(edit(room, [{ role: 'writer', displayName: 'New author' }]).members.filter(member => member.role === 'writer')).toHaveLength(2);
  expect(migrateRooms(db).latest).toBe(86);
});

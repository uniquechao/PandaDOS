import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../../../src/core/db';
import { migrate } from '../../../src/core/migrate';
import { RoomEngine } from '../../../src/rooms/engine';
import { RoomStore } from '../../../src/rooms/store';
import { migrateRooms } from '../../../src/rooms/migrations';
import { roomBudgetIncrement, roomBudgetRemaining, roomCanAdopt, roomCommandTarget, roomCriteriaValid, roomEditableCriteria } from './rooms-api';
import { MAX_ROOM_BUDGET } from '../../../shared/rooms';

let db: Database;
let engine: RoomEngine;
const meta = () => ({ actor: { userId: 1 }, key: crypto.randomUUID() });
beforeEach(() => {
  db = openDb(':memory:'); migrate(db); migrateRooms(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'room-ui','unused','admin',0)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'test',1,'/p',1,0)");
  engine = new RoomEngine({ store: new RoomStore(db) });
});
afterEach(() => db.close());

describe('UI contracts use real room engine snapshots', () => {
  test('long original request and twelve user criteria round-trip without becoming user criteria', () => {
    const room = engine.create(1, { title: 'Goal editor', request: 'x'.repeat(600), criteria: Array.from({ length: 12 }, (_, i) => `Check ${i}`) }, meta());
    const userCriteria = roomEditableCriteria(room.goal);
    expect(roomCriteriaValid(userCriteria)).toBe(true); expect(userCriteria).toHaveLength(12);
    const updated = engine.command({ projectId: 1, roomId: room.room.id }, room.mission!.id, 'goal', { expectedVersion: room.mission!.version, request: 'A replacement target', userCriteria }, meta());
    expect(roomEditableCriteria(updated.goal)).toEqual(userCriteria);
    expect(updated.goal!.criteria.filter(item => item.origin === 'request')).toHaveLength(1);
    expect(updated.goal!.criteria.some(item => item.description === 'x'.repeat(600))).toBe(false);
  });
  test('an editor target stays at the opening version and the engine rejects its stale mutation', () => {
    const room = engine.create(1, { title: 'Concurrent editor', request: 'First target' }, meta());
    const target = roomCommandTarget(room)!;
    const scope = { projectId: 1, roomId: room.room.id };
    const next = engine.command(scope, target.missionId, 'goal', { expectedVersion: target.expectedVersion, request: 'Another user changed this', userCriteria: [] }, meta());
    expect(target.expectedVersion).not.toBe(next.mission!.version);
    expect(() => engine.command(scope, target.missionId, 'goal', { expectedVersion: target.expectedVersion, request: 'Old form', userCriteria: [] }, meta())).toThrow();
    expect(engine.snapshot(scope).goal!.request).toBe('Another user changed this');
  });
  test('zero-valued budget fields are omitted and another dimension can grow when rounds are at the maximum', () => {
    const room = engine.create(1, { title: 'Budget editor', request: 'Draft', budget: { rounds: MAX_ROOM_BUDGET.rounds } }, meta());
    const remaining = roomBudgetRemaining(room.mission!.budget.limits);
    expect(remaining.rounds).toBe(0);
    const budget = roomBudgetIncrement({ rounds: 0, activeMs: 0, modelRequests: 1 });
    expect(budget).toEqual({ modelRequests: 1 });
    const next = engine.command({ projectId: 1, roomId: room.room.id }, room.mission!.id, 'budget', { expectedVersion: room.mission!.version, budget }, meta());
    expect(next.mission!.budget.limits.modelRequests).toBe(room.mission!.budget.limits.modelRequests + 1);
  });
  test('adoption stays disabled between passed review and the coach completion decision', () => {
    let room = engine.create(1, { title: 'Reviewed artifact', request: 'Write one sentence', start: true }, meta());
    const accept = (result: Parameters<RoomEngine['accept']>[1]) => { const attempt = engine.claimNext('test')!; expect(attempt).toBeTruthy(); expect(engine.dispatched(attempt)).toBe(true); expect(engine.accept(attempt, result)).toBe(true); };
    accept({ message: 'Plan', decision: 'continue' }); accept({ message: 'Use one sentence.' });
    accept({ message: 'Written', artifact: { title: 'Sentence', markdown: 'A complete sentence.' } });
    room = engine.snapshot({ projectId: 1, roomId: room.room.id });
    const artifact = room.artifacts[0]!;
    accept({ message: 'Reviewed', review: { artifactId: artifact.id, artifactVersion: artifact.currentVersion, criteria: room.goal!.criteria.map(item => ({ criterionId: item.id, verdict: 'passed', note: 'One sentence.' })) } });
    room = engine.snapshot({ projectId: 1, roomId: room.room.id });
    expect(roomCanAdopt(room, artifact.id, artifact.currentVersion)).toBe(false);
    accept({ message: 'Complete', decision: 'complete' });
    room = engine.snapshot({ projectId: 1, roomId: room.room.id });
    expect(roomCanAdopt(room, artifact.id, artifact.currentVersion)).toBe(true);
  });
});

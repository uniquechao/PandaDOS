import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { RoomEngine } from './engine';
import { RoomStore } from './store';
import { migrateRooms } from './migrations';
import { RoomReadModel } from './read-model';

describe('compact room command receipts', () => {
  test('history grows linearly; replay returns current state without repeating the action', () => {
    const db = openDb(':memory:');
    try {
      migrate(db); migrateRooms(db);
      db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','unused','admin',0)");
      db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
      db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0)");
      const engine = new RoomEngine({ store: new RoomStore(db) });
      const meta = { actor: { userId: 1 }, key: 'create-key' };
      const input = { title: 'Receipts', request: 'Write a document.' };
      const initial = engine.create(1, input, meta);
      const scope = { projectId: 1, roomId: initial.room.id };
      const contribute = (index: number) => engine.contribute(scope, { text: 'x'.repeat(2000), audience: { kind: 'room' }, clientMessageId: `message-${index}` }, meta.actor);
      for (let i = 0; i < 50; i++) contribute(i);
      const size = () => db.query<{ n: number }, []>("SELECT SUM(length(response_json)) AS n FROM room_commands WHERE operation='contribute'").get()!.n;
      const first = size();
      for (let i = 50; i < 100; i++) contribute(i);
      expect(size()).toBe(first * 2);
      expect(size()).toBeLessThan(12_000);
      expect(contribute(0).contributions).toHaveLength(100);
      const replay = engine.create(1, input, meta);
      expect(replay.room.id).toBe(initial.room.id);
      expect(replay.contributions).toHaveLength(100);
      expect(() => engine.create(1, { ...input, request: 'Another request' }, meta)).toThrow('idempotency_conflict');
      // Legacy data is compacted on replay without losing its original deduplication identity.
      db.query("UPDATE room_commands SET response_json=? WHERE operation='create'").run(JSON.stringify(initial));
      expect(engine.create(1, input, meta).contributions).toHaveLength(100);
      const receipt = db.query<{ response_json: string }, []>("SELECT response_json FROM room_commands WHERE operation='create'").get()!;
      expect(JSON.parse(receipt.response_json)).toEqual({ receiptVersion: 1, roomId: initial.room.id });
      expect(engine.list(1)).toHaveLength(1);
      const reads = new RoomReadModel(engine.store);
      const view = reads.view(scope);
      expect(view.contributions).toHaveLength(80);
      expect(view.history.hasMore).toBe(true);
      const previous = reads.history(scope, view.history.beforeSeq!);
      expect(previous.contributions).toHaveLength(20);
      expect(previous.hasMore).toBe(false);
      expect(new Set([...previous.contributions, ...view.contributions].map(item => item.id)).size).toBe(100);
    } finally { db.close(); }
  });
});

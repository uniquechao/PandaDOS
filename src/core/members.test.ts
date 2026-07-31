import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { UserStore } from './users';
import { ProjectMemberStore } from './members';

function setup(now?: () => number) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const owner = users.create('owner', 'user').user;
  const bob = users.create('bob', 'user').user;
  const carol = users.create('carol', 'user').user;
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  ).run('proj-a', '/ws/a', owner.id, 1_000);
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  ).run('proj-b', '/ws/b', owner.id, 1_000);
  const members = now ? new ProjectMemberStore(db, now) : new ProjectMemberStore(db);
  return { db, users, owner, bob, carol, members, pA: 1, pB: 2 };
}

describe('ProjectMemberStore', () => {
  test('add → isMember / list（带用户名），属主不进本表', () => {
    const { members, owner, bob, pA } = setup(() => 5_000);
    expect(members.isMember(pA, bob.id)).toBe(false);
    expect(members.add(pA, bob.id)).toBe(true);
    expect(members.isMember(pA, bob.id)).toBe(true);

    const list = members.list(pA);
    expect(list).toEqual([
      {
        projectId: pA,
        userId: bob.id,
        username: 'bob',
        createdTs: 5_000,
        lastLoginTs: null,
        lastSeenTs: null,
      },
    ]);
    // 属主不是成员行
    expect(members.isMember(pA, owner.id)).toBe(false);
    expect(list.some((m) => m.userId === owner.id)).toBe(false);
  });

  test('add 幂等：重复加返回 false 且不覆盖 created_ts、不增行', () => {
    let t = 100;
    const { members, bob, pA } = setup(() => t);
    expect(members.add(pA, bob.id)).toBe(true);
    t = 999; // 时间前进
    expect(members.add(pA, bob.id)).toBe(false);
    const list = members.list(pA);
    expect(list).toHaveLength(1);
    expect(list[0]!.createdTs).toBe(100); // 原值保留
  });

  test('list 按 created_ts 升序', () => {
    let t = 0;
    const { members, bob, carol, pA } = setup(() => t);
    t = 20;
    members.add(pA, carol.id);
    t = 10;
    members.add(pA, bob.id);
    expect(members.list(pA).map((m) => m.username)).toEqual(['bob', 'carol']);
  });

  test('remove 幂等：删存在返回 true，再删返回 false', () => {
    const { members, bob, pA } = setup();
    members.add(pA, bob.id);
    expect(members.remove(pA, bob.id)).toBe(true);
    expect(members.isMember(pA, bob.id)).toBe(false);
    expect(members.remove(pA, bob.id)).toBe(false);
  });

  test('projectIdsForUser：仅返回其作为成员参与的项目', () => {
    const { members, bob, carol, pA, pB } = setup();
    members.add(pA, bob.id);
    members.add(pB, bob.id);
    members.add(pB, carol.id);
    expect(members.projectIdsForUser(bob.id)).toEqual([pA, pB]);
    expect(members.projectIdsForUser(carol.id)).toEqual([pB]);
  });

  test('外键级联：删项目 / 删用户都会清掉对应成员行', () => {
    const { db, members, bob, carol, pA, pB } = setup();
    members.add(pA, bob.id);
    members.add(pB, bob.id);
    members.add(pB, carol.id);

    db.run('DELETE FROM projects WHERE id = ?', [pA]);
    expect(members.isMember(pA, bob.id)).toBe(false); // 项目删 → 成员行随之清
    expect(members.isMember(pB, bob.id)).toBe(true);

    db.run('DELETE FROM users WHERE id = ?', [bob.id]);
    expect(members.isMember(pB, bob.id)).toBe(false); // 用户删 → 成员行随之清
    expect(members.isMember(pB, carol.id)).toBe(true);
  });
});

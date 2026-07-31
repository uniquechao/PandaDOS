import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { SessionStore, SESSION_TTL_MS } from './sessions';
import { hashToken, UserStore } from './users';

function setup(now?: () => number) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const { user } = users.create('alice', 'user');
  const sessions = now ? new SessionStore(db, now) : new SessionStore(db);
  return { db, users, user, sessions };
}

describe('SessionStore', () => {
  test('create → 明文 token 可按哈希找回用户；错误哈希找不到', () => {
    const { user, sessions } = setup();
    const { token, expiresTs } = sessions.create(user.id);
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(expiresTs).toBeGreaterThan(Date.now());
    expect(sessions.userIdByTokenHash(hashToken(token))).toBe(user.id);
    expect(sessions.userIdByTokenHash(hashToken('wrong'))).toBeUndefined();
    expect(sessions.userIdByTokenHash('')).toBeUndefined();
  });

  test('过期会话不再命中，且被 prune/create 顺手清掉', () => {
    let t = 1_000_000;
    const { user, sessions, db } = setup(() => t);
    const { token } = sessions.create(user.id);
    const hash = hashToken(token);
    expect(sessions.userIdByTokenHash(hash)).toBe(user.id);

    t += SESSION_TTL_MS + 1;
    expect(sessions.userIdByTokenHash(hash)).toBeUndefined();
    sessions.create(user.id); // 写路径捎带 prune
    const n = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM auth_sessions').get()!.n;
    expect(n).toBe(1); // 过期行已清，只剩新会话
  });

  test('revokeForUser 只吊销目标用户的会话', () => {
    const { user, users, sessions } = setup();
    const bob = users.create('bob', 'user').user;
    const a = sessions.create(user.id);
    const b = sessions.create(bob.id);
    expect(sessions.revokeForUser(user.id)).toBe(1);
    expect(sessions.userIdByTokenHash(hashToken(a.token))).toBeUndefined();
    expect(sessions.userIdByTokenHash(hashToken(b.token))).toBe(bob.id);
  });

  test('删用户级联清会话（FK ON DELETE CASCADE）', () => {
    const { user, users, sessions } = setup();
    const { token } = sessions.create(user.id);
    users.remove(user.id);
    expect(sessions.userIdByTokenHash(hashToken(token))).toBeUndefined();
  });
});

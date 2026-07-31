import { describe, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db';
import { migrate } from './migrate';
import {
  ensureAdminUser,
  genToken,
  hashEq,
  hashToken,
  MEMORY_MAX_CHARS,
  PERSONA_MAX_CHARS,
  provisionUserWorkspace,
  userWorkspaceDir,
  UserStore,
} from './users';
import { LocalDriver } from '../executor/local';

function makeStore(): { store: UserStore; db: ReturnType<typeof openDb> } {
  const db = openDb(':memory:');
  migrate(db);
  return { store: new UserStore(db), db };
}

describe('token 哈希', () => {
  test('genToken 是 48 hex 且不重复', () => {
    const a = genToken();
    const b = genToken();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });

  test('hashToken 确定性、64 hex、不可逆（哈希不含明文）', () => {
    const tok = genToken();
    const h = hashToken(tok);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(tok)).toBe(h);
    expect(h).not.toBe(tok);
    expect(h.includes(tok)).toBe(false);
  });

  test('hashEq：相同 true、不同/空/长度不一致 false', () => {
    const h = hashToken('x');
    expect(hashEq(h, h)).toBe(true);
    expect(hashEq(h, hashToken('y'))).toBe(false);
    expect(hashEq('', h)).toBe(false);
    expect(hashEq(h, h.slice(0, 10))).toBe(false);
  });
});

describe('UserStore', () => {
  test('create 返回明文 token 一次；DB 只存哈希、绝无明文', () => {
    const { store, db } = makeStore();
    const { user, token } = store.create('alice', 'user');
    expect(token).toMatch(/^[0-9a-f]{48}$/);
    expect(user.username).toBe('alice');
    expect(user.tokenHash).toBe(hashToken(token));

    const raw = db
      .query<{ token_hash: string }, [number]>('SELECT token_hash FROM users WHERE id = ?')
      .get(user.id);
    expect(raw?.token_hash).toBe(hashToken(token));
    expect(raw?.token_hash).not.toBe(token);
  });

  test('byTokenHash / byUsername / byId', () => {
    const { store } = makeStore();
    const { user, token } = store.create('bob', 'user');
    expect(store.byTokenHash(hashToken(token))?.id).toBe(user.id);
    expect(store.byTokenHash(hashToken('wrong'))).toBeUndefined();
    expect(store.byTokenHash('')).toBeUndefined();
    expect(store.byUsername('bob')?.id).toBe(user.id);
    expect(store.byId(user.id)?.username).toBe('bob');
  });

  test('resetToken：旧 token 失效、新 token 生效、仅明文返回一次', () => {
    const { store } = makeStore();
    const { user, token: oldTok } = store.create('carol', 'user');
    const newTok = store.resetToken(user.id);
    expect(newTok).toMatch(/^[0-9a-f]{48}$/);
    expect(newTok).not.toBe(oldTok);
    expect(store.byTokenHash(hashToken(oldTok))).toBeUndefined();
    expect(store.byTokenHash(hashToken(newTok!))?.id).toBe(user.id);
    expect(store.resetToken(9999)).toBeNull();
  });

  test('用户名约束 + UNIQUE', () => {
    const { store } = makeStore();
    expect(() => store.create('bad name!', 'user')).toThrow();
    store.create('dup', 'user');
    expect(() => store.create('dup', 'user')).toThrow();
  });

  test('rename/setRole/touchLogin/remove/countAdmins', () => {
    const { store } = makeStore();
    const { user } = store.create('eve', 'user');
    expect(store.rename(user.id, 'eve2')).toBe(true);
    expect(store.byUsername('eve2')?.id).toBe(user.id);
    store.setRole(user.id, 'admin');
    expect(store.countAdmins()).toBe(1);
    expect(store.byId(user.id)?.lastLoginTs).toBeNull();
    store.touchLogin(user.id);
    expect(store.byId(user.id)?.lastLoginTs).toBeGreaterThan(0);
    expect(store.remove(user.id)).toBe(true);
    expect(store.byId(user.id)).toBeUndefined();
    expect(store.remove(user.id)).toBe(false);
  });

  test('touchSeen：首次写入，节流窗口内跳过，窗口外再写（012）', () => {
    const { store } = makeStore();
    const { user } = store.create('seen', 'user');
    expect(store.byId(user.id)?.lastSeenTs).toBeNull();

    // 首次：last_seen_ts 为 NULL → 必写
    expect(store.touchSeen(user.id)).toBe(true);
    const first = store.byId(user.id)?.lastSeenTs;
    expect(first).toBeGreaterThan(0);

    // 节流：刚写过、默认 5min 间隔未到 → 不写
    expect(store.touchSeen(user.id)).toBe(false);
    expect(store.byId(user.id)?.lastSeenTs).toBe(first!);

    // 间隔归零 = 窗口外 → 再写
    expect(store.touchSeen(user.id, 0)).toBe(true);
    expect(store.byId(user.id)?.lastSeenTs).toBeGreaterThanOrEqual(first!);

    // 不存在的用户：不写不抛
    expect(store.touchSeen(99999)).toBe(false);
  });

  test('remove：仍有项目归属时外键约束抛错（默认安全）', () => {
    const { store, db } = makeStore();
    const { user } = store.create('owner', 'user');
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('e1', 'h', 'root', 'k', '/ws', '/c')`,
    ).run();
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p1', 1, '/ws/p1', ?, 0)`,
    ).run(user.id);
    expect(() => store.remove(user.id)).toThrow();
  });

  test('ensureAdminUser：无 admin 建一次并回明文；已有则 null', () => {
    const { store } = makeStore();
    const boot = ensureAdminUser(store);
    expect(boot?.user.role).toBe('admin');
    expect(boot?.token).toMatch(/^[0-9a-f]{48}$/);
    expect(ensureAdminUser(store)).toBeNull();
  });
});

describe('UserStore 设定（persona/memory/autopilotDefault）', () => {
  test('默认值：无行时返回空设定', () => {
    const { store } = makeStore();
    const { user } = store.create('u1', 'user');
    expect(store.getSettings(user.id)).toEqual({
      userId: user.id,
      persona: null,
      memory: null,
      autopilotDefault: false,
      notifyPref: null,
    });
  });

  test('局部更新保留其余字段；读写往返一致', () => {
    const { store } = makeStore();
    const { user } = store.create('u2', 'user');
    store.putSettings(user.id, { persona: '风格A', autopilotDefault: true });
    store.putSettings(user.id, { memory: '记住这个' });
    const s = store.getSettings(user.id);
    expect(s.persona).toBe('风格A');
    expect(s.memory).toBe('记住这个');
    expect(s.autopilotDefault).toBe(true);
  });

  test('截断护栏：persona 8000 / memory 50000', () => {
    const { store } = makeStore();
    const { user } = store.create('u3', 'user');
    const s = store.putSettings(user.id, {
      persona: 'p'.repeat(PERSONA_MAX_CHARS + 500),
      memory: 'm'.repeat(MEMORY_MAX_CHARS + 500),
    });
    expect(s.persona!.length).toBe(PERSONA_MAX_CHARS);
    expect(s.memory!.length).toBe(MEMORY_MAX_CHARS);
    const back = store.getSettings(user.id);
    expect(back.persona!.length).toBe(PERSONA_MAX_CHARS);
    expect(back.memory!.length).toBe(MEMORY_MAX_CHARS);
  });

  test('置 null 清空', () => {
    const { store } = makeStore();
    const { user } = store.create('u4', 'user');
    store.putSettings(user.id, { persona: 'x' });
    const s = store.putSettings(user.id, { persona: null });
    expect(s.persona).toBeNull();
  });
});

describe('workspace 供给（经 Driver）', () => {
  test('目录名用不可复用的 user id（u<id>）', () => {
    expect(userWorkspaceDir('/ws/root/', { id: 7 })).toBe('/ws/root/u7');
    expect(userWorkspaceDir('/ws/root', { id: 7 })).toBe('/ws/root/u7');
  });

  test('provisionUserWorkspace 用 LocalDriver 在临时目录建出 workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mando-ws-'));
    const driver = new LocalDriver();
    const dir = await provisionUserWorkspace(driver, root, { id: 42, username: 'alice' });
    expect(dir).toBe(join(root, 'u42'));
    expect(existsSync(dir)).toBe(true);
    const keep = readFileSync(join(dir, '.mando/keep'), 'utf8');
    expect(keep).toContain('alice');
    expect(keep).toContain('42');
  });
});

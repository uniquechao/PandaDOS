import { afterEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { ProjectMemberStore } from '../core/members';
import { PrivateChat, type PrivateChatDeps } from './private-chat';
import type { NotifyTarget } from './router';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function setup(answer?: PrivateChatDeps['answer']) {
  const db = openDb(':memory:'); databases.push(db); migrate(db);
  db.run("INSERT INTO executors (name,host,port,ssh_user,key_ref,workspace_root,claude_dir) VALUES ('e','h',22,'u','k','/w','/c')");
  const users = new UserStore(db);
  const alice = users.create('alice').user;
  const bob = users.create('bob').user;
  const admin = users.create('admin', 'admin').user;
  for (const user of [alice, bob, admin]) users.setFeishuOpenid(user.id, `ou_${user.username}`);
  const members = new ProjectMemberStore(db);
  function project(name: string, ownerId = alice.id, status = 'active') {
    return Number(db.query('INSERT INTO projects(name,executor_id,cwd,owner_user_id,created_ts,status) VALUES (?,1,?,?,0,?)').run(name, `/w/${name}`, ownerId, status).lastInsertRowid);
  }
  const sends: Array<{ target: NotifyTarget; text: string }> = [];
  const calls: Array<[number, number, string]> = [];
  let active = true;
  const chat = new PrivateChat({ db,
    answer: async (userId, projectId, question) => {
      calls.push([userId, projectId, question]);
      return answer ? answer(userId, projectId, question) : `answer: ${question}`;
    },
    send: async (target, text) => { sends.push({ target, text }); },
    isActive: () => active,
  });
  return { db, users, alice, bob, admin, members, project, sends, calls, chat, deactivate: () => { active = false; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('PrivateChat', () => {
  test('unbound users get binding guidance without invoking the answer provider', async () => {
    const s = setup(); s.project('secret');
    await s.chat.handle('ou_unknown', '#secret read all');
    expect(s.calls).toEqual([]);
    expect(s.sends[0]!.text).toContain('bind');
    expect(s.sends[0]!.text).not.toContain('secret');
  });

  test('help only lists accessible active owner/member/admin projects', async () => {
    const s = setup(); const own = s.project('own'); const shared = s.project('shared', s.bob.id);
    s.members.add(shared, s.alice.id); s.project('hidden', s.bob.id); s.project('archived', s.alice.id, 'archived');
    for (const command of ['projects', '项目', 'help', '帮助']) {
      await s.chat.handle('ou_alice', command);
      const text = s.sends.at(-1)!.text;
      expect(text).toContain(`#${own} own`); expect(text).toContain(`#${shared} shared`);
      expect(text).not.toContain('hidden'); expect(text).not.toContain('archived');
    }
    await s.chat.handle('ou_admin', 'projects');
    expect(s.sends.at(-1)!.text).toContain('hidden');
    expect(s.sends.at(-1)!.text).not.toContain('archived');
    expect(s.calls).toEqual([]);
  });

  test('unknown and unauthorized project selectors use the same response', async () => {
    const s = setup(); const secret = s.project('secret', s.bob.id);
    await s.chat.handle('ou_alice', `#${secret} question`);
    await s.chat.handle('ou_alice', '#9999 question');
    expect(s.sends[0]!.text).toBe(s.sends[1]!.text);
    expect(s.sends[0]!.text).not.toContain('secret');
    expect(s.calls).toEqual([]);
    await s.chat.handle('ou_alice', 'hello');
    expect(s.sends.at(-1)!.text).toContain('no accessible active projects');
  });

  test('single project auto-selects; project-only command confirms and continuation stays selected', async () => {
    const s = setup(); const first = s.project('First App');
    await s.chat.handle('ou_alice', 'hello');
    expect(s.calls).toEqual([[s.alice.id, first, 'hello']]);
    const second = s.project('Second App');
    await s.chat.handle('ou_alice', '#Second App');
    expect(s.calls).toHaveLength(1); expect(s.sends.at(-1)!.text).toContain('Selected project');
    await s.chat.handle('ou_alice', 'continue');
    await s.chat.handle('ou_alice', `#${first} another question`);
    expect(s.calls.slice(1)).toEqual([[s.alice.id, second, 'continue'], [s.alice.id, first, 'another question']]);
    expect(s.sends.at(-1)!.text).toContain(`Project #${first}: First App`);
  });

  test('ambiguous exact names require ID; inaccessible duplicates never affect resolution', async () => {
    const s = setup(); const first = s.project('Same'); s.project('Same', s.bob.id);
    await s.chat.handle('ou_alice', '#Same question');
    expect(s.calls).toEqual([[s.alice.id, first, 'question']]);
    const duplicate = s.project('Same');
    await s.chat.handle('ou_alice', '#Same question');
    expect(s.calls).toHaveLength(1); expect(s.sends.at(-1)!.text).toContain('Several projects');
    await s.chat.handle('ou_alice', `#${duplicate} explicit`);
    expect(s.calls.at(-1)![1]).toBe(duplicate);
  });

  test('per-user queue preserves switches and questions without blocking other users', async () => {
    const started = deferred<void>(); const release = deferred<string>();
    const s = setup(async (_u, _p, q) => { if (q === 'slow') { started.resolve(); return release.promise; } return q; });
    const first = s.project('first'); const second = s.project('second'); const bobProject = s.project('bob', s.bob.id);
    const p1 = s.chat.handle('ou_alice', `#${first} slow`); await started.promise;
    const p2 = s.chat.handle('ou_alice', `#${second}`);
    const p3 = s.chat.handle('ou_alice', 'after switch');
    await s.chat.handle('ou_bob', 'independent');
    expect(s.calls).toEqual([[s.alice.id, first, 'slow'], [s.bob.id, bobProject, 'independent']]);
    release.resolve('finished'); await Promise.all([p1, p2, p3]);
    expect(s.calls.at(-1)).toEqual([s.alice.id, second, 'after switch']);
  });

  for (const revoke of ['membership', 'archive', 'unbind', 'rebind', 'deactivate', 'role'] as const) {
    test(`drops in-flight answers after ${revoke}`, async () => {
      const started = deferred<void>(); const release = deferred<string>();
      const s = setup(async () => { started.resolve(); return release.promise; });
      const projectId = s.project('private', s.bob.id);
      if (revoke === 'role') s.db.query("UPDATE users SET role = 'admin' WHERE id = ?").run(s.alice.id);
      else s.members.add(projectId, s.alice.id);
      const pending = s.chat.handle('ou_alice', 'question'); await started.promise;
      if (revoke === 'membership') s.members.remove(projectId, s.alice.id);
      if (revoke === 'archive') s.db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(projectId);
      if (revoke === 'unbind') s.users.setFeishuOpenid(s.alice.id, null);
      if (revoke === 'rebind') { s.users.setFeishuOpenid(s.alice.id, 'ou_new'); s.users.setFeishuOpenid(s.bob.id, 'ou_alice'); }
      if (revoke === 'deactivate') s.deactivate();
      if (revoke === 'role') s.db.query("UPDATE users SET role = 'user' WHERE id = ?").run(s.alice.id);
      release.resolve('confidential answer'); await pending;
      expect(s.sends).toEqual([]);
    });
  }

  test('queued inbound from a reassigned openid never runs as its new owner', async () => {
    const started = deferred<void>(); const release = deferred<string>();
    const s = setup(async () => { started.resolve(); return release.promise; }); s.project('private');
    const first = s.chat.handle('ou_alice', 'first'); await started.promise;
    const queued = s.chat.handle('ou_alice', 'queued');
    s.users.setFeishuOpenid(s.alice.id, 'ou_new'); s.users.setFeishuOpenid(s.bob.id, 'ou_alice');
    release.resolve('secret'); await Promise.all([first, queued]);
    expect(s.calls).toHaveLength(1); expect(s.sends).toEqual([]);
  });

  test('queued questions recheck membership before invoking the answer provider', async () => {
    const started = deferred<void>(); const release = deferred<string>();
    const s = setup(async () => { started.resolve(); return release.promise; });
    const id = s.project('shared', s.bob.id); s.members.add(id, s.alice.id);
    const first = s.chat.handle('ou_alice', 'first'); await started.promise;
    const queued = s.chat.handle('ou_alice', `#${id} queued`);
    s.members.remove(id, s.alice.id); release.resolve('secret');
    await Promise.all([first, queued]);
    expect(s.calls).toHaveLength(1);
    expect(s.sends).toHaveLength(1);
    expect(s.sends[0]!.text).toContain('unavailable');
    expect(s.sends[0]!.text).not.toContain('secret');
  });

  test('send failures do not poison the user queue', async () => {
    const s = setup(); const id = s.project('app');
    let fail = true; const sent: string[] = [];
    const chat = new PrivateChat({ db: s.db, answer: async () => 'answer',
      send: async (_target, text) => { if (fail) throw new Error('transport unavailable'); sent.push(text); } });
    await expect(chat.handle('ou_alice', `#${id} first`)).rejects.toThrow('transport unavailable');
    fail = false; await chat.handle('ou_alice', 'second');
    expect(sent).toHaveLength(1); expect(sent[0]).toContain('answer');
  });

  test('provider errors are localized and do not disclose raw errors or poison later requests', async () => {
    let fail = true;
    const s = setup(async () => { if (fail) throw new Error('secret-api-key'); return 'ok'; }); s.project('app');
    s.users.putSettings(s.alice.id, { locale: 'zh-Hans' });
    await s.chat.handle('ou_alice', 'question');
    expect(s.sends[0]!.text).toBe('暂时无法回答，请稍后重试。');
    fail = false; await s.chat.handle('ou_alice', 'retry');
    expect(s.sends[1]!.text).toContain('ok');
  });
});

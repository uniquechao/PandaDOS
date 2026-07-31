import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { SubscriptionStore } from '../../notify/router';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { subscriptionsRoutes, type FeishuBindVerifier } from './subscriptions';

// ---------- 测试环境 ----------

class FakeVerifier implements FeishuBindVerifier {
  calls: string[] = [];
  ok = true;
  async verifyBinding(openid: string): Promise<boolean> {
    this.calls.push(openid);
    return this.ok;
  }
}

function addProject(db: Database, ownerId: number, name: string): number {
  return (
    db
      .query<{ id: number }, [string, number, number]>(
        `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
         VALUES (?, 1, '/tmp', ?, ?) RETURNING id`,
      )
      .get(name, ownerId, Date.now())!.id
  );
}

function addIssue(db: Database, projectId: number): number {
  return (
    db
      .query<{ id: number }, [number, number]>(
        `INSERT INTO issues (project_id, title, created_ts) VALUES (?, 'T', ?) RETURNING id`,
      )
      .get(projectId, Date.now())!.id
  );
}

function makeApp(feishu: FeishuBindVerifier | null = new FakeVerifier()) {
  const db = openDb(':memory:');
  migrate(db);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('e', 'h', 22, 'u', 'k', '/w', '/c')`,
  );
  const users = new UserStore(db);
  const subs = new SubscriptionStore(db);
  const dispatch = createDispatcher(
    subscriptionsRoutes({ db, users, subs, feishu }),
    authDepsFromDb(db, users),
  );
  const admin = users.create('root', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  const pAlice = addProject(db, alice.user.id, 'pa');
  const pBob = addProject(db, bob.user.id, 'pb');
  const iAlice = addIssue(db, pAlice);
  const iBob = addIssue(db, pBob);
  return { db, users, subs, dispatch, admin, alice, bob, pAlice, pBob, iAlice, iBob };
}

function req(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Request {
  return new Request(`http://x${path}`, {
    method,
    headers: {
      ...(token ? { cookie: `${COOKIE}=${token}` } : {}),
      'content-type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ---------- 订阅校验矩阵 ----------

describe('POST /api/subscriptions（可见性矩阵）', () => {
  test('匿名 401', async () => {
    const { dispatch, pAlice } = makeApp();
    const r = await dispatch(req(null, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice }));
    expect(r!.status).toBe(401);
  });

  test('属主订阅自己项目/issue → 200；重复订阅幂等', async () => {
    const { dispatch, alice, pAlice, iAlice } = makeApp();
    const r1 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice }));
    expect(r1!.status).toBe(200);
    const s1 = ((await r1!.json()) as { subscription: { id: number } }).subscription;

    const r2 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice }));
    expect(((await r2!.json()) as { subscription: { id: number } }).subscription.id).toBe(s1.id);

    const r3 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'issue', targetId: iAlice }));
    expect(r3!.status).toBe(200);
  });

  test('普通用户订别人项目/issue → 403（issue 沿所属项目校验）', async () => {
    const { dispatch, alice, pBob, iBob } = makeApp();
    const r1 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pBob }));
    expect(r1!.status).toBe(403);
    const r2 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'issue', targetId: iBob }));
    expect(r2!.status).toBe(403);
  });

  test('成员可订所属项目/issue → 200（沿项目访问权放行，非仅属主）', async () => {
    const { db, dispatch, bob, pAlice, iAlice } = makeApp();
    // 未加入：bob 订 alice 的项目 → 403
    expect(
      (await dispatch(req(bob.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice })))!.status,
    ).toBe(403);
    // 关联 bob 为 pAlice 成员
    db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)').run(
      pAlice,
      bob.user.id,
    );
    // 加入后可订项目与其下 issue
    expect(
      (await dispatch(req(bob.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice })))!.status,
    ).toBe(200);
    expect(
      (await dispatch(req(bob.token, 'POST', '/api/subscriptions', { scope: 'issue', targetId: iAlice })))!.status,
    ).toBe(200);
  });

  test('不存在的目标：普通用户 403（不泄露存在性），admin 404', async () => {
    const { dispatch, alice, admin } = makeApp();
    const r1 = await dispatch(req(alice.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: 9999 }));
    expect(r1!.status).toBe(403);
    const r2 = await dispatch(req(admin.token, 'POST', '/api/subscriptions', { scope: 'issue', targetId: 9999 }));
    expect(r2!.status).toBe(404);
  });

  test('admin 可订任何人的项目/issue', async () => {
    const { dispatch, admin, pAlice, iBob } = makeApp();
    expect((await dispatch(req(admin.token, 'POST', '/api/subscriptions', { scope: 'project', targetId: pAlice })))!.status).toBe(200);
    expect((await dispatch(req(admin.token, 'POST', '/api/subscriptions', { scope: 'issue', targetId: iBob })))!.status).toBe(200);
  });

  test('畸形 body → 400（scope 非法/targetId 非正整数/非对象）', async () => {
    const { dispatch, alice, pAlice } = makeApp();
    for (const body of [
      { scope: 'user', targetId: pAlice },
      { scope: 'project', targetId: 0 },
      { scope: 'project', targetId: '1' },
      { scope: 'project', targetId: 1.5 },
      {},
      'nonsense',
    ]) {
      const r = await dispatch(req(alice.token, 'POST', '/api/subscriptions', body));
      expect(r!.status).toBe(400);
    }
  });
});

describe('DELETE /api/subscriptions + GET /api/me/subscriptions', () => {
  test('退订自己的订阅；removed 如实返回；清单只见自己的', async () => {
    const { dispatch, subs, alice, bob, pAlice, pBob } = makeApp();
    subs.add(alice.user.id, 'project', pAlice);
    subs.add(bob.user.id, 'project', pBob);

    const list = await dispatch(req(alice.token, 'GET', '/api/me/subscriptions'));
    const rows = (await list!.json()) as Array<{ userId: number; targetId: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetId).toBe(pAlice);

    const d1 = await dispatch(req(alice.token, 'DELETE', '/api/subscriptions', { scope: 'project', targetId: pAlice }));
    expect(((await d1!.json()) as { removed: boolean }).removed).toBe(true);
    const d2 = await dispatch(req(alice.token, 'DELETE', '/api/subscriptions', { scope: 'project', targetId: pAlice }));
    expect(((await d2!.json()) as { removed: boolean }).removed).toBe(false);

    // 退订不会误删别人的行
    expect(subs.listByUser(bob.user.id)).toHaveLength(1);
  });

  test('匿名 401', async () => {
    const { dispatch } = makeApp();
    expect((await dispatch(req(null, 'GET', '/api/me/subscriptions')))!.status).toBe(401);
    expect((await dispatch(req(null, 'DELETE', '/api/subscriptions', { scope: 'project', targetId: 1 })))!.status).toBe(401);
  });
});

// ---------- 飞书绑定 ----------

describe('POST /api/me/feishu', () => {
  test('测试消息可达 → 保存 openid', async () => {
    const fv = new FakeVerifier();
    const { dispatch, users, alice } = makeApp(fv);
    const r = await dispatch(req(alice.token, 'POST', '/api/me/feishu', { openid: 'ou_abc123' }));
    expect(r!.status).toBe(200);
    expect(fv.calls).toEqual(['ou_abc123']);
    expect(users.byId(alice.user.id)!.feishuOpenid).toBe('ou_abc123');
  });

  test('发送失败 → 502 且不保存（旧绑定不动 = 回滚语义）', async () => {
    const fv = new FakeVerifier();
    const { dispatch, users, alice } = makeApp(fv);
    users.setFeishuOpenid(alice.user.id, 'ou_old');
    fv.ok = false;
    const r = await dispatch(req(alice.token, 'POST', '/api/me/feishu', { openid: 'ou_new1' }));
    expect(r!.status).toBe(502);
    expect(users.byId(alice.user.id)!.feishuOpenid).toBe('ou_old');
  });

  test('格式非法 → 400 且不发测试消息', async () => {
    const fv = new FakeVerifier();
    const { dispatch, alice } = makeApp(fv);
    for (const openid of ['', 'ab', 'x'.repeat(65), '带 空格', '中文id', 42]) {
      const r = await dispatch(req(alice.token, 'POST', '/api/me/feishu', { openid }));
      expect(r!.status).toBe(400);
    }
    expect(fv.calls).toHaveLength(0);
  });

  test('openid:null 解绑（免验证）', async () => {
    const fv = new FakeVerifier();
    const { dispatch, users, alice } = makeApp(fv);
    users.setFeishuOpenid(alice.user.id, 'ou_old');
    const r = await dispatch(req(alice.token, 'POST', '/api/me/feishu', { openid: null }));
    expect(r!.status).toBe(200);
    expect(users.byId(alice.user.id)!.feishuOpenid).toBeNull();
    expect(fv.calls).toHaveLength(0);
  });

  test('飞书通道未配置 → 503', async () => {
    const { dispatch, alice } = makeApp(null);
    const r = await dispatch(req(alice.token, 'POST', '/api/me/feishu', { openid: 'ou_abc123' }));
    expect(r!.status).toBe(503);
  });

  test('匿名 401', async () => {
    const { dispatch } = makeApp();
    expect((await dispatch(req(null, 'POST', '/api/me/feishu', { openid: 'ou_abc123' })))!.status).toBe(401);
  });
});

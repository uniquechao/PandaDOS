import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import {
  GateRequestStore,
  NotifyRouter,
  SubscriptionStore,
  formatEventText,
  migrateNotify,
  type NotifyChannel,
  type NotifyEvent,
  type NotifyTarget,
} from './router';

// ---------- 种子 ----------

function makeDb(): Database {
  const db = openDb(':memory:');
  migrate(db);
  migrateNotify(db);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('e', 'h', 22, 'u', 'k', '/w', '/c')`,
  );
  return db;
}

function addProject(db: Database, ownerId: number, name = `p${Math.random()}`): number {
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

function addGate(db: Database, issueId: number): number {
  return (
    db
      .query<{ id: number }, [number]>(
        `INSERT INTO gates (issue_id, kind, payload_json) VALUES (?, 'plan', '{}') RETURNING id`,
      )
      .get(issueId)!.id
  );
}

// ---------- 假通道 ----------

class FakeChannel implements NotifyChannel {
  readonly name = 'feishu';
  texts: Array<{ target: NotifyTarget; text: string }> = [];
  cards: Array<{ target: NotifyTarget; event: NotifyEvent }> = [];
  failFor = new Set<number>(); // 对这些 userId 抛错
  async sendText(target: NotifyTarget, text: string): Promise<void> {
    if (this.failFor.has(target.userId)) throw new Error('boom');
    this.texts.push({ target, text });
  }
  async sendGateCard(target: NotifyTarget, event: NotifyEvent): Promise<void> {
    if (this.failFor.has(target.userId)) throw new Error('boom');
    this.cards.push({ target, event });
  }
}

function statusEvent(projectId: number, issueId: number, summary = 's'): NotifyEvent {
  return { kind: 'status_change', projectId, issueId, from: 'planning', to: 'plan_review', summary };
}

// ---------- 迁移 ----------

describe('migrateNotify', () => {
  test('应用 060 且幂等', () => {
    const db = makeDb();
    const s1 = migrateNotify(db);
    expect(s1.applied).toContain(60);
    const s2 = migrateNotify(db); // 重复执行不炸
    expect(s2.applied).toEqual(s1.applied);
    db.run(`INSERT INTO users (username, token_hash, role, created_ts) VALUES ('u', 'h', 'user', 0)`);
    // 表真的建出来了
    db.run(`SELECT request_id, gate_id, user_id, created_ts, consumed_ts FROM notify_gate_requests`);
  });
});

// ---------- SubscriptionStore ----------

describe('SubscriptionStore', () => {
  test('add 幂等 / remove / listByUser', () => {
    const db = makeDb();
    const users = new UserStore(db);
    const a = users.create('alice').user;
    const pid = addProject(db, a.id);
    const subs = new SubscriptionStore(db);

    const s1 = subs.add(a.id, 'project', pid);
    const s2 = subs.add(a.id, 'project', pid); // 重复订阅返回同一行
    expect(s2.id).toBe(s1.id);
    expect(subs.listByUser(a.id)).toHaveLength(1);

    expect(subs.remove(a.id, 'project', pid)).toBe(true);
    expect(subs.remove(a.id, 'project', pid)).toBe(false);
    expect(subs.listByUser(a.id)).toHaveLength(0);
  });

  test('subscriberIds：project ∪ issue 去重收敛', () => {
    const db = makeDb();
    const users = new UserStore(db);
    const a = users.create('alice').user;
    const b = users.create('bob').user;
    const pid = addProject(db, a.id);
    const iid = addIssue(db, pid);
    const subs = new SubscriptionStore(db);
    subs.add(a.id, 'project', pid);
    subs.add(a.id, 'issue', iid); // 双订阅 → 只一次
    subs.add(b.id, 'issue', iid);
    expect(subs.subscriberIds(pid, iid)).toEqual([a.id, b.id]);
    // 别的 issue：只有 project 订阅者
    expect(subs.subscriberIds(pid, iid + 999)).toEqual([a.id]);
  });

  test('ensureOwnerSubscription 幂等（建项目处的约定）', () => {
    const db = makeDb();
    const users = new UserStore(db);
    const a = users.create('alice').user;
    const pid = addProject(db, a.id);
    const subs = new SubscriptionStore(db);
    subs.ensureOwnerSubscription(pid, a.id);
    subs.ensureOwnerSubscription(pid, a.id);
    expect(subs.listByUser(a.id)).toHaveLength(1);
    expect(subs.subscriberIds(pid, 0)).toEqual([a.id]);
  });
});

// ---------- GateRequestStore：一次性语义 ----------

describe('GateRequestStore', () => {
  test('create→get→consume 一次；重放/未知 id 拒绝', () => {
    const db = makeDb();
    const users = new UserStore(db);
    const a = users.create('alice').user;
    const gid = addGate(db, addIssue(db, addProject(db, a.id)));
    const store = new GateRequestStore(db);

    const rid = store.create(gid, a.id);
    expect(store.get(rid)!.consumedTs).toBeNull();

    const c1 = store.consume(rid);
    expect(c1).toEqual({ gateId: gid, userId: a.id });
    expect(store.get(rid)!.consumedTs).not.toBeNull();

    expect(store.consume(rid)).toBeNull(); // 消费即失效
    expect(store.consume('no-such-id')).toBeNull();
  });

  test('同一 gate 可发多人多卡，各自独立一次性', () => {
    const db = makeDb();
    const users = new UserStore(db);
    const a = users.create('alice').user;
    const b = users.create('bob').user;
    const gid = addGate(db, addIssue(db, addProject(db, a.id)));
    const store = new GateRequestStore(db);
    const r1 = store.create(gid, a.id);
    const r2 = store.create(gid, b.id);
    expect(r1).not.toBe(r2);
    expect(store.consume(r1)).toEqual({ gateId: gid, userId: a.id });
    expect(store.consume(r2)).toEqual({ gateId: gid, userId: b.id }); // r1 消费不影响 r2
  });
});

// ---------- NotifyRouter.dispatch ----------

describe('NotifyRouter.dispatch', () => {
  function setup(throttleMs = 0) {
    const db = makeDb();
    const users = new UserStore(db);
    const alice = users.create('alice').user;
    const bob = users.create('bob').user;
    users.setFeishuOpenid(alice.id, 'ou_alice');
    const pid = addProject(db, alice.id);
    const iid = addIssue(db, pid);
    const router = new NotifyRouter(db, { throttleMs });
    const ch = new FakeChannel();
    router.register(ch);
    return { db, users, alice, bob, pid, iid, router, ch };
  }

  test('订阅解析：绑定用户收到，无绑定静默跳过，非订阅者不收', async () => {
    const { users, alice, bob, pid, iid, router, ch } = setup();
    users.create('carol'); // 不订阅
    router.subscriptions.add(alice.id, 'project', pid);
    router.subscriptions.add(bob.id, 'project', pid); // bob 未绑 openid

    await router.dispatch(statusEvent(pid, iid, '进度'));
    expect(ch.texts).toHaveLength(1);
    expect(ch.texts[0]!.target).toEqual({ userId: alice.id, address: 'ou_alice' });
    expect(ch.texts[0]!.text).toContain('进度');
    expect(ch.texts[0]!.text).toContain(`#${iid}`);
  });

  test('project+issue 双订阅去重：一个事件只发一条', async () => {
    const { alice, pid, iid, router, ch } = setup();
    router.subscriptions.add(alice.id, 'project', pid);
    router.subscriptions.add(alice.id, 'issue', iid);
    await router.dispatch(statusEvent(pid, iid));
    expect(ch.texts).toHaveLength(1);
  });

  test('gate_waiting 出确认卡（不聚合），缺 gate 降级文本', async () => {
    const { db, alice, pid, iid, router, ch } = setup();
    router.subscriptions.add(alice.id, 'project', pid);
    const gid = addGate(db, iid);
    await router.dispatch({
      kind: 'gate_waiting',
      projectId: pid,
      issueId: iid,
      gate: { id: gid, issueId: iid, kind: 'plan', status: 'waiting', payloadJson: '{}', decidedBy: null, decidedTs: null },
      summary: '计划待确认',
    });
    expect(ch.cards).toHaveLength(1);
    expect(ch.texts).toHaveLength(0);
    // 缺 gate 的 gate_waiting 走文本管道
    await router.dispatch({ kind: 'gate_waiting', projectId: pid, issueId: iid, summary: 'x' });
    expect(ch.texts).toHaveLength(1);
  });

  test('单用户发送失败不影响其他订阅者、不向上抛', async () => {
    const { users, alice, bob, pid, iid, router, ch } = setup();
    users.setFeishuOpenid(bob.id, 'ou_bob');
    router.subscriptions.add(alice.id, 'project', pid);
    router.subscriptions.add(bob.id, 'project', pid);
    ch.failFor.add(alice.id); // alice 在前（user_id 序），失败不拦 bob
    await router.dispatch(statusEvent(pid, iid));
    expect(ch.texts).toHaveLength(1);
    expect(ch.texts[0]!.target.userId).toBe(bob.id);
  });

  test('无订阅者/无通道：静默 no-op', async () => {
    const { pid, iid, router, ch } = setup();
    await router.dispatch(statusEvent(pid, iid)); // 无订阅
    expect(ch.texts).toHaveLength(0);
    const bare = new NotifyRouter(makeDb()); // 无通道
    await bare.dispatch(statusEvent(1, 1)); // 不炸
  });

  test('节流：窗口内聚合，窗口到期一次发出；窗口外直发', async () => {
    const { alice, pid, iid, router, ch } = setup(60);
    router.subscriptions.add(alice.id, 'project', pid);

    await router.dispatch(statusEvent(pid, iid, '第1条')); // 窗口外 → 直发
    await router.dispatch(statusEvent(pid, iid, '第2条')); // 窗口内 → 缓冲
    await router.dispatch(statusEvent(pid, iid, '第3条')); // 窗口内 → 缓冲
    expect(ch.texts).toHaveLength(1);
    expect(ch.texts[0]!.text).toContain('第1条');

    await Bun.sleep(120); // 窗口到期定时器触发
    expect(ch.texts).toHaveLength(2);
    expect(ch.texts[1]!.text).toContain('第2条');
    expect(ch.texts[1]!.text).toContain('第3条');
    router.stop();
  });

  test('节流：gate 卡直发并占用窗口，随后的文本进聚合', async () => {
    const { db, alice, pid, iid, router, ch } = setup(60);
    router.subscriptions.add(alice.id, 'project', pid);
    const gid = addGate(db, iid);
    await router.dispatch({
      kind: 'gate_waiting',
      projectId: pid,
      issueId: iid,
      gate: { id: gid, issueId: iid, kind: 'plan', status: 'waiting', payloadJson: '{}', decidedBy: null, decidedTs: null },
    });
    await router.dispatch(statusEvent(pid, iid, '卡后文本'));
    expect(ch.cards).toHaveLength(1);
    expect(ch.texts).toHaveLength(0); // 被卡占窗，进缓冲
    await router.flushAll(); // 手动冲缓冲（停机路径）
    expect(ch.texts).toHaveLength(1);
    expect(ch.texts[0]!.text).toContain('卡后文本');
    router.stop();
  });
});

// ---------- routeInbound ----------

describe('NotifyRouter.routeInbound', () => {
  function setup() {
    const db = makeDb();
    const users = new UserStore(db);
    const admin = users.create('root', 'admin').user;
    const alice = users.create('alice').user;
    const bob = users.create('bob').user;
    users.setFeishuOpenid(admin.id, 'ou_admin');
    users.setFeishuOpenid(alice.id, 'ou_alice');
    users.setFeishuOpenid(bob.id, 'ou_bob');
    const pid = addProject(db, alice.id, 'webapp');
    const router = new NotifyRouter(db);
    return { router, pid };
  }

  test('#id / #项目名 定位；属主与 admin 可达，非属主/未绑定/无前缀 null', async () => {
    const { router, pid } = setup();
    expect(await router.routeInbound('feishu', 'ou_alice', `#${pid} 进展如何`)).toBe(pid);
    expect(await router.routeInbound('feishu', 'ou_alice', '#webapp 进展如何')).toBe(pid);
    expect(await router.routeInbound('feishu', 'ou_admin', `#${pid} x`)).toBe(pid); // admin 全通
    expect(await router.routeInbound('feishu', 'ou_bob', `#${pid} x`)).toBeNull(); // 非属主
    expect(await router.routeInbound('feishu', 'ou_stranger', `#${pid} x`)).toBeNull(); // 未绑定
    expect(await router.routeInbound('feishu', 'ou_alice', '随便聊聊')).toBeNull(); // 无 # 前缀
    expect(await router.routeInbound('feishu', 'ou_alice', '#99999 x')).toBeNull(); // 不存在
    expect(await router.routeInbound('wechat', 'ou_alice', `#${pid} x`)).toBeNull(); // 非飞书通道
  });
});

// ---------- 文案渲染 ----------

describe('formatEventText', () => {
  test('四类事件确定性渲染', () => {
    expect(formatEventText({ kind: 'status_change', projectId: 1, issueId: 2, from: 'planning', to: 'testing' })).toContain(
      'planning → testing',
    );
    expect(formatEventText({ kind: 'issue_done', projectId: 1, issueId: 2, summary: 'T' })).toContain('完成');
    expect(formatEventText({ kind: 'issue_blocked', projectId: 1, issueId: 2 })).toContain('受阻');
    expect(formatEventText({ kind: 'gate_waiting', projectId: 1, issueId: 2 })).toContain('卡点');
  });
});

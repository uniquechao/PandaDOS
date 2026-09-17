import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { catalogs } from '../../shared/i18n/catalogs';
import { createI18n } from '../../shared/i18n/formatter';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import {
  GateRequestStore,
  NotifyRouter,
  SubscriptionStore,
  formatEventText,
  migrateNotify,
  userI18n,
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
  test('应用 063 且幂等', () => {
    const db = makeDb();
    const s1 = migrateNotify(db);
    expect(s1.applied).toContain(63);
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

/**
 * 等某个条件成立（节流窗口到期这类定时器驱动的断言用）。
 *
 * **不要用固定 `Bun.sleep(窗口 + 余量)`**：全量跑时几十个测试文件并行，事件循环被压住，
 * 定时器晚到几十毫秒是常事，固定睡眠就会变成偶发失败（本仓库实际发生过）。
 * 轮询到条件成立立刻返回，正常路径几乎不多花时间；超时才让断言去报错。
 */
async function waitUntil(ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ok() && Date.now() < deadline) await Bun.sleep(5);
}

// ---------- NotifyRouter.dispatch ----------

describe('NotifyRouter.dispatch', () => {
  function setup(throttleMs = 0) {
    const db = makeDb();
    const users = new UserStore(db);
    const alice = users.create('alice').user;
    const bob = users.create('bob').user;
    users.setFeishuOpenid(alice.id, 'ou_alice');
    const pid = addProject(db, alice.id);
    db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)').run(pid, bob.id);
    const iid = addIssue(db, pid);
    const router = new NotifyRouter(db, { throttleMs });
    const ch = new FakeChannel();
    router.register(ch);
    return { db, users, alice, bob, pid, iid, router, ch };
  }

  test('订阅解析：绑定用户收到，无绑定静默跳过，非订阅者不收', async () => {
    const { db, users, alice, bob, pid, iid, router, ch } = setup();
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

  test('同一结构化事件按收件人语言与时区分别渲染', async () => {
    const { db, users, alice, bob, pid, iid, router, ch } = setup();
    users.setFeishuOpenid(bob.id, 'ou_bob');
    users.putSettings(alice.id, { locale: 'en', timezone: 'Europe/Berlin' });
    users.putSettings(bob.id, { locale: 'ja', timezone: null, detectedTimezone: 'Asia/Tokyo' });
    router.subscriptions.add(alice.id, 'project', pid);
    router.subscriptions.add(bob.id, 'project', pid);
    await router.dispatch({ kind: 'issue_done', projectId: pid, issueId: iid, summary: 'T' });
    expect(ch.texts.find((x) => x.target.userId === alice.id)!.text).toContain('Done');
    expect(ch.texts.find((x) => x.target.userId === bob.id)!.text).toContain('完了');
    const ts = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(userI18n(db, alice.id).formatTime(ts)).not.toBe(userI18n(db, bob.id).formatTime(ts));
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

    await waitUntil(() => ch.texts.length >= 2); // 窗口到期定时器触发
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

  test('节流缓冲保存结构化事件，并在真正发送时读取最新语言', async () => {
    const { users, alice, pid, iid, router, ch } = setup(60_000);
    router.subscriptions.add(alice.id, 'project', pid);
    users.putSettings(alice.id, { locale: 'en' });
    await router.dispatch(statusEvent(pid, iid, 'first'));
    await router.dispatch({
      kind: 'status_change', projectId: pid, issueId: iid,
      summaryCode: 'plan_review', summaryParams: { title: 'OAuth login' },
    });
    expect(ch.texts).toHaveLength(1);

    users.putSettings(alice.id, { locale: 'ja' });
    await router.flushAll();

    expect(ch.texts).toHaveLength(2);
    expect(ch.texts[1]!.text).toContain('計画の確認待ち：OAuth login');
    expect(ch.texts[1]!.text).not.toContain('Plan awaiting confirmation');
    router.stop();
  });
});

describe('NotifyRouter authorization changes', () => {
  function setup() {
    const db = makeDb();
    const users = new UserStore(db);
    const owner = users.create('owner').user;
    const member = users.create('member').user;
    users.setFeishuOpenid(member.id, 'ou_member');
    const projectId = addProject(db, owner.id, 'shared app');
    const issueId = addIssue(db, projectId);
    db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)').run(projectId, member.id);
    const router = new NotifyRouter(db, { throttleMs: 60_000 });
    const channel = new FakeChannel(); router.register(channel);
    router.subscriptions.add(member.id, 'project', projectId);
    return { db, users, owner, member, projectId, issueId, router, channel };
  }

  test('members resolve exact names with spaces; archived projects and duplicate accessible names are rejected', async () => {
    const s = setup();
    expect(await s.router.routeInbound('feishu', 'ou_member', '#shared app question')).toBe(s.projectId);
    const other = addProject(s.db, s.member.id, 'shared app');
    expect(await s.router.routeInbound('feishu', 'ou_member', '#shared app question')).toBeNull();
    expect(await s.router.routeInbound('feishu', 'ou_member', `#${other} question`)).toBe(other);
    s.db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(other);
    expect(await s.router.routeInbound('feishu', 'ou_member', `#${other} question`)).toBeNull();
    expect(await s.router.routeInbound('feishu', 'ou_member', '#shared app question')).toBe(s.projectId);
    s.router.stop(); s.db.close();
  });

  for (const change of ['membership', 'archive', 'unbind', 'rebind', 'unregister', 'replace'] as const) {
    test(`buffered notifications do not leak after ${change}`, async () => {
      const s = setup();
      await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'first'));
      await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'confidential pending'));
      expect(s.channel.texts).toHaveLength(1);
      if (change === 'membership') s.db.query('DELETE FROM project_members WHERE user_id = ?').run(s.member.id);
      if (change === 'archive') s.db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(s.projectId);
      if (change === 'unbind') s.users.setFeishuOpenid(s.member.id, null);
      if (change === 'rebind') s.users.setFeishuOpenid(s.member.id, 'ou_new');
      if (change === 'unregister') s.router.unregister('feishu');
      const replacement = new FakeChannel();
      if (change === 'replace') s.router.register(replacement);
      await s.router.flushAll();
      expect(s.channel.texts).toHaveLength(1);
      expect(replacement.texts).toEqual([]);
      s.router.stop(); s.db.close();
    });
  }

  test('stale subscriptions cannot authorize text or gate delivery', async () => {
    const s = setup();
    s.db.query('DELETE FROM project_members WHERE user_id = ?').run(s.member.id);
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'private'));
    const gid = addGate(s.db, s.issueId);
    await s.router.dispatch({ kind: 'gate_waiting', projectId: s.projectId, issueId: s.issueId,
      gate: { id: gid, issueId: s.issueId, kind: 'plan', status: 'waiting', payloadJson: '{}', decidedBy: null, decidedTs: null } });
    expect(s.channel.texts).toEqual([]); expect(s.channel.cards).toEqual([]);
    s.router.stop(); s.db.close();
  });

  test('flush filters projects separately and retains still-authorized notifications', async () => {
    const s = setup(); const own = addProject(s.db, s.member.id, 'own'); const ownIssue = addIssue(s.db, own);
    s.router.subscriptions.add(s.member.id, 'project', own);
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'first'));
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'revoked-secret'));
    await s.router.dispatch(statusEvent(own, ownIssue, 'allowed-progress'));
    s.db.query('DELETE FROM project_members WHERE user_id = ?').run(s.member.id);
    await s.router.flushAll();
    expect(s.channel.texts).toHaveLength(2);
    expect(s.channel.texts[1]!.text).toContain('allowed-progress');
    expect(s.channel.texts[1]!.text).not.toContain('revoked-secret');
    s.router.stop(); s.db.close();
  });

  test('rebind followed by new dispatch discards the previous recipient buffer', async () => {
    const s = setup();
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'first'));
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'old-secret'));
    s.users.setFeishuOpenid(s.member.id, 'ou_new');
    await s.router.dispatch(statusEvent(s.projectId, s.issueId, 'new-progress'));
    await s.router.flushAll();
    expect(s.channel.texts).toHaveLength(2);
    expect(s.channel.texts[1]!.target.address).toBe('ou_new');
    expect(s.channel.texts[1]!.text).toContain('new-progress');
    expect(s.channel.texts[1]!.text).not.toContain('old-secret');
    s.router.stop(); s.db.close();
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
    const i18n = userI18n(makeDb(), 0);
    expect(formatEventText({ kind: 'status_change', projectId: 1, issueId: 2, from: 'planning', to: 'testing' }, i18n)).toContain(
      'Planning → Testing',
    );
    expect(formatEventText({ kind: 'issue_done', projectId: 1, issueId: 2, summary: 'T' }, i18n)).toContain('Done');
    expect(formatEventText({ kind: 'issue_blocked', projectId: 1, issueId: 2 }, i18n)).toContain('Blocked');
    expect(formatEventText({ kind: 'gate_waiting', projectId: 1, issueId: 2 }, i18n)).toContain('awaiting confirmation');
  });

  test('结构化业务摘要按收件人语言最终渲染', () => {
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: catalogs.en });
    const ja = createI18n({ locale: 'ja', timeZone: 'UTC', catalog: catalogs.ja });
    const event = {
      kind: 'gate_waiting' as const,
      projectId: 1,
      issueId: 2,
      summaryCode: 'plan_review' as const,
      summaryParams: { title: 'OAuth login' },
    };

    expect(formatEventText(event, en)).toContain('Plan awaiting confirmation: OAuth login');
    expect(formatEventText(event, ja)).toContain('計画の確認待ち：OAuth login');
    expect(formatEventText(event, ja)).not.toContain('计划待确认');
  });

  test('状态变更摘要本地化状态名但保留 issue 标题原文', () => {
    const ja = createI18n({ locale: 'ja', timeZone: 'UTC', catalog: catalogs.ja });
    const text = formatEventText({
      kind: 'status_change',
      projectId: 1,
      issueId: 2,
      from: 'planning',
      to: 'testing',
      summaryCode: 'status_transition',
      summaryParams: { title: '修复 OAuth' },
    }, ja);

    expect(text).toContain('修复 OAuth：計画中 → テスト中');
  });

  test('进度回复提示与人工选择说明本地化，AI/CLI 原文保持不变', () => {
    const ja = createI18n({ locale: 'ja', timeZone: 'UTC', catalog: catalogs.ja });
    const progress = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'progress_needs_reply',
      summaryParams: { emoji: '💬', headline: 'Raw AI headline' },
    }, ja);
    const approval = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'approval_selection',
      summaryParams: { context: 'rm -rf build?' },
    }, ja);

    expect(progress).toContain('Raw AI headline（返信待ち）');
    expect(approval).toContain('選択が必要です：rm -rf build?');
  });

  // #275 / B-07：弹窗等人选不是「受阻」，两种通知的前缀与语气必须分开
  test('choice_waiting 用「等你选择」的文案，与 issue_blocked 明确区分', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: catalogs['zh-Hans'] });
    const base = { projectId: 1, issueId: 7, summaryCode: 'menu_stuck' as const,
      summaryParams: { minutes: 5, context: 'rm -rf build?' } };

    const choice = formatEventText({ kind: 'choice_waiting', ...base }, zh);
    const blocked = formatEventText({ kind: 'issue_blocked', ...base }, zh);

    expect(choice).toContain('等你选择');
    expect(choice).not.toContain('受阻');
    expect(blocked).toContain('受阻');
    // 两者都带上具体上下文，用户不用点进去也知道在等什么
    expect(choice).toContain('rm -rf build?');
    expect(choice).toContain('#7');
  });

  // #274 止损闸：花销触顶主动停下，不是执行失败——三种触发原因各渲染一次
  test('止损暂停：三种触发原因分别渲染，并说清「没失败也没取消」', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: catalogs['zh-Hans'] });
    const render = (reason: string, params: Record<string, string | number>) => formatEventText({
      kind: 'issue_blocked', projectId: 1, issueId: 2,
      summaryCode: 'stop_loss_paused',
      summaryParams: { title: '导出功能', reason, blocks: 0, reentries: 0, hours: 0, ...params },
    }, zh);

    expect(render('blocked', { blocks: 3 })).toContain('累计受阻 3 次');
    expect(render('stage_reentry', { reentries: 3 })).toContain('同阶段重入 3 次');
    expect(render('runtime', { hours: 4.2 })).toContain('累计运行 4.2 小时');
    // 三种原因都必须带上这句：停下来 ≠ 失败，否则用户会去找一个不存在的报错
    for (const reason of ['blocked', 'stage_reentry', 'runtime']) {
      expect(render(reason, {})).toContain('没有失败，也没有取消');
      expect(render(reason, {})).toContain('确认后可从停下的那个阶段继续');
    }
    // issue 标题是用户原文，原样透传
    expect(render('blocked', { blocks: 3 })).toContain('导出功能');
  });

  // #280：创建时澄清一直失败——「一直烧钱、一直没产出」，文案要把这点说出来
  test('澄清成功率告警：带上 ok/total，并说明每次白跑照付通读代码库的钱', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: catalogs['zh-Hans'] });
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: catalogs.en });
    const event = {
      kind: 'status_change' as const, projectId: 1, issueId: 9,
      summaryCode: 'clarify_success_low' as const,
      summaryParams: { project: 'panda', ok: 1, total: 10 },
    };
    const zhText = formatEventText(event, zh);
    expect(zhText).toContain('panda');
    expect(zhText).toContain('最近 10 次只成功 1 次');
    expect(zhText).toContain('通读代码库');
    expect(formatEventText(event, en)).toContain('1/10');
  });

  // #279：批次全量回归红了——不是某条 issue 的失败，也没建 issue，文案必须把这两点说清
  test('回归失败通知：说清没建 issue、没人被阻塞，项目名与命令名原样透传', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: catalogs['zh-Hans'] });
    const en = createI18n({ locale: 'en', timeZone: 'UTC', catalog: catalogs.en });
    const event = {
      kind: 'issue_blocked' as const, projectId: 1, issueId: 42,
      summaryCode: 'regression_failed' as const,
      summaryParams: { project: 'panda', label: 'bun run test', code: 1 },
    };

    const zhText = formatEventText(event, zh);
    expect(zhText).toContain('panda');
    expect(zhText).toContain('bun run test'); // 命令名是原文，不翻译
    expect(zhText).toContain('没有建 issue');
    expect(zhText).toContain('没有任何任务被阻塞');

    const enText = formatEventText(event, en);
    expect(enText).toContain('No issue was created');
    expect(enText).toContain('exit code: 1');
  });

  // #273：nudge / judge 自动重试到顶转人工。issue 未 block，文案必须说清「仍在运行」
  test('自动重试到顶：reason 选词与 count 复数按语言渲染，issue 标题保持原文', () => {
    const zh = createI18n({ locale: 'zh-Hans', timeZone: 'UTC', catalog: catalogs['zh-Hans'] });
    const nudge = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'auto_retry_exhausted',
      summaryParams: { title: '导出功能', reason: 'nudge', count: 5 },
    }, zh);
    const judge = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'auto_retry_exhausted',
      summaryParams: { title: '导出功能', reason: 'judge', count: 10 },
    }, zh);

    expect(nudge).toContain('导出功能：自动催办连续 5 次没有进展，已停止。');
    expect(nudge).toContain('未被阻塞'); // 不是 blocked，别让人以为任务死了
    expect(judge).toContain('完成判定连续 10 次没有进展');

    // 俄语复数走 ICU few/many，不是把英文数量拼进去
    const ru = createI18n({ locale: 'ru', timeZone: 'UTC', catalog: catalogs.ru });
    const one = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'auto_retry_exhausted',
      summaryParams: { title: 'Экспорт', reason: 'nudge', count: 1 },
    }, ru);
    const many = formatEventText({
      kind: 'status_change', projectId: 1, issueId: 2,
      summaryCode: 'auto_retry_exhausted',
      summaryParams: { title: 'Экспорт', reason: 'nudge', count: 5 },
    }, ru);
    expect(one).toContain('после 1 попытки');
    expect(many).toContain('после 5 попыток');
  });
});

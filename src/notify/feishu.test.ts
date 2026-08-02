import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { catalogs } from '../../shared/i18n/catalogs';
import { createI18n } from '../../shared/i18n/formatter';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { migrateNotify, type NotifyEvent } from './router';
import {
  BIND_TEST_TEXT,
  CARD_REJECT_NOTE,
  FeishuChannel,
  type FeishuEventHandlers,
  type FeishuMessageCreateArgs,
  type FeishuSdk,
  type FeishuToast,
} from './feishu';

// ---------- SDK 全 mock（铁律） ----------

function fakeSdk() {
  const sent: FeishuMessageCreateArgs[] = [];
  let handlers: FeishuEventHandlers | null = null;
  const state = { fail: false, connects: 0, stopped: 0 };
  const sdk: FeishuSdk = {
    async connect(_cfg, h) {
      state.connects++;
      handlers = h;
      return {
        client: {
          im: {
            v1: {
              message: {
                create: async (args: FeishuMessageCreateArgs) => {
                  if (state.fail) throw new Error('net down');
                  sent.push(args);
                  return {};
                },
              },
            },
          },
        },
        stop: () => {
          state.stopped++;
        },
      };
    },
  };
  return { sdk, sent, state, handlers: () => handlers! };
}

// ---------- 种子 ----------

function seed() {
  const db: Database = openDb(':memory:');
  migrate(db);
  migrateNotify(db);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('e', 'h', 22, 'u', 'k', '/w', '/c')`,
  );
  const users = new UserStore(db);
  const alice = users.create('alice').user;
  const bob = users.create('bob').user;
  users.setFeishuOpenid(alice.id, 'ou_alice');
  users.setFeishuOpenid(bob.id, 'ou_bob');
  const pid = db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p', 1, '/tmp', ?, ?) RETURNING id`,
    )
    .get(alice.id, Date.now())!.id;
  const iid = db
    .query<{ id: number }, [number, number]>(
      `INSERT INTO issues (project_id, title, created_ts) VALUES (?, '加登录', ?) RETURNING id`,
    )
    .get(pid, Date.now())!.id;
  const gid = db
    .query<{ id: number }, [number, string]>(
      `INSERT INTO gates (issue_id, kind, payload_json) VALUES (?, 'plan', ?) RETURNING id`,
    )
    .get(iid, JSON.stringify({ subtasks: ['写表', '写接口'], implMode: 'seq' }))!.id;
  return { db, users, alice, bob, pid, iid, gid };
}

interface Wired {
  ch: FeishuChannel;
  fk: ReturnType<typeof fakeSdk>;
  decided: Array<{ gateId: number; userId: number; action: string; note?: string }>;
  inbound: Array<{ openid: string; text: string }>;
  selections: Array<{ requestId: string; optionIndex: number; openid: string }>;
  setDecideResult(r: { ok: boolean; error?: string }): void;
}

async function wire(db: Database, opts: { noDecide?: boolean } = {}): Promise<Wired> {
  const fk = fakeSdk();
  const decided: Wired['decided'] = [];
  const inbound: Wired['inbound'] = [];
  const selections: Wired['selections'] = [];
  let decideResult: { ok: boolean; error?: string } = { ok: true };
  const ch = new FeishuChannel(
    { appId: 'app', appSecret: 'sec' },
    {
      db,
      sdk: fk.sdk,
      ...(opts.noDecide
        ? {}
        : {
            decideGate: async (gateId, userId, action, note) => {
              decided.push({ gateId, userId, action, ...(note !== undefined ? { note } : {}) });
              return decideResult;
            },
          }),
      onInbound: (openid, text) => inbound.push({ openid, text }),
      onSelection: (requestId, optionIndex, openid) => selections.push({ requestId, optionIndex, openid }),
    },
  );
  await ch.start();
  return { ch, fk, decided, inbound, selections, setDecideResult: (r) => (decideResult = r) };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function cardOf(args: FeishuMessageCreateArgs): any {
  return JSON.parse(args.data.content);
}

function gateEvent(s: ReturnType<typeof seed>): NotifyEvent {
  return {
    kind: 'gate_waiting',
    projectId: s.pid,
    issueId: s.iid,
    gate: {
      id: s.gid,
      issueId: s.iid,
      kind: 'plan',
      status: 'waiting',
      payloadJson: JSON.stringify({ subtasks: ['写表', '写接口'], implMode: 'seq' }),
      decidedBy: null,
      decidedTs: null,
    },
    summary: '计划待确认：加登录',
  };
}

async function clickGate(w: Wired, openid: string, requestId: string, action: string): Promise<FeishuToast> {
  return (await w.fk.handlers().onCard({
    operator: { open_id: openid },
    action: { value: { forge: 'gate', requestId, action } },
  })) as FeishuToast;
}

// ---------- 收发 ----------

describe('FeishuChannel 收发（SDK mock）', () => {
  test('start 建长连；sendText 走 open_id 文本消息；stop 断开', async () => {
    const s = seed();
    const w = await wire(s.db);
    expect(w.fk.state.connects).toBe(1);
    await w.ch.sendText({ userId: s.alice.id, address: 'ou_alice' }, '你好');
    expect(w.fk.sent).toHaveLength(1);
    const m = w.fk.sent[0]!;
    expect(m.params.receive_id_type).toBe('open_id');
    expect(m.data.receive_id).toBe('ou_alice');
    expect(m.data.msg_type).toBe('text');
    expect(JSON.parse(m.data.content)).toEqual({ text: '你好' });
    await w.ch.stop();
    expect(w.fk.state.stopped).toBe(1);
  });

  test('未 start 时发送显式报错（不再 v1 式静默降级）', async () => {
    const s = seed();
    const ch = new FeishuChannel({ appId: 'a', appSecret: 's' }, { db: s.db });
    expect(ch.sendText({ userId: 1, address: 'x' }, 'hi')).rejects.toThrow('未连接');
  });

  test('入站：text 解析正文；非文本降级占位', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.fk.handlers().onInbound({
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: { message_type: 'text', content: JSON.stringify({ text: ' 进展如何 ' }) },
    });
    await w.fk.handlers().onInbound({
      sender: { sender_id: { open_id: 'ou_alice' } },
      message: { message_type: 'image', content: '{}' },
    });
    await w.fk.handlers().onInbound({ message: { message_type: 'text', content: '{}' } }); // 无 openid：丢
    expect(w.inbound).toEqual([
      { openid: 'ou_alice', text: '进展如何' },
      { openid: 'ou_alice', text: '[image]' },
    ]);
  });

  test('verifyBinding：可达 true；发送失败 false（调用方不落库）', async () => {
    const s = seed();
    const w = await wire(s.db);
    expect(await w.ch.verifyBinding('ou_new')).toBe(true);
    expect(w.fk.sent[0]!.data.receive_id).toBe('ou_new');
    expect(JSON.parse(w.fk.sent[0]!.data.content).text).toBe(BIND_TEST_TEXT);
    w.fk.state.fail = true;
    expect(await w.ch.verifyBinding('ou_bad')).toBe(false);
  });
});

// ---------- 卡点确认卡 ----------

describe('卡点确认卡（一次性 requestId）', () => {
  test('sendGateCard：requestId 落库并进两按钮 value；摘要含计划', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    expect(w.fk.sent).toHaveLength(1);
    expect(w.fk.sent[0]!.data.msg_type).toBe('interactive');
    const card = cardOf(w.fk.sent[0]!);
    const actions = card.elements.find((e: any) => e.tag === 'action').actions;
    expect(actions).toHaveLength(2);
    const rid = actions[0].value.requestId as string;
    expect(actions[0].value).toEqual({ forge: 'gate', requestId: rid, action: 'approve' });
    expect(actions[1].value).toEqual({ forge: 'gate', requestId: rid, action: 'reject' });
    expect(JSON.stringify(card)).toContain('写表'); // 计划摘要进卡
    expect(JSON.stringify(card)).toContain('计划待确认');
    // requestId 已登记且绑定发卡对象
    const row = w.ch.requests.get(rid)!;
    expect(row.gateId).toBe(s.gid);
    expect(row.userId).toBe(s.alice.id);
    expect(row.consumedTs).toBeNull();
  });

  test('结构化卡片摘要按收件人语言渲染', async () => {
    const s = seed();
    const w = await wire(s.db);
    const event = gateEvent(s);
    delete event.summary;
    event.summaryCode = 'plan_review';
    event.summaryParams = { title: 'OAuth login' };
    const ja = createI18n({ locale: 'ja', timeZone: 'Asia/Tokyo', catalog: catalogs.ja });

    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, event, ja);

    const text = JSON.stringify(cardOf(w.fk.sent[0]!));
    expect(text).toContain('計画の確認待ち：OAuth login');
    expect(text).not.toContain('计划待确认');
  });

  test('缺 gate 详情降级为文本提醒', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.ch.sendGateCard(
      { userId: s.alice.id, address: 'ou_alice' },
      { kind: 'gate_waiting', projectId: s.pid, issueId: s.iid, summary: '待确认' },
    );
    expect(w.fk.sent[0]!.data.msg_type).toBe('text');
  });

  test('approve 点击：转发 decideGate + success toast；重放拒绝（一次性语义）', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    const rid = cardOf(w.fk.sent[0]!).elements.find((e: any) => e.tag === 'action').actions[0].value.requestId;

    const t1 = await clickGate(w, 'ou_alice', rid, 'approve');
    expect(t1.toast.type).toBe('success');
    expect(w.decided).toEqual([{ gateId: s.gid, userId: s.alice.id, action: 'approve' }]);

    const t2 = await clickGate(w, 'ou_alice', rid, 'approve'); // 重放
    expect(t2.toast.type).toBe('error');
    expect(t2.toast.content).toContain('already handled');
    expect(w.decided).toHaveLength(1); // 引擎只被调一次
  });

  test('reject 点击：带默认意见转发（引擎要求 reject 必附 note）', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    const rid = cardOf(w.fk.sent[0]!).elements.find((e: any) => e.tag === 'action').actions[0].value.requestId;
    const t = await clickGate(w, 'ou_alice', rid, 'reject');
    expect(t.toast.type).toBe('success');
    expect(w.decided).toEqual([
      { gateId: s.gid, userId: s.alice.id, action: 'reject', note: CARD_REJECT_NOTE },
    ]);
  });

  test('操作者校验：别人点不消费 requestId，本人随后仍可用', async () => {
    const s = seed();
    const w = await wire(s.db);
    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    const rid = cardOf(w.fk.sent[0]!).elements.find((e: any) => e.tag === 'action').actions[0].value.requestId;

    const t1 = await clickGate(w, 'ou_bob', rid, 'approve'); // bob 点 alice 的卡
    expect(t1.toast.type).toBe('error');
    expect(t1.toast.content).toContain('not sent to you');
    expect(w.decided).toHaveLength(0);
    expect(w.ch.requests.get(rid)!.consumedTs).toBeNull(); // 未被烧掉

    const t2 = await clickGate(w, 'ou_alice', rid, 'approve');
    expect(t2.toast.type).toBe('success');
  });

  test('引擎拒绝（如网页已先处理）时 toast 如实报错——不再恒 success', async () => {
    const s = seed();
    const w = await wire(s.db);
    w.setDecideResult({ ok: false, error: '卡点已处理过' });
    await w.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    const rid = cardOf(w.fk.sent[0]!).elements.find((e: any) => e.tag === 'action').actions[0].value.requestId;
    const t = await clickGate(w, 'ou_alice', rid, 'approve');
    expect(t.toast.type).toBe('error');
    expect(t.toast.content).toContain('卡点已处理过');
  });

  test('未知 requestId / 畸形 value / 未接线 decideGate 均报错 toast', async () => {
    const s = seed();
    const w = await wire(s.db);
    expect((await clickGate(w, 'ou_alice', 'g-nope', 'approve')).toast.type).toBe('error');
    const bad = (await w.fk.handlers().onCard({
      operator: { open_id: 'ou_alice' },
      action: { value: { forge: 'gate', requestId: 123, action: 'boom' } },
    })) as FeishuToast;
    expect(bad.toast.type).toBe('error');

    const w2 = await wire(s.db, { noDecide: true });
    await w2.ch.sendGateCard({ userId: s.alice.id, address: 'ou_alice' }, gateEvent(s));
    const rid = cardOf(w2.fk.sent[0]!).elements.find((e: any) => e.tag === 'action').actions[0].value.requestId;
    const t = await clickGate(w2, 'ou_alice', rid, 'approve');
    expect(t.toast.type).toBe('error');
    expect(t.toast.content).toContain('unavailable');
  });
});

// ---------- v1 选择卡回调兼容 ----------

describe('selection 回调（v1 兼容 + 严格校验）', () => {
  test('合法点击转发 onSelection；畸形 optionIndex 拒绝（不再 ||0 误选第 1 项）', async () => {
    const s = seed();
    const w = await wire(s.db);
    const ok = (await w.fk.handlers().onCard({
      operator: { open_id: 'ou_alice' },
      action: { value: { forge: 'selection', requestId: 'r1', optionIndex: 2 } },
    })) as FeishuToast;
    expect(ok.toast.type).toBe('success');
    expect(w.selections).toEqual([{ requestId: 'r1', optionIndex: 2, openid: 'ou_alice' }]);

    for (const idx of ['2', 1.5, -1, null, undefined]) {
      const t = (await w.fk.handlers().onCard({
        operator: { open_id: 'ou_alice' },
        action: { value: { forge: 'selection', requestId: 'r1', optionIndex: idx } },
      })) as FeishuToast;
      expect(t.toast.type).toBe('error');
    }
    expect(w.selections).toHaveLength(1);
  });

  test('未知 forge 忽略（undefined，不出 toast）', async () => {
    const s = seed();
    const w = await wire(s.db);
    const r = await w.fk.handlers().onCard({ operator: { open_id: 'x' }, action: { value: { forge: 'other' } } });
    expect(r).toBeUndefined();
  });
});

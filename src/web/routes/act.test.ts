/**
 * /api/projects/:projectId/act 测试（Wave3 任务 B 的可靠 HTTP 版）：
 * - 鉴权矩阵（project-owner）：未登录 401 / 错属主 403 / 属主与 admin 放行；
 * - text/key/select 三动作语义（与 WS 帧一致）；
 * - select：无菜单 409 / sig 不符 409 stale / 正常相对导航注入；
 * - requestId：走审批管道消费口（expectSession 带项目会话名）；
 * - 注入串行：两条并发 act 对同一会话经 KeyedMutex 严格串行（评审 H9）。
 */
import { describe, expect, test } from 'bun:test';
import { MessageCounter } from '../../core/activity';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { KEY_WHITELIST } from '../../executor/driver';
import { KeyedMutex } from '../../issues/mutex';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { actRoutes } from './act';

const MENU = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No';
const MENU_SIG = 'Yes|No@0';

/** issue #94/#95：AskUserQuestion 菜单（每项带说明行，末两项之间夹分隔线） */
const ASK_MENU = [
  ' ☐ 盒子朝向',
  '',
  '盒子上到皮带时的朝向是基本固定，还是每个盒子都会变？',
  '',
  '❯ 1. 朝向基本固定',
  '     轴对齐皮带，偏移用常量向量加法即可。',
  '  2. 每个盒子朝向都会变',
  '     偏移要随盒姿态旋转。',
  '  3. 不确定，先按固定做',
  '     先落地常量偏移，后续再扩展。',
  '  4. Type something.',
  '──────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
const ASK_MENU_SIG = '朝向基本固定|每个盒子朝向都会变|不确定，先按固定做|Type something.|Chat about this@0';

class FakeMenuDriver {
  pane = '';
  keys: string[] = [];
  sent: string[] = [];
  sendKeysDelayMs = 0;
  active = 0;
  maxActive = 0;
  async capturePane(): Promise<string> {
    return this.pane;
  }
  async sendKey(_s: string, key: string): Promise<void> {
    if (!KEY_WHITELIST.has(key)) throw new Error(`key not in whitelist: ${key}`);
    this.keys.push(key);
  }
  async sendKeys(_s: string, text: string): Promise<void> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.sendKeysDelayMs) await new Promise((r) => setTimeout(r, this.sendKeysDelayMs));
    this.sent.push(text);
    this.active--;
  }
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const { user: admin, token: adminToken } = users.create('admin', 'admin');
  const { user: alice, token: aliceToken } = users.create('alice');
  const { token: bobToken } = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', '/tmp/ws', '/tmp/claude')`,
  );
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
     VALUES ('demo', 1, '/tmp/repo', ?, ?)`,
  ).run(alice.id, Date.now());

  const driver = new FakeMenuDriver();
  const consumeCalls: Array<{ requestId: string; index: number; expectSession?: string }> = [];
  let consumeResult: { ok: boolean; reason?: 'expired' | 'no_menu' | 'stale' | 'out_of_range' | 'forbidden' } = { ok: true };
  const approvals = {
    async consume(requestId: string, index: number, opts?: { expectSession?: string }) {
      consumeCalls.push({ requestId, index, ...(opts?.expectSession ? { expectSession: opts.expectSession } : {}) });
      return consumeResult;
    },
  };
  const messages = new MessageCounter(db);
  const dispatch = createDispatcher(
    actRoutes({
      db,
      convs: { tmuxName: (pid) => `cc-${pid}` },
      mutex: new KeyedMutex(),
      driverForProject: () => driver,
      approvals,
      retryDelayMs: 1,
      messages,
    }),
    authDepsFromDb(db, users),
  );

  const act = async (token: string | null, body: unknown, pid = 1) => {
    const req = new Request(`http://x/api/projects/${pid}/act`, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const r = dispatch(req);
    if (!r) throw new Error('路由未命中');
    const resp = await r;
    return { status: resp.status, body: (await resp.json()) as Record<string, unknown> };
  };

  return { db, admin, alice, adminToken, aliceToken, bobToken, driver, act, consumeCalls, messages, setConsume: (v: typeof consumeResult) => (consumeResult = v) };
}

describe('act 路由：鉴权矩阵（project-owner）', () => {
  test('未登录 401 / 错属主 403 / 属主 200 / admin 200 / 项目不存在 admin 404', async () => {
    const t = setup();
    expect((await t.act(null, { type: 'text', text: 'hi' })).status).toBe(401);
    expect((await t.act(t.bobToken, { type: 'text', text: 'hi' })).status).toBe(403);
    expect((await t.act(t.aliceToken, { type: 'text', text: 'hi' })).status).toBe(200);
    expect((await t.act(t.adminToken, { type: 'text', text: 'hi' })).status).toBe(200);
    expect((await t.act(t.bobToken, { type: 'text', text: 'hi' }, 999)).status).toBe(403); // 不泄露存在性
    expect((await t.act(t.adminToken, { type: 'text', text: 'hi' }, 999)).status).toBe(404);
    expect(t.driver.sent).toEqual(['hi', 'hi']); // 只有放行的两次注入
  });
});

describe('act 路由：动作语义', () => {
  test('text：注入项目 cc 会话；空文本/未知动作 400', async () => {
    const t = setup();
    expect((await t.act(t.aliceToken, { type: 'text', text: '  修复它  ' })).status).toBe(200);
    expect(t.driver.sent).toEqual(['  修复它  ']); // 净化在 Driver 层做（这里原样透传）
    expect((await t.act(t.aliceToken, { type: 'text', text: '   ' })).status).toBe(400);
    expect((await t.act(t.aliceToken, { type: 'nope' })).status).toBe(400);
  });

  test('text 注入成功计入用户消息数（013）；空文本/按键/注入失败都不计', async () => {
    const t = setup();
    await t.act(t.aliceToken, { type: 'text', text: '修复它' });
    await t.act(t.aliceToken, { type: 'text', text: '再来一句' });
    expect(t.messages.countsFor(t.alice.id)).toEqual({ today: 2, total: 2 });

    await t.act(t.aliceToken, { type: 'text', text: '   ' }); // 400 空文本
    await t.act(t.aliceToken, { type: 'key', key: 'Escape' }); // 按键不是消息
    expect(t.messages.countsFor(t.alice.id)).toEqual({ today: 2, total: 2 });

    t.driver.sendKeys = async () => {
      throw new Error('tmux 挂了');
    };
    expect((await t.act(t.aliceToken, { type: 'text', text: '发不出去' })).status).toBe(502);
    expect(t.messages.countsFor(t.alice.id)).toEqual({ today: 2, total: 2 }); // 没发出去不算

    // 归属到发消息的人：admin 代发不会记到项目属主头上
    await t.act(t.adminToken, { type: 'text', text: 'admin 发的' }).catch(() => undefined);
    expect(t.messages.countsFor(t.alice.id).total).toBe(2);
  });

  test('key：白名单键放行、越权键 400', async () => {
    const t = setup();
    expect((await t.act(t.aliceToken, { type: 'key', key: 'Escape' })).status).toBe(200);
    expect(t.driver.keys).toEqual(['Escape']);
    const bad = await t.act(t.aliceToken, { type: 'key', key: 'F12' });
    expect(bad.status).toBe(400);
    expect(t.driver.keys).toEqual(['Escape']);
  });

  test('select：无菜单 409；sig 不符 409 stale；命中后相对导航注入', async () => {
    const t = setup();
    const r1 = await t.act(t.aliceToken, { type: 'select', index: 1 });
    expect(r1.status).toBe(409); // 无菜单

    t.driver.pane = MENU;
    const r2 = await t.act(t.aliceToken, { type: 'select', index: 1, sig: 'Old|Menu@0' });
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('stale'); // 注入前重抓核对（评审 H9）
    expect(t.driver.keys).toEqual([]);

    const r3 = await t.act(t.aliceToken, { type: 'select', index: 1, sig: MENU_SIG });
    expect(r3.status).toBe(200);
    expect(r3.body.option).toBe('No');
    expect(t.driver.keys).toEqual(['Down', 'Enter']);

    const r4 = await t.act(t.aliceToken, { type: 'select', index: 9, sig: MENU_SIG });
    expect(r4.status).toBe(400); // 选项越界
  });

  test('issue #94/#95：AskUserQuestion 菜单可选中第 3 项；旧的单项 sig 判 stale', async () => {
    const t = setup();
    t.driver.pane = ASK_MENU;

    // 修复前网页拿到的签名只有第 1 项 → 现在按 stale 拒掉，不盲注入
    const stale = await t.act(t.aliceToken, { type: 'select', index: 2, sig: '朝向基本固定@0' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale');
    expect(t.driver.keys).toEqual([]);

    const ok = await t.act(t.aliceToken, { type: 'select', index: 2, sig: ASK_MENU_SIG });
    expect(ok.status).toBe(200);
    expect(ok.body.option).toBe('不确定，先按固定做');
    expect(t.driver.keys).toEqual(['Down', 'Down', 'Enter']); // 修复前是 400 越界，根本点不到
  });

  test('select + requestId：走审批消费口（带项目会话名核对）；失效 409', async () => {
    const t = setup();
    const ok = await t.act(t.aliceToken, { type: 'select', index: 0, requestId: 'req-1' });
    expect(ok.status).toBe(200);
    expect(t.consumeCalls).toEqual([{ requestId: 'req-1', index: 0, expectSession: 'cc-1' }]);

    t.setConsume({ ok: false, reason: 'expired' });
    expect((await t.act(t.aliceToken, { type: 'select', index: 0, requestId: 'req-1' })).status).toBe(409);
    t.setConsume({ ok: false, reason: 'stale' });
    expect((await t.act(t.aliceToken, { type: 'select', index: 0, requestId: 'req-1' })).status).toBe(409);
  });

  test('并发注入经 KeyedMutex 严格串行（评审 H9 单一驾驶员）', async () => {
    const t = setup();
    t.driver.sendKeysDelayMs = 25;
    const [a, b, c] = await Promise.all([
      t.act(t.aliceToken, { type: 'text', text: '一' }),
      t.act(t.aliceToken, { type: 'text', text: '二' }),
      t.act(t.aliceToken, { type: 'text', text: '三' }),
    ]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(t.driver.sent.sort()).toEqual(['一', '三', '二'].sort());
    expect(t.driver.maxActive).toBe(1); // 同一会话同时刻只有一个驾驶员
  });
});

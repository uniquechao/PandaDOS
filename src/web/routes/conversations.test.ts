/**
 * /api/projects/:projectId/conversations 测试（对话模式 chat 对话 HTTP API）：
 * - 鉴权矩阵（project-owner）：未登录 401 / 错属主 403 / 属主与 admin 放行 / 项目不存在 404；
 * - 新建 = kind='chat'（agent 可选 claude|codex）；列表仅 chat、排归档（?includeArchived=1 才含）；
 * - activate 起独立会话 chat-<convId>（幂等）；archive 归档 + kill；rename 改标题；
 * - 守卫：非 chat 对话（引擎绑定）与不存在对话在 activate/archive/rename 上拒绝；
 * - 当前模型 GET /:convId/model（issue #109）：chat 与 issue 对话都放行，探不到 → model:null。
 */
import { describe, expect, test } from 'bun:test';
import { ConversationManager, type ConvDriver } from '../../core/conversations';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { migrateIssueEngine } from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { conversationsRoutes, type ConvModelPort } from './conversations';

class FakeConvDriver implements ConvDriver {
  sessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  killed: string[] = [];
  /** capturePane 返回值（默认空串：codexExitedToShell/isCodexUpdatePrompt 均判否 → 健康短路） */
  paneText = '';
  async findExecutable(agent: 'claude' | 'codex') {
    return agent;
  }
  async listSessions() {
    return [...this.sessions].map((name) => ({ name }));
  }
  async capturePane() {
    return this.paneText;
  }
  async createSession(name: string) {
    this.sessions.add(name);
  }
  async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('no session');
    this.killed.push(name);
  }
  async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async statPath() {
    return { size: 1, isDirectory: true }; // cwd 视为已存在，跳过 .butler-keep 物化
  }
  async readFileRange() {
    return { data: new Uint8Array(), size: 0 };
  }
  async writeFile() {}
}

function setup(models?: ConvModelPort) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const { token: adminToken } = users.create('admin', 'admin');
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

  const driver = new FakeConvDriver();
  const convs = new ConversationManager(db, driver, { locate: async () => null });
  const mutex = new KeyedMutex();
  const dispatch = createDispatcher(
    conversationsRoutes({ db, convs, mutex, ...(models ? { models } : {}) }),
    authDepsFromDb(db, users),
  );

  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const req = new Request(`http://x${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const r = dispatch(req);
    if (!r) throw new Error('路由未命中');
    const resp = await r;
    return { status: resp.status, body: (await resp.json()) as Record<string, any> };
  };

  return { db, convs, driver, adminToken, aliceToken, bobToken, call };
}

const P = '/api/projects/1/conversations';

describe('conversations 路由：鉴权矩阵', () => {
  test('未登录 401 / 错属主 403 / 属主 200 / admin 200 / 项目不存在 404', async () => {
    const t = setup();
    expect((await t.call('GET', P, null)).status).toBe(401);
    expect((await t.call('GET', P, t.bobToken)).status).toBe(403);
    expect((await t.call('GET', P, t.aliceToken)).status).toBe(200);
    expect((await t.call('GET', P, t.adminToken)).status).toBe(200);
    // 不存在项目：bob 403（不泄露存在性）、admin 404
    expect((await t.call('GET', '/api/projects/999/conversations', t.bobToken)).status).toBe(403);
    expect((await t.call('GET', '/api/projects/999/conversations', t.adminToken)).status).toBe(404);
  });
});

describe('conversations 路由：新建/列表', () => {
  test('执行机未启用 Codex 时新建对话返回 409，Claude 不受影响', async () => {
    const t = setup();
    t.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    expect((await t.call('POST', P, t.aliceToken, { agent: 'codex' })).status).toBe(409);
    expect((await t.call('POST', P, t.aliceToken, { agent: 'claude' })).status).toBe(200);
  });

  test('新建 = chat；默认 claude，可选 codex；列表仅 chat 且排归档', async () => {
    const t = setup();
    const c1 = await t.call('POST', P, t.aliceToken, { label: '设计稿' });
    expect(c1.status).toBe(200);
    expect(c1.body.conversation.kind).toBe('chat');
    expect(c1.body.conversation.agent).toBe('claude');
    expect(c1.body.conversation.label).toBe('设计稿');

    const c2 = await t.call('POST', P, t.aliceToken, { label: '重构', agent: 'codex' });
    expect(c2.body.conversation.agent).toBe('codex');

    // 引擎绑定的 issue 对话不应出现在 chat 列表里
    t.convs.create(1, 'issue-conv', 'claude', 'issue');

    const list = await t.call('GET', P, t.aliceToken);
    const ids = list.body.conversations.map((c: any) => c.id);
    expect(ids).toContain(c1.body.conversation.id);
    expect(ids).toContain(c2.body.conversation.id);
    expect(list.body.conversations).toHaveLength(2); // 不含 issue 对话
  });

  test('缺 label → 默认「新对话」', async () => {
    const t = setup();
    const c = await t.call('POST', P, t.aliceToken, {});
    expect(c.body.conversation.label).toBe('新对话');
  });
});

describe('conversations 路由：activate/archive/rename', () => {
  test('activate 起 chat-<id> 独立会话（幂等）', async () => {
    const t = setup();
    const c = (await t.call('POST', P, t.aliceToken, { label: 'x' })).body.conversation;
    const a1 = await t.call('POST', `${P}/${c.id}/activate`, t.aliceToken);
    expect(a1.status).toBe(200);
    expect(t.driver.sessions.has(`chat-${c.id}`)).toBe(true);
    expect(t.driver.sent[0]).toEqual({ session: `chat-${c.id}`, text: `claude --session-id ${c.id}` });
    // 幂等：会话活着 → 不重发
    await t.call('POST', `${P}/${c.id}/activate`, t.aliceToken);
    expect(t.driver.sent).toHaveLength(1);
  });

  test('archive 归档 + kill 会话；之后不在列表（除非 includeArchived）', async () => {
    const t = setup();
    const c = (await t.call('POST', P, t.aliceToken, { label: 'x' })).body.conversation;
    await t.call('POST', `${P}/${c.id}/activate`, t.aliceToken);
    const ar = await t.call('POST', `${P}/${c.id}/archive`, t.aliceToken);
    expect(ar.status).toBe(200);
    expect(t.driver.killed).toContain(`chat-${c.id}`);

    expect((await t.call('GET', P, t.aliceToken)).body.conversations).toHaveLength(0);
    const withArch = await t.call('GET', `${P}?includeArchived=1`, t.aliceToken);
    expect(withArch.body.conversations.map((x: any) => x.id)).toContain(c.id);
  });

  test('rename 改标题；空 label 400', async () => {
    const t = setup();
    const c = (await t.call('POST', P, t.aliceToken, { label: 'old' })).body.conversation;
    const rn = await t.call('POST', `${P}/${c.id}/rename`, t.aliceToken, { label: 'new' });
    expect(rn.status).toBe(200);
    expect(rn.body.conversation.label).toBe('new');
    expect((await t.call('POST', `${P}/${c.id}/rename`, t.aliceToken, { label: '  ' })).status).toBe(400);
  });

  test('auto-approve 改档位：新建默认 cautious，改完回显；非法值 400、非 chat 对话 400', async () => {
    const t = setup();
    const c = (await t.call('POST', P, t.aliceToken, { label: 'x' })).body.conversation;
    expect(c.autoApprove).toBe('cautious'); // 对话默认 = 现状（全部等人点）

    const ok = await t.call('POST', `${P}/${c.id}/auto-approve`, t.aliceToken, { level: 'auto' });
    expect(ok.status).toBe(200);
    expect(ok.body.conversation.autoApprove).toBe('auto');
    // 列表返回体也带上档位（前端切换钮的初值来源）
    const list = await t.call('GET', P, t.aliceToken);
    expect(list.body.conversations.find((x: any) => x.id === c.id).autoApprove).toBe('auto');

    for (const level of ['全自动', '', undefined, 'AUTO']) {
      const bad = await t.call('POST', `${P}/${c.id}/auto-approve`, t.aliceToken, { level });
      expect(bad.status).toBe(400);
    }
    expect((await t.call('GET', P, t.aliceToken)).body.conversations[0].autoApprove).toBe('auto'); // 未被打脏

    const issueConv = t.convs.create(1, 'i', 'claude', 'issue');
    expect(
      (await t.call('POST', `${P}/${issueConv.id}/auto-approve`, t.aliceToken, { level: 'auto' })).status,
    ).toBe(400);
  });

  test('守卫：非 chat 对话 400；不存在对话 404', async () => {
    const t = setup();
    const issueConv = t.convs.create(1, 'i', 'claude', 'issue');
    expect((await t.call('POST', `${P}/${issueConv.id}/activate`, t.aliceToken)).status).toBe(400);
    expect((await t.call('POST', `${P}/${issueConv.id}/rename`, t.aliceToken, { label: 'x' })).status).toBe(400);
    expect((await t.call('POST', `${P}/does-not-exist/activate`, t.aliceToken)).status).toBe(404);
  });
});

describe('conversations 路由：当前模型（issue #109）', () => {
  test('chat 与 issue 对话都放行；返回代理与模型原始名', async () => {
    const asked: string[] = [];
    const t = setup({
      modelOf: async (id) => {
        asked.push(id);
        return id.startsWith('x') ? 'gpt-5.6-sol' : 'claude-opus-5';
      },
    });
    const chat = (await t.call('POST', P, t.aliceToken, { label: 'x' })).body.conversation;
    const r1 = await t.call('GET', `${P}/${chat.id}/model`, t.aliceToken);
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ ok: true, agent: 'claude', model: 'claude-opus-5' });

    // issue 引擎对话（详情页顶部要显示执行会话的模型）不该被 kind 闸挡掉
    const issueConv = t.convs.create(1, 'i', 'codex', 'issue');
    const r2 = await t.call('GET', `${P}/${issueConv.id}/model`, t.aliceToken);
    expect(r2.status).toBe(200);
    expect(r2.body.agent).toBe('codex');
    expect(asked).toContain(issueConv.id);
  });

  test('探不到 / 未接探测器 / 探测抛错 → model:null（不猜默认模型）', async () => {
    const none = setup({ modelOf: async () => null });
    const c1 = (await none.call('POST', P, none.aliceToken, {})).body.conversation;
    expect((await none.call('GET', `${P}/${c1.id}/model`, none.aliceToken)).body.model).toBeNull();

    const bare = setup(); // 未接 models 的最小装配
    const c2 = (await bare.call('POST', P, bare.aliceToken, {})).body.conversation;
    const r = await bare.call('GET', `${P}/${c2.id}/model`, bare.aliceToken);
    expect(r.status).toBe(200);
    expect(r.body.model).toBeNull();

    const boom = setup({ modelOf: () => Promise.reject(new Error('读不动')) });
    const c3 = (await boom.call('POST', P, boom.aliceToken, {})).body.conversation;
    expect((await boom.call('GET', `${P}/${c3.id}/model`, boom.aliceToken)).body.model).toBeNull();
  });

  test('鉴权与归属：未登录 401 / 非成员 403 / 不存在对话 404', async () => {
    const t = setup({ modelOf: async () => 'claude-opus-5' });
    const c = (await t.call('POST', P, t.aliceToken, {})).body.conversation;
    expect((await t.call('GET', `${P}/${c.id}/model`, null)).status).toBe(401);
    expect((await t.call('GET', `${P}/${c.id}/model`, t.bobToken)).status).toBe(403);
    expect((await t.call('GET', `${P}/does-not-exist/model`, t.aliceToken)).status).toBe(404);
  });
});

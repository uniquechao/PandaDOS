/**
 * WS 挂载测试（Wave3 任务 A/B）：
 * - 鉴权矩阵（term/chat 同一套 upgrade 前置鉴权，'project-access' 口径）：无 token 401 /
 *   非属主非成员 403 / 属主·成员·admin 放行 / admin 对不存在项目 404 /
 *   跨项目会话 403 / 会话不存在 404；
 * - chat 帧序：baseline（最近气泡+selection）→ msg 增量 → selection 变化 →
 *   select 带旧 sig → stale → 正确 sig 注入 → text/key 注入与 bad_key；
 * - term：PTY 桥（假 PtyChannel）——输出透传、resize 控制帧、binary 输入、exit 帧、关连接回收；
 * - gated：本机 tmux + script 可用时对真 LocalDriver.openPty 跑 attach 回环。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { imageReadHint } from '../../core/uploads';
import { LocalDriver } from '../../executor/local';
import { KEY_WHITELIST, type PtyChannel } from '../../executor/driver';
import { startServer, type PandaServer } from '../server';

// ---------- 假 Driver（tmux/PTY 面 stub，文件/git 面真 LocalDriver） ----------

class FakePty implements PtyChannel {
  writes: (string | Uint8Array)[] = [];
  resizes: Array<[number, number]> = [];
  closed = false;
  private dataCbs: Array<(c: Uint8Array) => void> = [];
  private exitCbs: Array<(code: number | null) => void> = [];
  write(d: string | Uint8Array) {
    this.writes.push(d);
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows]);
  }
  onData(cb: (c: Uint8Array) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (code: number | null) => void) {
    this.exitCbs.push(cb);
  }
  close() {
    this.closed = true;
  }
  emit(s: string) {
    for (const cb of this.dataCbs) cb(new TextEncoder().encode(s));
  }
  exit(code: number | null = 0) {
    for (const cb of this.exitCbs) cb(code);
  }
}

class FakeDriver extends LocalDriver {
  sessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  keys: Array<{ session: string; key: string }> = [];
  pane = '';
  ptys: Array<{ cmd: string; cols: number; rows: number; pty: FakePty }> = [];
  resizes: Array<{ session: string; size: { cols: number; rows: number } | null }> = [];
  scrolls: Array<{ session: string; direction: 'up' | 'down'; lines: number }> = [];
  scrollDelayMs = 0;
  scrollInFlight = 0;
  maxScrollInFlight = 0;
  override async findExecutable(agent: 'claude' | 'codex') {
    return `/test/bin/${agent}`;
  }
  override async listSessions() {
    return [...this.sessions].map((name) => ({ name, createdTs: 0, attached: false }));
  }
  override async createSession(name: string) {
    this.sessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  override async sendKey(session: string, key: string) {
    if (!KEY_WHITELIST.has(key)) throw new Error(`key not in whitelist: ${key}`); // LocalDriver 同语义
    this.keys.push({ session, key });
  }
  override async capturePane() {
    return this.pane;
  }
  override async openPty(cmd: string, cols: number, rows: number): Promise<PtyChannel> {
    const pty = new FakePty();
    this.ptys.push({ cmd, cols, rows, pty });
    return pty;
  }
  override async resizeWindow(session: string, size: { cols: number; rows: number } | null) {
    this.resizes.push({ session, size });
  }
  override async scrollPane(session: string, direction: 'up' | 'down', lines: number) {
    this.scrollInFlight += 1;
    this.maxScrollInFlight = Math.max(this.maxScrollInFlight, this.scrollInFlight);
    try {
      if (this.scrollDelayMs > 0) await Bun.sleep(this.scrollDelayMs);
      this.scrolls.push({ session, direction, lines });
    } finally {
      this.scrollInFlight -= 1;
    }
  }
}

// ---------- 环境 ----------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Ctx {
  server: PandaServer;
  base: string;
  wsBase: string;
  dir: string;
  claudeDir: string;
  driver: FakeDriver;
  adminToken: string;
  aliceToken: string;
  bobToken: string;
  pid: number;
}

async function boot(): Promise<Ctx> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-ws-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'panda.db');
  const claudeDir = path.join(dir, 'home', '.claude', 'projects');
  await fsp.mkdir(claudeDir, { recursive: true });

  const db0 = openDb(dbPath);
  migrate(db0);
  db0.query(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', ?, ?)`,
  ).run(path.join(dir, 'ws'), claudeDir);
  db0.close();

  const driver = new FakeDriver();
  const server = await startServer({
    port: 0,
    dbPath,
    adminTokenFile: path.join(dir, 'admin-token'),
    driverFactory: () => driver,
    feishu: null,
    engineConfig: { tickMs: 3_600_000 },
    statusIntervalMs: 3_600_000,
    wsChatPollMs: 30,
  });
  cleanups.push(() => server.stop());

  const base = `http://127.0.0.1:${server.port}`;
  const adminToken = (await fsp.readFile(path.join(dir, 'admin-token'), 'utf8')).trim();
  const api = async (method: string, p: string, token?: string, body?: unknown) => {
    const resp = await fetch(`${base}${p}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: resp.status, body: (await resp.json().catch(() => null)) as any };
  };
  const alice = await api('POST', '/api/admin/users', adminToken, { username: 'alice' });
  const bob = await api('POST', '/api/admin/users', adminToken, { username: 'bob' });
  const proj = await api('POST', '/api/projects', alice.body.token, { name: 'demo', executorId: 1 });

  return {
    server,
    base,
    wsBase: `ws://127.0.0.1:${server.port}`,
    dir,
    claudeDir,
    driver,
    adminToken,
    aliceToken: alice.body.token as string,
    bobToken: bob.body.token as string,
    pid: proj.body.project.id as number,
  };
}

// ---------- WS 客户端小工具 ----------

interface WsClient {
  ws: WebSocket;
  next(timeoutMs?: number): Promise<any>;
  nextBinary(timeoutMs?: number): Promise<Uint8Array>;
  send(v: unknown): void;
  close(): void;
  closed: Promise<void>;
}

function connect(url: string, token?: string): Promise<WsClient> {
  const ws = new WebSocket(
    url,
    // Bun 扩展：允许自定义 headers（浏览器 WebSocket 无此参；类型断言绕 DOM lib）
    { headers: token ? { authorization: `Bearer ${token}` } : {} } as unknown as string[],
  );
  ws.binaryType = 'arraybuffer';
  const q: any[] = [];
  const waiters: Array<(v: any) => void> = [];
  ws.onmessage = (e) => {
    const v = typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w(v);
    else q.push(v);
  };
  let closeResolve!: () => void;
  const closed = new Promise<void>((r) => (closeResolve = r));
  ws.onclose = () => closeResolve();
  const client: WsClient = {
    ws,
    next(timeoutMs = 3000) {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('等帧超时')), timeoutMs);
        waiters.push((v) => {
          clearTimeout(t);
          res(v);
        });
      });
    },
    async nextBinary(timeoutMs = 3000) {
      const v = await client.next(timeoutMs);
      if (!(v instanceof Uint8Array)) throw new Error(`期望 binary，收到 ${JSON.stringify(v)}`);
      return v;
    },
    send(v: unknown) {
      ws.send(typeof v === 'string' || v instanceof Uint8Array ? v : JSON.stringify(v));
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    },
    closed,
  };
  return new Promise((res, rej) => {
    ws.onopen = () => res(client);
    ws.onerror = () => rej(new Error('WS 连接失败'));
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 15));
  }
}

const asst = (text: string) =>
  `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`;
const user = (text: string) =>
  `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })}\n`;
/** 复刻 web/ws/chat.ts 的注入拼法：cleanHint = imageReadHint(abs).replace(/^\n+/,'')；带正文再接 '\n'+正文 */
const injected = (abs: string[], text = '') =>
  imageReadHint(abs).replace(/^\n+/, '') + (text ? '\n' + text : '');

const MENU = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No';

/** issue #94/#95：AskUserQuestion 菜单（选项行不相邻：每项下面跟说明，末两项之间夹分隔线） */
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

// ---------- 鉴权矩阵（upgrade 前置；非 upgrade 请求直接看状态码） ----------

describe('WS 鉴权矩阵（/ws/term /ws/chat 同一套 upgrade 前鉴权）', () => {
  test('401/403/404 全矩阵 + 正常路径可升级', async () => {
    const t = await boot();
    const get = async (p: string, token?: string) =>
      (await fetch(`${t.base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;

    // 无 token → 401（term/chat 一致）
    expect(await get(`/ws/term/${t.pid}`)).toBe(401);
    expect(await get(`/ws/chat/${t.pid}`)).toBe(401);
    // 错属主 → 403
    expect(await get(`/ws/term/${t.pid}`, t.bobToken)).toBe(403);
    expect(await get(`/ws/chat/${t.pid}`, t.bobToken)).toBe(403);
    // 项目不存在：普通用户 403（不泄露存在性），admin 404
    expect(await get(`/ws/chat/999`, t.bobToken)).toBe(403);
    expect(await get(`/ws/chat/999`, t.adminToken)).toBe(404);
    // term：仅 sessions 表登记的导入会话可显式接入；不能按 cc-* 名字猜测内部 agent tmux
    t.driver.sessions.add(`cc-${t.pid}`);
    expect(await get(`/ws/term/${t.pid}?session=cc-999`, t.aliceToken)).toBe(403);
    expect(await get(`/ws/term/${t.pid}?session=cc-${t.pid}`, t.aliceToken)).toBe(403);
    expect(await get(`/ws/term/${t.pid}?session=cc-${t.pid}-x`, t.aliceToken)).toBe(403);
    expect(await get(`/ws/term/${t.pid}?session=bad$name`, t.aliceToken)).toBe(400);
    // 属主/admin 的合法请求：非 upgrade 请求到达 upgrade 点 → 400（鉴权已过）
    expect(await get(`/ws/term/${t.pid}`, t.aliceToken)).toBe(400);
    expect(await get(`/ws/chat/${t.pid}`, t.adminToken)).toBe(400);
    // 未知 /ws/* → 404
    expect(await get(`/ws/nope`, t.aliceToken)).toBe(404);

    // 真升级：属主 WS 可建连（chat 无需 tmux 会话存在）
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    c.close();
    // 错属主 WS 建连直接失败
    await expect(connect(`${t.wsBase}/ws/chat/${t.pid}`, t.bobToken)).rejects.toThrow();
  });

  test('项目成员（project-access 放宽）可接入 term/chat', async () => {
    const t = await boot();
    const get = async (p: string, token?: string) =>
      (await fetch(`${t.base}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;

    // 加入前：bob 非属主非成员 → 403
    expect(await get(`/ws/chat/${t.pid}`, t.bobToken)).toBe(403);

    // 关联 bob 为项目成员（成员 API 尚未接线，WAL 下另开连接直接写库）
    const db = openDb(path.join(t.dir, 'panda.db'));
    const bobId = db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'bob'").get()!.id;
    db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)').run(
      t.pid,
      bobId,
    );
    db.close();

    // 加入后：鉴权通过 —— 非 upgrade 请求到 upgrade 点 → 400
    t.driver.sessions.add(`cc-${t.pid}`);
    expect(await get(`/ws/chat/${t.pid}`, t.bobToken)).toBe(400);
    expect(await get(`/ws/term/${t.pid}`, t.bobToken)).toBe(400);
    // 真实 ws 可建连（成为成员前会 reject）
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.bobToken);
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    c.close();
  });
});

// ---------- term：控制台 shell 回落（打开终端页不再「连接已断开」） ----------

describe('WS term：无会话时懒建控制台 shell', () => {
  const status = async (base: string, p: string, token: string) =>
    (await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } })).status;

  test('claude 会话 cc-<pid> 不在跑 + 不传 session → 懒建 cc-<pid>-console 并放行到 upgrade（不再 404）', async () => {
    const t = await boot();
    // 前置：没有任何会话（尤其没有 cc-<pid>）
    expect(t.driver.sessions.has(`cc-${t.pid}`)).toBe(false);
    // 打开终端页（UI 不带 session 参数）：非 upgrade 的 GET 走到 upgrade 点 → 400（鉴权/会话都过了）
    expect(await status(t.base, `/ws/term/${t.pid}`, t.aliceToken)).toBe(400);
    // 关键断言：控制台 shell 已在项目 cwd 懒建，绝不动 claude 会话名 cc-<pid>
    expect(t.driver.sessions.has(`cc-${t.pid}-console`)).toBe(true);
    expect(t.driver.sessions.has(`cc-${t.pid}`)).toBe(false);
  });

  test('issue 会话 cc-<pid> 在跑 + 不传 session → 仍打开隔离控制台', async () => {
    const t = await boot();
    t.driver.sessions.add(`cc-${t.pid}`);
    expect(await status(t.base, `/ws/term/${t.pid}`, t.aliceToken)).toBe(400);
    expect(t.driver.sessions.has(`cc-${t.pid}-console`)).toBe(true);
  });

  test('未登记的显式会话拒绝（不给名称空间或兜底懒建）', async () => {
    const t = await boot();
    expect(await status(t.base, `/ws/term/${t.pid}?session=cc-${t.pid}-x`, t.aliceToken)).toBe(403);
    expect(t.driver.sessions.has(`cc-${t.pid}-x`)).toBe(false);
  });
});

// ---------- term：强类型目标解析（console / issue / chat conversation / imported session） ----------

describe('WS term：强类型目标解析', () => {
  const status = async (base: string, p: string, token: string) =>
    (await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } })).status;

  test('issue 只接入本项目当前执行且仍绑定当前对话的模块会话；历史同模块 issue 不可误连', async () => {
    const t = await boot();
    const convId = crypto.randomUUID();
    t.server.db
      .query('INSERT INTO conversations (id, project_id, label, created_ts) VALUES (?, ?, ?, ?)')
      .run(convId, t.pid, '模块执行会话', Date.now());
    t.server.db
      .query(
        `INSERT INTO project_modules
           (project_id, slug, display_name, agent, source, conversation_id, created_ts)
         VALUES (?, 'terminal-runtime', '终端运行态', 'claude', 'manual', ?, ?)`,
      )
      .run(t.pid, convId, Date.now());
    const moduleId = t.server.db
      .query<{ id: number }, [number, string]>('SELECT id FROM project_modules WHERE project_id = ? AND slug = ?')
      .get(t.pid, 'terminal-runtime')!.id;
    const activeIssue = t.server.db
      .query<{ id: number }, [number, string, string, number, number]>(
        `INSERT INTO issues (project_id, title, status, conv_id, module_id, created_ts)
         VALUES (?, ?, 'implementing', ?, ?, ?) RETURNING id`,
      )
      .get(t.pid, '正在执行', convId, moduleId, Date.now())!;
    const historicIssue = t.server.db
      .query<{ id: number }, [number, string, string, number, number]>(
        `INSERT INTO issues (project_id, title, status, conv_id, module_id, created_ts)
         VALUES (?, ?, 'done', ?, ?, ?) RETURNING id`,
      )
      .get(t.pid, '同模块历史任务', convId, moduleId, Date.now())!;
    t.server.db
      .query('INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (?, ?, ?)')
      .run(t.pid, convId, Date.now());
    t.driver.sessions.add(`cc-${t.pid}-m-terminal-runtime`);

    const c = await connect(`${t.wsBase}/ws/term/${t.pid}?issue=${activeIssue.id}`, t.aliceToken);
    await waitFor(() => t.driver.ptys.length === 1);
    expect(t.driver.ptys[0]!.cmd).toBe(`tmux attach -t cc-${t.pid}-m-terminal-runtime`);
    c.close();
    await c.closed;

    // 两条 issue 共用模块会话时，历史任务不能借当前 conv 误连到活跃 tmux。
    expect(await status(t.base, `/ws/term/${t.pid}?issue=${historicIssue.id}`, t.aliceToken)).toBe(409);
  });

  test('conv 只接入项目内独立 chat 会话，并拒绝不存在、错误类型与冲突 selector', async () => {
    const t = await boot();
    const chatConv = crypto.randomUUID();
    const issueConv = crypto.randomUUID();
    const ins = t.server.db.query(
      'INSERT INTO conversations (id, project_id, label, created_ts, kind) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run(chatConv, t.pid, '独立聊天', Date.now(), 'chat');
    ins.run(issueConv, t.pid, 'issue 对话', Date.now(), 'issue');
    t.driver.sessions.add(`chat-${chatConv}`);

    const c = await connect(`${t.wsBase}/ws/term/${t.pid}?conv=${chatConv}`, t.aliceToken);
    await waitFor(() => t.driver.ptys.length === 1);
    expect(t.driver.ptys[0]!.cmd).toBe(`tmux attach -t chat-${chatConv}`);
    c.close();
    await c.closed;

    const designConv = crypto.randomUUID();
    ins.run(designConv, t.pid, '设计工作台对话', Date.now(), 'chat');
    t.server.db.query(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, conversation_id, created_ts, updated_ts)
       VALUES (?, 'Design', 'Reserved conversation', 'claude', ?, ?, ?)`,
    ).run(t.pid, designConv, Date.now(), Date.now());
    const reservedTerm = await fetch(`${t.base}/ws/term/${t.pid}?conv=${designConv}`, {
      headers: { authorization: `Bearer ${t.aliceToken}` },
    });
    expect(reservedTerm.status).toBe(409);
    expect(await reservedTerm.json()).toEqual({
      ok: false,
      error: {
        code: 'design.conversation_reserved',
        params: { conversationId: designConv },
        fallback: 'This conversation is managed by the design workspace.',
      },
    });

    expect(await status(t.base, `/ws/term/${t.pid}?conv=${issueConv}`, t.aliceToken)).toBe(409);
    expect(await status(t.base, `/ws/term/${t.pid}?conv=${crypto.randomUUID()}`, t.aliceToken)).toBe(404);
    t.driver.sessions.delete(`chat-${chatConv}`);
    expect(await status(t.base, `/ws/term/${t.pid}?conv=${chatConv}`, t.aliceToken)).toBe(404);
    expect(await status(t.base, `/ws/term/${t.pid}?conv=${chatConv}&issue=1`, t.aliceToken)).toBe(400);
    expect(await status(t.base, `/ws/term/${t.pid}?conv=${chatConv}&conv=${issueConv}`, t.aliceToken)).toBe(400);

    const wrongKindIssue = t.server.db
      .query<{ id: number }, [number, string, string, number]>(
        `INSERT INTO issues (project_id, title, status, conv_id, created_ts)
         VALUES (?, ?, 'implementing', ?, ?) RETURNING id`,
      )
      .get(t.pid, '错误绑定 chat 对话', chatConv, Date.now())!;
    t.server.db
      .query('INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (?, ?, ?)')
      .run(t.pid, chatConv, Date.now());
    expect(await status(t.base, `/ws/term/${t.pid}?issue=${wrongKindIssue.id}`, t.aliceToken)).toBe(409);
  });

  test('显式 session 仅保留已登记导入会话，其他项目的 issue/conv 目标拒绝', async () => {
    const t = await boot();
    const ownerId = t.server.db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'alice'").get()!.id;
    const imported = `legacy-shell-${Date.now()}`;
    t.server.db
      .query('INSERT INTO sessions (name, executor_id, project_id, owner_user_id) VALUES (?, ?, ?, ?)')
      .run(imported, 1, t.pid, ownerId);
    t.driver.sessions.add(imported);
    const c = await connect(`${t.wsBase}/ws/term/${t.pid}?session=${imported}`, t.aliceToken);
    await waitFor(() => t.driver.ptys.length === 1);
    expect(t.driver.ptys[0]!.cmd).toBe(`tmux attach -t ${imported}`);
    c.close();
    await c.closed;

    const foreignProject = await fetch(`${t.base}/api/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.aliceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other', executorId: 1 }),
    }).then((r) => r.json() as Promise<any>);
    const foreignConv = crypto.randomUUID();
    t.server.db
      .query('INSERT INTO conversations (id, project_id, label, created_ts, kind) VALUES (?, ?, ?, ?, ? )')
      .run(foreignConv, foreignProject.project.id, '别的项目', Date.now(), 'chat');
    const foreignIssue = t.server.db
      .query<{ id: number }, [number, string, number]>(
        'INSERT INTO issues (project_id, title, created_ts) VALUES (?, ?, ?) RETURNING id',
      )
      .get(foreignProject.project.id, '别的 issue', Date.now())!;
    expect(await status(t.base, `/ws/term/${t.pid}?conv=${foreignConv}`, t.aliceToken)).toBe(403);
    expect(await status(t.base, `/ws/term/${t.pid}?issue=${foreignIssue.id}`, t.aliceToken)).toBe(403);
  });
});

// ---------- chat 帧序 ----------

describe('WS chat：baseline → msg 增量 → selection → stale → 注入', () => {
  async function chatCtx() {
    const t = await boot();
    // 造激活对话 + jsonl（引擎不参与：直接落表）；注册 tmux 会话（注入自愈门禁判活要过）
    t.driver.sessions.add(`cc-${t.pid}`);
    const convId = crypto.randomUUID();
    t.server.db
      .query('INSERT INTO conversations (id, project_id, label, created_ts) VALUES (?, ?, ?, ?)')
      .run(convId, t.pid, '测试对话', Date.now());
    t.server.db
      .query('INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (?, ?, ?)')
      .run(t.pid, convId, Date.now());
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    const jsonl = path.join(sub, `${convId}.jsonl`);
    await fsp.writeFile(jsonl, asst('第一条') + asst('第二条'));
    return { ...t, convId, jsonl };
  }

  test('baseline 带最近气泡与当前菜单；tail 增量推 msg；菜单变化推 selection', async () => {
    const t = await chatCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);

    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs.map((m: any) => m.text)).toEqual(['第一条', '第二条']);
    expect(baseline.selection).toBeNull();

    // 增量：新行 → {type:'msg'}
    await fsp.appendFile(t.jsonl, asst('第三条'));
    const m = await c.next();
    expect(m.type).toBe('msg');
    expect(m.m.role).toBe('assistant');
    expect(m.m.text).toBe('第三条');

    // 菜单出现 → {type:'selection', sel:{context,options,sig}}
    t.driver.pane = MENU;
    const sel = await c.next();
    expect(sel.type).toBe('selection');
    expect(sel.sel.options).toEqual(['Yes', 'No']);
    expect(sel.sel.sig).toBe('Yes|No@0');
    expect(sel.sel.context).toContain('Do you want to proceed?');

    // 菜单消失 → sel:null
    t.driver.pane = '';
    const gone = await c.next();
    expect(gone.type).toBe('selection');
    expect(gone.sel).toBeNull();
    c.close();
    await c.closed;
  });

  test('issue #94/#95：AskUserQuestion 菜单整帧推全 5 项；select 第 3 项 → Down×2+Enter', async () => {
    const t = await chatCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    await c.next(); // baseline

    t.driver.pane = ASK_MENU;
    const sel = await c.next();
    expect(sel.type).toBe('selection');
    // 修复前网页只收到 ['朝向基本固定']——比终端里少 4 项，正是本 issue 的现象
    expect(sel.sel.options).toEqual([
      '朝向基本固定',
      '每个盒子朝向都会变',
      '不确定，先按固定做',
      'Type something.',
      'Chat about this',
    ]);
    expect(sel.sel.context).toContain('盒子朝向');
    // 次级说明随帧下发（前端渲染成选项下方小字），且不进签名
    expect(sel.sel.details[0]).toContain('轴对齐皮带');
    expect(sel.sel.details[4]).toBe('');
    expect(sel.sel.cursorIndex).toBe(0);
    expect(sel.sel.sig).not.toContain('轴对齐皮带');
    expect(sel.sel.multiSelect).toBe(false); // 单选表头的 ☐ 不该把它标成多选

    c.send({ type: 'select', index: 2, sig: sel.sel.sig });
    await waitFor(() => t.driver.keys.length === 3);
    expect(t.driver.keys.map((k) => k.key)).toEqual(['Down', 'Down', 'Enter']);

    t.driver.pane = '';
    c.close();
    await c.closed;
  });

  test('issue #95：多选表单帧带 multiSelect（前端据此改文案 + 给「→ 去提交」入口）', async () => {
    const t = await chatCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    await c.next(); // baseline

    t.driver.pane = [
      '←  ☒ 要装的模块  ✔ Submit  →',
      '',
      '请选择要安装的模块',
      '',
      '❯ 1. [✔] 视觉模块',
      '  采用高精度摄像头和 AI 视觉识别技术。',
      '  2. [ ] 抓取模块',
      '  集成精密机械臂和智能抓取器。',
      '',
      'Enter to select · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
    const sel = await c.next();
    expect(sel.type).toBe('selection');
    expect(sel.sel.multiSelect).toBe(true);
    expect(sel.sel.options).toEqual(['[✔] 视觉模块', '[ ] 抓取模块']);

    // 「→ 去提交」= key 帧 Right（白名单内），落到项目会话
    c.send({ type: 'key', key: 'Right' });
    await waitFor(() => t.driver.keys.length === 1);
    expect(t.driver.keys[0]).toEqual({ session: `cc-${t.pid}`, key: 'Right' });

    t.driver.pane = '';
    c.close();
    await c.closed;
  });

  test('select：sig 不符 → stale；正确 sig → 锁内导航注入；text/key 注入；bad_key/bad_frame 错误帧', async () => {
    const t = await chatCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    await c.next(); // baseline

    t.driver.pane = MENU;
    const sel = await c.next();
    expect(sel.sel.sig).toBe('Yes|No@0');

    // 旧 sig（菜单已变的模拟）→ stale，不注入
    c.send({ type: 'select', index: 1, sig: 'Old|Menu@0' });
    expect((await c.next()).type).toBe('stale');
    expect(t.driver.keys.length).toBe(0);

    // 正确 sig → Down+Enter（相对导航）
    c.send({ type: 'select', index: 1, sig: sel.sel.sig });
    await waitFor(() => t.driver.keys.length === 2);
    expect(t.driver.keys.map((k) => k.key)).toEqual(['Down', 'Enter']);
    expect(t.driver.keys[0]!.session).toBe(`cc-${t.pid}`);

    // text / key 注入
    c.send({ type: 'text', text: '继续修' });
    await waitFor(() => t.driver.sent.length === 1);
    expect(t.driver.sent[0]).toEqual({ session: `cc-${t.pid}`, text: '继续修' });
    c.send({ type: 'key', key: 'Escape' });
    await waitFor(() => t.driver.keys.length === 3);

    // 白名单外按键 → err bad_key；畸形帧 → err bad_frame
    t.driver.pane = ''; // 防 selection 帧插队
    await c.next(); // 吃掉 selection:null
    c.send({ type: 'key', key: 'F12' });
    expect(await c.next()).toEqual({ type: 'err', code: 'bad_key' });
    c.send('not json');
    expect(await c.next()).toEqual({ type: 'err', code: 'bad_frame' });
    c.send({ type: 'wat' });
    expect(await c.next()).toEqual({ type: 'err', code: 'bad_frame' });
    c.close();
  });

  test('text 帧带 images：isUploadRel 过滤 + imageReadHint 拼注入（提示在前，文本在后）；只发图也注入；空帧 bad_frame', async () => {
    const t = await chatCtx();
    const cwd = (t.server.db.query('SELECT cwd FROM projects WHERE id = ?').get(t.pid) as { cwd: string }).cwd;
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    await c.next(); // baseline

    // 文本 + 混合图片路径：仅上传目录内的 rel 保留并拼成执行机绝对路径，其余（非上传目录/越界）丢弃
    c.send({
      type: 'text',
      text: '看这个',
      images: [
        '.panda/uploads/x/a.png', // 合法
        'evil.png', // 非上传目录 → 丢
        '.panda/uploads/../secret', // 越界 → 丢
      ],
    });
    await waitFor(() => t.driver.sent.length === 1);
    const inj1 = t.driver.sent[0]!.text;
    expect(inj1).toContain('请先用 Read'); // imageReadHint 提示
    expect(inj1).toContain(`${cwd}/.panda/uploads/x/a.png`); // 合法图 → 执行机绝对路径
    expect(inj1).not.toContain('evil.png');
    expect(inj1).not.toContain('secret');
    expect(inj1).toContain('看这个'); // 用户文本保留
    expect(inj1.indexOf('请先用 Read')).toBeLessThan(inj1.indexOf('看这个')); // 提示在前、文本在后

    // 只发图（文本空但有图）：仍注入（纯提示 + 路径）
    c.send({ type: 'text', text: '', images: ['.panda/uploads/y/b.png'] });
    await waitFor(() => t.driver.sent.length === 2);
    const inj2 = t.driver.sent[1]!.text;
    expect(inj2).toContain('请先用 Read');
    expect(inj2).toContain(`${cwd}/.panda/uploads/y/b.png`);

    // 纯空帧（无文本无图）→ bad_frame，不注入
    c.send({ type: 'text', text: '   ' });
    expect(await c.next()).toEqual({ type: 'err', code: 'bad_frame' });
    expect(t.driver.sent.length).toBe(2);
    c.close();
  });

  test('user 消息附图富化：baseline/msg 帧回带 images(rel) 且正文剥离 AI 提示；纯图正文空；无图/非 user 原样透传', async () => {
    const t = await chatCtx();
    // 覆盖 chatCtx 默认 jsonl：一条 assistant（非 user，应原样）+ 一条带图 user（应富化）
    const combined = injected(
      ['/x/.panda/uploads/aa/a.png', '/x/.panda/uploads/bb/b.jpg'],
      '看这两张',
    );
    await fsp.writeFile(t.jsonl, asst('欢迎') + user(combined));

    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}`, t.aliceToken);
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    const [m0, m1] = baseline.msgs;
    // 非 user 原样：assistant 不挂 images
    expect(m0.role).toBe('assistant');
    expect(m0.images).toBeUndefined();
    // 带图 user：images = cwd 相对路径数组、正文剥掉 AI 向提示
    expect(m1.role).toBe('user');
    expect(m1.images).toEqual(['.panda/uploads/aa/a.png', '.panda/uploads/bb/b.jpg']);
    expect(m1.text).toBe('看这两张');
    expect(m1.text).not.toContain('请先用 Read');

    // tail 增量：再来一条纯图 user（无正文）→ msg 帧同样富化、正文为空串
    await fsp.appendFile(t.jsonl, user(injected(['/x/.panda/uploads/cc/c.webp'])));
    const inc = await c.next();
    expect(inc.type).toBe('msg');
    expect(inc.m.role).toBe('user');
    expect(inc.m.images).toEqual(['.panda/uploads/cc/c.webp']);
    expect(inc.m.text).toBe('');

    // 无图 user → 原样透传（不挂 images、正文不动）
    await fsp.appendFile(t.jsonl, user('就是一句普通的话'));
    const plain = await c.next();
    expect(plain.type).toBe('msg');
    expect(plain.m.role).toBe('user');
    expect(plain.m.images).toBeUndefined();
    expect(plain.m.text).toBe('就是一句普通的话');

    c.close();
    await c.closed;
  });
});

// ---------- term（假 PTY 桥） ----------

describe('WS term：PTY 桥', () => {
  test('openPty(tmux attach) → 输出透传 / resize与滚动控制帧 / binary 输入 / exit 帧 / 关连接回收', async () => {
    const t = await boot();
    const c = await connect(`${t.wsBase}/ws/term/${t.pid}?cols=100&rows=40`, t.aliceToken);

    await waitFor(() => t.driver.ptys.length === 1);
    const opened = t.driver.ptys[0]!;
    expect(opened.cmd).toBe(`tmux attach -t cc-${t.pid}-console`);
    expect(opened.cols).toBe(100);
    expect(opened.rows).toBe(40);

    // 服→客：PTY 输出 binary 透传
    opened.pty.emit('hello xterm');
    expect(new TextDecoder().decode(await c.nextBinary())).toBe('hello xterm');

    // 客→服：binary 输入透传；resize 控制帧
    c.ws.send(new TextEncoder().encode('ls\r'));
    await waitFor(() => opened.pty.writes.length === 1);
    expect(new TextDecoder().decode(opened.pty.writes[0] as Uint8Array)).toBe('ls\r');
    c.send({ type: 'resize', cols: 133, rows: 44 });
    await waitFor(() => opened.pty.resizes.length === 1);
    expect(opened.pty.resizes[0]).toEqual([133, 44]);

    t.driver.scrollDelayMs = 10;
    c.send({ type: 'scroll', direction: 'up', lines: 3 });
    c.send({ type: 'scroll', direction: 'down', lines: 999 });
    await waitFor(() => t.driver.scrolls.length === 2);
    expect(t.driver.scrolls).toEqual([
      { session: `cc-${t.pid}-console`, direction: 'up', lines: 3 },
      { session: `cc-${t.pid}-console`, direction: 'down', lines: 100 },
    ]);
    expect(t.driver.maxScrollInFlight).toBe(1);

    for (const invalid of [
      { type: 'scroll', direction: 'left', lines: 3 },
      { type: 'scroll', direction: 'up', lines: 0 },
      { type: 'scroll', direction: 'up', lines: '3' },
    ]) c.send(invalid);
    await Bun.sleep(20);
    expect(t.driver.scrolls).toHaveLength(2);

    // PTY 退出 → {type:'exit'} + 连接关闭
    opened.pty.exit(0);
    expect(await c.next()).toEqual({ type: 'exit' });
    await c.closed;

    // 关连接回收 PTY
    expect(opened.pty.closed).toBe(true);
  });

  test('issue #95：attach 前交还定尺权、断开后收回 220×50（否则窗口永远停在手机尺寸）', async () => {
    const t = await boot();
    const c = await connect(`${t.wsBase}/ws/term/${t.pid}?cols=52&rows=18`, t.aliceToken);
    await waitFor(() => t.driver.ptys.length === 1);
    const session = `cc-${t.pid}-console`;
    // 开：先 set window-size latest（size=null），再 attach——否则手机只看得见窗口左上角
    expect(t.driver.resizes).toEqual([{ session, size: null }]);

    c.close();
    await c.closed;
    // 关：收回标称尺寸。tmux detach 不会自己变回来，窗口一矮 CC 会把 ❯ 光标行顶出可视区，
    // capturePane 抓不到锚点 → 网页/审批侧整个菜单消失（52×18 实测复现）。
    await waitFor(() => t.driver.resizes.length === 2);
    expect(t.driver.resizes[1]).toEqual({ session, size: { cols: 220, rows: 50 } });
  });

  test('客户端主动断开 → PTY close 回收', async () => {
    const t = await boot();
    t.driver.sessions.add(`cc-${t.pid}`);
    const c = await connect(`${t.wsBase}/ws/term/${t.pid}`, t.aliceToken);
    await waitFor(() => t.driver.ptys.length === 1);
    c.close();
    await c.closed;
    await waitFor(() => t.driver.ptys[0]!.pty.closed);
  });
});

// ---------- chat 钉住对话（?conv=）：issue 现场模式 ----------

describe('WS chat ?conv=：钉住对话 live/只读 + mode 帧', () => {
  /** 两条对话：convA=激活（现场），convB=非激活（历史） */
  async function pinnedCtx() {
    const t = await boot();
    t.driver.sessions.add(`cc-${t.pid}`); // 注入自愈门禁判活要过
    const convA = crypto.randomUUID();
    const convB = crypto.randomUUID();
    const ins = t.server.db.query(
      'INSERT INTO conversations (id, project_id, label, created_ts) VALUES (?, ?, ?, ?)',
    );
    ins.run(convA, t.pid, '现场对话', Date.now());
    ins.run(convB, t.pid, '历史对话', Date.now());
    t.server.db
      .query('INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (?, ?, ?)')
      .run(t.pid, convA, Date.now());
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    const jsonlA = path.join(sub, `${convA}.jsonl`);
    const jsonlB = path.join(sub, `${convB}.jsonl`);
    await fsp.writeFile(jsonlA, asst('A1'));
    await fsp.writeFile(jsonlB, asst('B1') + asst('B2'));
    const setActive = (conv: string) =>
      t.server.db
        .query('UPDATE project_active_conv SET conv_id = ?, updated_ts = ? WHERE project_id = ?')
        .run(conv, Date.now(), t.pid);
    return { ...t, convA, convB, jsonlA, jsonlB, setActive };
  }

  test('conv 不属于项目 / 不存在 → 403（不泄露存在性）', async () => {
    const t = await pinnedCtx();
    const get = async (p: string) =>
      (await fetch(`${t.base}${p}`, { headers: { authorization: `Bearer ${t.aliceToken}` } })).status;
    // 别人项目的 conv：另建 bob 项目挂一条对话
    const proj2 = await fetch(`${t.base}/api/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t.bobToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'other', executorId: 1 }),
    }).then((r) => r.json() as Promise<any>);
    const foreign = crypto.randomUUID();
    t.server.db
      .query('INSERT INTO conversations (id, project_id, label, created_ts) VALUES (?, ?, ?, ?)')
      .run(foreign, proj2.project.id, '别家', Date.now());
    expect(await get(`/ws/chat/${t.pid}?conv=${foreign}`)).toBe(403);
    expect(await get(`/ws/chat/${t.pid}?conv=${crypto.randomUUID()}`)).toBe(403);
    // 合法 conv：鉴权全过，非 upgrade 请求到 upgrade 点 → 400
    expect(await get(`/ws/chat/${t.pid}?conv=${t.convA}`)).toBe(400);
    t.server.db.query(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, conversation_id, created_ts, updated_ts)
       VALUES (?, 'Design', 'Reserved conversation', 'claude', ?, ?, ?)`,
    ).run(t.pid, t.convB, Date.now(), Date.now());
    const reservedChat = await fetch(`${t.base}/ws/chat/${t.pid}?conv=${t.convB}`, {
      headers: { authorization: `Bearer ${t.aliceToken}` },
    });
    expect(reservedChat.status).toBe(409);
    expect(await reservedChat.json()).toMatchObject({
      error: {
        code: 'design.conversation_reserved',
        params: { conversationId: t.convB },
      },
    });
  });

  test('钉住激活对话 → mode live:true + baseline；菜单/注入全通', async () => {
    const t = await pinnedCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${t.convA}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs.map((m: any) => m.text)).toEqual(['A1']);
    // 菜单出现 → selection 帧照发
    t.driver.pane = MENU;
    const sel = await c.next();
    expect(sel.type).toBe('selection');
    expect(sel.sel.sig).toBe('Yes|No@0');
    // 注入照常
    c.send({ type: 'text', text: '干预一下' });
    await waitFor(() => t.driver.sent.length === 1);
    expect(t.driver.sent[0]!.text).toBe('干预一下');
    c.close();
    await c.closed;
  });

  test('钉住非激活对话 → mode live:false + 该对话历史；不发 selection；注入被拒 forbidden', async () => {
    const t = await pinnedCtx();
    t.driver.pane = MENU; // 屏上有菜单（属于激活对话 convA），只读连接不该看到
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${t.convB}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: false });
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs.map((m: any) => m.text)).toEqual(['B1', 'B2']); // 钉住的 convB，不是激活的 convA
    expect(baseline.selection).toBeNull();
    // 注入三型全拒，driver 不许被碰
    c.send({ type: 'text', text: 'x' });
    expect(await c.next()).toEqual({ type: 'err', code: 'forbidden' });
    c.send({ type: 'key', key: 'Escape' });
    expect(await c.next()).toEqual({ type: 'err', code: 'forbidden' });
    c.send({ type: 'select', index: 0, sig: 'Yes|No@0' });
    expect(await c.next()).toEqual({ type: 'err', code: 'forbidden' });
    expect(t.driver.sent.length).toBe(0);
    expect(t.driver.keys.length).toBe(0);
    // 只读也能收 tail 增量（历史回看在追加场景下照样活）
    await fsp.appendFile(t.jsonlB, asst('B3'));
    const m = await c.next();
    expect(m.type).toBe('msg');
    expect(m.m.text).toBe('B3');
    c.close();
    await c.closed;
  });

  test('live 状态翻转 → 推 mode 帧；转非 live 时清菜单；不重发 baseline', async () => {
    const t = await pinnedCtx();
    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${t.convA}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    await c.next(); // baseline(A1)
    t.driver.pane = MENU;
    expect((await c.next()).type).toBe('selection'); // 菜单已挂
    // 激活对话切到 convB → 钉住的 convA 变非 live：mode false + selection:null，无新 baseline
    t.setActive(t.convB);
    expect(await c.next()).toEqual({ type: 'mode', live: false });
    const cleared = await c.next();
    expect(cleared.type).toBe('selection');
    expect(cleared.sel).toBeNull();
    // 切回 → mode true，selection 重新可见
    t.setActive(t.convA);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    expect((await c.next()).type).toBe('selection');
    c.close();
    await c.closed;
  });
});

// ---------- chat 独立对话（对话模式 kind='chat'）：自身会话 + 恒可注入 ----------

describe('WS chat ?conv= chat 独立对话：自身会话 + 恒可注入（无单活跃门控）', () => {
  test('钉住 chat 对话：mode live:true + baseline；注入打到 chat-<id> 自身会话（即便非激活对话）', async () => {
    const t = await boot();
    const convC = crypto.randomUUID();
    // 独立聊天对话（kind='chat'）；故意不写 project_active_conv——issue 模式下这会被判只读，
    // chat 模式必须仍可注入，且注入目标是它自己的会话 chat-<convC>
    t.server.db
      .query(
        'INSERT INTO conversations (id, project_id, label, created_ts, agent, kind) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(convC, t.pid, '聊天', Date.now(), 'claude', 'chat');
    t.driver.sessions.add(`chat-${convC}`); // 会话活着（注入自愈门禁判活要过）
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, `${convC}.jsonl`), asst('你好'));

    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${convC}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs.map((m: any) => m.text)).toEqual(['你好']);

    // 注入放行（非激活也可），且落到 chat-<convC> 自身会话
    c.send({ type: 'text', text: '生成一张图' });
    await waitFor(() => t.driver.sent.length === 1);
    expect(t.driver.sent[0]).toEqual({ session: `chat-${convC}`, text: '生成一张图' });

    // 自身会话的菜单照常识别/推送
    t.driver.pane = MENU;
    const sel = await c.next();
    expect(sel.type).toBe('selection');
    expect(sel.sel.sig).toBe('Yes|No@0');
    c.send({ type: 'key', key: 'Down' });
    await waitFor(() => t.driver.keys.length === 1);
    expect(t.driver.keys[0]).toEqual({ session: `chat-${convC}`, key: 'Down' });

    c.close();
    await c.closed;
  });

  test('就绪门禁：codex 退回 shell 时不静默注入 → agent_not_ready 帧 + 触发重启（不把用户文本打进 bash）', async () => {
    const t = await boot();
    const convC = crypto.randomUUID();
    t.server.db
      .query(
        'INSERT INTO conversations (id, project_id, label, created_ts, agent, kind) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(convC, t.pid, '聊天', Date.now(), 'codex', 'chat');
    t.driver.sessions.add(`chat-${convC}`); // tmux 会话活着——覆盖的是「退回 shell」门禁而非死会话门禁
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, `${convC}.jsonl`), asst('你好'));

    // codex 已自更新退回 bash（tmux 会话仍活着，pane 是 shell 提示符）
    t.driver.pane = '🎉 Update ran successfully! Please restart Codex.\n[root@VM demo_project]#';

    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${convC}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    expect((await c.next()).type).toBe('baseline');

    c.send({ type: 'text', text: '生成一张图' });
    const err = await c.next();
    expect(err.type).toBe('err');
    expect(err.code).toBe('agent_not_ready');
    expect(err.msg).toContain('codex'); // 文案带 agent 名

    // 用户文本没被打进 shell；随后触发的自愈重启会发 codex 启动命令（非用户文本）
    await waitFor(() => t.driver.sent.some((s) => s.text.startsWith('/test/bin/codex ')));
    expect(t.driver.sent.some((s) => s.text === '生成一张图')).toBe(false);
    expect(t.driver.sent.find((s) => s.text.startsWith('/test/bin/codex '))!.session).toBe(
      `chat-${convC}`,
    );

    c.close();
    await c.closed;
  });
});

// ---------- 向上翻页历史（history 帧）：baseline 只给末段，history 逐页拉回更早 ----------

describe('WS chat 向上翻页历史', () => {
  test('baseline 末 60 条 + history 拉回更早、到顶 hasMore=false、无重叠、带稳定 off', async () => {
    const t = await boot();
    const convId = crypto.randomUUID();
    t.server.db
      .query(
        'INSERT INTO conversations (id, project_id, label, created_ts, agent, kind) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(convId, t.pid, '长对话', Date.now(), 'claude', 'chat');
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    const N = 150;
    const lines = Array.from({ length: N }, (_, i) => asst(`m${i}`));
    await fsp.writeFile(path.join(sub, `${convId}.jsonl`), lines.join('\n') + '\n');

    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${convId}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs.map((m: any) => m.text)).toEqual(
      Array.from({ length: 60 }, (_, i) => `m${90 + i}`), // 末 60 = m90..m149
    );
    expect(baseline.msgs.every((m: any) => typeof m.off === 'number')).toBe(true); // 带稳定标识
    expect(baseline.hasMore).toBe(true);

    // 第一次翻页：更早的 m0..m89 一窗即可装下（256KB ≫ 90 行）→ 一页拿全、到顶
    c.send({ type: 'history' });
    const h1 = await c.next();
    expect(h1.type).toBe('history');
    expect(h1.msgs.map((m: any) => m.text)).toEqual(Array.from({ length: 90 }, (_, i) => `m${i}`));
    expect(h1.hasMore).toBe(false);
    // 无重叠：更早页所有 off 都严格早于 baseline 最旧一条
    expect(h1.msgs[h1.msgs.length - 1].off).toBeLessThan(baseline.msgs[0].off);

    // 已到顶：再翻空帧、hasMore=false（不抖动、不越界）
    c.send({ type: 'history' });
    expect(await c.next()).toEqual({ type: 'history', msgs: [], hasMore: false });

    c.close();
    await c.closed;
  });

  test('超长工具输出超过初始字节窗时 baseline 仍按消息数回溯', async () => {
    const t = await boot();
    const convId = crypto.randomUUID();
    t.server.db
      .query(
        'INSERT INTO conversations (id, project_id, label, created_ts, agent, kind) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(convId, t.pid, '超长日志', Date.now(), 'claude', 'chat');
    const sub = path.join(t.claudeDir, 'proj-demo');
    await fsp.mkdir(sub, { recursive: true });
    const earlier = Array.from({ length: 30 }, (_, i) => asst(`before-${i}`));
    const giant = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(600 * 1024) }] },
    });
    const later = Array.from({ length: 40 }, (_, i) => asst(`after-${i}`));
    await fsp.writeFile(path.join(sub, `${convId}.jsonl`), [...earlier, giant, ...later].join('\n') + '\n');

    const c = await connect(`${t.wsBase}/ws/chat/${t.pid}?conv=${convId}`, t.aliceToken);
    expect(await c.next()).toEqual({ type: 'mode', live: true });
    const baseline = await c.next();
    expect(baseline.type).toBe('baseline');
    expect(baseline.msgs).toHaveLength(60);
    expect(baseline.msgs[0].text).toBe('before-11');
    expect(baseline.msgs.at(-1).text).toBe('after-39');
    expect(baseline.hasMore).toBe(true);

    c.send({ type: 'history', before: baseline.msgs[0].off });
    const history = await c.next();
    expect(history.msgs.map((m: any) => m.text)).toEqual(
      Array.from({ length: 11 }, (_, i) => `before-${i}`),
    );
    expect(history.msgs.every((m: any) => m.off < baseline.msgs[0].off)).toBe(true);
    expect(history.hasMore).toBe(false);
    c.close();
    await c.closed;
  });
});

// ---------- gated：真 tmux + script 的 LocalDriver.openPty 回环 ----------

const tmuxOk = spawnSync('tmux', ['-V']).status === 0;
const scriptOk = spawnSync('script', ['--version']).status === 0;
if (!tmuxOk || !scriptOk) {
  console.log('[ws.test] skip PTY 集成测试：本机 tmux/script 不可用');
}

describe.if(tmuxOk && scriptOk)('WS term 集成（真 tmux attach）', () => {
  test('对真 tmux 会话 attach：收到终端字节流', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-ws-real-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'panda.db');
    const claudeDir = path.join(dir, 'claude');
    const db0 = openDb(dbPath);
    migrate(db0);
    db0.query(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', '', ?, ?)`,
    ).run(path.join(dir, 'ws'), claudeDir);
    db0.close();

    const local = new LocalDriver();
    const server = await startServer({
      port: 0,
      dbPath,
      adminTokenFile: path.join(dir, 'admin-token'),
      driverFactory: () => local,
      feishu: null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
    });
    cleanups.push(() => server.stop());
    const adminToken = (await fsp.readFile(path.join(dir, 'admin-token'), 'utf8')).trim();
    const proj = await fetch(`http://127.0.0.1:${server.port}/api/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'real', executorId: 1 }),
    }).then((r) => r.json() as Promise<any>);
    const pid = proj.project.id as number;
    // 显式终端接入只认 sessions 表登记的导入会话；避免按 cc-* 名称误连 agent tmux。
    const session = `legacy-shell-${Date.now().toString(36)}`;
    const adminId = server.db.query<{ id: number }, []>("SELECT id FROM users WHERE username = 'admin'").get()!.id;
    server.db
      .query('INSERT INTO sessions (name, executor_id, project_id, owner_user_id) VALUES (?, ?, ?, ?)')
      .run(session, 1, pid, adminId);

    await local.createSession(session, dir);
    cleanups.push(async () => {
      await local.killSession(session).catch(() => {});
    });

    const c = await connect(
      `ws://127.0.0.1:${server.port}/ws/term/${pid}?cols=80&rows=24&session=${session}`,
      adminToken,
    );
    const first = await c.nextBinary(5000); // tmux attach 重绘屏幕即有字节流
    expect(first.length).toBeGreaterThan(0);
    c.send({ type: 'resize', cols: 90, rows: 30 }); // 不炸即可（LocalDriver resize 为 no-op）
    c.close();
    await c.closed;
  }, 15000);
});

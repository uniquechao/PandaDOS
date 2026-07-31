/**
 * web/server 集成测试：临时 DB + LocalDriver（tmux 面 stub）拉起完整 server（随机端口），
 * 走一遍冒烟主链：healthz → 首启 admin token 登录 → 建用户（落 workspace）→
 * 建项目（自动订阅属主）→ 建 issue（引擎接管到 planning）→ 列表可见 →
 * 属主隔离（他人 403）→ 飞书未配置静默路径（绑定 503）→ 静态服务 → 优雅停机不抛。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { LocalDriver } from '../executor/local';
import { executorStatusOf, startServer, trustFileOf, type MandoServer } from './server';

/** tmux 面全部 stub 成内存实现（测试机不真起 tmux/claude）；文件/git 面保持真 LocalDriver */
class FakeDriver extends LocalDriver {
  sessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
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
  override async sendKey() {}
  override async capturePane() {
    return '';
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Ctx {
  server: MandoServer;
  base: string;
  dir: string;
  ws: string;
  tokenFile: string;
  driver: FakeDriver;
}

async function boot(publicDir?: string): Promise<Ctx> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-server-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'mando.db');
  const ws = path.join(dir, 'ws');
  const claudeDir = path.join(dir, 'home', '.claude', 'projects');
  const tokenFile = path.join(dir, 'admin-token');

  // 预置一台本机执行机（host=127.0.0.1 且无 keyRef → LocalDriver 规则；测试注入 FakeDriver）
  const db0 = openDb(dbPath);
  migrate(db0);
  db0.query(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', ?, ?)`,
  ).run(ws, claudeDir);
  db0.close();

  const driver = new FakeDriver();
  // LLM 指到本地不可达地址、单次重试：开发机/CI 环境常带真 MANDO_LLM_API_KEY，
  // 不摘会让冒烟真调 驱动大模型（模块起名不定、耗时不定甚至超时）。配置在 startServer
  // 装配时一次性捕获（createLlmClient），随后立刻恢复 env，不影响同进程其它测试文件。
  const LLM_ENV: Record<string, string> = {
    MANDO_LLM_BASE_URL: 'http://127.0.0.1:1',
    MANDO_LLM_API_KEY: 'test-disabled',
    MANDO_LLM_RETRIES: '1',
    MANDO_LLM_TIMEOUT_MS: '500',
  };
  const savedEnv = Object.fromEntries(Object.keys(LLM_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, LLM_ENV);
  let server: MandoServer;
  try {
    server = await startServer({
      port: 0,
      dbPath,
      adminTokenFile: tokenFile,
      driverFactory: () => driver,
      feishu: null, // 飞书不配置（静默路径）
      engineConfig: { tickMs: 3_600_000 }, // 测试内不靠后台 tick
      statusIntervalMs: 3_600_000,
      ...(publicDir ? { publicDir } : {}),
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  cleanups.push(() => server.stop());
  return { server, base: `http://127.0.0.1:${server.port}`, dir, ws, tokenFile, driver };
}

async function api(
  ctx: Ctx,
  method: string,
  p: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any; headers: Headers }> {
  const resp = await fetch(`${ctx.base}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: resp.status, body: await resp.json().catch(() => null), headers: resp.headers };
}

describe('server 集成冒烟（完整装配）', () => {
  test('空数据库启动自动创建唯一系统本机执行机，重启保持幂等', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-local-bootstrap-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'mando.db');
    const defaults = {
      workspaceRoot: path.join(dir, 'workspace'),
      // 非标准测试路径：避免服务启动时的 best-effort 技能安装后台任务干扰幂等断言。
      claudeDir: path.join(dir, 'claude-projects'),
      codexDir: path.join(dir, 'home', '.codex', 'sessions'),
      supportsClaude: true,
      supportsCodex: true,
      checkedTs: 123,
    };
    const driver = new FakeDriver();
    const options = {
      port: 0,
      dbPath,
      adminTokenFile: path.join(dir, 'admin-token'),
      driverFactory: () => driver,
      feishu: null as null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
      localExecutorDefaults: defaults,
    };

    const first = await startServer(options);
    expect(
      first.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executors WHERE is_system_local = 1')
        .get()!.n,
    ).toBe(1);
    const local = first.db
      .query<
        { host: string; workspace_root: string; codex_dir: string; supports_codex: number },
        []
      >('SELECT host, workspace_root, codex_dir, supports_codex FROM executors LIMIT 1')
      .get()!;
    expect(local).toEqual({
      host: '127.0.0.1',
      workspace_root: defaults.workspaceRoot,
      codex_dir: defaults.codexDir,
      supports_codex: 1,
    });
    await first.stop();

    const second = await startServer(options);
    cleanups.push(() => second.stop());
    expect(second.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executors').get()!.n).toBe(1);
  });

  test('healthz → admin 登录 → 建用户/项目/issue → 属主隔离 → 优雅停机', async () => {
    const ctx = await boot();

    // ---- healthz：迁移链全量（001-015/030-038/040/060）+ executor online + engine running ----
    const h = await api(ctx, 'GET', '/healthz');
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    expect(h.body.db.latest).toBe(60);
    expect(h.body.db.applied).toBe(26);
    expect(h.body.executors).toEqual([{ id: 1, name: 'local', status: 'online' }]);
    expect(h.body.engine.running).toBe(true);
    expect(h.body.feishu).toBe(false);

    // ---- 首启 admin token：0600 文件可登录（明文只此一处，不在任何响应/日志里） ----
    const st = await fsp.stat(ctx.tokenFile);
    expect(st.mode & 0o777).toBe(0o600);
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    expect(adminToken).toMatch(/^[0-9a-f]{48}$/);

    const bad = await api(ctx, 'POST', '/api/login', undefined, { username: 'admin', token: 'wrong' });
    expect(bad.status).toBe(401);
    const login = await api(ctx, 'POST', '/api/login', undefined, { username: 'admin', token: adminToken });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe('admin');
    expect(login.headers.get('set-cookie')).toContain('mando_token=');

    // ---- 建用户：workspace 经 Driver 落到执行机（u<id> 目录 + .mando/keep） ----
    const alice = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'alice' });
    expect(alice.status).toBe(200);
    expect(alice.body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(alice.body.workspace.warnings).toEqual([]);
    const aliceId = alice.body.user.id as number;
    const keep = await fsp.readFile(path.join(ctx.ws, `u${aliceId}`, '.mando/keep'), 'utf8');
    expect(keep).toContain('alice');
    const bob = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'bob' });
    expect(bob.status).toBe(200);

    // ---- 建项目：默认 cwd 落在属主 workspace 内 + 属主自动订阅 ----
    const proj = await api(ctx, 'POST', '/api/projects', alice.body.token, {
      name: 'demo',
      executorId: 1,
    });
    expect(proj.status).toBe(200);
    const pid = proj.body.project.id as number;
    expect(proj.body.project.ownerUserId ?? proj.body.project.owner_user_id ?? aliceId).toBe(aliceId);
    expect(String(proj.body.project.cwd)).toStartWith(path.join(ctx.ws, `u${aliceId}`) + '/');
    const subs = await api(ctx, 'GET', '/api/me/subscriptions', alice.body.token);
    expect(subs.status).toBe(200);
    expect(subs.body.some((s: any) => s.scope === 'project' && s.targetId === pid)).toBe(true);

    // ---- 建 issue（debug：跳过澄清，直接被引擎接管到 planning，注入经 FakeDriver） ----
    const issue = await api(ctx, 'POST', `/api/projects/${pid}/issues`, alice.body.token, {
      title: '冒烟 bug',
      body: '集成冒烟',
      category: 'debug',
    });
    expect(issue.status).toBe(200);
    expect(issue.body.issue.status).toBe('planning');
    // 模块会话已（模拟）拉起：boot 已把 LLM 指到不可达地址 → 分类器必走确定性回退 general-work
    expect(ctx.driver.sessions.has(`cc-${pid}-m-general-work`)).toBe(true);
    expect(ctx.driver.sent.some((s) => s.text.includes('claude --session-id'))).toBe(true);

    // ---- 列表可见 + 属主隔离：他人 403 / 未登录 401 / admin 恒过 ----
    const list = await api(ctx, 'GET', `/api/projects/${pid}/issues`, alice.body.token);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`)).status).toBe(401);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`, bob.body.token)).status).toBe(403);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`, adminToken)).status).toBe(200);
    // 普通用户项目列表只见自己的
    const bobProjects = await api(ctx, 'GET', '/api/projects', bob.body.token);
    expect(bobProjects.body).toEqual([]);

    // ---- 飞书未配置：绑定接口 503，其余照常（通知路径静默跳过已由引擎流程隐式覆盖） ----
    const fs503 = await api(ctx, 'POST', '/api/me/feishu', alice.body.token, { openid: 'ou_test1234' });
    expect(fs503.status).toBe(503);

    // ---- 静态服务：/ 回 index.html（build-ui 产物） ----
    const home = await fetch(`${ctx.base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type') ?? '').toContain('text/html');

    // ---- 优雅停机：不抛、幂等，端口随即关闭 ----
    await ctx.server.stop();
    await ctx.server.stop(); // 幂等
    await expect(fetch(`${ctx.base}/healthz`)).rejects.toBeTruthy();
  });

  test('对话模式：建 chat 项目 → 建/列/激活/重命名/归档对话 → 拒建 issue → fs/raw 内联', async () => {
    const ctx = await boot();
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const alice = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'alice' });
    const at = alice.body.token as string;

    // 建 chat 项目
    const proj = await api(ctx, 'POST', '/api/projects', at, {
      name: 'chatproj',
      executorId: 1,
      kind: 'chat',
    });
    expect(proj.status).toBe(200);
    expect(proj.body.project.kind).toBe('chat');
    const pid = proj.body.project.id as number;
    const cwd = String(proj.body.project.cwd);

    // chat 项目拒建 issue（引擎中央守卫 → 400）
    const badIssue = await api(ctx, 'POST', `/api/projects/${pid}/issues`, at, { title: '不该建' });
    expect(badIssue.status).toBe(400);

    // 建两条对话（claude + codex）→ 列表返回 2 条
    const c1 = await api(ctx, 'POST', `/api/projects/${pid}/conversations`, at, {
      label: '设计',
      agent: 'claude',
    });
    expect(c1.body.conversation.kind).toBe('chat');
    const c2 = await api(ctx, 'POST', `/api/projects/${pid}/conversations`, at, {
      label: '重构',
      agent: 'codex',
    });
    expect(c2.body.conversation.agent).toBe('codex');
    const cid1 = c1.body.conversation.id as string;
    const cid2 = c2.body.conversation.id as string;
    expect((await api(ctx, 'GET', `/api/projects/${pid}/conversations`, at)).body.conversations.length).toBe(2);

    // 激活两条 → 各起独立会话 chat-<id>，互不 kill（都在）
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid1}/activate`, at)).status).toBe(200);
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid2}/activate`, at)).status).toBe(200);
    expect(ctx.driver.sessions.has(`chat-${cid1}`)).toBe(true);
    expect(ctx.driver.sessions.has(`chat-${cid2}`)).toBe(true);
    // claude/codex 各自的启动命令都注入了各自的会话
    expect(ctx.driver.sent.some((s) => s.session === `chat-${cid1}` && s.text.includes('claude'))).toBe(true);
    expect(ctx.driver.sent.some((s) => s.session === `chat-${cid2}` && s.text.includes('codex'))).toBe(true);

    // 重命名 + 归档
    const rn = await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid1}/rename`, at, { label: '设计稿' });
    expect(rn.body.conversation.label).toBe('设计稿');
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid2}/archive`, at)).status).toBe(200);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/conversations`, at)).body.conversations.length).toBe(1);

    // fs/raw 内联预览：写个 html，raw 返回按扩展名的 content-type + inline + CSP sandbox
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(cwd, 'page.html'), '<h1>hi</h1>');
    const raw = await fetch(`${ctx.base}/api/projects/${pid}/fs/raw?path=page.html`, {
      headers: { authorization: `Bearer ${at}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(raw.headers.get('content-disposition')).toContain('inline');
    expect(raw.headers.get('content-security-policy')).toBe('sandbox');
    expect(await raw.text()).toBe('<h1>hi</h1>');

    await ctx.server.stop();
  });

  test('重启不再重发 admin token（ensureAdminUser 幂等）', async () => {
    const ctx = await boot();
    const token1 = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    await ctx.server.stop();

    const server2 = await startServer({
      port: 0,
      dbPath: path.join(ctx.dir, 'mando.db'),
      adminTokenFile: path.join(ctx.dir, 'admin-token-2'), // 若误重建会写到这里
      driverFactory: () => ctx.driver,
      feishu: null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
    });
    cleanups.push(() => server2.stop());
    // 第二次启动没有新 token 文件（admin 已存在），旧 token 仍可登录
    expect(fsp.stat(path.join(ctx.dir, 'admin-token-2'))).rejects.toBeTruthy();
    const login = await fetch(`http://127.0.0.1:${server2.port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', token: token1 }),
    });
    expect(login.status).toBe(200);
  });
});

describe('serveStatic 静态服务（缓存头 + 缺失资源 404）', () => {
  test('/assets immutable、缺失404不回退HTML、index no-cache、无扩展名导航回退', async () => {
    const pub = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-pub-'));
    cleanups.push(() => fsp.rm(pub, { recursive: true, force: true }));
    await fsp.mkdir(path.join(pub, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(pub, 'index.html'), '<!doctype html><title>t</title><body>HOME_MARKER</body>');
    await fsp.writeFile(path.join(pub, 'assets', 'app-abc123.js'), 'export const x = 1;');

    const ctx = await boot(pub);

    // 存在的 hash chunk：200 + JS MIME + immutable 长缓存
    const js = await fetch(`${ctx.base}/assets/app-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type') ?? '').toContain('javascript');
    expect(js.headers.get('cache-control') ?? '').toContain('immutable');
    expect(await js.text()).toContain('export const x');

    // 缺失的 chunk：404，且绝不回退成 index.html（text/html）——这是 MIME 报错的根因
    const missing = await fetch(`${ctx.base}/assets/gone-999.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type') ?? '').not.toContain('text/html');

    // 带扩展名但非 /assets 的缺失文件同样 404，不回退 HTML
    const missPng = await fetch(`${ctx.base}/nope.png`);
    expect(missPng.status).toBe(404);
    expect(missPng.headers.get('content-type') ?? '').not.toContain('text/html');

    // index.html：/ 与 /index.html 都 200 + text/html + no-cache（发版即时生效）
    for (const p of ['/', '/index.html']) {
      const r = await fetch(`${ctx.base}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type') ?? '').toContain('text/html');
      expect(r.headers.get('cache-control') ?? '').toContain('no-cache');
      expect(await r.text()).toContain('HOME_MARKER');
    }

    // 无扩展名导航路径（hash 路由直链兜底）：回退 index.html
    const navp = await fetch(`${ctx.base}/p/7/term`);
    expect(navp.status).toBe(200);
    expect(navp.headers.get('content-type') ?? '').toContain('text/html');
    expect(await navp.text()).toContain('HOME_MARKER');
  });
});

describe('装配纯函数', () => {
  test('executorStatusOf：无 status=本机在线；connected/closed/其余 → online/offline/unknown', () => {
    expect(executorStatusOf(new LocalDriver())).toBe('online');
    const withStatus = (status: string) => ({ status }) as unknown as LocalDriver;
    expect(executorStatusOf(withStatus('connected'))).toBe('online');
    expect(executorStatusOf(withStatus('closed'))).toBe('offline');
    expect(executorStatusOf(withStatus('disconnected'))).toBe('unknown');
    expect(executorStatusOf(withStatus('connecting'))).toBe('unknown');
  });

  test('trustFileOf：…/.claude/projects → 同 home 的 .claude.json；推不出 undefined', () => {
    expect(trustFileOf('/root/.claude/projects')).toBe('/root/.claude.json');
    expect(trustFileOf('/root/.claude/projects/')).toBe('/root/.claude.json');
    expect(trustFileOf('/data/claude-projects')).toBeUndefined();
  });
});

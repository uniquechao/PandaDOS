/**
 * routes/git 单测 —— 图形化 git 视图四端点：
 * 概览（commits 结构化记录 + changes/upstream/ahead）× 提交详情（files/message/rename/merge/root）
 * × 单文件 diff × 工作区 diff（含未跟踪），叠鉴权矩阵与非 git 仓库/空仓库降级。
 * Driver 用 LocalDriver 对临时目录跑真 git（控制面测试替身，driver.ts 双重身份）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import type { ImplCommitsSnapshot } from '../../issues/engine';
import { gitLockKey, KeyedMutex } from '../../issues/mutex';
import { LocalDriver } from '../../executor/local';
import { LlmNotConfiguredError, type LlmClient, type LlmMessage } from '../../agents/llm';
import { authDepsFromDb, createDispatcher } from '../middleware';
import {
  buildGitAiPrompt, GIT_AI_KINDS, gitRoutes,
  type GitCommitRec, type IssueGitInfo, type IssueGitRef,
} from './git';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const driver = new LocalDriver();

async function commit(dir: string, msg: string): Promise<void> {
  await driver.git(dir, [
    '-c', 'user.email=t@t', '-c', 'user.name=t',
    'commit', '-q', '-m', msg,
  ]);
}

/**
 * 造一段带分支/合并/重命名的历史（提交顺序即时间序）：
 *   root: A f.txt('one')                        [main]
 *   分支 feat: A h.txt                          [feat]
 *   main: M f.txt(+two) + A g.txt
 *   main: merge feat (--no-ff)
 *   main: R g.txt → g2.txt
 */
async function initRepo(dir: string): Promise<void> {
  await driver.git(dir, ['init', '-q', '-b', 'main']);
  await fsp.writeFile(path.join(dir, 'f.txt'), 'one\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'first commit');
  await driver.git(dir, ['checkout', '-q', '-b', 'feat']);
  await fsp.writeFile(path.join(dir, 'h.txt'), 'feat\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'feat: add h');
  await driver.git(dir, ['checkout', '-q', 'main']);
  await fsp.writeFile(path.join(dir, 'f.txt'), 'one\ntwo\n');
  await fsp.writeFile(path.join(dir, 'g.txt'), 'g\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'second: touch f g');
  await driver.git(dir, [
    '-c', 'user.email=t@t', '-c', 'user.name=t',
    'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat',
  ]);
  await driver.git(dir, ['mv', 'g.txt', 'g2.txt']);
  await commit(dir, 'rename g');
}

async function setup(opts?: { llm?: LlmClient }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-git-route-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));

  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );
  // 项目 1：真 git 仓库；项目 2：普通目录；项目 3：空仓库（init 未提交）
  const repo = path.join(dir, 'repo');
  const plain = path.join(dir, 'plain');
  const empty = path.join(dir, 'empty');
  await fsp.mkdir(repo, { recursive: true });
  await fsp.mkdir(plain, { recursive: true });
  await fsp.mkdir(empty, { recursive: true });
  await initRepo(repo);
  await driver.git(empty, ['init', '-q', '-b', 'empty-main']);
  const ins = db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  );
  ins.run('repo', repo, alice.user.id, Date.now());
  ins.run('plain', plain, alice.user.id, Date.now());
  ins.run('empty', empty, alice.user.id, Date.now());

  const mutex = new KeyedMutex();
  const dispatch = createDispatcher(
    gitRoutes({
      db,
      driverForProject: () => driver,
      mutex,
      ...(opts?.llm ? { llm: opts.llm } : {}),
    }),
    authDepsFromDb(db, users),
  );
  return { db, dispatch, repo, empty, mutex, admin, alice, bob };
}

function get(p: string, token?: string): Request {
  return new Request(`http://t${p}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function post(p: string, body: unknown, token?: string): Request {
  return new Request(`http://t${p}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** LlmClient 替身：记录收到的消息，回定制内容（或抛错） */
function fakeLlm(reply: string | Error = 'AI 结果文本'): {
  llm: LlmClient;
  calls: LlmMessage[][];
  last(): LlmMessage[];
  userText(): string;
} {
  const calls: LlmMessage[][] = [];
  const llm: LlmClient = {
    async chat(messages) {
      calls.push(messages);
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [], raw: { role: 'assistant', content: reply } };
    },
  };
  const last = (): LlmMessage[] => calls[calls.length - 1]!;
  return { llm, calls, last, userText: () => String(last()[1]!.content) };
}

async function j(r: Response | Promise<Response> | null): Promise<{ status: number; body: any }> {
  const resp = await r!;
  return { status: resp.status, body: await resp.json() };
}

/** 概览里按 subject 找提交（date-order 下同刻提交的相对顺序不作强断言） */
function bySubject(commits: GitCommitRec[], subject: string): GitCommitRec {
  const c = commits.find((x) => x.subject === subject);
  expect(c).toBeDefined();
  return c!;
}

describe('GET /api/projects/:projectId/git', () => {
  test('鉴权矩阵：未登录 401 / 非属主 403 / 属主与 admin 过 / 不存在项目 admin 404·普通 403', async () => {
    const s = await setup();
    expect((await j(s.dispatch(get('/api/projects/1/git')))).status).toBe(401);
    expect((await j(s.dispatch(get('/api/projects/1/git', s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(get('/api/projects/1/git', s.alice.token)))).status).toBe(200);
    expect((await j(s.dispatch(get('/api/projects/1/git', s.admin.token)))).status).toBe(200);
    expect((await j(s.dispatch(get('/api/projects/99/git', s.admin.token)))).status).toBe(404);
    expect((await j(s.dispatch(get('/api/projects/99/git', s.bob.token)))).status).toBe(403);
  });

  test('happy path：branch/dirty + 结构化 commits（sha/parents/refs/author/ts/subject）', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/1/git', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.cwd).toBe(s.repo);
    expect(r.body.branch).toBe('main');
    expect(r.body.dirty).toBe(0);
    expect(r.body.changes).toEqual([]);
    const commits: GitCommitRec[] = r.body.commits;
    expect(commits.length).toBe(5);
    const root = bySubject(commits, 'first commit');
    expect(root.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(root.short.length).toBeGreaterThanOrEqual(7);
    expect(root.parents).toEqual([]);
    expect(root.author).toBe('t');
    expect(root.ts).toBeGreaterThan(1_600_000_000_000);
    const merge = bySubject(commits, 'merge feat');
    expect(merge.parents.length).toBe(2);
    const head = bySubject(commits, 'rename g');
    expect(head.refs.join(',')).toContain('HEAD -> main');
    expect(head.parents).toEqual([merge.sha]);
    // 拓扑保证：子提交行号在父提交之前
    const rowOf = new Map(commits.map((c, i) => [c.sha, i]));
    for (const c of commits) {
      for (const p of c.parents) expect(rowOf.get(c.sha)!).toBeLessThan(rowOf.get(p)!);
    }
  });

  test('工作区有改动 → dirty 计数 + changes 明细（?? 与 M）', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.repo, 'new.txt'), 'x');
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'changed\n');
    const r = await j(s.dispatch(get('/api/projects/1/git', s.alice.token)));
    expect(r.body.dirty).toBe(2);
    const byPath = new Map(r.body.changes.map((c: any) => [c.path, c.status]));
    expect(byPath.get('new.txt')).toBe('??');
    expect(byPath.get('f.txt')).toBe(' M');
  });

  test('有本地上游 → upstream/ahead 解析', async () => {
    const s = await setup();
    await driver.git(s.repo, ['branch', 'up']);
    await driver.git(s.repo, ['branch', '-u', 'up', 'main']);
    await fsp.writeFile(path.join(s.repo, 'z.txt'), 'z\n');
    await driver.git(s.repo, ['add', '.']);
    await commit(s.repo, 'ahead one');
    const r = await j(s.dispatch(get('/api/projects/1/git', s.alice.token)));
    expect(r.body.upstream).toBe('up');
    expect(r.body.ahead).toBe(1);
    expect(r.body.behind).toBe(0);
  });

  test('非 git 仓库 → ok:false + error（200，前端按 ok 渲染）', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/2/git', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('非 git 仓库');
    expect(typeof r.body.cwd).toBe('string');
  });

  test('detached HEAD → branch 空串', async () => {
    const s = await setup();
    await driver.git(s.repo, ['checkout', '-q', '--detach']);
    const r = await j(s.dispatch(get('/api/projects/1/git', s.alice.token)));
    expect(r.body.ok).toBe(true);
    expect(r.body.branch).toBe('');
  });

  test('空仓库（无提交）→ ok:true 降级：commits 空、dirty 0', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/3/git', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.commits).toEqual([]);
    expect(r.body.dirty).toBe(0);
  });
});

describe('GET /api/projects/:projectId/git/branches', () => {
  test('返回当前分支，并按本地/远程跟踪引用分组（排除 remote HEAD 别名）', async () => {
    const s = await setup();
    const head = (await driver.git(s.repo, ['rev-parse', 'HEAD'])).out.trim();
    await driver.git(s.repo, ['update-ref', 'refs/remotes/origin/main', head]);
    // 名称以 /HEAD 结尾也可以是普通 direct ref，不能和 origin/HEAD 符号别名一起误删。
    await driver.git(s.repo, ['update-ref', 'refs/remotes/origin/topic/HEAD', head]);
    await driver.git(s.repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const r = await j(s.dispatch(get('/api/projects/1/git/branches', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      cwd: s.repo,
      current: 'main',
      local: [
        { name: 'feat', ref: 'refs/heads/feat' },
        { name: 'main', ref: 'refs/heads/main' },
      ],
      remote: [
        { name: 'origin/main', ref: 'refs/remotes/origin/main' },
        { name: 'origin/topic/HEAD', ref: 'refs/remotes/origin/topic/HEAD' },
      ],
    });
  });

  test('鉴权矩阵：未登录 401 / 非成员 403 / 属主与 admin 可读', async () => {
    const s = await setup();
    expect((await j(s.dispatch(get('/api/projects/1/git/branches')))).status).toBe(401);
    expect((await j(s.dispatch(get('/api/projects/1/git/branches', s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(get('/api/projects/1/git/branches', s.alice.token)))).status).toBe(200);
    expect((await j(s.dispatch(get('/api/projects/1/git/branches', s.admin.token)))).status).toBe(200);
  });

  test('空仓库：保留 unborn 当前分支名，引用列表为空', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/3/git/branches', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.current).toBe('empty-main');
    expect(r.body.local).toEqual([]);
    expect(r.body.remote).toEqual([]);
  });

  test('detached HEAD：current 为空，但仍返回本地分支', async () => {
    const s = await setup();
    await driver.git(s.repo, ['checkout', '-q', '--detach']);
    const r = await j(s.dispatch(get('/api/projects/1/git/branches', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.current).toBe('');
    expect(r.body.local.map((b: { name: string }) => b.name)).toEqual(['feat', 'main']);
  });

  test('非 git 仓库沿用预期态：200 + ok:false', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/2/git/branches', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toContain('非 git 仓库');
    expect(r.body.cwd).toBe(s.repo.replace(/repo$/, 'plain'));
  });
});

describe('POST /api/projects/:projectId/git/stage|unstage', () => {
  test('stage 支持逐文件与全部，包含删除文件；未选择的改动保持未暂存', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'selected\n');
    await fsp.writeFile(path.join(s.repo, 'new.txt'), 'new\n');
    await fsp.writeFile(path.join(s.repo, 'later.txt'), 'later\n');
    await fsp.unlink(path.join(s.repo, 'h.txt'));

    const selected = await j(s.dispatch(post(
      '/api/projects/1/git/stage',
      { paths: ['f.txt', 'new.txt', 'h.txt', 'new.txt'] },
      s.alice.token,
    )));
    expect(selected.status).toBe(200);
    expect(selected.body).toEqual({ ok: true });
    const staged = (await driver.git(s.repo, ['diff', '--cached', '--name-status'])).out;
    expect(staged).toContain('M\tf.txt');
    expect(staged).toContain('A\tnew.txt');
    expect(staged).toContain('D\th.txt');
    expect(staged).not.toContain('later.txt');

    const all = await j(s.dispatch(post(
      '/api/projects/1/git/stage',
      { all: true },
      s.alice.token,
    )));
    expect(all.status).toBe(200);
    expect((await driver.git(s.repo, ['diff', '--cached', '--name-only'])).out).toContain('later.txt');
  });

  test('unstage 支持逐文件与全部，且不丢工作区内容', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'changed\n');
    await fsp.writeFile(path.join(s.repo, 'new.txt'), 'new\n');
    await driver.git(s.repo, ['add', '-A']);

    const one = await j(s.dispatch(post(
      '/api/projects/1/git/unstage',
      { paths: ['new.txt'] },
      s.alice.token,
    )));
    expect(one.status).toBe(200);
    expect((await driver.git(s.repo, ['diff', '--cached', '--name-only'])).out.trim()).toBe('f.txt');
    expect(await fsp.readFile(path.join(s.repo, 'new.txt'), 'utf8')).toBe('new\n');

    const all = await j(s.dispatch(post(
      '/api/projects/1/git/unstage',
      { all: true },
      s.alice.token,
    )));
    expect(all.status).toBe(200);
    expect((await driver.git(s.repo, ['diff', '--cached', '--name-only'])).out).toBe('');
    expect(await fsp.readFile(path.join(s.repo, 'f.txt'), 'utf8')).toBe('changed\n');
  });

  test('unborn 仓库也能取消全部暂存，文件仍留在工作区', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.empty, 'initial.txt'), 'initial\n');
    await driver.git(s.empty, ['add', 'initial.txt']);

    const r = await j(s.dispatch(post(
      '/api/projects/3/git/unstage',
      { all: true },
      s.alice.token,
    )));
    expect(r.status).toBe(200);
    expect((await driver.git(s.empty, ['status', '--porcelain=v1'])).out.trim()).toBe('?? initial.txt');
    expect(await fsp.readFile(path.join(s.empty, 'initial.txt'), 'utf8')).toBe('initial\n');
  });

  test('鉴权、选择器与路径参数校验', async () => {
    const s = await setup();
    const url = '/api/projects/1/git/stage';
    expect((await j(s.dispatch(post(url, { all: true })))).status).toBe(401);
    expect((await j(s.dispatch(post(url, { all: true }, s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(post(url, { all: true }, s.admin.token)))).status).toBe(200);
    s.db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 0)')
      .run(s.bob.user.id);
    expect((await j(s.dispatch(post(url, { all: true }, s.bob.token)))).status).toBe(200);
    for (const body of [
      {},
      { all: false },
      { all: true, paths: ['f.txt'] },
      { paths: [] },
      { paths: [''] },
      { paths: ['/etc/passwd'] },
      { paths: ['../outside'] },
      { paths: ['dir/../../outside'] },
      { paths: ['bad\0name'] },
      { paths: [7] },
    ]) {
      const r = await j(s.dispatch(post(url, body, s.alice.token)));
      expect(r.status).toBe(400);
      expect(r.body.ok).toBe(false);
      expect(typeof r.body.error).toBe('string');
    }
  });

  test('真实 git 写失败返回可操作的错误信息；非 git 仓库仍是预期态', async () => {
    const s = await setup();
    const missing = await j(s.dispatch(post(
      '/api/projects/1/git/stage',
      { paths: ['missing.txt'] },
      s.alice.token,
    )));
    expect(missing.status).toBe(409);
    expect(missing.body.error).toContain('pathspec');

    const plain = await j(s.dispatch(post(
      '/api/projects/2/git/stage',
      { all: true },
      s.alice.token,
    )));
    expect(plain.status).toBe(200);
    expect(plain.body).toMatchObject({ ok: false, error: '非 git 仓库' });
  });

  test('写操作使用共享项目 Git 锁：外部持锁期间真实 stage 不会执行', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.repo, 'locked.txt'), 'locked\n');
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(1), async () => {
      entered();
      await hold;
    });
    await acquired;

    let settled = false;
    const request = j(s.dispatch(post(
      '/api/projects/1/git/stage',
      { paths: ['locked.txt'] },
      s.alice.token,
    ))).finally(() => {
      settled = true;
    });
    await Bun.sleep(40);
    expect(settled).toBe(false);
    expect((await driver.git(s.repo, ['status', '--porcelain=v1', '--', 'locked.txt'])).out.trim())
      .toBe('?? locked.txt');

    release();
    await holder;
    expect((await request).status).toBe(200);
    expect((await driver.git(s.repo, ['status', '--porcelain=v1', '--', 'locked.txt'])).out.trim())
      .toBe('A  locked.txt');
  });
});

describe('POST /api/projects/:projectId/git/commit', () => {
  test('只提交已暂存内容，保留未暂存改动，并返回新提交 sha', async () => {
    const s = await setup();
    await driver.git(s.repo, ['config', 'user.email', 'route@test']);
    await driver.git(s.repo, ['config', 'user.name', 'Route Test']);
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'staged\n');
    await driver.git(s.repo, ['add', 'f.txt']);
    await fsp.writeFile(path.join(s.repo, 'later.txt'), 'not staged\n');

    const before = (await driver.git(s.repo, ['rev-parse', 'HEAD'])).out.trim();
    const r = await j(s.dispatch(post(
      '/api/projects/1/git/commit',
      { message: 'route commit\n\nbody' },
      s.alice.token,
    )));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(r.body.sha).not.toBe(before);
    expect(r.body.short).toBe(r.body.sha.slice(0, r.body.short.length));
    expect((await driver.git(s.repo, ['show', '--format=', '--name-only', 'HEAD'])).out.trim()).toBe('f.txt');
    expect((await driver.git(s.repo, ['show', '-s', '--format=%B', 'HEAD'])).out.trim())
      .toBe('route commit\n\nbody');
    expect((await driver.git(s.repo, ['status', '--porcelain=v1', '--', 'later.txt'])).out.trim())
      .toBe('?? later.txt');
  });

  test('空/超长 message 拒绝；没有已暂存内容返回 409，绝不顺手 add', async () => {
    const s = await setup();
    for (const message of ['', '   ', 'x'.repeat(20_001)]) {
      const r = await j(s.dispatch(post(
        '/api/projects/1/git/commit',
        { message },
        s.alice.token,
      )));
      expect(r.status).toBe(400);
    }
    await fsp.writeFile(path.join(s.repo, 'only-worktree.txt'), 'no auto add\n');
    const none = await j(s.dispatch(post(
      '/api/projects/1/git/commit',
      { message: 'must not commit' },
      s.alice.token,
    )));
    expect(none.status).toBe(409);
    expect(none.body.error).toContain('没有已暂存');
    expect((await driver.git(s.repo, ['status', '--porcelain=v1', '--', 'only-worktree.txt'])).out.trim())
      .toBe('?? only-worktree.txt');
  });

  test('git commit 失败时反馈 stderr', async () => {
    const s = await setup();
    // 覆盖宿主机可能存在的全局 identity，保证本真实仓库稳定触发 commit 失败。
    await driver.git(s.repo, ['config', 'user.name', '']);
    await driver.git(s.repo, ['config', 'user.email', '']);
    await fsp.writeFile(path.join(s.repo, 'identity.txt'), 'identity\n');
    await driver.git(s.repo, ['add', 'identity.txt']);
    const r = await j(s.dispatch(post(
      '/api/projects/1/git/commit',
      { message: 'missing identity' },
      s.alice.token,
    )));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/identity|email|name/i);
  });
});

describe('POST /api/projects/:projectId/git/push', () => {
  test('当前分支首次 push 建立 origin upstream，后续 push 复用 upstream', async () => {
    const s = await setup();
    const bare = path.join(path.dirname(s.repo), 'push-origin.git');
    await driver.git(s.repo, ['init', '--bare', '-q', bare]);
    await driver.git(s.repo, ['remote', 'add', 'origin', bare]);

    const first = await j(s.dispatch(post(
      '/api/projects/1/git/push',
      {},
      s.alice.token,
    )));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      createdUpstream: true,
    });
    expect((await driver.git(s.repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).out.trim())
      .toBe('origin/main');

    await driver.git(s.repo, ['config', 'user.email', 'route@test']);
    await driver.git(s.repo, ['config', 'user.name', 'Route Test']);
    await fsp.writeFile(path.join(s.repo, 'pushed.txt'), 'pushed\n');
    await driver.git(s.repo, ['add', 'pushed.txt']);
    await commit(s.repo, 'push again');
    const second = await j(s.dispatch(post(
      '/api/projects/1/git/push',
      {},
      s.alice.token,
    )));
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      ok: true,
      branch: 'main',
      upstream: 'origin/main',
      createdUpstream: false,
    });
    expect((await driver.git(bare, ['rev-parse', 'refs/heads/main'])).out.trim())
      .toBe((await driver.git(s.repo, ['rev-parse', 'HEAD'])).out.trim());
  });

  test('无 origin、detached HEAD、无提交分支均返回明确失败', async () => {
    const s = await setup();
    const noRemote = await j(s.dispatch(post(
      '/api/projects/1/git/push',
      {},
      s.alice.token,
    )));
    expect(noRemote.status).toBe(409);
    expect(noRemote.body.error).toContain('origin');

    await driver.git(s.repo, ['checkout', '-q', '--detach']);
    const detached = await j(s.dispatch(post(
      '/api/projects/1/git/push',
      {},
      s.alice.token,
    )));
    expect(detached.status).toBe(409);
    expect(detached.body.error).toContain('detached HEAD');

    const unborn = await j(s.dispatch(post(
      '/api/projects/3/git/push',
      {},
      s.alice.token,
    )));
    expect(unborn.status).toBe(409);
    expect(unborn.body.error).toContain('尚无提交');
  });

  test('远程 push 命令失败返回 502 与 git 诊断', async () => {
    const s = await setup();
    await driver.git(s.repo, [
      'remote', 'add', 'origin', path.join(path.dirname(s.repo), 'missing-origin.git'),
    ]);
    const r = await j(s.dispatch(post(
      '/api/projects/1/git/push',
      {},
      s.alice.token,
    )));
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toMatch(/推送|repository|remote/i);
  });
});

describe('GET /api/projects/:projectId/git/commits/:sha', () => {
  async function commits(s: Awaited<ReturnType<typeof setup>>): Promise<GitCommitRec[]> {
    return (await j(s.dispatch(get('/api/projects/1/git', s.alice.token)))).body.commits;
  }

  test('普通提交：meta + files（M/A + numstat 行数）+ 完整 message', async () => {
    const s = await setup();
    const c = bySubject(await commits(s), 'second: touch f g');
    const r = await j(s.dispatch(get(`/api/projects/1/git/commits/${c.sha}`, s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.sha).toBe(c.sha);
    expect(r.body.author).toBe('t');
    expect(r.body.authorEmail).toBe('t@t');
    expect(r.body.authorTs).toBeGreaterThan(1_600_000_000_000);
    expect(r.body.committer).toBe('t');
    expect(r.body.message).toBe('second: touch f g');
    const byPath = new Map(r.body.files.map((f: any) => [f.path, f]));
    expect((byPath.get('f.txt') as any).status).toBe('M');
    expect((byPath.get('f.txt') as any).adds).toBe(1);
    expect((byPath.get('f.txt') as any).dels).toBe(0);
    expect((byPath.get('g.txt') as any).status).toBe('A');
  });

  test('根提交：--root 兜底 → files 有 A f.txt', async () => {
    const s = await setup();
    const c = bySubject(await commits(s), 'first commit');
    const r = await j(s.dispatch(get(`/api/projects/1/git/commits/${c.sha}`, s.alice.token)));
    expect(r.body.parents).toEqual([]);
    expect(r.body.files).toEqual([{ status: 'A', path: 'f.txt', adds: 1, dels: 0 }]);
  });

  test('合并提交：按第一父 diff → 呈现被并入分支的文件', async () => {
    const s = await setup();
    const c = bySubject(await commits(s), 'merge feat');
    const r = await j(s.dispatch(get(`/api/projects/1/git/commits/${c.sha}`, s.alice.token)));
    expect(r.body.parents.length).toBe(2);
    expect(r.body.files.map((f: any) => f.path)).toEqual(['h.txt']);
  });

  test('重命名提交：status R100 + oldPath', async () => {
    const s = await setup();
    const c = bySubject(await commits(s), 'rename g');
    const r = await j(s.dispatch(get(`/api/projects/1/git/commits/${c.sha}`, s.alice.token)));
    const f = r.body.files[0];
    expect(f.status).toMatch(/^R\d*$/);
    expect(f.path).toBe('g2.txt');
    expect(f.oldPath).toBe('g.txt');
  });

  test('sha 非法 400 / 不存在 404 / 鉴权 401·403', async () => {
    const s = await setup();
    expect((await j(s.dispatch(get('/api/projects/1/git/commits/zzz', s.alice.token)))).status).toBe(400);
    expect((await j(s.dispatch(get('/api/projects/1/git/commits/deadbeef', s.alice.token)))).status).toBe(404);
    expect((await j(s.dispatch(get('/api/projects/1/git/commits/deadbeef')))).status).toBe(401);
    expect((await j(s.dispatch(get('/api/projects/1/git/commits/deadbeef', s.bob.token)))).status).toBe(403);
  });
});

describe('GET /api/projects/:projectId/git/commits/:sha/diff', () => {
  test('单文件补丁：含 +two；缺 path 400；合并提交对第一父', async () => {
    const s = await setup();
    const all = (await j(s.dispatch(get('/api/projects/1/git', s.alice.token)))).body.commits;
    const second = bySubject(all, 'second: touch f g');
    const r = await j(
      s.dispatch(get(`/api/projects/1/git/commits/${second.sha}/diff?path=f.txt`, s.alice.token)),
    );
    expect(r.body.ok).toBe(true);
    expect(r.body.diff).toContain('+two');
    expect(r.body.diff).not.toContain('g.txt'); // path 过滤生效
    expect(r.body.truncated).toBe(false);

    const merge = bySubject(all, 'merge feat');
    const mr = await j(
      s.dispatch(get(`/api/projects/1/git/commits/${merge.sha}/diff?path=h.txt`, s.alice.token)),
    );
    expect(mr.body.diff).toContain('+feat');

    expect(
      (await j(s.dispatch(get(`/api/projects/1/git/commits/${second.sha}/diff`, s.alice.token)))).status,
    ).toBe(400);
  });
});

describe('GET /api/projects/:projectId/git/worktree/diff', () => {
  test('已跟踪文件对 HEAD diff；未跟踪走 --no-index 全新增；缺 path 400', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'changed\n');
    await fsp.writeFile(path.join(s.repo, 'new.txt'), 'brand new\n');
    const r = await j(
      s.dispatch(get('/api/projects/1/git/worktree/diff?path=f.txt', s.alice.token)),
    );
    expect(r.body.ok).toBe(true);
    expect(r.body.diff).toContain('-one');
    expect(r.body.diff).toContain('+changed');

    const u = await j(
      s.dispatch(get('/api/projects/1/git/worktree/diff?path=new.txt&untracked=1', s.alice.token)),
    );
    expect(u.body.ok).toBe(true);
    expect(u.body.diff).toContain('+brand new');

    expect((await j(s.dispatch(get('/api/projects/1/git/worktree/diff', s.alice.token)))).status).toBe(400);
  });
});

// ---------- per-issue git（本 issue 的提交历史 + 改动范围） ----------

/**
 * 造一个带「未合并 issue 分支」的仓库：
 *   main:    A base.txt('base')
 *   issue/7: A feature.txt('hi') + M base.txt(+extra)   ← 两条提交，均未回 main
 */
async function initIssueRepo(dir: string): Promise<void> {
  await driver.git(dir, ['init', '-q', '-b', 'main']);
  await fsp.writeFile(path.join(dir, 'base.txt'), 'base\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'base commit');
  await driver.git(dir, ['checkout', '-q', '-b', 'issue/7']);
  await fsp.writeFile(path.join(dir, 'feature.txt'), 'hi\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'issue7: add feature');
  await fsp.writeFile(path.join(dir, 'base.txt'), 'base\nextra\n');
  await driver.git(dir, ['add', '.']);
  await commit(dir, 'issue7: touch base');
  await driver.git(dir, ['checkout', '-q', 'main']);
}

/** impl_commits 耐久快照 fixture（shas 无需真实存在——快照的意义就是离库可显示） */
const SNAP: ImplCommitsSnapshot = {
  base: 'aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000',
  tip: 'bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000',
  commits: [
    { sha: 'bbbb0000bbbb0000bbbb0000bbbb0000bbbb0000', short: 'bbbb000', author: 't', ts: 1700000000000, subject: 'snap: work' },
  ],
  files: [{ status: 'A', path: 'snap.txt', adds: 3, dels: 0 }],
};

/**
 * issueGitRef 替身：issue 7 → issue/7 分支，issue 8 → 尚未落分支，
 * issue 9 → 同 7 但活跃（执行中，附工作区未提交改动），issue 14 → 活跃且分支未落，
 * issue 15 → 分支已删但有耐久快照，issue 16 → 起点锚失效但有耐久快照，
 * 其余 → null（非本项目）。
 */
const issueRefStub = (projectId: number, issueId: number): IssueGitRef | null => {
  if (projectId !== 1) return null;
  if (issueId === 7) return { branch: 'issue/7', base: 'main' };
  if (issueId === 8) return { branch: 'issue/8', base: 'main' }; // 分支不存在
  if (issueId === 9) return { branch: 'issue/7', base: 'main', active: true };
  if (issueId === 14) return { branch: 'issue/nope', base: 'main', active: true };
  if (issueId === 15) return { branch: 'issue/deleted', base: 'main', snapshot: () => SNAP };
  if (issueId === 16) return { branch: 'issue/7', base: 'main', startSha: 'deadbeef', snapshot: () => SNAP };
  return null;
};

async function setupIssue() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-issgit-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  await initIssueRepo(repo);
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  ).run('repo', repo, alice.user.id, Date.now());
  const dispatch = createDispatcher(
    gitRoutes({ db, driverForProject: () => driver, issueGitRef: issueRefStub }),
    authDepsFromDb(db, users),
  );
  return { dispatch, repo, admin, alice, bob };
}

describe('GET /api/projects/:projectId/issues/:issueId/git', () => {
  test('鉴权矩阵：未登录 401 / 非属主 403 / 属主 200', async () => {
    const s = await setupIssue();
    expect((await j(s.dispatch(get('/api/projects/1/issues/7/git')))).status).toBe(401);
    expect((await j(s.dispatch(get('/api/projects/1/issues/7/git', s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(get('/api/projects/1/issues/7/git', s.alice.token)))).status).toBe(200);
  });

  test('本 issue 提交历史（base..branch）+ 改动范围（base...branch）', async () => {
    const s = await setupIssue();
    const r = await j(s.dispatch(get('/api/projects/1/issues/7/git', s.alice.token)));
    expect(r.status).toBe(200);
    const body: IssueGitInfo = r.body;
    expect(body.ok).toBe(true);
    expect(body.branch).toBe('issue/7');
    expect(body.base).toBe('main');
    expect(body.exists).toBe(true);
    expect(body.ahead).toBe(2);
    // 两条 issue 提交，base commit 不在内
    const subjects = body.commits.map((c) => c.subject);
    expect(subjects).toContain('issue7: add feature');
    expect(subjects).toContain('issue7: touch base');
    expect(subjects).not.toContain('base commit');
    // 改动范围：新增 feature.txt + 修改 base.txt
    const paths = body.files.map((f) => f.path).sort();
    expect(paths).toEqual(['base.txt', 'feature.txt']);
    const feat = body.files.find((f) => f.path === 'feature.txt')!;
    expect(feat.status).toBe('A');
    expect(feat.adds).toBe(1);
    expect(body.stat).toContain('feature.txt');
  });

  test('分支尚未存在（issue 未启动）→ exists:false + 空历史/空改动', async () => {
    const s = await setupIssue();
    const r = await j(s.dispatch(get('/api/projects/1/issues/8/git', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.exists).toBe(false);
    expect(r.body.commits).toEqual([]);
    expect(r.body.files).toEqual([]);
  });

  test('推送状态全谱：none → unpushed → ahead → pushed（终点相对 origin/<branch>）', async () => {
    const s = await setupIssue();
    const info = async (): Promise<IssueGitInfo> =>
      (await j(s.dispatch(get('/api/projects/1/issues/7/git', s.alice.token)))).body;
    // 未配 origin 远程 → none
    expect((await info()).push).toEqual({ state: 'none' });
    // 配了 origin 但该分支从未推送 → unpushed
    const bare = path.join(s.repo, '..', 'origin.git');
    await driver.git(s.repo, ['init', '--bare', '-q', bare]);
    await driver.git(s.repo, ['remote', 'add', 'origin', bare]);
    expect((await info()).push).toEqual({ state: 'unpushed' });
    // 只推到 issue/7~1 → 终点领先 origin 1 条
    await driver.git(s.repo, ['push', '-q', 'origin', 'issue/7~1:refs/heads/issue/7']);
    await driver.git(s.repo, ['fetch', '-q', 'origin']);
    expect((await info()).push).toEqual({ state: 'ahead', n: 1 });
    // 推平 → pushed
    await driver.git(s.repo, ['push', '-q', 'origin', 'issue/7:refs/heads/issue/7']);
    await driver.git(s.repo, ['fetch', '-q', 'origin']);
    expect((await info()).push).toEqual({ state: 'pushed' });
    // 分支未落（exists:false）→ 不带 push
    const nf: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/8/git', s.alice.token)))).body;
    expect(nf.push).toBeUndefined();
  });

  test('活跃 issue：附 worktree 未提交改动（已跟踪修改 + 未跟踪新增，porcelain 两列码）', async () => {
    const s = await setupIssue();
    // 弄脏工作区：改一个已跟踪文件 + 加一个未跟踪文件（当前在 main，base.txt 存在）
    await fsp.appendFile(path.join(s.repo, 'base.txt'), 'dirty\n');
    await fsp.writeFile(path.join(s.repo, 'wip.txt'), 'wip\n');
    const r = await j(s.dispatch(get('/api/projects/1/issues/9/git', s.alice.token)));
    expect(r.status).toBe(200);
    const body: IssueGitInfo = r.body;
    expect(body.ok).toBe(true);
    const wt = body.worktree!;
    expect(wt).toBeDefined();
    const byPath = new Map(wt.map((c) => [c.path, c.status]));
    expect(byPath.get('base.txt')).toBe(' M');
    expect(byPath.get('wip.txt')).toBe('??');
    // commit 范围部分不受影响（issue/7 的两条提交照常）
    expect(body.ahead).toBe(2);
  });

  test('非活跃 issue：无 worktree 字段（工作树不属于它）', async () => {
    const s = await setupIssue();
    await fsp.writeFile(path.join(s.repo, 'wip.txt'), 'wip\n');
    const body: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/7/git', s.alice.token)))).body;
    expect(body.worktree).toBeUndefined();
  });

  test('活跃但分支未落（exists:false）：仍附 worktree——正在进行的改动先于分支/提交可见', async () => {
    const s = await setupIssue();
    await fsp.writeFile(path.join(s.repo, 'wip.txt'), 'wip\n');
    const body: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/14/git', s.alice.token)))).body;
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(false);
    expect(body.worktree!.map((c) => c.path)).toContain('wip.txt');
  });

  test('快照兜底：分支已删但有 impl_commits 快照 → source:snapshot 回填 commits/files', async () => {
    const s = await setupIssue();
    const body: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/15/git', s.alice.token)))).body;
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(true); // 有快照 = 当年落过改动，不再报「未落分支」
    expect(body.source).toBe('snapshot');
    expect(body.startSha).toBe(SNAP.base);
    expect(body.ahead).toBe(1);
    expect(body.commits.map((c) => c.subject)).toEqual(['snap: work']);
    expect(body.files.map((f) => f.path)).toEqual(['snap.txt']);
    expect(body.stat).toBe('');
    expect(body.push).toEqual({ state: 'none' }); // 未配远程；快照终点对象也不在库
  });

  test('快照兜底：起点锚失效（sha 已不在库）→ 用快照，不退回 base...branch 混入他人提交', async () => {
    const s = await setupIssue();
    const body: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/16/git', s.alice.token)))).body;
    expect(body.source).toBe('snapshot');
    // 若退回 base...branch 会看到 issue/7 的 base.txt/feature.txt——快照兜底后只有快照文件
    expect(body.files.map((f) => f.path)).toEqual(['snap.txt']);
    expect(body.commits.map((c) => c.subject)).toEqual(['snap: work']);
  });

  test('非本项目 issue / 未装配 issueGitRef → 404', async () => {
    const s = await setupIssue();
    expect((await j(s.dispatch(get('/api/projects/1/issues/99/git', s.alice.token)))).status).toBe(404);
    // 未装配：另起一个不带 issueGitRef 的 dispatcher
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const a = users.create('a');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', 'ws', 'claude')`,
    );
    db.query(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?,1,?,?,?)`)
      .run('p', s.repo, a.user.id, Date.now());
    const d2 = createDispatcher(gitRoutes({ db, driverForProject: () => driver }), authDepsFromDb(db, users));
    expect((await j(d2(get('/api/projects/1/issues/7/git', a.token)))).status).toBe(404);
  });
});

describe('GET /api/projects/:projectId/issues/:issueId/git/diff', () => {
  test('本 issue 单文件 diff（base...branch -- path）', async () => {
    const s = await setupIssue();
    const r = await j(
      s.dispatch(get('/api/projects/1/issues/7/git/diff?path=base.txt', s.alice.token)),
    );
    expect(r.body.ok).toBe(true);
    expect(r.body.diff).toContain('+extra');
    const nf = await j(
      s.dispatch(get('/api/projects/1/issues/7/git/diff?path=feature.txt', s.alice.token)),
    );
    expect(nf.body.diff).toContain('+hi');
    expect((await j(s.dispatch(get('/api/projects/1/issues/7/git/diff', s.alice.token)))).status).toBe(400);
  });
});

// ---------- 固定/共享分支：只取本 issue 自己的提交（startSha..endSha），不混他 issue ----------

/**
 * 造一条固定工作分支 `work`，上面按顺序做了三条 issue 的提交（用户不每次从 main checkout）：
 *   main:  A base.txt                                    [main]
 *   work:  A a1.txt (issueA#1)  A a2.txt (issueA#2)      ← issueA：start=base tip, tip=a2
 *          A b1.txt (issueB#1)                           ← issueB：start=a2,     tip=b1
 *          A c1.txt (issueC#1)                           ← issueC：start=b1,     仍在推进(无 tip)
 * 断言：每条 issue 的「提交/改动」只含它自己的 commit/文件，base...work 会把三者全混进来。
 */
async function initSharedRepo(dir: string): Promise<{
  base: string; a2: string; b1: string; c1: string;
}> {
  const head = async () => (await driver.git(dir, ['rev-parse', 'HEAD'])).out.trim();
  const add = async (file: string, msg: string) => {
    await fsp.writeFile(path.join(dir, file), `${file}\n`);
    await driver.git(dir, ['add', '.']);
    await commit(dir, msg);
    return head();
  };
  await driver.git(dir, ['init', '-q', '-b', 'main']);
  const base = await add('base.txt', 'base commit');
  await driver.git(dir, ['checkout', '-q', '-b', 'work']);
  await add('a1.txt', 'A#1');
  const a2 = await add('a2.txt', 'A#2');
  const b1 = await add('b1.txt', 'B#1');
  // 远端在 b1 时刻收到 work（A/B 已推送），随后 C#1 只在本地 → 终点锚定的推送状态可分辨
  const bare = path.join(path.dirname(dir), 'origin.git');
  await driver.git(dir, ['init', '--bare', '-q', bare]);
  await driver.git(dir, ['remote', 'add', 'origin', bare]);
  await driver.git(dir, ['push', '-q', 'origin', 'work']);
  const c1 = await add('c1.txt', 'C#1');
  return { base, a2, b1, c1 };
}

async function setupShared() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-sharedgit-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const alice = users.create('alice');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  const sha = await initSharedRepo(repo);
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`,
  ).run('repo', repo, alice.user.id, Date.now());
  // 三条 issue 都落在固定分支 work：A/B 已定格（有 endSha），C 仍在推进（无 endSha→用分支 tip）
  const stub = (projectId: number, issueId: number): IssueGitRef | null => {
    if (projectId !== 1) return null;
    if (issueId === 10) return { branch: 'work', base: 'main', startSha: sha.base, endSha: sha.a2 };
    if (issueId === 11) return { branch: 'work', base: 'main', startSha: sha.a2, endSha: sha.b1 };
    if (issueId === 12) return { branch: 'work', base: 'main', startSha: sha.b1 }; // 无 endSha
    if (issueId === 13) return { branch: 'work', base: 'main', startSha: 'deadbeef' }; // 失效锚点→降级
    return null;
  };
  const dispatch = createDispatcher(
    gitRoutes({ db, driverForProject: () => driver, issueGitRef: stub }),
    authDepsFromDb(db, users),
  );
  return { dispatch, alice, sha };
}

describe('per-issue git —— 固定/共享分支只取本 issue 提交', () => {
  test('已定格 issue：startSha..endSha 只含本 issue 的 commit/文件（不含前后 issue）', async () => {
    const s = await setupShared();
    const a = await j(s.dispatch(get('/api/projects/1/issues/10/git', s.alice.token)));
    expect(a.status).toBe(200);
    const body: IssueGitInfo = a.body;
    expect(body.ok).toBe(true);
    expect(body.exists).toBe(true);
    expect(body.startSha).toBe(s.sha.base);
    expect(body.ahead).toBe(2); // A#1 + A#2，不含 base、B、C
    expect(body.commits.map((c) => c.subject).sort()).toEqual(['A#1', 'A#2']);
    expect(body.files.map((f) => f.path).sort()).toEqual(['a1.txt', 'a2.txt']);
    expect(body.stat).not.toContain('b1.txt');
    expect(body.stat).not.toContain('base.txt');
  });

  test('中间 issue：只含 B 的 commit（不被前 A / 后 C 污染）', async () => {
    const s = await setupShared();
    const b: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/11/git', s.alice.token)))).body;
    expect(b.commits.map((c) => c.subject)).toEqual(['B#1']);
    expect(b.files.map((f) => f.path)).toEqual(['b1.txt']);
  });

  test('推进中 issue（无 endSha）：startSha..分支 tip，含 C 起后的所有提交', async () => {
    const s = await setupShared();
    const c: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/12/git', s.alice.token)))).body;
    expect(c.commits.map((x) => x.subject)).toEqual(['C#1']);
    expect(c.files.map((f) => f.path)).toEqual(['c1.txt']);
  });

  test('失效起点锚（sha 已不在库）→ 降级回 base...branch（含全分支）', async () => {
    const s = await setupShared();
    const d: IssueGitInfo = (await j(s.dispatch(get('/api/projects/1/issues/13/git', s.alice.token)))).body;
    expect(d.startSha).toBeUndefined();
    // 降级：整条 work 相对 main → 四个文件都在
    expect(d.files.map((f) => f.path).sort()).toEqual(['a1.txt', 'a2.txt', 'b1.txt', 'c1.txt']);
  });

  test('推送状态按范围终点算：已定格且推过的 A/B 是 pushed，推进中的 C 领先 1 条', async () => {
    const s = await setupShared();
    const at = async (iid: number): Promise<IssueGitInfo> =>
      (await j(s.dispatch(get(`/api/projects/1/issues/${iid}/git`, s.alice.token)))).body;
    // 分支 tip（c1）未推送，但 A/B 的终点（a2/b1）已在 origin 上 → 不把 C 的账算到它们头上
    expect((await at(10)).push).toEqual({ state: 'pushed' });
    expect((await at(11)).push).toEqual({ state: 'pushed' });
    expect((await at(12)).push).toEqual({ state: 'ahead', n: 1 });
  });

  test('单文件 diff 也走本 issue 范围：B 的 diff 命中 b1，取 a1/c1 为空', async () => {
    const s = await setupShared();
    const hit = await j(s.dispatch(get('/api/projects/1/issues/11/git/diff?path=b1.txt', s.alice.token)));
    expect(hit.body.ok).toBe(true);
    expect(hit.body.diff).toContain('+b1.txt');
    const miss = await j(s.dispatch(get('/api/projects/1/issues/11/git/diff?path=a1.txt', s.alice.token)));
    expect(miss.body.ok).toBe(true);
    expect(miss.body.diff).toBe(''); // a1 不在 B 的范围内 → 空 diff
  });
});

// ---------- AI 助读端点 POST /git/ai ----------

describe('POST /api/projects/:projectId/git/ai —— AI 助读', () => {
  /** 概览取一条提交 sha（AI 各 kind 先拿 sha；此 GET 不用 llm） */
  async function commitSha(s: Awaited<ReturnType<typeof setup>>, subject: string): Promise<string> {
    const all = (await j(s.dispatch(get('/api/projects/1/git', s.alice.token)))).body.commits;
    return bySubject(all, subject).sha;
  }

  test('鉴权：未登录 401 / 非属主 403', async () => {
    const s = await setup({ llm: fakeLlm().llm });
    expect((await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-message' })))).status).toBe(401);
    expect((await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-message' }, s.bob.token)))).status).toBe(403);
  });

  test('未接入 llm → 503（即便 kind 合法）', async () => {
    const s = await setup(); // 不传 llm
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-message' }, s.alice.token)));
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });

  test('非法 kind → 400（未调 llm）', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'nope' }, s.alice.token)));
    expect(r.status).toBe(400);
    expect(f.calls.length).toBe(0);
  });

  test('commit-* 非法 sha → 400；file-explain 缺 path → 400（均未调 llm）', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    expect((await j(s.dispatch(
      post('/api/projects/1/git/ai', { kind: 'commit-summary', sha: 'zzz' }, s.alice.token),
    ))).status).toBe(400);
    expect((await j(s.dispatch(
      post('/api/projects/1/git/ai', { kind: 'file-explain' }, s.alice.token),
    ))).status).toBe(400);
    expect(f.calls.length).toBe(0);
  });

  test('commit-summary：拼 标题+提交信息+文件清单+diff → { ok, text }', async () => {
    const f = fakeLlm('这是总结');
    const s = await setup({ llm: f.llm });
    const sha = await commitSha(s, 'second: touch f g');
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-summary', sha }, s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, text: '这是总结' });
    const u = f.userText();
    expect(u).toContain('提交标题：second: touch f g');
    expect(u).toContain('提交信息：');
    expect(u).toContain('改动文件：');
    expect(u).toContain('f.txt');
    expect(u).toContain('+two'); // diff
  });

  test('commit-risk：走风险 system 提示 + 含 diff', async () => {
    const f = fakeLlm('风险点');
    const s = await setup({ llm: f.llm });
    const sha = await commitSha(s, 'second: touch f g');
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-risk', sha }, s.alice.token)));
    expect(r.body.text).toBe('风险点');
    expect(String(f.last()[0]!.content)).toContain('风险');
    expect(f.userText()).toContain('+two');
  });

  test('commit-explain：只喂 diff（不含 提交信息/改动文件 段）', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    const sha = await commitSha(s, 'second: touch f g');
    await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-explain', sha }, s.alice.token)));
    const u = f.userText();
    expect(u).toContain('+two');
    expect(u).not.toContain('改动文件：');
    expect(u).not.toContain('提交信息：');
  });

  test('file-explain（提交内单文件）：sha+path → 只该文件 diff', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    const sha = await commitSha(s, 'second: touch f g');
    await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'file-explain', sha, path: 'f.txt' }, s.alice.token)));
    const u = f.userText();
    expect(u).toContain('文件：f.txt');
    expect(u).toContain('+two');
    expect(u).not.toContain('g.txt'); // path 过滤
  });

  test('file-explain（工作区未跟踪文件）：无 sha + untracked → 全新增', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    await fsp.writeFile(path.join(s.repo, 'fresh.txt'), 'brand new\n');
    const r = await j(s.dispatch(
      post('/api/projects/1/git/ai', { kind: 'file-explain', path: 'fresh.txt', untracked: true }, s.alice.token),
    ));
    expect(r.body.ok).toBe(true);
    expect(f.userText()).toContain('+brand new');
  });

  test('commit-message：工作区改动 → 喂 status 清单 + diff', async () => {
    const f = fakeLlm('feat: 改了 f');
    const s = await setup({ llm: f.llm });
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'one\ntwo\nthree\n');
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-message' }, s.alice.token)));
    expect(r.body).toEqual({ ok: true, text: 'feat: 改了 f' });
    const u = f.userText();
    expect(u).toContain('f.txt'); // status 清单
    expect(u).toContain('+three'); // diff
  });

  test('commit-message：存在已暂存内容时只分析 index，不混入同文件未暂存内容', async () => {
    const f = fakeLlm('feat: 只提交已暂存内容');
    const s = await setup({ llm: f.llm });
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'one\ntwo\nstaged line\n');
    await driver.git(s.repo, ['add', 'f.txt']);
    await fsp.writeFile(path.join(s.repo, 'f.txt'), 'one\ntwo\nstaged line\nunstaged line\n');

    const r = await j(s.dispatch(post(
      '/api/projects/1/git/ai',
      { kind: 'commit-message' },
      s.alice.token,
    )));
    expect(r.body).toEqual({ ok: true, text: 'feat: 只提交已暂存内容' });
    expect(f.userText()).toContain('+staged line');
    expect(f.userText()).not.toContain('unstaged line');
  });

  test('commit-message：unborn 仓库已暂存的新文件包含实际 staged diff', async () => {
    const f = fakeLlm('feat: initial');
    const s = await setup({ llm: f.llm });
    await fsp.writeFile(path.join(s.empty, 'initial.txt'), 'initial staged content\n');
    await driver.git(s.empty, ['add', 'initial.txt']);

    const r = await j(s.dispatch(post(
      '/api/projects/3/git/ai',
      { kind: 'commit-message' },
      s.alice.token,
    )));
    expect(r.body).toEqual({ ok: true, text: 'feat: initial' });
    expect(f.userText()).toContain('initial.txt');
    expect(f.userText()).toContain('+initial staged content');
  });

  test('commit-message：工作区干净 → 无可分析改动 400（未调 llm）', async () => {
    const f = fakeLlm();
    const s = await setup({ llm: f.llm });
    const r = await j(s.dispatch(post('/api/projects/1/git/ai', { kind: 'commit-message' }, s.alice.token)));
    expect(r.status).toBe(400);
    expect(f.calls.length).toBe(0);
  });

  test('AI 返回空 → 502；AI 抛错 → 502', async () => {
    const s1 = await setup({ llm: fakeLlm('').llm });
    const sha1 = await commitSha(s1, 'first commit');
    expect((await j(s1.dispatch(
      post('/api/projects/1/git/ai', { kind: 'commit-explain', sha: sha1 }, s1.alice.token),
    ))).status).toBe(502);

    const s2 = await setup({ llm: fakeLlm(new Error('boom')).llm });
    const sha2 = await commitSha(s2, 'first commit');
    expect((await j(s2.dispatch(
      post('/api/projects/1/git/ai', { kind: 'commit-explain', sha: sha2 }, s2.alice.token),
    ))).status).toBe(502);
  });

  test('驱动大模型未配置 → 统一 503 配置提示', async () => {
    const s = await setup({ llm: fakeLlm(new LlmNotConfiguredError()).llm });
    const sha = await commitSha(s, 'first commit');
    const r = await j(s.dispatch(
      post('/api/projects/1/git/ai', { kind: 'commit-explain', sha }, s.alice.token),
    ));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({
      ok: false,
      code: 'llm_not_configured',
      error: '请联系管理员配置驱动大模型',
    });
  });
});

describe('buildGitAiPrompt（纯函数）', () => {
  test('按 标题→信息→文件→路径→diff 顺序拼 user；system 随 kind 变', () => {
    const msgs = buildGitAiPrompt('commit-summary', {
      subject: 'feat: x', message: 'feat: x\n\nbody', path: 'a.ts', files: 'M\ta.ts', diff: '@@\n+a',
    });
    expect(msgs.length).toBe(2);
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[1]!.role).toBe('user');
    const u = String(msgs[1]!.content);
    expect(u.indexOf('提交标题')).toBeLessThan(u.indexOf('提交信息'));
    expect(u.indexOf('文件：')).toBeLessThan(u.indexOf('改动文件：'));
    expect(u.indexOf('改动文件：')).toBeLessThan(u.indexOf('diff（可能已截断）'));
    expect(u).toContain('+a');
  });

  test('空 ctx → user 占位「（无可用内容）」', () => {
    expect(String(buildGitAiPrompt('file-explain', {})[1]!.content)).toBe('（无可用内容）');
  });

  test('各 kind 的 system 提示互不相同', () => {
    const systems = GIT_AI_KINDS.map((k) => String(buildGitAiPrompt(k, {})[0]!.content));
    expect(new Set(systems).size).toBe(GIT_AI_KINDS.length);
  });
});

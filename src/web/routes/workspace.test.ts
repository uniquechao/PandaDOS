/**
 * 工作区（issue #388）后端单测：
 *  - 文件写操作：新建文件/目录、重命名移动、删除（非空目录需显式确认 + 计数竞态）、搜索、状态标记、
 *    保存乐观并发、目录打包下载、路径越界；
 *  - 完整网页预览：令牌签发、相对资源、权限隔离（CSP sandbox、不认登录态、隐藏路径、令牌篡改/过期）；
 *  - Git：分开的暂存/未暂存 diff、按块暂存/取消/撤销（块头竞态）、撤销未跟踪拒绝、fetch/pull（脏工作区拒绝、
 *    ff-only 分叉拒绝）、新建/切换分支（脏工作区、占用 worktree、运行中 issue 受限）、
 *    worktree 创建/登记/移除安全边界（主位置/设计托管/有改动/运行中 不可移除；不改原项目 cwd）。
 * Driver 用 LocalDriver 对临时目录跑真 git。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { PandaSyncIndex, sha256Hex } from '../../core/project-sync';
import { UserStore } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import { getProject } from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { createPreviewService, PREVIEW_CSP, previewPathAllowed, previewResourceAllowed } from '../preview';
import { filesRoutes, gitMarksFor, parseGrep, parsePorcelainZ } from './files';
import { gitRoutes } from './git';
import {
  classifyWorktree, gitWorkspaceRoutes, hunkPatch, parseWorktreeList, plannedWorktreePath, splitHunks,
} from './git-workspace';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const driver = new LocalDriver();
const G = ['-c', 'user.email=t@t', '-c', 'user.name=t'];

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await driver.git(dir, [...G, ...args]);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.err}`);
  return r.out;
}

async function setup(opts: { repo?: boolean } = {}) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-ws-')));
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
  const proj = path.join(dir, 'repo');
  await fsp.mkdir(path.join(proj, 'site', 'css'), { recursive: true });
  await fsp.mkdir(path.join(proj, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'site', 'index.html'), '<link rel="stylesheet" href="css/a.css"><img src="../assets/p.png"><script src="app.js"></script>');
  await fsp.writeFile(path.join(proj, 'site', 'css', 'a.css'), 'body{color:red}');
  await fsp.writeFile(path.join(proj, 'site', 'app.js'), 'document.title="ok"');
  await fsp.writeFile(path.join(proj, 'assets', 'p.png'), new Uint8Array([137, 80, 78, 71]));
  await fsp.writeFile(path.join(proj, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n');
  await fsp.writeFile(path.join(proj, '.env'), 'SECRET=1');
  await fsp.writeFile(path.join(dir, 'outside.txt'), 'secret');
  if (opts.repo !== false) {
    await git(proj, 'init', '-q', '-b', 'main');
    await fsp.writeFile(path.join(proj, '.gitignore'), 'build/\n');
    await git(proj, 'add', '.');
    await git(proj, 'commit', '-q', '-m', 'init');
  }
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, ?, ?, ?)`,
  ).run(proj, alice.user.id, Date.now());

  const mutex = new KeyedMutex();
  const preview = createPreviewService({ db, driverForProject: () => driver });
  const dispatch = createDispatcher(
    [
      ...filesRoutes({ db, driverForProject: () => driver }),
      ...preview.routes(),
      ...gitRoutes({ db, driverForProject: () => driver, mutex }),
      ...gitWorkspaceRoutes({ db, driverForProject: () => driver, mutex }),
    ],
    authDepsFromDb(db, users),
  );
  const call = async (method: string, p: string, token: string, body?: unknown): Promise<{ status: number; j: any; res: Response }> => {
    const res = await dispatch(new Request(`http://t${p}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))!;
    const text = await res.clone().text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* 非 JSON（下载） */ }
    return { status: res.status, j, res };
  };
  return { dir, db, proj, preview, call, admin, alice, bob, tok: alice.token };
}

describe('纯函数', () => {
  test('gitMarksFor：直接子项标记、目录聚合、忽略与前缀', () => {
    const entries = parsePorcelainZ(' M sub/a.ts\0?? new.md\0!! build/\0UU sub/deep/c.ts\0R  n.txt\0o.txt\0');
    expect(entries.map((e) => e.path)).toEqual(['sub/a.ts', 'new.md', 'build/', 'sub/deep/c.ts', 'n.txt']);
    expect(gitMarksFor(entries, '', '')).toEqual({ sub: 'U', 'new.md': '?', build: '!', 'n.txt': 'R' });
    expect(gitMarksFor(entries, '', 'sub')).toEqual({ 'a.ts': 'M', deep: 'U' });
    expect(gitMarksFor(parsePorcelainZ(' M pkg/x.ts\0'), 'pkg/', '')).toEqual({ 'x.ts': 'M' });
  });
  test('parseGrep 解析 --null 输出并限量', () => {
    expect(parseGrep('a.ts\x0012\x00hello\nb.ts\x003\x00x\n', 1)).toEqual([{ path: 'a.ts', line: 12, text: 'hello' }]);
  });
  test('splitHunks/hunkPatch', () => {
    const d = splitHunks('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n');
    expect(d.hunks.length).toBe(2);
    expect(hunkPatch(d, 1)).toBe('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -9 +9 @@\n-c\n+d\n');
    expect(hunkPatch(d, 5)).toBeNull();
  });
  test('worktree 列表解析与分类', () => {
    const list = parseWorktreeList('worktree /r/main\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.panda-worktrees/ws-1-feat\nHEAD def\nbranch refs/heads/feat\n\nworktree /r/.panda-worktrees/design-1-2\nHEAD 1\ndetached\n\nworktree /x/other dir\nHEAD 2\nbranch refs/heads/o\nlocked\n');
    expect(list.map((w) => w.branch)).toEqual(['main', 'feat', '', 'o']);
    expect(list[3]!.path).toBe('/x/other dir');
    expect(list.map((w, i) => classifyWorktree(w, i, '/r/main', new Set()))).toEqual(['main', 'panda', 'design', 'external']);
    expect(plannedWorktreePath('/r/main', 3, 'Feature/X Y')).toBe('/r/.panda-worktrees/ws-3-feature-x-y');
  });
  test('previewPathAllowed 拒绝隐藏段与穿越', () => {
    expect(previewPathAllowed('site/index.html')).toBe(true);
    expect(previewPathAllowed('.env')).toBe(false);
    expect(previewPathAllowed('a/.git/config')).toBe(false);
    expect(previewPathAllowed('../x')).toBe(false);
  });
});

describe('文件写操作', () => {
  test('新建文件/目录：已存在 409、越界 400、非法名 400、父目录缺失 409', async () => {
    const { call, proj, tok } = await setup();
    expect((await call('POST', '/api/projects/1/fs/file?path=notes%2Fn.md', tok, {})).j.error.code).toBe('workspace.parent_missing');
    expect((await call('POST', '/api/projects/1/fs/mkdir?path=notes', tok)).status).toBe(200);
    const created = await call('POST', '/api/projects/1/fs/file?path=notes%2Fn.md', tok, { content: 'hi' });
    expect(created.status).toBe(200);
    expect(created.j.path).toBe('notes/n.md');
    expect(await fsp.readFile(path.join(proj, 'notes/n.md'), 'utf8')).toBe('hi');
    expect((await call('POST', '/api/projects/1/fs/file?path=notes%2Fn.md', tok, {})).j.error.code).toBe('workspace.exists');
    expect((await call('POST', '/api/projects/1/fs/mkdir?path=notes', tok)).status).toBe(409);
    expect((await call('POST', '/api/projects/1/fs/file?path=..%2Fx.txt', tok, {})).j.error.code).toBe('workspace.path_invalid');
    expect((await call('POST', '/api/projects/1/fs/file?path=', tok, {})).j.error.code).toBe('workspace.name_invalid');
  });

  test('重命名/移动：目标存在 409、移入自身 400、源不存在 404、越界 400', async () => {
    const { call, proj, tok } = await setup();
    const r = await call('POST', '/api/projects/1/fs/move', tok, { from: 'a.txt', to: 'site/b.txt' });
    expect(r.j).toMatchObject({ ok: true, from: 'a.txt', path: 'site/b.txt' });
    expect(await fsp.readFile(path.join(proj, 'site/b.txt'), 'utf8')).toContain('one');
    expect((await call('POST', '/api/projects/1/fs/move', tok, { from: 'site/b.txt', to: 'site/app.js' })).j.error.code).toBe('workspace.exists');
    expect((await call('POST', '/api/projects/1/fs/move', tok, { from: 'site', to: 'site/css/site' })).j.error.code).toBe('workspace.move_into_self');
    expect((await call('POST', '/api/projects/1/fs/move', tok, { from: 'gone.txt', to: 'x.txt' })).status).toBe(404);
    expect((await call('POST', '/api/projects/1/fs/move', tok, { from: 'site/app.js', to: '../app.js' })).status).toBe(400);
  });

  test('删除：非空目录须显式 recursive + 目录版本一致；新增文件或空目录都 409；根目录 400', async () => {
    const { call, proj, tok } = await setup();
    const stat = await call('GET', '/api/projects/1/fs/stat?path=site&count=1', tok);
    expect(stat.j.count).toMatchObject({ files: 3, dirs: 1, truncated: false });
    const v1 = stat.j.count.version as string;
    expect((await call('DELETE', '/api/projects/1/fs?path=site', tok)).j.error.code).toBe('workspace.dir_not_empty');
    expect((await call('DELETE', '/api/projects/1/fs?path=site&recursive=1', tok)).j.error.code).toBe('workspace.delete_count_changed');
    await fsp.writeFile(path.join(proj, 'site', 'late.txt'), 'x'); // 确认后又多了文件
    const stale = await call('DELETE', `/api/projects/1/fs?path=site&recursive=1&expectVersion=${v1}`, tok);
    expect(stale.j.error.code).toBe('workspace.delete_count_changed');
    expect(stale.j.error.params.files).toBe(4);
    const v2 = (await call('GET', '/api/projects/1/fs/stat?path=site&count=1', tok)).j.count.version as string;
    // 复核报告场景：确认后只多了一个空目录，文件数不变 → 仍须 409
    await fsp.mkdir(path.join(proj, 'site', 'empty-late'));
    const emptyDir = await call('DELETE', `/api/projects/1/fs?path=site&recursive=1&expectVersion=${v2}`, tok);
    expect(emptyDir.j.error.code).toBe('workspace.delete_count_changed');
    expect(emptyDir.j.error.params).toMatchObject({ files: 4, dirs: 2 });
    // 同数量替换（删一个、加一个）同样视为变化
    const v3 = (await call('GET', '/api/projects/1/fs/stat?path=site&count=1', tok)).j.count.version as string;
    await fsp.rm(path.join(proj, 'site', 'late.txt'));
    await fsp.writeFile(path.join(proj, 'site', 'other.txt'), 'y');
    expect((await call('DELETE', `/api/projects/1/fs?path=site&recursive=1&expectVersion=${v3}`, tok)).j.error.code).toBe('workspace.delete_count_changed');
    const v4 = (await call('GET', '/api/projects/1/fs/stat?path=site&count=1', tok)).j.count.version as string;
    expect((await call('DELETE', `/api/projects/1/fs?path=site&recursive=1&expectVersion=${v4}`, tok)).status).toBe(200);
    expect((await call('GET', '/api/projects/1/fs/stat?path=site', tok)).j.exists).toBe(false);
    expect((await call('DELETE', '/api/projects/1/fs?path=a.txt', tok)).status).toBe(200);
    expect((await call('DELETE', '/api/projects/1/fs?path=', tok)).j.error.code).toBe('workspace.delete_root');
    expect((await call('DELETE', '/api/projects/1/fs?path=a.txt', tok)).status).toBe(404);
  });

  test('保存乐观并发：打开后被他人改动 → 409，不覆盖', async () => {
    const { call, proj, tok } = await setup();
    const opened = await call('GET', '/api/projects/1/fs/file?path=a.txt', tok);
    const saved = await call('PUT', '/api/projects/1/fs/file?path=a.txt', tok, { content: 'mine', baseMtimeMs: opened.j.mtimeMs });
    expect(saved.status).toBe(200);
    const future = new Date(Date.now() + 5000);
    await fsp.writeFile(path.join(proj, 'a.txt'), 'agent');
    await fsp.utimes(path.join(proj, 'a.txt'), future, future);
    const conflict = await call('PUT', '/api/projects/1/fs/file?path=a.txt', tok, { content: 'mine2', baseMtimeMs: saved.j.mtimeMs });
    expect(conflict.j.error.code).toBe('workspace.file_changed');
    expect(await fsp.readFile(path.join(proj, 'a.txt'), 'utf8')).toBe('agent');
  });

  test('搜索：名称与内容（带行号、尊重 .gitignore）', async () => {
    const { call, proj, tok } = await setup();
    await fsp.mkdir(path.join(proj, 'build'));
    await fsp.writeFile(path.join(proj, 'build', 'out.txt'), 'three');
    const byName = await call('GET', '/api/projects/1/fs/search?q=APP&mode=name', tok);
    expect(byName.j.results).toEqual([{ path: 'site/app.js', type: 'file' }]);
    const byContent = await call('GET', '/api/projects/1/fs/search?q=three&mode=content', tok);
    expect(byContent.j.results).toEqual([{ path: 'a.txt', line: 3, text: 'three' }]);
    expect((await call('GET', '/api/projects/1/fs/search?q=', tok)).status).toBe(400);
  });

  test('列目录 git=1 带状态标记（改动/未跟踪/忽略）；非仓库照常列出', async () => {
    const { call, proj, tok } = await setup();
    await fsp.writeFile(path.join(proj, 'a.txt'), 'changed');
    await fsp.writeFile(path.join(proj, 'new.md'), 'n');
    await fsp.mkdir(path.join(proj, 'build'));
    await fsp.writeFile(path.join(proj, 'build', 'x'), 'x');
    const r = await call('GET', '/api/projects/1/fs?path=&git=1', tok);
    const marks = Object.fromEntries(r.j.entries.filter((e: any) => e.git).map((e: any) => [e.name, e.git]));
    expect(marks).toEqual({ 'a.txt': 'M', 'new.md': '?', build: '!' });
    const plain = await setup({ repo: false });
    const r2 = await plain.call('GET', '/api/projects/1/fs?path=&git=1', plain.tok);
    expect(r2.status).toBe(200);
    expect(r2.j.entries.some((e: any) => e.git)).toBe(false);
  });

  test('目录打包下载', async () => {
    const { call, tok } = await setup();
    const r = await call('GET', '/api/projects/1/fs/download-dir?path=site', tok);
    expect(r.status).toBe(200);
    expect(r.res.headers.get('content-type')).toBe('application/gzip');
    expect(r.res.headers.get('content-disposition')).toContain('site.tar.gz');
    const buf = new Uint8Array(await r.res.arrayBuffer());
    expect(buf[0]).toBe(0x1f);
    expect((await call('GET', '/api/projects/1/fs/download-dir?path=a.txt', tok)).status).toBe(400);
  });

  test('鉴权：非成员 403', async () => {
    const { call, bob } = await setup();
    expect((await call('POST', '/api/projects/1/fs/mkdir?path=x', bob.token)).status).toBe(403);
    expect((await call('POST', '/api/projects/1/fs/move', bob.token, { from: 'a.txt', to: 'b.txt' })).status).toBe(403);
  });
});

describe('完整网页预览（隔离服务）', () => {
  test('签发令牌 → 入口与相对 CSS/JS/图片均可加载，带 CSP sandbox 且不认登录态', async () => {
    const { call, preview, tok } = await setup();
    const minted = await call('POST', '/api/projects/1/fs/preview?path=site%2Findex.html', tok);
    expect(minted.status).toBe(200);
    const url = new URL(minted.j.url, 'http://t');
    expect(url.pathname).toMatch(/^\/preview\/[^/]+\/site\/index\.html$/);
    const fetchPreview = async (rel: string, headers: Record<string, string> = {}): Promise<Response> =>
      (await preview.handle(new Request(new URL(rel, url).toString(), { headers })))!;
    const entry = await fetchPreview(url.pathname);
    expect(entry.status).toBe(200);
    expect(entry.headers.get('content-type')).toContain('text/html');
    expect(entry.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).not.toContain('allow-same-origin');
    expect(entry.headers.get('referrer-policy')).toBe('no-referrer');
    // 相对资源按 HTML 所在目录解析（含 ../ 上跳）
    expect((await fetchPreview('css/a.css')).headers.get('content-type')).toContain('text/css');
    expect(await (await fetchPreview('app.js')).text()).toBe('document.title="ok"');
    expect((await fetchPreview('../assets/p.png')).headers.get('content-type')).toBe('image/png');
    // 不读 cookie：无令牌的同路径请求即便带控制面 cookie 也拒绝
    const token = url.pathname.split('/')[2]!;
    const forged = `${token.slice(0, -2)}xx`;
    expect((await preview.handle(new Request(`http://t/preview/${forged}/site/index.html`, { headers: { cookie: `panda_token=${tok}` } })))!.status).toBe(403);
  });

  test('隐藏文件、越界、service worker、非 GET、过期令牌一律拒绝', async () => {
    const { preview, db } = await setup();
    const project = getProject(db, 1)!;
    const { url } = preview.mint(project, 'site/index.html');
    const u = new URL(url, 'http://t');
    const at = (rel: string, init?: RequestInit): Promise<Response | null> => preview.handle(new Request(new URL(rel, u).toString(), init));
    expect((await at('../.env'))!.status).toBe(404);
    expect((await at('../../outside.txt'))!.status).not.toBe(200);
    expect((await at('app.js', { headers: { 'service-worker': 'script' } }))!.status).toBe(403);
    expect((await at('app.js', { method: 'POST' }))!.status).toBe(405);
    let now = Date.now();
    const clocked = createPreviewService({ db, driverForProject: () => driver, now: () => now });
    const late = new URL(clocked.mint(project, 'site/index.html').url, 'http://t');
    now += 31 * 60 * 1000;
    expect((await clocked.handle(new Request(late.toString())))!.status).toBe(403);
    expect(await preview.handle(new Request('http://t/api/x'))).toBeNull();
  });

  test('同一令牌只授权该网页的资源：入口范围外的项目文件一律拒绝（复核 #1）', async () => {
    const { preview, db, proj } = await setup();
    await fsp.writeFile(path.join(proj, 'CLAUDE.md'), 'secret notes');
    await fsp.writeFile(path.join(proj, 'site', 'notes.md'), 'draft');
    await fsp.writeFile(path.join(proj, 'site', 'data.json'), '{"k":1}');
    await fsp.writeFile(path.join(proj, 'config.js'), 'export const KEY = 1');
    await fsp.writeFile(path.join(proj, 'other.html'), '<p>other</p>');
    const { url } = preview.mint(getProject(db, 1)!, 'site/index.html');
    const u = new URL(url, 'http://t');
    const at = async (rel: string): Promise<number> => (await preview.handle(new Request(new URL(rel, u).toString())))!.status;
    expect(await at('index.html')).toBe(200);
    expect(await at('css/a.css')).toBe(200);
    expect(await at('../assets/p.png')).toBe(200); // 目录外被动资源仍可用
    expect(await at('../CLAUDE.md')).toBe(404); // 复核复现：同令牌读项目说明
    expect(await at('../a.txt')).toBe(404);
    expect(await at('notes.md')).toBe(404); // 入口目录内的非网页资源也不放行
    expect(await at('data.json')).toBe(404);
    expect(await at('../config.js')).toBe(404); // 目录外脚本
    expect(await at('../other.html')).toBe(404); // 目录外网页
    expect(previewResourceAllowed('index.html', 'src/app.js')).toBe(true); // 根目录入口 = 整个项目的网页资源
    expect(previewResourceAllowed('index.html', 'README.md')).toBe(false);
    // 外传通道：禁 fetch/表单/弹窗，资源只认同预览来源
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).toContain("img-src 'self' data: blob:");
    expect(PREVIEW_CSP).not.toContain('allow-popups');
    expect(PREVIEW_CSP).not.toContain('allow-forms');
  });

  test('签发端点：隐藏路径/非 HTML/不存在 拒绝，非成员 403', async () => {
    const { call, tok, bob } = await setup();
    expect((await call('POST', '/api/projects/1/fs/preview?path=.env', tok)).j.error.code).toBe('workspace.preview_path_invalid');
    expect((await call('POST', '/api/projects/1/fs/preview?path=a.txt', tok)).j.error.code).toBe('workspace.preview_path_invalid');
    expect((await call('POST', '/api/projects/1/fs/preview?path=nope.html', tok)).status).toBe(404);
    expect((await call('POST', '/api/projects/1/fs/preview?path=site%2Findex.html', bob.token)).status).toBe(403);
  });
});

describe('Git：暂存/块/撤销/冲突', () => {
  test('暂存与未暂存 diff 分开；按块暂存/取消/撤销；块头过期 409', async () => {
    const { call, proj, tok } = await setup();
    await fsp.writeFile(path.join(proj, 'a.txt'), 'ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n');
    const diff = await call('GET', '/api/projects/1/git/worktree/diff?path=a.txt&side=unstaged', tok);
    const hunks = splitHunks(diff.j.diff).hunks;
    expect(hunks.length).toBe(2);
    const stage = await call('POST', '/api/projects/1/git/hunk', tok, { path: 'a.txt', side: 'unstaged', index: 1, header: hunks[1]![0], action: 'stage' });
    expect(stage.j).toEqual({ ok: true });
    const staged = await call('GET', '/api/projects/1/git/worktree/diff?path=a.txt&side=staged', tok);
    expect(staged.j.diff).toContain('+TEN');
    expect(staged.j.diff).not.toContain('+ONE');
    const unstaged = await call('GET', '/api/projects/1/git/worktree/diff?path=a.txt&side=unstaged', tok);
    expect(unstaged.j.diff).toContain('+ONE');
    expect(unstaged.j.diff).not.toContain('+TEN');
    // 过期块头
    const stale = await call('POST', '/api/projects/1/git/hunk', tok, { path: 'a.txt', side: 'unstaged', index: 0, header: '@@ -9 +9 @@', action: 'stage' });
    expect(stale.j.error.code).toBe('workspace.git.hunk_stale');
    // 非法组合：暂存区不能 discard
    expect((await call('POST', '/api/projects/1/git/hunk', tok, { path: 'a.txt', side: 'staged', index: 0, header: 'x', action: 'discard' })).status).toBe(400);
    // 取消暂存该块
    const sh = splitHunks(staged.j.diff).hunks[0]![0];
    expect((await call('POST', '/api/projects/1/git/hunk', tok, { path: 'a.txt', side: 'staged', index: 0, header: sh, action: 'unstage' })).j.ok).toBe(true);
    // 撤销第一块（只丢 ONE 的改动）
    const u2 = splitHunks((await call('GET', '/api/projects/1/git/worktree/diff?path=a.txt&side=unstaged', tok)).j.diff).hunks;
    expect((await call('POST', '/api/projects/1/git/hunk', tok, { path: 'a.txt', side: 'unstaged', index: 0, header: u2[0]![0], action: 'discard' })).j.ok).toBe(true);
    const content = await fsp.readFile(path.join(proj, 'a.txt'), 'utf8');
    expect(content.startsWith('one\n')).toBe(true);
    expect(content.endsWith('TEN\n')).toBe(true);
  });

  test('撤销整文件：已跟踪可撤销、未跟踪拒绝（走删除交互）', async () => {
    const { call, proj, tok } = await setup();
    await fsp.writeFile(path.join(proj, 'a.txt'), 'x');
    await fsp.writeFile(path.join(proj, 'n.txt'), 'x');
    expect((await call('POST', '/api/projects/1/git/discard', tok, { paths: ['n.txt'] })).j.error.code).toBe('workspace.git.discard_untracked');
    expect((await call('POST', '/api/projects/1/git/discard', tok, { paths: ['a.txt'] })).j.ok).toBe(true);
    expect(await fsp.readFile(path.join(proj, 'a.txt'), 'utf8')).toContain('one');
    expect((await call('POST', '/api/projects/1/git/discard', tok, { paths: ['../x'] })).status).toBe(400);
  });

  test('冲突：GET /git 报告进行中的 merge；标记解决 + 继续完成合并；无操作时 409', async () => {
    const { call, proj, tok } = await setup();
    await git(proj, 'checkout', '-q', '-b', 'side');
    await fsp.writeFile(path.join(proj, 'a.txt'), 'side\n');
    await git(proj, 'commit', '-qam', 'side');
    await git(proj, 'checkout', '-q', 'main');
    await fsp.writeFile(path.join(proj, 'a.txt'), 'main\n');
    await git(proj, 'commit', '-qam', 'main');
    await driver.git(proj, [...G, 'merge', 'side']);
    const info = await call('GET', '/api/projects/1/git', tok);
    expect(info.j.operation).toBe('merge');
    expect(info.j.changes.find((c: any) => c.path === 'a.txt').status).toBe('UU');
    const early = await call('POST', '/api/projects/1/git/operation', tok, { action: 'continue' });
    expect(early.j.error.code).toBe('workspace.git.continue_failed');
    await fsp.writeFile(path.join(proj, 'a.txt'), 'merged\n');
    expect((await call('POST', '/api/projects/1/git/resolve', tok, { paths: ['a.txt'] })).j.ok).toBe(true);
    // continue 需要提交者身份：测试仓库本地配置
    await git(proj, 'config', 'user.email', 't@t');
    await git(proj, 'config', 'user.name', 't');
    expect((await call('POST', '/api/projects/1/git/operation', tok, { action: 'continue' })).j).toMatchObject({ ok: true, operation: 'merge' });
    expect((await call('GET', '/api/projects/1/git', tok)).j.operation).toBeNull();
    expect((await call('POST', '/api/projects/1/git/operation', tok, { action: 'abort' })).j.error.code).toBe('workspace.git.no_operation');
  });
});

describe('Git：远端同步', () => {
  async function withRemote() {
    const ctx = await setup();
    const remote = path.join(ctx.dir, 'remote.git');
    await git(ctx.dir, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(ctx.proj, 'remote', 'add', 'origin', remote);
    await git(ctx.proj, 'push', '-q', '-u', 'origin', 'main');
    const other = path.join(ctx.dir, 'other');
    await git(ctx.dir, 'clone', '-q', remote, other);
    await fsp.writeFile(path.join(other, 'r.txt'), 'remote');
    await git(other, 'add', '.');
    await git(other, 'commit', '-qm', 'remote change');
    await git(other, 'push', '-q');
    return ctx;
  }

  test('fetch 记录时间并重算 behind；pull 预览给出可选方式；ff-only 拉取成功', async () => {
    const { call, proj, tok } = await withRemote();
    const before = await call('GET', '/api/projects/1/git', tok);
    expect(before.j.upstream).toBe('origin/main');
    expect(before.j.behind).toBe(0);
    const f = await call('POST', '/api/projects/1/git/fetch', tok);
    expect(f.j.ok).toBe(true);
    expect(typeof f.j.lastFetchTs).toBe('number');
    const after = await call('GET', '/api/projects/1/git', tok);
    expect(after.j.behind).toBe(1);
    expect(after.j.lastFetchTs).toBeGreaterThan(0);
    const pv = await call('GET', '/api/projects/1/git/pull-preview', tok);
    expect(pv.j).toMatchObject({ upstream: 'origin/main', behind: 1, ahead: 0, modes: ['ff-only'] });
    // 脏工作区拒绝（不自动 stash）
    await fsp.writeFile(path.join(proj, 'a.txt'), 'dirty');
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' })).j.error.code).toBe('workspace.git.dirty');
    await git(proj, 'checkout', '--', 'a.txt');
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' })).j.ok).toBe(true);
    expect(await fsp.readFile(path.join(proj, 'r.txt'), 'utf8')).toBe('remote');
  });

  test('复核 #4：工作树干净但有运行中 issue（含同 cwd 的另一关联项目）→ 预览说明且 pull 拒绝，HEAD 不动', async () => {
    const { call, db, proj, tok, alice } = await withRemote();
    await call('POST', '/api/projects/1/git/fetch', tok);
    const head = (await driver.git(proj, ['rev-parse', 'HEAD'])).out.trim();
    db.query(`INSERT INTO issues (id, project_id, title, status, created_ts) VALUES (1, 1, 't', 'implementing', 0)`).run();
    const pv = await call('GET', '/api/projects/1/git/pull-preview', tok);
    expect(pv.j).toMatchObject({ behind: 1, dirty: 0, running: 1 });
    const busy = await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' });
    expect(busy.status).toBe(409);
    expect(busy.j.error).toMatchObject({ code: 'workspace.git.worktree_busy', params: { count: 1 } });
    expect((await driver.git(proj, ['rev-parse', 'HEAD'])).out.trim()).toBe(head);
    // 同执行机同 cwd 的另一项目在跑，同样挡住
    db.query(`UPDATE issues SET status = 'done'`).run();
    db.query(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p2', 1, ?, ?, 0)`).run(proj, alice.user.id);
    db.query(`INSERT INTO issues (id, project_id, title, status, created_ts) VALUES (2, 2, 't', 'testing', 0)`).run();
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' })).j.error.code).toBe('workspace.git.worktree_busy');
    db.query(`UPDATE issues SET status = 'done'`).run();
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' })).j.ok).toBe(true);
  });

  test('分叉时 ff-only 拒绝并说明，merge 方式可完成', async () => {
    const { call, proj, tok } = await withRemote();
    await fsp.writeFile(path.join(proj, 'l.txt'), 'local');
    await git(proj, 'add', '.');
    await git(proj, 'commit', '-qm', 'local');
    await call('POST', '/api/projects/1/git/fetch', tok);
    const pv = await call('GET', '/api/projects/1/git/pull-preview', tok);
    expect(pv.j.modes).toEqual(['merge', 'rebase']);
    const ff = await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' });
    expect(ff.j.error).toMatchObject({ code: 'workspace.git.diverged', params: { ahead: 1, behind: 1 } });
    await git(proj, 'config', 'user.email', 't@t');
    await git(proj, 'config', 'user.name', 't');
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'merge' })).j.ok).toBe(true);
  });

  test('无 upstream 的分支不能 pull；fetch 失败保留 Git 原始错误', async () => {
    const { call, proj, tok } = await setup();
    expect((await call('POST', '/api/projects/1/git/pull', tok, { mode: 'ff-only' })).j.error.code).toBe('workspace.git.no_upstream');
    await git(proj, 'remote', 'add', 'origin', '/nonexistent/remote.git');
    const f = await call('POST', '/api/projects/1/git/fetch', tok);
    expect(f.j.error.code).toBe('workspace.git.fetch_failed');
    expect(String(f.j.error.details)).toContain('nonexistent');
  });
});

describe('Git：分支', () => {
  test('新建并切换；非法名 400；已存在 409；脏工作区/运行中 issue 阻止切换并说明原因', async () => {
    const { call, db, proj, tok } = await setup();
    expect((await call('POST', '/api/projects/1/git/branches', tok, { name: '-x' })).j.error.code).toBe('workspace.git.branch_invalid');
    expect((await call('POST', '/api/projects/1/git/branches', tok, { name: 'feat', checkout: true })).j).toMatchObject({ ok: true, checkedOut: true });
    expect((await call('POST', '/api/projects/1/git/branches', tok, { name: 'feat' })).j.error.code).toBe('workspace.git.branch_exists');
    await fsp.writeFile(path.join(proj, 'a.txt'), 'dirty');
    const check = await call('GET', '/api/projects/1/git/checkout-check?branch=main', tok);
    expect(check.j.blockers).toEqual([{ code: 'dirty', count: 1 }]);
    const blocked = await call('POST', '/api/projects/1/git/checkout', tok, { branch: 'main' });
    expect(blocked.status).toBe(409);
    expect(blocked.j.blockers[0].code).toBe('dirty');
    expect((await driver.git(proj, ['symbolic-ref', '--short', 'HEAD'])).out.trim()).toBe('feat');
    await git(proj, 'checkout', '--', 'a.txt');
    db.query(`INSERT INTO issues (id, project_id, title, status, created_ts) VALUES (1, 1, 't', 'implementing', 0)`).run();
    const busy = await call('POST', '/api/projects/1/git/checkout', tok, { branch: 'main' });
    expect(busy.j.blockers).toEqual([{ code: 'issue_running', count: 1 }]);
    db.query(`UPDATE issues SET status = 'done'`).run();
    expect((await call('POST', '/api/projects/1/git/checkout', tok, { branch: 'main' })).j).toMatchObject({ ok: true, branch: 'main' });
  });

  test('远程分支切换显式建本地跟踪分支', async () => {
    const { call, dir, proj, tok } = await setup();
    const remote = path.join(dir, 'remote.git');
    await git(dir, 'init', '-q', '--bare', remote);
    await git(proj, 'remote', 'add', 'origin', remote);
    await git(proj, 'push', '-q', 'origin', 'main:rfeat');
    await git(proj, 'fetch', '-q', 'origin');
    const r = await call('POST', '/api/projects/1/git/checkout', tok, { remote: 'origin/rfeat' });
    expect(r.j).toMatchObject({ ok: true, branch: 'rfeat', tracking: 'origin/rfeat' });
    expect((await driver.git(proj, ['rev-parse', '--abbrev-ref', '@{upstream}'])).out.trim()).toBe('origin/rfeat');
    expect((await call('POST', '/api/projects/1/git/checkout', tok, { remote: 'origin/nope' })).status).toBe(404);
  });
});

describe('Git：多 worktree 安全边界', () => {
  test('创建 → 登记独立关联项目（不改原项目 cwd）→ 占用分支阻止切换 → 移除默认保留分支并归档项目', async () => {
    const { call, db, proj, tok, bob } = await setup();
    const dry = await call('POST', '/api/projects/1/git/worktrees', tok, { branch: 'wt1', create: true, dryRun: true });
    expect(dry.j.path).toBe(path.join(path.dirname(proj), '.panda-worktrees', 'ws-1-wt1'));
    const created = await call('POST', '/api/projects/1/git/worktrees', tok, { branch: 'wt1', create: true });
    expect(created.j.ok).toBe(true);
    const wtPath = created.j.path as string;
    expect(created.j.project.cwd).toBe(wtPath);
    expect(created.j.project.id).not.toBe(1);
    expect(getProject(db, 1)!.cwd).toBe(proj); // 原项目 cwd 不变
    // 非属主不能创建
    expect((await call('POST', '/api/projects/1/git/worktrees', bob.token, { branch: 'x', create: true })).status).toBe(403);
    // 列表：主位置 + 系统创建位置，关联项目可见
    const list = await call('GET', '/api/projects/1/git/worktrees', tok);
    expect(list.j.worktrees.map((w: any) => [w.kind, w.branch, w.current])).toEqual([['main', 'main', true], ['panda', 'wt1', false]]);
    expect(list.j.worktrees[1].projects[0].id).toBe(created.j.project.id);
    // 分支被另一 worktree 占用 → 切换受限，并给出占用位置与关联项目
    const blocked = await call('GET', '/api/projects/1/git/checkout-check?branch=wt1', tok);
    expect(blocked.j.blockers).toEqual([{ code: 'branch_in_worktree', path: wtPath, projectId: created.j.project.id }]);
    // 同分支再建 409
    expect((await call('POST', '/api/projects/1/git/worktrees', tok, { branch: 'wt1' })).j.error.code).toBe('workspace.git.branch_in_worktree');
    // 有改动不能移除
    await fsp.writeFile(path.join(wtPath, 'dirty.txt'), 'x');
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: wtPath })).j.error.code).toBe('workspace.git.worktree_dirty');
    await fsp.rm(path.join(wtPath, 'dirty.txt'));
    // 复核 #2：未跟踪 .panda/ 里用户新写的文件不是同步产物 → 计入改动、阻止移除，文件原样保留
    await fsp.mkdir(path.join(wtPath, '.panda', 'modules', 'm1', 'issues'), { recursive: true });
    const note = path.join(wtPath, '.panda', 'modules', 'm1', 'issues', '9-note.md');
    await fsp.writeFile(note, '用户过程页');
    await fsp.writeFile(path.join(wtPath, '.panda', 'project.json'), '{"v":1}');
    const pandaDirty = await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: wtPath });
    expect(pandaDirty.j.error.code).toBe('workspace.git.worktree_dirty');
    expect(pandaDirty.j.error.params.count).toBe(2); // project.json 尚未进同步索引，同样不能凭目录名删
    expect(await fsp.readFile(note, 'utf8')).toBe('用户过程页');
    await fsp.rm(path.join(wtPath, '.panda', 'modules'), { recursive: true });
    // 同步索引里 active 且指纹一致的才算可再生；内容被改过（指纹不符）仍算用户改动
    const index = new PandaSyncIndex(db);
    index.recordActive(created.j.project.id, {
      path: '.panda/project.json', fingerprint: sha256Hex('{"v":0}'), uid: 'u1', version: 1, kind: 'project', value: {},
    });
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: wtPath })).j.error.code).toBe('workspace.git.worktree_dirty');
    index.recordActive(created.j.project.id, {
      path: '.panda/project.json', fingerprint: sha256Hex('{"v":1}'), uid: 'u1', version: 1, kind: 'project', value: {},
    });
    // 关联项目有运行中 issue 不能移除
    db.query(`INSERT INTO issues (id, project_id, title, status, created_ts) VALUES (9, ?, 't', 'testing', 0)`).run(created.j.project.id);
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: wtPath })).j.error.code).toBe('workspace.git.worktree_busy');
    db.query(`UPDATE issues SET status = 'done' WHERE id = 9`).run();
    // 主位置不可移除
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: proj })).j.error.code).toBe('workspace.git.worktree_protected');
    const removed = await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: wtPath });
    expect(removed.j).toMatchObject({ ok: true, branch: 'wt1', branchDeleted: false });
    expect(await fsp.stat(wtPath).catch(() => null)).toBeNull();
    expect((await driver.git(proj, ['rev-parse', '--verify', 'refs/heads/wt1'])).code).toBe(0); // 默认保留分支
    expect(getProject(db, created.j.project.id)!.status).toBe('archived');
  });

  test('外部 worktree：可显式关联为项目，不可移除；设计托管位置不可移除也不可关联', async () => {
    const { call, dir, proj, tok } = await setup();
    const ext = path.join(dir, 'ext wt');
    await git(proj, 'worktree', 'add', '-q', '-b', 'ext', ext);
    const design = path.join(path.dirname(proj), '.panda-worktrees', 'design-1-2');
    await git(proj, 'worktree', 'add', '-q', '-b', 'codex/design-1-2', design);
    const list = await call('GET', '/api/projects/1/git/worktrees', tok);
    const kinds = Object.fromEntries(list.j.worktrees.map((w: any) => [w.path, w.kind]));
    expect(kinds[ext]).toBe('external');
    expect(kinds[design]).toBe('design');
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: ext })).j.error.code).toBe('workspace.git.worktree_protected');
    expect((await call('POST', '/api/projects/1/git/worktrees/remove', tok, { path: design })).j.error.code).toBe('workspace.git.worktree_protected');
    expect((await call('POST', '/api/projects/1/git/worktrees/associate', tok, { path: design })).j.error.code).toBe('workspace.git.worktree_protected');
    const assoc = await call('POST', '/api/projects/1/git/worktrees/associate', tok, { path: ext });
    expect(assoc.j.project.cwd).toBe(ext);
    // 幂等：再次关联复用同一项目
    expect((await call('POST', '/api/projects/1/git/worktrees/associate', tok, { path: ext })).j.project.id).toBe(assoc.j.project.id);
    expect((await call('POST', '/api/projects/1/git/worktrees/associate', tok, { path: '/nope' })).status).toBe(404);
  });

  test('非 Git 目录：Git 写操作给出结构化的非仓库错误', async () => {
    const { call, tok } = await setup({ repo: false });
    expect((await call('GET', '/api/projects/1/git/worktrees', tok)).j.error.code).toBe('workspace.git.not_repo');
    expect((await call('POST', '/api/projects/1/git/fetch', tok)).j.error.code).toBe('workspace.git.not_repo');
  });
});

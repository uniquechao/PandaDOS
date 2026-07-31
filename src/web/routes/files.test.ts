/**
 * routes/files 单测 —— 项目文件浏览五端点（v1 /api/files|file|download|upload 平移改造）：
 * 鉴权（project-owner）× 路径穿越 × 大小/二进制拒绝 × 读写/上传/下载副作用。
 * Driver 用 LocalDriver 指向临时目录（控制面测试替身，driver.ts 双重身份）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { MAX_TEXT_BYTES } from '../../core/files';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { filesRoutes } from './files';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-files-route-'));
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
  const proj = path.join(dir, 'proj');
  await fsp.mkdir(path.join(proj, 'sub'), { recursive: true });
  await fsp.writeFile(path.join(proj, 'readme.md'), '# hello\n');
  await fsp.writeFile(path.join(proj, 'sub', 'a.txt'), 'aaa');
  // 项目 cwd 外的邻居文件（穿越目标，任何端点都不该碰到它）
  await fsp.writeFile(path.join(dir, 'secret.txt'), 'secret');
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, ?, ?, ?)`,
  ).run(proj, alice.user.id, Date.now());

  const driver = new LocalDriver();
  const dispatch = createDispatcher(
    filesRoutes({ db, driverForProject: () => driver }),
    authDepsFromDb(db, users),
  );
  return { db, dispatch, proj, admin, alice, bob };
}

function get(p: string, token?: string): Request {
  return new Request(`http://t${p}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function put(p: string, token: string, body: unknown): Request {
  return new Request(`http://t${p}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function upload(p: string, token: string, file?: File | string): Request {
  const fd = new FormData();
  if (file !== undefined) fd.set('file', file);
  return new Request(`http://t${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
}

async function j(r: Response | Promise<Response> | null): Promise<{ status: number; body: any }> {
  const resp = await r!;
  return { status: resp.status, body: await resp.json() };
}

describe('GET /api/projects/:projectId/fs（列目录）', () => {
  test('鉴权矩阵：未登录 401 / 非属主 403 / 属主与 admin 过 / 不存在项目 admin 404·普通 403', async () => {
    const s = await setup();
    expect((await j(s.dispatch(get('/api/projects/1/fs')))).status).toBe(401);
    expect((await j(s.dispatch(get('/api/projects/1/fs', s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(get('/api/projects/1/fs', s.alice.token)))).status).toBe(200);
    expect((await j(s.dispatch(get('/api/projects/1/fs', s.admin.token)))).status).toBe(200);
    expect((await j(s.dispatch(get('/api/projects/99/fs', s.admin.token)))).status).toBe(404);
    expect((await j(s.dispatch(get('/api/projects/99/fs', s.bob.token)))).status).toBe(403);
  });

  test('根目录列表：目录在前按名排序，带 size/mtimeMs/mode', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/1/fs', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.cwd).toBe(s.proj);
    expect(r.body.path).toBe('');
    expect(r.body.entries.map((e: any) => e.name)).toEqual(['sub', 'readme.md']);
    const sub = r.body.entries[0];
    expect(sub.type).toBe('dir');
    const readme = r.body.entries[1];
    expect(readme.type).toBe('file');
    expect(readme.size).toBe(8);
    expect(typeof readme.mtimeMs).toBe('number');
    expect(typeof readme.mode).toBe('number');
  });

  test('子目录 path 参数生效，返回归一化相对路径', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/1/fs?path=.%2Fsub', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.path).toBe('sub');
    expect(r.body.entries.map((e: any) => e.name)).toEqual(['a.txt']);
  });

  test('穿越 400 / 不存在 404 / 非目录 400', async () => {
    const s = await setup();
    expect((await j(s.dispatch(get('/api/projects/1/fs?path=..', s.alice.token)))).status).toBe(400);
    expect(
      (await j(s.dispatch(get('/api/projects/1/fs?path=..%2Fsecret.txt', s.alice.token)))).status,
    ).toBe(400);
    expect((await j(s.dispatch(get('/api/projects/1/fs?path=nope', s.alice.token)))).status).toBe(404);
    expect(
      (await j(s.dispatch(get('/api/projects/1/fs?path=readme.md', s.alice.token)))).status,
    ).toBe(400);
  });
});

describe('GET /api/projects/:projectId/fs/file（读文本）', () => {
  test('happy path：返回 content/size/mode', async () => {
    const s = await setup();
    const r = await j(s.dispatch(get('/api/projects/1/fs/file?path=readme.md', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.content).toBe('# hello\n');
    expect(r.body.size).toBe(8);
    expect(typeof r.body.mode).toBe('number');
  });

  test('二进制 415 / 超 1MB 413 / 目录 400 / 不存在 404 / 穿越 400', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.proj, 'bin.dat'), new Uint8Array([1, 0, 2]));
    await fsp.writeFile(path.join(s.proj, 'big.txt'), new Uint8Array(MAX_TEXT_BYTES + 1).fill(97));
    const g = (p: string) => j(s.dispatch(get(`/api/projects/1/fs/file?path=${p}`, s.alice.token)));
    expect((await g('bin.dat')).status).toBe(415);
    expect((await g('big.txt')).status).toBe(413);
    expect((await g('sub')).status).toBe(400);
    expect((await g('nope.txt')).status).toBe(404);
    expect((await g('..%2Fsecret.txt')).status).toBe(400);
  });

  test('鉴权：非属主 403', async () => {
    const s = await setup();
    expect(
      (await j(s.dispatch(get('/api/projects/1/fs/file?path=readme.md', s.bob.token)))).status,
    ).toBe(403);
  });
});

describe('PUT /api/projects/:projectId/fs/file（写回已有文本）', () => {
  test('happy path：内容写盘，返回 size', async () => {
    const s = await setup();
    const r = await j(
      s.dispatch(put('/api/projects/1/fs/file?path=readme.md', s.alice.token, { content: 'new!' })),
    );
    expect(r.status).toBe(200);
    expect(r.body.size).toBe(4);
    expect(await fsp.readFile(path.join(s.proj, 'readme.md'), 'utf-8')).toBe('new!');
  });

  test('不存在的文件 404（新文件走上传）/ 目录 400 / 穿越 400 / content 非字符串 400 / 超限 413', async () => {
    const s = await setup();
    const w = (p: string, body: unknown) =>
      j(s.dispatch(put(`/api/projects/1/fs/file?path=${p}`, s.alice.token, body)));
    expect((await w('nope.txt', { content: 'x' })).status).toBe(404);
    expect((await w('sub', { content: 'x' })).status).toBe(400);
    expect((await w('..%2Fsecret.txt', { content: 'x' })).status).toBe(400);
    expect((await w('readme.md', { content: 42 })).status).toBe(400);
    expect((await w('readme.md', { content: 'x'.repeat(MAX_TEXT_BYTES + 1) })).status).toBe(413);
    // 穿越/拒绝路径上的目标文件不能被碰
    expect(await fsp.readFile(path.join(path.dirname(s.proj), 'secret.txt'), 'utf-8')).toBe('secret');
  });
});

describe('GET /api/projects/:projectId/fs/download（下载）', () => {
  test('happy path：attachment 头 + 原始字节', async () => {
    const s = await setup();
    const resp = await s.dispatch(get('/api/projects/1/fs/download?path=readme.md', s.alice.token))!;
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-disposition')).toContain('attachment');
    expect(resp.headers.get('content-disposition')).toContain('readme.md');
    expect(await resp.text()).toBe('# hello\n');
  });

  test('目录 400 / 不存在 404 / 穿越 400 / 未登录 401', async () => {
    const s = await setup();
    const g = (p: string, t?: string) =>
      j(s.dispatch(get(`/api/projects/1/fs/download?path=${p}`, t)));
    expect((await g('sub', s.alice.token)).status).toBe(400);
    expect((await g('nope', s.alice.token)).status).toBe(404);
    expect((await g('..%2Fsecret.txt', s.alice.token)).status).toBe(400);
    expect((await g('readme.md')).status).toBe(401);
  });
});

describe('GET /api/projects/:projectId/fs/raw（内联预览）', () => {
  test('按扩展名推断 content-type + inline + nosniff；原始字节', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.proj, 'pic.png'), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    // 文本类
    const rt = await s.dispatch(get('/api/projects/1/fs/raw?path=readme.md', s.alice.token))!;
    expect(rt.status).toBe(200);
    expect(rt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(rt.headers.get('content-disposition')).toContain('inline');
    expect(rt.headers.get('content-disposition')).toContain('readme.md');
    expect(rt.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await rt.text()).toBe('# hello\n');
    // 图片：按扩展名给 image/png，原始字节保真
    const rp = await s.dispatch(get('/api/projects/1/fs/raw?path=pic.png', s.alice.token))!;
    expect(rp.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await rp.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  test('html/svg 加 CSP sandbox；普通图片不加', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.proj, 'page.html'), '<h1>hi</h1>');
    await fsp.writeFile(path.join(s.proj, 'pic.png'), new Uint8Array([1, 2, 3]));
    const rh = await s.dispatch(get('/api/projects/1/fs/raw?path=page.html', s.alice.token))!;
    expect(rh.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(rh.headers.get('content-security-policy')).toBe('sandbox');
    const rp = await s.dispatch(get('/api/projects/1/fs/raw?path=pic.png', s.alice.token))!;
    expect(rp.headers.get('content-security-policy')).toBeNull();
  });

  test('未知扩展名 → octet-stream；目录 400 / 不存在 404 / 穿越 400 / 未登录 401 / 非属主 403', async () => {
    const s = await setup();
    await fsp.writeFile(path.join(s.proj, 'blob.xyz'), 'zzz');
    const g = (p: string, t?: string) => s.dispatch(get(`/api/projects/1/fs/raw?path=${p}`, t))!;
    expect((await g('blob.xyz', s.alice.token)).headers.get('content-type')).toBe('application/octet-stream');
    expect((await g('sub', s.alice.token)).status).toBe(400);
    expect((await g('nope', s.alice.token)).status).toBe(404);
    expect((await g('..%2Fsecret.txt', s.alice.token)).status).toBe(400);
    expect((await g('readme.md')).status).toBe(401);
    expect((await g('readme.md', s.bob.token)).status).toBe(403);
  });
});

describe('POST /api/projects/:projectId/fs/upload（上传到目录）', () => {
  test('happy path：落到指定子目录，返回 rel path', async () => {
    const s = await setup();
    const f = new File([new TextEncoder().encode('data!')], 'up.bin');
    const r = await j(s.dispatch(upload('/api/projects/1/fs/upload?path=sub', s.alice.token, f)));
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('up.bin');
    expect(r.body.path).toBe('sub/up.bin');
    expect(r.body.size).toBe(5);
    expect(await fsp.readFile(path.join(s.proj, 'sub', 'up.bin'), 'utf-8')).toBe('data!');
  });

  test('穿越文件名剥成基名，落点仍在目标目录内', async () => {
    const s = await setup();
    const f = new File(['x'], '../../escape.txt');
    const r = await j(s.dispatch(upload('/api/projects/1/fs/upload', s.alice.token, f)));
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('escape.txt');
    expect(fs.existsSync(path.join(s.proj, 'escape.txt'))).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(s.proj), 'escape.txt'))).toBe(false);
  });

  test('目标目录穿越 400 / 不存在 404 / 缺 file 字段 400 / 非属主 403', async () => {
    const s = await setup();
    const f = () => new File(['x'], 'x.txt');
    expect(
      (await j(s.dispatch(upload('/api/projects/1/fs/upload?path=..', s.alice.token, f())))).status,
    ).toBe(400);
    expect(
      (await j(s.dispatch(upload('/api/projects/1/fs/upload?path=nope', s.alice.token, f()))))
        .status,
    ).toBe(404);
    expect(
      (await j(s.dispatch(upload('/api/projects/1/fs/upload', s.alice.token)))).status,
    ).toBe(400);
    expect(
      (await j(s.dispatch(upload('/api/projects/1/fs/upload', s.bob.token, f())))).status,
    ).toBe(403);
  });

  test('Content-Length 先行拦截超大 body → 413', async () => {
    const s = await setup();
    const req = new Request('http://t/api/projects/1/fs/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.alice.token}`,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(64 * 1024 * 1024),
      },
      body: '--x--',
    });
    expect((await j(s.dispatch(req))).status).toBe(413);
  });
});

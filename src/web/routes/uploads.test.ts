/**
 * routes/uploads 单测 —— POST /api/projects/:projectId/upload 的
 * 鉴权（project-owner）× 类型 × 大小 × 路径 拒绝矩阵 + 落盘/exclude 副作用。
 * Driver 用 LocalDriver 指向临时目录（控制面测试替身，driver.ts 双重身份）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { isUploadRel, UPLOAD_DIR } from '../../core/uploads';
import { UserStore } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { MAX_UPLOAD_BYTES, uploadsRoutes } from './uploads';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mando-uploads-route-'));
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
  // 项目 1 归 alice；cwd 是带 .git/info 的目录（验证 exclude 副作用）
  const proj = path.join(dir, 'proj');
  await fsp.mkdir(path.join(proj, '.git', 'info'), { recursive: true });
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, ?, ?, ?)`,
  ).run(proj, alice.user.id, Date.now());

  const driver = new LocalDriver();
  const dispatch = createDispatcher(uploadsRoutes({ db, driver }), authDepsFromDb(db, users));
  return { db, dispatch, proj, admin, alice, bob };
}

/** 组 multipart 上传请求；file 省略 = 空表单；string = 文本字段（非文件） */
function upload(p: string, token?: string, file?: File | string): Request {
  const fd = new FormData();
  if (file !== undefined) fd.set('file', file);
  return new Request(`http://t${p}`, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  });
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function j(r: Response | Promise<Response> | null): Promise<{ status: number; body: any }> {
  const resp = await r!;
  return { status: resp.status, body: await resp.json() };
}

describe('POST /api/projects/:projectId/upload', () => {
  test('鉴权矩阵：未登录 401 / 非属主 403 / 属主与 admin 过 / 不存在项目 admin 404·普通 403', async () => {
    const s = await setup();
    const f = () => new File([PNG], 'shot.png', { type: 'image/png' });

    expect((await j(s.dispatch(upload('/api/projects/1/upload', undefined, f())))).status).toBe(401);
    expect((await j(s.dispatch(upload('/api/projects/1/upload', s.bob.token, f())))).status).toBe(403);
    expect((await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, f())))).status).toBe(200);
    expect((await j(s.dispatch(upload('/api/projects/1/upload', s.admin.token, f())))).status).toBe(200);

    // 不存在的项目：admin 见 404，普通用户统一 403（不泄露存在性，middleware 语义）
    expect((await j(s.dispatch(upload('/api/projects/99/upload', s.admin.token, f())))).status).toBe(404);
    expect((await j(s.dispatch(upload('/api/projects/99/upload', s.bob.token, f())))).status).toBe(403);

    // 无效 projectId → 400（middleware 缺 projectId）
    expect((await j(s.dispatch(upload('/api/projects/abc/upload', s.alice.token, f())))).status).toBe(400);
  });

  test('happy path：落盘到 cwd/UPLOAD_DIR/<随机>/，返回 rel+abs+name+size，git exclude 写好', async () => {
    const s = await setup();
    const file = new File([PNG], 'shot.png', { type: 'image/png' });
    const r = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, file)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.name).toBe('shot.png');
    expect(r.body.size).toBe(PNG.length);
    expect(isUploadRel(r.body.path)).toBe(true);
    expect(r.body.abs).toBe(path.join(s.proj, r.body.path));
    expect(new Uint8Array(await fsp.readFile(r.body.abs))).toEqual(PNG);
    const ex = await fsp.readFile(path.join(s.proj, '.git', 'info', 'exclude'), 'utf-8');
    expect(ex.split('\n').some((l) => l.trim() === UPLOAD_DIR + '/')).toBe(true);
  });

  test('路径拒绝：穿越文件名被剥成基名，落点仍在上传目录内', async () => {
    const s = await setup();
    const file = new File([PNG], '../../etc/passwd.png', { type: 'image/png' });
    const r = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, file)));
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('passwd.png');
    expect(r.body.path).not.toContain('..');
    expect(isUploadRel(r.body.path)).toBe(true);
    // 绝对路径必须落在项目 cwd 的上传目录下
    expect(r.body.abs.startsWith(path.join(s.proj, UPLOAD_DIR) + path.sep)).toBe(true);
    expect(fs.existsSync(path.join(path.dirname(s.proj), 'etc', 'passwd.png'))).toBe(false);
  });

  test('类型拒绝：非白名单扩展名/无扩展名 → 415', async () => {
    const s = await setup();
    for (const bad of ['evil.exe', 'noext', 'x.svg', '..png']) {
      const r = await j(
        s.dispatch(upload('/api/projects/1/upload', s.alice.token, new File([PNG], bad))),
      );
      expect(r.status).toBe(415);
      expect(r.body.ok).toBe(false);
    }
  });

  test('大小拒绝：>5MB → 413；恰好 5MB 放行', async () => {
    const s = await setup();
    const over = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.png', { type: 'image/png' });
    const r1 = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, over)));
    expect(r1.status).toBe(413);

    const exact = new File([new Uint8Array(MAX_UPLOAD_BYTES)], 'ok.png', { type: 'image/png' });
    const r2 = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, exact)));
    expect(r2.status).toBe(200);
    expect(r2.body.size).toBe(MAX_UPLOAD_BYTES);
  });

  test('形态拒绝：缺 file 字段 / file 是文本字段 / 非 multipart body → 400', async () => {
    const s = await setup();
    expect((await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token)))).status).toBe(400);
    expect(
      (await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, 'not-a-file')))).status,
    ).toBe(400);

    const jsonReq = new Request('http://t/api/projects/1/upload', {
      method: 'POST',
      headers: { authorization: `Bearer ${s.alice.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'x' }),
    });
    expect((await j(s.dispatch(jsonReq))).status).toBe(400);
  });

  test('Content-Length 先行拦截：声明超限直接 413（不进 formData 缓冲）', async () => {
    const s = await setup();
    const req = new Request('http://t/api/projects/1/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.alice.token}`,
        'content-type': 'multipart/form-data; boundary=x',
        'content-length': String(MAX_UPLOAD_BYTES + 1024 * 1024),
      },
      body: '--x--',
    });
    expect((await j(s.dispatch(req))).status).toBe(413);
  });

  test('同名两次上传 → 不同随机子目录，互不覆盖', async () => {
    const s = await setup();
    const mk = () => new File([PNG], 'same.png', { type: 'image/png' });
    const a = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, mk())));
    const b = await j(s.dispatch(upload('/api/projects/1/upload', s.alice.token, mk())));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.path).not.toBe(b.body.path);
    expect(fs.existsSync(a.body.abs)).toBe(true);
    expect(fs.existsSync(b.body.abs)).toBe(true);
  });
});

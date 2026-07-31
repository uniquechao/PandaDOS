/**
 * issues/migrations —— 模块相关迁移链的数据行为（035 回填 + 037 文本列收敛）。
 *
 * 这里必须分段执行迁移：035 的回填只对「迁移前就存在的旧 issue」生效，一次性跑完全部编号
 * 就无法造出旧数据现场。做法是把迁移文件按编号分批复制到临时目录分次 migrate（schema_migrations
 * 按编号记账，分批与一次性等价）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { ISSUE_ENGINE_MIGRATIONS_DIR } from './engine';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** 把 issues/migrations 里编号落在 [from, to] 的迁移复制到临时目录并执行 */
async function applyRange(db: ReturnType<typeof openDb>, from: number, to: number): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-mig-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  for (const f of await fsp.readdir(ISSUE_ENGINE_MIGRATIONS_DIR)) {
    const id = Number.parseInt(f, 10);
    if (!Number.isFinite(id) || id < from || id > to) continue;
    await fsp.copyFile(path.join(ISSUE_ENGINE_MIGRATIONS_DIR, f), path.join(dir, f));
  }
  migrate(db, dir);
}

/** 造一个「034 已建表、035 尚未回填」的旧库现场 */
async function legacyDb() {
  const db = openDb(':memory:');
  cleanups.push(async () => db.close());
  migrate(db); // core 001-011
  await applyRange(db, 30, 34); // 030-034：issues 引擎列 + project_modules + issues.module_id
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`,
  );
  db.run(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, goal, created_ts)
     VALUES (7, 'demo', 1, '/tmp/repo', 1, 'g', 1)`,
  );
  return db;
}

function insertIssue(
  db: ReturnType<typeof openDb>,
  id: number,
  moduleText: string,
  agent: 'claude' | 'codex',
): void {
  db.run(
    `INSERT INTO issues (id, project_id, title, body, category, module, impl_mode, agent, status, created_by, created_ts)
     VALUES (?, 7, ?, NULL, 'task', ?, 'seq', ?, 'done', 1, ?)`,
    [id, `issue ${id}`, moduleText, agent, id],
  );
}

describe('037：issues.module 文本列收敛到模块 slug', () => {
  test('035 回填后文本列仍是旧显示名 → 037 把它刷成 slug（同名跨代理各归各的模块）', async () => {
    const db = await legacyDb();
    // 生产实况：文本「issue」同时被 claude 与 codex 的 issue 用着，035 会拆成两个模块
    insertIssue(db, 1, 'issue', 'claude');
    insertIssue(db, 2, 'issue', 'codex');
    insertIssue(db, 3, 'issue', 'claude');
    insertIssue(db, 4, '', 'claude'); // 空文本 → 035 归入「未分类」

    await applyRange(db, 35, 99);

    const rows = db
      .query<{ id: number; module: string; module_id: number; slug: string; agent: string }, []>(
        `SELECT i.id, i.module, i.module_id, pm.slug, pm.agent
           FROM issues i JOIN project_modules pm ON pm.id = i.module_id ORDER BY i.id`,
      )
      .all();
    expect(rows.length).toBe(4);
    // 每条 issue 的文本列都等于它所属模块的 slug —— 调度分组不再被旧文本骗
    for (const r of rows) expect(r.module).toBe(r.slug);
    // 同名不同代理确实是两个模块，且文本列已经分得开
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(1)!.module_id).not.toBe(byId.get(2)!.module_id);
    expect(byId.get(1)!.module).not.toBe(byId.get(2)!.module);
    expect(byId.get(1)!.module).toBe(byId.get(3)!.module); // 同模块两条文本一致
  });

  test('不动没绑模块的 issue，且重复执行幂等', async () => {
    const db = await legacyDb();
    insertIssue(db, 1, 'issue', 'claude');
    await applyRange(db, 35, 99);
    // 造一条 035 之后新增、故意不绑模块的（旧库兼容路径）
    insertIssue(db, 2, '自由文本', 'claude');

    const before = db.query<{ module: string }, []>('SELECT module FROM issues WHERE id = 2').get()!.module;
    await applyRange(db, 35, 99); // 幂等重跑（编号已记账，实际不再执行）
    const after = db.query<{ module: string }, []>('SELECT module FROM issues WHERE id = 2').get()!.module;
    expect(after).toBe(before);
    expect(after).toBe('自由文本');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM issues WHERE module_id IS NULL').get()!.n).toBe(1);
  });
});

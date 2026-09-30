import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { LocalDriver } from '../executor/local';
import { migrateIssueEngine } from '../issues/engine';
import { moduleIssueRelPath } from '../issues/module-docs';
import { gitLockKey, KeyedMutex } from '../issues/mutex';
import { renumberIssue } from '../issues/issue-renumber';
import { createProjectDataPersistence } from './project-data-persistence';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('Issue Markdown 协作持久化', () => {
  test('已导入 Issue 回写原 doc_path，不按数据库 ID 新建重复过程页', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-issue-persist-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', '', ?, '')`, [cwd]);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, ?, 1, 1)`, [cwd]);
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, sync_uid, created_ts)
      VALUES (12, 7, 'sync-core', 'Sync Core', 'codex', 'manual', 'module-uid', 2)`);

    const original = '.panda/modules/sync-core/issues/33-original.md';
    await fsp.mkdir(path.join(cwd, path.dirname(original)), { recursive: true });
    await fsp.writeFile(path.join(cwd, original), `# #33 Imported issue\n\n<!-- panda:issue-meta:start -->\n---\nstatus: pending\n---\n<!-- panda:issue-meta:end -->\n`);
    db.run(`INSERT INTO issues
      (id, project_id, title, module, module_id, agent, status, sync_uid, doc_path, created_ts)
      VALUES (247, 7, 'Imported issue', 'sync-core', 12, 'codex', 'pending', 'issue-uid', ?, 3)`, [original]);
    db.run('DELETE FROM project_data_outbox');
    db.run("UPDATE issues SET status = 'done' WHERE id = 247");

    let entered!: () => void;
    let release!: () => void;
    const enteredWrite = new Promise<void>((resolve) => { entered = resolve; });
    const allowWrite = new Promise<void>((resolve) => { release = resolve; });
    class PausingDriver extends LocalDriver {
      override async replaceFileNoFollowWithin(
        root: string, relativePath: string, data: Uint8Array, expectedSha256: string | null,
      ) {
        entered();
        await allowWrite;
        return super.replaceFileNoFollowWithin(root, relativePath, data, expectedSha256);
      }
    }
    const mutex = new KeyedMutex();
    const outbox = createProjectDataPersistence(db, () => new PausingDriver(), mutex);
    const draining = outbox.drain();
    await enteredWrite;
    let gitEntered = false;
    const gitWork = mutex.runExclusive(gitLockKey(7), () => { gitEntered = true; });
    await Promise.resolve();
    expect(gitEntered).toBe(false); // 原子替换的临时文件消失前，git add/commit 不得开始
    release();
    expect(await draining).toEqual({ persisted: 1, failed: 0, remaining: 0 });
    await gitWork;
    expect(gitEntered).toBe(true);
    expect(await fsp.readFile(path.join(cwd, original), 'utf8')).toContain('status: done');
    const duplicate = moduleIssueRelPath('sync-core', '247', 'Imported issue');
    expect(await fsp.stat(path.join(cwd, duplicate)).catch(() => null)).toBeNull();
    db.close();
  });

  test('#307 换号后过程页搬到新编号路径：标题改新编号、旧文件删除', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-issue-renumber-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', '', ?, '')`, [cwd]);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (7, 'demo', 1, ?, 1, 1)`, [cwd]);
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, sync_uid, created_ts)
      VALUES (12, 7, 'sync-core', 'Sync Core', 'codex', 'manual', 'module-uid', 2)`);
    const oldId = '20260917-a3f9e4f';
    const oldRel = `.panda/modules/sync-core/issues/${oldId}-local.md`;
    await fsp.mkdir(path.join(cwd, path.dirname(oldRel)), { recursive: true });
    await fsp.writeFile(path.join(cwd, oldRel),
      `# #${oldId} Local issue\n\n## 原始需求\n\nbody\n\n## 设计与实施\n\n人工记录\n`);
    db.run(`INSERT INTO issues
      (id, project_id, title, body, module, module_id, agent, status, sync_uid, doc_path, created_ts)
      VALUES (?, 7, 'Local issue', 'body', 'sync-core', 12, 'codex', 'pending', 'issue-uid', ?, 3)`, [oldId, oldRel]);
    db.run('DELETE FROM project_data_outbox');

    const newId = renumberIssue(db, oldId, { to: '20260917-cccc222', reason: 'sync_collision' });
    const outbox = createProjectDataPersistence(db, () => new LocalDriver(), new KeyedMutex());
    const drained = await outbox.drain();
    expect(drained.failed).toBe(0);

    const newRel = `.panda/modules/sync-core/issues/${newId}-local.md`;
    const content = await fsp.readFile(path.join(cwd, newRel), 'utf8');
    expect(content.startsWith(`# #${newId} Local issue`)).toBe(true);
    expect(content).toContain('人工记录');
    expect(content).toContain(`issue_id: ${newId}`);
    expect(content).not.toContain(`# #${oldId}`);
    expect(await fsp.stat(path.join(cwd, oldRel)).catch(() => null)).toBeNull();
    db.close();
  });
});

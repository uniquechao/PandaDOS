import { describe, expect, test } from 'bun:test';
import { migrateDesigns } from '../designs/store';
import { migrateIssueEngine } from '../issues/engine';
import { openDb } from './db';
import { migrate } from './migrate';
import { JsonProjectDataOutboxHandler, ProjectDataPersistenceOutbox } from './project-data-outbox';
import { PandaProjectSync } from './project-sync';
import { LocalDriver } from '../executor/local';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function setup() {
  const db = openDb(':memory:');
  migrate(db); migrateIssueEngine(db); migrateDesigns(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
  db.run(`INSERT INTO executors
    (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'e', 'local', '', '', '/ws', '')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'p', 1, '/ws/p', 1, 1)`);
  db.run('DELETE FROM project_data_outbox');
  return db;
}

describe('协作文件持久化 outbox', () => {
  test('各长期领域变更在业务事务内合并登记，归档覆盖待写操作', () => {
    const db = setup();
    db.transaction(() => {
      db.run(`INSERT INTO project_modules
        (id, project_id, slug, display_name, agent, source, created_ts)
        VALUES (11, 1, 'sync-core', '同步', 'codex', 'manual', 2)`);
      db.run(`INSERT INTO issues (id, project_id, module_id, title, created_ts)
        VALUES (12, 1, 11, 'Issue', 3)`);
      db.run(`INSERT INTO project_workflow_templates
        (id, project_id, name, current_version, created_ts, updated_ts)
        VALUES (13, 1, '流程', 1, 4, 4)`);
      db.run(`INSERT INTO design_tasks
        (id, project_id, title, original_request, agent, created_ts, updated_ts)
        VALUES (14, 1, '设计', '需求', 'codex', 5, 5)`);
      db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent)
        VALUES ('conversation-1', 1, '对话', 6, 'codex')`);
      db.run(`INSERT INTO project_attachments
        (id, project_id, path, sha256, size, created_ts)
        VALUES (15, 1, '.panda/uploads/a/a.png', ?, 1, 7)`, ['0'.repeat(64)]);
      db.run("UPDATE issues SET status = 'cancelled' WHERE id = 12");
      db.run("UPDATE project_modules SET status = 'archived' WHERE id = 11");
    })();
    const jobs = new ProjectDataPersistenceOutbox(db, new Map()).pending();
    expect(jobs.map((job) => [job.entityKind, job.entityId, job.action])).toEqual([
      ['module', '11', 'archive'], ['issue', '12', 'archive'], ['workflow', '13', 'upsert'],
      ['design', '14', 'upsert'], ['conversation', 'conversation-1', 'upsert'], ['attachment', '15', 'upsert'],
    ]);
    db.close();
  });

  test('业务事务回滚不留下任务，失败写入保留错误并到期重试', async () => {
    const db = setup();
    expect(() => db.transaction(() => {
      db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (20, 1, '回滚', 2)`);
      throw new Error('rollback');
    })()).toThrow('rollback');
    expect(new ProjectDataPersistenceOutbox(db, new Map()).pending()).toEqual([]);

    db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (21, 1, '重试', 3)`);
    let now = 10_000;
    let attempts = 0;
    const outbox = new ProjectDataPersistenceOutbox(db, new Map([['issue', {
      async persist() { attempts += 1; if (attempts === 1) throw new Error('disk unavailable'); },
    }]]), () => now);
    expect(await outbox.drain()).toEqual({ persisted: 0, failed: 1, remaining: 1 });
    expect(outbox.pending()[0]).toMatchObject({ attemptCount: 1, nextAttemptTs: 11_000, lastError: 'Error: disk unavailable' });
    expect(await outbox.drain()).toEqual({ persisted: 0, failed: 0, remaining: 1 });
    now = 11_000;
    expect(await outbox.drain()).toEqual({ persisted: 1, failed: 0, remaining: 0 });
    db.close();
  });

  test('JSON 出口在提交后原子更新 .panda 文件', async () => {
    const db = setup();
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-outbox-'));
    try {
      db.run("UPDATE projects SET name = '协作项目' WHERE id = 1");
      const handler = new JsonProjectDataOutboxHandler(async () => ({
        sync: new PandaProjectSync(new LocalDriver(), null, []), cwd,
        path: '.panda/project.json', expectedFingerprint: null,
        value: { schema: 'pandados.project-data', version: 1, kind: 'project' },
      }));
      const outbox = new ProjectDataPersistenceOutbox(db, new Map([['project', handler]]));
      expect(await outbox.drain()).toEqual({ persisted: 1, failed: 0, remaining: 0 });
      expect(JSON.parse(await fs.readFile(path.join(cwd, '.panda/project.json'), 'utf8')))
        .toEqual({ kind: 'project', schema: 'pandados.project-data', version: 1 });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      db.close();
    }
  });
});

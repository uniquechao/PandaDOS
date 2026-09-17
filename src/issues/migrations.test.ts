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
import { ISSUE_ENGINE_MIGRATIONS_DIR, migrateIssueEngine } from './engine';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** 把 issues/migrations 里编号落在 [from, to] 的迁移复制到临时目录并执行 */
async function applyRange(db: ReturnType<typeof openDb>, from: number, to: number): Promise<void> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-mig-'));
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

describe('039/041：原子发布依赖与通用执行同步', () => {
  test('从 038 升级保留 issue，并添加可级联依赖、发布锁和 fail-closed 同步表', async () => {
    const db = await legacyDb();
    insertIssue(db, 1, 'legacy', 'claude');
    insertIssue(db, 2, 'legacy', 'claude');
    await applyRange(db, 35, 38);

    await applyRange(db, 39, 41);

    expect(db.query<{ title: string }, []>('SELECT title FROM issues WHERE id = 1').get()?.title).toBe('issue 1');
    const columns = db.query<{ name: string }, []>('PRAGMA table_info(issues)').all().map((c) => c.name);
    expect(columns).toContain('publication_locked');
    expect(db.query<{ publication_locked: number }, []>('SELECT publication_locked FROM issues WHERE id = 1').get())
      .toEqual({ publication_locked: 0 });

    db.query(
      `INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, kind, created_ts)
       VALUES (2, 1, 'blocks', 10)`,
    ).run();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_dependencies').get()?.n).toBe(1);
    expect(() => db.run(
      `INSERT INTO issue_dependencies (issue_id, depends_on_issue_id, kind, created_ts)
       VALUES (1, 1, 'blocks', 11)`,
    )).toThrow();

    db.query(
      `INSERT INTO issue_execution_syncs
       (issue_id, source_kind, source_key, source_revision, source_digest, diff_json, state, requested_ts)
       VALUES (2, 'design', 'design-7/node-b', '4', 'sha256:one', '{}', 'requested', 20)`,
    ).run();
    const syncColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(issue_execution_syncs)')
      .all()
      .map((c) => c.name);
    expect(syncColumns).toContain('resume_key');
    expect(syncColumns).toContain('resume_claimed_ts');
    expect(syncColumns).not.toContain('resume_lease_ts');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_execution_sync_effect_receipts'",
    ).get()?.name).toBe('issue_execution_sync_effect_receipts');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_execution_sync_effect_outbox'",
    ).get()?.name).toBe('issue_execution_sync_effect_outbox');
    const effectColumns = db
      .query<{ name: string }, []>('PRAGMA table_info(issue_execution_sync_effect_outbox)')
      .all()
      .map((c) => c.name);
    expect(effectColumns).toContain('delivery_state');
    expect(effectColumns).toContain('delivery_token');
    expect(effectColumns).toContain('dispatch_started_ts');
    expect(() => db.query(
      `INSERT INTO issue_execution_syncs
       (issue_id, source_kind, source_key, source_revision, source_digest, diff_json, state, requested_ts)
       VALUES (2, 'design', 'design-7/node-b', '4', 'sha256:one', '{}', 'requested', 21)`,
    ).run()).toThrow();
    expect(() => db.query(
      `INSERT INTO issue_execution_syncs
       (issue_id, source_kind, source_key, source_revision, source_digest, diff_json, state, requested_ts)
       VALUES (2, 'design', 'bad-state', '4', 'sha256:one', '{}', 'invented', 22)`,
    ).run()).toThrow();

    expect(db.query<{ n: number }, []>('PRAGMA foreign_key_check').all()).toEqual([]);
    db.query('DELETE FROM issues WHERE id = 1').run();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_dependencies').get()?.n).toBe(0);
  });

  test('039/041 fresh migrations are idempotent and remain Issue status/gate-neutral', () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    const firstDir = ISSUE_ENGINE_MIGRATIONS_DIR;
    migrate(db, firstDir);
    const first = migrate(db, firstDir);
    expect(first.applied.filter((id) => id >= 30 && id < 46)).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42, 43, 44, 45,
    ]);
    const issueColumns = db.query<{ name: string }, []>('PRAGMA table_info(issues)').all().map((c) => c.name);
    expect(issueColumns).toContain('completion_report_json');
    expect(issueColumns).toContain('doc_path');
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 39").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 42").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('043：模块、Issue 与工作流模板具有 UUIDv7 同步身份', () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, 'p', 1, '/ws/p', 1, 1)`);
    db.run(`INSERT INTO project_modules
      (project_id, slug, display_name, agent, source, created_ts)
      VALUES (1, 'sync-core', '同步', 'codex', 'manual', 2)`);
    db.run(`INSERT INTO issues (project_id, title, created_ts) VALUES (1, '同步', 3)`);
    db.run(`INSERT INTO project_workflow_templates
      (project_id, name, current_version, created_ts, updated_ts)
      VALUES (1, '默认', 1, 4, 4)`);
    for (const table of ['project_modules', 'issues', 'project_workflow_templates']) {
      expect(db.query<{ sync_uid: string }, []>(`SELECT sync_uid FROM ${table}`).get()!.sync_uid)
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('045：Issue 协作文件原始路径', () => {
  test('旧库升级后从同步索引回填 doc_path，未同步的 Issue 保持为空', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 44);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, sync_uid, created_ts)
      VALUES (12, 7, 'sync-core', 'Sync Core', 'codex', 'manual', 'module-uid', 2)`);
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, sync_uid, created_ts)
      VALUES (247, 7, 'Imported issue', 'sync-core', 12, 'issue-uid', 3),
             (248, 7, 'Local issue', 'sync-core', 12, 'local-uid', 4)`);
    db.run(`INSERT INTO project_data_sync_entries
      (project_id, entity_kind, sync_uid, path, fingerprint, schema_version, state, updated_ts)
      VALUES (7, 'issue', 'issue-uid', '.panda/modules/sync-core/issues/33-original.md',
              'sha256', 1, 'active', 5)`);

    await applyRange(db, 45, 45);

    const rows = db.query<{ id: number; doc_path: string | null }, []>(
      'SELECT id, doc_path FROM issues ORDER BY id',
    ).all();
    expect(rows).toEqual([
      { id: 247, doc_path: '.panda/modules/sync-core/issues/33-original.md' },
      { id: 248, doc_path: null },
    ]);
  });
});

describe('042：项目工作流模板与 issue 快照', () => {
  test('模板发布新版本不改 issue 快照，节点运行、路由和 worktree 契约可持久化', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 42);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(
      `INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`,
    );
    db.run(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, goal, created_ts)
       VALUES (7, 'demo', 1, '/tmp/repo', 1, 'g', 1)`,
    );
    db.run(
      `INSERT INTO issues (id, project_id, title, status, created_by, created_ts)
       VALUES (33, 7, 'workflow issue', 'pending', 1, 2)`,
    );

    const graph1 = JSON.stringify({
      schemaVersion: 1,
      entryNodeKey: 'issue',
      maxLoopIterations: 10,
      nodes: [{ key: 'issue', kind: 'issue', title: 'Issue' }],
      edges: [],
    });
    const graph2 = graph1.replace('Issue', 'Issue v2');
    const templateId = Number(
      db
        .query<{ id: number }, []>(
          `INSERT INTO project_workflow_templates
             (project_id, name, description, current_version, created_by, created_ts, updated_ts)
           VALUES (7, '交付流程', '实现与评审', 1, 1, 3, 3) RETURNING id`,
        )
        .get()!.id,
    );
    const version1Id = Number(
      db
        .query<{ id: number }, [number, string]>(
          `INSERT INTO project_workflow_versions
             (template_id, version, graph_json, graph_hash, created_by, created_ts)
           VALUES (?, 1, ?, 'hash-v1', 1, 3) RETURNING id`,
        )
        .get(templateId, graph1)!.id,
    );
    db.run(
      `INSERT INTO project_workflow_nodes
         (version_id, node_key, kind, title, execution_mode, max_visits, created_ts)
       VALUES (?, 'issue', 'issue', 'Issue', 'read', 1, 3),
              (?, 'implement', 'agent', '实现', 'write', 4, 3),
              (?, 'end', 'end', '完成', 'read', 1, 3)`,
      [version1Id, version1Id, version1Id],
    );
    db.run(
      `UPDATE project_workflow_nodes SET agent = 'codex' WHERE version_id = ? AND node_key = 'implement'`,
      [version1Id],
    );
    db.run(
      `INSERT INTO project_workflow_edges
         (version_id, edge_key, from_node_key, to_node_key, condition_text, priority, is_default, created_ts)
       VALUES (?, 'start', 'issue', 'implement', NULL, 0, 1, 3),
              (?, 'done', 'implement', 'end', '任务已经完成', 10, 0, 3)`,
      [version1Id, version1Id],
    );

    const workflowId = Number(
      db
        .query<{ id: number }, [number, number, string]>(
          `INSERT INTO issue_workflows
             (issue_id, template_id, template_version_id, template_name, template_version,
              graph_json, graph_hash, context_json, created_ts, updated_ts)
           VALUES (33, ?, ?, '交付流程', 1, ?, 'hash-v1', '{}', 4, 4) RETURNING id`,
        )
        .get(templateId, version1Id, graph1)!.id,
    );

    const version2Id = Number(
      db
        .query<{ id: number }, [number, string]>(
          `INSERT INTO project_workflow_versions
             (template_id, version, graph_json, graph_hash, created_by, created_ts)
           VALUES (?, 2, ?, 'hash-v2', 1, 5) RETURNING id`,
        )
        .get(templateId, graph2)!.id,
    );
    db.run('UPDATE project_workflow_templates SET current_version = 2, updated_ts = 5 WHERE id = ?', [templateId]);

    const snapshot = db
      .query<{ template_version: number; graph_json: string; graph_hash: string }, [number]>(
        'SELECT template_version, graph_json, graph_hash FROM issue_workflows WHERE id = ?',
      )
      .get(workflowId)!;
    expect(snapshot).toEqual({ template_version: 1, graph_json: graph1, graph_hash: 'hash-v1' });

    // 连线的复合外键强制两端属于同一版本，不能把版本 1 的节点串进版本 2。
    expect(() =>
      db.run(
        `INSERT INTO project_workflow_edges
           (version_id, edge_key, from_node_key, to_node_key, created_ts)
         VALUES (?, 'cross-version', 'issue', 'implement', 5)`,
        [version2Id],
      ),
    ).toThrow();

    db.run(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent)
       VALUES ('workflow-conv', 7, '实现', 6, 'codex')`,
    );
    const runId = Number(
      db
        .query<{ id: number }, [number]>(
          `INSERT INTO issue_workflow_node_runs
             (issue_workflow_id, node_key, attempt, iteration, token_key, parallel_group_key,
              agent, conversation_id, status, selected_edge_keys_json, output_text, route_reason,
              created_ts, updated_ts, started_ts, finished_ts)
           VALUES (?, 'implement', 2, 2, 'token-a', 'parallel-1', 'codex', 'workflow-conv',
                   'succeeded', '["done"]', '实现完成', '自然语言结果命中完成条件', 6, 7, 6, 7)
           RETURNING id`,
        )
        .get(workflowId)!.id,
    );
    db.run(
      `INSERT INTO issue_workflow_transitions
         (issue_workflow_id, from_run_id, edge_key, to_node_key, decision_text, iteration,
          parallel_group_key, created_ts)
       VALUES (?, ?, 'done', 'end', '自然语言结果命中完成条件', 2, 'parallel-1', 7)`,
      [workflowId, runId],
    );
    db.run(
      `INSERT INTO issue_workflow_worktrees
         (issue_workflow_id, node_run_id, path, branch, base_ref, base_sha, head_sha,
          status, conflict_details, created_ts, updated_ts)
       VALUES (?, ?, '/tmp/worktrees/implement', 'workflow/33/implement', 'main', 'base', 'head',
               'resolving', 'src/a.ts', 6, 7)`,
      [workflowId, runId],
    );

    expect(
      db
        .query<{ attempt: number; iteration: number; status: string; route_reason: string }, [number]>(
          'SELECT attempt, iteration, status, route_reason FROM issue_workflow_node_runs WHERE id = ?',
        )
        .get(runId),
    ).toEqual({
      attempt: 2,
      iteration: 2,
      status: 'succeeded',
      route_reason: '自然语言结果命中完成条件',
    });
    expect(
      db
        .query<{ edge_key: string; iteration: number }, [number]>(
          'SELECT edge_key, iteration FROM issue_workflow_transitions WHERE from_run_id = ?',
        )
        .get(runId),
    ).toEqual({ edge_key: 'done', iteration: 2 });
    expect(
      db
        .query<{ status: string; conflict_details: string }, [number]>(
          'SELECT status, conflict_details FROM issue_workflow_worktrees WHERE node_run_id = ?',
        )
        .get(runId),
    ).toEqual({ status: 'resolving', conflict_details: 'src/a.ts' });
  });

  test('模板和运行状态枚举、循环上限与单 issue 快照约束由数据库拒绝脏值', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 42);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(
      `INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`,
    );
    db.run(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
       VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`,
    );
    db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (33, 7, 'one', 2)`);

    expect(() =>
      db.run(
        `INSERT INTO project_workflow_templates
           (project_id, name, status, created_ts, updated_ts)
         VALUES (7, 'bad', 'deleted', 3, 3)`,
      ),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO issue_workflows
           (issue_id, template_name, template_version, graph_json, graph_hash,
            context_json, max_loop_iterations, created_ts, updated_ts)
         VALUES (33, 'bad', 1, '{}', 'h', '{}', 101, 3, 3)`,
      ),
    ).toThrow();

    db.run(
      `INSERT INTO issue_workflows
         (issue_id, template_name, template_version, graph_json, graph_hash, context_json, created_ts, updated_ts)
       VALUES (33, 'ok', 1, '{}', 'h', '{}', 3, 3)`,
    );
    expect(() =>
      db.run(
        `INSERT INTO issue_workflows
           (issue_id, template_name, template_version, graph_json, graph_hash, context_json, created_ts, updated_ts)
         VALUES (33, 'duplicate', 1, '{}', 'h2', '{}', 4, 4)`,
      ),
    ).toThrow();
  });
});

describe('046：模块级技能挂载', () => {
  test('只加一列：旧行保持 NULL（= 未配置），子表数据不受牵连', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 45);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (12, 7, 'billing-core', 'Billing', 'claude', 'manual', 2)`);
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, created_ts)
      VALUES (33, 7, '老 issue', 'billing-core', 12, 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 46, 46);

    // 旧行的新列为 NULL = 未配置，沿用项目默认
    expect(db.query<{ skills_json: string | null }, []>('SELECT skills_json FROM project_modules').get())
      .toEqual({ skills_json: null });
    // 没有重建表：外键子表一行不少（034 那次整表重建的教训）
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);
    expect(db.query<{ module_id: number }, []>('SELECT module_id FROM issues').get()!.module_id).toBe(12);

    // 写入后读回原样（存的是 JSON 数组文本）
    db.run(`UPDATE project_modules SET skills_json = ? WHERE id = 12`, [JSON.stringify(['superpowers'])]);
    expect(db.query<{ skills_json: string }, []>('SELECT skills_json FROM project_modules').get()!.skills_json)
      .toBe('["superpowers"]');
  });
});

describe('047：门禁执行范围与项目门禁命令', () => {
  test('只加两列：旧行保持 NULL（= 未配置），子表数据不受牵连', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 46);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (33, 7, '老 issue', 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 47, 47);

    expect(db.query<{ validation_scope_json: string | null }, []>(
      'SELECT validation_scope_json FROM issues',
    ).get()).toEqual({ validation_scope_json: null });
    expect(db.query<{ validation_commands_json: string | null }, []>(
      'SELECT validation_commands_json FROM projects',
    ).get()).toEqual({ validation_commands_json: null });
    // 没有重建表：外键子表一行不少
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(1);
  });
});

describe('048：模块与 issue 的推理档位', () => {
  test('只加两列：旧行保持 NULL（= 继承上一层），子表数据不受牵连', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    migrate(db);
    await applyRange(db, 30, 47);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (12, 7, 'issue-engine', '引擎', 'codex', 'manual', 2)`);
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, created_ts)
      VALUES (33, 7, '老 issue', 'issue-engine', 12, 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 48, 48);

    // 存量模块回填 high：不回填的话它们会在这次发布里一次性从全局 high 掉到 medium
    expect(db.query<{ reasoning_effort: string | null }, []>(
      'SELECT reasoning_effort FROM project_modules',
    ).get()).toEqual({ reasoning_effort: 'high' });
    // issue 侧不回填：null = 继承模块
    expect(db.query<{ reasoning_effort: string | null }, []>(
      'SELECT reasoning_effort FROM issues',
    ).get()).toEqual({ reasoning_effort: null });
    // 迁移之后新建的模块仍是未配置（走控制面默认档 medium）
    db.run(`INSERT INTO project_modules
      (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (13, 7, 'later', '后建的', 'codex', 'manual', 9)`);
    expect(db.query<{ reasoning_effort: string | null }, [number]>(
      'SELECT reasoning_effort FROM project_modules WHERE id = ?',
    ).get(13)).toEqual({ reasoning_effort: null });
    // 没有重建表：外键子表一行不少
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);
    expect(db.query<{ module_id: number }, []>('SELECT module_id FROM issues').get()!.module_id).toBe(12);
  });
});

describe('049：成本埋点落库', () => {
  test('只建两张派生表，不动既有表；外键跟着源实体级联清理', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    db.run('PRAGMA foreign_keys = ON');
    migrate(db);
    await applyRange(db, 30, 48);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent)
      VALUES ('conv-1', 7, 'c', 1, 'claude')`);
    db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (33, 7, '老 issue', 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 49, 49);

    // 既有数据一行不少（只建表、不改表）
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);

    db.run(`INSERT INTO conversation_usage (conv_id, project_id, kind, scanned_bytes, updated_ts)
      VALUES ('conv-1', 7, 'chat', 128, 5)`);
    db.run(`INSERT INTO issue_usage (issue_id, project_id, output_tokens, updated_ts)
      VALUES (33, 7, 42, 5)`);
    // 计数列都有默认值：只写游标也能落
    expect(db.query<{ requests: number; kind: string }, []>(
      'SELECT requests, kind FROM conversation_usage',
    ).get()).toEqual({ requests: 0, kind: 'chat' });

    // 派生数据跟着源实体走：删 issue / 删 conversation 都会带走对应用量行
    db.run('DELETE FROM issues WHERE id = 33');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_usage').get()!.n).toBe(0);
    db.run(`DELETE FROM conversations WHERE id = 'conv-1'`);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversation_usage').get()!.n).toBe(0);
  });
});

describe('065：用量按天分桶', () => {
  test('只建表；issue_id 无外键（0 = 未归因、删 issue 也留痕），project_id 跟着项目走', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    db.run('PRAGMA foreign_keys = ON');
    migrate(db);
    await applyRange(db, 30, 64);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);
    db.run(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (33, 7, '老 issue', 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 65, 65);

    // 既有数据一行不少（只建表、不改表）
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);

    // 计数列都有默认值：只写日键也能落
    db.run(`INSERT INTO usage_daily (day, project_id, issue_id, output_tokens, updated_ts)
      VALUES ('2026-09-07', 7, 33, 42, 5)`);
    db.run(`INSERT INTO usage_daily (day, project_id, issue_id, updated_ts)
      VALUES ('2026-09-07', 7, 0, 5)`); // issue_id = 0 = 未归因：没有外键挡它
    expect(db.query<{ requests: number; issue_id: number }, []>(
      'SELECT requests, issue_id FROM usage_daily WHERE issue_id = 0',
    ).get()).toEqual({ requests: 0, issue_id: 0 });

    // 主键是三元组：同一天同项目同 issue 只能有一行
    expect(() => db.run(`INSERT INTO usage_daily (day, project_id, issue_id, updated_ts)
      VALUES ('2026-09-07', 7, 33, 6)`)).toThrow();
    // 换一天就是另一行
    db.run(`INSERT INTO usage_daily (day, project_id, issue_id, updated_ts)
      VALUES ('2026-09-08', 7, 33, 6)`);

    // issue 被删：分桶行留着（读取侧显示为「未归模块」，不许因外键把历史用量抹掉）
    db.run('DELETE FROM issues WHERE id = 33');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_daily').get()!.n).toBe(3);
    // 项目被删：整块跟着走
    db.run('DELETE FROM projects WHERE id = 7');
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM usage_daily').get()!.n).toBe(0);
  });
});

describe('064：存量模块推理档位按风险下调', () => {
  test('高风险类保持 high、其余降 medium；用户手设的档与 issue 层继承都不被覆盖', async () => {
    const db = openDb(':memory:');
    cleanups.push(async () => db.close());
    db.run('PRAGMA foreign_keys = ON');
    migrate(db);
    await applyRange(db, 30, 47);

    db.run(`INSERT INTO users (id, username, token_hash, role, created_ts)
      VALUES (1, 'admin', 'x', 'admin', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/tmp/ws', '/tmp/claude')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'demo', 1, '/tmp/repo', 1, 1)`);

    // 048 之前建的模块：跑完 048 会被统一回填成 high，正是本条要收拾的现场
    const modules: Array<[number, string, string, 'claude' | 'codex']> = [
      // 高风险：英文关键词
      [1, 'engineering-architecture', 'Engineering Architecture', 'codex'],
      [2, 'db-migration-tool', 'DB Migration Tool', 'codex'],
      [3, 'issue-engine', 'Issue Engine', 'claude'],
      [4, 'workbench-framework', 'Workbench Framework', 'codex'],
      [5, 'deployment-operations', 'Deployment Operations', 'codex'],
      [6, 'private-repo-publish', 'Private Repo Publishing', 'codex'],
      [7, 'concurrency-recovery', 'Concurrency Recovery', 'codex'],
      [8, 'schema-guard', 'Schema Guard', 'codex'],
      [9, 'task-scheduler', 'Task Scheduler', 'codex'],
      [10, 'release-pipeline', 'Release Pipeline', 'codex'],
      // 高风险：只有中文显示名命中（slug 是无关英文）
      [11, 'core-runtime', '状态机与并发恢复', 'codex'],
      [12, 'core-plumbing', '数据迁移与架构', 'codex'],
      [13, 'ops-panel', '部署与发布', 'claude'],
      [14, 'base-kit', '工作台框架与调度', 'codex'],
      [15, 'engine-cn', 'issue 引擎', 'claude'],
      // 普通后端与 UI
      [20, 'global-layout', '全体页面布局', 'claude'],
      [21, 'user-management', '用户管理', 'claude'],
      [22, 'file-browser', '文件浏览', 'claude'],
      [23, 'greeting-service', 'Greeting Service', 'codex'],
      [24, 'feishu-integration', '飞书', 'codex'],
      // 名字命中高风险词、但用户已手动设成 low/medium：不许覆盖
      [30, 'migration-docs', '迁移文档', 'codex'],
      [31, 'engine-notes', 'Engine Notes', 'codex'],
    ];
    for (const [id, slug, name, agent] of modules) {
      db.run(
        `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
         VALUES (?, 7, ?, ?, ?, 'manual', 1)`,
        [id, slug, name, agent],
      );
    }
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, created_ts)
      VALUES (33, 7, '老 issue', 'issue-engine', 3, 3)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (33, 'created', 3)`);

    await applyRange(db, 48, 48);
    // 前置现场：048 之后存量模块一律 high
    expect(db.query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM project_modules WHERE reasoning_effort = 'high'`,
    ).get()!.n).toBe(modules.length);

    // 用户手动降过档的两个（覆盖了名字命中高风险词的情况）
    db.run(`UPDATE project_modules SET reasoning_effort = 'low' WHERE id = 30`);
    db.run(`UPDATE project_modules SET reasoning_effort = 'medium' WHERE id = 31`);
    // 048 之后新建的模块：未配置（NULL = 控制面默认档 medium），这条迁移也不该动它
    db.run(`INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (40, 7, 'later-module', '后建的', 'codex', 'manual', 9)`);
    // issue 层的覆盖档：一条显式 high、一条继承（NULL）
    db.run(`UPDATE issues SET reasoning_effort = 'high' WHERE id = 33`);
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, created_ts)
      VALUES (34, 7, '继承模块档的 issue', 'global-layout', 20, 4)`);

    await applyRange(db, 64, 64);

    const effortOf = (id: number): string | null =>
      db.query<{ reasoning_effort: string | null }, [number]>(
        'SELECT reasoning_effort FROM project_modules WHERE id = ?',
      ).get(id)!.reasoning_effort;

    // 迁移/状态机/并发恢复/架构/框架/调度/部署发布：保持 high（中英双语、slug 与显示名任一命中即算）
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      expect([id, effortOf(id)]).toEqual([id, 'high']);
    }
    // 普通后端与 UI：降到 medium
    for (const id of [20, 21, 22, 23, 24]) {
      expect([id, effortOf(id)]).toEqual([id, 'medium']);
    }
    // 只改当前值恰为 high 的行：用户手设的 low/medium 与未配置的 NULL 全部原样
    expect(effortOf(30)).toBe('low');
    expect(effortOf(31)).toBe('medium');
    expect(effortOf(40)).toBeNull();

    // 不动 issue 层：显式覆盖档与继承（NULL）都保持原样
    expect(db.query<{ reasoning_effort: string | null }, [number]>(
      'SELECT reasoning_effort FROM issues WHERE id = ?',
    ).get(33)!.reasoning_effort).toBe('high');
    expect(db.query<{ reasoning_effort: string | null }, [number]>(
      'SELECT reasoning_effort FROM issues WHERE id = ?',
    ).get(34)!.reasoning_effort).toBeNull();

    // 只是 UPDATE、没有重建表：模块与子表数据一行不少，模块绑定不断
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_modules').get()!.n)
      .toBe(modules.length + 1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(2);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()!.n).toBe(1);
    expect(db.query<{ module_id: number }, [number]>('SELECT module_id FROM issues WHERE id = ?')
      .get(33)!.module_id).toBe(3);
  });
});

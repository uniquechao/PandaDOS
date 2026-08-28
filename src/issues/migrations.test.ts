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
    expect(first.applied.filter((id) => id >= 30 && id < 43)).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 41, 42,
    ]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 39").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM schema_migrations WHERE id = 42").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('PRAGMA foreign_key_check').all()).toEqual([]);
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

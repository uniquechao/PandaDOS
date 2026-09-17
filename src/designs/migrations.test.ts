import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { loadMigrations, migrate, splitStatements } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { DESIGN_MIGRATIONS_DIR, DesignStore, migrateDesigns } from './store';
import { readFileSync } from 'node:fs';

const LEGACY_SAGA_050_SQL = readFileSync(
  new URL('./test-fixtures/050_design_workbench-saga-legacy.sql', import.meta.url),
  'utf8',
);

function tableColumns(db: ReturnType<typeof openDb>, table: string): string[] {
  return db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function indexNames(db: ReturnType<typeof openDb>): string[] {
  return db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((index) => index.name);
}

function seedProject(db: ReturnType<typeof openDb>): void {
  db.run(`INSERT INTO users (username, token_hash, created_ts) VALUES ('owner', 'hash', 1)`);
  db.run(
    `INSERT INTO executors
       (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`,
  );
  db.run(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
     VALUES ('project', 1, '/workspace/project', 1, 1)`,
  );
}

function applyRecordedDesign050(db: ReturnType<typeof openDb>, sql: string, name: string): void {
  const applyBase = db.transaction(() => {
    for (const statement of splitStatements(sql)) db.run(statement);
    db.query(
      'INSERT INTO schema_migrations (id, name, applied_ts) VALUES (50, ?, 1)',
    ).run(name);
  });
  applyBase();
}

function applyDesignMigrationsThrough(db: ReturnType<typeof openDb>, maxId: number): void {
  for (const migration of loadMigrations(DESIGN_MIGRATIONS_DIR).filter((item) => item.id <= maxId)) {
    if (db.query<{ ok: number }, [number]>('SELECT 1 AS ok FROM schema_migrations WHERE id = ?').get(migration.id)) continue;
    db.transaction(() => {
      for (const statement of splitStatements(migration.sql)) db.run(statement);
      db.query('INSERT INTO schema_migrations (id, name, applied_ts) VALUES (?, ?, 1)')
        .run(migration.id, migration.name);
    })();
  }
}

describe('design workbench migration', () => {
  test('061：design 具有 UUIDv7 同步身份', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, created_ts, updated_ts)
      VALUES (1, '同步设计', '同步', 'codex', 1, 1)`);
    expect(db.query<{ sync_uid: string }, []>('SELECT sync_uid FROM design_tasks').get()!.sync_uid)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    db.close();
  });

  test('upgrades a database that already recorded base 050 through additive design migrations with valid foreign keys', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const base = loadMigrations(DESIGN_MIGRATIONS_DIR).find((migration) => migration.id === 50)!;
    applyRecordedDesign050(db, base.sql, base.name);
    seedProject(db);
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Legacy graph', 'Upgrade issue granularity', 'codex', 'issue', 1, 1)`,
    );

    expect(tableColumns(db, 'conversations')).not.toContain('design_creation_saga_token');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_creation_sagas'",
    ).get()).toBeNull();

    const status = migrateDesigns(db);
    expect(status.applied).toEqual(expect.arrayContaining([50, 51, 52, 53, 54, 55, 56, 57, 58]));
    expect(tableColumns(db, 'conversations')).not.toContain('design_creation_saga_token');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_creation_sagas'",
    ).get()?.name).toBe('design_creation_sagas');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_execution_runs'",
    ).get()?.name).toBe('design_execution_runs');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_issue_sync_jobs'",
    ).get()?.name).toBe('design_issue_sync_jobs');
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_saga_conversation_owners'",
    ).get()?.name).toBe('design_saga_conversation_owners');
    expect(db.query<{ granularity: string }, []>(
      'SELECT graph_granularity AS granularity FROM design_tasks WHERE id = 1',
    ).get()).toEqual({ granularity: 'balanced' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('upgrades every exact-050 legacy granularity and normalizes the recorded legacy default on new raw writes', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const base = loadMigrations(DESIGN_MIGRATIONS_DIR).find((migration) => migration.id === 50)!;
    applyRecordedDesign050(db, base.sql, base.name);
    seedProject(db);
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, created_ts, updated_ts)
       VALUES (1, 'Legacy default', 'Omitted granularity', 'codex', 1, 1)`,
    );
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Legacy free form', 'Unknown historical value', 'codex', 'free-form', 2, 2),
              (1, 'Already stable', 'Preserve five-level value', 'codex', 'atomic', 3, 3)`,
    );

    expect(() => migrateDesigns(db)).not.toThrow();
    expect(db.query<{ graph_granularity: string }, []>(
      'SELECT graph_granularity FROM design_tasks ORDER BY id',
    ).all()).toEqual([
      { graph_granularity: 'balanced' },
      { graph_granularity: 'balanced' },
      { graph_granularity: 'atomic' },
    ]);

    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, created_ts, updated_ts)
       VALUES (1, 'Post migration default', 'Must normalize to balanced', 'codex', 4, 4)`,
    );
    db.run("UPDATE design_tasks SET graph_granularity = 'issue' WHERE id = 3");
    expect(db.query<{ graph_granularity: string }, []>(
      'SELECT graph_granularity FROM design_tasks WHERE id IN (3, 4) ORDER BY id',
    ).all()).toEqual([
      { graph_granularity: 'balanced' },
      { graph_granularity: 'balanced' },
    ]);
    expect(() => db.run(
      "UPDATE design_tasks SET graph_granularity = 'free-form' WHERE id = 4",
    )).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('upgrades the legacy saga-bearing migration 050 without duplicate columns or data rewrites', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    applyRecordedDesign050(
      db,
      LEGACY_SAGA_050_SQL,
      '050_design_workbench.sql',
    );
    seedProject(db);
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'e98 dirty legacy', 'Unknown granularity', 'codex', 'custom-e98', 1, 1)`,
    );
    db.query(
      `INSERT INTO design_creation_sagas
         (saga_token, project_id, idempotency_key, request_json, conversation_id, phase,
          conversation_owned, created_ts, updated_ts)
       VALUES ('e98-saga', 1, 'e98-request', '{}', 'e98-conv', 'intent', 0, 1, 1)`,
    ).run();
    db.query(
      `INSERT INTO conversations
         (id, project_id, label, created_ts, agent, kind, design_creation_saga_token)
       VALUES ('e98-conv', 1, 'Intermediate', 1, 'codex', 'chat', 'e98-saga')`,
    ).run();
    db.query(
      `INSERT INTO conversations
         (id, project_id, label, created_ts, agent, kind, design_creation_saga_token)
       VALUES ('untrusted-conv', 1, 'Untrusted', 2, 'codex', 'chat', 'unknown-saga')`,
    ).run();

    const status = migrateDesigns(db);
    migrateDesigns(db);

    expect(status.applied).toEqual(expect.arrayContaining([50, 51]));
    expect(tableColumns(db, 'conversations')).toContain('design_creation_saga_token');
    expect(db.query<{ token: string | null }, []>(
      "SELECT design_creation_saga_token AS token FROM conversations WHERE id = 'e98-conv'",
    ).get()).toEqual({ token: 'e98-saga' });
    expect(db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM design_saga_conversation_owners',
    ).get()?.n).toBe(1);
    expect(db.query<{ conversationId: string; sagaToken: string }, []>(
      `SELECT conversation_id AS conversationId, saga_token AS sagaToken
       FROM design_saga_conversation_owners`,
    ).get()).toEqual({ conversationId: 'e98-conv', sagaToken: 'e98-saga' });
    expect(new DesignStore(db).listIncompleteCreationSagas().map((saga) => saga.sagaToken))
      .toEqual(['e98-saga']);
    expect(db.query<{ graph_granularity: string }, []>(
      'SELECT graph_granularity FROM design_tasks WHERE id = 1',
    ).get()).toEqual({ graph_granularity: 'balanced' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('creates the design domain tables, linkage columns, and indexes on a fresh database', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const status = migrateDesigns(db);

    for (const table of [
      'design_tasks',
      'design_revisions',
      'design_events',
      'design_graph_nodes',
      'design_graph_edges',
      'design_persona_sources',
      'design_personas',
      'design_project_personas',
      'design_assets',
      'design_creation_sagas',
      'design_saga_conversation_owners',
      'design_agent_operations',
      'design_run_intents',
      'design_persona_market_snapshots',
      'design_publish_confirmations',
      'design_publications',
      'design_issue_links',
      'design_publication_outbox',
      'design_execution_runs',
      'design_run_conversations',
    ]) {
      expect(
        db.query<{ name: string }, [string]>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)?.name,
      ).toBe(table);
    }
    expect(status.applied).toEqual(expect.arrayContaining([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 73]));

    expect(tableColumns(db, 'issues')).toEqual(
      expect.arrayContaining(['design_task_id', 'design_node_id', 'design_revision']),
    );
    expect(tableColumns(db, 'conversations')).toContain('workspace_cwd');
    expect(tableColumns(db, 'conversations')).not.toContain('design_creation_saga_token');
    expect(tableColumns(db, 'design_persona_sources')).toEqual(expect.arrayContaining([
      'source_kind',
      'git_commit',
      'manifest_json',
    ]));
    expect(tableColumns(db, 'design_project_personas')).toEqual(expect.arrayContaining([
      'approved_by_user_id',
      'approved_ts',
    ]));
    expect(tableColumns(db, 'design_run_intents')).toEqual(expect.arrayContaining([
      'project_id',
      'persona_content_hash',
      'persona_git_commit',
      'resolved_agent',
      'state',
    ]));
    expect(tableColumns(db, 'design_assets')).toEqual(expect.arrayContaining([
      'kind',
      'preset',
      'size',
      'request_key',
      'request_digest',
      'asset_version',
      'byte_size',
      'output_sha256',
      'implementation_ready',
      'functional_details_json',
      'retry_of_asset_id',
      'provider_request_id',
      'runnable',
      'staging_manifest_json',
      'expected_output_sha256',
    ]));
    expect(indexNames(db)).toEqual(expect.arrayContaining([
      'idx_design_assets_request_key',
      'idx_design_assets_queue',
      'idx_design_assets_retry',
    ]));
    expect(tableColumns(db, 'design_publish_confirmations')).toEqual(expect.arrayContaining([
      'token_hash',
      'design_task_id',
      'revision',
      'graph_digest',
      'actor_key',
      'expires_ts',
      'consumed_publication_id',
      'consumed_ts',
    ]));
    expect(tableColumns(db, 'design_publish_confirmations')).not.toContain('token');
    expect(tableColumns(db, 'design_publications')).toEqual(expect.arrayContaining([
      'design_task_id',
      'project_id',
      'revision',
      'graph_digest',
      'actor_key',
      'idempotency_key',
      'status',
      'error',
    ]));
    expect(tableColumns(db, 'design_issue_links')).toEqual(expect.arrayContaining([
      'publication_id',
      'design_task_id',
      'project_id',
      'node_id',
      'issue_id',
      'link_kind',
      'source_revision',
      'last_synced_revision',
      'original_impl_mode',
      'baseline_contract_json',
      'baseline_contract_digest',
      'sync_state',
      'parent_issue_id',
      'parent_issue_project_id',
      'parent_link_id',
      'parent_design_task_id',
    ]));
    expect(tableColumns(db, 'design_publication_outbox')).toEqual(expect.arrayContaining([
      'publication_id',
      'kind',
      'target_key',
      'payload_json',
      'attempt_count',
      'next_retry_ts',
      'completed_ts',
    ]));
    expect(tableColumns(db, 'design_execution_runs')).toEqual(expect.arrayContaining([
      'id',
      'project_id',
      'design_task_id',
      'publication_id',
      'approved_revision',
      'graph_digest',
      'execution_mode',
      'lifecycle_state',
      'assignment_active',
      'base_ref',
      'base_sha',
      'worktree_branch',
      'worktree_cwd',
      'observed_head_sha',
      'observed_upstream',
      'observed_ahead',
      'observed_behind',
      'error_code',
      'error_detail',
      'created_ts',
      'updated_ts',
      'archived_ts',
      'cleaned_ts',
    ]));
    expect(tableColumns(db, 'design_agent_run_groups')).toEqual(expect.arrayContaining([
      'id',
      'design_task_id',
      'project_id',
      'idempotency_key',
      'request_digest',
      'mode',
      'source_revision',
      'message',
      'persona_keys_json',
      'status',
      'cancel_requested',
      'failure_code',
      'created_by_user_id',
      'created_ts',
      'started_ts',
      'finished_ts',
      'updated_ts',
    ]));
    expect(db.query<{ name: string; notnull: number }, []>(
      "PRAGMA table_info('design_execution_runs')",
    ).all().find((column) => column.name === 'publication_id')?.notnull).toBe(0);
    expect(tableColumns(db, 'design_run_conversations')).toEqual(expect.arrayContaining([
      'run_id', 'project_id', 'module_id', 'module_key', 'conversation_id',
      'seed_revision', 'seed_digest', 'context_path', 'handoff_summary',
      'created_ts', 'updated_ts',
    ]));
    const runConversationFks = db.query<{ id: number; from: string; to: string; table: string }, []>(
      "PRAGMA foreign_key_list('design_run_conversations')",
    ).all();
    const scopedFkGroups = new Map<number, string[]>();
    for (const row of runConversationFks) {
      scopedFkGroups.set(row.id, [...(scopedFkGroups.get(row.id) ?? []), `${row.table}:${row.from}:${row.to}`]);
    }
    expect([...scopedFkGroups.values()]).toEqual(expect.arrayContaining([
      expect.arrayContaining(['design_execution_runs:run_id:id', 'design_execution_runs:project_id:project_id']),
      expect.arrayContaining(['project_modules:module_id:id', 'project_modules:project_id:project_id']),
      expect.arrayContaining(['conversations:conversation_id:id', 'conversations:project_id:project_id']),
    ]));
    expect(new Set(db.query<{ table: string }, []>(
      "PRAGMA foreign_key_list('design_execution_runs')",
    ).all().map((foreignKey) => foreignKey.table))).toEqual(new Set([
      'design_revisions',
      'design_tasks',
      'design_publications',
    ]));
    const publicationFk = db.query<{ id: number; from: string; to: string }, []>(
      "PRAGMA foreign_key_list('design_execution_runs')",
    ).all().filter((row) => row.to === 'id' || [
      'design_task_id', 'project_id', 'revision', 'graph_digest',
    ].includes(row.to));
    const grouped = new Map<number, string[]>();
    for (const row of publicationFk) grouped.set(row.id, [...(grouped.get(row.id) ?? []), `${row.from}:${row.to}`]);
    expect([...grouped.values()]).toContainEqual(expect.arrayContaining([
      'publication_id:id',
      'design_task_id:design_task_id',
      'project_id:project_id',
      'approved_revision:revision',
      'graph_digest:graph_digest',
    ]));
    expect(tableColumns(db, 'design_creation_sagas')).toEqual(expect.arrayContaining([
      'saga_token',
      'project_id',
      'idempotency_key',
      'request_json',
      'conversation_id',
      'task_id',
      'phase',
      'conversation_owned',
      'error',
      'created_ts',
      'updated_ts',
    ]));
    expect(indexNames(db)).toEqual(
      expect.arrayContaining([
        'idx_design_tasks_project',
        'idx_design_revisions_task_revision',
        'idx_design_events_task_id',
        'idx_design_graph_nodes_task_order',
        'idx_design_graph_edges_task_id',
        'idx_issues_design_task',
        'idx_issues_design_node',
        'idx_design_creation_sagas_incomplete',
        'idx_design_saga_conversation_owners_saga',
        'idx_design_publications_task_revision',
        'idx_design_issue_links_task_node',
        'idx_design_issue_links_primary_node',
        'idx_design_issue_links_sync',
        'idx_design_publication_outbox_pending',
        'idx_design_execution_runs_recovery',
        'idx_design_execution_runs_one_live_worktree',
        'idx_design_publications_execution_identity',
        'idx_design_run_conversations_project',
        'idx_design_execution_runs_id_project',
        'idx_project_modules_id_project',
        'idx_conversations_id_project',
      ]),
    );
    db.close();
  });

  test('raw SQL cannot bind run conversations across run, module, or conversation project scope', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); migrateDesigns(db); seedProject(db);
    db.run(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
      VALUES ('other', 1, '/workspace/other', 1, 1)`);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, graph_granularity, created_ts, updated_ts)
      VALUES (1, 'p1', 'p1', 'codex', 1, 'balanced', 1, 1),
             (2, 'p2', 'p2', 'codex', 1, 'balanced', 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1),
             (2, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1)`);
    db.run(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
       execution_mode, lifecycle_state, created_ts, updated_ts)
      VALUES ('run-p1', 1, 1, 1, '${'a'.repeat(64)}', 'run-p1', 'current', 'ready', 1, 1),
             ('run-p2', 2, 2, 1, '${'b'.repeat(64)}', 'run-p2', 'current', 'ready', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('conv-p1', 1, 'p1', 1, 'codex', 'chat'), ('conv-p2', 2, 'p2', 1, 'codex', 'chat')`);
    db.run(`INSERT INTO project_modules
      (project_id, slug, display_name, agent, source, created_ts)
      VALUES (1, 'p1', 'p1', 'codex', 'manual', 1), (2, 'p2', 'p2', 'codex', 'manual', 1)`);

    const bind = (runId: string, projectId: number, moduleId: number | null, moduleKey: string, conversationId: string) => db.query(
      `INSERT INTO design_run_conversations
        (run_id, project_id, module_id, module_key, conversation_id, seed_revision,
         seed_digest, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1)`,
    ).run(runId, projectId, moduleId, moduleKey, conversationId, 'a'.repeat(64));

    expect(() => bind('run-p1', 2, 2, 'module:2', 'conv-p2')).toThrow();
    expect(() => bind('run-p1', 1, 2, 'module:2', 'conv-p1')).toThrow();
    expect(() => bind('run-p1', 1, null, 'unassigned:codex', 'conv-p2')).toThrow();
    expect(() => bind('run-p1', 1, 1, 'module:2', 'conv-p1')).toThrow();
    expect(() => bind('run-p1', 1, 1, 'module:01', 'conv-p1')).toThrow();
    expect(() => bind('run-p1', 1, 1, 'unassigned:codex', 'conv-p1')).toThrow();
    expect(() => bind('run-p1', 1, null, 'unassigned:gemini', 'conv-p1')).toThrow();
    expect(() => bind('run-p1', 1, 1, 'module:1', 'conv-p1')).not.toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('073 upgrades a legal 059 run conversation without rewriting its identity', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); applyDesignMigrationsThrough(db, 59); seedProject(db);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, graph_granularity, created_ts, updated_ts)
      VALUES (1, 'legal', 'legal', 'codex', 1, 'balanced', 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1)`);
    db.run(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
       execution_mode, lifecycle_state, created_ts, updated_ts)
      VALUES ('legal-run', 1, 1, 1, '${'a'.repeat(64)}', 'legal-run', 'current', 'ready', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('legal-conv', 1, 'legal', 1, 'codex', 'chat')`);
    db.run(`INSERT INTO design_run_conversations
      (run_id, project_id, module_key, conversation_id, seed_revision, seed_digest, created_ts, updated_ts)
      VALUES ('legal-run', 1, 'unassigned:codex', 'legal-conv', 1, '${'a'.repeat(64)}', 1, 1)`);

    expect(migrateDesigns(db).applied).toContain(73);
    expect(db.query('SELECT * FROM design_run_conversations').all()).toHaveLength(1);
    expect(db.query<{ runId: string; projectId: number; conversationId: string }, []>(
      `SELECT run_id AS runId, project_id AS projectId, conversation_id AS conversationId
       FROM design_run_conversations`,
    ).get()).toEqual({ runId: 'legal-run', projectId: 1, conversationId: 'legal-conv' });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('upgrades a 059 database whose legacy notify migration already owns id 60', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); applyDesignMigrationsThrough(db, 59);
    db.run(
      `INSERT INTO schema_migrations (id, name, applied_ts)
       VALUES (60, '060_notify_gate_requests.sql', 1)`,
    );

    const status = migrateDesigns(db);

    expect(status.applied).toContain(73);
    const foreignKeys = db.query<{ id: number; from: string; to: string; table: string }, []>(
      "PRAGMA foreign_key_list('design_run_conversations')",
    ).all();
    const scopedGroups = new Map<number, string[]>();
    for (const row of foreignKeys) {
      scopedGroups.set(row.id, [...(scopedGroups.get(row.id) ?? []), `${row.table}:${row.from}:${row.to}`]);
    }
    expect([...scopedGroups.values()]).toEqual(expect.arrayContaining([
      expect.arrayContaining(['design_execution_runs:run_id:id', 'design_execution_runs:project_id:project_id']),
      expect.arrayContaining(['project_modules:module_id:id', 'project_modules:project_id:project_id']),
      expect.arrayContaining(['conversations:conversation_id:id', 'conversations:project_id:project_id']),
    ]));
    db.close();
  });

  test('073 safely replays when the historical design migration already owns id 60', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); migrateDesigns(db); seedProject(db);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, graph_granularity, created_ts, updated_ts)
      VALUES (1, 'replay', 'replay', 'codex', 1, 'balanced', 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1)`);
    db.run(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
       execution_mode, lifecycle_state, created_ts, updated_ts)
      VALUES ('replay-run', 1, 1, 1, '${'a'.repeat(64)}', 'replay-run', 'current', 'ready', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('replay-conv', 1, 'replay', 1, 'codex', 'chat')`);
    db.run(`INSERT INTO design_run_conversations
      (run_id, project_id, module_key, conversation_id, seed_revision, seed_digest, created_ts, updated_ts)
      VALUES ('replay-run', 1, 'unassigned:codex', 'replay-conv', 1, '${'a'.repeat(64)}', 1, 1)`);
    db.run("UPDATE schema_migrations SET id = 60, name = '060_design_run_conversation_scope.sql' WHERE id = 73");

    expect(migrateDesigns(db).applied).toContain(73);
    expect(db.query<{ runId: string }, []>(
      'SELECT run_id AS runId FROM design_run_conversations',
    ).all()).toEqual([{ runId: 'replay-run' }]);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('073 fails transactionally when 059 contains an ambiguous cross-project historical row', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); applyDesignMigrationsThrough(db, 59); seedProject(db);
    db.run(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
      VALUES ('other', 1, '/workspace/other', 1, 1)`);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, graph_granularity, created_ts, updated_ts)
      VALUES (1, 'legacy', 'legacy', 'codex', 1, 'balanced', 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1)`);
    db.run(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
       execution_mode, lifecycle_state, created_ts, updated_ts)
      VALUES ('legacy-run', 1, 1, 1, '${'a'.repeat(64)}', 'legacy-run', 'current', 'ready', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('foreign-conv', 2, 'foreign', 1, 'codex', 'chat')`);
    db.run(`INSERT INTO design_run_conversations
      (run_id, project_id, module_key, conversation_id, seed_revision, seed_digest, created_ts, updated_ts)
      VALUES ('legacy-run', 2, 'unassigned:codex', 'foreign-conv', 1, '${'a'.repeat(64)}', 1, 1)`);

    expect(() => migrateDesigns(db)).toThrow();
    expect(db.query<{ ok: number }, []>('SELECT 1 AS ok FROM schema_migrations WHERE id = 73').get()).toBeNull();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_run_conversations').get()?.n).toBe(1);
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_run_conversations_scope_legacy'",
    ).get()).toBeNull();
    db.close();
  });

  test('073 fails transactionally when 059 module id and module key describe different identities', () => {
    const db = openDb(':memory:');
    migrate(db); migrateIssueEngine(db); applyDesignMigrationsThrough(db, 59); seedProject(db);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, graph_granularity, created_ts, updated_ts)
      VALUES (1, 'legacy', 'legacy', 'codex', 1, 'balanced', 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '', 0, '{"nodes":[],"edges":[]}', 'test', 1)`);
    db.run(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
       execution_mode, lifecycle_state, created_ts, updated_ts)
      VALUES ('legacy-run', 1, 1, 1, '${'a'.repeat(64)}', 'legacy-run', 'current', 'ready', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('legacy-conv', 1, 'legacy', 1, 'codex', 'chat')`);
    db.run(`INSERT INTO project_modules
      (project_id, slug, display_name, agent, source, created_ts)
      VALUES (1, 'legacy', 'legacy', 'codex', 'manual', 1)`);
    db.run(`INSERT INTO design_run_conversations
      (run_id, project_id, module_id, module_key, conversation_id, seed_revision,
       seed_digest, created_ts, updated_ts)
      VALUES ('legacy-run', 1, 1, 'module:2', 'legacy-conv', 1, '${'a'.repeat(64)}', 1, 1)`);

    expect(() => migrateDesigns(db)).toThrow();
    expect(db.query<{ ok: number }, []>('SELECT 1 AS ok FROM schema_migrations WHERE id = 73').get()).toBeNull();
    expect(db.query<{ moduleId: number; moduleKey: string }, []>(
      'SELECT module_id AS moduleId, module_key AS moduleKey FROM design_run_conversations',
    ).get()).toEqual({ moduleId: 1, moduleKey: 'module:2' });
    expect(db.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'design_run_conversations_scope_legacy'",
    ).get()).toBeNull();
    db.close();
  });

  test('is idempotent and keeps module association optional', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const first = migrateDesigns(db);
    const second = migrateDesigns(db);
    seedProject(db);

    expect(second).toEqual(first);
    expect(() =>
      db.query(
        `INSERT INTO design_tasks
           (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
         VALUES (1, 'Unassigned', 'Create an unassigned design', 'codex', 'balanced', 1, 1)`,
      ).run(),
    ).not.toThrow();
    expect(() => db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, created_ts, updated_ts)
       VALUES (1, 'Defaulted', 'Omit granularity after fresh migration', 'codex', 2, 2)`,
    )).not.toThrow();
    expect(
      db.query<{ module_id: number | null; stage: string; status: string; graph_granularity: string }, []>(
        'SELECT module_id, stage, status, graph_granularity FROM design_tasks WHERE id = 1',
      ).get(),
    ).toEqual({
      module_id: null,
      stage: 'goal_setting',
      status: 'active',
      graph_granularity: 'balanced',
    });
    expect(db.query<{ graph_granularity: string }, []>(
      'SELECT graph_granularity FROM design_tasks WHERE id = 2',
    ).get()).toEqual({ graph_granularity: 'balanced' });
    expect(() => db.run(
      `UPDATE design_tasks SET graph_granularity = 'free-form' WHERE id = 1`,
    )).toThrow();
    expect(() => db.run(
      `UPDATE design_tasks SET graph_granularity = 'issue' WHERE id = 1`,
    )).not.toThrow();
    expect(db.query<{ graph_granularity: string }, []>(
      'SELECT graph_granularity FROM design_tasks WHERE id = 1',
    ).get()).toEqual({ graph_granularity: 'balanced' });
    expect(() => db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, stage, status, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Bad stage', 'Invalid', 'codex', 'draft', 'active', 'balanced', 1, 1)`,
    )).toThrow();
    expect(() => db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, stage, status, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Bad status', 'Invalid', 'codex', 'goal_setting', 'paused', 'balanced', 1, 1)`,
    )).toThrow();
    expect(() => db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, stage, status, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Creating', 'Hidden bootstrap', 'codex', 'goal_setting', 'creating', 'balanced', 1, 1)`,
    )).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('binds one durable creation saga to each project idempotency key', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);

    db.query(
      `INSERT INTO design_creation_sagas
         (saga_token, project_id, idempotency_key, request_json, conversation_id, phase,
          conversation_owned, created_ts, updated_ts)
       VALUES ('saga-a', 1, 'request-a', '{}', 'conv-a', 'intent', 0, 1, 1)`,
    ).run();
    expect(() => db.query(
      `INSERT INTO design_creation_sagas
         (saga_token, project_id, idempotency_key, request_json, conversation_id, phase,
          conversation_owned, created_ts, updated_ts)
       VALUES ('saga-b', 1, 'request-a', '{}', 'conv-b', 'intent', 0, 2, 2)`,
    ).run()).toThrow();
    expect(db.query<{ task_id: number | null; error: string | null }, []>(
      "SELECT task_id, error FROM design_creation_sagas WHERE saga_token = 'saga-a'",
    ).get()).toEqual({ task_id: null, error: null });
    db.close();
  });

  test('makes graph node IDs unique within a design task', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);
    db.query(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, stage, status, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Graph', 'Model a graph', 'claude', 'goal_setting', 'active', 'balanced', 1, 1)`,
    ).run();
    db.query(
      `INSERT INTO design_graph_nodes (design_task_id, node_id, ordinal, title, created_ts, updated_ts)
       VALUES (1, 'node-a', 1, 'First node', 1, 1)`,
    ).run();

    expect(() =>
      db.query(
        `INSERT INTO design_graph_nodes (design_task_id, node_id, ordinal, title, created_ts, updated_ts)
         VALUES (1, 'node-a', 2, 'Duplicate node', 1, 1)`,
      ).run(),
    ).toThrow();
    db.close();
  });

  test('restricts deletion of an immutable revision while an asset still references it', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, stage, status, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Asset design', 'Keep revision history', 'codex', 'goal_setting', 'active', 'balanced', 1, 1)`,
    );
    db.run(
      `INSERT INTO design_revisions
         (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
       VALUES (1, 1, '{}', '# Revision', 80, '{"nodes":[],"edges":[]}', 'codex', 1)`,
    );
    db.run(
      `INSERT INTO design_assets
         (design_task_id, design_revision, prompt, status, created_ts, updated_ts)
       VALUES (1, 1, 'Illustrate the plan', 'ready', 1, 1)`,
    );

    const revisionFk = db
      .query<{ table: string; on_delete: string }, []>('PRAGMA foreign_key_list(design_assets)')
      .all()
      .find((foreignKey) => foreignKey.table === 'design_revisions');
    expect(revisionFk?.on_delete).toBe('RESTRICT');
    expect(() => db.run('DELETE FROM design_revisions WHERE design_task_id = 1 AND revision = 1')).toThrow();
    expect(
      db.query<{ design_task_id: number; design_revision: number }, []>(
        'SELECT design_task_id, design_revision FROM design_assets WHERE id = 1',
      ).get(),
    ).toEqual({ design_task_id: 1, design_revision: 1 });
    db.close();
  });

  test('upgrades legacy assets and enforces request idempotency plus retry lineage', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    const migrations = loadMigrations(DESIGN_MIGRATIONS_DIR);
    for (const migration of migrations.filter((item) => item.id <= 57)) {
      const apply = db.transaction(() => {
        for (const statement of splitStatements(migration.sql)) db.run(statement);
        db.query('INSERT INTO schema_migrations (id, name, applied_ts) VALUES (?, ?, 1)')
          .run(migration.id, migration.name);
      });
      apply();
    }
    seedProject(db);
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, current_revision, created_ts, updated_ts)
      VALUES (1, 'Visuals', 'Create references', 'codex', 1, 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{}', '# Visuals', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
    db.run(`INSERT INTO design_assets
      (design_task_id, design_revision, prompt, status, created_ts, updated_ts)
      VALUES (1, 1, 'legacy', 'ready', 1, 1)`);

    expect(migrateDesigns(db).applied).toContain(58);
    expect(db.query<{ kind: string; version: number; ready: number }, []>(
      `SELECT kind, asset_version AS version, implementation_ready AS ready
       FROM design_assets WHERE id = 1`,
    ).get()).toEqual({ kind: 'raster_reference', version: 0, ready: 0 });
    db.query(`INSERT INTO design_assets
      (design_task_id, design_revision, prompt, provider, status, kind, preset, size,
       request_key, request_digest, created_ts, updated_ts)
      VALUES (1, 1, 'one', 'openai', 'queued', 'raster_reference', 'full_page_mockup',
              '1024x1024', 'same-key', ?, 2, 2)`).run('a'.repeat(64));
    expect(() => db.query(`INSERT INTO design_assets
      (design_task_id, design_revision, prompt, provider, status, kind, preset, size,
       request_key, request_digest, created_ts, updated_ts)
      VALUES (1, 1, 'two', 'openai', 'queued', 'raster_reference', 'visual_direction',
              '1024x1024', 'same-key', ?, 3, 3)`).run('b'.repeat(64))).toThrow();
    db.query(`INSERT INTO design_assets
      (design_task_id, design_revision, prompt, provider, status, kind, preset, size,
       request_key, request_digest, retry_of_asset_id, created_ts, updated_ts)
      VALUES (1, 1, 'retry', 'openai', 'queued', 'raster_reference', 'full_page_mockup',
              '1024x1024', 'retry-key', ?, 2, 4, 4)`).run('c'.repeat(64));
    expect(() => db.run('DELETE FROM design_assets WHERE id = 2')).toThrow();
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  test('adds issue linkage without changing existing lifecycle and execution constraints', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);

    expect(() =>
      db.query(
        `INSERT INTO issues (project_id, title, category, status, impl_mode, created_ts)
         VALUES (1, 'Invalid lifecycle', 'task', 'designing', 'direct', 1)`,
      ).run(),
    ).toThrow();
    expect(() =>
      db.query(
        `INSERT INTO issues (project_id, title, category, status, impl_mode, created_ts)
         VALUES (1, 'Invalid execution', 'task', 'pending', 'parallel', 1)`,
      ).run(),
    ).toThrow();
    db.close();
  });

  test('enforces the publication, confirmation, link, and outbox contract', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    migrateDesigns(db);
    seedProject(db);
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Publish graph', 'Create linked issues', 'codex', 'atomic', 1, 1)`,
    );
    db.run(
      `INSERT INTO design_revisions
         (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
       VALUES (1, 1, '{}', '# Revision', 100, '{"nodes":[],"edges":[]}', 'owner', 1)`,
    );
    db.run(
      `INSERT INTO issues (project_id, title, category, status, impl_mode, created_ts)
       VALUES (1, 'Published node', 'task', 'pending', 'team', 1)`,
    );

    const tokenHash = 'a'.repeat(64);
    const graphDigest = 'b'.repeat(64);
    const contractDigest = 'c'.repeat(64);
    db.query(
      `INSERT INTO design_publish_confirmations
         (token_hash, design_task_id, revision, graph_digest, actor_key, expires_ts, created_ts)
       VALUES (?, 1, 1, ?, 'owner:1', 9999, 1)`,
    ).run(tokenHash, graphDigest);
    db.query(
      `INSERT INTO design_publications
         (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
          status, created_ts, updated_ts)
       VALUES (1, 1, 1, ?, 'owner:1', 'publish-1', 'committed', 1, 1)`,
    ).run(graphDigest);
    db.query(
      `UPDATE design_publish_confirmations
       SET consumed_publication_id = 1, consumed_ts = 2
       WHERE token_hash = ?`,
    ).run(tokenHash);
    db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (1, 1, 1, 'node-a', 1, 1, 1, 'team', '{}', ?, 'current', 1, 1)`,
    ).run(contractDigest);
    db.run(
      `INSERT INTO design_publication_outbox
         (publication_id, kind, target_key, payload_json, attempt_count, next_retry_ts,
          created_ts, updated_ts)
       VALUES (1, 'module_index', 'module:1', '{}', 0, 1, 1, 1)`,
    );

    expect(() => db.query(
      `INSERT INTO design_publications
         (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
          status, created_ts, updated_ts)
       VALUES (1, 1, 1, ?, 'owner:1', 'publish-1', 'committed', 2, 2)`,
    ).run('d'.repeat(64))).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (1, 1, 1, 'node-b', 1, 1, 1, 'direct', '{}', ?, 'current', 1, 1)`,
    ).run(contractDigest)).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (1, 1, 1, 'node-b', 999, 1, 1, 'parallel', '{}', ?, 'current', 1, 1)`,
    ).run(contractDigest)).toThrow();
    expect(() => db.run(
      `INSERT INTO design_publication_outbox
         (publication_id, kind, target_key, payload_json, attempt_count, next_retry_ts,
          created_ts, updated_ts)
       VALUES (1, 'module_index', 'module:1', '{}', 0, 1, 1, 1)`,
    )).toThrow();

    db.run(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('other-project', 1, '/workspace/other', 1, 2)`,
    );
    db.run(
      `INSERT INTO design_tasks
         (project_id, title, original_request, agent, graph_granularity, created_ts, updated_ts)
       VALUES (1, 'Second design', 'Prove design scoping', 'codex', 'small', 2, 2)`,
    );
    db.run(
      `INSERT INTO design_revisions
         (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
       VALUES (2, 1, '{}', '# Second', 100, '{"nodes":[],"edges":[]}', 'owner', 2)`,
    );
    db.run(
      `INSERT INTO design_revisions
         (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
       VALUES (2, 2, '{}', '# Second revision', 100, '{"nodes":[],"edges":[]}', 'owner', 3)`,
    );
    db.run(
      `INSERT INTO issues (project_id, title, category, status, impl_mode, created_ts)
       VALUES (1, 'Second link', 'task', 'pending', 'seq', 2),
              (1, 'Supplement', 'task', 'pending', 'seq', 3),
              (2, 'Foreign parent', 'task', 'pending', 'seq', 4)`,
    );
    db.query(
      `INSERT INTO design_publications
         (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
          status, created_ts, updated_ts)
       VALUES (2, 1, 1, ?, 'owner:1', 'publish-2', 'committed', 2, 2)`,
    ).run('d'.repeat(64));
    db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (2, 2, 1, 'node-second', 2, 1, 1, 'direct', '{}', ?, 'current', 2, 2)`,
    ).run('e'.repeat(64));
    db.query(
      `INSERT INTO design_publish_confirmations
         (token_hash, design_task_id, revision, graph_digest, actor_key, expires_ts, created_ts)
       VALUES (?, 1, 1, ?, 'owner:1', 9999, 2)`,
    ).run('f'.repeat(64), graphDigest);

    expect(() => db.query(
      `UPDATE design_publish_confirmations
       SET consumed_publication_id = 2, consumed_ts = 3
       WHERE token_hash = ?`,
    ).run('f'.repeat(64))).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, parent_link_id, parent_design_task_id,
          created_ts, updated_ts)
       VALUES (1, 1, 1, 'cross-design-parent', 3, 1, 1, 'direct', '{}', ?, 'current',
               2, 2, 3, 3)`,
    ).run('1'.repeat(64))).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, parent_issue_id, parent_issue_project_id,
          created_ts, updated_ts)
       VALUES (1, 1, 1, 'cross-project-parent', 3, 1, 1, 'direct', '{}', ?, 'current',
               4, 2, 3, 3)`,
    ).run('2'.repeat(64))).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (1, 1, 1, 'cross-design-revision', 3, 1, 2, 'direct', '{}', ?, 'current', 3, 3)`,
    ).run('4'.repeat(64))).toThrow();
    expect(() => db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, source_revision,
          last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, created_ts, updated_ts)
       VALUES (1, 1, 1, 'missing-revision', 3, 1, 999, 'direct', '{}', ?, 'current', 3, 3)`,
    ).run('5'.repeat(64))).toThrow();
    db.query(
      `INSERT INTO design_issue_links
         (publication_id, design_task_id, project_id, node_id, issue_id, link_kind,
          source_revision, last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, parent_issue_id, parent_issue_project_id,
          parent_link_id, parent_design_task_id, created_ts, updated_ts)
       VALUES (1, 1, 1, 'node-a', 3, 'supplement', 1, 1, 'direct', '{}', ?, 'current',
               1, 1, 1, 1, 3, 3)`,
    ).run('3'.repeat(64));
    expect(db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM design_issue_links WHERE publication_id = 1 AND node_id = 'node-a'",
    ).get()?.n).toBe(2);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db';
import {
  ALL_MIGRATION_DIRS,
  assertLedgerMatchesFiles,
  assertNoMigrationCollisions,
  assertUniqueMigrationIds,
  migrate,
  migrationStatus,
  splitStatements,
} from './migrate';

const EXPECTED_TABLES = [
  'schema_migrations',
  'users',
  'user_settings',
  'executors',
  'projects',
  'conversations',
  'issues',
  'issue_events',
  'gates',
  'subscriptions',
  'sessions',
  'auth_sessions',
  'skill_markets',
  'skill_i18n',
  'daily_greeting',
  'project_members',
  'user_message_counts',
  'project_external_issue_sources',
  'external_issue_records',
  'project_attachments',
  'project_data_sync_entries',
  'conversation_shared_messages',
  'project_data_outbox',
  'project_data_sync_status',
  'feishu_login_config',
  'feishu_messaging_config',
].sort();

/** core/migrations 当前最新编号（新增迁移文件时同步 +1） */
const LATEST_MIGRATION = 68;

function tableNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
}

describe('migrate', () => {
  const tmpDb = join(tmpdir(), `panda-migrate-test-${process.pid}-${Date.now()}.db`);

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(tmpDb + suffix, { force: true });
  });

  test('临时文件 db：迁移后全部表存在，WAL 生效', () => {
    const db = openDb(tmpDb);
    const status = migrate(db);

    expect(status.applied.length).toBeGreaterThanOrEqual(1);
    expect(status.latest).toBe(LATEST_MIGRATION);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);

    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get();
    expect(mode?.journal_mode).toBe('wal');
    db.close();
  });

  test('重复执行幂等：applied 不变、无异常、表不重复建', () => {
    const db = openDb(':memory:');
    const first = migrate(db);
    const second = migrate(db);
    const third = migrate(db);

    expect(second.applied).toEqual(first.applied);
    expect(third.applied).toEqual(first.applied);
    expect(tableNames(db)).toEqual(EXPECTED_TABLES);
    db.close();
  });

  test('migrationStatus 不执行迁移，仅报告', () => {
    const db = openDb(':memory:');
    expect(migrationStatus(db)).toEqual({ applied: [], latest: null });
    migrate(db);
    const s = migrationStatus(db);
    expect(s.latest).toBe(LATEST_MIGRATION);
    expect(s.applied).toContain(1);
    expect(s.applied).toContain(LATEST_MIGRATION);
    db.close();
  });

  test('024 迁移：项目统一转为 issue，独立对话类型保持不变', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.run("INSERT INTO users (username, token_hash, role, created_ts) VALUES ('migration-user', 'hash', 'user', 0)");
    db.run("INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir) VALUES ('local', '127.0.0.1', 22, 'runner', 'key', '/tmp', '/tmp')");
    db.run("INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts, kind) VALUES ('legacy-chat', 1, '/tmp/legacy-chat', 1, 0, 'chat')");
    db.run("INSERT INTO conversations (id, project_id, kind, created_ts) VALUES ('chat-history', 1, 'chat', 0)");
    db.run('DELETE FROM schema_migrations WHERE id = 24');

    migrate(db);

    expect(db.query<{ kind: string }, []>('SELECT kind FROM projects LIMIT 1').get()?.kind).toBe('issue');
    expect(db.query<{ kind: string }, []>("SELECT kind FROM conversations WHERE id = 'chat-history'").get()?.kind).toBe('chat');
    db.close();
  });

  test('索引已创建（抽查关键索引）', () => {
    const db = openDb(':memory:');
    migrate(db);
    const idx = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all()
      .map((r) => r.name);
    expect(idx).toContain('idx_issues_project_status');
    expect(idx).toContain('idx_issue_events_issue_ts');
    expect(idx).toContain('idx_subscriptions_target');
    db.close();
  });

  test('007 迁移：projects 认知总结/任务态列存在，summary_status 默认 idle', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .query<{ name: string; dflt_value: string | null }, []>('PRAGMA table_info(projects)')
      .all();
    const names = cols.map((c) => c.name);
    for (const c of [
      'understanding',
      'understanding_agent',
      'understanding_ts',
      'summary_status',
      'summary_error',
    ]) {
      expect(names).toContain(c);
    }
    // summary_status 有 NOT NULL DEFAULT 'idle'（PRAGMA 里带引号）
    const st = cols.find((c) => c.name === 'summary_status');
    expect(st?.dflt_value).toBe("'idle'");
    db.close();
  });

  test('008 迁移：projects.manual_review 列存在且默认 0（全自动流）', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .query<{ name: string; dflt_value: string | null }, []>('PRAGMA table_info(projects)')
      .all();
    const mr = cols.find((c) => c.name === 'manual_review');
    expect(mr).toBeTruthy();
    expect(mr?.dflt_value).toBe('0');
    db.close();
  });

  test('009 迁移：projects.kind / conversations.kind 存在且默认 issue，conversations.last_active_ts 存在', () => {
    const db = openDb(':memory:');
    migrate(db);
    const pkind = db
      .query<{ name: string; dflt_value: string | null }, []>('PRAGMA table_info(projects)')
      .all()
      .find((c) => c.name === 'kind');
    expect(pkind).toBeTruthy();
    expect(pkind?.dflt_value).toBe("'issue'");
    const conv = db
      .query<{ name: string; dflt_value: string | null }, []>('PRAGMA table_info(conversations)')
      .all();
    const ckind = conv.find((c) => c.name === 'kind');
    expect(ckind).toBeTruthy();
    expect(ckind?.dflt_value).toBe("'issue'");
    expect(conv.map((c) => c.name)).toContain('last_active_ts');
    db.close();
  });

  test('012 迁移：users.last_seen_ts 列存在（可空，无默认值）', () => {
    const db = openDb(':memory:');
    migrate(db);
    const col = db
      .query<{ name: string; notnull: number; dflt_value: string | null }, []>(
        'PRAGMA table_info(users)',
      )
      .all()
      .find((c) => c.name === 'last_seen_ts');
    expect(col).toBeTruthy();
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
    db.close();
  });

  test('015 迁移：executors 能力列与唯一系统本机索引存在', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .query<{ name: string; dflt_value: string | null }, []>('PRAGMA table_info(executors)')
      .all();
    const defaults = new Map(cols.map((c) => [c.name, c.dflt_value]));
    expect(defaults.get('is_system_local')).toBe('0');
    expect(defaults.get('supports_claude')).toBe('1');
    expect(defaults.get('supports_codex')).toBe('1');
    expect(defaults.get('codex_dir')).toBe("''");
    expect(defaults.get('capabilities_checked_ts')).toBeNull();
    const indexSql = db
      .query<{ sql: string | null }, [string]>(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      )
      .get('idx_executors_one_system_local')?.sql;
    expect(indexSql).toContain('WHERE is_system_local = 1');
    db.close();
  });

  test('016 迁移：用户语言、固定时区与最近设备时区均可空', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .query<{ name: string; notnull: number; dflt_value: string | null }, []>(
        'PRAGMA table_info(user_settings)',
      )
      .all();
    for (const name of ['locale', 'timezone', 'detected_timezone']) {
      const col = cols.find((item) => item.name === name);
      expect(col).toBeTruthy();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
    }
    db.close();
  });

  test('017 迁移：每项目单一外部来源，导入/忽略记录按来源与远端 id 去重', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.query(
      `INSERT INTO users (id, username, token_hash, role, created_ts)
       VALUES (1, 'u', 'h', 'user', 0)`,
    ).run();
    db.query(
      `INSERT INTO executors
         (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES (1, 'local', '127.0.0.1', 22, '', '', '/ws', '')`,
    ).run();
    db.query(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
       VALUES (1, 'p', 1, '/ws/p', 1, 0)`,
    ).run();

    db.query(
      `INSERT INTO project_external_issue_sources
         (project_id, provider, remote_name, remote_url, instance_url, created_ts, updated_ts)
       VALUES (1, 'github', 'origin', 'git@github.com:o/r.git', 'https://github.com', 0, 0)`,
    ).run();
    expect(() =>
      db
        .query(
          `INSERT INTO project_external_issue_sources
             (project_id, provider, remote_name, remote_url, instance_url, created_ts, updated_ts)
           VALUES (1, 'gitlab', 'upstream', 'git@gitlab.example:o/r.git', 'https://gitlab.example', 0, 0)`,
        )
        .run(),
    ).toThrow();

    db.query(
      `INSERT INTO external_issue_records
         (project_id, provider, source_key, external_id, external_number, external_url,
          disposition, created_ts, updated_ts)
       VALUES (1, 'github', 'github.com/o/r', '100', '7', 'https://github.com/o/r/issues/7',
               'ignored', 0, 0)`,
    ).run();
    expect(() =>
      db
        .query(
          `INSERT INTO external_issue_records
             (project_id, provider, source_key, external_id, external_number, external_url,
              disposition, created_ts, updated_ts)
           VALUES (1, 'github', 'github.com/o/r', '100', '7', 'https://github.com/o/r/issues/7',
                   'ignored', 0, 0)`,
        )
        .run(),
    ).toThrow();
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM external_issue_records').get()?.n,
    ).toBe(1);
    db.close();
  });

  test('019 迁移：项目、对话与附件具有 UUIDv7 同步身份', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects
      (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, 'p', 1, '/ws/p', 1, 1700000000000)`);
    db.run(`INSERT INTO conversations (id, project_id, created_ts) VALUES ('local-session', 1, 1700000000001)`);
    db.run(`INSERT INTO project_attachments
      (project_id, path, sha256, size, created_ts)
      VALUES (1, '.panda/uploads/a/image.png', ?, 3, 1700000000002)`, ['a'.repeat(64)]);
    for (const table of ['projects', 'conversations', 'project_attachments']) {
      const uid = db.query<{ sync_uid: string }, []>(`SELECT sync_uid FROM ${table} LIMIT 1`).get()!.sync_uid;
      expect(uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    db.close();
  });

  test('018 迁移：技能市场人格源 epoch 默认从 0 开始', () => {
    const db = openDb(':memory:');
    migrate(db);
    const column = db.query<{ name: string; dflt_value: string | null }, []>(
      "PRAGMA table_info('skill_markets')",
    ).all().find((candidate) => candidate.name === 'persona_source_epoch');
    expect(column?.dflt_value).toBe('0');
    expect(db.query<{ persona_source_epoch: number }, []>(
      'SELECT persona_source_epoch FROM skill_markets ORDER BY id LIMIT 1',
    ).get()?.persona_source_epoch).toBe(0);
    db.close();
  });

  test('018 迁移：从 017 升级时保留已有技能市场源', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.run('ALTER TABLE skill_markets DROP COLUMN persona_source_epoch');
    db.run('DELETE FROM schema_migrations WHERE id = 18');
    const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM skill_markets').get()!.n;

    const status = migrate(db);

    expect(status.latest).toBe(LATEST_MIGRATION);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM skill_markets').get()!.n).toBe(before);
    expect(db.query<{ persona_source_epoch: number }, []>(
      'SELECT persona_source_epoch FROM skill_markets ORDER BY id LIMIT 1',
    ).get()?.persona_source_epoch).toBe(0);
    db.close();
  });

  test('010 迁移：daily_greeting 表存在，主键 (user_id, day)，列齐全', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db
      .query<{ name: string; pk: number }, []>('PRAGMA table_info(daily_greeting)')
      .all();
    expect(cols.map((c) => c.name).sort()).toEqual(['created_ts', 'day', 'text', 'user_id']);
    // 复合主键 (user_id, day)：两列 pk 序号非 0
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(['day', 'user_id']);
    db.close();
  });

  test('splitStatements：去注释、按分号切分', () => {
    const stmts = splitStatements('-- c\nCREATE TABLE a (x INTEGER); \n\nCREATE INDEX i ON a(x); -- t\n');
    expect(stmts).toEqual(['CREATE TABLE a (x INTEGER)', 'CREATE INDEX i ON a(x)']);
  });
});

// ---------- 跨目录编号守卫（#292） ----------

describe('迁移编号守卫', () => {
  const tmpDirs: string[] = [];

  function dirWith(...files: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'panda-mig-'));
    tmpDirs.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), 'CREATE TABLE IF NOT EXISTS t (x INTEGER);');
    return dir;
  }

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('仓库现有迁移目录不存在跨目录撞号', () => {
    expect(() => assertUniqueMigrationIds()).not.toThrow();
    expect(ALL_MIGRATION_DIRS.length).toBe(5);
  });

  test('两个目录用同一编号 → 报错点名两个文件', () => {
    const a = dirWith('060_alpha.sql');
    const b = dirWith('060_beta.sql');
    expect(() => assertUniqueMigrationIds([a, b])).toThrow(/060_alpha\.sql.*060_beta\.sql/s);
  });

  test('同一目录内同编号不同名也算撞号', () => {
    const a = dirWith('060_alpha.sql', '060_beta.sql');
    expect(() => assertUniqueMigrationIds([a])).toThrow(/migration id 60/);
  });

  test('账本里编号已被别的文件名占用 → 报错（该迁移会被静默跳过）', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.run('INSERT INTO schema_migrations (id, name, applied_ts) VALUES (?, ?, ?)', [
      60,
      '060_design_run_conversation_scope.sql',
      0,
    ]);
    const notify = dirWith('060_notify_gate_requests.sql');
    expect(() => assertLedgerMatchesFiles(db, [notify])).toThrow(
      /060_design_run_conversation_scope\.sql.*060_notify_gate_requests\.sql/s,
    );
    // 换成未被占用的编号即放行
    const fixed = dirWith('063_notify_gate_requests.sql');
    expect(() => assertNoMigrationCollisions(db, [fixed])).not.toThrow();
    db.close();
  });

  test('账本编号与文件名一致时不报错', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() => assertNoMigrationCollisions(db)).not.toThrow();
    db.close();
  });
});

test('paused migration preserves issue rows, child references and installed triggers', () => {
  const db = new Database(':memory:');
  const dir = mkdtempSync(join(tmpdir(), 'panda-paused-migration-'));
  try {
    migrate(db);
    db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','hash','admin',0)");
    db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'x','x','x','x','x','x')");
    db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'x',1,'/x',1,0)");
    db.run("INSERT INTO issues(id,project_id,title,created_ts) VALUES(99,1,'preserve',0)");
    db.run("INSERT INTO issue_events(issue_id,kind,ts) VALUES(99,'keep',0)");
    db.run('ALTER TABLE issues ADD COLUMN plugin_extra TEXT');
    db.run("UPDATE issues SET plugin_extra='installed later' WHERE id=99");
    db.run("INSERT INTO issues(id,project_id,title,created_ts) VALUES(200,1,'deleted',0)");
    db.run('DELETE FROM issues WHERE id=200');
    db.run('CREATE TABLE legacy_orphan (id INTEGER REFERENCES conversations(id))');
    db.run('PRAGMA foreign_keys=OFF');
    db.run('INSERT INTO legacy_orphan VALUES(777)');
    db.run('CREATE TABLE audit (issue_id INTEGER)');
    db.run('CREATE TRIGGER keep_trigger AFTER UPDATE ON issues BEGIN INSERT INTO audit VALUES(NEW.id); END');
    db.run('CREATE INDEX keep_index ON issues(plugin_extra)');
    db.run('PRAGMA foreign_keys=ON');
    writeFileSync(join(dir,'071_paused_state.sql'), '-- panda:add-paused-issue-state\n');
    migrate(db, dir);
    db.run("UPDATE issues SET status='paused' WHERE id=99");
    expect(db.query('SELECT plugin_extra FROM issues WHERE id=99').get()).toEqual({plugin_extra:'installed later'});
    expect(db.query('SELECT kind FROM issue_events WHERE issue_id=99').get()).toEqual({kind:'keep'});
    expect(db.query('SELECT * FROM audit').all()).toEqual([{issue_id:99}]);
    expect(db.query('PRAGMA foreign_key_check').all()).toHaveLength(1);
    expect(db.query('PRAGMA foreign_keys').get()).toEqual({foreign_keys:1});
    db.run("INSERT INTO issues(project_id,title,created_ts) VALUES(1,'next',0)");
    expect(db.query<{id:number},[]>("SELECT id FROM issues WHERE title='next'").get()!.id).toBeGreaterThan(200);
    expect(db.query("SELECT name FROM sqlite_master WHERE name='keep_index'").get()).toBeTruthy();
    migrate(db, dir);
  } finally { db.close(); rmSync(dir, {recursive:true,force:true}); }
});

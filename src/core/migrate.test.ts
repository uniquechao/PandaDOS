import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db';
import { migrate, migrationStatus, splitStatements } from './migrate';

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
].sort();

/** core/migrations 当前最新编号（新增迁移文件时同步 +1） */
const LATEST_MIGRATION = 18;

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

    expect(status.latest).toBe(18);
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

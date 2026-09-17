/**
 * core/migrate —— 编号迁移执行器。
 * - 迁移文件：src/core/migrations/NNN_name.sql，按数字前缀升序执行
 * - schema_migrations 表记录已应用编号 → migrate() 可重复执行（幂等）
 * - 每个迁移整体包在事务里，失败回滚
 */
import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSyncUids } from './project-data';
import { ensureProjectDataOutboxTriggers } from './project-data-outbox';

export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * 全部迁移目录（各模块自带，但共用同一张 schema_migrations 账本）。
 * 这里只写路径、不 import 各模块，避免 core 反向依赖外层。
 */
export const ALL_MIGRATION_DIRS: readonly string[] = [
  DEFAULT_MIGRATIONS_DIR,
  join(import.meta.dir, '..', 'issues', 'migrations'),
  join(import.meta.dir, '..', 'agents', 'migrations'),
  join(import.meta.dir, '..', 'designs', 'migrations'),
  join(import.meta.dir, '..', 'notify', 'migrations'),
];

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export interface MigrationStatus {
  /** 已应用的迁移编号（升序） */
  applied: number[];
  /** 最新已应用编号；无迁移则 null */
  latest: number | null;
}


// ---------- 跨目录编号守卫（#292） ----------
// schema_migrations 是全局单一账本、只按编号去重：两个目录用同一个编号时，先跑的那个占住编号，
// 后跑的会被当成「已应用」而**永远不执行**，且全程无任何报错（notify 060 被 designs 060 顶掉、
// notify_gate_requests 表在生产库与测试库中双双缺失，就是这么来的）。所以撞号必须在启动即炸。

/** 列出某目录下的迁移文件名（NNN_xxx.sql），按编号升序；目录不存在返回空数组。 */
function listMigrationFiles(dir: string): { id: number; name: string }[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .map((f) => ({ id: Number.parseInt(f, 10), name: f }));
}

/** 跨目录编号唯一性：同一编号被两个目录使用即致命错误。 */
export function assertUniqueMigrationIds(dirs: readonly string[] = ALL_MIGRATION_DIRS): void {
  const owner = new Map<number, string>();
  for (const dir of dirs) {
    for (const m of listMigrationFiles(dir)) {
      const prev = owner.get(m.id);
      if (prev !== undefined && prev !== m.name) {
        throw new Error(
          `migration id ${m.id} 被多个目录占用：${prev} 与 ${m.name}；` +
            `schema_migrations 是全局账本，请把其中一个改成未被占用的编号`,
        );
      }
      owner.set(m.id, m.name);
    }
  }
}

/**
 * 账本一致性：某编号已落库、但当前文件名与落库名不同 → 该文件永远不会被执行。
 * 典型成因就是撞号（或迁移文件被改名而未换编号）。
 */
export function assertLedgerMatchesFiles(
  db: Database,
  dirs: readonly string[] = ALL_MIGRATION_DIRS,
): void {
  ensureMigrationsTable(db);
  const applied = new Map<number, string>();
  for (const r of db
    .query<{ id: number; name: string }, []>('SELECT id, name FROM schema_migrations')
    .all()) {
    applied.set(r.id, r.name);
  }
  for (const dir of dirs) {
    for (const m of listMigrationFiles(dir)) {
      const ledgerName = applied.get(m.id);
      if (ledgerName !== undefined && ledgerName !== m.name) {
        throw new Error(
          `migration id ${m.id} 在 schema_migrations 中记为 ${ledgerName}，` +
            `但磁盘上是 ${m.name}：该迁移会被静默跳过，请换一个未被占用的编号`,
        );
      }
    }
  }
}

/** 启动迁移链之前调用：撞号与账本错位都在这里暴露。 */
export function assertNoMigrationCollisions(
  db: Database,
  dirs: readonly string[] = ALL_MIGRATION_DIRS,
): void {
  assertUniqueMigrationIds(dirs);
  assertLedgerMatchesFiles(db, dirs);
}

/** 从目录加载迁移文件（NNN_xxx.sql），按编号升序。编号重复视为致命错误。 */
export function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const seen = new Set<number>();
  return files.map((f) => {
    const id = Number.parseInt(f, 10);
    if (seen.has(id)) throw new Error(`duplicate migration id ${id}: ${f}`);
    seen.add(id);
    return { id, name: f, sql: readFileSync(join(dir, f), 'utf8') };
  });
}

/** 去注释后按分号切分语句（本项目迁移 SQL 无字符串内分号/触发器，够用且可控）。 */
export function splitStatements(sql: string): string[] {
  const noComments = sql.replace(/--[^\n]*/g, '');
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function ensureMigrationsTable(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_ts INTEGER NOT NULL
  )`);
}

/** 查询当前迁移状态（不执行任何迁移）。 */
export function migrationStatus(db: Database): MigrationStatus {
  ensureMigrationsTable(db);
  const rows = db
    .query<{ id: number }, []>('SELECT id FROM schema_migrations ORDER BY id')
    .all();
  const applied = rows.map((r) => r.id);
  return { applied, latest: applied.length > 0 ? applied[applied.length - 1]! : null };
}

/** Rebuild only the issue status constraint, preserving installed columns, indexes and triggers.
 * Foreign keys are disabled outside the transaction; checked before committing and restored.
 */
function addPausedIssueState(db: Database): void {
  const existingViolations=new Set(db.query('PRAGMA foreign_key_check').all().map(row=>JSON.stringify(row)));
  const sequence=db.query<{seq:number},[]>("SELECT seq FROM sqlite_sequence WHERE name='issues'").get()?.seq ?? 0;
  const row = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'issues'").get();
  if (!row) throw new Error('issues table missing');
  const status = /CHECK\s*\(status IN\s*\(([^)]*)\)\)/i;
  if (!status.test(row.sql)) throw new Error('unknown issues status constraint');
  const sql = row.sql.replace(status, (_, states: string) => `CHECK (status IN (${states}, 'paused'))`)
    .replace(/^CREATE TABLE\s+["`]?issues["`]?/i, 'CREATE TABLE issues_rebuild');
  const objects = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE tbl_name = 'issues' AND type IN ('index','trigger') AND sql IS NOT NULL",
  ).all();
  const columns = db.query<{ name: string }, []>('PRAGMA table_info(issues)').all()
    .map(c => '"' + c.name.replaceAll('"', '""') + '"').join(',');
  db.run(sql);
  db.run(`INSERT INTO issues_rebuild (${columns}) SELECT ${columns} FROM issues`);
  db.run('DROP TABLE issues');
  db.run('ALTER TABLE issues_rebuild RENAME TO issues');
  for (const object of objects) db.run(object.sql);
  db.run("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='issues'",[sequence]);
  if (db.query('PRAGMA foreign_key_check').all().some(row=>!existingViolations.has(JSON.stringify(row)))) throw new Error('issue rebuild introduces a foreign key violation');
}

/** 应用所有未执行的迁移；重复调用幂等。返回执行后的状态。 */
export function migrate(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationStatus {
  ensureMigrationsTable(db);
  const done = new Set(migrationStatus(db).applied);
  const pending = loadMigrations(dir).filter((m) => !done.has(m.id));

  for (const m of pending) {
    const rebuild = m.sql.includes('-- panda:add-paused-issue-state');
    const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys;
    const legacy = db.query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table').get()!.legacy_alter_table;
    const apply = db.transaction(() => {
      if (rebuild) addPausedIssueState(db);
      for (const stmt of splitStatements(m.sql)) db.run(stmt);
      db.run('INSERT INTO schema_migrations (id, name, applied_ts) VALUES (?, ?, ?)', [
        m.id,
        m.name,
        Date.now(),
      ]);
    });
    try {
      if (rebuild) {
        db.run('PRAGMA foreign_keys = OFF'); db.run('PRAGMA legacy_alter_table = ON');
        if (db.query<{foreign_keys:number},[]>('PRAGMA foreign_keys').get()?.foreign_keys) throw new Error('issue rebuild requires a top-level migration transaction');
      }
      apply();
    } finally {
      if (rebuild) { db.run(`PRAGMA foreign_keys = ${fk}`); db.run(`PRAGMA legacy_alter_table = ${legacy}`); }
    }
  }
  if (dir === DEFAULT_MIGRATIONS_DIR) {
    ensureSyncUids(db, [
      { table: 'projects', timestampColumn: 'created_ts' },
      { table: 'conversations', timestampColumn: 'created_ts' },
      { table: 'project_attachments', timestampColumn: 'created_ts' },
    ]);
    ensureProjectDataOutboxTriggers(db, [
      { table: 'projects', kind: 'project', projectColumn: 'id', archivedWhen: "NEW.status = 'archived'" },
      { table: 'conversations', kind: 'conversation', archivedWhen: 'NEW.archived <> 0' },
      { table: 'project_attachments', kind: 'attachment', archivedWhen: "NEW.status = 'archived'" },
    ]);
  }
  return migrationStatus(db);
}

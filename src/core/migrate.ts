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
  join(import.meta.dir, '..', 'rooms', 'migrations'),
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
/** A rebuild can assign new rowids even when the same broken legacy reference survives.
 * Compare the child row's values instead, with numeric IDs normalized across INTEGER→TEXT.
 */
function foreignKeyViolationCounts(db: Database): Map<string, number> {
  const counts = new Map<string, number>();
  const violations = db.query<{ table: string; rowid: number | null; parent: string; fkid: number }, []>(
    'PRAGMA foreign_key_check',
  ).all();
  for (const violation of violations) {
    const row = violation.rowid === null ? null : db.query<Record<string, unknown>, [number]>(
      `SELECT * FROM ${quoteIdent(violation.table)} WHERE rowid = ?`,
    ).get(violation.rowid);
    const values = row && Object.entries(row).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [
      key,
      typeof value === 'number' || typeof value === 'bigint' ? String(value)
        : value instanceof Uint8Array ? Array.from(value) : value,
    ]);
    const fingerprint = JSON.stringify([violation.table, violation.parent, violation.fkid, values]);
    counts.set(fingerprint, (counts.get(fingerprint) ?? 0) + 1);
  }
  return counts;
}

function hasNewForeignKeyViolations(db: Database, before: ReadonlyMap<string, number>): boolean {
  for (const [fingerprint, count] of foreignKeyViolationCounts(db)) {
    if (count > (before.get(fingerprint) ?? 0)) return true;
  }
  return false;
}

function addPausedIssueState(db: Database): void {
  const existingViolations = foreignKeyViolationCounts(db);
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
  if (hasNewForeignKeyViolations(db, existingViolations)) throw new Error('issue rebuild introduces a foreign key violation');
}

// ---------- #307：issue 主键改文本编号 ----------

/** 不带外键、但同样存放 issue 编号的列（0 / 项目 id 等哨兵值使外键不可用）。 */
export const ISSUE_ID_EXTRA_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  subscriptions: ['target_id'],
  usage_daily: ['issue_id'],
  skill_policies: ['issue_id'],
};

/** 新建行未显式给编号时的兜底默认值（生产代码走 core/issue-id 的生成器，带机器段）。 */
const ISSUE_ID_SQL_DEFAULT =
  "(strftime('%Y%m%d','now','localtime') || '-' || substr(lower(hex(randomblob(4))),1,7))";

function quoteIdent(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function declaredType(db: Database, table: string, column: string): string | null {
  const col = db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`)
    .all().find((c) => c.name === column);
  return col ? col.type.toUpperCase() : null;
}

/** 按原 CREATE 语句重建表（保留列、索引、触发器），`transform` 改写建表 SQL。 */
function rebuildTable(db: Database, table: string, transform: (sql: string) => string): void {
  const row = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row) return;
  const tmp = `${table}__rebuild307`;
  const sql = transform(row.sql).replace(
    new RegExp(`^CREATE TABLE\\s+["\`]?${escapeRegExp(table)}["\`]?`, 'i'),
    `CREATE TABLE ${quoteIdent(tmp)}`,
  );
  if (sql === row.sql) throw new Error(`rebuild ${table}: CREATE TABLE header not recognized`);
  const objects = db.query<{ sql: string }, [string]>(
    "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL",
  ).all(table);
  const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${quoteIdent(table)})`).all()
    .map((c) => quoteIdent(c.name)).join(',');
  db.run(sql);
  db.run(`INSERT INTO ${quoteIdent(tmp)} (${columns}) SELECT ${columns} FROM ${quoteIdent(table)}`);
  db.run(`DROP TABLE ${quoteIdent(table)}`);
  db.run(`ALTER TABLE ${quoteIdent(tmp)} RENAME TO ${quoteIdent(table)}`);
  for (const object of objects) db.run(object.sql);
}

/** 把建表 SQL 里某列的声明类型 INTEGER 改成 TEXT。 */
function columnToText(sql: string, column: string): string {
  const re = new RegExp(`([(,]\\s*["\`]?${escapeRegExp(column)}["\`]?\\s+)INTEGER\\b`, 'i');
  if (!re.test(sql)) throw new Error(`column ${column} declaration not recognized`);
  return sql.replace(re, '$1TEXT');
}

/**
 * #307：issues.id 改 `TEXT PRIMARY KEY`，所有存放 issue 编号的列改 TEXT。
 * 幂等：已是 TEXT 的表跳过，故 issues（074）与 designs（075）两个目录可各跑一次，
 * 覆盖「全新库上 designs 表晚于 issues 迁移才建出来」的顺序。存量数字编号原样转成文本。
 */
function convertIssueIdsToText(db: Database): void {
  const existingViolations = foreignKeyViolationCounts(db);
  if (declaredType(db, 'issues', 'id') === 'INTEGER') {
    rebuildTable(db, 'issues', (sql) => {
      const re = /([(,]\s*["`]?id["`]?\s+)INTEGER\s+PRIMARY\s+KEY(\s+AUTOINCREMENT)?/i;
      if (!re.test(sql)) throw new Error('issues.id declaration not recognized');
      return sql.replace(re, `$1TEXT PRIMARY KEY NOT NULL DEFAULT ${ISSUE_ID_SQL_DEFAULT}`);
    });
    db.run("DELETE FROM sqlite_sequence WHERE name = 'issues'");
  }
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'issues'",
  ).all().map((r) => r.name);
  for (const table of tables) {
    const fkColumns = db.query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
      .all().filter((fk) => fk.table === 'issues').map((fk) => fk.from);
    // 复合外键 (issue_id, project_id) 里的 project 列不是 issue 编号
    const issueColumns = fkColumns.filter((c) => !/project_id$/.test(c));
    const columns = [...new Set([...issueColumns, ...(ISSUE_ID_EXTRA_COLUMNS[table] ?? [])])]
      .filter((c) => declaredType(db, table, c) === 'INTEGER');
    if (columns.length === 0) continue;
    rebuildTable(db, table, (sql) => columns.reduce((acc, c) => columnToText(acc, c), sql)
      .replace(/(issue_id\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+)0\b/gi, "$1'0'"));
  }
  if (hasNewForeignKeyViolations(db, existingViolations)) {
    throw new Error('issue id conversion introduces a foreign key violation');
  }
}

/** 应用所有未执行的迁移；重复调用幂等。返回执行后的状态。 */
export function migrate(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationStatus {
  ensureMigrationsTable(db);
  const done = new Set(migrationStatus(db).applied);
  const pending = loadMigrations(dir).filter((m) => !done.has(m.id));

  for (const m of pending) {
    const pausedRebuild = m.sql.includes('-- panda:add-paused-issue-state');
    const textIdRebuild = m.sql.includes('-- panda:issue-text-id');
    const rebuild = pausedRebuild || textIdRebuild;
    const fk = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()!.foreign_keys;
    const legacy = db.query<{ legacy_alter_table: number }, []>('PRAGMA legacy_alter_table').get()!.legacy_alter_table;
    const apply = db.transaction(() => {
      if (pausedRebuild) addPausedIssueState(db);
      if (textIdRebuild) convertIssueIdsToText(db);
      // SQLite trigger bodies contain semicolons. Let SQLite parse the trusted
      // migration file as a script instead of splitting it at those semicolons.
      if (/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(m.sql)) db.exec(m.sql);
      else for (const stmt of splitStatements(m.sql)) db.run(stmt);
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

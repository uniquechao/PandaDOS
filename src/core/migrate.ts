/**
 * core/migrate —— 编号迁移执行器。
 * - 迁移文件：src/core/migrations/NNN_name.sql，按数字前缀升序执行
 * - schema_migrations 表记录已应用编号 → migrate() 可重复执行（幂等）
 * - 每个迁移整体包在事务里，失败回滚
 */
import type { Database } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

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

/** 应用所有未执行的迁移；重复调用幂等。返回执行后的状态。 */
export function migrate(db: Database, dir: string = DEFAULT_MIGRATIONS_DIR): MigrationStatus {
  ensureMigrationsTable(db);
  const done = new Set(migrationStatus(db).applied);
  const pending = loadMigrations(dir).filter((m) => !done.has(m.id));

  for (const m of pending) {
    const apply = db.transaction(() => {
      for (const stmt of splitStatements(m.sql)) db.run(stmt);
      db.run('INSERT INTO schema_migrations (id, name, applied_ts) VALUES (?, ?, ?)', [
        m.id,
        m.name,
        Date.now(),
      ]);
    });
    apply();
  }
  return migrationStatus(db);
}

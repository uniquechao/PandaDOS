/**
 * core/db —— bun:sqlite 封装。
 * 职责：打开单文件 DB（默认 ~/.butler2/butler.db），统一 PRAGMA（WAL / 外键 / busy_timeout）。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_DB_PATH = join(homedir(), '.butler2', 'butler.db');

export function defaultDbPath(): string {
  return process.env.BUTLER2_DB ?? DEFAULT_DB_PATH;
}

/**
 * 打开（必要时创建）SQLite 数据库。
 * - WAL 模式（单进程多读一写足够，崩溃安全）
 * - foreign_keys ON（schema 里的 REFERENCES 才真正生效）
 * - busy_timeout 5s
 */
export function openDb(path: string = defaultDbPath()): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  return db;
}

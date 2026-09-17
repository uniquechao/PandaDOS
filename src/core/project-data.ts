/** Versioned, Git-shareable project data contract rooted at `.panda`. */
import type { Database } from 'bun:sqlite';

export const PANDA_PROJECT_DATA_VERSION = 1 as const;

export const PANDA_PROJECT_DATA = {
  root: '.panda',
  schema: 'pandados.project-data',
  project: '.panda/project.json',
  modules: '.panda/modules',
  workflows: '.panda/workflows',
  designs: '.panda/designs',
  conversations: '.panda/conversations',
  uploads: '.panda/uploads',
  excluded: ['.panda/tmp'],
} as const;

export type SyncUid = string;

export interface PandaProjectDataHeader {
  schema: typeof PANDA_PROJECT_DATA.schema;
  version: typeof PANDA_PROJECT_DATA_VERSION;
  uid: SyncUid;
  updatedTs: number;
}

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isSyncUid(value: unknown): value is SyncUid {
  return typeof value === 'string' && UUID_V7_RE.test(value);
}

/** UUIDv7: 48-bit Unix millisecond timestamp followed by 74 random bits. */
export function uuidV7(
  timestamp = Date.now(),
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): SyncUid {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new RangeError('UUIDv7 timestamp 超出 48-bit 毫秒范围');
  }
  if (random.byteLength < 10) throw new RangeError('UUIDv7 至少需要 10 个随机字节');
  const bytes = new Uint8Array(16);
  let time = BigInt(timestamp);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(time & 0xffn);
    time >>= 8n;
  }
  bytes[6] = 0x70 | (random[0]! & 0x0f);
  bytes[7] = random[1]!;
  bytes[8] = 0x80 | (random[2]! & 0x3f);
  bytes[9] = random[3]!;
  bytes.set(random.subarray(4, 10), 10);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic compatibility identity for legacy files that predate sync_uid. */
export function legacySyncUid(timestamp: number, stableSeed: string): SyncUid {
  const digest = new Bun.CryptoHasher('sha256').update(stableSeed).digest();
  return uuidV7(Math.max(0, Math.min(timestamp, 0xffff_ffff_ffff)), digest.subarray(0, 10));
}

export interface SyncUidTable {
  table: string;
  timestampColumn: string;
}

const SQL_IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * SQLite cannot add a column with a non-constant random default. Migrations add the nullable column;
 * this migration finalizer backfills it and installs a trigger for all future raw inserts.
 */
export function ensureSyncUids(db: Database, specs: readonly SyncUidTable[]): void {
  const sqlUuid = (timestampSql: string): string => {
    const timeHex = `printf('%012x', CAST(${timestampSql} AS INTEGER))`;
    return `lower(substr(${timeHex}, 1, 8) || '-' || substr(${timeHex}, 9, 4) || ` +
      `'-7' || substr(hex(randomblob(2)), 2, 3) || '-8' || ` +
      `substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6)))`;
  };
  db.transaction(() => {
    for (const { table, timestampColumn } of specs) {
      if (!SQL_IDENTIFIER.test(table) || !SQL_IDENTIFIER.test(timestampColumn)) {
        throw new Error('非法同步身份表配置');
      }
      const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
      if (!columns.some((column) => column.name === 'sync_uid')) continue;
      db.run(`UPDATE ${table} SET sync_uid = ${sqlUuid(timestampColumn)} WHERE sync_uid IS NULL`);
      db.run(`CREATE TRIGGER IF NOT EXISTS trg_${table}_sync_uid
        AFTER INSERT ON ${table}
        WHEN NEW.sync_uid IS NULL
        BEGIN
          UPDATE ${table}
          SET sync_uid = ${sqlUuid(`NEW.${timestampColumn}`)}
          WHERE rowid = NEW.rowid;
        END`);
    }
  })();
}

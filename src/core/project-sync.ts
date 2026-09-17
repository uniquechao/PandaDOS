/** Generic file-authoritative synchronization primitives for versioned `.panda` data. */
import type { Database } from 'bun:sqlite';
import type { DirEntry, ExecutorDriver } from '../executor/driver';
import {
  PANDA_PROJECT_DATA,
  PANDA_PROJECT_DATA_VERSION,
  isSyncUid,
  type PandaProjectDataHeader,
} from './project-data';

const DECODER = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const SHAREABLE_ROOTS = new Set(['modules', 'workflows', 'designs', 'conversations', 'uploads']);
const PRIVATE_SEGMENTS = new Set([
  'tmp', 'keys', 'key', 'secrets', 'secret', 'credentials', 'permissions', 'runtime', 'locks',
]);

export function isShareablePandaPath(input: string): boolean {
  if (input.includes('\0') || input.includes('\\') || input.startsWith('/') || input.includes('//')) return false;
  const parts = input.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return false;
  if (parts[0] !== '.panda') return false;
  if (input === PANDA_PROJECT_DATA.project) return true;
  const root = parts[1];
  if (!root || !SHAREABLE_ROOTS.has(root)) return false;
  return !parts.slice(1).some((part) => {
    const lower = part.toLowerCase();
    return PRIVATE_SEGMENTS.has(lower) || lower === '.env' || lower.endsWith('.key') || lower.endsWith('.pem');
  });
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, sortJson(object[key])]));
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(sortJson(value));
  if (json === undefined) throw new Error('无法序列化协作数据');
  return `${json}\n`;
}

export function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex');
}

export interface VersionedPandaRecord extends PandaProjectDataHeader {
  kind: string;
  [key: string]: unknown;
}

export function parseVersionedPandaJson(
  data: Uint8Array,
  path: string,
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): VersionedPandaRecord {
  if (data.byteLength > maxBytes) throw new Error(`协作文件过大：${path}`);
  let value: unknown;
  try {
    value = JSON.parse(DECODER.decode(data));
  } catch (error) {
    throw new Error(`协作文件 JSON 无效：${path}（${String(error).slice(0, 120)}）`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`协作文件必须是对象：${path}`);
  const item = value as Record<string, unknown>;
  if (item.schema !== PANDA_PROJECT_DATA.schema) throw new Error(`协作文件 schema 无效：${path}`);
  if (!Number.isInteger(item.version) || Number(item.version) < 1) throw new Error(`协作文件版本无效：${path}`);
  if (Number(item.version) > PANDA_PROJECT_DATA_VERSION) {
    throw new Error(`不支持协作文件版本 ${String(item.version)}：${path}`);
  }
  if (!isSyncUid(item.uid)) throw new Error(`协作文件 sync_uid 无效：${path}`);
  if (typeof item.kind !== 'string' || !item.kind) throw new Error(`协作文件 kind 无效：${path}`);
  if (!Number.isSafeInteger(item.updatedTs) || Number(item.updatedTs) < 0) {
    throw new Error(`协作文件 updatedTs 无效：${path}`);
  }
  return item as VersionedPandaRecord;
}

/** 免读短路要比对的文件元数据（执行机侧 stat，控制面不参与，避免两边时钟不一致） */
export interface PandaFileStat {
  size: number;
  mtimeMs: number;
}

export interface PandaSyncItem {
  path: string;
  fingerprint: string;
  uid: string;
  version: number;
  kind: string;
  value: unknown;
  /** 本次读取时的文件元数据；缺省 = 不记录，下一轮照旧全量读 */
  stat?: PandaFileStat;
}

export interface PandaSyncAdapter {
  kind: string;
  /** Lower priorities import first so parent records can precede dependent children. */
  priority?: number;
  matches(path: string): boolean;
  decode?(data: Uint8Array, path: string): VersionedPandaRecord;
  apply(projectId: number, item: PandaSyncItem): void | Promise<void>;
  archive(projectId: number, item: Omit<PandaSyncItem, 'value'>): void | Promise<void>;
}

export type PandaSyncEntryState = 'active' | 'archived' | 'error';

export interface PandaSyncEntry {
  projectId: number;
  entityKind: string;
  syncUid: string | null;
  path: string;
  fingerprint: string | null;
  schemaVersion: number | null;
  state: PandaSyncEntryState;
  error: string | null;
  updatedTs: number;
  /** 上次同步时执行机侧的文件元数据；老行为 null（没有这份记录就老实全量读） */
  size: number | null;
  mtimeMs: number | null;
}

interface SyncEntryRow {
  project_id: number;
  entity_kind: string;
  sync_uid: string | null;
  path: string;
  fingerprint: string | null;
  schema_version: number | null;
  state: string;
  error: string | null;
  updated_ts: number;
  size: number | null;
  mtime_ms: number | null;
}

function mapEntry(row: SyncEntryRow): PandaSyncEntry {
  return {
    projectId: row.project_id,
    entityKind: row.entity_kind,
    syncUid: row.sync_uid,
    path: row.path,
    fingerprint: row.fingerprint,
    schemaVersion: row.schema_version,
    state: row.state as PandaSyncEntryState,
    error: row.error,
    updatedTs: row.updated_ts,
    size: row.size ?? null,
    mtimeMs: row.mtime_ms ?? null,
  };
}

export class PandaSyncIndex {
  constructor(private readonly db: Database) {}

  list(projectId: number): PandaSyncEntry[] {
    return this.db.query<SyncEntryRow, [number]>(
      'SELECT * FROM project_data_sync_entries WHERE project_id = ? ORDER BY path',
    ).all(projectId).map(mapEntry);
  }

  byPath(projectId: number, path: string): PandaSyncEntry | null {
    const row = this.db.query<SyncEntryRow, [number, string]>(
      'SELECT * FROM project_data_sync_entries WHERE project_id = ? AND path = ?',
    ).get(projectId, path);
    return row ? mapEntry(row) : null;
  }

  recordActive(projectId: number, item: PandaSyncItem, now = Date.now()): void {
    // A previously unparseable path has no sync_uid and is indexed as `unknown`; once fixed,
    // remove that path-only error row so the real identity can take ownership of the path.
    this.db.query(`DELETE FROM project_data_sync_entries
      WHERE project_id = ? AND path = ? AND state = 'error'`).run(projectId, item.path);
    this.db.query(`INSERT INTO project_data_sync_entries
      (project_id, entity_kind, sync_uid, path, fingerprint, schema_version, state, error, updated_ts,
       size, mtime_ms)
      VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)
      ON CONFLICT(project_id, entity_kind, sync_uid) WHERE sync_uid IS NOT NULL DO UPDATE SET
        path = excluded.path, fingerprint = excluded.fingerprint,
        schema_version = excluded.schema_version, state = 'active', error = NULL,
        updated_ts = excluded.updated_ts, size = excluded.size, mtime_ms = excluded.mtime_ms`)
      .run(projectId, item.kind, item.uid, item.path, item.fingerprint, item.version, now,
        item.stat?.size ?? null, item.stat?.mtimeMs ?? null);
  }

  recordError(projectId: number, path: string, error: string, now = Date.now()): void {
    this.db.query(`INSERT INTO project_data_sync_entries
      (project_id, entity_kind, sync_uid, path, state, error, updated_ts)
      VALUES (?, 'unknown', NULL, ?, 'error', ?, ?)
      ON CONFLICT(project_id, path) DO UPDATE SET
        state = 'error', error = excluded.error, updated_ts = excluded.updated_ts`)
      .run(projectId, path, error.slice(0, 1000), now);
  }

  /**
   * 彻底忘掉一条路径。只给「文件已经不在了的 error 行」用：error 行没有 sync_uid，
   * 归档流程认不了它（`archive` 要 uid），于是文件删了它还赖在索引里，
   * `project_data_sync_status` 的 parse_error_count 永远降不下来、状态永远停在 warning。
   */
  forget(projectId: number, path: string): void {
    this.db.query('DELETE FROM project_data_sync_entries WHERE project_id = ? AND path = ?')
      .run(projectId, path);
  }

  markArchived(projectId: number, path: string, now = Date.now()): void {
    this.db.query(`UPDATE project_data_sync_entries
      SET state = 'archived', error = NULL, updated_ts = ?
      WHERE project_id = ? AND path = ?`).run(now, projectId, path);
  }
}

export interface PandaPullResult {
  imported: number;
  unchanged: number;
  archived: number;
  errors: number;
}

type SyncDriver = Pick<ExecutorDriver,
  'listDirectoryNoFollowWithin' | 'readFileNoFollowWithin' | 'replaceFileNoFollowWithin'>
  // statPath 可选：只给 adapter.unchanged 的免读短路用，老装配/测试 stub 不实现就退回全量读
  & Partial<Pick<ExecutorDriver, 'statPath'>>;

export class PandaProjectSync {
  constructor(
    private readonly driver: SyncDriver,
    private readonly index: PandaSyncIndex | null,
    private readonly adapters: readonly PandaSyncAdapter[],
    private readonly maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    private readonly maxFiles = DEFAULT_MAX_FILES,
  ) {}

  private requireDriver(): Required<SyncDriver> {
    if (!this.driver.listDirectoryNoFollowWithin || !this.driver.readFileNoFollowWithin ||
        !this.driver.replaceFileNoFollowWithin) {
      throw new Error('执行机不支持安全 .panda 同步能力');
    }
    return this.driver as Required<SyncDriver>;
  }

  private async discover(cwd: string): Promise<string[]> {
    const driver = this.requireDriver();
    const files: string[] = [];
    const walk = async (relative: string): Promise<void> => {
      const entries = await driver.listDirectoryNoFollowWithin(cwd, relative);
      if (entries === null) return;
      for (const entry of entries.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        const child = `${relative}/${entry.name}`;
        if (entry.type === 'symlink' || entry.type === 'other' || !isShareablePandaPath(child)) continue;
        if (entry.type === 'dir') await walk(child);
        else if (entry.type === 'file') {
          files.push(child);
          if (files.length > this.maxFiles) throw new Error(`.panda 协作文件超过上限 ${this.maxFiles}`);
        }
      }
    };
    const root: DirEntry[] | null = await driver.listDirectoryNoFollowWithin(cwd, '.panda');
    if (root === null) return [];
    for (const entry of root.slice().sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `.panda/${entry.name}`;
      if (!isShareablePandaPath(child)) continue;
      if (entry.type === 'dir') await walk(child);
      else if (entry.type === 'file') files.push(child);
    }
    return files;
  }

  /**
   * 读文件之前的免读短路。
   *
   * 常规路径判断「这个协作文件变没变」靠内容指纹，而指纹要读完整个文件才算得出来——于是每一轮
   * 轮询都把全部协作文件读一遍再哈希一遍，只为得出「一个字节都没变」。文本只有 1 MB 量级无所谓，
   * `.panda/uploads` 里的图片附件却有几十 MB：生产实测 11 个项目 107 张图共 58 MB，5 秒一轮 =
   * 持续约 11 MB/s 的读 + SHA-256 + 每轮几十 MB 的缓冲区分配，控制面因此常驻约 17% CPU。
   *
   * 短路条件：索引里这条路径已经是 active（之前同步成功过），且**执行机侧的 size 与 mtime 与
   * 上次同步时记录的完全相同**。两边都取自执行机自己的 stat，不掺控制面时钟，所以远程执行机
   * 与控制面时钟不一致也不会误判。比的是相等而非「不新于」——从备份恢复出一个 mtime 更旧的文件
   * 照样会落回全量读。
   *
   * 任何一步拿不准（执行机没有 statPath、stat 失败、不是普通文件、老行没记元数据）都退回原来的
   * 全量读：能力缺失只能让它变慢，不能让它变错。
   */
  private async skipUnchanged(projectId: number, cwd: string, path: string): Promise<boolean> {
    if (!this.driver.statPath || !this.index) return false;
    const prior = this.index.byPath(projectId, path);
    if (prior?.state !== 'active' || prior.size === null || prior.mtimeMs === null) return false;
    const stat = await this.driver
      .statPath(`${cwd.replace(/\/+$/, '')}/${path}`)
      .catch(() => null);
    if (!stat?.isFile) return false;
    return stat.size === prior.size && stat.mtimeMs === prior.mtimeMs;
  }

  async pull(projectId: number, cwd: string): Promise<PandaPullResult> {
    if (!this.index) throw new Error('pull 需要 SQLite 同步索引');
    const driver = this.requireDriver();
    const result: PandaPullResult = { imported: 0, unchanged: 0, archived: 0, errors: 0 };
    const seen = new Set<string>();
    const paths = await this.discover(cwd);
    paths.sort((left, right) => {
      const leftPriority = this.adapters.find((adapter) => adapter.matches(left))?.priority ?? 100;
      const rightPriority = this.adapters.find((adapter) => adapter.matches(right))?.priority ?? 100;
      return leftPriority - rightPriority || left.localeCompare(right);
    });
    for (const path of paths) {
      const adapter = this.adapters.find((candidate) => candidate.matches(path));
      if (!adapter) continue;
      seen.add(path);
      try {
        if (await this.skipUnchanged(projectId, cwd, path)) {
          result.unchanged += 1;
          continue;
        }
        const file = await driver.readFileNoFollowWithin(cwd, path, this.maxFileBytes + 1);
        if (file.size > this.maxFileBytes || file.data.byteLength > this.maxFileBytes) {
          throw new Error(`协作文件过大：${path}`);
        }
        const fingerprint = sha256Hex(file.data);
        const prior = this.index.byPath(projectId, path);
        if (prior?.state === 'active' && prior.fingerprint === fingerprint) {
          result.unchanged += 1;
          continue;
        }
        const value = adapter.decode
          ? adapter.decode(file.data, path)
          : parseVersionedPandaJson(file.data, path, this.maxFileBytes);
        if (value.kind !== adapter.kind) throw new Error(`协作文件 kind 与路径不匹配：${path}`);
        const stat = await this.driver.statPath?.(`${cwd.replace(/\/+$/, '')}/${path}`).catch(() => null);
        const item: PandaSyncItem = {
          path, fingerprint, uid: value.uid, version: value.version, kind: value.kind, value,
          ...(stat?.isFile ? { stat: { size: stat.size, mtimeMs: stat.mtimeMs } } : {}),
        };
        await adapter.apply(projectId, item);
        this.index.recordActive(projectId, item);
        result.imported += 1;
      } catch (error) {
        this.index.recordError(projectId, path, String(error));
        result.errors += 1;
      }
    }
    for (const entry of this.index.list(projectId)) {
      if (seen.has(entry.path)) continue;
      // 解析失败过、现在文件也没了 → 直接忘掉。它没有 sync_uid，走不了下面的归档流程；
      // 不清掉的话删文件并不能消错，状态会永远卡在 warning。
      if (entry.state === 'error') {
        this.index.forget(projectId, entry.path);
        continue;
      }
      if (entry.state !== 'active' || !entry.syncUid) continue;
      const adapter = this.adapters.find((candidate) => candidate.kind === entry.entityKind);
      if (!adapter) continue;
      try {
        await adapter.archive(projectId, {
          path: entry.path,
          fingerprint: entry.fingerprint ?? '',
          uid: entry.syncUid,
          version: entry.schemaVersion ?? 1,
          kind: entry.entityKind,
        });
        this.index.markArchived(projectId, entry.path);
        result.archived += 1;
      } catch (error) {
        this.index.recordError(projectId, entry.path, String(error));
        result.errors += 1;
      }
    }
    return result;
  }

  async writeJson(
    cwd: string,
    path: string,
    value: unknown,
    expectedFingerprint: string | null,
  ): Promise<{ status: 'written' | 'unchanged' | 'conflict'; fingerprint: string }> {
    if (!isShareablePandaPath(path)) throw new Error(`不可写入非协作路径：${path}`);
    const data = new TextEncoder().encode(canonicalJson(value));
    if (data.byteLength > this.maxFileBytes) throw new Error(`协作文件过大：${path}`);
    const fingerprint = sha256Hex(data);
    const status = await this.requireDriver().replaceFileNoFollowWithin(
      cwd, path, data, expectedFingerprint,
    );
    return { status, fingerprint };
  }
}

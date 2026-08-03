/**
 * core/external-issues —— 项目外部 issue 来源与导入/忽略 tombstone 的持久化边界。
 *
 * 本模块不访问 GitHub/GitLab，也不解析 git remote；它只负责数据库事实。远端获取与正式
 * issue 创建由 web/issues 外层在后续步骤编排。
 */
import type { Database } from 'bun:sqlite';
import type {
  ExternalIssueDisposition,
  ExternalIssueProvider,
  ExternalIssueRecord,
  ExternalIssueSourceConfig,
  ExternalIssueSourceSummary,
} from './types';

interface SourceRow {
  project_id: number;
  provider: string;
  remote_name: string;
  remote_url: string;
  instance_url: string;
  api_token: string | null;
  token_updated_ts: number | null;
  created_ts: number;
  updated_ts: number;
}

interface RecordRow {
  id: number;
  project_id: number;
  provider: string;
  source_key: string;
  external_id: string;
  external_number: string;
  external_url: string;
  disposition: string;
  local_issue_id: number | null;
  created_by: number | null;
  created_ts: number;
  updated_ts: number;
}

export interface SaveExternalIssueSourceInput {
  projectId: number;
  provider: ExternalIssueProvider;
  remoteName: string;
  remoteUrl: string;
  instanceUrl: string;
  /** undefined 保留现有 token；null 明确清除；string 替换。 */
  apiToken?: string | null;
}

export interface RecordExternalIssueInput {
  projectId: number;
  provider: ExternalIssueProvider;
  sourceKey: string;
  externalId: string;
  externalNumber: string;
  externalUrl: string;
  disposition: ExternalIssueDisposition;
  localIssueId?: number | null;
  createdBy?: number | null;
}

export type ExternalIssueIdentityInput = Omit<
  RecordExternalIssueInput,
  'disposition' | 'localIssueId'
>;

function provider(value: string): ExternalIssueProvider {
  return value === 'gitlab' ? 'gitlab' : 'github';
}

function sourceOf(row: SourceRow): ExternalIssueSourceConfig {
  return {
    projectId: row.project_id,
    provider: provider(row.provider),
    remoteName: row.remote_name,
    remoteUrl: row.remote_url,
    instanceUrl: row.instance_url,
    apiToken: row.api_token,
    tokenUpdatedTs: row.token_updated_ts,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

function recordOf(row: RecordRow): ExternalIssueRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: provider(row.provider),
    sourceKey: row.source_key,
    externalId: row.external_id,
    externalNumber: row.external_number,
    externalUrl: row.external_url,
    disposition: row.disposition === 'ignored' ? 'ignored' : 'imported',
    localIssueId: row.local_issue_id,
    createdBy: row.created_by,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

/** 只露末四位；短 token 不回显任何原字符，避免脱敏结果等同明文。 */
export function maskExternalIssueToken(token: string | null): string | null {
  if (!token) return null;
  return token.length > 4 ? `••••${token.slice(-4)}` : '••••';
}

export class ExternalIssueStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  source(projectId: number): ExternalIssueSourceConfig | null {
    const row = this.db
      .query<SourceRow, [number]>('SELECT * FROM project_external_issue_sources WHERE project_id = ?')
      .get(projectId);
    return row ? sourceOf(row) : null;
  }

  sourceSummary(projectId: number): ExternalIssueSourceSummary | null {
    const value = this.source(projectId);
    if (!value) return null;
    const { apiToken, ...safe } = value;
    return {
      ...safe,
      tokenConfigured: Boolean(apiToken),
      tokenMasked: maskExternalIssueToken(apiToken),
    };
  }

  saveSource(input: SaveExternalIssueSourceInput): ExternalIssueSourceConfig {
    const existing = this.source(input.projectId);
    const ts = this.now();
    const sameCredentialScope =
      existing?.provider === input.provider && existing.instanceUrl === input.instanceUrl;
    const suppliedToken = input.apiToken === '' ? null : input.apiToken;
    const nextToken =
      suppliedToken === undefined
        ? sameCredentialScope
          ? existing?.apiToken ?? null
          : null
        : suppliedToken;
    const tokenChanged = nextToken !== (existing?.apiToken ?? null);
    const tokenUpdatedTs = tokenChanged
      ? nextToken === null
        ? null
        : ts
      : existing?.tokenUpdatedTs ?? null;
    this.db.query(
      `INSERT INTO project_external_issue_sources
         (project_id, provider, remote_name, remote_url, instance_url, api_token,
          token_updated_ts, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET
         provider = excluded.provider,
         remote_name = excluded.remote_name,
         remote_url = excluded.remote_url,
         instance_url = excluded.instance_url,
         api_token = excluded.api_token,
         token_updated_ts = excluded.token_updated_ts,
         updated_ts = excluded.updated_ts`,
    ).run(
      input.projectId,
      input.provider,
      input.remoteName,
      input.remoteUrl,
      input.instanceUrl,
      nextToken,
      tokenUpdatedTs,
      existing?.createdTs ?? ts,
      ts,
    );
    return this.source(input.projectId)!;
  }

  clearSource(projectId: number): boolean {
    return this.db
      .query('DELETE FROM project_external_issue_sources WHERE project_id = ?')
      .run(projectId).changes > 0;
  }

  listRecords(
    projectId: number,
    providerName: ExternalIssueProvider,
    sourceKey: string,
  ): ExternalIssueRecord[] {
    return this.db
      .query<RecordRow, [number, string, string]>(
        `SELECT * FROM external_issue_records
          WHERE project_id = ? AND provider = ? AND source_key = ?
          ORDER BY id`,
      )
      .all(projectId, providerName, sourceKey)
      .map(recordOf);
  }

  record(input: RecordExternalIssueInput): ExternalIssueRecord {
    const ts = this.now();
    if (input.disposition === 'imported' && input.localIssueId == null) {
      throw new Error('记录 imported 外部 issue 时必须提供 localIssueId');
    }
    const localIssueId = input.disposition === 'imported' ? input.localIssueId ?? null : null;
    this.db.query(
      `INSERT INTO external_issue_records
         (project_id, provider, source_key, external_id, external_number, external_url,
          disposition, local_issue_id, created_by, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, provider, source_key, external_id) DO UPDATE SET
         external_number = excluded.external_number,
         external_url = excluded.external_url,
         disposition = excluded.disposition,
         local_issue_id = excluded.local_issue_id,
         created_by = excluded.created_by,
         updated_ts = excluded.updated_ts`,
    ).run(
      input.projectId,
      input.provider,
      input.sourceKey,
      input.externalId,
      input.externalNumber,
      input.externalUrl,
      input.disposition,
      localIssueId,
      input.createdBy ?? null,
      ts,
      ts,
    );
    return recordOf(
      this.db
        .query<RecordRow, [number, string, string, string]>(
          `SELECT * FROM external_issue_records
            WHERE project_id = ? AND provider = ? AND source_key = ? AND external_id = ?`,
        )
        .get(input.projectId, input.provider, input.sourceKey, input.externalId)!,
    );
  }

  /**
   * 在调用方事务内把远端 issue 原子绑定到刚创建的正式 issue。
   * - 尚无记录：插入 imported；
   * - ignored：允许用户改变主意，原位升级成 imported；
   * - 已 imported：不覆盖原 localIssueId，返回 null 让调用方回滚新 issue。
   */
  recordImportedOnce(
    input: ExternalIssueIdentityInput,
    localIssueId: number,
  ): ExternalIssueRecord | null {
    const ts = this.now();
    const row = this.db
      .query<RecordRow, [
        number, string, string, string, string, string, number, number | null, number, number,
      ]>(
        `INSERT INTO external_issue_records
           (project_id, provider, source_key, external_id, external_number, external_url,
            disposition, local_issue_id, created_by, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?)
         ON CONFLICT(project_id, provider, source_key, external_id) DO UPDATE SET
           external_number = excluded.external_number,
           external_url = excluded.external_url,
           disposition = 'imported',
           local_issue_id = excluded.local_issue_id,
           created_by = excluded.created_by,
           updated_ts = excluded.updated_ts
         WHERE external_issue_records.disposition = 'ignored'
         RETURNING *`,
      )
      .get(
        input.projectId,
        input.provider,
        input.sourceKey,
        input.externalId,
        input.externalNumber,
        input.externalUrl,
        localIssueId,
        input.createdBy ?? null,
        ts,
        ts,
      );
    return row ? recordOf(row) : null;
  }

  /** 忽略操作幂等，但绝不把已经 imported 的记录降级回 ignored。 */
  recordIgnored(input: ExternalIssueIdentityInput): ExternalIssueRecord | null {
    const ts = this.now();
    const row = this.db
      .query<RecordRow, [number, string, string, string, string, string, number | null, number, number]>(
        `INSERT INTO external_issue_records
           (project_id, provider, source_key, external_id, external_number, external_url,
            disposition, local_issue_id, created_by, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'ignored', NULL, ?, ?, ?)
         ON CONFLICT(project_id, provider, source_key, external_id) DO UPDATE SET
           external_number = excluded.external_number,
           external_url = excluded.external_url,
           created_by = excluded.created_by,
           updated_ts = excluded.updated_ts
         WHERE external_issue_records.disposition = 'ignored'
         RETURNING *`,
      )
      .get(
        input.projectId,
        input.provider,
        input.sourceKey,
        input.externalId,
        input.externalNumber,
        input.externalUrl,
        input.createdBy ?? null,
        ts,
        ts,
      );
    return row ? recordOf(row) : null;
  }
}

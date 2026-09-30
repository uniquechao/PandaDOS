import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import { isDeclaredAsyncFunction, isThenable, type SynchronousCallbackResult } from './synchronous-callback';
import { MAX_EXECUTION_SYNC_JSON } from './execution-sync-types';
import type {
  IssueExecutionSync, IssueExecutionSyncDecision, IssueExecutionSyncEffectContext,
  IssueExecutionSyncEffectReceipt, IssueExecutionSyncRequest, IssueExecutionSyncState,
} from './execution-sync-types';

function encodeExecutionSyncEffectResult(value: unknown): string {
  const encoded = JSON.stringify({ value });
  if (encoded === undefined || encoded.length > MAX_EXECUTION_SYNC_JSON) {
    throw new Error('execution sync effect result must be bounded JSON');
  }
  return encoded;
}

function decodeExecutionSyncEffectResult(encoded: string): unknown {
  const wrapper = JSON.parse(encoded) as { value?: unknown };
  return wrapper.value;
}

interface ExecutionSyncRow {
  id: number;
  issue_id: IssueId;
  source_kind: string;
  source_key: string;
  source_revision: string;
  source_digest: string;
  diff_json: string;
  state: string;
  boundary_kind: string | null;
  deferred_action_json: string | null;
  requested_by: number | null;
  requested_ts: number;
  acknowledged_ts: number | null;
  decided_by: number | null;
  decided_ts: number | null;
  resume_state: string;
  resume_key: string | null;
  resume_token: string | null;
  resume_claimed_ts: number | null;
  resumed_ts: number | null;
}

interface ExecutionSyncEffectReceiptRow {
  resume_key: string;
  sync_id: number;
  result_json: string;
  completed_ts: number;
}

function mapExecutionSync(row: ExecutionSyncRow): IssueExecutionSync {
  return {
    id: row.id,
    issueId: row.issue_id,
    sourceKind: row.source_kind,
    sourceKey: row.source_key,
    sourceRevision: row.source_revision,
    sourceDigest: row.source_digest,
    diffJson: row.diff_json,
    state: row.state as IssueExecutionSyncState,
    boundaryKind: row.boundary_kind,
    deferredActionJson: row.deferred_action_json,
    requestedBy: row.requested_by,
    requestedTs: row.requested_ts,
    acknowledgedTs: row.acknowledged_ts,
    decidedBy: row.decided_by,
    decidedTs: row.decided_ts,
    resumeState: row.resume_state as IssueExecutionSync['resumeState'],
    resumeKey: row.resume_key,
    resumeToken: row.resume_token,
    resumeClaimedTs: row.resume_claimed_ts,
    resumedTs: row.resumed_ts,
  };
}

function mapExecutionSyncEffectReceipt(row: ExecutionSyncEffectReceiptRow): IssueExecutionSyncEffectReceipt {
  return {
    syncId: row.sync_id,
    resumeKey: row.resume_key,
    result: decodeExecutionSyncEffectResult(row.result_json),
    completedTs: row.completed_ts,
  };
}

/** SQLite facts for sync requests, decisions and exactly-once local effect receipts. */
export class ExecutionSyncRepository {
  constructor(private readonly db: Database) {}

  requestExecutionSync(issueId: IssueId, input: IssueExecutionSyncRequest): IssueExecutionSync {
    if (!this.db.query<{ found: number }, [IssueId]>('SELECT 1 AS found FROM issues WHERE id = ?').get(issueId)) {
      throw new Error('issue does not exist');
    }
    const sourceKind = input.sourceKind.trim();
    const sourceKey = input.sourceKey.trim();
    const sourceRevision = input.sourceRevision.trim();
    const sourceDigest = input.sourceDigest.trim();
    if (!sourceKind || sourceKind.length > 40) throw new Error('invalid execution sync source kind');
    if (!sourceKey || sourceKey.length > 240) throw new Error('invalid execution sync source key');
    if (!sourceRevision || sourceRevision.length > 120) throw new Error('invalid execution sync source revision');
    if (!sourceDigest || sourceDigest.length > 200) throw new Error('invalid execution sync source digest');
    const diffJson = JSON.stringify(input.diff);
    if (diffJson === undefined || diffJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid execution sync diff');
    }
    const existing = this.db
      .query<ExecutionSyncRow, [IssueId, string, string, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE issue_id = ? AND source_kind = ? AND source_key = ? AND source_revision = ?`,
      )
      .get(issueId, sourceKind, sourceKey, sourceRevision);
    if (existing) {
      if (existing.source_digest !== sourceDigest || existing.diff_json !== diffJson) {
        throw new Error('execution sync idempotency conflict');
      }
      return mapExecutionSync(existing);
    }
    const row = this.db
      .query<ExecutionSyncRow, [IssueId, string, string, string, string, string, number | null, number]>(
        `INSERT INTO issue_execution_syncs
           (issue_id, source_kind, source_key, source_revision, source_digest, diff_json,
            state, requested_by, requested_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'requested', ?, ?)
         RETURNING *`,
      )
      .get(
        issueId,
        sourceKind,
        sourceKey,
        sourceRevision,
        sourceDigest,
        diffJson,
        input.requestedBy ?? null,
        Date.now(),
      );
    if (!row) throw new Error('create execution sync failed');
    return mapExecutionSync(row);
  }

  requestLatestExecutionSync(issueId: IssueId, input: IssueExecutionSyncRequest): IssueExecutionSync {
    const request = this.db.transaction(() => {
      const existing = this.db.query<ExecutionSyncRow, [IssueId, string, string, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE issue_id = ? AND source_kind = ? AND source_key = ? AND source_revision = ?`,
      ).get(issueId, input.sourceKind.trim(), input.sourceKey.trim(), input.sourceRevision.trim());
      if (existing) return this.requestExecutionSync(issueId, input);
      this.db.query(
        `UPDATE issue_execution_syncs SET state = 'stale', decided_ts = COALESCE(decided_ts, ?)
         WHERE issue_id = ? AND source_kind = ? AND source_key = ?
           AND state IN ('requested', 'boundary_waiting')`,
      ).run(Date.now(), issueId, input.sourceKind.trim(), input.sourceKey.trim());
      return this.requestExecutionSync(issueId, input);
    });
    return request();
  }

  latestExecutionSync(issueId: IssueId, sourceKind: string, sourceKey: string): IssueExecutionSync | null {
    const row = this.db.query<ExecutionSyncRow, [IssueId, string, string]>(
      `SELECT * FROM issue_execution_syncs
       WHERE issue_id = ? AND source_kind = ? AND source_key = ?
       ORDER BY requested_ts DESC, id DESC LIMIT 1`,
    ).get(issueId, sourceKind, sourceKey);
    return row ? mapExecutionSync(row) : null;
  }

  activeExecutionSyncBoundary(issueId: IssueId): IssueExecutionSync | null {
    const row = this.db.query<ExecutionSyncRow, [IssueId]>(
      `SELECT * FROM issue_execution_syncs
       WHERE issue_id = ? AND state = 'boundary_waiting'
       ORDER BY requested_ts DESC, id DESC LIMIT 1`,
    ).get(issueId);
    return row ? mapExecutionSync(row) : null;
  }

  getExecutionSync(id: number): IssueExecutionSync | undefined {
    const row = this.db.query<ExecutionSyncRow, [number]>('SELECT * FROM issue_execution_syncs WHERE id = ?').get(id);
    return row ? mapExecutionSync(row) : undefined;
  }

  holdExecutionSyncBoundary(
    issueId: IssueId,
    boundaryKind: string,
    deferredAction: unknown,
  ): IssueExecutionSync | null {
    const boundary = boundaryKind.trim();
    if (!boundary || boundary.length > 80) throw new Error('invalid execution sync boundary');
    const actionJson = JSON.stringify(deferredAction);
    if (actionJson === undefined || actionJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid deferred execution action');
    }
    const hold = this.db.transaction(() => {
      const requested = this.db
        .query<ExecutionSyncRow, [IssueId]>(
          `SELECT * FROM issue_execution_syncs
           WHERE issue_id = ? AND state IN ('requested', 'boundary_waiting')
           ORDER BY requested_ts DESC, id DESC LIMIT 1`,
        )
        .get(issueId);
      if (!requested) return null;
      if (requested.state === 'boundary_waiting') {
        if (requested.boundary_kind === boundary && requested.deferred_action_json === actionJson) {
          return mapExecutionSync(requested);
        }
        let existingAction: { kind?: unknown } | null = null;
        try {
          existingAction = JSON.parse(requested.deferred_action_json ?? 'null') as { kind?: unknown } | null;
        } catch {
          // Malformed durable action fails closed below.
        }
        if (existingAction?.kind !== 'safe_state') throw new Error('execution sync boundary conflict');
        const upgraded = this.db.query<ExecutionSyncRow, [string, string, number]>(
          `UPDATE issue_execution_syncs SET boundary_kind = ?, deferred_action_json = ?
           WHERE id = ? AND state = 'boundary_waiting' RETURNING *`,
        ).get(boundary, actionJson, requested.id);
        if (!upgraded) throw new Error('execution sync boundary race');
        return mapExecutionSync(upgraded);
      }
      const row = this.db
        .query<ExecutionSyncRow, [string, string, number, number]>(
          `UPDATE issue_execution_syncs
           SET state = 'boundary_waiting', boundary_kind = ?, deferred_action_json = ?,
               acknowledged_ts = ?
           WHERE id = ? AND state = 'requested'
           RETURNING *`,
        )
        .get(boundary, actionJson, Date.now(), requested.id);
      if (!row) throw new Error('execution sync boundary race');
      return mapExecutionSync(row);
    });
    return hold();
  }

  decideExecutionSync(
    id: number,
    decision: IssueExecutionSyncDecision,
    actor: number,
  ): IssueExecutionSync {
    const target: Exclude<IssueExecutionSyncState, 'requested' | 'boundary_waiting' | 'stale'> =
      decision === 'apply' ? 'applied' : decision === 'ignore' ? 'ignored' : 'supplemented';
    const decide = this.db.transaction(() => {
      const existing = this.getExecutionSync(id);
      if (!existing) throw new Error('execution sync does not exist');
      if (existing.state === target) return existing;
      if (existing.state !== 'boundary_waiting') throw new Error('execution sync decision conflict');
      const resumeKey = `issue-sync:${randomUUID()}`;
      const row = this.db
        .query<ExecutionSyncRow, [string, number, number, string, number]>(
          `UPDATE issue_execution_syncs
           SET state = ?, decided_by = ?, decided_ts = ?, resume_state = 'pending', resume_key = ?
           WHERE id = ? AND state = 'boundary_waiting'
           RETURNING *`,
        )
        .get(target, actor, Date.now(), resumeKey, id);
      if (!row) throw new Error('execution sync decision race');
      return mapExecutionSync(row);
    });
    return decide();
  }

  listResumableExecutionSyncs(limit: number): IssueExecutionSync[] {
    return this.db
      .query<ExecutionSyncRow, [number]>(
        `SELECT * FROM issue_execution_syncs
         WHERE state IN ('applied', 'ignored', 'supplemented')
           AND deferred_action_json IS NOT NULL
           AND resume_state = 'pending'
         ORDER BY decided_ts, id LIMIT ?`,
      )
      .all(limit)
      .map(mapExecutionSync);
  }

  getExecutionSyncEffectReceipt(id: number): IssueExecutionSyncEffectReceipt | null {
    const row = this.db
      .query<ExecutionSyncEffectReceiptRow, [number]>(
        'SELECT * FROM issue_execution_sync_effect_receipts WHERE sync_id = ?',
      )
      .get(id);
    return row ? mapExecutionSyncEffectReceipt(row) : null;
  }

  claimExecutionSyncResume(id: number, now: number): IssueExecutionSync | null {
    const claim = this.db.transaction(() => {
      const receipt = this.getExecutionSyncEffectReceipt(id);
      if (receipt) {
        this.db.query(
          `UPDATE issue_execution_syncs
           SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
               resumed_ts = COALESCE(resumed_ts, ?)
           WHERE id = ? AND resume_key = ? AND resume_state <> 'complete'`,
        ).run(receipt.completedTs, id, receipt.resumeKey);
        return null;
      }
      const token = randomUUID();
      const row = this.db
        .query<ExecutionSyncRow, [string, number, number]>(
          `UPDATE issue_execution_syncs
           SET resume_state = 'running', resume_token = ?, resume_claimed_ts = ?
           WHERE id = ?
             AND state IN ('applied', 'ignored', 'supplemented')
             AND deferred_action_json IS NOT NULL
             AND resume_state = 'pending'
           RETURNING *`,
        )
        .get(token, now, id);
      return row ? mapExecutionSync(row) : null;
    });
    return claim();
  }

  releaseExecutionSyncResume(id: number, token: string): void {
    this.db.query(
      `UPDATE issue_execution_syncs
       SET resume_state = 'pending', resume_token = NULL, resume_claimed_ts = NULL
       WHERE id = ? AND resume_state = 'running' AND resume_token = ?`,
    ).run(id, token);
  }

  resetAbandonedExecutionSyncResume(id: number, resumeKey: string, abandonedToken: string): boolean {
    if (!resumeKey || !abandonedToken) return false;
    const reset = this.db.transaction(() => {
      const owned = this.db.query<{ id: number }, [number, string, string]>(
        `SELECT id FROM issue_execution_syncs
         WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
      ).get(id, resumeKey, abandonedToken);
      if (!owned) return false;
      const receipt = this.getExecutionSyncEffectReceipt(id);
      if (receipt) {
        return this.db.query(
          `UPDATE issue_execution_syncs
           SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
               resumed_ts = COALESCE(resumed_ts, ?)
           WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
        ).run(receipt.completedTs, id, resumeKey, abandonedToken).changes === 1;
      }
      return this.db.query(
        `UPDATE issue_execution_syncs
         SET resume_state = 'pending', resume_token = NULL, resume_claimed_ts = NULL
         WHERE id = ? AND resume_state = 'running' AND resume_key = ? AND resume_token = ?`,
      ).run(id, resumeKey, abandonedToken).changes === 1;
    });
    return reset();
  }

  completeExecutionSyncResume(id: number, token: string): boolean {
    const result = this.db.query(
      `UPDATE issue_execution_syncs
       SET resume_state = 'complete', resume_token = NULL, resume_claimed_ts = NULL,
           resumed_ts = COALESCE(resumed_ts, receipt.completed_ts)
       FROM issue_execution_sync_effect_receipts receipt
       WHERE issue_execution_syncs.id = ?
         AND issue_execution_syncs.resume_state = 'running'
         AND issue_execution_syncs.resume_token = ?
         AND receipt.sync_id = issue_execution_syncs.id
         AND receipt.resume_key = issue_execution_syncs.resume_key`,
    ).run(id, token);
    return result.changes === 1;
  }

  commitExecutionSyncEffect<Result>(
    id: number,
    token: string,
    effect: (
      sync: IssueExecutionSync,
      context: IssueExecutionSyncEffectContext,
    ) => SynchronousCallbackResult<Result>,
  ): { applied: boolean; result: Result } {
    if (isDeclaredAsyncFunction(effect)) {
      throw new Error('execution sync effect callback must be synchronous');
    }
    const commit = this.db.transaction(() => {
      const row = this.db.query<ExecutionSyncRow, [number, string]>(
        `SELECT * FROM issue_execution_syncs
         WHERE id = ? AND resume_state = 'running' AND resume_token = ?`,
      ).get(id, token);
      if (!row || !row.resume_key) throw new Error('execution sync resume claim lost');
      const existing = this.getExecutionSyncEffectReceipt(id);
      if (existing) {
        if (!this.completeExecutionSyncResume(id, token)) throw new Error('execution sync resume claim lost');
        return { applied: false, result: existing.result as Result };
      }
      const sync = mapExecutionSync(row);
      const context: IssueExecutionSyncEffectContext = Object.freeze({
        enqueueExternalEffect: (intentKey: string, kind: string, payload: unknown): void => {
          if (!this.db.inTransaction) throw new Error('execution sync effect intent requires active transaction');
          const stableIntentKey = intentKey.trim();
          const stableKind = kind.trim();
          if (!stableIntentKey || stableIntentKey.length > 120 || !stableKind || stableKind.length > 80) {
            throw new Error('invalid execution sync effect intent');
          }
          const payloadJson = JSON.stringify(payload);
          if (payloadJson === undefined || payloadJson.length > MAX_EXECUTION_SYNC_JSON) {
            throw new Error('invalid execution sync effect intent payload');
          }
          this.db.query(
            `INSERT INTO issue_execution_sync_effect_outbox
               (resume_key, sync_id, intent_key, kind, payload_json, created_ts)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).run(row.resume_key, id, stableIntentKey, stableKind, payloadJson, Date.now());
        },
      });
      const result = effect(sync, context);
      if (isThenable(result)) throw new Error('execution sync effect callback must be synchronous');
      const resultJson = encodeExecutionSyncEffectResult(result);
      const completedTs = Date.now();
      this.db.query(
        `INSERT INTO issue_execution_sync_effect_receipts
           (resume_key, sync_id, result_json, completed_ts)
         VALUES (?, ?, ?, ?)`,
      ).run(row.resume_key, id, resultJson, completedTs);
      if (!this.completeExecutionSyncResume(id, token)) throw new Error('execution sync resume claim lost');
      return { applied: true, result };
    });
    return commit();
  }
}

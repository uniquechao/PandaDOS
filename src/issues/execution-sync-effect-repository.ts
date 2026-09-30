import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import { MAX_EXECUTION_SYNC_JSON } from './execution-sync-types';

/** Durable delivery state and receipts for execution-sync external actions. */
export interface IssueExecutionSyncEffectOutboxItem {
  resumeKey: string;
  syncId: number;
  intentKey: string;
  kind: string;
  payload: unknown;
  createdTs: number;
  deliveredTs: number | null;
  deliveryState: 'pending' | 'dispatching' | 'delivered' | 'uncertain';
  deliveryToken: string | null;
  dispatchStartedTs: number | null;
}

interface ExecutionSyncEffectOutboxRow {
  resume_key: string;
  sync_id: number;
  intent_key: string;
  kind: string;
  payload_json: string;
  created_ts: number;
  delivered_ts: number | null;
  delivery_state: IssueExecutionSyncEffectOutboxItem['deliveryState'];
  delivery_token: string | null;
  dispatch_started_ts: number | null;
}

function mapEffect(row: ExecutionSyncEffectOutboxRow): IssueExecutionSyncEffectOutboxItem {
  return {
    resumeKey: row.resume_key,
    syncId: row.sync_id,
    intentKey: row.intent_key,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    createdTs: row.created_ts,
    deliveredTs: row.delivered_ts,
    deliveryState: row.delivery_state,
    deliveryToken: row.delivery_token,
    dispatchStartedTs: row.dispatch_started_ts,
  };
}

export class ExecutionSyncEffectRepository {
  constructor(private readonly db: Database) {}

  hasUnresolved(issueId: IssueId): boolean {
    return this.db.query<{ found: number }, [IssueId]>(
      `SELECT 1 AS found
       FROM issue_execution_sync_effect_outbox effect
       JOIN issue_execution_syncs sync ON sync.id = effect.sync_id
       WHERE sync.issue_id = ? AND effect.delivery_state <> 'delivered'
       LIMIT 1`,
    ).get(issueId) !== null;
  }

  listExecutionSyncEffectOutbox(limit: number): IssueExecutionSyncEffectOutboxItem[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE delivery_state = 'pending' ORDER BY created_ts, sync_id, intent_key LIMIT ?`,
    ).all(bounded).map(mapEffect);
  }

  listUncertainExecutionSyncEffects(limit: number): IssueExecutionSyncEffectOutboxItem[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE delivery_state IN ('dispatching', 'uncertain')
       ORDER BY created_ts, sync_id, intent_key LIMIT ?`,
    ).all(bounded).map(mapEffect);
  }

  getUncertainExecutionSyncEffect(syncId: number): IssueExecutionSyncEffectOutboxItem | null {
    const row = this.db.query<ExecutionSyncEffectOutboxRow, [number]>(
      `SELECT * FROM issue_execution_sync_effect_outbox
       WHERE sync_id = ? AND delivery_state IN ('dispatching', 'uncertain')
       ORDER BY created_ts, intent_key LIMIT 1`,
    ).get(syncId);
    return row ? mapEffect(row) : null;
  }

  resolveUncertainExecutionSyncEffect(
    resumeKey: string,
    intentKey: string,
    resolution: 'confirm_delivered' | 'retry',
  ): boolean {
    if (resolution === 'confirm_delivered') {
      return this.db.query(
        `UPDATE issue_execution_sync_effect_outbox
         SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
             delivery_token = NULL, last_error = NULL
         WHERE resume_key = ? AND intent_key = ?
           AND delivery_state IN ('dispatching', 'uncertain')`,
      ).run(Date.now(), resumeKey, intentKey).changes === 1;
    }
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'pending', delivery_token = NULL, dispatch_started_ts = NULL,
           last_error = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state IN ('dispatching', 'uncertain')`,
    ).run(resumeKey, intentKey).changes === 1;
  }

  claimExecutionSyncEffectDelivery(
    resumeKey: string,
    intentKey: string,
    now: number,
  ): IssueExecutionSyncEffectOutboxItem | null {
    const token = randomUUID();
    const row = this.db.query<ExecutionSyncEffectOutboxRow, [string, number, string, string]>(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'dispatching', delivery_token = ?, dispatch_started_ts = ?, last_error = NULL
       WHERE resume_key = ? AND intent_key = ? AND delivery_state = 'pending'
       RETURNING *`,
    ).get(token, now, resumeKey, intentKey);
    return row ? mapEffect(row) : null;
  }

  recordExecutionSyncEffectStep(
    resumeKey: string,
    intentKey: string,
    deliveryToken: string,
    stepKey: string,
    payload: unknown,
  ): boolean {
    const payloadJson = JSON.stringify(payload);
    if (!stepKey || stepKey.length > 80 || payloadJson === undefined || payloadJson.length > MAX_EXECUTION_SYNC_JSON) {
      throw new Error('invalid execution sync effect step');
    }
    const record = this.db.transaction(() => {
      const owned = this.db.query<{ found: number }, [string, string, string]>(
        `SELECT 1 AS found FROM issue_execution_sync_effect_outbox
         WHERE resume_key = ? AND intent_key = ? AND delivery_state = 'dispatching' AND delivery_token = ?`,
      ).get(resumeKey, intentKey, deliveryToken);
      if (!owned) return false;
      this.db.query(
        `INSERT INTO issue_execution_sync_effect_steps
           (resume_key, intent_key, step_key, payload_json, completed_ts)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(resumeKey, intentKey, stepKey, payloadJson, Date.now());
      return true;
    });
    return record();
  }

  reconcileCompletedExecutionSyncEffectDeliveries(limit: number): number {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.db.query<{ resume_key: string; intent_key: string }, [number]>(
      `SELECT o.resume_key, o.intent_key
       FROM issue_execution_sync_effect_outbox o
       JOIN issue_execution_sync_effect_steps s
         ON s.resume_key = o.resume_key AND s.intent_key = o.intent_key AND s.step_key = 'action-complete'
       WHERE o.delivery_state IN ('dispatching', 'uncertain')
       ORDER BY o.created_ts, o.sync_id, o.intent_key LIMIT ?`,
    ).all(bounded);
    let reconciled = 0;
    for (const row of rows) {
      reconciled += this.db.query(
        `UPDATE issue_execution_sync_effect_outbox
         SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
             delivery_token = NULL, last_error = NULL
         WHERE resume_key = ? AND intent_key = ? AND delivery_state IN ('dispatching', 'uncertain')`,
      ).run(Date.now(), row.resume_key, row.intent_key).changes;
    }
    return reconciled;
  }

  markExecutionSyncEffectDelivered(resumeKey: string, intentKey: string, deliveryToken: string): boolean {
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'delivered', delivered_ts = COALESCE(delivered_ts, ?),
           delivery_token = NULL, last_error = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state = 'dispatching' AND delivery_token = ?`,
    ).run(Date.now(), resumeKey, intentKey, deliveryToken).changes === 1;
  }

  markExecutionSyncEffectUncertain(
    resumeKey: string,
    intentKey: string,
    deliveryToken: string,
    error: string,
  ): boolean {
    return this.db.query(
      `UPDATE issue_execution_sync_effect_outbox
       SET delivery_state = 'uncertain', last_error = ?, delivery_token = NULL
       WHERE resume_key = ? AND intent_key = ?
         AND delivery_state = 'dispatching' AND delivery_token = ?`,
    ).run(error.slice(0, 4000), resumeKey, intentKey, deliveryToken).changes === 1;
  }
}

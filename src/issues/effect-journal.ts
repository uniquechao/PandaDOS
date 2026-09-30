import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import { InputSubmitUnconfirmedError } from '../executor/driver';

interface EffectRow {
  project_id: number;
  executor_id: number;
  target: string;
  input_sha256: string;
  status: 'running' | 'confirmed' | 'uncertain';
}

export interface InterruptedIssueEffect {
  issueId: IssueId;
  operationKey: string;
}

export type EffectReconciliation = 'confirmed' | 'absent' | 'unknown';

export interface IssueEffectInput {
  issueId: IssueId;
  operationKey: string;
  projectId: number;
  executorId: number;
  target: string;
  input: string;
}

/** A durable, fail-closed boundary for non-idempotent external actions. */
export class IssueEffectJournal {
  constructor(private readonly db: Database, private readonly now: () => number = () => Date.now()) {}

  /** Called once when the sole control-plane process starts. A prior process may have sent the
   * action before losing its receipt; no caller may treat that claim as retryable work. */
  reconcileInterrupted(): InterruptedIssueEffect[] {
    return this.db.transaction(() => {
      const rows = this.db.query<{ issue_id: IssueId; operation_key: string }, []>(
        "SELECT issue_id, operation_key FROM issue_effect_journal WHERE status = 'running'",
      ).all();
      if (rows.length) this.db.query(
        `UPDATE issue_effect_journal SET status = 'uncertain', error = 'interrupted before confirmation', updated_ts = ?
         WHERE status = 'running'`,
      ).run(this.now());
      return rows.map((row) => ({ issueId: row.issue_id, operationKey: row.operation_key }));
    })();
  }

  hasUncertainInput(issueId: IssueId): boolean {
    return this.db.query<{ found: number }, [IssueId]>(
      "SELECT 1 AS found FROM issue_effect_journal WHERE issue_id = ? AND status = 'uncertain' AND target NOT LIKE 'notify:%' AND target NOT LIKE 'git:%' LIMIT 1",
    ).get(issueId) !== null;
  }

  statusOf(issueId: IssueId, operationKey: string): EffectRow['status'] | null {
    return this.db.query<{ status: EffectRow['status'] }, [IssueId, string]>(
      'SELECT status FROM issue_effect_journal WHERE issue_id = ? AND operation_key = ?',
    ).get(issueId, operationKey)?.status ?? null;
  }

  targetOf(issueId: IssueId, operationKey: string): string | null {
    return this.db.query<{ target: string }, [IssueId, string]>(
      'SELECT target FROM issue_effect_journal WHERE issue_id = ? AND operation_key = ?',
    ).get(issueId, operationKey)?.target ?? null;
  }

  async runOnce(
    input: IssueEffectInput,
    execute: () => Promise<void>,
    reconcile?: () => Promise<EffectReconciliation>,
  ): Promise<'performed' | 'confirmed'> {
    const digest = createHash('sha256').update(input.input).digest('hex');
    const claim = this.db.transaction(() => {
      const existing = this.db.query<EffectRow, [IssueId, string]>(
        'SELECT project_id, executor_id, target, input_sha256, status FROM issue_effect_journal WHERE issue_id = ? AND operation_key = ?',
      ).get(input.issueId, input.operationKey);
      if (existing) {
        if (existing.project_id !== input.projectId || existing.executor_id !== input.executorId
          || existing.target !== input.target || existing.input_sha256 !== digest) return 'mismatch' as const;
        return existing.status;
      }
      const ts = this.now();
      this.db.query(
        `INSERT INTO issue_effect_journal
         (issue_id, operation_key, project_id, executor_id, target, input_sha256, status, created_ts, updated_ts)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(input.issueId, input.operationKey, input.projectId, input.executorId, input.target, digest, ts, ts);
      return 'claimed' as const;
    })();
    if (claim === 'confirmed') return 'confirmed';
    if (claim !== 'claimed') {
      if (claim !== 'mismatch' && reconcile) {
        try {
          const observed = await reconcile();
          if (observed === 'confirmed') {
            this.db.query(
              `UPDATE issue_effect_journal SET status = 'confirmed', error = NULL, updated_ts = ?
               WHERE issue_id = ? AND operation_key = ? AND status IN ('running', 'uncertain')`,
            ).run(this.now(), input.issueId, input.operationKey);
            return 'confirmed';
          }
          // Only a queryable operation whose absence and original preconditions are proven may
          // return absent. Terminal input and provider notifications must always return unknown.
          if (observed === 'absent' && claim === 'uncertain') {
            const reset = this.db.query(
              `UPDATE issue_effect_journal SET status = 'running', error = NULL, updated_ts = ?
               WHERE issue_id = ? AND operation_key = ? AND status = 'uncertain'`,
            ).run(this.now(), input.issueId, input.operationKey);
            if (reset.changes === 1) return this.performClaimed(input, execute);
          }
        } catch {
          // A failed probe is not evidence that the external operation did not happen.
        }
      }
      if (claim === 'running') this.markUncertain(input, 'interrupted before confirmation');
      throw new InputSubmitUnconfirmedError(
        claim === 'mismatch' ? '耐久动作的执行位置或输入与原意图不一致，已停止注入'
          : '此前终端注入结果不确定，已停止自动重发并保留现场',
      );
    }
    return this.performClaimed(input, execute);
  }

  private async performClaimed(input: IssueEffectInput, execute: () => Promise<void>): Promise<'performed'> {
    try {
      await execute();
      const result = this.db.query(
        `UPDATE issue_effect_journal SET status = 'confirmed', updated_ts = ?
         WHERE issue_id = ? AND operation_key = ? AND status = 'running'`,
      ).run(this.now(), input.issueId, input.operationKey);
      if (result.changes !== 1) throw new Error('effect claim changed before confirmation');
      return 'performed';
    } catch (error) {
      this.markUncertain(input, String(error).slice(0, 500));
      throw new InputSubmitUnconfirmedError(
        `外部动作未能确认；已记为不确定，需检查现场后恢复：${String(error).slice(0, 300)}`,
      );
    }
  }

  private markUncertain(input: IssueEffectInput, error: string): void {
    this.db.query(
      `UPDATE issue_effect_journal SET status = 'uncertain', error = ?, updated_ts = ?
       WHERE issue_id = ? AND operation_key = ? AND status = 'running'`,
    ).run(error, this.now(), input.issueId, input.operationKey);
  }
}

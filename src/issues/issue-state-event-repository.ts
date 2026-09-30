import type { Database } from 'bun:sqlite';
import type { IssueEvent, IssueState } from '../core/types';
import type { IssueId } from '../../shared/issue-id';
import { serializeCompletionReport, type CompletionReport } from './completion-report';

interface EventRow {
  id: number;
  issue_id: IssueId;
  kind: string;
  data_json: string | null;
  ts: number;
}

function mapEvent(row: EventRow): IssueEvent {
  return { id: row.id, issueId: row.issue_id, kind: row.kind, dataJson: row.data_json, ts: row.ts };
}

/** Persistence primitives for issue state and its durable event timeline. No decisions or I/O. */
export class IssueStateEventRepository {
  constructor(private readonly db: Database) {}

  casStatus(id: IssueId, from: IssueState, to: IssueState): boolean {
    const result = this.db.query(
      `UPDATE issues SET status = ?, done_ts = CASE WHEN ? = 'done' THEN ? ELSE done_ts END
       WHERE id = ? AND status = ?`,
    ).run(to, to, Date.now(), id, from);
    return result.changes > 0;
  }

  setBranch(id: IssueId, branch: string): void {
    this.db.query('UPDATE issues SET branch = ? WHERE id = ?').run(branch, id);
  }

  setNote(id: IssueId, note: string | null): void {
    this.db.query('UPDATE issues SET note = ? WHERE id = ?').run(note, id);
  }

  setCompletionReport(id: IssueId, report: CompletionReport | null): void {
    this.db.query('UPDATE issues SET completion_report_json = ? WHERE id = ?')
      .run(report ? serializeCompletionReport(report) : null, id);
  }

  clearRunState(id: IssueId): void {
    this.db.query(
      'UPDATE issues SET plan_json = NULL, subtasks_json = NULL, sub_index = 0, note = NULL, done_ts = NULL, result_summary = NULL, completion_report_json = NULL WHERE id = ?',
    ).run(id);
  }

  logEvent(issueId: IssueId, kind: string, data?: Record<string, unknown>): void {
    this.db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(issueId, kind, data ? JSON.stringify(data) : null, Date.now());
  }

  listEvents(issueId: IssueId): IssueEvent[] {
    return this.db.query<EventRow, [IssueId]>('SELECT * FROM issue_events WHERE issue_id = ? ORDER BY id')
      .all(issueId).map(mapEvent);
  }

  recentEvents(issueId: IssueId, kind: string, limit = 200): IssueEvent[] {
    return this.db.query<EventRow, [IssueId, string, number]>(
      'SELECT * FROM issue_events WHERE issue_id = ? AND kind = ? ORDER BY id DESC LIMIT ?',
    ).all(issueId, kind, limit).map(mapEvent);
  }

  lastProjectEvent(projectId: number, kind: string): IssueEvent | null {
    const row = this.db.query<EventRow, [number, string]>(
      `SELECT e.* FROM issue_events e
       JOIN issues i ON i.id = e.issue_id
       WHERE i.project_id = ? AND e.kind = ?
       ORDER BY e.ts DESC, e.id DESC LIMIT 1`,
    ).get(projectId, kind);
    return row ? mapEvent(row) : null;
  }

  listProjectEvents(projectId: number, kind: string): IssueEvent[] {
    return this.db.query<EventRow, [number, string]>(
      `SELECT e.* FROM issue_events e
       JOIN issues i ON i.id = e.issue_id
       WHERE i.project_id = ? AND e.kind = ?
       ORDER BY e.id`,
    ).all(projectId, kind).map(mapEvent);
  }

  countEvents(issueId: IssueId, kind: string): number {
    return this.db.query<{ n: number }, [IssueId, string]>(
      'SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND kind = ?',
    ).get(issueId, kind)?.n ?? 0;
  }

  lastEventId(issueId: IssueId, kind: string): number {
    return this.db.query<{ id: number }, [IssueId, string]>(
      'SELECT id FROM issue_events WHERE issue_id = ? AND kind = ? ORDER BY id DESC LIMIT 1',
    ).get(issueId, kind)?.id ?? 0;
  }

  countEventsSince(issueId: IssueId, kind: string, afterEventId: number): number {
    return this.db.query<{ n: number }, [IssueId, string, number]>(
      'SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND kind = ? AND id > ?',
    ).get(issueId, kind, afterEventId)?.n ?? 0;
  }
}

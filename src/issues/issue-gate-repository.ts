import type { Database } from 'bun:sqlite';
import type { Gate, GateKind, GateStatus } from '../core/types';
import type { IssueId } from '../../shared/issue-id';

interface GateRow {
  id: number;
  issue_id: IssueId;
  kind: string;
  status: string;
  payload_json: string | null;
  decided_by: number | null;
  decided_ts: number | null;
}

function mapGate(row: GateRow): Gate {
  return {
    id: row.id, issueId: row.issue_id, kind: row.kind as GateKind,
    status: row.status as GateStatus, payloadJson: row.payload_json,
    decidedBy: row.decided_by, decidedTs: row.decided_ts,
  };
}

/** Persistence and one-shot CAS for review gates; lifecycle decisions remain with IssueEngine. */
export class IssueGateRepository {
  constructor(private readonly db: Database) {}

  createGate(issueId: IssueId, kind: GateKind, payload: Record<string, unknown>): Gate {
    const row = this.db.query<GateRow, [IssueId, string, string]>(
      'INSERT INTO gates (issue_id, kind, payload_json) VALUES (?, ?, ?) RETURNING *',
    ).get(issueId, kind, JSON.stringify(payload));
    if (!row) throw new Error('insert gate failed');
    return mapGate(row);
  }

  getGate(id: number): Gate | undefined {
    const row = this.db.query<GateRow, [number]>('SELECT * FROM gates WHERE id = ?').get(id);
    return row ? mapGate(row) : undefined;
  }

  listGates(issueId: IssueId): Gate[] {
    return this.db.query<GateRow, [IssueId]>('SELECT * FROM gates WHERE issue_id = ? ORDER BY id')
      .all(issueId).map(mapGate);
  }

  decideGate(id: number, status: 'approved' | 'rejected', userId: number, note?: string): boolean {
    const gate = this.getGate(id);
    if (!gate) return false;
    let payload: Record<string, unknown> = {};
    try { payload = gate.payloadJson ? JSON.parse(gate.payloadJson) as Record<string, unknown> : {}; }
    catch { payload = {}; }
    if (note) payload.decisionNote = note.slice(0, 2000);
    return this.db.query(
      `UPDATE gates SET status = ?, decided_by = ?, decided_ts = ?, payload_json = ?
       WHERE id = ? AND status = 'waiting'`,
    ).run(status, userId, Date.now(), JSON.stringify(payload), id).changes > 0;
  }

  expireWaitingGates(issueId: IssueId): void {
    this.db.query("UPDATE gates SET status = 'rejected', decided_ts = ? WHERE issue_id = ? AND status = 'waiting'")
      .run(Date.now(), issueId);
  }
}

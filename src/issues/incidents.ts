import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type { IssueId } from '../../shared/issue-id';
import type { IssueIncident, IncidentMessage } from '../../shared/issue-incidents';
import { redactDiagnostic } from '../../shared/issue-diagnostics';
import type { EngineIssue } from './engine';

const incidentColumns = `id,issue_id AS issueId,project_id AS projectId,stop_event_id AS stopEventId,
 attempt_id AS attemptId,state,run_state AS runState,locale,error,created_ts AS createdTs`;
const messageColumns = `id,role,content,request_key AS requestKey,state,created_ts AS createdTs`;
export class IssueIncidentStore {
  constructor(readonly db: Database) {}
  get(id: string): IssueIncident | null {
    return this.db.query<IssueIncident,[string]>(`SELECT ${incidentColumns} FROM issue_incidents WHERE id=?`).get(id);
  }
  held(issueId: IssueId): boolean {
    return !!this.db.query("SELECT 1 FROM issue_incidents WHERE issue_id=? AND state='open'").get(issueId);
  }
  active(issueId: IssueId): IssueIncident | null {
    return this.db.query<IssueIncident,[IssueId]>(`SELECT ${incidentColumns} FROM issue_incidents WHERE issue_id=? ORDER BY created_ts DESC,rowid DESC LIMIT 1`).get(issueId);
  }
  open(issue: EngineIssue, stop: number, attemptId: string | null, actor: number, locale: string): IssueIncident {
    if (!['paused','blocked'].includes(issue.status) || !stop) throw new Error('incident_not_stopped');
    const id = randomUUID();
    this.db.query(`INSERT OR IGNORE INTO issue_incidents(id,issue_id,project_id,stop_event_id,attempt_id,created_by,locale,created_ts) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id,issue.id,issue.projectId,stop,attemptId,actor,locale,Date.now());
    this.db.query("UPDATE issue_incidents SET state='stale' WHERE issue_id=? AND stop_event_id<>? AND state IN ('open','queued')").run(issue.id,stop);
    return this.db.query<IssueIncident,[IssueId,number]>(`SELECT ${incidentColumns} FROM issue_incidents WHERE issue_id=? AND stop_event_id=?`).get(issue.id,stop)!;
  }
  messages(id: string): IncidentMessage[] {
    return this.db.query<IncidentMessage,[string]>(`SELECT * FROM (SELECT ${messageColumns} FROM issue_incident_messages WHERE incident_id=? ORDER BY id DESC LIMIT 200) ORDER BY id`).all(id);
  }
  enqueue(id: string, key: string, text: string, actor: number): IncidentMessage {
    return this.db.transaction(() => {
      const content = redactDiagnostic(text.trim());
      if (!key || key.length > 100 || !content || content.length > 4000) throw new Error('incident_invalid_message');
      const existing = this.messages(id).find(m => m.requestKey === key && m.role === 'user');
      if (existing) { if (existing.content !== content) throw new Error('incident_request_conflict'); return existing; }
      const current = this.get(id);
      if (current?.state !== 'open') throw new Error('incident_stale');
      if (current.runState === 'running' || current.runState === 'queued') throw new Error('incident_busy');
      if (this.messages(id).filter(m => m.role === 'user').length >= 100) throw new Error('incident_turn_limit');
      this.db.query(`INSERT INTO issue_incident_messages(incident_id,role,content,request_key,state,actor,created_ts) VALUES(?,'user',?,?,'queued',?,?)`).run(id,content,key,actor,Date.now());
      this.db.query("UPDATE issue_incidents SET run_state='queued',error=NULL WHERE id=?").run(id);
      return this.messages(id).at(-1)!;
    })();
  }
  claim(id: string): IncidentMessage | null {
    return this.db.transaction(() => {
      const row = this.get(id);
      if (row?.state !== 'open' || row.runState !== 'queued') return null;
      const turn = this.messages(id).find(m => m.role === 'user' && m.state === 'queued');
      if (!turn) return null;
      this.db.query("UPDATE issue_incidents SET run_state='running' WHERE id=?").run(id);
      this.db.query("UPDATE issue_incident_messages SET state='running' WHERE id=?").run(turn.id);
      return turn;
    })();
  }
  finish(id: string, turnId: number, text: string, error = false): void {
    this.db.transaction(() => {
      const turn = this.messages(id).find(m => m.id === turnId && m.state === 'running');
      if (!turn) return;
      const content = redactDiagnostic(text).slice(0,16000);
      this.db.query('UPDATE issue_incident_messages SET state=? WHERE id=?').run(error ? 'failed' : 'done',turnId);
      if (!error) this.db.query(`INSERT INTO issue_incident_messages(incident_id,role,content,request_key,state,created_ts) VALUES(?,'assistant',?,?,'done',?)`).run(id,content,turn.requestKey,Date.now());
      this.db.query('UPDATE issue_incidents SET run_state=?,error=? WHERE id=?').run(error ? 'failed' : 'idle',error ? content : null,id);
    })();
  }
  interrupt(): void {
    this.db.transaction(() => {
      this.db.query("UPDATE issue_incident_messages SET state='interrupted' WHERE state IN ('queued','running')").run();
      this.db.query("UPDATE issue_incidents SET run_state='interrupted',error='incident_interrupted' WHERE run_state IN ('queued','running')").run();
    })();
  }
  state(id: string, state: IssueIncident['state']): void { this.db.query('UPDATE issue_incidents SET state=? WHERE id=?').run(state,id); }
  evidence(id: string): string { return this.db.query<{evidence:string},[string]>('SELECT evidence FROM issue_incidents WHERE id=?').get(id)?.evidence ?? ''; }
  setEvidence(id: string, evidence: string): void { this.db.query('UPDATE issue_incidents SET evidence=? WHERE id=?').run(redactDiagnostic(evidence).slice(0,60000),id); }
  receipt(id: string, key: string, kind: string, payload: string): string | null {
    const row = this.db.query<{kind:string;payload:string;result:string},[string,string]>('SELECT * FROM issue_incident_receipts WHERE incident_id=? AND request_key=?').get(id,key);
    if (!row) return null;
    if (row.kind !== kind || row.payload !== payload) throw new Error('incident_request_conflict');
    return row.result;
  }
  saveReceipt(id: string, key: string, kind: string, payload: string, result: string): void {
    if (!key || key.length > 100) throw new Error('incident_invalid_request');
    this.db.query('INSERT INTO issue_incident_receipts VALUES(?,?,?,?,?)').run(id,key,kind,payload,result);
  }
}

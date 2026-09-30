import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import type { RoomIssueAnswerReceipt, RoomIssueFeedback, RoomIssueFeedbackEvent } from '../../shared/room-issues';
import { RoomError, type RoomCommandMeta, type RoomScope } from '../rooms/contracts';
import type { IssueEngine } from '../issues/engine';

interface EventRow { id: number; kind: string; data_json: string | null; ts: number }
const parse = (json: string | null): Record<string, unknown> => {
  try { const value: unknown = JSON.parse(json ?? '{}'); return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
};
const stateKinds: Record<string, RoomIssueFeedbackEvent['kind']> = { planning: 'started', implementing: 'started', blocked: 'blocked', paused: 'paused', done: 'done', cancelled: 'cancelled' };

/** Whitelisted issue facts only. Raw event payloads, terminal output and tool logs never leave here. */
export class RoomIssueFeedbackService {
  constructor(private readonly db: Database, private readonly issues: Pick<IssueEngine, 'clarify'>) {}

  private links(scope: RoomScope) {
    return this.db.query<{ issue_id: IssueId; mission_id: string; artifact_id: string; artifact_revision: number; title: string; status: string; result_summary: string | null }, [number, string]>(
      `SELECT link.issue_id,link.mission_id,link.artifact_id,link.artifact_revision,issue.title,issue.status,issue.result_summary
       FROM room_issue_links link JOIN issues issue ON issue.id=link.issue_id AND issue.project_id=link.project_id
       WHERE link.project_id=? AND link.room_id=? ORDER BY link.created_ts DESC LIMIT 100`,
    ).all(scope.projectId, scope.roomId);
  }

  sync(scope: RoomScope): void {
    const pending = this.db.query(`SELECT 1 FROM room_issue_links link
      JOIN issues issue ON issue.id=link.issue_id AND issue.project_id=link.project_id
      LEFT JOIN room_issue_feedback_cursors cursor ON cursor.room_id=link.room_id AND cursor.issue_id=link.issue_id
      WHERE link.project_id=? AND link.room_id=? AND EXISTS (
        SELECT 1 FROM issue_events event WHERE event.issue_id=link.issue_id AND event.id>COALESCE(cursor.source_event_id,0)
      ) LIMIT 1`).get(scope.projectId, scope.roomId);
    if (!pending) return;
    this.db.transaction(() => {
      let changed = false;
      for (const link of this.links(scope)) {
        const cursor = this.db.query<{ source_event_id: number }, [string, IssueId]>('SELECT source_event_id FROM room_issue_feedback_cursors WHERE room_id=? AND issue_id=?').get(scope.roomId, link.issue_id)?.source_event_id ?? 0;
        const events = this.db.query<EventRow, [IssueId, number]>('SELECT id,kind,data_json,ts FROM issue_events WHERE issue_id=? AND id>? ORDER BY id LIMIT 500').all(link.issue_id, cursor);
        for (const event of events) {
          const data = parse(event.data_json);
          const kind = event.kind === 'transition' && typeof data.to === 'string' ? stateKinds[data.to]
            : event.kind === 'clarify_questions' ? 'clarification_needed'
            : event.kind === 'clarified' ? 'clarification_answered' : undefined;
          if (kind) {
            const result = this.db.query('INSERT OR IGNORE INTO room_issue_feedback VALUES(?,?,?,?,?,?)').run(scope.projectId, scope.roomId, link.issue_id, event.id, kind, event.ts);
            changed ||= result.changes > 0;
          }
        }
        if (events.length) this.db.query(`INSERT INTO room_issue_feedback_cursors VALUES(?,?,?,?)
          ON CONFLICT(room_id,issue_id) DO UPDATE SET source_event_id=excluded.source_event_id`).run(scope.projectId, scope.roomId, link.issue_id, events.at(-1)!.id);
      }
      if (changed) {
        this.db.query('UPDATE rooms SET event_seq=event_seq+1,updated_ts=? WHERE project_id=? AND id=?').run(Date.now(), scope.projectId, scope.roomId);
        this.db.query("INSERT INTO room_events(room_id,seq,type,entity_id,created_ts) SELECT id,event_seq,'issue_feedback',NULL,? FROM rooms WHERE project_id=? AND id=?").run(Date.now(), scope.projectId, scope.roomId);
      }
    }).immediate();
  }

  list(scope: RoomScope): RoomIssueFeedback[] {
    return this.links(scope).map(link => {
      const latest = this.db.query<EventRow, [IssueId]>("SELECT id,kind,data_json,ts FROM issue_events WHERE issue_id=? AND kind IN ('clarify_questions','clarified','clarify_timeout') ORDER BY id DESC LIMIT 1").get(link.issue_id);
      const data = latest?.kind === 'clarify_questions' ? parse(latest.data_json) : {};
      const questions = Array.isArray(data.questions) ? data.questions.filter((item): item is string => typeof item === 'string').slice(0, 20).map(item => item.slice(0, 4000)) : [];
      const events = this.db.query<{ source_event_id: number; kind: RoomIssueFeedbackEvent['kind']; created_ts: number }, [string, IssueId]>(
        'SELECT source_event_id,kind,created_ts FROM room_issue_feedback WHERE room_id=? AND issue_id=? ORDER BY source_event_id DESC LIMIT 40',
      ).all(scope.roomId, link.issue_id).reverse().map(event => ({ id: `${link.issue_id}:${event.source_event_id}`, sourceEventId: event.source_event_id, kind: event.kind, createdAt: event.created_ts }));
      return { issueId: link.issue_id, missionId: link.mission_id, artifactId: link.artifact_id, artifactVersion: link.artifact_revision,
        title: link.title, status: link.status, resultSummary: link.result_summary?.slice(0, 16000) ?? null,
        question: latest?.kind === 'clarify_questions' && questions.length ? { id: latest.id, questions } : null, events };
    });
  }

  async answer(scope: RoomScope, issueId: IssueId, questionId: number, answer: string, meta: RoomCommandMeta, authorize: () => void): Promise<RoomIssueAnswerReceipt> {
    authorize();
    if (!this.links(scope).some(link => link.issue_id === issueId)) throw new RoomError('not_found');
    if (!answer.trim() || answer.length > 4000 || !Number.isSafeInteger(questionId) || questionId <= 0) throw new RoomError('invalid_request');
    const result = await this.issues.clarify(issueId, answer, { questionId, requestKey: `room:${scope.roomId}:${meta.actor.userId}:${meta.key}`, actorUserId: meta.actor.userId, authorize });
    authorize();
    if (!result.ok) {
      if (result.error === 'clarification_delivery_uncertain') return { issueId, questionId, status: 'uncertain' };
      throw new RoomError('conflict');
    }
    this.sync(scope);
    return { issueId, questionId, status: 'accepted' };
  }
}

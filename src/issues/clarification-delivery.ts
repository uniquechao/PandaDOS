import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import type { ApplyResult } from './engine';
import type { IssueState } from './machine';

export interface ClarificationDeliveryInput {
  questionId: number;
  requestKey: string;
  actorUserId: number;
  /** Rechecked after asynchronous liveness work, immediately before delivery. */
  authorize?: () => void;
}
interface Event { id: number; kind: string; data_json: string | null }
const failure = (error: string): ApplyResult => ({ ok: false, error });
export class ClarificationNotDeliveredError extends Error {
  constructor(readonly original?: unknown) { super('clarification_not_delivered'); }
}

/** Durable per-question delivery receipts use the issue event log, not room state. */
export class ClarificationDelivery {
  private readonly busy = new Set<IssueId>();
  private readonly flights = new Set<Promise<ApplyResult>>();
  private closed = false;
  constructor(private readonly db: Database) {}

  close(): Promise<void> { this.closed=true;return Promise.allSettled([...this.flights]).then(()=>undefined); }
  reopen(): boolean { if(this.flights.size)return false;this.closed=false;return true; }
  run(issueId: IssueId, answer: string, input: ClarificationDeliveryInput | undefined, perform: (guard: () => void, deliveryKey?: string) => Promise<ApplyResult>): Promise<ApplyResult> {
    if(this.closed)return Promise.resolve(failure('clarification_delivery_stopped'));
    const flight=this.performRun(issueId,answer,input,perform);
    this.flights.add(flight);void flight.then(()=>this.flights.delete(flight),()=>this.flights.delete(flight));return flight;
  }
  private async performRun(issueId: IssueId, answer: string, input: ClarificationDeliveryInput | undefined, perform: (guard: () => void, deliveryKey?: string) => Promise<ApplyResult>): Promise<ApplyResult> {
    if (this.busy.has(issueId)) return failure('clarification_delivery_uncertain');
    const hash = createHash('sha256').update(answer).digest('hex');
    const log = (kind: string, extra = {}) => this.db.query('INSERT INTO issue_events(issue_id,kind,data_json,ts) VALUES(?,?,?,?)').run(issueId, kind, JSON.stringify({ requestKey: input?.requestKey, questionId: input?.questionId, actorUserId: input?.actorUserId, digest: hash, ...extra }), Date.now());
    const currentQuestion = () => this.db.query<Event, [IssueId]>("SELECT id,kind,data_json FROM issue_events WHERE issue_id=? AND kind IN ('clarify_questions','clarified','clarify_timeout') ORDER BY id DESC LIMIT 1").get(issueId);
    const guard = () => {
      if(this.closed)throw new ClarificationNotDeliveredError();
      try { input?.authorize?.(); } catch(error) { throw new ClarificationNotDeliveredError(error); }
      if (input) {
        const question = currentQuestion();
        if (question?.kind !== 'clarify_questions' || question.id !== input.questionId) throw new Error('clarification_question_changed');
      }
    };
    if (input) {
      if (!answer.trim() || answer.length > 4000 || !Number.isSafeInteger(input.questionId) || input.questionId < 1 || !input.requestKey || input.requestKey.length > 256) return failure('clarification_invalid');
      input.authorize?.();
      const prior = this.db.query<Event, [IssueId, string]>("SELECT id,kind,data_json FROM issue_events WHERE issue_id=? AND kind LIKE 'clarification_delivery_%' AND json_extract(data_json,'$.requestKey')=? ORDER BY id DESC LIMIT 1").get(issueId, input.requestKey);
      if (prior) {
        const data = JSON.parse(prior.data_json!) as { digest: string; questionId: number; actorUserId: number };
        if (data.digest !== hash || data.questionId !== input.questionId || data.actorUserId !== input.actorUserId) return failure('clarification_request_conflict');
        const accepted = prior.kind === 'clarification_delivery_accepted' || this.db.query("SELECT 1 FROM issue_events WHERE issue_id=? AND kind='clarified' AND json_extract(data_json,'$.deliveryKey')=?").get(issueId, input.requestKey);
        if (accepted) {
          const status = this.db.query<{ status: IssueState }, [IssueId]>('SELECT status FROM issues WHERE id=?').get(issueId)!.status;
          return { ok: true, from: status, to: status };
        }
        return failure(prior.kind === 'clarification_delivery_rejected' ? 'clarification_question_changed' : 'clarification_delivery_uncertain');
      }
    }
    this.busy.add(issueId);
    let claimed = false;
    try {
      this.db.transaction(() => {
        guard();
        // One unresolved intent per issue/question, including another room or process.
        const questionId = input?.questionId ?? (currentQuestion()?.kind === 'clarify_questions' ? currentQuestion()?.id : undefined);
        if (questionId !== undefined) {
          const pending = this.db.query<{ id: number }, [IssueId, number]>(`SELECT e.id FROM issue_events e WHERE e.issue_id=? AND e.kind='clarification_delivery_requested' AND json_extract(e.data_json,'$.questionId')=?
            AND NOT EXISTS (SELECT 1 FROM issue_events r WHERE r.issue_id=e.issue_id AND r.id>e.id AND r.kind IN ('clarification_delivery_accepted','clarification_delivery_rejected') AND json_extract(r.data_json,'$.requestKey')=json_extract(e.data_json,'$.requestKey'))
            AND NOT EXISTS (SELECT 1 FROM issue_events c WHERE c.issue_id=e.issue_id AND c.kind='clarified' AND json_extract(c.data_json,'$.deliveryKey')=json_extract(e.data_json,'$.requestKey')) LIMIT 1`).get(issueId, questionId);
          if (pending) throw new Error('clarification_delivery_uncertain');
        }
        if (input) {
          log('clarification_delivery_requested'); claimed = true;
        }
      }).immediate();
      const result = await perform(guard, input?.requestKey);
      if (claimed) log(result.ok ? 'clarification_delivery_accepted' : 'clarification_delivery_rejected');
      return result;
    } catch (error) {
      if(error instanceof ClarificationNotDeliveredError){
        if(claimed)log('clarification_delivery_rejected');
        if(error.original)throw error.original;
        return failure('clarification_not_delivered');
      }
      if (error instanceof Error && error.message === 'clarification_question_changed') {
        if (claimed) log('clarification_delivery_rejected');
        return failure('clarification_question_changed');
      }
      // A transport failure may follow a successful injection. Never resend blindly.
      if (claimed || error instanceof Error && error.message === 'clarification_delivery_uncertain') return failure('clarification_delivery_uncertain');
      throw error;
    } finally { this.busy.delete(issueId); }
  }
}

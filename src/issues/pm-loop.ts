import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { IssueState } from '../core/types';
import type { IssueId } from '../../shared/issue-id';
import { redactDiagnostic, redactDiagnosticValue } from '../../shared/issue-diagnostics';

export type PmLoopAction = 'wait' | 'continue' | 'verify' | 'recover' | 'clarify' | 'pause';
export interface PmLoopDecision {
 action: PmLoopAction;
 reason: string;
 instruction?: string;
 question?: string;
 waitSeconds?: number;
}
/** Facts are independently sampled by the engine, never accepted as a worker's self-diagnosis. */
export interface PmLoopObservation {
 issueId: IssueId;
 projectId: number;
 createdBy?: number | null;
 scopeKey: string;
 progressKey: string;
 status: IssueState;
 trigger?: string;
 allowedActions: readonly PmLoopAction[];
 facts: Record<string, unknown>;
}
export interface PmLoopConfig {
 idleMs: number;
 checkEveryMs: number;
 minWaitMs: number;
 maxWaitMs: number;
 decisionTimeoutMs: number;
 maxNoProgressRounds: number;
 maxInterventions: number;
 maxErrors: number;
}
export const DEFAULT_PM_LOOP_CONFIG: PmLoopConfig = {
 idleMs: 180_000, checkEveryMs: 30_000, minWaitMs: 60_000, maxWaitMs: 300_000,
 decisionTimeoutMs: 60_000, maxNoProgressRounds: 6, maxInterventions: 6, maxErrors: 3,
};
export interface PmLoopDeps {
 db: Database;
 now?(): number;
 list(): IssueId[];
 observe(id: IssueId, signal: AbortSignal): Promise<PmLoopObservation | null>;
 decide(observation: PmLoopObservation, signal: AbortSignal): Promise<PmLoopDecision>;
 apply(observation: PmLoopObservation, decision: PmLoopDecision, operationId: string): Promise<'applied' | 'deferred' | 'stale'>;
 config?: Partial<PmLoopConfig>;
}
interface CaseRow {
 issue_id: IssueId; scope_key: string; progress_key: string; phase: string;
 last_progress_ts: number; next_check_ts: number; no_progress_rounds: number;
 interventions: number; errors: number; deferrals: number; observation_json: string; decision_json: string | null;
 operation_id: string | null;
}

export function parsePmLoopDecision(value: unknown, allowed: readonly PmLoopAction[]): PmLoopDecision {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PM decision must be an object');
 const d = value as Record<string, unknown>;
 if (!allowed.includes(d.action as PmLoopAction)) throw new Error('PM action is not allowed in this scene');
 const text = (key: string, max: number, required = false): string | undefined => {
  const v = d[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x08\x0b-\x1f]/.test(v)) throw new Error(`Invalid PM ${key}`);
  return redactDiagnostic(v.trim());
 };
 const action = d.action as PmLoopAction;
 const reason = text('reason', 400, true)!;
 const instruction = text('instruction', 320, action === 'continue');
 const question = text('question', 300, action === 'clarify');
 if (d.waitSeconds !== undefined && (typeof d.waitSeconds !== 'number' || !Number.isFinite(d.waitSeconds) || d.waitSeconds <= 0)) throw new Error('Invalid PM waitSeconds');
 return { action, reason, ...(instruction ? { instruction } : {}), ...(question ? { question } : {}),
  ...(typeof d.waitSeconds === 'number' ? { waitSeconds: d.waitSeconds } : {}) };
}

/** An independent observation/decision loop. The engine remains the sole owner of effects. */
export class IssuePmLoop {
 private readonly cfg: PmLoopConfig;
 private readonly flights = new Map<IssueId, Promise<void>>();
 private readonly controllers = new Set<AbortController>();
 private accepting = true;
 private reconciled = false;
 private stopping: Promise<void> | null = null;
 constructor(private readonly deps: PmLoopDeps) { this.cfg = { ...DEFAULT_PM_LOOP_CONFIG, ...deps.config }; }
 private now(): number { return this.deps.now?.() ?? Date.now(); }
 private row(id: IssueId): CaseRow | null { return this.deps.db.query<CaseRow, [IssueId]>('SELECT * FROM issue_pm_loops WHERE issue_id=?').get(id); }
 private event(id: IssueId, kind: string, data: Record<string, unknown>): void {
  this.deps.db.query('INSERT INTO issue_events(issue_id,kind,data_json,ts) VALUES(?,?,?,?)')
   .run(id, kind, JSON.stringify(redactDiagnosticValue(data)), this.now());
 }
 start(): void { if (!this.stopping) this.accepting = true; }
 async stop(): Promise<void> {
  if (this.stopping) return this.stopping;
  this.accepting = false;
  for (const controller of this.controllers) controller.abort(new Error('PM supervision stopped'));
  const drain = Promise.allSettled([...this.flights.values()]).then(() => { if (this.stopping === drain) this.stopping = null; });
  this.stopping = drain;
  await drain;
 }
 private reconcile(): void {
  if (this.reconciled) return;
  this.reconciled = true;
  for (const row of this.deps.db.query<CaseRow, []>("SELECT * FROM issue_pm_loops WHERE phase IN ('deciding','applying')").all()) {
   if (row.phase === 'applying') {
    this.deps.db.query("UPDATE issue_pm_loops SET phase='uncertain',updated_ts=? WHERE issue_id=?").run(this.now(), row.issue_id);
    this.event(row.issue_id, 'pm_loop_uncertain', { operationId: row.operation_id, reason: 'Action interrupted before acknowledgement; do not replay.' });
   } else this.deps.db.query("UPDATE issue_pm_loops SET phase='watching',next_check_ts=?,updated_ts=? WHERE issue_id=?")
    .run(this.now(), this.now(), row.issue_id);
  }
 }
 async tick(): Promise<void> {
  if (!this.accepting) return;
  this.reconcile();
  const started: Promise<void>[] = [];
  for (const id of this.deps.list()) {
   if (this.flights.has(id)) continue;
   let flight!: Promise<void>;
   flight = this.run(id).catch(error => {
    this.event(id, 'pm_loop_error', { reason: redactDiagnostic(String(error)).slice(0, 1000) });
   }).finally(() => { if (this.flights.get(id) === flight) this.flights.delete(id); });
   this.flights.set(id, flight); started.push(flight);
  }
  await Promise.allSettled(started);
 }
 private async run(id: IssueId): Promise<void> {
  const controller = new AbortController(); this.controllers.add(controller);
  try {
   const sampled = await this.deps.observe(id, controller.signal);
   if (!sampled || !this.accepting) return;
   const observation = structuredClone(sampled);
   let row = this.row(id);
   // An outer action can itself rotate conversations or advance stages before its receipt is lost.
   // A new scene is not proof that the old action is reconciled. Only an explicit engine recovery clears this barrier.
   if (row?.phase === 'uncertain') return;
   const changedScope = row?.scope_key !== observation.scopeKey;
   const changedProgress = row?.progress_key !== observation.progressKey;
   if (!row || changedScope) {
    this.deps.db.query(`INSERT INTO issue_pm_loops(issue_id,scope_key,progress_key,last_progress_ts,next_check_ts,phase,observation_json,interventions,updated_ts)
     VALUES(?,?,?,?,?,'watching',?,?,?) ON CONFLICT(issue_id) DO UPDATE SET scope_key=excluded.scope_key,progress_key=excluded.progress_key,
     last_progress_ts=excluded.last_progress_ts,next_check_ts=excluded.next_check_ts,phase='watching',observation_json=excluded.observation_json,
     decision_json=NULL,operation_id=NULL,no_progress_rounds=0,errors=0,deferrals=0,updated_ts=excluded.updated_ts`)
     .run(id, observation.scopeKey, observation.progressKey, this.now(), this.now(), JSON.stringify(redactDiagnosticValue(observation)), row?.interventions ?? 0, this.now());
    row = this.row(id)!;
   } else if (row.phase === 'stopped') return;
   else if (changedProgress) {
    this.deps.db.query(`UPDATE issue_pm_loops SET progress_key=?,last_progress_ts=?,next_check_ts=?,phase='watching',
     decision_json=NULL,operation_id=NULL,no_progress_rounds=0,errors=0,deferrals=0,observation_json=?,updated_ts=? WHERE issue_id=?`)
     .run(observation.progressKey, this.now(), this.now(), JSON.stringify(redactDiagnosticValue(observation)), this.now(), id);
    row = this.row(id)!;
   }
   if (this.now() < row.next_check_ts) return;
   if (row.phase === 'ready' && row.decision_json && row.operation_id) {
    let decision: PmLoopDecision;
    try { decision = parsePmLoopDecision(JSON.parse(row.decision_json), observation.allowedActions); }
    catch {
     this.deps.db.query("UPDATE issue_pm_loops SET phase='watching',decision_json=NULL,operation_id=NULL,no_progress_rounds=no_progress_rounds+1,next_check_ts=?,updated_ts=? WHERE issue_id=?")
      .run(this.now() + this.cfg.minWaitMs, this.now(), id);
     this.event(id, 'pm_loop_stale', { operationId: row.operation_id, reason: 'Deferred action is no longer eligible in the current scene.' });
     return;
    }
    if (row.deferrals >= this.cfg.maxNoProgressRounds) {
     // An entry that never returned still owns its writer: stopping automatic intervention cannot steal that owner.
     this.deps.db.query("UPDATE issue_pm_loops SET phase='stopped',updated_ts=? WHERE issue_id=?").run(this.now(), id);
     this.event(id, 'pm_loop_deferred_exhausted', { operationId: row.operation_id, reason: 'Execution entry did not release ownership within the supervision budget; scene retained.' });
     return;
    }
    await this.execute(observation, decision, row.operation_id);
    return;
   }
   if (!observation.trigger && this.now() - row.last_progress_ts < this.cfg.idleMs) return;
   if (row.interventions >= this.cfg.maxInterventions || row.no_progress_rounds >= this.cfg.maxNoProgressRounds || row.errors >= this.cfg.maxErrors) {
    await this.prepare(observation, { action: 'pause', reason: 'PM supervision budget exhausted; preserve current work for inspection.' });
    return;
   }
   this.deps.db.query("UPDATE issue_pm_loops SET phase='deciding',no_progress_rounds=no_progress_rounds+1,observation_json=?,updated_ts=? WHERE issue_id=?")
    .run(JSON.stringify(redactDiagnosticValue(observation)), this.now(), id);
   let decision: PmLoopDecision;
   try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.cfg.decisionTimeoutMs)]);
    decision = parsePmLoopDecision(await this.deps.decide({ ...observation, facts: { ...observation.facts, supervision: { noProgressRounds: row.no_progress_rounds, interventions: row.interventions, idleMs: this.now() - row.last_progress_ts, previousDecision: row.decision_json ? JSON.parse(row.decision_json) : null } } }, signal), observation.allowedActions);
    signal.throwIfAborted();
   } catch (error) {
    if (!this.accepting) return;
    this.deps.db.query("UPDATE issue_pm_loops SET phase='waiting',errors=errors+1,next_check_ts=?,updated_ts=? WHERE issue_id=?")
     .run(this.now() + this.cfg.maxWaitMs, this.now(), id);
    this.event(id, 'pm_loop_model_failed', { reason: redactDiagnostic(String(error)).slice(0, 1000), nextCheckTs: this.now() + this.cfg.maxWaitMs });
    return;
   }
   if (!this.accepting) return;
   const fresh = await this.deps.observe(id, controller.signal);
   if (!fresh || fresh.scopeKey !== observation.scopeKey || fresh.progressKey !== observation.progressKey) {
    this.deps.db.query("UPDATE issue_pm_loops SET phase='watching',next_check_ts=?,updated_ts=? WHERE issue_id=?").run(this.now(), this.now(), id);
    this.event(id, 'pm_loop_stale', { reason: 'Scene or progress changed while PM was deciding.' });
    return;
   }
   await this.prepare(observation, decision);
  } finally { this.controllers.delete(controller); }
 }
 private async prepare(observation: PmLoopObservation, decision: PmLoopDecision): Promise<void> {
  const operationId = randomUUID();
  if (decision.action === 'wait') {
   const delay = Math.min(this.cfg.maxWaitMs, Math.max(this.cfg.minWaitMs, (decision.waitSeconds ?? 120) * 1000));
   this.deps.db.query("UPDATE issue_pm_loops SET phase='waiting',decision_json=?,operation_id=?,next_check_ts=?,updated_ts=? WHERE issue_id=?")
    .run(JSON.stringify(decision), operationId, this.now() + delay, this.now(), observation.issueId);
   this.event(observation.issueId, 'pm_loop_wait', { ...decision, operationId, nextCheckTs: this.now() + delay });
   return;
  }
  this.deps.db.query("UPDATE issue_pm_loops SET phase='ready',decision_json=?,operation_id=?,deferrals=0,updated_ts=? WHERE issue_id=?")
   .run(JSON.stringify(decision), operationId, this.now(), observation.issueId);
  this.event(observation.issueId, 'pm_loop_decision', { ...decision, operationId });
  await this.execute(observation, decision, operationId);
 }
 private async execute(observation: PmLoopObservation, decision: PmLoopDecision, operationId: string): Promise<void> {
  if (!this.accepting) return;
  this.deps.db.query("UPDATE issue_pm_loops SET phase='applying',updated_ts=? WHERE issue_id=? AND operation_id=?")
   .run(this.now(), observation.issueId, operationId);
  try {
   const result = await this.deps.apply(observation, decision, operationId);
   if (result === 'deferred') {
    this.deps.db.query("UPDATE issue_pm_loops SET phase='ready',deferrals=deferrals+1,next_check_ts=?,updated_ts=? WHERE issue_id=?")
     .run(this.now() + this.cfg.minWaitMs, this.now(), observation.issueId);
    this.event(observation.issueId, 'pm_loop_deferred', { operationId, action: decision.action, nextCheckTs: this.now() + this.cfg.minWaitMs });
    return;
   }
   this.deps.db.query(`UPDATE issue_pm_loops SET phase=?,interventions=interventions+?,next_check_ts=?,updated_ts=? WHERE issue_id=?`)
    .run(result === 'applied' && decision.action === 'pause' ? 'stopped' : 'watching', result === 'applied' ? 1 : 0,
     this.now() + this.cfg.minWaitMs, this.now(), observation.issueId);
   this.event(observation.issueId, result === 'applied' ? 'pm_loop_applied' : 'pm_loop_stale', { operationId, action: decision.action });
  } catch (error) {
   this.deps.db.query("UPDATE issue_pm_loops SET phase='uncertain',updated_ts=? WHERE issue_id=?").run(this.now(), observation.issueId);
   this.event(observation.issueId, 'pm_loop_uncertain', { operationId, reason: redactDiagnostic(String(error)).slice(0, 1000) });
  }
 }
}

import type { RoomAttempt } from './contracts';

export type RoomObservationPhase = 'scheduler' | 'capacity' | 'request' | 'attempt' | 'capability_probe' | 'tool';
export type RoomObservationOutcome = 'started' | 'succeeded' | 'failed' | 'cancelled';
const phases: readonly string[] = ['scheduler', 'capacity', 'request', 'attempt', 'capability_probe', 'tool'];
const outcomes: readonly string[] = ['started', 'succeeded', 'failed', 'cancelled'];
const codes = new Set(['cancelled', 'timeout', 'not_configured', 'protocol_invalid', 'scope_mismatch', 'context_too_large', 'response_too_large', 'provider_auth', 'provider_rate_limited', 'provider_unavailable', 'provider_rejected', 'runtime_failed', 'storage_error', 'lease_lost', 'capability_unsupported', 'tool_forbidden', 'tool_limit', 'budget_exhausted', 'internal_error', 'cli_cancel_unconfirmed']);

export interface RoomObservation {
  phase: RoomObservationPhase;
  outcome: RoomObservationOutcome;
  code?: string;
  attempt?: Pick<RoomAttempt, 'id' | 'projectId' | 'roomId' | 'missionId' | 'role'>;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}
export interface RoomDiagnosticEvent {
  timestamp: number; phase: RoomObservationPhase; outcome: RoomObservationOutcome; code?: string;
  projectId?: number; roomId?: string; missionId?: string; attemptId?: string;
  role?: RoomAttempt['role']; durationMs?: number; inputTokens?: number; outputTokens?: number;
}
export interface RoomDiagnosticPort { record(observation: RoomObservation): void }
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
const uuid = (value: unknown): string | undefined => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value) ? value : undefined;

/** Bounded operator metrics only. No prompts, provider URLs, credentials or error objects. */
export class RoomDiagnostics implements RoomDiagnosticPort {
  private readonly counters = new Map<string, number>();
  private readonly samples: RoomDiagnosticEvent[] = [];
  constructor(private readonly sink?: (event: RoomDiagnosticEvent) => void) {}

  record(value: RoomObservation): void {
    if (!phases.includes(value.phase) || !outcomes.includes(value.outcome)) return;
    const code = value.code ? codes.has(value.code) ? value.code : 'internal_error' : undefined;
    const role = value.attempt?.role && ['coach', 'planner', 'writer', 'reviewer'].includes(value.attempt.role) ? value.attempt.role : undefined;
    // Construct a new whitelist projection even if a caller passes extra properties.
    const event: RoomDiagnosticEvent = {
      timestamp: Date.now(), phase: value.phase, outcome: value.outcome,
      ...(code ? { code } : {}), ...(role ? { role } : {}),
      ...(number(value.attempt?.projectId) !== undefined ? { projectId: number(value.attempt?.projectId) } : {}),
      ...(uuid(value.attempt?.id) ? { attemptId: uuid(value.attempt?.id) } : {}),
      ...(uuid(value.attempt?.roomId) ? { roomId: uuid(value.attempt?.roomId) } : {}),
      ...(uuid(value.attempt?.missionId) ? { missionId: uuid(value.attempt?.missionId) } : {}),
      ...(number(value.durationMs) !== undefined ? { durationMs: number(value.durationMs) } : {}),
      ...(number(value.inputTokens) !== undefined ? { inputTokens: number(value.inputTokens) } : {}),
      ...(number(value.outputTokens) !== undefined ? { outputTokens: number(value.outputTokens) } : {}),
    };
    const key = `${event.phase}.${event.outcome}.${event.code ?? 'ok'}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    this.samples.push(event);
    if (this.samples.length > 64) this.samples.shift();
    try { this.sink?.({ ...event }); } catch { /* Metrics cannot affect collaboration execution. */ }
  }
  snapshot(): { counters: Record<string, number>; recent: RoomDiagnosticEvent[] } {
    return { counters: Object.fromEntries(this.counters), recent: this.samples.map(event => ({ ...event })) };
  }
}
export const roomDiagnostics = new RoomDiagnostics();

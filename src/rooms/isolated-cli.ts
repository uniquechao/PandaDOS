import type { RoomAttempt, RoomExecutionContext, RoomFormalResult } from './contracts';
import { parseRoomFormalResult, RoomRuntimeError } from './protocol';
import { compileRoomMessages, type RoomToolPort, type RoomRuntime } from './runtime';
import { projectRoomToolResult } from './tools';
import { roomDiagnostics } from './observability';

/** Proofs come from an operator-owned launcher self-test, never an Agent response. */
export const ROOM_ISOLATION_CHECKS = [
  'independent_identity', 'private_home', 'private_pid_namespace', 'readonly_inputs',
  'bounded_output_directory', 'denies_sibling_files', 'denies_host_credentials',
  'denies_host_database', 'denies_host_tmux', 'brokered_network',
  'metered_model_requests', 'metered_tools', 'inspect_execution', 'confirmed_cancel',
  'exclusive_room_execution',
] as const;
type IsolationCheck = typeof ROOM_ISOLATION_CHECKS[number];
export interface RoomIsolationEvidence {
  schemaVersion: 1; launcherId: string; checkedAt: number; expiresAt: number;
  checks: Record<IsolationCheck, boolean>;
}
export interface RoomIsolatedCliSpec {
  projectId: number; roomId: string; memberId: string; missionId: string;
  executionId: string; controlEpoch: number; fence: number; deadlineTs: number;
  /** Serialized formal input only. The launcher supplies no parent session history. */
  formalInput: string;
}
export interface RoomIsolatedCliResult {
  projectId: number; roomId: string; memberId: string; missionId: string;
  executionId: string; controlEpoch: number; fence: number;
  /** A bounded formal JSON file, never stdout/stderr or a CLI transcript. */
  formalJson: string;
}
export interface RoomIsolatedCliBackend {
  selfTest(signal: AbortSignal): Promise<RoomIsolationEvidence>;
  execute(spec: RoomIsolatedCliSpec, signal: AbortSignal, beforeModelRequest: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomIsolatedCliResult>;
  inspect(spec: Pick<RoomIsolatedCliSpec, 'projectId' | 'roomId' | 'memberId' | 'executionId'>): Promise<'running' | 'finished' | 'absent' | 'unknown'>;
  cancel(spec: Pick<RoomIsolatedCliSpec, 'projectId' | 'roomId' | 'memberId' | 'executionId'>): Promise<'confirmed' | 'unknown'>;
}

export function verifiedRoomIsolation(evidence: RoomIsolationEvidence | undefined, now = Date.now()): boolean {
  return !!evidence && evidence.schemaVersion === 1 && /^[a-zA-Z0-9._:-]{1,160}$/.test(evidence.launcherId)
    && Number.isSafeInteger(evidence.checkedAt) && evidence.checkedAt <= now
    && Number.isSafeInteger(evidence.expiresAt) && evidence.expiresAt > now
    && evidence.expiresAt - evidence.checkedAt <= 300_000
    && ROOM_ISOLATION_CHECKS.every(key => evidence.checks?.[key] === true);
}

/** No shared ExecutorDriver fallback: absent or unverified launchers fail before execution. */
export class RoomIsolatedCliRuntime implements RoomRuntime {
  readonly cancellationMode = 'confirm' as const;
  private evidence?: RoomIsolationEvidence;
  constructor(private readonly backend?: RoomIsolatedCliBackend, private readonly cancelPollMs = 1_000) {}
  configured(): boolean { return !!this.backend && verifiedRoomIsolation(this.evidence); }
  async confirmStopped(attempt: RoomAttempt, signal: AbortSignal): Promise<boolean> {
    if (!this.backend || signal.aborted) return false;
    const identity = { projectId: attempt.projectId, roomId: attempt.roomId, memberId: attempt.memberId, executionId: attempt.id };
    const status = await this.backend.inspect(identity).catch(() => 'unknown' as const);
    if (status === 'finished' || status === 'absent') return true;
    if (signal.aborted) return false;
    return await this.backend.cancel(identity).catch(() => 'unknown') === 'confirmed';
  }
  async probeIsolation(signal: AbortSignal): Promise<{ available: boolean; failedChecks: IsolationCheck[] }> {
    if (!this.backend) return { available: false, failedChecks: [...ROOM_ISOLATION_CHECKS] };
    this.evidence = undefined;
    const evidence = await this.backend.selfTest(signal);
    if (verifiedRoomIsolation(evidence)) this.evidence = evidence;
    return { available: this.configured(), failedChecks: ROOM_ISOLATION_CHECKS.filter(key => evidence.checks?.[key] !== true) };
  }
  async run(context: RoomExecutionContext, signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomFormalResult> {
    if (!this.configured() || !this.backend || !beforeRequest) throw new RoomRuntimeError('capability_unsupported');
    const attempt = context.attempt;
    const spec: RoomIsolatedCliSpec = {
      projectId: attempt.projectId, roomId: attempt.roomId, memberId: attempt.memberId,
      missionId: attempt.missionId, executionId: attempt.id, controlEpoch: attempt.controlEpoch,
      fence: attempt.fence, deadlineTs: attempt.deadlineTs,
      formalInput: JSON.stringify(compileRoomMessages(context)),
    };
    signal.throwIfAborted();
    let onAbort!: () => void;
    let cancellation: Promise<'confirmed' | 'unknown'> | undefined;
    const cancel = () => cancellation ??= (async (): Promise<'confirmed'> => {
      let reported = false;
      for (;;) {
        const status = await this.backend!.cancel(spec).catch(() => 'unknown' as const);
        if (status === 'confirmed') return 'confirmed';
        const inspected = await this.backend!.inspect(spec).catch(() => 'unknown' as const);
        if (inspected === 'finished' || inspected === 'absent') return 'confirmed';
        if (!reported) { roomDiagnostics.record({ phase: 'attempt', outcome: 'failed', attempt, code: 'cli_cancel_unconfirmed' }); reported = true; }
        // Keep the execution and resource barrier alive. A local timeout cannot
        // assert that a remote process stopped; the launcher holds room exclusivity.
        await new Promise(resolve => setTimeout(resolve, Math.max(10, this.cancelPollMs)));
      }
    })();
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { void cancel().then(status => reject(new RoomRuntimeError(status === 'confirmed' ? 'cancelled' : 'cli_cancel_unconfirmed'))); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    let result: RoomIsolatedCliResult;
    try {
      result = await Promise.race([this.backend.execute(spec, signal, requestId => {
        if (signal.aborted || !this.configured() || Date.now() >= spec.deadlineTs) return false;
        return beforeRequest(requestId);
      }, tools ? { call: call => {
        if (signal.aborted || !this.configured() || Date.now() >= spec.deadlineTs) throw new RoomRuntimeError('cancelled');
        return projectRoomToolResult(call, tools.call(call), context);
      } } : undefined), cancelled]);
    } catch (error) {
      // Ending a local HTTP wait never proves that the remote CLI stopped.
      const status = await cancel();
      if (status !== 'confirmed') throw new RoomRuntimeError('cli_cancel_unconfirmed');
      if (signal.aborted) throw new RoomRuntimeError('cancelled');
      throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError('runtime_failed');
    } finally { signal.removeEventListener('abort', onAbort); }
    if (signal.aborted) throw new RoomRuntimeError(await cancel() === 'confirmed' ? 'cancelled' : 'cli_cancel_unconfirmed');
    const status = await this.backend.inspect(spec);
    if (status !== 'finished' && status !== 'absent') throw new RoomRuntimeError(await cancel() === 'confirmed' ? 'runtime_failed' : 'cli_cancel_unconfirmed');
    if (Date.now() >= spec.deadlineTs || !this.configured()) throw new RoomRuntimeError('timeout');
    for (const key of ['projectId', 'roomId', 'memberId', 'missionId', 'executionId', 'controlEpoch', 'fence'] as const) if (result[key] !== spec[key]) throw new RoomRuntimeError('scope_mismatch');
    return parseRoomFormalResult(result.formalJson, context);
  }
}

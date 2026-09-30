import { randomUUID } from 'node:crypto';
import type { RoomAttempt, RoomRunPort } from './contracts';
import { RoomRuntimeError } from './protocol';
import type { RoomRuntime } from './runtime';
import { roomDiagnostics, type RoomDiagnosticPort } from './observability';
import { ResourceDrain, type DrainResult } from './lifecycle';

export interface RoomCoordinatorOptions {
  service: RoomRunPort;
  runtime: RoomRuntime;
  maxConcurrent?: number;
  pollIntervalMs?: number;
  leaseIntervalMs?: number;
  workerId?: string;
  onChange?: (roomId: string, projectId: number) => void;
  diagnostics?: RoomDiagnosticPort;
}
interface RunningAttempt {
  attempt: RoomAttempt;
  controller: AbortController;
  done: Promise<void>;
}

const SAFE_FAILURE_CODES = new Set([
  'protocol_invalid', 'scope_mismatch', 'context_too_large', 'response_too_large',
  'not_configured', 'cancelled', 'timeout', 'provider_auth', 'provider_rate_limited',
  'provider_unavailable', 'provider_rejected',
  'capability_unsupported', 'tool_forbidden', 'tool_limit', 'budget_exhausted',
]);

/** Owns only local scheduling/cancellation. SQLite scope and fences remain truth. */
export class RoomCoordinator {
  private readonly service: RoomRunPort;
  private readonly runtime: RoomRuntime;
  private readonly workerId: string;
  private readonly maxConcurrent: number;
  private readonly pollIntervalMs: number;
  private readonly leaseIntervalMs: number;
  private readonly onChange?: RoomCoordinatorOptions['onChange'];
  private readonly diagnostics: RoomDiagnosticPort;
  private readonly running = new Map<string, RunningAttempt>();
  private timer?: ReturnType<typeof setInterval>;
  private enabled = false;
  private scheduled = false;
  private ticking = false;
  private readonly drain = new ResourceDrain();
  private readonly recoveringStops = new Set<string>();
  private stopped = false;

  constructor(options: RoomCoordinatorOptions) {
    this.service = options.service;
    this.runtime = options.runtime;
    this.workerId = options.workerId ?? `room-worker-${randomUUID()}`;
    this.maxConcurrent = Math.min(16, Math.max(1, Math.floor(options.maxConcurrent ?? 2)));
    this.pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 1_000);
    this.leaseIntervalMs = Math.max(10, options.leaseIntervalMs ?? 5_000);
    this.onChange = options.onChange;
    this.diagnostics = options.diagnostics ?? roomDiagnostics;
  }

  start(): void {
    if (this.enabled || this.stopped) return;
    this.enabled = true;
    this.service.recover();
    this.timer = setInterval(() => this.wake(), this.pollIntervalMs);
    this.timer.unref?.();
    this.wake();
  }

  wake(): void {
    if (!this.enabled || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.tick(); });
  }

  cancelRoom(roomId: string): void {
    for (const task of this.running.values()) if (task.attempt.roomId === roomId) task.controller.abort();
    this.wake();
  }

  stop(waitMs = 5_000): Promise<DrainResult> {
    this.stopped = true;
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.running.values()];
    for (const task of pending) task.controller.abort();
    return this.drain.close(waitMs);
  }

  private changed(attempt: RoomAttempt): void {
    try { this.onChange?.(attempt.roomId, attempt.projectId); } catch { /* notifications are recoverable from persistent snapshots */ }
  }

  private tick(): void {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      for (const task of this.running.values()) {
        if (!this.service.isCurrent(task.attempt)) task.controller.abort();
      }
      this.service.recover();
      this.recoverStops();
      if (!this.runtime.configured()) {
        // Configuration can be withdrawn after a start command or while a call
        // waits for capacity. Persist the actionable interruption immediately.
        // Undispatched reservations are released by fail; sent calls stay billed.
        for (const task of this.running.values()) {
          this.service.fail(task.attempt, 'not_configured');
          task.controller.abort();
          this.changed(task.attempt);
        }
        for (let i = 0; i < this.maxConcurrent; i++) {
          const attempt = this.service.claimNext(this.workerId);
          if (!attempt) break;
          this.service.fail(attempt, 'not_configured');
          this.changed(attempt);
        }
        return;
      }
      while (this.enabled && this.running.size < this.maxConcurrent) {
        const attempt = this.service.claimNext(this.workerId);
        if (!attempt) break;
        const controller = new AbortController();
        const task: RunningAttempt = { attempt, controller, done: Promise.resolve() };
        this.running.set(attempt.id, task);
        this.changed(attempt);
        task.done = this.drain.track(this.execute(task).finally(() => {
          this.running.delete(attempt.id);
          this.changed(attempt);
          this.wake();
        }));
      }
    } catch {
      this.diagnostics.record({ phase: 'scheduler', outcome: 'failed', code: 'storage_error' });
      // Store/configuration failures are retried by the bounded polling cadence;
      // they never produce a synthetic member contribution or expose SQL/errors.
    } finally { this.ticking = false; }
  }

  /** Reconcile durable confirmation locks after a worker/process restart. */
  private recoverStops(): void {
    if (!this.runtime.confirmStopped || !this.service.pendingStops || !this.service.confirmStopped) return;
    for (const attempt of this.service.pendingStops()) {
      if (this.running.has(attempt.id) || this.recoveringStops.has(attempt.id)) continue;
      if (this.recoveringStops.size >= this.maxConcurrent) break;
      this.recoveringStops.add(attempt.id);
      const pending = (async () => {
        try {
          if (await this.runtime.confirmStopped!(attempt, AbortSignal.timeout(10_000))) {
            this.service.confirmStopped!(attempt);
            this.changed(attempt);
          }
        } catch {
          this.diagnostics.record({ phase: 'scheduler', outcome: 'failed', attempt, code: 'cli_cancel_unconfirmed' });
        } finally { this.recoveringStops.delete(attempt.id); }
      })();
      this.drain.track(pending);
    }
  }

  private async execute(task: RunningAttempt): Promise<void> {
    const { attempt, controller } = task;
    const started = performance.now();
    let accepted = false;
    this.diagnostics.record({ phase: 'attempt', outcome: 'started', attempt });
    const deadline = setTimeout(() => controller.abort(), Math.max(0, attempt.deadlineTs - Date.now()));
    const heartbeat = setInterval(() => {
      try { if (!this.service.renew(attempt)) controller.abort(); }
      catch { controller.abort(); }
    }, this.leaseIntervalMs);
    try {
      if (!this.service.isCurrent(attempt)) throw new RoomRuntimeError('cancelled');
      const ctx = this.service.context(attempt);
      const cancellationMode = this.runtime.cancellationModeFor?.(ctx) ?? this.runtime.cancellationMode;
      if (cancellationMode === 'confirm') {
        if (!this.runtime.confirmStopped || !this.service.setCancellationMode || !this.service.confirmStopped || !this.service.pendingStops) throw new RoomRuntimeError('capability_unsupported');
        if (!this.service.setCancellationMode(attempt, 'confirm')) throw new RoomRuntimeError('cancelled');
        attempt.cancelMode = 'confirm';
      }
      const aborted = cancellationMode === 'confirm' ? undefined : new Promise<never>((_, reject) => {
        const abort = () => reject(new RoomRuntimeError('cancelled'));
        if (controller.signal.aborted) abort();
        else controller.signal.addEventListener('abort', abort, { once: true });
      });
      const tool = this.service.tool?.bind(this.service);
      const execution = this.runtime.run(ctx, controller.signal, requestId => this.service.dispatched(attempt, undefined, requestId), tool ? { call: call => {
        if (controller.signal.aborted || !this.service.isCurrent(attempt)) throw new RoomRuntimeError('cancelled');
        return tool(attempt, call);
      } } : undefined);
      const result = aborted ? await Promise.race([execution, aborted]) : await execution;
      if (controller.signal.aborted || !this.service.isCurrent(attempt)) throw new RoomRuntimeError('cancelled');
      if (!this.service.accept(attempt, result)) {
        this.service.fail(attempt, 'cancelled');
        this.diagnostics.record({ phase: 'attempt', outcome: 'cancelled', attempt, code: 'lease_lost', durationMs: performance.now() - started });
      } else { accepted = true; this.diagnostics.record({ phase: 'attempt', outcome: 'succeeded', attempt, durationMs: performance.now() - started }); }
    } catch (error) {
      const code = controller.signal.aborted ? (Date.now() >= attempt.deadlineTs ? 'timeout' : 'cancelled') : error instanceof RoomRuntimeError && SAFE_FAILURE_CODES.has(error.code) ? error.code : 'runtime_failed';
      this.diagnostics.record({ phase: 'attempt', outcome: code === 'cancelled' ? 'cancelled' : 'failed', attempt, code, durationMs: performance.now() - started });
      try { this.service.fail(attempt, code); } catch { /* persisted lease recovery fences and settles the attempt */ }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      if (!accepted && attempt.cancelMode === 'confirm') {
        try {
          if (await this.runtime.confirmStopped?.(attempt, AbortSignal.timeout(10_000))) this.service.confirmStopped?.(attempt);
        } catch { /* Durable pendingStops retains the lock and recovery retries. */ }
      }
    }
  }
}

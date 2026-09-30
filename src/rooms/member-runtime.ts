import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RoomMember } from '../../shared/rooms';
import type { RoomModelCatalog } from '../../shared/room-models';
import type { RoomAttempt, RoomExecutionContext, RoomFormalResult } from './contracts';
import type { RoomProviderCapabilities, RoomRuntime, RoomToolPort } from './runtime';
import { RoomRuntimeError } from './protocol';
import { RoomModelRuntime } from './model-runtime';
import { RoomLocalCliRuntime } from './local-cli';
import { localHash, privateWrite } from './local-cli-state';

export interface RoomMemberRuntimeOptions { api: RoomModelRuntime; local: RoomLocalCliRuntime; stateDir: string }
/** Select a transport from the claimed member, never from a model response. */
export class RoomMemberRuntime implements RoomRuntime {
  constructor(private readonly options: RoomMemberRuntimeOptions) {}
  configured(): boolean { return this.options.api.configured() || this.options.local.configured(); }
  configuredFor(members: RoomMember[]): boolean {
    return !members.length ? this.options.api.configured() : members.every(member => member.model?.provider === 'claude' || member.model?.provider === 'codex' ? this.options.local.configuredFor([member]) : this.options.api.configuredFor([member]));
  }
  modelCatalog(): RoomModelCatalog {
    const api = this.options.api.modelCatalog();
    return { ...api, providers: [...this.options.local.modelCatalog().providers, ...api.providers] };
  }
  async designMembers(request: import('./member-designer').RoomMemberDesignRequest, signal: AbortSignal): Promise<string> {
    let dispatched = false;
    const beforeRequest = () => {
      if (dispatched || signal.aborted || Date.now() >= request.deadlineTs) return false;
      dispatched = true; return true;
    };
    if (request.model.provider === 'deepseek') {
      return (await this.options.api.requestOnce(request.messages, signal, request.deadlineTs, beforeRequest, false, request.model)).content;
    }
    // Each management request owns an ephemeral identity. It cannot resume a member,
    // hold the collaboration room lock, or leave that room blocked after a server restart.
    const roomId = `member-design:${request.roomId}:${request.requestId}`;
    const memberId = `member-design:${request.requestId}`;
    const attempt: RoomAttempt = {
      id: request.requestId, assignmentId: request.requestId, projectId: request.projectId,
      roomId, memberId, missionId: roomId, role: 'planner', kind: 'work', goalRevision: 1,
      round: 1, controlEpoch: 1, fence: 1, workerId: 'member-designer', leaseUntil: request.deadlineTs,
      deadlineTs: request.deadlineTs, audience: { kind: 'room' },
    };
    return this.options.local.runText({ attempt, member: { id: memberId, model: request.model } }, request.messages, signal, beforeRequest);
  }
  capabilities(): RoomProviderCapabilities { return this.options.api.capabilities(); }
  probe(signal: AbortSignal, beforeRequest?: () => boolean): Promise<RoomProviderCapabilities> { return this.options.api.probe(signal, beforeRequest); }
  private identity(attempt: RoomAttempt) {
    return { id: attempt.id, projectId: attempt.projectId, roomId: attempt.roomId, memberId: attempt.memberId, missionId: attempt.missionId, workerId: attempt.workerId, fence: attempt.fence, controlEpoch: attempt.controlEpoch };
  }
  private marker(attempt: RoomAttempt): string { return join(this.options.stateDir, 'routes', `${localHash(attempt.id)}.json`); }
  cancellationModeFor(context: RoomExecutionContext): 'detach' | 'confirm' {
    const mode = context.member.model?.provider === 'claude' || context.member.model?.provider === 'codex' ? 'confirm' : 'detach';
    const marker = this.marker(context.attempt);
    const value = JSON.stringify({ ...this.identity(context.attempt), mode });
    if (existsSync(marker)) { if (readFileSync(marker, 'utf8') !== value) throw new RoomRuntimeError('scope_mismatch'); }
    else privateWrite(marker, value);
    if (mode === 'confirm') this.options.local.prepareAttempt(context);
    return mode;
  }
  async run(context: RoomExecutionContext, signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomFormalResult> {
    const mode = this.cancellationModeFor(context);
    if (!this.configuredFor([context.member])) throw new RoomRuntimeError('not_configured');
    return mode === 'confirm' ? this.options.local.run(context, signal, beforeRequest, tools) : this.options.api.run(context, signal, beforeRequest, tools);
  }
  async confirmStopped(attempt: RoomAttempt, signal: AbortSignal): Promise<boolean> {
    try {
      const value = JSON.parse(readFileSync(this.marker(attempt), 'utf8'));
      for (const [key, expected] of Object.entries(this.identity(attempt))) if (value[key] !== expected) return false;
      if (value.mode === 'detach') return true;
      return value.mode === 'confirm' && await this.options.local.confirmStopped(attempt, signal);
    } catch { return false; }
  }
}

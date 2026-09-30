import type { FetchLike } from '../agents/llm';
import type { RoomIsolatedCliBackend, RoomIsolationEvidence, RoomIsolatedCliResult, RoomIsolatedCliSpec } from './isolated-cli';
import { verifiedRoomIsolation, RoomIsolatedCliRuntime } from './isolated-cli';
import { RoomRuntimeError } from './protocol';
import type { RoomToolPort } from './runtime';
import { parseRoomToolCall } from './tools';

export interface RoomIsolatedLauncherOptions {
  /** Operator-controlled launcher service, never a URL supplied by an Agent. */
  endpoint: string;
  token: string;
  fetchFn?: FetchLike;
}
type ExecutionIdentity = Pick<RoomIsolatedCliSpec, 'projectId' | 'roomId' | 'memberId' | 'executionId'>;
const identity = (spec: ExecutionIdentity): ExecutionIdentity => ({ projectId: spec.projectId, roomId: spec.roomId, memberId: spec.memberId, executionId: spec.executionId });
const scopeKeys = ['projectId', 'roomId', 'memberId', 'missionId', 'executionId', 'controlEpoch', 'fence'] as const;
const fail = (code = 'protocol_invalid'): never => { throw new RoomRuntimeError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) fail();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const { value, done } = await reader!.read(); if (done) break; size += value.byteLength; if (size > 70_000) fail('response_too_large'); chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { await reader!.cancel().catch(() => {}); throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError('protocol_invalid'); }
  finally { reader!.releaseLock(); }
}

/**
 * Transport to a separately deployed isolation launcher. This adapter creates no
 * sandbox itself and remains unavailable until the launcher's mandatory self-test
 * succeeds. The launcher must block each physical request until its permit POST.
 */
export class RoomHttpIsolatedLauncher implements RoomIsolatedCliBackend {
  private readonly endpoint: string;
  private readonly fetchFn: FetchLike;
  constructor(private readonly options: RoomIsolatedLauncherOptions) {
    let url: URL;
    try { url = new URL(options.endpoint); } catch { fail('capability_unsupported'); }
    if ((url!.protocol !== 'https:' && !(url!.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url!.hostname))) || url!.username || url!.password || url!.search || url!.hash || !options.token.trim() || /[\r\n]/.test(options.token)) fail('capability_unsupported');
    this.endpoint = url!.href.replace(/\/+$/, '');
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
  }
  private async post(path: string, input: unknown, signal: AbortSignal): Promise<Response> {
    try {
      const response = await this.fetchFn(`${this.endpoint}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.token}` }, body: JSON.stringify(input), signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); fail('runtime_failed'); }
      return response;
    } catch (error) { throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError(signal.aborted ? 'cancelled' : 'runtime_failed'); }
  }
  async selfTest(signal: AbortSignal): Promise<RoomIsolationEvidence> {
    const evidence = await boundedJson(await this.post('/self-test', { schemaVersion: 1 }, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))) as RoomIsolationEvidence;
    if (!verifiedRoomIsolation(evidence)) fail('capability_unsupported');
    return evidence;
  }
  async inspect(spec: ExecutionIdentity): Promise<'running' | 'finished' | 'absent' | 'unknown'> {
    try {
      spec = identity(spec);
      const data = object(await boundedJson(await this.post('/inspect', spec, AbortSignal.timeout(5_000))));
      if (Object.entries(spec).some(([key, value]) => data[key] !== value)) return 'unknown';
      return ['running', 'finished', 'absent'].includes(data.status as string) ? data.status as 'running' | 'finished' | 'absent' : 'unknown';
    } catch { return 'unknown'; }
  }
  async cancel(spec: ExecutionIdentity): Promise<'confirmed' | 'unknown'> {
    try {
      spec = identity(spec);
      const data = object(await boundedJson(await this.post('/cancel', spec, AbortSignal.timeout(5_000))));
      return Object.entries(spec).every(([key, value]) => data[key] === value) && data.status === 'confirmed' ? 'confirmed' : 'unknown';
    } catch { return 'unknown'; }
  }
  async execute(spec: RoomIsolatedCliSpec, signal: AbortSignal, beforeModelRequest: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomIsolatedCliResult> {
    if (spec.deadlineTs <= Date.now() || signal.aborted) fail('cancelled');
    const combined = AbortSignal.any([signal, AbortSignal.timeout(Math.min(180_000, spec.deadlineTs - Date.now()))]);
    const response = await this.post('/execute', { schemaVersion: 1, ...spec, allowedTools: tools ? ['read_source', 'read_artifact', 'search_sources'] : [], requestLimit: 6, toolLimit: 12 }, combined);
    if (!response.headers.get('content-type')?.startsWith('application/x-ndjson')) { await response.body?.cancel(); fail(); }
    const reader = response.body?.getReader(); if (!reader) fail();
    const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', bytes = 0, requests = 0, toolCount = 0;
    const handle = async (line: string): Promise<RoomIsolatedCliResult | undefined> => {
      let event: Record<string, unknown> = {};
      try { event = object(JSON.parse(line)); } catch { fail(); }
      if (scopeKeys.some(key => event[key] !== spec[key])) fail('scope_mismatch');
      if (event.kind === 'model_request') {
        if (requests >= 6 || event.requestId !== `request-${requests + 1}` || !beforeModelRequest(event.requestId as string)) fail('budget_exhausted');
        requests++;
        const permit = await this.post('/permit', { ...Object.fromEntries(scopeKeys.map(key => [key, spec[key]])), requestId: event.requestId, allowed: true }, combined);
        await permit.body?.cancel();
      } else if (event.kind === 'tool_request') {
        if (!tools || ++toolCount > 12) fail('tool_limit');
        const call = parseRoomToolCall(event.id, event.name, JSON.stringify(event.args));
        const result = tools!.call(call);
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 70_000) fail('response_too_large');
        const delivered = await this.post('/tool-result', { ...Object.fromEntries(scopeKeys.map(key => [key, spec[key]])), id: call.id, result }, combined);
        await delivered.body?.cancel();
      } else if (event.kind === 'result') {
        if (!requests || typeof event.formalJson !== 'string' || Buffer.byteLength(event.formalJson, 'utf8') > 65_536) fail();
        return { projectId: spec.projectId, roomId: spec.roomId, memberId: spec.memberId, missionId: spec.missionId, executionId: spec.executionId, controlEpoch: spec.controlEpoch, fence: spec.fence, formalJson: event.formalJson as string };
      } else fail();
    };
    try {
      for (;;) {
        combined.throwIfAborted();
        const { done, value } = await reader!.read();
        if (done) break;
        bytes += value.byteLength; if (bytes > 1_048_576) fail('response_too_large');
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf('\n'); if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (line.length > 70_000) fail('response_too_large');
          const result = await handle(line); if (result) { await reader!.cancel().catch(() => {}); return result; }
        }
        if (buffer.length > 70_000) fail('response_too_large');
      }
      return fail();
    } catch (error) { await reader!.cancel().catch(() => {}); throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError(combined.aborted ? 'cancelled' : 'protocol_invalid'); }
    finally { reader!.releaseLock(); }
  }
}

/** Composition-root factory: explicit operator configuration plus a successful live self-test. */
export async function createRoomIsolatedRuntime(options: RoomIsolatedLauncherOptions, signal: AbortSignal): Promise<RoomIsolatedCliRuntime> {
  const runtime = new RoomIsolatedCliRuntime(new RoomHttpIsolatedLauncher(options));
  const probe = await runtime.probeIsolation(signal);
  if (!probe.available) throw new RoomRuntimeError('capability_unsupported');
  return runtime;
}

import type { FetchLike, LlmConfig } from '../agents/llm';
import { isLlmConfigured } from '../agents/llm';
import type { RoomExecutionContext, RoomFormalResult } from './contracts';
import { parseRoomFormalResult, RoomRuntimeError } from './protocol';
import { compileRoomMessages, ROOM_CONTEXT_MAX_BYTES, type RoomModelMessage, type RoomRuntime, type RoomProviderCapabilities, type RoomToolPort } from './runtime';
import { ROOM_TOOLS, ROOM_TOOL_CONTRACT, parseRoomToolCall, projectRoomToolResult } from './tools';
import type { RoomToolCall } from './contracts';
export type { RoomProviderCapabilities } from './runtime';
import { roomDiagnostics, type RoomDiagnosticPort } from './observability';
import { createHash, randomUUID } from 'node:crypto';
import type { RoomMember, RoomMemberModel } from '../../shared/rooms';
import type { RoomModelCatalog } from '../../shared/room-models';

export interface RoomModelRuntimeOptions {
  config: LlmConfig | (() => LlmConfig);
  fetchFn?: FetchLike;
  /** Shared provider gate supplied by composition root, not an independent pool. */
  acquire?: (signal: AbortSignal) => Promise<() => void>;
  diagnostics?: RoomDiagnosticPort;
}
export interface RoomModelResponse {
  content: string;
  usage?: { inputTokens: number; outputTokens: number };
  /** Private cache identity; never projected into room contributions or prompts. */
  configurationKey?: string;
  toolCalls?: RoomToolCall[];
  /** DeepSeek requires this only for private tool continuation within this attempt. */
  privateReasoning?: string;
}
const CAPABILITY_TTL_MS = 600_000;
const configurationKey = (config: LlmConfig): string => createHash('sha256').update(JSON.stringify([config.baseUrl, config.model, config.apiKey])).digest('hex');

const PROVIDER_RESPONSE_MAX_BYTES = 1_048_576;
const MAX_REQUEST_TIMEOUT_MS = 180_000;

function safeUsage(raw: unknown): RoomModelResponse['usage'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(usage.prompt_tokens) || !Number.isSafeInteger(usage.completion_tokens) || (usage.prompt_tokens as number) < 0 || (usage.completion_tokens as number) < 0) return undefined;
  return { inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number };
}

/** Read bounded JSON without ever logging/returning a provider's response body. */
async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > PROVIDER_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw new RoomRuntimeError('response_too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RoomRuntimeError('protocol_invalid');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > PROVIDER_RESPONSE_MAX_BYTES) throw new RoomRuntimeError('response_too_large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new RoomRuntimeError('protocol_invalid'); }
}

/** Bounded private execution; only the final validated formal result leaves this runtime. */
export class RoomModelRuntime implements RoomRuntime {
  private readonly configProvider: () => LlmConfig;
  private readonly fetchFn: FetchLike;
  private readonly acquire?: RoomModelRuntimeOptions['acquire'];
  private readonly diagnostics: RoomDiagnosticPort;
  private capability?: { key: string; state: 'verified' | 'unsupported'; checkedAt: number };
  private probeFlight?: Promise<RoomProviderCapabilities>;

  constructor(options: RoomModelRuntimeOptions) {
    this.configProvider = typeof options.config === 'function' ? options.config : () => options.config as LlmConfig;
    this.fetchFn = options.fetchFn ?? ((url, init) => fetch(url, init));
    this.acquire = options.acquire;
    this.diagnostics = options.diagnostics ?? roomDiagnostics;
  }

  configured(): boolean {
    try { return isLlmConfigured(this.configProvider()); } catch { return false; }
  }
  configuredFor(members: RoomMember[]): boolean {
    return this.configured() && members.every(member => !member.model || member.model.provider === 'deepseek');
  }
  modelCatalog(): RoomModelCatalog {
    let model: string | undefined;
    try { model = this.configProvider().model || undefined; } catch { /* unavailable */ }
    const available = this.configured();
    return { ...(model ? { defaultModel: { provider: 'deepseek', model, effort: 'medium' } as RoomMemberModel } : {}), providers: [{ provider: 'deepseek', available, metering: 'model_requests', models: model ? [{ id: model, efforts: ['low', 'medium', 'high'] }] : [], ...(model ? { defaultModel: model } : {}), ...(!available ? { reason: 'not_configured' } : {}) }] };
  }
  capabilities(): RoomProviderCapabilities {
    let key: string | undefined;
    try { key = configurationKey(this.configProvider()); } catch { /* unavailable configuration */ }
    const candidate = this.capability;
    const cached = candidate && candidate.key === key && Date.now() < candidate.checkedAt + CAPABILITY_TTL_MS ? candidate : undefined;
    return { transport: 'model_api', isolation: 'brokered_tools', cancellation: 'local_detach', requestMetering: true, structuredOutput: cached?.state ?? 'unverified', checkedAt: cached?.checkedAt ?? null, expiresAt: cached ? cached.checkedAt + CAPABILITY_TTL_MS : null };
  }

  /** Explicit administrator probe. Exactly one bounded request, cached per provider identity. */
  probe(signal: AbortSignal, beforeRequest?: () => boolean): Promise<RoomProviderCapabilities> {
    if (this.capabilities().structuredOutput !== 'unverified') return Promise.resolve(this.capabilities());
    if (this.probeFlight) return this.probeFlight;
    const nonce = randomUUID();
    const started = performance.now();
    const run = async (): Promise<RoomProviderCapabilities> => {
      const response = await this.requestOnce([{ role: 'system', content: 'Return exactly one JSON object with the requested roomCapabilityProbe value. No other fields or prose.' }, { role: 'user', content: JSON.stringify({ roomCapabilityProbe: nonce }) }], signal, Date.now() + 15_000, beforeRequest);
      let valid = false;
      try { const value = JSON.parse(response.content); valid = value && Object.keys(value).length === 1 && value.roomCapabilityProbe === nonce; } catch { /* unsupported formal JSON response */ }
      this.capability = { key: response.configurationKey!, state: valid ? 'verified' : 'unsupported', checkedAt: Date.now() };
      this.diagnostics.record({ phase: 'capability_probe', outcome: valid ? 'succeeded' : 'failed', ...(valid ? {} : { code: 'capability_unsupported' }), durationMs: performance.now() - started });
      return this.capabilities();
    };
    const pending = run().finally(() => { if (this.probeFlight === pending) this.probeFlight = undefined; });
    this.probeFlight = pending;
    return pending;
  }

  async run(ctx: RoomExecutionContext, signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomFormalResult> {
    if (ctx.member.model && ctx.member.model.provider !== 'deepseek') throw new RoomRuntimeError('capability_unsupported');
    if (!ctx.member.model && this.capabilities().structuredOutput === 'unsupported') throw new RoomRuntimeError('capability_unsupported');
    const messages = compileRoomMessages(ctx);
    if (tools && !beforeRequest) throw new RoomRuntimeError('budget_exhausted');
    if (tools) messages[0].content += `\n\n${ROOM_TOOL_CONTRACT}`;
    let toolCount = 0;
    for (let request = 1; request <= 6; request++) {
      if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > ROOM_CONTEXT_MAX_BYTES) throw new RoomRuntimeError('context_too_large');
      const response = await this.requestOnce(messages, signal, ctx.attempt.deadlineTs, beforeRequest ? () => beforeRequest(`request-${request}`) : undefined, !!tools, ctx.member.model);
      signal.throwIfAborted();
      if (!response.toolCalls?.length) {
        const result = parseRoomFormalResult(response.content, ctx);
        if (!ctx.member.model) this.capability = { key: response.configurationKey!, state: 'verified', checkedAt: Date.now() };
        return result;
      }
      if (!tools) throw new RoomRuntimeError('tool_forbidden');
      if (request === 6 || toolCount + response.toolCalls.length > 12) throw new RoomRuntimeError('tool_limit');
      // DeepSeek's tool continuation requires reasoning_content. It stays in this
      // attempt's private request list and is never returned, persisted or shared.
      const continuation = { role: 'assistant' as const, content: '', tool_calls: response.toolCalls.map(call => ({ id: call.id, type: 'function' as const, function: { name: call.name, arguments: JSON.stringify(call.args) } })), ...(ctx.member.model?.provider === 'deepseek' && response.privateReasoning !== undefined ? { reasoning_content: response.privateReasoning } : {}) };
      messages.push(continuation);
      for (const call of response.toolCalls) {
        signal.throwIfAborted();
        toolCount++;
        const started = performance.now();
        try {
          const result = projectRoomToolResult(call, tools.call(call), ctx);
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
          this.diagnostics.record({ phase: 'tool', outcome: 'succeeded', attempt: ctx.attempt, durationMs: performance.now() - started });
        } catch (error) {
          this.diagnostics.record({ phase: 'tool', outcome: 'failed', attempt: ctx.attempt, code: 'tool_forbidden', durationMs: performance.now() - started });
          throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError('tool_forbidden');
        }
      }
    }
    throw new RoomRuntimeError('tool_limit');
  }

  async requestOnce(messages: RoomModelMessage[], signal: AbortSignal, deadlineTs: number, beforeRequest?: () => boolean, allowTools = false, memberModel?: RoomMemberModel): Promise<RoomModelResponse> {
    let config: LlmConfig;
    try { config = this.configProvider(); }
    catch { throw new RoomRuntimeError('not_configured'); }
    if (!isLlmConfigured(config)) throw new RoomRuntimeError('not_configured');
    if (signal.aborted) throw new RoomRuntimeError('cancelled');
    const remaining = deadlineTs - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new RoomRuntimeError('timeout');
    const timeoutController = new AbortController();
    // Capacity waiting is governed by the attempt deadline. Resolve the complete
    // provider configuration again at the actual send boundary: a queued request
    // must not use credentials or an endpoint which an administrator replaced.
    let timeout = setTimeout(() => timeoutController.abort(), Math.min(remaining, MAX_REQUEST_TIMEOUT_MS));
    const combined = AbortSignal.any([signal, timeoutController.signal]);
    let release: (() => void) | undefined;
    const started = performance.now();
    let sent = false;
    try {
      release = await this.acquire?.(combined);
      this.diagnostics.record({ phase: 'capacity', outcome: 'succeeded', durationMs: performance.now() - started });
      combined.throwIfAborted();
      try { config = this.configProvider(); } catch { throw new RoomRuntimeError('not_configured'); }
      if (!isLlmConfigured(config)) throw new RoomRuntimeError('not_configured');
      const requestRemaining = deadlineTs - Date.now();
      if (requestRemaining <= 0) throw new RoomRuntimeError('timeout');
      const configuredTimeout = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : 90_000;
      clearTimeout(timeout);
      timeout = setTimeout(() => timeoutController.abort(), Math.min(requestRemaining, configuredTimeout, MAX_REQUEST_TIMEOUT_MS));
      if (beforeRequest && !beforeRequest()) throw new RoomRuntimeError('cancelled');
      sent = true;
      this.diagnostics.record({ phase: 'request', outcome: 'started' });
      const response = await this.fetchFn(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: memberModel?.model ?? config.model, messages, temperature: config.temperature,
          ...(memberModel ? { reasoning_effort: memberModel.effort } : {}),
          stream: false, response_format: { type: 'json_object' }, max_tokens: 8_192,
          ...(allowTools ? { tools: ROOM_TOOLS, tool_choice: 'auto', parallel_tool_calls: false } : {}),
        }),
        signal: combined,
        redirect: 'error',
      });
      if (!response.ok) {
        // A provider may echo its Authorization header or input in an error body.
        // Cancel without reading it; only a stable classification leaves here.
        await response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) throw new RoomRuntimeError('provider_auth');
        if (response.status === 429) throw new RoomRuntimeError('provider_rate_limited');
        if (response.status >= 500) throw new RoomRuntimeError('provider_unavailable');
        throw new RoomRuntimeError('provider_rejected');
      }
      const raw = await readResponse(response, combined);
      combined.throwIfAborted();
      if (!raw || typeof raw !== 'object') throw new RoomRuntimeError('protocol_invalid');
      const envelope = raw as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }>; usage?: unknown };
      const choice = Array.isArray(envelope.choices) ? envelope.choices[0] : undefined;
      const message = choice?.message;
      if (!message) throw new RoomRuntimeError('protocol_invalid');
      let toolCalls: RoomToolCall[] | undefined;
      if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) {
        if (!allowTools || !Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > 12 || choice?.finish_reason !== 'tool_calls') throw new RoomRuntimeError('protocol_invalid');
        toolCalls = message.tool_calls.map((value: unknown) => {
          if (!value || typeof value !== 'object') throw new RoomRuntimeError('protocol_invalid');
          const call = value as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } };
          if (call.type !== 'function' || !call.function) throw new RoomRuntimeError('protocol_invalid');
          return parseRoomToolCall(call.id, call.function.name, call.function.arguments);
        });
        if (new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new RoomRuntimeError('protocol_invalid');
      } else if (typeof message.content !== 'string' || !message.content.trim() || (choice?.finish_reason !== undefined && choice.finish_reason !== 'stop')) throw new RoomRuntimeError('protocol_invalid');
      const usage = safeUsage(envelope.usage);
      this.diagnostics.record({ phase: 'request', outcome: 'succeeded', durationMs: performance.now() - started, inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens });
      return { content: toolCalls ? '' : message.content as string, usage, configurationKey: configurationKey(memberModel ? { ...config, model: memberModel.model } : config), ...(toolCalls ? { toolCalls } : {}), ...(memberModel?.provider === 'deepseek' && toolCalls && typeof message.reasoning_content === 'string' ? { privateReasoning: message.reasoning_content } : {}) };
    } catch (error) {
      const code = signal.aborted ? 'cancelled' : timeoutController.signal.aborted ? 'timeout' : error instanceof RoomRuntimeError ? error.code : 'provider_unavailable';
      this.diagnostics.record({ phase: sent ? 'request' : 'capacity', outcome: code === 'cancelled' ? 'cancelled' : 'failed', code, durationMs: performance.now() - started });
      throw new RoomRuntimeError(code);
    } finally {
      clearTimeout(timeout);
      release?.();
    }
  }
}

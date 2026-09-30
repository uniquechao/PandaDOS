import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fsyncSync, openSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomMember, RoomMemberModel } from '../../shared/rooms';
import type { RoomModelCatalog } from '../../shared/room-models';
import type { RoomAttempt, RoomExecutionContext, RoomFormalResult } from './contracts';
import { compileRoomMessages, ROOM_CONTEXT_MAX_BYTES, type RoomRuntime, type RoomToolPort, type RoomModelMessage } from './runtime';
import { parseRoomFormalResult, ROOM_SUBMISSION_MAX_BYTES, RoomRuntimeError } from './protocol';
import { projectRoomToolResult } from './tools';
import { bootId, inspectLocalGroup, localHash, privateDirectory, privateWrite, processStart, readRecord, releaseLocalLock, sameAttempt, signalLocalGroup, type LocalCliRecord } from './local-cli-state';

type CliProvider = 'claude' | 'codex';
export interface RoomLocalTextContext { attempt: RoomAttempt; member: Pick<RoomMember, 'id' | 'model'> }
export interface RoomLocalCliRuntimeOptions {
  /** Operator-owned private service state, never a project working tree. */
  stateDir: string;
  claudePath?: string;
  codexPath?: string;
  claudeHome?: string;
  codexHome?: string;
  acquire?: (signal: AbortSignal) => Promise<() => void>;
  pollMs?: number;
  /** Only the documented authentication variables are forwarded. */
  environment?: NodeJS.ProcessEnv;
}
const EFFORTS = ['low', 'medium', 'high'] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const CODEX_DISABLED = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'multi_agent_v2', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use', 'code_mode', 'code_mode_host', 'view_image', 'image_generation', 'memories', 'goals', 'sleep_tool', 'skill_search', 'tool_suggest', 'skill_mcp_dependency_install', 'shell_snapshot', 'unbounded_connection_retries'];
const versionChecks = new Map<string, boolean>();
const wait = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function executable(value: string): string | undefined {
  const candidates = isAbsolute(value) ? [value] : (process.env.PATH ?? '').split(':').map(part => join(part, value));
  return candidates.find(path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } });
}
function safeJson(path: string): Record<string, unknown> | undefined {
  try { if (statSync(path).size > 4_194_304) return undefined; return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function validModel(value: RoomMemberModel | undefined): value is RoomMemberModel {
  return !!value && (value.provider === 'claude' || value.provider === 'codex') && MODEL_ID.test(value.model) && !/\s/.test(value.model) && EFFORTS.includes(value.effort);
}
function sessionId(memberId: string): string {
  const hash = localHash(memberId);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/** Explicit controlled model metadata prevents a model catalog re-enabling host tools. */
export function roomCodexModelCatalog(model: string): Record<string, unknown> {
  return { models: [{ slug: model, display_name: model, description: '', default_reasoning_level: 'medium', supported_reasoning_levels: EFFORTS.map(effort => ({ effort, description: effort })), shell_type: 'default', visibility: 'list', supported_in_api: true, priority: 1, base_instructions: '', include_skills_usage_instructions: false, include_plugin_usage_instructions: false, include_apps_usage_instructions: false, default_reasoning_summary: 'none', support_verbosity: false, apply_patch_tool_type: null, web_search_tool_type: 'text', truncation_policy: { mode: 'tokens', limit: 10_000 }, context_window: 196_608, effective_context_window_percent: 95, experimental_supported_tools: [], input_modalities: ['text'], supports_search_tool: false, supports_experimental_context: false, use_responses_lite: false, node_repl_disabled: true, tool_mode: 'standard', multi_agent_version: null }] };
}

/** Local single-turn CLI sessions; no shared tmux, project configs or private history. */
export class RoomLocalCliRuntime implements RoomRuntime {
  readonly cancellationMode = 'confirm' as const;
  private readonly stateDir: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly paths: Partial<Record<CliProvider, string>>;
  private readonly homes: Record<CliProvider, string>;
  private readonly supported: Record<CliProvider, boolean>;
  private readonly active = new Set<string>();
  constructor(private readonly options: RoomLocalCliRuntimeOptions) {
    this.stateDir = resolve(options.stateDir);
    this.environment = options.environment ?? process.env;
    this.paths = { claude: executable(options.claudePath ?? 'claude'), codex: executable(options.codexPath ?? 'codex') };
    this.homes = { claude: options.claudeHome ?? this.environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), codex: options.codexHome ?? this.environment.CODEX_HOME ?? join(homedir(), '.codex') };
    this.supported = { claude: this.supports('claude'), codex: this.supports('codex') };
  }
  private supports(provider: CliProvider): boolean {
    const path = this.paths[provider];
    if (!path || (process.platform !== 'linux' && process.platform !== 'darwin')) return false;
    try {
      const stat = statSync(path);
      const key = JSON.stringify([provider, path, stat.ino, stat.size, stat.mtimeMs]);
      const cached = versionChecks.get(key);
      if (cached !== undefined) return cached;
      const version = spawnSync(path, ['--version'], { timeout: 5_000, maxBuffer: 16_384, encoding: 'utf8' });
      // These are the versions verified with an untrusted localhost model fixture.
      // An upgrade must be revalidated, never silently fall back to broader tools.
      const supported = version.status === 0 && (provider === 'claude' ? /\b2\.1\.(?:282|284)\b/.test(version.stdout) : /\b0\.156\.1\b/.test(version.stdout));
      versionChecks.set(key, supported);
      return supported;
    } catch { return false; }
  }
  private authenticated(provider: CliProvider): boolean {
    return provider === 'claude'
      ? !!(this.environment.CLAUDE_CODE_OAUTH_TOKEN || this.environment.ANTHROPIC_AUTH_TOKEN || this.environment.ANTHROPIC_API_KEY || existsSync(join(this.homes.claude, '.credentials.json')))
      : !!(this.environment.OPENAI_API_KEY || existsSync(join(this.homes.codex, 'auth.json')));
  }
  private available(provider: CliProvider): boolean { this.supported[provider] = this.supports(provider); return this.supported[provider] && this.authenticated(provider); }
  configured(): boolean { return (['claude', 'codex'] as const).some(provider => this.available(provider)); }
  configuredFor(members: RoomMember[]): boolean {
    return members.length > 0 && members.every(member => validModel(member.model) && this.available(member.model.provider as CliProvider));
  }
  modelCatalog(): RoomModelCatalog {
    return { providers: (['claude', 'codex'] as const).map(provider => {
      const available = this.available(provider);
      let ids: string[] = [];
      if (provider === 'codex') {
        const cache = safeJson(join(this.homes.codex, 'models_cache.json'));
        if (Array.isArray(cache?.models)) ids = cache.models.map(value => value?.slug).filter((value): value is string => typeof value === 'string' && MODEL_ID.test(value)).slice(0, 100);
      } else {
        const model = this.environment.ANTHROPIC_MODEL ?? safeJson(join(this.homes.claude, 'settings.json'))?.model;
        if (typeof model === 'string' && MODEL_ID.test(model)) ids = [model];
        ids.push('sonnet', 'opus');
      }
      return { provider, available, models: [...new Set(ids)].map(id => ({ id, efforts: [...EFFORTS] })), ...(ids[0] ? { defaultModel: ids[0] } : {}), metering: 'cli_invocations' as const,
        ...(!available ? { reason: !this.paths[provider] ? 'cli_not_installed' : !this.supported[provider] ? 'cli_version_unsupported' : 'cli_auth_missing' } : {}) };
    }) };
  }
  private roomDirectory(attempt: RoomAttempt): string { return join(this.stateDir, 'rooms', localHash(`${attempt.projectId}:${attempt.roomId}`)); }
  private recordPath(attempt: RoomAttempt): string { return join(this.roomDirectory(attempt), 'attempts', localHash(attempt.id), 'process.json'); }
  /** Called before the DB confirmation flag; no process can start from this record. */
  prepareAttempt(context: RoomLocalTextContext): void {
    const attempt = context.attempt;
    const path = this.recordPath(attempt);
    const prior = readRecord(path);
    if (prior) { if (!sameAttempt(prior, attempt)) throw new RoomRuntimeError('scope_mismatch'); return; }
    const record: LocalCliRecord = { version: 1, attemptId: attempt.id, projectId: attempt.projectId, roomId: attempt.roomId, memberId: attempt.memberId, missionId: attempt.missionId, workerId: attempt.workerId, fence: attempt.fence, controlEpoch: attempt.controlEpoch, provider: context.member.model?.provider as CliProvider, bootId: bootId(), pid: null, startTime: null, state: 'prepared', exitCode: null };
    privateWrite(path, JSON.stringify(record));
  }
  private bindMember(attempt: RoomAttempt): string {
    const directory = join(this.stateDir, 'members', localHash(attempt.memberId));
    privateDirectory(directory);
    const path = join(directory, 'binding.json');
    const binding = { memberId: attempt.memberId, projectId: attempt.projectId, roomId: attempt.roomId };
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, JSON.stringify(binding)); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const saved = safeJson(path);
      if (JSON.stringify(saved) !== JSON.stringify(binding)) throw new RoomRuntimeError('scope_mismatch');
    }
    return directory;
  }
  private childEnvironment(provider: CliProvider, home: string): Record<string, string> {
    const env: Record<string, string> = { PATH: this.environment.PATH ?? '/usr/local/bin:/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1' };
    const auth = provider === 'claude' ? ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL'] : ['OPENAI_API_KEY'];
    for (const key of auth) if (this.environment[key]) env[key] = this.environment[key]!;
    if (provider === 'claude') Object.assign(env, { CLAUDE_CONFIG_DIR: join(home, '.claude'), CLAUDE_CODE_SAFE_MODE: '1', CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', DISABLE_AUTOUPDATER: '1' });
    else env.CODEX_HOME = join(home, '.codex');
    return env;
  }
  private prepare(context: RoomLocalTextContext, directory: string, messages: RoomModelMessage[]): { executable: string; args: string[]; env: Record<string, string>; cwd: string; input: string; outputPath: string; deadlineTs: number; formalPath?: string } {
    const model = context.member.model!;
    const provider = model.provider as CliProvider;
    const memberDirectory = this.bindMember(context.attempt);
    const home = join(memberDirectory, provider, 'home');
    const cwd = join(directory, 'workspace');
    privateDirectory(home); privateDirectory(cwd);
    privateWrite(join(cwd, '.room-root'), '');
    const authFile = provider === 'claude' ? '.credentials.json' : 'auth.json';
    const authSource = join(this.homes[provider], authFile);
    const configHome = join(home, provider === 'claude' ? '.claude' : '.codex');
    privateDirectory(configHome);
    const authCopy = join(configHome, authFile);
    if (existsSync(authSource)) privateWrite(authCopy, readFileSync(authSource, 'utf8'));
    else if (existsSync(authCopy)) unlinkSync(authCopy);
    const systemPath = join(directory, 'system.txt');
    privateWrite(systemPath, messages[0].content);
    const common = { executable: this.paths[provider]!, env: this.childEnvironment(provider, home), cwd, input: messages[1].content, outputPath: join(directory, 'stdout.json'), deadlineTs: context.attempt.deadlineTs };
    if (provider === 'claude') return { ...common, args: ['--print', '--safe-mode', '--restricted', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--session-id', sessionId(context.member.id), '--max-turns', '1', '--output-format', 'json', '--model', model.model, '--effort', model.effort, '--system-prompt-file', systemPath] };
    const catalogPath = join(directory, 'models.json');
    privateWrite(catalogPath, JSON.stringify(roomCodexModelCatalog(model.model)));
    const formalPath = join(directory, 'formal.json');
    // Built-in Codex provider definitions are immutable. Its bounded internal
    // retries are included in one CLI invocation, never reported as one HTTP call.
    const config = [`model_catalog_json=${JSON.stringify(catalogPath)}`, `model_instructions_file=${JSON.stringify(systemPath)}`, `model_reasoning_effort=${JSON.stringify(model.effort)}`, 'project_doc_max_bytes=0', 'web_search="disabled"', 'mcp_servers={}', 'project_root_markers=[".room-root"]', 'approval_policy="never"'];
    return { ...common, formalPath, args: ['exec', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--json', '--model', model.model, '-C', cwd, '--output-last-message', formalPath, ...CODEX_DISABLED.flatMap(name => ['--disable', name]), '--enable', 'skip_host_skill_discovery', ...config.flatMap(value => ['-c', value]), '-'] };
  }
  async run(context: RoomExecutionContext, signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomFormalResult> {
    const messages = compileRoomMessages(context);
    // With CLI host tools disabled, authorized source bodies are explicit formal
    // inputs. The same broker projection enforces audience, version and digest.
    const input = JSON.parse(messages[1].content);
    if (input.sources.length > 12) throw new RoomRuntimeError('tool_limit');
    input.sources = input.sources.map((metadata: { id: string; version: number }) => {
      if (!tools) throw new RoomRuntimeError('tool_forbidden');
      const call = { id: `source-${metadata.id}`, name: 'read_source' as const, args: { sourceId: metadata.id, version: metadata.version } };
      return projectRoomToolResult(call, tools.call(call), context);
    });
    messages[1].content = JSON.stringify(input);
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > ROOM_CONTEXT_MAX_BYTES) throw new RoomRuntimeError('context_too_large');
    return parseRoomFormalResult(await this.runText(context, messages, signal, beforeRequest), context);
  }
  /** Same restricted CLI transport for a bounded configuration proposal, without a room conversation. */
  async runText(context: RoomLocalTextContext, messages: RoomModelMessage[], signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean): Promise<string> {
    if (messages.length !== 2 || messages[0].role !== 'system' || messages[1].role !== 'user'
      || Buffer.byteLength(JSON.stringify(messages), 'utf8') > ROOM_CONTEXT_MAX_BYTES) throw new RoomRuntimeError('context_too_large');
    this.prepareAttempt(context);
    if (!validModel(context.member.model) || !this.available(context.member.model.provider as CliProvider)) throw new RoomRuntimeError('not_configured');
    if (!beforeRequest) throw new RoomRuntimeError('budget_exhausted');
    const attempt = context.attempt;
    const roomDirectory = this.roomDirectory(attempt);
    const recordPath = this.recordPath(attempt);
    let record: LocalCliRecord | undefined;
    let release: (() => void) | undefined;
    let locked = false;
    let abort = false;
    const onAbort = () => { abort = true; if (record) signalLocalGroup(record, 'SIGTERM'); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      release = await this.options.acquire?.(signal);
      if (signal.aborted || Date.now() >= attempt.deadlineTs) throw new RoomRuntimeError('cancelled');
      if (!this.available(context.member.model.provider as CliProvider)) throw new RoomRuntimeError('not_configured');
      privateDirectory(roomDirectory);
      try { symlinkSync(dirname(recordPath), join(roomDirectory, 'execution.lock'), 'dir'); locked = true; }
      catch { throw new RoomRuntimeError('cli_busy'); }
      const prior = readRecord(recordPath);
      if (!prior || !sameAttempt(prior, attempt) || prior.state !== 'prepared' || prior.pid !== null || prior.stopped || existsSync(join(dirname(recordPath), 'cancelled'))) throw new RoomRuntimeError('scope_mismatch');
      const directory = dirname(recordPath);
      privateDirectory(directory);
      record = prior;
      const job = this.prepare(context, directory, messages);
      const jobPath = join(directory, 'job.json');
      privateWrite(jobPath, JSON.stringify(job));
      if (signal.aborted || Date.now() >= attempt.deadlineTs || !beforeRequest('request-1')) throw new RoomRuntimeError('cancelled');
      const supervisor = spawn(process.execPath, [fileURLToPath(new URL('./local-cli-worker.ts', import.meta.url)), recordPath, jobPath], { detached: true, env: { PATH: process.env.PATH }, stdio: ['pipe', 'ignore', 'ignore'], shell: false });
      supervisor.stdin.on('error', () => {});
      await new Promise<void>((done, fail) => { supervisor.once('spawn', done); supervisor.once('error', () => fail(new RoomRuntimeError('runtime_failed'))); });
      record.pid = supervisor.pid!;
      record.startTime = processStart(record.pid) ?? null;
      if (!record.startTime) { supervisor.stdin.end(); throw new RoomRuntimeError('runtime_failed'); }
      privateWrite(recordPath, JSON.stringify(record));
      this.active.add(attempt.id);
      supervisor.stdin.end('GO\n');
      let stopSince: number | undefined;
      for (;;) {
        const persisted = readRecord(recordPath);
        if (persisted && sameAttempt(persisted, attempt)) record = persisted;
        if (signal.aborted || abort || Date.now() >= attempt.deadlineTs) {
          stopSince ??= Date.now();
          signalLocalGroup(record, Date.now() - stopSince >= 350 ? 'SIGKILL' : 'SIGTERM');
        }
        const state = inspectLocalGroup(record);
        if (state === 'gone') {
          // The worker may write its exit receipt between our earlier read and
          // the /proc scan. Reload only after termination, before persisting proof.
          const finished = readRecord(recordPath);
          if (!finished || !sameAttempt(finished, attempt)) throw new RoomRuntimeError('scope_mismatch');
          record = finished; record.stopped = true; privateWrite(recordPath, JSON.stringify(record)); break;
        }
        await wait(this.options.pollMs ?? 75);
      }
      if (signal.aborted || abort) throw new RoomRuntimeError('cancelled');
      if (Date.now() >= attempt.deadlineTs) throw new RoomRuntimeError('timeout');
      if (record.failure) throw new RoomRuntimeError(record.failure);
      if (record.state !== 'exited' || record.exitCode !== 0) throw new RoomRuntimeError('runtime_failed');
      let formal: string;
      if (record.provider === 'claude') {
        const envelope = safeJson(job.outputPath);
        if (!envelope || envelope.is_error === true || typeof envelope.result !== 'string') throw new RoomRuntimeError('protocol_invalid');
        formal = envelope.result;
      } else {
        if (!job.formalPath || statSync(job.formalPath).size > ROOM_SUBMISSION_MAX_BYTES) throw new RoomRuntimeError('protocol_invalid');
        formal = readFileSync(job.formalPath, 'utf8');
      }
      return formal;
    } catch (error) {
      if (record && inspectLocalGroup(record) !== 'gone') {
        // No timeout or rejected promise can assert process termination.
        while (!(await this.confirmStopped(attempt, new AbortController().signal))) await wait(this.options.pollMs ?? 75);
      }
      throw error instanceof RoomRuntimeError ? error : new RoomRuntimeError('runtime_failed');
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.active.delete(attempt.id);
      if (locked && record && inspectLocalGroup(record) === 'gone') releaseLocalLock(roomDirectory, record);
      else if (locked && !record) unlinkSync(join(roomDirectory, 'execution.lock'));
      release?.();
    }
  }
  async confirmStopped(attempt: RoomAttempt, signal: AbortSignal): Promise<boolean> {
    let record: LocalCliRecord | undefined;
    try { record = readRecord(this.recordPath(attempt)); } catch { return false; }
    if (!record || !sameAttempt(record, attempt)) return false;
    // A permanent stop marker prevents a registered-but-not-yet-started worker
    // from launching after recovery acknowledged its prepared record as absent.
    privateWrite(join(dirname(this.recordPath(attempt)), 'cancelled'), '1');
    record = readRecord(this.recordPath(attempt));
    if (!record || !sameAttempt(record, attempt)) return false;
    let state = inspectLocalGroup(record);
    if (state === 'unknown' || signal.aborted) return false;
    if (state === 'running') {
      signalLocalGroup(record, 'SIGTERM');
      await wait(375);
      if (signal.aborted) return false;
      signalLocalGroup(record, 'SIGKILL');
      for (let i = 0; i < 10; i++) { state = inspectLocalGroup(record); if (state !== 'running' || signal.aborted) break; await wait(25); }
    }
    if (state !== 'gone' || signal.aborted) return false;
    record.stopped = true;
    privateWrite(this.recordPath(attempt), JSON.stringify(record));
    releaseLocalLock(this.roomDirectory(attempt), record);
    return true;
  }
}

import type { ExecutorDriver } from '../executor/driver';
import { MAX_INJECT_CHARS } from '../executor/driver';
import { detectSelection, isCodexUpdatePrompt } from './screen';
import { readDriverText } from './skills';
import { DEFAULT_CODEX_ARGS } from './conversations';
import type { AgentKind } from './types';

export type AgentArtifactDriver = Pick<
  ExecutorDriver,
  | 'findExecutable'
  | 'createSession'
  | 'killSession'
  | 'sendKeys'
  | 'sendKey'
  | 'capturePane'
  | 'writeFile'
  | 'statPath'
  | 'readFileRange'
  | 'removeTree'
>;

export interface AgentArtifactRunnerDeps {
  driver: AgentArtifactDriver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface AgentArtifactInputFile {
  path: string;
  data: Uint8Array | string;
  mode?: number;
}

export interface AgentArtifactSpec<T = unknown> {
  key: string;
  path: string;
  maxBytes: number;
  required?: boolean;
  /** Reject oversize content instead of preserving the legacy bounded-read behavior. */
  rejectOversize?: boolean;
  parse?: (text: string) => T;
}

export interface RunAgentArtifactsInput {
  agent: AgentKind;
  cwd: string;
  session: string;
  scratch: string;
  prompt: string;
  inputFiles: AgentArtifactInputFile[];
  donePath: string;
  artifacts: AgentArtifactSpec[];
}

export interface RunAgentArtifactsOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  readyDelayMs?: number;
  claudeArgs?: string;
  codexArgs?: string;
  signal?: AbortSignal;
  /** Legacy runners clear interactive trust/permission prompts; sandboxed callers can disable it. */
  autoApproveMenus?: boolean;
  /** Design runs retain their run directory as an auditable recovery record. */
  preserveScratch?: boolean;
}

export type RunAgentArtifactsResult =
  | { ok: true; artifacts: Record<string, unknown> }
  | {
      ok: false;
      reason:
        | 'executable-not-found'
        | 'prompt-too-long'
        | 'timeout'
        | 'cancelled'
        | 'malformed-artifact'
        | 'error';
      artifact?: string;
      error?: string;
    };

interface ResolvedOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  readyDelayMs: number;
  claudeArgs: string;
  codexArgs: string;
  signal?: AbortSignal;
  preserveScratch: boolean;
  autoApproveMenus: boolean;
}

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'signal'> = {
  pollIntervalMs: 4000,
  timeoutMs: 8 * 60 * 1000,
  readyDelayMs: 12000,
  claudeArgs: '--permission-mode acceptEdits',
  codexArgs: DEFAULT_CODEX_ARGS,
  preserveScratch: false,
  autoApproveMenus: true,
};

const AFFIRM_RE = /(yes|accept|proceed|trust|continue|allow|confirm|同意|信任|继续|确认|接受|允许)/i;

/** Shared with the legacy adapters and deliberately falls back to the current first option. */
export function pickAffirmative(options: string[]): number {
  const index = options.findIndex((option) => AFFIRM_RE.test(option));
  return index >= 0 ? index : 0;
}

function shellWord(word: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

export function agentArtifactCommand(
  agent: AgentKind,
  executable: string,
  args: { claudeArgs: string; codexArgs: string },
): string {
  const extra = agent === 'codex' ? args.codexArgs : args.claudeArgs;
  return `${shellWord(executable)} ${extra}`.trim();
}

export class AgentArtifactRunner {
  private readonly driver: AgentArtifactDriver;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: AgentArtifactRunnerDeps) {
    this.driver = deps.driver;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async killQuiet(session: string): Promise<void> {
    await this.driver.killSession(session).catch(() => {});
  }

  private async removeQuiet(path: string): Promise<void> {
    await this.driver.removeTree(path).catch(() => {});
  }

  private async clearMenusOnce(session: string, autoApproveMenus: boolean): Promise<void> {
    const pane = await this.driver.capturePane(session).catch(() => '');
    if (isCodexUpdatePrompt(pane)) {
      await this.driver.sendKeys(session, '2').catch(() => {});
      return;
    }
    if (!autoApproveMenus) return;
    const selection = detectSelection(pane);
    if (!selection) return;
    const target = pickAffirmative(selection.options);
    const delta = target - selection.cursorIndex;
    const key = delta < 0 ? 'Up' : 'Down';
    for (let index = 0; index < Math.abs(delta); index++) {
      await this.driver.sendKey(session, key).catch(() => {});
    }
    await this.driver.sendKey(session, 'Enter').catch(() => {});
  }

  private cancelled(signal?: AbortSignal): boolean {
    return signal?.aborted === true;
  }

  private async waitReady(session: string, options: ResolvedOptions): Promise<boolean> {
    let waited = 0;
    while (waited < options.readyDelayMs) {
      if (this.cancelled(options.signal)) return false;
      await this.clearMenusOnce(session, options.autoApproveMenus);
      await this.sleep(options.pollIntervalMs);
      waited += options.pollIntervalMs;
    }
    if (this.cancelled(options.signal)) return false;
    await this.clearMenusOnce(session, options.autoApproveMenus);
    return !this.cancelled(options.signal);
  }

  private async pollUntilDone(
    session: string,
    donePath: string,
    options: ResolvedOptions,
  ): Promise<'done' | 'timeout' | 'cancelled'> {
    const deadline = this.now() + options.timeoutMs;
    while (this.now() < deadline) {
      if (this.cancelled(options.signal)) return 'cancelled';
      await this.clearMenusOnce(session, options.autoApproveMenus);
      if (await this.driver.statPath(donePath).catch(() => null)) return 'done';
      await this.sleep(options.pollIntervalMs);
    }
    return this.cancelled(options.signal) ? 'cancelled' : 'timeout';
  }

  async run(
    input: RunAgentArtifactsInput,
    options: RunAgentArtifactsOptions = {},
  ): Promise<RunAgentArtifactsResult> {
    const resolved: ResolvedOptions = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      readyDelayMs: options.readyDelayMs ?? DEFAULT_OPTIONS.readyDelayMs,
      claudeArgs: options.claudeArgs ?? DEFAULT_OPTIONS.claudeArgs,
      codexArgs: options.codexArgs ?? DEFAULT_OPTIONS.codexArgs,
      preserveScratch: options.preserveScratch ?? DEFAULT_OPTIONS.preserveScratch,
      autoApproveMenus: options.autoApproveMenus ?? DEFAULT_OPTIONS.autoApproveMenus,
      signal: options.signal,
    };
    try {
      await this.killQuiet(input.session);
      await this.removeQuiet(input.scratch);
      if (this.cancelled(resolved.signal)) return { ok: false, reason: 'cancelled' };
      if (input.prompt.length > MAX_INJECT_CHARS) return { ok: false, reason: 'prompt-too-long' };

      const executable = await this.driver.findExecutable(input.agent);
      if (!executable) return { ok: false, reason: 'executable-not-found' };
      for (const file of input.inputFiles) {
        await this.driver.writeFile(file.path, file.data, file.mode);
      }
      await this.driver.createSession(input.session, input.cwd);
      await this.driver.sendKeys(input.session, agentArtifactCommand(input.agent, executable, resolved));
      if (!await this.waitReady(input.session, resolved)) return { ok: false, reason: 'cancelled' };
      await this.driver.sendKeys(input.session, input.prompt);

      const completion = await this.pollUntilDone(input.session, input.donePath, resolved);
      if (completion !== 'done') return { ok: false, reason: completion };

      const artifacts: Record<string, unknown> = {};
      for (const artifact of input.artifacts) {
        const stat = await this.driver.statPath(artifact.path).catch(() => null);
        if (artifact.rejectOversize && stat?.isFile && stat.size > artifact.maxBytes) {
          return { ok: false, reason: 'malformed-artifact', artifact: artifact.key, error: 'artifact exceeds size limit' };
        }
        const text = await readDriverText(this.driver, artifact.path, artifact.maxBytes);
        if (text === null) {
          if (artifact.required !== false) {
            return { ok: false, reason: 'malformed-artifact', artifact: artifact.key };
          }
          artifacts[artifact.key] = null;
          continue;
        }
        try {
          artifacts[artifact.key] = artifact.parse ? artifact.parse(text) : text;
        } catch (error) {
          return {
            ok: false,
            reason: 'malformed-artifact',
            artifact: artifact.key,
            error: String(error).slice(0, 300),
          };
        }
      }
      return { ok: true, artifacts };
    } catch (error) {
      return { ok: false, reason: 'error', error: String(error).slice(0, 300) };
    } finally {
      await this.killQuiet(input.session);
      if (!resolved.preserveScratch) await this.removeQuiet(input.scratch);
    }
  }
}

export function runAgentArtifacts(
  deps: AgentArtifactRunnerDeps,
  input: RunAgentArtifactsInput,
  options?: RunAgentArtifactsOptions,
): Promise<RunAgentArtifactsResult> {
  return new AgentArtifactRunner(deps).run(input, options);
}

import type { ExecutorDriver } from '../executor/driver';
import { MAX_INJECT_CHARS } from '../executor/driver';
import { detectSelection, isCodexUpdatePrompt } from './screen';
import { readDriverText } from './skills';
import { DEFAULT_CODEX_ARGS } from './conversations';
import { codexReasoningArg, ONE_SHOT_REASONING_EFFORT } from './reasoning';
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
  | 'listDir'
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

/** 失败时随结果带回的现场证据（#280 / B-06） */
export interface AgentArtifactDiagnostics {
  /** 失败瞬间的 pane 尾部（截断）——代理到底卡在哪一步，只有这里看得出来 */
  paneTail: string;
  /** scratch 目录里实际存在的文件（名字 + 字节数）：产物写没写出来一目了然 */
  files: Array<{ name: string; size: number }>;
  /** 声明的产物里真的写出来了几个 */
  hadArtifacts: number;
  /** 从起会话到失败的耗时（ms）：用来判断是「跑满超时」还是「早早就挂了」 */
  elapsedMs: number;
}

/** pane 尾部与文件清单的采样上限（只为诊断，不留大对象） */
export const MAX_PANE_TAIL_CHARS = 2000;
export const MAX_DIAGNOSTIC_FILES = 20;

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
  /**
   * 失败时保留 scratch（#280 / B-06）：成功路径照常清理，失败路径留现场给人看。
   * 默认 false —— 保留会在项目目录里堆残留，谁要谁显式开。
   */
  preserveScratchOnFailure?: boolean;
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
      /**
       * done 标记没出现（或产物校验没过），但**产物其实已经写出来了**（#280 / B-06）。
       * 这一轮的钱已经花了（代理完整读过一遍代码库），把结果整体丢掉是纯浪费——
       * 调用方据此决定要不要当部分成功用。
       */
      partial?: boolean;
      /** 抢救回来的产物（partial 时非空；键同 input.artifacts 的 key） */
      artifacts?: Record<string, unknown>;
      /** 失败现场证据；采样在清理之前做，所以 scratch 被删了也还有记录 */
      diagnostics?: AgentArtifactDiagnostics;
    };

interface ResolvedOptions {
  pollIntervalMs: number;
  timeoutMs: number;
  readyDelayMs: number;
  claudeArgs: string;
  codexArgs: string;
  signal?: AbortSignal;
  preserveScratch: boolean;
  preserveScratchOnFailure: boolean;
  autoApproveMenus: boolean;
}

/**
 * codex 的就绪等待（#280 / B-06）。
 *
 * 生产实测：创建时澄清的失败几乎全落在 codex（codex 4 成功 / 47 失败，claude 55 / 3），
 * 而失败一律是「跑满超时也没写出 done」。codex 冷启动比 claude 慢得多（要拉配置、
 * 可能弹更新提示），12 秒就注入提示词的话，文本很可能进了还没接管终端的 shell——
 * 代理压根没收到任务，当然什么都不会写。给它更长的就绪窗口，再配合下面的补交确认。
 */
export const CODEX_READY_DELAY_MS = 30_000;

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'signal'> = {
  pollIntervalMs: 4000,
  timeoutMs: 8 * 60 * 1000,
  readyDelayMs: 12000,
  claudeArgs: '--permission-mode acceptEdits',
  // #281 / I-04：一次性产物会话（澄清 / 模块整理 / 降级路径的执行总结 / 设计运行）统一 low。
  // 这些会话都是「读一遍、写两个文件、结束」，用不着高档推理；而且它们**每条 issue 都会跑**，
  // 是最值得先砍的一块。调用方显式传 codexArgs 仍以调用方为准（设计运行等特例可自己提档）。
  codexArgs: `${DEFAULT_CODEX_ARGS} ${codexReasoningArg(ONE_SHOT_REASONING_EFFORT)}`,
  preserveScratch: false,
  preserveScratchOnFailure: false,
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

  /**
   * 提示词提交确认（#280 / B-06）：**只对 codex**，且最多补交一次。
   *
   * Driver 的 `sendTextWithStableSubmit` 已经处理了「Enter 被 paste-burst 吞掉」那一档；
   * 这里管的是更前面的一档——codex 还没接管终端时，整段提示词打进了 shell，屏上什么都不会变。
   * 判据刻意只用「pane 有没有变化」，**不引入任何抓屏关键词判定**（那种判定在这个文件里
   * 一定会误命中：提示词本身就会被回显）。抓屏不可用时安全退化为不补交——宁可这轮白跑，
   * 也不能把同一段提示词重复灌进一个其实已经在干活的会话。
   */
  private async confirmPromptSubmitted(
    input: RunAgentArtifactsInput,
    paneBefore: string | null,
    options: ResolvedOptions,
  ): Promise<boolean> {
    if (input.agent !== 'codex' || paneBefore === null) return false;
    if (this.cancelled(options.signal)) return false;
    await this.sleep(options.pollIntervalMs);
    const after = await this.driver.capturePane(input.session).catch(() => null);
    if (after === null) return false; // 抓屏不可用：不猜，也不阻断
    if (after.trim() !== paneBefore.trim()) return false; // 屏变了 = 收到了
    await this.driver.sendKeys(input.session, input.prompt).catch(() => {});
    return true;
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

  /**
   * 失败现场采样（#280 / B-06）：pane 尾部 + scratch 文件清单。
   * **必须在清理之前调用**——旧实现超时即 kill + removeTree，事后谁也说不清代理跑到哪一步，
   * 生产上 92% 的创建时澄清失败就是这么变成一句无信息的 `reason=timeout` 的。
   * 采样自身绝不抛错：诊断失败不能盖掉真正的失败原因。
   */
  private async sample(
    session: string,
    scratch: string,
    startedAt: number,
    hadArtifacts: number,
  ): Promise<AgentArtifactDiagnostics> {
    const pane = await this.driver.capturePane(session).catch(() => '');
    const files: Array<{ name: string; size: number }> = [];
    const entries = await this.driver.listDir(scratch).catch(() => []);
    for (const entry of entries.slice(0, MAX_DIAGNOSTIC_FILES)) {
      if (entry.type === 'dir') {
        files.push({ name: `${entry.name}/`, size: -1 });
        continue;
      }
      const stat = await this.driver.statPath(`${scratch}/${entry.name}`).catch(() => null);
      files.push({ name: entry.name, size: stat?.size ?? -1 });
    }
    return {
      paneTail: pane.slice(-MAX_PANE_TAIL_CHARS),
      files,
      hadArtifacts,
      elapsedMs: Math.max(0, this.now() - startedAt),
    };
  }

  /** 读回已写出的产物（缺失的记进 missing，不抛错）——成功路径与抢救路径共用 */
  private async collectArtifacts(
    specs: AgentArtifactSpec[],
  ): Promise<{
    artifacts: Record<string, unknown>;
    present: number;
    missing: string[];
    oversize: string | null;
    parseError: { artifact: string; error: string } | null;
  }> {
    const artifacts: Record<string, unknown> = {};
    const missing: string[] = [];
    let present = 0;
    let oversize: string | null = null;
    let parseError: { artifact: string; error: string } | null = null;
    for (const artifact of specs) {
      const stat = await this.driver.statPath(artifact.path).catch(() => null);
      if (artifact.rejectOversize && stat?.isFile && stat.size > artifact.maxBytes) {
        oversize ??= artifact.key;
        continue;
      }
      const text = await readDriverText(this.driver, artifact.path, artifact.maxBytes).catch(() => null);
      if (text === null) {
        missing.push(artifact.key);
        artifacts[artifact.key] = null;
        continue;
      }
      present++;
      try {
        artifacts[artifact.key] = artifact.parse ? artifact.parse(text) : text;
      } catch (error) {
        parseError ??= { artifact: artifact.key, error: String(error).slice(0, 300) };
      }
    }
    return { artifacts, present, missing, oversize, parseError };
  }

  async run(
    input: RunAgentArtifactsInput,
    options: RunAgentArtifactsOptions = {},
  ): Promise<RunAgentArtifactsResult> {
    const resolved: ResolvedOptions = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
      timeoutMs: options.timeoutMs ?? DEFAULT_OPTIONS.timeoutMs,
      // 按代理分档：显式传了就听调用方的，没传才按代理给默认值（codex 冷启动更慢）
      readyDelayMs: options.readyDelayMs
        ?? (input.agent === 'codex' ? CODEX_READY_DELAY_MS : DEFAULT_OPTIONS.readyDelayMs),
      claudeArgs: options.claudeArgs ?? DEFAULT_OPTIONS.claudeArgs,
      codexArgs: options.codexArgs ?? DEFAULT_OPTIONS.codexArgs,
      preserveScratch: options.preserveScratch ?? DEFAULT_OPTIONS.preserveScratch,
      preserveScratchOnFailure: options.preserveScratchOnFailure ?? DEFAULT_OPTIONS.preserveScratchOnFailure,
      autoApproveMenus: options.autoApproveMenus ?? DEFAULT_OPTIONS.autoApproveMenus,
      signal: options.signal,
    };
    const startedAt = this.now();
    let failed = false;
    try {
      await this.killQuiet(input.session);
      await this.removeQuiet(input.scratch);
      if (this.cancelled(resolved.signal)) { failed = true; return { ok: false, reason: 'cancelled' }; }
      if (input.prompt.length > MAX_INJECT_CHARS) { failed = true; return { ok: false, reason: 'prompt-too-long' }; }

      const executable = await this.driver.findExecutable(input.agent);
      if (!executable) { failed = true; return { ok: false, reason: 'executable-not-found' }; }
      for (const file of input.inputFiles) {
        await this.driver.writeFile(file.path, file.data, file.mode);
      }
      await this.driver.createSession(input.session, input.cwd);
      await this.driver.sendKeys(input.session, agentArtifactCommand(input.agent, executable, resolved));
      if (!await this.waitReady(input.session, resolved)) { failed = true; return { ok: false, reason: 'cancelled' }; }
      const paneBeforePrompt = input.agent === 'codex'
        ? await this.driver.capturePane(input.session).catch(() => null)
        : null;
      await this.driver.sendKeys(input.session, input.prompt);
      await this.confirmPromptSubmitted(input, paneBeforePrompt, resolved);

      const completion = await this.pollUntilDone(input.session, input.donePath, resolved);
      const collected = await this.collectArtifacts(input.artifacts);

      if (completion !== 'done') {
        // 超时/取消也把产物读回来：done 只是「代理自己说完事了」的标记，产物写出来了就有价值。
        const diagnostics = await this.sample(input.session, input.scratch, startedAt, collected.present);
        failed = true;
        return {
          ok: false,
          reason: completion,
          ...(collected.present > 0 ? { partial: true, artifacts: collected.artifacts } : {}),
          diagnostics,
        };
      }

      if (collected.oversize) {
        failed = true;
        return {
          ok: false,
          reason: 'malformed-artifact',
          artifact: collected.oversize,
          error: 'artifact exceeds size limit',
          diagnostics: await this.sample(input.session, input.scratch, startedAt, collected.present),
        };
      }
      if (collected.parseError) {
        failed = true;
        return {
          ok: false,
          reason: 'malformed-artifact',
          artifact: collected.parseError.artifact,
          error: collected.parseError.error,
          diagnostics: await this.sample(input.session, input.scratch, startedAt, collected.present),
        };
      }
      const requiredMissing = input.artifacts
        .filter((a) => a.required !== false && collected.missing.includes(a.key))
        .map((a) => a.key)[0];
      if (requiredMissing !== undefined) {
        failed = true;
        return {
          ok: false,
          reason: 'malformed-artifact',
          artifact: requiredMissing,
          ...(collected.present > 0 ? { partial: true, artifacts: collected.artifacts } : {}),
          diagnostics: await this.sample(input.session, input.scratch, startedAt, collected.present),
        };
      }
      return { ok: true, artifacts: collected.artifacts };
    } catch (error) {
      failed = true;
      return { ok: false, reason: 'error', error: String(error).slice(0, 300) };
    } finally {
      // 清理必须在采样之后：上面每条失败分支都已经把现场取完了，这里才敢删。
      await this.killQuiet(input.session);
      if (!resolved.preserveScratch && !(failed && resolved.preserveScratchOnFailure)) {
        await this.removeQuiet(input.scratch);
      }
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

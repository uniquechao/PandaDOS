/**
 * core/agent-summary —— 「Agent 认知总结」驱动器（新模式的核心 runner）。
 *
 * 语义：用户为某项目选 claude/codex 时，本 runner 在**独立** tmux 会话 `sum-<projectId>`
 * 里拉起该 CLI 代理（绝不碰驱动 issue 的 `cc-<projectId>`），让它：
 *   1) 读历史会话摘要文件（子任务 2 的 buildHistoryDigest 产物，写在 .butler-summary/history.md）；
 *   2) 浏览项目代码库，理解定位/结构/现状；
 *   3) 更新项目根目录 README.md；
 *   4) 把「给用户看的认知总结」写到 .butler-summary/understanding.md；
 *   5) 最后创建标记文件 .butler-summary/done。
 * runner 轮询 done 标记直到出现或超时，读回 understanding.md，清理 scratch 与会话。
 *
 * 为什么用「文件标记」当哨兵而非抓屏找 SUMMARY_DONE：注入提示词本身含指令文字，
 * capture-pane 会把我们自己敲进去的提示回显进来 → 抓屏找关键词必然误命中（v1 子串哨兵事故同源）。
 * 文件标记由代理最后一步写，无回显歧义、纯 Driver 可测。菜单（信任/权限弹窗）仍复用 screen.ts
 * 的 detectSelection 自动过（选肯定项）。
 *
 * 依赖方向：core 最内层。Driver 用 ExecutorDriver 的结构化子集（Pick），SshDriver/LocalDriver 直接满足。
 */
import { DEFAULT_CODEX_ARGS } from './conversations';
import type { AgentKind } from './types';
import type { ExecutorDriver } from '../executor/driver';
import { detectSelection, isCodexUpdatePrompt } from './screen';
import { readDriverText } from './skills';

// isCodexUpdatePrompt 已迁至 core/screen（中立、无循环依赖），此处再导出保持既有引用（clarify-runner/测试）不变
export { isCodexUpdatePrompt };

/** runner 需要的 Driver 子集（tmux + 受限文件；结构兼容 ExecutorDriver） */
export type SummaryDriver = Pick<
  ExecutorDriver,
  | 'listSessions'
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

/** scratch 目录名（挂在项目 cwd 下；README.md 在仓库根，不在此，故清理不误伤） */
export const SCRATCH_DIR = '.butler-summary';
const REL_HISTORY = `${SCRATCH_DIR}/history.md`;
const REL_UNDERSTANDING = `${SCRATCH_DIR}/understanding.md`;
const REL_DONE = `${SCRATCH_DIR}/done`;

/** 认知总结读取上限（防超大文件） */
const MAX_UNDERSTANDING_BYTES = 32 * 1024;

/** 给 cwd 算出各 scratch 绝对路径 */
export function summaryPaths(cwd: string): {
  scratch: string;
  history: string;
  understanding: string;
  done: string;
} {
  const base = cwd.replace(/\/+$/, '');
  return {
    scratch: `${base}/${SCRATCH_DIR}`,
    history: `${base}/${REL_HISTORY}`,
    understanding: `${base}/${REL_UNDERSTANDING}`,
    done: `${base}/${REL_DONE}`,
  };
}

/** 独立总结会话名（项目维度；与驱动 issue 的 cc-<id> 互不干扰） */
export function summarySessionName(projectId: number): string {
  return `sum-${projectId}`;
}

/** 肯定项识别：信任/接受/继续/允许… 选它；都不匹配退化到第 0 项 */
const AFFIRM_RE = /(yes|accept|proceed|trust|continue|allow|confirm|同意|信任|继续|确认|接受|允许)/i;
export function pickAffirmative(options: string[]): number {
  const i = options.findIndex((o) => AFFIRM_RE.test(o));
  return i >= 0 ? i : 0;
}

/**
 * 产物目标：
 * - 'readme'（默认）：更新项目根 README.md（「更新简介」路径，issue 项目为主）；
 * - 'memory'：更新项目记忆文件（claude→CLAUDE.md / codex→AGENTS.md，「更新记忆」路径，对话模式为主）。
 * 两者其余步骤一致（读历史+浏览代码库 → 更新目标文件 → 写 understanding → 最后落 done 哨兵）。
 */
export type SummaryTarget = 'readme' | 'memory';

/** 项目记忆文件名：claude 读 CLAUDE.md，codex 读 AGENTS.md（更新记忆按所选 agent 写对应文件） */
export function memoryFileFor(agent: AgentKind): string {
  return agent === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
}

/** 组装注入给代理的任务提示词（单段：sendKeys 会把换行转空格、截断 2000，故简明成段）。 */
export function buildSummaryPrompt(
  agent: AgentKind,
  projectName?: string,
  target: SummaryTarget = 'readme',
): string {
  const who = projectName ? `项目「${projectName}」` : '本项目';
  if (target === 'memory') {
    const memFile = memoryFileFor(agent);
    return [
      `你在为${who}更新「项目记忆」。请严格按顺序完成，只做这几件事：`,
      `(1) 读取文件 ${REL_HISTORY}（本项目历史对话摘要），并浏览当前项目代码库（目录结构、关键源码与配置），弄清项目定位、结构、约定、当前进展与关键决策；`,
      `(2) 用简洁准确的中文更新（若不存在则新建）项目根目录的 ${memFile}（项目记忆/长期上下文文件），把「后续对话需要知道的持久信息」沉淀进去：项目目标、结构与关键模块、约定与禁区、当前状态与待办、重要决策；增量维护，别删掉仍有效的既有内容；`,
      `(3) 另写一段给用户看的「项目记忆概要」到文件 ${REL_UNDERSTANDING}：讲清项目定位、结构、当前状态与注意事项，纯文本或轻量 markdown，控制在 600 字以内；`,
      `(4) 全部完成后，最后创建标记文件 ${REL_DONE}（内容写 ok 即可）——这一步必须最后做。`,
      `不要改动与记忆无关的代码。`,
      agent === 'codex' ? '（无需请求审批，直接执行。）' : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  return [
    `你在为${who}生成「项目认知总结」。请严格按顺序完成，只做这几件事：`,
    `(1) 读取文件 ${REL_HISTORY}（本项目历史会话摘要），并浏览当前项目代码库（目录结构、README、关键源码与配置），弄清项目是什么、做什么、当前进展与要点；`,
    `(2) 用简洁准确的中文更新（若不存在则新建）项目根目录的 README.md，使其真实反映该项目；`,
    `(3) 另写一段给用户看的「项目认知总结」到文件 ${REL_UNDERSTANDING}：讲清项目定位、主要功能、技术栈、当前状态与注意事项，纯文本或轻量 markdown，控制在 600 字以内；`,
    `(4) 全部完成后，最后创建标记文件 ${REL_DONE}（内容写 ok 即可）——这一步必须最后做。`,
    `不要改动与总结无关的代码。`,
    agent === 'codex' ? '（无需请求审批，直接执行。）' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------- runner ----------

export interface SummaryRunnerDeps {
  driver: SummaryDriver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunSummaryInput {
  projectId: number;
  cwd: string;
  agent: AgentKind;
  /** 历史会话摘要（buildHistoryDigest 产物；至少是 EMPTY_DIGEST 占位） */
  historyDigest: string;
  projectName?: string;
  /** 产物目标（缺省 'readme'）：'memory' = 更新项目记忆文件 CLAUDE.md/AGENTS.md 而非 README.md */
  target?: SummaryTarget;
}

export interface SummaryRunOptions {
  /** 轮询间隔（ms） */
  pollIntervalMs?: number;
  /** 从注入提示词起算的总超时（ms） */
  timeoutMs?: number;
  /** 拉起代理后、注入提示词前的就绪等待（其间清菜单） */
  readyDelayMs?: number;
  /**
   * claude 启动参数。默认 --permission-mode acceptEdits：自动放行 Write/Edit（README、
   * understanding、done 三个产物全是写文件），无需逐个点权限弹窗。它不是 root 下被拒的
   * --dangerously-skip-permissions/bypassPermissions（那俩才 "cannot be used with root"），
   * acceptEdits 只放行编辑、仍受权限约束，root 可用。残留的非编辑弹窗由 clearMenusOnce 兜。
   */
  claudeArgs?: string;
  /** codex 启动参数（默认 bypass 审批+沙箱；codex 该参数在 root 下可用，与生产一致） */
  codexArgs?: string;
  /** 认知总结读取上限（字节） */
  maxUnderstandingBytes?: number;
}

export type RunSummaryResult =
  | { ok: true; understanding: string }
  | { ok: false; reason: 'timeout' | 'no-output' | 'error'; error?: string };

const DEFAULT_OPTIONS: Required<SummaryRunOptions> = {
  pollIntervalMs: 4000,
  timeoutMs: 8 * 60 * 1000,
  readyDelayMs: 12000, // 给 claude/codex 足够启动（codex 还要过更新弹窗 + 重绘 TUI）再注入提示词
  claudeArgs: '--permission-mode acceptEdits', // 自动放行写文件（root 可用，非 bypassPermissions）
  codexArgs: DEFAULT_CODEX_ARGS,
  maxUnderstandingBytes: MAX_UNDERSTANDING_BYTES,
};

export class AgentSummaryRunner {
  private readonly driver: SummaryDriver;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: SummaryRunnerDeps) {
    this.driver = deps.driver;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private startCommand(agent: AgentKind, o: Required<SummaryRunOptions>): string {
    return agent === 'codex' ? `codex ${o.codexArgs}`.trim() : `claude ${o.claudeArgs}`.trim();
  }

  /**
   * 抓屏，若有选择菜单则自动选肯定项（信任/接受/权限弹窗）。
   * 每轮见到菜单就点——**不做签名去重**：连续两次同款权限弹窗（如先写 understanding、
   * 再写 done，选项文字完全一样）签名相同，去重会漏掉后一个 → 卡死永不产出 done（实测坑）。
   * 轮询间隔（默认 4s）远大于渲染时间，重复点也只是多一个空 Enter（无害）。
   */
  private async clearMenusOnce(session: string): Promise<void> {
    const pane = await this.driver.capturePane(session).catch(() => '');
    // codex 启动「有可用更新」弹窗（用 › 光标，detectSelection（认 ❯）抓不到；直接 Enter
    // 会选中高亮的「1. Update now」跑安装脚本）——输入 2 选「Skip」跳过（sendKeys 自带回车确认）。
    if (isCodexUpdatePrompt(pane)) {
      await this.driver.sendKeys(session, '2').catch(() => {});
      return;
    }
    const sel = detectSelection(pane);
    if (!sel) return;
    const target = pickAffirmative(sel.options);
    const delta = target - sel.cursorIndex;
    const key = delta < 0 ? 'Up' : 'Down';
    for (let i = 0; i < Math.abs(delta); i++) {
      await this.driver.sendKey(session, key).catch(() => {});
    }
    await this.driver.sendKey(session, 'Enter').catch(() => {});
  }

  private async killQuiet(session: string): Promise<void> {
    await this.driver.killSession(session).catch(() => {});
  }

  private async removeQuiet(path: string): Promise<void> {
    await this.driver.removeTree(path).catch(() => {});
  }

  /** 就绪等待：拉起代理后等 readyDelayMs，其间反复清菜单（过掉信任弹窗）后再注入提示词。 */
  private async waitReady(session: string, readyDelayMs: number, pollMs: number): Promise<void> {
    let waited = 0;
    while (waited < readyDelayMs) {
      await this.clearMenusOnce(session);
      await this.sleep(pollMs);
      waited += pollMs;
    }
    await this.clearMenusOnce(session);
  }

  /** 轮询 done 标记，其间持续清菜单；出现→true，超时→false。 */
  private async pollUntilDone(
    session: string,
    donePath: string,
    timeoutMs: number,
    pollMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      await this.clearMenusOnce(session);
      const st = await this.driver.statPath(donePath).catch(() => null);
      if (st) return true;
      await this.sleep(pollMs);
    }
    return false;
  }

  async run(input: RunSummaryInput, options: SummaryRunOptions = {}): Promise<RunSummaryResult> {
    const o: Required<SummaryRunOptions> = { ...DEFAULT_OPTIONS, ...options };
    const session = summarySessionName(input.projectId);
    const p = summaryPaths(input.cwd);

    try {
      // 0) 清残留会话与旧 scratch，保证干净起步
      await this.killQuiet(session);
      await this.removeQuiet(p.scratch);

      // 1) 写历史摘要（writeFile 自动建父目录 = 重建 scratch）
      await this.driver.writeFile(p.history, input.historyDigest);

      // 2) 起代理
      await this.driver.createSession(session, input.cwd);
      await this.driver.sendKeys(session, this.startCommand(input.agent, o));

      // 3) 等就绪 + 过信任弹窗
      await this.waitReady(session, o.readyDelayMs, o.pollIntervalMs);

      // 4) 注入任务提示词（按 target 选更新 README 还是项目记忆文件）
      await this.driver.sendKeys(
        session,
        buildSummaryPrompt(input.agent, input.projectName, input.target ?? 'readme'),
      );

      // 5) 轮询 done 标记
      const done = await this.pollUntilDone(session, p.done, o.timeoutMs, o.pollIntervalMs);
      if (!done) return { ok: false, reason: 'timeout' };

      // 6) 读回认知总结（scratch 清理前）
      const text = await readDriverText(this.driver, p.understanding, o.maxUnderstandingBytes);
      const trimmed = (text ?? '').trim();
      if (!trimmed) return { ok: false, reason: 'no-output' };
      return { ok: true, understanding: trimmed };
    } catch (e) {
      return { ok: false, reason: 'error', error: String(e).slice(0, 300) };
    } finally {
      await this.killQuiet(session);
      await this.removeQuiet(p.scratch);
    }
  }
}

/** 便捷函数：一次性跑完并返回结果。 */
export function runAgentSummary(
  deps: SummaryRunnerDeps,
  input: RunSummaryInput,
  options?: SummaryRunOptions,
): Promise<RunSummaryResult> {
  return new AgentSummaryRunner(deps).run(input, options);
}

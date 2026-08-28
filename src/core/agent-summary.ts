/**
 * core/agent-summary —— 「Agent 认知总结」驱动器（新模式的核心 runner）。
 *
 * 语义：用户为某项目选 claude/codex 时，本 runner 在**独立** tmux 会话 `sum-<projectId>`
 * 里拉起该 CLI 代理（绝不碰驱动 issue 的 `cc-<projectId>`），让它：
 *   1) 读历史会话摘要文件（子任务 2 的 buildHistoryDigest 产物，写在 .panda/tmp/summary/history.md）；
 *   2) 浏览项目代码库，理解定位/结构/现状；
 *   3) 更新项目根目录 README.md；
 *   4) 把「给用户看的认知总结」写到 .panda/tmp/summary/understanding.md；
 *   5) 最后创建标记文件 .panda/tmp/summary/done。
 * runner 轮询 done 标记直到出现或超时，读回 understanding.md，清理 scratch 与会话。
 *
 * 为什么用「文件标记」当哨兵而非抓屏找 SUMMARY_DONE：注入提示词本身含指令文字，
 * capture-pane 会把我们自己敲进去的提示回显进来 → 抓屏找关键词必然误命中（v1 子串哨兵事故同源）。
 * 文件标记由代理最后一步写，无回显歧义、纯 Driver 可测。菜单（信任/权限弹窗）仍复用 screen.ts
 * 的 detectSelection 自动过（选肯定项）。
 *
 * 依赖方向：core 最内层。Driver 用 ExecutorDriver 的结构化子集（Pick），SshDriver/LocalDriver 直接满足。
 */
import type { AgentKind } from './types';
import { isCodexUpdatePrompt } from './screen';
import {
  pickAffirmative,
  runAgentArtifacts,
  type AgentArtifactDriver,
} from './agent-artifact-runner';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';

// isCodexUpdatePrompt 已迁至 core/screen（中立、无循环依赖），此处再导出保持既有引用（clarify-runner/测试）不变
export { isCodexUpdatePrompt };
export { pickAffirmative };

/** runner 需要的 Driver 子集（tmux + 受限文件；结构兼容 ExecutorDriver） */
export type SummaryDriver = AgentArtifactDriver;

/** scratch 目录名（挂在项目 cwd 下；README.md 在仓库根，不在此，故清理不误伤） */
export const SCRATCH_DIR = '.panda/tmp/summary';
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
  locale: SupportedLocale = 'zh-Hans',
): string {
  if (promptLanguage(locale) === 'en') {
    const who = projectName ? `project "${projectName}"` : 'this project';
    const targetFile = target === 'memory' ? memoryFileFor(agent) : 'README.md';
    const artifact = target === 'memory' ? 'project memory overview' : 'project understanding summary';
    return [
      `Update ${target === 'memory' ? 'project memory' : 'project documentation'} for ${who}. Perform only these steps in order:`,
      `(1) Read ${REL_HISTORY} and inspect the repository structure, important source/configuration, conventions, current state, and key decisions.`,
      `(2) Incrementally update or create root ${targetFile} so it accurately preserves durable project context; do not remove still-valid content.`,
      `(3) Write a user-facing ${artifact} to ${REL_UNDERSTANDING}, using plain text or light Markdown and at most 600 words.`,
      `(4) As the final step, create ${REL_DONE} containing ok.`,
      `Do not modify unrelated code.`,
      agent === 'codex' ? 'Proceed without requesting approval.' : '',
      outputLanguageInstruction(locale),
    ].filter(Boolean).join(' ');
  }
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
      outputLanguageInstruction(locale),
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
    outputLanguageInstruction(locale),
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
  locale?: SupportedLocale;
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

export class AgentSummaryRunner {
  private readonly driver: SummaryDriver;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: SummaryRunnerDeps) {
    this.driver = deps.driver;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(input: RunSummaryInput, options: SummaryRunOptions = {}): Promise<RunSummaryResult> {
    const session = summarySessionName(input.projectId);
    const p = summaryPaths(input.cwd);
    const result = await runAgentArtifacts(
      { driver: this.driver, now: this.now, sleep: this.sleep },
      {
        agent: input.agent,
        cwd: input.cwd,
        session,
        scratch: p.scratch,
        prompt: buildSummaryPrompt(input.agent, input.projectName, input.target ?? 'readme', input.locale),
        inputFiles: [{ path: p.history, data: input.historyDigest }],
        donePath: p.done,
        artifacts: [{
          key: 'understanding',
          path: p.understanding,
          maxBytes: options.maxUnderstandingBytes ?? MAX_UNDERSTANDING_BYTES,
          required: false,
        }],
      },
      options,
    );
    if (!result.ok) {
      return result.reason === 'timeout'
        ? { ok: false, reason: 'timeout' }
        : { ok: false, reason: 'error', ...(result.error ? { error: result.error } : {}) };
    }
    const understanding = typeof result.artifacts.understanding === 'string'
      ? result.artifacts.understanding.trim()
      : '';
    return understanding ? { ok: true, understanding } : { ok: false, reason: 'no-output' };
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

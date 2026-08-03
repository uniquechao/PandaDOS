/**
 * issues/clarify-runner —— 「创建时澄清」驱动器：新建 issue 后，用该 issue 所选的
 * claude/codex 在**一次性独立** tmux 会话 `clr-<issueId>` 里做只读分析（绝不碰驱动
 * issue 的项目会话），产出：
 *   - 反馈（对需求的理解 / 初步实现思路 / 影响面与风险）→ feedback.md；
 *   - 澄清问题（仅当存在不问清会做错方向的关键歧义）→ questions.md（每行一个）；
 *   - 最后创建标记文件 done。
 * runner 轮询 done 标记直到出现或超时，读回两个产物解析返回，清理 scratch 与会话。
 *
 * 文件哨兵而非抓屏找关键词：与 core/agent-summary 同理（注入提示词含指令文字，
 * capture-pane 会回显我们敲进去的内容，抓屏必误命中）。菜单（信任/权限弹窗）自动过
 * （detectSelection + 肯定项），codex 更新弹窗选 Skip——逻辑与 agent-summary 一致。
 *
 * scratch 按 issue 隔离（.panda/tmp/clarify/<issueId>/）：同项目多条 issue 并发分析互不踩；
 * 清理只删本 issue 子目录，不动兄弟。
 */
import { DEFAULT_CODEX_ARGS } from '../core/conversations';
import {
  isCodexUpdatePrompt,
  pickAffirmative,
  type SummaryDriver,
} from '../core/agent-summary';
import { detectSelection } from '../core/screen';
import { readDriverText } from '../core/skills';
import type { AgentKind, IssueCategory } from '../core/types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';

/** runner 需要的 Driver 子集 = agent-summary 同款（tmux + 受限文件） */
export type ClarifyDriver = SummaryDriver;

/** scratch 根目录名（挂在项目 cwd 下；子目录按 issueId 隔离） */
export const CLARIFY_SCRATCH_BASE = '.panda/tmp/clarify';

/** 反馈读取上限（防超大文件；store 落库另有 8000 截断） */
const MAX_FEEDBACK_BYTES = 32 * 1024;
/** 问题条数/单条长度上限（与 PmAgent.generateClarifyingQuestions 口径一致） */
export const MAX_QUESTIONS = 5;
const MAX_QUESTION_CHARS = 300;

/** 给 cwd + issueId 算出各 scratch 绝对路径 */
export function clarifyPaths(cwd: string, issueId: number): {
  scratch: string;
  task: string;
  feedback: string;
  questions: string;
  done: string;
} {
  const base = `${cwd.replace(/\/+$/, '')}/${CLARIFY_SCRATCH_BASE}/${issueId}`;
  return {
    scratch: base,
    task: `${base}/task.md`,
    feedback: `${base}/feedback.md`,
    questions: `${base}/questions.md`,
    done: `${base}/done`,
  };
}

/** 独立澄清会话名（issue 维度；与驱动项目的 cc-<pid> / 总结的 sum-<pid> 互不干扰） */
export function clarifySessionName(issueId: number): string {
  return `clr-${issueId}`;
}

/** 创建时澄清的一轮问答（问题批 + 用户答复；未答复为 null） */
export interface ClarifyRound {
  questions: string[];
  answer: string | null;
}

/** 组装写给代理读的任务文件（issue 需求 + 项目上下文 + 历轮问答；正文不截断——文件无注入预算） */
export function buildClarifyTaskMd(input: {
  title: string;
  body?: string | null;
  category?: IssueCategory;
  goal?: string | null;
  projectName?: string;
  history?: ClarifyRound[];
}): string {
  const history = input.history?.length
    ? [
        '## 历轮澄清问答',
        '',
        '（以下问题已经问过发起人；**已回答过的不要重复问**，答复是需求的一部分。）',
        '',
        ...input.history.flatMap((r, i) => [
          `### 第 ${i + 1} 轮`,
          '',
          ...r.questions.map((q, j) => `${j + 1}. ${q}`),
          '',
          `答复：${r.answer?.trim() || '（未答复）'}`,
          '',
        ]),
      ]
    : [];
  return [
    `# 任务需求${input.projectName ? `（项目：${input.projectName}）` : ''}`,
    '',
    `- 标题：${input.title}`,
    `- 类型：${input.category ?? 'task'}`,
    ...(input.goal ? [`- 项目目标：${input.goal}`] : []),
    '',
    '## 需求正文',
    '',
    input.body?.trim() || '（无正文，仅标题）',
    '',
    ...history,
  ].join('\n');
}

/**
 * 组装注入给代理的提示词（单段：sendKeys 会把换行转空格、截断 2000，故简明成段；
 * issue 内容不进提示词——写在 task.md 里让代理自己读，绕开注入预算）。
 */
export function buildClarifyPrompt(
  agent: AgentKind,
  issueId: number,
  opts: { allowQuestions?: boolean } = {},
  locale: SupportedLocale = 'zh-Hans',
): string {
  const rel = `${CLARIFY_SCRATCH_BASE}/${issueId}`;
  const allowQuestions = opts.allowQuestions !== false;
  // 提问轮数到顶后：只更新反馈、禁止再出题——反复追问比按最佳判断做更打扰人。
  const questionStep = allowQuestions
    ? `(3) 若存在**不问清楚就会做错方向**的关键歧义或缺失信息，把要问发起人的问题写到文件 ${rel}/questions.md——每行一个、最多 ${MAX_QUESTIONS} 个、简短中文口语（发起人在手机上打字回）；task.md 里历轮问答已回答过的**不要重复问**；实现细节可自行决定的不算歧义，需求清晰就不要创建该文件；`
    : `(3) 本轮不要提问：**不要创建** ${rel}/questions.md——即使仍有歧义，也按 task.md（含历轮问答）里的信息取最佳判断，把取舍写进反馈；`;
  if (promptLanguage(locale) === 'en') {
    const questionStepEn = allowQuestions
      ? `(3) If critical ambiguity would otherwise send implementation in the wrong direction, write up to ${MAX_QUESTIONS} short questions, one per line, to ${rel}/questions.md. Do not repeat questions already answered in task.md. Do not create the file when the request is clear.`
      : `(3) Do not ask questions or create ${rel}/questions.md in this round. Use the best judgment available from task.md and record tradeoffs in the feedback.`;
    return [
      `Perform a read-only pre-implementation analysis. Do not change code or any file outside ${rel}/.`,
      `(1) Read ${rel}/task.md and the relevant repository code to understand the current behavior and where the request belongs.`,
      `(2) Write a concise analysis of the request, likely implementation, affected modules/files, impact, and risks to ${rel}/feedback.md (at most 400 words).`,
      questionStepEn,
      `(4) As the final step, create ${rel}/done containing ok.`,
      agent === 'codex' ? 'Proceed without requesting approval.' : '',
      outputLanguageInstruction(locale),
    ].filter(Boolean).join(' ');
  }
  return [
    `你在对一条新任务做「实施前分析」，这是只读分析，除下述 ${rel}/ 下的产物文件外，不要改动任何文件、不要写代码。请严格按顺序完成：`,
    `(1) 读取文件 ${rel}/task.md（任务需求，含历轮澄清问答），并浏览项目代码库中与之相关的部分，理解现状与该需求的落点；`,
    `(2) 把你的反馈写到文件 ${rel}/feedback.md：对需求的理解、初步实现思路、涉及的模块/文件、影响面与风险，简洁中文，400 字以内；`,
    questionStep,
    `(4) 全部完成后，最后创建标记文件 ${rel}/done（内容写 ok 即可）——这一步必须最后做。`,
    agent === 'codex' ? '（无需请求审批，直接执行。）' : '',
    outputLanguageInstruction(locale),
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * questions.md → 问题列表：逐行取，剥编号/列表符，去空行与「无」类占位；
 * 每条截 300 字，最多 5 条（与 PM 澄清口径一致）。
 */
export function parseQuestions(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const q = raw
      .replace(/^\s*(?:[-*•]|\d+[.)、]|\(\d+\))\s*/, '')
      .trim();
    if (!q) continue;
    if (/^[（(]?(无|没有|none|n\/a)[）)]?[。.]?$/i.test(q)) continue;
    out.push(q.slice(0, MAX_QUESTION_CHARS));
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

// ---------- runner ----------

export interface ClarifyRunnerDeps {
  driver: ClarifyDriver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunClarifyInput {
  issueId: number;
  cwd: string;
  agent: AgentKind;
  title: string;
  body?: string | null;
  category?: IssueCategory;
  goal?: string | null;
  projectName?: string;
  /** 创建时澄清的历轮问答（写进 task.md，代理不得重复问已答过的） */
  history?: ClarifyRound[];
  /** false = 提问轮数到顶：本轮只更新反馈，禁止产出 questions.md（引擎侧另有兜底压制） */
  allowQuestions?: boolean;
  locale?: SupportedLocale;
}

export interface ClarifyRunOptions {
  /** 轮询间隔（ms） */
  pollIntervalMs?: number;
  /** 从注入提示词起算的总超时（ms） */
  timeoutMs?: number;
  /** 拉起代理后、注入提示词前的就绪等待（其间清菜单） */
  readyDelayMs?: number;
  /** claude 启动参数（默认 acceptEdits：产物全是写文件，root 可用，见 agent-summary 同款注释） */
  claudeArgs?: string;
  /** codex 启动参数（默认 bypass 审批+沙箱） */
  codexArgs?: string;
  /** 反馈读取上限（字节） */
  maxFeedbackBytes?: number;
}

export type RunClarifyResult =
  | {
      ok: true;
      feedback: string;
      questions: string[];
      /** questions.md 原文（#110，未剥编号/未截条数；供事件留档、UI 完整展示；无该文件 = ''） */
      questionsText?: string;
    }
  | { ok: false; reason: 'timeout' | 'no-output' | 'error'; error?: string };

const DEFAULT_OPTIONS: Required<ClarifyRunOptions> = {
  pollIntervalMs: 4000,
  timeoutMs: 8 * 60 * 1000,
  readyDelayMs: 12000, // 给 claude/codex 足够启动（codex 还要过更新弹窗 + 重绘 TUI）再注入提示词
  claudeArgs: '--permission-mode acceptEdits',
  codexArgs: DEFAULT_CODEX_ARGS,
  maxFeedbackBytes: MAX_FEEDBACK_BYTES,
};

export class ClarifyRunner {
  private readonly driver: ClarifyDriver;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: ClarifyRunnerDeps) {
    this.driver = deps.driver;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private startCommand(agent: AgentKind, o: Required<ClarifyRunOptions>): string {
    return agent === 'codex' ? `codex ${o.codexArgs}`.trim() : `claude ${o.claudeArgs}`.trim();
  }

  /** 抓屏清菜单一轮（agent-summary 同款：不做签名去重，重复点只是多个空 Enter，无害） */
  private async clearMenusOnce(session: string): Promise<void> {
    const pane = await this.driver.capturePane(session).catch(() => '');
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

  async run(input: RunClarifyInput, options: ClarifyRunOptions = {}): Promise<RunClarifyResult> {
    const o: Required<ClarifyRunOptions> = { ...DEFAULT_OPTIONS, ...options };
    const session = clarifySessionName(input.issueId);
    const p = clarifyPaths(input.cwd, input.issueId);

    try {
      // 0) 清残留会话与旧 scratch（只清本 issue 子目录，不动同项目兄弟）
      await this.killQuiet(session);
      await this.removeQuiet(p.scratch);

      // 1) 写任务文件（writeFile 自动建父目录 = 重建 scratch）
      await this.driver.writeFile(p.task, buildClarifyTaskMd(input));

      // 2) 起代理
      await this.driver.createSession(session, input.cwd);
      await this.driver.sendKeys(session, this.startCommand(input.agent, o));

      // 3) 等就绪 + 过信任弹窗
      await this.waitReady(session, o.readyDelayMs, o.pollIntervalMs);

      // 4) 注入任务提示词
      await this.driver.sendKeys(
        session,
        buildClarifyPrompt(input.agent, input.issueId, { allowQuestions: input.allowQuestions !== false }, input.locale),
      );

      // 5) 轮询 done 标记
      const done = await this.pollUntilDone(session, p.done, o.timeoutMs, o.pollIntervalMs);
      if (!done) return { ok: false, reason: 'timeout' };

      // 6) 读回产物（scratch 清理前）；questions.md 可以不存在（= 需求清晰）
      const feedback = ((await readDriverText(this.driver, p.feedback, o.maxFeedbackBytes)) ?? '').trim();
      const questionsRaw = await readDriverText(this.driver, p.questions, o.maxFeedbackBytes);
      const questions = parseQuestions(questionsRaw);
      if (!feedback && questions.length === 0) return { ok: false, reason: 'no-output' };
      return { ok: true, feedback, questions, questionsText: (questionsRaw ?? '').trim() };
    } catch (e) {
      return { ok: false, reason: 'error', error: String(e).slice(0, 300) };
    } finally {
      await this.killQuiet(session);
      await this.removeQuiet(p.scratch);
    }
  }
}

/** 便捷函数：一次性跑完并返回结果。 */
export function runClarify(
  deps: ClarifyRunnerDeps,
  input: RunClarifyInput,
  options?: ClarifyRunOptions,
): Promise<RunClarifyResult> {
  return new ClarifyRunner(deps).run(input, options);
}

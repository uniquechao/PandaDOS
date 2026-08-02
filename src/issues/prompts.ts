/**
 * issues/prompts —— 各阶段注入 Claude Code 的 prompt 模板。
 * 措辞尽量沿用 v1 四段调优 prompt（评审 2.1 逐字摘录；「单独输出一行」「前后别带其它内容」
 * 等短语与 sentinel.ts 的整行匹配是配套的，两头一起改或都不改）。
 *
 * 相对 v1 的改造（评审 H7/5.2#2）：
 * - 哨兵词升级 STAGE_DONE:<id>:<stage> / SUBTASK_DONE:<id> / TESTS_FAILED:<id> 体系；
 * - 注入长度预算与组装联动：用户可变文本（issue 正文/goal/意见/子任务清单）各自
 *   居中截断到固定预算，哨兵/协议指令永不被截；
 * - 分支上下文入 prompt（implementing/testing 告知工作分支，禁止自行切/合）;
 * - team prompt 补 imgHint（v1 疏漏）。
 *
 * clarifying 阶段没有 CC prompt：澄清已前置到创建时（issues/clarify-runner 独立会话分析，
 * 提问经通知通道发发起人），clarifying 状态仅存量兼容。
 */
import { MAX_INJECT_CHARS } from '../executor/driver';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';

// ---------- 预算（总和 + 固定措辞 ≤ MAX_INJECT_CHARS=2000，哨兵指令必达） ----------
// 集成收敛：注入截断统一回 v1 的 2000（driver.sanitizeInjectText），各预算随之联动缩减，
// 保证组装结果永不触发 driver 的尾部截断（哨兵协议在尾部，截断即失联）。

// 2026-07-27 提速：planning 新增「流程按规模裁剪 + 子任务只写代码改动」的固定措辞（约 150 字），
// 固定措辞与可变预算共用同一个 2000 上限，故三个预算按比例下调让位（worst case 实测 1945）。
export const BUDGET_ISSUE_TEXT = 600; // reserve space for the output-language contract
export const BUDGET_GOAL = 250;
export const BUDGET_FEEDBACK = 450; // 卡点 reject 意见 / 测试失败原因
export const BUDGET_TEAM_LIST = 1120; // reserve language contract without risking sentinel truncation
export const BUDGET_SUBTASK = 500; // 单条子任务（v1 平移）

/** 居中截断（保头保尾，砍中间）——协议性内容在句尾，永不受害 */
export function midTruncate(s: string, n: number): string {
  s = String(s ?? '').trim();
  if (s.length <= n) return s;
  const half = Math.floor((n - 12) / 2);
  return `${s.slice(0, half)}…[中间省略]…${s.slice(-half)}`;
}

/** 组装完成后的兜底校验：不应触发（预算已联动）；万一超限抛错而非静默截断（评审铁律） */
function assertBudget(prompt: string): string {
  if (prompt.length > MAX_INJECT_CHARS) {
    throw new Error(`prompt 超出注入预算(${prompt.length}>${MAX_INJECT_CHARS})，检查预算联动`);
  }
  return prompt;
}

function localizedPrompt(
  locale: SupportedLocale | undefined,
  chinese: string,
  english: string,
): string {
  const selected = locale ?? 'zh-Hans'; // legacy direct callers; production always passes account locale
  return assertBudget(
    `${promptLanguage(selected) === 'zh' ? chinese : english}\n${outputLanguageInstruction(selected)}`,
  );
}

/**
 * 把截图提示追加到已过 assertBudget 的 prompt 尾部：装不下时按整行回退（路径行绝不截半），
 * 一行都装不下则整体丢弃。截图提示是尽力而为的增强——预算吃紧时宁可丢图，
 * 也绝不让 driver 的 2000 截断吃掉前面的哨兵协议（哨兵指令在 imgHint 之前）。
 */
function appendImgHint(base: string, imgHint?: string): string {
  if (!imgHint) return base;
  const room = MAX_INJECT_CHARS - base.length;
  if (imgHint.length <= room) return base + imgHint;
  const cut = imgHint.lastIndexOf('\n', Math.max(0, room));
  return cut <= 0 ? base : base + imgHint.slice(0, cut);
}

/**
 * issue 截图提示后缀：re-export core/uploads 的唯一实现（集成收敛，此前两处同文重复）。
 * 路径必须是执行机侧绝对路径。
 */
export { imageReadHint } from '../core/uploads';

// ---------- 各阶段模板 ----------

export interface PromptIssueLike {
  id: number;
  title: string;
  body: string | null;
}

function issueText(issue: PromptIssueLike, budget = BUDGET_ISSUE_TEXT): string {
  const t = issue.body ? `${issue.title}：${issue.body}` : issue.title;
  return midTruncate(t, budget);
}

/**
 * planning 阶段（v1 buildAlignPrompt 措辞沿用）：要求输出 SUBTASKS_BEGIN/END 块。
 * feedback = 卡点① reject 意见（回炉重排时带上）。
 */
export function buildPlanningPrompt(opts: {
  issue: PromptIssueLike;
  goal?: string | null;
  feedback?: string | null;
  imgHint?: string;
  /** 模块永久共享会话的新 issue 切换提示；缺省表示独立会话，不额外占注入预算。 */
  moduleName?: string | null;
  locale?: SupportedLocale;
}): string {
  const goal = opts.goal ? midTruncate(opts.goal, BUDGET_GOAL) : '';
  const fb = opts.feedback ? midTruncate(opts.feedback, BUDGET_FEEDBACK) : '';
  const boundaryZh = opts.moduleName
    ? `【模块共享会话 · ${midTruncate(opts.moduleName, 60)}】当前切换到 Issue #${opts.issue.id}。` +
      `保留此前模块技术上下文，但前一个 Issue 已结束；当前目标和验收范围只以 Issue #${opts.issue.id} 为准。`
    : '';
  const boundaryEn = opts.moduleName
    ? `[Shared module conversation · ${midTruncate(opts.moduleName, 60)}] Now switching to Issue #${opts.issue.id}. ` +
      `Retain prior module technical context, but the previous issue is finished; use only Issue #${opts.issue.id} for the current goal and acceptance scope. `
    : '';
  const issue = issueText(opts.issue, opts.moduleName ? 480 : BUDGET_ISSUE_TEXT);
  const zh =
    boundaryZh +
      `【任务规划】我想做：${issue}${goal ? `（项目目标：${goal}）` : ''}。` +
      (fb ? `上一版计划被驳回，意见：${fb}。请针对意见重新规划。` : '') +
      `请先别写代码，通读相关代码理解现状；若有**不问清就会做错方向**的关键歧义、必须我拍板才能继续，` +
      `就把问题按编号列出、最后单独输出一行 NEED_CLARIFY:${opts.issue.id}` +
      `（**用纯文字提问，不要用交互式多选菜单/AskUserQuestion**，我在手机上打字回），我回答后你再继续；` +
      `实现细节能自决的别停下来问。流程按改动规模裁剪：小改动读完相关代码直接动手，别走「头脑风暴→写计划文档→TDD」全套。` +
      `确认理解充分后把它拆成有序、可独立执行的子任务：**子任务只写代码改动本身**，` +
      `跑测试/类型检查/构建/浏览器自测/commit/push 由系统统一负责，一律别写进子任务；` +
      `条数按规模来，一两处文件的小改动就只出 1 条，别为凑完整硬拆细。` +
      `然后严格单独输出一段(前后不要别的内容)：` +
      `先一行 SUBTASKS_BEGIN，然后每行一个带序号的子任务，最后一行 SUBTASKS_END。我确认后才开始实施。`;
  const en =
    boundaryEn +
    `[Task planning] Requested work: ${issue}${goal ? ` (Project goal: ${goal})` : ''}. ` +
    (fb ? `The previous plan was rejected with this feedback: ${fb}. Re-plan around that feedback. ` : '') +
    `Do not write code yet. Read the relevant code first. Ask only about critical ambiguity that would otherwise send the work in the wrong direction; list numbered questions and then output NEED_CLARIFY:${opts.issue.id} on its own line. ` +
    `Use plain text, not an interactive AskUserQuestion menu. Decide implementation details yourself. Scale the process to the change; small changes do not need the full brainstorming, plan-document, and TDD workflow. ` +
    `When ready, split only the code changes into ordered, independently executable subtasks. Do not include tests, type checks, builds, browser checks, commits, or pushes because the system handles them. ` +
    `Output only one block: SUBTASKS_BEGIN on its own line, one numbered subtask per line, and SUBTASKS_END on its own line. Wait for confirmation before implementation.`;
  const base = localizedPrompt(opts.locale, zh, en);
  return appendImgHint(base, opts.imgHint);
}

/** implementing / seq 模式：逐个喂子任务（v1 buildSubtaskPrompt 措辞沿用；SUBTASK_DONE 带 id） */
export function buildSubtaskPrompt(opts: {
  issue: PromptIssueLike;
  subtasks: string[];
  idx: number;
  branch: string;
  locale?: SupportedLocale;
}): string {
  const { issue, subtasks, idx, branch } = opts;
  const sub = midTruncate(subtasks[idx] ?? '', BUDGET_SUBTASK);
  const zh = `【实施 子任务 ${idx + 1}/${subtasks.length}】${sub}。` +
      `当前工作分支 ${branch}，不要自行切换分支或合并。` +
      `流程按改动规模裁剪：小改动直接改，别为这一条走「头脑风暴→写计划文档→TDD」全套。` +
      `完成并跑相关测试通过后，单独输出一行：SUBTASK_DONE:${issue.id}。` +
      `若必须我先拍板/补充信息才能继续，按编号列出问题并单独输出一行：NEED_CLARIFY:${issue.id}，我回答后再继续；` +
      `若卡住无法完成，单独输出一行：ISSUE_BLOCKED:${issue.id} 简短原因。` +
      `完成本子任务前别做清单外的事。`;
  const en = `[Implementation subtask ${idx + 1}/${subtasks.length}] ${sub}. ` +
    `The current working branch is ${branch}; do not switch or merge branches. Scale the process to the change. ` +
    `After completing it and passing relevant tests, output SUBTASK_DONE:${issue.id} on its own line. ` +
    `If a user decision or missing information is essential, list numbered questions and output NEED_CLARIFY:${issue.id} on its own line. ` +
    `If blocked, output ISSUE_BLOCKED:${issue.id} followed by a short reason on its own line. Do nothing outside this subtask before it is complete.`;
  return localizedPrompt(opts.locale, zh, en);
}

/** implementing / team 模式：一次性交付全部子任务（v1 buildTeamPrompt 措辞沿用 + 补 imgHint） */
export function buildTeamPrompt(opts: {
  issue: PromptIssueLike;
  subtasks: string[];
  goal?: string | null;
  branch: string;
  imgHint?: string;
  locale?: SupportedLocale;
}): string {
  const goal = opts.goal ? midTruncate(opts.goal, BUDGET_GOAL) : '';
  const list = midTruncate(
    opts.subtasks.map((s, i) => `(${i + 1}) ${midTruncate(s, BUDGET_SUBTASK)}`).join('  '),
    BUDGET_TEAM_LIST,
  );
  const zh = `【Agent team 实施】${goal ? `总目标：${goal}。` : ''}` +
      `当前工作分支 ${opts.branch}，不要自行切换分支或合并。` +
      `请用你的 Agent team（Task 工具起多个子代理）分工并行完成下面全部子任务：${list}。` +
      `流程按改动规模裁剪：小改动直接改，别走「头脑风暴→写计划文档→TDD」全套。` +
      `各子代理完成后你汇总并跑相关测试，全部通过后单独输出一行：STAGE_DONE:${opts.issue.id}:implementing；` +
      `若必须我先拍板/补充信息才能继续，按编号列出问题并单独输出一行：NEED_CLARIFY:${opts.issue.id}，我回答后再继续；` +
      `若卡住无法完成，单独输出一行：ISSUE_BLOCKED:${opts.issue.id} 简短原因。`;
  const en = `[Agent team implementation] ${goal ? `Overall goal: ${goal}. ` : ''}` +
    `The current working branch is ${opts.branch}; do not switch or merge branches. Use the Task tool to delegate these subtasks in parallel: ${list}. ` +
    `Scale process to the change. After consolidating all work and passing relevant tests, output STAGE_DONE:${opts.issue.id}:implementing on its own line. ` +
    `If a user decision is essential, list numbered questions and output NEED_CLARIFY:${opts.issue.id} on its own line. If blocked, output ISSUE_BLOCKED:${opts.issue.id} followed by a short reason on its own line.`;
  const base = localizedPrompt(opts.locale, zh, en);
  return appendImgHint(base, opts.imgHint);
}

/** implementing 返工（testing 失败回退 / 卡点② reject）：带意见修复 */
export function buildReworkPrompt(opts: {
  issue: PromptIssueLike;
  feedback: string;
  branch: string;
  source: 'tests_failed' | 'review_rejected';
  locale?: SupportedLocale;
}): string {
  const fb = midTruncate(opts.feedback || '(未说明)', BUDGET_FEEDBACK);
  const head = opts.source === 'tests_failed' ? '测试未通过' : '合并 review 未通过，意见';
  const zh = `【返工】${head}：${fb}。请在分支 ${opts.branch} 上修复/调整，改完做必要的自测/跑相关测试验证。` +
      `完成并验证通过后，单独输出一行：STAGE_DONE:${opts.issue.id}:implementing；` +
      `若必须我先拍板/补充信息才能继续，按编号列出问题并单独输出一行：NEED_CLARIFY:${opts.issue.id}，我回答后再继续；` +
      `若卡住无法继续，单独输出一行：ISSUE_BLOCKED:${opts.issue.id} 简短原因。`;
  const headEn = opts.source === 'tests_failed' ? 'Tests failed' : 'Merge review was rejected';
  const en = `[Rework] ${headEn}: ${fb}. Fix or adjust it on branch ${opts.branch}, then run the relevant checks. ` +
    `After verification passes, output STAGE_DONE:${opts.issue.id}:implementing on its own line. ` +
    `If a user decision is essential, list numbered questions and output NEED_CLARIFY:${opts.issue.id} on its own line. If blocked, output ISSUE_BLOCKED:${opts.issue.id} followed by a short reason on its own line.`;
  return localizedPrompt(opts.locale, zh, en);
}

/** testing 阶段：完整跑测试/编译门并汇报 */
export function buildTestingPrompt(opts: { issue: PromptIssueLike; branch: string; locale?: SupportedLocale }): string {
  const zh = `【测试验证】实施已完成（分支 ${opts.branch}）。请完整跑本项目的测试/编译门（类型检查、单测等），` +
      `确认改动没破坏现有功能。全部通过后，单独输出一行：STAGE_DONE:${opts.issue.id}:testing；` +
      `有失败先尝试就地修复，仍无法通过则单独输出一行：TESTS_FAILED:${opts.issue.id} 简短原因；` +
      `若必须我先拍板才能继续，按编号列出问题并单独输出一行：NEED_CLARIFY:${opts.issue.id}，我回答后再继续；` +
      `若被环境问题卡死无法继续，单独输出一行：ISSUE_BLOCKED:${opts.issue.id} 简短原因。`;
  const en = `[Test verification] Implementation is complete on branch ${opts.branch}. Run the project's complete test/build gates, including type checks and unit tests, and verify no existing behavior regressed. ` +
    `When everything passes, output STAGE_DONE:${opts.issue.id}:testing on its own line. Try to fix failures locally; if they remain, output TESTS_FAILED:${opts.issue.id} followed by a short reason on its own line. ` +
    `If a user decision is essential, output NEED_CLARIFY:${opts.issue.id}; if blocked by the environment, output ISSUE_BLOCKED:${opts.issue.id} followed by a short reason.`;
  return localizedPrompt(opts.locale, zh, en);
}

// ---------- nudge（v1 三条文案平移改哨兵名；「前后别带其它内容」与整行匹配配套） ----------

/**
 * planning 判 done 却没解析到子任务块时的重输出指令（issue #48：judged=done 死循环出口）。
 * 场景：代理很可能已经规划完（甚至输出过块），但产物没进到引擎绑定的会话文件
 * （会话错绑/换绑后旧输出不回读）——让它重发一遍，格式要求与 sentinel.parseSubtasksBlock 配套。
 */
export function buildReplanRequest(locale: SupportedLocale = 'zh-Hans'): string {
  const zh =
    `你可能已经完成了子任务规划，但我没有收到规范格式的子任务块。` +
    `请严格按格式重新完整输出一遍：先一行 SUBTASKS_BEGIN，然后每行一个带序号的子任务，` +
    `最后一行 SUBTASKS_END（这三部分各自独占一行，前后别带其它内容）。`;
  const en = `You may have finished planning, but I did not receive a valid subtask block. Output it again in full: SUBTASKS_BEGIN on its own line, one numbered subtask per line, and SUBTASKS_END on its own line, with no surrounding content.`;
  return localizedPrompt(locale, zh, en);
}

/**
 * 执行中澄清等待超时（spec 第 2 点）：到点仍没等到发起人回答，注入此句让代理按最佳判断
 * （合理默认）继续推进、别再停下等；若发起人之后补充说明会以新消息追加。
 */
export function buildClarifyContinue(locale: SupportedLocale = 'zh-Hans'): string {
  const zh =
    `未收到你对刚才澄清问题的回复，请按你的最佳判断（合理默认）继续推进，不用再停下来等我；` +
    `若我之后补充了说明，会以新消息发给你。`;
  const en = `No response arrived for the clarification questions. Continue using your best judgment and reasonable defaults without waiting again. Any later clarification will arrive as a new message.`;
  return localizedPrompt(locale, zh, en);
}

export function buildNudge(opts: {
  issue: PromptIssueLike;
  stage: 'planning' | 'implementing' | 'testing';
  /** implementing 下：seq 且还有未完子任务 → 催 SUBTASK_DONE；否则催 STAGE_DONE */
  seqPending?: boolean;
  locale?: SupportedLocale;
}): string {
  const id = opts.issue.id;
  // 催促里附带 NEED_CLARIFY 逃生口：代理若确有必须我拍板的问题，走协议标记等待（引擎会停催、
  // 转「等待用户澄清」）——而不是像旧文案那样无条件「别停下来等我」把它推着往前做错方向。
  const clarifyHint = `确需我拍板才能继续的，按编号列出问题并单独输出一行 NEED_CLARIFY:${id}，我回答后再继续`;
  if (opts.stage === 'planning') {
    const zh =
      `子任务规划好了就严格按格式输出：一行 SUBTASKS_BEGIN、每行一个子任务、一行 SUBTASKS_END` +
      `（前后别带其它内容）；${clarifyHint}；否则请继续规划。`;
    const en = `When subtask planning is ready, output exactly one SUBTASKS_BEGIN line, one subtask per line, and one SUBTASKS_END line, with no surrounding content. If a user decision is essential, list numbered questions and output NEED_CLARIFY:${id} on its own line; otherwise continue planning.`;
    return localizedPrompt(opts.locale, zh, en);
  }
  if (opts.stage === 'implementing') {
    const zh = opts.seqPending
      ? `当前子任务完成且测试通过了就单独输出一行 SUBTASK_DONE:${id}；${clarifyHint}；否则没完成请继续。`
      : `全部完成且测试通过后，单独输出一行 STAGE_DONE:${id}:implementing（前后别带其它内容）；${clarifyHint}；否则没完成请继续。`;
    const en = opts.seqPending
      ? `When the current subtask is complete and tests pass, output SUBTASK_DONE:${id} on its own line. If a user decision is essential, output NEED_CLARIFY:${id}; otherwise continue.`
      : `When all work is complete and tests pass, output STAGE_DONE:${id}:implementing on its own line with no surrounding content. If a user decision is essential, output NEED_CLARIFY:${id}; otherwise continue.`;
    return localizedPrompt(opts.locale, zh, en);
  }
  const zh = `测试都通过了就单独输出一行 STAGE_DONE:${id}:testing（前后别带其它内容）；没通过就继续处理（无法通过就输出一行 TESTS_FAILED:${id} 原因）；${clarifyHint}。`;
  const en = `When all tests pass, output STAGE_DONE:${id}:testing on its own line with no surrounding content. Continue fixing failures, or output TESTS_FAILED:${id} followed by a reason if they cannot be fixed. If a user decision is essential, output NEED_CLARIFY:${id}.`;
  return localizedPrompt(opts.locale, zh, en);
}

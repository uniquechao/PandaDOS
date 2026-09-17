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
export const BUDGET_RECOVERY_GUIDANCE = 320;
export const BUDGET_RECOVERY_SUBTASKS = 320;
// 2026-09-06（#275 / B-08）：哨兵边界说明写全后固定措辞变长（英文 team 实测 2341>2000），
// 按「固定措辞与可变预算共用同一个 2000 上限」的既有纪律，让位给它下调到 720（英文 worst case 1941）。
// 2026-09-09（#301）：边界说明再补「纯告知不发标记」与受阻三段格式（英文 +130 字），同一条纪律
// 再让位一次下调到 560（英文 team worst case 1976、testing 固定措辞 1957——这两处已贴着上限，
// 以后再往固定措辞里加话，先跑 prompts.test 的 worst case，别指望还有余量）。
export const BUDGET_TEAM_LIST = 560; // reserve language contract without risking sentinel truncation
// 2026-09-07（#277 / I-02）：planning 与受阻恢复续跑内联了模块文档规则（中文 192 / 英文 ~370 字），
// 这两处不再靠静态预算表硬扛「每种组合都不破 2000」——改由 fitParts 按顺序压缩可变字段
// （见下方注释）。常量保持不变，只是从「唯一保证」降级成「首轮上限」。
export const BUDGET_SUBTASK = 500; // 单条子任务（v1 平移）

/**
 * NEED_CLARIFY 与 ISSUE_BLOCKED 的边界说明（B-08）。
 *
 * 原文只有「必须我先拍板就 NEED_CLARIFY，卡住就 ISSUE_BLOCKED」两句，太短，代理经常
 * 在同一条回复里两个都发（实测：一次「我需要你确认 X，否则无法继续」就同时命中两个协议）。
 * 而引擎的哨兵判定是先到先得，混发的结果一律被判 blocked，用户的问题就被吞掉了。
 *
 * 所以这里必须把三件事讲全：**互斥**、**怎么选**（我回答能不能解开）、**混发会怎样**。
 * 措辞是所有阶段共用的唯一维护点，别再在各个 builder 里各写各的。
 *
 * #301 再补两条，起因是用户看到「受阻」只有一句话，不知道是告知还是要自己动手：
 * 1. **三分**——只是同步进展、列可选后续、自己能接着干的，一个标记都别发（发了就白白
 *    中断队列还要人工解锁）；要用户拍板/补信息的走澄清；只有必须用户亲自动手才是受阻。
 * 2. **受阻原因写成三段**「在做什么｜卡在哪｜要我做什么」，代理顺手写、零额外调用；
 *    读端是 `shared/blocked.ts:parseBlockedNote`，UI 据此拆三行展示，两头要改一起改。
 */
export function sentinelBoundary(issueId: number, locale: SupportedLocale | undefined): string {
  const zh = `两个协议标记互斥、一次最多发一个：只是同步进展、列可选后续、你自己能接着干的 → 一个标记都别发，直接继续；` +
    `我回答就能解开的（需要拍板或补充信息）→ 先按编号列出问题，再单独输出一行 NEED_CLARIFY:${issueId}，然后停下等我；` +
    `仅限当前目标内、你无法自行解除且必须我亲自动手才算受阻（如账号授权或线下操作）→ 单独输出一行 ` +
    `ISSUE_BLOCKED:${issueId} 在做什么｜卡在哪｜要我做什么（三段用｜分隔，整行不超过 200 字）。` +
    `同一条回复里两个都出现时按澄清处理，ISSUE_BLOCKED 会被忽略。`;
  const en = `Emit at most one of these two markers. For progress or optional advice, emit no marker and keep going. ` +
    `For essential decisions/info, list questions then NEED_CLARIFY:${issueId} on its own line and wait. ` +
    `Only for in-scope obstacles you cannot resolve without my action, emit ISSUE_BLOCKED:${issueId} what you were doing | where you are stuck | what I must do (200 chars max). ` +
    `Both markers means clarification.`;
  return promptLanguage(locale ?? DEFAULT_LOCALE) === 'zh' ? zh : en;
}

/**
 * 收尾时随最后一次 `STAGE_DONE:<id>:testing` 一并带出的结构化完成报告块（#275 / I-05）。
 *
 * 刻意要求**内联输出、不要写文件**：写文件要 mkdir + 写两个文件 + 写哨兵四次工具调用，
 * 而这段内容代理此刻本来就在脑子里。字段清单与 completion-report.ts 的 schema 必须对齐，
 * 两头一起改；解析不通过时引擎会静默忽略并退回确定性拼装，所以这里不必吓唬代理。
 */
export function completionReportHint(issueId: number, locale: SupportedLocale | undefined): string {
  const zh = `输出 STAGE_DONE:${issueId}:testing 的同一条回复里，再附一段完成报告块：` +
    `单独一行 REPORT_BEGIN，中间一段 JSON，再单独一行 REPORT_END（不要写文件，也不要加代码围栏）。` +
    `JSON 字段：version(固定 1)、outcome(complete|partial|blocked)、objective、` +
    `implementation[]、advantages[]、disadvantages[]、verification[]、completion、` +
    `unmetGoals[]、remainingWork[]只填原始需求内未完成的必要工作；系统门禁/提交/推送不算遗留，未推送或推送失败只作提示；部署仅在明确要求上线时算目标；后续交付和可选建议放 optionalFollowUps[]，无遗留写空数组。`;
  const en = `In the same reply as STAGE_DONE:${issueId}:testing, append a completion report block: ` +
    `a line REPORT_BEGIN, one JSON object, then a line REPORT_END (inline, no files, no code fences). ` +
    `Fields: version (always 1), outcome (complete|partial|blocked), objective, implementation[], ` +
    `advantages[], disadvantages[], verification[], completion, unmetGoals[], remainingWork[]; ` +
    `unmetGoals/remainingWork: required in-scope work only, never system gates/commits/pushes. Failed pushes and unrequested deployment are optionalFollowUps[], not blockers. Requested deployment remains required. Use [] for no required work.`;
  return promptLanguage(locale ?? DEFAULT_LOCALE) === 'zh' ? zh : en;
}

/**
 * 模块文档规则（#277 / I-02）：把 `.claude/skills/panda-issue` 的五条规则内联进注入 prompt。
 *
 * 为什么不再依赖技能文件：技能要代理自己判断「这次算不算 issue/模块场景」再去读，
 * 命中率不稳定，读一遍还额外烧一轮工具调用；而这五条规则本来就短。内联之后
 * `.claude/skills/panda-issue/SKILL.md` 只剩「给人看」的用途，运行时不再依赖它。
 *
 * 只加进 planning/kickoff 与受阻恢复续跑这两处——那里代理才真的要去读写模块文档；
 * 逐条子任务、返工、测试阶段加它纯属浪费预算。
 */
export function moduleDocsRule(locale: SupportedLocale | undefined): string {
  const zh = `【模块文档】先从当前目录向上定位项目根，读 .panda/modules/INDEX.md，` +
    `再读本模块 MODULE.md 和本 prompt 指定的 issue 过程页；` +
    `实施中只在过程页记关键设计、决策、涉及文件与测试结论，不记逐条终端流水；` +
    `收尾前更新过程页，只把长期仍有效的知识提炼回 MODULE.md；` +
    `不要自行批量新建模块；文档、数据库事实与代码三者冲突时停止写入并明确报告。`;
  const en = `[Module docs] Find the project root from the cwd; read .panda/modules/INDEX.md, ` +
    `this module's MODULE.md, and the issue process page named here. Record only key design, decisions, ` +
    `files and test results there, not a terminal log; update it before finishing and promote only durable ` +
    `knowledge to MODULE.md. Never bulk-create modules; if docs, DB and code disagree, stop and report.`;
  return promptLanguage(locale ?? DEFAULT_LOCALE) === 'zh' ? zh : en;
}

/**
 * 变长字段装箱（#277 / I-02）。
 *
 * 固定措辞越写越长，静态预算表就越来越难保证「每一种组合都不破 2000」——planning 的
 * 「受阻恢复 + 驳回意见 + 模块名」三件套在本条之前就已经实测 2296/3111 会抛预算错。
 * 所以改成：各字段先按各自上限截断，若组装出来仍超限，就按给定顺序继续往下压，
 * 直到装得下为止。**哨兵协议与固定措辞永不参与压缩**，被压的只可能是用户可变文本。
 */
function fitParts<T extends Record<string, string>>(
  parts: T,
  order: ReadonlyArray<readonly [keyof T, number]>,
  render: (p: T) => string,
): string {
  let current = { ...parts };
  let out = render(current);
  for (const [key, floor] of order) {
    while (out.length > MAX_INJECT_CHARS && current[key]!.length > floor) {
      const before = current[key]!;
      const next = Math.max(floor, Math.floor(before.length * 0.8));
      // floor = 0 表示「压到底就整块丢掉」：连同它的引导语一起消失（引导语都写成
      // 「非空才拼」），这样极端组合下还能再腾出几十字给哨兵协议。
      // midTruncate 会补省略标记，短串截出来可能不减反增——那就直接丢掉，绝不空转。
      const shrunk = next <= 0 ? '' : midTruncate(before, next);
      current = { ...current, [key]: shrunk.length < before.length ? shrunk : '' };
      out = render(current);
    }
    if (out.length <= MAX_INJECT_CHARS) break;
  }
  return out;
}

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

/** 组装但不校验预算：给 fitParts 反复试算用；对外一律走 localizedPrompt */
function composePrompt(
  locale: SupportedLocale | undefined,
  chinese: string,
  english: string,
): string {
  const selected = locale ?? 'zh-Hans'; // legacy direct callers; production always passes account locale
  return `${promptLanguage(selected) === 'zh' ? chinese : english}\n${outputLanguageInstruction(selected)}`;
}

function localizedPrompt(
  locale: SupportedLocale | undefined,
  chinese: string,
  english: string,
): string {
  return assertBudget(composePrompt(locale, chinese, english));
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
  /** 受阻后由用户明确给出的恢复方法，以及保存后的子任务快照。 */
  recovery?: { guidance: string; subtasks: string[] } | null;
  imgHint?: string;
  /** Only explicit project review requires a human plan approval. */
  manualReview?: boolean;
  /** 模块永久共享会话的新 issue 切换提示；缺省表示独立会话，不额外占注入预算。 */
  moduleName?: string | null;
  locale?: SupportedLocale;
}): string {
  const parts = {
    goal: opts.goal ? midTruncate(opts.goal, opts.recovery ? 100 : BUDGET_GOAL) : '',
    fb: opts.feedback ? midTruncate(opts.feedback, BUDGET_FEEDBACK) : '',
    guidance: opts.recovery ? midTruncate(opts.recovery.guidance, BUDGET_RECOVERY_GUIDANCE) : '',
    recoverySubtasks: opts.recovery
      ? midTruncate(
          opts.recovery.subtasks.map((text, index) => `${index + 1}. ${text}`).join('\n'),
          BUDGET_RECOVERY_SUBTASKS,
        )
      : '',
    issue: issueText(opts.issue, opts.recovery ? 360 : opts.moduleName ? 480 : BUDGET_ISSUE_TEXT),
  };
  const render = (p: typeof parts): string => {
  const { goal, fb, guidance: recoveryGuidance, recoverySubtasks, issue } = p;
  const boundaryZh = opts.moduleName
    ? `【模块共享会话 · ${midTruncate(opts.moduleName, 60)}】当前切换到 Issue #${opts.issue.id}。` +
      `保留此前模块技术上下文，但前一个 Issue 已结束；当前目标和验收范围只以 Issue #${opts.issue.id} 为准。`
    : '';
  const boundaryEn = opts.moduleName
    ? `[Shared module conversation · ${midTruncate(opts.moduleName, 60)}] Now on Issue #${opts.issue.id}. ` +
      `Keep the module's technical context; the previous issue is done. Scope everything to Issue #${opts.issue.id}. `
    : '';
  const recoveryZh = recoveryGuidance
    ? `【受阻恢复】用户给出的解除方法：${recoveryGuidance}。` +
      (recoverySubtasks ? `保存后的子任务如下：\n${recoverySubtasks}\n请以更新后的 issue 内容、解除方法和子任务为准重新规划。` : '')
    : '';
  const recoveryEn = recoveryGuidance
    ? `[Blocked recovery] Guidance: ${recoveryGuidance}. ` +
      (recoverySubtasks ? `Saved subtasks:\n${recoverySubtasks}\nRe-plan from the updated issue, guidance and subtasks. ` : '')
    : '';
  const zh =
    boundaryZh +
      `【任务规划】我想做：${issue}${goal ? `（项目目标：${goal}）` : ''}。` +
      (fb ? `上一版计划被驳回，意见：${fb}。请针对意见重新规划。` : '') +
      recoveryZh +
      `请先别写代码，通读相关代码理解现状；若有**不问清就会做错方向**的关键歧义、必须我拍板才能继续，` +
      `就把问题按编号列出、最后单独输出一行 NEED_CLARIFY:${opts.issue.id}` +
      `（**用纯文字提问，不要用交互式多选菜单/AskUserQuestion**，我在手机上打字回），我回答后你再继续；` +
      `实现细节能自决的别停下来问。流程按改动规模裁剪：先判断整体复杂度（依赖、风险、设计取舍），默认不加载 superpowers；简单任务直接做，复杂任务才按需选技能；部署仅在明确要求上线时纳入目标。` +
      `默认只输出 1 条端到端交付：**子任务只写代码改动本身**；同一目标的组件、样式、接口接线与回归测试一起完成，不按文件或技术层拆轮次。` +
      `测试执行/类型检查/构建/commit/push 及文档收尾别写进子任务；必要测试代码随实现一起修改。` +
      `小改动就只出 1 条；仅有独立验收目标、外部依赖或阶段决策时才拆，每条说明拆分理由；通常 2–3 条，更多须由需求的实际复杂度支撑。不要扩展原始需求。` +
      `然后严格单独输出一段(前后不要别的内容)：` +
      `先一行 SUBTASKS_BEGIN，然后每行一个带序号的子任务，最后一行 SUBTASKS_END。` +
      (opts.manualReview ? `等待计划审批后实施。` : `系统自动接续实施，不要向用户索要开工确认。`) +
      moduleDocsRule(opts.locale);
  const en =
    boundaryEn +
    `[Task planning] Requested work: ${issue}${goal ? ` (Project goal: ${goal})` : ''}. ` +
    (fb ? `The previous plan was rejected with this feedback: ${fb}. Re-plan around that feedback. ` : '') +
    recoveryEn +
    `Read relevant code before implementing. For essential ambiguity, list numbered questions then NEED_CLARIFY:${opts.issue.id} on its own line. ` +
    `No AskUserQuestion menus; decide implementation details yourself. Assess overall complexity first (dependencies, risk, tradeoffs); no superpowers by default, select skills only when warranted. Deploy only if requested. ` +
    `Default to ONE end-to-end deliverable. Keep components, styles, API wiring and regression test code together; never split by file or technical layer. Do not create tasks for running checks, commits, pushes or documentation wrap-up. Split only for independent acceptance goals, external dependencies or staged decisions; state why each split is needed, usually 2–3 tasks. Do not expand scope. ` +
    `Output SUBTASKS_BEGIN, numbered deliverables, SUBTASKS_END on separate lines. ` +
    (opts.manualReview ? `Wait for plan approval. ` : `The system continues automatically; do not ask the user for permission to start. `) +
    moduleDocsRule(opts.locale);
    return composePrompt(opts.locale, zh, en);
  };
  // 变长字段按「先砍最不影响判断的」顺序让位：项目目标 → 驳回意见 → 恢复子任务快照
  // → 解除方法 → issue 正文（正文垫底，它是任务本体）。
  const base = assertBudget(fitParts(parts, [
    ['goal', 0],
    ['fb', 0],
    ['recoverySubtasks', 0],
    ['guidance', 80],
    ['issue', 120],
  ], render));
  return appendImgHint(base, opts.imgHint);
}

/** implementing / seq 模式：逐个喂子任务（v1 buildSubtaskPrompt 措辞沿用；SUBTASK_DONE 带 id） */
export function buildSubtaskPrompt(opts: {
  issue: PromptIssueLike;
  subtasks: string[];
  idx: number;
  branch: string;
  locale?: SupportedLocale;
  resumeKey?: string;
}): string {
  const { issue, subtasks, idx, branch } = opts;
  const sub = midTruncate(subtasks[idx] ?? '', BUDGET_SUBTASK);
  const resumeZh = opts.resumeKey
    ? `SYNC_RESUME_KEY:${opts.resumeKey}。若已处理过完全相同的 key，不得重复执行该子任务。`
    : '';
  const resumeEn = opts.resumeKey
    ? `SYNC_RESUME_KEY:${opts.resumeKey}. If this exact key was already processed, do not execute the subtask again. `
    : '';
  const zh = resumeZh + `【实施 子任务 ${idx + 1}/${subtasks.length}】${sub}。` +
      `当前工作分支 ${branch}，不要自行切换分支或合并。` +
      `流程按改动规模裁剪：沿用整体复杂度判断，不为子任务重新启动 superpowers；简单任务直接做。` +
      `只跑与本次改动有关的必要测试，不重复全量门禁；完成后单独输出一行：SUBTASK_DONE:${issue.id}。` +
      `${sentinelBoundary(issue.id, opts.locale)}` +
      `完成本子任务前别做清单外的事。`;
  const en = resumeEn + `[Implementation subtask ${idx + 1}/${subtasks.length}] ${sub}. ` +
    `The current working branch is ${branch}; do not switch or merge branches. Keep the overall complexity decision; do not restart superpowers per subtask. ` +
    `Run only necessary targeted tests, not repeated full gates. When complete, output SUBTASK_DONE:${issue.id} on its own line. ` +
    `${sentinelBoundary(issue.id, opts.locale)} Do nothing outside this subtask before it is complete.`;
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
      `完成以下全部交付：${list}。只有确实独立且能并行的工作才用 Agent team 分工；单条或紧密关联的工作自己连续完成，不为使用工具硬拆。` +
      `流程按改动规模裁剪：先判断整体复杂度，默认不加载 superpowers，复杂工作才按需选技能。` +
      `汇总后只跑必要的相关测试，不重复全量门禁；完成后单独输出一行：STAGE_DONE:${opts.issue.id}:implementing。` +
      `${sentinelBoundary(opts.issue.id, opts.locale)}`;
  const en = `[Agent team implementation] ${goal ? `Overall goal: ${goal}. ` : ''}` +
    `The current working branch is ${opts.branch}; do not switch or merge branches. Complete these deliverables: ${list}. Delegate only genuinely independent parallel work; do a single or tightly coupled deliverable yourself. ` +
    `Use necessary targeted checks; do not repeat full gates. After consolidation, output STAGE_DONE:${opts.issue.id}:implementing on its own line. ` +
    `${sentinelBoundary(opts.issue.id, opts.locale)}`;
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
      `完成并验证通过后，单独输出一行：STAGE_DONE:${opts.issue.id}:implementing。` +
      `${sentinelBoundary(opts.issue.id, opts.locale)}`;
  const headEn = opts.source === 'tests_failed' ? 'Tests failed' : 'Merge review was rejected';
  const en = `[Rework] ${headEn}: ${fb}. Fix or adjust it on branch ${opts.branch}, then run the relevant checks. ` +
    `After verification passes, output STAGE_DONE:${opts.issue.id}:implementing on its own line. ` +
    `${sentinelBoundary(opts.issue.id, opts.locale)}`;
  return localizedPrompt(opts.locale, zh, en);
}

/**
 * testing 阶段（#279 / I-03 之后）：**门禁不再由你跑**。
 *
 * 旧措辞是「完整跑本项目的测试/编译门」，实测导致单条 issue 里重复跑 15 次门禁、外加 4 次
 * 只为看跑完没有的空轮询——每一次轮询都是一次带 200k 上下文的完整模型请求。现在类型检查/
 * 单测/构建由引擎在会话外经 Driver 直跑（ValidationRunner），代理这几分钟是空闲的、不烧 token。
 *
 * 所以这里只要三件事：必要的自检、对照原始目标的完成度判断、内联完成报告块。
 * `STAGE_DONE:<id>:testing` 的语义随之变成「我这边完事了，可以跑门禁了」——协议标记本身不变
 * （sentinel.ts 与 #275 的 REPORT_BEGIN/REPORT_END 都照旧），别顺手改名。
 */
export function buildTestingPrompt(opts: { issue: PromptIssueLike; branch: string; locale?: SupportedLocale }): string {
  const zh = `【收尾自检】分支 ${opts.branch}。对照原始目标检查改动；部署仅在需求明确包含上线时验收。` +
    `不要自己跑类型检查、单测或构建，系统随后统一跑门禁，失败会回灌修复。` +
    `自己能修的直接修；必要决策走澄清，确需用户亲自操作的外部障碍走受阻。` +
    `自检完成后单独输出 STAGE_DONE:${opts.issue.id}:testing；无法修复的问题输出 TESTS_FAILED:${opts.issue.id} 原因。` +
    completionReportHint(opts.issue.id, opts.locale) + sentinelBoundary(opts.issue.id, opts.locale);
  const en = `[Final self-check] Branch ${opts.branch}. Check changes against the original objective; deployment is in scope only when requested. ` +
    `Do not run type checks, tests, or builds yourself; the system runs gates next and returns failures for repair. ` +
    `Fix what you can, clarify essential decisions, and block only on external obstacles requiring user action. ` +
    `After self-check, output STAGE_DONE:${opts.issue.id}:testing on its own line; for unfixable problems output TESTS_FAILED:${opts.issue.id} with a reason. ` +
    completionReportHint(opts.issue.id, opts.locale) + sentinelBoundary(opts.issue.id, opts.locale);
  return localizedPrompt(opts.locale, zh, en);
}

/** blocked 解除后的阶段续行：只携带解除方法与当前进度，不重发整阶段初始任务。 */
export function buildRecoveryResumePrompt(opts: {
  issue: PromptIssueLike;
  stage: 'planning' | 'implementing' | 'testing';
  guidance: string;
  branch: string;
  currentSubtask?: string;
  subtaskIndex?: number;
  subtaskTotal?: number;
  team?: boolean;
  locale?: SupportedLocale;
}): string {
  const clarifyZh = sentinelBoundary(opts.issue.id, 'zh-Hans');
  const clarifyEn = sentinelBoundary(opts.issue.id, 'en');
  // 恢复续跑同样要读写模块文档（过程页得续上、收尾得回写），所以这里也内联规则（#277 / I-02）
  const docsRule = moduleDocsRule(opts.locale);
  const index = (opts.subtaskIndex ?? 0) + 1;
  const total = opts.subtaskTotal ?? index;
  const parts = {
    guidance: midTruncate(opts.guidance, BUDGET_FEEDBACK),
    current: midTruncate(opts.currentSubtask ?? '(当前子任务)', BUDGET_SUBTASK),
  };
  const render = (p: typeof parts): string => {
    const commonZh = `【受阻恢复·继续运行】解除方法：${p.guidance}。请沿用当前会话和已有工作现场，从中断处继续；不要重新规划，不要重做已完成内容。`;
    const commonEn = `[Blocked recovery · continue] Recovery guidance: ${p.guidance}. Continue from the interruption using the current session and existing workspace. Do not re-plan or redo completed work. `;
    if (opts.stage === 'planning') {
      return composePrompt(
        opts.locale,
        commonZh + `继续完成当前规划，完成后仅输出 SUBTASKS_BEGIN/子任务/SUBTASKS_END 规范块。${clarifyZh}${docsRule}`,
        commonEn + `Continue the current planning. When complete, output only the required SUBTASKS_BEGIN/subtasks/SUBTASKS_END block. ${clarifyEn} ${docsRule}`,
      );
    }
    if (opts.stage === 'testing') {
      return composePrompt(
        opts.locale,
        commonZh + `继续自检，不重跑系统门禁；完成后输出 STAGE_DONE:${opts.issue.id}:testing，无法修复则输出 TESTS_FAILED:${opts.issue.id} 原因。` + completionReportHint(opts.issue.id, opts.locale) + clarifyZh + docsRule,
        commonEn + `Self-check; do not rerun gates. Output STAGE_DONE:${opts.issue.id}:testing; for unfixable problems output TESTS_FAILED:${opts.issue.id} with a reason. ` + completionReportHint(opts.issue.id, opts.locale) + clarifyEn + docsRule,
      );
    }
    if (opts.team) {
      return composePrompt(
        opts.locale,
        commonZh + `继续分支 ${opts.branch} 上尚未完成的团队实施，不要重新派发已完成工作；全部完成后单独输出一行 STAGE_DONE:${opts.issue.id}:implementing。${clarifyZh}${docsRule}`,
        commonEn + `Continue only the unfinished team implementation on branch ${opts.branch}; do not dispatch completed work again. When complete, output STAGE_DONE:${opts.issue.id}:implementing on its own line. ${clarifyEn} ${docsRule}`,
      );
    }
    return composePrompt(
      opts.locale,
      commonZh + `继续分支 ${opts.branch} 上的当前子任务 ${index}/${total}：${p.current}。完成并验证后单独输出一行 SUBTASK_DONE:${opts.issue.id}。${clarifyZh}${docsRule}`,
      commonEn + `Continue current subtask ${index}/${total} on branch ${opts.branch}: ${p.current}. After completing and verifying it, output SUBTASK_DONE:${opts.issue.id} on its own line. ${clarifyEn} ${docsRule}`,
    );
  };
  // 解除方法是这条 prompt 的本体，先砍当前子任务文本
  return assertBudget(fitParts(parts, [['current', 0], ['guidance', 80]], render));
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
      `默认 1 条完整交付，不按文件或文档收尾拆分；确有独立验收目标才拆。子任务规划好了就严格按格式输出：一行 SUBTASKS_BEGIN、每行一个子任务、一行 SUBTASKS_END` +
      `（前后别带其它内容）；${clarifyHint}；否则请继续规划。`;
    const en = `Default to one complete deliverable; split only for independent acceptance goals, not files or wrap-up. When ready, output exactly one SUBTASKS_BEGIN line, one subtask per line, and one SUBTASKS_END line, with no surrounding content. If a user decision is essential, list numbered questions and output NEED_CLARIFY:${id} on its own line; otherwise continue planning.`;
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
  const zh = `自检完成后单独输出 STAGE_DONE:${id}:testing，并在同一回复附完成报告；不要重跑门禁，由系统执行。无法修复则输出 TESTS_FAILED:${id} 原因；${clarifyHint}。` + completionReportHint(id, opts.locale);
  const en = `After self-check, output STAGE_DONE:${id}:testing with the completion report in the same reply. Do not rerun gates; the system runs them. For unfixable problems output TESTS_FAILED:${id} with a reason; for essential decisions output NEED_CLARIFY:${id}. ` + completionReportHint(id, opts.locale);
  return localizedPrompt(opts.locale, zh, en);
}

/** One implementation turn, with an issue/attempt-bound completion signal. */
export function buildDirectPrompt(opts: {
  issue: PromptIssueLike; attempt: number; branch: string; locale?: SupportedLocale;
  feedback?: string; docPath?: string | null; imgHint?: string;
}): string {
  const id = opts.issue.id;
  const doc = opts.docPath && opts.docPath.length <= 160 ? opts.docPath : 'locate this issue via INDEX';
  const ready = `ISSUE_READY:${id}:${opts.attempt}`;
  const report = completionReportHint(id, opts.locale).replaceAll(`STAGE_DONE:${id}:testing`, ready);
  const parts = { task: issueText(opts.issue), feedback: midTruncate(opts.feedback ?? '', 250) };
  const render = (p: typeof parts) => composePrompt(opts.locale,
    `直接完成 #${id}：${p.task}\n使用系统已准备的分支，不要切换或合并。沿用已有进度。${p.feedback}\n` +
    `先结合必要代码判断整体复杂度，明确任务连续完成，不生成子任务，不默认用 superpowers。仅遇实质架构取舍或复杂依赖时，输出 NEED_PLAN:${id}:${opts.attempt} 升级理由，交系统规划。定向验证即可，最终门禁由系统执行，不重复跑。\n` +
    moduleDocsRule(opts.locale) + ` 过程页：${doc}\n` +
    sentinelBoundary(id, opts.locale) + '\n' + report,
    `Complete #${id} directly: ${p.task}\nUse the prepared branch; do not switch/merge. Preserve progress. ${p.feedback}\n` +
    `Assess complexity in context. No subtasks or default superpowers. For real design tradeoffs emit NEED_PLAN:${id}:${opts.attempt} and reason; await planning. Targeted checks only; system runs final gates.\n` +
    `Read .panda/modules/INDEX.md, module MODULE.md and process page: ${doc}. Keep decisions/evidence there; promote durable knowledge. Stop on conflicting facts.\n` +
    sentinelBoundary(id, opts.locale) + '\n' + report);
  return appendImgHint(assertBudget(fitParts(parts, [['task', 40], ['feedback', 0]], render)), opts.imgHint);
}

/**
 * agents/approval —— CC 弹窗菜单的自动批复分级（v1 autoApproveConv 平移，评审 §1.3）。
 *
 * 规则本体全部在 **agents/approval-policy**（全局策略集合，唯一维护点）；本文件只负责
 * 「按什么顺序套用」。四层瀑布**必须保序**（评审 5.3#4：顺序颠倒会让 LLM 对多选表单
 * 输出 approve → selectOption 死循环）：
 *   1. 多选/交互表单 → 一律升级人工，绝不自动点；
 *   2. trust 弹窗 → 直接同意（yes 未命中时落回下一层，v1 语义）；
 *   3. 推荐项（issue #91）→ 选项自带 (recommended)/（推荐）标记就直接选它，不问 LLM；
 *   4. 驱动大模型 分级（AUTOPILOT_APPROVAL_SYS 逐字平移）→ 安全可逆 approve / 危险不可逆 escalate；
 *   5. 第 4 层不可用时的本地兜底 localFallback（issue #91）→ 危险交人工 / 普通放行。
 *      它长在第 4 层的 catch 里而不是独立一层，因为它的触发条件是「上一层调不通」而非菜单形态。
 *
 * 档位（issue #108/#34）插在第 3 层与第 4 层之间：谨慎档到这里就转人工；中等与
 * 全自动都由管家按完整语义分级，全自动仅在模型不可用时走本地红线兜底。前三层与档位无关。
 *
 * 第 3 层为什么排在 trust 之后：trust 是「必须答应否则寸步难行」的目录信任弹窗，语义比
 * 推荐标记更强，且真实 trust 弹窗从不带 recommended 标记，两层实际不重叠——排后面纯粹是
 * 为了让已上线的 trust 行为一个字节都不变。
 *
 * 相对 v1 的修债：
 * - 审批判定用**裸 system**（评审 M17：不拼用户 persona/memory，防「都同意别烦我」软化规则）；
 * - 每次分级产出 requestId，配 ApprovalRegistry 消费即焚（防重放，spec §12）；
 * - trust 直批不再无审计：结果带 rule 字段，调用方据此落 issue_events（评审 M7）。
 */
import type { AutoApproveLevel } from '../core/types';
import {
  APPROVAL_POLICY,
  isDangerousMenu,
  isMultiSelectMenu,
  isNeverPick,
  pickRecommended,
  pickSafeAffirmative,
} from './approval-policy';
import type { LlmClient } from './llm';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from './prompts/language';

// ---------- prompt 常量（评审附录逐字摘录，改一个字都要 diff 可见） ----------

/** autopilot 智能分级批复 system（v1 agent.ts:680-689 平移；v2 放宽：普通 git push 归入自动批准。
 *  裸 system 使用，不带 persona 前缀） */
export const AUTOPILOT_APPROVAL_SYS = `# 任务：autopilot 智能分级批复
Claude Code 弹出了一个选择/审批菜单。替主人判断：自动批准并选某项，还是升级给主人人工决定。只输出 JSON：
{"action":"approve"|"escalate","option":选项编号(从1起,approve时必填),"reason":"≤20字中文理由"}

# 规则（拿不准一律 escalate）
- approve（安全·可逆·在任务范围内）：读文件/浏览、跑测试或 production build、普通代码编辑、新建文件/目录、清理 /tmp 或项目 .panda/tmp 内临时文件、git add/commit/普通 push（非 force、不改历史）、装任务明确需要的依赖、确认计划继续。按完整语义判断，不得因命令正文恰含 submit、production 等单词升级。选最能推进【当前任务】的那项。
- escalate（危险·不可逆·超范围）：删除非临时文件或数据(drop/truncate)、git reset --hard / force push / 改历史、实际部署/发布/上线、改生产配置或密钥、对外改外部状态（普通 git push 除外）、关机/重启、与当前任务无关的操作、任何看不懂或拿不准的。
- 宁可 escalate，也别误批。`;
export const AUTOPILOT_APPROVAL_SYS_EN = `# Task: grade an autopilot approval request
Claude Code displayed a choice or approval menu. Decide whether to approve one option automatically or escalate to the user. Return JSON only:
{"action":"approve"|"escalate","option":one-based option number when approving,"reason":"concise reason"}
Approve safe, reversible, in-scope reading, tests, production builds (building is not deployment), ordinary edits, file creation, cleanup strictly inside /tmp or the project's .panda/tmp, non-force git add/commit/push, required dependencies, or plan continuation. Judge the full meaning; words such as submit or production alone are not risks. Escalate non-temporary deletion, destructive Git history changes, actual deployments, production configuration or secrets changes, external side effects, unrelated work, and anything uncertain.`;

export const TEXT_APPROVAL_SYS = `# 任务：判断编码代理的纯文本提问能否由全自动管家代答
编码代理没有弹出结构化菜单，而是在最终回复里要求主人确认、选择执行方式或回复短文本。只输出 JSON：
{"action":"reply"|"hold","reply":"reply 时要发送的最短原样答案","reason":"≤30字中文理由"}

- reply：仅限任务范围内、不会改变需求的流程继续确认或执行方式选择；答案必须由原文明确给出，优先采用代理明确推荐且能继续当前目标的选项。
- hold：业务需求澄清、架构/产品取舍、范围变化、脏工作区/分支处置、删除非临时数据、改 Git 历史、密钥/生产配置、超出原目标的发布或外部副作用，以及任何拿不准的情况。
- 已明确要求交付、部署或上线时，选择“继续执行既定计划/当前会话实施”本身可 reply；不得据此扩大到原目标外的发布。
- reply 只能是一个编号、短选项文字或 yes/no，不得添加解释、命令或多行内容。`;
export const TEXT_APPROVAL_SYS_EN = `# Task: decide whether autopilot may answer a coding agent's plain-text question
Return JSON only: {"action":"reply"|"hold","reply":"short exact answer when replying","reason":"concise reason"}.
Reply only to an explicit, in-scope workflow continuation or execution-mode choice whose answer is present in the text. Hold for requirement clarification, architecture/product tradeoffs, scope changes, dirty-worktree or branch decisions, destructive actions, secrets/production configuration, out-of-scope external effects, or uncertainty. If delivery/deployment is already the stated goal, choosing to continue that established plan is allowed. The reply must be a single number, short option label, or yes/no.`;

/** 选项解读 prompt（v1 agent.ts:124-125 逐字）——升级人工时给通知卡生成人话摘要 */
export const EXPLAIN_SELECTION_SYS = `# 任务：说清 CC 在让主人选什么
2-3 行中文说清在问什么、各选项含义、你的建议（结合会话进度）。飞书 lark_md，结尾原样列出全部编号选项。`;
export const EXPLAIN_SELECTION_SYS_EN = `# Task: explain what Claude Code is asking the user to choose
In 2-3 lines, explain the question, the meaning of each option, and your evidence-based recommendation. Use Feishu lark_md and finish by reproducing every numbered option exactly as supplied.`;

/**
 * 网页版菜单解读 prompt（issue #112）：给的是**盯着屏幕的人**看的，不是通知卡。
 * 与 EXPLAIN_SELECTION_SYS 的两处硬区别：不重列选项（网页上就在这段话下面）、不用飞书 lark_md。
 */
export const EXPLAIN_MENU_WEB_SYS = `# 任务：给主人讲清这个弹窗在问什么
主人正盯着 AI 编码代理弹出的选择菜单，选项就显示在你这段话的下面。用 3-5 行中文说清：
- 这一步在干什么、为什么会弹出来（大白话，别照抄英文原文）；
- 同意之后会发生什么，有没有不可逆的后果或风险（删数据、改 git 历史、强推、发布上线、动生产配置或密钥这类必须点名）；
- 你建议选第几项、一句话理由；拿不准就直说拿不准、请主人自己判断。
只输出纯文本：不要重复罗列选项，不要标题/加粗/代码块等 markdown，不要飞书 lark_md 语法，不要客套话。`;
export const EXPLAIN_MENU_WEB_SYS_EN = `# Task: explain the coding agent's choice menu
In 3-5 plain-text lines, explain what is happening, why the menu appeared, what approval would do, any irreversible risk, and which numbered option you recommend with one reason. State uncertainty plainly. Do not repeat the options, use headings, Markdown, or pleasantries.`;

// ---------- 规则本体：见 approval-policy.ts（这里只做便捷 re-export，调用方无需两处 import） ----------

export {
  AFFIRM_RE,
  APPROVAL_POLICY,
  DANGER_RE,
  isDangerousMenu,
  isMultiSelectMenu,
  isNeverPick,
  MULTI_SELECT_RE,
  NEVER_PICK_RE,
  pickRecommended,
  pickSafeAffirmative,
  RECOMMENDED_RE,
  TRUST_RE,
  TRUST_YES_RE,
} from './approval-policy';

// ---------- 分级 ----------

export type ApprovalRule =
  | 'multi_select'
  | 'trust'
  | 'recommended'
  | 'llm'
  | 'llm_error'
  | 'local_fallback'
  /** 谨慎档：过了 trust/推荐两层还没定论 → 直接等人工，连 LLM 都不问（issue #108） */
  | 'cautious_hold'
  /** 全自动档：管家判为危险，或模型不可用时命中本地危险红线 */
  | 'auto_danger'
  /** 全自动档：管家判为安全，或模型不可用时本地规则选同意项 */
  | 'auto_affirm';

function approvalReason(locale: SupportedLocale, zh: string, en: string): string {
  return promptLanguage(locale) === 'zh' ? zh : en;
}

export interface ApprovalMenu {
  /** 菜单上下文（detectSelection 的 context / MenuSnapshot.title） */
  context: string;
  options: string[];
  /** 上游已判定多选时可直传（与内建正则取或） */
  multiSelect?: boolean;
}

export interface ApprovalTask {
  goal?: string | null;
  taskText?: string | null;
}

export type ApprovalOutcome =
  | { requestId: string; action: 'approve'; optionIndex: number; reason: string; rule: ApprovalRule }
  | { requestId: string; action: 'escalate'; reason: string; rule: ApprovalRule };

export type TextApprovalOutcome =
  | { action: 'reply'; reply: string; reason: string }
  | { action: 'hold'; reason: string };

/**
 * 低成本候选门禁：只把明确要求回复/确认/选择的屏幕交给 LLM，避免后台每 3 秒分析普通输出。
 * 最终是否可代答完全由管家模型按安全规则判断，不靠关键词直接授权。
 */
export function textApprovalCandidate(pane: string): string | null {
  const lines = pane.slice(-5000).split('\n');
  const directive = /(回复\s*[`'“\"]?\w+|reply\s+(?:with\s+)?[`'\"]?\w+|是否.*(?:继续|确认)|请选择|选择.*方式)/i;
  let end = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    if (directive.test(lines[i]!)) { end = i; break; }
  }
  if (end < 0) return null;
  const context = lines.slice(Math.max(0, end - 24), end + 1).join('\n').trim();
  if (!/(?:^|\n)\s*\d+[.、)]\s+\S|回复\s*[`'“\"]?\w+|reply\s+(?:with\s+)?[`'\"]?\w+/im.test(context)) return null;
  return context;
}

/** 全自动档的纯文本确认分级；失败、脏 JSON 和不安全回复一律 hold。 */
export async function decideTextApproval(
  llm: LlmClient,
  input: { pane: string; goal?: string | null; taskText?: string | null; locale?: SupportedLocale },
): Promise<TextApprovalOutcome> {
  const locale = input.locale ?? 'zh-Hans';
  const context = textApprovalCandidate(input.pane);
  if (!context) return { action: 'hold', reason: approvalReason(locale, '不是明确的纯文本确认', 'Not an explicit plain-text confirmation') };
  try {
    const r = await llm.chat([
      {
        role: 'system',
        content: (promptLanguage(locale) === 'zh' ? TEXT_APPROVAL_SYS : TEXT_APPROVAL_SYS_EN) +
          `\n${outputLanguageInstruction(locale)}`,
      },
      {
        role: 'user',
        content: promptLanguage(locale) === 'zh'
          ? `总目标：${input.goal || '(未设)'}\n当前任务：${input.taskText || '(未设)'}\n\n代理屏幕：\n${context}`
          : `Overall goal: ${input.goal || '(not set)'}\nCurrent task: ${input.taskText || '(not set)'}\n\nAgent screen:\n${context}`,
      },
    ], { jsonMode: true });
    const parsed = JSON.parse(r.content || '{}') as Record<string, unknown>;
    const reply = String(parsed.reply ?? '').trim();
    const safeReply = reply.length > 0 && reply.length <= 80 && !/[\r\n\x00-\x1f\x7f]/.test(reply);
    if (parsed.action === 'reply' && safeReply) {
      return { action: 'reply', reply, reason: String(parsed.reason ?? '').slice(0, 100) || approvalReason(locale, '安全的流程继续确认', 'Safe workflow continuation') };
    }
    return { action: 'hold', reason: String(parsed.reason ?? '').slice(0, 100) || approvalReason(locale, '需要主人判断', 'User judgment is required') };
  } catch {
    return { action: 'hold', reason: approvalReason(locale, '纯文本确认分级失败', 'Plain-text confirmation grading failed') };
  }
}

/** 一次性 requestId（v1 agent.ts:117 式样 + 加宽随机位防同毫秒碰撞） */
export function genRequestId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 菜单自动批复分级。返回结构含 requestId：升级人工时把它发进通知卡，
 * 回调经 ApprovalRegistry.consume 消费即焚防重放。
 *
 * `level`（issue #108）只决定**第 1~3 层之后怎么走**，前三层三档完全一致：
 *   - 'cautious'：直接转人工（不问 LLM）——只有 trust/推荐这种零风险项才自动点；
 *   - 'medium'（缺省，历史行为）：驱动大模型 分级 + 分级不可用时本地兜底；
 *   - 'auto'：管家结合任务与完整菜单语义分级；模型不可用时才以本地红线保守兜底，
 *     其中只豁免简单的 `/tmp` 与项目 `.panda/tmp` 临时文件清理。
 * 多选/交互表单在第 1 层就转人工，任何档位都不例外（驱动不了且会死循环）。
 */
export async function decideApproval(
  llm: LlmClient,
  menu: ApprovalMenu,
  task: ApprovalTask = {},
  level: AutoApproveLevel = 'medium',
  locale: SupportedLocale = 'zh-Hans',
): Promise<ApprovalOutcome> {
  const requestId = genRequestId();

  // 1) 多选/交互表单：一律升级人工（绝不自动点，v1 铁律）
  if (menu.multiSelect || isMultiSelectMenu(menu.context, menu.options)) {
    return { requestId, action: 'escalate', reason: approvalReason(locale, '交互式多选表单，需人工填写', 'Interactive multi-select form requires user input'), rule: 'multi_select' };
  }

  // 2) trust 弹窗：直接同意；yes 未命中不 return，落回下一层（v1 语义）
  const blob = `${menu.context} ${menu.options.join(' ')}`.toLowerCase();
  if (APPROVAL_POLICY.trust.test(blob)) {
    const yes = menu.options.findIndex((o) => APPROVAL_POLICY.trustYes.test(o));
    if (yes >= 0) {
      return { requestId, action: 'approve', optionIndex: yes, reason: approvalReason(locale, '信任弹窗，选同意', 'Approved the trust prompt'), rule: 'trust' };
    }
  }

  // 3) 推荐项（issue #91）：CLI 自己标了 (recommended)/（推荐）就照它选，不必问 LLM。
  //    典型场景是长会话恢复弹窗「Resume from summary (recommended)」——这类弹窗 LLM 也
  //    看不出所以然，反而常年卡在人工。未命中同样不 return，落回 LLM 分级。
  const rec = pickRecommended(menu.options);
  if (rec >= 0) {
    return {
      requestId,
      action: 'approve',
      optionIndex: rec,
      reason: approvalReason(locale, '选项标了推荐，按推荐选', 'Selected the option marked recommended'),
      rule: 'recommended',
    };
  }

  // 3.5) 档位分流（issue #108/#34）。谨慎档不问 LLM；中等和全自动均由管家按完整
  //      语义分级。全自动仅在模型不可用时采用本地红线兜底，避免关键词误判常态化。
  if (level === 'cautious') {
    return {
      requestId,
      action: 'escalate',
      reason: approvalReason(locale, '谨慎档：非零风险弹窗一律等人工', 'Cautious mode requires user approval for non-zero-risk prompts'),
      rule: 'cautious_hold',
    };
  }
  // 4) 驱动大模型 分级（裸 system，评审 M17；user 模板 v1 agent.ts:643 平移）
  const optionsText = menu.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  let decision: { action?: unknown; option?: unknown; reason?: unknown } | null = null;
  try {
    const r = await llm.chat(
      [
        { role: 'system', content: (promptLanguage(locale) === 'zh' ? AUTOPILOT_APPROVAL_SYS : AUTOPILOT_APPROVAL_SYS_EN) + `\n${outputLanguageInstruction(locale)}` },
        {
          role: 'user',
          content: promptLanguage(locale) === 'zh'
            ? `总目标：${task.goal || '(未设)'}\n当前任务：${task.taskText || '(未设)'}\n\nClaude Code 弹出的选择/审批：\n上下文：${menu.context}\n选项：\n${optionsText}`
            : `Overall goal: ${task.goal || '(not set)'}\nCurrent task: ${task.taskText || '(not set)'}\n\nClaude Code choice/approval:\nContext: ${menu.context}\nOptions:\n${optionsText}`,
        },
      ],
      { jsonMode: true },
    );
    decision = JSON.parse(r.content || '{}');
  } catch {
    // LLM 挂了/解析不出 JSON → 本地兜底分级（issue #91）。
    // 原先这里无条件升级人工，看着保守，实际后果更糟：驱动大模型 一挂（如 2026-07-25
    // llm-chat 下线），跑测试、改文件、git commit 这种日常弹窗全部堵在等人点，
    // 自动执行流直接瘫痪。中等档改为「危险的仍交人工，普通的本地放行」；全自动档
    // 也只在模型不可用时进入自己的保守兜底，正常路径始终由管家按完整语义判断。
    return level === 'auto' ? autoFallback(requestId, menu, locale) : localFallback(requestId, menu, locale);
  }
  const opt = Number(decision?.option);
  if (decision?.action === 'approve' && Number.isInteger(opt) && opt >= 1 && opt <= menu.options.length && !isNeverPick(menu.options[opt - 1]!)) {
    return {
      requestId,
      action: 'approve',
      optionIndex: opt - 1,
      reason: String(decision?.reason ?? '').slice(0, 100),
      rule: level === 'auto' ? 'auto_affirm' : 'llm',
    };
  }
  return {
    requestId,
    action: 'escalate',
    reason: String(decision?.reason ?? '').slice(0, 100) || approvalReason(locale, '需判断', 'Needs user judgment'),
    rule: level === 'auto' ? 'auto_danger' : 'llm',
  };
}

/**
 * LLM 分级不可用时的本地兜底（issue #91，规则见 approval-policy）。
 *
 * 三种出口，顺序即优先级：
 *   a. 命中危险·不可逆大类 → 仍交人工，**保留 rule 'llm_error'**（本质还是分级失败，
 *      审计上要能和「分级正常但判危险」的 rule 'llm' 区分开）；
 *   b. 找不到明确同意项（不是权限弹窗，而是让人做选择题）→ 交人工，同样 'llm_error'；
 *   c. 其余普通权限弹窗 → 选同意项放行，rule 'local_fallback'。
 *
 * 主人已知悉并接受 c 的小概率误批（issue #91 澄清第 4 问）：宁可偶尔误批一次普通操作，
 * 也不要 LLM 一挂就全线停摆。危险操作仍然一个都不自动点。
 */
function localFallback(requestId: string, menu: ApprovalMenu, locale: SupportedLocale): ApprovalOutcome {
  if (isDangerousMenu(menu.context, menu.options)) {
    return { requestId, action: 'escalate', reason: approvalReason(locale, 'LLM 分级失败且疑似危险操作，需人工判断', 'LLM grading failed and the operation may be dangerous; user judgment is required'), rule: 'llm_error' };
  }
  const yes = pickSafeAffirmative(menu.options);
  if (yes < 0) {
    return { requestId, action: 'escalate', reason: approvalReason(locale, 'LLM 分级失败且无明确同意项，需人工判断', 'LLM grading failed and there is no clear affirmative option; user judgment is required'), rule: 'llm_error' };
  }
  return {
    requestId,
    action: 'approve',
    optionIndex: yes,
    reason: approvalReason(locale, 'LLM 分级不可用，本地规则判为安全操作', 'LLM grading is unavailable; local rules classified this as safe'),
    rule: 'local_fallback',
  };
}

/**
 * 全自动档在管家不可用时的本地兜底：危险不可逆仍交人工、没有明确同意项也交人工；
 * rule 与中等档分开，事后能看出具体审批档位。
 */
function autoFallback(requestId: string, menu: ApprovalMenu, locale: SupportedLocale): ApprovalOutcome {
  if (isDangerousMenu(menu.context, menu.options)) {
    return { requestId, action: 'escalate', reason: approvalReason(locale, '全自动档红线：危险不可逆操作仍需人工', 'Automatic mode safety boundary: dangerous irreversible work still requires the user'), rule: 'auto_danger' };
  }
  const yes = pickSafeAffirmative(menu.options);
  if (yes < 0) {
    return { requestId, action: 'escalate', reason: approvalReason(locale, '全自动档：无明确同意项，需人工判断', 'Automatic mode found no clear affirmative option; user judgment is required'), rule: 'auto_affirm' };
  }
  return {
    requestId,
    action: 'approve',
    optionIndex: yes,
    reason: approvalReason(locale, '全自动档，本地规则判为可放行', 'Automatic mode local rules approved this operation'),
    rule: 'auto_affirm',
  };
}

// ---------- 升级人工时的选项解读（通知卡摘要） ----------

/**
 * 生成人话摘要（v1 handleApproval 平移）：LLM 失败回落到裸 context+options。
 * systemPrefix = PM 的 systemPrompt（解读非安全判定，可带 persona；与审批分级的裸 system 区别开）。
 */
export async function explainSelection(
  llm: LlmClient,
  opts: {
    label: string;
    context: string;
    options: string[];
    /** 会话滚动摘要（runningSummary） */
    progress?: string;
    systemPrefix?: string;
    locale?: SupportedLocale;
  },
): Promise<string> {
  const optionsText = opts.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const locale = opts.locale ?? 'zh-Hans';
  const fallback = `${opts.context}\n\n**选项：**\n${optionsText}`;
  try {
    const r = await llm.chat([
      {
        role: 'system',
        content: (opts.systemPrefix ? `${opts.systemPrefix}\n\n` : '') +
          (promptLanguage(locale) === 'zh' ? EXPLAIN_SELECTION_SYS : EXPLAIN_SELECTION_SYS_EN) +
          `\n${outputLanguageInstruction(locale)}`,
      },
      {
        role: 'user',
        content: promptLanguage(locale) === 'zh'
          ? `会话 @${opts.label}\n会话进度：${opts.progress || '(无)'}\n\n上下文：${opts.context}\n选项：\n${optionsText}`
          : `Session @${opts.label}\nProgress: ${opts.progress || '(none)'}\n\nContext: ${opts.context}\nOptions:\n${optionsText}`,
      },
    ]);
    return r.content.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * 网页「解释一下」的按需解读（issue #112）：菜单弹出后主人点了才调，一次一条。
 *
 * 与 explainSelection 的关键差别是**失败返回 null 而不是回落原文**：网页上 context 和选项
 * 本来就摆在那儿，把它们再吐一遍等于没解释，还会让人以为「这就是 AI 的解读」。null 让调用方
 * 明确回一个「解读失败，可重试」，别把降级伪装成结果。
 */
export async function explainMenuForHuman(
  llm: LlmClient,
  opts: {
    /** 会话标识（项目名），给模型一点场景感 */
    label: string;
    context: string;
    options: string[];
    /** 多选表单：按键语义不同（勾选≠提交），解读里值得提一句 */
    multiSelect?: boolean;
    /** PM 的 systemPrompt（persona/记忆）；解读不是安全判定，可以带 */
    systemPrefix?: string;
    locale?: SupportedLocale;
  },
): Promise<string | null> {
  const optionsText = opts.options.map((o, i) => `${i + 1}. ${o}`).join('\n');
  const locale = opts.locale ?? 'zh-Hans';
  const multiHint = opts.multiSelect
    ? promptLanguage(locale) === 'zh'
      ? '\n注意：这是多选表单，点选项只是勾选/取消，要再按「→」进复核页才真正提交。'
      : '\nThis is a multi-select form: selecting an item only toggles it; the review step submits it.'
    : '';
  try {
    const r = await llm.chat([
      {
        role: 'system',
        content: (opts.systemPrefix ? `${opts.systemPrefix}\n\n` : '') +
          (promptLanguage(locale) === 'zh' ? EXPLAIN_MENU_WEB_SYS : EXPLAIN_MENU_WEB_SYS_EN) +
          `\n${outputLanguageInstruction(locale)}`,
      },
      {
        role: 'user',
        content: promptLanguage(locale) === 'zh'
          ? `会话 @${opts.label}${multiHint}\n\n屏幕上下文：${opts.context}\n选项：\n${optionsText}`
          : `Session @${opts.label}${multiHint}\n\nScreen context: ${opts.context}\nOptions:\n${optionsText}`,
      },
    ]);
    return r.content.trim() || null;
  } catch {
    return null;
  }
}

// ---------- requestId 防重放注册表 ----------

export interface PendingApproval {
  outcome: ApprovalOutcome;
  /** 发卡时的菜单签名（selectionSig）；消费时调用方须重抓菜单核对（评审 5.3#5：别存 cursorIndex） */
  menuSig: string;
  /** 目标 tmux 会话 */
  session: string;
  createdTs: number;
}

/** 待人工决定的审批登记：消费即焚（一次性 requestId），过期自动清（默认 30min）。
 *  重启丢失是可接受的：watcher 下轮重测到同一菜单会重新升级（自愈），
 *  真正的流程卡点（plan/merge_review）在 gates 表里有 CAS 防重放，不走这里。 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, PendingApproval>();

  constructor(
    private readonly ttlMs: number = 30 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  register(outcome: ApprovalOutcome, session: string, menuSig: string): void {
    this.sweep();
    this.pending.set(outcome.requestId, { outcome, session, menuSig, createdTs: this.now() });
  }

  /** 消费即焚：第二次同 id / 过期 / 未登记 → null（防重放） */
  consume(requestId: string): PendingApproval | null {
    this.sweep();
    const p = this.pending.get(requestId);
    if (!p) return null;
    this.pending.delete(requestId);
    return p;
  }

  /** 是否仍在等人工（未消费未过期）——waiting_input 派生标记查询用 */
  has(requestId: string): boolean {
    this.sweep();
    return this.pending.has(requestId);
  }

  /** 会话菜单消失时清掉该会话的全部登记（菜单已被人工/其它途径处理，旧卡作废）；返回被清的 id */
  dropBySession(session: string): string[] {
    const dropped: string[] = [];
    for (const [k, v] of this.pending) {
      if (v.session === session) {
        this.pending.delete(k);
        dropped.push(k);
      }
    }
    return dropped;
  }

  get size(): number {
    return this.pending.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [k, v] of this.pending) {
      if (now - v.createdTs > this.ttlMs) this.pending.delete(k);
    }
  }
}

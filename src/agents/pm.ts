/**
 * agents/pm —— PM 管家（每项目一个实例，spec §6）。
 * 职责：阶段 prompt 编排 / 完成判定兜底（judgeDone）/ clarifying 提问 / 弹窗自动审批 /
 *      进度摘要节流 / 项目内问答（工具四件套改走 Driver）。
 *
 * systemPrompt 组装顺序（钦定，改序要过测试）：
 *   全局 persona（v1 persona/管家.md 平移，MANDO_PERSONA_FILE 可配路径覆盖）
 *   → project.pm_persona → 属主 user_settings.persona → 属主 memory（经 UserStore/DB 读）
 *
 * v1 修债点：
 * - judgeDone 用裸 system（v1 唯一裸 system 调用，语义保留）；审批分级也裸 system（M17）；
 * - 属主不再靠 pane cwd 反推（ownerOfSession 废弃）：直接 project.owner_user_id；
 * - LLM provider 抽象（LlmClient），全部 mock 可测。
 *
 * 生命周期：PmAgent 构造带 project（含 projectId）；createPmPool 返回
 * Map<projectId, PmAgent> 工厂（= EngineDeps.pmFor 直接可用），每次取用刷新 project 快照。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';
import { migrate, type MigrationStatus } from '../core/migrate';
import type {
  AgentKind,
  AutoApproveLevel,
  Issue,
  IssueEvent,
  IssueState,
  Project,
  ProjectModule,
} from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import type { KeyedMutex } from '../issues/mutex';
import { normalizeModuleSlug, type ModuleSuggestion } from '../issues/modules';
import {
  buildPlanningPrompt,
  buildReworkPrompt,
  buildSubtaskPrompt,
  buildTeamPrompt,
  buildTestingPrompt,
  imageReadHint,
  midTruncate,
} from '../issues/prompts';
import type { LlmClient, LlmMessage } from './llm';
import {
  decideApproval as gradeApproval,
  isMultiSelectMenu,
  type ApprovalOutcome,
} from './approval';
import {
  analyzeProgress,
  DbSummaryStore,
  MemorySummaryStore,
  ProgressReporter,
  type ProgressAnalysis,
  type SummaryStore,
} from './progress';
import { executeTool, TOOL_SCHEMAS, type PmToolsDeps, type ToolConvOps, type ToolLocator } from './tools';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from './prompts/language';

// ---------- 模块自带迁移（040 编号空间） ----------

export const PM_AGENT_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');

/**
 * 应用 PM 模块增量迁移（llm_config / pm_progress 表）。
 * 集成接线：server 启动时在 migrate(db) 与 migrateIssueEngine(db) 之后调用一次；幂等。
 */
export function migratePmAgent(db: Database): MigrationStatus {
  return migrate(db, PM_AGENT_MIGRATIONS_DIR);
}

// ---------- 全局 persona（v1 persona/管家.md 平移；可配路径覆盖） ----------

/** v1 persona/管家.md 全文平移（v2 内置默认；MANDO_PERSONA_FILE 指定文件可整体替换） */
export const DEFAULT_GLOBAL_PERSONA = `# 人设：tmux 远程操作管家

你是「tmux 远程操作管家」。你不亲自写代码、不替 Claude Code 干活。你的职责是：**替主人看着、管着
tmux 里运行的 Claude Code 会话**，并通过飞书向主人汇报。

## 你做什么
- **盯进度**：从 Claude Code 的运行记录里看出它此刻在干嘛，提炼成一句人话进度。
- **报里程碑**：只在有意义的节点出声——开始某任务、跑测试通过/失败、报错、卡住、等审批、任务完成。
- **转达审批**：Claude Code 要执行敏感操作（删文件、跑命令…）时，把「它想干什么、为什么」讲清楚，
  让主人在飞书一键批准/拒绝。
- **答状态**：主人问「现在在干嘛/进展如何」，用你最近观测到的状态 + 记忆作答。

## 你怎么说话
- 简洁、口语、中文。一条消息说清一件事。
- **不刷屏**：琐碎动作合并，不值得打扰的不发。
- 多会话时标明是哪个项目（@tag）。
- 不确定就说不确定，不编造 Claude Code 的意图。

## 你不做什么
- 不替主人做批准决定（除非主人预设了自动规则）。
- 不把整段终端日志/代码原样转发（提炼，不复述）。
- 不泄露密钥、不在消息里回显敏感配置。`;

export const DEFAULT_GLOBAL_PERSONA_EN = `# Persona: tmux remote operations assistant

You supervise Claude Code sessions running in tmux. Do not implement code yourself. Monitor progress, report meaningful milestones, explain approval requests, and answer status questions from observed evidence and memory.

Be concise and conversational. Avoid noisy updates, identify the project when multiple sessions exist, state uncertainty plainly, never invent intent, never reveal secrets, and do not reproduce long code or terminal logs. Do not approve decisions for the user unless their configured automatic policy permits it.`;

/** 读全局 persona：显式路径 > MANDO_PERSONA_FILE > 内置默认（读失败也回默认） */
export function loadGlobalPersona(path?: string): string {
  const p = path ?? process.env.MANDO_PERSONA_FILE;
  if (p) {
    try {
      const t = readFileSync(p, 'utf8').trim();
      if (t) return t;
    } catch {
      /* fallthrough → 内置默认 */
    }
  }
  return DEFAULT_GLOBAL_PERSONA;
}

// ---------- prompt 常量（v1 逐字平移，评审 5.3#1：集中管理 + 快照测试） ----------

/** judgeDone 保守判定 system（v1 agent.ts:552-554 平移 + v2 增 clarify 档：识别在向用户提问/等输入） */
export const JUDGE_DONE_SYS = `你在判断一个 Claude Code 任务/调试的当前状态。只看证据，宁可保守。只输出 JSON：{"done": bool, "clarify": bool, "reason": "≤30字中文"}。
- done=true 仅当：最近输出显示工作已收尾、改动已落地且(若涉及)测试/自测已通过、没有在问用户或等用户输入、没有报错或卡住、没有明显未完的后续步骤。
- clarify=true 当：最近输出显示它在**向用户提问 / 等用户回答或拍板后才能继续**（例如列出待确认的问题、征求你决策）；此时 done 必为 false。
- done 与 clarify 都为 false：还在进行中、报错、被卡住、或证据不足以确认完成。`;
export const JUDGE_DONE_SYS_EN = `Judge the current state of a Claude Code task from evidence only and be conservative. Return JSON only: {"done": bool, "clarify": bool, "reason": "a concise reason"}.
- done=true only when work is complete, changes landed, relevant checks passed, no user input is pending, and no error or obvious next step remains.
- clarify=true when the latest output asks the user a question or cannot continue without their decision; done must then be false.
- otherwise both values are false.`;

/**
 * 同模块任务智能合并 system（v2 新增）：把同一模块下若干待办 issue 交 LLM 判断哪些
 * 可并成一条一起做，减少「同模块反复起会话/重复读代码」的开销。保守——只合并真正
 * 高度相关、能在一次实施里顺手一起做完的；独立任务保持独立。
 */
export const MERGE_SYS = `# 任务：判断同一模块下的多条待办能否合并成一条一起做
你是项目 PM，在调度前对同一模块（子系统/目录）的若干待办任务做智能归并，目的是让高度相关、
能在同一次实施里顺手一起完成的任务合并成一条，减少反复起会话、重复读代码的开销。

只输出 JSON：{"groups": [{"members": [id, id, ...], "title": "合并后标题", "body": "合并后正文"}]}

规则（宁可不合并，也别把不相关的硬凑一起）：
- 只合并**高度相关、边界重叠、能一起做且不互相冲突**的任务（如：改同一处逻辑的多个小修、
  同一功能的补充点、同一文件/组件的连续改动）。
- 目标不同、互相独立、或合并后会显著增大单次实施风险的，**不要合并**，直接不出现在 groups 里。
- 每个 group 至少 2 个 members；members 用给定的 id。
- title ≤ 60 字，概括合并后的整体目标。
- body：把被合并各条的需求**完整保留**并条理化（分条列出，不要丢信息），供工程师一次实施。
- 没有任何可合并的组时，groups 给空数组。`;
export const MERGE_SYS_EN = `# Task: decide whether pending issues in one module should be merged
Return JSON only: {"groups":[{"members":[1,2],"title":"merged title","body":"complete merged requirements"}]}.
Merge only highly related work with overlapping boundaries that can safely be implemented together. Keep independent or risky work separate. Every group needs at least two supplied IDs. Preserve every requirement in the merged body. Return an empty groups array when nothing should merge.`;

/** clarifying 判定 system（v2 新增，风格沿用四段调优 prompt 的保守哲学） */
export const CLARIFYING_SYS = `# 任务：判断需求是否需要先向发起人澄清
你是项目 PM，在决定一条 issue 能否直接进入规划实施。只输出 JSON：
{"clear": bool, "questions": ["问题1", "问题2"]}
规则（宁可少问也别烦人，最多 5 个问题）：
- clear=true：目标明确、范围可判断、没有会做错方向的关键歧义（实现细节可由工程师在规划阶段自行决定，不算歧义）。
- clear=false 仅当：存在不问清楚就会做错方向的关键歧义或缺失信息；questions 里每条是一个独立可回答的简短中文问题（口语，我在手机上打字回）。
- clear=true 时 questions 给空数组。`;
export const CLARIFYING_SYS_EN = `# Task: decide whether a request needs clarification before implementation
Return JSON only: {"clear": bool, "questions": ["question 1"]}.
Prefer not to interrupt the user. Set clear=false only for missing information or critical ambiguity that would send implementation in the wrong direction. Ask at most five short, independently answerable questions. Implementation details the engineer can choose are not ambiguity. When clear=true, questions must be empty.`;

/** issue → 项目模块的保守分类；英文 slug 是稳定目录名，不能生成泛滥。 */
export const MODULE_SUGGEST_SYS = `# Task: assign an issue to one project module
Return JSON only. Choose an existing module whenever it reasonably fits:
{"kind":"existing","moduleId":123}
Create a module only when no existing module has the same responsibility:
{"kind":"new","slug":"two-to-four-words","displayName":"Short name","purpose":"One sentence"}

Rules:
- slug must be a concise lowercase English phrase of 2–4 words joined by hyphens.
- Keep module boundaries broad and stable; do not create modules for individual screens, tickets, or implementation details.
- Respect the requested agent. A module has exactly one fixed agent.
- If creation is disallowed, kind must be "existing".`;

// ---------- 类型 ----------

/** capturePane 检测到的弹窗/菜单快照（core/screen detectSelection 的 PM 侧投影） */
export interface MenuSnapshot {
  /** 菜单标题/问题行（detectSelection 的 context） */
  title: string;
  /** 选项文本 */
  options: string[];
  /** 是否多选表单（多选一律升级人工，v1 规则） */
  multiSelect: boolean;
  /** 原始屏幕文本 */
  raw: string;
}

/** SelectionPayload（core/screen）→ MenuSnapshot 便捷转换（集成接线用） */
export function menuFromSelection(sel: { context: string; options: string[] }, raw = ''): MenuSnapshot {
  return {
    title: sel.context,
    options: sel.options,
    multiSelect: isMultiSelectMenu(sel.context, sel.options),
    raw,
  };
}

/** 审批结论（= approval.ts ApprovalOutcome，含 requestId 供防重放） */
export type ApprovalDecision = ApprovalOutcome;

export type DoneJudgement = 'done' | 'not_done' | 'blocked' | 'clarify';

/** 送 LLM 判合并的候选（同模块同 agent/类型的 pending issue 投影） */
export interface MergeCandidate {
  id: number;
  title: string;
  body: string | null;
}

/** LLM 给出的一个合并组：members 合成一条，title/body 为合并后内容 */
export interface MergeGroup {
  members: number[];
  title: string;
  body: string;
}

export interface SuggestModuleInput {
  title: string;
  body?: string | null;
  agent: AgentKind;
  modules: ProjectModule[];
  allowNew: boolean;
  manualName?: string;
}

export interface PmUserStore {
  getSettings(userId: number): { persona: string | null; memory: string | null; locale?: SupportedLocale | null };
  byId(id: number): { username: string } | undefined;
}

export interface PmAgentDeps {
  driver: ExecutorDriver;
  llm: LlmClient;
  /** core/users UserStore 结构兼容（getSettings/byId 子集） */
  users: PmUserStore;
  /** core/conversations ConversationManager 结构兼容 */
  convs: ToolConvOps;
  /** core/jsonl JsonlLocator 结构兼容 */
  locator: ToolLocator;
  /** 与 issue 引擎共用同一实例（tmuxLockKey 同一把锁才有互斥意义） */
  mutex: KeyedMutex;
  /** 全局管家 persona；缺省 loadGlobalPersona()（MANDO_PERSONA_FILE 可配） */
  globalPersona?: string;
  /** 给 DbSummaryStore 用（进度滚动摘要入库）；缺省内存存 */
  db?: Database;
}

/** 问答工具循环轮数上限（v1 agent.ts:169 平移） */
export const CHAT_TOOL_ROUNDS = 5;
/** summarizeProgress 喂 LLM 的活动文本上限（v1 context.maxChars 平移，保尾） */
export const SUMMARIZE_MAX_CHARS = 12000;

// ---------- 内部工具 ----------

interface Subtaskish {
  text: string;
  done?: boolean;
}

function subtaskTexts(issue: Issue): string[] {
  if (!issue.subtasksJson) return [];
  try {
    const a = JSON.parse(issue.subtasksJson) as Array<Subtaskish | string>;
    if (!Array.isArray(a)) return [];
    return a
      .map((s) => (typeof s === 'string' ? s : (s?.text ?? '')))
      .filter((t): t is string => typeof t === 'string' && t.length > 0);
  } catch {
    return [];
  }
}

/** issue 一句话正文（v1 issue.text 语义：title + body 合成） */
function composeIssueText(issue: Issue): string {
  return midTruncate(issue.body ? `${issue.title}：${issue.body}` : issue.title, 2000);
}

// ---------- PM 管家 ----------

export class PmAgent {
  private readonly globalPersona: string;
  private readonly customGlobalPersona: boolean;
  /** 进度滚动摘要：有 db 落 pm_progress（重启不丢，评审 H4），否则内存 */
  private readonly summary: SummaryStore;

  constructor(
    /** 项目级上下文锚点：goal / pm_persona / owner 都从这里来（pool 每次取用会刷新） */
    public project: Project,
    private readonly deps: PmAgentDeps,
  ) {
    this.customGlobalPersona = deps.globalPersona !== undefined || Boolean(process.env.MANDO_PERSONA_FILE);
    this.globalPersona = deps.globalPersona ?? loadGlobalPersona();
    this.summary = deps.db ? new DbSummaryStore(deps.db, project.id) : new MemorySummaryStore();
  }

  get projectId(): number {
    return this.project.id;
  }

  /**
   * systemPrompt 组装（顺序钦定）：
   * 全局 persona → 项目 pm_persona → 属主 persona → 属主 memory（属主 = project.owner_user_id）。
   */
  systemPrompt(localeOverride?: SupportedLocale): string {
    const s = this.deps.users.getSettings(this.project.ownerUserId);
    const locale = localeOverride ?? s.locale ?? DEFAULT_LOCALE;
    const globalPersona = this.customGlobalPersona
      ? this.globalPersona
      : promptLanguage(locale) === 'zh'
        ? DEFAULT_GLOBAL_PERSONA
        : DEFAULT_GLOBAL_PERSONA_EN;
    return (
      globalPersona +
      (this.project.pmPersona ? `\n\n# 项目 PM 设定\n${this.project.pmPersona}` : '') +
      (s.persona ? `\n\n# 用户附加设定\n${s.persona}` : '') +
      (s.memory ? `\n\n# 记忆\n${s.memory}` : '') +
      `\n\n${outputLanguageInstruction(locale)}`
    );
  }

  private localeForIssue(issue: Issue): SupportedLocale {
    const userId = issue.createdBy ?? this.project.ownerUserId;
    return this.deps.users.getSettings(userId).locale ?? DEFAULT_LOCALE;
  }

  /**
   * 组装某阶段要注入 Claude Code 的 prompt（issues/prompts.ts 模板 + 项目 goal + issue 上下文）。
   * 注意：引擎的 kickoff（engine.buildKickoffPrompt，带事件历史判 rework）是生产权威路径；
   * 本方法服务手动补喂/重试/预览等场景，rework 场景由调用方显式传 opts。
   * clarifying/plan_review/merge_review 等无 CC 注入 prompt 的阶段抛错。
   */
  async buildStagePrompt(
    issue: Issue & { implMode?: 'seq' | 'team' },
    stage: IssueState,
    opts: { feedback?: string | null; reworkSource?: 'tests_failed' | 'review_rejected' } = {},
  ): Promise<string> {
    const branch = issue.branch ?? `issue/${issue.id}`;
    const imgHint = imageReadHint(this.absImages(issue));
    const locale = this.localeForIssue(issue);
    switch (stage) {
      case 'planning':
        return buildPlanningPrompt({
          issue,
          goal: this.project.goal,
          feedback: opts.feedback ?? null,
          imgHint,
          locale,
        });
      case 'implementing': {
        if (opts.reworkSource) {
          return buildReworkPrompt({
            issue,
            feedback: opts.feedback ?? '',
            branch,
            source: opts.reworkSource,
            locale,
          });
        }
        const subtasks = subtaskTexts(issue);
        if (issue.implMode === 'team') {
          return buildTeamPrompt({ issue, subtasks, goal: this.project.goal, branch, imgHint, locale });
        }
        if (!subtasks[issue.subIndex]) {
          throw new Error(`issue ${issue.id} 无可喂子任务（subIndex=${issue.subIndex}）`);
        }
        return buildSubtaskPrompt({ issue, subtasks, idx: issue.subIndex, branch, locale });
      }
      case 'testing':
        return buildTestingPrompt({ issue, branch, locale });
      default:
        throw new Error(`阶段 ${stage} 没有 CC 注入 prompt`);
    }
  }

  /**
   * 完成判定兜底（三级机制的第 3 级，v1 fallbackDoneCheck→judgeDone 平移）：
   * 裸 system（不带 persona/memory，v1 语义）+ jsonMode，只看证据宁可保守。
   * 返回 'done'（已收尾）/ 'clarify'（在向用户提问/等输入，第二层保险，忘输出 NEED_CLARIFY 也能兜住）
   * / 'not_done'（还在跑或证据不足）。永远不返回 'blocked'（阻塞由哨兵 ISSUE_BLOCKED
   * 与菜单滞留检测负责）；LLM 调用错误上抛（引擎捕获落事件）。
   */
  async judgeDone(issue: Issue, recentOutput: string): Promise<DoneJudgement> {
    const locale = this.localeForIssue(issue);
    const subs = subtaskTexts(issue);
    const subsText = subs.length
      ? `\n子任务清单：\n${subs.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : '';
    const r = await this.deps.llm.chat(
      [
        { role: 'system', content: (promptLanguage(locale) === 'zh' ? JUDGE_DONE_SYS : JUDGE_DONE_SYS_EN) + `\n${outputLanguageInstruction(locale)}` },
        {
          role: 'user',
          content: promptLanguage(locale) === 'zh'
            ? `任务：${composeIssueText(issue)}${subsText}\n\n会话最近输出：\n${recentOutput}`
            : `Task:\n${composeIssueText(issue)}${subsText}\n\nLatest session output:\n${recentOutput}`,
        },
      ],
      { jsonMode: true },
    );
    try {
      const j = JSON.parse(r.content || '{}');
      // clarify 优先于 done：在等用户回答时绝不误判「完成」（宁可停下等，不擅自收尾）
      if (j.clarify === true) return 'clarify';
      if (j.done === true) return 'done';
      return 'not_done';
    } catch {
      return 'not_done'; // 解析失败按未完成（保守，v1 兜底语义）
    }
  }

  /**
   * 给 ModuleManager 的非权威分类建议。这里做语法与候选集合校验，最终的数量上限、
   * 冲突处理和落库仍由 ModuleManager 确定性执行。
   */
  async suggestModule(input: SuggestModuleInput): Promise<ModuleSuggestion> {
    const eligible = input.modules.filter((m) => m.status === 'active' && m.agent === input.agent);
    const rows = eligible.length
      ? eligible.map((m) => `- id=${m.id} slug=${m.slug} name=${m.displayName}`).join('\n')
      : '(none)';
    const creation = input.allowNew
      ? 'You may create one module only if none fits.'
      : 'Creation is disallowed. You must select one listed module.';
    const manual = input.manualName ? `\nUser-entered module name: ${input.manualName}` : '';
    const r = await this.deps.llm.chat(
      [
        { role: 'system', content: MODULE_SUGGEST_SYS },
        {
          role: 'user',
          content:
            `Agent: ${input.agent}\n${creation}\nExisting modules:\n${rows}${manual}\n\n` +
            `Issue: ${composeIssueText({ title: input.title, body: input.body ?? null } as Issue)}`,
        },
      ],
      { jsonMode: true },
    );
    try {
      const parsed = JSON.parse(r.content || '{}') as Record<string, unknown>;
      if (parsed.kind === 'existing') {
        const moduleId = Number(parsed.moduleId);
        if (eligible.some((m) => m.id === moduleId)) return { kind: 'existing', moduleId };
      }
      if (parsed.kind === 'new' && input.allowNew) {
        const slug = typeof parsed.slug === 'string' ? normalizeModuleSlug(parsed.slug) : null;
        const displayName = typeof parsed.displayName === 'string' ? parsed.displayName.trim().slice(0, 80) : '';
        const purpose = typeof parsed.purpose === 'string' ? parsed.purpose.trim().slice(0, 300) : '';
        if (slug && displayName && purpose) return { kind: 'new', slug, displayName, purpose };
      }
    } catch {
      // deterministic fallback below
    }
    if (eligible[0]) return { kind: 'existing', moduleId: eligible[0].id };
    return {
      kind: 'new',
      slug: 'general-work',
      displayName: 'General Work',
      purpose: 'General project work that does not yet belong to a stable module.',
    };
  }

  /**
   * 同模块任务智能合并（调度前调用）：把同一模块的若干 pending 候选交 LLM 判归并，
   * 返回合并组（每组 ≥2 条 members，含合并后 title/body）。只做建议——是否落地、
   * 校验 members 是否仍 pending、如何折叠取消，全在引擎侧确定性完成。
   * 保守：候选 <2、解析失败、LLM 未给合并组 → 返回 []（不合并，不卡调度）。
   */
  async mergeModuleTasks(module: string, candidates: MergeCandidate[]): Promise<MergeGroup[]> {
    if (candidates.length < 2) return [];
    const ids = new Set(candidates.map((c) => c.id));
    const list = candidates
      .map((c) => `#${c.id} ${midTruncate(c.body ? `${c.title}：${c.body}` : c.title, 500)}`)
      .join('\n');
    const locale = this.deps.users.getSettings(this.project.ownerUserId).locale ?? DEFAULT_LOCALE;
    const r = await this.deps.llm.chat(
      [
        { role: 'system', content: (promptLanguage(locale) === 'zh' ? MERGE_SYS : MERGE_SYS_EN) + `\n${outputLanguageInstruction(locale)}` },
        { role: 'user', content: promptLanguage(locale) === 'zh' ? `模块「${module}」下的待办任务：\n${list}` : `Pending issues in module ${module}:\n${list}` },
      ],
      { jsonMode: true },
    );
    try {
      const j = JSON.parse(r.content || '{}') as { groups?: unknown };
      const groups = Array.isArray(j.groups) ? j.groups : [];
      const out: MergeGroup[] = [];
      for (const g of groups) {
        if (!g || typeof g !== 'object') continue;
        const gg = g as { members?: unknown; title?: unknown; body?: unknown };
        const members = (Array.isArray(gg.members) ? gg.members : [])
          .map((m) => Number(m))
          .filter((m) => Number.isInteger(m) && ids.has(m));
        const uniq = [...new Set(members)];
        if (uniq.length < 2) continue; // 少于 2 条不成合并
        const title = typeof gg.title === 'string' && gg.title.trim() ? gg.title.trim().slice(0, 200) : '';
        const body = typeof gg.body === 'string' ? gg.body.trim().slice(0, 8000) : '';
        if (!title || !body) continue; // 合并后内容缺失，保守跳过
        out.push({ members: uniq, title, body });
      }
      // 防 LLM 把同一 id 划进多个组：一个 id 只归第一个用到它的组
      const used = new Set<number>();
      return out.filter((g) => {
        if (g.members.some((m) => used.has(m))) return false;
        g.members.forEach((m) => used.add(m));
        return true;
      });
    } catch {
      return [];
    }
  }

  /**
   * clarifying 阶段：判断需求是否含糊；含糊返回提问列表（≤5 条，经通知通道发发起人），
   * 清晰返回 null（引擎据此 skip_clarifying）。解析失败按不含糊处理（不卡流程，引擎另兜 LLM 错误）。
   */
  async generateClarifyingQuestions(issue: Issue): Promise<string[] | null> {
    const locale = this.localeForIssue(issue);
    const r = await this.deps.llm.chat(
      [
        { role: 'system', content: (promptLanguage(locale) === 'zh' ? CLARIFYING_SYS : CLARIFYING_SYS_EN) + `\n${outputLanguageInstruction(locale)}` },
        {
          role: 'user',
          content: promptLanguage(locale) === 'zh'
            ? `项目目标：${this.project.goal || '(未设)'}\nissue（${issue.category}）：${composeIssueText(issue)}`
            : `Project goal: ${this.project.goal || '(not set)'}\nIssue (${issue.category}): ${composeIssueText(issue)}`,
        },
      ],
      { jsonMode: true },
    );
    try {
      const j = JSON.parse(r.content || '{}');
      if (j.clear === true) return null;
      const qs = (Array.isArray(j.questions) ? (j.questions as unknown[]) : [])
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim().slice(0, 300))
        .slice(0, 5);
      return qs.length ? qs : null; // 说不清晰却没给问题 → 按清晰处理，不空转
    } catch {
      return null;
    }
  }

  /**
   * 弹窗自动审批（approval.ts 三层瀑布）：多选→escalate；trust→approve；
   * 其余按档位分流——谨慎转人工 / 中等走 驱动大模型 分级（裸 system）/ 全自动本地放行（红线除外）。
   * 结果含 requestId 供升级通知卡防重放。level 缺省 'medium' = 加档位之前的历史行为。
   */
  async decideApproval(
    menu: MenuSnapshot,
    task: { taskText?: string | null; createdBy?: number | null } = {},
    level: AutoApproveLevel = 'medium',
  ): Promise<ApprovalDecision> {
    return gradeApproval(
      this.deps.llm,
      { context: menu.title || menu.raw, options: menu.options, multiSelect: menu.multiSelect },
      { goal: this.project.goal, taskText: task.taskText },
      level,
      this.deps.users.getSettings(task.createdBy ?? this.project.ownerUserId).locale ?? DEFAULT_LOCALE,
    );
  }

  /**
   * 进度摘要（issue_events 批次 → 值不值得推）：值得推返回 headline，否则 null。
   * jsonl 噪音管道请用 createProgressReporter（批量 flush + 节流 + 回插）。
   */
  async summarizeProgress(events: IssueEvent[]): Promise<string | null> {
    if (!events.length) return null;
    const activity = events
      .map((e) => `[${e.kind}]${e.dataJson ? `：${e.dataJson.slice(0, 300)}` : ''}`)
      .join('\n')
      .slice(-SUMMARIZE_MAX_CHARS);
    const a = await analyzeProgress(this.deps.llm, {
      label: this.project.name,
      prev: this.summary.get(),
      activity,
      systemPrefix: this.systemPrompt(),
      locale: this.deps.users.getSettings(this.project.ownerUserId).locale ?? DEFAULT_LOCALE,
    });
    if (!a.push || !a.headline) return null;
    this.summary.set(a.headline);
    return a.headline;
  }

  /**
   * jsonl 进度管道工厂：批量 flush（默认 30s，可配）+ analyze 过滤，
   * 产出 {push, status, needsReply, headline} 给 NotifyRouter 适配层（onPush）。
   * deps.db 存在时 runningSummary 落 pm_progress 表（重启不丢）。
   */
  createProgressReporter(
    onPush: (a: ProgressAnalysis) => void | Promise<void>,
    opts: { throttleSeconds?: number } = {},
  ): ProgressReporter {
    return new ProgressReporter(this.project.name, this.deps.llm, onPush, this.summary, {
      throttleSeconds: opts.throttleSeconds,
      systemPrefix: () => this.systemPrompt(),
      locale: this.deps.users.getSettings(this.project.ownerUserId).locale ?? DEFAULT_LOCALE,
    });
  }

  /**
   * 项目内问答：网页/飞书就本项目提问时应答。
   * 工具四件套（tools.ts）项目作用域 + Driver 执行；最多 5 轮工具循环（v1 平移）。
   */
  async answerQuestion(userId: number, question: string): Promise<string> {
    const locale = this.deps.users.getSettings(userId).locale ?? DEFAULT_LOCALE;
    const convs = this.deps.convs.listByProject(this.project.id);
    const current = this.deps.convs.currentConv(this.project.id);
    const zh = promptLanguage(locale) === 'zh';
    const snapshot = convs.length
      ? convs
          .map(
            (c, i) =>
              `${i + 1}. ${c.label ?? c.id}${c.id === current ? (zh ? '（当前激活）' : ' (active)') : ''}${c.archived ? (zh ? '（已归档）' : ' (archived)') : ''}`,
          )
          .join('\n')
      : zh ? '（本项目还没有对话）' : '(No conversations in this project yet)';
    const asker = this.deps.users.byId(userId)?.username ?? (zh ? `用户${userId}` : `User ${userId}`);
    // v1 能力段措辞沿用，作用域从「本机所有会话」改写为本项目（评审 §2B）
    const capability = zh
      ? `# 你的能力（重要）\n你是项目「${this.project.name}」的 PM 管家，只负责本项目${this.project.goal ? `（项目目标：${this.project.goal}）` : ''}。有工具：list_sessions / read_progress / capture_pane / send_command。需要时主动调用再回答，绝不要说你没有监控能力。send_command 会改变项目会话状态，确认用户意图后再调。\n\n# 排版（飞书 lark_md）\n简洁：关键 **加粗**，多项换行+emoji；不要长段落或 markdown 标题。\n\n## 本项目对话快照\n${snapshot}\n\n（当前提问者：${asker}）`
      : `# Capabilities\nYou are the PM assistant for project "${this.project.name}" and only this project${this.project.goal ? ` (goal: ${this.project.goal})` : ''}. You can use list_sessions, read_progress, capture_pane, and send_command. Use tools when evidence is needed; never claim you cannot monitor the project. send_command changes session state, so confirm the user's intent first.\n\n# Feishu lark_md format\nBe concise, use **bold** and short emoji-separated lines where useful, and avoid headings or long paragraphs.\n\n## Project conversation snapshot\n${snapshot}\n\nCurrent requester: ${asker}`;
    const system = `${this.systemPrompt(locale)}\n\n${capability}\n\n${outputLanguageInstruction(locale)}`;
    return this.chatWithTools(system, question);
  }

  // ---- 内部 ----

  /** 带工具的问答循环（v1 chatWithTools 平移：5 轮上限、工具异常转字符串继续） */
  private async chatWithTools(system: string, userText: string): Promise<string> {
    const messages: LlmMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userText },
    ];
    for (let round = 0; round < CHAT_TOOL_ROUNDS; round++) {
      const msg = await this.deps.llm.chat(messages, { tools: TOOL_SCHEMAS });
      messages.push(msg.raw);
      if (msg.toolCalls.length) {
        for (const tc of msg.toolCalls) {
          let result = '';
          try {
            result = await executeTool(
              tc.function.name,
              JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>,
              this.toolDeps(),
            );
          } catch (e) {
            result = `工具出错: ${String(e)}`;
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        continue;
      }
      return msg.content;
    }
    return '（工具调用轮数过多，没得到最终答复）';
  }

  private toolDeps(): PmToolsDeps {
    return {
      projectId: this.project.id,
      driver: this.deps.driver,
      convs: this.deps.convs,
      locator: this.deps.locator,
      mutex: this.deps.mutex,
    };
  }

  /** imagesJson → 执行机侧绝对路径（engine.absImages 同语义） */
  private absImages(issue: Issue): string[] {
    if (!issue.imagesJson) return [];
    try {
      const arr = JSON.parse(issue.imagesJson) as string[];
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => (p.startsWith('/') ? p : `${this.project.cwd.replace(/\/+$/, '')}/${p}`));
    } catch {
      return [];
    }
  }
}

// ---------- 管家池 ----------

/**
 * 管家池工厂：Map<projectId, PmAgent>，同项目复用实例（保留滚动摘要等运行态），
 * 每次取用刷新 project 快照（goal/pm_persona/owner 可能已被网页改过）。
 * 返回值签名与 EngineDeps.pmFor 一致，可直接接线。
 */
export function createPmPool(deps: PmAgentDeps): (project: Project) => PmAgent {
  const pool = new Map<number, PmAgent>();
  return (project: Project) => {
    let pm = pool.get(project.id);
    if (!pm) {
      pm = new PmAgent(project, deps);
      pool.set(project.id, pm);
    } else {
      pm.project = project;
    }
    return pm;
  };
}

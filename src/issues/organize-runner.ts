/**
 * issues/organize-runner —— 「模块智能整理」驱动器：用户手动触发后，用所选的
 * claude/codex 在**一次性独立** tmux 会话 `org-<projectId>` 里扫描项目全部历史 issue
 * （标题+正文）并结合代码库理解，产出整理方案 plan.json：
 *   - merge：职责重叠的模块合并（保留方语义沿用 mergeModules）；
 *   - create：确有独立职责但还没有模块的 → 全新建模块；
 *   - rename：把 legacy-module-NN 这类无意义序号 slug 改成与显示名语义相近的英文名；
 *   - move：归错类的个别 issue 拆出去挪进其他/新模块（已完成的历史 issue 也可挪）。
 * 最后创建标记文件 done。runner 轮询 done 直到出现或超时，读回 plan.json 返回原文；
 * **确定性清洗（parseOrganizePlan）由引擎在拿到结果后按当时的库内事实做**——方案只是建议，
 * 逐项执行前还会再校验一轮。
 *
 * 文件哨兵而非抓屏找关键词：与 clarify-runner/agent-summary 同理（注入提示词含指令文字，
 * capture-pane 会回显我们敲进去的内容，抓屏必误命中）。菜单（信任/权限弹窗）自动过，
 * codex 更新弹窗选 Skip——逻辑与 clarify-runner 一致。
 *
 * scratch 按项目隔离（.panda/tmp/organize/<projectId>/）；每项目单飞由引擎保证。
 */
import {
  runAgentArtifacts,
  type AgentArtifactDriver,
} from '../core/agent-artifact-runner';
import type { AgentKind } from '../core/types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';
import { normalizeModuleSlug } from './modules';

/** runner 需要的 Driver 子集 = clarify-runner 同款（tmux + 受限文件） */
export type OrganizeDriver = AgentArtifactDriver;

/** scratch 根目录名（挂在项目 cwd 下；子目录按 projectId 隔离） */
export const ORGANIZE_SCRATCH_BASE = '.panda/tmp/organize';

/** plan.json 读取上限（模块+issue 都很多时也远用不满） */
const MAX_PLAN_BYTES = 128 * 1024;
/** 单方案动作数上限（超出的丢弃——LLM 洪水输出不进事件） */
export const MAX_ORGANIZE_ACTIONS = 40;
/** reason 长度上限 */
const MAX_REASON_CHARS = 200;

/** 给 cwd + projectId 算出各 scratch 绝对路径 */
export function organizePaths(cwd: string, projectId: number): {
  scratch: string;
  task: string;
  plan: string;
  done: string;
} {
  const base = `${cwd.replace(/\/+$/, '')}/${ORGANIZE_SCRATCH_BASE}/${projectId}`;
  return { scratch: base, task: `${base}/task.md`, plan: `${base}/plan.json`, done: `${base}/done` };
}

/** 独立整理会话名（项目维度；与 cc-<pid> / clr-<iid> / sum-<pid> 互不干扰） */
export function organizeSessionName(projectId: number): string {
  return `org-${projectId}`;
}

// ---------- 方案动作类型（清洗后的确定形状；引擎事件与 UI 共用） ----------

export type OrganizeAction =
  | { kind: 'create'; slug: string; displayName: string; agent: AgentKind; reason: string }
  | { kind: 'rename'; moduleId: number; slug: string; displayName?: string; reason: string }
  | { kind: 'merge'; targetId: number; sourceIds: number[]; reason: string }
  | {
      kind: 'move';
      issueIds: number[];
      /** 挪去已有模块（moduleId）或本方案 create 的新模块（slug） */
      to: { moduleId: number } | { slug: string };
      reason: string;
    };

/** 清洗上下文：库内当时事实（active 模块、全部 slug 含归档、全部 issue 投影） */
export interface OrganizePlanContext {
  modules: Array<{ id: number; slug: string; agent: AgentKind; active: boolean }>;
  issues: Array<{ id: number; status: string; moduleId: number | null }>;
}

// ---------- task.md / prompt 组装 ----------

export interface OrganizeModuleInfo {
  id: number;
  slug: string;
  displayName: string;
  agent: AgentKind;
  source: string;
  issueCount: number;
}

export interface OrganizeIssueInfo {
  id: number;
  title: string;
  body: string | null;
  status: string;
  agent: AgentKind;
  moduleId: number | null;
}

/** issue 正文进清单前的压平截断（全量 issue 都要进文件，单条别失控） */
function excerpt(body: string | null, n = 300): string {
  const t = (body ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 组装写给代理读的任务文件（全部模块 + 全部 issue 清单；文件无注入预算，不截 issue 条数） */
export function buildOrganizeTaskMd(input: {
  projectName: string;
  goal?: string | null;
  modules: OrganizeModuleInfo[];
  issues: OrganizeIssueInfo[];
}): string {
  const byModule = new Map<number | null, OrganizeIssueInfo[]>();
  for (const i of input.issues) {
    const k = i.moduleId;
    const list = byModule.get(k) ?? [];
    list.push(i);
    byModule.set(k, list);
  }
  const issueLines = (list: OrganizeIssueInfo[]): string[] =>
    list.map((i) => {
      const body = excerpt(i.body);
      return `- #${i.id} [${i.status}/${i.agent}] ${i.title}${body ? ` —— ${body}` : ''}`;
    });
  const sections: string[] = [];
  for (const m of input.modules) {
    const list = byModule.get(m.id) ?? [];
    sections.push(
      `### 模块 id=${m.id}「${m.displayName}」（slug=${m.slug} · ${m.agent} · ${m.source} · ${list.length} issue）`,
      '',
      ...(list.length ? issueLines(list) : ['（无 issue）']),
      '',
    );
  }
  const orphan = byModule.get(null) ?? [];
  if (orphan.length) {
    sections.push('### 未归入正式模块的 issue', '', ...issueLines(orphan), '');
  }
  return [
    `# 模块整理任务（项目：${input.projectName}）`,
    '',
    ...(input.goal ? [`- 项目目标：${input.goal}`, ''] : []),
    `当前共 ${input.modules.length} 个 active 模块、${input.issues.length} 条 issue，按模块列出如下。`,
    '',
    ...sections,
  ].join('\n');
}

/**
 * 组装注入给代理的提示词（单段：sendKeys 会把换行转空格、截断 2000，故简明成段；
 * 模块/issue 清单不进提示词——写在 task.md 里让代理自己读，绕开注入预算）。
 */
export function buildOrganizePrompt(
  agent: AgentKind,
  projectId: number,
  locale: SupportedLocale = 'zh-Hans',
): string {
  const rel = `${ORGANIZE_SCRATCH_BASE}/${projectId}`;
  if (promptLanguage(locale) === 'en') {
    return [
      `Perform a read-only project module organization analysis. Do not change code or files outside ${rel}/.`,
      `(1) Read ${rel}/task.md and inspect the repository to understand module responsibilities.`,
      `(2) Write ${rel}/plan.json as {"actions":[...]}. Allowed actions are "merge", "rename", "create", and "move" using the exact schema documented in task.md. Use semantic lowercase 2-4 word hyphenated English slugs. Keep module boundaries broad and stable, preserve user-authored issue text, prefer conservative no-op decisions, and give every action a concise reason in the selected output language.`,
      `(3) As the final step, create ${rel}/done containing ok.`,
      agent === 'codex' ? 'Proceed without requesting approval.' : '',
      outputLanguageInstruction(locale),
    ].filter(Boolean).join(' ');
  }
  return [
    `你在为项目做「模块整理分析」，这是只读分析，除 ${rel}/ 下的产物文件外不要改动任何文件、不要写代码。请严格按顺序完成：`,
    `(1) 读取文件 ${rel}/task.md（当前全部模块与全部历史 issue 清单），并浏览项目代码库理解各部分职责；`,
    `(2) 给出模块整理方案，写到文件 ${rel}/plan.json，格式为 {"actions":[...]}，动作四种：`,
    `{"kind":"merge","targetId":保留模块id,"sourceIds":[并入后归档的模块id],"reason":"..."} 合并职责相同或高度重叠的模块；`,
    `{"kind":"rename","moduleId":id,"slug":"新英文slug","displayName":"新显示名(可选)","reason":"..."} 把 legacy-module-NN 这类无意义序号 slug 改成语义化英文名；`,
    `{"kind":"create","slug":"...","displayName":"...","agent":"claude|codex","reason":"..."} 新建确有独立职责的模块；`,
    `{"kind":"move","issueIds":[issue id],"to":"目标模块id或本方案新建模块的slug","reason":"..."} 把归错类的 issue 挪进其他/新模块。`,
    `要求：slug 用 2-4 个小写英文单词连字符拼接，语义必须与显示名对应（如「Git 页面」→ git-pages），严禁无意义编号；显示名保持中文可读；合并选保留方时优先 issue 多、名称更能概括职责的一方；宁可保守不动，也不要为整齐而硬拆硬并；每个动作都要给简短中文 reason；没有值得做的就给空 actions；`,
    `(3) 全部完成后，最后创建标记文件 ${rel}/done（内容写 ok 即可）——这一步必须最后做。`,
    agent === 'codex' ? '（无需请求审批，直接执行。）' : '',
    outputLanguageInstruction(locale),
  ]
    .filter(Boolean)
    .join(' ');
}

// ---------- 方案清洗（纯函数；LLM 只出建议，落事件前必须过这里） ----------

function cleanReason(v: unknown): string | null {
  const r = typeof v === 'string' ? v.trim().slice(0, MAX_REASON_CHARS) : '';
  return r || null;
}

/**
 * plan.json 原文 → 清洗后的动作列表。规则（宁可丢弃也不落可疑动作）：
 * - 只认上下文里存在的模块/issue id；slug 一律过 normalizeModuleSlug；缺 reason 丢弃；
 * - create/rename 的新 slug 不得与项目内任何 slug（含归档，UNIQUE 约束）或本方案先前动作冲突；
 * - 一个模块最多出现在一个模块级动作里（merge 目标/来源、rename 互斥，防执行顺序歧义）；
 * - move 只收非驱动态 issue（pending/done/blocked/cancelled；执行中的挪了会踩正在跑的会话）；
 *   目标可以是 active 模块 id，或本方案 create 的新 slug；已在目标模块的 issue 剔除；
 * - 总量截断 MAX_ORGANIZE_ACTIONS。
 */
export function parseOrganizePlan(text: string | null | undefined, ctx: OrganizePlanContext): OrganizeAction[] {
  if (!text) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const actions = (raw as { actions?: unknown })?.actions;
  if (!Array.isArray(actions)) return [];

  const activeById = new Map(ctx.modules.filter((m) => m.active).map((m) => [m.id, m]));
  const issueById = new Map(ctx.issues.map((i) => [i.id, i]));
  const usedSlugs = new Set(ctx.modules.map((m) => m.slug)); // 含归档：UNIQUE(project_id, slug)
  const usedModules = new Set<number>(); // 模块级动作互斥
  const createdSlugs = new Set<string>(); // 本方案新建的 slug（move 目标可引用）
  const out: OrganizeAction[] = [];

  for (const a of actions) {
    if (out.length >= MAX_ORGANIZE_ACTIONS) break;
    if (!a || typeof a !== 'object') continue;
    const g = a as Record<string, unknown>;
    const reason = cleanReason(g.reason);
    if (!reason) continue;

    if (g.kind === 'create') {
      const slug = typeof g.slug === 'string' ? normalizeModuleSlug(g.slug) : null;
      if (!slug || usedSlugs.has(slug)) continue;
      const agent: AgentKind = g.agent === 'codex' ? 'codex' : 'claude';
      const displayName =
        (typeof g.displayName === 'string' ? g.displayName.trim().slice(0, 80) : '') || slug;
      usedSlugs.add(slug);
      createdSlugs.add(slug);
      out.push({ kind: 'create', slug, displayName, agent, reason });
    } else if (g.kind === 'rename') {
      const moduleId = Number(g.moduleId);
      const m = activeById.get(moduleId);
      if (!m || usedModules.has(moduleId)) continue;
      const slug = typeof g.slug === 'string' ? normalizeModuleSlug(g.slug) : null;
      if (!slug || slug === m.slug || usedSlugs.has(slug)) continue;
      const displayName = typeof g.displayName === 'string' ? g.displayName.trim().slice(0, 80) : '';
      usedSlugs.add(slug);
      usedModules.add(moduleId);
      out.push({ kind: 'rename', moduleId, slug, ...(displayName ? { displayName } : {}), reason });
    } else if (g.kind === 'merge') {
      const targetId = Number(g.targetId);
      if (!activeById.has(targetId) || usedModules.has(targetId)) continue;
      const sourceIds = [
        ...new Set(
          (Array.isArray(g.sourceIds) ? g.sourceIds : [])
            .map((s) => Number(s))
            .filter((s) => activeById.has(s) && s !== targetId && !usedModules.has(s)),
        ),
      ];
      if (!sourceIds.length) continue;
      usedModules.add(targetId);
      sourceIds.forEach((s) => usedModules.add(s));
      out.push({ kind: 'merge', targetId, sourceIds, reason });
    } else if (g.kind === 'move') {
      // 目标：数字/数字串 = 已有 active 模块 id；其余字符串 = 本方案 create 的新 slug
      const toRaw = g.to;
      let to: { moduleId: number } | { slug: string } | null = null;
      const asId = Number(toRaw);
      if (Number.isInteger(asId) && asId > 0 && activeById.has(asId)) {
        to = { moduleId: asId };
      } else if (typeof toRaw === 'string') {
        const slug = normalizeModuleSlug(toRaw);
        if (slug && createdSlugs.has(slug)) to = { slug };
      }
      if (!to) continue;
      const targetModuleId = 'moduleId' in to ? to.moduleId : null;
      const issueIds = [
        ...new Set(
          (Array.isArray(g.issueIds) ? g.issueIds : [])
            .map((s) => Number(s))
            .filter((id) => {
              const i = issueById.get(id);
              if (!i) return false;
              if (!['pending', 'done', 'blocked', 'cancelled'].includes(i.status)) return false;
              return targetModuleId === null || i.moduleId !== targetModuleId;
            }),
        ),
      ];
      if (!issueIds.length) continue;
      out.push({ kind: 'move', issueIds, to, reason });
    }
  }
  return out;
}

// ---------- runner ----------

export interface OrganizeRunnerDeps {
  driver: OrganizeDriver;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RunOrganizeInput {
  projectId: number;
  cwd: string;
  agent: AgentKind;
  projectName: string;
  goal?: string | null;
  modules: OrganizeModuleInfo[];
  issues: OrganizeIssueInfo[];
  locale?: SupportedLocale;
}

export interface OrganizeRunOptions {
  pollIntervalMs?: number;
  /** 从注入提示词起算的总超时（ms）；整理要扫全部 issue + 代码库，比澄清宽 */
  timeoutMs?: number;
  readyDelayMs?: number;
  claudeArgs?: string;
  codexArgs?: string;
  maxPlanBytes?: number;
}

export type RunOrganizeResult =
  | { ok: true; planText: string }
  | { ok: false; reason: 'timeout' | 'no-output' | 'error'; error?: string };

export class OrganizeRunner {
  private readonly driver: OrganizeDriver;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: OrganizeRunnerDeps) {
    this.driver = deps.driver;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async run(input: RunOrganizeInput, options: OrganizeRunOptions = {}): Promise<RunOrganizeResult> {
    const session = organizeSessionName(input.projectId);
    const p = organizePaths(input.cwd, input.projectId);
    const result = await runAgentArtifacts(
      { driver: this.driver, now: this.now, sleep: this.sleep },
      {
        agent: input.agent,
        cwd: input.cwd,
        session,
        scratch: p.scratch,
        prompt: buildOrganizePrompt(input.agent, input.projectId, input.locale),
        inputFiles: [{ path: p.task, data: buildOrganizeTaskMd(input) }],
        donePath: p.done,
        artifacts: [{
          key: 'plan',
          path: p.plan,
          maxBytes: options.maxPlanBytes ?? MAX_PLAN_BYTES,
          required: false,
        }],
      },
      {
        pollIntervalMs: options.pollIntervalMs ?? 5000,
        timeoutMs: options.timeoutMs ?? 15 * 60 * 1000,
        readyDelayMs: options.readyDelayMs,
        claudeArgs: options.claudeArgs,
        codexArgs: options.codexArgs,
      },
    );
    if (!result.ok) {
      return result.reason === 'timeout'
        ? { ok: false, reason: 'timeout' }
        : { ok: false, reason: 'error', ...(result.error ? { error: result.error } : {}) };
    }
    const planText = typeof result.artifacts.plan === 'string' ? result.artifacts.plan.trim() : '';
    return planText ? { ok: true, planText } : { ok: false, reason: 'no-output' };
  }
}

/** 便捷函数：一次性跑完并返回结果。 */
export function runOrganize(
  deps: OrganizeRunnerDeps,
  input: RunOrganizeInput,
  options?: OrganizeRunOptions,
): Promise<RunOrganizeResult> {
  return new OrganizeRunner(deps).run(input, options);
}

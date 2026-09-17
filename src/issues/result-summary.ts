/**
 * issues/result-summary —— 收尾摘要的确定性拼装（#275 / I-05）。
 *
 * 为什么要有这个模块：原来的执行总结是收尾时**另起一轮满窗注入**，让代理把 300 字摘要
 * 写进文件再由引擎读回来。那一轮正好落在全程上下文最高点（#270 实测 218k），还要
 * mkdir + 写两个文件 + 写哨兵四次工具调用——为一段摘要付一整轮请求，是单条 issue 里
 * 最贵的一次「非生产性」支出。
 *
 * 现在改成：引擎手里本来就有的结构化数据直接拼。这些数据的产生是 issue 执行的副产品，
 * 一分钱不额外花——
 * - done：结构化完成报告（代理随最后一次 STAGE_DONE 内联带出）+ 子任务完成情况 +
 *   `impl_commits` 的提交与逐文件改动 + 推送结果（auto_push / push_skipped / auto_push_failed）；
 * - blocked：最近一次 block note + 最后一次失败事件（error / tests_failed）+ 当时的进度。
 *
 * 全部是**纯函数**：入参是普通数据，不碰 store / driver / 时钟，方便单测。拼不出内容时
 * 返回空串，由调用方决定要不要降级到 PM——本模块不做降级，也不抛错。
 *
 * 入参类型刻意在本文件里独立声明（与 queue.ts 的 QueueIssue 同一套路），不从 engine.ts
 * 引类型：engine 要 import 本模块，反向再引会把两个大文件绑死。
 */
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { promptLanguage } from '../agents/prompts/language';
import type { CompletionReport } from './completion-report';

/** 摘要总长上限：给 UI 一段能一眼扫完的东西，不是完整报告（完整报告在 completionReport 里） */
export const MAX_SUMMARY_CHARS = 1200;
/** 清单类字段各自最多列几条（实现/验证/遗留） */
const MAX_LIST_LINES = 5;
/** 单行上限 */
const MAX_LINE_CHARS = 200;

export interface SummarySubtask {
  text: string;
  done: boolean;
}

export interface SummaryCommit {
  short: string;
  subject: string;
}

export interface SummaryFile {
  status: string;
  path: string;
  adds: number | null;
  dels: number | null;
}

/** 事件的最小形状（只用得上这三个字段；调用方直接把 issue_events 行喂进来即可） */
export interface SummaryEvent {
  id: number;
  kind: string;
  dataJson: string | null;
}

export type PushOutcome =
  | { kind: 'pushed'; branch: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'failed'; detail: string }
  | null;

export interface FailureInfo {
  /** 事件类别：tests_failed 或 error（error 再按 where 细分） */
  kind: string;
  /** where=auto_commit / auto_push / judgeDone …；tests_failed 无 */
  where?: string;
  detail: string;
}

function parse(dataJson: string | null): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const v = JSON.parse(dataJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // 坏事件当没有，不让一条脏数据把整段摘要搞没
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function clip(s: string, n = MAX_LINE_CHARS): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

/**
 * 本轮推送到底怎么样了：取三类推送事件里**最后发生的那条**。
 * 三者互斥但会跨轮重复（重跑、人工补推），只有最后一条代表现状。
 */
export function pushOutcomeOf(events: readonly SummaryEvent[]): PushOutcome {
  let latest: SummaryEvent | null = null;
  for (const e of events) {
    if (e.kind !== 'auto_push' && e.kind !== 'push_skipped' && e.kind !== 'auto_push_failed') continue;
    if (!latest || e.id > latest.id) latest = e;
  }
  if (!latest) return null;
  const d = parse(latest.dataJson);
  if (latest.kind === 'auto_push') return { kind: 'pushed', branch: str(d.branch) };
  if (latest.kind === 'push_skipped') return { kind: 'skipped', reason: str(d.reason) };
  return { kind: 'failed', detail: str(d.detail) };
}

/**
 * 最后一次失败事件：`tests_failed` 或任意 `error`（含 where=auto_commit 的自动提交失败）。
 * 这是「卡在哪里」最有信息量的一条——block note 常常只说结论，失败事件里才有原话。
 */
export function lastFailureOf(events: readonly SummaryEvent[]): FailureInfo | null {
  let latest: SummaryEvent | null = null;
  for (const e of events) {
    if (e.kind !== 'error' && e.kind !== 'tests_failed') continue;
    if (!latest || e.id > latest.id) latest = e;
  }
  if (!latest) return null;
  const d = parse(latest.dataJson);
  if (latest.kind === 'tests_failed') {
    const note = str(d.note);
    return note ? { kind: 'tests_failed', detail: note } : { kind: 'tests_failed', detail: '' };
  }
  const where = str(d.where);
  const detail = str(d.error) || str(d.reason);
  return { kind: 'error', ...(where ? { where } : {}), detail };
}

function subtaskLine(subs: readonly SummarySubtask[], zh: boolean): string | null {
  if (subs.length === 0) return null;
  const done = subs.filter((s) => s.done).length;
  return zh ? `子任务：${done}/${subs.length} 完成` : `Subtasks: ${done}/${subs.length} done`;
}

function changeLine(
  commits: readonly SummaryCommit[],
  files: readonly SummaryFile[],
  zh: boolean,
): string | null {
  if (commits.length === 0 && files.length === 0) return null;
  const adds = files.reduce((n, f) => n + (f.adds ?? 0), 0);
  const dels = files.reduce((n, f) => n + (f.dels ?? 0), 0);
  return zh
    ? `改动：${commits.length} 个提交 / ${files.length} 个文件（+${adds} −${dels}）`
    : `Changes: ${commits.length} commits / ${files.length} files (+${adds} −${dels})`;
}

function pushLine(outcome: PushOutcome, zh: boolean): string | null {
  if (!outcome) return null;
  if (outcome.kind === 'pushed') {
    return zh
      ? `推送：已推送${outcome.branch ? `（${outcome.branch}）` : ''}`
      : `Push: pushed${outcome.branch ? ` (${outcome.branch})` : ''}`;
  }
  if (outcome.kind === 'skipped') {
    // 无远端不是故障，文案别写成失败，否则用户会去查一个不存在的问题
    return zh ? '推送：已跳过（项目没有配置远端）' : 'Push: skipped (no remote configured)';
  }
  return zh
    ? `推送：未推送${outcome.detail ? `——${clip(outcome.detail, 120)}` : ''}`
    : `Push: not pushed${outcome.detail ? ` — ${clip(outcome.detail, 120)}` : ''}`;
}

function listBlock(title: string, items: readonly string[]): string | null {
  const kept = items.map((s) => clip(s)).filter(Boolean).slice(0, MAX_LIST_LINES);
  if (kept.length === 0) return null;
  return `${title}\n${kept.map((s) => `- ${s}`).join('\n')}`;
}

function assemble(parts: readonly (string | null)[]): string {
  const text = parts.filter((p): p is string => !!p && p.trim().length > 0).join('\n').trim();
  return text.length <= MAX_SUMMARY_CHARS ? text : `${text.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

export interface DoneSummaryInput {
  /** 结构化完成报告（代理内联带出的那份）；没有就只靠客观数据拼 */
  report: CompletionReport | null;
  subtasks: readonly SummarySubtask[];
  commits: readonly SummaryCommit[];
  files: readonly SummaryFile[];
  events: readonly SummaryEvent[];
  locale?: SupportedLocale;
}

/**
 * done 的摘要：有结构化报告就以它为主干（目标/实现/验证/遗留），再补客观数据；
 * 没有报告就只用客观数据——**「本次改了什么、推没推上去」本身就是有用的交代**，
 * 比一句「已完成」强得多，也不需要为此再花一次模型请求。
 */
export function buildDoneSummary(input: DoneSummaryInput): string {
  const zh = promptLanguage(input.locale ?? DEFAULT_LOCALE) === 'zh';
  const r = input.report;
  const objective = r?.objective ? clip(r.objective, 300) : '';
  return assemble([
    objective ? (zh ? `目标：${objective}` : `Objective: ${objective}`) : null,
    r?.completion ? (zh ? `完成情况：${clip(r.completion, 300)}` : `Outcome: ${clip(r.completion, 300)}`) : null,
    subtaskLine(input.subtasks, zh),
    changeLine(input.commits, input.files, zh),
    pushLine(pushOutcomeOf(input.events), zh),
    r ? listBlock(zh ? '实现：' : 'Implementation:', r.implementation) : null,
    r ? listBlock(zh ? '验证：' : 'Verification:', r.verification) : null,
    r ? listBlock(zh ? '遗留：' : 'Remaining:', [...r.unmetGoals, ...r.remainingWork]) : null,
  ]);
}

export interface BlockedSummaryInput {
  /** 最近一次进入 blocked 时记下的原因（transition 的 note） */
  blockNote: string | null;
  subtasks: readonly SummarySubtask[];
  commits: readonly SummaryCommit[];
  events: readonly SummaryEvent[];
  locale?: SupportedLocale;
}

/** 失败事件的人话说明（where 已知的挑常见几类，其余原样带 where） */
function failureLine(f: FailureInfo, zh: boolean): string {
  const detail = clip(f.detail, 300);
  if (f.kind === 'tests_failed') {
    return zh ? `最后一次失败：测试未通过${detail ? `——${detail}` : ''}`
      : `Last failure: tests failed${detail ? ` — ${detail}` : ''}`;
  }
  const label = zh
    ? f.where === 'auto_commit' ? '自动提交失败'
      : f.where === 'auto_push' ? '自动推送失败'
        : f.where ? `${f.where} 出错` : '执行出错'
    : f.where === 'auto_commit' ? 'auto commit failed'
      : f.where === 'auto_push' ? 'auto push failed'
        : f.where ? `${f.where} error` : 'error';
  return zh ? `最后一次失败：${label}${detail ? `——${detail}` : ''}`
    : `Last failure: ${label}${detail ? ` — ${detail}` : ''}`;
}

/**
 * blocked 的摘要：先说「卡在哪里」（block note 是结论），再补最后一次失败事件（原话在这里），
 * 最后给一句当时的进度，让人知道回来接手时手头有什么。
 */
export function buildBlockedSummary(input: BlockedSummaryInput): string {
  const zh = promptLanguage(input.locale ?? DEFAULT_LOCALE) === 'zh';
  const note = input.blockNote ? clip(input.blockNote, 400) : '';
  const failure = lastFailureOf(input.events);
  return assemble([
    note ? (zh ? `卡在这里：${note}` : `Blocked on: ${note}`) : null,
    failure ? failureLine(failure, zh) : null,
    subtaskLine(input.subtasks, zh),
    input.commits.length > 0
      ? (zh ? `已有 ${input.commits.length} 个提交，改动都在分支上` : `${input.commits.length} commits are already on the branch`)
      : null,
  ]);
}

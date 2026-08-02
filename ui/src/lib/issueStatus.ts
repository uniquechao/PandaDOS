/** issue 状态分类小工具（纯函数，便于单测）。 */
import { tryJson } from './fmt';
import { tr } from '../i18n/runtime';
import type { IssueEvent, IssueStatus } from './types';

/** 「驱动中」= AI 正在跑的状态（可终止/重试，执行页显示运行操作栏） */
export const DRIVING_STATUSES: IssueStatus[] = ['planning', 'implementing', 'testing', 'merging'];

export function isDriving(status: IssueStatus): boolean {
  return DRIVING_STATUSES.includes(status);
}

/** 「重试」按当前状态派生的动作 */
export type RetryAction =
  | 'unblock' // 受阻 → 解除阻塞重跑（POST /unblock）
  | 'reopen' // 已取消 → 复活重跑（POST /reopen，#93）
  | 'inject' // 驱动中且最近失败 → 注入「请重试刚才失败的步骤」
  | 'none'; // 无可重试

export interface RetryPlan {
  action: RetryAction;
  label: string;
  enabled: boolean;
  hint: string;
}

/**
 * 重试决策（纯函数）：
 *  - blocked → unblock 重跑（始终可用）；
 *  - cancelled → reopen 复活重跑（#93；注意它会立刻排队开跑，要改需求得先改完再点）；
 *  - 驱动中 + 最近工具异常 → 注入重试提示；驱动中但无失败步骤 → 禁用；
 *  - 其余 → 无。
 *
 * done 刻意不给重跑：它是真终态（状态机也不接 reopen），别在这里开口子。
 */
export function retryPlan(status: IssueStatus, hasError: boolean): RetryPlan {
  if (status === 'blocked') {
    return { action: 'unblock', label: tr('action.unblockRetry'), enabled: true, hint: tr('action.unblockRetryHint') };
  }
  if (status === 'cancelled') {
    return {
      action: 'reopen',
      label: tr('action.runAgain'),
      enabled: true,
      hint: tr('action.runAgainHint'),
    };
  }
  if (isDriving(status)) {
    return hasError
      ? { action: 'inject', label: tr('action.retry'), enabled: true, hint: tr('action.retryHint') }
      : { action: 'none', label: tr('action.retry'), enabled: false, hint: tr('action.noRetry') };
  }
  return { action: 'none', label: tr('action.retry'), enabled: false, hint: '' };
}

/** 澄清分析在途标记的兜底时限：runner 超时 8 分钟，超过 15 分钟仍无终结事件视为已死（如服务重启丢链），不再显示「分析中」 */
export const CLARIFY_ANALYZING_MAX_AGE_MS = 15 * 60_000;

/**
 * 「澄清分析进行中」派生（纯函数，事件溯源）：最近一条 clarify_started 之后还没有终结事件
 * —— clarify_done（产出落库）/ clarify_discarded（归来时已开跑丢弃）/ error@where=clarify（失败）。
 * 创建/答澄清/改需求正文都会触发（重）分析，UI 用它显示「代理正在重新分析…」占位。
 * started 距今超过 maxAgeMs 视为悬空（分析链随进程死亡，事件不会再来），返回 false 自愈。
 */
/** 顶部澄清面板的派生状态（clarifyPanelState 的返回值） */
export interface ClarifyPanelState {
  /** 面板是否展开 */
  visible: boolean;
  /** 待回答的问题清单（最近一批；已回答/超时 → 空） */
  questions: string[];
  /**
   * 代理原话全文（#110，事件 text 字段；已回答/超时随 questions 一起清空）：
   * questions 只有清单项，交代前提/现状的散文会丢——有原文就整段展示，旧事件没有则为 ''
   */
  text: string;
  /** 澄清分析进行中（显示「正在重新分析」占位） */
  analyzing: boolean;
}

/**
 * 顶部澄清面板派生（纯函数，IssueDetail 用；事件溯源，随 5s 轮询刷新，多轮问答天然闭环）：
 *  - questions：最近一批 clarify_questions，其后已有 clarified/clarify_timeout（已回答/超时自动
 *    继续）即收起——新一轮问题事件出现则自动覆盖旧问题重新展开；
 *  - analyzing：见 clarifyAnalyzing（创建/答澄清/改需求正文触发的（重）分析在途）；
 *  - visible：有问题待答 / 代理在等（awaitingClarify）/ 服务端待答标记（clarifyPending）/ 分析中
 *    任一即展开；终态（done/cancelled）一律收起。
 */
export function clarifyPanelState(
  status: IssueStatus,
  events: IssueEvent[],
  flags: { awaitingClarify?: boolean; clarifyPending?: boolean } = {},
  now: number = Date.now(),
): ClarifyPanelState {
  if (status === 'done' || status === 'cancelled') {
    return { visible: false, questions: [], text: '', analyzing: false };
  }
  let qEv: IssueEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'clarify_questions') {
      qEv = events[i]!;
      break;
    }
  }
  let questions: string[] = [];
  let text = '';
  if (qEv) {
    const answered = events.some(
      (e) => (e.kind === 'clarified' || e.kind === 'clarify_timeout') && e.id > qEv!.id,
    );
    if (!answered) {
      const d = tryJson<{ questions?: string[]; text?: string }>(qEv.dataJson);
      questions = d?.questions ?? [];
      text = (d?.text ?? '').trim();
    }
  }
  const analyzing = clarifyAnalyzing(events, now);
  return {
    visible:
      questions.length > 0 ||
      text.length > 0 ||
      !!flags.awaitingClarify ||
      !!flags.clarifyPending ||
      analyzing,
    questions,
    text,
    analyzing,
  };
}

export function clarifyAnalyzing(
  events: IssueEvent[],
  now: number = Date.now(),
  maxAgeMs: number = CLARIFY_ANALYZING_MAX_AGE_MS,
): boolean {
  let started: IssueEvent | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'clarify_started') {
      started = events[i]!;
      break;
    }
  }
  if (!started) return false;
  if (now - started.ts > maxAgeMs) return false;
  return !events.some((e) => {
    if (e.id <= started!.id) return false;
    if (e.kind === 'clarify_done' || e.kind === 'clarify_discarded') return true;
    if (e.kind !== 'error') return false;
    try {
      return e.dataJson !== null && (JSON.parse(e.dataJson) as { where?: string }).where === 'clarify';
    } catch {
      return false;
    }
  });
}

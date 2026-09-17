/**
 * issues/machine —— Issue 生命周期状态机（spec §5），纯函数、无副作用。
 *
 * pending ─► clarifying ─► planning ─► plan_review ─► implementing
 *                                        │拒绝→planning     │
 *    done ◄─ merging ◄─ merge_review ◄─ testing ◄──────────┘
 *                          │拒绝→implementing
 * 任意非终态可 → blocked / cancelled；blocked 可按受阻来源阶段人工恢复。
 * testing 失败回退 implementing，失败次数超上限（3）→ blocked。
 *
 * 终态两态并不对称（#93）：
 * - `cancelled` 是**可复活的终态**：人工改完需求后 reopen→pending 重新排队（取消往往意味着
 *   「这版需求不对，改完再来」，逼用户重开一条会丢掉 id、事件历史、模块绑定和截图）；
 * - `done` 仅保留受审计的 `reopen` 出口，用于将历史误标完成项退回队列。
 */
import type { IssueState } from '../core/types';

export type { IssueState };

export const ISSUE_STATES: readonly IssueState[] = [
  'pending', 'clarifying', 'planning', 'plan_review', 'implementing',
  'testing', 'merge_review', 'merging', 'done', 'blocked', 'paused', 'cancelled',
];

export type IssueMachineEvent =
  | 'start_clarifying'  // pending → clarifying（存量兼容：v2 澄清已前置到创建时，引擎不再进入）
  | 'start_direct'
  | 'request_plan'
  | 'skip_clarifying'   // pending → planning（开跑一律直进）
  | 'clarified'         // clarifying → planning（答案已并入 body；存量兼容路径）
  | 'plan_ready'        // planning → plan_review（SUBTASKS 解析成功，进卡点①）
  | 'plan_approved'     // plan_review → implementing
  | 'plan_rejected'     // plan_review → planning（带意见重排）
  | 'impl_done'         // implementing → testing（全部子任务 STAGE_DONE）
  | 'tests_passed'      // testing → merge_review（进卡点②）
  | 'work_remaining'
  | 'tests_failed'      // testing → implementing；失败次数 > 上限 → blocked
  | 'review_approved'   // merge_review → merging
  | 'review_rejected'   // merge_review → implementing（带 review 意见）
  | 'merged'            // merging → done
  | 'merge_conflict'    // merging → blocked（交人工）
  | 'pause'
  | 'block'             // 任意非终态 → blocked
  | 'cancel'            // 任意非终态 → cancelled
  | 'unblock'           // blocked → 受阻来源阶段（缺少有效来源时经 pending 安全回 planning）
  | 'reopen';           // cancelled/done → pending（人工复活或纠正误标）

/** testing 失败自动回退的次数上限；累计失败超过它 → blocked */
export const MAX_TEST_FAILURES = 3;

export const TERMINAL_STATES: readonly IssueState[] = ['done', 'cancelled'];

export function isTerminal(state: IssueState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface TransitionContext {
  /** tests_failed 专用：累计失败次数（含本次）。缺省按 1 处理。 */
  failCount?: number;
  /** unblock 专用：进入 blocked 前持久化的可恢复阶段。 */
  resumeState?: IssueState;
}

const RESUMABLE_STATES: readonly IssueState[] = [
  'planning', 'plan_review', 'implementing', 'testing', 'merge_review', 'merging',
];

export function isResumableState(state: unknown): state is IssueState {
  return typeof state === 'string' && RESUMABLE_STATES.includes(state as IssueState);
}

/** 普通事件的静态转换表（特殊事件 block/cancel/tests_failed 在 transition 里单独处理） */
const TABLE: Readonly<Record<IssueState, Partial<Record<IssueMachineEvent, IssueState>>>> = {
  pending: { start_clarifying: 'clarifying', skip_clarifying: 'planning', start_direct: 'implementing' },
  clarifying: { clarified: 'planning' },
  planning: { plan_ready: 'plan_review' },
  plan_review: { plan_approved: 'implementing', plan_rejected: 'planning' },
  implementing: { impl_done: 'testing', request_plan: 'planning' },
  testing: { tests_passed: 'merge_review', work_remaining: 'implementing' },
  merge_review: { review_approved: 'merging', review_rejected: 'implementing' },
  merging: { merged: 'done', merge_conflict: 'blocked' },
  blocked: {},
  paused: {},
  done: { reopen: 'pending' }, // 仅允许受审计的人工纠正
  cancelled: { reopen: 'pending' }, // #93：唯一出口，人工复活
};

/**
 * 纯转换函数：给定当前状态与事件，返回下一状态；非法转换返回 null。
 *
 * - `block`：任意非终态（且非 blocked 本身）→ blocked
 * - `cancel`：任意非终态 → cancelled（blocked 也可取消）
 * - `tests_failed`：仅 testing 合法；ctx.failCount ≤ MAX_TEST_FAILURES → implementing，
 *   超限 → blocked
 * - `reopen`：走静态表，只有 cancelled/done 命中。注意 block/cancel
 *   的终态拦截在前面就 return 了，不会误伤 reopen。
 */
export function transition(
  state: IssueState,
  event: IssueMachineEvent,
  ctx?: TransitionContext,
): IssueState | null {
  if (event === 'pause') return isTerminal(state) || state === 'paused' ? null : 'paused';
  if (event === 'block') {
    return isTerminal(state) || state === 'blocked' ? null : 'blocked';
  }
  if (event === 'cancel') {
    return isTerminal(state) ? null : 'cancelled';
  }
  if (event === 'tests_failed') {
    if (state !== 'testing') return null;
    const failCount = ctx?.failCount ?? 1;
    return failCount > MAX_TEST_FAILURES ? 'paused' : 'implementing';
  }
  if (event === 'unblock') {
    if (state !== 'blocked' && state !== 'paused') return null;
    return isResumableState(ctx?.resumeState) ? ctx.resumeState : 'pending';
  }
  return TABLE[state][event] ?? null;
}

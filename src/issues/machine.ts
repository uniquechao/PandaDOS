/**
 * issues/machine —— Issue 生命周期状态机（spec §5），纯函数、无副作用。
 *
 * pending ─► clarifying ─► planning ─► plan_review ─► implementing
 *                                        │拒绝→planning     │
 *    done ◄─ merging ◄─ merge_review ◄─ testing ◄──────────┘
 *                          │拒绝→implementing
 * 任意非终态可 → blocked / cancelled；blocked 可人工重启（unblock→pending）。
 * testing 失败回退 implementing，失败次数超上限（3）→ blocked。
 *
 * 终态两态并不对称（#93）：
 * - `cancelled` 是**可复活的终态**：人工改完需求后 reopen→pending 重新排队（取消往往意味着
 *   「这版需求不对，改完再来」，逼用户重开一条会丢掉 id、事件历史、模块绑定和截图）；
 * - `done` 是**真终态**，任何事件都不接。已完成的还想再跑属于另一件事（要不要允许、
 *   重跑要不要另起一条），没想清楚之前不开这个口子。
 */
import type { IssueState } from '../core/types';

export type { IssueState };

export const ISSUE_STATES: readonly IssueState[] = [
  'pending', 'clarifying', 'planning', 'plan_review', 'implementing',
  'testing', 'merge_review', 'merging', 'done', 'blocked', 'cancelled',
];

export type IssueMachineEvent =
  | 'start_clarifying'  // pending → clarifying（存量兼容：v2 澄清已前置到创建时，引擎不再进入）
  | 'skip_clarifying'   // pending → planning（开跑一律直进）
  | 'clarified'         // clarifying → planning（答案已并入 body；存量兼容路径）
  | 'plan_ready'        // planning → plan_review（SUBTASKS 解析成功，进卡点①）
  | 'plan_approved'     // plan_review → implementing
  | 'plan_rejected'     // plan_review → planning（带意见重排）
  | 'impl_done'         // implementing → testing（全部子任务 STAGE_DONE）
  | 'tests_passed'      // testing → merge_review（进卡点②）
  | 'tests_failed'      // testing → implementing；失败次数 > 上限 → blocked
  | 'review_approved'   // merge_review → merging
  | 'review_rejected'   // merge_review → implementing（带 review 意见）
  | 'merged'            // merging → done
  | 'merge_conflict'    // merging → blocked（交人工）
  | 'block'             // 任意非终态 → blocked
  | 'cancel'            // 任意非终态 → cancelled
  | 'unblock'           // blocked → pending（人工重启，重新入队）
  | 'reopen';           // cancelled → pending（#93 人工复活：改完需求重新排队；done 不接）

/** testing 失败自动回退的次数上限；累计失败超过它 → blocked */
export const MAX_TEST_FAILURES = 3;

export const TERMINAL_STATES: readonly IssueState[] = ['done', 'cancelled'];

export function isTerminal(state: IssueState): boolean {
  return TERMINAL_STATES.includes(state);
}

export interface TransitionContext {
  /** tests_failed 专用：累计失败次数（含本次）。缺省按 1 处理。 */
  failCount?: number;
}

/** 普通事件的静态转换表（特殊事件 block/cancel/tests_failed 在 transition 里单独处理） */
const TABLE: Readonly<Record<IssueState, Partial<Record<IssueMachineEvent, IssueState>>>> = {
  pending: { start_clarifying: 'clarifying', skip_clarifying: 'planning' },
  clarifying: { clarified: 'planning' },
  planning: { plan_ready: 'plan_review' },
  plan_review: { plan_approved: 'implementing', plan_rejected: 'planning' },
  implementing: { impl_done: 'testing' },
  testing: { tests_passed: 'merge_review' },
  merge_review: { review_approved: 'merging', review_rejected: 'implementing' },
  merging: { merged: 'done', merge_conflict: 'blocked' },
  blocked: { unblock: 'pending' },
  done: {}, // 真终态：一个事件都不接
  cancelled: { reopen: 'pending' }, // #93：唯一出口，人工复活
};

/**
 * 纯转换函数：给定当前状态与事件，返回下一状态；非法转换返回 null。
 *
 * - `block`：任意非终态（且非 blocked 本身）→ blocked
 * - `cancel`：任意非终态 → cancelled（blocked 也可取消）
 * - `tests_failed`：仅 testing 合法；ctx.failCount ≤ MAX_TEST_FAILURES → implementing，
 *   超限 → blocked
 * - `reopen`：走静态表，因此只有 cancelled 命中；done 与其余状态一律 null。注意 block/cancel
 *   的终态拦截在前面就 return 了，不会误伤 reopen。
 */
export function transition(
  state: IssueState,
  event: IssueMachineEvent,
  ctx?: TransitionContext,
): IssueState | null {
  if (event === 'block') {
    return isTerminal(state) || state === 'blocked' ? null : 'blocked';
  }
  if (event === 'cancel') {
    return isTerminal(state) ? null : 'cancelled';
  }
  if (event === 'tests_failed') {
    if (state !== 'testing') return null;
    const failCount = ctx?.failCount ?? 1;
    return failCount > MAX_TEST_FAILURES ? 'blocked' : 'implementing';
  }
  return TABLE[state][event] ?? null;
}

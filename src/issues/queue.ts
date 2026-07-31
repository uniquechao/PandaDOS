/**
 * issues/queue —— 每项目单 active 的队列调度（v1 scheduleNext 平移，键换 project）。
 * - 忙判定：项目内任一 issue 处于「驱动中」状态（clarifying→merging 全链）即忙；
 * - 挑选：pending 中 同模块优先 → FIFO（created_ts 最早）；
 * - done/blocked/cancelled 后由引擎调用接力。
 *
 * 与 v1 差异（有意）：design 也参与自动挑选——v2 的 clarifying/planning 由引擎自动驱动，
 * 不再像 v1 那样必须人工发起对齐（评审 M9 的 aligning 手动起点已被状态机吸收）。
 */
import type { IssueState } from '../core/types';

/** 「驱动中」状态：占用项目唯一 cc 进程 / 流水线的状态（卡点等待也算占用，防并行分支流打架）；
 *  clarifying 仅存量兼容（v2 澄清前置到创建时、pending 期间后台分析，引擎不再进入该态） */
export const BUSY_STATES: readonly IssueState[] = [
  'clarifying',
  'planning',
  'plan_review',
  'implementing',
  'testing',
  'merge_review',
  'merging',
];

export interface QueueIssue {
  id: number;
  status: IssueState;
  module: string;
  /** 正式模块 id；缺省/null = 旧库或旧测试（此时模块身份回落到 module 文本）。 */
  moduleId?: number | null;
  createdTs: number;
  /** 置顶时刻（ms）；null/undefined = 未置顶。置顶只影响 pending 排队顺序（见 pickNext）。 */
  pinnedTs?: number | null;
}

/**
 * 调度用的模块身份键：**以 module_id 为准**，缺省才回落到 module 文本。
 *
 * 为什么不能直接用 module 文本：035 回填只写了 issues.module_id，旧文本留在 issues.module 里，
 * 于是同一模块出现两种文本（被 FIFO 打散），而同名不同代理的两个模块共用一种文本（被并成一桶
 * 连着跑）。文本列是给人看的冗余，模块身份只有 module_id 说得准。
 */
export function moduleKeyOf(issue: Pick<QueueIssue, 'module' | 'moduleId'>): string {
  return issue.moduleId != null ? `#${issue.moduleId}` : issue.module;
}

/** 项目是否忙（有 issue 在驱动中） */
export function isBusy(issues: QueueIssue[]): boolean {
  return issues.some((i) => BUSY_STATES.includes(i.status));
}

/** 按当前优先模块从 pending 候选里挑一条，不做项目忙判定、不修改输入。排序键（依次）：
 *   0. 置顶优先（pinnedTs 非空）——用户手动置顶的 pending 压过一切（模块聚合/FIFO/preferModuleKey）；
 *      多个置顶之间按置顶时刻晚→早（后置顶的排最前，即「置顶=移到队首」，重复置顶可再顶上去）；
 *   1. preferModuleKey 命中（刚完成/新建的模块优先接力，保证同模块连着跑）——传进来的必须是
 *      moduleKeyOf() 的结果，不是 issues.module 文本；
 *   2. 模块排位 = 该模块最早 pending 任务的 createdTs（模块之间不交错——
 *      一个模块的所有任务跑完再换下一个模块，而非纯 FIFO 把模块打散）；
 *   3. 模块键（同排位稳定序）；
 *   4. 模块内 FIFO（createdTs → id）。
 */
function pickPendingCandidate<T extends QueueIssue>(cands: readonly T[], preferModuleKey?: string): T | undefined {
  if (!cands.length) return undefined;
  const moduleRank = new Map<string, number>();
  for (const i of cands) {
    const key = moduleKeyOf(i);
    const cur = moduleRank.get(key);
    if (cur === undefined || i.createdTs < cur) moduleRank.set(key, i.createdTs);
  }
  return [...cands].sort((a, b) => {
    // 置顶层：先按「是否置顶」分层，再按置顶时刻晚→早（后置顶的在前）
    const apin = a.pinnedTs ?? 0;
    const bpin = b.pinnedTs ?? 0;
    if ((apin > 0) !== (bpin > 0)) return apin > 0 ? -1 : 1;
    if (apin > 0 && bpin > 0) return bpin - apin || a.id - b.id;
    // 非置顶层：preferModuleKey → 模块排位 → 模块键（稳定序）→ 组内 FIFO
    const ak = moduleKeyOf(a);
    const bk = moduleKeyOf(b);
    const ap = preferModuleKey && ak === preferModuleKey ? 0 : 1;
    const bp = preferModuleKey && bk === preferModuleKey ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const ar = moduleRank.get(ak)!;
    const br = moduleRank.get(bk)!;
    if (ar !== br) return ar - br;
    if (ak !== bk) return ak < bk ? -1 : 1;
    return a.createdTs - b.createdTs || a.id - b.id;
  })[0];
}

/**
 * 返回完整 pending 执行顺序：每挑出一条，就用它的模块键作为下一轮 preferModuleKey，
 * 等价于引擎逐条收尾接力的实际选择过程。只复制/删除内部候选，不修改输入数组。
 */
export function orderPending<T extends QueueIssue>(issues: readonly T[], preferModuleKey?: string): T[] {
  const remaining = issues.filter((i) => i.status === 'pending');
  const ordered: T[] = [];
  let preferred = preferModuleKey;
  while (remaining.length > 0) {
    const next = pickPendingCandidate(remaining, preferred);
    if (!next) break;
    ordered.push(next);
    remaining.splice(remaining.indexOf(next), 1);
    preferred = moduleKeyOf(next);
  }
  return ordered;
}

/** 挑下一条要跑的 issue：项目忙或无候选时返回 undefined，否则取完整队列首项。 */
export function pickNext<T extends QueueIssue>(issues: T[], preferModuleKey?: string): T | undefined {
  if (isBusy(issues)) return undefined;
  return orderPending(issues, preferModuleKey)[0];
}

/**
 * 把 pending issue 按模块分组（模块聚合调度/合并的取数口径）：
 * 返回 [模块键（moduleKeyOf）, 该模块 pending 列表（FIFO）] 数组，模块之间按各自最早任务排序。
 */
export function groupPendingByModule<T extends QueueIssue>(issues: T[]): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const i of issues) {
    if (i.status !== 'pending') continue;
    const key = moduleKeyOf(i);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
  }
  const out = [...groups.entries()];
  for (const [, list] of out) list.sort((a, b) => a.createdTs - b.createdTs || a.id - b.id);
  out.sort((a, b) => (a[1][0]!.createdTs - b[1][0]!.createdTs) || (a[0] < b[0] ? -1 : 1));
  return out;
}

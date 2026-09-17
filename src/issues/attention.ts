/**
 * issues/attention —— 「这条 issue 到底在等什么」的统一派生（#275 / I-07）。
 *
 * 病灶：`blocked` 一直被当成所有等待原因的统一出口。本周 41 次进入 blocked 里有 27 次
 * 不该是 blocked（12 次配置故障、15 次「本地门禁全过、只差人工部署/真机验收」）。
 * 这不只是显示语义——每次错误的 blocked 都换来一轮重新注入，直接对应真金白银。
 *
 * 所以按**原因**分层，而不是按状态。取值与判定顺序：
 *
 *   clarify  等你回答澄清问题（创建时或执行中）
 *   choice   等你在 CLI 弹窗里做选择（升级人工未处理 / 菜单滞留）
 *   review   卡点等你审批（plan_review / merge_review）
 *   stalled  自动手段用尽，等你看一眼：#273 的催办/判定到顶、#274 的止损暂停
 *   verify   本地门禁全过，只差人工部署/真机/验收
 *   blocked  真故障，需要修
 *   none     不用你管
 *
 * **顺序即优先级，不许调换**：都是「等你」，但一条 issue 同时满足多项时要报最具体、
 * 最可操作的那个。clarify/choice 是你此刻能一句话解开的，排最前；blocked 兜底排最后——
 * 它信息量最低（「出事了」），凡是能说得更准的都该盖过它。
 *
 * 纯函数：入参是普通数据，不碰 store / driver / 时钟。`stalled` 与 `verify` 都只认
 * **锚点之后**的证据（锚点 = 最近一次人工介入），否则一条被解开过的 issue 会永远挂着旧标记。
 */
import type { IssueState } from '../core/types';

export type AttentionKind =
  | 'none'
  | 'clarify'
  | 'choice'
  | 'review'
  | 'stalled'
  | 'verify'
  | 'blocked';

/** 事件的最小形状（调用方直接把 issue_events 行喂进来） */
export interface AttentionEvent {
  id: number;
  kind: string;
  dataJson: string | null;
}

export interface AttentionInput {
  status: IssueState;
  events: readonly AttentionEvent[];
  /** 澄清问题未答（口径同 store.clarifyPendingOf） */
  clarifyPending: boolean;
  /** CLI 弹窗在等人工选择（升级卡未处理 / 菜单滞留；内存态，只能外部传入） */
  waitingInput: boolean;
  /**
   * 受阻但**已排队等待自动恢复**（#283）：用户点过「继续运行」，只是项目当时忙着，
   * 接力会在空闲时自动把它拉回来。缺省 false（老调用方行为不变）。
   */
  unblockQueued?: boolean;
}

/**
 * 「等你部署/真机/人工验收」的本地判据关键词（#275 决策 2B：不动哨兵协议，只用已有信号）。
 *
 * 刻意写在一处、也刻意不追求穷尽：命中就报 `verify`（更准的说法），没命中就退回 `blocked`
 * （更保守的说法）。误判方向是安全的——把「等验收」说成「受阻」只是不够准，
 * 反过来把真故障说成「等验收」才会让人不去修。
 */
const VERIFY_HINTS = [
  '部署', '上线', '发布', '重启', '真机', '设备', '验收', '人工确认', '人工操作', '手动',
  'deploy', 'release', 'restart', 'on-device', 'hardware', 'manual', 'sign-off',
];

function parse(dataJson: string | null): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const v = JSON.parse(dataJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 最近一次人工介入的事件 id：之后的证据才算数（口径同引擎的 attentionAnchor） */
function humanTouchAnchor(events: readonly AttentionEvent[]): number {
  let anchor = 0;
  for (const e of events) {
    if (e.kind === 'reopened' || e.kind === 'unblock_guidance' || e.kind === 'clarified') {
      if (e.id > anchor) anchor = e.id;
    }
  }
  return anchor;
}

/** 最近一次进入 blocked 的 transition（用来看它是不是止损打的、以及 note 说了什么） */
function lastBlockedTransition(
  events: readonly AttentionEvent[],
): { note: string; stopLoss: boolean } | null {
  let latest: AttentionEvent | null = null;
  for (const e of events) {
    if (e.kind !== 'transition') continue;
    const d = parse(e.dataJson);
    if (d.to !== 'blocked') continue;
    if (!latest || e.id > latest.id) latest = e;
  }
  if (!latest) return null;
  const d = parse(latest.dataJson);
  return {
    note: typeof d.note === 'string' ? d.note : '',
    stopLoss: d.stopLoss === true,
  };
}

/** 「本地门禁其实是过了的」：有过成功的自动提交/推送，且锚点之后没有测试失败 */
function localGatesPassed(events: readonly AttentionEvent[], anchor: number): boolean {
  let delivered = false;
  for (const e of events) {
    if (e.id <= anchor) continue;
    if (e.kind === 'tests_failed') return false;
    if (e.kind === 'auto_commit' || e.kind === 'auto_push' || e.kind === 'push_skipped') delivered = true;
  }
  return delivered;
}

export function looksLikeVerifyNote(note: string): boolean {
  const t = note.toLowerCase();
  return VERIFY_HINTS.some((k) => t.includes(k.toLowerCase()));
}

/** 锚点之后是否有「自动手段用尽」的证据（#273 催办/判定到顶） */
function retryExhausted(events: readonly AttentionEvent[], anchor: number): boolean {
  return events.some(
    (e) => e.id > anchor && (e.kind === 'nudge_exhausted' || e.kind === 'judge_exhausted'),
  );
}

const REVIEW_STATES: readonly IssueState[] = ['plan_review', 'merge_review'];

/**
 * 派生这条 issue 在等什么。顺序即优先级，见文件头。
 */
export function attentionKindOf(input: AttentionInput): AttentionKind {
  const { status, events } = input;
  if (status === 'done' || status === 'cancelled') return 'none';
  if (status === 'paused') return input.unblockQueued ? 'none' : 'stalled';

  if (input.clarifyPending) return 'clarify';
  if (input.waitingInput) return 'choice';
  if (REVIEW_STATES.includes(status)) return 'review';

  // 已排队待恢复：用户该做的已经做了，系统会自动接手——再亮一个「等你处理」纯属打扰。
  // 复用 none 而不是新增取值：这条 issue 此刻确实不需要人做任何事。
  if (status === 'blocked' && input.unblockQueued) return 'none';

  const anchor = humanTouchAnchor(events);
  const blockedInfo = status === 'blocked' ? lastBlockedTransition(events) : null;

  // stalled：#274 的止损暂停（blocked 但带 stopLoss 标记）与 #273 的自动重试到顶
  // 用**同一个取值**承载——两者对用户是同一件事「自动手段用尽了，你来看一眼」，
  // 造两个近义状态只会让人多记一个词。
  if (blockedInfo?.stopLoss) return 'stalled';
  if (retryExhausted(events, anchor)) return 'stalled';

  if (status === 'blocked') {
    // verify：本地门禁全过、只差人工部署/真机/验收。这是 27 次错误 blocked 里的一大半。
    if (blockedInfo && looksLikeVerifyNote(blockedInfo.note) && localGatesPassed(events, anchor)) {
      return 'verify';
    }
    // 找不到/读不出那条 transition（事件被裁剪、数据损坏）也必须报 blocked：
    // 状态摆在那里，派生失败时宁可说得泛一点，也不能把一条受阻的 issue 藏起来。
    return 'blocked';
  }
  return 'none';
}

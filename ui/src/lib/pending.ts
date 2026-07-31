/**
 * lib/pending —— 「我刚发出去的消息」本地乐观气泡（issue #116，纯函数便于单测）。
 *
 * 为什么要有：注入走 tmux sendKeys，消息要等代理把它写进 jsonl 才会从服务端回流；代理正忙时
 * 它先进 CC 的输入队列，回流可能是几分钟后。这段空窗期里用户在对话面板看不到自己发过什么
 * （本 issue 现场），只能去原生终端找。所以点发送即本地插一条带送达状态的气泡，真消息回流再撤。
 *
 * 状态机：sending →（服务端 ack）sent →（同文消息回流）撤掉
 *         sending →（带 id 的 err）failed（**留着不撤**，让用户看得见这条没发出去）
 * 「正在重启并自动补发」的 err 故意不带 id（见 web/ws/chat.ts 回执契约），气泡保持 sending。
 */
import type { ChatMessage } from './types';

export type PendingState = 'sending' | 'sent' | 'failed';

export interface PendingMsg {
  /** 本地生成的一次性 id，随 text 帧发出、随 ack/err 回来 */
  id: string;
  /** 用户正文（不含附图提示；附图只记张数，不留 blob 预览——发送后本地 URL 已 revoke） */
  text: string;
  imgCount: number;
  /**
   * 创建时对话里最大的 off。只有比它更靠后的回流消息才可能是这一条——
   * 否则历史里一句一模一样的旧话就会把新气泡误撤掉。
   */
  sinceOff: number;
  state: PendingState;
}

/** 当前对话已加载消息的最大 off（无 off 的老数据不参与，返回 -1 表示「谁都算更新」） */
export function maxOffOf(msgs: ChatMessage[]): number {
  let max = -1;
  for (const m of msgs) if (typeof m.off === 'number' && m.off > max) max = m.off;
  return max;
}

/** 空白归一：sendKeys 会把换行压成空格，回流文本与原文只在空白上不同，比对前统一 */
export function normText(s: string | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

/** 更新某条气泡的状态；id 不在表里（已被回流撤掉）时原样返回，不无谓触发重渲染 */
export function markPending(list: PendingMsg[], id: string, state: PendingState): PendingMsg[] {
  if (!list.some((p) => p.id === id)) return list;
  return list.map((p) => (p.id === id ? { ...p, state } : p));
}

/** 回流的这条消息是不是本地这条气泡（正文归一后相同；纯图消息比张数） */
function bodyMatches(m: ChatMessage, p: PendingMsg): boolean {
  const body = normText(m.text);
  if (p.text.trim()) return body === normText(p.text);
  return body === '' && p.imgCount > 0 && (m.images?.length ?? 0) === p.imgCount;
}

/**
 * 真消息回流即撤掉对应的本地气泡（否则同一句话一次显示两遍）。
 * 一条回流消息最多认领一条气泡（连发两句一样的话时不会被一次性全撤）；无变化返回原引用。
 */
export function prunePending(list: PendingMsg[], msgs: ChatMessage[]): PendingMsg[] {
  if (!list.length) return list;
  const rest = [...list];
  for (const m of msgs) {
    if (m.role !== 'user' || !rest.length) continue;
    const off = m.off ?? -1;
    const i = rest.findIndex((p) => off > p.sinceOff && bodyMatches(m, p));
    if (i >= 0) rest.splice(i, 1);
  }
  return rest.length === list.length ? list : rest;
}

/** 气泡上的状态文案（对应 .rs-msg-ack） */
export const PENDING_HINT: Record<PendingState, string> = {
  sending: '⏳ 发送中…',
  sent: '✓ 已送达',
  failed: '⚠ 没发出去，请重发',
};

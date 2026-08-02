/**
 * notify/cards —— 飞书交互卡片构造（v1 src/cards.ts 三卡平移 + 新增卡点确认卡，spec §8）。
 *
 * 平移说明（对照 v1 逐条）：
 * - 三卡（进度/回复/选择）结构原样保留：HEADER_COLOR 五态色映射、STATUS_EMOJI、
 *   选择卡「最多 6 按钮 / 按钮文案截 18 字 / 首项 primary」规则、value 协议
 *   `{forge:"selection",requestId,optionIndex}`（评审 §2A：收发两端配套资产）。
 * - 进度卡去掉 v1 的 sessionNo/`#N 回复`提示（评审 B 表：序号寻址已判弃用——
 *   会话增减即错位），needsReply 提示改为纯文案。
 * - 新增卡点确认卡 buildGateCard：计划摘要或 diff 摘要 + approve/reject 按钮，
 *   value 带一次性 requestId（`{forge:"gate",requestId,action}`，与 selection 同
 *   namespace 不同 kind，复用同一条 WS 回调分发）。
 * - 卡片渲染是纯函数，不碰 DB/网络——一次性语义在 GateRequestStore（router.ts），
 *   点击校验在 FeishuChannel.handleCard（feishu.ts）。
 */
import type { GateKind } from '../core/types';
import type { I18nApi } from '../../shared/i18n/formatter';

// ---------- 事件状态（v1 cards.ts:3-18 原样） ----------

export type EventStatus = 'working' | 'milestone' | 'waiting' | 'error' | 'done';

const HEADER_COLOR: Record<EventStatus, string> = {
  working: 'blue',
  milestone: 'turquoise',
  waiting: 'orange',
  error: 'red',
  done: 'green',
};
const STATUS_EMOJI: Record<EventStatus, string> = {
  working: '🛠️',
  milestone: '📌',
  waiting: '💬',
  error: '❗',
  done: '✅',
};

export function isEventStatus(s: unknown): s is EventStatus {
  return typeof s === 'string' && s in HEADER_COLOR;
}

function nowHHMM(i18n: I18nApi): string {
  return i18n.formatTime(Date.now());
}

// ---------- 三卡（v1 平移） ----------

/**
 * 进度/状态卡：彩色标题(标题+状态 emoji) + 正文 + 脚注(时间·标题)。
 * needsReply=true 时高亮「它在等你」（v1 的 `#N` 序号回复提示已弃用）。
 */
export function buildEventCard(
  i18n: I18nApi,
  title: string,
  status: EventStatus,
  headline: string,
  needsReply = false,
): unknown {
  const elements: unknown[] = [{ tag: 'div', text: { tag: 'lark_md', content: headline } }];
  if (needsReply) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: i18n.t('notify.waitingReply') },
    });
  }
  elements.push({
    tag: 'note',
    elements: [{ tag: 'plain_text', content: `🕘 ${nowHHMM(i18n)} · ${title}` }],
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      template: HEADER_COLOR[status],
      title: { tag: 'plain_text', content: `${STATUS_EMOJI[status]} ${title}` },
    },
    elements,
  };
}

/** 问答回复卡：lark_md 正文（PM 输出轻量排版），无头。 */
export function buildReplyCard(markdown: string): unknown {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdown } }],
  };
}

/**
 * 选择卡：每个选项一个按钮。最多 6 按钮（第 7+ 项只出现在 summary 文本里）、
 * 文案截 18 字、首项 primary；value 带 requestId + optionIndex（v1 协议原样）。
 */
export function buildSelectionCard(
  i18n: I18nApi,
  requestId: string,
  title: string,
  summary: string,
  options: string[],
): unknown {
  const buttons = options.slice(0, 6).map((opt, i) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: `${i + 1}. ${opt.length > 18 ? opt.slice(0, 18) + '…' : opt}` },
    type: i === 0 ? 'primary' : 'default',
    value: { forge: 'selection', requestId, optionIndex: i },
  }));
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: i18n.t('notify.selectionTitle', { title }) } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: summary } },
      { tag: 'action', actions: buttons },
    ],
  };
}

// ---------- 卡点确认卡（v2 新增，spec §8「新增卡点确认卡」） ----------

/** gate 摘要渲染的字符预算（飞书卡片放不下长 diff；完整内容看网页） */
export const GATE_SUMMARY_MAX = 2400;
const PLAN_ITEM_MAX = 80;
const PLAN_ITEMS_MAX = 15;

/**
 * 从 gate payload 渲染人可读摘要（lark_md）：
 * - plan：子任务编号清单（≤15 条、每条截 80 字）+ 实现模式；
 * - merge_review：分支→基线 + `--stat` 变更文件清单（截断）+ 完整 diff 看网页提示。
 * payload 解析失败时兜底为「详情见网页」——卡片是提醒+快捷通道，不是唯一真相源。
 */
export function gateSummary(kind: GateKind, payloadJson: string | null, i18n: I18nApi): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = payloadJson ? (JSON.parse(payloadJson) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }

  let body: string;
  if (kind === 'plan') {
    const subtasks = Array.isArray(payload.subtasks)
      ? (payload.subtasks as unknown[]).filter((s): s is string => typeof s === 'string')
      : [];
    const mode = payload.implMode === 'team' ? i18n.t('notify.modeTeam') : i18n.t('notify.modeSeq');
    if (subtasks.length === 0) {
      body = i18n.t('notify.planEmpty');
    } else {
      const lines = subtasks
        .slice(0, PLAN_ITEMS_MAX)
        .map((s, i) => `${i + 1}. ${s.length > PLAN_ITEM_MAX ? s.slice(0, PLAN_ITEM_MAX) + '…' : s}`);
      if (subtasks.length > PLAN_ITEMS_MAX) lines.push(i18n.t('notify.planMore', { count: subtasks.length }));
      body = `${i18n.t('notify.planHeading', { count: subtasks.length, mode })}\n${lines.join('\n')}`;
    }
  } else {
    const branch = typeof payload.branch === 'string' ? payload.branch : '?';
    const base = typeof payload.base === 'string' ? payload.base : '?';
    const stat = typeof payload.stat === 'string' ? payload.stat.trim() : '';
    const parts = [`**${i18n.t('notify.branch')}** \`${branch}\` → \`${base}\``];
    if (typeof payload.gitError === 'string' && payload.gitError) {
      parts.push(i18n.t('notify.diffFailed', { error: payload.gitError.slice(0, 200) }));
    }
    if (stat) parts.push('```\n' + stat.slice(0, 1600) + (stat.length > 1600 ? '\n…' : '') + '\n```');
    if (payload.diffTruncated === true) parts.push(i18n.t('notify.diffTruncated'));
    parts.push(i18n.t('notify.fullDiffWeb'));
    body = parts.join('\n');
  }
  return body.length > GATE_SUMMARY_MAX ? body.slice(0, GATE_SUMMARY_MAX) + '…' : body;
}

export interface GateCardArgs {
  /** 一次性 requestId（GateRequestStore.create 产出，消费即失效） */
  requestId: string;
  kind: GateKind;
  issueId: number;
  /** 计划摘要或 diff 摘要（gateSummary 产出，可加抬头） */
  summary: string;
}

/**
 * 卡点确认卡：摘要 + approve/reject 两按钮。
 * 按钮 value = {forge:"gate", requestId, action}——同一 requestId 两个动作，
 * 任一被消费后另一个即失效（防重放的一次性语义在 DB CAS，见 router.ts）。
 * 卡片一键 reject 带默认意见（引擎要求 reject 必附 note），详细意见走网页。
 */
export function buildGateCard(a: GateCardArgs, i18n: I18nApi): unknown {
  const title =
    a.kind === 'plan'
      ? i18n.t('notify.planGateTitle', { id: a.issueId })
      : i18n.t('notify.mergeGateTitle', { id: a.issueId });
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: a.summary } },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: i18n.t('notify.approve') },
            type: 'primary',
            value: { forge: 'gate', requestId: a.requestId, action: 'approve' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: i18n.t('notify.reject') },
            type: 'danger',
            value: { forge: 'gate', requestId: a.requestId, action: 'reject' },
          },
        ],
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `🕘 ${nowHHMM(i18n)} · ${i18n.t('notify.oneTimeFooter')}`,
          },
        ],
      },
    ],
  };
}

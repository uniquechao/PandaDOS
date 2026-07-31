/**
 * lib/approvalLog —— 弹窗自动批复的审计视图（issue #91）。
 *
 * 引擎每次处理弹窗都落 `menu_auto`（自动点了）/ `menu_escalated`（交人工）事件，data 里带
 * `rule` 说明是哪条策略批的。详情页原先只把 events 用来推状态，这些事件从不露面——出了
 * 「谁把这个弹窗点掉的」这种疑问只能去翻 sqlite。这里把它们翻成人话给详情页用。
 *
 * 纯函数、不碰网络：events 详情页本来就已经拉了，不额外请求。
 */
import type { IssueEvent } from './types';

/** rule → 中文名（与 agents/approval-policy 的策略集合一一对应） */
export const APPROVAL_RULE_LABEL: Record<string, string> = {
  recommended: '推荐项',
  local_fallback: '本地兜底',
  trust: '信任弹窗',
  llm: 'AI 分级',
  llm_error: '分级失败',
  multi_select: '多选表单',
};

export interface ApprovalLogRow {
  id: number;
  ts: number;
  /** true = 已自动点掉；false = 已交人工 */
  auto: boolean;
  /** 规则中文名（认不出的 rule 原样显示，别吞掉新规则） */
  ruleLabel: string;
  /** 一句话说明：自动的说选了第几项，交人工的说为什么 */
  detail: string;
  /** 弹窗上下文（截断后的命令/问题），用于回想「是哪个弹窗」 */
  context: string;
}

function parse(dataJson: string | null): Record<string, unknown> {
  if (!dataJson) return {};
  try {
    const v: unknown = JSON.parse(dataJson);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** 首行即可读：上下文常是「Bash command\n<命令>\n<说明>」，取前两行最有信息量 */
function briefContext(context: string): string {
  return context.split('\n').filter(Boolean).slice(0, 2).join(' · ').slice(0, 120);
}

/**
 * 取最近 `limit` 条弹窗审批记录（新的在前）。
 * 只认 menu_auto / menu_escalated——菜单没被处理过的 issue 返回空数组，调用方据此不渲染。
 */
export function toApprovalLog(events: IssueEvent[], limit = 20): ApprovalLogRow[] {
  const rows: ApprovalLogRow[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
    const ev = events[i]!;
    if (ev.kind !== 'menu_auto' && ev.kind !== 'menu_escalated') continue;
    const d = parse(ev.dataJson);
    const auto = ev.kind === 'menu_auto';
    const rule = str(d.rule);
    const reason = str(d.reason);
    const result = str(d.result);
    let detail: string;
    if (auto) {
      const opt = typeof d.option === 'number' ? `选了第 ${d.option + 1} 项` : '已自动选择';
      // result 非 injected 说明菜单在决定期间变了，没真按下去——这种必须看得见
      detail = result && result !== 'injected' ? `${opt}（未生效：${result}）` : opt;
    } else {
      detail = reason || '需人工判断';
    }
    rows.push({
      id: ev.id,
      ts: ev.ts,
      auto,
      ruleLabel: APPROVAL_RULE_LABEL[rule] ?? rule ?? '',
      detail,
      context: briefContext(str(d.context)),
    });
  }
  return rows;
}

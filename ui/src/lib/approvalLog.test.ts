/**
 * lib/approvalLog 测试（issue #91）：menu_auto / menu_escalated → 详情页可读的审批记录。
 * 重点是「推荐项」和「本地兜底」两条新规则必须能被一眼区分出来。
 */
import { describe, expect, test } from 'bun:test';
import { toApprovalLog, APPROVAL_RULE_LABEL } from './approvalLog';
import type { IssueEvent } from './types';

let seq = 0;
function ev(kind: string, data: Record<string, unknown>): IssueEvent {
  seq++;
  return { id: seq, issueId: 7, kind, dataJson: JSON.stringify(data), ts: 1_700_000_000_000 + seq };
}

describe('toApprovalLog', () => {
  test('新规则可区分：推荐项 / 本地兜底 各自显示自己的中文名与选中项', () => {
    const rows = toApprovalLog([
      ev('menu_auto', {
        rule: 'recommended',
        reason: '选项标了推荐，按推荐选',
        option: 0,
        result: 'injected',
        context: 'This session is 5h 36m old\nResume?',
      }),
      ev('menu_auto', {
        rule: 'local_fallback',
        reason: 'LLM 分级不可用，本地规则判为安全操作',
        option: 0,
        result: 'injected',
        context: 'Bash command\nbun test src/agents',
      }),
    ]);
    expect(rows.length).toBe(2);
    // 新的在前
    expect(rows[0]!.ruleLabel).toBe('本地兜底');
    expect(rows[0]!.auto).toBe(true);
    expect(rows[0]!.detail).toBe('选了第 1 项');
    expect(rows[0]!.context).toBe('Bash command · bun test src/agents');
    expect(rows[1]!.ruleLabel).toBe('推荐项');
  });

  test('交人工的记录显示原因，不显示选项', () => {
    const rows = toApprovalLog([
      ev('menu_escalated', {
        rule: 'llm_error',
        reason: 'LLM 分级失败且疑似危险操作，需人工判断',
        cards: 1,
        context: 'Bash command\nrm -rf node_modules',
      }),
    ]);
    expect(rows[0]!.auto).toBe(false);
    expect(rows[0]!.ruleLabel).toBe('分级失败');
    expect(rows[0]!.detail).toBe('LLM 分级失败且疑似危险操作，需人工判断');
  });

  test('自动选了但没注入成功（菜单已变）必须看得见，不能显示成已生效', () => {
    const rows = toApprovalLog([
      ev('menu_auto', { rule: 'recommended', option: 1, result: 'stale', context: 'x' }),
    ]);
    expect(rows[0]!.detail).toBe('选了第 2 项（未生效：stale）');
  });

  test('无关事件被忽略；没有弹窗记录时返回空数组（调用方据此不渲染）', () => {
    expect(toApprovalLog([ev('transition', { to: 'done' }), ev('nudged', {})]).length).toBe(0);
    expect(toApprovalLog([]).length).toBe(0);
  });

  test('脏数据不崩：dataJson 为 null / 非 JSON / 非对象都按空处理', () => {
    const rows = toApprovalLog([
      { id: 1, issueId: 7, kind: 'menu_auto', dataJson: null, ts: 1 },
      { id: 2, issueId: 7, kind: 'menu_auto', dataJson: '不是 JSON', ts: 2 },
      { id: 3, issueId: 7, kind: 'menu_auto', dataJson: '"字符串"', ts: 3 },
    ]);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.detail === '已自动选择')).toBe(true);
    expect(rows.every((r) => r.ruleLabel === '')).toBe(true);
  });

  test('未知 rule 原样显示（新增策略忘了加中文名也不会被吞掉）', () => {
    const rows = toApprovalLog([ev('menu_auto', { rule: 'brand_new_rule', option: 0 })]);
    expect(rows[0]!.ruleLabel).toBe('brand_new_rule');
  });

  test('limit 截断，取最近的若干条', () => {
    const many = Array.from({ length: 30 }, (_, i) => ev('menu_auto', { rule: 'llm', option: i % 3 }));
    const rows = toApprovalLog(many, 5);
    expect(rows.length).toBe(5);
    expect(rows[0]!.id).toBe(many[29]!.id); // 最新的一条在最前
  });

  test('策略集合的每条 rule 都有中文名（新增规则时别忘了这张表）', () => {
    for (const rule of ['multi_select', 'trust', 'recommended', 'llm', 'llm_error', 'local_fallback']) {
      expect(APPROVAL_RULE_LABEL[rule]).toBeTruthy();
    }
  });
});

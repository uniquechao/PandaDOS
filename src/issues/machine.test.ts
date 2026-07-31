import { describe, expect, test } from 'bun:test';
import {
  ISSUE_STATES,
  MAX_TEST_FAILURES,
  transition,
  type IssueMachineEvent,
  type IssueState,
} from './machine';

/** 全事件清单——新增事件时**必须**同步这里，终态穷举用例才不会漏检 */
const ALL_EVENTS: IssueMachineEvent[] = [
  'start_clarifying', 'skip_clarifying', 'clarified', 'plan_ready', 'plan_approved',
  'plan_rejected', 'impl_done', 'tests_passed', 'tests_failed', 'review_approved',
  'review_rejected', 'merged', 'merge_conflict', 'block', 'cancel', 'unblock', 'reopen',
];

describe('issue 状态机：合法转换', () => {
  test('完整敏捷环（含 clarifying）', () => {
    expect(transition('pending', 'start_clarifying')).toBe('clarifying');
    expect(transition('clarifying', 'clarified')).toBe('planning');
    expect(transition('planning', 'plan_ready')).toBe('plan_review');
    expect(transition('plan_review', 'plan_approved')).toBe('implementing');
    expect(transition('implementing', 'impl_done')).toBe('testing');
    expect(transition('testing', 'tests_passed')).toBe('merge_review');
    expect(transition('merge_review', 'review_approved')).toBe('merging');
    expect(transition('merging', 'merged')).toBe('done');
  });

  test('简单 issue 跳过 clarifying', () => {
    expect(transition('pending', 'skip_clarifying')).toBe('planning');
  });

  test('卡点①拒绝 → 回 planning', () => {
    expect(transition('plan_review', 'plan_rejected')).toBe('planning');
  });

  test('卡点②拒绝 → 回 implementing', () => {
    expect(transition('merge_review', 'review_rejected')).toBe('implementing');
  });

  test('merge 冲突 → blocked', () => {
    expect(transition('merging', 'merge_conflict')).toBe('blocked');
  });

  test('blocked 可人工重启回 pending', () => {
    expect(transition('blocked', 'unblock')).toBe('pending');
  });

  test('cancelled 可人工复活回 pending（#93）', () => {
    expect(transition('cancelled', 'reopen')).toBe('pending');
  });

  test('复活后能重新走完整条流程（不是死路）', () => {
    let s: IssueState | null = transition('cancelled', 'reopen');
    expect(s).toBe('pending');
    s = transition(s!, 'skip_clarifying');
    expect(s).toBe('planning');
    s = transition(s!, 'plan_ready');
    expect(s).toBe('plan_review');
    // 复活后仍可再次取消，再次复活
    expect(transition('plan_review', 'cancel')).toBe('cancelled');
    expect(transition('cancelled', 'reopen')).toBe('pending');
  });

  test('任意非终态可 block / cancel', () => {
    const nonTerminal = ISSUE_STATES.filter((s) => s !== 'done' && s !== 'cancelled');
    for (const s of nonTerminal) {
      if (s !== 'blocked') expect(transition(s, 'block')).toBe('blocked');
      expect(transition(s, 'cancel')).toBe('cancelled');
    }
  });
});

describe('issue 状态机：非法转换返回 null', () => {
  test('跨阶段跳跃非法', () => {
    expect(transition('pending', 'plan_approved')).toBeNull();
    expect(transition('planning', 'merged')).toBeNull();
    expect(transition('implementing', 'tests_passed')).toBeNull();
    expect(transition('testing', 'plan_ready')).toBeNull();
  });

  test('done 是真终态：拒绝一切事件（含 reopen）', () => {
    for (const e of ALL_EVENTS) {
      expect(transition('done', e)).toBeNull();
    }
  });

  test('cancelled 只接 reopen，其余事件一律拒绝', () => {
    for (const e of ALL_EVENTS) {
      if (e === 'reopen') continue;
      expect(transition('cancelled', e)).toBeNull();
    }
  });

  test('blocked 不能再 block；非 blocked 不能 unblock', () => {
    expect(transition('blocked', 'block')).toBeNull();
    expect(transition('implementing', 'unblock')).toBeNull();
  });

  test('tests_failed 只在 testing 阶段合法', () => {
    expect(transition('implementing', 'tests_failed')).toBeNull();
    expect(transition('merge_review', 'tests_failed')).toBeNull();
  });
});

describe('issue 状态机：testing 失败回退计数（上限 3）', () => {
  test('失败 1~3 次回 implementing', () => {
    for (let n = 1; n <= MAX_TEST_FAILURES; n++) {
      expect(transition('testing', 'tests_failed', { failCount: n })).toBe('implementing');
    }
  });

  test('第 4 次失败（超限）→ blocked', () => {
    expect(transition('testing', 'tests_failed', { failCount: MAX_TEST_FAILURES + 1 })).toBe('blocked');
    expect(transition('testing', 'tests_failed', { failCount: 99 })).toBe('blocked');
  });

  test('缺省 ctx 按第 1 次失败处理', () => {
    expect(transition('testing', 'tests_failed')).toBe('implementing');
  });

  test('回退后可再次走完 实现→测试 循环', () => {
    let s: IssueState | null = transition('testing', 'tests_failed', { failCount: 2 });
    expect(s).toBe('implementing');
    s = transition(s!, 'impl_done');
    expect(s).toBe('testing');
    s = transition(s!, 'tests_passed');
    expect(s).toBe('merge_review');
  });
});

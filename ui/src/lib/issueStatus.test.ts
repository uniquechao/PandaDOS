import { describe, expect, test } from 'bun:test';
import type { IssueStatus } from './types';
import { DRIVING_STATUSES, isDriving, retryPlan } from './issueStatus';

describe('isDriving', () => {
  test('AI 在跑的四态为真', () => {
    for (const s of ['planning', 'implementing', 'testing', 'merging'] as IssueStatus[]) {
      expect(isDriving(s)).toBe(true);
    }
  });

  test('待办/审阅/受阻/结束态为假', () => {
    for (const s of [
      'pending',
      'clarifying',
      'plan_review',
      'merge_review',
      'done',
      'blocked',
      'cancelled',
    ] as IssueStatus[]) {
      expect(isDriving(s)).toBe(false);
    }
  });

  test('DRIVING_STATUSES 恰为四态', () => {
    expect(DRIVING_STATUSES).toEqual(['planning', 'implementing', 'testing', 'merging']);
  });
});

describe('retryPlan', () => {
  test('blocked → unblock 重跑，始终可用', () => {
    const p = retryPlan('blocked', false);
    expect(p.action).toBe('unblock');
    expect(p.enabled).toBe(true);
    expect(p.label).toBe('Unblock and retry');
  });

  test('驱动中 + 最近异常 → inject 可用', () => {
    const p = retryPlan('implementing', true);
    expect(p.action).toBe('inject');
    expect(p.enabled).toBe(true);
    expect(p.label).toBe('Retry');
  });

  test('驱动中但无失败步骤 → 禁用', () => {
    const p = retryPlan('testing', false);
    expect(p.action).toBe('none');
    expect(p.enabled).toBe(false);
    expect(p.hint).toContain('No failed step');
  });

  test('cancelled → reopen 复活重跑，始终可用（#93）', () => {
    const p = retryPlan('cancelled', false);
    expect(p.action).toBe('reopen');
    expect(p.enabled).toBe(true);
    expect(p.label).toBe('Run again');
    // 提示必须点破「立刻开跑」，否则用户会以为还能先改需求
    expect(p.hint).toContain('queue immediately');
  });

  test('done 是真终态：不给重跑（状态机也不接 reopen）', () => {
    const p = retryPlan('done', true);
    expect(p.action).toBe('none');
    expect(p.enabled).toBe(false);
  });

  test('非驱动非受阻非取消（pending/plan_review…）→ 无、禁用', () => {
    for (const s of ['pending', 'plan_review', 'merge_review'] as IssueStatus[]) {
      const p = retryPlan(s, true);
      expect(p.action).toBe('none');
      expect(p.enabled).toBe(false);
    }
  });
});

import { beforeEach, describe, expect, test } from 'bun:test';
import { enCatalog } from '../../../shared/i18n/catalogs/en';
import { createI18n } from '../../../shared/i18n/formatter';
import { setRuntimeI18n } from '../i18n/runtime';
import type { IssueStatus } from './types';
import type { IssueEvent } from './types';
import { DRIVING_STATUSES, isDriving, pushFailureState, retryPlan } from './issueStatus';

beforeEach(() => {
  setRuntimeI18n(createI18n({ locale: 'en', timeZone: 'UTC', catalog: enCatalog }));
});

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
  test('blocked → unblock 继续运行，始终可用', () => {
    const p = retryPlan('blocked', false);
    expect(p.action).toBe('unblock');
    expect(p.enabled).toBe(true);
    expect(p.label).toBe('Unblock and continue');
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

  test('cancelled → reopen 重新运行，始终可用（#93）', () => {
    const p = retryPlan('cancelled', false);
    expect(p.action).toBe('reopen');
    expect(p.enabled).toBe(true);
    expect(p.label).toBe('Run again');
    // 提示必须点破「立刻开跑」，否则用户会以为还能先改需求
    expect(p.hint).toContain('queue immediately');
  });

  test('done 是真终态：不给重新运行（状态机也不接 reopen）', () => {
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

describe('pushFailureState（#272 / B-02）', () => {
  let seq = 0;
  const ev = (kind: string, data?: Record<string, unknown>): IssueEvent => ({
    id: ++seq,
    issueId: 1,
    kind,
    dataJson: data ? JSON.stringify(data) : null,
    ts: 1_700_000_000_000 + seq,
  });
  const failed = (detail = 'fatal: 远端拒绝') =>
    ev('auto_push_failed', { branch: 'panda/up', detail });

  beforeEach(() => { seq = 0; });

  test('没有 auto_push_failed → null（绝大多数 issue 走这条）', () => {
    expect(pushFailureState([])).toBeNull();
    expect(pushFailureState([ev('auto_commit'), ev('auto_push', { branch: 'main' })])).toBeNull();
  });

  test('有 auto_push_failed 且其后没有成功推送 → 返回分支与 git 原话', () => {
    expect(pushFailureState([ev('auto_commit'), failed()])).toEqual({
      branch: 'panda/up',
      detail: 'fatal: 远端拒绝',
    });
  });

  test('失败之后又推成功（重跑/人工补推）→ 标记自动消失，不需要谁去清', () => {
    expect(pushFailureState([failed(), ev('auto_push', { branch: 'panda/up' })])).toBeNull();
  });

  test('只看最后一次失败：先失败→推成功→又失败，仍要显示最新那条', () => {
    const events = [
      failed('第一次'),
      ev('auto_push', { branch: 'panda/up' }),
      failed('第二次'),
    ];
    expect(pushFailureState(events)?.detail).toBe('第二次');
  });

  test('推成功发生在失败之前不算解除（事件顺序按 id，不按出现次序）', () => {
    const push = ev('auto_push', { branch: 'panda/up' });
    const fail = failed();
    // 倒序塞进去：id 仍然是 push 更早，不能被当成「事后补推成功」
    expect(pushFailureState([fail, push])?.detail).toBe('fatal: 远端拒绝');
  });

  test('push_skipped 刻意不算解除：没有 origin 说明它至今仍没被推走', () => {
    expect(pushFailureState([failed(), ev('push_skipped', { reason: 'no-remote' })])).not.toBeNull();
  });

  test('旧事件缺字段/坏 JSON 时降级成空串，不炸也不显示 undefined', () => {
    expect(pushFailureState([ev('auto_push_failed')])).toEqual({ branch: '', detail: '' });
    expect(pushFailureState([{ id: 9, issueId: 1, kind: 'auto_push_failed', dataJson: '{坏', ts: 0 }]))
      .toEqual({ branch: '', detail: '' });
  });
});

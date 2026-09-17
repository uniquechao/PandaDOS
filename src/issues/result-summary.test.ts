/**
 * issues/result-summary 单测 —— 收尾摘要的确定性拼装（#275 / I-05）。
 * 全是纯函数：入参普通数据，不碰 store / driver / 时钟。
 */
import { describe, expect, test } from 'bun:test';
import type { CompletionReport } from './completion-report';
import {
  buildBlockedSummary,
  buildDoneSummary,
  lastFailureOf,
  MAX_SUMMARY_CHARS,
  pushOutcomeOf,
  type SummaryEvent,
} from './result-summary';

const report: CompletionReport = {
  version: 1,
  outcome: 'complete',
  objective: '给导出加 CSV 支持',
  implementation: ['新增 exporter 模块', '接进设置页'],
  advantages: ['零依赖'],
  disadvantages: [],
  verification: ['跑了单测与门禁'],
  completion: '已全部完成并上线',
  unmetGoals: [],
  remainingWork: ['观察一周导出耗时'],
};

const ev = (id: number, kind: string, data?: Record<string, unknown>): SummaryEvent => ({
  id,
  kind,
  dataJson: data ? JSON.stringify(data) : null,
});

describe('pushOutcomeOf：只认最后发生的那条推送事件', () => {
  test('三类事件各自识别', () => {
    expect(pushOutcomeOf([ev(1, 'auto_push', { branch: 'main' })]))
      .toEqual({ kind: 'pushed', branch: 'main' });
    expect(pushOutcomeOf([ev(1, 'push_skipped', { reason: 'no-remote' })]))
      .toEqual({ kind: 'skipped', reason: 'no-remote' });
    expect(pushOutcomeOf([ev(1, 'auto_push_failed', { detail: 'rejected' })]))
      .toEqual({ kind: 'failed', detail: 'rejected' });
  });

  test('跨轮重复时以最后一条为准（人工补推后不该还说未推送）', () => {
    const events = [
      ev(1, 'auto_push_failed', { detail: 'rejected' }),
      ev(2, 'auto_commit', {}),
      ev(3, 'auto_push', { branch: 'panda/up' }),
    ];
    expect(pushOutcomeOf(events)).toEqual({ kind: 'pushed', branch: 'panda/up' });
    // 事件顺序打乱也按 id 判，不靠数组次序
    expect(pushOutcomeOf([...events].reverse())).toEqual({ kind: 'pushed', branch: 'panda/up' });
  });

  test('没有推送事件返回 null', () => {
    expect(pushOutcomeOf([])).toBeNull();
    expect(pushOutcomeOf([ev(1, 'auto_commit', {})])).toBeNull();
  });
});

describe('lastFailureOf：最后一次 error / tests_failed', () => {
  test('error 带 where，tests_failed 带 note', () => {
    expect(lastFailureOf([ev(1, 'error', { where: 'auto_commit', error: 'Author identity unknown' })]))
      .toEqual({ kind: 'error', where: 'auto_commit', detail: 'Author identity unknown' });
    expect(lastFailureOf([ev(1, 'tests_failed', { note: '3 个用例挂了' })]))
      .toEqual({ kind: 'tests_failed', detail: '3 个用例挂了' });
  });

  test('取 id 最大的一条，坏事件与无关事件跳过', () => {
    const events = [
      ev(1, 'tests_failed', { note: '旧的' }),
      ev(2, 'nudged', {}),
      ev(3, 'error', { where: 'auto_push', error: '新的' }),
    ];
    expect(lastFailureOf(events)).toMatchObject({ where: 'auto_push', detail: '新的' });
    expect(lastFailureOf([{ id: 9, kind: 'error', dataJson: '{坏' }]))
      .toEqual({ kind: 'error', detail: '' }); // 坏数据只丢细节，不丢「有过失败」这件事
    expect(lastFailureOf([])).toBeNull();
  });
});

describe('buildDoneSummary', () => {
  const base = {
    subtasks: [{ text: 'a', done: true }, { text: 'b', done: true }],
    commits: [{ short: 'abc1234', subject: '加导出' }],
    files: [{ status: 'M', path: 'a.ts', adds: 10, dels: 2 }, { status: 'A', path: 'b.ts', adds: 5, dels: 0 }],
    events: [ev(1, 'auto_push', { branch: 'main' })],
  };

  test('料齐：报告主干 + 客观数据都在', () => {
    const s = buildDoneSummary({ ...base, report, locale: 'zh-Hans' });
    expect(s).toContain('目标：给导出加 CSV 支持');
    expect(s).toContain('完成情况：已全部完成并上线');
    expect(s).toContain('子任务：2/2 完成');
    expect(s).toContain('改动：1 个提交 / 2 个文件（+15 −2）');
    expect(s).toContain('推送：已推送（main）');
    expect(s).toContain('- 新增 exporter 模块');
    expect(s).toContain('- 跑了单测与门禁');
    expect(s).toContain('- 观察一周导出耗时'); // 遗留 = unmetGoals + remainingWork
    expect(s.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  test('没有结构化报告：只靠客观数据也拼得出有用的交代', () => {
    const s = buildDoneSummary({ ...base, report: null, locale: 'zh-Hans' });
    expect(s).toContain('子任务：2/2 完成');
    expect(s).toContain('改动：1 个提交');
    expect(s).toContain('推送：已推送');
    expect(s).not.toContain('目标：');
    expect(s.trim().length).toBeGreaterThan(0); // 不为空 → 不用降级到 PM
  });

  test('无远端跳过推送不写成失败：那不是故障', () => {
    const s = buildDoneSummary({
      ...base, report: null, events: [ev(1, 'push_skipped', { reason: 'no-remote' })], locale: 'zh-Hans',
    });
    expect(s).toContain('推送：已跳过（项目没有配置远端）');
    expect(s).not.toContain('未推送');
  });

  test('推送失败要说清楚，并带上 git 原话', () => {
    const s = buildDoneSummary({
      ...base, report: null,
      events: [ev(1, 'auto_push_failed', { detail: '! [rejected] (fetch first)' })],
      locale: 'zh-Hans',
    });
    expect(s).toContain('推送：未推送');
    expect(s).toContain('[rejected]');
  });

  test('什么料都没有 → 空串，由调用方决定要不要降级', () => {
    expect(buildDoneSummary({
      report: null, subtasks: [], commits: [], files: [], events: [], locale: 'zh-Hans',
    })).toBe('');
  });

  test('超长内容被截断，不把 UI 撑爆', () => {
    const fat: CompletionReport = {
      ...report,
      objective: 'x'.repeat(2000),
      implementation: Array.from({ length: 50 }, (_, i) => `${i}-${'y'.repeat(500)}`),
    };
    const s = buildDoneSummary({ ...base, report: fat, locale: 'zh-Hans' });
    expect(s.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
  });

  test('英文 locale 走英文措辞', () => {
    const s = buildDoneSummary({ ...base, report, locale: 'en' });
    expect(s).toContain('Objective:');
    expect(s).toContain('Subtasks: 2/2 done');
    expect(s).toContain('Push: pushed (main)');
  });
});

describe('buildBlockedSummary', () => {
  test('料齐：卡在哪里 + 最后一次失败 + 当时进度', () => {
    const s = buildBlockedSummary({
      blockNote: '自动提交失败，工作区改动已保留',
      subtasks: [{ text: 'a', done: true }, { text: 'b', done: false }],
      commits: [{ short: 'abc1234', subject: '半成品' }],
      events: [ev(5, 'error', { where: 'auto_commit', error: 'Author identity unknown' })],
      locale: 'zh-Hans',
    });
    expect(s).toContain('卡在这里：自动提交失败，工作区改动已保留');
    expect(s).toContain('最后一次失败：自动提交失败——Author identity unknown');
    expect(s).toContain('子任务：1/2 完成');
    expect(s).toContain('已有 1 个提交');
  });

  test('只有 block note 也拼得出来；只有失败事件同样', () => {
    expect(buildBlockedSummary({
      blockNote: '缺少 API key', subtasks: [], commits: [], events: [], locale: 'zh-Hans',
    })).toBe('卡在这里：缺少 API key');

    expect(buildBlockedSummary({
      blockNote: null, subtasks: [], commits: [],
      events: [ev(1, 'tests_failed', { note: '门禁没过' })], locale: 'zh-Hans',
    })).toBe('最后一次失败：测试未通过——门禁没过');
  });

  test('什么都没有 → 空串，交给调用方降级到 PM', () => {
    expect(buildBlockedSummary({
      blockNote: null, subtasks: [], commits: [], events: [], locale: 'zh-Hans',
    })).toBe('');
  });
});

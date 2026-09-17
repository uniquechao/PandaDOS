/**
 * issues/merge-guards 单测（#289 / B-14）——纯函数，入参普通数据。
 * 重点：声明写在正文中段仍然生效（那正是 #277 声明失效的现场），以及普通正文不误命中。
 */
import { describe, expect, test } from 'bun:test';
import {
  composeMergedBody,
  hasNoMergeDeclaration,
  looksTruncated,
  MERGED_SECTION_OMITTED,
  TRUNCATED_BODY_CHARS,
} from './merge-guards';

/** 把声明埋在一大段正文中间——midTruncate 会把这段省掉，引擎侧判据必须不受影响 */
const buried = (declaration: string): string =>
  ['# 需求', '正文'.repeat(400), declaration, '正文'.repeat(400), '## 验收'].join('\n');

describe('hasNoMergeDeclaration：宽松认「别合并」', () => {
  test('#277 的原句（写在正文中段）必须命中', () => {
    const text = buried('【范围声明·置顶】本条独立，不得与任何其他 Issue 合并。');
    expect(hasNoMergeDeclaration(text)).toBe(true);
  });

  test('中文的各种顺手写法都认', () => {
    for (const s of [
      '范围声明：本条独立',
      '本条独立，不要和别的 issue 合并',
      '禁止与 #276 合并',
      '这条别合并，单独处理',
      '本 issue 不参与合并',
      '请把本条排除在候选之外',
      'noMerge',
      'no-merge: true',
    ]) {
      expect(hasNoMergeDeclaration(buried(s))).toBe(true);
    }
  });

  test('英文写法同样认', () => {
    for (const s of [
      'Do not merge this issue with anything else.',
      "Don't merge it into another task.",
      'This must not be merged.',
      'Please keep separate from #276.',
      'This is a standalone issue.',
    ]) {
      expect(hasNoMergeDeclaration(buried(s))).toBe(true);
    }
  });

  test('普通正文不误命中——宁可漏合并，但也不能把正常任务全判成不可合并', () => {
    for (const s of [
      '把门禁从 Agent 会话里移出去，改成引擎在会话外跑。',
      '修复自动提交失败：补齐 git 身份并在 push 被拒时重试。',
      '这条可以和 #276 合并，内容高度重合。',
      '建议与相邻任务合并处理。',
      '合并不受限制。',
      '',
      '   ',
    ]) {
      expect(hasNoMergeDeclaration(s)).toBe(false);
    }
    expect(hasNoMergeDeclaration(null)).toBe(false);
    expect(hasNoMergeDeclaration(undefined)).toBe(false);
  });

  test('过程页里「单独跑该文件」这类套话不算声明（拿生产库真实正文实测复现过）', () => {
    // 抖动用例的说明几乎每条 issue 的过程页里都有；早期把 `单独跑` 裸着当声明，
    // 结果 #277 / #283 这些**根本没写声明**的 issue 也被判成不可合并——
    // 那等于把智能合并整个静默关掉，连 merge_skipped{reason} 的分布也一起失真。
    const boilerplate = buried(
      '`hung worktree Git recovery is deadline-bounded` 是 5 秒 deadline 用例，'
      + '整套并发跑且负载高时会偶发超时；单独跑该文件 18 项全过，遇到它单独复跑确认即可。',
    );
    expect(hasNoMergeDeclaration(boilerplate)).toBe(false);
    // 但「单独做的是本条」仍然算声明
    expect(hasNoMergeDeclaration(buried('本条请单独处理，别并进别的任务'))).toBe(true);
    expect(hasNoMergeDeclaration(buried('单独实施本条即可'))).toBe(true);
  });

  test('明确写法压过反例上下文：既说了「不得合并」就是不得合并', () => {
    expect(hasNoMergeDeclaration('虽然看起来可以合并，但本条不得与任何 issue 合并')).toBe(true);
    expect(hasNoMergeDeclaration('范围声明：独立执行；其余任务可以合并')).toBe(true);
  });
});

describe('looksTruncated：正文残缺时不许做不可逆的合并决策', () => {
  test('midTruncate 的省略标记', () => {
    expect(looksTruncated({ title: 't', body: '开头…[中间省略]…结尾' })).toBe(true);
    expect(looksTruncated({ title: 't', body: 'A[省略120字]B' })).toBe(true);
    expect(looksTruncated({ title: 't', body: '正文（此前被截断）' })).toBe(true);
  });

  test('以省略号收尾 = 半句话结束', () => {
    expect(looksTruncated({ title: 't', body: '实施要点：先改 engine.ts…' })).toBe(true);
    expect(looksTruncated({ title: 't', body: 'see engine.ts...' })).toBe(true);
  });

  test('有过程页却几乎没有正文：#289 第一次误合并的现场', () => {
    expect(looksTruncated({ title: 't', body: '对应 B-14。', docPath: '.panda/modules/m/issues/1.md' })).toBe(true);
    // 没有过程页时，短正文是正常的（很多 issue 本来就一句话）
    expect(looksTruncated({ title: 't', body: '对应 B-14。' })).toBe(false);
    expect(looksTruncated({ title: 't', body: null })).toBe(false);
  });

  test('正文完整就不该被拦下', () => {
    const body = '需求'.repeat(TRUNCATED_BODY_CHARS) + '。';
    expect(looksTruncated({ title: 't', body, docPath: '.panda/modules/m/issues/1.md' })).toBe(false);
  });
});

describe('composeMergedBody：摘要在前，原文分节追加（#289 / B-14）', () => {
  const entries = [
    { id: 7, title: 'A', body: '定位：engine.ts:5245' },
    { id: 9, title: 'B', body: '验收：门禁全绿' },
  ];

  test('原文一字不改地跟在摘要后面，分节标题带 #id', () => {
    const body = composeMergedBody('摘要：两条都在改调度', entries);
    expect(body).toContain('摘要：两条都在改调度');
    expect(body).toContain('### #7 A');
    expect(body).toContain('定位：engine.ts:5245');
    expect(body).toContain('### #9 B');
    expect(body).toContain('验收：门禁全绿');
    expect(body.indexOf('摘要')).toBeLessThan(body.indexOf('### #7'));
  });

  test('超限时从最后一节开始省略，前面的原文与摘要保全', () => {
    const long = '正'.repeat(400);
    const body = composeMergedBody('摘要', [
      { id: 1, title: 'A', body: long },
      { id: 2, title: 'B', body: long },
    ], 600);
    expect(body.length).toBeLessThanOrEqual(600);
    expect(body).toContain('摘要');
    expect(body).toContain(long); // 第一节原文还在
    expect(body).toContain('### #2 B'); // 第二节标题在
    expect(body).toContain(MERGED_SECTION_OMITTED); // 但正文换成说明
  });

  test('摘要本身就超限：硬截断兜底，绝不返回超长内容', () => {
    const body = composeMergedBody('摘'.repeat(1000), entries, 100);
    expect(body.length).toBeLessThanOrEqual(100);
  });

  test('空正文的分支也留下分节，让人知道它被并进来了', () => {
    const body = composeMergedBody('摘要', [{ id: 3, title: 'C', body: null }]);
    expect(body).toContain('### #3 C');
    expect(body).toContain(MERGED_SECTION_OMITTED);
  });
});

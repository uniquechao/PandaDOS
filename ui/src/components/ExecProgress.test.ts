/**
 * ExecProgress 判据单测（issue #100）：进度链的三态、end 点亮、标题回退。
 * 只测纯函数 execProgressState——渲染部分 bun test 无 DOM，按仓库惯例不测。
 */
import { describe, expect, test } from 'bun:test';
import { execProgressState, stepGlyph, type ProgStep } from './ExecProgress';
import type { Subtask } from '../lib/types';

const subs = (...done: boolean[]): Subtask[] => done.map((d, i) => ({ text: `子任务 ${i + 1} 正文`, done: d }));

describe('execProgressState', () => {
  test('已完成的编号是 done，正在跑的那条（i === subIndex）是 cur，其余 todo', () => {
    const { steps } = execProgressState(subs(true, false, false), 1, 'implementing');
    expect(steps.map((s) => s.state)).toEqual(['done', 'cur', 'todo']);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3]);
    expect(steps[1]!.text).toBe('子任务 2 正文');
  });

  test('testing 阶段同样认当前子任务（与 implementing 一致）', () => {
    const { steps } = execProgressState(subs(true, false), 1, 'testing');
    expect(steps[1]!.state).toBe('cur');
  });

  test('不在推进阶段（planning/plan_review/merging…）不高亮任何一条——subIndex 停在 0 时高亮是误导', () => {
    for (const st of ['planning', 'plan_review', 'merging', 'pending'] as const) {
      const { steps } = execProgressState(subs(false, false), 0, st);
      expect(steps.every((s) => s.state === 'todo')).toBe(true);
    }
  });

  test('blocked：卡在的那条（i === subIndex 且未完成）标 blocked，其余不高亮；内联标题取它（#104）', () => {
    const st = execProgressState(subs(true, false, false), 1, 'blocked');
    expect(st.steps.map((s) => s.state)).toEqual(['done', 'blocked', 'todo']);
    expect(st.cur?.n).toBe(2);
    // subIndex 指向已完成的（收尾时挂的）→ 不给完成条抹 blocked
    expect(execProgressState(subs(true, true), 1, 'blocked').steps.map((s) => s.state)).toEqual(['done', 'done']);
  });

  test('cancelled：未完成的整批标 cancelled（不会再跑），已完成保持 done（#104）', () => {
    const { steps } = execProgressState(subs(true, false, false), 0, 'cancelled');
    expect(steps.map((s) => s.state)).toEqual(['done', 'cancelled', 'cancelled']);
  });

  test('完成度计数 doneN/total（顶栏「2/4」徽标）', () => {
    const st = execProgressState(subs(true, true, false, false), 2, 'implementing');
    expect(st.doneN).toBe(2);
    expect(st.total).toBe(4);
  });

  test('圆点 glyph：done ✓ / blocked ⚠ / cancelled ✕，其余显示编号', () => {
    const g = (state: ProgStep['state']): string => stepGlyph({ n: 3, text: 't', state });
    expect(g('done')).toBe('✓');
    expect(g('blocked')).toBe('⚠');
    expect(g('cancelled')).toBe('✕');
    expect(g('cur')).toBe('3');
    expect(g('todo')).toBe('3');
  });

  test('已完成的子任务即使正好是 subIndex 也不算 cur（与详情 tab 的 .plan-i.cur 同判据）', () => {
    const { steps } = execProgressState(subs(true, true), 1, 'implementing');
    expect(steps.map((s) => s.state)).toEqual(['done', 'done']);
  });

  test('end 节点只在 issue 完成后点亮', () => {
    expect(execProgressState(subs(true, true), 2, 'done').endDone).toBe(true);
    expect(execProgressState(subs(true, true), 2, 'merging').endDone).toBe(false);
    expect(execProgressState(subs(true, false), 1, 'implementing').endDone).toBe(false);
  });

  test('内联标题取当前子任务；没有在跑的则退回最近一条已完成的', () => {
    expect(execProgressState(subs(true, false, false), 1, 'implementing').cur?.n).toBe(2);
    // 全跑完等收尾（merging/done）：退回最后一条已完成
    expect(execProgressState(subs(true, true), 2, 'merging').cur?.n).toBe(2);
    // 还没开跑：一条都没完成也没在跑 → 没有标题可显示
    expect(execProgressState(subs(false, false), 0, 'pending').cur).toBeNull();
  });

  test('没有子任务 → 空链（组件据此整块不渲染）', () => {
    const st = execProgressState([], 0, 'implementing');
    expect(st.steps).toEqual([]);
    expect(st.cur).toBeNull();
  });
});

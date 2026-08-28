/**
 * ExecProgress 判据单测（issue #100）：进度链的三态、end 点亮、标题回退。
 * 只测纯函数 execProgressState——渲染部分 bun test 无 DOM，按仓库惯例不测。
 */
import { describe, expect, test } from 'bun:test';
import { canEditSubtask, execProgressState, placeProgressTip, stepGlyph, type ProgStep } from './ExecProgress';
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

describe('canEditSubtask', () => {
  test('计划待确认时所有未完成项可编辑，已完成项不可编辑', () => {
    expect(canEditSubtask({ text: '待确认', done: false }, 0, 0, 'plan_review', 'team')).toBe(true);
    expect(canEditSubtask({ text: '已完成', done: true }, 0, 0, 'plan_review', 'seq')).toBe(false);
  });

  test('顺序执行只开放当前游标之后的项', () => {
    const future = { text: '后续项', done: false };
    expect(canEditSubtask(future, 0, 0, 'implementing', 'seq')).toBe(false);
    expect(canEditSubtask(future, 1, 0, 'implementing', 'seq')).toBe(true);
  });

  test('blocked 可编辑当前受阻项及后续未完成项，且不受顺序/并行模式限制', () => {
    const unfinished = { text: '受阻项', done: false };
    expect(canEditSubtask(unfinished, 0, 0, 'blocked', 'seq')).toBe(true);
    expect(canEditSubtask(unfinished, 1, 0, 'blocked', 'team')).toBe(true);
    expect(canEditSubtask({ text: '已完成', done: true }, 0, 0, 'blocked', 'seq')).toBe(false);
  });

  test('并行执行开工后及其他阶段都不开放编辑', () => {
    const subtask = { text: '未完成', done: false };
    expect(canEditSubtask(subtask, 1, 0, 'implementing', 'team')).toBe(false);
    for (const status of ['planning', 'testing', 'merging', 'done', 'cancelled'] as const) {
      expect(canEditSubtask(subtask, 1, 0, status, 'seq')).toBe(false);
    }
  });
});

describe('placeProgressTip', () => {
  test('按实测宽度将左右边缘夹在可见视口内', () => {
    const left = placeProgressTip(
      { left: 2, top: 40, width: 10, bottom: 50 },
      { width: 320, height: 80 },
      { left: 0, top: 0, width: 1024, height: 768 },
    );
    const right = placeProgressTip(
      { left: 1008, top: 40, width: 10, bottom: 50 },
      { width: 320, height: 80 },
      { left: 0, top: 0, width: 1024, height: 768 },
    );
    expect(left.left).toBe(8);
    expect(right.left).toBe(696);
  });

  test('下方空间不足时翻到锚点上方，并尊重 visualViewport 偏移', () => {
    expect(placeProgressTip(
      { left: 180, top: 690, width: 10, bottom: 700 },
      { width: 240, height: 180 },
      { left: 10, top: 100, width: 390, height: 640 },
    )).toEqual({ left: 65, top: 504, side: 'above' });
  });

  test('两侧空间都不足时仍把完整浮层夹在视口内', () => {
    expect(placeProgressTip(
      { left: 180, top: 160, width: 10, bottom: 170 },
      { width: 360, height: 584 },
      { left: 0, top: 0, width: 375, height: 600 },
    )).toEqual({ left: 8, top: 8, side: 'below' });
  });
});

describe('ExecProgress 浮层交互契约', () => {
  test('浮层 portal 到 body，支持焦点、Escape 和语义关联', async () => {
    const source = await Bun.file(new URL('./ExecProgress.tsx', import.meta.url)).text();
    expect(source).toContain("createPortal(");
    expect(source).toContain('document.body');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain('onFocus=');
    expect(source).toContain("matches(':focus-visible')");
    expect(source).toContain('aria-describedby=');
    expect(source).toContain('role="tooltip"');
    expect(source).toContain("tr('ui.subtaskProgressStep'");
  });
});

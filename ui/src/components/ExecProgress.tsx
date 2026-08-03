/**
 * components/ExecProgress —— 执行现场顶栏的子任务进度链（issue #100）。
 *
 * 「1 → 2 → 3 → end」：站在执行 tab 就能看出这条 issue 拆了几步、正跑第几步、还剩几步，
 * 不用切回详情 tab 翻计划。编号后内联当前子任务标题（截断），悬停/点按编号弹出该子任务全文。
 * 纯展示：数据来自详情接口的 subtasks + issue.subIndex/status，自己不发请求。
 */
import { useEffect, useState } from 'preact/hooks';
import type { ImplMode, IssueStatus, Subtask } from '../lib/types';
import { tr } from '../i18n/runtime';

export type StepState = 'done' | 'cur' | 'todo' | 'blocked' | 'cancelled';

export interface ProgStep {
  /** 展示用序号（1 起） */
  n: number;
  text: string;
  state: StepState;
}

export interface ProgState {
  steps: ProgStep[];
  /** 末尾 end 节点是否点亮（issue 已完成） */
  endDone: boolean;
  /** 顶栏内联标题取的那一条：当前/受阻子任务，没有则退回最近一条已完成的 */
  cur: ProgStep | null;
  /** 完成度计数（#104 顶栏「2/4」徽标；计划清单标题的 doneN 仍走详情页自算） */
  doneN: number;
  total: number;
}

/**
 * 只有代理真在按子任务推进时才认「当前子任务」。
 * planning/plan_review/merging 等阶段 subIndex 可能还停在 0 或已走到末尾，
 * 那时高亮一条没在跑的子任务是误导——与详情 tab 的 `.plan-i.cur` 同一套判据（i === subIndex 且未完成）。
 */
const RUNNING_STATES: readonly IssueStatus[] = ['implementing', 'testing'];

/**
 * 与 issue 引擎的派发边界保持一致：计划确认阶段尚未派发；顺序执行时只有游标之后的项尚未派发。
 * 团队模式开工后会并行派发全部子任务，因此不开放编辑。
 */
export function canEditSubtask(
  subtask: Subtask,
  index: number,
  subIndex: number,
  status: IssueStatus,
  implMode: ImplMode,
): boolean {
  if (subtask.done) return false;
  if (status === 'plan_review') return true;
  return implMode === 'seq' && (status === 'implementing' || status === 'blocked') && index > subIndex;
}

/** 纯函数：把 subtasks + subIndex + status 折成进度链（组件只管画）。
 * blocked：卡在的那条（i === subIndex 且未完成）标 blocked——subIndex 就是受阻现场，有信息量；
 * cancelled：未完成的整批标 cancelled（不会再跑了），已完成的保持 done 不抹功劳。（#104） */
export function execProgressState(subs: Subtask[], subIndex: number, status: IssueStatus): ProgState {
  const running = RUNNING_STATES.includes(status);
  const steps: ProgStep[] = subs.map((s, i) => ({
    n: i + 1,
    text: s.text,
    state: s.done
      ? 'done'
      : status === 'cancelled'
        ? 'cancelled'
        : status === 'blocked' && i === subIndex
          ? 'blocked'
          : running && i === subIndex
            ? 'cur'
            : 'todo',
  }));
  const cur =
    steps.find((s) => s.state === 'cur' || s.state === 'blocked') ??
    // 没有在跑/受阻的那一条（已跑完 / 还没开跑）→ 退回最近一条已完成的，标题栏不至于空着
    [...steps].reverse().find((s) => s.state === 'done') ??
    null;
  return {
    steps,
    endDone: status === 'done',
    cur,
    doneN: steps.filter((s) => s.state === 'done').length,
    total: steps.length,
  };
}

/** 圆点内容（进度链与详情计划清单共用）：done ✓ / blocked ⚠ / cancelled ✕，其余显示编号
 * （编号仍留在 title/aria/浮层里，不丢定位感） */
export function stepGlyph(s: ProgStep): string {
  return s.state === 'done' ? '✓' : s.state === 'blocked' ? '⚠' : s.state === 'cancelled' ? '✕' : String(s.n);
}

/** 浮层横向位置夹在视口内（编号在最左/最右时不被切掉） */
function clampX(x: number): number {
  const w = typeof window === 'undefined' ? 360 : window.innerWidth;
  return Math.min(Math.max(x, 90), Math.max(90, w - 90));
}

export function ExecProgress({
  subs,
  subIndex,
  status,
}: {
  subs: Subtask[];
  subIndex: number;
  status: IssueStatus;
}) {
  // 详情浮层：编号 + 全文 + 视口坐标（null = 未弹）
  const [tip, setTip] = useState<{ n: number; text: string; x: number; y: number } | null>(null);
  const tipOpen = tip !== null;

  // 点别处/滚动/改窗口大小都收起：手机上是点按弹出的，没有 mouseleave 可依赖。
  useEffect(() => {
    if (!tipOpen) return;
    const close = (): void => setTip(null);
    document.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [tipOpen]);

  const { steps, endDone, cur, doneN, total } = execProgressState(subs, subIndex, status);
  if (steps.length === 0) return null; // 没拆子任务的小改动：整块不渲染，顶栏保持原样

  const show = (el: HTMLElement, s: ProgStep): void => {
    const r = el.getBoundingClientRect();
    setTip({ n: s.n, text: s.text, x: r.left + r.width / 2, y: r.bottom + 6 });
  };

  return (
    <div class="exec-prog" aria-label={tr('ui.subtaskProgress')}>
      <span class={`ep-count${doneN === total ? ' all' : ''}`} title={tr('ui.completedProgress', { done: doneN, total })}>
        {doneN}/{total}
      </span>
      {/* 连线圆点轨道（#113 Apple 化）：状态靠填充色表达，编号/全文在 title/aria/浮层里 */}
      <div class="ep-track">
        {steps.map((s) => (
          <button
            key={s.n}
            class={`ep-dot ${s.state}`}
            title={`${s.n}. ${s.text}`}
            aria-label={`子任务 ${s.n}：${s.text}`}
            // 只对鼠标做悬停弹出：触摸设备上 pointerenter 也会来一发，会和下面的点按互相抵消
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') show(e.currentTarget, s);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') setTip(null);
            }}
            onClick={(e) => {
              e.stopPropagation(); // 否则冒到 document 上被上面的 close 立刻关掉
              if (tip && tip.n === s.n) setTip(null);
              else show(e.currentTarget, s);
            }}
          />
        ))}
        <span class={`ep-end${endDone ? ' done' : ''}`} title={endDone ? tr('status.done') : tr('ui.endpoint')} aria-label={tr('ui.endpoint')} />
      </div>
      {cur && (
        <span class="ep-title" title={`${cur.n}. ${cur.text}`}>
          {cur.n}. {cur.text}
        </span>
      )}
      {tip && (
        <div
          class="ep-tip"
          style={{ left: `${clampX(tip.x)}px`, top: `${tip.y}px` }}
          onClick={(e) => e.stopPropagation()}
        >
          <b>{tip.n}.</b> {tip.text}
        </div>
      )}
    </div>
  );
}

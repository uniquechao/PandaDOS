/**
 * components/ExecProgress —— 执行现场顶栏的子任务进度链（issue #100）。
 *
 * 「1 → 2 → 3 → end」：站在执行 tab 就能看出这条 issue 拆了几步、正跑第几步、还剩几步，
 * 不用切回详情 tab 翻计划。编号后内联当前子任务标题（截断），悬停/点按编号弹出该子任务全文。
 * 纯展示：数据来自详情接口的 subtasks + issue.subIndex/status，自己不发请求。
 */
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
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
  if (status === 'blocked' || status === 'paused') return index >= subIndex;
  return implMode === 'seq' && status === 'implementing' && index > subIndex;
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
        : (status === 'blocked' || status === 'paused') && i === subIndex
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

interface TipAnchor {
  left: number;
  top: number;
  width: number;
  bottom: number;
}

interface TipViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ProgressTipPlacement {
  left: number;
  top: number;
  side: 'above' | 'below';
}

const TIP_MARGIN = 8;
const TIP_GAP = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 以实测浮层尺寸定位：优先放在锚点下方；空间不足时翻到上方；两轴最终都夹在可见视口内。
 * visualViewport 的 offset 也纳入计算，软键盘或缩放后仍不会掉出当前可见区域。
 */
export function placeProgressTip(
  anchor: TipAnchor,
  tip: { width: number; height: number },
  viewport: TipViewport,
): ProgressTipPlacement {
  const viewLeft = viewport.left + TIP_MARGIN;
  const viewTop = viewport.top + TIP_MARGIN;
  const viewRight = viewport.left + viewport.width - TIP_MARGIN;
  const viewBottom = viewport.top + viewport.height - TIP_MARGIN;
  const belowTop = anchor.bottom + TIP_GAP;
  const aboveTop = anchor.top - TIP_GAP - tip.height;
  const belowSpace = viewBottom - belowTop;
  const aboveSpace = anchor.top - TIP_GAP - viewTop;
  const side = belowSpace >= tip.height || belowSpace >= aboveSpace ? 'below' : 'above';

  return {
    left: clamp(anchor.left + anchor.width / 2 - tip.width / 2, viewLeft, viewRight - tip.width),
    top: clamp(side === 'below' ? belowTop : aboveTop, viewTop, viewBottom - tip.height),
    side,
  };
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
  const [tip, setTip] = useState<{ n: number; text: string; anchor: TipAnchor } | null>(null);
  const [placement, setPlacement] = useState<ProgressTipPlacement | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipOpen = tip !== null;

  // 点别处/滚动/改窗口大小都收起：手机上是点按弹出的，没有 mouseleave 可依赖。
  useEffect(() => {
    if (!tipOpen) return;
    const close = (): void => setTip(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    const viewport = window.visualViewport;
    document.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    viewport?.addEventListener('resize', close);
    viewport?.addEventListener('scroll', close);
    return () => {
      document.removeEventListener('click', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      viewport?.removeEventListener('resize', close);
      viewport?.removeEventListener('scroll', close);
    };
  }, [tipOpen]);

  useLayoutEffect(() => {
    if (!tip || !tipRef.current) {
      setPlacement(null);
      return;
    }
    const visual = window.visualViewport;
    const viewport: TipViewport = {
      left: visual?.offsetLeft ?? 0,
      top: visual?.offsetTop ?? 0,
      width: visual?.width ?? window.innerWidth,
      height: visual?.height ?? window.innerHeight,
    };
    setPlacement(placeProgressTip(
      tip.anchor,
      { width: tipRef.current.offsetWidth, height: tipRef.current.offsetHeight },
      viewport,
    ));
  }, [tip]);

  const { steps, endDone, cur, doneN, total } = execProgressState(subs, subIndex, status);
  if (steps.length === 0) return null; // 没拆子任务的小改动：整块不渲染，顶栏保持原样

  const show = (el: HTMLElement, s: ProgStep): void => {
    const r = el.getBoundingClientRect();
    setPlacement(null);
    setTip({ n: s.n, text: s.text, anchor: { left: r.left, top: r.top, width: r.width, bottom: r.bottom } });
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
            aria-label={tr('ui.subtaskProgressStep', { number: s.n, text: s.text })}
            aria-describedby={tip?.n === s.n ? `exec-progress-tip-${s.n}` : undefined}
            aria-current={s.state === 'cur' ? 'step' : undefined}
            // 只对鼠标做悬停弹出：触摸设备上 pointerenter 也会来一发，会和下面的点按互相抵消
            onPointerEnter={(e) => {
              if (e.pointerType === 'mouse') show(e.currentTarget, s);
            }}
            onPointerLeave={(e) => {
              if (e.pointerType === 'mouse') setTip(null);
            }}
            onFocus={(e) => {
              // 鼠标/触屏随后还会触发 click；只让键盘焦点在 focus 阶段打开，避免首次点击开后即关。
              if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, s);
            }}
            onBlur={() => setTip(null)}
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
        createPortal(
          <div
            ref={tipRef}
            id={`exec-progress-tip-${tip.n}`}
            class="ep-tip"
            role="tooltip"
            data-side={placement?.side}
            style={{
              left: `${placement?.left ?? 0}px`,
              top: `${placement?.top ?? 0}px`,
              visibility: placement ? 'visible' : 'hidden',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <b>{tip.n}.</b> {tip.text}
          </div>,
          document.body,
        )
      )}
    </div>
  );
}

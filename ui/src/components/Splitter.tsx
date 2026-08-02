/**
 * Splitter —— Git 页宽屏三栏之间的可拖拽竖向分隔条。
 *
 * pointer 事件 + setPointerCapture 拖拽：把指针 x 换算成「占容器宽度的累计百分比」，
 * 交给 colsize hook 的 setBoundary(boundary, pct)（夹取 + 落库都在 hook 里）。
 * requestAnimationFrame 节流到每帧一次；双击复位默认列宽。
 * 拖拽期给 <body> 挂 .col-resizing（统一光标/禁选，样式见 style.css 子任务 11）。
 *
 * 与两条分隔线联动：boundary 0 在 提交/文件 之间、boundary 1 在 文件/Diff 之间；
 * 两个 Splitter 共用父级同一个 useColSizes 实例。
 */
import type { RefObject } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { ColSizes } from '../lib/colsize';
import { tr } from '../i18n/runtime';

export function Splitter({
  containerRef,
  cols,
  boundary,
  label,
}: {
  /** 三栏容器 ref：把指针 x 换算成占容器宽度的百分比 */
  containerRef: RefObject<HTMLElement>;
  /** 父级 useColSizes 返回值（两条分隔条共用同一实例） */
  cols: ColSizes;
  /** 0 = 提交/文件 之间；1 = 文件/Diff 之间 */
  boundary: 0 | 1;
  label?: string;
}) {
  const dragging = useRef(false); // 同步守卫（pointermove 立即可读）
  const [active, setActive] = useState(false); // 拖拽态样式（触发重渲染挂 .on）
  const lastX = useRef(0);
  const raf = useRef(0);

  const flush = (): void => {
    raf.current = 0;
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    cols.setBoundary(boundary, ((lastX.current - r.left) / r.width) * 100);
  };

  const onMove = (e: PointerEvent): void => {
    if (!dragging.current) return;
    lastX.current = e.clientX;
    if (!raf.current) raf.current = requestAnimationFrame(flush); // 每帧最多算一次，用最新 x
  };

  const end = (e: PointerEvent): void => {
    if (!dragging.current) return;
    dragging.current = false;
    setActive(false);
    if (raf.current) {
      cancelAnimationFrame(raf.current);
      raf.current = 0;
    }
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.classList.remove('col-resizing');
  };

  return (
    <div
      class={`gsplit${active ? ' on' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? tr('ui.dragColumns')}
      title={tr('ui.dragColumnsReset')}
      onPointerDown={(e) => {
        e.preventDefault();
        dragging.current = true;
        setActive(true);
        lastX.current = e.clientX;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        document.body.classList.add('col-resizing');
      }}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDblClick={() => cols.reset()}
    >
      <span class="gsplit-grip" />
    </div>
  );
}

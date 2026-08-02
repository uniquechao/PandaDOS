/**
 * ListSplitter —— 工作台宽屏「列表栏 | 工作台」之间的可拖拽竖向分隔条（两栏像素版）。
 *
 * pointer 事件 + setPointerCapture 拖拽：把指针 x 换算成「左栏到容器左沿的像素宽」，
 * 交给 useListWidth 的 setWidth（夹取 [260,400] + 落库都在 hook 里）。
 * requestAnimationFrame 节流到每帧一次；双击 reset 复位默认响应式宽度。
 * 拖拽期给 <body> 挂 .col-resizing（统一光标/禁选，样式见 style.css）。
 * 复用 Git 页分隔条的 .gsplit 视觉（cursor/hover/.on/竖线），逻辑改为单边界像素制。
 */
import type { RefObject } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { ListWidth } from '../lib/listwidth';
import { tr } from '../i18n/runtime';

export function ListSplitter({
  containerRef,
  list,
  label,
}: {
  /** 两栏容器 ref（.wb-split）：把指针 x 换算成左栏像素宽 */
  containerRef: RefObject<HTMLElement>;
  /** 父级 useListWidth 返回值 */
  list: ListWidth;
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
    // 左栏目标宽 = 指针到容器左沿的距离（hook 内夹取 [260,400] 并落库）
    list.setWidth(lastX.current - r.left);
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
      aria-label={label ?? tr('ui.dragList')}
      title={tr('ui.dragListReset')}
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
      onDblClick={() => list.reset()}
    >
      <span class="gsplit-grip" />
    </div>
  );
}

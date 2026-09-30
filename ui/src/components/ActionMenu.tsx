/**
 * ActionMenu —— 工作区行菜单 / 更多菜单（issue #388）。
 *
 * 宽屏：定位在触发点的浮层（行末 ⋯、右键、Shift+F10 共用）；窄屏：可滚动底部面板（复用 Modal 的抽屉形态），
 * 不依赖 hover/长按。键盘：打开即聚焦首项，↑/↓ 移动，Esc 关闭并把焦点还给触发元素。
 */
import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { Modal } from './Modal';

export interface MenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 分组分隔线：在本项之前画一条 */
  separator?: boolean;
}

export interface MenuAnchor {
  x: number;
  y: number;
}

function MenuItems({ items, onClose }: { items: MenuItem[]; onClose: () => void }) {
  return (
    <>
      {items.map((it) => (
        <>
          {it.separator && <div class="am-sep" role="separator" />}
          <button
            key={it.key}
            type="button"
            role="menuitem"
            class={`am-item${it.danger ? ' danger' : ''}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </>
      ))}
    </>
  );
}

export function ActionMenu({
  items,
  anchor,
  title,
  sheet,
  onClose,
  header,
}: {
  items: MenuItem[];
  anchor: MenuAnchor;
  /** 菜单标题（抽屉形态显示完整目标名称） */
  title: string;
  /** true = 手机底部面板 */
  sheet: boolean;
  onClose: () => void;
  header?: ComponentChildren;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === 'undefined' ? null : document.activeElement);

  useEffect(() => {
    const root = ref.current;
    root?.querySelector<HTMLButtonElement>('.am-item:not([disabled])')?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        (opener.current as HTMLElement | null)?.focus?.();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = Array.from(root?.querySelectorAll<HTMLButtonElement>('.am-item:not([disabled])') ?? []);
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      list[next]?.focus();
    };
    const onDown = (e: PointerEvent): void => {
      if (!sheet && root && !root.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose, sheet]);

  if (sheet) {
    return (
      <Modal title={title} onClose={onClose}>
        <div class="am-sheet" role="menu" aria-label={title} ref={ref}>
          {header}
          <MenuItems items={items} onClose={onClose} />
        </div>
      </Modal>
    );
  }
  // 浮层夹在视口内（右/下边缘翻转）
  const w = 240;
  const h = Math.min(items.length * 36 + 16, 420);
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - w - 8));
  const top = anchor.y + h > window.innerHeight - 8 ? Math.max(8, anchor.y - h) : anchor.y;
  return createPortal(
    <div class="am-pop" role="menu" aria-label={title} ref={ref} style={{ left, top, width: w }}>
      {header}
      <MenuItems items={items} onClose={onClose} />
    </div>,
    document.body,
  );
}

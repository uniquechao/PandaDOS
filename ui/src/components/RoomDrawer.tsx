import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useI18n } from '../i18n/provider';

/** One inspector surface: in-flow on wide screens, a focus-contained overlay on narrow ones. */
export function RoomDrawer({ title, overlay, onClose, children, actions }: {
  title: string; overlay: boolean; onClose: () => void; children: ComponentChildren; actions?: ComponentChildren;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    dialog.close();
    if (overlay) dialog.showModal(); else dialog.show();
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || overlay || document.querySelector('dialog:modal')) return;
      event.preventDefault(); close.current();
    };
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('keydown', escape); dialog.close(); };
  }, [overlay]);
  return <dialog ref={ref} class={`room-dialog room-drawer${overlay ? ' room-drawer-overlay' : ''}`} aria-label={title} aria-modal={overlay}
    onCancel={event => { event.preventDefault(); close.current(); }}
    onClick={event => {
      if (!overlay || event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close.current();
    }}>
    <header class="room-drawer-head"><h2>{title}</h2>{actions}<button type="button" class="room-icon-button" onClick={onClose} aria-label={t('common.close')}>×</button></header>
    <div class="room-drawer-body">{children}</div>
  </dialog>;
}

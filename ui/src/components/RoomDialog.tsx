import { useLayoutEffect, useRef } from 'preact/hooks';
import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useI18n } from '../i18n/provider';
import { setLeaveGuard } from '../lib/router';

/** Reuse the same editor in the room inspector without stacking a second surface. */
export function RoomPanelSurface({ embedded = false, ...props }: {
  embedded?: boolean; title: string; children: ComponentChildren; onClose: () => void; wide?: boolean;
}) {
  return embedded ? <section class="room-embedded-panel" aria-label={props.title}>{props.children}</section> : <RoomDialog {...props} />;
}

/** Native modal provides focus containment; restore the trigger on close. */
export function RoomDialog({ title, children, onClose, wide = false, className = '', routed = false }: {
  title: string; children: ComponentChildren; onClose: () => void; wide?: boolean; className?: string; routed?: boolean;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
    // Artifact/member panels already have a route entry. Local dialogs consume
    // the first in-app back action so it closes the editor without leaving the room.
    const release = routed || query.has('artifact') || query.has('member') ? () => {} : setLeaveGuard(() => { close.current(); return true; });
    return () => { release(); ref.current?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return createPortal(<dialog class={`room-dialog${wide ? ' room-dialog-wide' : ''} ${className}`} ref={ref}
    aria-label={title} onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => { if (event.target === event.currentTarget) { const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <header class="room-dialog-head"><h2>{title}</h2><button type="button" class="room-icon-button" onClick={onClose} aria-label={t('common.close')}>×</button></header>
    <div class="room-dialog-body">{children}</div>
  </dialog>, document.body);
}

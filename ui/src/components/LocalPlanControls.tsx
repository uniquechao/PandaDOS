import { createPortal } from 'preact/compat';
import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LocalPlanCandidate } from '../../../shared/local-plans';
import { useI18n } from '../i18n/provider';
import { completedTasks } from '../lib/local-plans';
import { setLeaveGuard } from '../lib/router';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';

const icons = {
  back: 'm14 5-7 7 7 7', next: 'm10 5 7 7-7 7',
  search: 'M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15ZM16 16l5 5',
  refresh: 'M20 7v5h-5M4 17v-5h5M19 12a7 7 0 0 0-12-5L4 10M5 12a7 7 0 0 0 12 5l3-3',
  open: 'M8 4H4v16h16v-4M12 3h9v9M10 14 21 3',
  close: 'm6 6 12 12M18 6 6 18', file: 'M6 3h8l4 4v14H6ZM14 3v5h4M9 12h6M9 16h6',
  help: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1.2.6-2 1-2 2.5M12 17h.01',
};
export function LocalPlanIcon({ name }: { name: keyof typeof icons }) {
  return <svg class="lp-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

/** Native dialogs contain focus, stack confirmations safely and restore the triggering control. */
export function LocalPlanDialog({ title, children, onClose, onBack = onClose, className = '', guardBack = true }: {
  title: string; children: ComponentChildren; onClose(): void; onBack?(): void; className?: string; guardBack?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const back = useRef(onBack);
  back.current = onBack;
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    const release = guardBack ? setLeaveGuard(to => {
      // Explicit links inside the reader must navigate on the first click.
      if (to.name === 'issue' || to.name === 'workspace') return false;
      back.current(); return true;
    }) : () => {};
    return () => { release(); ref.current?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return createPortal(<dialog ref={ref} class={`lp-dialog ${className}`} aria-label={title} tabIndex={-1}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const panel = event.currentTarget;
      // Native dialog makes the background inert; explicitly wrap at both ends
      // so Chromium does not move focus to browser chrome after the last control.
      const controls = Array.from(panel.querySelectorAll<HTMLElement>('button, input, textarea, select, a[href], summary, [tabindex]'))
        .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0);
      const active = document.activeElement;
      if (!controls.length) { event.preventDefault(); panel.focus(); return; }
      if (event.shiftKey && (active === controls[0] || active === panel || !panel.contains(active))) {
        event.preventDefault(); controls.at(-1)!.focus();
      } else if (!event.shiftKey && (active === controls.at(-1) || active === panel || !panel.contains(active))) {
        event.preventDefault(); controls[0]!.focus();
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
    }}>{children}</dialog>, document.body);
}

export function PlanTabs<T extends string>({ id, active, options, onChange }: {
  id: string; active: T; options: Array<{ value: T; label: string }>; onChange(value: T): void;
}) {
  return <div class="lp-tabs" role="tablist" aria-label={options.map(option => option.label).join(' / ')}>
    {options.map((option, index) => <button key={option.value} type="button" id={`${id}-${option.value}`} role="tab"
      aria-selected={active === option.value} aria-controls={`${id}-panel`} tabIndex={active === option.value ? 0 : -1}
      onClick={() => onChange(option.value)} onKeyDown={event => {
        const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!offset && !['Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + offset + options.length) % options.length;
        onChange(options[next]!.value);
        document.getElementById(`${id}-${options[next]!.value}`)?.focus();
      }}>{option.label}</button>)}
  </div>;
}

export interface PlanError { message: string; details?: string }
export function PlanErrorNotice({ error }: { error: PlanError | null }) {
  const { t } = useI18n();
  return error ? <div class="lp-notice lp-error" role="alert"><p>{error.message}</p>{error.details && <details>
    <summary>{t('localPlans.diagnostics')}</summary><pre>{error.details}</pre>
  </details>}</div> : null;
}

export function PlanStateBadge({ row }: { row: LocalPlanCandidate }) {
  const { t } = useI18n();
  const done = !!row.execution?.issues.length && completedTasks(row.execution) === row.execution.issues.length;
  return <span class={`badge ${row.execution ? done ? 'b-green' : 'b-blue' : row.error ? 'b-red' : 'b-amber'}`}>
    {t(row.execution ? done ? 'status.done' : 'localPlans.published' : row.error ? 'localPlans.invalid' : 'localPlans.draft')}
  </span>;
}

export function PlanSource({ pid, path }: { pid: number; path: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return <details class="lp-source"><summary><LocalPlanIcon name="file" />{t('localPlans.source')}</summary>
    <code>{path}</code><div class="lp-inline-actions">
      <button class="btn sm" onClick={() => void copyText(path).then(ok => {
        if (ok) setCopied(true); else toast.error(t('ui.copyFailed'));
      })}>{t(copied ? 'ui.copied' : 'ui.copy')}</button>
      <a class="btn sm" href={`#/p/${pid}/workspace/files/${encodeURIComponent(path)}`}>{t('localPlans.openSource')}<LocalPlanIcon name="open" /></a>
    </div>
  </details>;
}

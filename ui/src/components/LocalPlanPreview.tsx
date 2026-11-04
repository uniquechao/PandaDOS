import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LocalPlanCandidate, LocalPlanExecution } from '../../../shared/local-plans';
import type { IssueStatus } from '../lib/types';
import { executionInput, type PlanExecuteInput } from '../lib/local-plans';
import { useI18n } from '../i18n/provider';
import { Markdown } from './Markdown';
import { StatusBadge } from './badges';
import { Spinner } from './Loaders';
import { LocalPlanDialog, LocalPlanIcon, PlanErrorNotice, PlanStateBadge, PlanTabs, type PlanError } from './LocalPlanControls';

export type PlanSnapshot = LocalPlanCandidate & { plan: NonNullable<LocalPlanCandidate['plan']> };
export function LocalPlanPreview({ pid, snapshot, initialTask, execution, stale, canReload, pending, executing, error, onClose, onReload, onExecute }: {
  pid: number; snapshot: PlanSnapshot; initialTask: number; execution?: LocalPlanExecution;
  stale: boolean; canReload: boolean; pending: PlanExecuteInput | null; executing: boolean; error: PlanError | null;
  onClose(): void; onReload(index: number): void; onExecute(input: PlanExecuteInput): Promise<void>;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const plan = snapshot.plan;
  const [index, setIndex] = useState(Math.max(0, Math.min(initialTask, plan.issues.length - 1)));
  const [tab, setTab] = useState<'description' | 'acceptance'>('description');
  const [confirmation, setConfirmation] = useState<PlanExecuteInput | null>(null);
  const reader = useRef<HTMLDivElement>(null);
  const directory = useRef<HTMLElement>(null);
  const scroll = useRef(new Map<string, number>());
  const task = plan.issues[index]!;
  const scrollKey = `${task.position}:${tab}`;
  const linked = execution?.digest === snapshot.digest ? execution.issues.find(item => item.key === String(task.position)) : undefined;
  const published = !!execution;
  const readOnly = execution?.digest === snapshot.digest;
  const ownPending = pending?.path === snapshot.path && pending.planId === plan.planId && pending.digest === snapshot.digest ? pending : null;
  const disabled = published || stale || !!pending || executing || !!snapshot.error;
  // An uncertain request is reconciled by the server against its original digest, even if the source changed.
  const retryDisabled = ownPending ? executing || published : disabled;
  const badgeRow = { ...snapshot, execution: readOnly ? execution! : snapshot.execution };
  useLayoutEffect(() => { if (reader.current) reader.current.scrollTop = scroll.current.get(scrollKey) ?? 0; }, [scrollKey]);
  useLayoutEffect(() => { directory.current?.querySelector('[aria-current="step"]')?.scrollIntoView({ block: 'nearest' }); }, [index]);

  const selectTask = (next: number, focus = false): void => {
    setIndex(next);
    if (focus) directory.current?.querySelector<HTMLButtonElement>(`[data-task="${next}"]`)?.focus();
  };
  const versionNotice = stale ? <div class="lp-notice" role="status"><p>{t('localPlans.previewChanged')}</p>
    {canReload && <button class="btn sm" disabled={executing} onClick={() => onReload(index)}>{t('localPlans.reloadPreview')}</button>}
  </div> : null;
  const tabs = [{ value: 'description' as const, label: t('localPlans.description') },
    { value: 'acceptance' as const, label: t('localPlans.criteriaCount', { count: task.acceptance.length }) }];

  return <>
    <LocalPlanDialog title={t('localPlans.previewTitle')} className="lp-preview"
      onClose={onClose} onBack={() => confirmation ? setConfirmation(null) : onClose()}>
      <header class="lp-preview-head">
        <div class="lp-breadcrumb"><button onClick={onClose}><LocalPlanIcon name="back" />{t('localPlans.listBack')}</button>
          <span aria-hidden="true">/</span><span>{t('localPlans.previewTitle')}</span></div>
        <button class="lp-icon-button lp-close" onClick={onClose} aria-label={t('common.close')}><LocalPlanIcon name="close" /></button>
        <div class="lp-preview-title"><h2>{plan.title}</h2><PlanStateBadge row={badgeRow} /></div>
        <p class="lp-meta">{t('localPlans.taskCount', { count: plan.issues.length })}<span aria-hidden="true"> · </span>{t(readOnly ? 'localPlans.readOnly' : 'localPlans.draftNote')}</p>
      </header>
      <div class="lp-preview-body">
        <nav class="lp-task-directory" ref={directory} aria-label={t('localPlans.directory')}>
          <h3>{t('localPlans.directory')}</h3>
          {plan.issues.map((item, itemIndex) => {
            const fact = execution?.digest === snapshot.digest ? execution.issues.find(issue => issue.key === String(item.position)) : undefined;
            return <button key={item.position} class={`lp-directory-row${itemIndex === index ? ' selected' : ''}`} data-task={itemIndex}
              aria-current={itemIndex === index ? 'step' : undefined} onClick={() => selectTask(itemIndex)}
              onKeyDown={event => {
                const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
                if (!delta) return;
                event.preventDefault(); selectTask((itemIndex + delta + plan.issues.length) % plan.issues.length, true);
              }}>
              <span class="lp-number">{i18n.formatNumber(item.position)}</span><span class="lp-directory-copy"><strong>{item.title}</strong>
                {fact && <StatusBadge status={fact.status as IssueStatus} />}</span>
            </button>;
          })}
        </nav>
        <section class="lp-preview-task">
          <header class="lp-task-head">
            <label class="lp-task-picker"><span class="lp-sr-only">{t('localPlans.directory')}</span>
              <select value={index} onChange={event => selectTask(Number(event.currentTarget.value))}>
                {plan.issues.map((item, i) => <option value={i} key={item.position}>{t('localPlans.taskPosition', { position: i18n.formatNumber(item.position), total: i18n.formatNumber(plan.issues.length) })} — {item.title}</option>)}
              </select>
            </label>
            <p class="lp-meta lp-desktop-position">{t('localPlans.taskPosition', { position: i18n.formatNumber(task.position), total: i18n.formatNumber(plan.issues.length) })}</p>
            <h3>{task.title}</h3><div class="lp-meta lp-task-meta">{task.module && <code>{task.module}</code>}<span>{task.agent ?? t('localPlans.automaticAgent')}</span></div>
            <PlanTabs<'description' | 'acceptance'> id="lp-preview-tab" active={tab} options={tabs} onChange={setTab} />
          </header>
          <div ref={reader} class="lp-reader" role="tabpanel" id="lp-preview-tab-panel" aria-labelledby={`lp-preview-tab-${tab}`}
            onScroll={event => scroll.current.set(scrollKey, event.currentTarget.scrollTop)}>
            {versionNotice}
            {tab === 'description' ? <Markdown text={task.body} /> : <section><h4>{t('localPlans.acceptance')}</h4>
              <ol class="lp-criteria">{task.acceptance.map((criterion, i) => <li key={i}><span class="lp-number" aria-hidden="true">{i18n.formatNumber(i + 1)}</span><span>{criterion}</span></li>)}</ol>
            </section>}
            <section class="lp-dependencies"><h4>{t('localPlans.prerequisites')}</h4>
              {task.dependsOn.length ? <ul>{task.dependsOn.map(position => {
                const dependency = plan.issues.find(item => item.position === position)!;
                const fact = execution?.digest === snapshot.digest ? execution.issues.find(item => item.key === String(position)) : undefined;
                return <li key={position}><span class="lp-number">{i18n.formatNumber(position)}</span>{fact
                  ? <a href={`#/p/${pid}/issue/${encodeURIComponent(fact.issueId)}`}>{dependency.title}<small>#{fact.issueId}</small></a>
                  : <span>{dependency.title}</span>}</li>;
              })}</ul> : <p class="lp-meta">{t('localPlans.noDependencies')}</p>}
            </section>
            {linked && <a class="lp-text-button lp-linked-issue" href={`#/p/${pid}/issue/${encodeURIComponent(linked.issueId)}`}>
              {t('localPlans.openIssue')}<LocalPlanIcon name="open" /><small>#{linked.issueId}</small></a>}
            <PlanErrorNotice error={error} />
          </div>
        </section>
      </div>
      <footer class="lp-preview-footer">
        <span class="lp-meta lp-footer-note">{t(readOnly ? 'localPlans.readOnly' : 'localPlans.draftNote')}</span>
        <span class="lp-meta lp-footer-position">{i18n.formatNumber(index + 1)} / {i18n.formatNumber(plan.issues.length)}</span>
        <div class="lp-preview-actions">
          <button class="btn lp-previous" disabled={index === 0} onClick={() => selectTask(index - 1)} aria-label={t('localPlans.previous')}><LocalPlanIcon name="back" /><span>{t('localPlans.previous')}</span></button>
          <button class="btn" disabled={index === plan.issues.length - 1} onClick={() => selectTask(index + 1)}>{t('localPlans.next')}<LocalPlanIcon name="next" /></button>
          {published ? <button class="btn" onClick={onClose}>{t('common.close')}</button>
            : <button class="btn primary" disabled={retryDisabled} onClick={() => ownPending ? void onExecute(ownPending) : setConfirmation(executionInput(snapshot))}>
              {executing && <Spinner size="sm" />}{t(executing ? 'localPlans.executing' : ownPending ? 'localPlans.retry' : 'localPlans.execute')}</button>}
        </div>
      </footer>
    </LocalPlanDialog>
    {confirmation && <LocalPlanDialog title={t('localPlans.confirmTitle')} className="lp-confirm" guardBack={false} onClose={() => setConfirmation(null)}>
      <header><h2>{t('localPlans.confirmTitle')}</h2><button class="lp-icon-button" onClick={() => setConfirmation(null)} aria-label={t('common.close')}><LocalPlanIcon name="close" /></button></header>
      <div class="lp-confirm-body"><h3>{plan.title}</h3><p>{t('localPlans.confirmEffect', { count: plan.issues.length })}</p><p class="lp-meta">{t('localPlans.confirmNote')}</p>
        {versionNotice}<PlanErrorNotice error={error} /></div>
      <footer><button class="btn" onClick={() => setConfirmation(null)}>{t(executing ? 'common.close' : 'common.cancel')}</button>
        <button class="btn primary" disabled={retryDisabled} onClick={() => void onExecute(ownPending ?? confirmation)}>{executing && <Spinner size="sm" />}{t(executing ? 'localPlans.executing' : ownPending ? 'localPlans.retry' : 'localPlans.confirmAction')}</button></footer>
    </LocalPlanDialog>}
  </>;
}

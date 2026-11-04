import '../local-plans.css';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { LocalPlanCandidate, LocalPlanExecution, LocalPlansView } from '../../../shared/local-plans';
import { api, ApiError } from '../lib/api';
import { capturePlan, executionCounts, filterPlans, planDocument, planRowKey, planRows, previewChanged,
  readPlanRequest, selectedPlan, type PlanExecuteInput, type PlanFilter } from '../lib/local-plans';
import { useI18n } from '../i18n/provider';
import { nav } from '../lib/router';
import type { IssueStatus, Project } from '../lib/types';
import { StatusBadge } from '../components/badges';
import { Spinner } from '../components/Loaders';
import { LocalPlanPreview, type PlanSnapshot } from '../components/LocalPlanPreview';
import { LocalPlanDialog, LocalPlanIcon, PlanErrorNotice, PlanSource, PlanStateBadge, PlanTabs, type PlanError } from '../components/LocalPlanControls';

type DetailTab = 'progress' | 'content';
interface SavedView { selected: string | null; filter: PlanFilter; query: string; tab: DetailTab; scroll: number }
function savedView(key: string): SavedView {
  const defaults: SavedView = { selected: null, filter: 'all', query: '', tab: 'progress', scroll: 0 };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!value) return defaults;
    return { selected: typeof value.selected === 'string' ? value.selected : null,
      filter: ['all', 'draft', 'published'].includes(value.filter) ? value.filter : 'all',
      query: typeof value.query === 'string' ? value.query : '', tab: value.tab === 'content' ? 'content' : 'progress',
      scroll: Number.isFinite(value.scroll) && value.scroll > 0 ? value.scroll : 0 };
  } catch { return defaults; }
}
const sameRequest = (a: PlanExecuteInput | null, b: PlanExecuteInput) => !!a && a.path === b.path && a.planId === b.planId && a.digest === b.digest;

export function LocalPlansWorkspace({ pid }: { pid: number }) {
  const i18n = useI18n();
  const { t } = i18n;
  const requestKey = `panda:local-plan-request:${pid}`;
  const viewKey = `panda:local-plan-view:${pid}`;
  const [saved] = useState(() => savedView(viewKey));
  const [data, setData] = useState<LocalPlansView | null>(null);
  const [project, setProject] = useState('');
  const [selection, setSelection] = useState(saved.selected);
  const [filter, setFilter] = useState<PlanFilter>(saved.filter);
  const [query, setQuery] = useState(saved.query);
  const [tab, setTab] = useState<DetailTab>(saved.tab);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [help, setHelp] = useState(false);
  const [preview, setPreview] = useState<{ row: PlanSnapshot; initialTask: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [loadError, setLoadError] = useState<PlanError | null>(null);
  const [executionError, setExecutionError] = useState<PlanError | null>(null);
  const [pending, setPending] = useState<PlanExecuteInput | null>(() => {
    try { return readPlanRequest(localStorage.getItem(requestKey)); } catch { return null; }
  });
  const alive = useRef(true);
  const generation = useRef(0);
  const executingRef = useRef(false);
  const pendingRef = useRef(pending);
  const lastExecution = useRef<PlanExecuteInput | null>(pending);
  const list = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const latestView = useRef<SavedView>(saved);
  const currentSelection = useRef<{ key: string; planId?: string } | null>(null);

  const rows = data ? planRows(data) : [];
  const visible = filterPlans(rows, filter, query);
  const row = selectedPlan(visible, selection);
  const document = row ? planDocument(row) : null;
  const detailTab = row?.execution ? tab : 'content';
  currentSelection.current = row ? { key: planRowKey(row), planId: document?.planId } : null;
  latestView.current = { selected: row ? planRowKey(row) : selection, filter, query, tab, scroll: latestView.current.scroll };

  const persist = (input: PlanExecuteInput | null): void => {
    pendingRef.current = input;
    setPending(input);
    try { if (input) localStorage.setItem(requestKey, JSON.stringify(input)); else localStorage.removeItem(requestKey); } catch { /* Keep the captured request in memory. */ }
  };
  const asError = (reason: unknown): PlanError => ({
    message: reason instanceof ApiError ? reason.message : t('errors.local_plans.unavailable'),
    details: reason instanceof ApiError && reason.details != null
      ? typeof reason.details === 'string' ? reason.details : JSON.stringify(reason.details, null, 2) : undefined,
  });
  const load = async (refresh = false, quiet = false): Promise<void> => {
    const request = ++generation.current;
    if (!quiet) setLoading(true);
    try {
      const result = await api<LocalPlansView>(`/api/projects/${pid}/local-plans${refresh ? '?refresh=1' : ''}`);
      if (!alive.current || request !== generation.current) return;
      setData(result); setLoadError(null);
      const original = pendingRef.current;
      if (original && result.executions.some(item => item.planId === original.planId && item.digest === original.digest)) {
        persist(null); setExecutionError(null);
      }
    } catch (reason) { if (alive.current && request === generation.current) setLoadError(asError(reason)); }
    finally { if (alive.current && request === generation.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    void api<Project>(`/api/projects/${pid}`).then(value => { if (alive.current) setProject(value.name); }).catch(() => {});
    void load();
    const timer = setInterval(() => { if (!executingRef.current && !window.document.hidden) void load(false, true); }, 10_000);
    const save = () => { try { localStorage.setItem(viewKey, JSON.stringify(latestView.current)); } catch { /* Optional view preference. */ } };
    window.addEventListener('pagehide', save);
    return () => { save(); alive.current = false; generation.current++; clearInterval(timer); window.removeEventListener('pagehide', save); };
  }, [pid]);
  useEffect(() => { try { localStorage.setItem(viewKey, JSON.stringify(latestView.current)); } catch {} }, [selection, filter, query, tab]);
  const selectedKey = row ? planRowKey(row) : null;
  useEffect(() => { if (selectedKey && selectedKey !== selection) setSelection(selectedKey); }, [selectedKey, selection]);
  useLayoutEffect(() => {
    if (data && list.current && !restored.current) { list.current.scrollTop = saved.scroll; restored.current = true; }
  }, [data]);

  const openPreview = (candidate: LocalPlanCandidate, initialTask = 0): void => {
    const snapshot = capturePlan(candidate);
    if (snapshot.plan) setPreview({ row: { ...snapshot, plan: snapshot.plan }, initialTask });
  };
  const execute = async (input: PlanExecuteInput): Promise<void> => {
    if (executingRef.current || (pendingRef.current && !sameRequest(pendingRef.current, input))) return;
    persist(input); lastExecution.current = input;
    executingRef.current = true; generation.current++; setLoading(false); setExecuting(true); setExecutionError(null);
    try {
      const { execution } = await api<{ execution: LocalPlanExecution }>(`/api/projects/${pid}/local-plans/execute`, 'POST', input);
      try { if (localStorage.getItem(requestKey) === JSON.stringify(input)) localStorage.removeItem(requestKey); } catch {}
      if (!alive.current) return;
      persist(null);
      setData(previous => ({ candidates: (previous?.candidates ?? []).map(candidate => candidate.path === input.path
        ? { ...candidate, execution, changed: candidate.digest !== execution.digest } : candidate),
      executions: [...(previous?.executions ?? []).filter(item => item.planId !== execution.planId), execution] }));
      const active = currentSelection.current;
      if (active?.planId === input.planId && (active.key === `file:${input.path}` || active.key === `published:${input.planId}`)) {
        setSelection(`published:${input.planId}`); setFilter('all'); setTab('progress');
      }
      setPreview(current => current && current.row.plan.planId === input.planId && current.row.digest === input.digest ? null : current);
      await load(false, true);
    } catch (reason) {
      if (alive.current) {
        setExecutionError(asError(reason));
        if (reason instanceof ApiError && [400, 403, 404, 409].includes(reason.status)) { persist(null); await load(true, true); }
      }
    } finally { executingRef.current = false; if (alive.current) setExecuting(false); }
  };
  const previewExecution = preview ? data?.executions.find(item => item.planId === preview.row.plan.planId) ?? preview.row.execution ?? undefined : undefined;
  const latestPreview = preview ? rows.find(item => item.execution?.planId === preview.row.plan.planId) ?? rows.find(item => item.path === preview.row.path) : undefined;
  const previewError = preview && lastExecution.current?.planId === preview.row.plan.planId && lastExecution.current.digest === preview.row.digest ? executionError : null;
  const draftCount = rows.filter(item => item.plan && !item.error && !item.execution).length;
  const publishedCount = rows.filter(item => item.execution).length;

  return <div class="local-plans-page">
    <header class="lp-page-header">
      <div><div class="lp-breadcrumb"><button onClick={() => nav(`/p/${pid}`)}>{project || t('board.tasks')}</button><span aria-hidden="true">/</span><span>{t('localPlans.title')}</span></div>
        <h1>{t('localPlans.title')}</h1><p>{t('localPlans.subtitle')}</p></div>
      <div class="lp-header-actions"><button class="btn" onClick={() => nav(`/p/${pid}`)}><LocalPlanIcon name="back" />{t('localPlans.backToTasks')}</button>
        <button class="btn" disabled={loading || executing} onClick={() => void load(true)}>{loading ? <Spinner size="sm" /> : <LocalPlanIcon name="refresh" />}{t('ui.refresh')}</button>
        <button class="btn" onClick={() => setHelp(true)}><LocalPlanIcon name="help" />{t('localPlans.helpTitle')}</button></div>
    </header>
    <PlanErrorNotice error={executionError ?? loadError} />
    {pending && <div class="lp-notice lp-request-status" role="status"><p>{t(executing ? 'localPlans.executing' : 'localPlans.uncertain')}</p>
      {!executing && <button class="btn sm" onClick={() => void execute(pending)}>{t('localPlans.retry')}</button>}</div>}
    {!data && !loadError ? <div class="lp-workspace lp-skeleton" aria-label={t('common.loading')} role="status"><div class="lp-skeleton-list">{[1, 2, 3].map(n => <div class="skel" key={n} />)}</div><div class="lp-skeleton-detail"><div class="skel" /><div class="skel" /></div></div>
      : data && <div class="lp-workspace" data-detail={mobileDetail}>
        <aside class="lp-plans"><div class="lp-list-head"><h2>{t('localPlans.list')}<span class="lp-count">{i18n.formatNumber(rows.length)}</span></h2>
          <label class="lp-search"><LocalPlanIcon name="search" /><span class="lp-sr-only">{t('localPlans.search')}</span><input type="search" value={query} placeholder={t('localPlans.search')} onInput={event => setQuery(event.currentTarget.value)} /></label>
          <div class="lp-filters" aria-label={t('localPlans.list')}>
            {([{ value: 'all', label: t('localPlans.all'), count: rows.length }, { value: 'draft', label: t('localPlans.draft'), count: draftCount }, { value: 'published', label: t('localPlans.published'), count: publishedCount }] as const).map(option =>
              <button key={option.value} aria-pressed={filter === option.value} onClick={() => setFilter(option.value)}>{option.label}<span>{i18n.formatNumber(option.count)}</span></button>)}
          </div></div>
          <div ref={list} class="lp-plan-list" onScroll={event => { latestView.current.scroll = event.currentTarget.scrollTop; }}>
            {visible.map(candidate => { const plan = planDocument(candidate); return <button key={planRowKey(candidate)} class={`lp-plan-row${row && planRowKey(candidate) === planRowKey(row) ? ' selected' : ''}`}
              aria-pressed={!!row && planRowKey(candidate) === planRowKey(row)} onClick={() => { setSelection(planRowKey(candidate)); setMobileDetail(true); setTab(candidate.execution ? 'progress' : 'content'); }}>
              <strong>{plan?.title ?? candidate.path.split('/').at(-1)}</strong><div class="lp-plan-row-meta"><span>{candidate.execution
                ? t('localPlans.progress', { done: i18n.formatNumber(executionCounts(candidate.execution).done), total: i18n.formatNumber(candidate.execution.issues.length) })
                : plan ? t('localPlans.taskCount', { count: plan.issues.length }) : t('localPlans.invalid')}</span><PlanStateBadge row={candidate} /></div>
            </button>; })}
            {!visible.length && <div class="lp-empty"><LocalPlanIcon name="file" /><p>{t(rows.length ? 'localPlans.noResults' : 'localPlans.empty')}</p>
              {rows.length ? <button class="btn" onClick={() => { setQuery(''); setFilter('all'); }}>{t('localPlans.clearFilters')}</button>
                : <button class="btn" onClick={() => setHelp(true)}>{t('localPlans.helpTitle')}</button>}</div>}
          </div>
        </aside>
        <section class="lp-detail" aria-label={t('localPlans.contentTab')}>
          {row ? <>
            <header class="lp-detail-head"><button class="lp-text-button lp-mobile-back" onClick={() => setMobileDetail(false)}><LocalPlanIcon name="back" />{t('localPlans.listBack')}</button>
              <div class="lp-detail-title"><h2>{document?.title ?? row.path.split('/').at(-1)}</h2><PlanStateBadge row={row} /></div>
              <div class="lp-detail-meta"><span class="lp-meta">{document && t('common.issueCount', { count: document.issues.length })}</span><PlanSource pid={pid} path={row.path} /></div>
              {row.execution && <PlanTabs<DetailTab> id="lp-detail-tab" active={detailTab} onChange={setTab} options={[{ value: 'progress', label: t('localPlans.progressTab') }, { value: 'content', label: t('localPlans.contentTab') }]} />}
            </header>
            <div class="lp-detail-body" role={row.execution ? 'tabpanel' : undefined} id="lp-detail-tab-panel" aria-labelledby={row.execution ? `lp-detail-tab-${detailTab}` : undefined}>
              {row.changed && <div class="lp-notice" role="status">{t('localPlans.changed')}</div>}
              {row.error && <PlanErrorNotice error={{ message: t('localPlans.invalid'), details: row.error }} />}
              {detailTab === 'progress' && row.execution ? <PlanProgress pid={pid} execution={row.execution} onContent={() => setTab('content')} />
                : document && <><div class="lp-section-heading"><h3>{t('localPlans.contentTab')}</h3><button class={`btn${row.execution ? '' : ' primary'}`} onClick={() => openPreview(row)}>{t('localPlans.preview')}<LocalPlanIcon name="open" /></button></div>
                  <ol class="lp-outline">{document.issues.map((task, index) => <li key={task.position}><button onClick={() => openPreview(row, index)}>
                    <span class="lp-number">{i18n.formatNumber(task.position)}</span><span class="lp-outline-copy"><strong>{task.title}</strong><span class="lp-meta">{task.module && <code>{task.module}</code>}<span>{task.agent ?? t('localPlans.automaticAgent')}</span><span>{t('localPlans.criteriaCount', { count: task.acceptance.length })}</span>{task.dependsOn.length > 0 && <span>{t('localPlans.dependencies', { tasks: i18n.formatList(task.dependsOn.map(position => i18n.formatNumber(position))) })}</span>}</span></span><LocalPlanIcon name="next" />
                  </button></li>)}</ol></>}
            </div>
          </> : <div class="lp-empty"><LocalPlanIcon name="file" /><p>{t(rows.length ? 'localPlans.noResults' : 'localPlans.empty')}</p></div>}
        </section>
      </div>}
    {help && <LocalPlanDialog title={t('localPlans.helpTitle')} className="lp-help" onClose={() => setHelp(false)}><header><h2>{t('localPlans.helpTitle')}</h2><button class="lp-icon-button" aria-label={t('common.close')} onClick={() => setHelp(false)}><LocalPlanIcon name="close" /></button></header>
      <div><p>{t('localPlans.help')}</p></div><footer><button class="btn" onClick={() => setHelp(false)}>{t('common.close')}</button></footer></LocalPlanDialog>}
    {preview && <LocalPlanPreview key={`${preview.row.path}:${preview.row.digest}`} pid={pid} snapshot={preview.row} initialTask={preview.initialTask}
      execution={previewExecution} stale={!!data && previewChanged(preview.row, data)} canReload={!!latestPreview && !!planDocument(latestPreview)}
      pending={pending} executing={executing} error={previewError} onClose={() => setPreview(null)} onExecute={execute}
      onReload={index => { if (latestPreview) openPreview(latestPreview, index); }} />}
  </div>;
}

function PlanProgress({ pid, execution, onContent }: { pid: number; execution: LocalPlanExecution; onContent(): void }) {
  const i18n = useI18n(); const { t } = i18n;
  const counts = executionCounts(execution);
  const fraction = counts.total ? counts.done / counts.total : 0;
  return <>
    <section class="lp-progress"><div class="lp-progress-summary"><strong>{t('localPlans.progress', { done: i18n.formatNumber(counts.done), total: i18n.formatNumber(counts.total) })}</strong>
      <div class="lp-progress-counts">{counts.running > 0 && <span>{t('localPlans.runningCount', { count: counts.running })}</span>}{counts.pending > 0 && <span>{t('localPlans.pendingCount', { count: counts.pending })}</span>}{counts.attention > 0 && <span class="lp-attention">{t('localPlans.attentionCount', { count: counts.attention })}</span>}{counts.cancelled > 0 && <span>{t('localPlans.cancelledCount', { count: counts.cancelled })}</span>}</div></div>
      <div class="lp-progress-line"><div class="lp-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, counts.total)} aria-valuenow={counts.done} aria-label={t('localPlans.progressTab')}><span style={{ width: `${fraction * 100}%` }} /></div><span class="lp-meta">{new Intl.NumberFormat(i18n.locale, { style: 'percent', maximumFractionDigits: 0 }).format(fraction)}</span></div>
    </section>
    {execution.effectsPending && <div class="lp-notice" role="status">{t('localPlans.effectsPending')}</div>}
    {execution.lastError && <PlanErrorNotice error={{ message: t('localPlans.effectsPending'), details: execution.lastError }} />}
    <h3 class="lp-linked-title">{t('localPlans.relatedIssues')}</h3>
    <ol class="lp-issues">{execution.issues.map((issue, index) => <li key={issue.issueId}><span class="lp-number">{i18n.formatNumber(index + 1)}</span>
      <div class="lp-issue-copy"><a href={`#/p/${pid}/issue/${encodeURIComponent(issue.issueId)}`}><span>{issue.title}</span><small>#{issue.issueId}</small></a>
        {issue.status === 'pending' && issue.blockers.length > 0 && <p class="lp-meta">{t('localPlans.dependencies', { tasks: i18n.formatList(issue.blockers.map(item => `#${item.issueId}`)) })}</p>}</div>
      <StatusBadge status={issue.status as IssueStatus} /><a class="lp-icon-button" href={`#/p/${pid}/issue/${encodeURIComponent(issue.issueId)}`} aria-label={t('localPlans.openIssue')}><LocalPlanIcon name="open" /></a>
    </li>)}</ol><button class="lp-text-button lp-view-content" onClick={onContent}>{t('localPlans.contentTab')}<LocalPlanIcon name="next" /></button>
  </>;
}

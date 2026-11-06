import { useEffect, useRef, useState } from 'preact/hooks';
import type { LocalPlanCandidate, LocalPlanExecution, LocalPlanPage, LocalPlanStatus } from '../../../shared/local-plans';
import { api, ApiError } from '../lib/api';
import { completedTasks, executionInput, readPlanRequest, type PlanExecuteInput } from '../lib/local-plans';
import { useI18n } from '../i18n/provider';
import { nav } from '../lib/router';
import { Modal } from '../components/Modal';
import { Markdown } from '../components/Markdown';
import { StatusBadge } from '../components/badges';
import { fmtTime } from '../lib/fmt';
import type { IssueStatus } from '../lib/types';
import type { IssueId } from '../../../shared/issue-id';

export function LocalPlansButton({ pid, initialOpen = false }: { pid: number; initialOpen?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(initialOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (initialOpen) setOpen(true); }, [initialOpen]);
  const close = (): void => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return <>
    <button ref={trigger} class="btn sm wb-list-action" title={t('localPlans.title')} aria-label={t('localPlans.title')} onClick={() => setOpen(true)}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M8 4H5v17h14V4h-3M8 3h8v4H8zM8 12h8M8 16h5" /></svg>
    </button>
    {open && <LocalPlansView pid={pid} onClose={close} onOpenIssue={iid => { setOpen(false); nav(`/p/${pid}/issue/${encodeURIComponent(iid)}`); }} />}
  </>;
}

/** Kept mounted over the board: closing does not alter its issue, filters or scroll containers. */
export function LocalPlansView({ pid, onClose = () => nav(`/p/${pid}`), onOpenIssue = iid => nav(`/p/${pid}/issue/${encodeURIComponent(iid)}`) }: {
  pid: number; onClose?: () => void; onOpenIssue?: (iid: IssueId) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  const [data, setData] = useState<LocalPlanPage | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [listError, setListError] = useState('');
  const [listBusy, setListBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LocalPlanCandidate | null>(null);
  const [detailError, setDetailError] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [executing, setExecuting] = useState(false);
  const [tab, setTab] = useState<'progress' | 'content'>('progress');
  const storageKey = `panda:local-plan-request:${pid}`;
  const [pending, setPending] = useState<PlanExecuteInput | null>(() => {
    try { return readPlanRequest(localStorage.getItem(storageKey)); } catch { return null; }
  });
  const alive = useRef(true);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const detailAbort = useRef<AbortController | null>(null);
  const executingRef = useRef(false);
  const detailLoading = useRef(false);
  const hasExecution = useRef(false);
  const currentId = useRef<string | null>(null);
  const requestedPage = useRef(1);
  const retryRefresh = useRef(false);
  const listScroll = useRef<HTMLDivElement>(null);
  const detailScroll = useRef<HTMLElement>(null);
  const message = (reason: unknown): string => reason instanceof ApiError
    ? `${reason.message}${reason.details ? `\n${String(reason.details)}` : ''}` : t('errors.local_plans.unavailable');

  const loadList = async (page = 1, refresh = false): Promise<void> => {
    const generation = ++listGeneration.current;
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    requestedPage.current = page;
    retryRefresh.current = refresh;
    setListBusy(true);
    setListError('');
    try {
      if (refresh) await api(`/api/projects/${pid}/local-plans/refresh`, 'POST', undefined, { signal: controller.signal });
      const params = new URLSearchParams({ page: String(page), pageSize: '20', q: query, status });
      const result = await api<LocalPlanPage>(`/api/projects/${pid}/local-plans?${params}`, 'GET', undefined, { signal: controller.signal });
      if (!alive.current || generation !== listGeneration.current) return;
      setData(result);
      if (listScroll.current) listScroll.current.scrollTop = 0;
    } catch (reason) {
      if (alive.current && generation === listGeneration.current) {
        retryRefresh.current = refresh || (reason instanceof ApiError && reason.params.refresh === true);
        setListError(message(reason));
      }
    } finally { clearTimeout(timeout); if (alive.current && generation === listGeneration.current) setListBusy(false); }
  };
  const loadDetail = async (id: string, polling = false): Promise<void> => {
    const generation = ++detailGeneration.current;
    detailAbort.current?.abort();
    const controller = new AbortController();
    detailAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 30_000);
    detailLoading.current = true;
    if (!polling) { setDetailBusy(true); setDetailError(''); }
    try {
      const result = await api<LocalPlanCandidate>(`/api/projects/${pid}/local-plans/detail?id=${encodeURIComponent(id)}`, 'GET', undefined, { signal: controller.signal });
      if (alive.current && generation === detailGeneration.current && currentId.current === id) {
        hasExecution.current = !!result.execution;
        // Keep the exact draft preview while polling execution facts.
        setSelected(previous => polling && previous && !result.execution ? previous : result);
        setDetailError('');
      }
    } catch (reason) {
      if (alive.current && generation === detailGeneration.current && currentId.current === id) setDetailError(message(reason));
    } finally {
      clearTimeout(timeout);
      if (alive.current && generation === detailGeneration.current) { setDetailBusy(false); detailLoading.current = false; }
    }
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      listGeneration.current++; detailGeneration.current++;
      listAbort.current?.abort(); detailAbort.current?.abort();
    };
  }, [pid]);
  useEffect(() => { void loadList(1); }, [pid, query, status]);
  useEffect(() => {
    if (!selectedId) return;
    void loadDetail(selectedId);
    const timer = setInterval(() => {
      if (hasExecution.current && !detailLoading.current && !executingRef.current) void loadDetail(selectedId, true);
    }, 10_000);
    return () => clearInterval(timer);
  }, [pid, selectedId]);

  const choose = (id: string): void => {
    if (id === currentId.current) { void loadDetail(id); return; }
    hasExecution.current = false;
    currentId.current = id;
    detailGeneration.current++;
    detailAbort.current?.abort();
    setSelectedId(id); setSelected(null); setDetailError(''); setActionError(''); setDetailBusy(true); setTab('progress');
    if (detailScroll.current) detailScroll.current.scrollTop = 0;
  };
  const persist = (input: PlanExecuteInput | null): void => {
    setPending(input);
    try {
      if (input) localStorage.setItem(storageKey, JSON.stringify(input));
      else localStorage.removeItem(storageKey);
    } catch { /* The captured request remains stable for this modal lifetime. */ }
  };
  const execute = async (input: PlanExecuteInput): Promise<void> => {
    if (executingRef.current) return;
    persist(input);
    executingRef.current = true;
    setExecuting(true); setActionError('');
    try {
      await api<{ execution: LocalPlanExecution }>(`/api/projects/${pid}/local-plans/execute`, 'POST', input);
      try { if (localStorage.getItem(storageKey) === JSON.stringify(input)) localStorage.removeItem(storageKey); } catch {}
      if (alive.current) {
        setPending(null);
        void loadList(data?.page ?? 1);
        if (currentId.current) void loadDetail(currentId.current);
      }
    } catch (reason) {
      if (alive.current) {
        setActionError(message(reason));
        if (reason instanceof ApiError && [400, 403, 404, 409].includes(reason.status)) persist(null);
      }
    } finally {
      executingRef.current = false;
      if (alive.current) setExecuting(false);
    }
  };

  const execution = selected?.execution;
  const preview = execution?.plan ?? selected?.plan;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const statusBadge = (value: LocalPlanStatus) => <span class={`badge ${value === 'published' ? 'b-blue' : value === 'invalid' ? 'b-red' : 'b-amber'}`}>{t(`localPlans.${value}`)}</span>;
  return <Modal wide className="local-plans-modal" title={t('localPlans.title')} onClose={onClose}>
    <div class="local-plans-tools">
      <button class="btn sm" disabled={listBusy} onClick={() => { void loadList(data?.page ?? 1, true); if (currentId.current) void loadDetail(currentId.current); }}>{t('localPlans.refresh')}</button>
      <button class="btn sm local-plans-close" aria-label={t('common.close')} onClick={onClose}>×</button>
    </div>
    <div class="local-plans-browser">
      <aside class="local-plans-sidebar" aria-label={t('localPlans.list')}>
        <div class="local-plans-filters">
          <input type="search" aria-label={t('localPlans.search')} placeholder={t('localPlans.search')} value={query} maxLength={200} onInput={e => setQuery(e.currentTarget.value)} />
          <select aria-label={t('localPlans.filter')} value={status} onChange={e => setStatus(e.currentTarget.value)}>
            <option value="">{t('localPlans.all')}</option>
            {(['draft', 'published', 'invalid'] as const).map(value => <option key={value} value={value}>{t(`localPlans.${value}`)}</option>)}
          </select>
        </div>
        {listBusy && <p class="local-plans-feedback" role="status">{t('common.loading')}</p>}
        {listError && <div class="local-plans-feedback err" role="alert"><pre>{listError}</pre><button class="btn sm" disabled={listBusy} onClick={() => void loadList(requestedPage.current, retryRefresh.current)}>{t('action.retry')}</button></div>}
        <div ref={listScroll} class="local-plans-list" aria-busy={listBusy}>
          {data?.items.map(item => <button key={item.id} class={`local-plan-row${selectedId === item.id || (item.planId && item.planId === selected?.plan?.planId) ? ' on' : ''}`} aria-pressed={selectedId === item.id || (!!item.planId && item.planId === selected?.plan?.planId)} onClick={() => choose(item.id)}>
            <strong title={item.title}>{item.title}</strong>
            <span>{statusBadge(item.status)}<time dateTime={item.time ? new Date(item.time).toISOString() : undefined}>{fmtTime(item.time)}</time></span>
          </button>)}
          {data?.items.length === 0 && !listBusy && <p class="local-plans-feedback">{t(query.trim() || status ? 'localPlans.noMatches' : 'localPlans.empty')}</p>}
        </div>
        <footer class="local-plans-pagination">
          <button class="btn sm" disabled={listBusy || !data || data.page <= 1} onClick={() => void loadList(data!.page - 1)} aria-label={t('localPlans.previous')}>‹</button>
          <span>{t('localPlans.page', { page: data?.page ?? 1, pages })}</span>
          <button class="btn sm" disabled={listBusy || !data || data.page >= pages} onClick={() => void loadList(data!.page + 1)} aria-label={t('localPlans.next')}>›</button>
        </footer>
      </aside>
      <section ref={detailScroll} class="local-plans-detail" aria-label={t('localPlans.preview')} aria-busy={detailBusy}>
        {!selectedId && <div class="local-plans-placeholder">{t('localPlans.choose')}</div>}
        {detailBusy && <p role="status">{t('common.loading')}</p>}
        {detailError && <div class="err" role="alert"><pre class="local-plans-diagnostic">{detailError}</pre><button class="btn sm" onClick={() => selectedId && void loadDetail(selectedId)}>{t('action.retry')}</button></div>}
        {selected && <>
          <header class="local-plan-heading"><h2>{preview?.title ?? selected.path}</h2>{statusBadge(execution ? 'published' : selected.error ? 'invalid' : 'draft')}
            <a class="btn sm local-plan-source" href={`#/p/${pid}/files/${selected.path.split('/').map(encodeURIComponent).join('/')}`} title={selected.path}>{t('localPlans.source')}</a>
          </header>
          {selected.error && <pre class="err local-plans-diagnostic">{selected.error}</pre>}
          {selected.changed && <p class="local-plans-notice">{t('localPlans.changed')}</p>}
          <div class="local-plan-tabs">
            <div role="tablist" aria-label={t('localPlans.preview')}>
              <button role="tab" aria-selected={tab === 'progress'} onClick={() => setTab('progress')}>{t('localPlans.executionProgress')}</button>
              <button role="tab" aria-selected={tab === 'content'} onClick={() => setTab('content')}>{t('localPlans.content')}</button>
            </div>
            {execution && <span class="local-plan-progress-summary">{t('localPlans.progress', { done: completedTasks(execution), total: execution.issues.length })}<progress max={execution.issues.length || 1} value={completedTasks(execution)} /></span>}
          </div>
          {tab === 'progress' && <div role="tabpanel">
            {!execution && <p class="mut">{t('localPlans.draft')}</p>}
            {execution?.effectsPending && <p class="local-plans-notice">{t('localPlans.effectsPending')}</p>}
            {execution?.lastError && <pre class="local-plans-diagnostic">{execution.lastError}</pre>}
            <ul class="local-plan-progress">{execution?.issues.map(item => <li key={item.issueId}>
              <a href={`#/p/${pid}/issue/${encodeURIComponent(item.issueId)}`} onClick={e => { e.preventDefault(); onOpenIssue(item.issueId); }}><strong>{item.title}</strong><code>#{item.issueId}</code><StatusBadge status={item.status as IssueStatus} /><span aria-hidden="true">›</span></a>
              {item.status === 'pending' && item.blockers.length > 0 && <span class="local-plan-blockers">{t('localPlans.dependencies', { tasks: i18n.formatList(item.blockers.map(blocker => `#${blocker.issueId}`)) })}</span>}
            </li>)}</ul>
          </div>}
          {tab === 'content' && preview && <ol role="tabpanel" class="local-plan-tasks">{preview.issues.map(item => <li key={item.position}>
            <h4>{item.title}</h4><Markdown text={item.body} />
            <div class="local-plan-meta"><code>{item.module ?? ''}</code><span>{item.agent ?? t('localPlans.automaticAgent')}</span></div>
            <h5>{t('localPlans.acceptance')}</h5><ul>{item.acceptance.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
            <p>{item.dependsOn.length ? t('localPlans.dependencies', { tasks: i18n.formatList(item.dependsOn.map(number => i18n.formatNumber(number))) }) : t('localPlans.noDependencies')}</p>
          </li>)}</ol>}
          {preview && !execution && <button class="btn primary" disabled={executing || !!selected.error || !!pending} onClick={() => void execute(executionInput(selected))}>{t(executing ? 'localPlans.executing' : 'localPlans.execute')}</button>}
        </>}
        {actionError && <pre class="err local-plans-diagnostic" role="alert">{actionError}</pre>}
        {pending && <div class="local-plans-notice" role="status"><p>{t('localPlans.uncertain')}</p><button class="btn" disabled={executing} onClick={() => void execute(pending)}>{t('localPlans.retry')}</button></div>}
      </section>
    </div>
  </Modal>;
}

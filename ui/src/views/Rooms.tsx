import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError } from '../lib/api';
import { nav } from '../lib/router';
import { roomsApi, roomPath, roomRequestKey, roomCriteriaValid, roomCreationKey, readRoomLocal, saveRoomLocal, clearRoomLocal, type RoomPendingCreation, type RoomListResult } from '../lib/rooms-api';
import { useI18n } from '../i18n/provider';
import { RoomDialog } from '../components/RoomDialog';
import { RoomStatus } from './room-presenters';
import type { Me, Project } from '../lib/types';
import { DEFAULT_ROOM_BUDGET, MAX_ROOM_BUDGET, ROOM_ROLES, type RoomBudgetLimits, type RoomCreateInput, type RoomSnapshot } from '../../../shared/rooms';
import './rooms.css';

export function RoomGoalFields({ request, criteria, onRequest, onCriteria }: {
  request: string; criteria: string; onRequest: (value: string) => void; onCriteria: (value: string) => void;
}) {
  const { t } = useI18n();
  return <>
    <label class="room-field"><span>{t('rooms.desiredResult')}</span><textarea required rows={4} maxLength={8000} value={request}
      placeholder={t('rooms.goalPlaceholder')} onInput={(event) => onRequest(event.currentTarget.value)} /></label>
    <label class="room-field"><span>{t('rooms.criteria')}</span><textarea rows={3} maxLength={6000} value={criteria}
      placeholder={t('rooms.criteriaHint')} onInput={(event) => onCriteria(event.currentTarget.value)} /></label>
  </>;
}
export const criteriaLines = (value: string): string[] => value.split('\n').map((line) => line.trim()).filter(Boolean);

export function RoomBudgetFields({ value, onChange, incremental = false, maximum = MAX_ROOM_BUDGET }: {
  value: RoomBudgetLimits; onChange: (value: RoomBudgetLimits) => void; incremental?: boolean; maximum?: RoomBudgetLimits;
}) {
  const { t } = useI18n();
  return <div class="room-budget-fields">
    <label class="room-field"><span>{t('rooms.round')}</span><input type="number" min={incremental ? 0 : 1} max={maximum.rounds} step={1} required
      disabled={incremental && maximum.rounds === 0} value={value.rounds} onInput={(event) => onChange({ ...value, rounds: Number(event.currentTarget.value) })} /></label>
    <label class="room-field"><span>{t('rooms.minutes')}</span><input type="number" min={incremental ? 0 : 1} max={Math.floor(maximum.activeMs / 60000)} step={1} required
      disabled={incremental && maximum.activeMs < 60000} value={value.activeMs / 60000} onInput={(event) => onChange({ ...value, activeMs: Number(event.currentTarget.value) * 60000 })} /></label>
    <label class="room-field"><span>{t('rooms.requests')}</span><input type="number" min={incremental ? 0 : 1} max={maximum.modelRequests} step={1} required
      disabled={incremental && maximum.modelRequests === 0} value={value.modelRequests} onInput={(event) => onChange({ ...value, modelRequests: Number(event.currentTarget.value) })} /></label>
    <p class="room-muted room-budget-help">{t('rooms.budgetHint')}</p>
  </div>;
}

function CreateRoom({ pid, userId, configured, writable, defaults, onClose, onCreated, onFailure }: {
  pid: number; userId: number; configured: boolean; writable: boolean; defaults: RoomBudgetLimits; onClose: () => void; onCreated: (value: RoomSnapshot) => void; onFailure: (cause: unknown) => void;
}) {
  const { t, locale } = useI18n();
  const storageKey = roomCreationKey(userId, pid);
  const recovered = useRef(readRoomLocal<RoomPendingCreation>(storageKey));
  const [uncertain, setUncertain] = useState(!!recovered.current);
  const [title, setTitle] = useState(recovered.current?.input.title ?? '');
  const [request, setRequest] = useState(recovered.current?.input.request ?? '');
  const [criteria, setCriteria] = useState(recovered.current?.input.criteria?.join('\n') ?? '');
  const [templateKey, setTemplate] = useState<'product' | 'writing'>(recovered.current?.input.templateKey ?? 'product');
  const [budget, setBudget] = useState({ ...defaults, ...recovered.current?.input.budget });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const submitted = useRef<RoomPendingCreation | null>(recovered.current);
  const submit = async (start: boolean): Promise<void> => {
    if (!writable || pending || !title.trim() || !request.trim() || !roomCriteriaValid(criteriaLines(criteria))) return;
    const input: RoomCreateInput = uncertain && submitted.current ? submitted.current.input : { title: title.trim(), request: request.trim(), criteria: criteriaLines(criteria), templateKey, budget, start, locale };
    const fingerprint = JSON.stringify(input);
    if (JSON.stringify(submitted.current?.input) !== fingerprint) submitted.current = { input, key: roomRequestKey() };
    saveRoomLocal(storageKey, submitted.current);
    setPending(true); setError('');
    try { const result = await roomsApi.create(pid, input, submitted.current!.key); saveRoomLocal(storageKey, null); onCreated(result); }
    catch (cause) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed'));
      if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500) setUncertain(true);
      else { saveRoomLocal(storageKey, null); submitted.current = null; setUncertain(false); } }
    finally { setPending(false); }
  };
  return <RoomDialog title={t('rooms.create')} onClose={() => { if (!pending) onClose(); }}>
    <form class="room-form" onSubmit={(event) => { event.preventDefault(); void submit(true); }}>
      {uncertain && <p class="room-notice">{t('rooms.creationPending')}</p>}
      <fieldset class="room-form-fields" disabled={!writable || uncertain || pending}>
      <label class="room-field"><span>{t('rooms.roomName')}</span><input autoComplete="off" required maxLength={160} value={title}
        placeholder={t('rooms.roomPlaceholder')} onInput={(event) => setTitle(event.currentTarget.value)} /></label>
      <RoomGoalFields request={request} criteria={criteria} onRequest={setRequest} onCriteria={setCriteria} />
      <fieldset class="room-template-field"><legend>{t('rooms.template')}</legend><div class="room-template-options">
        {(['product', 'writing'] as const).map((key) => <label class={templateKey === key ? 'room-template selected' : 'room-template'} key={key}>
          <input type="radio" name="room-template" value={key} checked={templateKey === key} onChange={() => setTemplate(key)} />{t(`rooms.${key}`)}</label>)}
      </div></fieldset>
      <div class="room-create-team">{ROOM_ROLES.map((role) => <div key={role}><b>{t(`rooms.${role}`)}</b><p>{t(`rooms.memberRole.${role}`)}</p></div>)}</div>
      <details class="room-advanced"><summary>{t('rooms.advanced')}</summary><RoomBudgetFields value={budget} onChange={setBudget} /></details>
      </fieldset>
      {!roomCriteriaValid(criteriaLines(criteria)) && <p class="room-error">{t('rooms.criteriaLimit')}</p>}
      {!configured && <p class="room-notice">{t('rooms.createWithMembersHint')}</p>}
      {error && <p role="alert" class="room-error">{error}</p>}
      <footer class="room-dialog-actions"><button type="button" class="btn" disabled={pending} onClick={onClose}>{t('common.cancel')}</button>
        {!uncertain && <button type="button" class="btn" disabled={!writable || pending || !title.trim() || !request.trim() || !roomCriteriaValid(criteriaLines(criteria))} onClick={() => void submit(false)}>{t('rooms.saveDraft')}</button>}
        <button type="submit" class="btn primary" disabled={!writable || pending || (!configured && !uncertain) || !roomCriteriaValid(criteriaLines(criteria))}>{pending ? t('common.loading') : t(uncertain ? 'rooms.checkCreation' : 'rooms.start')}</button></footer>
    </form>
  </RoomDialog>;
}

export function RoomsView({ pid, me }: { pid: number; me: Me }) {
  const { t, formatRelativeTime, formatNumber } = useI18n();
  const [result, setResult] = useState<RoomListResult | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const scrollRestored = useRef(false);
  const scrollKey = `panda.rooms.list.${me.id}.${pid}.scroll`;
  useLayoutEffect(() => { if (result && listRef.current && !scrollRestored.current) { listRef.current.scrollTop = readRoomLocal<number>(scrollKey) ?? 0; scrollRestored.current = true; } }, [result, scrollKey]);
  const filterKey = `panda.rooms.list.${me.id}.${pid}.filters`;
  const storedFilter = useRef(readRoomLocal<{query: string; filter: string}>(filterKey));
  const [creating, setCreating] = useState(!!readRoomLocal(roomCreationKey(me.id, pid)));
  const [query, setQuery] = useState(storedFilter.current?.query ?? '');
  const [filter, setFilter] = useState(storedFilter.current?.filter ?? 'all');
  useEffect(() => { saveRoomLocal(filterKey, { query, filter }); }, [query, filter, filterKey]);
  const failure = (cause: unknown): void => { if (cause instanceof ApiError && [401, 403].includes(cause.status)) { clearRoomLocal(me.id, pid); setResult(null); setCreating(false); nav('/'); } };
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      if (document.hidden) return;
      try {
        const next = await roomsApi.list(pid, controller.signal);
        if (active) {
          setResult((current) => {
            if (!current) return next;
            const byId = new Map(next.rooms.map((room) => [room.room.id, room]));
            const ordered = current.rooms.flatMap((room) => { const value = byId.get(room.room.id); byId.delete(room.room.id); return value ? [value] : []; });
            return { ...next, rooms: [...ordered, ...byId.values()] };
          });
          setError('');
        }
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { failure(cause); return; }
        setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed'));
      } finally { if (active) timer = setTimeout(() => void load(), 10000); }
    };
    const wake = (): void => { if (!document.hidden) { clearTimeout(timer); void load(); } };
    void load();
    void api<Project>(`/api/projects/${pid}`, 'GET', undefined, { signal: controller.signal }).then((value) => { if (active) setProject(value); }).catch(() => {});
    document.addEventListener('visibilitychange', wake);
    return () => { active = false; controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', wake); };
  }, [pid, refresh]);

  const needsAction = (state: string | undefined): boolean => ['waiting_user', 'exhausted', 'interrupted'].includes(state ?? '');
  const all = result?.rooms ?? [];
  const rooms = all.filter((item) => {
    const state = item.mission?.state ?? 'draft';
    if (filter === 'archived' ? item.room.status !== 'archived' : item.room.status === 'archived') return false;
    if (filter === 'active' && ['draft', 'completed', 'stopped'].includes(state)) return false;
    if (filter === 'attention' && !needsAction(state)) return false;
    if (filter === 'completed' && state !== 'completed') return false;
    return `${item.room.title} ${item.goal?.request ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  });
  const attention = all.filter((item) => item.room.status === 'active' && needsAction(item.mission?.state));
  return <div class="fullcol room-view" ref={listRef} onScroll={event => { if (scrollRestored.current) saveRoomLocal(scrollKey, event.currentTarget.scrollTop); }}>
    <header class="room-page-header"><div class="room-header-copy"><a class="room-breadcrumb" href={`#/p/${pid}`}>{project?.name ?? t('rooms.project')}</a><h1>{t('rooms.rooms')}</h1><p>{t('rooms.intro')}</p></div>
      <button class="btn primary" onClick={() => setCreating(true)} disabled={!result?.canWrite || !!error}>{t('rooms.create')}</button></header>
    <main class="room-list-content">
      {error && <div class="room-notice room-error" role="alert">{error}<button class="btn" onClick={() => setRefresh((value) => value + 1)}>{t('rooms.refresh')}</button></div>}
      {result && !result.runtime.configured && <div class="room-notice"><span>{t('rooms.createWithMembersHint')}</span></div>}
      {attention.length > 0 && <div class="room-attention"><div><b>{t('rooms.attention')}</b><p>{attention.map((item) => item.room.title).slice(0, 3).join(' · ')}</p></div>
        <button class="btn" onClick={() => { setFilter('attention'); setQuery(''); }}>{t('rooms.respond')}</button></div>}
      <div class="room-filters"><div class="room-filter-list">{(['all', 'active', 'attention', 'completed', 'archived'] as const).map((key) =>
        <button class={`room-filter${filter === key ? ' selected' : ''}`} aria-pressed={filter === key} onClick={() => setFilter(key)} key={key}>{t(`rooms.${key}`)}</button>)}</div>
        <input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} aria-label={t('rooms.search')} placeholder={t('rooms.search')} /></div>
      {!result && !error && <div class="room-loading" role="status">{t('common.loading')}</div>}
      {result && rooms.length === 0 && <div class="room-empty"><h2>{t(query || filter !== 'all' ? 'rooms.noMatches' : 'rooms.noRoom')}</h2>
        {query || filter !== 'all' ? <button class="btn" onClick={() => { setQuery(''); setFilter('all'); }}>{t('rooms.clearSearch')}</button>
          : <button class="btn primary" onClick={() => setCreating(true)} disabled={!result.canWrite}>{t('rooms.create')}</button>}</div>}
      <div class="room-card-grid">{rooms.map((item) => <article class="room-card" key={item.room.id}>
        <div class="room-row room-between"><RoomStatus state={item.mission?.state ?? 'draft'} /><time dateTime={new Date(item.room.updatedAt).toISOString()}>{formatRelativeTime(item.room.updatedAt)}</time></div>
        <h2><a href={`#${roomPath(pid, item.room.id)}`}>{item.room.title}</a></h2><p class="room-card-goal">{item.goal?.request}</p>
        <div class="room-card-artifact">{item.latestArtifact ? <><span aria-hidden="true">▤</span><span>{item.latestArtifact.title}</span><small>{t('rooms.versionLabel', { version: formatNumber(item.latestArtifact.version) })}</small></> : <span class="room-muted">{t('rooms.noArtifact')}</span>}</div>
        <footer class="room-row room-between"><span class="room-team-count">{t('rooms.team')} · {formatNumber(item.memberCount)}</span><span>{t('rooms.roundUsage', { used: formatNumber(item.mission?.round ?? 0), limit: formatNumber(item.mission?.budget.limits.rounds ?? result?.defaults.rounds ?? DEFAULT_ROOM_BUDGET.rounds) })}</span></footer>
      </article>)}</div>
    </main>
    {creating && result && <CreateRoom pid={pid} userId={me.id} onFailure={failure} writable={result.canWrite} configured={result.runtime.configured} defaults={result.defaults} onClose={() => setCreating(false)} onCreated={(snapshot) => { setCreating(false); nav(roomPath(pid, snapshot.room.id)); }} />}
  </div>;
}

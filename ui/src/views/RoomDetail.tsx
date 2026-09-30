import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useI18n } from '../i18n/provider';
import { ApiError } from '../lib/api';
import { nav, type RoomPanelRoute } from '../lib/router';
import { RoomIcon } from '../components/RoomIcon';
import { useRoomAnswer } from '../lib/room-answer';
import { RoomDialog } from '../components/RoomDialog';
import { acceptRoomSnapshot, mergeRoomView, clearRoomLocal, type RoomCommandTarget, readRoomDraft, roomPath, roomRequestKey, roomsApi, saveRoomDraft } from '../lib/rooms-api';
import { RoomAvatar, RoomStatus, ROOM_PHASE_KEYS, memberLabel, memberActivityKey } from './room-presenters';
import { RoomSidebar } from './RoomSidebar';
import { RoomMembersManager } from './RoomMembers';
import { RoomMessages } from './RoomConversation';
import { RoomArtifactPanel, RoomControlPanel, RoomMemberPanel, type RoomControl } from './RoomPanels';
import type { Me } from '../lib/types';
import type { RoomBudgetLimits, RoomCommand, RoomCommandInput, RoomSnapshot } from '../../../shared/rooms';
import './rooms.css';
import './room-chat.css';
import './room-members.css';

export interface RoomDetailProps {
  pid: number; rid: string; me: Me; artifactId?: string; artifactVersion?: number; memberId?: string; panel?: RoomPanelRoute;
}
export function RoomDetailView({ pid, rid, me, artifactId, artifactVersion, memberId, panel }: RoomDetailProps) {
  const { t, formatNumber, formatDateTime, formatList, locale } = useI18n();
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const current = useRef<RoomSnapshot | null>(null);
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(true);
  const [confirmedAt, setConfirmedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const [draft, setDraft] = useState(() => readRoomDraft(me.id, pid, rid));
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [overlay, setOverlay] = useState(false);
  const [mention, setMention] = useState(false);
  const mentionStart = useRef<number | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const focusAfterDrawerClose = useRef(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [artifactError, setArtifactError] = useState('');
  const [artifactReload, setArtifactReload] = useState(0);
  const [control, setControl] = useState<RoomControl | null>(null);
  const [more, setMore] = useState(false);
  const [manageMemberId, setManageMemberId] = useState<string>();
  type WorkspaceTab = 'discussion' | 'goal' | 'artifacts' | 'sources';
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(artifactId ? 'artifacts' : panel === 'goal' || panel === 'artifacts' || panel === 'sources' ? panel : 'discussion');
  const returnQuery = useRef('');
  useEffect(() => {
    if (artifactId) setWorkspaceTab('artifacts');
    else if (panel === 'goal' || panel === 'artifacts' || panel === 'sources') setWorkspaceTab(panel);
    else if (!memberId && panel !== 'team' && panel !== 'budget') setWorkspaceTab('discussion');
  }, [panel, artifactId, memberId]);
  const [newMessages, setNewMessages] = useState(0);
  const [announcedMessages, setAnnouncedMessages] = useState(0);
  const feedRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const atBottom = useRef(true);
  const rememberPosition = (): void => {
    const feed = feedRef.current;
    if (!feed || !feed.offsetParent) return;
    atBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 96;
    const top = feed.getBoundingClientRect().top;
    const first = [...feed.querySelectorAll<HTMLElement>('[data-message-id]')].find(node => node.getBoundingClientRect().bottom > top);
    anchor.current = first ? { id: first.id, offset: first.getBoundingClientRect().top - top } : null;
  };
  const scrollToEnd = useRef(true);
  const refresh = useRef<() => void>(() => {});
  const mutation = useRef<{ fingerprint: string; key: string; expectedVersion: number } | null>(null);

  const applySnapshot = (next: RoomSnapshot): void => {
    if (!alive.current || !acceptRoomSnapshot(pid, rid, current.current, next)) return;
    next = mergeRoomView(current.current, next);
    const previous = current.current;
    const feed = feedRef.current;
    const atEnd = !feed ? true : !feed.offsetParent ? atBottom.current : feed.scrollHeight - feed.scrollTop - feed.clientHeight < 96;
    if (previous) rememberPosition();
    const oldSeq = previous?.contributions.reduce((max, item) => Math.max(max, item.seq), 0) ?? 0;
    const added = next.contributions.filter((item) => item.seq > oldSeq).length;
    if (previous && added) setAnnouncedMessages(added);
    if (!previous || atEnd) scrollToEnd.current = true;
    else if (added) setNewMessages((value) => value + added);
    current.current = next; setSnapshot(next); setConnected(true); setConfirmedAt(Date.now()); setError('');
    if (!draftRef.current.text && next.mission && (draftRef.current.missionId !== next.mission.id || draftRef.current.goalRevision !== next.mission.goalRevision)) setDraft(value => ({ ...value, missionId: next.mission!.id, goalRevision: next.mission!.goalRevision, clientMessageId: roomRequestKey() }));
    if (!draftRef.current.recipient) {
      setDraft(value => ({ ...value, recipient: 'all' }));
    }
  };
  const applyRef = useRef(applySnapshot);
  applyRef.current = applySnapshot;
  const handleFailure = (cause: unknown): void => {
    if (!alive.current) return;
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) {
      current.current = null; setSnapshot(null); setControl(null); setMore(false);
      alive.current = false; clearRoomLocal(me.id, pid, cause.status === 404 ? rid : undefined);
      nav(cause.status === 404 ? roomPath(pid) : '/'); return;
    }
    if (cause instanceof ApiError && cause.status === 0) setConnected(false);
    setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed'));
  };
  const failureRef = useRef(handleFailure);
  failureRef.current = handleFailure;

  const answer = useRoomAnswer({ pid, rid, userId: me.id, snapshot, connected, onSnapshot: applySnapshot, onFailure: handleFailure });

  useEffect(() => {
    alive.current = true;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let sequence = 0;
    const load = async (): Promise<void> => {
      clearTimeout(timer);
      if (!alive.current || document.hidden) return;
      const request = ++sequence;
      controller?.abort(); controller = new AbortController();
      try {
        const next = await roomsApi.view(pid, rid, controller.signal);
        if (alive.current && request === sequence) applyRef.current(next);
      } catch (cause) { if (alive.current && request === sequence) failureRef.current(cause); }
      finally { if (alive.current && request === sequence) timer = setTimeout(() => void load(), 3000); }
    };
    refresh.current = () => void load();
    const visible = (): void => { if (!document.hidden) void load(); else { clearTimeout(timer); ++sequence; controller?.abort(); } };
    const offline = (): void => { setConnected(false); clearTimeout(timer); ++sequence; controller?.abort(); };
    const online = (): void => { void load(); };
    void load();
    document.addEventListener('visibilitychange', visible); window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { alive.current = false; ++sequence; controller?.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, [pid, rid, me.id]);
  useEffect(() => { saveRoomDraft(me.id, pid, rid, draft); }, [draft, me.id, pid, rid]);
  const selectedVersion = snapshot?.artifacts.find(item => item.id === artifactId)?.currentVersion;
  useEffect(() => {
    if (!artifactId) return;
    const controller = new AbortController();
    setArtifactError('');
    void roomsApi.artifact(pid, rid, artifactId, controller.signal).then(({ artifact }) => {
      if (controller.signal.aborted || !alive.current || !current.current) return;
      const value = current.current;
      applyRef.current({ ...value, artifacts: value.artifacts.map(item => item.id === artifactId ? { ...item, versions: item.versions.map(version => artifact.versions.find(loaded => loaded.version === version.version) ?? version) } : item) });
    }).catch(cause => { if (!controller.signal.aborted) { setArtifactError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); failureRef.current(cause); } });
    return () => controller.abort();
  }, [pid, rid, artifactId, selectedVersion, artifactReload]);
  const loadHistory = async (): Promise<void> => {
    const value = current.current;
    if (!value?.history?.hasMore || !value.history.beforeSeq || loadingHistory) return;
    setLoadingHistory(true);
    try {
      const result = await roomsApi.history(pid, rid, value.history.beforeSeq);
      if (!alive.current || !current.current) return;
      const now = current.current;
      applyRef.current({ ...now, contributions: [...new Map([...result.contributions, ...now.contributions].map(item => [item.id, item])).values()].sort((a, b) => a.seq - b.seq), history: { hasMore: result.hasMore, beforeSeq: result.beforeSeq } });
    } catch (cause) { failureRef.current(cause); }
    finally { if (alive.current) setLoadingHistory(false); }
  };

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (!feed || !feed.offsetParent) return;
    if (scrollToEnd.current) {
      feed.scrollTop = feed.scrollHeight; scrollToEnd.current = false; setNewMessages(0);
    } else if (anchor.current) {
      const node = document.getElementById(anchor.current.id);
      if (node && feed.contains(node)) feed.scrollTop += node.getBoundingClientRect().top - feed.getBoundingClientRect().top - anchor.current.offset;
    }
    rememberPosition();
  }, [snapshot, panel, artifactId, memberId, overlay, workspaceTab]);
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const resize = (): void => {
      const viewport = window.visualViewport;
      const viewportBottom = (viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0);
      const parentBottom = layout.parentElement?.getBoundingClientRect().bottom ?? viewportBottom;
      const available = Math.max(180, Math.min(viewportBottom, parentBottom) - layout.getBoundingClientRect().top);
      layout.style.setProperty('--room-viewport-height', `${available}px`);
      setOverlay(layout.clientWidth < 940);
      if (atBottom.current && feedRef.current?.offsetParent) feedRef.current.scrollTop = feedRef.current.scrollHeight;
    };
    resize();
    const observer = new ResizeObserver(resize); observer.observe(layout);
    window.addEventListener('resize', resize); window.visualViewport?.addEventListener('resize', resize); window.visualViewport?.addEventListener('scroll', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('resize', resize); window.visualViewport?.removeEventListener('scroll', resize); };
  }, [!!snapshot]);

  const command = async (cmd: RoomCommand, fields: Omit<RoomCommandInput, 'expectedVersion'> = {}, target?: RoomCommandTarget): Promise<boolean> => {
    const value = current.current;
    if (!value?.mission || busyRef.current || !connected) return false;
    if (target && target.missionId !== value.mission.id) { setError(t('rooms.missionChanged')); return false; }
    const expectedVersion = target?.expectedVersion ?? value.mission.version;
    const fingerprint = JSON.stringify({ mission: value.mission.id, cmd, fields, expectedVersion });
    if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, key: roomRequestKey(), expectedVersion };
    busyRef.current = true; setBusy(true);
    try {
      const next = await roomsApi.command(pid, rid, value.mission.id, cmd, { ...fields, expectedVersion: mutation.current.expectedVersion }, mutation.current.key);
      applyRef.current(next); mutation.current = null; return true;
    } catch (cause) {
      failureRef.current(cause);
      if (cause instanceof ApiError && cause.status > 0 && cause.status < 500) mutation.current = null;
      refresh.current(); return false;
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const newGoal = async (request: string, criteria: string[], budget: RoomBudgetLimits): Promise<boolean> => {
    if (busyRef.current || !connected) return false;
    const fields = { request, criteria, budget, locale };
    const fingerprint = JSON.stringify({ kind: 'newGoal', fields });
    if (mutation.current?.fingerprint !== fingerprint) mutation.current = { fingerprint, key: roomRequestKey(), expectedVersion: 0 };
    busyRef.current = true; setBusy(true);
    try { applyRef.current(await roomsApi.newMission(pid, rid, fields, mutation.current.key)); mutation.current = null; return true; }
    catch (cause) { failureRef.current(cause); return false; }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  const send = async (): Promise<void> => {
    const value = draftRef.current;
    const snap = current.current;
    if (sendingRef.current || !value.text.trim() || !connected || !snap?.capabilities.canContribute || value.missionId !== snap.mission?.id || value.goalRevision !== snap.mission?.goalRevision) return;
    const recipient = value.recipient || 'all';
    if (recipient !== 'all' && !snap.members.some(member => member.id === recipient && member.status === 'active')) { setError(t('rooms.recipientRemoved')); return; }
    sendingRef.current = true; setSending(true);
    try {
      const next = await roomsApi.contribute(pid, rid, { text: value.text, clientMessageId: value.clientMessageId,
        missionId: value.missionId, goalRevision: value.goalRevision,
        audience: recipient === 'all' ? { kind: 'room' } : { kind: 'members', memberIds: [recipient] } });
      applyRef.current(next);
      if (alive.current) {
        setDraft((now) => now.clientMessageId === value.clientMessageId ? { ...now, text: '', clientMessageId: roomRequestKey() } : now);
      }
    } catch (cause) { failureRef.current(cause); }
    finally { sendingRef.current = false; if (alive.current) setSending(false); }
  };
  const drawerOpen = !!(memberId || panel === 'team' || panel === 'budget');
  useLayoutEffect(() => {
    if (!drawerOpen && focusAfterDrawerClose.current) {
      focusAfterDrawerClose.current = false;
      requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    }
  }, [drawerOpen]);
  const goPanel = (query: string): void => { rememberPosition(); nav(`${roomPath(pid, rid)}${query}`, { replace: drawerOpen }); };
  const closePanel = (): void => goPanel(drawerOpen ? returnQuery.current || (workspaceTab === 'discussion' ? '' : `?panel=${workspaceTab}`) : '');
  const openArtifact = (id: string, version: number): void => goPanel(`?artifact=${encodeURIComponent(id)}&version=${version}`);
  const openMember = (id: string): void => { if (!drawerOpen) returnQuery.current = location.hash.split('?')[1] ? `?${location.hash.split('?')[1]}` : ''; goPanel(`?member=${encodeURIComponent(id)}`); };
  const openSidebar = (next: RoomPanelRoute): void => {
    if (next === 'team' || next === 'budget') { if (!drawerOpen) returnQuery.current = location.hash.split('?')[1] ? `?${location.hash.split('?')[1]}` : ''; }
    goPanel(`?panel=${next}`);
  };
  const openWorkspace = (tab: WorkspaceTab): void => { rememberPosition(); setWorkspaceTab(tab); goPanel(tab === 'discussion' ? '' : `?panel=${tab}`); };
  const focusComposer = (): void => { requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true })); };
  const selectRecipient = (id: string): void => {
    if (answer.pending || answer.uncertain) return;
    answer.leave();
    setDraft(value => ({ ...value, recipient: id, text: mentionStart.current === null ? value.text : value.text.slice(0, mentionStart.current), clientMessageId: roomRequestKey() }));
    mentionStart.current = null; setMention(false); focusComposer();
  };
  const archive = async (): Promise<void> => {
    if (!snapshot || !connected || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try { applyRef.current(await roomsApi.archive(pid, rid, snapshot.room.version, roomRequestKey())); setMore(false); }
    catch (cause) { failureRef.current(cause); }
    finally { busyRef.current = false; if (alive.current) setBusy(false); }
  };
  if (!snapshot) return <div class="fullcol room-view"><header class="room-page-header"><a href={`#${roomPath(pid)}`}>{t('rooms.rooms')}</a></header>
    <main class="room-empty">{error ? <><p class="room-error" role="alert">{error}</p><button class="btn" onClick={() => refresh.current()}>{t('rooms.refresh')}</button></> : <p role="status">{t('common.loading')}</p>}</main></div>;
  const { room, mission, goal, members, artifacts, capabilities } = snapshot;
  const readOnly = !Object.values(capabilities).some(Boolean);
  const disabled = !connected || busy || room.status === 'archived' || readOnly;
  const selectedArtifact = artifacts.find((item) => item.id === artifactId);
  const selectedMember = members.find((member) => member.id === memberId);
  const draftStale = !!draft.text && (draft.missionId !== mission?.id || draft.goalRevision !== mission?.goalRevision);
  const closed = mission?.state === 'completed' || mission?.state === 'stopped';
  const action = capabilities.canStart ? 'start' : capabilities.canResume ? 'resume' : capabilities.canPause ? 'pause' : null;
  const attention = mission && ['waiting_user', 'exhausted', 'interrupted'].includes(mission.state);

  const activeMembers = members.filter(member => member.status === 'active');
  const recipientRemoved = !!draft.recipient && draft.recipient !== 'all' && !activeMembers.some(member => member.id === draft.recipient);
  const missingRoles = (['writer', 'reviewer'] as const).filter(role => !activeMembers.some(member => member.role === role));
  const coach = activeMembers.find(member => member.role === 'coach');
  const canSubmit = answer.mode ? answer.canSend && !busy : !disabled && !sending && !draftStale && !recipientRemoved && capabilities.canContribute && !!draft.text.trim();
  const submit = (): void => { if (canSubmit) { if (answer.mode) void answer.submit(); else void send(); } };
  const workspaceTabs = ['discussion', 'goal', 'artifacts', 'sources'] as const;
  return <div ref={layoutRef} class={`fullcol room-view room-detail room-chat-layout${overlay ? ' room-compact' : ''}`}>
    <header class="room-chat-header">
      <a class="room-icon-button" href={`#${roomPath(pid)}`} aria-label={t('rooms.rooms')}><RoomIcon name="back" /></a>
      <div class="room-chat-title"><h1 title={room.title}>{room.title}</h1><RoomStatus state={mission?.state ?? 'draft'} />{room.status === 'archived' && <span class="room-status">{t('rooms.archived')}</span>}</div>
      <div class="room-header-actions">{action && <button class={`btn${action !== 'pause' && !attention ? ' primary' : ''}`} disabled={disabled || answer.pending || action !== 'pause' && !!missingRoles.length || action === 'start' && snapshot.runtime?.configured === false} onClick={() => action === 'resume' && mission?.reasonCode === 'no_progress' ? setControl('guidance') : void command(action)}>{t(`rooms.${action}`)}</button>}
        <button class="room-icon-button room-mobile-panels" aria-label={t('rooms.manageMembers')} aria-expanded={panel === 'team'} onClick={() => openSidebar('team')}><RoomIcon name="team" /></button>
        <button class="room-icon-button" onClick={() => setMore(true)} aria-label={t('rooms.more')}><RoomIcon name="more" /></button></div>
    </header>
    <nav class="room-workspace-tabs" role="tablist" aria-label={t('rooms.chatPanels')}>{workspaceTabs.map(tab => <button type="button" key={tab} role="tab" id={`room-tab-${tab}`} aria-selected={workspaceTab === tab} aria-controls={`room-panel-${tab}`} onClick={() => openWorkspace(tab)} onKeyDown={event => { const index = workspaceTabs.indexOf(tab); const next = event.key === 'ArrowRight' ? (index + 1) % 4 : event.key === 'ArrowLeft' ? (index + 3) % 4 : event.key === 'Home' ? 0 : event.key === 'End' ? 3 : null; if (next !== null) { event.preventDefault(); openWorkspace(workspaceTabs[next]); document.getElementById(`room-tab-${workspaceTabs[next]}`)?.focus(); } }} tabIndex={workspaceTab === tab ? 0 : -1}>{tab !== 'discussion' && <RoomIcon name={tab} />}<span>{t(tab === 'sources' ? 'rooms.chatSources' : `rooms.${tab}`)}</span>{tab === 'artifacts' && artifacts.length > 0 && <small>{formatNumber(artifacts.length)}</small>}</button>)}</nav>
    {snapshot.runtime?.configured === false && <div class="room-notice room-chat-notice"><span>{t('rooms.memberRuntimeMissing')}</span><button class="linkbtn" onClick={() => openSidebar('team')}>{t('rooms.manageMembers')}</button></div>}
    {!!missingRoles.length && <div class="room-notice room-chat-notice"><span>{t('rooms.missingRoles', { roles: formatList(missingRoles.map(role => t(`rooms.${role}`))) })}</span><button class="linkbtn" onClick={() => openSidebar('team')}>{t('rooms.manageMembers')}</button></div>}
    {(!connected || error) && <div class="room-notice room-error room-chat-notice" role="alert"><span title={confirmedAt ? t('rooms.updatedAt', { time: formatDateTime(confirmedAt) }) : undefined}>{!connected ? t('rooms.offlineHint') : error}</span><button class="linkbtn" onClick={() => refresh.current()}>{t(connected ? 'rooms.refresh' : 'rooms.reconnect')}</button></div>}
    {mission?.state === 'exhausted' && <div class="room-notice room-chat-notice"><span>{t('rooms.limitHint')}</span><button class="linkbtn" disabled={disabled || !capabilities.canAddBudget} onClick={() => setControl('budget')}>{t('rooms.addBudget')}</button></div>}
    {mission?.state === 'interrupted' && <div class="room-notice room-chat-notice"><span>{t(mission.reasonCode === 'not_configured' ? 'rooms.memberRuntimeMissing' : mission.reasonCode === 'no_progress' ? 'rooms.noProgress' : 'rooms.errorHint')}</span><button class="linkbtn" disabled={disabled || !capabilities.canResume} onClick={() => mission.reasonCode === 'no_progress' ? setControl('guidance') : void command('resume')}>{t('rooms.retry')}</button></div>}
    <span class="sr-only" role="status" aria-live="polite">{announcedMessages ? t('rooms.newMessages', { count: announcedMessages }) : ''}</span>
    <main class="room-chat-main">
      <section class="room-conversation" id="room-panel-discussion" role="tabpanel" aria-labelledby="room-tab-discussion" hidden={workspaceTab !== 'discussion'}>
        <div class="room-feed-wrap"><div class="room-feed" ref={feedRef} onScroll={() => { rememberPosition(); if (atBottom.current) setNewMessages(0); }}>
          {snapshot.history?.hasMore && <button class="btn room-history-load" disabled={loadingHistory || !connected} onClick={() => void loadHistory()}>{t(loadingHistory ? 'common.loading' : 'rooms.loadHistory')}</button>}
          <RoomMessages snapshot={snapshot} userId={me.id} answer={answer} disabled={disabled || !capabilities.canContribute} onArtifact={openArtifact} onReply={focusComposer} />
        </div>{newMessages > 0 && <button class="room-new-messages" aria-live="polite" onClick={() => { if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight; setNewMessages(0); rememberPosition(); }}><RoomIcon name="down" />{t('rooms.newMessages', { count: newMessages })}</button>}</div>
        {!answer.mode && draftStale && <div class="room-notice room-draft-warning"><p>{t('rooms.draftScopeChanged')}</p><button class="btn" onClick={() => setDraft(value => ({ ...value, missionId: mission?.id, goalRevision: mission?.goalRevision, clientMessageId: roomRequestKey() }))}>{t('rooms.useDraftHere')}</button><button class="btn" onClick={() => setDraft(value => ({ ...value, text: '', missionId: mission?.id, goalRevision: mission?.goalRevision, clientMessageId: roomRequestKey() }))}>{t('rooms.discardDraft')}</button></div>}
        <form class={`room-composer${answer.mode ? ' room-composer-reply' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
          <div class="room-composer-context">{answer.mode ? <><span class="room-reply-context">{t('rooms.chatReplyingTo', { name: coach ? memberLabel(coach, t) : t('rooms.chatModerator') })}</span><button type="button" class="room-icon-button" disabled={answer.pending || answer.uncertain} aria-label={t('rooms.chatExitReply')} onClick={() => answer.leave()}>×</button></> : <label class="room-recipient"><span>{t('rooms.recipient')}</span><select value={draft.recipient || 'all'} disabled={sending || !capabilities.canContribute} onChange={event => selectRecipient(event.currentTarget.value)}><option value="all">{t('rooms.everyone')}</option>{recipientRemoved && <option value={draft.recipient} disabled>{members.find(member => member.id === draft.recipient)?.displayName || t('rooms.memberRemoved')} · {t('rooms.memberRemoved')}</option>}{members.filter(member => member.status === 'active').map(member => <option key={member.id} value={member.id}>{memberLabel(member, t)}</option>)}</select></label>}</div>
          {!answer.mode && recipientRemoved && <p class="room-answer-warning" role="alert">{t('rooms.recipientRemoved')}</p>}
          {answer.mode && answer.uncertain && <p class="room-answer-warning" role="status">{t('rooms.chatAnswerPending')}</p>}
          {answer.mode && answer.stale && !answer.uncertain && <div class="room-answer-warning" role="alert"><span>{t('rooms.chatAnswerChanged')}</span>{mission?.state === 'waiting_user' && mission.question && <button type="button" class="linkbtn" onClick={() => { if (mission.question?.id === answer.questionId) answer.rebase(); else answer.begin(); }}>{t('rooms.chatRebaseAnswer')}</button>}</div>}
          {answer.mode && answer.option && <div class="room-selected-answer">{answer.option}</div>}
          <textarea ref={composerRef} value={answer.mode ? answer.text : draft.text} rows={2} maxLength={8000} aria-label={t(answer.mode ? 'rooms.chatSendReply' : 'rooms.discussion')} placeholder={t(answer.mode ? 'rooms.chatAnswerPlaceholder' : 'rooms.chatMessagePlaceholder')} disabled={answer.mode ? answer.pending || answer.uncertain || !capabilities.canContribute : !capabilities.canContribute || sending}
            onInput={event => { const text = event.currentTarget.value; if (answer.mode) answer.setText(text); else { setDraft(value => ({ ...value, text, clientMessageId: roomRequestKey() })); const match = /(?:^|\s)@[^\s@]*$/.exec(text); mentionStart.current = match ? text.lastIndexOf('@') : null; setMention(!!match); } }}
            onKeyDown={event => { if (event.key === 'Escape' && mention) { event.preventDefault(); event.stopPropagation(); setMention(false); } if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submit(); } }} />
          {mention && !answer.mode && <div class="room-mention-menu" role="listbox" aria-label={t('rooms.chatChooseRecipient')}><button type="button" role="option" aria-selected={draft.recipient === 'all'} onClick={() => selectRecipient('all')}>{t('rooms.everyone')}</button>{members.filter(member => member.status === 'active').map(member => <button type="button" key={member.id} role="option" aria-selected={draft.recipient === member.id} onClick={() => selectRecipient(member.id)}><RoomAvatar member={member} />{memberLabel(member, t)}</button>)}</div>}
          <div class="room-composer-bottom"><div class="room-composer-tools">{!answer.mode && <button type="button" class="room-icon-button room-mention-trigger" aria-label={t('rooms.chatChooseRecipient')} aria-expanded={mention} disabled={!capabilities.canContribute} onClick={() => { mentionStart.current = null; setMention(value => !value); }}>@</button>}<button type="button" class="room-icon-button" aria-label={t('rooms.chatAddReference')} onClick={() => openSidebar('sources')}><RoomIcon name="plus" /></button><span class="room-send-shortcut">{t('rooms.chatSendShortcut')}</span></div><button type="submit" class="btn primary room-send-button" disabled={!canSubmit}><span>{t(answer.pending || sending ? 'rooms.sending' : answer.mode ? answer.uncertain ? 'rooms.chatRetryAnswer' : 'rooms.chatSendReply' : 'rooms.send')}</span><RoomIcon name="send" /></button></div>
          {!answer.mode && draft.recipient && draft.recipient !== 'all' && <p class="room-directed-hint">{t('rooms.chatDirectedHint')}</p>}
        </form>
        <footer class="room-chat-status"><span>{room.status === 'archived' || readOnly ? t('rooms.readonly') : mission?.state === 'completed' ? t('rooms.formalAccepted') : mission?.state === 'quiescing' ? t('rooms.quiescing') : mission ? t(ROOM_PHASE_KEYS[mission.phase]) : t('rooms.formalOnly')}</span>{mission && <button type="button" class="linkbtn" onClick={() => openSidebar('budget')}>{t('rooms.roundUsage', { used: formatNumber(mission.round), limit: formatNumber(mission.budget.limits.rounds) })}</button>}</footer>
      </section>
      {workspaceTab !== 'discussion' && <section class="room-workspace-panel" role="tabpanel" id={`room-panel-${workspaceTab}`} aria-labelledby={`room-tab-${workspaceTab}`}>
        {selectedArtifact ? <><button class="linkbtn room-artifact-back" onClick={() => goPanel('?panel=artifacts')}>{t('rooms.chatBackArtifacts')}</button><RoomArtifactPanel embedded key={selectedArtifact.id} pid={pid} userId={me.id} snapshot={snapshot} artifact={selectedArtifact} version={artifactVersion ?? selectedArtifact.currentVersion} writable={!disabled && capabilities.canPublish} onSnapshot={applySnapshot} onFailure={handleFailure} loadError={artifactError} onReload={() => setArtifactReload(value => value + 1)} onVersion={version => openArtifact(selectedArtifact.id, version)} onClose={closePanel} /></>
          : artifactId ? <p>{t('rooms.notAvailable')}</p> : <RoomSidebar tab={workspaceTab} pid={pid} userId={me.id} snapshot={snapshot} disabled={disabled} onControl={setControl} onArtifact={openArtifact} onMember={openMember} onSnapshot={applySnapshot} onFailure={handleFailure} />}
      </section>}
      <aside class="room-roster" aria-label={t('rooms.memberRoster')}>
        <header><h2>{t('rooms.memberRoster')} <small>{formatNumber(activeMembers.length)}</small></h2><button type="button" class="linkbtn" onClick={() => { setManageMemberId(undefined); openSidebar('team'); }}>{t('rooms.manageMembers')}</button></header>
        <div class="room-roster-list">{activeMembers.map(member => <button type="button" class="room-roster-member" key={member.id} onClick={() => openMember(member.id)}><RoomAvatar member={member} /><span><b>{memberLabel(member, t)}</b><small>{member.role === 'coach' ? t('rooms.chatModerator') : t(`rooms.${member.role}`)} · {t(memberActivityKey(member))}</small></span><span class={`room-activity-dot ${member.activity?.state ?? 'idle'}`} aria-hidden="true" /></button>)}</div>
      </aside>
    </main>
    {panel === 'team' && <RoomDialog routed title={t('rooms.manageMembers')} wide className="room-members-dialog" onClose={closePanel}><RoomMembersManager key={rid} pid={pid} userId={me.id} snapshot={snapshot} writable={!disabled} focusMemberId={manageMemberId} onSnapshot={applySnapshot} onFailure={handleFailure} /></RoomDialog>}
    {panel === 'budget' && <RoomDialog routed title={t('rooms.budget')} onClose={closePanel}><RoomSidebar tab="budget" pid={pid} userId={me.id} snapshot={snapshot} disabled={disabled} onControl={kind => { closePanel(); setControl(kind); }} onArtifact={openArtifact} onMember={openMember} onSnapshot={applySnapshot} onFailure={handleFailure} /></RoomDialog>}
    {selectedMember && <RoomMemberPanel onManage={() => { setManageMemberId(selectedMember.id); goPanel('?panel=team'); }} pid={pid} member={selectedMember} snapshot={snapshot} writable={!disabled && capabilities.canPublish} onSnapshot={applySnapshot} onFailure={handleFailure} onClose={closePanel} onAsk={() => { if (answer.pending || answer.uncertain) return; selectRecipient(selectedMember.id); focusAfterDrawerClose.current = true; returnQuery.current = ''; setWorkspaceTab('discussion'); goPanel(''); }} />}
    {memberId && !selectedMember && <RoomDialog title={t('rooms.details')} onClose={closePanel}><p>{t('rooms.notAvailable')}</p></RoomDialog>}
    {more && <RoomDialog title={t('rooms.more')} onClose={() => setMore(false)}><div class="room-more-actions">
      <button class="btn" onClick={() => { setMore(false); openSidebar('team'); }}>{t('rooms.manageMembers')}</button><button class="btn" onClick={() => { setMore(false); openSidebar('budget'); }}>{t('rooms.budget')}</button>
      {capabilities.canEditGoal && <button class="btn" disabled={disabled} onClick={() => { setMore(false); setControl('goal'); }}>{t('rooms.changeGoal')}</button>}
      {capabilities.canAddBudget && <button class="btn" disabled={disabled} onClick={() => { setMore(false); setControl('budget'); }}>{t('rooms.addBudget')}</button>}
      {closed && room.status === 'active' && capabilities.canArchive && <button class="btn" disabled={disabled} onClick={() => { setMore(false); setControl('newGoal'); }}>{t('rooms.newGoal')}</button>}
      {capabilities.canArchive && <button class="btn" disabled={disabled} onClick={() => void archive()}>{t('rooms.archive')}</button>}
      {capabilities.canStop && <button class="btn room-danger" disabled={disabled} onClick={() => { setMore(false); setControl('stop'); }}>{t('rooms.stop')}</button>}
      <button class="btn" onClick={() => { setMore(false); refresh.current(); }}>{t('rooms.refresh')}</button></div></RoomDialog>}
    {control && <RoomControlPanel key={control} userId={me.id} kind={control} snapshot={snapshot} disabled={disabled} onCommand={command} onNewGoal={newGoal} onClose={() => setControl(null)} />}
  </div>;
}

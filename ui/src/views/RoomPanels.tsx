import { useEffect, useRef, useState } from 'preact/hooks';
import { RoomArtifactEditor } from './RoomResources';
import { RoomDialog, RoomPanelSurface } from '../components/RoomDialog';
import { Markdown } from '../components/Markdown';
import { useI18n } from '../i18n/provider';
import { ApiError, getProjectExecutorAgents } from '../lib/api';
import { publicationStorageKey, readRoomPublication, roomDiffLines, roomRequestKey, roomsApi, roomCanAdopt, roomEditableCriteria, roomCommandTarget, roomBudgetRemaining, roomBudgetIncrement, roomCriteriaValid, readRoomLocal, saveRoomLocal, type RoomCommandTarget, saveRoomPublication } from '../lib/rooms-api';
import { toast } from '../lib/toast';
import { RoomAvatar, memberLabel, memberActivityKey } from './room-presenters';
import { RoomBudgetFields, RoomGoalFields, criteriaLines } from './Rooms';
import type { AgentKind } from '../lib/types';
import type { RoomArtifact, RoomArtifactRef, RoomBudgetLimits, RoomCommand, RoomCommandInput, RoomIssueDraft, RoomMember, RoomSnapshot } from '../../../shared/rooms';
import { DEFAULT_ROOM_BUDGET } from '../../../shared/rooms';

export function RoomMemberPanel({ pid, member, snapshot, writable, onSnapshot, onFailure, onClose, embedded = false, onAsk, onManage }: { embedded?: boolean; onAsk?: () => void; onManage?: () => void; pid: number; member: RoomMember; snapshot: RoomSnapshot; writable: boolean; onSnapshot: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void; onClose: () => void }) {
  const { t } = useI18n();
  const task = snapshot.plans?.filter(plan => plan.missionId === snapshot.mission?.id && plan.goalRevision === snapshot.goal?.revision).flatMap(plan => plan.tasks).find(item => item.id === member.activity?.taskId);
  return <RoomPanelSurface embedded={embedded} title={memberLabel(member, t)} onClose={onClose}>
    <div class="room-member-heading"><RoomAvatar member={member} /><div><b>{t(`rooms.${member.role}`)}</b><p>{t('rooms.roomOnly')}</p></div></div>
    <p>{t(`rooms.memberRole.${member.role}`)}</p>
    <h3>{t('rooms.chatMemberTask')}</h3><p class="room-muted">{t(memberActivityKey(member))}</p>{task && <blockquote>{task.instruction}</blockquote>}
    {onAsk && <button class="btn primary" disabled={!snapshot.capabilities.canContribute || snapshot.room.status !== 'active' || member.status !== 'active'} onClick={onAsk}>{t('rooms.chatAskMember')}</button>}
    <details class="room-advanced"><summary>{t('rooms.details')}</summary><dl class="room-metadata"><dt>{t('rooms.memberId')}</dt><dd><code>{member.id}</code></dd>
      <dt>{t('rooms.configure')}</dt><dd><code>{member.modelProfile}</code></dd><dt>{t('rooms.address')}</dt><dd><code>{member.address}</code></dd></dl>
      <button class="btn" onClick={() => void navigator.clipboard.writeText(member.address).then(() => toast.success(t('rooms.copied'))).catch(() => toast.error(t('rooms.notAvailable')))}>{t('rooms.copy')}</button>
      <p class="room-muted">{t('rooms.bindingHint')}</p>
    </details>
    <p class="room-muted">{member.status === 'retired' ? t('rooms.memberRetired') : member.model ? `${member.model.provider === 'claude' ? 'Claude' : member.model.provider === 'codex' ? 'Codex' : 'DeepSeek'} · ${member.model.model} · ${t(member.model.provider === 'deepseek' ? 'rooms.modelApi' : 'rooms.localSession')}` : t('rooms.defaultModel')}</p>
    {onManage && member.status === 'active' && <button class="btn" onClick={onManage}>{t('rooms.memberSettings')}</button>}
  </RoomPanelSurface>;
}

export type RoomControl = 'goal' | 'budget' | 'stop' | 'newGoal' | 'guidance';
interface ControlDraft { request: string; criteria: string; answer: string; budget: RoomBudgetLimits; baseline: RoomArtifactRef[]; target: RoomCommandTarget | null }
export function RoomControlPanel({ userId, kind, snapshot, disabled, onCommand, onNewGoal, onClose }: {
  userId: number; kind: RoomControl; snapshot: RoomSnapshot; disabled: boolean;
  onCommand: (cmd: RoomCommand, fields?: Omit<RoomCommandInput, 'expectedVersion'>, target?: RoomCommandTarget) => Promise<boolean>;
  onNewGoal: (request: string, criteria: string[], budget: RoomBudgetLimits) => Promise<boolean>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const storageKey = useRef(`panda.rooms.control.${userId}.${snapshot.room.projectId}.${snapshot.room.id}.${snapshot.mission?.id}.${snapshot.mission?.goalRevision}.${kind}`).current;
  const recovered = useRef(readRoomLocal<ControlDraft>(storageKey));
  const retainDraft = useRef(kind !== 'stop');
  const [request, setRequest] = useState(recovered.current?.request ?? (kind === 'newGoal' ? '' : snapshot.goal?.request ?? ''));
  const [criteria, setCriteria] = useState(recovered.current?.criteria ?? (kind === 'newGoal' ? '' : roomEditableCriteria(snapshot.goal).join('\n')));
  const [answer, setAnswer] = useState(recovered.current?.answer ?? '');
  const [target, setTarget] = useState(() => recovered.current?.target ?? roomCommandTarget(snapshot));
  const currentTarget = roomCommandTarget(snapshot);
  const changed = kind !== 'newGoal' && !!target && (target.missionId !== currentTarget?.missionId || target.expectedVersion !== currentTarget.expectedVersion);
  const sameMission = target?.missionId === currentTarget?.missionId;
  const remaining = roomBudgetRemaining(snapshot.mission?.budget.limits ?? DEFAULT_ROOM_BUDGET);
  const [baseline, setBaseline] = useState(() => recovered.current?.baseline ?? snapshot.artifacts.filter(item => item.missionId === snapshot.mission?.id).map(item => ({ artifactId: item.id, version: item.currentVersion })));
  const [budget, setBudget] = useState<RoomBudgetLimits>(recovered.current?.budget ?? (kind === 'newGoal' ? DEFAULT_ROOM_BUDGET : { rounds: Math.min(2, remaining.rounds), modelRequests: Math.min(24, remaining.modelRequests), activeMs: Math.min(600000, Math.floor(remaining.activeMs / 60000) * 60000) }));
  useEffect(() => { if (retainDraft.current) saveRoomLocal(storageKey, { request, criteria, answer, target, baseline, budget }); }, [storageKey, request, criteria, answer, target, baseline, budget]);
  const [pending, setPending] = useState(false);
  const titleKey = { goal: 'rooms.changeGoal', budget: 'rooms.addBudget', stop: 'rooms.stop', newGoal: 'rooms.newGoal', guidance: 'rooms.addGuidance' } as const;
  const submit = async (): Promise<void> => {
    if (pending || disabled || changed || ((kind === 'goal' || kind === 'newGoal') && !roomCriteriaValid(criteriaLines(criteria)))) return;
    setPending(true);
    let success = false;
    try {
      if (kind === 'newGoal') success = await onNewGoal(request.trim(), criteriaLines(criteria), budget);
      else if (kind === 'goal') success = await onCommand('goal', { request: request.trim(), userCriteria: criteriaLines(criteria), baselineArtifactRefs: baseline }, target ?? undefined);
      else if (kind === 'budget') success = await onCommand('budget', { budget: roomBudgetIncrement(budget) }, target ?? undefined);
      else if (kind === 'guidance') success = await onCommand('resume', { guidance: answer.trim() }, target ?? undefined);
      else success = await onCommand('stop', {}, target ?? undefined);
      if (success) { retainDraft.current = false; saveRoomLocal(storageKey, null); onClose(); }
    } finally { setPending(false); }
  };
  return <RoomDialog title={t(titleKey[kind])} onClose={() => { if (!pending) onClose(); }}>
    <form class="room-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {changed && <section class="room-notice" role="alert"><p>{t(sameMission ? 'rooms.editConflict' : 'rooms.missionChanged')}</p><blockquote>{snapshot.goal?.request}</blockquote>
        {sameMission && <button type="button" class="btn" onClick={() => setTarget(roomCommandTarget(snapshot))}>{t('rooms.keepEdits')}</button>}</section>}
      {(kind === 'goal' || kind === 'newGoal') && <><p class="room-muted">{t(kind === 'goal' ? 'rooms.changeHint' : 'rooms.noHistory')}</p>
        {kind === 'goal' && <section class="room-goal-comparison"><b>{t('rooms.chatCurrentGoal')}</b><blockquote>{snapshot.goal?.request}</blockquote><b>{t('rooms.chatProposedGoal')}</b></section>}
        <RoomGoalFields request={request} criteria={criteria} onRequest={setRequest} onCriteria={setCriteria} />
        {!roomCriteriaValid(criteriaLines(criteria)) && <p class="room-error">{t('rooms.criteriaLimit')}</p>}
        {kind === 'goal' && snapshot.artifacts.filter(item => item.missionId === target?.missionId).length > 0 && <fieldset><legend>{t('rooms.baselineArtifacts')}</legend><p class="room-muted">{t('rooms.baselineHint')}</p>{snapshot.artifacts.filter(item => item.missionId === target?.missionId).map(item => <label class="room-row" key={item.id}><input type="checkbox" checked={baseline.some(ref => ref.artifactId === item.id)} onChange={(event) => setBaseline(event.currentTarget.checked ? [...baseline.filter(ref => ref.artifactId !== item.id), { artifactId: item.id, version: item.currentVersion }] : baseline.filter(ref => ref.artifactId !== item.id))} />{item.title} · {t('rooms.versionLabel', { version: baseline.find(ref => ref.artifactId === item.id)?.version ?? item.currentVersion })}</label>)}</fieldset>}</>}
      {(kind === 'budget' || kind === 'newGoal') && <><RoomBudgetFields value={budget} onChange={setBudget} incremental={kind === 'budget'} maximum={kind === 'budget' ? remaining : undefined} />
        {kind === 'budget' && <p class="room-notice">{t('rooms.resumeHint')}</p>}</>}
      {kind === 'guidance' && <label class="room-field"><span>{t('rooms.guidanceHint')}</span><textarea required rows={4} maxLength={8000} value={answer} onInput={(event) => setAnswer(event.currentTarget.value)} /></label>}
      {kind === 'stop' && <p class="room-notice">{t('rooms.stopHint')}</p>}
      <footer class="room-dialog-actions"><button type="button" class="btn" onClick={onClose} disabled={pending}>{t('common.cancel')}</button>
        <button type="submit" class={`btn ${kind === 'stop' ? 'room-danger' : 'primary'}`} disabled={disabled || pending || changed || kind === 'guidance' && !answer.trim() || (kind === 'goal' || kind === 'newGoal') && !roomCriteriaValid(criteriaLines(criteria)) || kind === 'budget' && !Object.values(budget).some((value) => value > 0)}>
          {pending ? t('common.loading') : t(kind === 'goal' ? 'rooms.confirmChange' : kind === 'budget' ? 'rooms.addAndResume' : kind === 'stop' ? 'rooms.stop' : kind === 'newGoal' ? 'rooms.saveDraft' : 'rooms.resume')}</button></footer>
    </form>
  </RoomDialog>;
}

function IssuePreview({ pid, userId, snapshot, draft: initial, disabled, onPublished, onFailure, onClose, embedded = false }: {
  embedded?: boolean;
  pid: number; userId: number; snapshot: RoomSnapshot; draft: RoomIssueDraft; disabled: boolean;
  onPublished: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const storageKey = publicationStorageKey(userId, pid, snapshot.room.id, initial.artifactId, initial.artifactVersion);
  const recovered = useRef(readRoomPublication(storageKey, initial.artifactId, initial.artifactVersion));
  const editKey = `${storageKey}.draft`;
  const [draft, setDraft] = useState(recovered.current?.draft ?? readRoomLocal<RoomIssueDraft>(editKey) ?? initial);
  const retainDraft = useRef(true);
  useEffect(() => { if (retainDraft.current) saveRoomLocal(editKey, draft); }, [draft, editKey]);
  const [agents, setAgents] = useState<AgentKind[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(!!recovered.current);
  const submission = useRef<{ fingerprint: string; key: string; version: number } | null>(recovered.current
    ? { fingerprint: JSON.stringify(recovered.current.draft), key: recovered.current.key, version: recovered.current.expectedVersion } : null);
  useEffect(() => {
    const controller = new AbortController();
    void getProjectExecutorAgents(pid, controller.signal).then(setAgents).catch(cause => { if (!controller.signal.aborted) onFailure(cause); });
    return () => controller.abort();
  }, [pid]);
  const publish = async (): Promise<void> => {
    if (pending || disabled || !snapshot.mission || !draft.title.trim() || draft.title.length > 200 || !draft.body.trim() || draft.body.length > 8000) return;
    const fingerprint = JSON.stringify(draft);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: roomRequestKey(), version: snapshot.mission.version };
    saveRoomPublication(storageKey, { draft, key: submission.current.key, expectedVersion: submission.current.version });
    setPending(true); setError('');
    try {
      const response = await roomsApi.publish(pid, snapshot.room.id, draft, submission.current.version, submission.current.key);
      saveRoomPublication(storageKey, null); retainDraft.current = false; saveRoomLocal(editKey, null); setUncertain(false);
      onPublished(response.snapshot); onClose(); toast.success(t('rooms.issueCreated'));
    } catch (cause) { if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) retainDraft.current = false; onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed'));
      if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500) setUncertain(true);
      else { submission.current = null; saveRoomPublication(storageKey, null); setUncertain(false); }
    } finally { setPending(false); }
  };
  return <RoomPanelSurface embedded={embedded} title={t('rooms.issuePreview')} onClose={() => { if (!pending) onClose(); }}>
    <form class="room-form" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
      {embedded && <h3>{t('rooms.issuePreview')}</h3>}
      <p class="room-notice">{t('rooms.issueHint')}</p>
      {uncertain && <p class="room-notice" role="status">{t('errors.rooms.publication_pending')}</p>}
      <label class="room-field"><span>{t('rooms.issueTitle')}</span><input required disabled={uncertain || pending} maxLength={200} value={draft.title} onInput={(event) => setDraft({ ...draft, title: event.currentTarget.value })} /></label>
      <label class="room-field"><span>{t('rooms.issueBody')}</span><textarea required disabled={uncertain || pending} rows={12} value={draft.body} aria-invalid={draft.body.length > 8000} aria-describedby="room-issue-length" onInput={(event) => setDraft({ ...draft, body: event.currentTarget.value })} /></label>
      <p class={draft.body.length > 8000 ? 'room-error' : 'room-muted'} id="room-issue-length">{t('rooms.bodyLength', { used: draft.body.length, limit: 8000 })}{draft.body.length > 8000 && <><br />{t('rooms.bodyTooLong')}</>}</p>
      <label class="room-field"><span>{t('rooms.executionAgent')}</span><select value={draft.agent ?? ''} disabled={uncertain || pending} required onChange={(event) => setDraft({ ...draft, agent: event.currentTarget.value as AgentKind })}>
        {[...new Set([...(draft.agent ? [draft.agent] : []), ...agents])].map((agent) => <option key={agent} value={agent}>{agent === 'claude' ? 'Claude' : 'Codex'}</option>)}
      </select></label>
      <p class="room-muted">{t('rooms.source')}: {snapshot.room.title} · {t('rooms.versionLabel', { version: draft.artifactVersion })}</p>
      {error && <p class="room-error" role="alert">{error}</p>}
      <footer class="room-dialog-actions"><button class="btn" type="button" disabled={pending} onClick={onClose}>{t('common.cancel')}</button>
        <button class="btn primary" type="submit" disabled={disabled || pending || !draft.agent || draft.title.length > 200 || draft.body.length > 8000}>{pending ? t('common.loading') : t(uncertain ? 'rooms.checkPublication' : 'rooms.publish')}</button></footer>
    </form>
  </RoomPanelSurface>;
}

export function RoomArtifactPanel({ pid, userId, snapshot, artifact, version, writable, onSnapshot, onFailure, onVersion, onClose, loadError, onReload, embedded = false }: {
  embedded?: boolean;
  pid: number; userId: number; snapshot: RoomSnapshot; artifact: RoomArtifact; version: number; writable: boolean;
  onSnapshot: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void; onVersion: (version: number) => void; onClose: () => void; loadError: string; onReload: () => void;
}) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const [compare, setCompare] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<RoomIssueDraft | null>(null);
  const selected = artifact.versions.find((item) => item.version === version);
  const previous = artifact.versions.filter((item) => item.version < version).sort((a, b) => b.version - a.version)[0];
  if (!selected) return <RoomPanelSurface embedded={embedded} title={artifact.title} onClose={onClose}><p>{t('rooms.notAvailable')}</p></RoomPanelSurface>;
  if (selected.contentLoaded === false) return <RoomPanelSurface embedded={embedded} title={artifact.title} onClose={onClose}>{loadError ? <><p class="room-error" role="alert">{loadError}</p><button class="btn" onClick={onReload}>{t('rooms.retry')}</button></> : <p role="status">{t('common.loading')}</p>}</RoomPanelSurface>;
  const oldGoal = artifact.missionId !== snapshot.mission?.id || selected.goalRevision !== snapshot.goal?.revision;
  const passed = roomCanAdopt(snapshot, artifact.id, version);
  const reviewGoal = snapshot.goals?.find(goal => goal.missionId === artifact.missionId && goal.revision === selected.goalRevision) ?? (snapshot.goal?.missionId === artifact.missionId && snapshot.goal.revision === selected.goalRevision ? snapshot.goal : null);
  const reviews = snapshot.assessments.filter((item) => item.artifactId === artifact.id && item.artifactVersion === version && item.goalRevision === selected.goalRevision);
  const download = (): void => {
    const blob = new Blob([selected.markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${selected.title.replace(/[\\/:*?"<>|]/g, '_')}-v${selected.version}.md`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const adopt = async (): Promise<void> => {
    setBusy(true); setError('');
    try { onSnapshot(await roomsApi.adopt(pid, snapshot.room.id, artifact.id, version, roomRequestKey())); }
    catch (cause) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    finally { setBusy(false); }
  };
  const preview = async (): Promise<void> => {
    setBusy(true); setError('');
    try { setDraft((await roomsApi.preview(pid, snapshot.room.id, artifact.id, version)).draft); }
    catch (cause) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    finally { setBusy(false); }
  };
  if (editing) return <RoomArtifactEditor embedded={embedded} pid={pid} userId={userId} snapshot={snapshot} artifact={artifact} selected={selected} writable={writable} onSnapshot={next => { onSnapshot(next); onVersion(next.artifacts.find(item => item.id === artifact.id)!.currentVersion); }} onFailure={onFailure} onClose={() => setEditing(false)} />;
  if (draft) return <IssuePreview embedded={embedded} pid={pid} userId={userId} snapshot={snapshot} draft={draft} disabled={!writable} onPublished={onSnapshot} onFailure={onFailure} onClose={() => setDraft(null)} />;
  return <RoomPanelSurface embedded={embedded} title={artifact.title} onClose={onClose} wide>
    <div class="room-artifact-toolbar"><label>{t('rooms.version')} <select value={version} onChange={(event) => onVersion(Number(event.currentTarget.value))}>
      {artifact.versions.map((item) => <option value={item.version} key={item.version}>{t('rooms.versionLabel', { version: formatNumber(item.version) })}</option>)}</select></label>
      <button class={`btn${compare ? ' selected' : ''}`} aria-pressed={compare} disabled={!previous} onClick={() => setCompare((value) => !value)}>{t('rooms.compare')}</button>
      <button class="btn" onClick={download}>{t('rooms.download')}</button>
      <button class="btn" disabled={!writable || artifact.missionId !== snapshot.mission?.id || version !== artifact.currentVersion || !['paused', 'completed'].includes(snapshot.mission?.state ?? '')} onClick={() => setEditing(true)}>{t('rooms.editArtifact')}</button>
    </div>
    {selected.authorType === 'user' && <p class="room-muted">{t('rooms.humanRevision')}</p>}
    {oldGoal && <p class="room-notice">{t('rooms.oldGoal')}</p>}
    {artifact.currentVersion > version && <p class="room-muted">{t('rooms.latest')}: <button class="linkbtn" onClick={() => onVersion(artifact.currentVersion)}>{t('rooms.versionLabel', { version: artifact.currentVersion })}</button></p>}
    <div class="room-document-layout"><article class="room-document">
      {compare && previous ? <div class="room-version-comparison"><p class="room-muted">{t('rooms.versionLabel', { version: previous.version })} → {t('rooms.versionLabel', { version })}</p>
        <pre class="room-diff">{roomDiffLines(previous.markdown, selected.markdown).map((line, index) => line.kind === 'added'
          ? <ins key={index}>+ {line.text}{'\n'}</ins> : line.kind === 'removed' ? <del key={index}>− {line.text}{'\n'}</del> : <span key={index}>{'  '}{line.text}{'\n'}</span>)}</pre></div> : <Markdown text={selected.markdown} />}
    </article><aside class="room-review-aside"><h3>{t('rooms.criteria')}</h3>
      {reviews.length ? reviews.map((assessment) => <div class="room-review" key={assessment.id}><b>{t(assessment.verdict === 'passed' ? 'rooms.passed' : 'rooms.needsRevision')}</b>
        <p>{reviewGoal?.criteria.find((criterion) => criterion.id === assessment.criterionId)?.description ?? t('rooms.historicalCriterionUnavailable')}</p><p>{assessment.note}</p></div>) : <p class="room-muted">{t('rooms.pending')}</p>}
      {selected.evidence?.map((item, index) => <blockquote class="room-evidence" key={index}><b>{snapshot.sources?.find(source => source.id === item.sourceId)?.title ?? t('rooms.source')}</b><p>{item.quote}</p></blockquote>)}
      <p class="room-muted">{formatDateTime(selected.createdAt)}</p>
      {artifact.adoptedVersion === version && <p class="room-adopted">{t('rooms.adopted')}</p>}
    </aside></div>
    {error && <p class="room-error" role="alert">{error}</p>}
    <footer class="room-dialog-actions"><button class="btn" onClick={() => void preview()} disabled={!writable || busy}>{t('rooms.createIssue')}</button>
      <button class="btn primary" onClick={() => void adopt()} disabled={!writable || busy || !passed || artifact.adoptedVersion === version}>{t(artifact.adoptedVersion === version ? 'rooms.adopted' : 'rooms.adopt')}</button></footer>
  </RoomPanelSurface>;
}

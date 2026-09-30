import { useEffect, useRef, useState } from 'preact/hooks';
import type { RoomArtifact, RoomArtifactVersion, RoomSnapshot, RoomSourceGrant } from '../../../shared/rooms';
import { useI18n } from '../i18n/provider';
import { RoomDialog, RoomPanelSurface } from '../components/RoomDialog';
import { Markdown } from '../components/Markdown';
import { ApiError } from '../lib/api';
import { readRoomLocal, roomRequestKey, roomsApi, saveRoomLocal } from '../lib/rooms-api';
import { memberLabel } from './room-presenters';

interface ResourceProps { pid: number; userId: number; snapshot: RoomSnapshot; writable: boolean; onSnapshot: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void }
function SourceEditor({ pid, userId, snapshot, writable, onSnapshot, onFailure, onClose }: ResourceProps & { onClose: () => void }) {
  const { t } = useI18n();
  const [scope] = useState(() => ({ missionId: snapshot.mission!.id, goalRevision: snapshot.mission!.goalRevision }));
  const storageKey = `panda.rooms.source.${userId}.${pid}.${snapshot.room.id}.${scope.missionId}.${scope.goalRevision}`;
  const recovered = useRef(readRoomLocal<{ title: string; content: string; recipient: string; key?: string }>(storageKey));
  const [form, setForm] = useState(recovered.current ?? { title: '', content: '', recipient: 'all' });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const persist = useRef(true);
  useEffect(() => { if (persist.current) saveRoomLocal(storageKey, form); }, [form, storageKey]);
  const changed = scope.missionId !== snapshot.mission?.id || scope.goalRevision !== snapshot.mission?.goalRevision;
  const tooLong = new TextEncoder().encode(form.content).length > 64000;
  const submit = async (): Promise<void> => {
    if (!writable || pending || changed || tooLong || !form.title.trim() || !form.content.trim()) return;
    const submission = { ...form, key: form.key ?? roomRequestKey() }; setForm(submission); saveRoomLocal(storageKey, submission); setPending(true); setError('');
    try {
      const result = await roomsApi.source(pid, snapshot.room.id, { ...scope, title: submission.title.trim(), content: submission.content, audience: submission.recipient === 'all' ? { kind: 'room' } : { kind: 'members', memberIds: [submission.recipient] } }, submission.key);
      persist.current = false; saveRoomLocal(storageKey, null); onSnapshot(result); onClose();
    } catch (cause) { if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) persist.current = false; onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    finally { setPending(false); }
  };
  return <RoomDialog title={t('rooms.addSource')} onClose={() => { if (!pending) onClose(); }}><form class="room-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <p class="room-notice">{t('rooms.sourcePauseHint')}</p>
    {changed && <p class="room-error">{t('rooms.missionChanged')}</p>}
    <label class="room-field"><span>{t('rooms.sourceTitle')}</span><input required maxLength={160} disabled={pending} value={form.title} onInput={event => setForm({ ...form, key: undefined, title: event.currentTarget.value })} /></label>
    <label class="room-field"><span>{t('rooms.sourceContent')}</span><textarea required rows={12} disabled={pending} value={form.content} onInput={event => setForm({ ...form, key: undefined, content: event.currentTarget.value })} /></label>
    <label class="room-field"><span>{t('rooms.recipient')}</span><select disabled={pending} value={form.recipient} onChange={event => setForm({ ...form, key: undefined, recipient: event.currentTarget.value })}><option value="all">{t('rooms.everyone')}</option>{snapshot.members.filter(member => member.status === 'active').map(member => <option key={member.id} value={member.id}>{memberLabel(member, t)}</option>)}</select></label>
    <p class="room-muted">{t('rooms.sourceLimit')}</p>{tooLong && <p class="room-error">{t('rooms.sourceLimit')}</p>}{error && <p class="room-error" role="alert">{error}</p>}
    <footer class="room-dialog-actions"><button class="btn" type="button" disabled={pending} onClick={onClose}>{t('common.cancel')}</button><button class="btn primary" disabled={!writable || pending || changed || tooLong}>{t(pending ? 'common.loading' : 'rooms.addSource')}</button></footer>
  </form></RoomDialog>;
}

function SourceText({ pid, rid, source, expanded, onFailure }: { pid: number; rid: string; source: RoomSourceGrant; expanded: boolean; onFailure: (cause: unknown) => void }) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(source.contentLoaded === false ? null : source.content);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!expanded || content !== null) return;
    const controller = new AbortController();
    setError('');
    void roomsApi.sourceDetail(pid, rid, source.id, controller.signal).then(result => { if (!controller.signal.aborted) setContent(result.source.content); }).catch(cause => { if (!controller.signal.aborted) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); } });
    return () => controller.abort();
  }, [pid, rid, source.id, expanded, retry]);
  return content !== null ? <Markdown text={content} /> : error ? <div><p class="room-error">{error}</p><button class="btn" onClick={() => setRetry(value => value + 1)}>{t('rooms.retry')}</button></div> : <p role="status">{t('common.loading')}</p>;
}

export function RoomSourcesPanel(props: ResourceProps) {
  const { snapshot, writable, onSnapshot, onFailure, pid } = props;
  const { t, formatList } = useI18n();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const keys = useRef(new Map<string, string>());
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(new Set<string>());
  const active = snapshot.sources?.filter(source => source.status === 'active' && source.missionId === snapshot.mission?.id && source.goalRevision === snapshot.mission?.goalRevision) ?? [];
  const revoke = async (id: string): Promise<void> => {
    if (busy || !writable) return;
    const key = keys.current.get(id) ?? roomRequestKey(); keys.current.set(id, key); setBusy(id); setError('');
    try { onSnapshot(await roomsApi.revokeSource(pid, snapshot.room.id, id, key)); }
    catch (cause) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    finally { setBusy(null); }
  };
  return <section class="room-side-panel room-sources"><header><h2>{t('rooms.sources')}</h2><button class="linkbtn" disabled={!writable || active.length >= 12} onClick={() => setAdding(true)}>{t('rooms.addSource')}</button></header>
    <p class="room-muted">{t('rooms.sourceScopeHint')}</p>
    {(snapshot.sources ?? []).map(source => <details key={source.id} id={`room-source-${source.id}`} onToggle={event => { const open = event.currentTarget.open; setExpanded(value => { const next = new Set(value); if (open) next.add(source.id); else next.delete(source.id); return next; }); }}><summary>{source.title}{source.status === 'revoked' && <small> · {t('rooms.revoked')}</small>}</summary>
      <p class="room-muted">{t('rooms.to', { recipient: source.audience.kind === 'room' ? t('rooms.everyone') : formatList(source.audience.memberIds.map(id => { const member = snapshot.members.find(item => item.id === id); return member ? memberLabel(member, t) : id; })) })}</p>
      <p class="room-muted">{t('rooms.goalRevision', { revision: source.goalRevision })}</p><SourceText pid={pid} rid={snapshot.room.id} source={source} expanded={expanded.has(source.id)} onFailure={onFailure} />
      {source.status === 'active' && <button class="btn" disabled={!writable || !!busy} onClick={() => void revoke(source.id)}>{t(busy === source.id ? 'common.loading' : 'rooms.revokeSource')}</button>}
    </details>)}{error && <p class="room-error" role="alert">{error}</p>}
    {adding && <SourceEditor {...props} onClose={() => setAdding(false)} />}
  </section>;
}

export function RoomArtifactEditor({ pid, userId, snapshot, artifact, selected, writable, onSnapshot, onFailure, onClose, embedded = false }: ResourceProps & { embedded?: boolean; artifact: RoomArtifact; selected: RoomArtifactVersion; onClose: () => void }) {
  const { t } = useI18n();
  const storageKey = `panda.rooms.artifactDraft.${userId}.${pid}.${snapshot.room.id}.${artifact.id}.${selected.version}`;
  const [form, setForm] = useState(() => readRoomLocal<{ title: string; markdown: string }>(storageKey) ?? { title: selected.title, markdown: selected.markdown });
  const [target] = useState(() => ({ missionId: snapshot.mission!.id, expectedMissionVersion: snapshot.mission!.version, expectedVersion: selected.version }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const retain = useRef(true);
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  useEffect(() => { if (retain.current) saveRoomLocal(storageKey, form); }, [form, storageKey]);
  const changed = target.missionId !== snapshot.mission?.id || target.expectedMissionVersion !== snapshot.mission?.version || target.expectedVersion !== artifact.currentVersion;
  const tooLong = form.markdown.length > 48000 || new TextEncoder().encode(form.markdown).length > 64000;
  const save = async (): Promise<void> => {
    if (!writable || pending || changed || tooLong || !form.markdown.trim()) return;
    const input = { ...form, expectedMissionVersion: target.expectedMissionVersion, expectedVersion: target.expectedVersion };
    const fingerprint = JSON.stringify(input);
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: roomRequestKey() };
    setPending(true); setError('');
    try { const next = await roomsApi.editArtifact(pid, snapshot.room.id, artifact.id, input, submission.current.key); retain.current = false; saveRoomLocal(storageKey, null); onSnapshot(next); onClose(); }
    catch (cause) { if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) retain.current = false; onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    finally { setPending(false); }
  };
  return <RoomPanelSurface embedded={embedded} title={t('rooms.editArtifact')} wide onClose={() => { if (!pending) onClose(); }}><form class="room-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    {embedded && <h3>{t('rooms.editArtifact')}</h3>}
    <p class="room-notice">{t('rooms.editArtifactHint')}</p>{changed && <p class="room-error">{t('rooms.missionChanged')}</p>}
    <label class="room-field"><span>{t('rooms.sourceTitle')}</span><input required maxLength={200} value={form.title} disabled={pending} onInput={event => setForm({ ...form, title: event.currentTarget.value })} /></label>
    <label class="room-field"><span>{t('rooms.artifactContent')}</span><textarea required rows={18} maxLength={48000} value={form.markdown} disabled={pending} onInput={event => setForm({ ...form, markdown: event.currentTarget.value })} /></label>
    {tooLong && <p class="room-error">{t('rooms.artifactLimit')}</p>}{error && <p class="room-error" role="alert">{error}</p>}<footer class="room-dialog-actions"><button class="btn" type="button" disabled={pending} onClick={onClose}>{t('common.cancel')}</button><button class="btn primary" disabled={!writable || pending || changed || tooLong}>{t(pending ? 'common.loading' : 'common.save')}</button></footer>
  </form></RoomPanelSurface>;
}

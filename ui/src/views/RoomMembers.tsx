import { useEffect, useRef, useState } from 'preact/hooks';
import type { RoomMemberModel, RoomModelProvider, RoomReasoningEffort, RoomRole, RoomSnapshot } from '../../../shared/rooms';
import type { RoomModelCatalog } from '../../../shared/room-models';
import { useI18n } from '../i18n/provider';
import { ApiError } from '../lib/api';
import { RoomAvatar, memberLabel } from './room-presenters';
import { readRoomLocal, roomRequestKey, roomsApi, saveRoomLocal } from '../lib/rooms-api';
import { applyMemberProposal, memberDesignRows, addMemberDraft, canEditMembers, memberChanges, memberDraft, rebaseMembers, validMemberRows, type MemberRowDraft, type MembersDraft } from '../lib/room-members';

const ROLES: RoomRole[] = ['coach', 'planner', 'writer', 'reviewer'];
const EFFORTS: RoomReasoningEffort[] = ['low', 'medium', 'high'];
const PROVIDERS: RoomModelProvider[] = ['claude', 'codex', 'deepseek'];
const PROVIDER_NAMES = { claude: 'Claude', codex: 'Codex', deepseek: 'DeepSeek' };
const EFFORT_KEYS = { low: 'rooms.effortLow', medium: 'rooms.effortMedium', high: 'rooms.effortHigh' } as const;
function newModel(provider: RoomModelProvider, catalog: RoomModelCatalog | null): RoomMemberModel {
  const source = catalog?.providers.find(item => item.provider === provider);
  return { provider, model: source?.defaultModel ?? source?.models[0]?.id ?? '', effort: 'medium' };
}
function ModelFields({ value, catalog, disabled, onChange, id }: { value: RoomMemberModel | null; catalog: RoomModelCatalog | null; disabled: boolean; onChange: (value: RoomMemberModel | null) => void; id: string }) {
  const { t } = useI18n();
  const provider = catalog?.providers.find(item => item.provider === value?.provider);
  return <div class="room-model-fields">
    <label class="room-field"><span>{t('rooms.modelProvider')}</span><select aria-label={t('rooms.modelProvider')} value={value?.provider ?? ''} disabled={disabled} onChange={event => onChange(event.currentTarget.value ? newModel(event.currentTarget.value as RoomModelProvider, catalog) : null)}><option value="">{t('rooms.defaultModel')}</option>{PROVIDERS.map(key => <option value={key} key={key}>{PROVIDER_NAMES[key]} · {t(key === 'deepseek' ? 'rooms.modelApi' : 'rooms.localSession')}</option>)}</select></label>
    {value && <><label class="room-field"><span>{t('rooms.modelName')}</span><input placeholder={t('rooms.modelIdHint')} value={value.model} maxLength={200} list={id} disabled={disabled} onInput={event => onChange({ ...value, model: event.currentTarget.value })} /><datalist id={id}>{provider?.models.map(model => <option value={model.id} key={model.id} />)}</datalist></label>
      <label class="room-field"><span>{t('rooms.reasoningEffort')}</span><select aria-label={t('rooms.reasoningEffort')} value={value.effort} disabled={disabled} onChange={event => onChange({ ...value, effort: event.currentTarget.value as RoomReasoningEffort })}>{EFFORTS.map(effort => <option value={effort} key={effort}>{t(EFFORT_KEYS[effort])}</option>)}</select></label>
      {value.provider === 'deepseek' && <p class="room-muted">{t('rooms.deepseekEffortHint')}</p>}
      {catalog && !provider?.available && <p class="room-muted">{t('rooms.modelUnavailable')}</p>}</>}
  </div>;
}

export function RoomMembersManager({ pid, userId, snapshot, writable, focusMemberId, onSnapshot, onFailure }: {
  pid: number; userId: number; snapshot: RoomSnapshot; writable: boolean; focusMemberId?: string;
  onSnapshot: (snapshot: RoomSnapshot) => void; onFailure: (cause: unknown) => void;
}) {
  const { t, formatList, formatNumber } = useI18n();
  const storageKey = `panda.rooms.members.${userId}.${pid}.${snapshot.room.id}`;
  const [draft, setDraft] = useState<MembersDraft>(() => {
    const saved = readRoomLocal<MembersDraft>(storageKey);
    return saved && Array.isArray(saved.rows) && Array.isArray(saved.baseline) && Number.isSafeInteger(saved.expectedRoomVersion) ? saved : memberDraft(snapshot);
  });
  const draftRef = useRef(draft); draftRef.current = draft;
  const snapshotRef = useRef(snapshot); snapshotRef.current = snapshot;
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(focusMemberId ?? draft.rows[0]?.key ?? '');
  const [catalog, setCatalog] = useState<RoomModelCatalog | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const retain = useRef(true);
  const alive = useRef(true);
  const [bulkProvider, setBulkProvider] = useState<'keep' | 'default' | RoomModelProvider>('keep');
  const [bulkModel, setBulkModel] = useState<RoomMemberModel | null>(null);
  const [bulkEffort, setBulkEffort] = useState<'keep' | RoomReasoningEffort>('keep');
  const [bulkRole, setBulkRole] = useState<'' | RoomRole>('');
  const [agentOpen, setAgentOpen] = useState(false);
  const [instruction, setInstruction] = useState(() => readRoomLocal<{ instruction: string }>(`${storageKey}.agent`)?.instruction ?? '');
  const [agentModel, setAgentModel] = useState<RoomMemberModel | null>(() => readRoomLocal<{ model: RoomMemberModel | null }>(`${storageKey}.agent`)?.model ?? null);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const [proposalSummary, setProposalSummary] = useState('');
  const [proposalUndo, setProposalUndo] = useState<MembersDraft | null>(null);
  const generation = useRef<{ fingerprint: string; key: string } | null>(readRoomLocal(`${storageKey}.generation`));
  const generationController = useRef<AbortController | null>(null);
  useEffect(() => { saveRoomLocal(`${storageKey}.agent`, { instruction, model: agentModel }); }, [instruction, agentModel, storageKey]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generationController.current?.abort(); }; }, []);
  useEffect(() => { if (focusMemberId) setExpanded(focusMemberId); }, [focusMemberId]);
  useEffect(() => { const controller = new AbortController(); void roomsApi.memberModels(pid, snapshot.room.id, controller.signal).then(setCatalog).catch(cause => { if (!controller.signal.aborted) onFailure(cause); }); return () => controller.abort(); }, [pid, snapshot.room.id]);
  useEffect(() => { if (retain.current) saveRoomLocal(storageKey, draft); }, [draft, storageKey]);
  const changes = memberChanges(draft);
  const conflict = draft.expectedRoomVersion !== snapshot.room.version;
  useEffect(() => { if (conflict && !draft.request && !changes.length) setDraft(memberDraft(snapshot)); }, [snapshot.room.version, draft.expectedRoomVersion, draft.request?.key, changes.length]);
  const editable = writable && canEditMembers(snapshot);
  const locked = !editable || pending || generating || !!draft.request;
  const rows = draft.rows.filter(item => !item.removed);
  const selection = selected.filter(key => rows.some(item => item.key === key));
  const missing = (['writer', 'reviewer'] as const).filter(required => !rows.some(item => item.role === required));
  const update = (next: MembersDraft): void => { if (locked) return; setDraft(next); setSaved(false); setError(''); setProposalUndo(null); setProposalSummary(''); };
  const patch = (key: string, fields: Partial<MemberRowDraft>): void => update({ ...draft, rows: draft.rows.map(item => item.key === key ? { ...item, ...fields } : item) });
  const remove = (key: string): void => update({ ...draft, rows: draft.rows.flatMap(item => item.key !== key ? [item] : item.id && !item.orphan ? [{ ...item, removed: !item.removed }] : []) });
  const add = (): void => {
    const item = addMemberDraft('writer', t('rooms.memberDefaultName', { role: t('rooms.writer'), number: rows.filter(value => value.role === 'writer').length + 1 }));
    update({ ...draft, rows: [...draft.rows, item] }); setExpanded(item.key);
  };
  const applyBatch = (): void => {
    if (!selection.length) return;
    update({ ...draft, rows: draft.rows.map(item => {
      if (!selection.includes(item.key)) return item;
      let model = bulkProvider === 'keep' ? item.model : bulkProvider === 'default' ? null : bulkModel ? { ...bulkModel, effort: item.model?.effort ?? catalog?.defaultModel?.effort ?? 'medium' } : null;
      if (bulkEffort !== 'keep' && bulkProvider !== 'default') { const base = model ?? catalog?.defaultModel; if (base) model = { ...base, effort: bulkEffort }; }
      return { ...item, ...(bulkRole ? { role: bulkRole } : {}), model };
    }) });
  };
  const generate = async (): Promise<void> => {
    const value = draftRef.current;
    if (locked || generatingRef.current || !instruction.trim() || conflict) return;
    const input = { expectedRoomVersion: value.expectedRoomVersion, instruction: instruction.trim(), members: memberDesignRows(value), model: agentModel };
    const fingerprint = JSON.stringify(input);
    if (generation.current?.fingerprint !== fingerprint) generation.current = { fingerprint, key: roomRequestKey() };
    saveRoomLocal(`${storageKey}.generation`, generation.current);
    const controller = new AbortController(); generationController.current = controller;
    generatingRef.current = true; setGenerating(true); setError(''); setSaved(false);
    try {
      const proposal = await roomsApi.proposeMembers(pid, snapshot.room.id, input, generation.current.key, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (draftRef.current !== value || snapshotRef.current.room.version !== value.expectedRoomVersion) { setError(t('rooms.membersConflict')); return; }
      const next = applyMemberProposal(value, proposal);
      setProposalUndo(value); setDraft(next); setProposalSummary(proposal.summary || t('rooms.agentDraftReady'));
      setExpanded(next.rows.find(item => !item.removed)?.key ?? ''); setSelected([]); setAgentOpen(false);
      generation.current = null; saveRoomLocal(`${storageKey}.generation`, null);
    } catch (cause) {
      if (!alive.current || controller.signal.aborted) return;
      onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.agentProposalFailed'));
    } finally {
      generatingRef.current = false;
      if (alive.current) setGenerating(false);
    }
  };
  const save = async (): Promise<void> => {
    const value = draftRef.current;
    if (pendingRef.current || generatingRef.current || !writable || !value.request && (!editable || conflict || !changes.length || !validMemberRows(value.rows))) return;
    const request = value.request ?? { key: roomRequestKey(), input: { expectedRoomVersion: value.expectedRoomVersion, changes: memberChanges(value) } };
    const submitted = { ...value, request };
    pendingRef.current = true; setPending(true); setError(''); setDraft(submitted); saveRoomLocal(storageKey, submitted);
    try {
      const next = await roomsApi.members(pid, snapshot.room.id, request.input, request.key);
      if (readRoomLocal<MembersDraft>(storageKey)?.request?.key === request.key) saveRoomLocal(storageKey, null);
      if (alive.current) { onSnapshot(next); setDraft(memberDraft(snapshotRef.current.room.version > next.room.version ? snapshotRef.current : next)); setSelected([]); setSaved(true); setProposalUndo(null); setProposalSummary(''); }
    } catch (cause) {
      const definitive = cause instanceof ApiError && cause.status > 0 && cause.status < 500;
      if (definitive) { const retry = { ...submitted, request: undefined }; if (readRoomLocal<MembersDraft>(storageKey)?.request?.key === request.key) saveRoomLocal(storageKey, retry); if (alive.current) setDraft(retry); }
      if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) { retain.current = false; saveRoomLocal(storageKey, null); }
      if (alive.current) { onFailure(cause); setError(cause instanceof ApiError ? cause.message : t('rooms.viewFailed')); }
    } finally { pendingRef.current = false; if (alive.current) setPending(false); }
  };
  const focused = draft.rows.find(item => item.key === expanded) ?? draft.rows[0];
  const changedKeys = new Set(draft.rows.filter(item => !item.id || memberChanges({ ...draft, rows: [item] }).length).map(item => item.key));
  return <section class="room-members-manager">
    <div class="room-members-editor">
      <aside class="room-members-picker" aria-label={t('rooms.memberRoster')}>
        <div class="room-members-toolbar"><b>{t('rooms.memberRoster')} <small>{formatNumber(rows.length)}{' / '}{formatNumber(12)}</small></b><button class="btn" disabled={locked || rows.length >= 12} onClick={add}>{t('rooms.addMember')}</button></div>
        <label class="room-members-select-all"><input type="checkbox" aria-label={t('rooms.selectAllMembers')} disabled={locked} checked={!!rows.length && selection.length === rows.length} onChange={event => setSelected(event.currentTarget.checked ? rows.map(item => item.key) : [])} />{t('rooms.selectAllMembers')}<small>{t('rooms.membersSelected', { count: selection.length })}</small></label>
        <ul class="room-member-drafts">{draft.rows.map(item => <li class={`room-member-draft${item.removed ? ' is-removed' : ''}${focused?.key === item.key ? ' is-selected' : ''}`} key={item.key}>
          <button type="button" class="room-member-expand" aria-pressed={focused?.key === item.key} title={memberLabel(item, t)} onClick={() => setExpanded(item.key)}>
            <RoomAvatar member={item} />
            <span class="room-member-list-copy"><span class="room-member-list-name"><b>{memberLabel(item, t)}</b>{changedKeys.has(item.key) && <span class="room-draft-dot" title={t('rooms.unsavedMember')} aria-label={t('rooms.unsavedMember')} />}</span><small>{t(`rooms.${item.role}`)}{item.removed ? ` · ${t('rooms.memberRemoved')}` : ''}</small></span>
          </button>
          <label class="room-member-select"><input type="checkbox" aria-label={memberLabel(item, t)} disabled={locked || item.removed} checked={selection.includes(item.key)} onChange={event => setSelected(event.currentTarget.checked ? [...selected, item.key] : selected.filter(key => key !== item.key))} /></label>
        </li>)}</ul>
      </aside>
      <div class="room-members-details">
        <header class="room-member-editor-heading"><div><small>{t('rooms.memberDetails')}</small><h3>{focused ? memberLabel(focused, t) : t('rooms.memberRoster')}</h3></div>{focused && <button class="linkbtn room-danger" disabled={locked} onClick={() => remove(focused.key)}>{t(focused.removed ? 'rooms.restoreMember' : 'rooms.removeMember')}</button>}</header>
        {!editable && <p class="room-notice">{t('rooms.memberConfigPaused')}</p>}
    <details class="room-members-batch"><summary>{t('rooms.batchSettings')} · {t('rooms.membersSelected', { count: selection.length })}</summary>
      <label class="room-field"><span>{t('rooms.modelProvider')}</span><select aria-label={t('rooms.modelProvider')} disabled={locked} value={bulkProvider} onChange={event => { const value = event.currentTarget.value as typeof bulkProvider; setBulkProvider(value); setBulkModel(value === 'keep' || value === 'default' ? null : newModel(value, catalog)); }}><option value="keep">{t('rooms.keepSetting')}</option><option value="default">{t('rooms.clearModel')}</option>{PROVIDERS.map(key => <option value={key} key={key}>{PROVIDER_NAMES[key]} · {t(key === 'deepseek' ? 'rooms.modelApi' : 'rooms.localSession')}</option>)}</select></label>
      {bulkModel && <label class="room-field"><span>{t('rooms.modelName')}</span><input value={bulkModel.model} maxLength={200} disabled={locked} onInput={event => setBulkModel({ ...bulkModel, model: event.currentTarget.value })} /></label>}
      <label class="room-field"><span>{t('rooms.reasoningEffort')}</span><select aria-label={t('rooms.reasoningEffort')} value={bulkEffort} disabled={locked} onChange={event => setBulkEffort(event.currentTarget.value as typeof bulkEffort)}><option value="keep">{t('rooms.keepSetting')}</option>{EFFORTS.map(value => <option value={value} key={value}>{t(EFFORT_KEYS[value])}</option>)}</select></label>
      <label class="room-field"><span>{t('rooms.generationRole')}</span><select aria-label={t('rooms.generationRole')} value={bulkRole} disabled={locked} onChange={event => setBulkRole(event.currentTarget.value as typeof bulkRole)}><option value="">{t('rooms.keepSetting')}</option>{ROLES.map(value => <option value={value} key={value}>{t(`rooms.${value}`)}</option>)}</select></label>
      {bulkProvider === 'deepseek' && <p class="room-muted">{t('rooms.deepseekEffortHint')}</p>}
      <button class="btn" disabled={locked || !selection.length || bulkEffort !== 'keep' && bulkProvider === 'keep' && !catalog?.defaultModel && rows.some(item => selection.includes(item.key) && !item.model)} onClick={applyBatch}>{t('rooms.batchApply')}</button>
    </details>

        {focused && !focused.removed && <div class="room-member-draft-fields" key={focused.key}>
          {focused.orphan && <p class="room-error">{t('rooms.recipientRemoved')}</p>}
          <div class="room-member-identity-fields"><label class="room-field"><span>{t('rooms.memberName')}</span><input value={focused.displayName} maxLength={80} disabled={locked} onInput={event => patch(focused.key, { displayName: event.currentTarget.value })} /></label>
          <label class="room-field"><span>{t('rooms.generationRole')}</span><select aria-label={t('rooms.generationRole')} value={focused.role} disabled={locked} onChange={event => patch(focused.key, { role: event.currentTarget.value as RoomRole })}>{ROLES.map(value => <option value={value} key={value}>{t(`rooms.${value}`)}</option>)}</select></label></div>
          <label class="room-field"><span>{t('rooms.memberInstructions')}</span><textarea rows={5} value={focused.instructions} maxLength={4000} disabled={locked} onInput={event => patch(focused.key, { instructions: event.currentTarget.value })} /></label>
          <ModelFields value={focused.model} catalog={catalog} disabled={locked} id={`room-model-${focused.key}`} onChange={model => patch(focused.key, { model })} />
          <p class="room-muted">{t('rooms.modelHint')}</p>
        </div>}
        {focused?.removed && <p class="room-notice">{t('rooms.removeMemberHint')}</p>}
    <p class="room-muted">{t('rooms.memberLimit')}</p>
    {!!missing.length && <p class="room-notice">{t('rooms.missingRoles', { roles: formatList(missing.map(value => t(`rooms.${value}`))) })}</p>}
    {conflict && !draft.request && !!changes.length && <div class="room-notice"><p>{t('rooms.membersConflict')}</p><ul>{snapshot.members.filter(item => item.status === 'active').map(item => <li key={item.id}>{item.displayName} · {t(`rooms.${item.role}`)} · {item.model?.model ?? t('rooms.defaultModel')}</li>)}</ul><button class="btn" disabled={pending || generating} onClick={() => setDraft(memberDraft(snapshot))}>{t('rooms.reloadMembers')}</button><button class="btn" disabled={pending || generating} onClick={() => setDraft(rebaseMembers(draft, snapshot))}>{t('rooms.reviewMembers')}</button></div>}
    {draft.request && !pending && <p class="room-notice">{t('rooms.memberSavePending')}</p>}


      </div>
    </div>
    <section class="room-members-agent">
      <button type="button" class="room-agent-toggle" aria-expanded={agentOpen} onClick={() => setAgentOpen(value => !value)}><span class="room-agent-mark" aria-hidden="true">✦</span><span><b>{t('rooms.agentEditMembers')}</b><small>{t('rooms.agentEditHint')}</small></span><span aria-hidden="true">{agentOpen ? '−' : '+'}</span></button>
      {agentOpen && <div class="room-agent-composer">
        <label class="room-field"><span>{t('rooms.agentInstruction')}</span><textarea rows={3} value={instruction} maxLength={4000} disabled={locked} placeholder={t('rooms.agentInstructionPlaceholder')} onInput={event => setInstruction(event.currentTarget.value)} /></label>
        <details class="room-agent-model"><summary>{t('rooms.agentModel')}</summary><ModelFields value={agentModel} catalog={catalog} disabled={locked} id="room-generator-model" onChange={setAgentModel} /></details>
        <div class="room-agent-actions"><small>{t('rooms.agentContextHint', { count: rows.length })}</small><button class="btn primary" disabled={locked || conflict || !instruction.trim()} onClick={() => void generate()}>{t(generating ? 'rooms.agentGenerating' : 'rooms.agentGenerate')}</button></div>
      </div>}
      {generating && <p role="status" class="room-muted">{t('rooms.agentGenerating')}</p>}
      {proposalSummary && <div class="room-agent-result" role="status"><span>{proposalSummary}<small>{t('rooms.agentDraftReady')}</small></span>{proposalUndo && <button class="linkbtn" onClick={() => { if (locked) return; setDraft(proposalUndo); setProposalUndo(null); setProposalSummary(''); }} disabled={locked}>{t('rooms.undoAgentChanges')}</button>}</div>}
    </section>
    {error && <p class="room-error" role="alert">{error}</p>}{saved && <p role="status">{t('rooms.membersSaved')}</p>}
    <footer class="room-members-save"><small>{t('rooms.pendingChanges', { count: changes.length })}</small><button class="btn primary" disabled={!writable || pending || generating || !draft.request && (!editable || conflict || !changes.length || !validMemberRows(draft.rows))} onClick={() => void save()}>{t(pending ? 'common.loading' : draft.request ? 'rooms.retry' : 'rooms.saveMembers')}</button></footer>
  </section>;
}

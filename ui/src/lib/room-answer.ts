import { useLayoutEffect, useMemo, useReducer, useRef } from 'preact/hooks';
import type { RoomSnapshot } from '../../../shared/rooms';
import { roomCommandTarget, roomRequestKey, roomsApi, type RoomCommandTarget } from './rooms-api';

interface AnswerInput { expectedVersion: number; questionId: string; answer: string }
interface AnswerRequest { key: string; target: RoomCommandTarget; input: AnswerInput }
interface AnswerDraft { questionId: string; target: RoomCommandTarget; text: string; option: string | null; request?: AnswerRequest }
interface AnswerData { version: 1; mode: boolean; active: string | null; autoQuestion: string | null; drafts: AnswerDraft[] }
interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void }
export interface RoomAnswerOptions {
  pid: number; rid: string; userId: number; snapshot: RoomSnapshot | null; connected: boolean;
  onSnapshot(snapshot: RoomSnapshot): void; onFailure(error: unknown): void;
}
export interface RoomAnswerState {
  mode: boolean; text: string; option: string | null; pending: boolean; uncertain: boolean;
  stale: boolean; canSend: boolean; questionId: string | undefined;
}
interface ControllerOptions extends Pick<RoomAnswerOptions, 'pid' | 'rid' | 'userId' | 'onSnapshot' | 'onFailure'> {
  storage?: StoragePort;
  requestKey?: () => string;
  send?: (missionId: string, input: AnswerInput, key: string) => Promise<RoomSnapshot>;
}

const empty = (): AnswerData => ({ version: 1, mode: false, active: null, autoQuestion: null, drafts: [] });
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;
function target(value: unknown): RoomCommandTarget | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<RoomCommandTarget>;
  return identifier(v.missionId) && positive(v.expectedVersion) && positive(v.goalRevision)
    ? { missionId: v.missionId, expectedVersion: v.expectedVersion, goalRevision: v.goalRevision } : null;
}
function answerText(draft: AnswerDraft): string {
  return draft.option === null ? draft.text : draft.text ? [draft.option, draft.text].join('\n\n') : draft.option;
}
function read(storage: StoragePort | undefined, key: string): AnswerData {
  try {
    const data: unknown = JSON.parse(storage?.getItem(key) ?? 'null');
    if (!data || typeof data !== 'object') return empty();
    const value = data as Partial<AnswerData>;
    if (value.version !== 1 || typeof value.mode !== 'boolean' || !Array.isArray(value.drafts)
      || value.active !== null && !identifier(value.active) || value.autoQuestion !== null && !identifier(value.autoQuestion)) return empty();
    const drafts: AnswerDraft[] = [];
    for (const item of value.drafts) {
      const binding = target(item?.target);
      if (!binding || !identifier(item.questionId) || typeof item.text !== 'string' || item.text.length > 8000
        || item.option !== null && (typeof item.option !== 'string' || item.option.length > 300)
        || drafts.some(draft => draft.questionId === item.questionId)) return empty();
      const draft: AnswerDraft = { questionId: item.questionId, target: binding, text: item.text, option: item.option };
      if (item.request) {
        const requestTarget = target(item.request.target), input = item.request.input;
        if (!requestTarget || JSON.stringify(requestTarget) !== JSON.stringify(binding)
          || typeof item.request.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.request.key)
          || !input || input.questionId !== draft.questionId || input.expectedVersion !== binding.expectedVersion
          || typeof input.answer !== 'string' || !input.answer.trim() || input.answer.length > 8000 || input.answer !== answerText(draft)) return empty();
        draft.request = { key: item.request.key, target: requestTarget, input: { questionId: input.questionId, expectedVersion: input.expectedVersion, answer: input.answer } };
      }
      drafts.push(draft);
    }
    if (value.active !== null && !drafts.some(draft => draft.questionId === value.active)
      || drafts.some(draft => draft.request && draft.questionId !== value.active)) return empty();
    return { version: 1, mode: value.mode, active: value.active!, autoQuestion: value.autoQuestion!, drafts };
  } catch { return empty(); }
}
export const roomAnswerStorageKey = (userId: number, pid: number, rid: string): string => `panda.rooms.answer.${userId}.${pid}.${rid}`;

/** Question-bound state and its write-ahead request survive remounts independently of normal chat. */
export class RoomAnswerController {
  private readonly storageKey: string;
  private readonly storage: StoragePort | undefined;
  private data: AnswerData;
  private snapshot: RoomSnapshot | null = null;
  private connected = false;
  private inFlight = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly options: ControllerOptions) {
    this.storageKey = roomAnswerStorageKey(options.userId, options.pid, options.rid);
    try { this.storage = options.storage ?? globalThis.sessionStorage; } catch { this.storage = undefined; }
    this.data = read(this.storage, this.storageKey);
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose(): void { this.disposed = true; this.listeners.clear(); }
  private emit(): void { if (!this.disposed) for (const listener of this.listeners) listener(); }
  private persist(required = false): void {
    try {
      if (!this.storage) throw new Error('room_answer_storage_unavailable');
      this.storage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch (error) { if (required) throw error; }
  }
  private settlePersisted(key: string, accepted: boolean): void {
    // A remounted controller may have advanced, or the ACL handler may have
    // cleared this scope. A late response may only settle its own saved request.
    try {
      const saved = read(this.storage, this.storageKey);
      const draft = saved.drafts.find(item => item.request?.key === key);
      if (!draft) return;
      if (accepted) {
        saved.drafts = saved.drafts.filter(item => item !== draft);
        if (saved.active === draft.questionId) { saved.active = null; saved.mode = false; }
      } else delete draft.request;
      this.storage?.setItem(this.storageKey, JSON.stringify(saved));
    } catch { /* An unchanged recovery key can safely be replayed later. */ }
  }
  private draft(): AnswerDraft | undefined { return this.data.drafts.find(draft => draft.questionId === this.data.active); }
  private current() {
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.room.projectId !== this.options.pid || snapshot.room.id !== this.options.rid
      || snapshot.mission?.state !== 'waiting_user' || !snapshot.mission.question) return null;
    const binding = roomCommandTarget(snapshot);
    return binding ? { target: binding, question: snapshot.mission.question } : null;
  }
  update(snapshot: RoomSnapshot | null, connected: boolean): void {
    this.snapshot = snapshot; this.connected = connected;
    const current = this.current();
    if (current && !this.data.active && this.data.autoQuestion !== current.question.id) {
      this.begin(current.question.id);
    }
    this.emit();
  }
  get state(): RoomAnswerState {
    const draft = this.draft(), current = this.current();
    const stale = !!draft && (!current || draft.questionId !== current.question.id || draft.target.missionId !== current.target.missionId
      || draft.target.goalRevision !== current.target.goalRevision || draft.target.expectedVersion !== current.target.expectedVersion);
    const answer = draft ? answerText(draft) : '';
    const scoped = this.snapshot?.room.projectId === this.options.pid && this.snapshot.room.id === this.options.rid;
    const writable = this.snapshot?.room.status === 'active' && this.snapshot.capabilities.canContribute && this.snapshot.runtime?.configured !== false;
    return { mode: this.data.mode, text: draft?.text ?? '', option: draft?.option ?? null, pending: this.inFlight,
      uncertain: !!draft?.request, stale, questionId: draft?.questionId,
      canSend: this.data.mode && this.connected && scoped && !this.inFlight && !!draft && (!!draft.request
        || !stale && !!writable && !!answer.trim() && answer.length <= 8000) };
  }
  setText(text: string): void {
    const draft = this.draft();
    if (!draft || draft.request || this.inFlight || text.length > 8000) return;
    draft.text = text; this.persist(); this.emit();
  }
  selectOption(questionId: string, option: string): void {
    const current = this.current();
    if (!current || current.question.id !== questionId || !current.question.options.includes(option) || this.inFlight || this.draft()?.request) return;
    this.begin(questionId);
    const draft = this.draft();
    if (!draft || draft.questionId !== questionId) return;
    draft.option = option; this.persist(); this.emit();
  }
  begin(questionId?: string): void {
    if (this.inFlight || this.draft()?.request) { this.data.mode = true; this.persist(); this.emit(); return; }
    const current = this.current();
    if (!current || questionId !== undefined && current.question.id !== questionId) return;
    const existing = this.data.drafts.find(draft => draft.questionId === current.question.id);
    if (!existing) this.data.drafts.push({ questionId: current.question.id, target: current.target, text: '', option: null });
    this.data.active = current.question.id; this.data.autoQuestion = current.question.id; this.data.mode = true;
    this.persist(); this.emit();
  }
  leave(): void { this.data.mode = false; this.persist(); this.emit(); }
  rebase(): void {
    const draft = this.draft(), current = this.current();
    if (!draft || draft.request || this.inFlight || !current || draft.questionId !== current.question.id
      || draft.target.missionId !== current.target.missionId || draft.target.goalRevision !== current.target.goalRevision) return;
    draft.target = current.target; this.persist(); this.emit();
  }
  async submit(): Promise<boolean> {
    if (this.disposed || !this.state.canSend) return false;
    const draft = this.draft()!;
    const oldRequest = draft.request;
    const request: AnswerRequest = oldRequest ?? { key: (this.options.requestKey ?? roomRequestKey)(), target: { ...draft.target }, input: { expectedVersion: draft.target.expectedVersion, questionId: draft.questionId, answer: answerText(draft) } };
    draft.request = request;
    try { this.persist(true); }
    catch (error) {
      draft.request = oldRequest;
      if (!this.disposed) this.options.onFailure(error);
      this.emit(); return false;
    }
    this.inFlight = true; this.emit();
    let next: RoomSnapshot;
    try {
      next = await (this.options.send ?? ((missionId, input, key) => roomsApi.command(this.options.pid, this.options.rid, missionId, 'answer', input, key)))(request.target.missionId, request.input, request.key);
      if (!next || next.room?.projectId !== this.options.pid || next.room.id !== this.options.rid) throw new Error('room_answer_response_mismatch');
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      // Only definite validation/CAS rejections release the request identity.
      if (status === 400 || status === 409) { delete draft.request; this.settlePersisted(request.key, false); }
      this.inFlight = false;
      if (!this.disposed) this.options.onFailure(error);
      this.emit(); return false;
    }
    this.inFlight = false;
    this.data.drafts = this.data.drafts.filter(item => item !== draft);
    this.data.active = null; this.data.mode = false; this.settlePersisted(request.key, true);
    if (!this.disposed) this.options.onSnapshot(next);
    this.emit(); return true;
  }
}

export function useRoomAnswer(options: RoomAnswerOptions) {
  const current = useRef(options); current.current = options;
  const [, render] = useReducer(value => value + 1, 0);
  const controller = useMemo(() => {
    const sameScope = () => current.current.pid === options.pid && current.current.rid === options.rid && current.current.userId === options.userId;
    return new RoomAnswerController({ ...options,
      onSnapshot: snapshot => { if (sameScope()) current.current.onSnapshot(snapshot); },
      onFailure: error => { if (sameScope()) current.current.onFailure(error); },
    });
  }, [options.pid, options.rid, options.userId]);
  useLayoutEffect(() => {
    const unsubscribe = controller.subscribe(() => render(undefined));
    return () => { unsubscribe(); controller.dispose(); };
  }, [controller]);
  useLayoutEffect(() => { controller.update(options.snapshot, options.connected); }, [controller, options.snapshot, options.connected]);
  return { ...controller.state, setText: (text: string) => controller.setText(text), selectOption: (questionId: string, option: string) => controller.selectOption(questionId, option),
    begin: (questionId?: string) => controller.begin(questionId), leave: () => controller.leave(), rebase: () => controller.rebase(), submit: () => controller.submit() };
}

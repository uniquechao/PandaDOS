import type { RoomMemberDesignInput, RoomMemberDesignProposal } from '../../../shared/room-member-design';
import { api } from './api';
import type { IssueId } from '../../../shared/issue-id';
import type { RoomIssueAnswerReceipt } from '../../../shared/room-issues';
import type { RoomModelCatalog } from '../../../shared/room-models';
import type { RoomMembersInput } from '../../../shared/rooms';
import type { RoomArtifact, RoomAudience, RoomBudgetLimits, RoomCommand, RoomCommandInput, RoomContribution, RoomCreateInput, RoomGoal, RoomIssueDraft, RoomSnapshot, RoomSourceGrant, RoomSummary } from '../../../shared/rooms';
import { MAX_ROOM_BUDGET } from '../../../shared/rooms';

export interface RoomListResult {
  rooms: RoomSummary[];
  runtime: { configured: boolean };
  defaults: RoomBudgetLimits;
  canWrite: boolean;
}
export const roomBase = (pid: number, roomId?: string): string => `/api/projects/${pid}/rooms${roomId ? `/${encodeURIComponent(roomId)}` : ''}`;
export const roomPath = (pid: number, roomId?: string): string => `/p/${pid}/rooms${roomId ? `/${encodeURIComponent(roomId)}` : ''}`;
export function roomRequestKey(): string { return crypto.randomUUID(); }
export interface RoomCommandTarget { missionId: string; expectedVersion: number; goalRevision: number }
export function roomCommandTarget(snapshot: RoomSnapshot): RoomCommandTarget | null {
  return snapshot.mission ? { missionId: snapshot.mission.id, expectedVersion: snapshot.mission.version, goalRevision: snapshot.mission.goalRevision } : null;
}
export function roomEditableCriteria(goal: RoomGoal | null): string[] {
  return goal?.criteria.filter(item => item.id !== 'original-request' && item.origin !== 'request').map(item => item.description) ?? [];
}
export function roomCriteriaValid(criteria: string[]): boolean { return criteria.length <= 12 && criteria.every(item => item.length <= 500); }
export function roomBudgetRemaining(limits: RoomBudgetLimits): RoomBudgetLimits {
  return Object.fromEntries(Object.entries(MAX_ROOM_BUDGET).map(([key, max]) => [key, Math.max(0, max - limits[key as keyof RoomBudgetLimits])])) as unknown as RoomBudgetLimits;
}
export function roomBudgetIncrement(limits: RoomBudgetLimits): Partial<RoomBudgetLimits> {
  return Object.fromEntries(Object.entries(limits).filter(([, amount]) => amount > 0));
}
export function roomCanAdopt(snapshot: RoomSnapshot, artifactId: string, version: number): boolean {
  return snapshot.mission?.state === 'completed' && snapshot.artifacts.find(item => item.id === artifactId)?.currentVersion === version && roomVersionPassed(snapshot, artifactId, version);
}
export function readRoomLocal<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null; } catch { return null; }
}
export function saveRoomLocal(key: string, value: unknown): void {
  try { if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}
export function clearRoomLocal(userId: number, pid: number, rid?: string): void {
  try { for (const key of Object.keys(sessionStorage)) {
    if (!key.startsWith('panda.rooms.')) continue;
    const marker = `.${userId}.${pid}.`, index = key.indexOf(marker);
    const scope = index < 0 ? null : key.slice(index + marker.length);
    if (scope !== null && (!rid || scope === rid || scope.startsWith(`${rid}.`))) sessionStorage.removeItem(key);
  } } catch { /* Storage is optional. */ }
}
export const roomCreationKey = (userId: number, pid: number): string => `panda.rooms.create.${userId}.${pid}.pending`;
export interface RoomPendingCreation { input: RoomCreateInput; key: string }

export const roomsApi = {
  memberModels: (pid: number, rid: string, signal?: AbortSignal) => api<RoomModelCatalog>(`${roomBase(pid, rid)}/member-models`, 'GET', undefined, { signal }),
  proposeMembers: (pid: number, rid: string, input: RoomMemberDesignInput, key: string, signal?: AbortSignal) => api<RoomMemberDesignProposal>(`${roomBase(pid, rid)}/members/propose`, 'POST', input, { idempotencyKey: key, signal }),
  members: (pid: number, rid: string, input: RoomMembersInput, key: string) => api<RoomSnapshot>(`${roomBase(pid, rid)}/members/batch`, 'POST', input, { idempotencyKey: key }),
  list: (pid: number, signal?: AbortSignal) => api<RoomListResult>(roomBase(pid), 'GET', undefined, { signal }),
  snapshot: (pid: number, rid: string, signal?: AbortSignal) => api<RoomSnapshot>(`${roomBase(pid, rid)}/snapshot`, 'GET', undefined, { signal }),
  view: (pid: number, rid: string, signal?: AbortSignal) => api<RoomSnapshot>(`${roomBase(pid, rid)}/view`, 'GET', undefined, { signal }),
  artifact: (pid: number, rid: string, artifactId: string, signal?: AbortSignal) => api<{ artifact: RoomArtifact }>(`${roomBase(pid, rid)}/artifacts/${encodeURIComponent(artifactId)}`, 'GET', undefined, { signal }),
  history: (pid: number, rid: string, beforeSeq: number, signal?: AbortSignal) => api<{ contributions: RoomContribution[]; hasMore: boolean; beforeSeq: number | null }>(`${roomBase(pid, rid)}/contributions?beforeSeq=${beforeSeq}&limit=80`, 'GET', undefined, { signal }),
  create: (pid: number, input: RoomCreateInput, key: string) => api<RoomSnapshot>(roomBase(pid), 'POST', input, { idempotencyKey: key }),
  command: (pid: number, rid: string, mid: string, cmd: RoomCommand, input: RoomCommandInput, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/missions/${encodeURIComponent(mid)}/${cmd}`, 'POST', input, { idempotencyKey: key }),
  contribute: (pid: number, rid: string, input: { text: string; audience: RoomAudience; clientMessageId: string; missionId?: string; goalRevision?: number; replyTo?: string }) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/contributions`, 'POST', input),
  archive: (pid: number, rid: string, expectedVersion: number, key: string) => api<RoomSnapshot>(`${roomBase(pid, rid)}/archive`, 'POST', { expectedVersion }, { idempotencyKey: key }),
  adopt: (pid: number, rid: string, artifactId: string, version: number, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/artifacts/${encodeURIComponent(artifactId)}/adopt`, 'POST', { version }, { idempotencyKey: key }),
  preview: (pid: number, rid: string, artifactId: string, artifactVersion: number) =>
    api<{ draft: RoomIssueDraft }>(`${roomBase(pid, rid)}/issues/preview`, 'POST', { artifactId, artifactVersion }),
  publish: (pid: number, rid: string, draft: RoomIssueDraft, expectedVersion: number, key: string) =>
    api<{ issueId: IssueId; snapshot: RoomSnapshot }>(`${roomBase(pid, rid)}/issues`, 'POST', { draft, expectedVersion }, { idempotencyKey: key }),
  answerIssue: (pid: number, rid: string, issueId: IssueId, questionId: number, answer: string, key: string) =>
    api<RoomIssueAnswerReceipt>(`${roomBase(pid, rid)}/issues/${encodeURIComponent(issueId)}/answer`, 'POST', { questionId, answer }, { idempotencyKey: key }),
  source: (pid: number, rid: string, input: { missionId: string; goalRevision: number; title: string; content: string; audience: RoomAudience }, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/sources`, 'POST', input, { idempotencyKey: key }),
  sourceDetail: (pid: number, rid: string, sourceId: string, signal?: AbortSignal) => api<{ source: RoomSourceGrant }>(`${roomBase(pid, rid)}/sources/${encodeURIComponent(sourceId)}`, 'GET', undefined, { signal }),
  revokeSource: (pid: number, rid: string, sourceId: string, key: string) => api<RoomSnapshot>(`${roomBase(pid, rid)}/sources/${encodeURIComponent(sourceId)}/revoke`, 'POST', {}, { idempotencyKey: key }),
  member: (pid: number, rid: string, memberId: string, input: { expectedVersion: number; displayName: string; instructions: string }, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/members/${encodeURIComponent(memberId)}/configure`, 'POST', input, { idempotencyKey: key }),
  editArtifact: (pid: number, rid: string, artifactId: string, input: { expectedVersion: number; expectedMissionVersion: number; title: string; markdown: string }, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/artifacts/${encodeURIComponent(artifactId)}/edit`, 'POST', input, { idempotencyKey: key }),
  newMission: (pid: number, rid: string, input: Omit<RoomCreateInput, 'title' | 'templateKey' | 'start'>, key: string) =>
    api<RoomSnapshot>(`${roomBase(pid, rid)}/missions`, 'POST', input, { idempotencyKey: key }),
};

/** A late request from a previous room or an older cursor never replaces current content. */
export function acceptRoomSnapshot(pid: number, rid: string, current: RoomSnapshot | null, next: RoomSnapshot): boolean {
  return next.room.projectId === pid && next.room.id === rid
    && (!current || next.eventCursor >= current.eventCursor && next.room.version >= current.room.version);
}
export function mergeRoomView(current: RoomSnapshot | null, next: RoomSnapshot): RoomSnapshot {
  if (!current || current.room.id !== next.room.id || current.room.projectId !== next.room.projectId) return next;
  const oldLast = current.contributions.at(-1)?.seq ?? 0;
  const newFirst = next.contributions[0]?.seq ?? 0;
  const connected = !oldLast || !newFirst || newFirst <= oldLast + 1;
  const contributions = connected ? [...new Map([...current.contributions, ...next.contributions].map(item => [item.id, item])).values()].sort((a, b) => a.seq - b.seq) : next.contributions;
  const keptOlder = connected && !!current.contributions.length && (current.contributions[0]?.seq ?? 0) < newFirst;
  return { ...next, contributions,
    ...(next.history ? { history: { hasMore: keptOlder ? current.history?.hasMore ?? false : next.history.hasMore, beforeSeq: contributions[0]?.seq ?? null } } : {}),
    artifacts: next.artifacts.map(artifact => ({ ...artifact, versions: artifact.versions.map(version => {
      const cached = current.artifacts.find(item => item.id === artifact.id)?.versions.find(item => item.version === version.version);
      return version.contentLoaded === false && cached && cached.contentLoaded !== false ? cached : version;
    }) })),
  };
}

/** Only a current-goal assessment of this exact immutable version is applicable. */
export function roomVersionPassed(snapshot: RoomSnapshot, artifactId: string, version: number): boolean {
  const artifact = snapshot.artifacts.find((item) => item.id === artifactId);
  const selected = artifact?.versions.find((item) => item.version === version);
  const goal = snapshot.goal;
  if (!goal || !selected || artifact?.missionId !== snapshot.mission?.id || selected.goalRevision !== goal.revision) return false;
  const required = goal.criteria.filter((item) => item.required);
  return required.length > 0 && required.every((criterion) => latestRoomAssessment(snapshot, artifactId, version, criterion.id)?.verdict === 'passed');
}

export function latestRoomAssessment(snapshot: RoomSnapshot, artifactId: string, version: number, criterionId: string) {
  return snapshot.assessments.filter((assessment) => assessment.artifactId === artifactId && assessment.artifactVersion === version
    && assessment.goalRevision === snapshot.goal?.revision && assessment.criterionId === criterionId)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
}

export interface RoomDiffLine { kind: 'same' | 'added' | 'removed'; text: string }
/** Bounded LCS for readable line diffs. Long documents use whole blocks to keep the UI responsive. */
export function roomDiffLines(before: string, after: string): RoomDiffLine[] {
  const left = before.split('\n'), right = after.split('\n');
  if (left.length * right.length > 250000) return [{ kind: 'removed', text: before }, { kind: 'added', text: after }];
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--)
    table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const result: RoomDiffLine[] = []; let i = 0, j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ kind: 'same', text: left[i++] }); j++; }
    else if (i < left.length && (j === right.length || table[i + 1][j] >= table[i][j + 1])) result.push({ kind: 'removed', text: left[i++] });
    else result.push({ kind: 'added', text: right[j++] });
  }
  return result;
}

export function roomDraftKey(userId: number, pid: number, rid: string): string { return `panda.rooms.draft.${userId}.${pid}.${rid}`; }
export interface RoomComposerDraft { text: string; recipient: string; clientMessageId: string; missionId?: string; goalRevision?: number }
export function readRoomDraft(userId: number, pid: number, rid: string): RoomComposerDraft {
  try {
    const value = JSON.parse(sessionStorage.getItem(roomDraftKey(userId, pid, rid)) ?? 'null');
    if (value && typeof value.text === 'string' && typeof value.recipient === 'string' && typeof value.clientMessageId === 'string') return value;
  } catch { /* Disabled browser storage does not prevent composing. */ }
  return { text: '', recipient: '', clientMessageId: roomRequestKey() };
}
export function saveRoomDraft(userId: number, pid: number, rid: string, draft: RoomComposerDraft): void {
  try { sessionStorage.setItem(roomDraftKey(userId, pid, rid), JSON.stringify(draft)); } catch { /* Optional draft persistence. */ }
}

export interface RoomPendingPublication { draft: RoomIssueDraft; key: string; expectedVersion: number }
export const publicationStorageKey = (userId: number, pid: number, rid: string, artifactId: string, version: number): string =>
  `panda.rooms.publication.${userId}.${pid}.${rid}.${artifactId}.${version}`;
export function readRoomPublication(storageKey: string, artifactId: string, version: number): RoomPendingPublication | null {
  try {
    const record = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (record && record.draft?.artifactId === artifactId && record.draft?.artifactVersion === version
      && typeof record.draft.title === 'string' && typeof record.draft.body === 'string' && typeof record.key === 'string'
      && Number.isInteger(record.expectedVersion)) return record;
  } catch { /* Optional browser storage. */ }
  return null;
}
export function saveRoomPublication(storageKey: string, record: RoomPendingPublication | null): void {
  try { if (record) sessionStorage.setItem(storageKey, JSON.stringify(record)); else sessionStorage.removeItem(storageKey); } catch { /* Keep the in-memory recovery record. */ }
}

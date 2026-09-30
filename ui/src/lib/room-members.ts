import type { RoomMember, RoomMemberChange, RoomMemberModel, RoomMembersInput, RoomRole, RoomSnapshot } from '../../../shared/rooms';
import { ROOM_ROLES } from '../../../shared/rooms';
import { roomRequestKey } from './rooms-api';
import { applyMemberDesignOperations, type RoomMemberDesignRow, type RoomMemberDesignProposal } from '../../../shared/room-member-design';

export interface MemberRowDraft {
  key: string; id?: string; version?: number; role: RoomRole; displayName: string; instructions: string;
  model: RoomMemberModel | null; removed?: boolean; orphan?: boolean;
}
export interface MembersDraft {
  expectedRoomVersion: number; baseline: RoomMember[]; rows: MemberRowDraft[];
  request?: { key: string; input: RoomMembersInput };
}
const copyModel = (model: RoomMemberModel | null | undefined): RoomMemberModel | null => model ? { provider: model.provider, model: model.model, effort: model.effort } : null;
const row = (member: RoomMember): MemberRowDraft => ({ key: member.id, id: member.id, version: member.version, role: member.role, displayName: member.displayName, instructions: member.instructions ?? '', model: copyModel(member.model) });
export function memberDraft(snapshot: RoomSnapshot): MembersDraft {
  const baseline = snapshot.members.filter(member => member.status === 'active').map(member => ({ ...member, ...(member.model ? { model: copyModel(member.model)! } : {}) }));
  return { expectedRoomVersion: snapshot.room.version, baseline, rows: baseline.map(row) };
}
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as RoomMemberModel, right = b as RoomMemberModel;
  return left.provider === right.provider && left.model === right.model && left.effort === right.effort;
};
export function memberChanges(draft: MembersDraft): RoomMemberChange[] {
  return draft.rows.flatMap(value => {
    if (value.removed) return value.id && !value.orphan ? [{ id: value.id, expectedVersion: value.version, remove: true }] : [];
    const previous = draft.baseline.find(member => member.id === value.id);
    const fields = { role: value.role, displayName: value.displayName, instructions: value.instructions, model: value.model };
    if (!value.id) return [fields];
    const changes: RoomMemberChange = { id: value.id, expectedVersion: value.version };
    for (const key of ['role', 'displayName', 'instructions', 'model'] as const) {
      const old = key === 'model' ? previous?.model ?? null : key === 'instructions' ? previous?.instructions ?? '' : previous?.[key];
      if (!equal(old, fields[key])) Object.assign(changes, { [key]: fields[key] });
    }
    return Object.keys(changes).length > 2 ? [changes] : [];
  });
}
/** Reapply only explicit edits; polling never silently rebases a user's CAS. */
export function rebaseMembers(draft: MembersDraft, snapshot: RoomSnapshot): MembersDraft {
  // An unknown commit must replay its original target, body and key first.
  if (draft.request) return draft;
  const next = memberDraft(snapshot);
  for (const change of memberChanges(draft)) {
    const previous = draft.rows.find(item => item.id === change.id && !!change.id);
    if (!change.id) continue;
    const current = next.rows.find(item => item.id === change.id);
    if (!current) {
      if (!change.remove && previous) next.rows.push({ ...previous, model: copyModel(previous.model), orphan: true });
      continue;
    }
    if (change.remove) current.removed = true;
    else for (const key of ['role', 'displayName', 'instructions', 'model'] as const) if (key in change) Object.assign(current, { [key]: key === 'model' ? copyModel(change.model) : change[key] });
  }
  next.rows.push(...draft.rows.filter(item => !item.id).map(item => ({ ...item, model: copyModel(item.model) })));
  return next;
}
export function addMemberDraft(role: RoomRole, displayName: string, model: RoomMemberModel | null = null, instructions = ''): MemberRowDraft {
  return { key: roomRequestKey(), role, displayName, model: copyModel(model), instructions };
}
export function memberDesignRows(draft: MembersDraft): RoomMemberDesignRow[] {
  return draft.rows.filter(item => !item.removed).map(item => ({ key: item.key, ...(item.id ? { memberId: item.id } : {}), role: item.role, displayName: item.displayName, instructions: item.instructions, model: copyModel(item.model) }));
}
export function applyMemberProposal(draft: MembersDraft, proposal: RoomMemberDesignProposal): MembersDraft {
  if (draft.request) throw new Error('member_save_pending');
  const next = applyMemberDesignOperations(memberDesignRows(draft), proposal.operations, roomRequestKey);
  const active = next.map(item => {
    const previous = draft.rows.find(row => row.key === item.key);
    return { ...previous, key: item.key, role: item.role, displayName: item.displayName, instructions: item.instructions, model: copyModel(item.model), removed: false };
  });
  const tombstones = draft.rows.filter(item => item.id && !active.some(row => row.key === item.key)).map(item => ({ ...item, removed: true }));
  const rows = [...active, ...tombstones];
  if (!validMemberRows(rows)) throw new Error('invalid_member_proposal');
  return { ...draft, rows };
}
export function canEditMembers(snapshot: RoomSnapshot): boolean {
  return snapshot.room.status === 'active' && snapshot.capabilities.canPublish
    && !['queued', 'running', 'quiescing'].includes(snapshot.mission?.state ?? '')
    && !snapshot.members.some(member => member.activity?.state === 'working');
}
export function validMemberRows(rows: MemberRowDraft[]): boolean {
  const active = rows.filter(item => !item.removed);
  return active.length > 0 && active.length <= 12 && active.filter(item => item.role === 'coach').length === 1
    && new Set(rows.map(item => item.key)).size === rows.length
    && new Set(rows.filter(item => item.id).map(item => item.id)).size === rows.filter(item => item.id).length
    && active.every(item => !item.orphan && ROOM_ROLES.includes(item.role) && typeof item.displayName === 'string' && item.displayName.trim().length > 0 && item.displayName.length <= 80 && typeof item.instructions === 'string' && item.instructions.length <= 4000
      && (!item.model || ['claude', 'codex', 'deepseek'].includes(item.model.provider) && ['low', 'medium', 'high'].includes(item.model.effort) && typeof item.model.model === 'string' && !/[\s\x00-\x1f\x7f-\x9f]/.test(item.model.model) && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(item.model.model)));
}

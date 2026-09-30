import { ROOM_ROLES, type RoomMemberModel, type RoomRole } from './rooms';

/** Editable roster only. No transcripts, activity payloads or runtime credentials. */
export interface RoomMemberDesignRow {
  key: string;
  memberId?: string;
  role: RoomRole;
  displayName: string;
  instructions: string;
  model: RoomMemberModel | null;
}
export type RoomMemberDesignOperation =
  | { kind: 'add'; member: Omit<RoomMemberDesignRow, 'key' | 'memberId'> }
  | { kind: 'update'; key: string; fields: Partial<Omit<RoomMemberDesignRow, 'key' | 'memberId'>> }
  | { kind: 'remove'; key: string };
export interface RoomMemberDesignInput {
  expectedRoomVersion: number;
  instruction: string;
  members: RoomMemberDesignRow[];
  model?: RoomMemberModel | null;
}
export interface RoomMemberDesignProposal {
  summary: string;
  operations: RoomMemberDesignOperation[];
}
export function validDesignModel(model: unknown): model is RoomMemberModel | null {
  if (model === null) return true;
  if (!model || typeof model !== 'object' || Array.isArray(model)) return false;
  const m = model as RoomMemberModel;
  return Object.keys(m).every(key => ['provider', 'model', 'effort'].includes(key))
    && ['claude', 'codex', 'deepseek'].includes(m.provider) && ['low', 'medium', 'high'].includes(m.effort)
    && typeof m.model === 'string' && !/\s/.test(m.model) && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(m.model);
}
export function validDesignRows(rows: RoomMemberDesignRow[], requireCoach = true): boolean {
  return rows.length >= (requireCoach ? 1 : 0) && rows.length <= 12
    && new Set(rows.map(row => row.key)).size === rows.length
    && (!requireCoach || rows.filter(row => row.role === 'coach').length === 1)
    && rows.every(row => typeof row.key === 'string' && !/\s/.test(row.key) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.key)
      && ROOM_ROLES.includes(row.role) && typeof row.displayName === 'string' && !!row.displayName.trim()
      && row.displayName.length <= 80 && typeof row.instructions === 'string' && row.instructions.length <= 4000
      && validDesignModel(row.model));
}
/** Atomic application: reject the complete proposal if any target or final invariant is invalid. */
export function applyMemberDesignOperations(rows: RoomMemberDesignRow[], operations: RoomMemberDesignOperation[], newKey: () => string): RoomMemberDesignRow[] {
  const result = rows.map(row => ({ ...row, model: row.model ? { ...row.model } : null }));
  const touched = new Set<string>();
  for (const operation of operations) {
    if (operation.kind === 'add') result.push({ ...operation.member, key: newKey() });
    else {
      const index = result.findIndex(row => row.key === operation.key);
      if (index < 0 || touched.has(operation.key)) throw new Error('invalid_member_proposal');
      touched.add(operation.key);
      if (operation.kind === 'remove') result.splice(index, 1);
      else Object.assign(result[index], operation.fields);
    }
  }
  if (!validDesignRows(result)) throw new Error('invalid_member_proposal');
  return result;
}

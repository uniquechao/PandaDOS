import { describe, expect, test } from 'bun:test';
import { RoomMemberDesigner, parseMemberDesignInput, parseMemberDesignProposal } from './member-designer';
import type { RoomMemberDesignInput, RoomMemberDesignRow } from '../../shared/room-member-design';
import type { RoomSnapshot } from '../../shared/rooms';
import { RoomError } from './contracts';

const members: RoomMemberDesignRow[] = [
  { key: 'coach', memberId: 'coach', role: 'coach', displayName: 'Coach', instructions: 'Keep the discussion focused', model: null },
  { key: 'writer', memberId: 'writer', role: 'writer', displayName: 'Writer', instructions: 'Deliver an actionable proposal', model: { provider: 'codex', model: 'test-model', effort: 'high' } },
  { key: 'reviewer', memberId: 'reviewer', role: 'reviewer', displayName: 'Reviewer', instructions: 'Check acceptance criteria', model: null },
];
const snapshot = { room: { id: 'room', projectId: 1, version: 4 }, members: members.map(m => ({ ...m, id: m.memberId, status: 'active' })), goal: { request: 'Design a workspace' }, contributions: [{ text: 'DO_NOT_SHARE_DISCUSSION' }] } as unknown as RoomSnapshot;
const input = (): RoomMemberDesignInput => ({ expectedRoomVersion: 4, instruction: 'Update the writer and add a UX reviewer', members: structuredClone(members) });
const result = JSON.stringify({ summary: 'Updated the team', operations: [
  { kind: 'update', key: 'writer', fields: { instructions: 'Produce a detailed design' } },
  { kind: 'remove', key: 'reviewer' },
  { kind: 'add', member: { role: 'reviewer', displayName: 'UX reviewer', instructions: 'Check interaction details', model: null } },
] });
const catalog = { providers: [{ provider: 'codex' as const, available: true, defaultModel: 'test-model', models: [{ id: 'test-model', efforts: ['high' as const] }] }] };

describe('bounded Agent member proposals', () => {
  test('input accepts the complete editable roster and rejects foreign or hidden fields', () => {
    expect(parseMemberDesignInput(input(), snapshot).members).toEqual(members);
    expect(() => parseMemberDesignInput({ ...input(), members: [{ ...members[0], memberId: 'foreign' }] }, snapshot)).toThrow('scope_mismatch');
    expect(() => parseMemberDesignInput({ ...input(), members: [{ ...members[0], transcript: 'private' }] }, snapshot)).toThrow('invalid_request');
    expect(() => parseMemberDesignInput({ ...input(), model: { provider: 'codex', model: 'test\n', effort: 'high' } }, snapshot)).toThrow('invalid_request');
    expect(parseMemberDesignInput({ ...input(), members: [] }, snapshot).members).toEqual([]);
  });
  test('mixed operations validate atomically, preserving inputs and exactly one coach', () => {
    const before = structuredClone(members);
    expect(parseMemberDesignProposal(result, members).operations).toHaveLength(3);
    expect(members).toEqual(before);
    const bad = (operations: unknown[]) => () => parseMemberDesignProposal(JSON.stringify({ summary: '', operations }), members);
    expect(bad([{ kind: 'remove', key: 'coach' }])).toThrow();
    expect(bad([{ kind: 'remove', key: 'unknown' }])).toThrow();
    expect(bad([{ kind: 'update', key: 'writer', fields: { model: { provider: 'other', model: 'test', effort: 'high' } } }])).toThrow();
    expect(bad([{ kind: 'update', key: 'writer', fields: { memberId: 'foreign' } }])).toThrow();
    expect(bad([{ kind: 'remove', key: 'reviewer' }, { kind: 'update', key: 'reviewer', fields: { displayName: 'Old reviewer' } }])).toThrow();
    expect(() => parseMemberDesignProposal(JSON.stringify({ summary: '', operations: [], reasoning: 'private' }), members)).toThrow();
    expect(bad(Array.from({ length: 10 }, () => ({ kind: 'add', member: { ...members[1], key: undefined, memberId: undefined } })))).toThrow();
  });
  test('single flight and same-key retry use one bounded model call and share only editable inputs', async () => {
    let calls = 0, release!: () => void, captured = '';
    const gate = new Promise<void>(resolve => { release = resolve; });
    const designer = new RoomMemberDesigner({ modelCatalog: () => catalog, designMembers: async (request) => {
      calls++; captured = JSON.stringify(request.messages); await gate;
      expect(request.deadlineTs - Date.now()).toBeLessThanOrEqual(120_000);
      expect(request.model.provider).toBe('codex'); return result;
    } });
    const one = designer.propose(snapshot, input(), 1, 'same', () => {});
    const two = designer.propose(snapshot, input(), 1, 'same', () => {});
    await expect(designer.propose(snapshot, input(), 1, 'other', () => {})).rejects.toThrow('state_conflict');
    release(); expect(await one).toEqual(await two);
    expect(await designer.propose(snapshot, input(), 1, 'same', () => {})).toEqual(JSON.parse(result));
    expect(calls).toBe(1); expect(captured).toContain('Deliver an actionable proposal'); expect(captured).not.toContain('DO_NOT_SHARE_DISCUSSION');
    await expect(designer.propose(snapshot, { ...input(), instruction: 'Different request' }, 1, 'same', () => {})).rejects.toThrow('idempotency_conflict');
    await designer.stop();
  });
  test('rechecks authorization after generation and shutdown aborts without publishing a proposal', async () => {
    let allowed = true;
    const designer = new RoomMemberDesigner({ modelCatalog: () => catalog, designMembers: async () => { allowed = false; return result; } });
    await expect(designer.propose(snapshot, input(), 1, 'revoked', () => { if (!allowed) throw new RoomError('forbidden'); })).rejects.toThrow('forbidden');
    await designer.stop();
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
    const pending = new RoomMemberDesigner({ modelCatalog: () => catalog, designMembers: async (_request, signal) => {
      began(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return result;
    } });
    const flight = pending.propose(snapshot, input(), 1, 'stop', () => {}).then(() => null, error => error);
    await started; await pending.stop(); expect(await flight).toBeInstanceOf(Error);
    await expect(pending.propose(snapshot, input(), 1, 'later', () => {})).rejects.toThrow('unavailable');
  });
});

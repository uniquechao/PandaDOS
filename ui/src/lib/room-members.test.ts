import { describe, expect, test } from 'bun:test';
import { applyMemberProposal, memberDesignRows, addMemberDraft, canEditMembers, memberChanges, memberDraft, rebaseMembers, validMemberRows } from './room-members';
import type { RoomMemberModel, RoomSnapshot, RoomState } from '../../../shared/rooms';

function snapshot(version = 7): RoomSnapshot {
  const roomId = 'member-room';
  return {
    room: { id: roomId, projectId: 1, title: 'Member team', status: 'active', version, eventCursor: version, createdAt: 0, updatedAt: 0 },
    members: (['coach', 'planner', 'writer', 'reviewer'] as const).map(role => ({ id: `member-${role}`, projectId: 1, roomId, role, displayName: role, address: `room/${roomId}/agent/member-${role}`, modelProfile: 'default', status: 'active', version: 3, instructions: '' })),
    mission: { id: 'mission', roomId, projectId: 1, state: 'draft', phase: 'aligning', version: 5, controlEpoch: 1, goalRevision: 1, round: 0, nextRole: 'coach', locale: 'en', actorUserId: 1, budget: { limits: { modelRequests: 48, activeMs: 1200000, rounds: 4 }, modelRequests: 0, activeMs: 0 }, question: null, reasonCode: null, createdAt: 0, updatedAt: 0 },
    goal: null, contributions: [], artifacts: [], assessments: [], issueLinks: [], eventCursor: version,
    capabilities: { canStart: true, canPause: false, canResume: false, canStop: true, canEditGoal: true, canAddBudget: true, canPublish: true, canContribute: true, canArchive: false },
  };
}
const codex: RoomMemberModel = { provider: 'codex', model: 'gpt-5.4', effort: 'medium' };

describe('member editing drafts', () => {
  test('opening captures stable room/member CAS and a detached model baseline', () => {
    const source = snapshot(); source.members[2].model = { ...codex };
    const draft = memberDraft(source);
    expect(memberChanges(draft)).toEqual([]); expect(draft.expectedRoomVersion).toBe(7);
    source.room.version = 8; source.members[2].version = 4; source.members[2].model!.effort = 'low';
    expect(draft.expectedRoomVersion).toBe(7); expect(draft.rows[2].version).toBe(3); expect(draft.baseline[2].model?.effort).toBe('medium');
    draft.rows[2].model!.effort = 'high';
    expect(draft.baseline[2].model?.effort).toBe('medium');
    expect(memberChanges(draft)).toEqual([{ id: 'member-writer', expectedVersion: 3, model: { ...codex, effort: 'high' } }]);
  });

  test('diff preserves raw text and model clear, ignores unchanged object property order', () => {
    const source = snapshot(); source.members[2].model = { ...codex }; const draft = memberDraft(source);
    draft.rows[2].model = { effort: 'medium', model: 'gpt-5.4', provider: 'codex' };
    expect(memberChanges(draft)).toEqual([]);
    draft.rows[2].displayName = '  Main writer  '; draft.rows[2].instructions = '  Exact instructions\n'; draft.rows[2].model = null;
    expect(memberChanges(draft)).toEqual([{ id: 'member-writer', expectedVersion: 3, displayName: '  Main writer  ', instructions: '  Exact instructions\n', model: null }]);
    draft.rows[2].model = { ...codex, effort: 'high' };
    const rebased = rebaseMembers(draft, snapshot(8)); rebased.rows[2].model!.effort = 'low';
    expect(draft.rows[2].model.effort).toBe('high');
  });

  test('new additions have independent draft identities, deleted additions vanish, existing removal has only its CAS', () => {
    const draft = memberDraft(snapshot()); const first = addMemberDraft('writer', 'New writer', codex), second = addMemberDraft('planner', 'Discarded');
    expect(first.key).not.toBe(second.key); expect(first.id).toBeUndefined();
    codex.effort = 'high'; expect(first.model?.effort).toBe('medium'); codex.effort = 'medium';
    second.removed = true; draft.rows.push(first, second); draft.rows[1].displayName = 'Edited then removed'; draft.rows[1].removed = true;
    expect(memberChanges(draft)).toEqual([{ id: 'member-planner', expectedVersion: 3, remove: true }, { role: 'writer', displayName: 'New writer', instructions: '', model: { ...codex } }]);
  });

  test('explicit rebase applies only local field edits while retaining concurrent remote settings and roster additions', () => {
    const draft = memberDraft(snapshot()); draft.rows[2].displayName = 'Locally renamed author'; draft.rows[1].removed = true;
    const added = addMemberDraft('reviewer', 'Local new reviewer'); draft.rows.push(added);
    const remote = snapshot(9); remote.members[2] = { ...remote.members[2], version: 6, instructions: 'Remote instructions', model: { provider: 'claude', model: 'claude-sonnet-4-5', effort: 'high' } };
    remote.members.push({ ...remote.members[1], id: 'remote-new-planner', displayName: 'Remote additional planner' });
    const rebased = rebaseMembers(draft, remote), writer = rebased.rows.find(item => item.id === 'member-writer')!;
    expect(rebased.expectedRoomVersion).toBe(9); expect(writer).toMatchObject({ version: 6, displayName: 'Locally renamed author', instructions: 'Remote instructions', model: remote.members[2].model });
    expect(rebased.rows.find(item => item.id === 'remote-new-planner')?.displayName).toBe('Remote additional planner');
    expect(rebased.rows.find(item => item.key === added.key)?.displayName).toBe('Local new reviewer');
    expect(memberChanges(rebased)).toEqual([{ id: 'member-planner', expectedVersion: 3, remove: true }, { id: 'member-writer', expectedVersion: 6, displayName: 'Locally renamed author' }, { role: 'reviewer', displayName: 'Local new reviewer', instructions: '', model: null }]);
    expect(draft.expectedRoomVersion).toBe(7); expect(draft.rows[2].version).toBe(3);
  });

  test('remote retirement never becomes a new member, requires discarding an orphan local edit', () => {
    const draft = memberDraft(snapshot()); draft.rows[2].displayName = 'Local old author'; draft.rows[1].removed = true;
    const remote = snapshot(10); remote.members[2].status = 'retired'; remote.members[1].status = 'retired';
    const rebased = rebaseMembers(draft, remote), orphan = rebased.rows.find(item => item.id === 'member-writer')!;
    expect(orphan).toMatchObject({ id: 'member-writer', orphan: true, displayName: 'Local old author' }); expect(validMemberRows(rebased.rows)).toBe(false);
    expect(rebased.rows.some(item => item.id === 'member-planner')).toBe(false);
    orphan.removed = true; expect(memberChanges(rebased)).toEqual([]); expect(validMemberRows(rebased.rows)).toBe(true);
    expect(remote.members[2].status).toBe('retired');
  });

  test('an unknown request remains bound to its original payload/key/CAS across attempted rebase', () => {
    const draft = memberDraft(snapshot()); draft.rows[2].displayName = 'Already submitted';
    draft.request = { key: 'stable-unknown-key', input: { expectedRoomVersion: draft.expectedRoomVersion, changes: memberChanges(draft) } };
    const original = structuredClone(draft), rebased = rebaseMembers(draft, snapshot(11));
    expect(rebased).toBe(draft); expect(rebased).toEqual(original); expect(rebased.request!.input.expectedRoomVersion).toBe(7);
  });
});

describe('member form readiness', () => {
  test('exactly one coach and at most twelve active rows, without requiring temporary vacancies to be filled', () => {
    const draft = memberDraft(snapshot()); expect(validMemberRows(draft.rows)).toBe(true);
    const coachOnly = draft.rows.filter(item => item.role === 'coach'); expect(validMemberRows(coachOnly)).toBe(true);
    expect(validMemberRows([])).toBe(false); expect(validMemberRows(draft.rows.filter(item => item.role !== 'coach'))).toBe(false);
    expect(validMemberRows([...draft.rows, addMemberDraft('coach', 'Duplicate coach')])).toBe(false);
    const full = [...draft.rows, ...Array.from({ length: 8 }, (_, i) => addMemberDraft('writer', `Writer ${i}`))]; expect(validMemberRows(full)).toBe(true);
    expect(validMemberRows([...full, addMemberDraft('writer', 'Thirteenth')])).toBe(false);
    expect(validMemberRows([...draft.rows, { ...draft.rows[2] }])).toBe(false);
    expect(validMemberRows([...draft.rows, { ...draft.rows[2], key: 'duplicate-id' }])).toBe(false);
  });

  test('validates model provider/effort and identifiers including final newline, role, name and instructions', () => {
    const rows = memberDraft(snapshot()).rows;
    const valid = () => validMemberRows(rows); rows[2].model = { ...codex }; expect(valid()).toBe(true);
    for (const id of ['gpt-5.4\n', 'gpt-5.4\r', 'gpt 5.4', '-flag', 'name+suffix', 'x'.repeat(201)]) { rows[2].model!.model = id; expect(valid()).toBe(false); }
    rows[2].model!.model = 'provider/path:model-1.0'; expect(valid()).toBe(true);
    rows[2].model = { ...codex, provider: 'unknown' as never }; expect(valid()).toBe(false);
    rows[2].model = { ...codex, effort: 'max' as never }; expect(valid()).toBe(false);
    rows[2].model = null; rows[2].role = 'other' as never; expect(valid()).toBe(false); rows[2].role = 'writer';
    rows[2].displayName = ' \n '; expect(valid()).toBe(false); rows[2].displayName = 'x'.repeat(81); expect(valid()).toBe(false);
    rows[2].displayName = 'Writer'; rows[2].instructions = 'x'.repeat(4001); expect(valid()).toBe(false);
  });

  test('all stationary states allow editing while active execution, archive and revocation deny it', () => {
    const source = snapshot();
    for (const state of ['draft', 'paused', 'completed', 'stopped', 'waiting_user', 'interrupted', 'exhausted'] as RoomState[]) { source.mission!.state = state; expect(canEditMembers(source)).toBe(true); }
    for (const state of ['queued', 'running', 'quiescing'] as RoomState[]) { source.mission!.state = state; expect(canEditMembers(source)).toBe(false); }
    source.mission!.state = 'paused'; source.members[0].activity = { state: 'working' }; expect(canEditMembers(source)).toBe(false);
    source.members[0].activity = { state: 'idle' }; source.room.status = 'archived'; expect(canEditMembers(source)).toBe(false);
    source.room.status = 'active'; source.capabilities.canPublish = false; expect(canEditMembers(source)).toBe(false);
  });
});


test('Agent roster operations remain a draft with the original CAS and retired-member history', () => {
  const draft = memberDraft(snapshot());
  draft.rows[2].instructions = 'Unsaved detailed instructions';
  expect(memberDesignRows(draft)[2].instructions).toBe('Unsaved detailed instructions');
  const next = applyMemberProposal(draft, { summary: 'Updated', operations: [
    { kind: 'update', key: 'member-writer', fields: { displayName: 'Lead author' } },
    { kind: 'remove', key: 'member-planner' },
    { kind: 'add', member: { role: 'reviewer', displayName: 'UX reviewer', instructions: 'Review UX', model: codex } },
  ] });
  expect(next.expectedRoomVersion).toBe(7);
  expect(next.rows.find(m => m.id === 'member-writer')).toMatchObject({ version: 3, instructions: 'Unsaved detailed instructions' });
  expect(next.rows.find(m => m.id === 'member-planner')?.removed).toBe(true);
  expect(memberChanges(next)).toHaveLength(3);
  expect(draft.rows.find(m => m.id === 'member-planner')?.removed).toBeUndefined();
  expect(() => applyMemberProposal(draft, { summary: '', operations: [{ kind: 'remove', key: 'member-coach' }] })).toThrow();
  draft.request = { key: 'pending', input: { expectedRoomVersion: 7, changes: memberChanges(draft) } };
  expect(() => applyMemberProposal(draft, { summary: '', operations: [] })).toThrow('member_save_pending');
});

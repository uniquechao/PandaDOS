import { afterEach, describe, expect, test } from 'bun:test';
import { acceptRoomSnapshot, mergeRoomView, roomDiffLines, roomDraftKey, roomsApi, roomVersionPassed } from './rooms-api';
import { parseHash } from './router';
import type { RoomSnapshot } from '../../../shared/rooms';

function snapshot(): RoomSnapshot {
  return {
    room: { id: 'room-a', projectId: 1, title: 'A', status: 'active', version: 3, eventCursor: 4, createdAt: 1, updatedAt: 2 },
    mission: { id: 'mission-a', roomId: 'room-a', projectId: 1, state: 'completed', phase: 'finalizing', version: 5, controlEpoch: 2, goalRevision: 1, round: 1, nextRole: 'coach', locale: 'en', actorUserId: 1,
      budget: { limits: { modelRequests: 48, activeMs: 1200000, rounds: 4 }, modelRequests: 8, activeMs: 5000 }, question: null, reasonCode: null, createdAt: 1, updatedAt: 2 },
    goal: { id: 'goal-a', missionId: 'mission-a', revision: 1, request: 'Write a guide.', criteria: [{ id: 'criterion-a', description: 'Three examples', required: true }], createdAt: 1 },
    members: [], contributions: [],
    artifacts: [{ id: 'artifact-a', roomId: 'room-a', missionId: 'mission-a', title: 'Guide', currentVersion: 2, adoptedVersion: null,
      versions: [1, 2].map((version) => ({ artifactId: 'artifact-a', version, goalRevision: 1, title: 'Guide', markdown: 'Guide', digest: 'hash', authorMemberId: 'writer', createdAt: version })) }],
    assessments: [{ id: 'review-a', artifactId: 'artifact-a', artifactVersion: 2, goalRevision: 1, criterionId: 'criterion-a', verdict: 'passed', note: 'Verified', reviewerMemberId: 'reviewer', createdAt: 3 }],
    issueLinks: [], capabilities: { canStart: false, canPause: false, canResume: false, canStop: false, canEditGoal: false, canAddBudget: false, canPublish: true, canContribute: false, canArchive: true }, eventCursor: 4,
  };
}

describe('room scope and immutable version presentation', () => {
  test('ignores a late snapshot from a previous room, project or cursor', () => {
    const current = snapshot();
    expect(acceptRoomSnapshot(1, 'room-a', null, current)).toBe(true);
    expect(acceptRoomSnapshot(2, 'room-a', null, current)).toBe(false);
    expect(acceptRoomSnapshot(1, 'room-b', null, current)).toBe(false);
    expect(acceptRoomSnapshot(1, 'room-a', current, { ...current, eventCursor: 3 })).toBe(false);
    expect(acceptRoomSnapshot(1, 'room-a', current, { ...current, room: { ...current.room, version: 2 } })).toBe(false);
  });
  test('does not reuse approval across artifact versions, goals or missions', () => {
    const value = snapshot();
    expect(roomVersionPassed(value, 'artifact-a', 2)).toBe(true);
    expect(roomVersionPassed(value, 'artifact-a', 1)).toBe(false);
    value.goal!.revision = 2;
    expect(roomVersionPassed(value, 'artifact-a', 2)).toBe(false);
    value.goal!.revision = 1; value.mission!.id = 'mission-b';
    expect(roomVersionPassed(value, 'artifact-a', 2)).toBe(false);
  });
  test('a later failed assessment supersedes an earlier pass', () => {
    const value = snapshot();
    value.assessments.push({ ...value.assessments[0], id: 'review-b', verdict: 'failed', createdAt: 4 });
    expect(roomVersionPassed(value, 'artifact-a', 2)).toBe(false);
  });
  test('polling retains loaded history and version content, but resets across a missing history gap', () => {
    const current = snapshot();
    const contribution = (seq: number) => ({ id: `c${seq}`, roomId: 'room-a', missionId: 'mission-a', goalRevision: 1, seq, authorType: 'user' as const, authorId: '1', kind: 'message' as const, text: 'Formal', audience: { kind: 'room' as const }, createdAt: seq });
    current.contributions = [1, 2, 3].map(contribution); current.history = { hasMore: false, beforeSeq: 1 };
    const next = { ...snapshot(), contributions: [3, 4].map(contribution), history: { hasMore: true, beforeSeq: 3 } };
    next.artifacts[0]!.versions[1] = { ...next.artifacts[0]!.versions[1]!, markdown: '', contentLoaded: false };
    const merged = mergeRoomView(current, next);
    expect(merged.contributions.map(item => item.seq)).toEqual([1, 2, 3, 4]);
    expect(merged.history).toEqual({ hasMore: false, beforeSeq: 1 });
    expect(merged.artifacts[0]!.versions[1]!.markdown).toBe('Guide');
    const gap = mergeRoomView(current, { ...next, contributions: [8, 9].map(contribution), history: { hasMore: true, beforeSeq: 8 } });
    expect(gap.contributions.map(item => item.seq)).toEqual([8, 9]); expect(gap.history?.hasMore).toBe(true);
  });
  test('draft storage identity includes user, project and room', () => {
    expect(new Set([roomDraftKey(1, 2, 'a'), roomDraftKey(2, 2, 'a'), roomDraftKey(1, 3, 'a'), roomDraftKey(1, 2, 'b')]).size).toBe(4);
  });
  test('deep links select immutable versions and tolerate malformed identities', () => {
    expect(parseHash('#/p/12/rooms')).toEqual({ name: 'rooms', pid: 12 });
    expect(parseHash('#/p/12/rooms/room-a?artifact=artifact-a&version=2')).toEqual({ name: 'room', pid: 12, rid: 'room-a', artifactId: 'artifact-a', artifactVersion: 2 });
    expect(parseHash('#/p/12/rooms/room-a?member=writer')).toEqual({ name: 'room', pid: 12, rid: 'room-a', memberId: 'writer' });
    expect(parseHash('#/p/12/rooms/%')).toEqual({ name: 'rooms', pid: 12 });
    expect(parseHash('#/p/12/rooms/room-a?artifact=a&version=-1')).toEqual({ name: 'room', pid: 12, rid: 'room-a', artifactId: 'a' });
    expect(parseHash('#/p/12/rooms/room-a?panel=goal')).toEqual({ name: 'room', pid: 12, rid: 'room-a', panel: 'goal' });
    expect(parseHash('#/p/12/rooms/room-a?panel=unknown')).toEqual({ name: 'room', pid: 12, rid: 'room-a' });
    expect(parseHash('#/p/12/rooms/room-a?panel=goal&artifact=a&version=2&member=coach')).toEqual({ name: 'room', pid: 12, rid: 'room-a', artifactId: 'a', artifactVersion: 2 });
  });
  test('diff preserves content and distinguishes real additions and removals', () => {
    expect(roomDiffLines('Heading\nOld\nEnd', 'Heading\nNew\nEnd')).toEqual([
      { kind: 'same', text: 'Heading' }, { kind: 'removed', text: 'Old' }, { kind: 'added', text: 'New' }, { kind: 'same', text: 'End' },
    ]);
    const long = 'x\n'.repeat(600);
    expect(roomDiffLines(long, `${long}y`)).toHaveLength(2);
  });
});

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
describe('room mutation transport', () => {
  test('issue preview and publish are distinct requests and publication carries stable idempotency', async () => {
    const requests: Array<{ path: string; method: string; body: unknown; key: string | null }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ path: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('Idempotency-Key') });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    await roomsApi.preview(1, 'room-a', 'artifact-a', 2);
    const draft = { artifactId: 'artifact-a', artifactVersion: 2, title: 'Implement', body: 'Scope' };
    await roomsApi.publish(1, 'room-a', draft, 7, 'publish-1');
    await roomsApi.publish(1, 'room-a', draft, 7, 'publish-1');
    expect(requests[0]).toEqual({ path: '/api/projects/1/rooms/room-a/issues/preview', method: 'POST', body: { artifactId: 'artifact-a', artifactVersion: 2 }, key: null });
    expect(requests[1].body).toEqual({ draft, expectedVersion: 7 });
    expect(requests[1].key).toBe('publish-1'); expect(requests[2]).toEqual(requests[1]);
  });
  test('directed messages contain only selected member IDs and the stable message identity', async () => {
    let body: unknown;
    globalThis.fetch = (async (_, init) => { body = JSON.parse(String(init?.body)); return new Response('{}'); }) as typeof fetch;
    await roomsApi.contribute(1, 'room-a', { text: 'Please review', audience: { kind: 'members', memberIds: ['reviewer'] }, clientMessageId: 'message-1' });
    expect(body).toEqual({ text: 'Please review', audience: { kind: 'members', memberIds: ['reviewer'] }, clientMessageId: 'message-1' });
  });
});

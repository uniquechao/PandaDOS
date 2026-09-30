import { afterEach, describe, expect, test } from 'bun:test';
import { RoomAnswerController, roomAnswerStorageKey } from './room-answer';
import type { RoomSnapshot } from '../../../shared/rooms';

function snapshot(questionId = 'question-a', version = 5, goalRevision = 1): RoomSnapshot {
  return {
    room: { id: 'room-a', projectId: 1, title: 'Room', status: 'active', version: 1, eventCursor: version, createdAt: 0, updatedAt: 0 },
    mission: { id: 'mission-a', projectId: 1, roomId: 'room-a', state: 'waiting_user', phase: 'aligning', version, goalRevision, controlEpoch: 1, round: 0, nextRole: 'coach', locale: 'en', actorUserId: 2,
      budget: { limits: { modelRequests: 48, activeMs: 1200000, rounds: 4 }, modelRequests: 1, activeMs: 100 }, question: { id: questionId, text: 'Who is the audience?', options: ['Designers', 'Engineers'] }, reasonCode: 'user_input_required', createdAt: 0, updatedAt: 0 },
    goal: { id: `goal-${goalRevision}`, missionId: 'mission-a', revision: goalRevision, request: 'Write an introduction', criteria: [], createdAt: 0 },
    members: [], artifacts: [], assessments: [], contributions: [], issueLinks: [],
    capabilities: { canStart: false, canPause: false, canResume: false, canStop: true, canEditGoal: true, canAddBudget: true, canPublish: true, canContribute: true, canArchive: false }, runtime: { configured: true }, eventCursor: version,
  };
}
function memory() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function setup(extra: Partial<ConstructorParameters<typeof RoomAnswerController>[0]> = {}) {
  const storage = memory(), errors: unknown[] = [], confirmed: RoomSnapshot[] = [];
  let counter = 0;
  const options = { pid: 1, rid: 'room-a', userId: 2, storage, requestKey: () => `answer-${++counter}`,
    onFailure: (error: unknown) => { errors.push(error); }, onSnapshot: (value: RoomSnapshot) => { confirmed.push(value); }, ...extra };
  const controller = new RoomAnswerController(options);
  controller.update(snapshot(), true);
  return { controller, storage, errors, confirmed, options };
}
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('question-bound reply composer', () => {
  test('choosing an option never sends, normal mode retains its separate question draft through refresh', () => {
    let sends = 0;
    const c = setup({ send: async () => { sends++; return snapshot(); } });
    expect(c.controller.state.mode).toBe(true);
    c.controller.selectOption('question-a', 'Engineers');
    c.controller.setText('  Preserve this explanation\n');
    expect(c.controller.state).toMatchObject({ option: 'Engineers', text: '  Preserve this explanation\n', canSend: true });
    c.controller.leave();
    expect(c.controller.state).toMatchObject({ mode: false, canSend: false });
    const reload = new RoomAnswerController(c.options); reload.update(snapshot(), true);
    expect(reload.state).toMatchObject({ mode: false, option: 'Engineers', text: '  Preserve this explanation\n' });
    reload.begin();
    expect(reload.state.canSend).toBe(true);
    reload.selectOption('historical-question', 'Designers');
    reload.selectOption('question-a', 'An invented option');
    expect(reload.state.option).toBe('Engineers');
    expect(sends).toBe(0);
  });
  test('CAS changes require explicit rebase, and another goal or question cannot inherit the old draft', () => {
    const c = setup(); c.controller.setText('Old target answer');
    c.controller.update(snapshot('question-a', 6), true);
    expect(c.controller.state).toMatchObject({ stale: true, canSend: false });
    c.controller.rebase();
    expect(c.controller.state).toMatchObject({ stale: false, canSend: true, text: 'Old target answer' });
    c.controller.update(snapshot('question-a', 7, 2), true);
    c.controller.rebase();
    expect(c.controller.state.stale).toBe(true);
    c.controller.update(snapshot('question-b', 8, 2), true);
    c.controller.rebase();
    expect(c.controller.state).toMatchObject({ questionId: 'question-a', stale: true });
    c.controller.begin('question-a');
    expect(c.controller.state.questionId).toBe('question-a');
    c.controller.begin('question-b');
    expect(c.controller.state).toMatchObject({ questionId: 'question-b', text: '', option: null, stale: false, canSend: false });
    const persisted = JSON.parse(c.storage.data.get(roomAnswerStorageKey(2, 1, 'room-a'))!);
    expect(persisted.drafts.find((draft: {questionId: string}) => draft.questionId === 'question-a').text).toBe('Old target answer');
  });
  test('offline, scope mismatch and combined option/text length prevent new submissions', async () => {
    let sends = 0;
    const c = setup({ send: async () => { sends++; return snapshot(); } });
    c.controller.setText('Answer'); c.controller.update(snapshot(), false);
    expect(await c.controller.submit()).toBe(false);
    c.controller.update({ ...snapshot(), room: { ...snapshot().room, id: 'room-b' } }, true);
    expect(await c.controller.submit()).toBe(false);
    c.controller.update(snapshot(), true); c.controller.selectOption('question-a', 'Engineers'); c.controller.setText('x'.repeat(8000));
    expect(await c.controller.submit()).toBe(false);
    expect(sends).toBe(0);
    expect(new Set([roomAnswerStorageKey(2, 1, 'room-a'), roomAnswerStorageKey(3, 1, 'room-a'), roomAnswerStorageKey(2, 2, 'room-a'), roomAnswerStorageKey(2, 1, 'room-b')]).size).toBe(4);
  });
});

describe('durable answer submission and replay', () => {
  test('persists the exact payload before fetch and replays it after lost response and refresh even after the room advances', async () => {
    const c = setup();
    const requests: Array<{ url: string; body: unknown; key: string | null }> = [];
    let loseResponse = true;
    const advanced = snapshot('question-b', 8, 2);
    globalThis.fetch = (async (url, init) => {
      const request = { url: String(url), body: JSON.parse(String(init?.body)), key: new Headers(init?.headers).get('Idempotency-Key') };
      const persisted = JSON.parse(c.storage.data.get(roomAnswerStorageKey(2, 1, 'room-a'))!);
      expect(persisted.drafts[0].request).toMatchObject({ key: request.key, input: request.body });
      requests.push(request);
      if (loseResponse) throw new TypeError('Response was lost after commit');
      return new Response(JSON.stringify(advanced), { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    c.controller.selectOption('question-a', 'Engineers'); c.controller.setText('  Include beginners.\n');
    expect(await c.controller.submit()).toBe(false);
    expect(c.controller.state).toMatchObject({ uncertain: true, pending: false });
    c.controller.dispose();
    const reload = new RoomAnswerController(c.options);
    const running = { ...advanced, mission: { ...advanced.mission!, state: 'running' as const, question: null } };
    reload.update(running, true);
    expect(reload.state).toMatchObject({ questionId: 'question-a', stale: true, uncertain: true, canSend: true });
    reload.setText('Cannot replace an uncertain answer'); reload.selectOption('question-b', 'Designers'); reload.rebase(); reload.begin('question-b');
    expect(reload.state.text).toBe('  Include beginners.\n');
    loseResponse = false;
    expect(await reload.submit()).toBe(true);
    expect(requests[0]).toEqual({ url: '/api/projects/1/rooms/room-a/missions/mission-a/answer', body: { expectedVersion: 5, questionId: 'question-a', answer: 'Engineers\n\n  Include beginners.\n' }, key: 'answer-1' });
    expect(requests[1]).toEqual(requests[0]);
    expect(reload.state).toMatchObject({ mode: false, uncertain: false, text: '' });
    expect(c.confirmed).toEqual([advanced]);
  });
  test('only definite 400/409 replies permit editing and new request identity', async () => {
    for (const status of [400, 409, 0, 500, 502, 403]) {
      const sent: Array<{ key: string; input: unknown }> = [];
      let responseStatus = status;
      const c = setup({ send: async (_missionId, input, key) => {
        sent.push({ key, input });
        if (responseStatus) throw { status: responseStatus };
        if (status === 0 && sent.length === 1) throw { status: 0 };
        return snapshot();
      } });
      c.controller.setText('First answer');
      expect(await c.controller.submit()).toBe(false);
      const definite = status === 400 || status === 409;
      expect(c.controller.state.uncertain).toBe(!definite);
      c.controller.setText('Edited after rejection'); responseStatus = 0;
      expect(await c.controller.submit()).toBe(true);
      expect(sent[1]!.key).toBe(definite ? 'answer-2' : 'answer-1');
      expect(sent[1]!.input).toMatchObject({ answer: definite ? 'Edited after rejection' : 'First answer' });
    }
  });
  test('double clicks do not dispatch twice, and late completion cannot update an unmounted room', async () => {
    let finish!: (snapshot: RoomSnapshot) => void; let sends = 0;
    const c = setup({ send: () => { sends++; return new Promise(resolve => { finish = resolve; }); } });
    c.controller.setText('The selected answer');
    const first = c.controller.submit();
    expect(c.controller.state.pending).toBe(true);
    expect(await c.controller.submit()).toBe(false);
    c.controller.setText('Must not edit in flight');
    c.controller.dispose(); finish(snapshot());
    expect(await first).toBe(true);
    expect(sends).toBe(1); expect(c.confirmed).toEqual([]);
    const reload = new RoomAnswerController(c.options); reload.update(snapshot(), true);
    expect(reload.state.uncertain).toBe(false);
    expect(reload.state.mode).toBe(false);
  });
  test('storage failure prevents dispatch and an unrelated success response cannot erase recovery state', async () => {
    let calls = 0;
    const c = setup({ storage: { getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } }, send: async () => { calls++; return snapshot(); } });
    c.controller.setText('Keep this text');
    expect(await c.controller.submit()).toBe(false);
    expect(c.controller.state).toMatchObject({ text: 'Keep this text', uncertain: false, pending: false });
    expect(calls).toBe(0); expect(c.errors).toHaveLength(1);
    const wrong = setup({ send: async () => ({ ...snapshot(), room: { ...snapshot().room, id: 'another-room' } }) });
    wrong.controller.setText('Answer');
    expect(await wrong.controller.submit()).toBe(false);
    expect(wrong.controller.state.uncertain).toBe(true);
    expect(wrong.confirmed).toEqual([]);
  });
  test('late responses neither overwrite a remounted composer nor recreate storage cleared after access loss', async () => {
    let finish!: (value: RoomSnapshot) => void;
    const c = setup({ send: () => new Promise(resolve => { finish = resolve; }) });
    c.controller.setText('Answer to the first question');
    const first = c.controller.submit(); c.controller.dispose();
    const next = snapshot('question-b', 7);
    const reopened = new RoomAnswerController({ ...c.options, send: async () => next });
    reopened.update(snapshot(), true);
    expect(await reopened.submit()).toBe(true);
    reopened.update(next, true); reopened.setText('New question draft');
    finish(next); await first;
    const refreshed = new RoomAnswerController(c.options); refreshed.update(next, true);
    expect(refreshed.state).toMatchObject({ questionId: 'question-b', text: 'New question draft' });

    let finishRevoked!: (value: RoomSnapshot) => void;
    const revoked = setup({ send: () => new Promise(resolve => { finishRevoked = resolve; }) });
    revoked.controller.setText('Private answer'); const pending = revoked.controller.submit();
    revoked.controller.dispose(); revoked.storage.data.clear();
    finishRevoked(snapshot()); await pending;
    expect(revoked.storage.data.size).toBe(0);
  });
});

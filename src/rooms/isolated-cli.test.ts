import { expect, test } from 'bun:test';
import { RoomIsolatedCliRuntime, ROOM_ISOLATION_CHECKS, verifiedRoomIsolation, type RoomIsolationEvidence } from './isolated-cli';
import type { RoomExecutionContext } from './contracts';
import { RoomHttpIsolatedLauncher } from './isolated-cli-http';
import type { FetchLike } from '../agents/llm';

const proof = (): RoomIsolationEvidence => ({ schemaVersion: 1, launcherId: 'trusted-launcher-v1', checkedAt: Date.now() - 1, expiresAt: Date.now() + 60_000, checks: Object.fromEntries(ROOM_ISOLATION_CHECKS.map(key => [key, true])) as RoomIsolationEvidence['checks'] });
test('the current environment has no configured isolated launcher and cannot fall back to shared CLI', async () => {
  const runtime = new RoomIsolatedCliRuntime();
  expect(runtime.configured()).toBe(false);
  expect((await runtime.probeIsolation(new AbortController().signal)).available).toBe(false);
  await expect(runtime.run({} as RoomExecutionContext, new AbortController().signal, () => true)).rejects.toThrow('capability_unsupported');
});
test('all independent filesystem, credential, cancellation and metering checks are mandatory', () => {
  expect(verifiedRoomIsolation(proof())).toBe(true);
  for (const key of ROOM_ISOLATION_CHECKS) {
    const evidence = proof(); evidence.checks[key] = false;
    expect(verifiedRoomIsolation(evidence)).toBe(false);
  }
  const expired = proof(); expired.expiresAt = Date.now() - 1;
  expect(verifiedRoomIsolation(expired)).toBe(false);
});

function context(): RoomExecutionContext {
  const member = { id: 'member-1', projectId: 1, roomId: 'room-1', role: 'coach' as const, displayName: 'Coach', address: 'room/room-1/agent/member-1', modelProfile: 'isolated', status: 'active' as const, version: 1 };
  return { member, members: [member], attempt: { id: 'execution-1', assignmentId: 'assignment-1', projectId: 1, roomId: 'room-1', missionId: 'mission-1', memberId: member.id, role: 'coach', kind: 'work', goalRevision: 1, round: 1, controlEpoch: 1, fence: 2, workerId: 'worker-1', leaseUntil: Date.now() + 60_000, deadlineTs: Date.now() + 60_000, audience: { kind: 'room' } }, mission: { id: 'mission-1', projectId: 1, roomId: 'room-1', state: 'running', phase: 'producing', version: 1, controlEpoch: 1, goalRevision: 1, round: 1, nextRole: 'coach', locale: 'en', actorUserId: 1, budget: { limits: { modelRequests: 48, activeMs: 1_200_000, rounds: 4 }, modelRequests: 1, activeMs: 100 }, question: null, reasonCode: null, createdAt: 1, updatedAt: 1 }, goal: { id: 'goal-1', missionId: 'mission-1', revision: 1, request: 'Write a useful proposal.', criteria: [{ id: 'criterion-1', description: 'Concrete scenarios', required: true }], createdAt: 1 }, contributions: [], artifacts: [], assessments: [] };
}

test('configurable isolated launcher probes, meters a private execution and confirms it finished', async () => {
  const operations: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(init!.body as string);
    operations.push(path);
    if (path === '/self-test') return Response.json(proof());
    if (path === '/execute') {
      expect(body.allowedTools).toEqual([]);
      expect(body.formalInput).not.toContain('PRIVATE_HOST_HOME');
      const scope = { projectId: body.projectId, roomId: body.roomId, memberId: body.memberId, missionId: body.missionId, executionId: body.executionId, controlEpoch: body.controlEpoch, fence: body.fence };
      return new Response([JSON.stringify({ ...scope, kind: 'model_request', requestId: 'request-1' }), JSON.stringify({ ...scope, kind: 'result', formalJson: '{"message":"Start the bounded workflow.","decision":"continue"}', raw: 'PRIVATE_TRANSCRIPT' }), ''].join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
    }
    if (path === '/permit') { expect(body.requestId).toBe('request-1'); return Response.json({ ok: true }); }
    if (path === '/inspect') { expect(body.formalInput).toBeUndefined(); return Response.json({ ...body, status: 'finished' }); }
    throw new Error('unexpected endpoint');
  };
  const runtime = new RoomIsolatedCliRuntime(new RoomHttpIsolatedLauncher({ endpoint: 'http://127.0.0.1:9988', token: 'private-launcher-token', fetchFn }));
  expect((await runtime.probeIsolation(new AbortController().signal)).available).toBe(true);
  const result = await runtime.run(context(), new AbortController().signal, id => { operations.push(`meter:${id}`); return true; });
  expect(result).toEqual({ message: 'Start the bounded workflow.', decision: 'continue' });
  expect(operations).toEqual(['/self-test', '/execute', 'meter:request-1', '/permit', '/inspect']);
});

test('unverified launchers and plaintext remote endpoints never start an execution', async () => {
  expect(() => new RoomHttpIsolatedLauncher({ endpoint: 'http://remote.invalid', token: 'secret' })).toThrow('capability_unsupported');
  let starts = 0;
  const backend = new RoomHttpIsolatedLauncher({ endpoint: 'https://isolated.invalid', token: 'secret', fetchFn: async url => {
    if (String(url).endsWith('/execute')) starts++;
    const evidence = proof(); evidence.checks.denies_host_credentials = false;
    return Response.json(evidence);
  } });
  const runtime = new RoomIsolatedCliRuntime(backend);
  await expect(runtime.probeIsolation(new AbortController().signal)).rejects.toThrow('capability_unsupported');
  expect(runtime.configured()).toBe(false);
  await expect(runtime.run(context(), new AbortController().signal, () => true)).rejects.toThrow('capability_unsupported');
  expect(starts).toBe(0);
});

test('unknown remote cancellation retains the execution barrier until a real confirmation', async () => {
  const controller = new AbortController();
  let executing!: () => void;
  const started = new Promise<void>(resolve => { executing = resolve; });
  let confirmed = false;
  const runtime = new RoomIsolatedCliRuntime({ selfTest: async () => proof(), execute: async () => { executing(); return new Promise(() => {}); }, inspect: async () => 'unknown', cancel: async () => confirmed ? 'confirmed' : 'unknown' }, 10);
  await runtime.probeIsolation(new AbortController().signal);
  const running = runtime.run(context(), controller.signal, () => true);
  await started; controller.abort();
  let settled = false; void running.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  confirmed = true;
  await expect(running).rejects.toThrow('cancelled');
});

test('launcher stream cannot bypass request accounting or return another room scope', async () => {
  let permits = 0, cancelled = 0;
  const backend = new RoomHttpIsolatedLauncher({ endpoint: 'https://isolated.invalid', token: 'secret', fetchFn: async (url, init) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(init!.body as string);
    if (path === '/self-test') return Response.json(proof());
    if (path === '/permit') { permits++; return Response.json({}); }
    if (path === '/cancel') { cancelled++; return Response.json({ ...body, status: 'confirmed' }); }
    return new Response(JSON.stringify({ ...body, roomId: 'other-room', kind: 'model_request', requestId: 'request-1' }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  const runtime = new RoomIsolatedCliRuntime(backend);
  await runtime.probeIsolation(new AbortController().signal);
  await expect(runtime.run(context(), new AbortController().signal, () => true)).rejects.toThrow('scope_mismatch');
  expect(permits).toBe(0); expect(cancelled).toBe(1);
});

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DEFAULT_LLM_CONFIG, type FetchLike, type LlmConfig } from '../agents/llm';
import type { RoomFormalResult, RoomScope } from './contracts';
import { RoomCoordinator } from './coordinator';
import { RoomEngine } from './engine';
import { migrateRooms } from './migrations';
import { RoomModelRuntime } from './model-runtime';
import { RoomStore } from './store';

const config = { ...DEFAULT_LLM_CONFIG, baseUrl: 'https://room-provider.invalid/v1', apiKey: 'PRIVATE_TEST_KEY', model: 'fake-room-model' };
interface Input {
  member: { id: string; role: string; address: string };
  assignment: { kind: string; round: number };
  goal: { revision: number; request: string; criteria: Array<{ id: string }> };
  contributions: Array<{ authorType: string; text: string }>;
  artifacts: Array<{ id: string; currentVersion: number }>;
  assessments: Array<{ verdict: string }>;
}
const response = (result: RoomFormalResult) => Response.json({ choices: [{ message: { content: JSON.stringify(result), reasoning_content: 'PRIVATE_PROVIDER_THOUGHT' }, finish_reason: 'stop' }] });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!assertion()) { if (Date.now() > deadline) throw new Error('timed out'); await sleep(5); }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture(handler: (input: Input, init: RequestInit) => Promise<Response> | Response, options: { budget?: { modelRequests: number }; request?: string; acquire?: (signal: AbortSignal) => Promise<() => void>; config?: () => LlmConfig } = {}) {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE projects(id INTEGER PRIMARY KEY); CREATE TABLE issues(id TEXT PRIMARY KEY,project_id INTEGER,status TEXT); INSERT INTO users VALUES(1); INSERT INTO projects VALUES(1);');
  migrateRooms(db);
  const engine = new RoomEngine({ store: new RoomStore(db) });
  const room = engine.create(1, { title: 'Room integration', request: options.request ?? 'Write three specific user scenarios.', criteria: ['Include three scenarios'], locale: 'en', start: true, budget: options.budget }, { actor: { userId: 1 }, key: 'create-room' });
  const scope: RoomScope = { projectId: 1, roomId: room.room.id };
  const inputs: Input[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const raw = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
    expect(JSON.stringify(raw.messages)).not.toContain('PRIVATE_PROVIDER_THOUGHT');
    expect(JSON.stringify(raw.messages)).not.toContain(config.apiKey);
    const input = JSON.parse(raw.messages[1].content) as Input;
    inputs.push(input);
    return handler(input, init);
  };
  const runtime = new RoomModelRuntime({ config: options.config ?? config, fetchFn, acquire: options.acquire });
  const coordinator = new RoomCoordinator({ service: engine, runtime, pollIntervalMs: 10, leaseIntervalMs: 10 });
  cleanup.push(async () => { await coordinator.stop(); db.close(); });
  const snapshot = () => engine.snapshot(scope);
  return { db, engine, coordinator, scope, snapshot, inputs };
}

function normal(input: Input, options: { revise?: boolean } = {}): RoomFormalResult {
  if (input.assignment.kind === 'reply') return { message: 'A concise formal reply.' };
  if (input.member.role === 'coach') return { message: input.assessments.some((assessment) => assessment.verdict === 'passed') ? 'The current version satisfies every criterion.' : 'Create three concrete scenarios, then review independently.', decision: input.assessments.length > 0 && input.assessments.every((assessment) => assessment.verdict === 'passed') ? 'complete' : 'continue' };
  if (input.member.role === 'planner') return { message: 'Cover a new user, a returning user, and a collaborating team.' };
  if (input.member.role === 'writer') return { message: 'The requested scenarios are ready for independent review.', artifact: { title: 'User scenarios', markdown: input.assignment.round === 1 ? '# Scenarios\n\n1. New user learns the workflow.\n2. Returning user resumes work.\n3. A team creates together.' : '# Revised scenarios\n\n1. A new user creates a first issue.\n2. A returning user resumes a saved task.\n3. A team reviews and publishes a shared draft.' } };
  const artifact = input.artifacts.at(-1)!;
  const verdict = options.revise && artifact.currentVersion === 1 ? 'failed' : 'passed';
  return { message: verdict === 'passed' ? 'All required criteria have evidence.' : 'The scenarios need concrete actions.', review: { artifactId: artifact.id, artifactVersion: artifact.currentVersion, criteria: input.goal.criteria.map(({ id }) => ({ criterionId: id, verdict, note: verdict === 'passed' ? 'The exact current version contains the three requested scenarios.' : 'Specify what each user actually does.' })) } };
}

describe('persistent room + controlled provider collaboration', () => {
  test('a restarted confirmation coordinator releases a durable stop only after launcher acknowledgment', async () => {
    const f = fixture(input => response(normal(input)));
    const old = f.engine.claimNext('old-process')!;
    expect(f.engine.setCancellationMode(old, 'confirm')).toBe(true);
    expect(f.engine.dispatched(old)).toBe(true);
    const mission = f.snapshot().mission!;
    f.engine.command(f.scope, mission.id, 'pause', { expectedVersion: mission.version }, { actor: { userId: 1 }, key: 'pause-cli-before-restart' });
    let confirmed = false, checks = 0, executions = 0;
    const restarted = new RoomCoordinator({ service: f.engine, pollIntervalMs: 10, leaseIntervalMs: 10, runtime: { cancellationMode: 'confirm', configured: () => true, confirmStopped: async attempt => { expect(attempt.id).toBe(old.id); checks++; return confirmed; }, run: async () => { executions++; throw new Error('unexpected execution'); } } });
    cleanup.push(async () => { const stopped = await restarted.stop(); await stopped.done; });
    restarted.start();
    await until(() => checks >= 1);
    expect(f.snapshot().mission?.state).toBe('quiescing');
    expect(f.engine.pendingStops()).toHaveLength(1);
    expect(executions).toBe(0);
    confirmed = true;
    restarted.wake();
    await until(() => f.snapshot().mission?.state === 'paused');
    expect(f.engine.pendingStops()).toHaveLength(0);
    expect(executions).toBe(0);
  });
  test('reads an authorized source privately, bills request two and commits exact formal evidence', async () => {
    let sourceId = '';
    const quote = 'New users need three concrete scenarios.';
    let reads = 0;
    const f = fixture((input, init) => {
      if (input.member.role !== 'writer') return response(normal(input));
      const payload = JSON.parse(init.body as string);
      if (!payload.messages.some((message: { role: string }) => message.role === 'tool')) {
        reads++;
        return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: 'PRIVATE_INTERNAL_SEARCH', tool_calls: [{ id: 'source-read-1', type: 'function', function: { name: 'read_source', arguments: JSON.stringify({ sourceId, version: 1 }) } }] } }] });
      }
      expect(payload.messages.at(-1).role).toBe('tool');
      expect(JSON.parse(payload.messages.at(-1).content).content).toBe(quote);
      expect(JSON.stringify(payload.messages)).not.toContain('PRIVATE_INTERNAL_SEARCH');
      return response({ ...normal(input), evidence: [{ sourceId, sourceVersion: 1, quote }] });
    });
    let snapshot = f.snapshot();
    snapshot = f.engine.grantSource(f.scope, { missionId: snapshot.mission!.id, goalRevision: 1, title: 'Approved source', content: quote, audience: { kind: 'room' } }, { actor: { userId: 1 }, key: 'grant-source' });
    sourceId = snapshot.sources![0].id;
    f.engine.command(f.scope, snapshot.mission!.id, 'resume', { expectedVersion: snapshot.mission!.version }, { actor: { userId: 1 }, key: 'resume-after-source' });
    f.coordinator.start();
    await until(() => f.snapshot().mission?.state === 'completed');
    snapshot = f.snapshot();
    expect(reads).toBe(1);
    expect(snapshot.mission?.budget.modelRequests).toBe(6);
    expect(snapshot.mission?.budget.reservedRequests).toBe(0);
    expect(snapshot.artifacts[0].versions[0].evidence).toEqual([{ sourceId, sourceVersion: 1, quote }]);
    expect(snapshot.contributions.some(contribution => contribution.evidence?.[0]?.sourceId === sourceId)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_INTERNAL_SEARCH');
  });
  test('autonomously revises, independently rechecks exact versions and completes in nine requests', async () => {
    const f = fixture((input) => response(normal(input, { revise: true })));
    f.coordinator.start();
    await until(() => f.snapshot().mission?.state === 'completed');
    const snapshot = f.snapshot();
    expect(f.inputs.map((input) => input.member.role)).toEqual(['coach', 'planner', 'writer', 'reviewer', 'coach', 'planner', 'writer', 'reviewer', 'coach']);
    expect(snapshot.mission?.budget.modelRequests).toBe(9);
    expect(snapshot.mission?.round).toBe(2);
    expect(snapshot.artifacts[0].versions).toHaveLength(2);
    expect(snapshot.artifacts[0].adoptedVersion).toBeNull();
    expect(snapshot.assessments.filter((item) => item.artifactVersion === 1).every((item) => item.verdict === 'failed')).toBe(true);
    expect(snapshot.assessments.filter((item) => item.artifactVersion === 2).every((item) => item.verdict === 'passed')).toBe(true);
    const writerId = snapshot.members.find((member) => member.role === 'writer')!.id;
    expect(snapshot.assessments.every((item) => item.reviewerMemberId !== writerId)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_PROVIDER_THOUGHT');
    expect(JSON.stringify(snapshot)).not.toContain(config.apiKey);
    expect(f.inputs.every((input) => input.member.address === `room/${snapshot.room.id}/agent/${input.member.id}`)).toBe(true);
  });

  test('a coach question waits without billing then resumes only after an explicit answer', async () => {
    const f = fixture((input) => {
      if (input.member.role === 'coach' && !input.contributions.some((item) => item.authorType === 'user')) return response({ message: 'The target audience affects the requested examples.', decision: 'ask_user', question: { text: 'Should the introduction target new users?', options: ['New users', 'Returning users'] } });
      return response(normal(input));
    });
    f.coordinator.start();
    await until(() => f.snapshot().mission?.state === 'waiting_user');
    const waiting = f.snapshot().mission!;
    await sleep(30);
    expect(f.inputs).toHaveLength(1);
    expect(waiting.question?.text).toBe('Should the introduction target new users?');
    f.engine.command(f.scope, waiting.id, 'answer', { expectedVersion: waiting.version, questionId: waiting.question!.id, answer: 'Prioritize new users.' }, { actor: { userId: 1 }, key: 'answer-question' });
    f.coordinator.wake();
    await until(() => f.snapshot().mission?.state === 'completed');
    expect(f.snapshot().mission?.budget.modelRequests).toBe(6);
    expect(f.snapshot().contributions.some((item) => item.authorType === 'user' && item.text === 'Prioritize new users.')).toBe(true);
  });

  test('pause fences a live writer, rejects late output and resumes the same persisted assignment', async () => {
    let finishLate!: (value: Response) => void;
    let pausedWriterInput: Input | undefined;
    let writerCalls = 0;
    const f = fixture((input) => {
      if (input.member.role === 'writer' && writerCalls++ === 0) {
        pausedWriterInput = input;
        return new Promise((resolve) => { finishLate = resolve; });
      }
      return response(normal(input));
    });
    f.coordinator.start();
    await until(() => !!pausedWriterInput);
    const before = f.snapshot().mission!;
    const originalAssignment = f.db.query<{ assignment_id: string }, []>("SELECT assignment_id FROM room_attempts WHERE state='running'").get()!.assignment_id;
    f.engine.command(f.scope, before.id, 'pause', { expectedVersion: before.version }, { actor: { userId: 1 }, key: 'pause' });
    f.coordinator.cancelRoom(f.scope.roomId);
    await until(() => f.snapshot().mission?.state === 'paused');
    const paused = f.snapshot().mission!;
    expect(paused.controlEpoch).toBeGreaterThan(before.controlEpoch);
    expect(f.snapshot().artifacts).toHaveLength(0);
    f.engine.command(f.scope, paused.id, 'resume', { expectedVersion: paused.version }, { actor: { userId: 1 }, key: 'resume' });
    f.coordinator.wake();
    await until(() => f.snapshot().mission?.state === 'completed');
    finishLate(response({ message: 'LATE_PRIVATE_CANDIDATE', artifact: { title: 'Late', markdown: 'MUST_NOT_REPLACE_CURRENT' } }));
    await sleep(20);
    expect(JSON.stringify(f.snapshot())).not.toContain('LATE_PRIVATE_CANDIDATE');
    expect(f.snapshot().artifacts[0].versions).toHaveLength(1);
    const attempts = f.db.query<{ assignment_id: string }, [string]>('SELECT assignment_id FROM room_attempts WHERE assignment_id=?').all(originalAssignment);
    expect(attempts).toHaveLength(2);
    expect(f.snapshot().mission?.budget.modelRequests).toBe(6);
  });

  test('hard request cap prevents further fetches, then an explicit grant preserves consumed usage', async () => {
    const f = fixture((input) => response(normal(input)), { budget: { modelRequests: 1 } });
    f.coordinator.start();
    await until(() => f.snapshot().mission?.state === 'exhausted');
    expect(f.inputs).toHaveLength(1);
    expect(f.snapshot().artifacts).toHaveLength(0);
    const exhausted = f.snapshot().mission!;
    f.engine.command(f.scope, exhausted.id, 'budget', { expectedVersion: exhausted.version, budget: { modelRequests: 4 } }, { actor: { userId: 1 }, key: 'budget-grant' });
    f.coordinator.wake();
    await until(() => f.snapshot().mission?.state === 'completed');
    expect(f.inputs).toHaveLength(5);
    expect(f.snapshot().mission?.budget.modelRequests).toBe(5);
    expect(f.snapshot().mission?.budget.limits.modelRequests).toBe(5);
  });

  test('replaying an old pause key after resume does not cancel the fresh execution epoch', async () => {
    const writers: Array<{ input: Input; signal: AbortSignal; finish: (value: Response) => void }> = [];
    const f = fixture((input, init) => {
      if (input.member.role === 'writer') return new Promise<Response>((finish) => {
        writers.push({ input, signal: init.signal as AbortSignal, finish });
      });
      return response(normal(input));
    });
    f.coordinator.start();
    await until(() => writers.length === 1);
    const before = f.snapshot().mission!;
    const pauseInput = { expectedVersion: before.version };
    const pauseMeta = { actor: { userId: 1 }, key: 'pause-replayed-after-resume' };
    f.engine.command(f.scope, before.id, 'pause', pauseInput, pauseMeta);
    // The HTTP route only wakes the coordinator. Its current-epoch check performs cancellation.
    f.coordinator.wake();
    await until(() => f.snapshot().mission?.state === 'paused');
    const paused = f.snapshot().mission!;
    f.engine.command(f.scope, paused.id, 'resume', { expectedVersion: paused.version }, { actor: { userId: 1 }, key: 'resume-after-original-pause' });
    f.coordinator.wake();
    await until(() => writers.length === 2);
    const running = f.snapshot().mission!;
    const activeId = f.db.query<{ id: string }, []>("SELECT id FROM room_attempts WHERE state='running'").get()!.id;
    const replay = f.engine.command(f.scope, before.id, 'pause', pauseInput, pauseMeta);
    // Compact receipts replay no side effects and project current state, never an old snapshot.
    expect(replay.mission!.controlEpoch).toBe(running.controlEpoch);
    f.coordinator.wake();
    await sleep(35); // Includes several polls and lease renewals after the stale command replay.
    expect(f.snapshot().mission!.state).toBe('running');
    expect(f.snapshot().mission!.controlEpoch).toBe(running.controlEpoch);
    expect(f.db.query<{ id: string }, []>("SELECT id FROM room_attempts WHERE state='running'").get()!.id).toBe(activeId);
    expect(writers[1].signal.aborted).toBe(false);
    writers[0].finish(response({ message: 'LATE_OLD_EPOCH', artifact: { title: 'Late', markdown: 'Outdated draft' } }));
    writers[1].finish(response(normal(writers[1].input)));
    await until(() => f.snapshot().mission?.state === 'completed');
    expect(f.snapshot().mission!.budget.modelRequests).toBe(6);
    expect(f.snapshot().artifacts[0].versions).toHaveLength(1);
    expect(JSON.stringify(f.snapshot())).not.toContain('LATE_OLD_EPOCH');
  });

  test('pause while waiting for provider capacity releases reservation without charging a request', async () => {
    let waitingForCapacity = false;
    const f = fixture((input) => response(normal(input)), { acquire: async (signal) => {
      waitingForCapacity = true;
      return new Promise<() => void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('gate_cancelled')), { once: true }));
    } });
    f.coordinator.start();
    await until(() => waitingForCapacity);
    const active = f.snapshot().mission!;
    expect(active.budget.reservedRequests).toBe(1);
    expect(active.budget.modelRequests).toBe(0);
    f.engine.command(f.scope, active.id, 'pause', { expectedVersion: active.version }, { actor: { userId: 1 }, key: 'pause-before-send' });
    f.coordinator.cancelRoom(f.scope.roomId);
    await until(() => f.snapshot().mission?.state === 'paused');
    expect(f.snapshot().mission?.budget.reservedRequests).toBe(0);
    expect(f.snapshot().mission?.budget.modelRequests).toBe(0);
    expect(f.inputs).toHaveLength(0);
  });

  test('withdrawn model configuration interrupts pending work without a physical request', async () => {
    const f = fixture((input) => response(normal(input)), { config: () => ({ ...config, apiKey: '' }) });
    f.coordinator.start();
    await until(() => f.snapshot().mission?.state === 'interrupted');
    expect(f.snapshot().mission?.reasonCode).toBe('not_configured');
    expect(f.snapshot().mission?.budget.reservedRequests).toBe(0);
    expect(f.snapshot().mission?.budget.modelRequests).toBe(0);
    expect(f.inputs).toHaveLength(0);
  });

  test('configuration withdrawn while awaiting capacity revokes the attempt and frees its reservation', async () => {
    let configured = true;
    let waiting = false;
    const f = fixture((input) => response(normal(input)), {
      config: () => ({ ...config, apiKey: configured ? config.apiKey : '' }),
      acquire: async (signal) => {
        waiting = true;
        return new Promise<() => void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled gate')), { once: true }));
      },
    });
    f.coordinator.start();
    await until(() => waiting);
    expect(f.snapshot().mission?.budget.reservedRequests).toBe(1);
    configured = false;
    f.coordinator.wake();
    await until(() => f.snapshot().mission?.state === 'interrupted');
    expect(f.snapshot().mission?.reasonCode).toBe('not_configured');
    expect(f.snapshot().mission?.budget.reservedRequests).toBe(0);
    expect(f.snapshot().mission?.budget.modelRequests).toBe(0);
    expect(f.inputs).toHaveLength(0);
  });
});

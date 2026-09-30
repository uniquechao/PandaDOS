import { describe, expect, test } from 'bun:test';
import { DEFAULT_LLM_CONFIG } from '../agents/llm';
import { SUPPORTED_LOCALES } from '../../shared/i18n/locales';
import { outputLanguageInstruction } from '../agents/prompts/language';
import type { RoomAttempt, RoomExecutionContext, RoomFormalResult, RoomRunPort } from './contracts';
import { RoomCoordinator } from './coordinator';
import { RoomModelRuntime } from './model-runtime';
import { parseRoomFormalResult, RoomRuntimeError } from './protocol';
import { compileRoomMessages, ROOM_CONTEXT_MAX_BYTES, type RoomRuntime } from './runtime';
import { parseRoomToolCall, projectRoomToolResult } from './tools';
import { createHash } from 'node:crypto';

function context(role: 'coach' | 'planner' | 'writer' | 'reviewer' = 'writer'): RoomExecutionContext {
  const now = Date.now();
  const members = (['coach', 'planner', 'writer', 'reviewer'] as const).map((memberRole) => ({ id: `member-${memberRole}`, projectId: 1, roomId: 'room-1', role: memberRole, displayName: memberRole, address: `room/room-1/agent/member-${memberRole}`, modelProfile: 'default', status: 'active' as const, version: 1 }));
  return {
    attempt: { id: 'attempt-1', assignmentId: 'assignment-1', projectId: 1, roomId: 'room-1', missionId: 'mission-1', memberId: `member-${role}`, role, kind: 'work', goalRevision: 1, round: 1, controlEpoch: 1, fence: 1, workerId: 'worker-1', leaseUntil: now + 30_000, deadlineTs: now + 60_000, audience: { kind: 'room' } },
    member: members.find((member) => member.role === role)!, members,
    mission: { id: 'mission-1', projectId: 1, roomId: 'room-1', state: 'running', phase: 'producing', version: 1, controlEpoch: 1, goalRevision: 1, round: 1, nextRole: role, locale: 'en', actorUserId: 1, budget: { limits: { modelRequests: 48, activeMs: 1_200_000, rounds: 4 }, modelRequests: 1, activeMs: 100 }, question: null, reasonCode: null, createdAt: now, updatedAt: now },
    goal: { id: 'goal-1', missionId: 'mission-1', revision: 1, request: 'Write an introduction covering three user scenarios.', criteria: [{ id: 'criterion-1', description: 'Three specific user scenarios', required: true }], createdAt: now },
    contributions: [], assessments: [],
    artifacts: [{ id: 'artifact-1', roomId: 'room-1', missionId: 'mission-1', title: 'Introduction', currentVersion: 2, adoptedVersion: null, versions: [
      { artifactId: 'artifact-1', version: 1, goalRevision: 1, title: 'Old', markdown: 'Old text', digest: 'old', authorMemberId: 'member-writer', createdAt: now },
      { artifactId: 'artifact-1', version: 2, goalRevision: 1, title: 'Introduction', markdown: 'Three concrete user scenarios.', digest: 'new', authorMemberId: 'member-writer', createdAt: now },
    ] }],
  };
}
const config = { ...DEFAULT_LLM_CONFIG, baseUrl: 'https://model.invalid/v1', apiKey: 'PRIVATE_API_SECRET', model: 'fake', retries: 9 };
const writerResult: RoomFormalResult = { message: 'The introduction is ready for review.', artifact: { title: 'Introduction', markdown: '# Introduction\n\nThree scenarios.' } };
const providerResponse = (result: RoomFormalResult, extra: Record<string, unknown> = {}) => Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(result), ...extra } }], usage: { prompt_tokens: 24, completion_tokens: 64 } });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('controlled plans, messages and references accept formal data and reject scope or role escalation', () => {
  const ctx = context('coach');
  const plan = { tasks: [{ id: 'plan', role: 'planner', instruction: 'Provide independent scenarios', dependsOn: [], independent: true }, { id: 'write', role: 'writer', instruction: 'Write artifact', dependsOn: ['plan'] }, { id: 'review', role: 'reviewer', instruction: 'Review artifact', dependsOn: ['write'] }] };
  const result = { message: 'Execute the bounded plan', decision: 'continue', plan, messages: [{ text: 'Prioritize three scenarios.', audience: { kind: 'members', memberIds: ['member-planner'] } }] };
  expect(parseRoomFormalResult(JSON.stringify(result), ctx).plan?.tasks).toHaveLength(3);
  const explicitFalse = structuredClone(result); explicitFalse.plan.tasks[1].independent = false; explicitFalse.plan.tasks[2].independent = false;
  expect(parseRoomFormalResult(JSON.stringify(explicitFalse), ctx).plan?.tasks[1].independent).toBe(false);
  const cycle = structuredClone(result); cycle.plan.tasks[0].dependsOn = ['review'];
  expect(() => parseRoomFormalResult(JSON.stringify(cycle), ctx)).toThrow('protocol_invalid');
  const noWriterDependency = structuredClone(result); noWriterDependency.plan.tasks[2].dependsOn = [];
  expect(() => parseRoomFormalResult(JSON.stringify(noWriterDependency), ctx)).toThrow('protocol_invalid');
  const foreign = structuredClone(result); foreign.messages[0].audience.memberIds = ['other-room-member'];
  expect(() => parseRoomFormalResult(JSON.stringify(foreign), ctx)).toThrow('protocol_invalid');
  ctx.attempt.kind = 'reply';
  expect(() => parseRoomFormalResult(JSON.stringify(result), ctx)).toThrow('protocol_invalid');
});

test('issue feedback projection retains only linked mission formal fields', () => {
  const ctx = context();
  ctx.issueFeedback = [{ issueId: 'issue-1', title: 'Formal issue', status: 'done', missionId: ctx.mission.id, artifactId: 'artifact-1', artifactVersion: 2, resultSummary: 'Formal completion summary', question: null, events: [{ id: 'event-1', sourceEventId: 3, kind: 'done', createdAt: 1, raw: 'PRIVATE_EVENT_RAW' }], raw: 'PRIVATE_ISSUE_RAW' } as never];
  const input = compileRoomMessages(ctx)[1].content;
  expect(input).toContain('Formal completion summary');
  expect(input).not.toContain('PRIVATE_');
});

describe('bounded private formal tools', () => {
  const toolResponse = (id = 'tool-1', name = 'search_sources', args = { query: 'scenario' }) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: 'PRIVATE_TOOL_THINKING', reasoning_content: 'PRIVATE_REASONING', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
  test('meters every physical call, keeps only formal tool fields, and returns final submission', async () => {
    let calls = 0;
    const ids: string[] = [];
    const runtime = new RoomModelRuntime({ config, fetchFn: async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      expect(body.tools).toHaveLength(3);
      calls++;
      if (calls === 1) return toolResponse();
      expect(JSON.stringify(body.messages)).not.toContain('PRIVATE_');
      expect(body.messages.at(-1).role).toBe('tool');
      return providerResponse(writerResult);
    } });
    const result = await runtime.run(context(), new AbortController().signal, id => { ids.push(id!); return true; }, { call: () => [] });
    expect(result).toEqual(writerResult);
    expect(ids).toEqual(['request-1', 'request-2']);
    expect(calls).toBe(2);
  });
  test('blocks tool names, argument expansion, private results and budget denial before next fetch', async () => {
    let calls = 0;
    const forbidden = new RoomModelRuntime({ config, fetchFn: async () => { calls++; return toolResponse('tool-1', 'read_file', { query: '/etc/passwd' }); } });
    let toolCalls = 0;
    await expect(forbidden.run(context(), new AbortController().signal, () => true, { call: () => { toolCalls++; return []; } })).rejects.toThrow('tool_forbidden');
    expect(toolCalls).toBe(0);
    const budget = new RoomModelRuntime({ config, fetchFn: async () => { calls++; return toolResponse(); } });
    await expect(budget.run(context(), new AbortController().signal, id => id === 'request-1', { call: () => [] })).rejects.toThrow('cancelled');
    expect(calls).toBe(2);
  });
  test('ends an endless tool loop at the sixth physical request', async () => {
    let requests = 0, tools = 0;
    const runtime = new RoomModelRuntime({ config, fetchFn: async () => toolResponse(`tool-${++requests}`) });
    await expect(runtime.run(context(), new AbortController().signal, () => true, { call: () => { tools++; return []; } })).rejects.toThrow('tool_limit');
    expect(requests).toBe(6);
    expect(tools).toBe(5);
  });
  test('source output and citations require exact authorized scope, version and digest', () => {
    const ctx = context();
    const source = { id: 'source-1', roomId: 'room-1', missionId: 'mission-1', goalRevision: 1, version: 1, title: 'Research', content: 'Three concrete user scenarios.', digest: createHash('sha256').update('Three concrete user scenarios.').digest('hex'), audience: { kind: 'room' as const }, status: 'active' as const, createdAt: 1 };
    ctx.sources = [source];
    const call = parseRoomToolCall('read-1', 'read_source', '{"sourceId":"source-1","version":1}');
    const result = projectRoomToolResult(call, { ...source, raw: 'PRIVATE_PROVIDER_RAW' }, ctx);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(JSON.stringify(result)).toContain(source.content);
    expect(() => projectRoomToolResult(call, { ...source, content: 'altered' }, ctx)).toThrow('tool_forbidden');
    expect(() => projectRoomToolResult(call, { ...source, roomId: 'other-room' }, ctx)).toThrow('tool_forbidden');
    expect(() => parseRoomToolCall('read-2', 'read_source', '{"sourceId":"source-1","version":1,"path":"/private"}')).toThrow('tool_forbidden');
    const formal = { ...writerResult, evidence: [{ sourceId: 'source-1', sourceVersion: 1, quote: 'Three concrete user scenarios.' }] };
    expect(parseRoomFormalResult(JSON.stringify(formal), ctx).evidence).toHaveLength(1);
    ctx.sources = [{ ...source, audience: { kind: 'members', memberIds: ['member-writer'] } }];
    expect(() => projectRoomToolResult(call, source, ctx)).toThrow('tool_forbidden');
    expect(() => parseRoomFormalResult(JSON.stringify(formal), ctx)).toThrow('protocol_invalid');
  });
});

async function until(assertion: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!assertion()) { if (Date.now() > deadline) throw new Error('timed out'); await sleep(5); }
}

describe('room formal protocol', () => {
  test('formal analysis headings are business prose while private channel envelopes remain forbidden', () => {
    const result = { ...writerResult, message: 'Analysis:\nThree user scenarios support this proposal.', artifact: { title: 'Analysis', markdown: '# Analysis\n\nAnalysis:\nA concise public analysis.' } };
    expect(parseRoomFormalResult(JSON.stringify(result), context())).toEqual(result);
    expect(() => parseRoomFormalResult(JSON.stringify({ ...result, message: 'reasoning_content: private' }), context())).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult(JSON.stringify({ ...result, message: '<analysis>private</analysis>' }), context())).toThrow('protocol_invalid');
  });
  test('rejects unknown fields, role escalation and internal transcript fields', () => {
    const ctx = context();
    expect(() => parseRoomFormalResult(JSON.stringify({ ...writerResult, reasoning: 'PRIVATE_THOUGHT' }), ctx)).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult(JSON.stringify({ ...writerResult, roomId: 'room-2' }), ctx)).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult(JSON.stringify({ ...writerResult, decision: 'complete' }), ctx)).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult(JSON.stringify({ ...writerResult, message: '<think>PRIVATE_THOUGHT</think>' }), ctx)).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult('```json\n{}\n```', ctx)).toThrow('protocol_invalid');
  });

  test('independent review must cover required criteria and exact current version', () => {
    const ctx = context('reviewer');
    const result: RoomFormalResult = { message: 'All three scenarios appear in the introduction.', review: { artifactId: 'artifact-1', artifactVersion: 2, criteria: [{ criterionId: 'criterion-1', verdict: 'passed', note: 'Three distinct scenarios are present.' }] } };
    expect(parseRoomFormalResult(JSON.stringify(result), ctx)).toEqual(result);
    expect(() => parseRoomFormalResult(JSON.stringify({ ...result, review: { ...result.review, artifactVersion: 1 } }), ctx)).toThrow('protocol_invalid');
    expect(() => parseRoomFormalResult(JSON.stringify({ ...result, review: { ...result.review, criteria: [] } }), ctx)).toThrow('protocol_invalid');
    ctx.artifacts[0].versions[1].authorMemberId = ctx.member.id;
    expect(() => parseRoomFormalResult(JSON.stringify(result), ctx)).toThrow('protocol_invalid');
  });

  test('a direct reply cannot smuggle an artifact or work decision', () => {
    const ctx = context('coach');
    ctx.attempt.kind = 'reply';
    expect(parseRoomFormalResult('{"message":"A formal answer."}', ctx)).toEqual({ message: 'A formal answer.' });
    expect(() => parseRoomFormalResult('{"message":"A formal answer.","decision":"continue"}', ctx)).toThrow('protocol_invalid');
  });

  test('questions are explicit and submissions are size bounded', () => {
    const ctx = context('coach');
    expect(() => parseRoomFormalResult('{"message":"A decision","decision":"ask_user"}', ctx)).toThrow('protocol_invalid');
    expect(parseRoomFormalResult('{"message":"Choose the primary audience.","decision":"ask_user","question":{"text":"New or returning users?"}}', ctx).question).toEqual({ text: 'New or returning users?', options: [] });
    expect(() => parseRoomFormalResult(' '.repeat(65_537), ctx)).toThrow('protocol_invalid');
  });
});

describe('room context isolation', () => {
  test('question identity and explicit old-goal references survive without becoming current evidence', () => {
    const ctx = context('writer');
    ctx.goal.baselineArtifactRefs = [{ artifactId: 'old-artifact', version: 3 }];
    ctx.baselineArtifacts = [{ ...ctx.artifacts[0].versions[0], artifactId: 'old-artifact', version: 3, goalRevision: 0, markdown: 'AUTHORIZED_BASELINE' }, { ...ctx.artifacts[0].versions[0], artifactId: 'unselected', markdown: 'UNAUTHORIZED_BASELINE' }];
    ctx.referenceContributions = [{ id: 'old-request', roomId: ctx.attempt.roomId, missionId: 'old-mission', goalRevision: 0, seq: 1, authorType: 'user', authorId: '1', kind: 'message', text: 'EXPLICIT_OLD_REFERENCE', audience: { kind: 'room' }, createdAt: 0 }];
    ctx.contributions.push({ id: 'question', roomId: ctx.attempt.roomId, missionId: ctx.attempt.missionId, goalRevision: 1, seq: 2, authorType: 'member', authorId: 'member-coach', kind: 'question', text: 'Choose a direction', question: { id: 'q-1', text: 'Who is the audience?', options: ['New users'] }, audience: { kind: 'room' }, createdAt: 1 });
    const input = JSON.parse(compileRoomMessages(ctx)[1].content);
    expect(input.contributions[0].question.text).toBe('Who is the audience?');
    expect(input.referenceContributions[0].text).toBe('EXPLICIT_OLD_REFERENCE');
    expect(input.baselineArtifacts).toHaveLength(1);
    expect(JSON.stringify(input)).not.toContain('UNAUTHORIZED_BASELINE');
    expect(input.assessments).toEqual([]);
  });
  test('product and writing templates change internal focus without changing user criteria', () => {
    const ctx = context('planner');
    ctx.mission.templateKey = 'writing';
    expect(compileRoomMessages(ctx)[0].content).toContain('Team template: content creation');
    ctx.mission.templateKey = 'product';
    const messages = compileRoomMessages(ctx);
    expect(messages[0].content).toContain('Team template: product planning');
    expect(JSON.parse(messages[1].content).goal.criteria).toEqual(ctx.goal.criteria);
  });
  test('Chinese locales use Chinese internal contracts and all locales declare output language', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const ctx = context('coach');
      ctx.mission.locale = locale;
      const system = compileRoomMessages(ctx)[0].content;
      expect(system).toContain(outputLanguageInstruction(locale));
      if (locale.startsWith('zh')) {
        expect(system).toContain('你是团队的目标教练');
        expect(system).not.toContain('You are');
      } else expect(system).toContain('You are the team');
    }
  });
  test('coach sees no directed private input when producing a room-wide decision', () => {
    const ctx = context('coach');
    const base = { roomId: 'room-1', missionId: 'mission-1', goalRevision: 1, seq: 1, authorType: 'member' as const, authorId: 'member-writer', kind: 'message' as const, createdAt: Date.now() };
    ctx.contributions.push({ ...base, id: 'formal', text: 'FORMAL_SCENARIO', audience: { kind: 'room' } });
    ctx.contributions.push({ ...base, id: 'private', text: 'PRIVATE_FOR_COACH', audience: { kind: 'members', memberIds: ['member-coach'] } });
    ctx.contributions.push({ ...base, id: 'other-room', roomId: 'room-2', text: 'OTHER_ROOM_SECRET', audience: { kind: 'room' } });
    Object.assign(ctx, { raw: { reasoning_content: 'PRIVATE_RUNTIME_TRANSCRIPT' } });
    const compiled = JSON.stringify(compileRoomMessages(ctx));
    expect(compiled).toContain('FORMAL_SCENARIO');
    expect(compiled).not.toContain('PRIVATE_FOR_COACH');
    expect(compiled).not.toContain('OTHER_ROOM_SECRET');
    expect(compiled).not.toContain('PRIVATE_RUNTIME_TRANSCRIPT');
    expect(compiled).not.toContain('Old text');
  });

  test('direct replies preserve audience intersections and require their input', () => {
    const ctx = context('coach');
    ctx.attempt.kind = 'reply';
    ctx.attempt.inputContributionId = 'request';
    ctx.attempt.audience = { kind: 'members', memberIds: ['member-coach', 'member-writer'] };
    const base = { roomId: 'room-1', missionId: 'mission-1', goalRevision: 1, seq: 1, authorType: 'member' as const, authorId: 'member-writer', kind: 'message' as const, createdAt: Date.now() };
    ctx.contributions.push({ ...base, id: 'request', text: 'DIRECT_QUESTION', audience: { kind: 'members', memberIds: ['member-coach'] } });
    ctx.contributions.push({ ...base, authorId: 'member-reviewer', id: 'reviewer-private', text: 'DO_NOT_RESHARE', audience: { kind: 'members', memberIds: ['member-coach'] } });
    const compiled = JSON.stringify(compileRoomMessages(ctx));
    expect(compiled).toContain('DIRECT_QUESTION');
    expect(compiled).not.toContain('DO_NOT_RESHARE');
    ctx.attempt.audience = { kind: 'room' };
    expect(() => compileRoomMessages(ctx)).toThrow('scope_mismatch');
  });

  test('rejects cross-room identity and never truncates oversized required goal', () => {
    const ctx = context();
    ctx.member.roomId = 'room-2';
    expect(() => compileRoomMessages(ctx)).toThrow('scope_mismatch');
    ctx.member.roomId = 'room-1';
    ctx.goal.request = 'x'.repeat(ROOM_CONTEXT_MAX_BYTES);
    expect(() => compileRoomMessages(ctx)).toThrow('context_too_large');
  });
});

describe('room single-request model transport', () => {
  test('explicit capability probes are single-flight, cached and invalidated by provider replacement', async () => {
    let calls = 0;
    let current = { ...config };
    const runtime = new RoomModelRuntime({ config: () => current, fetchFn: async (_url, init) => {
      calls++;
      const input = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
      return Response.json({ choices: [{ message: { content: JSON.stringify(input) }, finish_reason: 'stop' }] });
    } });
    expect(runtime.capabilities().structuredOutput).toBe('unverified');
    const [first, duplicate] = await Promise.all([runtime.probe(new AbortController().signal), runtime.probe(new AbortController().signal)]);
    expect(first.structuredOutput).toBe('verified');
    expect(duplicate).toEqual(first);
    await runtime.probe(new AbortController().signal);
    expect(calls).toBe(1);
    current = { ...current, model: 'replacement' };
    expect(runtime.capabilities().structuredOutput).toBe('unverified');
    await runtime.probe(new AbortController().signal);
    expect(calls).toBe(2);
  });
  test('a provider that fails the explicit JSON probe stays fail-closed without more billable work', async () => {
    let calls = 0;
    const runtime = new RoomModelRuntime({ config, fetchFn: async () => { calls++; return Response.json({ choices: [{ message: { content: 'Plain prose' }, finish_reason: 'stop' }] }); } });
    expect((await runtime.probe(new AbortController().signal)).structuredOutput).toBe('unsupported');
    await expect(runtime.run(context(), new AbortController().signal)).rejects.toThrow('capability_unsupported');
    expect(calls).toBe(1);
  });
  test('a queued request resolves the current provider and credentials only after capacity is granted', async () => {
    let current = { ...config, baseUrl: 'https://old.invalid/v1', apiKey: 'OLD_PRIVATE_KEY', model: 'old-model' };
    let grant!: (release: () => void) => void;
    let consumed = 0;
    const runtime = new RoomModelRuntime({ config: () => current, acquire: () => new Promise(resolve => { grant = resolve; }), fetchFn: async (url, init) => {
      expect(url).toBe('https://new.invalid/v1/chat/completions');
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer NEW_PRIVATE_KEY');
      expect(JSON.parse(String(init.body)).model).toBe('new-model');
      return providerResponse(writerResult);
    } });
    const running = runtime.run(context(), new AbortController().signal, () => { consumed++; return true; });
    current = { ...current, baseUrl: 'https://new.invalid/v1', apiKey: 'NEW_PRIVATE_KEY', model: 'new-model' };
    grant(() => {});
    expect(await running).toEqual(writerResult);
    expect(consumed).toBe(1);
  });
  test('strips provider reasoning and metadata; sends only formal whitelist input', async () => {
    let calls = 0;
    const runtime = new RoomModelRuntime({ config, fetchFn: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body as string);
      expect(body.tools).toBeUndefined();
      expect(body.messages).toHaveLength(2);
      expect(JSON.stringify(body.messages)).not.toContain(config.apiKey);
      expect(init.redirect).toBe('error');
      return providerResponse(writerResult, { reasoning_content: 'PRIVATE_REASONING', raw: 'PRIVATE_RAW' });
    } });
    const result = await runtime.run(context(), new AbortController().signal);
    expect(result).toEqual(writerResult);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(calls).toBe(1);
  });

  test('never retries 503 and never exposes provider error bodies', async () => {
    let calls = 0;
    const runtime = new RoomModelRuntime({ config, fetchFn: async () => {
      calls++;
      return new Response(`PRIVATE_PROVIDER_BODY ${config.apiKey}`, { status: 503 });
    } });
    await expect(runtime.run(context(), new AbortController().signal)).rejects.toThrow('provider_unavailable');
    expect(calls).toBe(1);
  });

  test('one abort cancels the physical request and safely classifies failure', async () => {
    const controller = new AbortController();
    let dispatched = false;
    const runtime = new RoomModelRuntime({ config, fetchFn: async (_url, init) => {
      dispatched = true;
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('PRIVATE_NETWORK_ERROR')), { once: true }));
    } });
    const result = runtime.run(context(), controller.signal);
    await until(() => dispatched);
    controller.abort();
    await expect(result).rejects.toThrow('cancelled');
  });

  test('deadline bounds provider wait and releases the shared gate once', async () => {
    let released = 0;
    const runtime = new RoomModelRuntime({ config: { ...config, timeoutMs: 20 }, acquire: async () => () => { released++; }, fetchFn: async (_url, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private')), { once: true })) });
    await expect(runtime.run(context(), new AbortController().signal)).rejects.toThrow('timeout');
    expect(released).toBe(1);
  });

  test('not configured, prior abort and elapsed deadline dispatch no request', async () => {
    let calls = 0;
    const fetchFn = async () => { calls++; return providerResponse(writerResult); };
    const unconfigured = new RoomModelRuntime({ config: { ...config, apiKey: '' }, fetchFn });
    expect(unconfigured.configured()).toBe(false);
    await expect(unconfigured.run(context(), new AbortController().signal)).rejects.toThrow('not_configured');
    const runtime = new RoomModelRuntime({ config, fetchFn });
    const ctx = context();
    ctx.attempt.deadlineTs = Date.now() - 1;
    await expect(runtime.run(ctx, new AbortController().signal)).rejects.toThrow('timeout');
    await expect(runtime.run(context(), AbortSignal.abort())).rejects.toThrow('cancelled');
    expect(calls).toBe(0);
  });

  test('request accounting runs after provider capacity acquisition, directly before fetch', async () => {
    const operations: string[] = [];
    const runtime = new RoomModelRuntime({ config,
      acquire: async () => { operations.push('acquire'); return () => { operations.push('release'); }; },
      fetchFn: async () => { operations.push('fetch'); return providerResponse(writerResult); },
    });
    await runtime.run(context(), new AbortController().signal, () => { operations.push('consume'); return true; });
    expect(operations).toEqual(['acquire', 'consume', 'fetch', 'release']);
    operations.length = 0;
    await expect(runtime.run(context(), new AbortController().signal, () => { operations.push('revoked'); return false; })).rejects.toThrow('cancelled');
    expect(operations).toEqual(['acquire', 'revoked', 'release']);
  });

  test('rejects unsupported tool calls and oversized response envelopes', async () => {
    const runtime = new RoomModelRuntime({ config, fetchFn: async () => providerResponse(writerResult, { tool_calls: [{ function: { name: 'read_file' } }] }) });
    await expect(runtime.run(context(), new AbortController().signal)).rejects.toThrow('protocol_invalid');
    const large = new RoomModelRuntime({ config, fetchFn: async () => new Response('PRIVATE', { headers: { 'content-length': '1048577' } }) });
    await expect(large.run(context(), new AbortController().signal)).rejects.toThrow('response_too_large');
  });
});

describe('room coordinator fence and cancellation', () => {
  function fixture(runtime: RoomRuntime) {
    const ctx = context();
    let claimed = false;
    let current = true;
    let accepted = 0;
    const failures: string[] = [];
    const service: RoomRunPort = {
      claimNext: () => { if (claimed) return null; claimed = true; return ctx.attempt; },
      context: () => ctx,
      dispatched: () => true,
      setCancellationMode: () => true,
      pendingStops: () => [],
      confirmStopped: () => true,
      renew: () => current,
      accept: () => { accepted++; return current; },
      fail: (_attempt, code) => { failures.push(code); },
      recover: () => {},
      isCurrent: () => current,
    };
    const coordinator = new RoomCoordinator({ service, runtime, pollIntervalMs: 10, leaseIntervalMs: 10 });
    return { ctx, coordinator, failures, invalidate: () => { current = false; }, accepted: () => accepted };
  }

  test('accepts the valid formal result exactly once', async () => {
    const f = fixture({ configured: () => true, run: async () => writerResult });
    f.coordinator.start();
    await until(() => f.accepted() === 1);
    await f.coordinator.stop();
    expect(f.accepted()).toBe(1);
    expect(f.failures).toEqual([]);
  });

  test('epoch change detaches an uncooperative provider and rejects its late result', async () => {
    let resolve!: (value: RoomFormalResult) => void;
    let dispatched = false;
    const f = fixture({ configured: () => true, run: async () => { dispatched = true; return new Promise((done) => { resolve = done; }); } });
    f.coordinator.start();
    await until(() => dispatched);
    f.invalidate();
    f.coordinator.wake();
    await until(() => f.failures.length === 1);
    resolve(writerResult);
    await sleep(20);
    await f.coordinator.stop();
    expect(f.failures).toEqual(['cancelled']);
    expect(f.accepted()).toBe(0);
  });

  test('shutdown cannot hang on a provider that ignores abort', async () => {
    let dispatched = false;
    const f = fixture({ configured: () => true, run: async () => { dispatched = true; return new Promise(() => {}); } });
    f.coordinator.start();
    await until(() => dispatched);
    await f.coordinator.stop();
    expect(f.failures).toEqual(['cancelled']);
  });

  test('confirmation runtimes keep the shutdown resource barrier until execution actually settles', async () => {
    let resolve!: (result: RoomFormalResult) => void;
    let dispatched = false;
    const f = fixture({ cancellationMode: 'confirm', configured: () => true, confirmStopped: async () => true, run: async () => { dispatched = true; return new Promise(done => { resolve = done; }); } });
    f.coordinator.start();
    await until(() => dispatched);
    const stop = await f.coordinator.stop(1);
    expect(stop.settled).toBe(false);
    expect(stop.pending).toBe(1);
    expect(f.failures).toEqual([]);
    resolve(writerResult);
    await stop.done;
    expect(f.accepted()).toBe(0);
    expect(f.failures).toEqual(['cancelled']);
  });

  test('a detached physical request retains its shared slot until settlement and never submits late', async () => {
    let releaseCount = 0;
    let finish!: (response: Response) => void;
    let dispatched = false;
    const runtime = new RoomModelRuntime({ config, acquire: async () => () => { releaseCount++; }, fetchFn: async () => {
      dispatched = true;
      return new Promise((resolve) => { finish = resolve; });
    } });
    const f = fixture(runtime);
    f.coordinator.start();
    await until(() => dispatched);
    await f.coordinator.stop();
    expect(releaseCount).toBe(0);
    expect(f.failures).toEqual(['cancelled']);
    finish(providerResponse(writerResult));
    await until(() => releaseCount === 1);
    expect(f.accepted()).toBe(0);
  });

  test('model error text is never persisted as a failure reason', async () => {
    const f = fixture({ configured: () => true, run: async () => { throw new Error('PRIVATE_KEY_AND_TOOL_LOG'); } });
    f.coordinator.start();
    await until(() => f.failures.length === 1);
    await f.coordinator.stop();
    expect(f.failures).toEqual(['runtime_failed']);
  });

  test('provider concurrency stays bounded even across rooms', async () => {
    let claimed = 0;
    let running = 0;
    let maximum = 0;
    let completed = 0;
    const service: RoomRunPort = {
      claimNext: () => claimed >= 5 ? null : { ...context().attempt, id: `attempt-${claimed++}` },
      context: (attempt) => ({ ...context(), attempt }), renew: () => true, dispatched: () => true,
      accept: () => { completed++; return true; }, fail: () => {}, recover: () => {}, isCurrent: () => true,
    };
    const runtime: RoomRuntime = { configured: () => true, run: async () => { running++; maximum = Math.max(maximum, running); await sleep(10); running--; return writerResult; } };
    const coordinator = new RoomCoordinator({ service, runtime, maxConcurrent: 2, pollIntervalMs: 10 });
    coordinator.start();
    await until(() => completed === 5);
    await coordinator.stop();
    expect(maximum).toBe(2);
  });
});

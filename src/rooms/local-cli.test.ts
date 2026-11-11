import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RoomExecutionContext } from './contracts';
import { RoomLocalCliRuntime } from './local-cli';
import { RoomMemberRuntime } from './member-runtime';
import { RoomModelRuntime } from './model-runtime';
import { DEFAULT_LLM_CONFIG } from '../agents/llm';
import { inspectLocalGroup, localHash, readRecord } from './local-cli-state';
import { createHash } from 'node:crypto';

const fixtures: string[] = [];
const result = { message: 'Formal delivery', artifact: { title: 'Draft', markdown: 'Verbatim draft\n' } };
function fixture(mode = 'success', claudeVersion = '2.1.282') {
  const parent = resolve('.private/chatroom-design-v2/local-cli-checks/tests');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'fixture-')); fixtures.push(directory);
  const executable = join(directory, 'fake-cli');
  const capture = join(directory, 'capture.json');
  writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs');
const args=process.argv.slice(2);
if(args.includes('--version')){console.log(${JSON.stringify(`Claude ${claudeVersion} codex 0.156.1`)});process.exit(0)}
let input=''; process.stdin.on('data',v=>input+=v);process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args,input,cwd:process.cwd(),env:process.env}),{mode:384});
${mode === 'hang' ? "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);" : mode === 'descendant' ? "const child=require('node:child_process').spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});child.unref();console.log(JSON.stringify({result:JSON.stringify(" + JSON.stringify(result) + ")}));" : `const result=${JSON.stringify(result)}; const at=args.indexOf('--output-last-message'); if(at>=0) fs.writeFileSync(args[at+1],JSON.stringify(result)); console.error('PRIVATE_STDERR'); console.log(JSON.stringify({result:JSON.stringify(result),thinking:'PRIVATE_THINKING',tool_logs:'PRIVATE_TOOL_LOG'}));`}
});\n`, { mode: 0o700 });
  const auth = join(directory, 'auth'); mkdirSync(auth);
  writeFileSync(join(auth, '.credentials.json'), '{"private":"PRIVATE_CREDENTIAL"}');
  writeFileSync(join(auth, 'auth.json'), '{"private":"PRIVATE_CREDENTIAL"}');
  const stateDir = join(directory, 'state');
  const options = { stateDir, claudePath: executable, codexPath: executable, claudeHome: auth, codexHome: auth, environment: { PATH: process.env.PATH, PRIVATE_PARENT_SECRET: 'MUST_NOT_PASS', NODE_OPTIONS: '--unsafe-parent-option' }, pollMs: 10 };
  return { directory, capture, options, runtime: new RoomLocalCliRuntime(options) };
}
function context(provider: 'claude' | 'codex' | 'deepseek' = 'claude', roomId = 'room-1', memberId = 'writer-1'): RoomExecutionContext {
  const now = Date.now();
  const member = { id: memberId, projectId: 1, roomId, role: 'writer' as const, displayName: 'Writer', address: `room/${roomId}/agent/${memberId}`, modelProfile: 'default', status: 'active' as const, version: 1, model: { provider, model: 'test-model', effort: 'high' as const } };
  return { member, members: [member], attempt: { id: `attempt-${crypto.randomUUID()}`, assignmentId: 'assignment-1', projectId: 1, roomId, missionId: 'mission-1', memberId, role: 'writer', kind: 'work', goalRevision: 1, round: 1, controlEpoch: 1, fence: 1, workerId: 'worker-1', leaseUntil: now + 30_000, deadlineTs: now + 5_000, audience: { kind: 'room' } },
    mission: { id: 'mission-1', projectId: 1, roomId, state: 'running', phase: 'producing', version: 1, controlEpoch: 1, goalRevision: 1, round: 1, nextRole: 'writer', locale: 'en', actorUserId: 1, budget: { limits: { modelRequests: 48, activeMs: 1_200_000, rounds: 4 }, modelRequests: 0, activeMs: 0 }, question: null, reasonCode: null, createdAt: now, updatedAt: now }, goal: { id: 'goal-1', missionId: 'mission-1', revision: 1, request: 'Write a formal draft.', criteria: [{ id: 'criterion-1', description: 'Draft', required: true }], createdAt: now }, contributions: [], artifacts: [], assessments: [] };
}
async function until(fn: () => boolean) { const end = Date.now() + 2_000; while (!fn()) { if (Date.now() > end) throw new Error('fixture timeout'); await new Promise(done => setTimeout(done, 10)); } }
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('private local CLI member sessions', () => {
  test('independent fault turns reuse restricted transport with separate durable identity and no host tools',async()=>{
    const f=fixture();const request={id:'diag-unique-turn',scopeId:'incident-unique',projectId:7,agent:'claude' as const,model:'test-model',effort:'low' as const,deadlineTs:Date.now()+5000,system:'Independent fault analysis only.',input:'Verified failure evidence.'};
    const text=await f.runtime.runIndependentText(request,new AbortController().signal);
    expect(text).toContain('Formal delivery');
    const capture=JSON.parse(readFileSync(f.capture,'utf8'));
    expect(capture.args[capture.args.indexOf('--tools')+1]).toBe('');
    expect(capture.args).toContain('--restricted');
    expect(capture.cwd).toContain(localHash(request.id));
    expect(capture.cwd).not.toContain('module-workspace');
    expect(capture.env.PRIVATE_PARENT_SECRET).toBeUndefined();
  });
  test('verified Claude 2.1.284 supports a formal local session', async () => {
    const f = fixture('success', '2.1.284'); const ctx = context();
    expect(f.runtime.configuredFor([ctx.member])).toBe(true);
    expect(await f.runtime.run(ctx, new AbortController().signal, () => true)).toEqual(result);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    expect(capture.args[capture.args.indexOf('--tools') + 1]).toBe('');
    expect(capture.args).toContain('--safe-mode');
  });
  test('unverified newer Claude versions stay unavailable without starting a session', async () => {
    const f = fixture('success', '2.1.285'); const ctx = context(); let dispatched = 0;
    expect(f.runtime.configuredFor([ctx.member])).toBe(false);
    expect(f.runtime.modelCatalog().providers.find(provider => provider.provider === 'claude')?.reason).toBe('cli_version_unsupported');
    await expect(f.runtime.run(ctx, new AbortController().signal, () => { dispatched++; return true; })).rejects.toThrow('not_configured');
    expect(dispatched).toBe(0);
    expect(existsSync(f.capture)).toBe(false);
  });
  test('real spawn forwards exact model/effort with no shell, isolated authentication and only formal output', async () => {
    const f = fixture(); const ctx = context(); const dispatched: string[] = [];
    expect(f.runtime.configuredFor([ctx.member])).toBe(true);
    expect(await f.runtime.run(ctx, new AbortController().signal, id => { dispatched.push(id!); return true; })).toEqual(result);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    expect(capture.args[capture.args.indexOf('--model') + 1]).toBe('test-model');
    expect(capture.args[capture.args.indexOf('--effort') + 1]).toBe('high');
    expect(capture.args[capture.args.indexOf('--tools') + 1]).toBe('');
    expect(capture.args).toContain('--safe-mode'); expect(capture.args).toContain('--restricted');
    expect(capture.args).toContain('--no-session-persistence');
    expect(capture.env.PRIVATE_PARENT_SECRET).toBeUndefined(); expect(capture.env.NODE_OPTIONS).toBeUndefined();
    expect(capture.env.CLAUDE_CODE_MAX_RETRIES).toBe('0');
    expect(capture.cwd).not.toBe(process.cwd());
    expect(capture.env.HOME).toContain(localHash(ctx.member.id));
    expect(statSync(capture.env.HOME).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(capture.input)).not.toContain('PRIVATE_');
    expect(dispatched).toEqual(['request-1']);
    expect(await f.runtime.confirmStopped(ctx.attempt, new AbortController().signal)).toBe(true);
    expect(await f.runtime.confirmStopped({ ...ctx.attempt, fence: 2 }, new AbortController().signal)).toBe(false);
  });
  test('Codex controlled metadata disables powerful tools despite upstream model defaults', async () => {
    const f = fixture(); const ctx = context('codex');
    expect(await f.runtime.run(ctx, new AbortController().signal, () => true)).toEqual(result);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    expect(capture.args).toContain('--ignore-user-config'); expect(capture.args).toContain('--ignore-rules');
    expect(capture.args).toContain('--ephemeral'); expect(capture.args).toContain('--strict-config');
    const argument = capture.args.find((item: string) => item.startsWith('model_catalog_json='));
    const catalog = JSON.parse(readFileSync(JSON.parse(argument.slice(argument.indexOf('=') + 1)), 'utf8')).models[0];
    expect(catalog.slug).toBe('test-model'); expect(catalog.apply_patch_tool_type).toBeNull();
    expect(catalog.multi_agent_version).toBeNull(); expect(catalog.experimental_supported_tools).toEqual([]);
    expect(catalog.supports_search_tool).toBe(false); expect(catalog.node_repl_disabled).toBe(true);
    expect(capture.args).toContain('model_reasoning_effort="high"');
    expect(JSON.stringify(f.runtime.modelCatalog())).not.toContain('PRIVATE_');
  });
  test('member binding is permanent and a budget rejection never launches the CLI', async () => {
    const f = fixture(); const ctx = context();
    await expect(f.runtime.run(ctx, new AbortController().signal, () => false)).rejects.toThrow('cancelled');
    expect(existsSync(f.capture)).toBe(false);
    await expect(f.runtime.run(context('claude', 'other-room'), new AbortController().signal, () => true)).rejects.toThrow('scope_mismatch');
    expect(existsSync(f.capture)).toBe(false);
  });
  test('removing source login credentials removes an obsolete member copy before environment authentication', async () => {
    const f = fixture();
    await f.runtime.run(context(), new AbortController().signal, () => true);
    const capture = JSON.parse(readFileSync(f.capture, 'utf8'));
    const copy = join(capture.env.CLAUDE_CONFIG_DIR, '.credentials.json');
    expect(existsSync(copy)).toBe(true);
    rmSync(join(f.options.claudeHome, '.credentials.json'));
    (f.options.environment as NodeJS.ProcessEnv).CLAUDE_CODE_OAUTH_TOKEN = 'NEW_PRIVATE_LOGIN';
    await f.runtime.run(context(), new AbortController().signal, () => true);
    expect(existsSync(copy)).toBe(false);
    expect(JSON.parse(readFileSync(f.capture, 'utf8')).env.CLAUDE_CODE_OAUTH_TOKEN).toBe('NEW_PRIVATE_LOGIN');
  });
  test('cancellation acknowledged during the dispatch gap prevents a late supervisor launching', async () => {
    const f = fixture(); const ctx = context(); let stopped: Promise<boolean> | undefined;
    await expect(f.runtime.run(ctx, new AbortController().signal, () => {
      stopped = f.runtime.confirmStopped(ctx.attempt, new AbortController().signal);
      return true;
    })).rejects.toThrow('runtime_failed');
    expect(await stopped).toBe(true); expect(existsSync(f.capture)).toBe(false);
  });
  test('only authorized source text is supplied directly to the tool-free CLI', async () => {
    const f = fixture(); const ctx = context();
    const content = 'Authorized source paragraph.';
    const source = { id: 'source-1', roomId: ctx.attempt.roomId, missionId: ctx.attempt.missionId, goalRevision: 1, version: 1, title: 'Source', content, digest: createHash('sha256').update(content).digest('hex'), audience: { kind: 'room' as const }, status: 'active' as const, createdAt: 1 };
    ctx.sources = [source, { ...source, id: 'source-private', audience: { kind: 'members', memberIds: ['someone-else'] } }];
    await f.runtime.run(ctx, new AbortController().signal, () => true, { call: call => { expect(call.args.sourceId).toBe(source.id); return source; } });
    const input = JSON.parse(readFileSync(f.capture, 'utf8')).input;
    expect(input).toContain(content); expect(input).not.toContain('PRIVATE_SIBLING_CONTENT');
    expect(JSON.parse(input).sources).toHaveLength(1);
  });
  test('a room lock blocks another member until cancellation confirms the actual process group stopped', async () => {
    const f = fixture('hang'); const ctx = context(); const controller = new AbortController();
    const running = f.runtime.run(ctx, controller.signal, () => true).catch(error => error);
    await until(() => existsSync(f.capture));
    const second = new RoomLocalCliRuntime(f.options);
    await expect(second.run(context('claude', 'room-1', 'writer-2'), new AbortController().signal, () => true)).rejects.toThrow('cli_busy');
    controller.abort();
    expect((await running).code).toBe('cancelled');
    expect(await second.confirmStopped(ctx.attempt, new AbortController().signal)).toBe(true);
    const path = join(f.options.stateDir, 'rooms', localHash('1:room-1'), 'attempts', localHash(ctx.attempt.id), 'process.json');
    expect(inspectLocalGroup(readRecord(path)!)).toBe('gone');
  });
  test('restart recovery cancels exact persisted identity and refuses stale fences', async () => {
    const f = fixture('hang'); const ctx = context();
    const running = f.runtime.run(ctx, new AbortController().signal, () => true).catch(error => error);
    await until(() => existsSync(f.capture));
    const restarted = new RoomLocalCliRuntime(f.options);
    expect(await restarted.confirmStopped({ ...ctx.attempt, fence: 22 }, new AbortController().signal)).toBe(false);
    expect(await restarted.confirmStopped(ctx.attempt, new AbortController().signal)).toBe(true);
    expect((await running).code).toBe('runtime_failed');
    expect(readdirSync(join(f.options.stateDir, 'rooms', localHash('1:room-1')))).not.toContain('execution.lock');
  });
  test('a surviving descendant prevents acceptance and is stopped at the attempt deadline', async () => {
    const f = fixture('descendant'); const ctx = context(); ctx.attempt.deadlineTs = Date.now() + 600;
    await expect(f.runtime.run(ctx, new AbortController().signal, () => true)).rejects.toThrow('timeout');
    expect(await f.runtime.confirmStopped(ctx.attempt, new AbortController().signal)).toBe(true);
  });
});

test('member router keeps API cancellation detached and CLI cancellation durable; API model and effort follow member', async () => {
  const f = fixture(); let body: any;
  const api = new RoomModelRuntime({ config: { ...DEFAULT_LLM_CONFIG, baseUrl: 'https://deepseek.invalid', apiKey: 'PRIVATE_KEY', model: 'default-deepseek' }, fetchFn: async (_url, init) => { body = JSON.parse(init!.body as string); return Response.json({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }); } });
  const runtime = new RoomMemberRuntime({ api, local: f.runtime, stateDir: f.options.stateDir });
  const ctx = context('deepseek');
  expect(runtime.cancellationModeFor(ctx)).toBe('detach');
  expect(await runtime.run(ctx, new AbortController().signal, () => true)).toEqual(result);
  expect(body.model).toBe('test-model'); expect(body.reasoning_effort).toBe('high');
  expect(await runtime.confirmStopped(ctx.attempt, new AbortController().signal)).toBe(true);
  const local = context();
  expect(runtime.cancellationModeFor(local)).toBe('confirm');
  expect(await runtime.confirmStopped(local.attempt, new AbortController().signal)).toBe(true);
  expect(await runtime.confirmStopped({ ...local.attempt, id: 'old-external-launcher' }, new AbortController().signal)).toBe(false);
  const localOnly = new RoomMemberRuntime({ api: new RoomModelRuntime({ config: DEFAULT_LLM_CONFIG }), local: f.runtime, stateDir: f.options.stateDir });
  expect(localOnly.configured()).toBe(true); expect(localOnly.configuredFor([])).toBe(false);
  expect(localOnly.configuredFor([local.member])).toBe(true); expect(localOnly.configuredFor([ctx.member])).toBe(false);
});

test('DeepSeek reasoning needed for tool continuation remains private to one attempt', async () => {
  const sent: any[] = []; const ctx = context('deepseek'); ctx.member.model!.effort = 'medium';
  const api = new RoomModelRuntime({ config: { ...DEFAULT_LLM_CONFIG, baseUrl: 'https://deepseek.invalid', apiKey: 'PRIVATE_KEY', model: 'default-model' }, fetchFn: async (_url, init) => {
    sent.push(JSON.parse(init!.body as string));
    return sent.length === 1 ? Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: '', reasoning_content: 'PRIVATE_CONTINUATION', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_sources', arguments: '{"query":"draft"}' } }] } }] }) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result), reasoning_content: 'PRIVATE_FINAL' } }] });
  } });
  const formal = await api.run(ctx, new AbortController().signal, () => true, { call: () => [] });
  expect(sent[0].reasoning_effort).toBe('medium'); expect(sent[0].model).toBe('test-model');
  expect(sent[1].messages.find((message: any) => message.role === 'assistant').reasoning_content).toBe('PRIVATE_CONTINUATION');
  expect(JSON.stringify(formal)).not.toContain('PRIVATE_');
  await api.run(context('deepseek'), new AbortController().signal, () => true);
  expect(JSON.stringify(sent[2])).not.toContain('PRIVATE_CONTINUATION');
});


test('member design uses fresh restricted Claude/Codex CLI sessions and DeepSeek API only', async () => {
  const f = fixture(); let requests = 0;
  const api = new RoomModelRuntime({ config: { ...DEFAULT_LLM_CONFIG, baseUrl: 'https://fixture.invalid/v1', apiKey: 'private', model: 'test' }, fetchFn: async () => {
    requests++; return new Response(JSON.stringify({ choices: [{ message: { content: '{"summary":"Proposal","operations":[]}', reasoning_content: 'PRIVATE_THINKING' }, finish_reason: 'stop' }] }));
  } });
  const runtime = new RoomMemberRuntime({ api, local: f.runtime, stateDir: f.options.stateDir });
  for (const provider of ['claude', 'codex', 'deepseek'] as const) {
    const request = { projectId: 1, roomId: 'real-room', requestId: crypto.randomUUID(), model: { provider, model: 'test', effort: 'high' as const }, deadlineTs: Date.now() + 5000, messages: [{ role: 'system' as const, content: 'Return member proposal JSON' }, { role: 'user' as const, content: '{"members":[]}' }] };
    const formal = await runtime.designMembers(request, new AbortController().signal);
    expect(formal).not.toContain('PRIVATE_');
    if (provider !== 'deepseek') {
      expect(requests).toBe(0);
      const captured = JSON.parse(readFileSync(f.capture, 'utf8'));
      expect(captured.input).toBe('{"members":[]}'); expect(captured.env.HOME).not.toContain(localHash('writer-1'));
      expect(captured.args).toContain(provider === 'claude' ? '--restricted' : '--ignore-user-config');
    }
  }
  expect(requests).toBe(1);
});

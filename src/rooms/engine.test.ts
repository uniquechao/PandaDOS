import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { RoomEngine } from './engine';
import { RoomStore } from './store';
import { migrateRooms } from './migrations';
import type { RoomAttempt, RoomFormalResult, RoomScope } from './contracts';
import type { RoomCommand, RoomCommandInput, RoomSnapshot } from '../../shared/rooms';

let db: Database;
let store: RoomStore;
let engine: RoomEngine;
let now = 1_800_000_000_000;
let sequence = 0;
const meta = () => ({ actor: { userId: 1 }, key: `command-${++sequence}` });
function create(start = true, extra = {}) {
  return engine.create(1, { title: 'Writing team', request: 'Write an introduction with three concrete scenarios.', criteria: ['At most 1000 characters.'], start, ...extra }, meta());
}
const scope = (snapshot: RoomSnapshot): RoomScope => ({ projectId: snapshot.room.projectId, roomId: snapshot.room.id });
function cmd(snapshot: RoomSnapshot, command: RoomCommand, extra: Partial<RoomCommandInput> = {}): RoomSnapshot {
  const current = engine.snapshot(scope(snapshot));
  return engine.command(scope(snapshot), current.mission!.id, command, { expectedVersion: current.mission!.version, ...extra }, meta());
}
function claim(): RoomAttempt { const attempt = engine.claimNext('worker'); expect(attempt).not.toBeNull(); expect(engine.dispatched(attempt!)).toBe(true); return attempt!; }
function accept(result: RoomFormalResult): RoomAttempt { const attempt = claim(); expect(engine.accept(attempt, result)).toBe(true); return attempt; }
function toReview(snapshot: RoomSnapshot) {
  accept({ message: 'Plan the introduction.', decision: 'continue' });
  accept({ message: 'The audience needs three concrete examples.' });
  accept({ message: 'The draft is available.', artifact: { title: 'Introduction', markdown: 'Scenario one. Scenario two. Scenario three.' } });
  const attempt = claim();
  const ctx = engine.context(attempt);
  expect(attempt.role).toBe('reviewer');
  const artifact = ctx.artifacts[0]!;
  const result: RoomFormalResult = { message: 'Reviewed each requirement.', review: { artifactId: artifact.id, artifactVersion: artifact.currentVersion, criteria: ctx.goal.criteria.map(c => ({ criterionId: c.id, verdict: 'passed', note: `Checked ${c.id}.` })) } };
  return { attempt, ctx, result, snapshot: engine.snapshot(scope(snapshot)) };
}

beforeEach(() => {
  now = 1_800_000_000_000;
  sequence = 0;
  db = openDb(':memory:');
  migrate(db);
  migrateRooms(db);
  db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'test','unused','admin',0),(2,'other','unused','user',0)");
  db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'test','local','test','','','')");
  db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'p',1,'/p',1,0),(2,'q',1,'/q',2,0)");
  store = new RoomStore(db);
  engine = new RoomEngine({ store, now: () => now });
});
afterEach(() => db.close());

describe('room identity and SQLite constraints', () => {
  test('migration is idempotent and existing project records survive', () => {
    expect(migrateRooms(db).applied).toContain(81);
    expect(db.query('SELECT id FROM projects').all()).toHaveLength(2);
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  test('room instances and native sessions cannot move, including after stop and lease expiry', () => {
    const a = create(); const b = create(false);
    const member = a.members[0]!;
    expect(() => db.run('UPDATE room_members SET room_id=? WHERE id=?', [b.room.id, member.id])).toThrow('room_member_scope_immutable');
    engine.bindRuntime(scope(a), member.id, 'deployment/runner/session-generation');
    expect(() => engine.bindRuntime(scope(b), b.members[0]!.id, 'deployment/runner/session-generation')).toThrow();
    expect(() => db.run('UPDATE room_runtime_bindings SET member_id=?,room_id=?', [b.members[0]!.id, b.room.id])).toThrow('room_runtime_scope_immutable');
    expect(() => db.run('DELETE FROM room_runtime_bindings')).toThrow('room_runtime_binding_retained');
    expect(a.members.map(m => m.id).some(id => b.members.some(m => m.id === id))).toBe(false);
    expect(member.address).toBe(`room/${a.room.id}/agent/${member.id}`);
  });
  test('full scope foreign keys reject cross-room assignments even if member UUID exists', () => {
    const a = create(); const b = create(false);
    expect(() => db.run("INSERT INTO room_assignments(id,project_id,room_id,mission_id,member_id,kind,instruction,goal_revision,created_ts) VALUES('bad',?,?,?,?, 'work','x',1,0)", [1, a.room.id, a.mission!.id, b.members[0]!.id])).toThrow();
  });
  test('one open mission and a fresh mission after closure retain permanent member identities', () => {
    const a = create(false);
    expect(() => engine.newMission(scope(a), { request: 'Other goal' }, meta())).toThrow();
    const stopped = cmd(a, 'stop');
    const fresh = engine.newMission(scope(stopped), { request: 'Other goal' }, meta());
    expect(fresh.mission!.state).toBe('draft');
    expect(fresh.mission!.id).not.toBe(stopped.mission!.id);
    expect(fresh.members.map(m => m.id)).toEqual(a.members.map(m => m.id));
    expect(() => cmd(stopped, 'resume')).toThrow();
  });
  test('same command is idempotent; different payload under its key conflicts', () => {
    const key = meta();
    const input = { title: 'One', request: 'Write prose' };
    const first = engine.create(1, input, key);
    expect(engine.create(1, input, key).room.id).toBe(first.room.id);
    expect(() => engine.create(1, { ...input, title: 'Two' }, key)).toThrow();
    expect(engine.list(1)).toHaveLength(1);
  });
});

describe('finite autonomous workflow', () => {
  test('coach/planner/writer/reviewer/coach closes only after current independent criteria pass', () => {
    const a = create();
    const review = toReview(a);
    expect(engine.snapshot(scope(a)).mission!.state).toBe('running');
    expect(engine.accept(review.attempt, review.result)).toBe(true);
    const coach = accept({ message: 'The current version satisfies the goal.', decision: 'complete' });
    expect(coach.role).toBe('coach');
    const final = engine.snapshot(scope(a));
    expect(final.mission!.state).toBe('completed');
    expect(final.mission!.budget.modelRequests).toBe(5);
    expect(final.artifacts[0]!.adoptedVersion).toBeNull();
    expect(final.assessments).toHaveLength(2);
    expect(engine.claimNext('worker')).toBeNull();
    expect(engine.adopt(scope(a), final.artifacts[0]!.id, 1, meta()).artifacts[0]!.adoptedVersion).toBe(1);
  });
  test('fulfilled work does not bypass missing or failed criteria, and reviewers cannot write', () => {
    const a = create();
    const initial = claim();
    expect(() => engine.accept(initial, { message: 'Done', decision: 'complete' })).toThrow();
    expect(engine.accept(initial, { message: 'Plan', decision: 'continue' })).toBe(true);
    accept({ message: 'Plan details' });
    accept({ message: 'Draft', artifact: { title: 'Draft', markdown: 'One scene only.' } });
    const reviewer = claim();
    expect(() => engine.accept(reviewer, { message: 'Overwrite', artifact: { title: 'Wrong', markdown: 'Wrong' } })).toThrow();
    const ctx = engine.context(reviewer);
    engine.accept(reviewer, { message: 'Needs another revision.', review: { artifactId: ctx.artifacts[0]!.id, artifactVersion: 1, criteria: ctx.goal.criteria.map(c => ({ criterionId: c.id, verdict: 'failed', note: 'Requirements not satisfied.' })) } });
    const coach = claim();
    expect(() => engine.accept(coach, { message: 'Ignore the failed review', decision: 'complete' })).toThrow();
    expect(engine.snapshot(scope(a)).mission!.state).toBe('running');
  });
  test('submission retries are digest-idempotent, never double-publish', () => {
    const a = create(); const attempt = claim();
    const result: RoomFormalResult = { message: 'Plan', decision: 'continue' };
    engine.accept(attempt, result);
    const before = engine.snapshot(scope(a));
    expect(engine.accept(attempt, result)).toBe(true);
    expect(engine.snapshot(scope(a)).eventCursor).toBe(before.eventCursor);
    expect(() => engine.accept(attempt, { ...result, message: 'Other' })).toThrow();
  });
  test('last request and last round limits are enforced without an extra summary request', () => {
    const a = create(true, { budget: { modelRequests: 1 } });
    const attempt = claim();
    expect(engine.claimNext('second-worker')).toBeNull();
    engine.accept(attempt, { message: 'Plan', decision: 'continue' });
    expect(engine.claimNext('second-worker')).toBeNull();
    const exhausted = engine.snapshot(scope(a));
    expect(exhausted.mission!.state).toBe('exhausted');
    expect(exhausted.mission!.budget.modelRequests).toBe(1);
    const granted = cmd(exhausted, 'budget', { budget: { modelRequests: 2 } });
    expect(granted.mission!.budget.modelRequests).toBe(1);
    expect(granted.mission!.budget.limits.modelRequests).toBe(3);
    expect(claim().role).toBe('planner');
  });
  test('round cap is cumulative and adding request budget alone cannot produce another round', () => {
    const a = create(true, { budget: { rounds: 1 } });
    const { attempt, result } = toReview(a);
    engine.accept(attempt, { ...result, review: { ...result.review!, criteria: result.review!.criteria.map(c => ({ ...c, verdict: 'failed' })) } });
    accept({ message: 'Try another approach', decision: 'continue' });
    expect(engine.snapshot(scope(a)).mission!.state).toBe('exhausted');
    expect(engine.snapshot(scope(a)).mission!.round).toBe(1);
    expect(engine.claimNext('worker')).toBeNull();
    expect(() => cmd(a, 'budget', { budget: { modelRequests: 1 } })).toThrow();
    const grant = cmd(a, 'budget', { budget: { rounds: 1 } });
    expect(grant.mission!.budget.limits.rounds).toBe(2);
  });
  test('physical dispatch consumes the reservation once; cancellation before dispatch releases it', () => {
    const a = create(true, { budget: { modelRequests: 1 } });
    const waiting = engine.claimNext('worker')!;
    expect(engine.snapshot(scope(a)).mission!.budget).toMatchObject({ modelRequests: 0, reservedRequests: 1 });
    expect(engine.accept(waiting, { message: 'Unmetered mock', decision: 'continue' })).toBe(false);
    engine.fail(waiting, 'context_too_large');
    expect(engine.snapshot(scope(a)).mission!.budget).toMatchObject({ modelRequests: 0, reservedRequests: 0 });
    cmd(a, 'resume');
    const sent = engine.claimNext('worker')!;
    expect(engine.dispatched(sent)).toBe(true);
    expect(engine.dispatched(sent)).toBe(false);
    engine.fail(sent, 'provider_unavailable');
    expect(engine.snapshot(scope(a)).mission!.budget).toMatchObject({ modelRequests: 1, reservedRequests: 0 });
  });
  test('two unchanged drafts with the same remaining criteria interrupt instead of looping', () => {
    const a = create(); const first = toReview(a);
    const failed = (result: RoomFormalResult): RoomFormalResult => ({ ...result, review: { ...result.review!, criteria: result.review!.criteria.map(c => ({ ...c, verdict: 'failed' })) } });
    engine.accept(first.attempt, failed(first.result));
    accept({ message: 'Revise the missing scenarios', decision: 'continue' });
    accept({ message: 'Another proposal' });
    accept({ message: 'Revision', artifact: { title: 'Introduction', markdown: 'Scenario one. Scenario two. Scenario three.' } });
    const review = claim();
    const ctx = engine.context(review);
    engine.accept(review, failed({ message: 'Same gaps remain', review: { artifactId: ctx.artifacts[0]!.id, artifactVersion: 2, criteria: ctx.goal.criteria.map(c => ({ criterionId: c.id, verdict: 'failed', note: 'Missing details.' })) } }));
    accept({ message: 'Try again', decision: 'continue' });
    expect(engine.snapshot(scope(a)).mission).toMatchObject({ state: 'interrupted', reasonCode: 'no_progress' });
    cmd(a, 'resume', { guidance: 'Change the structure to a tutorial.' });
    accept({ message: 'Use the revised approach', decision: 'continue' });
    expect(engine.snapshot(scope(a)).mission!.nextRole).toBe('planner');
  });
});

describe('control fences, restart recovery and privacy', () => {
  test('pause wins against late submit; settling old attempt cannot release a new attempt', () => {
    const a = create(); const old = claim();
    const pausing = cmd(a, 'pause');
    expect(pausing.mission!.state).toBe('quiescing');
    expect(engine.accept(old, { message: 'Late', decision: 'continue' })).toBe(false);
    engine.fail(old, 'cancelled');
    expect(engine.snapshot(scope(a)).mission!.state).toBe('paused');
    cmd(a, 'resume');
    const fresh = claim();
    expect(fresh.fence).toBeGreaterThan(old.fence);
    expect(fresh.controlEpoch).toBeGreaterThan(old.controlEpoch);
    engine.fail(old, 'cancelled');
    expect(engine.isCurrent(fresh)).toBe(true);
  });
  test('expired leases remain charged, require explicit resume, and reject old owners', () => {
    const a = create(); const old = claim();
    now += 31_000;
    engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    engine.recover();
    const interrupted = engine.snapshot(scope(a));
    expect(interrupted.mission!.state).toBe('interrupted');
    expect(interrupted.mission!.budget.activeMs).toBe(31_000);
    expect(interrupted.mission!.budget.modelRequests).toBe(1);
    expect(engine.claimNext('new-worker')).toBeNull();
    expect(engine.renew(old)).toBe(false);
    cmd(a, 'resume');
    const fresh = claim();
    expect(fresh.fence).toBeGreaterThan(old.fence);
    expect(engine.accept(old, { message: 'Old', decision: 'continue' })).toBe(false);
    expect(engine.snapshot(scope(a)).mission!.budget.modelRequests).toBe(2);
  });
  test('stopping an interrupted expired API execution settles without refunding the uncertain request', () => {
    const a = create(); const expired = claim();
    now += 31_000;
    engine.recover();
    const stopped = cmd(a, 'stop');
    expect(stopped.mission!.state).toBe('stopped');
    expect(stopped.mission!.budget.modelRequests).toBe(1);
    expect(engine.accept(expired, { message: 'Late response', decision: 'continue' })).toBe(false);
    const fresh = engine.newMission(scope(a), { request: 'Independent new goal' }, meta());
    expect(fresh.mission!.state).toBe('draft');
  });
  test('goal revision waits for local cancellation and excludes previous goal assessments', () => {
    const a = create();
    const review = toReview(a);
    engine.accept(review.attempt, review.result);
    const coach = claim();
    const pending = cmd(a, 'goal', { request: 'New original goal', criteria: ['A new criterion'] });
    expect(pending.mission!.state).toBe('quiescing');
    expect(pending.goal!.revision).toBe(1);
    expect(engine.accept(coach, { message: 'Late completion', decision: 'complete' })).toBe(false);
    engine.fail(coach, 'cancelled');
    const changed = engine.snapshot(scope(a));
    expect(changed.goal!.revision).toBe(2);
    expect(changed.goal!.request).toBe('New original goal');
    const next = claim();
    const ctx = engine.context(next);
    expect(ctx.assessments).toHaveLength(0);
    expect(ctx.artifacts).toHaveLength(0);
    expect(ctx.baselineArtifacts).toHaveLength(1);
    expect(ctx.baselineArtifacts![0]!.markdown).toBe(review.ctx.artifacts[0]!.versions[0]!.markdown);
    expect(() => engine.accept(next, { message: 'Reuse old verdict', decision: 'complete' })).toThrow();
  });
  test('directed messages only enter replies with compatible audience, including for coach', () => {
    const a = create();
    const coach = a.members.find(m => m.role === 'coach')!;
    const writer = a.members.find(m => m.role === 'writer')!;
    const marker = 'PRIVATE_DIRECTED_MARKER';
    engine.contribute(scope(a), { text: marker, audience: { kind: 'members', memberIds: [coach.id] }, clientMessageId: 'private' }, { userId: 1 });
    const reply = claim();
    expect(reply.kind).toBe('reply');
    expect(engine.context(reply).contributions.some(c => c.text === marker)).toBe(true);
    expect(() => engine.accept(reply, { message: 'Forward', decision: 'continue' })).toThrow();
    engine.accept(reply, { message: 'Private reply' });
    const work = claim();
    expect(work.kind).toBe('work');
    expect(engine.context(work).contributions.some(c => c.text === marker || c.text === 'Private reply')).toBe(false);
    engine.contribute(scope(a), { text: 'Visible to writer only', audience: { kind: 'members', memberIds: [writer.id] }, clientMessageId: 'writer' }, { userId: 1 });
    expect(engine.context(work).contributions.some(c => c.text === 'Visible to writer only')).toBe(false);
    expect(engine.snapshot(scope(a)).contributions.some(c => c.text === marker)).toBe(true); // Human project collaborators can view formal records.
  });
  test('scope forgery and private provider fields cannot enter formal output', () => {
    const a = create(); const b = create(false); const attempt = claim();
    expect(() => engine.context({ ...attempt, roomId: b.room.id })).toThrow();
    expect(engine.accept({ ...attempt, memberId: b.members[0]!.id }, { message: 'x', decision: 'continue' })).toBe(false);
    expect(() => engine.accept(attempt, { message: 'x', decision: 'continue', raw: 'PRIVATE_RAW_MARKER' } as RoomFormalResult)).toThrow();
    expect(() => engine.accept(attempt, { message: '<think>PRIVATE_THOUGHT_MARKER</think>', decision: 'continue' })).toThrow();
    engine.fail(attempt, 'PRIVATE_ERROR_MARKER token=secret');
    const serialized = JSON.stringify(engine.snapshot(scope(a)));
    expect(serialized).not.toContain('PRIVATE_');
    expect(engine.snapshot(scope(a)).mission!.reasonCode).toBe('execution_failed');
  });
  test('event cursors are continuous and a restarted store yields the same formal snapshot', () => {
    const a = create(); accept({ message: 'Plan', decision: 'continue' });
    engine.contribute(scope(a), { text: '  Exact user text\n', audience: { kind: 'room' }, clientMessageId: 'original' }, { userId: 1 });
    const before = engine.snapshot(scope(a));
    const after = new RoomEngine({ store: new RoomStore(db), now: () => now }).snapshot(scope(a));
    expect(after).toEqual(before);
    expect(after.contributions.at(-1)!.text).toBe('  Exact user text\n');
    const events = db.query<{ seq: number }, [string]>('SELECT seq FROM room_events WHERE room_id=? ORDER BY seq').all(a.room.id);
    expect(events.map(e => e.seq)).toEqual(Array.from({ length: before.eventCursor }, (_, i) => i + 1));
  });
});

describe('durable questions and explicit historical inputs', () => {
  test('answers retain the exact question and options across recovery', () => {
    const a = create();
    accept({ message: 'One clarification is needed.', decision: 'ask_user', question: { text: 'Which audience should the draft address?', options: ['Designers', 'Engineers'] } });
    const waiting = engine.snapshot(scope(a));
    const original = waiting.contributions.at(-1)!;
    expect(original.question).toEqual(waiting.mission!.question!);
    expect(() => cmd(waiting, 'answer', { questionId: 'stale', answer: 'First option' })).toThrow();
    const answered = cmd(waiting, 'answer', { questionId: original.question!.id, answer: 'First option' });
    expect(answered.mission!.question).toBeNull();
    expect(answered.contributions.at(-1)).toMatchObject({ replyTo: original.id, answersQuestionId: original.question!.id, text: 'First option' });
    engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    const ctx = engine.context(claim());
    expect(ctx.contributions.find(item => item.id === original.id)!.question).toEqual(original.question);
    expect(ctx.contributions.at(-1)!.answersQuestionId).toBe(original.question!.id);
  });
  test('editing user criteria does not turn the generated original request into an extra condition', () => {
    const request = 'A'.repeat(501);
    const a = create(false, { request });
    expect(a.goal!.criteria.map(item => item.origin)).toEqual(['request', 'user']);
    expect(() => cmd(a, 'goal', { request: 'New goal', criteria: a.goal!.criteria.map(item => item.description) })).toThrow();
    expect(() => cmd(a, 'goal', { request: 'New goal', criteria: [], userCriteria: [] })).toThrow();
    const b = cmd(a, 'goal', { request: 'New goal', userCriteria: ['New criterion'] });
    const c = cmd(b, 'goal', { request: 'Third goal' });
    expect(c.goal!.criteria.map(item => item.description)).toEqual(['Third goal', 'New criterion']);
    expect(c.goals!.map(goal => goal.request)).toEqual([request, 'New goal', 'Third goal']);
    expect(c.goals![0]!.criteria[1]!.description).toBe('At most 1000 characters.');
  });
  test('baseline revisions are exact and explicit resets and new missions do not inherit history', () => {
    const a = create(); const review = toReview(a);
    engine.accept(review.attempt, review.result);
    const artifact = review.ctx.artifacts[0]!;
    const changed = cmd(a, 'goal', { request: 'Only change the heading', userCriteria: [] });
    expect(changed.goal!.baselineArtifactRefs).toEqual([{ artifactId: artifact.id, version: 1 }]);
    const attempt = claim();
    const ctx = engine.context(attempt);
    expect(ctx.baselineArtifacts![0]).toMatchObject({ artifactId: artifact.id, version: 1, digest: artifact.versions[0]!.digest });
    expect(ctx.assessments).toEqual([]);
    cmd(changed, 'pause'); engine.fail(attempt, 'cancelled');
    const reset = cmd(changed, 'goal', { request: 'Start from a blank document', baselineArtifactRefs: [] });
    expect(reset.goal!.baselineArtifactRefs).toEqual([]);
    expect(() => cmd(reset, 'goal', { request: 'Missing version', baselineArtifactRefs: [{ artifactId: artifact.id, version: 99 }] })).toThrow();
    cmd(reset, 'stop');
    const fresh = engine.newMission(scope(a), { request: 'An independent task' }, meta());
    expect(fresh.goal!.baselineArtifactRefs).toEqual([]);
    expect(fresh.missions).toHaveLength(2);
    const authorized = cmd(fresh, 'goal', { request: 'Revise the old text', baselineArtifactRefs: [{ artifactId: artifact.id, version: 1 }] });
    expect(authorized.goal!.baselineArtifactRefs).toHaveLength(1);
    const other = create(false);
    expect(() => cmd(other, 'goal', { request: 'Cross-room reference', baselineArtifactRefs: [{ artifactId: artifact.id, version: 1 }] })).toThrow();
  });
  test('explicit historical replies preserve audience intersection and reject stale editor submissions', () => {
    const a = create(false);
    const coach = a.members.find(member => member.role === 'coach')!;
    const b = engine.contribute(scope(a), { text: 'Previous goal detail', audience: { kind: 'room' }, clientMessageId: 'old' }, { userId: 1 });
    const publicReference = b.contributions.at(-1)!;
    const c = engine.contribute(scope(a), { text: 'Private prior goal detail', audience: { kind: 'members', memberIds: [coach.id] }, clientMessageId: 'old-private' }, { userId: 1 });
    const privateReference = c.contributions.at(-1)!;
    cmd(c, 'goal', { request: 'Updated goal' });
    expect(() => engine.contribute(scope(a), { text: 'Stale composer', audience: { kind: 'room' }, clientMessageId: 'stale', missionId: a.mission!.id, goalRevision: 1 }, { userId: 1 })).toThrow();
    expect(() => engine.contribute(scope(a), { text: 'Leak', audience: { kind: 'room' }, replyTo: privateReference.id, clientMessageId: 'leak' }, { userId: 1 })).toThrow();
    engine.contribute(scope(a), { text: 'Keep that requirement', audience: { kind: 'room' }, replyTo: publicReference.id, clientMessageId: 'reference' }, { userId: 1 });
    cmd(c, 'start');
    const attempt = claim();
    const ctx = engine.context(attempt);
    expect(ctx.referenceContributions!.map(item => item.id)).toEqual([publicReference.id]);
    expect(JSON.stringify(ctx)).not.toContain('Private prior goal detail');
  });
});

describe('authorized sources, tools and editable artifacts', () => {
  test('sources expose only authorized fixed content and revocation fences in-flight requests', () => {
    const a = create(false); const coach = a.members.find(member => member.role === 'coach')!;
    const grant = (title: string, audience: RoomSnapshot['contributions'][number]['audience']) => engine.grantSource(scope(a), { missionId: a.mission!.id, goalRevision: 1, title, content: `Exact ${title} source content.`, audience }, meta());
    const publicSource = grant('Public', { kind: 'room' }).sources![0]!;
    const privateSource = grant('Private', { kind: 'members', memberIds: [coach.id] }).sources![1]!;
    expect(store.snapshot(scope(a), now, { metadataOnly: true }).sources![0]).toMatchObject({ content: '', contentLoaded: false });
    expect(store.sources(scope(a), { sourceId: publicSource.id })).toHaveLength(1);
    cmd(a, 'start');
    const attempt = claim();
    expect(engine.context(attempt).sources.map(source => source.id)).toEqual([publicSource.id]);
    expect(engine.tool(attempt, { id: 'read', name: 'read_source', args: { sourceId: publicSource.id, version: 1 } })).toMatchObject({ content: publicSource.content });
    expect(engine.tool(attempt, { id: 'read', name: 'read_source', args: { sourceId: publicSource.id, version: 1 } })).toMatchObject({ digest: publicSource.digest });
    expect(() => engine.tool(attempt, { id: 'private', name: 'read_source', args: { sourceId: privateSource.id, version: 1 } })).toThrow();
    expect(() => engine.tool(attempt, { id: 'path', name: 'read_source', args: { sourceId: publicSource.id, version: 1, path: '/etc/passwd' } })).toThrow();
    expect(() => engine.tool(attempt, { id: 'read', name: 'search_sources', args: { query: 'Exact' } })).toThrow();
    expect(engine.tool(attempt, { id: 'search', name: 'search_sources', args: { query: 'Exact' } })).toEqual([{ id: publicSource.id, version: 1, title: 'Public', digest: publicSource.digest, excerpt: publicSource.content }]);
    expect(store.get<{tool_calls: number}>('SELECT tool_calls FROM room_attempts WHERE id=?', attempt.id)!.tool_calls).toBe(2);
    for (let index = 3; index <= 12; index++) engine.tool(attempt, { id: `read-${index}`, name: 'read_source', args: { sourceId: publicSource.id, version: 1 } });
    expect(() => engine.tool(attempt, { id: 'read-13', name: 'read_source', args: { sourceId: publicSource.id, version: 1 } })).toThrow();
    const revoked = engine.revokeSource(scope(a), publicSource.id, meta());
    expect(revoked.mission!.state).toBe('quiescing');
    expect(engine.isCurrent(attempt)).toBe(false);
    expect(() => engine.tool(attempt, { id: 'read', name: 'read_source', args: { sourceId: publicSource.id, version: 1 } })).toThrow();
    expect(engine.accept(attempt, { message: 'Late quote', decision: 'continue' })).toBe(false);
    engine.fail(attempt, 'cancelled');
    expect(engine.snapshot(scope(a)).mission!.state).toBe('paused');
    expect(() => db.run('UPDATE room_sources SET content=? WHERE id=?', ['changed', publicSource.id])).toThrow('room_source_content_immutable');
  });
  test('multiple physical requests charge once each and stop at cumulative and per-attempt limits', () => {
    const a = create(true, { budget: { modelRequests: 2 } });
    const attempt = claim();
    expect(engine.dispatched(attempt, now, 'request-3')).toBe(false);
    expect(engine.dispatched(attempt, now, 'request-2')).toBe(true);
    expect(engine.dispatched(attempt, now, 'request-2')).toBe(false);
    expect(engine.dispatched(attempt, now, 'request-3')).toBe(false);
    expect(engine.snapshot(scope(a)).mission!.budget).toMatchObject({ modelRequests: 2, reservedRequests: 0 });
    expect(engine.accept(attempt, { message: 'Late plan after denied dispatch', decision: 'continue' })).toBe(false);
    engine.fail(attempt, 'cancelled');
    expect(engine.claimNext('worker')).toBeNull();
    expect(engine.snapshot(scope(a)).mission!.state).toBe('exhausted');
    cmd(a, 'stop');
    const b = create(); const second = claim();
    for (let index = 2; index <= 6; index++) expect(engine.dispatched(second, now, `request-${index}`)).toBe(true);
    expect(engine.dispatched(second, now, 'request-7')).toBe(false);
    expect(engine.snapshot(scope(b)).mission!.budget.modelRequests).toBe(6);
  });
  test('evidence must quote authorized source exactly and persists with the artifact version', () => {
    const a = create(false);
    const source = engine.grantSource(scope(a), { missionId: a.mission!.id, goalRevision: 1, title: 'Reference', content: 'Users prefer three concrete examples.', audience: { kind: 'room' } }, meta()).sources![0]!;
    cmd(a, 'start');
    accept({ message: 'Plan', decision: 'continue' }); accept({ message: 'Use the reference' });
    const writer = claim();
    const evidence = { sourceId: source.id, sourceVersion: 1, quote: 'three concrete examples' };
    const result: RoomFormalResult = { message: 'Draft', artifact: { title: 'Draft', markdown: 'One. Two. Three.' }, evidence: [evidence] };
    expect(() => engine.accept(writer, { ...result, evidence: [{ ...evidence, quote: 'Fabricated quotation' }] })).toThrow();
    expect(engine.accept(writer, result)).toBe(true);
    const snapshot = engine.snapshot(scope(a));
    expect(snapshot.artifacts[0]!.versions[0]!.evidence).toEqual([evidence]);
    expect(snapshot.contributions.at(-1)!.evidence).toEqual([evidence]);
    expect(db.query('SELECT name FROM room_tool_calls').all()).toEqual([]);
  });
  test('user edits create immutable CAS versions, clear adoption, pause and require independent re-review', () => {
    const a = create(); const review = toReview(a); engine.accept(review.attempt, review.result);
    accept({ message: 'Complete', decision: 'complete' });
    let complete = engine.snapshot(scope(a)); const artifact = complete.artifacts[0]!;
    complete = engine.adopt(scope(a), artifact.id, 1, meta());
    const input = { expectedVersion: 1, expectedMissionVersion: complete.mission!.version, title: 'Edited title', markdown: '  Exact edited text\n' };
    const editKey = meta();
    const edited = engine.editArtifact(scope(a), artifact.id, input, editKey);
    expect(edited.mission!.state).toBe('paused');
    expect(edited.artifacts[0]!.adoptedVersion).toBeNull();
    expect(edited.artifacts[0]!.versions[1]).toMatchObject({ version: 2, authorType: 'user', authorUserId: 1, markdown: input.markdown });
    expect(engine.editArtifact(scope(a), artifact.id, input, editKey).artifacts[0]!.versions).toHaveLength(2);
    expect(() => engine.editArtifact(scope(a), artifact.id, input, meta())).toThrow();
    expect(() => engine.adopt(scope(a), artifact.id, 2, meta())).toThrow();
    expect(engine.claimNext('worker')).toBeNull();
    cmd(edited, 'resume'); const reviewer = claim();
    expect(reviewer.role).toBe('reviewer');
    const ctx = engine.context(reviewer);
    engine.accept(reviewer, { message: 'Edited draft passed', review: { artifactId: artifact.id, artifactVersion: 2, criteria: ctx.goal.criteria.map(item => ({ criterionId: item.id, verdict: 'passed', note: 'Checked edited text' })) } });
    accept({ message: 'Re-reviewed version is ready', decision: 'complete' });
    expect(engine.snapshot(scope(a)).mission!.state).toBe('completed');
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  test('team preferences keep permanent identity and reject editing active members', () => {
    const a = create(false); const coach = a.members[0]!;
    const configured = engine.configureMember(scope(a), coach.id, { expectedVersion: 1, displayName: '  Meeting coach  ', instructions: '  Ask precise questions.\n' }, meta());
    expect(configured.members[0]).toMatchObject({ id: coach.id, address: coach.address, displayName: '  Meeting coach  ', instructions: '  Ask precise questions.\n', version: 2 });
    expect(() => engine.configureMember(scope(a), coach.id, { expectedVersion: 1, displayName: 'Stale', instructions: '' }, meta())).toThrow();
    cmd(a, 'start'); const attempt = claim();
    expect(engine.context(attempt).member.instructions).toBe('  Ask precise questions.\n');
    expect(engine.snapshot(scope(a)).members[0]!.activity!.state).toBe('working');
    expect(() => engine.configureMember(scope(a), coach.id, { expectedVersion: 2, displayName: 'Live change', instructions: '' }, meta())).toThrow();
  });
});

describe('finite plans and formal directed collaboration', () => {
  test('only false conditions are skipped; failed prerequisites remain blocked until explicit retry', () => {
    const a = create();
    const plan: NonNullable<RoomFormalResult['plan']> = { tasks: [
      { id: 'repair-plan', role: 'planner', instruction: 'Repair remaining failed criteria', dependsOn: [], condition: 'has_failed_review' },
      { id: 'write', role: 'writer', instruction: 'Write the draft', dependsOn: ['repair-plan'] },
      { id: 'review', role: 'reviewer', instruction: 'Independently review', dependsOn: ['write'] },
    ] };
    accept({ message: 'First draft with optional repair planning', decision: 'continue', plan });
    expect(engine.snapshot(scope(a)).plans![0]!.tasks[0]!.state).toBe('skipped');
    const writerAttempt = claim(); expect(writerAttempt.role).toBe('writer');
    const live = engine.claimNext('other'); expect(live).toBeNull();
    engine.accept(writerAttempt, { message: 'Draft', artifact: { title: 'Draft', markdown: 'Draft with gaps' } });
    const reviewer = claim(); const ctx = engine.context(reviewer);
    engine.accept(reviewer, { message: 'Needs repair', review: { artifactId: ctx.artifacts[0]!.id, artifactVersion: 1, criteria: ctx.goal.criteria.map(item => ({ criterionId: item.id, verdict: 'failed', note: 'Missing detail' })) } });
    accept({ message: 'Now repair the failed review', decision: 'continue', plan });
    const planner = claim(); expect(planner.role).toBe('planner');
    engine.fail(planner, 'provider_unavailable');
    const failed = engine.snapshot(scope(a));
    expect(failed.mission!.state).toBe('interrupted');
    expect(failed.plans![1]!.tasks.map(item => item.state)).toEqual(['failed', 'pending', 'pending']);
    expect(engine.claimNext('worker')).toBeNull();
    cmd(failed, 'resume');
    expect(claim().assignmentId).toBe(planner.assignmentId);
  });
  test('independent proposal nodes do not see each other, then the writer joins their contributions', () => {
    const a = create();
    accept({ message: 'Generate two independent proposals', decision: 'continue', plan: { tasks: [
      { id: 'idea-a', role: 'planner', instruction: 'Explore first approach', dependsOn: [], independent: true },
      { id: 'idea-b', role: 'planner', instruction: 'Explore second approach', dependsOn: [], independent: true },
      { id: 'write', role: 'writer', instruction: 'Combine both proposals', dependsOn: ['idea-a', 'idea-b'] },
      { id: 'review', role: 'reviewer', instruction: 'Check against the goal', dependsOn: ['write'] },
    ] } });
    const first = claim(); expect(engine.context(first).task!.id).toBe('idea-a');
    engine.accept(first, { message: 'FIRST_INDEPENDENT_PROPOSAL' });
    engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    const second = claim(); const secondContext = engine.context(second);
    expect(secondContext.task!.id).toBe('idea-b');
    expect(JSON.stringify(secondContext)).not.toContain('FIRST_INDEPENDENT_PROPOSAL');
    engine.accept(second, { message: 'SECOND_INDEPENDENT_PROPOSAL' });
    const writer = claim(); const writerContext = engine.context(writer);
    expect(writer.role).toBe('writer');
    expect(writerContext.contributions.map(item => item.text)).toContain('FIRST_INDEPENDENT_PROPOSAL');
    expect(writerContext.contributions.map(item => item.text)).toContain('SECOND_INDEPENDENT_PROPOSAL');
    engine.accept(writer, { message: 'Combined draft', artifact: { title: 'Both proposals', markdown: 'One. Two. Three.' } });
    const reviewer = claim(); const ctx = engine.context(reviewer);
    engine.accept(reviewer, { message: 'Passed', review: { artifactId: ctx.artifacts[0]!.id, artifactVersion: 1, criteria: ctx.goal.criteria.map(item => ({ criterionId: item.id, verdict: 'passed', note: 'Checked' })) } });
    accept({ message: 'Ready', decision: 'complete' });
    const final = engine.snapshot(scope(a));
    expect(final.mission!.state).toBe('completed');
    expect(final.plans![0]!.tasks.map(task => task.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    expect(final.plans![0]!.state).toBe('completed');
    expect(final.contributions.find(item => item.text === 'FIRST_INDEPENDENT_PROPOSAL')!.taskId).toBe('idea-a');
    expect(final.mission!.budget.modelRequests).toBe(6);
  });
  test('agent-directed messages publish atomically and reply tasks cannot create echo chains', () => {
    const a = create(); const writer = a.members.find(member => member.role === 'writer')!;
    const coach = claim();
    const result: RoomFormalResult = { message: 'Clarification', decision: 'ask_user', question: { text: 'Continue?', options: [] }, messages: [{ text: 'DIRECTED_FORMAL_MESSAGE', audience: { kind: 'members', memberIds: [writer.id] } }] };
    engine.accept(coach, result);
    expect(engine.accept(coach, result)).toBe(true);
    const waiting = engine.snapshot(scope(a));
    expect(waiting.contributions.filter(item => item.text === 'DIRECTED_FORMAL_MESSAGE')).toHaveLength(1);
    cmd(waiting, 'answer', { questionId: waiting.mission!.question!.id, answer: 'Yes' });
    const reply = claim(); expect(reply.kind).toBe('reply');
    expect(engine.context(reply).contributions.some(item => item.text === 'DIRECTED_FORMAL_MESSAGE')).toBe(true);
    expect(() => engine.accept(reply, { message: 'Echo', messages: [{ text: 'Recursive', audience: { kind: 'members', memberIds: [a.members[0]!.id] } }] })).toThrow();
    engine.accept(reply, { message: 'FORMAL_PRIVATE_REPLY' });
    const work = claim();
    expect(engine.context(work).contributions.some(item => item.text.includes('DIRECTED_FORMAL_MESSAGE') || item.text.includes('FORMAL_PRIVATE_REPLY'))).toBe(false);
  });
});

describe('external execution cancellation requires durable acknowledgement', () => {
  test('an unmetered external launch keeps its lock through pause, failure and restart until exact confirmation', () => {
    const a = create();
    const attempt = engine.claimNext('old-worker')!;
    expect(engine.setCancellationMode(attempt, 'confirm')).toBe(true);
    expect(engine.setCancellationMode(attempt, 'detach')).toBe(false);
    expect(cmd(a, 'pause').mission!.state).toBe('quiescing');
    engine.fail(attempt, 'cancelled');
    expect(engine.snapshot(scope(a)).mission!.state).toBe('quiescing');
    expect(engine.snapshot(scope(a)).mission!.budget.reservedRequests).toBe(1);
    now += 60_000; engine.recover();
    engine = new RoomEngine({ store: new RoomStore(db), now: () => now });
    const [pending] = engine.pendingStops();
    expect(pending).toMatchObject({ id: attempt.id, fence: attempt.fence, workerId: 'old-worker', cancelMode: 'confirm' });
    expect(engine.claimNext('new-worker')).toBeNull();
    expect(() => cmd(a, 'resume')).toThrow();
    expect(() => engine.newMission(scope(a), { request: 'Cannot move on while an executor may still run' }, meta())).toThrow();
    expect(engine.confirmStopped({ ...pending!, fence: pending!.fence + 1 })).toBe(false);
    expect(engine.confirmStopped({ ...pending!, roomId: 'wrong-room' })).toBe(false);
    expect(engine.confirmStopped(pending!)).toBe(true);
    const stopped = engine.snapshot(scope(a));
    expect(stopped.mission!.state).toBe('paused');
    expect(stopped.mission!.budget).toMatchObject({ modelRequests: 0, reservedRequests: 0 });
    cmd(stopped, 'resume'); const next = engine.claimNext('new-worker')!;
    expect(next.id).not.toBe(attempt.id);
    expect(engine.confirmStopped(pending!)).toBe(true);
    expect(engine.isCurrent(next)).toBe(true);
    expect(engine.pendingStops()).toEqual([]);
  });
  test('an expired confirmed-mode worker stays quiescing and charged, unlike API detachment', () => {
    const a = create(); const attempt = engine.claimNext('external-worker')!;
    engine.setCancellationMode(attempt, 'confirm');
    expect(engine.dispatched(attempt)).toBe(true);
    expect(engine.setCancellationMode(attempt, 'detach')).toBe(false);
    now += 31_000; engine.recover();
    const blocked = engine.snapshot(scope(a));
    expect(blocked.mission!.state).toBe('quiescing');
    expect(store.mission(scope(a), a.mission!.id).target_state).toBe('interrupted');
    expect(blocked.mission!.budget.modelRequests).toBe(1);
    expect(engine.pendingStops()).toHaveLength(1);
    expect(engine.accept(attempt, { message: 'Late completion', decision: 'continue' })).toBe(false);
    expect(engine.confirmStopped(engine.pendingStops()[0]!)).toBe(true);
    expect(engine.snapshot(scope(a)).mission!.state).toBe('interrupted');
    expect(engine.snapshot(scope(a)).mission!.budget.modelRequests).toBe(1);
    cmd(a, 'resume'); expect(engine.claimNext('new-worker')).not.toBeNull();
  });
  test('goal revision stays pending until the exact external process is confirmed stopped', () => {
    const a = create(); const attempt = engine.claimNext('external-worker')!;
    engine.setCancellationMode(attempt, 'confirm'); engine.dispatched(attempt);
    const changing = cmd(a, 'goal', { request: 'A new target', userCriteria: [] });
    expect(changing.goal!.revision).toBe(1);
    engine.fail(attempt, 'runtime_failed');
    expect(engine.snapshot(scope(a)).goal!.revision).toBe(1);
    expect(engine.confirmStopped(engine.pendingStops()[0]!)).toBe(true);
    const settled = engine.snapshot(scope(a));
    expect(settled.goal!.revision).toBe(2);
    expect(settled.mission!.state).toBe('queued');
    expect(engine.claimNext('new-worker')!.goalRevision).toBe(2);
  });
});

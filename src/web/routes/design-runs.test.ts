import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { DesignRunCoordinatorError, type DesignRunView } from '../../designs/run-coordinator';
import { migrateDesigns } from '../../designs/store';
import { migrateIssueEngine } from '../../issues/engine';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { designRunRoutes } from './design-runs';

function run(overrides: Partial<DesignRunView> = {}): DesignRunView {
  return {
    id: 'run-1', designId: 7, projectId: 1, mode: 'goal', sourceRevision: 1,
    status: 'queued', personas: ['builtin:goal-coach', 'builtin:design-steward'],
    cancelRequested: false, failureCode: null, createdTs: 1, startedTs: null,
    finishedTs: null, updatedTs: 1, ...overrides,
  };
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  const users = new UserStore(db);
  const owner = users.create('owner');
  const member = users.create('member');
  const outsider = users.create('outsider');
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', '', '/workspace', '/claude')`);
  db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, '/workspace/one', ?, 1),
           (2, 'two', 1, '/workspace/two', ?, 1)`).run(owner.user.id, outsider.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 1)')
    .run(member.user.id);
  const calls: unknown[][] = [];
  const coordinator = {
    start(projectId: number, designId: number, input: unknown) { calls.push(['start', projectId, designId, input]); return run(); },
    getScoped(projectId: number, designId: number, runId: string) {
      calls.push(['get', projectId, designId, runId]);
      if (runId === 'missing') throw new DesignRunCoordinatorError('DESIGN_RUN_NOT_FOUND', 'secret sql path');
      return run();
    },
    cancel(projectId: number, designId: number, runId: string, revision: number) {
      calls.push(['cancel', projectId, designId, runId, revision]);
      return run({ status: 'cancelled', cancelRequested: true });
    },
  };
  const dispatch = createDispatcher(designRunRoutes({ coordinator }), authDepsFromDb(db, users));
  const call = async (method: string, path: string, token: string | null, body?: unknown, key?: string) => {
    const response = await dispatch(new Request(`http://test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))!;
    return { status: response.status, body: await response.json() as any };
  };
  return { db, owner, member, outsider, calls, call };
}

describe('design run routes', () => {
  test('starts only for owners with a strict request and idempotency key', async () => {
    const s = setup();
    const payload = { expectedRevision: 1, mode: 'goal', message: 'Clarify the outcome.' };
    expect((await s.call('POST', '/api/projects/1/designs/7/runs', s.member.token, payload, 'run-key')).status).toBe(403);
    expect((await s.call('POST', '/api/projects/1/designs/7/runs', s.owner.token, payload)).status).toBe(400);
    expect((await s.call('POST', '/api/projects/1/designs/7/runs', s.owner.token,
      { ...payload, unknown: true }, 'run-key')).status).toBe(400);
    const started = await s.call('POST', '/api/projects/1/designs/7/runs', s.owner.token, payload, 'run-key');
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ id: 'run-1', status: 'queued' });
    expect(s.calls[0]).toMatchObject(['start', 1, 7, { actorUserId: s.owner.user.id, idempotencyKey: 'run-key' }]);
    s.db.close();
  });

  test('allows project members to poll but keeps cancellation owner-only', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/projects/1/designs/7/runs/run-1', s.member.token)).status).toBe(200);
    expect((await s.call('POST', '/api/projects/1/designs/7/runs/run-1/cancel', s.member.token,
      { expectedRevision: 1 })).status).toBe(403);
    const cancelled = await s.call('POST', '/api/projects/1/designs/7/runs/run-1/cancel', s.owner.token,
      { expectedRevision: 1 });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe('cancelled');
    s.db.close();
  });

  test('rejects non-canonical scope IDs and redacts internal failures', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/projects/01/designs/7/runs/run-1', s.owner.token)).status).toBe(400);
    expect((await s.call('GET', '/api/projects/1/designs/7/runs/+1', s.owner.token)).status).toBe(400);
    const missing = await s.call('GET', '/api/projects/1/designs/7/runs/missing', s.owner.token);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('design.run_not_found');
    expect(JSON.stringify(missing.body)).not.toContain('secret sql path');
    s.db.close();
  });
});

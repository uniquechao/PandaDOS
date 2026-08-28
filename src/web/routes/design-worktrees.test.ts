import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { User } from '../../core/types';
import type { DesignExecutionRun } from '../../designs/worktree';
import { designWorktreeRoutes, type DesignWorktreeRouteService } from './design-worktrees';

const user = { id: 7 } as User;
const digest = 'a'.repeat(64);
function run(overrides: Partial<DesignExecutionRun> = {}): DesignExecutionRun {
  return {
    id: 'run-1', projectId: 1, designId: 2, publicationId: 3, revision: 4,
    graphDigest: digest, idempotencyKey: 'secret-key', executionMode: 'worktree',
    lifecycleState: 'ready', assignmentActive: false, baseRef: 'refs/heads/main',
    baseSha: 'b'.repeat(40), worktreeBranch: 'codex/design-1-2',
    worktreeCwd: '/secret/server/path', observedHeadSha: 'b'.repeat(40),
    observedUpstream: null, observedAhead: null, observedBehind: null,
    errorCode: null, errorDetail: '/secret/sqlite/path', createdTs: 1, updatedTs: 2,
    archivedTs: null, cleanedTs: null, ...overrides,
  };
}

function setup() {
  const db = new Database(':memory:');
  db.run('CREATE TABLE design_tasks (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL)');
  db.run('INSERT INTO design_tasks VALUES (2, 1)');
  const calls: unknown[] = [];
  const service: DesignWorktreeRouteService = {
    getRun: () => run(),
    async create(input) { calls.push(input); return run({ publicationId: null }); },
    async inspect(input) { calls.push(input); return run(); },
    async execute(input) { calls.push(input); return run({ lifecycleState: 'executing', assignmentActive: true }); },
    async archive(input) { calls.push(input); return run({ lifecycleState: 'archived' }); },
    async clean(input) { calls.push(input); return run({ lifecycleState: 'cleaned' }); },
  };
  return { db, calls, routes: designWorktreeRoutes({ db, service }) };
}

describe('design worktree routes', () => {
  test('GET is project scoped and returns a safe DTO without cwd, idempotency key, or error detail', async () => {
    const s = setup();
    const route = s.routes.find((item) => item.method === 'GET')!;
    const response = await route.handler({ req: new Request('http://x'), url: new URL('http://x'), params: { projectId: '1', designId: '2' }, user });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('/secret/server/path');
    expect(text).not.toContain('secret-key');
    expect(text).not.toContain('/secret/sqlite/path');
    const hidden = await route.handler({ req: new Request('http://x'), url: new URL('http://x'), params: { projectId: '9', designId: '2' }, user });
    expect(hidden.status).toBe(404);
    s.db.close();
  });

  test('create requires strict body, canonical idempotency key, and server-generated branch/path', async () => {
    const s = setup();
    const route = s.routes.find((item) => item.method === 'POST' && !item.path.endsWith('inspect')
      && !item.path.endsWith('execute') && !item.path.endsWith('archive') && !item.path.endsWith('clean'))!;
    const req = new Request('http://x', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': 'create-1',
    }, body: JSON.stringify({ expectedRevision: 4, graphDigest: digest, executionMode: 'worktree', baseRef: 'refs/heads/main' }) });
    const response = await route.handler({ req, url: new URL('http://x'), params: { projectId: '1', designId: '2' }, user });
    expect(response.status).toBe(201);
    expect(s.calls[0]).toEqual({ projectId: 1, designId: 2, revision: 4, graphDigest: digest,
      executionMode: 'worktree', idempotencyKey: 'create-1', baseRef: 'refs/heads/main' });
    const unknown = new Request('http://x', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Idempotency-Key': 'create-2',
    }, body: JSON.stringify({ expectedRevision: 4, graphDigest: digest, executionMode: 'current', cwd: '/tmp/evil' }) });
    expect((await route.handler({ req: unknown, url: new URL('http://x'), params: { projectId: '1', designId: '2' }, user })).status).toBe(400);
    s.db.close();
  });

  test('state mutations require the exact publication/revision/digest tuple', async () => {
    const s = setup();
    const route = s.routes.find((item) => item.path.endsWith('/execute'))!;
    const wrong = new Request('http://x', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicationId: 3, expectedRevision: 5, graphDigest: digest }) });
    expect((await route.handler({ req: wrong, url: new URL('http://x'), params: { projectId: '1', designId: '2' }, user })).status).toBe(409);
    expect(s.calls).toHaveLength(0);
    s.db.close();
  });
});

import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import type { Project } from '../../core/types';
import { UserStore } from '../../core/users';
import {
  createDesignFilesService,
  createDesignFilesSnapshotAccess,
  createDesignFilesTargetResolver,
} from '../../designs/files-adapter';
import {
  DesignFilesError,
  type DesignFilesDiffResult,
  type DesignFilesDriver,
} from '../../designs/files';
import type { DesignRevision, DesignTask } from '../../designs/types';
import type { DesignExecutionRun } from '../../designs/worktree';
import { gitLockKey, KeyedMutex } from '../../issues/mutex';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { designFilesRoutes, type DesignFilesRouteService } from './design-files';

function task(projectId = 1, currentRevision = 2): DesignTask {
  return { id: 9, projectId, currentRevision } as DesignTask;
}

function revision(value: number): DesignRevision {
  return {
    id: value,
    designTaskId: 9,
    revision: value,
    documentJson: { goal: `revision ${value}` },
    documentMarkdown: `# Revision ${value}\n`,
    readiness: 90,
    graph: { nodes: [], edges: [] },
    actor: 'owner:1',
    reason: null,
    createdTs: value,
  };
}

function diffResult(): DesignFilesDiffResult {
  return {
    projectId: 1,
    designId: 9,
    revision: 2,
    targetKind: 'project',
    files: [{
      path: 'DESIGN.md',
      classification: 'conflict',
      baseSha256: 'a'.repeat(64),
      localSha256: 'b'.repeat(64),
      incomingSha256: 'c'.repeat(64),
      baseBytes: 1,
      localBytes: 2,
      incomingBytes: 3,
      baseText: 'base',
      localText: 'local',
      incomingText: 'incoming',
    }],
    conflictToken: 'payload.signature',
  };
}

function routeSetup() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const owner = users.create('owner');
  const member = users.create('member');
  const stranger = users.create('stranger');
  db.run(
    `INSERT INTO executors
       (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir,
        supports_claude, supports_codex)
     VALUES (1, 'local', '127.0.0.1', 22, 'root', '', '/workspace', '/claude', 1, 1)`,
  );
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'one', 1, '/workspace/one', ?, 1),
            (2, 'two', 1, '/workspace/two', ?, 1)`,
  ).run(owner.user.id, owner.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 1)')
    .run(member.user.id);

  const calls: Array<{ kind: 'diff' | 'publish'; input: unknown }> = [];
  let diffFailure: unknown = null;
  let publishFailure: unknown = null;
  const service: DesignFilesRouteService = {
    async diff(input) {
      calls.push({ kind: 'diff', input });
      if (diffFailure) throw diffFailure;
      return { ...diffResult(), futurePrivateCwd: '/private/repo' } as DesignFilesDiffResult;
    },
    async publish(input) {
      calls.push({ kind: 'publish', input });
      if (publishFailure) throw publishFailure;
      return {
        status: 'published', revision: input.expectedRevision, targetKind: 'project',
        bundleSha256: 'd'.repeat(64), futurePrivateCwd: '/private/repo',
      } as never;
    },
  };
  const store = {
    getTask(id: number) { return id === 9 ? task(1) : null; },
    isTaskProvisional() { return false; },
  };
  const dispatch = createDispatcher(
    designFilesRoutes({ store, service }),
    authDepsFromDb(db, users),
  );
  return {
    dispatch, calls, admin, owner, member, stranger,
    fail(error: unknown) { diffFailure = error; publishFailure = error; },
    failPublish(error: unknown) { publishFailure = error; },
  };
}

function get(path: string, token?: string): Request {
  return new Request(`http://test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function response(value: Response | Promise<Response> | null) {
  const resolved = await value!;
  return { status: resolved.status, body: await resolved.json() as Record<string, any> };
}

describe('design files route boundary', () => {
  test('allows members to inspect but only owner/admin to publish and hides cross-project designs', async () => {
    const setup = routeSetup();
    const path = '/api/projects/1/designs/9/file-diff?expectedRevision=2';
    expect((await response(setup.dispatch(get(path)))).status).toBe(401);
    expect((await response(setup.dispatch(get(path, setup.stranger.token)))).status).toBe(403);
    expect((await response(setup.dispatch(get(path, setup.member.token)))).status).toBe(200);
    expect((await response(setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files', { expectedRevision: 2 }, setup.member.token,
    )))).status).toBe(403);
    expect((await response(setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files', { expectedRevision: 2 }, setup.owner.token,
    )))).status).toBe(200);
    expect((await response(setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files', { expectedRevision: 2 }, setup.admin.token,
    )))).status).toBe(200);
    const crossProject = await response(setup.dispatch(get(
      '/api/projects/2/designs/9/file-diff?expectedRevision=2', setup.owner.token,
    )));
    expect(crossProject).toMatchObject({ status: 404, body: { error: { code: 'design.not_found' } } });
  });

  test('strictly parses revision and overwrite token without accepting paths or unknown fields', async () => {
    const setup = routeSetup();
    const invalidGets = [
      '/api/projects/1/designs/9/file-diff',
      '/api/projects/1/designs/9/file-diff?expectedRevision=2&expectedRevision=2',
      '/api/projects/1/designs/9/file-diff?expectedRevision=2&cwd=/tmp/other',
      '/api/projects/1/designs/9/file-diff?expectedRevision=2.5',
    ];
    for (const path of invalidGets) {
      expect((await response(setup.dispatch(get(path, setup.owner.token)))).status).toBe(400);
    }
    const invalidBodies = [
      {},
      { expectedRevision: '2' },
      { expectedRevision: 2, cwd: '/tmp/other' },
      { expectedRevision: 2, conflictToken: 'payload.signature' },
      { expectedRevision: 2, resolution: 'overwrite' },
      { expectedRevision: 2, resolution: 'force', conflictToken: 'payload.signature' },
      { expectedRevision: 2, resolution: 'overwrite', conflictToken: 'not-signed' },
    ];
    for (const body of invalidBodies) {
      const result = await response(setup.dispatch(post(
        '/api/projects/1/designs/9/publish-files', body, setup.owner.token,
      )));
      expect(result).toMatchObject({ status: 400, body: { error: { code: 'design.files_invalid_request' } } });
    }
    const valid = await response(setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files',
      { expectedRevision: 2, resolution: 'overwrite', conflictToken: 'payload.signature' },
      setup.owner.token,
    )));
    expect(valid.status).toBe(200);
    expect(setup.calls.at(-1)).toEqual({
      kind: 'publish',
      input: { projectId: 1, designId: 9, expectedRevision: 2, resolution: 'overwrite', conflictToken: 'payload.signature' },
    });
  });

  test('returns an explicit safe DTO with relative projection paths and no future service secrets', async () => {
    const setup = routeSetup();
    const diff = await response(setup.dispatch(get(
      '/api/projects/1/designs/9/file-diff?expectedRevision=2', setup.member.token,
    )));
    expect(diff.body).toEqual({
      ok: true,
      diff: diffResult(),
    });
    expect(JSON.stringify(diff.body)).not.toContain('/private/repo');
    const published = await response(setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files', { expectedRevision: 2 }, setup.owner.token,
    )));
    expect(published.body).toEqual({
      ok: true,
      publication: {
        status: 'published', revision: 2, targetKind: 'project', bundleSha256: 'd'.repeat(64),
      },
    });
    expect(JSON.stringify(published.body)).not.toContain('/private/repo');
  });

  test('maps stable file errors without exposing driver diagnostics and includes a fresh external diff', async () => {
    const cases: Array<[DesignFilesError['code'], number, string]> = [
      ['REVISION_CONFLICT', 409, 'design.files_revision_conflict'],
      ['SNAPSHOT_NOT_FOUND', 404, 'design.not_found'],
      ['TARGET_INVALID', 409, 'design.files_target_unavailable'],
      ['REPO_UNAVAILABLE', 502, 'design.files_repo_unavailable'],
      ['UNSAFE_PATH', 409, 'design.files_unsafe_projection'],
      ['ASSET_INVALID', 409, 'design.files_asset_invalid'],
      ['MANIFEST_INVALID', 409, 'design.files_manifest_invalid'],
      ['CONFLICT_STALE', 409, 'design.files_conflict_stale'],
      ['WRITE_FAILED', 502, 'design.files_publish_failed'],
    ];
    for (const [code, status, expectedCode] of cases) {
      const setup = routeSetup();
      setup.fail(new DesignFilesError(code, 'ssh host /private/repo secret token=abc'));
      const result = await response(setup.dispatch(get(
        '/api/projects/1/designs/9/file-diff?expectedRevision=2', setup.owner.token,
      )));
      expect(result).toMatchObject({ status, body: { error: { code: expectedCode } } });
      expect(JSON.stringify(result.body)).not.toContain('/private/repo');
      expect(JSON.stringify(result.body)).not.toContain('token=abc');
    }

    const setup = routeSetup();
    setup.failPublish(new DesignFilesError('EXTERNAL_CHANGE', 'external state'));
    // The route must perform a fresh safe diff after the publish conflict.
    const serviceCall = setup.calls;
    const resultPromise = setup.dispatch(post(
      '/api/projects/1/designs/9/publish-files', { expectedRevision: 2 }, setup.owner.token,
    ));
    const result = await response(resultPromise);
    expect(result).toMatchObject({
      status: 409,
      body: { error: { code: 'design.files_external_change' }, diff: { revision: 2 } },
    });
    expect(serviceCall.map((call) => call.kind)).toEqual(['publish', 'diff']);
  });
});

describe('design files adapters', () => {
  test('loads current and immutable revision snapshots with optional asset and persona provenance ports', async () => {
    const revisions = new Map([[1, revision(1)], [2, revision(2)]]);
    const calls: string[] = [];
    const access = createDesignFilesSnapshotAccess({
      store: {
        getTask: (id) => id === 9 ? task(7) : null,
        getRevision: (_id, value) => revisions.get(value) ?? null,
        isTaskProvisional: () => false,
      },
      assets: {
        async listForRevision(projectId, designId, value) {
          calls.push(`asset:${projectId}:${designId}:${value}`);
          return [];
        },
      },
      personas: {
        async listForRevision(projectId, designId, value) {
          calls.push(`persona:${projectId}:${designId}:${value}`);
          return [{ key: 'builtin:reviewer', source: 'builtin', contentHash: 'a'.repeat(64) }];
        },
      },
    });
    expect(await access.loadCurrentSnapshot(7, 9)).toMatchObject({
      projectId: 7, designId: 9, revision: 2, documentMarkdown: '# Revision 2\n', assets: [],
      personas: [{ key: 'builtin:reviewer', source: 'builtin' }],
    });
    expect(await access.loadRevisionSnapshot(7, 9, 1)).toMatchObject({ revision: 1, documentMarkdown: '# Revision 1\n' });
    expect(await access.loadRevisionSnapshot(8, 9, 1)).toBeNull();
    expect(calls).toEqual(['asset:7:9:2', 'persona:7:9:2', 'asset:7:9:1', 'persona:7:9:1']);

    const empty = createDesignFilesSnapshotAccess({
      store: {
        getTask: () => task(7), getRevision: () => revision(2), isTaskProvisional: () => false,
      },
    });
    expect(await empty.loadCurrentSnapshot(7, 9)).toMatchObject({ assets: [], personas: [] });
  });

  test('prefers only a healthy active design worktree and fails closed for active unhealthy state', async () => {
    const driver = {} as DesignFilesDriver;
    const project = { id: 7, cwd: '/project' } as Project;
    let run: DesignExecutionRun | null = null;
    const resolve = createDesignFilesTargetResolver({
      projectLookup: (id) => id === 7 ? project : null,
      worktreeLookup: { getActiveByDesign: () => run },
      driverForProject: () => driver,
    });
    expect(await resolve(7, 9)).toMatchObject({ cwd: '/project', kind: 'project', stableKey: 'project:7' });

    run = {
      id: 'run-1', projectId: 7, designId: 9, executionMode: 'worktree', lifecycleState: 'executing',
      assignmentActive: true, worktreeCwd: '/managed/design-9', worktreeBranch: 'design/7-9',
      observedHeadSha: 'a'.repeat(40), errorCode: null,
    } as DesignExecutionRun;
    expect(await resolve(7, 9)).toMatchObject({
      cwd: '/managed/design-9', kind: 'design_worktree', stableKey: 'design-worktree:run-1',
    });

    run = { ...run, errorCode: 'WORKTREE_MISSING' };
    await expect(resolve(7, 9)).rejects.toMatchObject({ code: 'TARGET_INVALID' });
    run = { ...run, errorCode: null, lifecycleState: 'archived' };
    await expect(resolve(7, 9)).rejects.toMatchObject({ code: 'TARGET_INVALID' });
    run = { ...run, assignmentActive: false };
    expect(await resolve(7, 9)).toMatchObject({ cwd: '/project', kind: 'project' });
  });

  test('constructs the service with the caller shared Git mutex instead of a private lock', async () => {
    const mutex = new KeyedMutex();
    const gitCalls: string[][] = [];
    const driver: DesignFilesDriver = {
      async listDirectoryNoFollowWithin() { return null; },
      async readFileNoFollowWithin() { return null; },
      async replaceFileNoFollowWithin() { return 'conflict'; },
      async removeFileNoFollowWithin() { return 'conflict'; },
      async git(_cwd, args) {
        gitCalls.push(args);
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, out: 'true\n', err: '' };
        if (args[0] === 'symbolic-ref') return { code: 0, out: 'main\n', err: '' };
        return { code: 0, out: `${'a'.repeat(40)}\n`, err: '' };
      },
    };
    const project = { id: 7, cwd: '/project' } as Project;
    const service = createDesignFilesService({
      store: {
        getTask: () => task(7), getRevision: (_id, value) => revision(value), isTaskProvisional: () => false,
      },
      projectLookup: () => project,
      worktreeLookup: { getActiveByDesign: () => null },
      driverForProject: () => driver,
      mutex,
      conflictSecret: 'server-only-secret',
      now: () => 1,
    });
    let release!: () => void;
    let entered = false;
    const held = mutex.runExclusive(gitLockKey(7), async () => {
      entered = true;
      await new Promise<void>((resolve) => { release = resolve; });
    });
    while (!entered) await Promise.resolve();
    const pending = service.diff({ projectId: 7, designId: 9, expectedRevision: 2 });
    await Promise.resolve();
    expect(gitCalls).toEqual([]);
    release();
    await held;
    await pending;
    expect(gitCalls.length).toBe(3);
  });
});

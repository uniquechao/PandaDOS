import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import { migrateDesigns } from './store';
import {
  DesignWorktreeError,
  DesignWorktreeService,
  DesignWorktreeStore,
  parseWorktreePorcelain,
  type DesignWorktreeDriver,
  type DesignWorktreeApprovedDesign,
  type DesignWorktreeProject,
  type DesignWorktreePublication,
} from './worktree';

const DIGEST = 'a'.repeat(64);
const BASE_SHA = '1'.repeat(40);

function setupDb() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run("INSERT INTO users (username, token_hash, created_ts) VALUES ('owner', 'hash', 1)");
  db.run(`INSERT INTO executors
    (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES ('local', '127.0.0.1', 22, 'owner', 'key', '/srv', '/claude')`);
  db.run(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
    VALUES ('project', 1, '/srv/repo', 1, 1)`);
  db.run(`INSERT INTO design_tasks
    (project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
    VALUES (1, 'Plan', 'Build it', 'codex', 'approved', 1, 1, 1)`);
  db.run(`INSERT INTO design_revisions
    (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
    VALUES (1, 1, '{}', '# Plan', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
  return db;
}

interface FakeWorktree {
  path: string;
  branch: string;
  head: string;
  locked?: boolean;
  prunable?: boolean;
}

class FakeDriver implements DesignWorktreeDriver {
  readonly calls: Array<{ cwd: string; args: string[] }> = [];
  readonly mkdirs: string[] = [];
  readonly worktrees = new Map<string, FakeWorktree>();
  baseSha = BASE_SHA;
  dirty = false;
  upstream = 'refs/remotes/origin/codex/design-1-1';
  ahead = 0;
  behind = 0;
  failAfterAdd = false;
  parentSymlink = false;
  repoTop = '/srv/repo';

  async mkdirp(path: string): Promise<void> { this.mkdirs.push(path); }
  async readlink(path: string): Promise<string | null> {
    return this.parentSymlink && path === '/srv/.panda-worktrees' ? '/tmp/escape' : null;
  }
  async statPath(path: string) {
    if (path === this.repoTop || path === '/srv' || path === '/srv/.panda-worktrees') {
      return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 };
    }
    return null;
  }

  async git(cwd: string, args: string[]) {
    this.calls.push({ cwd, args: [...args] });
    const key = args.join('\0');
    if (key === 'rev-parse\0--show-toplevel') return { code: 0, out: `${this.repoTop}\n`, err: '' };
    if (key === 'rev-parse\0--show-prefix') {
      return { code: 0, out: cwd === this.repoTop ? '' : 'nested/\n', err: '' };
    }
    if (args[0] === 'check-ref-format') return { code: 0, out: '', err: '' };
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet') {
      return { code: 0, out: `${this.baseSha}\n`, err: '' };
    }
    if (key === 'worktree\0list\0--porcelain') {
      const blocks = [
        `worktree /srv/repo\nHEAD ${'0'.repeat(40)}\nbranch refs/heads/main\n`,
        ...[...this.worktrees.values()].map((worktree) =>
          `worktree ${worktree.path}\nHEAD ${worktree.head}\nbranch refs/heads/${worktree.branch}\n${worktree.locked ? 'locked\n' : ''}${worktree.prunable ? 'prunable\n' : ''}`),
      ];
      return { code: 0, out: `${blocks.join('\n')}\n`, err: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      const branch = args[4]!;
      const path = args[5]!;
      const head = args[6]!;
      this.worktrees.set(path, { path, branch, head });
      if (this.failAfterAdd) throw new Error('simulated process interruption');
      return { code: 0, out: '', err: '' };
    }
    if (key === 'status\0--porcelain=v1\0--untracked-files=normal') {
      return { code: 0, out: this.dirty ? '?? local.txt\n' : '', err: '' };
    }
    if (key === 'rev-parse\0--abbrev-ref\0--symbolic-full-name\0@{upstream}') {
      return this.upstream
        ? { code: 0, out: `${this.upstream}\n`, err: '' }
        : { code: 128, out: '', err: 'no upstream' };
    }
    if (key === 'rev-list\0--count\0@{upstream}..HEAD') {
      return { code: 0, out: `${this.ahead}\n`, err: '' };
    }
    if (key === 'rev-list\0--count\0HEAD..@{upstream}') {
      return { code: 0, out: `${this.behind}\n`, err: '' };
    }
    if (key === 'symbolic-ref\0--quiet\0--short\0HEAD') {
      return { code: 0, out: `${this.worktrees.get(cwd)?.branch ?? 'main'}\n`, err: '' };
    }
    if (key === 'rev-parse\0--verify\0HEAD') {
      return { code: 0, out: `${this.worktrees.get(cwd)?.head ?? BASE_SHA}\n`, err: '' };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      this.worktrees.delete(args[2]!);
      return { code: 0, out: '', err: '' };
    }
    return { code: 1, out: '', err: `unexpected git argv: ${args.join(' ')}` };
  }
}

function setupService(options: {
  driver?: FakeDriver;
  owner?: boolean;
  busy?: boolean;
  checkpoint?: (point: string) => void | Promise<void>;
} = {}) {
  const db = setupDb();
  const store = new DesignWorktreeStore(db);
  const driver = options.driver ?? new FakeDriver();
  const project: DesignWorktreeProject = { id: 1, cwd: '/srv/repo' };
  const approved: DesignWorktreeApprovedDesign = {
    projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST,
  };
  const publication: DesignWorktreePublication = {
    id: 1, projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST, status: 'complete',
  };
  let nextId = 0;
  const service = new DesignWorktreeService({
    store,
    mutex: new KeyedMutex(),
    projectLookup: (id) => id === 1 ? project : null,
    approvedDesignLookup: (_projectId, designId, revision, digest) =>
      designId === 1 && revision === 1 && digest === DIGEST ? approved : null,
    publicationLookup: (id) => id === 1 ? publication : null,
    authorizeOwner: () => options.owner ?? true,
    driverForProject: () => driver,
    publicationHasBusyIssues: () => options.busy ?? false,
    checkpoint: options.checkpoint,
    idFactory: () => `run-${++nextId}`,
    now: () => 10,
  });
  return { db, store, driver, service };
}

function setupRestartedService(db: ReturnType<typeof setupDb>, driver: FakeDriver) {
  return new DesignWorktreeService({
    store: new DesignWorktreeStore(db), mutex: new KeyedMutex(),
    projectLookup: () => ({ id: 1, cwd: '/srv/repo' }),
    approvedDesignLookup: () => ({ projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST }),
    publicationLookup: (id) => id === 1
      ? { id: 1, projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST, status: 'complete' }
      : null,
    authorizeOwner: () => true, driverForProject: () => driver,
    publicationHasBusyIssues: () => false, idFactory: () => 'restart-id', now: () => 30,
  });
}

const actor = { userId: 1, actorKey: 'user:1' };
const worktreeInput = {
  projectId: 1,
  designId: 1,
  revision: 1,
  graphDigest: DIGEST,
  idempotencyKey: 'worktree-1',
  executionMode: 'worktree' as const,
  baseRef: 'refs/heads/main',
};

function bindPublication(db: ReturnType<typeof setupDb>, store: DesignWorktreeStore): void {
  db.transaction(() => {
    db.query(`INSERT INTO design_publications
      (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
       status, created_ts, updated_ts)
      VALUES (1, 1, 1, ?, 'user:1', 'publish-1', 'complete', 1, 1)`).run(DIGEST);
    store.bindPublicationInTransaction({
      projectId: 1, designId: 1, publicationId: 1, revision: 1, graphDigest: DIGEST, updatedTs: 2,
    });
  })();
}

describe('DesignWorktreeService', () => {
  test('defaults to current mode without invoking Git', async () => {
    const { db, driver, service } = setupService();
    const run = await service.create({
      projectId: 1, designId: 1, revision: 1,
      graphDigest: DIGEST, idempotencyKey: 'current-1',
    }, actor);
    expect(run).toMatchObject({ publicationId: null, executionMode: 'current', lifecycleState: 'ready', baseRef: null, baseSha: null });
    expect(driver.calls).toEqual([]);
    db.close();
  });

  test('persists the immutable publication tuple before one fixed-argv worktree add', async () => {
    const { db, store, driver, service } = setupService();
    const run = await service.create(worktreeInput, actor);
    expect(run).toMatchObject({
      id: 'run-1', publicationId: null, revision: 1, graphDigest: DIGEST,
      baseRef: 'refs/heads/main', baseSha: BASE_SHA,
      worktreeBranch: 'codex/design-1-1',
      worktreeCwd: '/srv/.panda-worktrees/design-1-1',
      lifecycleState: 'ready', assignmentActive: false,
    });
    expect(store.getByBatch(1, 1, DIGEST)?.baseSha).toBe(BASE_SHA);
    expect(driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toEqual([{
      cwd: '/srv/repo',
      args: ['worktree', 'add', '--no-track', '-b', 'codex/design-1-1', '/srv/.panda-worktrees/design-1-1', BASE_SHA],
    }]);
    expect(driver.mkdirs).toEqual(['/srv/.panda-worktrees']);
    db.close();
  });

  test('reuses an exact ready run without resolving a moved base ref or adding again', async () => {
    const { db, driver, service } = setupService();
    const first = await service.create(worktreeInput, actor);
    driver.baseSha = '2'.repeat(40);
    const second = await service.create(worktreeInput, actor);
    expect(second).toEqual(first);
    expect(driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toHaveLength(1);
    expect(second.baseSha).toBe(BASE_SHA);
    db.close();
  });

  test('rejects non-owner access, publication mismatches, and caller-controlled ref tricks before add', async () => {
    const unauthorized = setupService({ owner: false });
    await expect(unauthorized.service.create(worktreeInput, actor)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    unauthorized.db.close();

    const scoped = setupService();
    await expect(scoped.service.create({ ...worktreeInput, revision: 2 }, actor)).rejects.toMatchObject({ code: 'PUBLICATION_MISMATCH' });
    await expect(scoped.service.create({ ...worktreeInput, baseRef: 'main; rm -rf /' }, actor)).rejects.toMatchObject({ code: 'BASE_INVALID' });
    expect(scoped.driver.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false);
    scoped.db.close();
  });

  test('executes and archives only the exact ready publication while preserving one worktree', async () => {
    const { db, driver, service } = setupService();
    await service.create(worktreeInput, actor);
    bindPublication(db, new DesignWorktreeStore(db));
    const executing = await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    expect(executing).toMatchObject({ lifecycleState: 'executing', assignmentActive: true });
    expect(await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor)).toEqual(executing);
    const archived = await service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    expect(archived).toMatchObject({ lifecycleState: 'archived', assignmentActive: false });
    expect(driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toHaveLength(1);
    db.close();
  });

  test('cleans only an archived exact clean pushed worktree and never uses force or removeTree', async () => {
    const { db, driver, service } = setupService();
    await service.create(worktreeInput, actor);
    bindPublication(db, new DesignWorktreeStore(db));
    await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    await service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    driver.behind = 2;
    const cleaned = await service.clean({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    expect(cleaned).toMatchObject({
      lifecycleState: 'cleaned',
      observedHeadSha: BASE_SHA,
      observedUpstream: 'refs/remotes/origin/codex/design-1-1',
      observedAhead: 0,
      observedBehind: 2,
    });
    expect(driver.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'remove')?.args)
      .toEqual(['worktree', 'remove', '/srv/.panda-worktrees/design-1-1']);
    expect(driver.calls.flatMap((call) => call.args)).not.toContain('--force');
    db.close();
  });

  test('retains a dirty archived worktree as cleanup_blocked', async () => {
    const { db, driver, service } = setupService();
    await service.create(worktreeInput, actor);
    bindPublication(db, new DesignWorktreeStore(db));
    await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    await service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    driver.dirty = true;
    await expect(service.clean({ projectId: 1, designId: 1, publicationId: 1 }, actor))
      .rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(service.getRun(1, 1)?.lifecycleState).toBe('cleanup_blocked');
    expect(driver.worktrees.size).toBe(1);
    db.close();
  });

  test('preserves archived worktrees with no upstream or local commits ahead', async () => {
    for (const configure of [
      (driver: FakeDriver) => { driver.upstream = ''; },
      (driver: FakeDriver) => { driver.ahead = 1; },
    ]) {
      const { db, driver, service } = setupService();
      await service.create(worktreeInput, actor);
      bindPublication(db, new DesignWorktreeStore(db));
      await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
      await service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
      configure(driver);
      await expect(service.clean({ projectId: 1, designId: 1, publicationId: 1 }, actor))
        .rejects.toBeInstanceOf(DesignWorktreeError);
      expect(driver.worktrees.size).toBe(1);
      expect(service.getRun(1, 1)?.lifecycleState).toBe('cleanup_blocked');
      db.close();
    }
  });

  test('requires a remote-tracking upstream before cleanup', async () => {
    const { db, driver, service } = setupService();
    await service.create(worktreeInput, actor);
    bindPublication(db, new DesignWorktreeStore(db));
    await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    await service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    driver.upstream = 'refs/heads/backup';
    await expect(service.clean({ projectId: 1, designId: 1, publicationId: 1 }, actor))
      .rejects.toMatchObject({ code: 'UPSTREAM_MISSING' });
    expect(driver.worktrees.size).toBe(1);
    db.close();
  });

  test('persists active unhealthy recovery without pretending the assignment is healthy', async () => {
    const { db, driver, service } = setupService();
    await service.create(worktreeInput, actor);
    bindPublication(db, new DesignWorktreeStore(db));
    await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
    driver.worktrees.clear();
    await expect(service.inspect({ projectId: 1, designId: 1, publicationId: 1 }, actor))
      .rejects.toMatchObject({ code: 'WORKTREE_MISSING' });
    expect(service.getRun(1, 1)).toMatchObject({
      lifecycleState: 'executing', assignmentActive: true, errorCode: 'WORKTREE_MISSING',
    });
    await expect(service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor))
      .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await service.recoverAll()).toEqual({ inspected: 1, recovered: 0, failed: 1 });
    expect(service.getRun(1, 1)?.errorCode).toBe('WORKTREE_MISSING');
    db.close();
  });

  test('durably records active locked, prunable, and branch-mismatched assignments', async () => {
    for (const [expected, mutate] of [
      ['WORKTREE_LOCKED', (worktree: FakeWorktree) => { worktree.locked = true; }],
      ['WORKTREE_MISMATCH', (worktree: FakeWorktree) => { worktree.prunable = true; }],
      ['WORKTREE_MISMATCH', (worktree: FakeWorktree) => { worktree.branch = 'wrong-branch'; }],
    ] as const) {
      const { db, driver, service } = setupService();
      await service.create(worktreeInput, actor);
      bindPublication(db, new DesignWorktreeStore(db));
      await service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
      mutate(driver.worktrees.values().next().value!);
      await expect(service.inspect({ projectId: 1, designId: 1, publicationId: 1 }, actor))
        .rejects.toMatchObject({ code: expected });
      expect(service.getRun(1, 1)).toMatchObject({
        lifecycleState: 'executing', assignmentActive: true, errorCode: expected,
      });
      db.close();
    }
  });

  test('continues exact creation retries from every durable pre-ready crash window', async () => {
    for (const point of ['after_reserve', 'after_creating', 'after_mkdir', 'before_add', 'after_add', 'before_ready']) {
      let crashed = false;
      const shared = setupService({
        checkpoint: (seen) => {
          if (!crashed && seen === point) {
            crashed = true;
            throw new Error(`crash:${point}`);
          }
        },
      });
      await expect(shared.service.create({ ...worktreeInput, idempotencyKey: `crash-${point}` }, actor))
        .rejects.toThrow(`crash:${point}`);
      const restarted = new DesignWorktreeService({
        store: new DesignWorktreeStore(shared.db), mutex: new KeyedMutex(),
        projectLookup: () => ({ id: 1, cwd: '/srv/repo' }),
        approvedDesignLookup: () => ({ projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST }),
        publicationLookup: () => null, authorizeOwner: () => true,
        driverForProject: () => shared.driver, publicationHasBusyIssues: () => false,
        idFactory: () => 'must-not-reserve-again', now: () => 20,
      });
      expect(await restarted.recoverAll()).toEqual({ inspected: 1, recovered: 1, failed: 0 });
      expect(await restarted.create({ ...worktreeInput, idempotencyKey: `crash-${point}` }, actor))
        .toMatchObject({ lifecycleState: 'ready', errorCode: null });
      expect(shared.driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add'))
        .toHaveLength(1);
      shared.db.close();
    }
  });

  test('normalizes worktree reserve races across independent mutexes', async () => {
    for (const winnerKey of ['worktree-race', 'different-key']) {
      const { db, store, driver, service } = setupService();
      const reserve = store.reserve.bind(store);
      let inject = true;
      store.reserve = ((input) => {
        if (inject) {
          inject = false;
          reserve({ ...input, id: 'race-winner', idempotencyKey: winnerKey });
        }
        return reserve(input);
      }) as typeof store.reserve;
      const result = service.create({ ...worktreeInput, idempotencyKey: 'worktree-race' }, actor);
      if (winnerKey === 'worktree-race') {
        await expect(result).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
        expect(store.getByBatch(1, 1, DIGEST)).toMatchObject({ id: 'race-winner', lifecycleState: 'intent' });
      } else {
        await expect(result).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
      }
      expect(driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add'))
        .toHaveLength(0);
      db.close();
    }
  });

  test('recovers cleanup crashes after durable intent and after Git removal', async () => {
    for (const point of ['after_cleanup_intent', 'after_remove', 'before_cleanup_finalize']) {
      let crashed = false;
      const shared = setupService({ checkpoint: (seen) => {
        if (!crashed && seen === point) { crashed = true; throw new Error(`crash:${point}`); }
      } });
      await shared.service.create(worktreeInput, actor);
      bindPublication(shared.db, new DesignWorktreeStore(shared.db));
      await shared.service.execute({ projectId: 1, designId: 1, publicationId: 1 }, actor);
      await shared.service.archive({ projectId: 1, designId: 1, publicationId: 1 }, actor);
      await expect(shared.service.clean({ projectId: 1, designId: 1, publicationId: 1 }, actor))
        .rejects.toThrow(`crash:${point}`);
      expect(shared.service.getRun(1, 1)?.lifecycleState).toBe('cleaning');
      const restarted = setupRestartedService(shared.db, shared.driver);
      expect(await restarted.recoverAll()).toEqual({ inspected: 1, recovered: 1, failed: 0 });
      expect(restarted.getRun(1, 1)?.lifecycleState).toBe('cleaned');
      expect(shared.driver.worktrees.size).toBe(0);
      shared.db.close();
    }
  });

  test('recovers a creating row only when the persisted path branch and SHA match', async () => {
    const { db, store, driver, service } = setupService();
    driver.failAfterAdd = true;
    await expect(service.create({ ...worktreeInput, idempotencyKey: 'crash-1' }, actor)).rejects.toThrow('simulated process interruption');
    expect(store.getByBatch(1, 1, DIGEST)?.lifecycleState).toBe('creating');
    driver.failAfterAdd = false;
    expect(await service.recoverAll()).toEqual({ inspected: 1, recovered: 1, failed: 0 });
    expect(service.getRun(1, 1)?.lifecycleState).toBe('ready');
    expect(driver.calls.filter((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toHaveLength(1);
    db.close();
  });

  test('recovery scans only resumable or assignment-active rows and applies a stable limit', () => {
    const db = setupDb();
    const store = new DesignWorktreeStore(db);
    const states = [
      ['intent', false], ['creating', false], ['executing', true], ['cleaning', false], ['recoverable_error', true],
      ['ready', false], ['archived', false], ['cleanup_blocked', false], ['cleaned', false], ['recoverable_error', false],
    ] as const;
    for (let index = 0; index < states.length; index++) {
      const [lifecycleState, assignmentActive] = states[index]!;
      if (index > 0) {
        db.query(`INSERT INTO design_tasks
          (project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
          VALUES (1, ?, 'recover', 'codex', 'approved', ?, ?, ?)`)
          .run(`Recovery ${index}`, index + 1, index + 1, index + 1);
        db.query(`INSERT INTO design_revisions
          (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
          VALUES (?, ?, '{}', '# Recovery', 90, '{"nodes":[],"edges":[]}', 'owner', ?)`)
          .run(index + 1, index + 1, index + 1);
      }
      store.reserve({
        id: `filter-${index}`, projectId: 1, designId: index + 1, publicationId: null, revision: index + 1,
        graphDigest: String(index + 1).padStart(64, '0'), idempotencyKey: `filter-${index}`,
        executionMode: 'worktree', lifecycleState, assignmentActive,
        baseRef: 'refs/heads/main', baseSha: BASE_SHA, worktreeBranch: `codex/filter-${index}`,
        worktreeCwd: `/srv/.panda-worktrees/filter-${index}`, createdTs: index + 1, updatedTs: index + 1,
      });
    }
    for (let offset = 0; offset < 30; offset++) {
      const designId = states.length + offset + 1;
      db.query(`INSERT INTO design_tasks
        (project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
        VALUES (1, ?, 'cleaned history', 'codex', 'approved', 1, ?, ?)`)
        .run(`Cleaned ${offset}`, designId, designId);
      db.query(`INSERT INTO design_revisions
        (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
        VALUES (?, 1, '{}', '# Cleaned', 90, '{"nodes":[],"edges":[]}', 'owner', ?)`)
        .run(designId, designId);
      store.reserve({
        id: `cleaned-${offset}`, projectId: 1, designId, publicationId: null, revision: 1,
        graphDigest: String(designId).padStart(64, '0'), idempotencyKey: `cleaned-${offset}`,
        executionMode: 'worktree', lifecycleState: 'cleaned', assignmentActive: false,
        baseRef: 'refs/heads/main', baseSha: BASE_SHA, worktreeBranch: `codex/cleaned-${offset}`,
        worktreeCwd: `/srv/.panda-worktrees/cleaned-${offset}`, createdTs: designId, updatedTs: designId,
      });
    }
    expect(store.listRecoverable(3).map((run) => run.lifecycleState)).toEqual(['intent', 'creating', 'executing']);
    expect(store.listRecoverable(20).map((run) => run.lifecycleState))
      .toEqual(['intent', 'creating', 'executing', 'cleaning', 'recoverable_error']);
    db.close();
  });

  test('recovery deadline returns while hung Git stays detached and cannot mutate after abort', async () => {
    let crash = true;
    const shared = setupService({ checkpoint: (point) => {
      if (point === 'after_add' && crash) throw new Error('crash after add');
    } });
    await expect(shared.service.create(worktreeInput, actor)).rejects.toThrow('crash after add');
    crash = false;
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const originalGit = shared.driver.git.bind(shared.driver);
    shared.driver.git = async (cwd, args) => {
      if (args.join(' ') === 'worktree list --porcelain') {
        entered();
        await held;
      }
      return originalGit(cwd, args);
    };
    const restarted = setupRestartedService(shared.db, shared.driver);
    const recovery = restarted.recoverAll({ limit: 10, overallTimeoutMs: 10 });
    await didEnter;
    const bounded = await Promise.race([recovery.then(() => true), Bun.sleep(50).then(() => false)]);
    expect(bounded).toBe(true);
    expect(restarted.getRun(1, 1)).toMatchObject({ lifecycleState: 'creating', errorCode: null });
    release();
    await recovery;
    await Bun.sleep(5);
    expect(restarted.getRun(1, 1)).toMatchObject({ lifecycleState: 'creating', errorCode: null });
    shared.db.close();
  });

  test('serializes same-project Git lifecycles through the injected mutex', async () => {
    const mutex = new KeyedMutex();
    const { db, driver, store } = setupService();
    const project: DesignWorktreeProject = { id: 1, cwd: '/srv/repo' };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const service = new DesignWorktreeService({
      store, mutex, projectLookup: () => project,
      approvedDesignLookup: () => ({ projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST }),
      publicationLookup: () => ({ id: 1, projectId: 1, designId: 1, revision: 1, graphDigest: DIGEST, status: 'complete' }),
      authorizeOwner: () => true, driverForProject: () => driver,
      publicationHasBusyIssues: () => false, idFactory: () => 'run-locked', now: () => 1,
    });
    const held = mutex.runExclusive('git:1', async () => { entered = true; await gate; });
    while (!entered) await Promise.resolve();
    const creating = service.create(worktreeInput, actor);
    await Promise.resolve();
    expect(driver.calls).toEqual([]);
    release();
    await held;
    await creating;
    expect(driver.calls.length).toBeGreaterThan(0);
    db.close();
  });

  test('binds only an exact ready intent inside the publisher transaction', async () => {
    const { db, store, service } = setupService();
    await service.create(worktreeInput, actor);
    expect(() => store.requirePublishableIntentInTransaction(1, 1, DIGEST)).toThrow();
    expect(() => store.bindPublicationInTransaction({
      projectId: 1, designId: 1, publicationId: 1, revision: 1, graphDigest: DIGEST, updatedTs: 2,
    })).toThrow();

    db.transaction(() => {
      const intent = store.requirePublishableIntentInTransaction(1, 1, DIGEST);
      expect(intent).toMatchObject({ publicationId: null, lifecycleState: 'ready' });
      db.query(`INSERT INTO design_publications
        (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
         status, created_ts, updated_ts)
        VALUES (1, 1, 1, ?, 'user:1', 'publish-1', 'post_commit_pending', 1, 1)`).run(DIGEST);
      expect(store.bindPublicationInTransaction({
        projectId: 1, designId: 1, publicationId: 1, revision: 1, graphDigest: DIGEST, updatedTs: 2,
      }).publicationId).toBe(1);
    })();
    expect(store.getByPublication(1)?.publicationId).toBe(1);
    db.close();
  });

  test('locks the current/worktree decision for one immutable design tuple', async () => {
    const { db, service } = setupService();
    await service.create({
      projectId: 1, designId: 1, revision: 1,
      graphDigest: DIGEST, idempotencyKey: 'decision-1',
    }, actor);
    await expect(service.create({ ...worktreeInput, idempotencyKey: 'decision-2' }, actor))
      .rejects.toMatchObject({ code: 'RUN_CONFLICT' });
    db.close();
  });

  test('does not adopt or reset a colliding registered branch or path', async () => {
    const driver = new FakeDriver();
    driver.worktrees.set('/srv/other', {
      path: '/srv/other', branch: 'codex/design-1-1', head: '2'.repeat(40),
    });
    const { db, service } = setupService({ driver });
    await expect(service.create(worktreeInput, actor)).rejects.toMatchObject({ code: 'WORKTREE_COLLISION' });
    expect(driver.worktrees.get('/srv/other')?.head).toBe('2'.repeat(40));
    expect(driver.calls.some((call) => call.args.includes('reset') || call.args.includes('--force'))).toBe(false);
    db.close();
  });

  test('accepts a full remote ref and a full 64-hex object id', async () => {
    const driver = new FakeDriver();
    driver.baseSha = 'b'.repeat(64);
    const { db, service } = setupService({ driver });
    const run = await service.create({ ...worktreeInput, baseRef: 'refs/remotes/origin/main' }, actor);
    expect(run).toMatchObject({ baseRef: 'refs/remotes/origin/main', baseSha: 'b'.repeat(64) });
    expect(driver.calls.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add')?.args.at(-1))
      .toBe('b'.repeat(64));
    db.close();
  });

  test('fails closed when the repository root or managed parent is unsafe', async () => {
    const nestedDriver = new FakeDriver();
    nestedDriver.repoTop = '/srv';
    const nested = setupService({ driver: nestedDriver });
    await expect(nested.service.create(worktreeInput, actor)).rejects.toMatchObject({ code: 'REPOSITORY_INVALID' });
    nested.db.close();

    const linkedDriver = new FakeDriver();
    linkedDriver.parentSymlink = true;
    const linked = setupService({ driver: linkedDriver });
    await expect(linked.service.create(worktreeInput, actor)).rejects.toMatchObject({ code: 'WORKTREE_COLLISION' });
    expect(linked.driver.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(false);
    linked.db.close();
  });

  test('parses normal, detached, and locked porcelain and rejects truncated metadata', () => {
    expect(parseWorktreePorcelain(
      `worktree /srv/repo\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/main\n\n`
      + `worktree /srv/detached path\nHEAD ${'2'.repeat(40)}\ndetached\nlocked reason\n`,
    )).toEqual([
      { path: '/srv/repo', head: '1'.repeat(40), branch: 'refs/heads/main', detached: false, locked: false, prunable: false },
      { path: '/srv/detached path', head: '2'.repeat(40), branch: null, detached: true, locked: true, prunable: false },
    ]);
    expect(() => parseWorktreePorcelain('worktree /srv/broken\nbranch refs/heads/main\n'))
      .toThrow(DesignWorktreeError);
  });

  test('enforces one live design worktree and unique live cwd and branch in SQLite', () => {
    const db = setupDb();
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
      VALUES (1, 'Plan 2', 'Build next', 'codex', 'approved', 1, 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (2, 1, '{}', '# Plan 2', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
    const store = new DesignWorktreeStore(db);
    const common = {
      publicationId: null, revision: 1, executionMode: 'worktree' as const,
      lifecycleState: 'ready' as const, assignmentActive: false,
      baseRef: 'refs/heads/main', baseSha: BASE_SHA, createdTs: 1, updatedTs: 1,
    };
    store.reserve({
      ...common, id: 'unique-1', projectId: 1, designId: 1, graphDigest: DIGEST,
      idempotencyKey: 'unique-1', worktreeBranch: 'codex/design-1-1', worktreeCwd: '/srv/wt-1',
    });
    expect(() => store.reserve({
      ...common, id: 'same-design', projectId: 1, designId: 1, graphDigest: 'b'.repeat(64),
      idempotencyKey: 'same-design', worktreeBranch: 'codex/other', worktreeCwd: '/srv/wt-other',
    })).toThrow();
    expect(() => store.reserve({
      ...common, id: 'same-cwd', projectId: 1, designId: 2, graphDigest: 'c'.repeat(64),
      idempotencyKey: 'same-cwd', worktreeBranch: 'codex/design-1-2', worktreeCwd: '/srv/wt-1',
    })).toThrow();
    expect(() => store.reserve({
      ...common, id: 'same-branch', projectId: 1, designId: 2, graphDigest: 'c'.repeat(64),
      idempotencyKey: 'same-branch', worktreeBranch: 'codex/design-1-1', worktreeCwd: '/srv/wt-2',
    })).toThrow();
    db.close();
  });

  test('rejects raw cross-design publication binding and noncanonical SHA lengths', () => {
    const db = setupDb();
    db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
      VALUES (1, 'Plan 2', 'Build next', 'codex', 'approved', 1, 1, 1)`);
    db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (2, 1, '{}', '# Plan 2', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
    db.query(`INSERT INTO design_publications
      (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
       status, created_ts, updated_ts)
      VALUES (2, 1, 1, ?, 'user:1', 'publish-2', 'complete', 1, 1)`).run(DIGEST);
    expect(() => db.query(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, publication_id, approved_revision, graph_digest,
       idempotency_key, execution_mode, lifecycle_state, assignment_active, created_ts, updated_ts)
      VALUES ('cross-scope', 1, 1, 1, 1, ?, 'cross-scope', 'current', 'ready', 0, 1, 1)`).run(DIGEST)).toThrow();

    db.query(`INSERT INTO design_publications
      (design_task_id, project_id, revision, graph_digest, actor_key, idempotency_key,
       status, created_ts, updated_ts)
      VALUES (1, 1, 1, ?, 'user:1', 'publish-1', 'complete', 1, 1)`).run(DIGEST);
    for (const [id, revision, digest] of [
      ['wrong-revision', 2, DIGEST],
      ['wrong-digest', 1, 'b'.repeat(64)],
      ['wrong-both', 2, 'b'.repeat(64)],
    ] as const) {
      if (revision === 2) {
        db.run(`INSERT OR IGNORE INTO design_revisions
          (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
          VALUES (1, 2, '{}', '# Plan v2', 90, '{"nodes":[],"edges":[]}', 'owner', 2)`);
      }
      expect(() => db.query(`INSERT INTO design_execution_runs
        (id, project_id, design_task_id, publication_id, approved_revision, graph_digest,
         idempotency_key, execution_mode, lifecycle_state, assignment_active, created_ts, updated_ts)
        VALUES (?, 1, 1, 2, ?, ?, ?, 'current', 'ready', 0, 1, 1)`)
        .run(id, revision, digest, id)).toThrow();
    }
    expect(() => new DesignWorktreeStore(db).reserve({
      id: 'bad-sha', projectId: 1, designId: 1, publicationId: null,
      revision: 1, graphDigest: DIGEST, idempotencyKey: 'bad-sha',
      executionMode: 'worktree', lifecycleState: 'ready', assignmentActive: false,
      baseRef: 'refs/heads/main', baseSha: '1'.repeat(41),
      worktreeBranch: 'codex/design-1-1', worktreeCwd: '/srv/wt-bad',
      createdTs: 1, updatedTs: 1,
    })).toThrow();
    db.close();
  });

  test('normalizes a current-mode unique race into exact replay or stable conflict', async () => {
    for (const winnerKey of ['current-race', 'different-key']) {
      const { db, store, service } = setupService();
      const reserve = store.reserve.bind(store);
      let injectRace = true;
      store.reserve = ((input) => {
        if (injectRace) {
          injectRace = false;
          reserve({ ...input, id: 'race-winner', idempotencyKey: winnerKey });
        }
        return reserve(input);
      }) as typeof store.reserve;
      const operation = service.create({
        projectId: 1, designId: 1, revision: 1,
        graphDigest: DIGEST, idempotencyKey: 'current-race',
      }, actor);
      if (winnerKey === 'current-race') {
        expect(await operation).toMatchObject({ id: 'race-winner', executionMode: 'current' });
      } else {
        await expect(operation).rejects.toMatchObject({ code: 'RUN_CONFLICT' });
      }
      db.close();
    }
  });
});

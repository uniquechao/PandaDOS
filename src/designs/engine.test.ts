import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import {
  DesignEngine,
  DesignEngineError,
  type Actor,
  type DesignConversationOps,
  type DesignEngineErrorCode,
  type DesignScopeOps,
  type ReviewRequest,
  type StewardRevisionInput,
} from './engine';
import type { ReadinessDimension, ReadinessInput } from './readiness';
import { DesignStageConflictError, DesignStore, migrateDesigns } from './store';
import type { DesignGraphNodeDraft } from './types';

const dimensions: ReadinessDimension[] = [
  'goal_clarity',
  'scope_boundaries',
  'solution_completeness',
  'dependencies_constraints',
  'acceptance_testability',
  'risks_unknowns',
];

const owner: Actor = { id: 'user:1', role: 'owner' };
const steward: Actor = { id: 'builtin:design-steward', role: 'design_steward' };
const reviewer: Actor = { id: 'builtin:architecture-reviewer', role: 'reviewer' };
const goalCoach: Actor = { id: 'builtin:goal-coach', role: 'goal_coach' };

function readiness(score: number): ReadinessInput {
  return {
    dimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, {
      score,
      evidencePaths: [`document.${dimension}`],
      missingItems: score >= 80 ? [] : [dimension],
      nextQuestions: [],
    }])) as ReadinessInput['dimensions'],
  };
}

function publishableNode(
  nodeId: string,
  title: string,
  overrides: Partial<DesignGraphNodeDraft> = {},
): DesignGraphNodeDraft {
  return {
    nodeId,
    title,
    goal: `Deliver ${title}.`,
    background: [`${title} background.`],
    sourceSections: [`${title} source.`],
    scope: [`${title} scope.`],
    nonGoals: [`${title} non-goal.`],
    inputs: [`${title} input.`],
    outputs: [`${title} output.`],
    dependencies: [],
    implementationNotes: [`Implement ${title}.`],
    moduleId: null,
    runtime: 'current',
    agent: null,
    complexity: 'medium',
    complexityRationale: [`${title} requires coordination.`],
    acceptanceCriteria: [`${title} works.`],
    testRecommendations: [`Test ${title}.`],
    evidenceRequirements: [`Attach ${title} evidence.`],
    completionInstructions: [`Report ${title} completion.`],
    implMode: 'direct',
    ...overrides,
  };
}

function setup(ids: string[] = []) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)`);
  db.run(
    `INSERT INTO executors
       (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`,
  );
  db.run(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'first', 1, '/workspace/first', 1, 1),
            (2, 'second', 1, '/workspace/second', 1, 2)`,
  );
  db.run(
    `INSERT INTO project_modules
       (id, project_id, slug, display_name, agent, source, created_by, created_ts)
     VALUES (11, 1, 'backend', 'Backend', 'codex', 'manual', 1, 1),
            (22, 2, 'frontend', 'Frontend', 'claude', 'manual', 1, 1)`,
  );

  const created: Array<{
    conversationId: string;
    sagaToken: string;
    projectId: number;
    designId: number;
    agent: 'claude' | 'codex';
    cwd?: string;
  }> = [];
  const activated: string[] = [];
  const archived: string[] = [];
  const deleted: string[] = [];
  const failures = { create: 0, activate: 0, archive: 0, delete: 0 };
  const hooks: {
    create?: (conversationId: string) => void | Promise<void>;
    activate?: (conversationId: string) => void | Promise<void>;
  } = {};
  let archiveAttempts = 0;
  const conversations: DesignConversationOps = {
    async createDesignConversation(input) {
      if (failures.create-- > 0) throw new Error('create conversation failed');
      const id = input.conversationId;
      await hooks.create?.(id);
      const inserted = db.transaction(() => {
        const row = db.query<{ id: string }, [string, number, string, string]>(
          `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
           VALUES (?, ?, ?, 1, ?, 'chat') ON CONFLICT DO NOTHING RETURNING id`,
        ).get(id, input.projectId, `Design ${input.designId}`, input.agent);
        if (row) db.query(
          `INSERT INTO design_saga_conversation_owners (conversation_id, saga_token, created_ts)
           VALUES (?, ?, 1)`,
        ).run(id, input.sagaToken);
        return row;
      })();
      const owner = db.query<{ token: string }, [string]>(
        `SELECT saga_token AS token FROM design_saga_conversation_owners
         WHERE conversation_id = ?`,
      ).get(id);
      if (inserted) created.push(input);
      return {
        conversationId: id,
        created: inserted !== null && inserted !== undefined,
        ownershipProof: owner?.token === input.sagaToken ? input.sagaToken : null,
      };
    },
    async activateDesignConversation(conversationId) {
      await hooks.activate?.(conversationId);
      if (failures.activate-- > 0) throw new Error('activate conversation failed');
      activated.push(conversationId);
    },
    async archiveDesignConversation(conversationId) {
      archiveAttempts++;
      if (failures.archive-- > 0) throw new Error('archive conversation failed');
      archived.push(conversationId);
      db.query('UPDATE conversations SET archived = 1 WHERE id = ?').run(conversationId);
    },
    async deleteDesignConversation({ conversationId, ownershipProof }) {
      if (failures.delete-- > 0) throw new Error('delete conversation failed');
      const conversation = db.query<{ found: number }, [string]>(
        'SELECT 1 AS found FROM conversations WHERE id = ?',
      ).get(conversationId);
      if (!conversation) return true;
      const row = db.query<{ token: string }, [string]>(
        `SELECT saga_token AS token FROM design_saga_conversation_owners
         WHERE conversation_id = ?`,
      ).get(conversationId);
      if (row?.token !== ownershipProof) return false;
      deleted.push(conversationId);
      db.transaction(() => {
        db.query(
          `DELETE FROM design_saga_conversation_owners
           WHERE conversation_id = ? AND saga_token = ?`,
        ).run(conversationId, ownershipProof);
        db.query('DELETE FROM conversations WHERE id = ?').run(conversationId);
      })();
      return true;
    },
  };
  const scopeState = { projectExists: true, supportsAgent: true };
  const scope = {
    projectExists(projectId) {
      return scopeState.projectExists
        && db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(projectId)!.n === 1;
    },
    getModule(moduleId) {
      return db
        .query<{ projectId: number; agent: string }, [number]>(
          'SELECT project_id AS projectId, agent FROM project_modules WHERE id = ?',
        )
        .get(moduleId) as { projectId: number; agent: 'claude' | 'codex' } | null;
    },
    supportsAgent() {
      return scopeState.supportsAgent;
    },
  } satisfies DesignScopeOps & { supportsAgent(projectId: number, agent: 'claude' | 'codex'): boolean };
  const store = new DesignStore(db);
  const idQueue = ids.slice();
  const idFactory = () => idQueue.shift() ?? crypto.randomUUID();
  const engine = new DesignEngine({ store, scope, conversations, idFactory });
  return {
    db, store, engine, created, activated, archived, deleted, failures, hooks,
    archiveAttempts: () => archiveAttempts, conversations, scope, scopeState, idFactory,
  };
}

async function createDesign(
  engine: DesignEngine,
  moduleId: number | null = null,
  idempotencyKey = 'request-safe-rollout',
) {
  return engine.create(1, {
    moduleId,
    title: 'Safe rollout',
    originalRequest: 'Design a safe rollout.',
    agent: 'codex',
    idempotencyKey,
  }, owner);
}

function persistedRequest(moduleId: number | null = null): string {
  return JSON.stringify({
    input: {
      moduleId,
      title: 'Safe rollout',
      originalRequest: 'Design a safe rollout.',
      agent: 'codex',
      readinessThreshold: 80,
      graphGranularity: 'issue',
    },
    actorKey: 'owner:user:1',
  });
}

async function expectCode(promise: Promise<unknown>, code: DesignEngineErrorCode, currentRevision?: number) {
  try {
    await promise;
    throw new Error('expected design engine error');
  } catch (error) {
    expect(error).toBeInstanceOf(DesignEngineError);
    expect((error as DesignEngineError).code).toBe(code);
    if (currentRevision !== undefined) {
      expect((error as DesignEngineError).currentRevision).toBe(currentRevision);
    }
  }
}

describe('DesignEngine', () => {
  test('creates a revisioned goal-setting design without a module and binds its text conversation ID', async () => {
    const { db, store, engine, created, activated } = setup();

    const task = await createDesign(engine);

    expect(task).toMatchObject({
      projectId: 1,
      moduleId: null,
      agent: 'codex',
      stage: 'goal_setting',
      status: 'active',
      currentRevision: 1,
      graphGranularity: 'balanced',
      conversationId: task.conversationId!,
    });
    expect(store.getRevision(task.id, 1)).toMatchObject({
      revision: 1,
      readiness: 0,
      actor: 'owner:user:1',
    });
    expect(store.listEvents(task.id).map((event) => event.kind)).toEqual(['task_created']);
    expect(created).toEqual([{
      conversationId: task.conversationId!,
      sagaToken: expect.any(String),
      projectId: 1,
      designId: task.id,
      agent: 'codex',
    }]);
    expect(activated).toEqual([task.conversationId!]);
    db.close();
  });

  test('creates against a matching optional module', async () => {
    const { db, engine } = setup();
    const task = await createDesign(engine, 11);
    expect(task.moduleId).toBe(11);
    db.close();
  });

  test('coalesces concurrent calls and replays one completed saga for the same idempotency key', async () => {
    const s = setup();
    const [first, concurrent] = await Promise.all([
      createDesign(s.engine, null, 'same-request'),
      createDesign(s.engine, null, 'same-request'),
    ]);
    const replay = await createDesign(s.engine, null, 'same-request');

    expect(concurrent.id).toBe(first.id);
    expect(replay.id).toBe(first.id);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_creation_sagas').get()!.n).toBe(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
    expect(s.created).toHaveLength(1);
    expect(s.activated).toHaveLength(1);
    s.db.close();
  });

  test('two engine instances concurrently fulfill the same key with one task and conversation', async () => {
    const s = setup();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    s.hooks.create = async () => {
      arrivals++;
      if (arrivals === 2) release();
      await gate;
    };
    const second = new DesignEngine({
      store: s.store,
      scope: s.scope,
      conversations: s.conversations,
      idFactory: s.idFactory,
    });

    const results = await Promise.allSettled([
      createDesign(s.engine, null, 'cross-engine-key'),
      createDesign(second, null, 'cross-engine-key'),
    ]);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const ids = results.map((result) => result.status === 'fulfilled' ? result.value.id : -1);
    expect(new Set(ids).size).toBe(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
    expect(s.store.getCreationSaga(1, 'cross-engine-key')).toMatchObject({ phase: 'completed', error: null });
    s.db.close();
  });

  test('completed replay returns the original archived task before current module checks', async () => {
    const s = setup();
    const task = await createDesign(s.engine, 11, 'historical-key');
    const archived = await s.engine.archive(task.id, owner);
    s.db.query('DELETE FROM project_modules WHERE id = 11').run();
    s.scopeState.supportsAgent = false;

    const replay = await createDesign(s.engine, 11, 'historical-key');
    expect(replay).toMatchObject({ id: archived.id, status: 'archived', stage: 'archived' });
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
    s.db.close();
  });

  test('startup recovery marks stale project, module, agent, and capability scopes without side effects', async () => {
    const cases: Array<{
      name: string;
      moduleId: number | null;
      stale: (s: ReturnType<typeof setup>) => void;
    }> = [
      { name: 'project', moduleId: null, stale: (s) => { s.scopeState.projectExists = false; } },
      { name: 'module missing', moduleId: 11, stale: (s) => { s.db.query('DELETE FROM project_modules WHERE id = 11').run(); } },
      { name: 'module project', moduleId: 11, stale: (s) => { s.db.query('UPDATE project_modules SET project_id = 2 WHERE id = 11').run(); } },
      { name: 'module agent', moduleId: 11, stale: (s) => { s.db.query("UPDATE project_modules SET agent = 'claude' WHERE id = 11").run(); } },
      { name: 'capability', moduleId: null, stale: (s) => { s.scopeState.supportsAgent = false; } },
    ];
    for (const item of cases) {
      const s = setup();
      s.store.ensureCreationSaga({
        sagaToken: `stale-${item.name}`,
        projectId: 1,
        idempotencyKey: `stale-${item.name}`,
        requestJson: persistedRequest(item.moduleId),
        conversationId: `conv-stale-${item.name}`,
      });
      item.stale(s);

      await s.engine.recoverIncompleteCreations();

      expect(s.store.getCreationSaga(1, `stale-${item.name}`)).toMatchObject({
        phase: 'recoverable_error', taskId: null, conversationOwned: false,
      });
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(0);
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(0);
      s.db.close();
    }
  });

  test('recovery honors max saga and per-saga timeout budgets', async () => {
    const s = setup();
    for (const suffix of ['hung', 'later']) {
      s.store.ensureCreationSaga({
        sagaToken: `saga-${suffix}`,
        projectId: 1,
        idempotencyKey: `request-${suffix}`,
        requestJson: persistedRequest(),
        conversationId: `conv-${suffix}`,
      });
    }
    s.hooks.create = async (conversationId) => {
      if (conversationId === 'conv-hung') await new Promise<void>(() => {});
    };

    const outcome = await Promise.race([
      s.engine.recoverIncompleteCreations({ maxSagas: 1, attemptBudget: 1, perSagaTimeoutMs: 10 })
        .then(() => 'returned'),
      Bun.sleep(100).then(() => 'hung'),
    ]);

    expect(outcome).toBe('returned');
    expect(s.store.getCreationSagaByToken('saga-later')).toMatchObject({ phase: 'intent', taskId: null });
    s.db.close();
  });

  test('aborting startup recovery returns promptly and a late activation cannot touch durable state', async () => {
    const s = setup();
    s.store.ensureCreationSaga({
      sagaToken: 'saga-abort', projectId: 1, idempotencyKey: 'request-abort',
      requestJson: persistedRequest(), conversationId: 'conv-abort',
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    s.hooks.activate = () => blocked;
    const abort = new AbortController();
    const recovery = s.engine.recoverIncompleteCreations({
      maxSagas: 1, attemptBudget: 1, perSagaTimeoutMs: 5_000, signal: abort.signal,
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (s.store.getCreationSagaByToken('saga-abort')?.phase === 'activating') break;
      await Bun.sleep(1);
    }
    expect(s.store.getCreationSagaByToken('saga-abort')?.phase).toBe('activating');
    abort.abort('shutdown');
    expect(await Promise.race([
      recovery.then(() => 'returned'),
      Bun.sleep(100).then(() => 'hung'),
    ])).toBe('returned');
    release();
    await Bun.sleep(10);
    expect(s.store.getCreationSagaByToken('saga-abort')).toMatchObject({
      phase: 'activating', taskId: expect.any(Number), conversationOwned: true,
    });
    s.db.close();
  });

  test('compensates transient setup failures with ownership guards and retries the same saga', async () => {
    for (const step of ['create', 'activate'] as const) {
      const s = setup();
      s.failures[step] = 1;

      await expectCode(createDesign(s.engine), 'DESIGN_CONVERSATION_FAILED');
      expect(s.store.listTasks(1)).toEqual([]);
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(0);
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(0);
      expect(s.store.listIncompleteCreationSagas()).toHaveLength(1);

      const retry = await createDesign(s.engine);
      expect(retry).toMatchObject({ status: 'active' });
      expect(s.store.listTasks(1)).toHaveLength(1);
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
      s.db.close();
    }
  });

  test('persists recoverable ownership state when strict conversation cleanup fails, then reconciles on retry', async () => {
    const s = setup();
    s.failures.activate = 1;
    s.failures.delete = 1;

    await expectCode(createDesign(s.engine), 'DESIGN_CONVERSATION_CLEANUP_FAILED');
    expect(s.store.listTasks(1)).toEqual([]);
    expect(s.store.listIncompleteCreationSagas()[0]).toMatchObject({
      taskId: null, phase: 'recoverable_error', conversationOwned: true,
    });
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);

    const retried = await createDesign(s.engine);
    expect(retried).toMatchObject({ stage: 'goal_setting', status: 'active', currentRevision: 1 });
    expect(s.store.listTasks(1)).toHaveLength(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
    expect(s.deleted).toHaveLength(1);
    s.db.close();
  });

  test('resumes persisted crashes after marker, task, conversation, bind, and activation without duplicates', async () => {
    for (const crash of ['marker', 'task', 'conversation', 'bound', 'activated'] as const) {
      const s = setup();
      const sagaToken = `saga-crash-${crash}`;
      const conversationId = `conv-crash-${crash}`;
      const idempotencyKey = `request-crash-${crash}`;
      const requestJson = JSON.stringify({
        input: {
          moduleId: null,
          title: 'Safe rollout',
          originalRequest: 'Design a safe rollout.',
          agent: 'codex',
          readinessThreshold: 80,
          graphGranularity: 'issue',
        },
        actorKey: 'owner:user:1',
      });
      s.store.ensureCreationSaga({
        sagaToken, projectId: 1, idempotencyKey, requestJson, conversationId,
      });
      let taskId: number | null = null;
      if (crash !== 'marker') {
        taskId = s.store.createCreationSagaTask(sagaToken, 'intent', {
          projectId: 1,
          title: 'Safe rollout',
          originalRequest: 'Design a safe rollout.',
          agent: 'codex',
          documentJson: { title: 'Safe rollout', originalRequest: 'Design a safe rollout.' },
          documentMarkdown: '# Safe rollout\n\nDesign a safe rollout.',
          readiness: 0,
          graph: { nodes: [], edges: [] },
          actor: 'owner:user:1',
          readinessThreshold: 80,
          graphGranularity: 'balanced',
        })!.task.id;
      }
      if (crash === 'conversation' || crash === 'bound' || crash === 'activated') {
        await s.conversations.createDesignConversation({
          conversationId, sagaToken, projectId: 1, designId: taskId!, agent: 'codex',
        });
        if (crash !== 'conversation') s.store.markCreationConversationOwned(sagaToken, 'task_created');
      }
      if (crash === 'bound' || crash === 'activated') {
        s.store.bindCreationConversation(sagaToken, 'conversation_created');
      }
      if (crash === 'activated') {
        s.store.markCreationActivating(sagaToken, 'bound');
        await s.conversations.activateDesignConversation(conversationId);
        s.store.markCreationActivated(sagaToken, 'activating');
      }

      const restarted = new DesignEngine({
        store: s.store, scope: s.scope, conversations: s.conversations, idFactory: s.idFactory,
      });
      const task = await createDesign(restarted, null, idempotencyKey);
      expect(task).toMatchObject({ id: taskId ?? expect.any(Number), status: 'active', conversationId });
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
      expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
      expect(s.store.listIncompleteCreationSagas()).toEqual([]);
      s.db.close();
    }
  });

  test('never deletes a pre-existing conversation when the allocated ID collides', async () => {
    const s = setup(['saga-collision', 'conv-collision', 'conv-retry']);
    s.db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES ('conv-collision', 1, 'Existing', 1, 'codex', 'chat')`,
    ).run();

    await expectCode(createDesign(s.engine, null, 'collision-key'), 'DESIGN_CONVERSATION_FAILED');
    expect(s.db.query<{ label: string }, []>(
      "SELECT label FROM conversations WHERE id = 'conv-collision'",
    ).get()).toEqual({ label: 'Existing' });
    expect(s.deleted).toEqual([]);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(0);
    s.db.close();
  });

  test('does not compensate a concurrently modified bootstrap task and marks the saga recoverable', async () => {
    const s = setup();
    s.failures.activate = 1;
    s.hooks.activate = () => {
      const saga = s.store.listIncompleteCreationSagas()[0]!;
      s.db.query('UPDATE design_tasks SET current_revision = 2 WHERE id = ?').run(saga.taskId!);
    };

    await expectCode(createDesign(s.engine), 'DESIGN_CONVERSATION_CLEANUP_FAILED');
    const saga = s.store.listIncompleteCreationSagas()[0]!;
    expect(saga).toMatchObject({ phase: 'recoverable_error', conversationOwned: true });
    expect(s.store.getTask(saga.taskId!)).toMatchObject({ currentRevision: 2, status: 'active' });
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()!.n).toBe(1);
    expect(s.deleted).toEqual([]);
    s.db.close();
  });

  test('allows only the owner to create the initial canonical design', async () => {
    const { db, engine } = setup();

    await expectCode(engine.create(1, {
      title: 'Reviewer-owned draft',
      originalRequest: 'A specialist must not seed the canonical document.',
      agent: 'codex',
    }, reviewer), 'DESIGN_OWNER_REQUIRED');
    expect(db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM design_tasks').get()!.count).toBe(0);
    db.close();
  });

  test('rejects a module from another project and a module-agent mismatch', async () => {
    const { db, engine } = setup();
    await expectCode(engine.create(1, {
      moduleId: 22,
      title: 'Wrong project',
      originalRequest: 'Must not cross projects.',
      agent: 'claude',
    }, owner), 'DESIGN_MODULE_PROJECT_MISMATCH');
    await expectCode(engine.create(1, {
      moduleId: 11,
      title: 'Wrong agent',
      originalRequest: 'Must use the module agent.',
      agent: 'claude',
    }, owner), 'DESIGN_MODULE_AGENT_MISMATCH');
    db.close();
  });

  test('idempotently replays steward/reviewer crash windows without weakening role boundaries', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await expectCode(
      engine.updateBrief(task.id, { expectedRevision: 1, title: 'Reviewer rewrite' }, reviewer),
      'DESIGN_OWNER_REQUIRED',
    );
    await expectCode(
      engine.confirmGoal(task.id, { expectedRevision: 1 }, reviewer),
      'DESIGN_OWNER_REQUIRED',
    );
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    const stewardInput: StewardRevisionInput = {
      operationId: 'steward-run-1',
      expectedRevision: 1,
      documentJson: { goal: 'Safe rollout', solution: 'Canary' },
      documentMarkdown: '# Safe rollout\n\nCanary.',
      readiness: readiness(90),
      nextStage: 'review',
      reason: 'solution selected',
    };
    const firstRevision = await engine.applyStewardRevision(task.id, stewardInput, steward);
    // Recovery before ingestion commits the operation exactly once.
    const replayedRevision = await engine.applyStewardRevision(task.id, stewardInput, steward);
    // Recovery after ingestion but before run.json completion replays the durable result.
    expect(replayedRevision).toEqual(firstRevision);
    expect(store.getRevision(task.id, 2)).not.toBeNull();
    expect(store.getRevision(task.id, 3)).toBeNull();
    expect(db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM design_agent_operations WHERE operation_kind = 'steward_revision'",
    ).get()?.n).toBe(1);

    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 2,
      documentJson: { tampered: true },
      documentMarkdown: '# Tampered',
      readiness: readiness(100),
    }, reviewer), 'DESIGN_STEWARD_REQUIRED');
    const reviewInput: ReviewRequest = {
      operationId: 'review-run-1',
      sourceRevision: 2,
      persona: 'architecture-reviewer',
      findings: [{
        dimension: 'architecture',
        severity: 'warning',
        finding: 'Rollback ownership is unclear.',
        evidence: ['document.solution'],
        proposedPatch: { path: '/risks/0', value: 'Assign rollback owner.' },
      }],
    };
    const run = await engine.requestReview(task.id, reviewInput, reviewer);
    const replayedRun = await engine.requestReview(task.id, reviewInput, reviewer);

    expect(run.findings[0]).toMatchObject({ severity: 'warning', proposedPatch: { path: '/risks/0' } });
    expect(replayedRun.eventId).toBe(run.eventId);
    expect(store.getTask(task.id)).toMatchObject({ currentRevision: 2, documentJson: { goal: 'Safe rollout', solution: 'Canary' } });
    expect(store.listEvents(task.id).at(-1)?.kind).toBe('finding_appended');
    expect(store.listEvents(task.id).filter((event) => event.kind === 'finding_appended')).toHaveLength(1);
    expect(db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM design_agent_operations WHERE operation_kind = 'review'",
    ).get()?.n).toBe(1);
    await expectCode(engine.requestReview(task.id, {
      ...reviewInput,
      findings: [{ ...reviewInput.findings[0], finding: 'Different payload.' }],
    }, reviewer), 'DESIGN_IDEMPOTENCY_CONFLICT');
    db.close();
  });

  test('lets only the design steward refine the canonical goal before owner confirmation', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    const revised = await engine.applyStewardRevision(task.id, {
      operationId: 'goal-steward-1',
      expectedRevision: 1,
      documentJson: { goal: 'Prevent failed rollouts from reaching all users.' },
      documentMarkdown: '# Goal\n\nPrevent failed rollouts from reaching all users.',
      readiness: readiness(70),
      nextStage: 'goal_setting',
      reason: 'goal coach clarified the outcome',
    }, steward);
    expect(revised).toMatchObject({ revision: 2, actor: 'design_steward:builtin:design-steward' });
    expect(store.getTask(task.id)).toMatchObject({
      stage: 'goal_setting',
      currentRevision: 2,
      documentJson: { goal: 'Prevent failed rollouts from reaching all users.' },
    });
    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 2,
      documentJson: { goal: 'Owner bypass' },
      documentMarkdown: '# Owner bypass',
      readiness: readiness(80),
      nextStage: 'goal_setting',
    }, owner), 'DESIGN_STEWARD_REQUIRED');
    db.close();
  });

  test('persists goal-coach findings while the design is still in goal setting', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    const run = await engine.requestReview(task.id, {
      operationId: 'goal-coach-findings-1',
      sourceRevision: 1,
      persona: 'builtin:goal-coach',
      findings: [{
        dimension: 'goal_clarity',
        severity: 'blocker',
        finding: 'The success verdict is not yet observable.',
        evidence: ['The original request does not define a pass/fail signal.'],
        proposedPatch: 'Define an observable ready/not-ready verdict.',
      }],
    }, goalCoach);

    expect(run.findings).toHaveLength(1);
    expect(store.getTask(task.id)?.stage).toBe('goal_setting');
    expect(store.listEvents(task.id).at(-1)?.kind).toBe('finding_appended');
    db.close();
  });

  test('persists specialist findings during solution drafting', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    const run = await engine.requestReview(task.id, {
      operationId: 'solution-review-findings-1',
      sourceRevision: 1,
      persona: 'builtin:general-reviewer',
      findings: [{
        dimension: 'solution_completeness',
        severity: 'warning',
        finding: 'The implementation shape needs one concrete command.',
        evidence: ['The solution has no canonical command.'],
        proposedPatch: 'Choose a deterministic local command.',
      }],
    }, reviewer);

    expect(run.findings).toHaveLength(1);
    expect(store.getTask(task.id)?.stage).toBe('solution_draft');
    expect(store.listEvents(task.id).at(-1)?.kind).toBe('finding_appended');
    db.close();
  });

  test('appends owner brief input without changing canonical document metadata or revision', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    const unchanged = await engine.updateBrief(task.id, {
      expectedRevision: 1,
      title: 'Suggested title',
      originalRequest: 'Please also preserve rollback evidence.',
    }, owner);

    expect(unchanged).toMatchObject({
      title: 'Safe rollout',
      originalRequest: 'Design a safe rollout.',
      currentRevision: 1,
    });
    expect(store.getRevision(task.id, 1)?.documentJson).toEqual({
      title: 'Safe rollout',
      originalRequest: 'Design a safe rollout.',
    });
    expect(store.listEvents(task.id).at(-1)).toMatchObject({
      kind: 'input_appended',
      data: {
        actor: owner,
        title: 'Suggested title',
        originalRequest: 'Please also preserve rollback evidence.',
        sourceRevision: 1,
      },
    });
    const confirmed = await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    expect(confirmed).toMatchObject({ stage: 'solution_draft', currentRevision: 1 });
    expect(store.getRevision(task.id, 1)?.documentJson).toEqual({
      title: 'Safe rollout',
      originalRequest: 'Design a safe rollout.',
    });
    db.close();
  });

  test('queues an owner review request without impersonating a specialist or changing the live document', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { goal: 'Safe rollout', solution: 'Canary' },
      documentMarkdown: '# Safe rollout\n\nCanary.',
      readiness: readiness(90),
      nextStage: 'review',
    }, steward);

    const unchanged = await engine.queueReview(task.id, {
      expectedRevision: 2,
      personas: ['architecture-reviewer'],
    }, owner);

    expect(unchanged).toMatchObject({ currentRevision: 2, stage: 'review' });
    expect(store.getRevision(task.id, 2)?.documentJson).toEqual({ goal: 'Safe rollout', solution: 'Canary' });
    expect(store.listEvents(task.id).at(-1)).toMatchObject({
      kind: 'input_appended',
      data: {
        requestKind: 'review',
        sourceRevision: 2,
        actor: owner,
        personas: ['architecture-reviewer'],
      },
    });
    db.close();
  });

  test('records an owner graph proposal without replacing the canonical steward graph', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { goal: 'Safe rollout', solution: 'Canary' },
      documentMarkdown: '# Safe rollout\n\nCanary.',
      readiness: readiness(90),
      nextStage: 'review',
    }, steward);
    const proposal = {
      nodes: [publishableNode('proposal', 'Owner proposal', {
        goal: 'Suggest a graph without publishing it',
        acceptanceCriteria: ['The steward decides whether to apply it'],
        evidenceRequirements: ['design event'],
        implMode: 'direct' as const,
      })],
      edges: [],
    };

    const unchanged = await engine.proposeGraph(task.id, { expectedRevision: 2, graph: proposal }, owner);

    expect(unchanged).toMatchObject({ currentRevision: 2, stage: 'review' });
    expect(store.getGraph(task.id)).toEqual({ nodes: [], edges: [] });
    expect(store.listEvents(task.id).at(-1)).toMatchObject({
      kind: 'input_appended',
      data: { requestKind: 'graph_proposal', sourceRevision: 2, actor: owner, graph: proposal },
    });
    db.close();
  });

  test('returns a stable conflict code with the current revision', async () => {
    const { db, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(90),
    }, steward);
    await expectCode(
      engine.updateBrief(task.id, { expectedRevision: 1, originalRequest: 'Stale input.' }, owner),
      'DESIGN_REVISION_CONFLICT',
      2,
    );
    db.close();
  });

  test('translates a no-revision stage race to a stable engine error', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    store.transitionStage = () => {
      throw new DesignStageConflictError('solution_draft', task.currentRevision);
    };

    await expectCode(
      engine.confirmGoal(task.id, { expectedRevision: task.currentRevision }, owner),
      'DESIGN_INVALID_STAGE_TRANSITION',
      task.currentRevision,
    );
    db.close();
  });

  test('rejects skipped and backward lifecycle transitions', async () => {
    const { db, engine } = setup();
    const task = await createDesign(engine);
    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Too soon' },
      documentMarkdown: '# Too soon',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward), 'DESIGN_INVALID_STAGE_TRANSITION');
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await expectCode(engine.confirmGoal(task.id, { expectedRevision: 1 }, owner), 'DESIGN_INVALID_STAGE_TRANSITION');
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward);
    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 2,
      documentJson: { solution: 'Bypass graph validation' },
      documentMarkdown: '# Bypass',
      readiness: readiness(100),
      nextStage: 'graph_draft',
    }, steward), 'DESIGN_INVALID_STAGE_TRANSITION');
    db.close();
  });

  test('recalculates readiness deterministically and persists the same value with the revision event', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    const mixed = readiness(83);
    mixed.dimensions!.risks_unknowns = { score: 78.6, evidencePaths: ['document.risks'], missingItems: [], nextQuestions: [] };

    const revision = await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: mixed,
    }, steward);

    expect(revision.readiness).toBe(83);
    expect(store.listEvents(task.id).at(-1)?.data).toMatchObject({ readiness: 83, revision: 2 });
    db.close();
  });

  test('successful document commit triggers a bounded sync drain without rolling back on one job failure', async () => {
    const s = setup();
    const drains: number[] = [];
    const engine = new DesignEngine({
      store: s.store,
      scope: s.scope,
      conversations: s.conversations,
      revisionSync: {
        drainRevisionSyncJobs({ limit }: { limit?: number } = {}) {
          drains.push(limit ?? 0);
          throw new Error('isolated sync failure');
        },
      },
      idFactory: s.idFactory,
    });
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);

    const revision = await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(100),
    }, steward);

    expect(revision.revision).toBe(2);
    expect(drains).toEqual([25]);
    expect(s.store.getTask(task.id)?.currentRevision).toBe(2);
    s.db.close();
  });

  test('replaces a valid publishable graph as one revision and preserves its canonical fields', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward);
    const graph = await engine.replaceGraph(task.id, {
      expectedRevision: 2,
      readiness: readiness(100),
      graph: {
        nodes: [publishableNode('ship', 'Ship', {
          goal: 'Release safely.',
          scope: ['backend'],
          nonGoals: ['redesign'],
          dependencies: [],
          acceptanceCriteria: ['Canary passes.'],
          testRecommendations: ['Run integration tests.'],
          evidenceRequirements: ['Test log.'],
          implMode: 'direct',
        })],
        edges: [],
      },
    }, steward);

    expect(graph.nodes[0]).toMatchObject({ nodeId: 'ship', acceptanceCriteria: ['Canary passes.'], implMode: 'direct' });
    expect(store.getTask(task.id)).toMatchObject({ currentRevision: 3, stage: 'graph_draft' });
    expect(store.getRevision(task.id, 3)?.graph.nodes[0]).toMatchObject({ testRecommendations: ['Run integration tests.'] });
    await expectCode(engine.replaceGraph(task.id, {
      expectedRevision: 3,
      readiness: readiness(100),
      graph: {
        ...graph,
        nodes: graph.nodes.map((node) => ({ ...node, title: 'Ship safely' })),
      },
    }, owner), 'DESIGN_STEWARD_REQUIRED');
    db.close();
  });

  test('approves only a revalidated live graph through the explicit owner action', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward);
    await engine.replaceGraph(task.id, {
      expectedRevision: 2,
      readiness: readiness(100),
      graph: {
        nodes: [publishableNode('ship', 'Ship', {
          acceptanceCriteria: ['Canary passes.'],
          evidenceRequirements: ['Test log.'],
          implMode: 'direct',
        })],
        edges: [],
      },
    }, steward);

    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 3,
      documentJson: { solution: 'Cannot self-approve' },
      documentMarkdown: '# Cannot self-approve',
      readiness: readiness(100),
      nextStage: 'approved',
    }, steward), 'DESIGN_INVALID_STAGE_TRANSITION');
    await expectCode(engine.approveGraph(task.id, {
      expectedRevision: 3,
      readiness: readiness(79),
    }, owner), 'DESIGN_NOT_READY');
    const storedDetail = db.query<{ detail_json: string | null }, []>(
      `SELECT detail_json FROM design_graph_nodes WHERE design_task_id = 1 AND node_id = 'ship'`,
    ).get()!.detail_json;
    db.run(`UPDATE design_graph_nodes SET detail_json = NULL WHERE design_task_id = 1 AND node_id = 'ship'`);
    await expectCode(engine.approveGraph(task.id, {
      expectedRevision: 3,
      readiness: readiness(100),
    }, owner), 'DESIGN_INVALID_GRAPH');
    db.query(
      `UPDATE design_graph_nodes SET detail_json = ? WHERE design_task_id = 1 AND node_id = 'ship'`,
    ).run(storedDetail);
    const approved = await engine.approveGraph(task.id, {
      expectedRevision: 3,
      readiness: readiness(100),
    }, owner);
    expect(approved).toMatchObject({ stage: 'approved', currentRevision: 3 });
    expect(store.listEvents(task.id).at(-1)?.kind).toBe('graph_approved');
    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 3,
      documentJson: { solution: 'Cannot revise after approval' },
      documentMarkdown: '# Cannot revise after approval',
      readiness: readiness(100),
    }, steward), 'DESIGN_INVALID_STAGE_TRANSITION', 3);
    await expectCode(engine.applyStewardRevision(task.id, {
      expectedRevision: 3,
      documentJson: { solution: 'Cannot start execution generically' },
      documentMarkdown: '# Cannot start execution generically',
      readiness: readiness(100),
      nextStage: 'executing',
    }, steward), 'DESIGN_INVALID_STAGE_TRANSITION');
    db.close();
  });

  test('starts and completes execution through explicit owner actions without document revisions', async () => {
    const { db, store, engine } = setup();
    const task = await createDesign(engine);
    await engine.confirmGoal(task.id, { expectedRevision: 1 }, owner);
    await engine.applyStewardRevision(task.id, {
      expectedRevision: 1,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward);
    await engine.replaceGraph(task.id, {
      expectedRevision: 2,
      readiness: readiness(100),
      graph: {
        nodes: [publishableNode('ship', 'Ship', {
          acceptanceCriteria: ['Canary passes.'],
          evidenceRequirements: ['Test log.'],
          implMode: 'direct',
        })],
        edges: [],
      },
    }, steward);
    await engine.approveGraph(task.id, {
      expectedRevision: 3,
      readiness: readiness(100),
    }, owner);

    await expectCode(
      engine.startExecution(task.id, { expectedRevision: 3 }, reviewer),
      'DESIGN_OWNER_REQUIRED',
    );
    await expectCode(
      engine.startExecution(task.id, { expectedRevision: 2 }, owner),
      'DESIGN_REVISION_CONFLICT',
      3,
    );
    const executing = await engine.startExecution(task.id, { expectedRevision: 3 }, owner);
    expect(executing).toMatchObject({ stage: 'executing', status: 'active', currentRevision: 3 });
    await expectCode(
      engine.startExecution(task.id, { expectedRevision: 3 }, owner),
      'DESIGN_INVALID_STAGE_TRANSITION',
      3,
    );
    await expectCode(
      engine.completeExecution(task.id, { expectedRevision: 3 }, reviewer),
      'DESIGN_OWNER_REQUIRED',
    );
    const completed = await engine.completeExecution(task.id, { expectedRevision: 3 }, owner);
    expect(completed).toMatchObject({ stage: 'completed', status: 'active', currentRevision: 3 });
    expect(store.getRevision(task.id, 4)).toBeNull();
    expect(store.listEvents(task.id).slice(-3).map((event) => event.kind)).toEqual([
      'graph_approved',
      'execution_started',
      'execution_completed',
    ]);

    await engine.archive(task.id, owner);
    await expectCode(
      engine.completeExecution(task.id, { expectedRevision: 3 }, owner),
      'DESIGN_ARCHIVED',
    );
    db.close();
  });

  test('makes an archived design immutable and archives its conversation', async () => {
    const { db, store, engine, archived } = setup();
    const task = await createDesign(engine);
    const archivedTask = await engine.archive(task.id, owner);
    expect(archivedTask).toMatchObject({ stage: 'archived', status: 'archived' });
    expect(archived).toEqual([task.conversationId!]);

    await expectCode(
      engine.updateBrief(task.id, { expectedRevision: archivedTask.currentRevision, title: 'Cannot edit' }, owner),
      'DESIGN_ARCHIVED',
    );
    expect(store.getTask(task.id)?.title).toBe('Safe rollout');
    db.close();
  });

  test('retries strict conversation cleanup after an archive failure', async () => {
    const s = setup();
    const task = await createDesign(s.engine);
    s.failures.archive = 1;

    await expectCode(s.engine.archive(task.id, owner), 'DESIGN_CONVERSATION_CLEANUP_FAILED');
    expect(s.store.getTask(task.id)).toMatchObject({ stage: 'archived', status: 'archived' });
    expect(s.db.query<{ archived: number }, [string]>(
      'SELECT archived FROM conversations WHERE id = ?',
    ).get(task.conversationId!)?.archived).toBe(0);

    const retried = await s.engine.archive(task.id, owner);
    expect(retried).toMatchObject({ stage: 'archived', status: 'archived' });
    expect(s.archiveAttempts()).toBe(2);
    expect(s.archived).toEqual([task.conversationId!]);
    expect(s.db.query<{ archived: number }, [string]>(
      'SELECT archived FROM conversations WHERE id = ?',
    ).get(task.conversationId!)?.archived).toBe(1);
    s.db.close();
  });
});

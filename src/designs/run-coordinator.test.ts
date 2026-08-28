import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { DesignPersonaRegistry } from './personas';
import { DesignRunCoordinator, DesignRunCoordinatorError } from './run-coordinator';
import type { DesignRunner, RunDesignInput, RunDesignResult } from './runner';
import { DesignStore, migrateDesigns } from './store';
import type { DesignTaskStage } from './types';

class FakeRunner {
  inputs: RunDesignInput[] = [];
  recovered: Array<{ cwd: string; designId: number }> = [];
  block = false;

  async run(input: RunDesignInput, options: { signal?: AbortSignal }): Promise<RunDesignResult> {
    this.inputs.push(input);
    if (this.block) {
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) return resolve();
        options.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false, reason: 'runner-error' };
    }
    return { ok: true, runs: [] };
  }

  async recoverInterrupted(cwd: string, designId: number): Promise<string[]> {
    this.recovered.push({ cwd, designId });
    return [];
  }
}

function setup(stage: DesignTaskStage = 'goal_setting', agent: 'codex' | 'claude' = 'codex') {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)");
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, '/workspace/one', 1, 1),
           (2, 'two', 1, '/workspace/two', 1, 1)`);
  const store = new DesignStore(db);
  const created = store.createRevisionedTask({
    projectId: 1,
    title: 'Durable design run',
    originalRequest: 'Clarify and implement a durable design workbench.',
    agent,
    stage: 'goal_setting',
    documentJson: { goal: 'Durable design collaboration' },
    documentMarkdown: '# Durable design collaboration',
    readiness: 20,
    actor: 'user:1',
    createdTs: 10,
  });
  if (stage !== 'goal_setting') {
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run(stage, created.task.id);
  }
  const runner = new FakeRunner();
  let nextId = 1;
  const coordinator = new DesignRunCoordinator({
    store,
    personas: new DesignPersonaRegistry(db),
    project: (id) => id === 1 ? { id, cwd: '/workspace/one' } : id === 2 ? { id, cwd: '/workspace/two' } : null,
    runnerForProject: () => runner as unknown as DesignRunner,
    idFactory: () => `run-${nextId++}`,
    now: (() => { let now = 100; return () => ++now; })(),
  });
  return { db, store, task: created.task, runner, coordinator };
}

async function code(promise: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    if (typeof promise === 'function') promise();
    else await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DesignRunCoordinatorError);
    return (error as DesignRunCoordinatorError).code;
  }
  throw new Error('expected coordinator error');
}

describe('design run coordinator', () => {
  test('durably records owner input, resolves the bounded goal chain, and replays idempotently', async () => {
    const s = setup();
    const request = {
      expectedRevision: 1,
      mode: 'goal' as const,
      message: 'Help verify the real user outcome.',
      idempotencyKey: 'goal-request-1',
      actorUserId: 1,
    };
    const first = s.coordinator.start(1, s.task.id, request);
    const replay = s.coordinator.start(1, s.task.id, request);
    expect(replay.id).toBe(first.id);
    await s.coordinator.wait(first.id);

    expect(s.coordinator.getScoped(1, s.task.id, first.id)).toMatchObject({
      status: 'completed',
      mode: 'goal',
      personas: ['builtin:goal-coach', 'builtin:design-steward'],
    });
    expect(s.runner.inputs).toHaveLength(1);
    expect(s.runner.inputs[0]).toMatchObject({ agent: 'codex', sourceRevision: 1 });
    expect(s.runner.inputs[0]!.personas.map((persona) => persona.manifest.role))
      .toEqual(['goal_coach', 'design_steward']);
    expect(s.runner.inputs[0]!.contextMarkdown).toContain('Help verify the real user outcome.');
    expect(s.runner.inputs[0]!.contextMarkdown).toContain('Graph granularity: balanced');
    expect(s.coordinator.listScoped(1, s.task.id)).toEqual([
      expect.objectContaining({ id: first.id, status: 'completed' }),
    ]);
    expect(s.store.listEvents(s.task.id).filter((event) => event.kind === 'input_appended')).toHaveLength(1);
    s.db.query("UPDATE design_tasks SET status = 'archived' WHERE id = ?").run(s.task.id);
    expect(s.coordinator.start(1, s.task.id, request).id).toBe(first.id);
    expect(await code(() => s.coordinator.start(2, s.task.id, {
      ...request, idempotencyKey: 'cross-project',
    }))).toBe('DESIGN_RUN_NOT_FOUND');
    expect(s.store.listEvents(s.task.id).filter((event) => event.kind === 'input_appended')).toHaveLength(1);
    expect(await code(() => s.coordinator.start(1, s.task.id, { ...request, message: 'Different' })))
      .toBe('DESIGN_RUN_IDEMPOTENCY_CONFLICT');
    s.db.close();
  });

  test('uses fixed specialist-to-steward chains without broadening persona roles', async () => {
    const s = setup('solution_draft', 'claude');
    const solution = s.coordinator.start(1, s.task.id, {
      expectedRevision: 1, mode: 'solution', idempotencyKey: 'solution-1', actorUserId: 1,
    });
    await s.coordinator.wait(solution.id);
    const review = s.coordinator.start(1, s.task.id, {
      expectedRevision: 1, mode: 'review', idempotencyKey: 'review-1', actorUserId: 1,
    });
    await s.coordinator.wait(review.id);
    expect(s.runner.inputs.map((input) => input.personas.map((persona) => persona.manifest.role))).toEqual([
      ['reviewer', 'design_steward'],
      ['reviewer', 'independent_verifier', 'design_steward'],
    ]);
    expect(await code(() => s.coordinator.start(1, s.task.id, {
      expectedRevision: 1,
      mode: 'solution',
      personas: ['builtin:issue-planner'],
      idempotencyKey: 'invalid-role',
      actorUserId: 1,
    }))).toBe('DESIGN_RUN_INVALID');
    s.db.close();
  });

  test('places the persisted five-level granularity in graph-run canonical context', async () => {
    const s = setup('graph_draft');
    s.db.query("UPDATE design_tasks SET graph_granularity = 'atomic' WHERE id = ?").run(s.task.id);
    const run = s.coordinator.start(1, s.task.id, {
      expectedRevision: 1,
      mode: 'graph',
      idempotencyKey: 'graph-atomic-1',
      actorUserId: 1,
    });
    await s.coordinator.wait(run.id);
    expect(s.runner.inputs[0]!.contextMarkdown).toContain('Graph granularity: atomic');
    s.db.close();
  });

  test('cancels a running job and never discloses it across project scope', async () => {
    const s = setup();
    s.runner.block = true;
    const run = s.coordinator.start(1, s.task.id, {
      expectedRevision: 1, mode: 'goal', idempotencyKey: 'cancel-1', actorUserId: 1,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(await code(() => s.coordinator.getScoped(2, s.task.id, run.id))).toBe('DESIGN_RUN_NOT_FOUND');
    expect(s.coordinator.cancel(1, s.task.id, run.id, 1).cancelRequested).toBe(true);
    await s.coordinator.wait(run.id);
    expect(s.coordinator.getScoped(1, s.task.id, run.id).status).toBe('cancelled');
    s.db.close();
  });

  test('recovers running durable groups and invokes runner scratch recovery before relaunch', async () => {
    const s = setup();
    const ensured = s.store.ensureAgentRunGroup({
      id: 'recovered-run', designTaskId: s.task.id, projectId: 1,
      idempotencyKey: 'recover-1', requestDigest: 'digest', mode: 'goal', sourceRevision: 1,
      message: null, personaKeys: ['builtin:goal-coach', 'builtin:design-steward'],
      createdByUserId: 1, now: 20,
    });
    expect(s.store.claimAgentRunGroup(ensured.group.id, 21)?.status).toBe('running');
    expect(await s.coordinator.recoverStartup()).toBe(1);
    await s.coordinator.wait(ensured.group.id);
    expect(s.runner.recovered).toEqual([{ cwd: '/workspace/one', designId: s.task.id }]);
    expect(s.coordinator.getScoped(1, s.task.id, ensured.group.id).status).toBe('completed');
    s.db.close();
  });
});

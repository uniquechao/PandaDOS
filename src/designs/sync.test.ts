import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { IssueState } from '../core/types';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import {
  IssueEngine,
  migrateIssueEngine,
  type IssueExecutionSyncState,
  type IssuePublicationBatchPort,
} from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import { DesignPublisher } from './publisher';
import { DesignStore, migrateDesigns } from './store';
import type { DesignGraph, DesignGraphNodeDraft, DesignIssueSyncState } from './types';
import {
  DesignSyncCoordinator,
  DesignSyncError,
  threeWayDesignDiff,
  type DesignIssueSyncContract,
} from './sync';

function contract(overrides: Partial<DesignIssueSyncContract> = {}): DesignIssueSyncContract {
  return {
    title: 'Published title',
    body: 'Published body',
    moduleId: 11,
    agent: 'codex',
    implMode: 'direct',
    dependencies: ['foundation'],
    ...overrides,
  };
}

function publishableNode(overrides: Partial<DesignGraphNodeDraft> = {}): DesignGraphNodeDraft {
  return {
    nodeId: 'stable-node',
    title: 'Published title',
    goal: 'Deliver the published behavior.',
    background: ['Existing background.'],
    sourceSections: ['Design section.'],
    scope: ['In scope.'],
    nonGoals: ['Not in scope.'],
    inputs: ['Input.'],
    outputs: ['Output.'],
    dependencies: [],
    implementationNotes: ['Implement safely.'],
    moduleId: null,
    runtime: 'current',
    agent: null,
    complexity: 'medium',
    complexityRationale: ['Requires coordination.'],
    acceptanceCriteria: ['Behavior works.'],
    testRecommendations: ['Run focused tests.'],
    evidenceRequirements: ['Attach test output.'],
    completionInstructions: ['Report completion.'],
    implMode: 'direct',
    ...overrides,
  };
}

async function setupSync(nodes: DesignGraphNodeDraft[] = [publishableNode()]) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)");
  db.run(`INSERT INTO executors
            (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
          VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`);
  db.run(`INSERT INTO projects
            (id, name, executor_id, cwd, owner_user_id, created_ts)
          VALUES (1, 'project', 1, '/workspace/project', 1, 1)`);
  db.run(`INSERT INTO project_modules
            (id, project_id, slug, display_name, agent, source, created_by, created_ts)
          VALUES (11, 1, 'backend', 'Backend', 'codex', 'manual', 1, 1)`);
  const injections: string[] = [];
  const gitCalls: string[][] = [];
  const moduleRecords: number[] = [];
  const moduleState = { failures: 0 };
  let captures = 0;
  const engineDeps = {
    db,
    driver: {
      sendKeys: async (_session: string, text: string) => { injections.push(text); },
      capturePane: async () => { captures++; return ''; },
      git: async (_cwd: string, args: string[]) => {
        gitCalls.push(args);
        const out = args[0] === 'symbolic-ref'
          ? 'main\n'
          : args[0] !== 'rev-parse'
            ? ''
            : args.includes('--abbrev-ref') ? 'main\n' : `${'a'.repeat(40)}\n`;
        return { code: 0, out, err: '' };
      },
    } as never,
    convs: { tmuxName: () => 'sync-session' } as never,
    locator: {} as never,
    pmFor: () => ({}) as never,
    notify: { dispatch: async () => {} },
    modulesFor: () => ({
      async recordIssue(module: { id: number }) {
        if (moduleState.failures-- > 0) throw new Error('module docs unavailable');
        moduleRecords.push(module.id);
      },
    }) as never,
    mutex: new KeyedMutex(),
    config: { resultSummaryTimeoutMs: 0 },
  } as ConstructorParameters<typeof IssueEngine>[0];
  const issueEngine = new IssueEngine(engineDeps);
  const issuePort: IssuePublicationBatchPort = {
    prepareDesignBatch: issueEngine.prepareDesignBatch.bind(issueEngine),
    commitPreparedDesignBatch: issueEngine.commitPreparedDesignBatch.bind(issueEngine),
    async completeDesignBatch() {},
  };
  const store = new DesignStore(db);
  const created = store.createRevisionedTask({
    projectId: 1,
    title: 'Revision-aware design',
    originalRequest: 'Keep the Issue synchronized.',
    agent: 'codex',
    documentJson: {},
    documentMarkdown: '# Revision-aware design',
    readiness: 100,
    graph: { nodes, edges: [] },
    actor: 'owner:user:1',
  });
  db.query("UPDATE design_tasks SET stage = 'graph_draft' WHERE id = ?").run(created.task.id);
  const approved = store.transitionStage({
    designTaskId: created.task.id,
    expectedRevision: created.task.currentRevision,
    action: 'approve_graph',
    actor: 'owner:user:1',
  });
  const publisher = new DesignPublisher({ store, issues: issuePort, tokenFactory: () => 'sync-token' });
  const confirmation = publisher.issuePublishConfirmation(approved.id, approved.currentRevision, {
    id: 'user:1', role: 'owner',
  });
  const publication = await publisher.publishGraph(approved.id, {
    expectedRevision: approved.currentRevision,
    confirmationToken: confirmation.token,
    idempotencyKey: 'sync-publication',
  }, { id: 'user:1', role: 'owner' });
  const issueIds = publication.issues.map((item) => item.issueId);
  const issueId = issueIds[0]!;
  const coordinator = new DesignSyncCoordinator({ store, issues: issueEngine, now: () => 10_000 });
  return {
    db, store, issueEngine, coordinator, designId: approved.id, issueId, issueIds,
    injections, gitCalls, captures: () => captures,
    moduleRecords, moduleState,
    restartIssueEngine: () => new IssueEngine(engineDeps),
  };
}

function addRevision(
  db: Database,
  store: DesignStore,
  designId: number,
  mutate: (graph: DesignGraph) => DesignGraph,
): number {
  const task = store.getTask(designId)!;
  const prior = store.getRevision(designId, task.currentRevision)!;
  const revision = task.currentRevision + 1;
  const graph = mutate(structuredClone(prior.graph));
  db.query(
    `INSERT INTO design_revisions
       (design_task_id, revision, document_json, document_markdown, readiness, graph_json,
        actor, reason, created_ts)
     VALUES (?, ?, '{}', '# revised', 100, ?, 'owner:user:1', 'sync test', ?)`,
  ).run(designId, revision, JSON.stringify(graph), revision);
  db.query(
    `UPDATE design_tasks SET current_revision = ?, document_json = '{}', document_markdown = '# revised'
     WHERE id = ?`,
  ).run(revision, designId);
  return revision;
}

describe('threeWayDesignDiff', () => {
  test('classifies unchanged, local-only, incoming-only, converged and conflicting fields independently', () => {
    const base = contract({
      title: 'Base title',
      body: 'Base body',
      moduleId: 11,
      agent: 'codex',
      implMode: 'direct',
      dependencies: ['a'],
    });
    const local = contract({
      title: 'Base title',
      body: 'Local body',
      moduleId: 22,
      agent: 'claude',
      implMode: 'direct',
      dependencies: ['a'],
    });
    const incoming = contract({
      title: 'Base title',
      body: 'Base body',
      moduleId: 33,
      agent: 'claude',
      implMode: 'team',
      dependencies: ['b'],
    });

    const diff = threeWayDesignDiff(base, local, incoming);

    expect(diff.fields.title!.kind).toBe('unchanged');
    expect(diff.fields.body!.kind).toBe('local_only');
    expect(diff.fields.moduleId!.kind).toBe('conflict');
    expect(diff.fields.agent!.kind).toBe('converged');
    expect(diff.fields.implMode!.kind).toBe('incoming_only');
    expect(diff.fields.dependencies).toEqual({
      kind: 'incoming_only', base: ['a'], local: ['a'], incoming: ['b'],
    });
    expect(diff.hasConflicts).toBe(true);
    expect(diff.autoPatch).toEqual({ implMode: 'team', dependencies: ['b'] });
  });

  test('treats node removal as retirement and never as an Issue deletion patch', () => {
    const diff = threeWayDesignDiff(contract(), contract({ title: 'Manual title' }), null);

    expect(diff.removed).toBe(true);
    expect(diff.autoPatch).toEqual({});
    expect(diff.hasConflicts).toBe(false);
    expect(diff.fields).toEqual({});
  });

  test('compares dependency arrays as deterministic field values', () => {
    const base = contract({ dependencies: ['a', 'b'] });
    const reorderedLocal = contract({ dependencies: ['b', 'a'] });
    const incoming = contract({ dependencies: ['a', 'c'] });

    expect(threeWayDesignDiff(base, reorderedLocal, incoming).fields.dependencies!.kind).toBe('conflict');
    expect(threeWayDesignDiff(base, base, incoming).autoPatch.dependencies).toEqual(['a', 'c']);
  });
});

describe('DesignSyncCoordinator', () => {
  test('document mutation transaction enqueues one durable job for every primary link', async () => {
    const s = await setupSync();
    s.db.query("UPDATE design_tasks SET stage = 'solution_draft' WHERE id = ?").run(s.designId);
    const task = s.store.getTask(s.designId)!;
    const snapshot = s.store.getRevision(s.designId, task.currentRevision)!;

    const result = s.store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: s.designId,
      expectedRevision: task.currentRevision,
      documentJson: snapshot.documentJson,
      documentMarkdown: `${snapshot.documentMarkdown}\n\nChanged`,
      readiness: snapshot.readiness,
      graph: { ...snapshot.graph, nodes: snapshot.graph.nodes.map((node) => ({
        ...node,
        title: `${node.title} changed`,
      })) },
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: {} },
      createdTs: 9_000,
    });

    expect(s.db.query<{
      linkId: number; designId: number; revision: number; state: string; attempts: number;
    }, []>(
      `SELECT link_id AS linkId, design_task_id AS designId, target_revision AS revision,
              state, attempt_count AS attempts
       FROM design_issue_sync_jobs`,
    ).all()).toEqual([{
      linkId: s.store.getPrimaryIssueLink(s.designId, 'stable-node')!.id,
      designId: s.designId,
      revision: result.revision.revision,
      state: 'pending',
      attempts: 0,
    }]);
    expect(s.coordinator.drainRevisionSyncJobs({ limit: 10 })).toEqual({
      examined: 1, completed: 1, retried: 0, stale: 0,
    });
    expect(s.issueEngine.store.get(s.issueId)).toMatchObject({ title: 'Published title changed' });
    expect(s.db.query<{ state: string; attempts: number }, []>(
      'SELECT state, attempt_count AS attempts FROM design_issue_sync_jobs',
    ).get()).toEqual({ state: 'complete', attempts: 1 });
    s.db.close();
  });

  test('durable worker isolates one link failure and completes the remaining link', async () => {
    const s = await setupSync([
      publishableNode(),
      publishableNode({ nodeId: 'stable-node-2', title: 'Published second' }),
    ]);
    s.db.query("UPDATE design_tasks SET stage = 'solution_draft' WHERE id = ?").run(s.designId);
    const task = s.store.getTask(s.designId)!;
    const snapshot = s.store.getRevision(s.designId, task.currentRevision)!;
    s.store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: s.designId,
      expectedRevision: task.currentRevision,
      documentJson: snapshot.documentJson,
      documentMarkdown: `${snapshot.documentMarkdown}\n\nChanged`,
      readiness: snapshot.readiness,
      graph: { ...snapshot.graph, nodes: snapshot.graph.nodes.map((node) => ({
        ...node, title: `${node.title} changed`,
      })) },
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: {} },
      createdTs: 9_000,
    });
    const isolatedIssues = new Proxy(s.issueEngine, {
      get(target, property, receiver) {
        if (property === 'getDesignSyncSnapshot') {
          return (issueId: number) => {
            if (issueId === s.issueIds[0]) throw new Error('first link unavailable');
            return target.getDesignSyncSnapshot(issueId);
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const coordinator = new DesignSyncCoordinator({ store: s.store, issues: isolatedIssues, now: () => 10_000 });

    expect(coordinator.drainRevisionSyncJobs({ limit: 10 })).toEqual({
      examined: 2, completed: 1, retried: 1, stale: 0,
    });
    expect(s.store.listIssueSyncJobs(s.designId).map((job) => ({
      state: job.state, attempts: job.attemptCount, error: job.lastError,
    }))).toEqual([
      { state: 'retry', attempts: 1, error: 'Error: first link unavailable' },
      { state: 'complete', attempts: 1, error: null },
    ]);
    expect(s.issueEngine.store.get(s.issueIds[1]!)).toMatchObject({ title: 'Published second changed' });
    s.db.close();
  });

  test('guardedly auto-syncs an unchanged pending Issue and advances its baseline once', async () => {
    const s = await setupSync();
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Incoming title';
      return graph;
    });

    const [result] = s.coordinator.reconcileRevision(s.designId, revision, 1);

    expect(result).toMatchObject({ state: 'auto_synced', targetRevision: revision, repeated: false });
    expect(s.issueEngine.store.get(s.issueId)!.title).toBe('Incoming title');
    expect(s.store.getPrimaryIssueLink(s.designId, 'stable-node')).toMatchObject({
      lastSyncedRevision: revision,
      syncState: 'auto_synced',
      baselineContract: { revision, title: 'Incoming title' },
    });
    expect(s.coordinator.reconcileRevision(s.designId, revision, 1)[0]).toMatchObject({ repeated: true });
    s.db.close();
  });

  test('preserves a manual pending edit as a field conflict and persists an orthogonal decision', async () => {
    const s = await setupSync();
    s.issueEngine.store.patchMeta(s.issueId, { title: 'Manual local title' });
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Different incoming title';
      return graph;
    });

    const [result] = s.coordinator.reconcileRevision(s.designId, revision, 1);
    const sync = s.issueEngine.getExecutionSync(result!.executionSyncId!);

    expect(result).toMatchObject({ state: 'conflict', repeated: false });
    expect(s.issueEngine.store.get(s.issueId)!.title).toBe('Manual local title');
    expect(sync).toMatchObject({ state: 'boundary_waiting', boundaryKind: 'pending_conflict' });
    expect(JSON.parse(sync!.diffJson).diff.fields.title.kind).toBe('conflict');
    expect(s.coordinator.listSyncs(s.designId)).toEqual([expect.objectContaining({
      linkId: result!.linkId,
      executionSyncId: result!.executionSyncId,
      state: 'conflict',
      decisionState: 'boundary_waiting',
      fields: expect.arrayContaining([{
        field: 'title',
        kind: 'conflict',
        base: 'Published title',
        local: 'Manual local title',
        incoming: 'Different incoming title',
      }]),
      recovery: { pending: false, resolutionRequired: false },
    })]);
    expect(JSON.stringify(s.coordinator.listSyncs(s.designId))).not.toMatch(/diffJson|deferredAction|deliveryToken/);
    await expect(s.coordinator.decideScoped(
      s.designId + 999,
      result!.executionSyncId!,
      revision,
      'ignore',
      1,
    )).rejects.toMatchObject({ code: 'DESIGN_SYNC_NOT_FOUND' });
    s.db.close();
  });

  test('uses the precise state policy and keeps existing plan/merge gates orthogonal', async () => {
    const cases: Array<[IssueState, DesignIssueSyncState, IssueExecutionSyncState]> = [
      ['clarifying', 'confirmation_needed', 'requested'],
      ['planning', 'confirmation_needed', 'requested'],
      ['plan_review', 'confirmation_needed', 'boundary_waiting'],
      ['implementing', 'confirmation_needed', 'requested'],
      ['testing', 'confirmation_needed', 'requested'],
      ['merge_review', 'confirmation_needed', 'boundary_waiting'],
      ['merging', 'supplement_needed', 'boundary_waiting'],
      ['done', 'supplement_needed', 'boundary_waiting'],
      ['blocked', 'confirmation_needed', 'boundary_waiting'],
      ['cancelled', 'cancelled', 'boundary_waiting'],
    ];
    for (const [status, linkState, executionState] of cases) {
      const s = await setupSync();
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(status, s.issueId);
      if (status === 'plan_review') s.issueEngine.store.createGate(s.issueId, 'plan', { existing: true });
      if (status === 'merge_review') s.issueEngine.store.createGate(s.issueId, 'merge_review', { existing: true });
      const revision = addRevision(s.db, s.store, s.designId, (graph) => {
        graph.nodes[0]!.title = `Incoming for ${status}`;
        return graph;
      });
      const [result] = s.coordinator.reconcileRevision(s.designId, revision, 1);
      expect(result!.state, status).toBe(linkState);
      expect(s.issueEngine.getExecutionSync(result!.executionSyncId!)!.state, status).toBe(executionState);
      if (status === 'plan_review' || status === 'merge_review') {
        expect(s.db.query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM gates WHERE issue_id = ? AND status = 'waiting'",
        ).get(s.issueId)!.n, status).toBe(1);
      }
      s.db.close();
    }
  });

  test('newer revision supersedes an undecided request and rejects the stale decision', async () => {
    const s = await setupSync();
    s.db.query("UPDATE issues SET status = 'planning' WHERE id = ?").run(s.issueId);
    const revision2 = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Revision two';
      return graph;
    });
    const old = s.coordinator.reconcileRevision(s.designId, revision2, 1)[0]!;
    const revision3 = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Revision three';
      return graph;
    });
    const latest = s.coordinator.reconcileRevision(s.designId, revision3, 1)[0]!;

    expect(s.issueEngine.getExecutionSync(old.executionSyncId!)!.state).toBe('stale');
    expect(s.issueEngine.getExecutionSync(latest.executionSyncId!)!.state).toBe('requested');
    await expect(s.coordinator.decide(old.executionSyncId!, revision2, 'ignore', 1))
      .rejects.toMatchObject({ code: 'DESIGN_SYNC_STALE' });
    s.db.close();
  });

  test('applies an owner-selected conflict once and rejects a conflicting second decision', async () => {
    const s = await setupSync();
    s.issueEngine.store.patchMeta(s.issueId, { title: 'Manual local title' });
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Owner-selected incoming title';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

    const applied = await s.coordinator.decide(requested.executionSyncId!, revision, 'apply', 1);
    const duplicate = await s.coordinator.decide(requested.executionSyncId!, revision, 'apply', 1);

    expect(applied).toEqual(duplicate);
    expect(s.issueEngine.store.get(s.issueId)).toMatchObject({
      status: 'pending', title: 'Owner-selected incoming title',
    });
    expect(s.store.getIssueLink(requested.linkId)).toMatchObject({
      lastSyncedRevision: revision, syncState: 'current',
    });
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_receipts',
    ).get()!.n).toBe(1);
    await expect(s.coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1))
      .rejects.toMatchObject({ code: 'DESIGN_SYNC_CONFLICT' });
    s.db.close();
  });

  test('holds the exact plan event durably and duplicate delivery cannot cross the boundary', async () => {
    const s = await setupSync();
    s.db.query("UPDATE projects SET manual_review = 1 WHERE id = 1").run();
    s.db.query("UPDATE issues SET status = 'planning' WHERE id = ?").run(s.issueId);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'Plan revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    s.issueEngine.store.setSubtasks(s.issueId, ['one']);

    expect(await s.issueEngine.applyEvent(s.issueId, 'plan_ready')).toEqual({
      ok: true, from: 'planning', to: 'planning',
    });
    expect(await s.issueEngine.applyEvent(s.issueId, 'plan_ready')).toEqual({
      ok: true, from: 'planning', to: 'planning',
    });
    expect(s.issueEngine.getExecutionSync(requested.executionSyncId!)).toMatchObject({
      state: 'boundary_waiting', boundaryKind: 'plan_ready',
    });

    await s.coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1);
    expect(s.issueEngine.store.get(s.issueId)!.status).toBe('plan_review');
    expect(s.db.query<{ n: number }, [number]>(
      "SELECT COUNT(*) AS n FROM gates WHERE issue_id = ? AND kind = 'plan' AND status = 'waiting'",
    ).get(s.issueId)!.n).toBe(1);
    s.db.close();
  });

  test('done and cancelled history is immutable; supplement creates a new linked pending Issue', async () => {
    for (const status of ['done', 'cancelled'] as const) {
      const s = await setupSync();
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(status, s.issueId);
      const original = s.issueEngine.store.get(s.issueId)!;
      const revision = addRevision(s.db, s.store, s.designId, (graph) => {
        graph.nodes[0]!.title = `Supplement for ${status}`;
        return graph;
      });
      const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

      await expect(s.coordinator.decide(requested.executionSyncId!, revision, 'apply', 1))
        .rejects.toMatchObject({ code: 'DESIGN_SYNC_NOT_ACTIONABLE' });
      const result = await s.coordinator.decide(requested.executionSyncId!, revision, 'supplement', 1);
      const supplement = s.issueEngine.store.get(result.supplementIssueId!)!;

      expect(s.issueEngine.store.get(s.issueId)).toMatchObject({
        status, title: original.title, body: original.body,
      });
      expect(supplement).toMatchObject({ status: 'pending', title: `Supplement for ${status}` });
      expect(s.db.query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM design_issue_links WHERE parent_issue_id = ? AND link_kind = 'supplement'",
      ).get(s.issueId)!.n).toBe(1);
      s.db.close();
    }
  });

  test('node removal retires the stable link without deleting or cancelling the Issue', async () => {
    const s = await setupSync();
    const revision = addRevision(s.db, s.store, s.designId, (graph) => ({ ...graph, nodes: [], edges: [] }));

    const [retired] = s.coordinator.reconcileRevision(s.designId, revision, 1);

    expect(retired).toMatchObject({ state: 'stale', repeated: false });
    expect(s.issueEngine.store.get(s.issueId)).toMatchObject({ status: 'pending' });
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issues').get()!.n).toBe(1);
    expect(s.coordinator.reconcileRevision(s.designId, revision, 1)[0]).toMatchObject({ repeated: true });
    s.db.close();
  });

  test('clarifying and pending-start transitions persist the exact deferred event before moving', async () => {
    for (const [status, event] of [
      ['clarifying', 'clarified'],
      ['pending', 'skip_clarifying'],
    ] as const) {
      const s = await setupSync();
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(status, s.issueId);
      if (status === 'pending') s.issueEngine.store.patchMeta(s.issueId, { title: 'manual conflict' });
      const revision = addRevision(s.db, s.store, s.designId, (graph) => {
        graph.nodes[0]!.title = `incoming ${event}`;
        return graph;
      });
      const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

      expect(await s.issueEngine.applyEvent(s.issueId, event)).toEqual({ ok: true, from: status, to: status });
      const held = s.issueEngine.getExecutionSync(requested.executionSyncId!)!;
      expect(held).toMatchObject({ state: 'boundary_waiting', boundaryKind: event });
      expect(JSON.parse(held.deferredActionJson!)).toEqual({ kind: 'issue-event', event, options: {} });
      expect(s.issueEngine.store.get(s.issueId)!.status).toBe(status);
      s.db.close();
    }
  });

  test('plan and merge gate decisions coexist with sync and upgrade the safe-state hold to the exact event', async () => {
    for (const [status, gateKind, expectedEvent] of [
      ['plan_review', 'plan', 'plan_approved'],
      ['merge_review', 'merge_review', 'review_approved'],
    ] as const) {
      const s = await setupSync();
      s.db.query("UPDATE projects SET manual_review = 1 WHERE id = 1").run();
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(status, s.issueId);
      const gate = s.issueEngine.store.createGate(s.issueId, gateKind, { existing: true });
      const revision = addRevision(s.db, s.store, s.designId, (graph) => {
        graph.nodes[0]!.title = `gate ${status}`;
        return graph;
      });
      const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

      expect(await s.issueEngine.decideGate(gate.id, 1, 'approve')).toEqual({
        ok: true, from: status, to: status,
      });
      const held = s.issueEngine.getExecutionSync(requested.executionSyncId!)!;
      expect(held.boundaryKind).toBe(expectedEvent);
      expect(JSON.parse(held.deferredActionJson!)).toEqual({
        kind: 'issue-event', event: expectedEvent, options: { actor: 1 },
      });
      expect(s.issueEngine.store.getGate(gate.id)!.status).toBe('approved');
      expect(s.issueEngine.store.get(s.issueId)!.status).toBe(status);
      s.db.close();
    }
  });

  test('seq completion advances once, persists nextIndex, and duplicate sentinel plus restart never skip a subtask', async () => {
    const s = await setupSync();
    s.db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
              VALUES ('sync-conv', 1, 'sync', 1, 'codex', 'issue')`);
    s.db.query(
      "UPDATE issues SET status = 'implementing', impl_mode = 'seq', conv_id = 'sync-conv' WHERE id = ?",
    ).run(s.issueId);
    s.issueEngine.store.setSubtasks(s.issueId, ['first', 'second', 'third']);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'seq revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    const message = [{ role: 'assistant' as const, text: `SUBTASK_DONE:${s.issueId}`, seq: 1 }];

    await s.issueEngine.ingest(s.issueId, message, null, 'sync-session');
    const restarted = s.restartIssueEngine();
    await restarted.ingest(s.issueId, message, null, 'sync-session');

    expect(restarted.store.get(s.issueId)!.subIndex).toBe(1);
    expect(restarted.store.subtasksOf(restarted.store.get(s.issueId)!)).toEqual([
      { text: 'first', done: true }, { text: 'second', done: false }, { text: 'third', done: false },
    ]);
    const held = restarted.getExecutionSync(requested.executionSyncId!)!;
    expect(held).toMatchObject({ state: 'boundary_waiting', boundaryKind: 'inject_subtask' });
    expect(JSON.parse(held.deferredActionJson!)).toEqual({ kind: 'inject_subtask', nextIndex: 1 });
    expect(s.injections).toEqual([]);
    s.db.close();
  });

  test('team and testing boundaries preserve full exact lifecycle actions', async () => {
    const cases = [
      {
        status: 'implementing', mode: 'team', event: 'impl_done', options: {}, boundary: 'impl_done',
      },
      {
        status: 'testing', mode: 'seq', event: 'tests_passed',
        options: { note: 'all green' }, boundary: 'tests_passed',
      },
      {
        status: 'testing', mode: 'seq', event: 'tests_failed',
        options: { note: 'suite failed', failCount: 2 }, boundary: 'tests_failed',
      },
    ] as const;
    for (const entry of cases) {
      const s = await setupSync();
      s.db.query('UPDATE issues SET status = ?, impl_mode = ? WHERE id = ?')
        .run(entry.status, entry.mode, s.issueId);
      const revision = addRevision(s.db, s.store, s.designId, (graph) => {
        graph.nodes[0]!.title = `${entry.event} revision`;
        return graph;
      });
      const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

      const heldResult = await s.issueEngine.applyEvent(s.issueId, entry.event, entry.options);
      expect(heldResult.ok).toBe(true);
      expect(heldResult.ok && heldResult.to).toBe(entry.status);
      const held = s.issueEngine.getExecutionSync(requested.executionSyncId!)!;
      expect(held.boundaryKind).toBe(entry.boundary);
      expect(JSON.parse(held.deferredActionJson!)).toEqual({
        kind: 'issue-event', event: entry.event, options: entry.options,
      });
      expect(s.issueEngine.store.get(s.issueId)!.status).toBe(entry.status);
      s.db.close();
    }
  });

  test('durable boundary makes watcher tick a zero-side-effect no-op across restart', async () => {
    const s = await setupSync();
    s.db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
              VALUES ('sync-watch', 1, 'sync', 1, 'codex', 'issue')`);
    s.db.query(
      "UPDATE issues SET status = 'planning', conv_id = 'sync-watch' WHERE id = ?",
    ).run(s.issueId);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'watch revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    await s.issueEngine.applyEvent(s.issueId, 'plan_ready');

    await s.restartIssueEngine().tick();

    expect(s.issueEngine.getExecutionSync(requested.executionSyncId!)!.state).toBe('boundary_waiting');
    expect(s.injections).toEqual([]);
    expect(s.captures()).toBe(0);
    expect(s.gitCalls).toEqual([]);
    s.db.close();
  });

  test('publicationLocked blocks generic edits and restart drains the original durable module intent', async () => {
    const s = await setupSync();
    const prepared = await s.issueEngine.prepareDesignBatch(1, [{
      nodeId: 'durable-module-node',
      title: 'Durable module Issue',
      body: 'Durable module body',
      moduleId: 11,
      implMode: 'direct',
      agent: 'codex',
      createdBy: 1,
    }]);
    const published = s.issueEngine.commitPreparedDesignBatch(prepared, [], () => undefined)[0]!;
    const operation = {
      key: `issue-publication:1:module-doc:${published.id}`,
      kind: 'module-doc' as const,
      projectId: 1,
      issueId: published.id,
      issueIds: [published.id],
      moduleId: 11,
      agent: 'codex' as const,
    };
    const completed = new Set<string>();
    let retries = 0;
    const outbox = {
      listOperations: () => [operation],
      isComplete: (item: typeof operation) => completed.has(item.key),
      markComplete: (item: typeof operation) => { completed.add(item.key); },
      markRetry: () => { retries++; },
    };
    s.moduleState.failures = 1;

    await expect(s.issueEngine.completeDesignBatch(1, [published.id], outbox))
      .rejects.toThrow('post-commit retry required');
    await expect(s.issueEngine.updatePendingMeta(published.id, { moduleId: null, title: 'manual edit' }))
      .rejects.toThrow('revision-aware sync');
    expect(s.issueEngine.store.get(published.id)).toMatchObject({
      moduleId: 11, title: 'Durable module Issue', publicationLocked: true,
    });

    await s.restartIssueEngine().completeDesignBatch(1, [published.id], outbox);

    expect(retries).toBe(1);
    expect(completed).toEqual(new Set([operation.key]));
    expect(s.moduleRecords).toEqual([11]);
    s.db.close();
  });

  test('decision receipt survives before async delivery and a restarted engine drains the exact action once', async () => {
    const s = await setupSync();
    s.issueEngine.store.patchMeta(s.issueId, { title: 'local conflict' });
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'restart incoming';
      return graph;
    });
    const noDrainIssues = new Proxy(s.issueEngine, {
      get(target, property, receiver) {
        if (property === 'drainExecutionSyncEffectOutbox') {
          return async () => ({ examined: 0, delivered: 0 });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const coordinator = new DesignSyncCoordinator({ store: s.store, issues: noDrainIssues });
    const requested = coordinator.reconcileRevision(s.designId, revision, 1)[0]!;

    await coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1);
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_receipts',
    ).get()!.n).toBe(1);
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_outbox WHERE delivered_ts IS NULL',
    ).get()!.n).toBe(1);

    expect(await s.restartIssueEngine().drainExecutionSyncEffectOutbox()).toEqual({ examined: 1, delivered: 1 });
    expect(await s.restartIssueEngine().drainExecutionSyncEffectOutbox()).toEqual({ examined: 0, delivered: 0 });
    s.db.close();
  });

  test('after subtask prompt dispatch but before acknowledgement, recovery fails closed and never auto-sends twice', async () => {
    const s = await setupSync();
    s.db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
              VALUES ('sync-crash', 1, 'sync', 1, 'codex', 'issue')`);
    s.db.query(
      "UPDATE issues SET status = 'implementing', impl_mode = 'seq', conv_id = 'sync-crash' WHERE id = ?",
    ).run(s.issueId);
    s.issueEngine.store.setSubtasks(s.issueId, ['first', 'second']);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'crash-window revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    await s.issueEngine.ingest(
      s.issueId,
      [{ role: 'assistant', text: `SUBTASK_DONE:${s.issueId}`, seq: 1 }],
      null,
      'sync-session',
    );
    const originalAck = s.issueEngine.store.markExecutionSyncEffectDelivered.bind(s.issueEngine.store);
    let crashOnce = true;
    s.issueEngine.store.markExecutionSyncEffectDelivered = ((
      resumeKey: string,
      intentKey: string,
      deliveryToken: string,
    ) => {
      if (crashOnce) {
        crashOnce = false;
        throw new Error('crash after prompt dispatch');
      }
      return originalAck(resumeKey, intentKey, deliveryToken);
    }) as typeof s.issueEngine.store.markExecutionSyncEffectDelivered;

    const recovery = await s.coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1);

    expect(recovery.state).toBe('recovery_pending');
    expect(s.store.getIssueLink(recovery.linkId)?.syncState).toBe('recovery_pending');
    expect(s.coordinator.getLinkRecovery(recovery.linkId)).toEqual(expect.objectContaining({
      linkId: recovery.linkId,
      state: 'recovery_pending',
      executionSyncId: requested.executionSyncId,
    }));
    expect(s.injections).toHaveLength(1);
    expect(s.injections[0]).toContain('SYNC_RESUME_KEY:');
    expect(s.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()).toEqual({ state: 'uncertain' });
    expect(s.issueEngine.listUncertainExecutionSyncEffects()).toEqual([
      expect.objectContaining({
        syncId: requested.executionSyncId,
        deliveryState: 'uncertain',
        intentKey: `boundary:${s.issueId}:${revision}`,
      }),
    ]);
    await s.restartIssueEngine().ingest(
      s.issueId,
      [{ role: 'assistant', text: `SUBTASK_DONE:${s.issueId}`, seq: 2 }],
      null,
      'sync-session',
    );
    expect(s.issueEngine.store.get(s.issueId)).toMatchObject({ status: 'implementing', subIndex: 1 });
    expect(await s.coordinator.resolveScopedRecovery(
      s.designId,
      requested.executionSyncId!,
      revision,
      'confirm_delivered',
    )).toEqual(expect.objectContaining({ state: 'current', linkId: recovery.linkId }));
    expect(s.store.getIssueLink(recovery.linkId)?.syncState).toBe('current');
    expect(s.issueEngine.listUncertainExecutionSyncEffects()).toEqual([]);
    expect(await s.restartIssueEngine().drainExecutionSyncEffectOutbox()).toEqual({ examined: 0, delivered: 0 });
    expect(s.injections).toHaveLength(1);
    s.db.close();
  });

  test('partial issue-event entry action remains uncertain instead of treating replayed illegal transition as success', async () => {
    const s = await setupSync();
    s.db.query("UPDATE issues SET status = 'planning' WHERE id = ?").run(s.issueId);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'partial entry revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    s.issueEngine.store.setSubtasks(s.issueId, ['one']);
    await s.issueEngine.applyEvent(s.issueId, 'plan_ready');
    const originalLog = s.issueEngine.store.logEvent.bind(s.issueEngine.store);
    s.issueEngine.store.logEvent = ((
      issueId: number,
      kind: string,
      data?: Record<string, unknown>,
    ) => {
      if (kind === 'auto_approved') throw new Error('crash during plan-review entry');
      return originalLog(issueId, kind, data);
    }) as typeof s.issueEngine.store.logEvent;

    await s.coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1);

    expect(s.issueEngine.store.get(s.issueId)?.status).toBe('plan_review');
    expect(s.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()).toEqual({ state: 'uncertain' });
    expect(await s.coordinator.resolveScopedRecovery(
      s.designId,
      requested.executionSyncId!,
      revision,
      'retry',
    )).toEqual(expect.objectContaining({ state: 'recovery_pending' }));
    expect(s.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()).toEqual({ state: 'uncertain' });
    // The owner explicitly authorized this one resend; the repeated partial entry still fails closed.
    expect(s.issueEngine.store.get(s.issueId)?.status).toBe('plan_review');
    s.db.close();
  });

  test('partial merge entry after Git work is fail-closed and recovery does not repeat Git', async () => {
    const s = await setupSync();
    s.db.query("UPDATE issues SET status = 'merge_review', branch = 'main' WHERE id = ?").run(s.issueId);
    const revision = addRevision(s.db, s.store, s.designId, (graph) => {
      graph.nodes[0]!.title = 'partial Git revision';
      return graph;
    });
    const requested = s.coordinator.reconcileRevision(s.designId, revision, 1)[0]!;
    const originalLog = s.issueEngine.store.logEvent.bind(s.issueEngine.store);
    s.issueEngine.store.logEvent = ((
      issueId: number,
      kind: string,
      data?: Record<string, unknown>,
    ) => {
      if (kind === 'auto_approved') throw new Error('crash after Git work');
      return originalLog(issueId, kind, data);
    }) as typeof s.issueEngine.store.logEvent;

    await s.coordinator.decide(requested.executionSyncId!, revision, 'ignore', 1);
    const gitCallCount = s.gitCalls.length;

    expect(gitCallCount).toBeGreaterThan(0);
    expect(s.issueEngine.store.get(s.issueId)?.status).toBe('merge_review');
    expect(s.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()).toEqual({ state: 'uncertain' });
    expect(await s.restartIssueEngine().drainExecutionSyncEffectOutbox()).toEqual({ examined: 0, delivered: 0 });
    expect(s.gitCalls).toHaveLength(gitCallCount);
    s.db.close();
  });
});

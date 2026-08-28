import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { validateDesignGraph } from './graph';
import type { DesignGraphNodeDraft, DesignRunIntent } from './types';
import {
  DesignRevisionConflictError,
  DesignStageConflictError,
  DesignStore,
  DesignTaskImmutableError,
  migrateDesigns,
} from './store';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run(`INSERT INTO users (username, token_hash, created_ts) VALUES ('owner', 'hash', 1)`);
  db.run(
    `INSERT INTO executors
       (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`,
  );
  db.run(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
     VALUES ('first', 1, '/workspace/first', 1, 1),
            ('second', 1, '/workspace/second', 1, 2)`,
  );
  return { db, store: new DesignStore(db) };
}

function createTask(store: DesignStore, projectId = 1) {
  return store.createTask({
    projectId,
    title: `Design ${projectId}`,
    originalRequest: 'Design a safe rollout',
    agent: 'codex',
    readinessThreshold: 70,
    documentJson: { summary: 'initial draft' },
    documentMarkdown: '# Initial draft',
    graphGranularity: 'balanced',
  });
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

describe('DesignStore', () => {
  test('creates a run intent only for the design current revision and owning project', () => {
    const { db, store } = setup();
    const task = createTask(store, 1);
    const base: DesignRunIntent = {
      designId: task.id,
      runId: 'run-scope',
      projectId: 1,
      operationGroupId: 'group-a',
      key: 'builtin:general-reviewer',
      contentHash: 'a'.repeat(64),
      origin: 'builtin',
      gitCommit: null,
      role: 'reviewer',
      resolvedAgent: 'codex',
      sourceRevision: task.currentRevision,
      state: 'launching',
      createdTs: 1,
      updatedTs: 1,
    };

    expect(store.createRunIntent({ ...base, projectId: 2 })).toBe(false);
    expect(store.createRunIntent({ ...base, runId: 'run-stale', sourceRevision: task.currentRevision + 1 })).toBe(false);
    expect(store.createRunIntent({ ...base, runId: 'run-agent', resolvedAgent: 'claude' })).toBe(false);
    expect(store.createRunIntent(base)).toBe(true);
    expect(store.getRunIntent(task.id, base.runId)).toMatchObject({
      projectId: 1,
      sourceRevision: task.currentRevision,
      state: 'launching',
    });
    db.close();
  });

  test('persists one pre-side-effect creation saga per project idempotency key', () => {
    const { db, store } = setup();
    const first = store.ensureCreationSaga({
      sagaToken: 'saga-first',
      projectId: 1,
      idempotencyKey: 'request-1',
      requestJson: '{"title":"Safe rollout"}',
      conversationId: 'conv-first',
    });
    const replay = store.ensureCreationSaga({
      sagaToken: 'saga-second',
      projectId: 1,
      idempotencyKey: 'request-1',
      requestJson: '{"title":"Safe rollout"}',
      conversationId: 'conv-second',
    });

    expect(first).toMatchObject({ created: true, saga: {
      sagaToken: 'saga-first', projectId: 1, idempotencyKey: 'request-1',
      conversationId: 'conv-first', taskId: null, phase: 'intent', conversationOwned: false, error: null,
    } });
    expect(replay).toMatchObject({ created: false, saga: {
      sagaToken: 'saga-first', conversationId: 'conv-first',
    } });
    expect(store.listIncompleteCreationSagas().map((saga) => saga.sagaToken)).toEqual(['saga-first']);
    db.close();
  });

  test('creates and completes a hidden bootstrap task under saga token and conversation guards', () => {
    const { db, store } = setup();
    const saga = store.ensureCreationSaga({
      sagaToken: 'saga-bootstrap',
      projectId: 1,
      idempotencyKey: 'request-bootstrap',
      requestJson: '{}',
      conversationId: 'conv-bootstrap',
    }).saga;
    const created = store.createCreationSagaTask(saga.sagaToken, 'intent', {
      projectId: 1,
      title: 'Hidden bootstrap',
      originalRequest: 'Do not publish before activation.',
      agent: 'codex',
      documentJson: { title: 'Hidden bootstrap' },
      documentMarkdown: '# Hidden bootstrap',
      readiness: 0,
      graph: { nodes: [], edges: [] },
      actor: 'owner:user:1',
    })!;

    expect(created.task).toMatchObject({ status: 'active', conversationId: null, currentRevision: 1 });
    expect(store.isTaskProvisional(created.task.id)).toBe(true);
    expect(store.listTasks(1)).toEqual([]);
    expect(store.getCreationSagaByToken(saga.sagaToken)).toMatchObject({
      taskId: created.task.id, phase: 'task_created', conversationOwned: false,
    });
    expect(store.listEvents(created.task.id)[0]?.data).toMatchObject({
      creationSagaToken: saga.sagaToken,
      conversationId: saga.conversationId,
    });

    db.query(
      `INSERT INTO conversations
         (id, project_id, label, created_ts, agent, kind)
       VALUES (?, 1, 'Design bootstrap', 1, 'codex', 'chat')`,
    ).run(saga.conversationId);
    db.query(
      `INSERT INTO design_saga_conversation_owners (conversation_id, saga_token, created_ts)
       VALUES (?, ?, 1)`,
    ).run(saga.conversationId, saga.sagaToken);
    store.markCreationConversationOwned(saga.sagaToken, 'task_created');
    const bound = store.bindCreationConversation(saga.sagaToken, 'conversation_created')!;
    expect(bound).toMatchObject({ status: 'active', conversationId: saga.conversationId });
    store.markCreationActivating(saga.sagaToken, 'bound');
    store.markCreationActivated(saga.sagaToken, 'activating');
    const completed = store.completeCreationSaga(saga.sagaToken, 'activated')!;
    expect(completed).toMatchObject({ status: 'active', conversationId: saga.conversationId });
    expect(store.isTaskProvisional(completed.id)).toBe(false);
    expect(store.listTasks(1).map((task) => task.id)).toEqual([completed.id]);
    expect(store.listIncompleteCreationSagas()).toEqual([]);
    db.close();
  });

  test('phase transitions are compare-and-swap and a stale engine cannot overwrite the winner', () => {
    const { db, store } = setup();
    const saga = store.ensureCreationSaga({
      sagaToken: 'saga-cas', projectId: 1, idempotencyKey: 'request-cas',
      requestJson: '{}', conversationId: 'conv-cas',
    }).saga;
    store.createCreationSagaTask(saga.sagaToken, 'intent', {
      projectId: 1,
      title: 'CAS bootstrap',
      originalRequest: 'Only one engine advances each phase.',
      agent: 'codex',
      documentJson: {},
      documentMarkdown: '# CAS',
      readiness: 0,
      actor: 'owner:user:1',
    })!;
    db.query(
      `INSERT INTO conversations
         (id, project_id, label, created_ts, agent, kind)
       VALUES ('conv-cas', 1, 'CAS', 1, 'codex', 'chat')`,
    ).run();
    db.query(
      `INSERT INTO design_saga_conversation_owners (conversation_id, saga_token, created_ts)
       VALUES ('conv-cas', 'saga-cas', 1)`,
    ).run();

    expect(store.markCreationConversationOwned(saga.sagaToken, 'task_created')?.phase)
      .toBe('conversation_created');
    expect(store.markCreationConversationOwned(saga.sagaToken, 'task_created')).toBeNull();
    expect(store.markCreationSagaError(saga.sagaToken, 'task_created', 'stale failure')).toBeNull();
    expect(store.getCreationSagaByToken(saga.sagaToken)).toMatchObject({
      phase: 'conversation_created', error: null,
    });
    expect(store.markCreationSagaError(saga.sagaToken, 'conversation_created', 'winner failure'))
      .toMatchObject({ phase: 'recoverable_error', error: 'winner failure' });
    expect(store.markCreationSagaError(saga.sagaToken, 'recoverable_error', 'loser failure')).toBeNull();
    expect(store.getCreationSagaByToken(saga.sagaToken)?.error).toBe('winner failure');
    db.close();
  });

  test('guarded task compensation refuses concurrent mutation or foreign bootstrap ownership', () => {
    for (const mutation of ['revision', 'conversation', 'event-token'] as const) {
      const { db, store } = setup();
      const saga = store.ensureCreationSaga({
        sagaToken: `saga-${mutation}`,
        projectId: 1,
        idempotencyKey: `request-${mutation}`,
        requestJson: '{}',
        conversationId: `conv-${mutation}`,
      }).saga;
      const task = store.createCreationSagaTask(saga.sagaToken, 'intent', {
        projectId: 1,
        title: 'Bootstrap',
        originalRequest: 'Guard compensation.',
        agent: 'codex',
        documentJson: {},
        documentMarkdown: '# Bootstrap',
        readiness: 0,
        actor: 'owner:user:1',
      })!.task;
      if (mutation === 'revision') {
        db.query('UPDATE design_tasks SET current_revision = 2 WHERE id = ?').run(task.id);
      } else if (mutation === 'conversation') {
        db.query(
          `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
           VALUES ('foreign-conv', 1, 'Foreign', 1, 'codex', 'chat')`,
        ).run();
        db.query('UPDATE design_tasks SET conversation_id = ? WHERE id = ?').run('foreign-conv', task.id);
      } else {
        db.query('UPDATE design_events SET data_json = ? WHERE design_task_id = ?')
          .run('{"creationSagaToken":"foreign","conversationId":"foreign"}', task.id);
      }

      expect(store.deleteCreationSagaTask(saga.sagaToken, 'task_created')).toBe(false);
      expect(store.getTask(task.id)).not.toBeNull();
      store.markCreationSagaError(saga.sagaToken, 'task_created', 'compensation ownership conflict');
      expect(store.getCreationSagaByToken(saga.sagaToken)).toMatchObject({
        phase: 'recoverable_error', error: 'compensation ownership conflict', taskId: task.id,
      });
      db.close();
    }
  });

  test('creates tasks and lists only the requested project', () => {
    const { db, store } = setup();
    const first = createTask(store, 1);
    const second = createTask(store, 2);

    expect(store.getTask(first.id)).toMatchObject({
      id: first.id,
      projectId: 1,
      moduleId: null,
      currentRevision: 0,
      readinessThreshold: 70,
      readinessOverride: false,
      documentJson: { summary: 'initial draft' },
      graphGranularity: 'balanced',
    });
    expect(store.listTasks(1).map((task) => task.id)).toEqual([first.id]);
    expect(store.listTasks(2).map((task) => task.id)).toEqual([second.id]);
    db.close();
  });

  test('patches only runtime metadata without advancing the document revision', () => {
    const { db, store } = setup();
    const task = createTask(store);

    const updated = store.updateTask(task.id, {
      expectedRevision: 0,
      worktreeCwd: '/workspace/design',
      worktreeBranch: 'codex/design-1',
      lastError: 'recoverable',
    });

    expect(updated).toMatchObject({
      id: task.id,
      stage: 'goal_setting',
      currentRevision: 0,
      worktreeCwd: '/workspace/design',
      worktreeBranch: 'codex/design-1',
      lastError: 'recoverable',
    });
    expect(() =>
      store.updateTask(task.id, { expectedRevision: 0, stage: 'review' }),
    ).toThrow('commitDocumentMutation');
    expect(() =>
      store.updateTask(task.id, { expectedRevision: 0, moduleId: 11 }),
    ).toThrow('commitDocumentMutation');
    db.close();
  });

  test('refuses to bypass the atomic document mutation primitive', () => {
    const { db, store } = setup();
    const task = createTask(store);

    expect(() => store.updateTask(task.id, {
      expectedRevision: 0,
      documentJson: { summary: 'unsafe replacement' },
      documentMarkdown: '# Unsafe replacement',
    })).toThrow('commitDocumentMutation');
    expect(store.getTask(task.id)).toMatchObject({
      currentRevision: 0,
      documentJson: { summary: 'initial draft' },
      documentMarkdown: '# Initial draft',
    });
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    store.saveRevision({
      designTaskId: task.id,
      revision: 1,
      documentJson: { summary: 'safe replacement' },
      documentMarkdown: '# Safe replacement',
      readiness: 80,
      graph: { nodes: [], edges: [] },
      actor: 'design_steward:codex',
    });
    expect(() => store.replaceGraph(task.id, {
      nodes: [{ nodeId: 'unsafe', title: 'Unsafe graph replacement' }],
      edges: [],
    })).toThrow('commitDocumentMutation');
    db.close();
  });

  test('appends immutable events and revisions', () => {
    const { db, store } = setup();
    const task = createTask(store);
    const firstEvent = store.appendEventAtRevision(task.id, 0, 'task_created', { source: 'user' });
    store.appendEventAtRevision(task.id, 0, 'stage_changed', { from: 'draft', to: 'review' });
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    const revision = store.saveRevision({
      designTaskId: task.id,
      revision: 1,
      documentJson: { summary: 'reviewed' },
      documentMarkdown: '# Reviewed',
      readiness: 84,
      graph: { nodes: [], edges: [] },
      actor: 'codex',
      reason: 'review complete',
    });

    expect(store.listEvents(task.id, firstEvent.id).map((event) => event.kind)).toEqual([
      'stage_changed',
      'document_revised',
    ]);
    expect(store.getRevision(task.id, 1)).toMatchObject({
      id: revision.id,
      documentJson: { summary: 'reviewed' },
      readiness: 84,
      actor: 'codex',
    });
    expect(() => store.saveRevision({ ...revision, designTaskId: task.id })).toThrow();
    db.close();
  });

  test('normalizes a revision graph snapshot to the public graph contract', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    const research = publishableNode('research', 'Research');
    const rollout = publishableNode('rollout', 'Rollout', {
      dependencies: ['research'],
      implMode: 'team',
    });

    store.saveRevision({
      designTaskId: task.id,
      revision: 1,
      documentJson: { summary: 'sequenced work' },
      documentMarkdown: '# Sequenced work',
      readiness: 80,
      graph: {
        nodes: [research, rollout],
        edges: [{ fromNodeId: 'research', toNodeId: 'rollout' }],
      },
      actor: 'codex',
    });

    expect(store.getRevision(task.id, 1)?.graph).toEqual({
      nodes: [
        { ...research, ordinal: 0, detail: null, issueId: null, lastSyncedRevision: null },
        { ...rollout, ordinal: 1, detail: null, issueId: null, lastSyncedRevision: null },
      ],
      edges: [{ fromNodeId: 'research', toNodeId: 'rollout', kind: 'depends_on' }],
    });
    db.close();
  });

  test('round-trips every publish-time graph field through live and revision storage', () => {
    const { db, store } = setup();
    const task = createTask(store);
    const graph = {
      nodes: [publishableNode('implementation', 'Implementation', {
        goal: 'Ship the approved design safely.',
        background: ['Approved design revision.'],
        sourceSections: ['Architecture decision record.'],
        scope: ['design engine'],
        nonGoals: ['UI changes'],
        inputs: ['Canonical graph.'],
        outputs: ['Linked Issues.'],
        dependencies: [],
        implementationNotes: ['Use one SQLite transaction.'],
        moduleId: 11,
        runtime: 'worktree',
        agent: 'codex',
        complexity: 'high',
        complexityRationale: ['Atomic publication spans two domains.'],
        acceptanceCriteria: ['A stale revision is rejected.'],
        testRecommendations: ['Run the focused engine suite.'],
        evidenceRequirements: ['Attach the passing test output.'],
        completionInstructions: ['Report publication and Issue IDs.'],
        implMode: 'team' as const,
      })],
      edges: [],
    };

    store.replaceGraph(task.id, graph);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    store.saveRevision({
      designTaskId: task.id,
      revision: 1,
      documentJson: { summary: 'sequenced work' },
      documentMarkdown: '# Sequenced work',
      readiness: 90,
      graph,
      actor: 'design_steward:codex',
    });

    const live = store.getGraph(task.id);
    const snapshot = store.getRevision(task.id, 1)!.graph;
    expect(live.nodes[0]).toMatchObject(graph.nodes[0]);
    expect(snapshot.nodes[0]).toMatchObject(graph.nodes[0]);
    expect(validateDesignGraph(live)).toEqual({ valid: true, errors: [] });
    expect(validateDesignGraph(snapshot)).toEqual({ valid: true, errors: [] });
    db.close();
  });

  test('rolls graph replacement back when an edge names a missing node', () => {
    const { db, store } = setup();
    const task = createTask(store);
    store.replaceGraph(task.id, {
      nodes: [{ nodeId: 'research', title: 'Research' }],
      edges: [],
    });

    expect(() =>
      store.replaceGraph(task.id, {
        nodes: [{ nodeId: 'implementation', title: 'Implementation' }],
        edges: [{ fromNodeId: 'implementation', toNodeId: 'missing' }],
      }),
    ).toThrow('unknown graph node');
    expect(store.getGraph(task.id)).toEqual({
      nodes: [{ nodeId: 'research', ordinal: 0, title: 'Research', detail: null, issueId: null, lastSyncedRevision: null }],
      edges: [],
    });
    db.close();
  });

  test('commits a document revision, snapshot, readiness, event, and sync dirtiness together', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    store.replaceGraph(task.id, {
      nodes: [{
        ...publishableNode('implementation', 'Implementation'),
        lastSyncedRevision: 0,
      }],
      edges: [],
    });

    const result = store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: task.id,
      expectedRevision: 0,
      documentJson: { goal: 'Safe rollout' },
      documentMarkdown: '# Safe rollout',
      readiness: 86,
      actor: 'design_steward:codex',
      reason: 'document revised',
      event: { kind: 'document_revised', data: { revised: true } },
    });

    expect(result.task).toMatchObject({ currentRevision: 1, stage: 'solution_draft' });
    expect(result.revision).toMatchObject({
      revision: 1,
      readiness: 86,
      documentJson: { goal: 'Safe rollout' },
    });
    expect(result.event).toMatchObject({
      kind: 'document_revised',
      data: {
        revised: true,
        revision: 1,
        readiness: 86,
        graphSyncDirty: true,
        linkedIssueSyncDirty: true,
      },
    });
    expect(store.getGraph(task.id).nodes[0]?.lastSyncedRevision).toBeNull();
    db.close();
  });

  test('rejects arbitrary stage and status patches at the atomic document boundary', () => {
    const { db, store } = setup();
    const task = createTask(store);

    expect(() => store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: task.id,
      expectedRevision: 0,
      taskPatch: { stage: 'completed', status: 'archived' },
      documentJson: { bypass: true },
      documentMarkdown: '# Bypass',
      readiness: 100,
      graph: { nodes: [], edges: [] },
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    } as never)).toThrow('closed document action');

    expect(store.getTask(task.id)).toMatchObject({
      stage: 'goal_setting',
      status: 'active',
      currentRevision: 0,
      documentJson: { summary: 'initial draft' },
    });
    expect(store.getRevision(task.id, 1)).toBeNull();
    expect(store.listEvents(task.id)).toEqual([]);
    db.close();
  });

  test('validates a closed document action against the exact live stage', () => {
    const { db, store } = setup();
    const task = createTask(store);

    expect(() => store.commitDocumentMutation({
      action: 'submit_review',
      designTaskId: task.id,
      expectedRevision: 0,
      documentJson: { solution: 'Too soon' },
      documentMarkdown: '# Too soon',
      readiness: 90,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    })).toThrow(DesignStageConflictError);
    expect(store.getTask(task.id)).toMatchObject({ stage: 'goal_setting', currentRevision: 0 });
    expect(store.getRevision(task.id, 1)).toBeNull();

    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    const submitted = store.commitDocumentMutation({
      action: 'submit_review',
      designTaskId: task.id,
      expectedRevision: 0,
      documentJson: { solution: 'Canary' },
      documentMarkdown: '# Canary',
      readiness: 90,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    });
    expect(submitted.task).toMatchObject({ stage: 'review', status: 'active', currentRevision: 1 });
    db.close();
  });

  test('rejects ordinary document revision outside solution drafting and review', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('approved', task.id);

    expect(() => store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: task.id,
      expectedRevision: 0,
      documentJson: { tooLate: true },
      documentMarkdown: '# Too late',
      readiness: 100,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    })).toThrow(DesignStageConflictError);
    expect(store.getTask(task.id)).toMatchObject({ stage: 'approved', currentRevision: 0 });
    expect(store.getRevision(task.id, 1)).toBeNull();
    expect(store.listEvents(task.id)).toEqual([]);
    db.close();
  });

  test('preserves archived and stale-revision error priority for rejected lifecycle patches', () => {
    const first = setup();
    const archivedTask = createTask(first.store);
    first.store.archiveTask(archivedTask.id, 'owner:user:1');
    expect(() => first.store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: archivedTask.id,
      expectedRevision: 0,
      taskPatch: { stage: 'completed' },
      documentJson: { bypass: true },
      documentMarkdown: '# Bypass',
      readiness: 100,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    } as never)).toThrow(DesignTaskImmutableError);
    first.db.close();

    const second = setup();
    const staleTask = createTask(second.store);
    second.db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', staleTask.id);
    second.store.saveRevision({
      designTaskId: staleTask.id,
      revision: 1,
      documentJson: { current: true },
      documentMarkdown: '# Current',
      readiness: 90,
      graph: { nodes: [], edges: [] },
      actor: 'design_steward:codex',
    });
    expect(() => second.store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: staleTask.id,
      expectedRevision: 0,
      taskPatch: { status: 'archived' },
      documentJson: { bypass: true },
      documentMarkdown: '# Bypass',
      readiness: 100,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    } as never)).toThrow(DesignRevisionConflictError);
    second.db.close();
  });

  test('rolls every document mutation side effect back when its event cannot be saved', () => {
    const { db, store } = setup();
    const task = createTask(store);
    store.replaceGraph(task.id, {
      nodes: [{
        ...publishableNode('implementation', 'Implementation'),
        lastSyncedRevision: 0,
      }],
      edges: [],
    });
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    db.run(`CREATE TRIGGER reject_design_event BEFORE INSERT ON design_events
      BEGIN SELECT RAISE(ABORT, 'event rejected'); END`);

    expect(() => store.commitDocumentMutation({
      action: 'revise_document',
      designTaskId: task.id,
      expectedRevision: 0,
      documentJson: { goal: 'Safe rollout' },
      documentMarkdown: '# Safe rollout',
      readiness: 86,
      actor: 'design_steward:codex',
      event: { kind: 'document_revised', data: null },
    })).toThrow('event rejected');

    expect(store.getTask(task.id)).toMatchObject({
      currentRevision: 0,
      documentJson: { summary: 'initial draft' },
    });
    expect(store.getRevision(task.id, 1)).toBeNull();
    expect(store.getGraph(task.id).nodes[0]?.lastSyncedRevision).toBe(0);
    db.close();
  });

  test('rejects an invalid graph before any document mutation side effect is committed', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);
    const invalidGraphs = [
      {
        nodes: [{ nodeId: 'incomplete', title: 'Incomplete' }],
        edges: [],
      },
      {
        nodes: [
          {
            nodeId: 'a', title: 'A', acceptanceCriteria: ['A works'],
            evidenceRequirements: ['A output'], implMode: 'direct' as const,
          },
          {
            nodeId: 'b', title: 'B', acceptanceCriteria: ['B works'],
            evidenceRequirements: ['B output'], implMode: 'team' as const,
          },
        ],
        edges: [
          { fromNodeId: 'a', toNodeId: 'b' },
          { fromNodeId: 'b', toNodeId: 'a' },
        ],
      },
    ];

    for (const graph of invalidGraphs) {
      expect(() => store.commitDocumentMutation({
        action: 'revise_document',
        designTaskId: task.id,
        expectedRevision: 0,
        documentJson: { invalid: true },
        documentMarkdown: '# Invalid',
        readiness: 100,
        graph,
        actor: 'design_steward:codex',
        event: { kind: 'document_revised', data: null },
      })).toThrow('invalid design graph');
      expect(() => store.saveRevision({
        designTaskId: task.id,
        revision: 1,
        documentJson: { invalid: true },
        documentMarkdown: '# Invalid',
        readiness: 100,
        graph,
        actor: 'design_steward:codex',
      })).toThrow('invalid design graph');
      expect(store.getTask(task.id)?.currentRevision).toBe(0);
      expect(store.getRevision(task.id, 1)).toBeNull();
      expect(store.listEvents(task.id)).toEqual([]);
    }
    db.close();
  });

  test('allows only explicit lifecycle actions through the stage transition primitive', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('review', task.id);

    expect(() => store.transitionStage({
      designTaskId: task.id,
      expectedRevision: 0,
      action: 'draft_graph',
      actor: 'design_steward:codex',
      eventData: null,
    } as never)).toThrow('closed lifecycle action');
    expect(store.getTask(task.id)).toMatchObject({ stage: 'review', currentRevision: 0 });
    expect(store.listEvents(task.id)).toEqual([]);
    db.close();
  });

  test('returns a typed stage conflict when a no-revision lifecycle action loses a stage race', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('solution_draft', task.id);

    expect(() => store.transitionStage({
      designTaskId: task.id,
      expectedRevision: 0,
      action: 'confirm_goal',
      actor: 'owner:user:1',
      eventData: null,
    })).toThrow(DesignStageConflictError);
    expect(store.getTask(task.id)).toMatchObject({ stage: 'solution_draft', currentRevision: 0 });
    expect(store.listEvents(task.id)).toEqual([]);
    db.close();
  });

  test('starts and completes execution through closed lifecycle actions without document revisions', () => {
    const { db, store } = setup();
    const task = createTask(store);
    db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('approved', task.id);

    const executing = store.transitionStage({
      designTaskId: task.id,
      expectedRevision: 0,
      action: 'start_execution',
      actor: 'owner:user:1',
      eventData: { source: 'owner' },
    });
    const completed = store.transitionStage({
      designTaskId: task.id,
      expectedRevision: 0,
      action: 'complete_execution',
      actor: 'owner:user:1',
      eventData: { evidence: ['run-log'] },
    });

    expect(executing).toMatchObject({ stage: 'executing', status: 'active', currentRevision: 0 });
    expect(completed).toMatchObject({ stage: 'completed', status: 'active', currentRevision: 0 });
    expect(store.getRevision(task.id, 1)).toBeNull();
    expect(store.listEvents(task.id).map((event) => event.kind)).toEqual([
      'execution_started',
      'execution_completed',
    ]);
    db.close();
  });

  test('rejects task, revision, and graph mutations after archival', () => {
    const { db, store } = setup();
    const task = createTask(store);
    store.archiveTask(task.id, 'owner:user:1');

    expect(() => store.updateTask(task.id, {
      expectedRevision: 0,
      title: 'Changed after archive',
    })).toThrow('archived');
    expect(() => store.saveRevision({
      designTaskId: task.id,
      revision: 1,
      documentJson: { changed: true },
      documentMarkdown: '# Changed',
      readiness: 100,
      graph: { nodes: [], edges: [] },
      actor: 'design_steward:codex',
    })).toThrow('archived');
    expect(() => store.replaceGraph(task.id, {
      nodes: [{ nodeId: 'changed', title: 'Changed' }],
      edges: [],
    })).toThrow('archived');
    expect(() => store.appendEventAtRevision(
      task.id,
      task.currentRevision,
      'task_error',
      { message: 'Cannot append after archive' },
    )).toThrow('archived');
    expect(store.getTask(task.id)).toMatchObject({ title: 'Design 1', stage: 'archived', status: 'archived' });
    expect(store.listEvents(task.id).map((event) => event.kind)).toEqual(['task_archived']);
    db.close();
  });

  test('rejects unknown stage/status in SQLite and unknown events at the typed boundary', () => {
    const { db, store } = setup();
    const task = createTask(store);

    expect(() => db.query('UPDATE design_tasks SET stage = ? WHERE id = ?').run('draft', task.id)).toThrow();
    expect(() => db.query('UPDATE design_tasks SET status = ? WHERE id = ?').run('paused', task.id)).toThrow();
    db.query(
      `INSERT INTO design_events (design_task_id, kind, data_json, ts)
       VALUES (?, 'anything', '{}', 1)`,
    ).run(task.id);
    expect(() => store.listEvents(task.id)).toThrow('invalid design event kind');
    db.close();
  });
});

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { KeyedMutex } from '../issues/mutex';
import {
  IssueEngine,
  migrateIssueEngine,
  type EngineIssue,
  type IssuePublicationBatchPort,
  type IssuePublicationPostCommitOperation,
} from '../issues/engine';
import { DesignEngine, type Actor } from './engine';
import { DesignPublisher, DesignPublisherError, renderDesignIssueBody } from './publisher';
import { DesignStore, migrateDesigns } from './store';
import type {
  DesignGraphDraft,
  DesignGraphNodeDraft,
  DesignIssueBaselineContract,
} from './types';

const owner: Actor = { id: 'user:1', role: 'owner' };
const otherOwner: Actor = { id: 'user:2', role: 'owner' };

function node(
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

function graph(): DesignGraphDraft {
  return {
    nodes: [
      node('foundation', 'Foundation'),
      node('delivery', 'Delivery', { dependencies: ['foundation'], implMode: 'team' }),
    ],
    edges: [{ fromNodeId: 'foundation', toNodeId: 'delivery', kind: 'depends_on' }],
  };
}

function bodyBoundaryNode(targetLength: number): DesignGraphNodeDraft {
  const draft = node('boundary', 'Boundary', { implementationNotes: ['x', 'x'] });
  const contract: Omit<DesignIssueBaselineContract, 'body'> = {
    schemaVersion: 1,
    designId: 1,
    revision: 1,
    nodeId: draft.nodeId,
    title: draft.title,
    goal: draft.goal!,
    background: draft.background!,
    sourceSections: draft.sourceSections!,
    scope: draft.scope!,
    nonGoals: draft.nonGoals!,
    inputs: draft.inputs!,
    outputs: draft.outputs!,
    dependencies: draft.dependencies!,
    implementationNotes: draft.implementationNotes!,
    moduleId: null,
    runtime: draft.runtime!,
    agent: 'codex',
    complexity: draft.complexity!,
    complexityRationale: draft.complexityRationale!,
    acceptanceCriteria: draft.acceptanceCriteria!,
    testRecommendations: draft.testRecommendations!,
    evidenceRequirements: draft.evidenceRequirements!,
    completionInstructions: draft.completionInstructions!,
    implMode: draft.implMode!,
  };
  let remaining = targetLength - renderDesignIssueBody(contract).length;
  if (remaining < 0 || remaining > 7_998) throw new Error('unsupported body boundary fixture');
  const firstExtra = Math.min(remaining, 3_999);
  remaining -= firstExtra;
  draft.implementationNotes = ['x'.repeat(1 + firstExtra), 'x'.repeat(1 + remaining)];
  contract.implementationNotes = draft.implementationNotes;
  if (renderDesignIssueBody(contract).length !== targetLength) throw new Error('body boundary fixture drifted');
  return draft;
}

function scalar(db: Database, sql: string): number {
  return db.query<{ n: number }, []>(sql).get()!.n;
}

function setup(opts: {
  failComplete?: number;
  graph?: DesignGraphDraft;
  hangCompleteAfterAttempt?: number;
  postCommitTimeoutMs?: number;
  executionRuns?: {
    requirePublishableIntentInTransaction(designId: number, revision: number, digest: string): unknown;
    bindPublicationInTransaction(input: {
      projectId: number; designId: number; publicationId: number; revision: number;
      graphDigest: string; updatedTs: number;
    }): unknown;
  };
} = {}) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts)
          VALUES (1, 'owner', 'hash-1', 1), (2, 'other', 'hash-2', 1)`);
  db.run(`INSERT INTO executors
            (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
          VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/workspace', '/claude')`);
  db.run(`INSERT INTO projects
            (id, name, executor_id, cwd, owner_user_id, created_ts)
          VALUES (1, 'project', 1, '/workspace/project', 1, 1)`);
  db.run(`INSERT INTO project_modules
            (id, project_id, slug, display_name, agent, source, created_by, created_ts)
          VALUES (11, 1, 'backend', 'Backend', 'codex', 'manual', 1, 1)`);

  const issueEngine = new IssueEngine({
    db,
    driver: {} as never,
    convs: {} as never,
    locator: {} as never,
    pmFor: () => ({}) as never,
    notify: { dispatch: async () => {} },
    mutex: new KeyedMutex(),
    config: { resultSummaryTimeoutMs: 0 },
  });
  let completeAttempts = 0;
  let failuresLeft = opts.failComplete ?? 0;
  let releaseHungComplete: (() => void) | null = null;
  const hungComplete = new Promise<void>((resolve) => { releaseHungComplete = resolve; });
  const completedOperations: string[] = [];
  const issuePort: IssuePublicationBatchPort = {
    prepareDesignBatch: issueEngine.prepareDesignBatch.bind(issueEngine),
    commitPreparedDesignBatch: issueEngine.commitPreparedDesignBatch.bind(issueEngine),
    async completeDesignBatch(projectId, issueIds, outbox) {
      completeAttempts++;
      if (completeAttempts === opts.hangCompleteAfterAttempt) await hungComplete;
      const operations: IssuePublicationPostCommitOperation[] = issueIds.flatMap((issueId) => {
        const issue = issueEngine.store.get(issueId)!;
        return issue.moduleId === null ? [] : [{
          key: `issue-publication:${projectId}:module-doc:${issueId}`,
          kind: 'module-doc' as const,
          projectId,
          issueId,
          issueIds,
        }];
      });
      operations.push({
        key: `issue-publication:${projectId}:scheduler:${[...issueIds].sort((a, b) => a - b).join(',')}`,
        kind: 'scheduler',
        projectId,
        issueId: null,
        issueIds,
      });
      for (const operation of operations) {
        if (failuresLeft-- > 0) {
          await outbox?.markRetry(operation, 'post-commit unavailable');
          throw new Error('post-commit unavailable');
        }
        if (!(await outbox?.isComplete(operation))) {
          completedOperations.push(operation.key);
          await outbox?.markComplete(operation);
        }
      }
    },
  };

  const store = new DesignStore(db);
  const created = store.createRevisionedTask({
    projectId: 1,
    title: 'Approved module design',
    originalRequest: 'Build the approved module safely.',
    agent: 'codex',
    documentJson: { goal: 'Ship safely' },
    documentMarkdown: '# Approved module design',
    readiness: 100,
    graph: opts.graph ?? graph(),
    actor: 'owner:user:1',
  });
  db.query("UPDATE design_tasks SET stage = 'graph_draft' WHERE id = ?").run(created.task.id);
  const approved = store.transitionStage({
    designTaskId: created.task.id,
    expectedRevision: created.task.currentRevision,
    action: 'approve_graph',
    actor: 'owner:user:1',
  });
  let now = 1_000;
  let tokenSequence = 0;
  const publisher = new DesignPublisher({
    store,
    issues: issuePort,
    now: () => now,
    tokenFactory: () => `confirmation-${++tokenSequence}`,
    executionRuns: opts.executionRuns,
    ...(opts.postCommitTimeoutMs === undefined ? {} : { postCommitTimeoutMs: opts.postCommitTimeoutMs }),
  });
  return {
    db,
    store,
    issueEngine,
    issuePort,
    publisher,
    task: approved,
    advance(ms: number) { now += ms; },
    completeAttempts: () => completeAttempts,
    releaseHungComplete() { releaseHungComplete?.(); },
    completedOperations,
  };
}

describe('DesignPublisher', () => {
  test('owner confirmation is bound to the immutable approved revision/digest and stores only its hash', () => {
    const s = setup();
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);

    expect(confirmation).toMatchObject({
      designId: s.task.id,
      revision: s.task.currentRevision,
      token: 'confirmation-1',
      orderedNodes: [
        {
          nodeId: 'foundation', title: 'Foundation', goal: 'Deliver Foundation.',
          scope: ['Foundation scope.'], nonGoals: ['Foundation non-goal.'],
          inputs: ['Foundation input.'], outputs: ['Foundation output.'], dependencies: [],
          implementationNotes: ['Implement Foundation.'], resolvedModuleId: null,
          resolvedAgent: 'codex', runtime: 'current', complexity: 'medium',
          complexityRationale: ['Foundation requires coordination.'], implMode: 'direct',
          acceptanceCriteria: ['Foundation works.'], testRecommendations: ['Test Foundation.'],
          evidenceRequirements: ['Attach Foundation evidence.'],
          completionInstructions: ['Report Foundation completion.'],
        },
        {
          nodeId: 'delivery', title: 'Delivery', goal: 'Deliver Delivery.',
          dependencies: ['foundation'], resolvedAgent: 'codex', implMode: 'team',
        },
      ],
      dependencies: [{ fromNodeId: 'foundation', toNodeId: 'delivery' }],
      topologicalOrder: ['foundation', 'delivery'],
      blockers: [],
      readiness: { score: 100, threshold: 80, override: false },
    });
    expect(confirmation.orderedNodes.every((item) => /^[0-9a-f]{64}$/.test(item.bodyDigest))).toBe(true);
    expect(confirmation.graphDigest).toMatch(/^[0-9a-f]{64}$/);
    const stored = s.db.query<{ token_hash: string }, []>(
      'SELECT token_hash FROM design_publish_confirmations',
    ).get()!;
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.token_hash).not.toContain(confirmation.token);
    expect(JSON.stringify(s.store.listEvents(s.task.id))).not.toContain(confirmation.token);
    expect(() => s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, otherOwner))
      .toThrow(DesignPublisherError);
    s.db.close();
  });

  test('confirmation exposes only a stable blocker code when an approved readiness override is active', () => {
    const s = setup();
    s.db.query('UPDATE design_revisions SET readiness = 70 WHERE design_task_id = ? AND revision = ?')
      .run(s.task.id, s.task.currentRevision);
    s.db.query('UPDATE design_tasks SET readiness_override = 1 WHERE id = ?').run(s.task.id);

    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    expect(confirmation.readiness).toEqual({ score: 70, threshold: 80, override: true });
    expect(confirmation.blockers).toEqual(['readiness_below_threshold']);
    expect(JSON.stringify(confirmation)).not.toMatch(/SQLITE|private|prompt|path/i);
    s.db.close();
  });

  test('publishes every node, dependency, immutable link, event and outbox atomically with complete Issue contracts', async () => {
    const s = setup();
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    const result = await s.publisher.publishGraph(s.task.id, {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'publish-approved-1',
    }, owner);

    expect(result.status).toBe('complete');
    expect(result.issues.map((issue) => ({ nodeId: issue.nodeId, implMode: issue.implMode }))).toEqual([
      { nodeId: 'foundation', implMode: 'direct' },
      { nodeId: 'delivery', implMode: 'team' },
    ]);
    const issues = s.issueEngine.store.listByProject(1);
    expect(confirmation.orderedNodes.map((item) => item.bodyDigest)).toEqual(
      issues.map((issue) => createHash('sha256').update(issue.body!, 'utf8').digest('hex')),
    );
    expect(issues.map((issue) => issue.implMode)).toEqual(['seq', 'team']);
    expect(issues.every((issue) => issue.publicationLocked)).toBe(true);
    expect(issues[0]!.body).toContain('## Goal');
    expect(issues[0]!.body).toContain('## Background/source');
    expect(issues[0]!.body).toContain('## Scope');
    expect(issues[0]!.body).toContain('## Non-goals');
    expect(issues[0]!.body).toContain('## Implementation');
    expect(issues[0]!.body).toContain('## Inputs/outputs');
    expect(issues[0]!.body).toContain('## Dependencies');
    expect(issues[0]!.body).toContain('## Acceptance criteria');
    expect(issues[0]!.body).toContain('## Tests');
    expect(issues[0]!.body).toContain('## Required evidence');
    expect(issues[0]!.body).toContain('## Completion report');
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issue_dependencies')).toBe(1);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_issue_links')).toBe(2);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(1);
    expect(s.store.listEvents(s.task.id).at(-1)).toMatchObject({
      kind: 'graph_published',
      data: { publicationId: result.publicationId, revision: s.task.currentRevision },
    });
    expect(s.db.query<{ completed: number; total: number }, []>(
      `SELECT COUNT(completed_ts) AS completed, COUNT(*) AS total
         FROM design_publication_outbox`,
    ).get()).toEqual({ completed: 1, total: 1 });
    s.db.query('UPDATE design_graph_nodes SET issue_id = NULL, last_synced_revision = NULL WHERE design_task_id = ?')
      .run(s.task.id);
    expect(s.store.getGraph(s.task.id).nodes.map((node) => node.issueId)).toEqual(
      result.issues.map((issue) => issue.issueId),
    );
    s.db.close();
  });

  test('same idempotency key replays consumed confirmation while a second key cannot duplicate the revision', async () => {
    const s = setup();
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    const request = {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'same-request',
    };
    const first = await s.publisher.publishGraph(s.task.id, request, owner);
    const replay = await s.publisher.publishGraph(s.task.id, {
      ...request,
      confirmationToken: 'already-consumed-and-wrong',
    }, owner);
    expect(replay).toEqual(first);
    await expect(s.publisher.publishGraph(s.task.id, request, otherOwner))
      .rejects.toMatchObject({ code: 'DESIGN_IDEMPOTENCY_CONFLICT' });
    await expect(s.publisher.publishGraph(s.task.id, {
      ...request,
      expectedRevision: s.task.currentRevision + 1,
    }, owner)).rejects.toMatchObject({ code: 'DESIGN_IDEMPOTENCY_CONFLICT' });

    const secondConfirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    await expect(s.publisher.publishGraph(s.task.id, {
      ...request,
      confirmationToken: secondConfirmation.token,
      idempotencyKey: 'different-request',
    }, owner)).rejects.toMatchObject({ code: 'DESIGN_ALREADY_PUBLISHED' });
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(2);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(1);
    s.db.close();
  });

  test('wrong actor and expired confirmation fail before any Issue is visible', async () => {
    const s = setup();
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    s.db.query('UPDATE projects SET owner_user_id = 2 WHERE id = 1').run();
    await expect(s.publisher.publishGraph(s.task.id, {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'wrong-actor',
    }, otherOwner)).rejects.toMatchObject({ code: 'DESIGN_CONFIRMATION_MISMATCH' });
    s.db.query('UPDATE projects SET owner_user_id = 1 WHERE id = 1').run();
    s.advance(5 * 60_000 + 1);
    await expect(s.publisher.publishGraph(s.task.id, {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'expired',
    }, owner)).rejects.toMatchObject({ code: 'DESIGN_CONFIRMATION_EXPIRED' });
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
    s.db.close();
  });

  test('Issue or link fault rolls back publication and leaves the one-use token reusable', async () => {
    for (const fault of ['issues', 'design_issue_links'] as const) {
      const s = setup();
      const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
      s.db.run(`CREATE TRIGGER fail_${fault} BEFORE INSERT ON ${fault}
                BEGIN SELECT RAISE(ABORT, 'fault-${fault}'); END`);
      const request = {
        expectedRevision: s.task.currentRevision,
        confirmationToken: confirmation.token,
        idempotencyKey: `rollback-${fault}`,
      };
      await expect(s.publisher.publishGraph(s.task.id, request, owner)).rejects.toThrow(`fault-${fault}`);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issue_dependencies')).toBe(0);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(0);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_issue_links')).toBe(0);
      expect(s.db.query<{ consumed_ts: number | null }, []>(
        'SELECT consumed_ts FROM design_publish_confirmations',
      ).get()!.consumed_ts).toBeNull();
      s.db.run(`DROP TRIGGER fail_${fault}`);
      const recovered = await s.publisher.publishGraph(s.task.id, request, owner);
      expect(recovered.issues).toHaveLength(2);
      s.db.close();
    }
  });

  test('post-commit failure is item-durable and a restarted publisher retries without duplicate Issues', async () => {
    const s = setup({ failComplete: 1 });
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    const request = {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'restart-retry',
    };
    const pending = await s.publisher.publishGraph(s.task.id, request, owner);
    expect(pending.status).toBe('recoverable_error');
    expect(s.completeAttempts()).toBe(1);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(2);

    const restarted = new DesignPublisher({
      store: new DesignStore(s.db),
      issues: s.issuePort,
      now: () => 2_000,
      tokenFactory: () => 'unused-after-restart',
    });
    const replay = await restarted.publishGraph(s.task.id, {
      ...request,
      confirmationToken: 'not-required-for-idempotent-replay',
    }, owner);
    expect(replay.status).toBe('complete');
    expect(replay.issues.map((issue) => issue.issueId)).toEqual(pending.issues.map((issue) => issue.issueId));
    expect(s.completeAttempts()).toBe(2);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(2);
    expect(s.completedOperations).toHaveLength(1);
    s.db.close();
  });

  test('recoverPostCommit applies a per-publication deadline instead of awaiting a hung drain forever', async () => {
    const s = setup({ failComplete: 1, hangCompleteAfterAttempt: 2, postCommitTimeoutMs: 15 });
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    const pending = await s.publisher.publishGraph(s.task.id, {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'bounded-recovery',
    }, owner);
    expect(pending.status).toBe('recoverable_error');

    s.advance(60_000);
    const recovery = s.publisher.recoverPostCommit(1);
    const bounded = await Promise.race([
      recovery.then(() => true),
      Bun.sleep(60).then(() => false),
    ]);
    s.releaseHungComplete();
    await recovery;

    expect(bounded).toBe(true);
    expect(s.store.getPublication(pending.publicationId)?.status).toBe('recoverable_error');
    s.db.close();
  });

  test('rejects non-approved, archived, stale, and malformed approved revision snapshots', () => {
    const nonApproved = setup();
    nonApproved.db.query("UPDATE design_tasks SET stage = 'graph_draft' WHERE id = ?").run(nonApproved.task.id);
    expect(() => nonApproved.publisher.issuePublishConfirmation(
      nonApproved.task.id,
      nonApproved.task.currentRevision,
      owner,
    )).toThrow(DesignPublisherError);
    nonApproved.db.close();

    const archived = setup();
    archived.db.query("UPDATE design_tasks SET status = 'archived' WHERE id = ?").run(archived.task.id);
    expect(() => archived.publisher.issuePublishConfirmation(
      archived.task.id,
      archived.task.currentRevision,
      owner,
    )).toThrow(DesignPublisherError);
    archived.db.close();

    const stale = setup();
    expect(() => stale.publisher.issuePublishConfirmation(stale.task.id, stale.task.currentRevision + 1, owner))
      .toThrow(DesignPublisherError);
    stale.db.close();

    const malformed = setup();
    malformed.db.query('UPDATE design_revisions SET graph_json = ? WHERE design_task_id = ? AND revision = ?')
      .run(JSON.stringify({ nodes: [{ nodeId: 'broken', title: 'Broken' }], edges: [] }), malformed.task.id, 1);
    expect(() => malformed.publisher.issuePublishConfirmation(
      malformed.task.id,
      malformed.task.currentRevision,
      owner,
    )).toThrow(DesignPublisherError);
    malformed.db.close();
  });

  test('same idempotency key conflicts after immutable revision bytes are illegally changed', async () => {
    const s = setup();
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, s.task.currentRevision, owner);
    const request = {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'digest-conflict',
    };
    await s.publisher.publishGraph(s.task.id, request, owner);
    const changed = graph();
    changed.nodes[0]!.goal = 'Illegally changed immutable goal.';
    s.db.query('UPDATE design_revisions SET graph_json = ? WHERE design_task_id = ? AND revision = ?')
      .run(JSON.stringify(changed), s.task.id, s.task.currentRevision);

    await expect(s.publisher.publishGraph(s.task.id, {
      ...request,
      confirmationToken: 'replay-does-not-use-token',
    }, owner)).rejects.toMatchObject({ code: 'DESIGN_IDEMPOTENCY_CONFLICT' });
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(2);
    s.db.close();
  });

  test('accepts an exactly 8000-character Issue body and rejects 8001 without truncation', async () => {
    const exact = setup({ graph: { nodes: [bodyBoundaryNode(8_000)], edges: [] } });
    const exactConfirmation = exact.publisher.issuePublishConfirmation(exact.task.id, 1, owner);
    const published = await exact.publisher.publishGraph(exact.task.id, {
      expectedRevision: 1,
      confirmationToken: exactConfirmation.token,
      idempotencyKey: 'body-8000',
    }, owner);
    expect(published.issues).toHaveLength(1);
    expect(exact.issueEngine.store.listByProject(1)[0]!.body).toHaveLength(8_000);
    exact.db.close();

    const over = setup({ graph: { nodes: [bodyBoundaryNode(8_001)], edges: [] } });
    expect(() => over.publisher.issuePublishConfirmation(over.task.id, 1, owner))
      .toThrow(DesignPublisherError);
    expect(scalar(over.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
    over.db.close();
  });

  test('module, agent, and executor capability changes between prepare and commit reject the whole batch', async () => {
    const mutations = [
      {
        break(db: Database) {
          db.query('UPDATE projects SET owner_user_id = 2 WHERE id = 1').run();
        },
        restore(db: Database) {
          db.query('UPDATE projects SET owner_user_id = 1 WHERE id = 1').run();
        },
      },
      {
        break(db: Database) { db.query("UPDATE project_modules SET sync_status = 'error' WHERE id = 11").run(); },
        restore(db: Database) { db.query("UPDATE project_modules SET sync_status = 'ready' WHERE id = 11").run(); },
      },
      {
        break(db: Database) { db.query("UPDATE project_modules SET agent = 'claude' WHERE id = 11").run(); },
        restore(db: Database) { db.query("UPDATE project_modules SET agent = 'codex' WHERE id = 11").run(); },
      },
      {
        break(db: Database) { db.query('UPDATE executors SET supports_codex = 0 WHERE id = 1').run(); },
        restore(db: Database) { db.query('UPDATE executors SET supports_codex = 1 WHERE id = 1').run(); },
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const moduleGraph: DesignGraphDraft = { nodes: [node('module-node', 'Module node', { moduleId: 11 })], edges: [] };
      const s = setup({ graph: moduleGraph });
      const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
      const prepare = s.issuePort.prepareDesignBatch.bind(s.issuePort);
      s.issuePort.prepareDesignBatch = async (...args) => {
        const prepared = await prepare(...args);
        mutation.break(s.db);
        return prepared;
      };
      const request = {
        expectedRevision: 1,
        confirmationToken: confirmation.token,
        idempotencyKey: `toctou-${index}`,
      };
      await expect(s.publisher.publishGraph(s.task.id, request, owner)).rejects.toThrow();
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(0);
      expect(s.db.query<{ consumed: number | null }, []>(
        'SELECT consumed_ts AS consumed FROM design_publish_confirmations',
      ).get()!.consumed).toBeNull();
      mutation.restore(s.db);
      s.issuePort.prepareDesignBatch = prepare;
      const recovered = await s.publisher.publishGraph(s.task.id, request, owner);
      expect(recovered.issues).toHaveLength(1);
      expect(s.db.query<{ completed: number; total: number }, []>(
        'SELECT COUNT(completed_ts) AS completed, COUNT(*) AS total FROM design_publication_outbox',
      ).get()).toEqual({ completed: 2, total: 2 });
      s.db.close();
    }
  });

  test('post-commit outbox persists one item per module document plus one scheduler item', async () => {
    const moduleGraph: DesignGraphDraft = {
      nodes: [
        node('module-a', 'Module A', { moduleId: 11 }),
        node('module-b', 'Module B', { moduleId: 11 }),
      ],
      edges: [],
    };
    const s = setup({ graph: moduleGraph });
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
    const result = await s.publisher.publishGraph(s.task.id, {
      expectedRevision: 1,
      confirmationToken: confirmation.token,
      idempotencyKey: 'item-outbox',
    }, owner);
    expect(result.status).toBe('complete');
    expect(s.db.query<{ kind: string; n: number }, []>(
      `SELECT kind, COUNT(*) AS n FROM design_publication_outbox
       GROUP BY kind ORDER BY kind`,
    ).all()).toEqual([
      { kind: 'module_index', n: 2 },
      { kind: 'scheduler', n: 1 },
    ]);
    expect(s.completedOperations).toHaveLength(3);
    expect(new Set(s.completedOperations).size).toBe(3);
    s.db.close();
  });

  test('approved stage, revision digest, and readiness are rechecked inside the shared transaction', async () => {
    const mutations = [
      {
        break(db: Database, designId: number) {
          db.query("UPDATE design_tasks SET stage = 'executing' WHERE id = ?").run(designId);
        },
        restore(db: Database, designId: number) {
          db.query("UPDATE design_tasks SET stage = 'approved' WHERE id = ?").run(designId);
        },
      },
      {
        break(db: Database, designId: number) {
          const changed = graph();
          changed.nodes[0]!.goal = 'Changed between prepare and commit.';
          db.query('UPDATE design_revisions SET graph_json = ? WHERE design_task_id = ? AND revision = 1')
            .run(JSON.stringify(changed), designId);
        },
        restore(db: Database, designId: number) {
          db.query('UPDATE design_revisions SET graph_json = ? WHERE design_task_id = ? AND revision = 1')
            .run(JSON.stringify(graph()), designId);
        },
      },
      {
        break(db: Database, designId: number) {
          db.query('UPDATE design_revisions SET readiness = 0 WHERE design_task_id = ? AND revision = 1')
            .run(designId);
        },
        restore(db: Database, designId: number) {
          db.query('UPDATE design_revisions SET readiness = 100 WHERE design_task_id = ? AND revision = 1')
            .run(designId);
        },
      },
    ];
    for (const [index, mutation] of mutations.entries()) {
      const s = setup();
      const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
      const prepare = s.issuePort.prepareDesignBatch.bind(s.issuePort);
      s.issuePort.prepareDesignBatch = async (...args) => {
        const prepared = await prepare(...args);
        mutation.break(s.db, s.task.id);
        return prepared;
      };
      const request = {
        expectedRevision: 1,
        confirmationToken: confirmation.token,
        idempotencyKey: `design-toctou-${index}`,
      };
      await expect(s.publisher.publishGraph(s.task.id, request, owner)).rejects.toThrow();
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
      expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(0);
      expect(s.db.query<{ consumed: number | null }, []>(
        'SELECT consumed_ts AS consumed FROM design_publish_confirmations',
      ).get()!.consumed).toBeNull();
      mutation.restore(s.db, s.task.id);
      s.issuePort.prepareDesignBatch = prepare;
      expect((await s.publisher.publishGraph(s.task.id, request, owner)).issues).toHaveLength(2);
      s.db.close();
    }
  });

  test('every publication write fault rolls back all domains and preserves the token', async () => {
    const faults = [
      { name: 'token', sql: `CREATE TRIGGER fail_token BEFORE UPDATE ON design_publish_confirmations
                              BEGIN SELECT RAISE(ABORT, 'fault-token'); END` },
      { name: 'publication', sql: `CREATE TRIGGER fail_publication BEFORE INSERT ON design_publications
                                    BEGIN SELECT RAISE(ABORT, 'fault-publication'); END` },
      { name: 'nth_issue', sql: `CREATE TRIGGER fail_nth_issue BEFORE INSERT ON issues
                                  WHEN NEW.publication_locked = 1
                                   AND (SELECT COUNT(*) FROM issues WHERE publication_locked = 1) = 1
                                  BEGIN SELECT RAISE(ABORT, 'fault-nth-issue'); END` },
      { name: 'dependency', sql: `CREATE TRIGGER fail_dependency BEFORE INSERT ON issue_dependencies
                                   BEGIN SELECT RAISE(ABORT, 'fault-dependency'); END` },
      { name: 'link', sql: `CREATE TRIGGER fail_link BEFORE INSERT ON design_issue_links
                             BEGIN SELECT RAISE(ABORT, 'fault-link'); END` },
      { name: 'event', sql: `CREATE TRIGGER fail_event BEFORE INSERT ON design_events
                              WHEN NEW.kind = 'graph_published'
                              BEGIN SELECT RAISE(ABORT, 'fault-event'); END` },
      { name: 'outbox', sql: `CREATE TRIGGER fail_outbox BEFORE INSERT ON design_publication_outbox
                               BEGIN SELECT RAISE(ABORT, 'fault-outbox'); END` },
    ];
    for (const fault of faults) {
      const s = setup();
      const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
      s.db.run(fault.sql);
      const request = {
        expectedRevision: 1,
        confirmationToken: confirmation.token,
        idempotencyKey: `fault-${fault.name}`,
      };
      await expect(s.publisher.publishGraph(s.task.id, request, owner)).rejects.toThrow(
        `fault-${fault.name.replace('_', '-')}`,
      );
      for (const table of [
        'issues',
        'issue_events',
        'issue_dependencies',
        'design_publications',
        'design_issue_links',
        'design_publication_outbox',
      ]) {
        expect(scalar(s.db, `SELECT COUNT(*) AS n FROM ${table}`), `${fault.name}:${table}`).toBe(0);
      }
      expect(s.store.listEvents(s.task.id).some((event) => event.kind === 'graph_published')).toBe(false);
      expect(s.db.query<{ consumed: number | null }, []>(
        'SELECT consumed_ts AS consumed FROM design_publish_confirmations',
      ).get()!.consumed).toBeNull();
      s.db.run(`DROP TRIGGER fail_${fault.name}`);
      expect((await s.publisher.publishGraph(s.task.id, request, owner)).issues).toHaveLength(2);
      s.db.close();
    }
  });

  test('design linkage callback observes the Issue batch shared transaction', async () => {
    const s = setup();
    let observedInTransaction = false;
    const commit = s.store.commitPublicationInTransaction.bind(s.store);
    s.store.commitPublicationInTransaction = (input) => {
      observedInTransaction = s.db.inTransaction;
      return commit(input);
    };
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
    await s.publisher.publishGraph(s.task.id, {
      expectedRevision: 1,
      confirmationToken: confirmation.token,
      idempotencyKey: 'shared-transaction',
    }, owner);
    expect(observedInTransaction).toBe(true);
    s.db.close();
  });

  test('guards and binds the exact execution intent inside the shared publication transaction', async () => {
    const calls: string[] = [];
    let db: Database | null = null;
    const s = setup({
      executionRuns: {
        requirePublishableIntentInTransaction(designId, revision, digest) {
          expect(db?.inTransaction).toBe(true);
          calls.push(`guard:${designId}:${revision}:${digest}`);
        },
        bindPublicationInTransaction(input) {
          expect(db?.inTransaction).toBe(true);
          calls.push(`bind:${input.designId}:${input.publicationId}:${input.revision}:${input.graphDigest}`);
        },
      },
    });
    db = s.db;
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
    const result = await s.publisher.publishGraph(s.task.id, {
      expectedRevision: 1,
      confirmationToken: confirmation.token,
      idempotencyKey: 'execution-intent-transaction',
    }, owner);
    expect(calls).toEqual([
      `guard:${s.task.id}:1:${result.graphDigest}`,
      `bind:${s.task.id}:${result.publicationId}:1:${result.graphDigest}`,
    ]);
    s.db.close();
  });

  test('an unavailable execution intent fails as typed not-ready and rolls back every Issue', async () => {
    const s = setup({
      executionRuns: {
        requirePublishableIntentInTransaction() { throw new Error('/private/worktree/path'); },
        bindPublicationInTransaction() { throw new Error('unreachable'); },
      },
    });
    const confirmation = s.publisher.issuePublishConfirmation(s.task.id, 1, owner);
    try {
      await s.publisher.publishGraph(s.task.id, {
        expectedRevision: 1,
        confirmationToken: confirmation.token,
        idempotencyKey: 'execution-intent-missing',
      }, owner);
      throw new Error('expected publication to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(DesignPublisherError);
      expect((error as DesignPublisherError).code).toBe('DESIGN_NOT_READY');
      expect(String(error)).not.toContain('/private/worktree/path');
    }
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM issues')).toBe(0);
    expect(scalar(s.db, 'SELECT COUNT(*) AS n FROM design_publications')).toBe(0);
    s.db.close();
  });

  test('DesignEngine exposes the publisher only through owner actions', async () => {
    const s = setup();
    const engine = new DesignEngine({
      store: s.store,
      scope: {
        projectExists: () => true,
        getModule: () => null,
        supportsAgent: () => true,
      },
      conversations: {
        createDesignConversation: async () => ({ conversationId: 'unused', created: false, ownershipProof: null }),
        activateDesignConversation: async () => {},
        archiveDesignConversation: async () => {},
        deleteDesignConversation: async () => true,
      },
      publisher: s.publisher,
    });
    expect(() => engine.issuePublishConfirmation(
      s.task.id,
      { expectedRevision: s.task.currentRevision },
      { id: 'reviewer', role: 'reviewer' },
    )).toThrow(DesignPublisherError);
    const confirmation = engine.issuePublishConfirmation(
      s.task.id,
      { expectedRevision: s.task.currentRevision },
      owner,
    );
    const result = await engine.publishGraph(s.task.id, {
      expectedRevision: s.task.currentRevision,
      confirmationToken: confirmation.token,
      idempotencyKey: 'engine-publish',
    }, owner);
    expect(result.issues).toHaveLength(2);
    s.db.close();
  });
});

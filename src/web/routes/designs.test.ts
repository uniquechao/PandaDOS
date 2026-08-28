import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import {
  DesignEngine,
  type Actor,
  type DesignConversationOps,
  type DesignScopeOps,
} from '../../designs/engine';
import {
  DesignPublisherError,
  type DesignPublisherPort,
} from '../../designs/publisher';
import { DesignPersonaRegistry } from '../../designs/personas';
import type { ReadinessDimension, ReadinessInput } from '../../designs/readiness';
import { DesignStore, migrateDesigns } from '../../designs/store';
import { DesignSyncError } from '../../designs/sync';
import { IssueStore, migrateIssueEngine } from '../../issues/engine';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { designsRoutes } from './designs';

const steward: Actor = { id: 'internal:design-steward', role: 'design_steward' };
const dimensions: ReadinessDimension[] = [
  'goal_clarity',
  'scope_boundaries',
  'solution_completeness',
  'dependencies_constraints',
  'acceptance_testability',
  'risks_unknowns',
];

function readiness(score: number): ReadinessInput {
  return {
    dimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, {
      score,
      evidencePaths: [`document.${dimension}`],
      missingItems: [],
      nextQuestions: [],
    }])) as ReadinessInput['dimensions'],
  };
}

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  const member = users.create('member');
  db.run(
    `INSERT INTO executors
       (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir,
        supports_claude, supports_codex)
     VALUES (1, 'local', '127.0.0.1', 22, 'root', '', '/workspace', '/claude', 1, 1)`,
  );
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'first', 1, '/workspace/first', ?, 1),
            (2, 'second', 1, '/workspace/second', ?, 2)`,
  ).run(alice.user.id, alice.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 1)')
    .run(member.user.id);
  db.query(
    `INSERT INTO project_modules
       (id, project_id, slug, display_name, agent, source, created_by, created_ts)
     VALUES (11, 1, 'api-server', 'API server', 'codex', 'manual', ?, 1),
            (22, 2, 'other-module', 'Other module', 'claude', 'manual', ?, 1)`,
  ).run(alice.user.id, alice.user.id);

  const activated: string[] = [];
  const archived: string[] = [];
  const failures = { activate: 0, archive: 0 };
  const conversations: DesignConversationOps = {
    async createDesignConversation(input) {
      const id = input.conversationId;
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
      const ownership = db.query<{ token: string }, [string]>(
        `SELECT saga_token AS token FROM design_saga_conversation_owners
         WHERE conversation_id = ?`,
      ).get(id);
      return {
        conversationId: id,
        created: inserted !== null && inserted !== undefined,
        ownershipProof: ownership?.token === input.sagaToken ? input.sagaToken : null,
      };
    },
    async activateDesignConversation(id) {
      if (failures.activate-- > 0) throw new Error('activate failed');
      activated.push(id);
    },
    async archiveDesignConversation(id) {
      if (failures.archive-- > 0) throw new Error('strict archive failed');
      archived.push(id);
      db.query('UPDATE conversations SET archived = 1 WHERE id = ?').run(id);
    },
    async deleteDesignConversation({ conversationId, ownershipProof }) {
      const conversation = db.query<{ found: number }, [string]>(
        'SELECT 1 AS found FROM conversations WHERE id = ?',
      ).get(conversationId);
      if (!conversation) return true;
      const existing = db.query<{ token: string }, [string]>(
        `SELECT saga_token AS token FROM design_saga_conversation_owners
         WHERE conversation_id = ?`,
      ).get(conversationId);
      if (existing?.token !== ownershipProof) return false;
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
  const scope: DesignScopeOps = {
    projectExists(projectId) {
      return db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(projectId)!.n === 1;
    },
    getModule(moduleId) {
      return db.query<{ projectId: number; agent: 'claude' | 'codex' }, [number]>(
        'SELECT project_id AS projectId, agent FROM project_modules WHERE id = ?',
      ).get(moduleId) ?? null;
    },
    supportsAgent(projectId, agent) {
      const row = db.query<{ supportsClaude: number; supportsCodex: number }, [number]>(
        `SELECT e.supports_claude AS supportsClaude, e.supports_codex AS supportsCodex
         FROM projects p JOIN executors e ON e.id = p.executor_id WHERE p.id = ?`,
      ).get(projectId);
      return agent === 'claude' ? row?.supportsClaude === 1 : row?.supportsCodex === 1;
    },
  };
  const publishCalls: Array<{ kind: string; designId: number; input?: unknown; actor: Actor }> = [];
  let publisherFailure: unknown = null;
  const publication = {
    publicationId: 71,
    designId: 1,
    projectId: 1,
    revision: 3,
    graphDigest: 'digest-safe',
    status: 'recoverable_error' as const,
    error: 'SQLITE_ERROR at /private/secret.db token_hash=abc',
    issues: [{ nodeId: 'api', issueId: 91, title: 'Expose API', implMode: 'direct' as const, moduleId: 11, agent: 'codex' as const }],
  };
  const publisher: DesignPublisherPort = {
    issuePublishConfirmation(designId, expectedRevision, actor) {
      publishCalls.push({ kind: 'confirmation', designId, input: { expectedRevision }, actor });
      if (publisherFailure) throw publisherFailure;
      return {
        designId,
        projectId: 1,
        revision: expectedRevision,
        graphDigest: 'digest-safe',
        token: 'confirmation-token',
        expiresTs: 123_456,
        orderedNodes: [],
        topologicalOrder: [],
        dependencies: [],
        blockers: [],
        readiness: { score: 100, threshold: 80, override: false },
      };
    },
    async publishGraph(designId, input, actor) {
      publishCalls.push({ kind: 'publish', designId, input, actor });
      if (publisherFailure) throw publisherFailure;
      return { ...publication, designId, revision: input.expectedRevision };
    },
    listPublications(designId) {
      publishCalls.push({ kind: 'list', designId, actor: { id: 'system:list', role: 'independent_verifier' } });
      if (publisherFailure) throw publisherFailure;
      return [{ ...publication, designId }];
    },
  };
  const syncCalls: Array<{ kind: string; designId: number; syncId?: number; input?: unknown }> = [];
  let syncFailure: unknown = null;
  const sync = {
    listSyncs(designId: number) {
      syncCalls.push({ kind: 'list', designId });
      if (syncFailure) throw syncFailure;
      return [{
        linkId: 81,
        nodeId: 'api',
        issueId: 91,
        targetRevision: 1,
        state: 'conflict',
        executionSyncId: 61,
        decisionState: 'boundary_waiting',
        fields: [{ field: 'title', kind: 'conflict', base: 'Base', local: 'Local', incoming: 'Incoming' }],
        recovery: { pending: false, resolutionRequired: false },
      }];
    },
    async decideScoped(designId: number, syncId: number, expectedRevision: number, decision: string, actor: number) {
      syncCalls.push({ kind: 'decide', designId, syncId, input: { expectedRevision, decision, actor } });
      if (syncFailure) throw syncFailure;
      return { linkId: 81, nodeId: 'api', issueId: 91, targetRevision: expectedRevision,
        state: decision === 'supplement' ? 'current' : 'recovery_pending', executionSyncId: syncId,
        supplementIssueId: decision === 'supplement' ? 92 : null, repeated: false };
    },
    resolveScopedRecovery(designId: number, syncId: number, expectedRevision: number, resolution: string) {
      syncCalls.push({ kind: 'recover', designId, syncId, input: { expectedRevision, resolution } });
      if (syncFailure) throw syncFailure;
      return { linkId: 81, nodeId: 'api', issueId: 91, targetRevision: expectedRevision,
        state: resolution === 'confirm_delivered' ? 'current' : 'recovery_pending', executionSyncId: syncId,
        supplementIssueId: null, repeated: false };
    },
  };
  const store = new DesignStore(db);
  const engine = new DesignEngine({ store, scope, conversations, publisher });
  const personas = new DesignPersonaRegistry(db);
  const dispatch = createDispatcher(designsRoutes({
    db,
    engine,
    store,
    sync: sync as any,
    personas,
    assetCapability: () => ({ available: false, error: '/private/provider-secret' }),
  }), authDepsFromDb(db, users));

  const call = async (
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ) => {
    const request = new Request(`http://test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await dispatch(request)!;
    return { status: response.status, headers: response.headers, body: await response.json() as any };
  };

  return {
    db, users, admin, alice, bob, member, store, engine, activated, archived, failures, call,
    publishCalls, syncCalls,
    setPublisherFailure(error: unknown) { publisherFailure = error; },
    setSyncFailure(error: unknown) { syncFailure = error; },
  };
}

async function createDesign(
  s: ReturnType<typeof setup>,
  overrides: Record<string, unknown> = {},
) {
  return s.call('POST', '/api/projects/1/designs', s.alice.token, {
    title: 'Safe rollout',
    originalRequest: 'Design a safe rollout.',
    agent: 'codex',
    ...overrides,
  });
}

describe('design routes', () => {
  test('returns one revision-bound safe workbench aggregate with full readiness and structured findings', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    await s.engine.confirmGoal(id, { expectedRevision: 1 }, { id: `user:${s.alice.user.id}`, role: 'owner' });
    await s.engine.applyStewardRevision(id, {
      expectedRevision: 1,
      documentJson: { goal: 'Ship safely' },
      documentMarkdown: '# Safe design',
      readiness: readiness(90),
      nextStage: 'review',
    }, steward);
    await s.engine.requestReview(id, {
      sourceRevision: 2,
      persona: 'security-reviewer',
      findings: [{
        dimension: 'risks_unknowns',
        severity: 'warning',
        finding: 'Rollback ownership is unclear.',
        evidence: ['document.risks'],
        proposedPatch: { risks: ['Assign rollback owner'] },
      }],
    }, { id: 'persona:security-reviewer', role: 'reviewer' });
    s.store.ensureAgentRunGroup({
      id: 'workbench-run',
      designTaskId: id,
      projectId: 1,
      idempotencyKey: 'workbench-run-1',
      requestDigest: 'safe-digest',
      mode: 'review',
      sourceRevision: 2,
      message: null,
      personaKeys: ['builtin:general-reviewer', 'builtin:design-steward'],
      createdByUserId: s.alice.user.id,
      now: 50,
    });
    const issue = new IssueStore(s.db).create(1, {
      title: 'Linked implementation',
      body: 'Safe body',
      category: 'task',
      agent: 'codex',
    });
    s.db.query(
      `INSERT INTO design_publications
         (id, design_task_id, project_id, revision, graph_digest, actor_key,
          idempotency_key, status, error, created_ts, updated_ts)
       VALUES (71, ?, 1, 2, ?, 'user:1', 'workbench-publication', 'recoverable_error', ?, 60, 61)`,
    ).run(id, '1'.repeat(64), 'SQLITE_ERROR /private/secret.db');
    s.db.query(
      `INSERT INTO design_issue_links
         (id, publication_id, design_task_id, project_id, node_id, issue_id, link_kind,
          source_revision, last_synced_revision, original_impl_mode, baseline_contract_json,
          baseline_contract_digest, sync_state, sync_error, created_ts, updated_ts)
       VALUES (81, 71, ?, 1, 'api', ?, 'primary', 2, 2, 'direct', ?, ?, 'conflict', ?, 60, 61)`,
    ).run(id, issue.id, JSON.stringify({ title: 'Linked implementation' }), '2'.repeat(64), 'raw sync secret');

    const response = await s.call('GET', `/api/projects/1/designs/${id}/workbench`, s.member.token);
    expect(response.status).toBe(200);
    expect(response.body.workbench).toMatchObject({
      design: { id, currentRevision: 2 },
      revision: { revision: 2, documentMarkdown: '# Safe design' },
      readinessReport: { aggregate: 90, threshold: 80 },
      graph: { nodes: [], edges: [] },
      graphValidation: { valid: true, errors: [] },
      findings: [{
        persona: 'security-reviewer',
        sourceRevision: 2,
        dimension: 'risks_unknowns',
        severity: 'warning',
        finding: 'Rollback ownership is unclear.',
        evidence: ['document.risks'],
        proposedPatch: { risks: ['Assign rollback owner'] },
      }],
      permissions: { owner: false, canEdit: false, canRun: false, canPublish: false },
    });
    expect(response.body.workbench.readinessReport.dimensions).toHaveLength(6);
    expect(response.body.workbench).toHaveProperty('linkedIssues');
    expect(response.body.workbench).toHaveProperty('enabledPersonas');
    expect(response.body.workbench.enabledPersonas).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'builtin:goal-coach', role: 'goal_coach' }),
      expect.objectContaining({ key: 'builtin:design-steward', role: 'design_steward' }),
    ]));
    expect(response.body.workbench).toHaveProperty('latestRun');
    expect(response.body.workbench.latestRun).toMatchObject({ id: 'workbench-run', status: 'queued' });
    expect(response.body.workbench.publications).toEqual([
      expect.objectContaining({ publicationId: 71, status: 'recoverable_error' }),
    ]);
    expect(response.body.workbench.linkedIssues).toEqual([
      expect.objectContaining({
        linkId: 81,
        issueId: issue.id,
        status: 'pending',
        syncState: 'conflict',
        latestSync: expect.objectContaining({
          targetRevision: 1,
          fields: [{ field: 'title', kind: 'conflict', base: 'Base', local: 'Local', incoming: 'Incoming' }],
        }),
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/prompt|promptPath|worktreeCwd|lastError|syncError|SQLITE|private\/secret/i);

    const cross = await s.call('GET', `/api/projects/2/designs/${id}/workbench`, s.alice.token);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('design.not_found');
    s.db.close();
  });

  test('changes graph granularity through an exact owner-only revision contract', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const path = `/api/projects/1/designs/${id}/granularity`;

    const changed = await s.call('PATCH', path, s.alice.token, {
      expectedRevision: 1,
      granularity: 'atomic',
    });
    expect(changed.status).toBe(200);
    expect(changed.body.design).toMatchObject({ id, currentRevision: 2, graphGranularity: 'atomic' });
    expect(s.store.getRevision(id, 2)).not.toBeNull();
    expect(s.store.listEvents(id).at(-1)).toMatchObject({
      kind: 'document_revised',
      data: expect.objectContaining({ revision: 2, graphGranularity: 'atomic' }),
    });

    s.db.query("UPDATE design_tasks SET stage = 'approved' WHERE id = ?").run(id);
    const invalidatedApproval = await s.call('PATCH', path, s.alice.token, {
      expectedRevision: 2,
      granularity: 'module',
    });
    expect(invalidatedApproval.body.design).toMatchObject({
      currentRevision: 3,
      graphGranularity: 'module',
      stage: 'graph_draft',
    });

    const stale = await s.call('PATCH', path, s.alice.token, {
      expectedRevision: 1,
      granularity: 'small',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({
      code: 'design.revision_conflict',
      params: { currentRevision: 3 },
    });
    expect((await s.call('PATCH', path, s.member.token, {
      expectedRevision: 3,
      granularity: 'small',
    })).status).toBe(403);
    for (const body of [
      { expectedRevision: 3, granularity: 'issue' },
      { expectedRevision: 3, granularity: 'huge' },
      { expectedRevision: 3, granularity: 'small', extra: true },
      { granularity: 'small' },
    ]) {
      expect((await s.call('PATCH', path, s.alice.token, body)).status).toBe(400);
    }
    s.db.close();
  });

  test('lists safe per-field sync views for project members and hides cross-project designs', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const listed = await s.call('GET', `/api/projects/1/designs/${id}/syncs`, s.member.token);
    expect(listed.status).toBe(200);
    expect(listed.body.syncs).toEqual([expect.objectContaining({
      linkId: 81,
      state: 'conflict',
      fields: [{ field: 'title', kind: 'conflict', base: 'Base', local: 'Local', incoming: 'Incoming' }],
      recovery: { pending: false, resolutionRequired: false },
    })]);
    expect(JSON.stringify(listed.body)).not.toMatch(/diffJson|deferred|deliveryToken|SQLITE|secret/i);

    const cross = await s.call('GET', `/api/projects/2/designs/${id}/syncs`, s.alice.token);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('design.not_found');
    expect(s.syncCalls.filter((call) => call.kind === 'list')).toHaveLength(1);
    s.db.close();
  });

  test('applies, ignores, supplements, and resolves recovery through strict owner-only revision contracts', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    for (const action of ['apply', 'ignore'] as const) {
      const response = await s.call(
        'POST', `/api/projects/1/designs/${id}/syncs/61/${action}`, s.alice.token,
        { expectedRevision: 1 },
      );
      expect(response.status).toBe(200);
      expect(response.body.sync).toMatchObject({ executionSyncId: 61, state: 'recovery_pending' });
    }
    const supplement = await s.call(
      'POST', `/api/projects/1/designs/${id}/syncs/61/supplement`, s.alice.token,
      { expectedRevision: 1 }, { 'Idempotency-Key': 'sync-supplement-61-r1' },
    );
    expect(supplement.status).toBe(200);
    expect(supplement.headers.get('Idempotency-Key')).toBe('sync-supplement-61-r1');

    for (const resolution of ['confirm_delivered', 'retry'] as const) {
      const response = await s.call(
        'POST', `/api/projects/1/designs/${id}/syncs/61/recovery`, s.alice.token,
        { expectedRevision: 1, resolution },
      );
      expect(response.status).toBe(200);
      expect(response.body.sync.state).toBe(resolution === 'confirm_delivered' ? 'current' : 'recovery_pending');
    }
    expect((await s.call(
      'POST', `/api/projects/1/designs/${id}/syncs/61/apply`, s.member.token, { expectedRevision: 1 },
    )).status).toBe(403);
    s.db.close();
  });

  test('rejects unknown sync fields, unsafe ids/revisions, stale revisions, and missing supplement keys', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const base = `/api/projects/1/designs/${id}/syncs`;
    for (const [path, body, headers] of [
      [`${base}/61/apply`, {}, {}],
      [`${base}/61/apply`, { expectedRevision: 1, targetRevision: 1 }, {}],
      [`${base}/61/apply`, { expectedRevision: 0 }, {}],
      [`${base}/61/recovery`, { expectedRevision: 1, resolution: 'auto' }, {}],
      [`${base}/61/recovery`, { expectedRevision: 1, resolution: 'retry', extra: true }, {}],
      [`${base}/61/supplement`, { expectedRevision: 1 }, {}],
    ] as const) {
      const response = await s.call('POST', path, s.alice.token, body, headers);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('design.invalid_request');
    }
    expect((await s.call('POST', `${base}/0/apply`, s.alice.token, { expectedRevision: 1 })).status).toBe(404);
    for (const unsafeId of ['01', '+1', '1e2', '9007199254740992']) {
      const response = await s.call('POST', `${base}/${unsafeId}/apply`, s.alice.token, { expectedRevision: 1 });
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('design.sync_not_found');
    }
    expect((await s.call('POST', `${base}/61/apply`, s.alice.token, { expectedRevision: 2 })).body.error)
      .toMatchObject({ code: 'design.sync_stale', params: { currentRevision: 1 } });
    s.db.close();
  });

  test('maps scoped sync failures without leaking foreign diffs or database details', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const path = `/api/projects/1/designs/${id}/syncs/61/apply`;
    s.setSyncFailure(new DesignSyncError('DESIGN_SYNC_NOT_FOUND', 'foreign project diff secret'));
    const foreign = await s.call('POST', path, s.alice.token, { expectedRevision: 1 });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('design.sync_not_found');
    expect(JSON.stringify(foreign.body)).not.toContain('secret');

    s.setSyncFailure(new Error('SQLITE_ERROR /private/secret.db diff_json=hidden'));
    const unknown = await s.call('POST', path, s.alice.token, { expectedRevision: 1 });
    expect(unknown.status).toBe(500);
    expect(unknown.body.error.code).toBe('design.operation_failed');
    expect(JSON.stringify(unknown.body)).not.toMatch(/SQLITE|private|diff_json/);
    s.db.close();
  });
  test('publishes through strict owner-only confirmation and idempotent publish contracts', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;

    const confirmation = await s.call(
      'POST', `/api/projects/1/designs/${id}/graph/publish-confirmation`, s.alice.token,
      { expectedRevision: 3 },
    );
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.confirmation).toMatchObject({
      designId: id,
      revision: 3,
      token: 'confirmation-token',
      topologicalOrder: [],
      blockers: [],
      readiness: { score: 100, threshold: 80, override: false },
    });

    const published = await s.call(
      'POST', `/api/projects/1/designs/${id}/graph/publish`, s.alice.token,
      { expectedRevision: 3, confirmationToken: 'confirmation-token' },
      { 'Idempotency-Key': 'publish:design-1:revision-3' },
    );
    expect(published.status).toBe(200);
    expect(published.headers.get('Idempotency-Key')).toBe('publish:design-1:revision-3');
    expect(published.body.publication).toMatchObject({
      publicationId: 71,
      designId: id,
      revision: 3,
      status: 'recoverable_error',
      issues: [{ issueId: 91 }],
    });
    expect(published.body.publication.error).toBeUndefined();
    expect(JSON.stringify(published.body)).not.toContain('secret.db');
    expect(s.publishCalls.at(-1)).toMatchObject({
      kind: 'publish',
      designId: id,
      input: {
        expectedRevision: 3,
        confirmationToken: 'confirmation-token',
        idempotencyKey: 'publish:design-1:revision-3',
      },
      actor: { id: `user:${s.alice.user.id}`, role: 'owner' },
    });
    s.db.close();
  });

  test('rejects malformed publication bodies, unknown fields, unsafe revisions, and missing keys', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const confirmationPath = `/api/projects/1/designs/${id}/graph/publish-confirmation`;
    const publishPath = `/api/projects/1/designs/${id}/graph/publish`;

    for (const body of [
      null,
      [],
      { expectedRevision: 0 },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { expectedRevision: 1, extra: true },
    ]) {
      const response = await s.call('POST', confirmationPath, s.alice.token, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('design.invalid_request');
    }

    for (const [body, headers] of [
      [{ expectedRevision: 1, confirmationToken: 'token' }, {}],
      [{ expectedRevision: 1, confirmationToken: '' }, { 'Idempotency-Key': 'key' }],
      [{ expectedRevision: 1, confirmationToken: ' token' }, { 'Idempotency-Key': 'key' }],
      [{ expectedRevision: 1, confirmationToken: 'token', extra: 1 }, { 'Idempotency-Key': 'key' }],
      [{ expectedRevision: 1, confirmationToken: 'token' }, { 'Idempotency-Key': 'contains space' }],
      [{ expectedRevision: 1, confirmationToken: 'token' }, { 'Idempotency-Key': 'x'.repeat(257) }],
    ] as const) {
      const response = await s.call('POST', publishPath, s.alice.token, body, headers);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('design.invalid_request');
    }
    expect(s.publishCalls.filter((call) => call.kind !== 'list')).toEqual([]);
    s.db.close();
  });

  test('lists safe publication projections for project members and hides cross-project designs', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const list = await s.call('GET', `/api/projects/1/designs/${id}/publications`, s.member.token);
    expect(list.status).toBe(200);
    expect(list.body.publications).toHaveLength(1);
    expect(list.body.publications[0]).toMatchObject({ publicationId: 71, designId: id });
    expect(list.body.publications[0].error).toBeUndefined();
    expect(JSON.stringify(list.body)).not.toContain('token_hash');

    const cross = await s.call('GET', `/api/projects/2/designs/${id}/publications`, s.alice.token);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('design.not_found');
    expect(s.publishCalls.filter((call) => call.kind === 'list')).toHaveLength(1);
    s.db.close();
  });

  test('maps typed publisher failures and redacts unknown internals', async () => {
    const s = setup();
    const id = (await createDesign(s)).body.design.id as number;
    const path = `/api/projects/1/designs/${id}/graph/publish-confirmation`;
    s.setPublisherFailure(new DesignPublisherError('DESIGN_CONFIRMATION_EXPIRED', 'token_hash abc expired'));
    const typed = await s.call('POST', path, s.alice.token, { expectedRevision: 1 });
    expect(typed.status).toBe(409);
    expect(typed.body.error).toEqual(expect.objectContaining({
      code: 'design.confirmation_expired',
      params: {},
    }));
    expect(typed.body.error.details).toBeUndefined();

    s.setPublisherFailure(new Error('SQLITE_ERROR /private/data.db token_hash=abc'));
    const unknown = await s.call('POST', path, s.alice.token, { expectedRevision: 1 });
    expect(unknown.status).toBe(500);
    expect(unknown.body.error.code).toBe('design.operation_failed');
    expect(unknown.body.error.details).toBeUndefined();
    expect(JSON.stringify(unknown.body)).not.toContain('SQLITE');
    s.db.close();
  });

  test('uses a strict header-first idempotency key, generates one when absent, and replays one task', async () => {
    const s = setup();
    const generated = await createDesign(s);
    expect(generated.status).toBe(200);
    expect(generated.body.idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(generated.headers.get('Idempotency-Key')).toBe(generated.body.idempotencyKey);

    const request = {
      title: 'Header-owned design',
      originalRequest: 'Create exactly once.',
      agent: 'codex',
      requestKey: 'body-key',
    };
    const [first, concurrent] = await Promise.all([
      s.call('POST', '/api/projects/1/designs', s.alice.token, request, { 'Idempotency-Key': 'header-key' }),
      s.call('POST', '/api/projects/1/designs', s.alice.token, request, { 'Idempotency-Key': 'header-key' }),
    ]);
    const replay = await s.call(
      'POST', '/api/projects/1/designs', s.alice.token, request, { 'Idempotency-Key': 'header-key' },
    );
    expect(first.body.idempotencyKey).toBe('header-key');
    expect(concurrent.body.design.id).toBe(first.body.design.id);
    expect(replay.body.design.id).toBe(first.body.design.id);
    expect(s.store.getCreationSaga(1, 'header-key')?.taskId).toBe(first.body.design.id);
    expect(s.store.getCreationSaga(1, 'body-key')).toBeNull();

    for (const [headers, body] of [
      [{ 'Idempotency-Key': 'contains space' }, request],
      [{ 'Idempotency-Key': 'x'.repeat(129) }, request],
      [{}, { ...request, requestKey: 7 }],
    ] as const) {
      const invalid = await s.call('POST', '/api/projects/1/designs', s.alice.token, body, headers);
      expect(invalid.status).toBe(400);
      expect(invalid.body.error.code).toBe('design.invalid_request');
    }
    s.db.close();
  });

  test('returns a generated key on setup failure so the caller can retry the same saga', async () => {
    const s = setup();
    s.failures.activate = 1;
    const failed = await createDesign(s);
    const key = failed.headers.get('Idempotency-Key');
    expect(failed.status).toBe(502);
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    expect(failed.body.error.params).toEqual({ idempotencyKey: key });

    const retried = await s.call('POST', '/api/projects/1/designs', s.alice.token, {
      title: 'Safe rollout', originalRequest: 'Design a safe rollout.', agent: 'codex',
    }, { 'Idempotency-Key': key! });
    expect(retried.status).toBe(200);
    expect(retried.body.idempotencyKey).toBe(key);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
    s.db.close();
  });

  test('rejects reuse of an idempotency key for a different normalized request', async () => {
    const s = setup();
    const headers = { 'Idempotency-Key': 'request-conflict' };
    expect((await s.call('POST', '/api/projects/1/designs', s.alice.token, {
      title: 'First', originalRequest: 'First request.', agent: 'codex',
    }, headers)).status).toBe(200);
    const conflict = await s.call('POST', '/api/projects/1/designs', s.alice.token, {
      title: 'Second', originalRequest: 'Different request.', agent: 'codex',
    }, headers);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({ code: 'design.idempotency_conflict', params: {} });
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n).toBe(1);
    s.db.close();
  });

  test('keeps incomplete saga tasks out of list and detail responses', async () => {
    const s = setup();
    const saga = s.store.ensureCreationSaga({
      sagaToken: 'saga-hidden',
      projectId: 1,
      idempotencyKey: 'request-hidden',
      requestJson: '{}',
      conversationId: 'conv-hidden',
    }).saga;
    const task = s.store.createCreationSagaTask(saga.sagaToken, 'intent', {
      projectId: 1,
      title: 'Hidden',
      originalRequest: 'Still creating.',
      agent: 'codex',
      documentJson: {},
      documentMarkdown: '# Hidden',
      readiness: 0,
      actor: 'owner:user:1',
    })!.task;

    const list = await s.call('GET', '/api/projects/1/designs', s.alice.token);
    const detail = await s.call('GET', `/api/projects/1/designs/${task.id}`, s.alice.token);
    expect(list.body.designs).toEqual([]);
    expect(detail.status).toBe(404);
    expect(detail.body.error.code).toBe('design.not_found');
    s.db.close();
  });

  test('authorizes through project access and supports list/create/detail without a module', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/projects/1/designs', null)).status).toBe(401);
    expect((await s.call('GET', '/api/projects/1/designs', s.bob.token)).status).toBe(403);

    const originalRequest = '  Design a safe rollout.\nKeep this spacing.  ';
    const created = await createDesign(s, {
      originalRequest,
      actor: { role: 'design_steward', id: 'forged' },
    });
    expect(created.status).toBe(200);
    expect(created.body.design).toMatchObject({
      projectId: 1,
      moduleId: null,
      agent: 'codex',
      stage: 'goal_setting',
      currentRevision: 1,
      originalRequest,
    });
    expect(s.store.getRevision(created.body.design.id, 1)?.actor).toBe(`owner:user:${s.alice.user.id}`);
    expect(s.activated).toEqual([created.body.design.conversationId]);

    const list = await s.call('GET', '/api/projects/1/designs', s.alice.token);
    expect(list.status).toBe(200);
    expect(list.body.designs.map((design: { id: number }) => design.id)).toEqual([created.body.design.id]);

    const detail = await s.call(
      'GET', `/api/projects/1/designs/${created.body.design.id}`, s.alice.token,
    );
    expect(detail.body.design).toMatchObject({ id: created.body.design.id, title: 'Safe rollout' });
    s.db.close();
  });

  test('validates module ownership, module agent, strict agent JSON, and project capability', async () => {
    const s = setup();
    const invalidAgent = await createDesign(s, { agent: 'reviewer' });
    expect(invalidAgent.status).toBe(400);
    expect(invalidAgent.body.error.code).toBe('design.agent_invalid');

    const missingModule = await createDesign(s, { moduleId: 999 });
    expect(missingModule.status).toBe(400);
    expect(missingModule.body.error.code).toBe('design.module_invalid');
    const crossModule = await createDesign(s, { moduleId: 22, agent: 'claude' });
    expect(crossModule.status).toBe(400);
    expect(crossModule.body.error.code).toBe('design.module_invalid');
    const mismatch = await createDesign(s, { moduleId: 11, agent: 'claude' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('design.module_agent_mismatch');

    s.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    const unsupported = await createDesign(s);
    expect(unsupported.status).toBe(409);
    expect(unsupported.body.error).toMatchObject({
      code: 'design.agent_unavailable',
      params: { agent: 'codex', executor: 'local' },
    });
    s.db.close();
  });

  test('allows members to read but rejects every owner mutation with a stable design code', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    expect((await s.call('GET', `/api/projects/1/designs/${id}`, s.member.token)).status).toBe(200);

    const attempts: Array<[string, string, unknown?]> = [
      ['POST', '/api/projects/1/designs', {
        title: 'Member draft', originalRequest: 'Must not create.', agent: 'codex',
      }],
      ['PATCH', `/api/projects/1/designs/${id}`, { expectedRevision: 1, title: 'Member edit' }],
      ['POST', `/api/projects/1/designs/${id}/confirm-goal`, { expectedRevision: 1 }],
      ['POST', `/api/projects/1/designs/${id}/reviews`, { expectedRevision: 1 }],
      ['PUT', `/api/projects/1/designs/${id}/graph`, { expectedRevision: 1, graph: { nodes: [], edges: [] } }],
      ['POST', `/api/projects/1/designs/${id}/approve-graph`, { expectedRevision: 1, readiness: {} }],
      ['POST', `/api/projects/1/designs/${id}/start-execution`, { expectedRevision: 1 }],
      ['POST', `/api/projects/1/designs/${id}/complete-execution`, { expectedRevision: 1 }],
      ['POST', `/api/projects/1/designs/${id}/archive`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await s.call(method, path, s.member.token, body);
      expect(response.status).toBe(403);
      expect(response.body.error).toMatchObject({ code: 'design.forbidden', params: {} });
    }

    const adminCreated = await s.call('POST', '/api/projects/1/designs', s.admin.token, {
      title: 'Admin draft', originalRequest: 'Administrators may act for the owner.', agent: 'codex',
    });
    expect(adminCreated.status).toBe(200);
    expect(s.store.getRevision(adminCreated.body.design.id, 1)?.actor).toBe(`owner:user:${s.admin.user.id}`);
    s.db.close();
  });

  test('strictly rejects coerced create fields and malformed graph linkage metadata', async () => {
    const s = setup();
    for (const overrides of [
      { moduleId: true },
      { moduleId: '11' },
      { readinessThreshold: '80' },
      { readinessThreshold: true },
      { graphGranularity: 1 },
    ]) {
      const response = await createDesign(s, overrides);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('design.invalid_request');
    }

    const created = await createDesign(s);
    const id = created.body.design.id as number;
    for (const node of [
      { nodeId: 'bad-issue', title: 'Bad issue', issueId: '12' },
      { nodeId: 'bad-sync', title: 'Bad sync', lastSyncedRevision: true },
    ]) {
      const response = await s.call('PUT', `/api/projects/1/designs/${id}/graph`, s.alice.token, {
        expectedRevision: 1,
        graph: {
          nodes: [{
            ...node,
            acceptanceCriteria: ['Valid otherwise'],
            evidenceRequirements: ['route test'],
            implMode: 'direct',
          }],
          edges: [],
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('design.invalid_request');
    }
    s.db.close();
  });

  test('checks path project ownership before detail mutations and returns revision conflicts', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    const cross = await s.call('GET', `/api/projects/2/designs/${id}`, s.alice.token);
    expect(cross.status).toBe(404);
    expect(cross.body.error.code).toBe('design.not_found');

    const patched = await s.call('PATCH', `/api/projects/1/designs/${id}`, s.alice.token, {
      expectedRevision: 1,
      title: 'Suggested title',
      originalRequest: '  Preserve this request verbatim.\n  ',
      role: 'design_steward',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.design).toMatchObject({ title: 'Safe rollout', currentRevision: 1 });
    expect(s.store.listEvents(id).at(-1)?.data).toMatchObject({
      title: 'Suggested title',
      originalRequest: '  Preserve this request verbatim.\n  ',
      actor: { id: `user:${s.alice.user.id}`, role: 'owner' },
    });

    const conflict = await s.call('PATCH', `/api/projects/1/designs/${id}`, s.alice.token, {
      expectedRevision: 0,
      title: 'Stale input',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatchObject({
      code: 'design.revision_conflict',
      params: { currentRevision: 1 },
    });
    s.db.close();
  });

  test('confirms goals and queues owner reviews without accepting a forged reviewer role', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    const confirmed = await s.call(
      'POST', `/api/projects/1/designs/${id}/confirm-goal`, s.alice.token, { expectedRevision: 1 },
    );
    expect(confirmed.body.design.stage).toBe('solution_draft');
    await s.engine.applyStewardRevision(id, {
      expectedRevision: 1,
      documentJson: { goal: 'Safe rollout', solution: 'Canary' },
      documentMarkdown: '# Safe rollout\n\nCanary.',
      readiness: readiness(90),
      nextStage: 'review',
    }, steward);

    const review = await s.call('POST', `/api/projects/1/designs/${id}/reviews`, s.alice.token, {
      expectedRevision: 2,
      personas: ['architecture-reviewer'],
      role: 'reviewer',
      findings: [{ finding: 'forged' }],
    });
    expect(review.status).toBe(200);
    expect(review.body).toMatchObject({ queued: true, design: { id, currentRevision: 2 } });
    expect(s.store.listEvents(id).at(-1)).toMatchObject({
      kind: 'input_appended',
      data: {
        requestKind: 'review',
        actor: { id: `user:${s.alice.user.id}`, role: 'owner' },
      },
    });

    const ready = await s.call('GET', `/api/projects/1/designs/${id}/readiness`, s.alice.token);
    expect(ready.body).toMatchObject({
      readiness: { score: 90, threshold: 80, override: false, revision: 2 },
    });
    const events = await s.call('GET', `/api/projects/1/designs/${id}/events?after=2`, s.alice.token);
    expect(events.body.events.every((event: { id: number }) => event.id > 2)).toBe(true);
    s.db.close();
  });

  test('keeps owner graph PUT as a proposal, then exposes explicit approve/start/complete actions', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    await s.engine.confirmGoal(id, { expectedRevision: 1 }, { id: `user:${s.alice.user.id}`, role: 'owner' });
    await s.engine.applyStewardRevision(id, {
      expectedRevision: 1,
      documentJson: { goal: 'Safe rollout', solution: 'Canary' },
      documentMarkdown: '# Safe rollout\n\nCanary.',
      readiness: readiness(100),
      nextStage: 'review',
    }, steward);
    const graph = {
      nodes: [{
        nodeId: 'api',
        title: 'Expose API',
        goal: 'Expose the design API',
        background: ['The approved design requires a stable API.'],
        sourceSections: ['design.document.api'],
        scope: ['Expose the approved design API.'],
        nonGoals: ['Do not change unrelated APIs.'],
        inputs: ['Approved design revision.'],
        outputs: ['Published API contract.'],
        dependencies: [],
        implementationNotes: ['Implement through the design route facade.'],
        moduleId: null,
        runtime: 'current',
        agent: null,
        complexity: 'medium',
        complexityRationale: ['The route crosses design and issue boundaries.'],
        acceptanceCriteria: ['Authorized clients can use it'],
        testRecommendations: ['Run the focused route tests.'],
        evidenceRequirements: ['route tests'],
        completionInstructions: ['Report the route contract and test evidence.'],
        implMode: 'direct',
      }],
      edges: [],
    };

    const proposed = await s.call('PUT', `/api/projects/1/designs/${id}/graph`, s.alice.token, {
      expectedRevision: 2,
      graph,
      actor: { id: 'forged', role: 'design_steward' },
    });
    expect(proposed.status).toBe(200);
    expect(proposed.body).toMatchObject({ queued: true, graph: { nodes: [], edges: [] } });
    expect(s.store.getTask(id)?.currentRevision).toBe(2);
    expect(s.store.listEvents(id).at(-1)?.data).toMatchObject({ requestKind: 'graph_proposal' });

    await s.engine.replaceGraph(id, { expectedRevision: 2, graph: graph as any, readiness: readiness(100) }, steward);
    const canonical = await s.call('GET', `/api/projects/1/designs/${id}/graph`, s.alice.token);
    expect(canonical.body.graph.nodes[0]).toMatchObject({ nodeId: 'api', title: 'Expose API' });

    const approved = await s.call('POST', `/api/projects/1/designs/${id}/approve-graph`, s.alice.token, {
      expectedRevision: 3,
      readiness: readiness(100),
      override: {
        ownerActor: 'forged-owner',
        reason: 'No blockers',
        timestamp: 1,
        acceptedBlockerIds: [],
      },
    });
    expect(approved.body.design.stage).toBe('approved');
    expect(s.store.listEvents(id).at(-1)?.data).toMatchObject({
      override: { ownerActor: `user:${s.alice.user.id}` },
    });
    const started = await s.call(
      'POST', `/api/projects/1/designs/${id}/start-execution`, s.alice.token, { expectedRevision: 3 },
    );
    expect(started.body.design.stage).toBe('executing');
    const completed = await s.call(
      'POST', `/api/projects/1/designs/${id}/complete-execution`, s.alice.token, { expectedRevision: 3 },
    );
    expect(completed.body.design.stage).toBe('completed');
    s.db.close();
  });

  test('rejects malformed graph and readiness payloads as client errors', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;

    const malformedGraph = await s.call('PUT', `/api/projects/1/designs/${id}/graph`, s.alice.token, {
      expectedRevision: 1,
      graph: { nodes: [null], edges: [] },
    });
    expect(malformedGraph.status).toBe(400);
    expect(malformedGraph.body.error.code).toBe('design.invalid_request');
    expect(malformedGraph.body.error.details).toBeUndefined();

    const malformedReadiness = await s.call(
      'POST',
      `/api/projects/1/designs/${id}/approve-graph`,
      s.alice.token,
      { expectedRevision: 1, readiness: { hardBlockers: 'not-an-array' } },
    );
    expect(malformedReadiness.status).toBe(400);
    expect(malformedReadiness.body.error.code).toBe('design.invalid_request');
    s.db.close();
  });

  test('archives through the owner actor and closes the design conversation', async () => {
    const s = setup();
    const created = await createDesign(s);
    const id = created.body.design.id as number;
    s.failures.archive = 1;
    const failed = await s.call('POST', `/api/projects/1/designs/${id}/archive`, s.alice.token, {
      role: 'design_steward',
    });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('design.conversation_cleanup_failed');
    expect(s.store.getTask(id)).toMatchObject({ status: 'archived', stage: 'archived' });

    const archived = await s.call('POST', `/api/projects/1/designs/${id}/archive`, s.alice.token, {
      role: 'design_steward',
    });
    expect(archived.status).toBe(200);
    expect(archived.body.design).toMatchObject({ status: 'archived', stage: 'archived' });
    expect(s.archived).toEqual([created.body.design.conversationId]);
    expect(s.store.listEvents(id).at(-1)?.data).toMatchObject({ actor: `owner:user:${s.alice.user.id}` });
    s.db.close();
  });
});

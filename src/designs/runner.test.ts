import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentArtifactDriver } from '../core/agent-artifact-runner';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { LocalDriver } from '../executor/local';
import {
  DesignPersonaRegistry,
  renderPersonaDocument,
  type PersonaManifest,
  type ResolvedPersona,
} from './personas';
import { DesignEngine } from './engine';
import { DesignStore, migrateDesigns } from './store';
import {
  buildDesignRunPrompt,
  DesignRunner,
  designRunPaths,
  MAX_DESIGN_CONTEXT_BYTES,
  MAX_DESIGN_PERSONAS,
  type DesignRunnerDriver,
  type DesignRunnerEngine,
  type DesignRunIntentStore,
} from './runner';
import type { DesignRunIntent } from './types';

class FakeDriver implements DesignRunnerDriver {
  files = new Map<string, string>();
  sessions = new Set<string>();
  created: Array<{ name: string; cwd: string }> = [];
  killed: string[] = [];
  sent: Array<{ session: string; text: string }> = [];
  wrote: Array<{ path: string; data: string }> = [];
  removed: string[] = [];
  captureCount = 0;
  failStat = false;
  onCapture?: (session: string, files: Map<string, string>) => void;

  async findExecutable(agent: 'claude' | 'codex') { return `/tools/${agent}`; }
  async createSession(name: string, cwd: string) {
    this.sessions.add(name);
    this.created.push({ name, cwd });
  }
  async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('missing');
    this.killed.push(name);
  }
  async sendKeys(session: string, text: string) { this.sent.push({ session, text }); }
  async sendKey() {}
  async capturePane(session: string) {
    this.captureCount++;
    this.onCapture?.(session, this.files);
    return '';
  }
  async writeFile(path: string, data: Uint8Array | string) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.files.set(path, text);
    this.wrote.push({ path, data: text });
  }
  async statPath(path: string) {
    if (this.failStat) throw new Error('stat unavailable');
    const data = this.files.get(path);
    if (data !== undefined) {
      return { size: new TextEncoder().encode(data).length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
    }
    if ([...this.files.keys()].some((file) => file.startsWith(`${path}/`))) {
      return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 };
    }
    return null;
  }
  async readFileRange(path: string, offset: number, limit: number) {
    const data = new TextEncoder().encode(this.files.get(path) ?? '');
    return { data: data.subarray(offset, offset + limit), size: data.length };
  }
  async removeTree(path: string) {
    this.removed.push(path);
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
  }
  async listDir(path: string) {
    const prefix = `${path.replace(/\/+$/, '')}/`;
    const names = new Set<string>();
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const name = file.slice(prefix.length).split('/')[0];
      if (name) names.add(name);
    }
    return [...names].sort().map((name) => ({ name, type: 'dir' as const }));
  }
}

class FakeEngine implements DesignRunnerEngine {
  reviews: unknown[] = [];
  revisions: unknown[] = [];
  graphs: unknown[] = [];

  async requestReview(...args: Parameters<DesignRunnerEngine['requestReview']>) {
    this.reviews.push(args);
    return { eventId: this.reviews.length };
  }
  async applyStewardRevision(...args: Parameters<DesignRunnerEngine['applyStewardRevision']>) {
    this.revisions.push(args);
    return { revision: (args[1].expectedRevision ?? 0) + 1 } as any;
  }
  async replaceGraph(...args: Parameters<DesignRunnerEngine['replaceGraph']>) {
    this.graphs.push(args);
    return { nodes: [], edges: [] } as any;
  }
}

class FakeIntentStore implements DesignRunIntentStore {
  rows = new Map<string, DesignRunIntent>();

  createRunIntent(intent: DesignRunIntent): boolean {
    const key = `${intent.designId}:${intent.runId}`;
    if (this.rows.has(key)) return false;
    this.rows.set(key, { ...intent });
    return true;
  }

  getRunIntent(designId: number, runId: string): DesignRunIntent | null {
    return this.rows.get(`${designId}:${runId}`) ?? null;
  }

  updateRunIntentState(
    designId: number,
    runId: string,
    from: DesignRunIntent['state'],
    to: DesignRunIntent['state'],
    updatedTs = Date.now(),
  ): boolean {
    const key = `${designId}:${runId}`;
    const current = this.rows.get(key);
    if (!current || current.state !== from) return false;
    this.rows.set(key, { ...current, state: to, updatedTs });
    return true;
  }
}

function clock() {
  let now = 1000;
  return { now: () => now, sleep: async (ms: number) => void (now += ms) };
}

const FAST = { pollIntervalMs: 10, readyDelayMs: 10, timeoutMs: 100 };

const personaDb = openDb(':memory:');
migrate(personaDb);
migrateIssueEngine(personaDb);
migrateDesigns(personaDb);
const personaRegistry = new DesignPersonaRegistry(personaDb);

function persona(
  role: ResolvedPersona['manifest']['role'],
  agent: 'claude' | 'codex' = 'claude',
): ResolvedPersona {
  const builtinByRole: Record<ResolvedPersona['manifest']['role'], string> = {
    reviewer: 'builtin:general-reviewer',
    design_steward: 'builtin:design-steward',
    goal_coach: 'builtin:goal-coach',
    issue_planner: 'builtin:issue-planner',
    independent_verifier: 'builtin:independent-verifier',
  };
  return personaRegistry.resolveForRun(1, builtinByRole[role]!, agent);
}

async function scopedProjectPersona(): Promise<ResolvedPersona> {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  const cwd = mkdtempSync(join(tmpdir(), 'runner-scoped-persona-'));
  db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)");
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/repo', '/claude')`);
  db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, ?, 1, 1), (2, 'two', 1, '/repo/two', 1, 1)`).run(cwd);
  const manifest: PersonaManifest = {
    slug: 'claude-reviewer',
    displayName: 'Claude Reviewer',
    reviewSpecialty: 'Project-scoped review',
    compatibleAgents: ['claude'],
    outputSchemaVersion: 1,
    promptPath: 'PERSONA.md',
    role: 'reviewer',
  };
  const bundle = join(cwd, '.panda/personas/claude-reviewer');
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(manifest, 'Review this project only.'));
  const registry = new DesignPersonaRegistry(db);
  const [found] = await registry.discoverProject({ id: 1, cwd }, new LocalDriver());
  registry.approveHash(1, found!.id, found!.contentHash, 1);
  registry.setEnabled(1, found!.id, true);
  const resolved = registry.resolveForRun(1, found!.key, 'claude');
  db.close();
  return resolved;
}

function emitArtifacts(
  driver: FakeDriver,
  designId: number,
  roleByRun: Record<string, 'reviewer' | 'design_steward'>,
) {
  driver.onCapture = (session, files) => {
    const runId = session.split('-').slice(2).join('-');
    const paths = designRunPaths('/repo', designId, runId);
    const role = roleByRun[runId];
    if (!role) return;
    files.set(paths.findings, role === 'reviewer'
      ? JSON.stringify([{
          dimension: 'security',
          severity: 'warning',
          finding: 'Authentication boundary is unclear.',
          evidence: ['Design section 3 omits the caller identity.'],
          proposedPatch: { section: 'Security' },
        }])
      : '[]');
    files.set(paths.documentPatch, role === 'design_steward'
      ? JSON.stringify({
          documentJson: { title: 'Revised design' },
          documentMarkdown: '# Revised design',
          readiness: {},
          reason: 'Integrated review findings',
        })
      : 'null');
    files.set(paths.graph, 'null');
    files.set(paths.done, 'ok');
  };
}

function realEngine(stage: 'solution_draft' | 'review' = 'solution_draft') {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)");
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', 'key', '/repo', '/claude')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'project', 1, '/repo', 1, 1)`);
  const store = new DesignStore(db);
  const task = store.createTask({
    projectId: 1,
    title: 'Recovery boundary',
    originalRequest: 'Do not trust project-writable manifests.',
    agent: 'claude',
    stage,
    documentJson: { title: 'Original' },
    documentMarkdown: '# Original',
  });
  const engine = new DesignEngine({
    store,
    scope: {
      projectExists: () => true,
      getModule: () => null,
      supportsAgent: () => true,
    },
    conversations: {
      createDesignConversation: async () => ({ conversationId: 'unused', created: false, ownershipProof: null }),
      activateDesignConversation: async () => {},
      archiveDesignConversation: async () => {},
      deleteDesignConversation: async () => false,
    },
  });
  return { db, store, task, engine };
}

describe('design runner protocol', () => {
  test('uses an isolated design/run directory and a bounded role-specific prompt', () => {
    const paths = designRunPaths('/repo/', 12, 'run-a');
    expect(paths.scratch).toBe('/repo/.panda/tmp/design/12/run-a');
    expect(paths.findings).toBe(`${paths.scratch}/findings.json`);
    expect(paths.documentPatch).toBe(`${paths.scratch}/document.patch.json`);
    expect(paths.graph).toBe(`${paths.scratch}/graph.json`);
    expect(paths.priorFindings).toBe(`${paths.scratch}/prior-findings.json`);
    expect(paths.contract).toBe(`${paths.scratch}/artifact-contract.md`);
    expect(paths.run).toBe(`${paths.scratch}/run.json`);
    expect(paths.done).toBe(`${paths.scratch}/done`);

    const reviewer = buildDesignRunPrompt({
      designId: 12,
      runId: 'run-a',
      persona: 'builtin:general-reviewer',
      role: 'reviewer',
      locale: 'en',
    });
    expect(reviewer).toContain('findings.json');
    expect(reviewer).toContain('evidence must be an array of non-empty strings');
    expect(reviewer).toContain('document.patch.json must contain null');
    expect(reviewer).toContain('context.md');
    expect(reviewer).toContain('artifact-contract.md');
    expect(reviewer).toContain('Do not inspect files outside the current run directory');
    expect(reviewer.length).toBeLessThanOrEqual(2000);

    const steward = buildDesignRunPrompt({
      designId: 12,
      runId: 'run-b',
      persona: 'design-steward',
      role: 'design_steward',
      locale: 'en',
    });
    expect(steward).toContain('document.patch.json');
    expect(steward).toContain('Only the design steward');
    expect(steward).toContain('prior-findings.json');
  });

  test('ingests structured output from multiple personas while only the steward mutates the document', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const ids = ['review-1', 'steward-1'];
    emitArtifacts(driver, 12, { 'review-1': 'reviewer', 'steward-1': 'design_steward' });
    const runner = new DesignRunner({
      driver,
      engine,
      intents: new FakeIntentStore(),
      idFactory: () => ids.shift()!,
      ...clock(),
    });
    const context = 'x'.repeat(20_000);
    const result = await runner.run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'codex',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: context,
      locale: 'en',
      personas: [
        persona('reviewer', 'codex'),
        persona('design_steward', 'codex'),
      ],
    }, {
      ...FAST,
      ...({
        claudeArgs: '--dangerously-skip-permissions',
        codexArgs: '--dangerously-bypass-approvals-and-sandbox',
        autoApproveMenus: true,
      } as Record<string, unknown>),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.runs.map((run) => run.runId)).toEqual(['review-1', 'steward-1']);
    expect(engine.reviews).toHaveLength(1);
    expect(engine.revisions).toHaveLength(1);
    expect((engine.reviews[0] as unknown[])[2]).toEqual({ id: 'builtin:general-reviewer', role: 'reviewer' });
    expect((engine.revisions[0] as unknown[])[2]).toEqual({ id: 'builtin:design-steward', role: 'design_steward' });
    expect((engine.reviews[0] as unknown[])[1]).toMatchObject({
      operationId: 'group-14:review-round-a|revision-4|persona-24:builtin:general-reviewer',
    });
    expect((engine.revisions[0] as unknown[])[1]).toMatchObject({
      operationId: 'group-14:review-round-a|revision-4|persona-22:builtin:design-steward',
    });

    const stewardPaths = designRunPaths('/repo', 12, 'steward-1');
    expect(driver.files.get(stewardPaths.contract)).toContain('"scope":["..."]');
    expect(driver.files.get(stewardPaths.contract)).toContain('"kind":"depends_on"');
    expect(JSON.parse(driver.files.get(stewardPaths.priorFindings)!)).toEqual([{
      persona: 'builtin:general-reviewer',
      findings: [{
        dimension: 'security',
        severity: 'warning',
        finding: 'Authentication boundary is unclear.',
        evidence: ['Design section 3 omits the caller identity.'],
        proposedPatch: { section: 'Security' },
      }],
      graph: null,
    }]);
    expect(driver.created).toEqual([
      { name: 'design-12-review-1', cwd: designRunPaths('/repo', 12, 'review-1').scratch },
      { name: 'design-12-steward-1', cwd: stewardPaths.scratch },
    ]);
    expect(driver.sent.find((sent) => sent.session === 'design-12-review-1')?.text)
      .toBe('/tools/codex -c check_for_update_on_startup=false -c model_reasoning_effort=medium --sandbox workspace-write --ask-for-approval never');

    const designRoot = '/repo/.panda/tmp/design/12/';
    expect(driver.wrote.every((write) => write.path.startsWith(designRoot))).toBe(true);
    expect(driver.wrote.some((write) => write.path.endsWith('/context.md') && write.data === context)).toBe(true);
    expect(driver.sent.filter((sent) => !sent.text.startsWith('/tools/')).every((sent) => sent.text.length <= 2000)).toBe(true);
    expect(JSON.parse(driver.files.get('/repo/.panda/tmp/design/12/review-1/run.json')!).status).toBe('completed');
    expect(JSON.parse(driver.files.get('/repo/.panda/tmp/design/12/steward-1/run.json')!).status).toBe('completed');
    expect(JSON.parse(driver.files.get('/repo/.panda/tmp/design/12/review-1/run.json')!)).toMatchObject({
      persona: 'builtin:general-reviewer',
      personaOrigin: 'builtin',
      personaGitCommit: null,
      personaContentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test('rejects a specialist-authored document patch without applying it', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const paths = designRunPaths('/repo', 12, 'bad-specialist');
    driver.onCapture = (_session, files) => {
      files.set(paths.findings, JSON.stringify([{
        dimension: 'ux', severity: 'info', finding: 'ok', evidence: ['screen'], proposedPatch: {},
      }]));
      files.set(paths.documentPatch, JSON.stringify({
        documentJson: {},
        documentMarkdown: '# hijack',
        readiness: {},
      }));
      files.set(paths.graph, 'null');
      files.set(paths.done, 'ok');
    };
    const result = await new DesignRunner({
      driver, engine, intents: new FakeIntentStore(), idFactory: () => 'bad-specialist', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: 'context',
      personas: [persona('reviewer')],
    }, FAST);
    expect(result).toMatchObject({ ok: false, reason: 'forbidden-artifact', runId: 'bad-specialist' });
    expect(engine.revisions).toEqual([]);
  });

  test('completes a valid no-op steward run without creating a revision', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const paths = designRunPaths('/repo', 12, 'noop-steward');
    driver.onCapture = (_session, files) => {
      files.set(paths.findings, '[]');
      files.set(paths.documentPatch, 'null');
      files.set(paths.graph, 'null');
      files.set(paths.done, 'ok');
    };
    const result = await new DesignRunner({
      driver, engine, intents: new FakeIntentStore(), idFactory: () => 'noop-steward', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: 'context',
      personas: [persona('design_steward')],
    }, FAST);

    expect(result.ok).toBe(true);
    expect(engine.revisions).toEqual([]);
    expect(JSON.parse(driver.files.get(paths.run)!).status).toBe('completed');
    expect(driver.created).toEqual([{ name: 'design-12-noop-steward', cwd: paths.scratch }]);
    expect(driver.sent[0]?.text).toBe('/tools/claude --permission-mode acceptEdits --disallowedTools Bash NotebookEdit');
  });

  test('applies a steward document patch before its graph and uses the returned revision CAS', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const plannerPaths = designRunPaths('/repo', 12, 'graph-planner');
    const paths = designRunPaths('/repo', 12, 'graph-steward');
    const graph = {
      nodes: [{
        nodeId: 'api', ordinal: 0, title: 'API', goal: 'Ship API', background: ['Need API'],
        sourceSections: ['solution'], scope: ['API'], nonGoals: ['UI'], inputs: ['Design'], outputs: ['API'],
        dependencies: [], implementationNotes: ['Implement'], moduleId: null, runtime: 'current', agent: null,
        complexity: 'low', complexityRationale: ['Bounded'], acceptanceCriteria: ['Works'],
        testRecommendations: ['Test'], evidenceRequirements: ['Output'], completionInstructions: ['Report'],
        implMode: 'direct', detail: null, issueId: null, lastSyncedRevision: null,
      }],
      edges: [],
    };
    driver.onCapture = (session, files) => {
      if (session === 'design-12-graph-planner') {
        files.set(plannerPaths.findings, '[]');
        files.set(plannerPaths.documentPatch, 'null');
        files.set(plannerPaths.graph, JSON.stringify(graph));
        files.set(plannerPaths.done, 'ok');
        return;
      }
      files.set(paths.findings, '[]');
      files.set(paths.documentPatch, JSON.stringify({
        documentJson: { solution: true }, documentMarkdown: '# Solution', readiness: {}, nextStage: 'review',
      }));
      files.set(paths.graph, JSON.stringify(graph));
      files.set(paths.done, 'ok');
    };
    const ids = ['graph-planner', 'graph-steward'];
    const result = await new DesignRunner({
      driver, engine, intents: new FakeIntentStore(), idFactory: () => ids.shift()!, ...clock(),
    }).run({
      projectId: 1, designId: 12, cwd: '/repo', agent: 'claude', sourceRevision: 4,
      operationGroupId: 'graph-round', contextMarkdown: 'context',
      personas: [persona('issue_planner'), persona('design_steward')],
    }, FAST);

    expect(result.ok).toBe(true);
    expect(engine.revisions).toHaveLength(1);
    expect(engine.graphs).toHaveLength(1);
    expect((engine.graphs[0] as unknown[])[1]).toMatchObject({ expectedRevision: 5, graph });
    expect((engine.graphs[0] as unknown[])[2]).toEqual({ id: 'builtin:design-steward', role: 'design_steward' });
    expect(JSON.parse(driver.files.get(paths.priorFindings)!)).toEqual([{
      persona: 'builtin:issue-planner', findings: [], graph,
    }]);
  });

  test('marks abandoned live runs interrupted, preserves completed artifacts, and retries under a new run ID', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const intents = new FakeIntentStore();
    const reviewer = persona('reviewer');
    const live = designRunPaths('/repo', 12, 'old-live');
    const incomplete = designRunPaths('/repo', 12, 'old-incomplete');
    const forbidden = designRunPaths('/repo', 12, 'old-forbidden');
    const complete = designRunPaths('/repo', 12, 'old-complete');
    driver.sessions.add('design-12-old-live');
    driver.sessions.add('design-12-old-incomplete');
    driver.sessions.add('design-12-old-forbidden');
    const addAttempt = (runId: string, operationGroupId: string, status: 'running' | 'completed') => {
      const intent: DesignRunIntent = {
        designId: 12,
        runId,
        projectId: 1,
        operationGroupId,
        key: reviewer.key,
        contentHash: reviewer.contentHash,
        origin: reviewer.origin,
        gitCommit: reviewer.gitCommit,
        role: reviewer.manifest.role,
        resolvedAgent: reviewer.resolvedAgent,
        sourceRevision: 4,
        state: 'launching',
        createdTs: 10,
        updatedTs: 10,
      };
      intents.createRunIntent(intent);
      driver.files.set(designRunPaths('/repo', 12, runId).run, JSON.stringify({
        schemaVersion: 1,
        projectId: 1,
        designId: 12,
        runId,
        persona: reviewer.key,
        role: reviewer.manifest.role,
        personaContentHash: reviewer.contentHash,
        personaOrigin: reviewer.origin,
        personaGitCommit: reviewer.gitCommit,
        resolvedAgent: reviewer.resolvedAgent,
        sourceRevision: 4,
        operationGroupId,
        status,
        startedTs: 10,
        ...(status === 'completed' ? { finishedTs: 20 } : {}),
      }));
    };
    addAttempt('old-live', 'old-round', 'running');
    driver.files.set(live.findings, JSON.stringify([{
      dimension: 'recovery',
      severity: 'warning',
      finding: 'Reuse the retained deterministic output.',
      evidence: ['retained findings.json'],
      proposedPatch: { retained: true },
    }]));
    driver.files.set(live.documentPatch, 'null');
    driver.files.set(live.graph, 'null');
    driver.files.set(live.done, 'ok');
    addAttempt('old-incomplete', 'incomplete-round', 'running');
    addAttempt('old-forbidden', 'forbidden-round', 'running');
    driver.files.set(forbidden.findings, '[]');
    driver.files.set(forbidden.documentPatch, JSON.stringify({
      documentJson: {}, documentMarkdown: '# forbidden', readiness: {},
    }));
    driver.files.set(forbidden.graph, 'null');
    driver.files.set(forbidden.done, 'ok');
    addAttempt('old-complete', 'old-round', 'completed');
    driver.files.set(complete.findings, '[{"kept":true}]');

    const runner = new DesignRunner({
      driver, engine, intents, idFactory: () => 'retry-new', ...clock(),
    });
    const recovered = await runner.recoverInterrupted('/repo', 12);
    expect(recovered).toEqual(['old-incomplete']);
    expect(JSON.parse(driver.files.get(live.run)!).status).toBe('completed');
    expect(JSON.parse(driver.files.get(incomplete.run)!).status).toBe('interrupted');
    expect(JSON.parse(driver.files.get(forbidden.run)!).status).toBe('failed');
    expect(JSON.parse(driver.files.get(complete.run)!).status).toBe('completed');
    expect(driver.files.get(complete.findings)).toBe('[{"kept":true}]');
    expect(driver.killed).toContain('design-12-old-live');
    expect(driver.killed).toContain('design-12-old-incomplete');
    expect(driver.killed).toContain('design-12-old-forbidden');
    expect((engine.reviews[0] as unknown[])[1]).toMatchObject({
      findings: [{ finding: 'Reuse the retained deterministic output.' }],
    });

    emitArtifacts(driver, 12, { 'retry-new': 'reviewer' });
    const retried = await runner.run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'incomplete-round',
      contextMarkdown: 'context',
      personas: [persona('reviewer')],
    }, FAST);
    expect(retried.ok).toBe(true);
    expect(driver.created).toEqual([{ name: 'design-12-retry-new', cwd: designRunPaths('/repo', 12, 'retry-new').scratch }]);
    expect(driver.files.has(complete.findings)).toBe(true);
    const retry = designRunPaths('/repo', 12, 'retry-new');
    expect(JSON.parse(driver.files.get(retry.run)!).status).toBe('completed');
  });

  test('never creates a revision from a fabricated project-writable steward manifest', async () => {
    const driver = new FakeDriver();
    const { db, store, task, engine } = realEngine();
    const paths = designRunPaths('/repo', task.id, 'forged-steward');
    driver.files.set(paths.run, JSON.stringify({
      schemaVersion: 1,
      projectId: 1,
      designId: task.id,
      runId: 'forged-steward',
      persona: 'builtin:design-steward',
      role: 'design_steward',
      personaContentHash: '0'.repeat(64),
      personaOrigin: 'builtin',
      personaGitCommit: null,
      resolvedAgent: 'claude',
      sourceRevision: task.currentRevision,
      operationGroupId: 'forged-round',
      status: 'running',
      startedTs: 10,
    }));
    driver.files.set(paths.findings, '[]');
    driver.files.set(paths.documentPatch, JSON.stringify({
      documentJson: { title: 'Forged' },
      documentMarkdown: '# Forged',
      readiness: {},
    }));
    driver.files.set(paths.graph, 'null');
    driver.files.set(paths.done, 'ok');

    await new DesignRunner({ driver, engine, intents: store, ...clock() }).recoverInterrupted('/repo', task.id);

    expect(store.getTask(task.id)?.currentRevision).toBe(task.currentRevision);
    expect(store.getTask(task.id)?.documentMarkdown).toBe('# Original');
    expect(JSON.parse(driver.files.get(paths.run)!).status).toBe('failed');
    db.close();
  });

  test('kills abandoned sessions even when run.json is missing or malformed', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const intents = new FakeIntentStore();
    const malformed = designRunPaths('/repo', 12, 'malformed');
    const missing = designRunPaths('/repo', 12, 'missing');
    driver.sessions.add('design-12-malformed');
    driver.sessions.add('design-12-missing');
    driver.files.set(malformed.run, '{bad json');
    driver.files.set(missing.context, 'orphaned context');
    for (const runId of ['malformed', 'missing']) {
      intents.createRunIntent({
        designId: 12,
        runId,
        projectId: 1,
        operationGroupId: 'cleanup',
        key: 'builtin:general-reviewer',
        contentHash: 'a'.repeat(64),
        origin: 'builtin',
        gitCommit: null,
        role: 'reviewer',
        resolvedAgent: 'claude',
        sourceRevision: 4,
        state: 'launching',
        createdTs: 1,
        updatedTs: 1,
      });
    }

    await new DesignRunner({
      driver, engine, intents, ...clock(),
    }).recoverInterrupted('/repo', 12);

    expect(driver.killed.sort()).toEqual(['design-12-malformed', 'design-12-missing']);
    expect(engine.reviews).toEqual([]);
    expect(engine.revisions).toEqual([]);
    expect(intents.getRunIntent(12, 'missing')?.state).toBe('failed');
    expect(intents.getRunIntent(12, 'malformed')?.state).toBe('failed');
  });

  test('recovers a legitimate steward intent once across crashes before and after ingestion', async () => {
    const driver = new FakeDriver();
    const { db, store, task, engine } = realEngine();
    const steward = personaRegistry.resolveForRun(1, 'builtin:design-steward', 'claude');
    const runId = 'trusted-steward';
    const paths = designRunPaths('/repo', task.id, runId);
    const intent: DesignRunIntent = {
      designId: task.id,
      runId,
      projectId: 1,
      operationGroupId: 'trusted-round',
      key: steward.key,
      contentHash: steward.contentHash,
      origin: steward.origin,
      gitCommit: steward.gitCommit,
      role: steward.manifest.role,
      resolvedAgent: steward.resolvedAgent,
      sourceRevision: task.currentRevision,
      state: 'launching',
      createdTs: 10,
      updatedTs: 10,
    };
    expect(store.createRunIntent(intent)).toBe(true);
    const running = {
      schemaVersion: 1,
      projectId: 1,
      designId: task.id,
      runId,
      persona: steward.key,
      role: steward.manifest.role,
      personaContentHash: steward.contentHash,
      personaOrigin: steward.origin,
      personaGitCommit: steward.gitCommit,
      resolvedAgent: steward.resolvedAgent,
      sourceRevision: task.currentRevision,
      operationGroupId: 'trusted-round',
      status: 'running',
      startedTs: 10,
    };
    driver.files.set(paths.run, JSON.stringify(running));
    driver.files.set(paths.findings, '[]');
    driver.files.set(paths.documentPatch, JSON.stringify({
      documentJson: { title: 'Recovered' },
      documentMarkdown: '# Recovered',
      readiness: {},
    }));
    driver.files.set(paths.graph, 'null');
    driver.files.set(paths.done, 'ok');
    const runner = new DesignRunner({ driver, engine, intents: store, ...clock() });

    await runner.recoverInterrupted('/repo', task.id);
    expect(store.getTask(task.id)?.currentRevision).toBe(task.currentRevision + 1);
    expect(store.getRunIntent(task.id, runId)?.state).toBe('ingested');
    expect(JSON.parse(driver.files.get(paths.run)!).status).toBe('completed');
    const operation = db.query<{ request_json: string }, []>(
      "SELECT request_json FROM design_agent_operations WHERE operation_kind = 'steward_revision'",
    ).get();
    expect(JSON.parse(operation!.request_json).personaProvenance).toEqual({
      key: steward.key,
      contentHash: steward.contentHash,
      origin: 'builtin',
      gitCommit: null,
      role: 'design_steward',
      projectId: 1,
      resolvedAgent: 'claude',
    });
    expect(store.listEvents(task.id).find((event) => event.kind === 'document_revised')?.data)
      .toMatchObject({ personaProvenance: { key: steward.key, contentHash: steward.contentHash } });

    driver.files.set(paths.run, JSON.stringify(running));
    await runner.recoverInterrupted('/repo', task.id);
    expect(store.getTask(task.id)?.currentRevision).toBe(task.currentRevision + 1);
    expect(JSON.parse(driver.files.get(paths.run)!).status).toBe('completed');
    db.close();
  });

  test('fails terminally when project files replace an authorized persona key, hash, and role', async () => {
    const driver = new FakeDriver();
    const { db, store, task, engine } = realEngine();
    const reviewer = personaRegistry.resolveForRun(1, 'builtin:general-reviewer', 'claude');
    const runId = 'tampered-authority';
    const paths = designRunPaths('/repo', task.id, runId);
    expect(store.createRunIntent({
      designId: task.id,
      runId,
      projectId: 1,
      operationGroupId: 'trusted-review',
      key: reviewer.key,
      contentHash: reviewer.contentHash,
      origin: reviewer.origin,
      gitCommit: reviewer.gitCommit,
      role: reviewer.manifest.role,
      resolvedAgent: reviewer.resolvedAgent,
      sourceRevision: task.currentRevision,
      state: 'launching',
      createdTs: 10,
      updatedTs: 10,
    })).toBe(true);
    driver.files.set(paths.run, JSON.stringify({
      schemaVersion: 1,
      projectId: 1,
      designId: task.id,
      runId,
      persona: 'builtin:design-steward',
      role: 'design_steward',
      personaContentHash: '0'.repeat(64),
      personaOrigin: 'builtin',
      personaGitCommit: null,
      resolvedAgent: 'claude',
      sourceRevision: task.currentRevision,
      operationGroupId: 'trusted-review',
      status: 'running',
      startedTs: 10,
    }));
    driver.files.set(paths.findings, '[]');
    driver.files.set(paths.documentPatch, JSON.stringify({
      documentJson: { title: 'Escalated' }, documentMarkdown: '# Escalated', readiness: {},
    }));
    driver.files.set(paths.graph, 'null');
    driver.files.set(paths.done, 'ok');

    await new DesignRunner({ driver, engine, intents: store, ...clock() })
      .recoverInterrupted('/repo', task.id);

    expect(store.getTask(task.id)?.currentRevision).toBe(task.currentRevision);
    expect(store.getRunIntent(task.id, runId)?.state).toBe('failed');
    expect(JSON.parse(driver.files.get(paths.run)!).status).toBe('failed');
    db.close();
  });

  test('persists reviewer persona provenance in the durable operation and finding event', async () => {
    const driver = new FakeDriver();
    const { db, store, task, engine } = realEngine('review');
    const reviewer = personaRegistry.resolveForRun(1, 'builtin:general-reviewer', 'claude');
    const runId = 'trusted-reviewer';
    const paths = designRunPaths('/repo', task.id, runId);
    const intent: DesignRunIntent = {
      designId: task.id,
      runId,
      projectId: 1,
      operationGroupId: 'review-provenance',
      key: reviewer.key,
      contentHash: reviewer.contentHash,
      origin: reviewer.origin,
      gitCommit: reviewer.gitCommit,
      role: reviewer.manifest.role,
      resolvedAgent: reviewer.resolvedAgent,
      sourceRevision: task.currentRevision,
      state: 'launching',
      createdTs: 10,
      updatedTs: 10,
    };
    expect(store.createRunIntent(intent)).toBe(true);
    driver.files.set(paths.run, JSON.stringify({
      schemaVersion: 1,
      projectId: 1,
      designId: task.id,
      runId,
      persona: reviewer.key,
      role: reviewer.manifest.role,
      personaContentHash: reviewer.contentHash,
      personaOrigin: reviewer.origin,
      personaGitCommit: reviewer.gitCommit,
      resolvedAgent: reviewer.resolvedAgent,
      sourceRevision: task.currentRevision,
      operationGroupId: 'review-provenance',
      status: 'running',
      startedTs: 10,
    }));
    driver.files.set(paths.findings, JSON.stringify([{
      dimension: 'security', severity: 'warning', finding: 'Trust boundary missing.',
      evidence: ['Section 2'], proposedPatch: { section: 2 },
    }]));
    driver.files.set(paths.documentPatch, 'null');
    driver.files.set(paths.graph, 'null');
    driver.files.set(paths.done, 'ok');

    await new DesignRunner({ driver, engine, intents: store, ...clock() })
      .recoverInterrupted('/repo', task.id);

    const operation = db.query<{ request_json: string }, []>(
      "SELECT request_json FROM design_agent_operations WHERE operation_kind = 'review'",
    ).get();
    expect(JSON.parse(operation!.request_json).personaProvenance).toEqual({
      key: reviewer.key,
      contentHash: reviewer.contentHash,
      origin: 'builtin',
      gitCommit: null,
      role: 'reviewer',
      projectId: 1,
      resolvedAgent: 'claude',
    });
    expect(store.listEvents(task.id).find((event) => event.kind === 'finding_appended')?.data)
      .toMatchObject({ personaProvenance: { key: reviewer.key, contentHash: reviewer.contentHash } });
    db.close();
  });

  test('never overwrites a retained run when run ID allocation repeatedly collides', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const retained = designRunPaths('/repo', 12, 'retained');
    const original = JSON.stringify({
      schemaVersion: 1, designId: 12, runId: 'retained', persona: 'reviewer', role: 'reviewer',
      sourceRevision: 4, operationGroupId: 'old-round', status: 'completed', startedTs: 10, finishedTs: 20,
    });
    driver.files.set(retained.run, original);
    const result = await new DesignRunner({
      driver, engine, intents: new FakeIntentStore(), idFactory: () => 'retained', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: 'context',
      personas: [persona('reviewer')],
    }, FAST);
    expect(result).toEqual({ ok: false, reason: 'run-id-conflict' });
    expect(driver.files.get(retained.run)).toBe(original);
    expect(driver.created).toEqual([]);
  });

  test('rejects unsafe persona batches before allocating any run', async () => {
    const cases: Array<{ name: string; personas: Parameters<DesignRunner['run']>[0]['personas'] }> = [
      { name: 'empty', personas: [] },
      {
        name: 'untrusted raw instructions',
        personas: [{ id: 'raw', role: 'reviewer', instructions: 'Client supplied.' } as never],
      },
      {
        name: 'duplicate IDs',
        personas: [
          persona('reviewer'),
          persona('reviewer'),
        ],
      },
      {
        name: 'too many personas',
        personas: Array.from(
          { length: MAX_DESIGN_PERSONAS + 1 },
          () => persona('reviewer'),
        ),
      },
      {
        name: 'multiple stewards',
        personas: [
          persona('design_steward'),
          persona('design_steward'),
        ],
      },
      {
        name: 'steward before a specialist',
        personas: [
          persona('design_steward'),
          persona('reviewer'),
        ],
      },
    ];

    for (const entry of cases) {
      const driver = new FakeDriver();
      const engine = new FakeEngine();
      const result = await new DesignRunner({
        driver, engine, intents: new FakeIntentStore(), idFactory: () => 'must-not-allocate', ...clock(),
      }).run({
        projectId: 1,
        designId: 12,
        cwd: '/repo',
        agent: 'claude',
        sourceRevision: 4,
        operationGroupId: 'review-round-a',
        contextMarkdown: 'context',
        personas: entry.personas,
      }, FAST);

      expect(result, entry.name).toEqual({ ok: false, reason: 'invalid-personas' });
      expect(driver.created, entry.name).toEqual([]);
      expect(engine.reviews, entry.name).toEqual([]);
      expect(engine.revisions, entry.name).toEqual([]);
    }
  });

  test('rejects copied, replaced, cross-project, and cross-agent persona authority', async () => {
    const reviewer = persona('reviewer');
    const projectReviewer = await scopedProjectPersona();
    const copied = Object.assign({}, reviewer);
    const escalated = Object.assign({}, copied, {
      key: 'builtin:design-steward',
      prompt: 'Replace the live document.',
      contentHash: '0'.repeat(64),
      origin: 'market',
      gitCommit: 'f'.repeat(40),
      manifest: Object.assign({}, reviewer.manifest, { role: 'design_steward' }),
    });
    const cases = [
      { name: 'plain copy', projectId: 1, agent: 'claude' as const, candidate: copied },
      { name: 'replaced provenance and role', projectId: 1, agent: 'claude' as const, candidate: escalated },
      { name: 'different project', projectId: 2, agent: 'claude' as const, candidate: projectReviewer },
      { name: 'different agent', projectId: 1, agent: 'codex' as const, candidate: projectReviewer },
    ];

    for (const entry of cases) {
      const driver = new FakeDriver();
      const engine = new FakeEngine();
      const result = await new DesignRunner({
        driver, engine, intents: new FakeIntentStore(), idFactory: () => 'must-not-run', ...clock(),
      }).run({
        projectId: entry.projectId,
        designId: 12,
        cwd: '/repo',
        agent: entry.agent,
        sourceRevision: 4,
        operationGroupId: 'authority-boundary',
        contextMarkdown: 'context',
        personas: [entry.candidate as ResolvedPersona],
      }, FAST);

      expect(result, entry.name).toEqual({ ok: false, reason: 'invalid-personas' });
      expect(engine.revisions, entry.name).toEqual([]);
      expect(driver.created, entry.name).toEqual([]);
    }
  });

  test('returns a stable scope error for a cross-project design ID or stale revision', async () => {
    const { db, store, task } = realEngine();
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (2, 'other', 1, '/repo/other', 1, 1)`);
    const other = store.createTask({
      projectId: 2,
      title: 'Other project',
      originalRequest: 'Out of scope.',
      agent: 'claude',
      documentJson: {},
      documentMarkdown: '# Other',
    });
    const cases = [
      { runId: 'cross-project', designId: other.id, sourceRevision: other.currentRevision },
      { runId: 'stale-revision', designId: task.id, sourceRevision: task.currentRevision + 1 },
    ];
    for (const entry of cases) {
      const driver = new FakeDriver();
      const result = await new DesignRunner({
        driver,
        engine: new FakeEngine(),
        intents: store,
        idFactory: () => entry.runId,
        ...clock(),
      }).run({
        projectId: 1,
        designId: entry.designId,
        cwd: '/repo',
        agent: 'claude',
        sourceRevision: entry.sourceRevision,
        operationGroupId: 'scope-check',
        contextMarkdown: 'context',
        personas: [persona('reviewer')],
      }, FAST);
      expect(result).toEqual({ ok: false, reason: 'invalid-run-scope' });
      expect(driver.created).toEqual([]);
    }
    db.close();
  });

  test('rejects oversized file context before allocating any run', async () => {
    const driver = new FakeDriver();
    const engine = new FakeEngine();
    const result = await new DesignRunner({
      driver, engine, intents: new FakeIntentStore(), idFactory: () => 'must-not-allocate', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: 'x'.repeat(MAX_DESIGN_CONTEXT_BYTES + 1),
      personas: [persona('reviewer')],
    }, FAST);

    expect(result).toEqual({ ok: false, reason: 'invalid-context' });
    expect(driver.created).toEqual([]);
  });

  test('normalizes run-allocation driver failures instead of rejecting', async () => {
    const driver = new FakeDriver();
    driver.failStat = true;
    const result = await new DesignRunner({
      driver, engine: new FakeEngine(), intents: new FakeIntentStore(), idFactory: () => 'run', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: 'review-round-a',
      contextMarkdown: 'context',
      personas: [persona('reviewer')],
    }, FAST);

    expect(result).toMatchObject({ ok: false, reason: 'runner-error', error: 'Error: stat unavailable' });
  });

  test('rejects an unsafe operation group before allocating any run', async () => {
    const driver = new FakeDriver();
    const result = await new DesignRunner({
      driver, engine: new FakeEngine(), intents: new FakeIntentStore(), idFactory: () => 'must-not-allocate', ...clock(),
    }).run({
      projectId: 1,
      designId: 12,
      cwd: '/repo',
      agent: 'claude',
      sourceRevision: 4,
      operationGroupId: '../same-round',
      contextMarkdown: 'context',
      personas: [persona('reviewer')],
    }, FAST);

    expect(result).toEqual({ ok: false, reason: 'invalid-operation-group' });
    expect(driver.created).toEqual([]);
  });
});

// Keep the fake structurally checked against the shared runner boundary too.
const _artifactDriver: AgentArtifactDriver = new FakeDriver();
void _artifactDriver;

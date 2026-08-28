/**
 * web/server 集成测试：临时 DB + LocalDriver（tmux 面 stub）拉起完整 server（随机端口），
 * 走一遍冒烟主链：healthz → 首启 admin token 登录 → 建用户（落 workspace）→
 * 建项目（自动订阅属主）→ 建 issue（引擎接管到 planning）→ 列表可见 →
 * 属主隔离（他人 403）→ 飞书未配置静默路径（绑定 503）→ 静态服务 → 优雅停机不抛。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { promises as fsp, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { importableHistorySessions } from '../core/conversation-history';
import { migrate, splitStatements } from '../core/migrate';
import { migrateDesigns, DesignStore } from '../designs/store';
import { designGraphDigest } from '../designs/graph';
import type { DesignGraphDraft } from '../designs/types';
import type { DesignRunner, RunDesignInput } from '../designs/runner';
import type { DesignImageGenerator } from '../designs/image-provider';
import { migrateIssueEngine } from '../issues/engine';
import { ModuleStore } from '../issues/modules';
import { LocalDriver } from '../executor/local';
import {
  designImageRuntimeFromEnv,
  executorStatusOf,
  resolveDesignAssetStorageRoot,
  startServer,
  trustFileOf,
  type PandaServer,
  type ServerOptions,
} from './server';

const LEGACY_SAGA_050_SQL = readFileSync(
  new URL('../designs/test-fixtures/050_design_workbench-saga-legacy.sql', import.meta.url),
  'utf8',
);

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function png(width = 1024, height = 1024): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

/** tmux 面全部 stub 成内存实现（测试机不真起 tmux/claude）；文件/git 面保持真 LocalDriver */
class FakeDriver extends LocalDriver {
  sessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  gitCalls: Array<{ cwd: string; args: string[] }> = [];
  override async git(cwd: string, args: string[]) {
    this.gitCalls.push({ cwd, args: [...args] });
    return super.git(cwd, args);
  }
  override async findExecutable(agent: 'claude' | 'codex') {
    return `/test/bin/${agent}`;
  }
  override async listSessions() {
    return [...this.sessions].map((name) => ({ name, createdTs: 0, attached: false }));
  }
  override async createSession(name: string) {
    this.sessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  override async sendKey() {}
  override async capturePane() {
    return '';
  }
}

class HungDesignDriver extends FakeDriver {
  private releaseCreate: (() => void) | null = null;
  readonly entered = new Promise<void>((resolve) => { this.releaseCreate = resolve; });
  override async createSession(name: string) {
    if (name.startsWith('chat-')) await this.entered;
    return super.createSession(name);
  }

  release(): void { this.releaseCreate?.(); }
}

class HungModuleDriver extends FakeDriver {
  moduleMode: 'normal' | 'fail' | 'hang' = 'normal';
  private releaseWrite: (() => void) | null = null;
  private enteredWrite: (() => void) | null = null;
  readonly entered = new Promise<void>((resolve) => { this.enteredWrite = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.releaseWrite = resolve; });

  release(): void {
    this.moduleMode = 'normal';
    this.releaseWrite?.();
  }

  override async writeFile(filePath: string, data: Uint8Array | string, mode?: number): Promise<void> {
    if (filePath.includes('/.panda/modules/')) {
      if (this.moduleMode === 'fail') throw new Error('module write unavailable');
      if (this.moduleMode === 'hang') {
        this.enteredWrite?.();
        await this.released;
      }
    }
    return super.writeFile(filePath, data, mode);
  }
}

class HungWorktreeRecoveryDriver extends FakeDriver {
  private enteredRecovery: (() => void) | null = null;
  private releaseRecovery: (() => void) | null = null;
  readonly entered = new Promise<void>((resolve) => { this.enteredRecovery = resolve; });
  private readonly released = new Promise<void>((resolve) => { this.releaseRecovery = resolve; });

  release(): void { this.releaseRecovery?.(); }

  override async git(cwd: string, args: string[]) {
    if (args.join(' ') === 'worktree list --porcelain') {
      this.enteredRecovery?.();
      await this.released;
      return { code: 0, out: '', err: '' };
    }
    return super.git(cwd, args);
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

interface Ctx {
  server: PandaServer;
  base: string;
  dir: string;
  ws: string;
  tokenFile: string;
  driver: FakeDriver;
}

function applyRecordedLegacyDesign050(db: ReturnType<typeof openDb>): void {
  db.transaction(() => {
    for (const statement of splitStatements(LEGACY_SAGA_050_SQL)) db.run(statement);
    db.query(
      `INSERT INTO schema_migrations (id, name, applied_ts)
       VALUES (50, '050_design_workbench.sql', 1)`,
    ).run();
  })();
}

async function boot(
  publicDir?: string,
  prepareDb?: (db: ReturnType<typeof openDb>) => void,
  injectedDriver: FakeDriver = new FakeDriver(),
  serverOverrides: Partial<ServerOptions> = {},
): Promise<Ctx> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-server-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'panda.db');
  const ws = path.join(dir, 'ws');
  const claudeDir = path.join(dir, 'home', '.claude', 'projects');
  const tokenFile = path.join(dir, 'admin-token');

  // 预置一台本机执行机（host=127.0.0.1 且无 keyRef → LocalDriver 规则；测试注入 FakeDriver）
  const db0 = openDb(dbPath);
  migrate(db0);
  db0.query(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', ?, ?)`,
  ).run(ws, claudeDir);
  prepareDb?.(db0);
  db0.close();

  const driver = injectedDriver;
  // LLM 指到本地不可达地址、单次重试：开发机/CI 环境常带真 PANDA_LLM_API_KEY，
  // 不摘会让冒烟真调 驱动大模型（模块起名不定、耗时不定甚至超时）。配置在 startServer
  // 装配时一次性捕获（createLlmClient），随后立刻恢复 env，不影响同进程其它测试文件。
  const LLM_ENV: Record<string, string> = {
    PANDA_LLM_BASE_URL: 'http://127.0.0.1:1',
    PANDA_LLM_API_KEY: 'test-disabled',
    PANDA_LLM_RETRIES: '1',
    PANDA_LLM_TIMEOUT_MS: '500',
  };
  const savedEnv = Object.fromEntries(Object.keys(LLM_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, LLM_ENV);
  let server: PandaServer;
  try {
    server = await startServer({
      port: 0,
      dbPath,
      adminTokenFile: tokenFile,
      driverFactory: () => driver,
      feishu: null, // 飞书不配置（静默路径）
      engineConfig: { tickMs: 3_600_000 }, // 测试内不靠后台 tick
      statusIntervalMs: 3_600_000,
      designImageRuntime: null,
      ...(publicDir ? { publicDir } : {}),
      ...serverOverrides,
    });
  } finally {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  cleanups.push(() => server.stop());
  return { server, base: `http://127.0.0.1:${server.port}`, dir, ws, tokenFile, driver };
}

async function api(
  ctx: Ctx,
  method: string,
  p: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const resp = await fetch(`${ctx.base}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: resp.status, body: await resp.json().catch(() => null), headers: resp.headers };
}

describe('server 集成冒烟（完整装配）', () => {
  test('design run route executes the task agent and ingests a real steward revision', async () => {
    const dimensions = [
      'goal_clarity', 'scope_boundaries', 'solution_completeness',
      'dependencies_constraints', 'acceptance_testability', 'risks_unknowns',
    ] as const;
    const ctx = await boot(undefined, undefined, new FakeDriver(), {
      designRunnerForProject: (_project, { engine }) => ({
        async run(input: RunDesignInput) {
          const steward = input.personas.at(-1)!;
          await engine.applyStewardRevision(input.designId, {
            operationId: `${input.operationGroupId}:fake-steward`,
            expectedRevision: input.sourceRevision,
            documentJson: { goal: 'Verified production outcome' },
            documentMarkdown: '# Goal\n\nVerified production outcome',
            readiness: {
              dimensions: Object.fromEntries(dimensions.map((dimension) => [dimension, {
                score: 90, evidencePaths: [`document.${dimension}`], missingItems: [], nextQuestions: [],
              }])) as any,
            },
            nextStage: 'goal_setting',
            personaProvenance: {
              key: steward.key, contentHash: steward.contentHash, origin: steward.origin,
              gitCommit: steward.gitCommit, role: steward.manifest.role,
              projectId: input.projectId, resolvedAgent: input.agent,
            },
          }, { id: steward.key, role: 'design_steward' });
          return { ok: true as const, runs: [] };
        },
        async recoverInterrupted() { return []; },
      }) as unknown as DesignRunner,
    });
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const owner = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'run-owner' });
    const project = await api(ctx, 'POST', '/api/projects', owner.body.token, { name: 'run-project', executorId: 1 });
    const design = await api(ctx, 'POST', `/api/projects/${project.body.project.id}/designs`, owner.body.token, {
      title: 'Run orchestration', originalRequest: 'Verify the outcome.', agent: 'codex',
    });
    const disabledAssets = await api(
      ctx,
      'GET',
      `/api/projects/${project.body.project.id}/designs/${design.body.design.id}/assets/capability`,
      owner.body.token,
    );
    expect(disabledAssets).toMatchObject({
      status: 200,
      body: { capability: { enabled: false, provider: null, model: null, reason: 'not_configured' } },
    });
    expect(fsp.stat(path.join(ctx.dir, 'design-assets'))).rejects.toBeTruthy();
    const started = await api(
      ctx, 'POST', `/api/projects/${project.body.project.id}/designs/${design.body.design.id}/runs`, owner.body.token,
      { expectedRevision: 1, mode: 'goal', message: 'Clarify this goal.' },
      { 'Idempotency-Key': 'server-real-run' },
    );
    expect(started.status).toBe(202);
    let status: Awaited<ReturnType<typeof api>> | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      status = await api(
        ctx, 'GET', `/api/projects/${project.body.project.id}/designs/${design.body.design.id}/runs/${started.body.run.id}`,
        owner.body.token,
      );
      if (status.body.run.status === 'completed') break;
      await Bun.sleep(2);
    }
    expect(status).toBeDefined();
    expect(status!.body.run).toMatchObject({ status: 'completed', sourceRevision: 1 });
    expect(new DesignStore(ctx.server.db).getTask(design.body.design.id)).toMatchObject({
      agent: 'codex', currentRevision: 2,
      documentJson: { goal: 'Verified production outcome' },
    });
  });

  test('fake image provider generates verified bytes and projects only a ready current-revision asset', async () => {
    const generatedBytes = png();
    const generatedSha = createHash('sha256').update(generatedBytes).digest('hex');
    const generator: DesignImageGenerator = {
      async generate() {
        return { mime: 'image/png', data: generatedBytes.slice(), providerRequestId: 'fake-request-1' };
      },
    };
    const ctx = await boot(undefined, undefined, new FakeDriver(), {
      designImageRuntime: {
        generator,
        provider: { name: 'openai', model: 'fake-image', outputFormat: 'png', quality: 'medium' },
      },
    });
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const owner = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'asset-owner' });
    const project = await api(ctx, 'POST', '/api/projects', owner.body.token, {
      name: 'asset-project', executorId: 1,
    });
    const projectId = project.body.project.id as number;
    const projectCwd = String(project.body.project.cwd);
    await fsp.mkdir(projectCwd, { recursive: true });
    await fsp.writeFile(path.join(projectCwd, 'README.md'), '# asset project\n');
    for (const args of [
      ['init', '-q'], ['add', 'README.md'],
      ['-c', 'user.name=server-test', '-c', 'user.email=server@test', 'commit', '-qm', 'initial'],
    ]) expect(Bun.spawnSync({ cmd: ['git', '-C', projectCwd, ...args] }).exitCode).toBe(0);

    const created = await api(ctx, 'POST', `/api/projects/${projectId}/designs`, owner.body.token, {
      title: 'Asset projection', originalRequest: 'Create one implementation-ready screen.', agent: 'codex',
    });
    const designId = created.body.design.id as number;
    const assetBase = `/api/projects/${projectId}/designs/${designId}/assets`;
    expect(await api(ctx, 'GET', `${assetBase}/capability`, owner.body.token)).toMatchObject({
      status: 200, body: { capability: { enabled: true, provider: 'openai', model: 'fake-image' } },
    });
    const queued = await api(ctx, 'POST', `${assetBase}/generate`, owner.body.token, {
      expectedRevision: 1,
      preset: 'full_page_mockup',
      prompt: 'Draw the complete settings page.',
      size: '1024x1024',
      includeRevisionContext: false,
      references: [],
      acknowledgeExternalProcessingAndCost: true,
    }, { 'Idempotency-Key': 'server-fake-asset-1' });
    expect(queued.status).toBe(202);
    const assetId = queued.body.asset.id as number;
    let asset = queued.body.asset as Record<string, any>;
    for (let attempt = 0; attempt < 50 && asset.status !== 'succeeded'; attempt++) {
      await Bun.sleep(2);
      const listed = await api(ctx, 'GET', assetBase, owner.body.token);
      asset = listed.body.assets.find((item: { id: number }) => item.id === assetId);
    }
    expect(asset).toMatchObject({
      id: assetId, status: 'succeeded', outputSha256: generatedSha,
      byteSize: generatedBytes.length, providerRequestId: 'fake-request-1', implementationReady: false,
    });

    const content = await fetch(`${ctx.base}${assetBase}/${assetId}/content`, {
      headers: { authorization: `Bearer ${owner.body.token}` },
    });
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('image/png');
    expect(Array.from(new Uint8Array(await content.arrayBuffer()))).toEqual(Array.from(generatedBytes));

    const annotated = await api(ctx, 'PATCH', `${assetBase}/${assetId}`, owner.body.token, {
      expectedAssetVersion: asset.assetVersion,
      functionalDetails: {
        altText: 'Settings page with account and notification controls.',
        interactions: ['Save persists all settings.'],
        responsiveBehavior: ['Navigation collapses below 720px.'],
        accessibilityNotes: ['Focus order follows visual order.'],
        acceptanceCriteria: ['Keyboard users can save every field.'],
      },
      implementationReady: true,
    });
    expect(annotated).toMatchObject({
      status: 200, body: { asset: { id: assetId, implementationReady: true } },
    });

    const diff = await api(
      ctx, 'GET', `/api/projects/${projectId}/designs/${designId}/file-diff?expectedRevision=1`, owner.body.token,
    );
    const projectedPath = `assets/${assetId}-visual-${assetId}.png`;
    expect(diff.status).toBe(200);
    expect(diff.body.diff.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: projectedPath, incomingSha256: generatedSha }),
    ]));
    const published = await api(
      ctx, 'POST', `/api/projects/${projectId}/designs/${designId}/publish-files`, owner.body.token,
      { expectedRevision: 1 },
    );
    expect(published).toMatchObject({
      status: 200, body: { publication: { status: 'published', revision: 1, targetKind: 'project' } },
    });
    const projectedBytes = new Uint8Array(await fsp.readFile(
      path.join(projectCwd, `.panda/designs/design-${designId}/${projectedPath}`),
    ));
    expect(Array.from(projectedBytes)).toEqual(Array.from(generatedBytes));
    expect(createHash('sha256').update(projectedBytes).digest('hex')).toBe(generatedSha);
  });

  test('server shutdown closes DB before an abort-ignoring provider rejects without a late touch', async () => {
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    let reject!: (error: unknown) => void;
    const held = new Promise<never>((_resolve, fail) => { reject = fail; });
    const generator: DesignImageGenerator = {
      async generate() {
        entered();
        return await held;
      },
    };
    const ctx = await boot(undefined, undefined, new FakeDriver(), {
      designImageRuntime: {
        generator,
        provider: { name: 'openai', model: 'hung-image', outputFormat: 'png', quality: 'medium' },
      },
      designAssetShutdownTimeoutMs: 0,
    });
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const owner = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'late-provider-owner' });
    const project = await api(ctx, 'POST', '/api/projects', owner.body.token, {
      name: 'late-provider-project', executorId: 1,
    });
    const design = await api(ctx, 'POST', `/api/projects/${project.body.project.id}/designs`, owner.body.token, {
      title: 'Late provider', originalRequest: 'Prove bounded shutdown.', agent: 'codex',
    });
    const queued = await api(
      ctx,
      'POST',
      `/api/projects/${project.body.project.id}/designs/${design.body.design.id}/assets/generate`,
      owner.body.token,
      {
        expectedRevision: 1,
        preset: 'full_page_mockup',
        prompt: 'Draw the page.',
        size: '1024x1024',
        includeRevisionContext: false,
        references: [],
        acknowledgeExternalProcessingAndCost: true,
      },
      { 'Idempotency-Key': 'late-provider-server-1' },
    );
    expect(queued.status).toBe(202);
    await didEnter;
    expect(await Promise.race([
      ctx.server.stop().then(() => true),
      Bun.sleep(100).then(() => false),
    ])).toBe(true);
    let lateUnhandled: unknown = null;
    const onUnhandled = (error: unknown) => { lateUnhandled = error; };
    process.on('unhandledRejection', onUnhandled);
    try {
      reject(new Error('provider rejected after server close'));
      await Bun.sleep(10);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(lateUnhandled).toBeNull();
  });
  test('backfills a legacy task-created crash window and keeps it out of ordinary surfaces', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000066';
    const sagaToken = 'saga-legacy-crash-window';
    let taskId = 0;
    const ctx = await boot(undefined, (db) => {
      migrateIssueEngine(db);
      applyRecordedLegacyDesign050(db);
      db.run(`INSERT INTO users (id, username, token_hash, created_ts)
              VALUES (66, 'legacy-owner', 'hash', 1)`);
      const workspaceRoot = db.query<{ root: string }, []>(
        'SELECT workspace_root AS root FROM executors WHERE id = 1',
      ).get()!.root;
      db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
                VALUES (66, 'legacy-recovery', 1, ?, 66, 1)`).run(path.join(workspaceRoot, 'legacy'));
      const store = new DesignStore(db);
      store.ensureCreationSaga({
        sagaToken,
        projectId: 66,
        idempotencyKey: 'request-legacy-crash-window',
        requestJson: JSON.stringify({
          input: {
            moduleId: null,
            title: 'Legacy recovery',
            originalRequest: 'Recover the legacy ownership proof.',
            agent: 'claude',
            readinessThreshold: 80,
            graphGranularity: 'issue',
          },
          actorKey: 'owner:user:66',
        }),
        conversationId,
      });
      taskId = store.createCreationSagaTask(sagaToken, 'intent', {
        projectId: 66,
        title: 'Legacy recovery',
        originalRequest: 'Recover the legacy ownership proof.',
        agent: 'claude',
        documentJson: { title: 'Legacy recovery' },
        documentMarkdown: '# Legacy recovery',
        readiness: 0,
        actor: 'owner:user:66',
      })!.task.id;
      db.query(
        `INSERT INTO conversations
           (id, project_id, label, created_ts, agent, kind, design_creation_saga_token)
         VALUES (?, 66, 'Legacy design', 1, 'claude', 'chat', ?)`,
      ).run(conversationId, sagaToken);
    });

    for (let attempt = 0; attempt < 50; attempt++) {
      const phase = ctx.server.db.query<{ phase: string }, [string]>(
        'SELECT phase FROM design_creation_sagas WHERE saga_token = ?',
      ).get(sagaToken)?.phase;
      if (phase === 'completed') break;
      await Bun.sleep(5);
    }

    expect(ctx.server.db.query<{
      phase: string;
      taskId: number | null;
      conversationOwned: number;
    }, [string]>(
      `SELECT phase, task_id AS taskId, conversation_owned AS conversationOwned
       FROM design_creation_sagas WHERE saga_token = ?`,
    ).get(sagaToken)).toEqual({ phase: 'completed', taskId, conversationOwned: 1 });
    expect(ctx.server.db.query<{
      id: number;
      conversationId: string | null;
      status: string;
    }, []>(
      'SELECT id, conversation_id AS conversationId, status FROM design_tasks WHERE project_id = 66',
    ).all()).toEqual([{ id: taskId, conversationId, status: 'active' }]);
    expect(ctx.server.db.query<{ conversationId: string; sagaToken: string }, []>(
      `SELECT conversation_id AS conversationId, saga_token AS sagaToken
       FROM design_saga_conversation_owners`,
    ).all()).toEqual([{ conversationId, sagaToken }]);
    expect(ctx.server.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM conversations WHERE project_id = 66',
    ).get()!.n).toBe(1);
    expect(ctx.server.db.query<{ token: string }, [string]>(
      'SELECT design_creation_saga_token AS token FROM conversations WHERE id = ?',
    ).get(conversationId)).toEqual({ token: sagaToken });
    expect(ctx.driver.sessions.has(`chat-${conversationId}`)).toBe(true);

    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const ordinary = await api(ctx, 'GET', '/api/projects/66/conversations', adminToken);
    expect(ordinary.body.conversations).toEqual([]);
    expect(importableHistorySessions(ctx.server.db, [{ agent: 'claude', sessionId: conversationId }]))
      .toEqual([]);
    const ws = await fetch(`${ctx.base}/ws/chat/66?conv=${conversationId}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(ws.status).toBe(409);
    expect(await ws.json()).toMatchObject({
      error: { code: 'design.conversation_reserved', params: { conversationId } },
    });
  });

  test('startup resumes an incomplete design creation saga before serving requests', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000077';
    const ctx = await boot(undefined, (db) => {
      migrateIssueEngine(db);
      migrateDesigns(db);
      db.run(`INSERT INTO users (id, username, token_hash, created_ts)
              VALUES (77, 'design-owner', 'hash', 1)`);
      const workspaceRoot = db.query<{ root: string }, []>(
        'SELECT workspace_root AS root FROM executors WHERE id = 1',
      ).get()!.root;
      db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
                VALUES (77, 'recovery-project', 1, ?, 77, 1)`).run(path.join(workspaceRoot, 'recovery'));
      new DesignStore(db).ensureCreationSaga({
        sagaToken: 'saga-startup-recovery',
        projectId: 77,
        idempotencyKey: 'request-startup-recovery',
        requestJson: JSON.stringify({
          input: {
            moduleId: null,
            title: 'Startup recovery',
            originalRequest: 'Resume this design after restart.',
            agent: 'claude',
            readinessThreshold: 80,
            graphGranularity: 'issue',
          },
          actorKey: 'owner:user:77',
        }),
        conversationId,
      });
    });

    for (let attempt = 0; attempt < 50; attempt++) {
      const phase = ctx.server.db.query<{ phase: string }, []>(
        "SELECT phase FROM design_creation_sagas WHERE saga_token = 'saga-startup-recovery'",
      ).get()?.phase;
      if (phase === 'completed') break;
      await Bun.sleep(5);
    }
    expect(ctx.server.db.query<{ phase: string; task_id: number | null; error: string | null }, []>(
      "SELECT phase, task_id, error FROM design_creation_sagas WHERE saga_token = 'saga-startup-recovery'",
    ).get()).toMatchObject({ phase: 'completed', task_id: expect.any(Number) });
    expect(ctx.server.db.query<{ status: string; conversation_id: string }, []>(
      'SELECT status, conversation_id FROM design_tasks WHERE project_id = 77',
    ).get()).toEqual({ status: 'active', conversation_id: conversationId });
    expect(ctx.driver.sessions.has(`chat-${conversationId}`)).toBe(true);
  });

  test('a hung design recovery cannot delay server availability', async () => {
    const conversationId = '00000000-0000-4000-8000-000000000088';
    const driver = new HungDesignDriver();
    const started = boot(undefined, (db) => {
      migrateIssueEngine(db);
      migrateDesigns(db);
      db.run(`INSERT INTO users (id, username, token_hash, created_ts)
              VALUES (88, 'hung-owner', 'hash', 1)`);
      const workspaceRoot = db.query<{ root: string }, []>(
        'SELECT workspace_root AS root FROM executors WHERE id = 1',
      ).get()!.root;
      db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
                VALUES (88, 'hung-recovery', 1, ?, 88, 1)`).run(path.join(workspaceRoot, 'hung'));
      new DesignStore(db).ensureCreationSaga({
        sagaToken: 'saga-hung-recovery',
        projectId: 88,
        idempotencyKey: 'request-hung-recovery',
        requestJson: JSON.stringify({
          input: {
            moduleId: null,
            title: 'Hung recovery',
            originalRequest: 'Do not delay HTTP availability.',
            agent: 'claude',
            readinessThreshold: 80,
            graphGranularity: 'issue',
          },
          actorKey: 'owner:user:88',
        }),
        conversationId,
      });
    }, driver);

    const outcome = await Promise.race([
      started.then((ctx) => ({ kind: 'started' as const, ctx })),
      Bun.sleep(100).then(() => ({ kind: 'timed-out' as const })),
    ]);
    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    expect((await fetch(`${outcome.ctx.base}/healthz`)).status).toBe(200);
    const stopped = Promise.race([
      outcome.ctx.server.stop().then(() => true),
      Bun.sleep(100).then(() => false),
    ]);
    expect(await stopped).toBe(true);
    driver.release();
    await Bun.sleep(20);
  });

  test('hung worktree Git recovery is deadline-bounded and leaves the active adapter fail-closed', async () => {
    const driver = new HungWorktreeRecoveryDriver();
    let booted: Promise<Ctx>;
    booted = boot(undefined, (db) => {
      migrateIssueEngine(db);
      migrateDesigns(db);
      db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (77, 'worktree-owner', 'hash', 1)");
      db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
              VALUES (77, 'hung-worktree', 1, '/srv/repo', 77, 1)`);
      db.run(`INSERT INTO design_tasks
        (id, project_id, title, original_request, agent, stage, current_revision, created_ts, updated_ts)
        VALUES (77, 77, 'Hung recovery', 'Recover safely', 'codex', 'approved', 1, 1, 1)`);
      db.run(`INSERT INTO design_revisions
        (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
        VALUES (77, 1, '{}', '# Hung', 100, '{"nodes":[],"edges":[]}', 'owner', 1)`);
      db.query(`INSERT INTO design_execution_runs
        (id, project_id, design_task_id, approved_revision, graph_digest, idempotency_key,
         execution_mode, lifecycle_state, assignment_active, base_ref, base_sha,
         worktree_branch, worktree_cwd, observed_head_sha, created_ts, updated_ts)
        VALUES ('hung-active', 77, 77, 1, ?, 'hung-active', 'worktree', 'executing', 1,
                'refs/heads/main', ?, 'codex/hung-active', '/srv/worktree', ?, 1, 1)`)
        .run('a'.repeat(64), '1'.repeat(40), '1'.repeat(40));
    }, driver, { designWorktreeRecoveryLimit: 10, designWorktreeRecoveryTimeoutMs: 10 });
    await driver.entered;
    const outcome = await Promise.race([booted.then((ctx) => ({ kind: 'started' as const, ctx })), Bun.sleep(100).then(() => ({ kind: 'timeout' as const }))]);
    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') { driver.release(); await booted; return; }
    expect(outcome.ctx.server.db.query<{ error: string | null }, []>(
      "SELECT error_code AS error FROM design_execution_runs WHERE id = 'hung-active'",
    ).get()?.error).toBe('RECOVERY_REQUIRED');
    driver.release();
    await Bun.sleep(10);
    expect(outcome.ctx.server.db.query<{ error: string | null }, []>(
      "SELECT error_code AS error FROM design_execution_runs WHERE id = 'hung-active'",
    ).get()?.error).toBe('RECOVERY_REQUIRED');
  });

  test('hung publication module write times out recovery and stop without a late DB touch', async () => {
    const driver = new HungModuleDriver();
    const timeoutOptions = { publicationRecoveryTimeoutMs: 15 } as Partial<ServerOptions>;
    const ctx = await boot(undefined, undefined, driver, timeoutOptions);
    const owner = ctx.server.users.create('publication-owner');
    ctx.server.db.query(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
       VALUES (91, 'publication-recovery', 1, ?, ?, 1)`,
    ).run(path.join(ctx.ws, 'publication-recovery'), owner.user.id);
    ctx.server.db.query(
      `INSERT INTO project_modules
         (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (91, 91, 'publisher', 'Publisher', 'codex', 'manual', ?, 1)`,
    ).run(owner.user.id);
    const store = new DesignStore(ctx.server.db);
    const created = store.createRevisionedTask({
      projectId: 91,
      moduleId: 91,
      title: 'Recover publication',
      originalRequest: 'Recover a timed-out module projection.',
      agent: 'codex',
      documentJson: { goal: 'Recover safely' },
      documentMarkdown: '# Recover safely',
      readiness: 100,
      graph: {
        nodes: [{
          nodeId: 'publisher', ordinal: 0, title: 'Publisher', goal: 'Publish safely.',
          background: ['Recovery must be bounded.'], sourceSections: ['server.recovery'],
          scope: ['Recover module projection.'], nonGoals: ['No sync changes.'],
          inputs: ['Committed publication.'], outputs: ['Recovered module page.'], dependencies: [],
          implementationNotes: ['Use the durable outbox.'], moduleId: 91, runtime: 'current',
          agent: 'codex', complexity: 'medium', complexityRationale: ['External I/O may hang.'],
          acceptanceCriteria: ['Stop remains bounded.'], testRecommendations: ['Run server tests.'],
          evidenceRequirements: ['Bounded stop evidence.'], completionInstructions: ['Report recovery.'],
          implMode: 'direct', detail: null, issueId: null, lastSyncedRevision: null,
        }],
        edges: [],
      },
      actor: `owner:user:${owner.user.id}`,
    });
    ctx.server.db.query("UPDATE design_tasks SET stage = 'graph_draft' WHERE id = ?").run(created.task.id);
    store.transitionStage({
      designTaskId: created.task.id,
      expectedRevision: created.task.currentRevision,
      action: 'approve_graph',
      actor: `owner:user:${owner.user.id}`,
    });
    const recoveryDigest = designGraphDigest(created.task.id, created.task.currentRevision, store.getRevision(
      created.task.id, created.task.currentRevision,
    )!.graph);
    expect((await api(
      ctx,
      'POST',
      `/api/projects/91/designs/${created.task.id}/worktree`,
      owner.token,
      { expectedRevision: created.task.currentRevision, graphDigest: recoveryDigest, executionMode: 'current' },
      { 'Idempotency-Key': 'server-hung-workspace' },
    )).status).toBe(201);
    const confirmation = await api(
      ctx,
      'POST',
      `/api/projects/91/designs/${created.task.id}/graph/publish-confirmation`,
      owner.token,
      { expectedRevision: created.task.currentRevision },
    );
    driver.moduleMode = 'fail';
    const published = await api(
      ctx,
      'POST',
      `/api/projects/91/designs/${created.task.id}/graph/publish`,
      owner.token,
      { expectedRevision: created.task.currentRevision, confirmationToken: confirmation.body.confirmation.token },
      { 'Idempotency-Key': 'server-hung-publication' },
    );
    expect(published.body.publication.status).toBe('recoverable_error');
    ctx.server.db.query(
      'UPDATE design_publication_outbox SET next_retry_ts = 0 WHERE publication_id = ?',
    ).run(published.body.publication.publicationId);
    await ctx.server.stop();

    driver.moduleMode = 'hang';
    const second = await startServer({
      port: 0,
      dbPath: path.join(ctx.dir, 'panda.db'),
      adminTokenFile: ctx.tokenFile,
      driverFactory: () => driver,
      feishu: null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
      ...timeoutOptions,
    });
    cleanups.push(() => second.stop());
    const entered = await Promise.race([
      driver.entered.then(() => true),
      Bun.sleep(200).then(() => false),
    ]);
    expect(entered).toBe(true);

    const originalTouch = ModuleStore.prototype.touch;
    let stopReturned = false;
    let lateTouches = 0;
    ModuleStore.prototype.touch = function patchedTouch(id: number): void {
      if (stopReturned) lateTouches++;
      return originalTouch.call(this, id);
    };
    try {
      const stopping = second.stop();
      stopReturned = await Promise.race([
        stopping.then(() => true),
        Bun.sleep(100).then(() => false),
      ]);
      driver.release();
      await stopping;
      await Bun.sleep(20);
      expect(stopReturned).toBe(true);
      expect(lateTouches).toBe(0);
    } finally {
      driver.release();
      ModuleStore.prototype.touch = originalTouch;
    }
  });

  test('空数据库启动自动创建唯一系统本机执行机，重启保持幂等', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-local-bootstrap-'));
    cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
    const dbPath = path.join(dir, 'panda.db');
    const defaults = {
      workspaceRoot: path.join(dir, 'workspace'),
      // 非标准测试路径：避免服务启动时的 best-effort 技能安装后台任务干扰幂等断言。
      claudeDir: path.join(dir, 'claude-projects'),
      codexDir: path.join(dir, 'home', '.codex', 'sessions'),
      supportsClaude: true,
      supportsCodex: true,
      checkedTs: 123,
    };
    const driver = new FakeDriver();
    const options = {
      port: 0,
      dbPath,
      adminTokenFile: path.join(dir, 'admin-token'),
      driverFactory: () => driver,
      feishu: null as null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
      localExecutorDefaults: defaults,
    };

    const first = await startServer(options);
    expect(
      first.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executors WHERE is_system_local = 1')
        .get()!.n,
    ).toBe(1);
    const local = first.db
      .query<
        { host: string; workspace_root: string; codex_dir: string; supports_codex: number },
        []
      >('SELECT host, workspace_root, codex_dir, supports_codex FROM executors LIMIT 1')
      .get()!;
    expect(local).toEqual({
      host: '127.0.0.1',
      workspace_root: defaults.workspaceRoot,
      codex_dir: defaults.codexDir,
      supports_codex: 1,
    });
    await first.stop();

    const second = await startServer(options);
    cleanups.push(() => second.stop());
    expect(second.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executors').get()!.n).toBe(1);
  });

  test('healthz → admin 登录 → 建用户/项目/issue → 属主隔离 → 优雅停机', async () => {
    const ctx = await boot();

    // ---- healthz：迁移链全量（含 Issue 039/041/042、PM 040 与 Design 050-060）+ executor online + engine running ----
    const h = await api(ctx, 'GET', '/healthz');
    expect(h.status).toBe(200);
    expect(h.body.ok).toBe(true);
    expect(h.body.db.latest).toBe(60);
    expect(h.body.db.applied).toBe(42);
    expect(h.body.executors).toEqual([{ id: 1, name: 'local', status: 'online' }]);
    expect(h.body.engine.running).toBe(true);
    expect(h.body.feishu).toBe(false);

    // ---- 首启 admin token：0600 文件可登录（明文只此一处，不在任何响应/日志里） ----
    const st = await fsp.stat(ctx.tokenFile);
    expect(st.mode & 0o777).toBe(0o600);
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    expect(adminToken).toMatch(/^[0-9a-f]{48}$/);

    const bad = await api(ctx, 'POST', '/api/login', undefined, { username: 'admin', token: 'wrong' });
    expect(bad.status).toBe(401);
    const login = await api(ctx, 'POST', '/api/login', undefined, { username: 'admin', token: adminToken });
    expect(login.status).toBe(200);
    expect(login.body.role).toBe('admin');
    expect(login.headers.get('set-cookie')).toContain('panda_token=');

    // ---- 建用户：workspace 经 Driver 落到执行机（u<id> 目录 + .panda/keep） ----
    const alice = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'alice' });
    expect(alice.status).toBe(200);
    expect(alice.body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(alice.body.workspace.warnings).toEqual([]);
    const aliceId = alice.body.user.id as number;
    const keep = await fsp.readFile(path.join(ctx.ws, `u${aliceId}`, '.panda/keep'), 'utf8');
    expect(keep).toContain('alice');
    const bob = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'bob' });
    expect(bob.status).toBe(200);

    // ---- 建项目：默认 cwd 落在属主 workspace 内 + 属主自动订阅 ----
    const proj = await api(ctx, 'POST', '/api/projects', alice.body.token, {
      name: 'demo',
      executorId: 1,
    });
    expect(proj.status).toBe(200);
    const pid = proj.body.project.id as number;
    expect(proj.body.project.ownerUserId ?? proj.body.project.owner_user_id ?? aliceId).toBe(aliceId);
    expect(String(proj.body.project.cwd)).toStartWith(path.join(ctx.ws, `u${aliceId}`) + '/');
    const projectCwd = String(proj.body.project.cwd);
    await fsp.mkdir(projectCwd, { recursive: true });
    await fsp.writeFile(path.join(projectCwd, 'README.md'), '# demo\n');
    for (const args of [
      ['init', '-q'], ['add', 'README.md'],
      ['-c', 'user.name=server-test', '-c', 'user.email=server@test', 'commit', '-qm', 'initial'],
    ]) {
      const result = Bun.spawnSync({ cmd: ['git', '-C', projectCwd, ...args] });
      expect(result.exitCode).toBe(0);
    }
    const subs = await api(ctx, 'GET', '/api/me/subscriptions', alice.body.token);
    expect(subs.status).toBe(200);
    expect(subs.body.some((s: any) => s.scope === 'project' && s.targetId === pid)).toBe(true);

    // ---- Design workspace：050 已迁移、API 已由 ApiDeps 挂载、独立 chat 会话不混入普通列表 ----
    const design = await api(ctx, 'POST', `/api/projects/${pid}/designs`, alice.body.token, {
      title: 'Server design smoke',
      originalRequest: 'Prove the design domain is assembled at server startup.',
      agent: 'claude',
    });
    expect(design.status).toBe(200);
    expect(design.body.design).toMatchObject({
      projectId: pid,
      moduleId: null,
      stage: 'goal_setting',
      currentRevision: 1,
    });
    expect(typeof design.body.design.conversationId).toBe('string');
    expect(
      ctx.server.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_tasks').get()!.n,
    ).toBe(1);
    const emptySyncs = await api(
      ctx,
      'GET',
      `/api/projects/${pid}/designs/${design.body.design.id as number}/syncs`,
      alice.body.token,
    );
    expect(emptySyncs.status).toBe(200);
    expect(emptySyncs.body.syncs).toEqual([]);
    const ordinaryChats = await api(ctx, 'GET', `/api/projects/${pid}/conversations`, alice.body.token);
    expect(ordinaryChats.status).toBe(200);
    expect(ordinaryChats.body.conversations).toEqual([]);

    // ---- 建 issue（debug：跳过澄清，直接被引擎接管到 planning，注入经 FakeDriver） ----
    const issue = await api(ctx, 'POST', `/api/projects/${pid}/issues`, alice.body.token, {
      title: '冒烟 bug',
      body: '集成冒烟',
      category: 'debug',
    });
    expect(issue.status).toBe(200);
    expect(issue.body.issue.status).toBe('planning');
    // 模块会话已（模拟）拉起：boot 已把 LLM 指到不可达地址 → 分类器必走确定性回退 general-work
    expect(ctx.driver.sessions.has(`cc-${pid}-m-general-work`)).toBe(true);
    expect(ctx.driver.sent.some((s) => s.text.includes('claude --session-id'))).toBe(true);

    // ---- 列表可见 + 属主隔离：他人 403 / 未登录 401 / admin 恒过 ----
    const list = await api(ctx, 'GET', `/api/projects/${pid}/issues`, alice.body.token);
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`)).status).toBe(401);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`, bob.body.token)).status).toBe(403);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/issues`, adminToken)).status).toBe(200);
    // 普通用户项目列表只见自己的
    const bobProjects = await api(ctx, 'GET', '/api/projects', bob.body.token);
    expect(bobProjects.body).toEqual([]);
    // Free the project scheduler so the publication below proves the worktree execution gate.
    ctx.server.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(issue.body.issue.id);

    // ---- 飞书未配置：绑定接口 503，其余照常（通知路径静默跳过已由引擎流程隐式覆盖） ----
    const fs503 = await api(ctx, 'POST', '/api/me/feishu', alice.body.token, { openid: 'ou_test1234' });
    expect(fs503.status).toBe(503);

    // ---- Design publication：IssueEngine 先装配，再通过窄 batch port 注入 DesignPublisher ----
    const designId = design.body.design.id as number;
    const publishGraph: DesignGraphDraft = {
      nodes: [{
        nodeId: 'server-api', ordinal: 0, title: 'Publish server API',
        goal: 'Publish the approved server design.',
        background: ['Server assembly must expose the publisher.'],
        sourceSections: ['server.integration'], scope: ['HTTP publication wiring.'],
        nonGoals: ['No sync decisions.'], inputs: ['Approved design revision.'],
        outputs: ['One linked Issue.'], dependencies: [],
        implementationNotes: ['Use the Issue publication batch port.'],
        moduleId: null, runtime: 'current', agent: null, complexity: 'medium',
        complexityRationale: ['The transaction spans two domain stores.'],
        acceptanceCriteria: ['The endpoint creates exactly one linked Issue.'],
        testRecommendations: ['Run the server integration test.'],
        evidenceRequirements: ['Record the publication and Issue identifiers.'],
        completionInstructions: ['Report the linked Issue.'], implMode: 'direct',
        detail: null, issueId: null, lastSyncedRevision: null,
      }, {
        nodeId: 'server-worker', ordinal: 1, title: 'Implement server worker',
        goal: 'Consume the published server API.',
        background: ['One design worktree must serve the whole publication.'],
        sourceSections: ['server.integration'], scope: ['Worker integration.'],
        nonGoals: ['No second worktree.'], inputs: ['Published server API.'],
        outputs: ['A second linked Issue.'], dependencies: ['server-api'],
        implementationNotes: ['Reuse the publication execution workspace.'],
        moduleId: null, runtime: 'current', agent: null, complexity: 'low',
        complexityRationale: ['The API contract is already fixed.'],
        acceptanceCriteria: ['Both linked Issues share one worktree.'],
        testRecommendations: ['Run the server integration test.'],
        evidenceRequirements: ['Record one git worktree add.'],
        completionInstructions: ['Report the linked Issue.'], implMode: 'direct',
        detail: null, issueId: null, lastSyncedRevision: null,
      }],
      edges: [{ fromNodeId: 'server-api', toNodeId: 'server-worker', kind: 'depends_on' }],
    };
    const designStore = new DesignStore(ctx.server.db);
    ctx.server.db.query("UPDATE design_tasks SET stage = 'review' WHERE id = ?").run(designId);
    designStore.commitDocumentMutation({
      action: 'replace_graph', designTaskId: designId, expectedRevision: 1,
      documentJson: {}, documentMarkdown: '# Approved publication', readiness: 100,
      graph: publishGraph, actor: 'design_steward:server-test',
      event: { kind: 'graph_replaced', data: { source: 'server-test' } },
    });
    designStore.transitionStage({
      designTaskId: designId, expectedRevision: 2, action: 'approve_graph',
      actor: `owner:user:${aliceId}`,
    });
    for (const args of [
      ['add', '-A'],
      ['-c', 'user.name=server-test', '-c', 'user.email=server@test', 'commit', '--allow-empty', '-qm', 'design baseline'],
    ]) {
      expect(Bun.spawnSync({ cmd: ['git', '-C', projectCwd, ...args] }).exitCode).toBe(0);
    }
    const fileDiff = await api(
      ctx, 'GET', `/api/projects/${pid}/designs/${designId}/file-diff?expectedRevision=2`, alice.body.token,
    );
    expect(fileDiff).toMatchObject({ status: 200 });
    expect(fileDiff.body.diff.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining([
      'DESIGN.md', 'issue-graph.json', 'manifest.json',
    ]));
    const projected = await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/publish-files`, alice.body.token,
      { expectedRevision: 2 },
    );
    expect(projected).toMatchObject({
      status: 200, body: { publication: { status: 'published', revision: 2, targetKind: 'project' } },
    });
    expect(await fsp.readFile(path.join(projectCwd, `.panda/designs/design-${designId}/DESIGN.md`), 'utf8'))
      .toContain('Approved publication');
    const emptyWorktree = await api(
      ctx, 'GET', `/api/projects/${pid}/designs/${designId}/worktree`, alice.body.token,
    );
    expect(emptyWorktree).toMatchObject({ status: 200, body: { worktree: null } });
    const branch = Bun.spawnSync({ cmd: ['git', '-C', projectCwd, 'branch', '--show-current'] })
      .stdout.toString().trim();
    const executionIntent = await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/worktree`, alice.body.token,
      {
        expectedRevision: 2,
        graphDigest: designGraphDigest(designId, 2, publishGraph),
        executionMode: 'worktree',
        baseRef: `refs/heads/${branch}`,
      },
      { 'Idempotency-Key': `server-workspace:${designId}:2` },
    );
    expect(executionIntent).toMatchObject({
      status: 201,
      body: { worktree: { executionMode: 'worktree', lifecycleState: 'ready', publicationId: null } },
    });
    expect(ctx.driver.gitCalls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'add')).toHaveLength(1);
    const confirmation = await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/graph/publish-confirmation`,
      alice.body.token, { expectedRevision: 2 },
    );
    expect(confirmation.status).toBe(200);
    expect(confirmation.body.confirmation).toMatchObject({
      designId, projectId: pid, revision: 2,
      orderedNodes: [
        { nodeId: 'server-api', implMode: 'direct' },
        { nodeId: 'server-worker', implMode: 'direct' },
      ],
    });
    const published = await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/graph/publish`,
      alice.body.token,
      { expectedRevision: 2, confirmationToken: confirmation.body.confirmation.token },
      { 'Idempotency-Key': `server-design:${designId}:2` },
    );
    expect(published.status).toBe(200);
    expect(published.headers.get('Idempotency-Key')).toBe(`server-design:${designId}:2`);
    expect(published.body.publication).toMatchObject({
      designId, projectId: pid, revision: 2,
      issues: [
        { nodeId: 'server-api', issueId: expect.any(Number) },
        { nodeId: 'server-worker', issueId: expect.any(Number) },
      ],
    });
    expect(published.body.publication.error).toBeUndefined();
    const boundRun = await api(
      ctx, 'GET', `/api/projects/${pid}/designs/${designId}/worktree`, alice.body.token,
    );
    expect(boundRun.body.worktree.publicationId).toBe(published.body.publication.publicationId);
    const linkedBeforeExecute = ctx.server.db.query<{ status: string }, [number]>(`
      SELECT issue.status FROM design_issue_links link JOIN issues issue ON issue.id = link.issue_id
      WHERE link.publication_id = ? ORDER BY link.node_id
    `).all(published.body.publication.publicationId);
    expect(linkedBeforeExecute).toEqual([{ status: 'pending' }, { status: 'pending' }]);
    const executed = await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/worktree/execute`, alice.body.token,
      {
        publicationId: published.body.publication.publicationId,
        expectedRevision: 2,
        graphDigest: published.body.publication.graphDigest,
      },
    );
    expect(executed).toMatchObject({ status: 200, body: { worktree: { lifecycleState: 'executing' } } });
    expect(ctx.server.db.query<{ status: string }, [number]>(`
      SELECT issue.status FROM design_issue_links link JOIN issues issue ON issue.id = link.issue_id
      WHERE link.publication_id = ? ORDER BY link.node_id LIMIT 1
    `).get(published.body.publication.publicationId)?.status).toBe('planning');
    expect(ctx.driver.gitCalls.filter(({ args }) => args[0] === 'worktree' && args[1] === 'add')).toHaveLength(1);
    const worktreeDiff = await api(
      ctx, 'GET', `/api/projects/${pid}/designs/${designId}/file-diff?expectedRevision=2`, alice.body.token,
    );
    expect(worktreeDiff).toMatchObject({ status: 200, body: { diff: { targetKind: 'design_worktree' } } });
    expect((await api(
      ctx, 'POST', `/api/projects/${pid}/designs/${designId}/publish-files`, alice.body.token,
      { expectedRevision: 2 },
    ))).toMatchObject({ status: 200, body: { publication: { targetKind: 'design_worktree' } } });
    const worktreeCwd = ctx.server.db.query<{ cwd: string }, [number]>(
      'SELECT worktree_cwd AS cwd FROM design_execution_runs WHERE publication_id = ?',
    ).get(published.body.publication.publicationId)!.cwd;
    expect(await fsp.readFile(path.join(worktreeCwd, `.panda/designs/design-${designId}/DESIGN.md`), 'utf8'))
      .toContain('Approved publication');
    const linked = ctx.server.db.query<{ issue_id: number; node_id: string }, [number]>(
      'SELECT issue_id, node_id FROM design_issue_links WHERE publication_id = ? ORDER BY node_id',
    ).all(published.body.publication.publicationId);
    ctx.server.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(linked[0]!.issue_id);
    ctx.server.db.query(
      "UPDATE design_execution_runs SET error_code = 'WORKTREE_MISSING' WHERE publication_id = ?",
    ).run(published.body.publication.publicationId);
    await ctx.server.engine.scheduleNext(pid);
    expect(ctx.server.db.query<{ status: string }, [number]>(
      'SELECT status FROM issues WHERE id = ?',
    ).get(linked[1]!.issue_id)?.status).toBe('pending');
    const publications = await api(
      ctx, 'GET', `/api/projects/${pid}/designs/${designId}/publications`, alice.body.token,
    );
    expect(publications.body.publications).toEqual([published.body.publication]);
    expect(ctx.server.db.query<{ n: number }, [number]>(
      'SELECT COUNT(*) AS n FROM issues WHERE project_id = ? AND publication_locked = 1',
    ).get(pid)!.n).toBe(2);

    // ---- 静态服务：/ 回 index.html（build-ui 产物） ----
    const home = await fetch(`${ctx.base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get('content-type') ?? '').toContain('text/html');

    // ---- 优雅停机：不抛、幂等，端口随即关闭 ----
    await ctx.server.stop();
    await ctx.server.stop(); // 幂等
    await expect(fetch(`${ctx.base}/healthz`)).rejects.toBeTruthy();
  });

  test('对话模式：建 chat 项目 → 建/列/激活/重命名/归档对话 → 拒建 issue → fs/raw 内联', async () => {
    const ctx = await boot();
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const alice = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'alice' });
    const at = alice.body.token as string;

    // 建 chat 项目
    const proj = await api(ctx, 'POST', '/api/projects', at, {
      name: 'chatproj',
      executorId: 1,
      kind: 'chat',
    });
    expect(proj.status).toBe(200);
    expect(proj.body.project.kind).toBe('chat');
    const pid = proj.body.project.id as number;
    const cwd = String(proj.body.project.cwd);

    // chat 项目拒建 issue（引擎中央守卫 → 400）
    const badIssue = await api(ctx, 'POST', `/api/projects/${pid}/issues`, at, { title: '不该建' });
    expect(badIssue.status).toBe(400);

    // 建两条对话（claude + codex）→ 列表返回 2 条
    const c1 = await api(ctx, 'POST', `/api/projects/${pid}/conversations`, at, {
      label: '设计',
      agent: 'claude',
    });
    expect(c1.body.conversation.kind).toBe('chat');
    const c2 = await api(ctx, 'POST', `/api/projects/${pid}/conversations`, at, {
      label: '重构',
      agent: 'codex',
    });
    expect(c2.body.conversation.agent).toBe('codex');
    const cid1 = c1.body.conversation.id as string;
    const cid2 = c2.body.conversation.id as string;
    expect((await api(ctx, 'GET', `/api/projects/${pid}/conversations`, at)).body.conversations.length).toBe(2);

    // 激活两条 → 各起独立会话 chat-<id>，互不 kill（都在）
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid1}/activate`, at)).status).toBe(200);
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid2}/activate`, at)).status).toBe(200);
    expect(ctx.driver.sessions.has(`chat-${cid1}`)).toBe(true);
    expect(ctx.driver.sessions.has(`chat-${cid2}`)).toBe(true);
    // claude/codex 各自的启动命令都注入了各自的会话
    expect(ctx.driver.sent.some((s) => s.session === `chat-${cid1}` && s.text.includes('claude'))).toBe(true);
    expect(ctx.driver.sent.some((s) => s.session === `chat-${cid2}` && s.text.includes('codex'))).toBe(true);

    // 重命名 + 归档
    const rn = await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid1}/rename`, at, { label: '设计稿' });
    expect(rn.body.conversation.label).toBe('设计稿');
    expect((await api(ctx, 'POST', `/api/projects/${pid}/conversations/${cid2}/archive`, at)).status).toBe(200);
    expect((await api(ctx, 'GET', `/api/projects/${pid}/conversations`, at)).body.conversations.length).toBe(1);

    // fs/raw 内联预览：写个 html，raw 返回按扩展名的 content-type + inline + CSP sandbox
    await fsp.mkdir(cwd, { recursive: true });
    await fsp.writeFile(path.join(cwd, 'page.html'), '<h1>hi</h1>');
    const raw = await fetch(`${ctx.base}/api/projects/${pid}/fs/raw?path=page.html`, {
      headers: { authorization: `Bearer ${at}` },
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(raw.headers.get('content-disposition')).toContain('inline');
    expect(raw.headers.get('content-security-policy')).toBe('sandbox');
    expect(await raw.text()).toBe('<h1>hi</h1>');

    await ctx.server.stop();
  });

  test('重启不再重发 admin token（ensureAdminUser 幂等）', async () => {
    const ctx = await boot();
    const token1 = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    await ctx.server.stop();

    const server2 = await startServer({
      port: 0,
      dbPath: path.join(ctx.dir, 'panda.db'),
      adminTokenFile: path.join(ctx.dir, 'admin-token-2'), // 若误重建会写到这里
      driverFactory: () => ctx.driver,
      feishu: null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
    });
    cleanups.push(() => server2.stop());
    // 第二次启动没有新 token 文件（admin 已存在），旧 token 仍可登录
    expect(fsp.stat(path.join(ctx.dir, 'admin-token-2'))).rejects.toBeTruthy();
    const login = await fetch(`http://127.0.0.1:${server2.port}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', token: token1 }),
    });
    expect(login.status).toBe(200);
  });

  test('restart and retry timer drain only pending execution-sync effects', async () => {
    const ctx = await boot(undefined, undefined, new FakeDriver(), {
      executionSyncEffectIntervalMs: 10,
      executionSyncEffectDrainTimeoutMs: 20,
    });
    const adminToken = (await fsp.readFile(ctx.tokenFile, 'utf8')).trim();
    const owner = await api(ctx, 'POST', '/api/admin/users', adminToken, { username: 'sync-effect-owner' });
    const project = await api(ctx, 'POST', '/api/projects', owner.body.token, {
      name: 'sync-effect-project', executorId: 1,
    });
    const issue = await api(ctx, 'POST', `/api/projects/${project.body.project.id}/issues`, owner.body.token, {
      title: 'Recover external effect', category: 'debug', body: 'Drain the durable pending effect.',
    });
    const sync = ctx.server.engine.requestExecutionSync(issue.body.issue.id, {
      sourceKind: 'design', sourceKey: 'server/restart-effect', sourceRevision: '1',
      sourceDigest: 'sha256:restart', diff: { state: 'pending' },
    });
    ctx.server.engine.holdExecutionSyncBoundary(issue.body.issue.id, 'server-restart', { kind: 'safe_state' });
    ctx.server.engine.decideExecutionSync(sync.id, 'ignore', owner.body.user.id);
    ctx.server.engine.resumeExecutionSync(sync.id, (_action, _claimed, effect) => {
      effect.enqueueExternalEffect('server-restart', 'issue-sync-boundary', {
        issueId: issue.body.issue.id, action: { kind: 'safe_state' },
      });
      return { queued: true };
    });
    expect(ctx.server.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()?.state).toBe('pending');
    await ctx.server.stop();

    const restarted = await startServer({
      port: 0,
      dbPath: path.join(ctx.dir, 'panda.db'),
      adminTokenFile: path.join(ctx.dir, 'admin-token-restart'),
      driverFactory: () => ctx.driver,
      feishu: null,
      designImageRuntime: null,
      engineConfig: { tickMs: 3_600_000 },
      statusIntervalMs: 3_600_000,
      executionSyncEffectIntervalMs: 10,
      executionSyncEffectDrainTimeoutMs: 20,
    });
    cleanups.push(() => restarted.stop());
    let state = '';
    for (let attempt = 0; attempt < 30; attempt++) {
      state = restarted.db.query<{ state: string }, []>(
        'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
      ).get()?.state ?? '';
      if (state === 'delivered') break;
      await Bun.sleep(5);
    }
    expect(state).toBe('delivered');
    restarted.db.query(
      `UPDATE issue_execution_sync_effect_outbox SET delivery_state = 'uncertain' WHERE intent_key = 'server-restart'`,
    ).run();
    await Bun.sleep(30);
    expect(restarted.db.query<{ state: string }, []>(
      'SELECT delivery_state AS state FROM issue_execution_sync_effect_outbox',
    ).get()?.state).toBe('uncertain');
  });
});

describe('serveStatic 静态服务（缓存头 + 缺失资源 404）', () => {
  test('/assets immutable、缺失404不回退HTML、index no-cache、无扩展名导航回退', async () => {
    const pub = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-pub-'));
    cleanups.push(() => fsp.rm(pub, { recursive: true, force: true }));
    await fsp.mkdir(path.join(pub, 'assets'), { recursive: true });
    await fsp.writeFile(path.join(pub, 'index.html'), '<!doctype html><title>t</title><body>HOME_MARKER</body>');
    await fsp.writeFile(path.join(pub, 'assets', 'app-abc123.js'), 'export const x = 1;');

    const ctx = await boot(pub);

    // 存在的 hash chunk：200 + JS MIME + immutable 长缓存
    const js = await fetch(`${ctx.base}/assets/app-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type') ?? '').toContain('javascript');
    expect(js.headers.get('cache-control') ?? '').toContain('immutable');
    expect(await js.text()).toContain('export const x');

    // 缺失的 chunk：404，且绝不回退成 index.html（text/html）——这是 MIME 报错的根因
    const missing = await fetch(`${ctx.base}/assets/gone-999.js`);
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type') ?? '').not.toContain('text/html');

    // 带扩展名但非 /assets 的缺失文件同样 404，不回退 HTML
    const missPng = await fetch(`${ctx.base}/nope.png`);
    expect(missPng.status).toBe(404);
    expect(missPng.headers.get('content-type') ?? '').not.toContain('text/html');

    // index.html：/ 与 /index.html 都 200 + text/html + no-cache（发版即时生效）
    for (const p of ['/', '/index.html']) {
      const r = await fetch(`${ctx.base}${p}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type') ?? '').toContain('text/html');
      expect(r.headers.get('cache-control') ?? '').toContain('no-cache');
      expect(await r.text()).toContain('HOME_MARKER');
    }

    // 无扩展名导航路径（hash 路由直链兜底）：回退 index.html
    const navp = await fetch(`${ctx.base}/p/7/term`);
    expect(navp.status).toBe(200);
    expect(navp.headers.get('content-type') ?? '').toContain('text/html');
    expect(await navp.text()).toContain('HOME_MARKER');
  });
});

describe('装配纯函数', () => {
  test('in-memory databases require an explicit isolated absolute asset root', () => {
    expect(() => resolveDesignAssetStorageRoot(':memory:')).toThrow(/explicit|asset root/i);
    expect(resolveDesignAssetStorageRoot(':memory:', '/tmp/panda-assets-a')).toBe('/tmp/panda-assets-a');
    expect(resolveDesignAssetStorageRoot(':memory:', '/tmp/panda-assets-b')).toBe('/tmp/panda-assets-b');
    expect(() => resolveDesignAssetStorageRoot(':memory:', 'relative-assets')).toThrow(/absolute/i);
  });

  test('image runtime treats a missing key as disabled and rejects malformed keyed configuration', () => {
    const unusedFetch = async () => { throw new Error('must not perform network I/O while parsing configuration'); };
    expect(designImageRuntimeFromEnv({}, unusedFetch)).toBeNull();
    expect(designImageRuntimeFromEnv({ OPENAI_API_KEY: '   ' }, unusedFetch)).toBeNull();
    expect(designImageRuntimeFromEnv({
      OPENAI_API_KEY: 'test-key',
      OPENAI_IMAGE_MODEL: 'fake-image',
      OPENAI_IMAGE_OUTPUT_FORMAT: 'webp',
      OPENAI_IMAGE_QUALITY: 'high',
    }, unusedFetch)).toMatchObject({
      provider: { name: 'openai', model: 'fake-image', outputFormat: 'webp', quality: 'high' },
    });
    expect(() => designImageRuntimeFromEnv({
      OPENAI_API_KEY: 'test-key', OPENAI_IMAGE_OUTPUT_FORMAT: 'jpeg',
    }, unusedFetch)).toThrow();
  });

  test('executorStatusOf：无 status=本机在线；connected/closed/其余 → online/offline/unknown', () => {
    expect(executorStatusOf(new LocalDriver())).toBe('online');
    const withStatus = (status: string) => ({ status }) as unknown as LocalDriver;
    expect(executorStatusOf(withStatus('connected'))).toBe('online');
    expect(executorStatusOf(withStatus('closed'))).toBe('offline');
    expect(executorStatusOf(withStatus('disconnected'))).toBe('unknown');
    expect(executorStatusOf(withStatus('connecting'))).toBe('unknown');
  });

  test('trustFileOf：…/.claude/projects → 同 home 的 .claude.json；推不出 undefined', () => {
    expect(trustFileOf('/root/.claude/projects')).toBe('/root/.claude.json');
    expect(trustFileOf('/root/.claude/projects/')).toBe('/root/.claude.json');
    expect(trustFileOf('/data/claude-projects')).toBeUndefined();
  });
});

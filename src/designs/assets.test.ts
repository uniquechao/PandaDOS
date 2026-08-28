import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import {
  DesignAssetError,
  DesignAssetService,
  DesignAssetStorage,
  DesignAssetStore,
  canonicalDesignAssetRequestDigest,
  functionalDetailsComplete,
  type DesignAssetReferenceDescriptor,
} from './assets';
import type { DesignImageGenerationInput, DesignImageGenerator } from './image-provider';
import { migrateDesigns } from './store';

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fsp.rm(cleanups.pop()!, { recursive: true, force: true });
});

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

const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');

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
    (project_id, title, original_request, agent, stage, status, current_revision,
     document_json, document_markdown, created_ts, updated_ts)
    VALUES (1, 'Settings', 'Design settings', 'codex', 'review', 'active', 1,
            '{}', '# Settings', 1, 1)`);
  db.run(`INSERT INTO design_revisions
    (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
    VALUES (1, 1, '{}', '# Settings', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
  return db;
}

function reserveInput(key = 'request-1', digest = 'a'.repeat(64)) {
  return {
    designId: 1,
    revision: 1,
    requestKey: key,
    requestDigest: digest,
    preset: 'full_page_mockup' as const,
    size: '1024x1024' as const,
    prompt: 'Owner prompt',
    providerPrompt: 'Composed prompt',
    provider: 'openai',
    model: 'gpt-image-2',
    outputFormat: 'png' as const,
    quality: 'medium',
    compilerVersion: 1,
    includeRevisionContext: false,
    contextSha256: null,
    referenceManifest: [],
    retryOfAssetId: null,
    createdTs: 10,
  };
}

describe('DesignAssetStore durable CAS', () => {
  test('reserves one request key, replays the exact digest, and conflicts on different bytes', () => {
    const db = setupDb();
    const firstStore = new DesignAssetStore(db);
    const secondStore = new DesignAssetStore(db);
    const first = firstStore.reserveOrReplay(reserveInput());
    expect(first).toMatchObject({ created: true, asset: { status: 'queued', assetVersion: 0, runnable: false } });
    expect(secondStore.reserveOrReplay(reserveInput())).toMatchObject({ created: false, asset: { id: first.asset.id } });
    expect(() => secondStore.reserveOrReplay(reserveInput('request-1', 'b'.repeat(64))))
      .toThrow(DesignAssetError);
    expect(firstStore.listScoped(1, 1)).toHaveLength(1);
    db.close();
  });

  test('allows only queued-running-terminal CAS and keeps terminal rows immutable', () => {
    const db = setupDb();
    const store = new DesignAssetStore(db);
    const asset = store.reserveOrReplay(reserveInput()).asset;
    expect(store.markRunnable(asset.id, asset.assetVersion, '[]')?.assetVersion).toBe(1);
    const running = store.claimNext([])!;
    expect(running).toMatchObject({ status: 'running', assetVersion: 2 });
    expect(store.claimNext([])).toBeNull();
    expect(store.cancelScoped(1, 1, asset.id, 1)?.status).toBe('cancelled');
    expect(store.failRunning(asset.id, running.assetVersion, 'provider_failure')).toBeNull();
    expect(store.cancelScoped(1, 1, asset.id, 1)?.status).toBe('cancelled');
    db.close();
  });

  test('uses assetVersion CAS for bounded annotations and readiness', () => {
    const db = setupDb();
    const store = new DesignAssetStore(db);
    const asset = store.reserveOrReplay(reserveInput()).asset;
    const draft = store.annotateScoped({
      projectId: 1, designId: 1, assetId: asset.id, expectedAssetVersion: 0,
      functionalDetails: { altText: 'Settings page', interactions: [], responsiveBehavior: [], accessibilityNotes: [], acceptanceCriteria: [] },
      implementationReady: false, actorUserId: 1, ts: 20,
    });
    expect(draft).toMatchObject({ assetVersion: 1, implementationReady: false });
    expect(() => store.annotateScoped({
      projectId: 1, designId: 1, assetId: asset.id, expectedAssetVersion: 0,
      functionalDetails: null, implementationReady: false, actorUserId: 1, ts: 21,
    })).toThrow(DesignAssetError);
    expect(() => store.annotateScoped({
      projectId: 1, designId: 1, assetId: asset.id, expectedAssetVersion: draft.assetVersion,
      functionalDetails: {
        altText: 'Settings page', interactions: ['Save works.'], responsiveBehavior: ['Stacks on mobile.'],
        accessibilityNotes: ['Focus is visible.'], acceptanceCriteria: ['Keyboard save works.'],
      },
      implementationReady: true, actorUserId: 1, ts: 22,
    })).toThrow(DesignAssetError);
    db.close();
  });
});

describe('visual asset pure contracts', () => {
  test('canonical request digest is stable and binds ordered reference hashes', () => {
    const request = {
      schemaVersion: 1, compilerVersion: 1, projectId: 1, designId: 1, revision: 1,
      preset: 'visual_direction', prompt: 'Warm surfaces', includeRevisionContext: false,
      contextSha256: null, size: '1024x1024', acknowledgement: true,
      provider: 'openai', model: 'gpt-image-2', outputFormat: 'png', quality: 'medium',
      references: [{ source: 'design_asset', identity: 'asset:4', sha256: 'a'.repeat(64) }],
    } as const;
    expect(canonicalDesignAssetRequestDigest(request)).toBe(canonicalDesignAssetRequestDigest({ ...request }));
    expect(canonicalDesignAssetRequestDigest({ ...request, prompt: 'Cool surfaces' })).not.toBe(
      canonicalDesignAssetRequestDigest(request),
    );
    expect(canonicalDesignAssetRequestDigest({ ...request, references: [] })).not.toBe(
      canonicalDesignAssetRequestDigest(request),
    );
  });

  test('requires every functional detail family before implementation readiness', () => {
    const complete = {
      altText: 'Desktop settings screen with navigation and account controls.',
      interactions: ['Save persists changes.'],
      responsiveBehavior: ['Navigation collapses below 720px.'],
      accessibilityNotes: ['Focus order follows visual order.'],
      acceptanceCriteria: ['Keyboard users can save every field.'],
    };
    expect(functionalDetailsComplete(complete)).toBe(true);
    expect(functionalDetailsComplete({ ...complete, acceptanceCriteria: [] })).toBe(false);
    expect(functionalDetailsComplete({ ...complete, altText: '   ' })).toBe(false);
  });
});

type FakeGenerationResult = {
  mime: 'image/png';
  data: Uint8Array;
  providerRequestId: string;
};

class FakeGenerator implements DesignImageGenerator {
  readonly inputs: DesignImageGenerationInput[] = [];
  result: FakeGenerationResult = { mime: 'image/png', data: png(), providerRequestId: 'provider-1' };
  deferred: {
    promise: Promise<FakeGenerationResult>;
    resolve: (value: FakeGenerationResult) => void;
    reject: (error: unknown) => void;
  } | null = null;

  hold(): void {
    let resolve!: (value: FakeGenerationResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<FakeGenerationResult>((done, fail) => { resolve = done; reject = fail; });
    this.deferred = { promise, resolve, reject };
  }

  async generate(input: DesignImageGenerationInput) {
    this.inputs.push(input);
    return this.deferred ? await this.deferred.promise : this.result;
  }
}

async function serviceSetup(options: {
  generator?: FakeGenerator | null;
  checkpoint?: (point: string) => void | Promise<void>;
  reference?: { name: string; mime: string; data: Uint8Array };
  maxQueued?: number;
  maxConcurrent?: number;
} = {}) {
  const db = setupDb();
  const root = await fsp.mkdtemp(join(tmpdir(), 'panda-design-assets-'));
  cleanups.push(root);
  const store = new DesignAssetStore(db);
  const storage = new DesignAssetStorage(root);
  const generator = options.generator === undefined ? new FakeGenerator() : options.generator;
  const scheduled: Array<() => Promise<void>> = [];
  const service = new DesignAssetService({
    store,
    storage,
    generator,
    taskLookup: (designId) => {
      const row = db.query<{ projectId: number; currentRevision: number; status: string; markdown: string }, [number]>(
        `SELECT project_id AS projectId, current_revision AS currentRevision, status,
                document_markdown AS markdown FROM design_tasks WHERE id = ?`,
      ).get(designId);
      return row ? {
        projectId: row.projectId, designId, currentRevision: row.currentRevision,
        status: row.status, documentMarkdown: row.markdown,
      } : null;
    },
    revisionLookup: (designId, value) => {
      const row = db.query<{ revision: number; markdown: string }, [number, number]>(
        `SELECT revision, document_markdown AS markdown FROM design_revisions
         WHERE design_task_id = ? AND revision = ?`,
      ).get(designId, value);
      return row ? { revision: row.revision, documentMarkdown: row.markdown } : null;
    },
    authorizeOwner: (projectId, userId) => projectId === 1 && userId === 1,
    referenceResolver: {
      resolve: async (_scope, descriptor: DesignAssetReferenceDescriptor) => options.reference ?? {
        name: descriptor.source === 'project_file' ? 'reference.png' : `asset-${descriptor.assetId}.png`,
        mime: 'image/png', data: png(16, 16),
      },
    },
    provider: { name: 'openai', model: 'gpt-image-2', outputFormat: 'png', quality: 'medium' },
    maxConcurrent: options.maxConcurrent ?? 1,
    maxQueued: options.maxQueued ?? 10,
    schedule: (run) => { scheduled.push(run); },
    now: () => 100,
    checkpoint: options.checkpoint,
  });
  return { db, root, store, storage, generator, service, scheduled };
}

function generateInput(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 1,
    designId: 1,
    expectedRevision: 1,
    requestKey: 'request-1',
    preset: 'full_page_mockup' as const,
    prompt: 'Create a complete settings page.',
    size: '1024x1024' as const,
    includeRevisionContext: false,
    references: [] as DesignAssetReferenceDescriptor[],
    acknowledgeExternalProcessingAndCost: true as const,
    ...overrides,
  };
}

describe('DesignAssetService storage, queue, and recovery', () => {
  test('provider unavailable creates no durable or filesystem side effect', async () => {
    const setup = await serviceSetup({ generator: null });
    await expect(setup.service.enqueue(generateInput(), { userId: 1 }))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(setup.store.listScoped(1, 1)).toEqual([]);
    expect(await fsp.readdir(setup.root)).toEqual([]);

    const reserved = setup.store.reserveOrReplay(reserveInput('restart-without-key')).asset;
    expect(setup.store.markRunnable(reserved.id, reserved.assetVersion, '[]')).toMatchObject({ status: 'queued' });
    await setup.service.recover();
    expect(setup.store.listScoped(1, 1)).toEqual([
      expect.objectContaining({ id: reserved.id, status: 'queued', runnable: true }),
    ]);
    expect(await fsp.readdir(setup.root)).toEqual([]);
    setup.db.close();
  });

  test('rejects malformed runtime controls and draft detail control bytes with stable errors', async () => {
    const setup = await serviceSetup();
    for (const invalid of [
      { preset: 'unknown' }, { size: '17x19' }, { prompt: 42 }, { retryOfAssetId: 0 },
    ]) {
      await expect(setup.service.enqueue(generateInput(invalid), { userId: 1 }))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    await expect(setup.service.annotate({
      projectId: 1, designId: 1, assetId: queued.asset.id,
      expectedAssetVersion: queued.asset.assetVersion,
      functionalDetails: { altText: '\u0000', interactions: [], responsiveBehavior: [], accessibilityNotes: [], acceptanceCriteria: [] },
      implementationReady: false,
    }, { userId: 1 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    setup.db.close();
  });

  test('enforces the durable queue cap after exact-key replay', async () => {
    const setup = await serviceSetup({ maxQueued: 1 });
    const first = await setup.service.enqueue(generateInput(), { userId: 1 });
    expect((await setup.service.enqueue(generateInput(), { userId: 1 })).asset.id).toBe(first.asset.id);
    await expect(setup.service.enqueue(generateInput({ requestKey: 'request-2' }), { userId: 1 }))
      .rejects.toMatchObject({ code: 'QUEUE_FULL' });
    setup.db.close();
  });

  test('honors global concurrency while never running two jobs from one design together', async () => {
    const generator = new FakeGenerator();
    generator.hold();
    const setup = await serviceSetup({ generator, maxConcurrent: 2 });
    setup.db.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, stage, status, current_revision,
       document_json, document_markdown, created_ts, updated_ts)
      VALUES (1, 'Profile', 'Design profile', 'codex', 'review', 'active', 1,
              '{}', '# Profile', 1, 1)`);
    setup.db.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (2, 1, '{}', '# Profile', 90, '{"nodes":[],"edges":[]}', 'owner', 1)`);
    await setup.service.enqueue(generateInput({ requestKey: 'design-1-a' }), { userId: 1 });
    await setup.service.enqueue(generateInput({ requestKey: 'design-1-b' }), { userId: 1 });
    await setup.service.enqueue(generateInput({ designId: 2, requestKey: 'design-2-a' }), { userId: 1 });
    const draining = setup.service.runPending();
    while (generator.inputs.length < 2) await Promise.resolve();
    expect(generator.inputs).toHaveLength(2);
    expect(setup.store.listScoped(1, 1).filter((asset) => asset.status === 'running')).toHaveLength(1);
    expect(setup.store.listScoped(1, 2).filter((asset) => asset.status === 'running')).toHaveLength(1);
    generator.deferred!.resolve(generator.result);
    await draining;
    expect(generator.inputs).toHaveLength(3);
    expect(setup.store.listScoped(1, 1).every((asset) => asset.status === 'succeeded')).toBe(true);
    setup.db.close();
  });

  test('freezes bounded references, replays one key, and rejects a changed digest before provider execution', async () => {
    const reference = { name: '../owner-name.png', mime: 'image/png', data: png(16, 16) };
    const setup = await serviceSetup({ reference });
    const input = generateInput({ references: [{ source: 'project_file', path: 'docs/reference.png' }] });
    const first = await setup.service.enqueue(input, { userId: 1 });
    expect(first).toMatchObject({ replayed: false, asset: { status: 'queued', runnable: true } });
    expect((await setup.service.enqueue(input, { userId: 1 }))).toMatchObject({ replayed: true, asset: { id: first.asset.id } });
    await expect(setup.service.enqueue({ ...input, prompt: 'Different paid request' }, { userId: 1 }))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(setup.generator?.inputs).toHaveLength(0);
    const staged = await fsp.readdir(join(setup.root, 'staging', String(first.asset.id)));
    expect(staged).toEqual(['0.png']);
    setup.db.close();
  });

  test('runs one queued job, atomically stores exact raster metadata, and replays the response-loss row', async () => {
    const setup = await serviceSetup();
    setup.generator!.result = {
      ...setup.generator!.result,
      revisedPrompt: 'Provider revised prompt',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    } as FakeGenerationResult & { revisedPrompt: string; usage: { inputTokens: number; outputTokens: number; totalTokens: number } };
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    await setup.service.runPending();
    const succeeded = setup.store.getScoped(1, 1, queued.asset.id)!;
    expect(succeeded).toMatchObject({
      status: 'succeeded', mimeType: 'image/png', width: 1024, height: 1024,
      byteSize: png().length, outputSha256: sha(png()), path: `1/1/${queued.asset.id}.png`,
      providerRequestId: 'provider-1',
      metadata: { revisedPrompt: 'Provider revised prompt', usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    });
    expect(setup.generator?.inputs).toHaveLength(1);
    expect((await setup.service.enqueue(generateInput(), { userId: 1 })).asset.id).toBe(queued.asset.id);
    expect((await fsp.stat(join(setup.root, succeeded.path!))).mode & 0o777).toBe(0o600);
    setup.db.close();
  });

  test('cancellation wins over a late provider result and removes controlled output', async () => {
    const generator = new FakeGenerator();
    generator.hold();
    const setup = await serviceSetup({ generator });
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    const running = setup.service.runPending();
    while (generator.inputs.length === 0) await Promise.resolve();
    expect(await setup.service.cancel(1, 1, queued.asset.id, { userId: 1 })).toMatchObject({ status: 'cancelled' });
    generator.deferred!.resolve(generator.result);
    await running;
    expect(setup.store.getScoped(1, 1, queued.asset.id)?.status).toBe('cancelled');
    expect(await fsp.readdir(join(setup.root, '1', '1')).catch(() => [])).toEqual([]);
    setup.db.close();
  });

  test('shutdown stops claims, aborts active work, and leaves an ignored late result for restart recovery', async () => {
    const generator = new FakeGenerator();
    generator.hold();
    const setup = await serviceSetup({ generator });
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    const draining = setup.service.runPending();
    while (generator.inputs.length === 0) await Promise.resolve();
    await setup.service.shutdown(0);
    expect(generator.inputs[0]!.signal?.aborted).toBe(true);
    generator.deferred!.resolve(generator.result);
    await draining;
    expect(setup.store.getScoped(1, 1, queued.asset.id)?.status).toBe('running');
    setup.db.close();
  });

  test('provider late rejection after bounded shutdown never reaches the closed store', async () => {
    const generator = new FakeGenerator();
    generator.hold();
    const setup = await serviceSetup({ generator });
    await setup.service.enqueue(generateInput(), { userId: 1 });
    const draining = setup.service.runPending();
    while (generator.inputs.length === 0) await Promise.resolve();
    let lateDbTouches = 0;
    const projectIdForAsset = setup.store.projectIdForAsset.bind(setup.store);
    setup.store.projectIdForAsset = ((...args: Parameters<typeof projectIdForAsset>) => {
      lateDbTouches++;
      return projectIdForAsset(...args);
    }) as typeof setup.store.projectIdForAsset;
    await setup.service.shutdown(0);
    setup.db.close();
    generator.deferred!.reject(new Error('late provider failure'));
    await expect(draining).resolves.toBeUndefined();
    expect(lateDbTouches).toBe(0);
  });

  for (const boundary of ['prepareOutput', 'publishOutput', 'checkpoint'] as const) {
    test(`${boundary} late continuation after bounded shutdown performs no closed-DB write`, async () => {
      let entered!: () => void;
      const didEnter = new Promise<void>((resolve) => { entered = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const setup = await serviceSetup({
        checkpoint: boundary === 'checkpoint' ? async () => { entered(); await held; } : undefined,
      });
      if (boundary === 'prepareOutput') {
        const original = setup.storage.prepareOutput.bind(setup.storage);
        setup.storage.prepareOutput = async (...args) => {
          entered();
          await held;
          return original(...args);
        };
      }
      if (boundary === 'publishOutput') {
        const original = setup.storage.publishOutput.bind(setup.storage);
        setup.storage.publishOutput = async (...args) => {
          await original(...args);
          entered();
          await held;
        };
      }
      await setup.service.enqueue(generateInput(), { userId: 1 });
      const draining = setup.service.runPending();
      await didEnter;
      let lateDbTouches = 0;
      const persistExpectedOutput = setup.store.persistExpectedOutput.bind(setup.store);
      const completeRunning = setup.store.completeRunning.bind(setup.store);
      setup.store.persistExpectedOutput = ((...args: Parameters<typeof persistExpectedOutput>) => {
        lateDbTouches++;
        return persistExpectedOutput(...args);
      }) as typeof setup.store.persistExpectedOutput;
      setup.store.completeRunning = ((...args: Parameters<typeof completeRunning>) => {
        lateDbTouches++;
        return completeRunning(...args);
      }) as typeof setup.store.completeRunning;
      await setup.service.shutdown(0);
      setup.db.close();
      release();
      await expect(draining).resolves.toBeUndefined();
      expect(lateDbTouches).toBe(0);
      expect(await fsp.readdir(join(setup.root, '1', '1')).catch(() => [])).toEqual([]);
    });
  }

  test('shutdown boundedly detaches a hung recovery and a late storage result cannot touch a closed DB', async () => {
    const setup = await serviceSetup();
    const reserved = setup.store.reserveOrReplay(reserveInput('hung-recovery')).asset;
    const runnable = setup.store.markRunnable(reserved.id, reserved.assetVersion, '[]')!;
    const running = setup.store.claimNext([])!;
    setup.store.persistExpectedOutput(running.id, running.assetVersion, {
      sha256: sha(png()), bytes: png().length, mime: 'image/png', width: 1024, height: 1024,
    });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    setup.storage.verifyExpected = async () => {
      entered();
      await held;
      return `1/1/${running.id}.png`;
    };
    let lateDbTouches = 0;
    const complete = setup.store.completeRunning.bind(setup.store);
    setup.store.completeRunning = ((...args: Parameters<typeof complete>) => {
      lateDbTouches++;
      return complete(...args);
    }) as typeof setup.store.completeRunning;

    let recoverySettled = false;
    const recovery = setup.service.recover().finally(() => { recoverySettled = true; });
    await didEnter;
    const bounded = await Promise.race([
      setup.service.shutdown(10).then(() => true),
      Bun.sleep(60).then(() => false),
    ]);
    expect(bounded).toBe(true);
    expect(recoverySettled).toBe(true);
    setup.db.close();
    release();
    await recovery.catch(() => {});
    expect(lateDbTouches).toBe(0);
    expect(runnable.status).toBe('queued');
  });

  test('keeps staging, storage, metadata-crash, and terminal-CAS faults recoverable', async () => {
    const staging = await serviceSetup();
    staging.storage.stageReferences = async () => { throw new Error('disk full'); };
    await expect(staging.service.enqueue(generateInput(), { userId: 1 }))
      .rejects.toMatchObject({ code: 'STORAGE_FAILED' });
    expect(staging.store.listScoped(1, 1)[0]).toMatchObject({ status: 'failed', error: 'staging_failed' });
    staging.db.close();

    const storage = await serviceSetup();
    storage.storage.prepareOutput = async () => { throw new Error('disk full'); };
    const storageAsset = await storage.service.enqueue(generateInput(), { userId: 1 });
    await storage.service.runPending();
    expect(storage.store.getScoped(1, 1, storageAsset.asset.id))
      .toMatchObject({ status: 'failed', error: 'storage_failure' });
    storage.db.close();

    const metadata = await serviceSetup();
    const metadataAsset = await metadata.service.enqueue(generateInput(), { userId: 1 });
    metadata.store.persistExpectedOutput = () => { throw new Error('simulated process crash'); };
    await expect(metadata.service.runPending()).rejects.toThrow('simulated process crash');
    expect(metadata.store.getScoped(1, 1, metadataAsset.asset.id))
      .toMatchObject({ status: 'running', expectedOutputSha256: null });
    const calls = metadata.generator!.inputs.length;
    await metadata.service.recover();
    expect(metadata.store.getScoped(1, 1, metadataAsset.asset.id))
      .toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(metadata.generator!.inputs).toHaveLength(calls);
    metadata.db.close();

    const terminal = await serviceSetup();
    const terminalAsset = await terminal.service.enqueue(generateInput(), { userId: 1 });
    terminal.store.completeRunning = () => null;
    await terminal.service.runPending();
    expect(terminal.store.getScoped(1, 1, terminalAsset.asset.id)?.status).toBe('running');
    expect(await fsp.readdir(join(terminal.root, '1', '1')).catch(() => [])).toEqual([]);
    terminal.db.close();
  });

  test('restart finalizes only hash-verified output and never resends an ambiguous running request', async () => {
    let crash = true;
    const setup = await serviceSetup({ checkpoint: (point) => {
      if (point === 'after_output_publish' && crash) throw new Error('simulated crash');
    } });
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    await expect(setup.service.runPending()).rejects.toThrow('simulated crash');
    expect(setup.store.getScoped(1, 1, queued.asset.id)).toMatchObject({
      status: 'running', expectedOutputSha256: sha(png()),
    });
    crash = false;
    const providerCalls = setup.generator!.inputs.length;
    await setup.service.recover();
    expect(setup.store.getScoped(1, 1, queued.asset.id)?.status).toBe('succeeded');
    expect(setup.generator!.inputs).toHaveLength(providerCalls);

    const ambiguous = setup.store.reserveOrReplay(reserveInput('request-ambiguous', 'b'.repeat(64))).asset;
    setup.store.markRunnable(ambiguous.id, ambiguous.assetVersion, '[]');
    setup.store.claimNext([]);
    await setup.service.recover();
    expect(setup.store.getScoped(1, 1, ambiguous.id)).toMatchObject({ status: 'failed', error: 'interrupted' });
    expect(setup.generator!.inputs).toHaveLength(providerCalls);
    setup.db.close();
  });

  test('retry requires a new key and records terminal lineage with renewed consent', async () => {
    const setup = await serviceSetup();
    const original = await setup.service.enqueue(generateInput(), { userId: 1 });
    setup.store.failQueued(original.asset.id, original.asset.assetVersion, 'staging_failed');
    const retried = await setup.service.enqueue(generateInput({
      requestKey: 'request-2', retryOfAssetId: original.asset.id,
    }), { userId: 1 });
    expect(retried.asset.retryOfAssetId).toBe(original.asset.id);
    await expect(setup.service.enqueue(generateInput({ retryOfAssetId: original.asset.id }), { userId: 1 }))
      .rejects.toMatchObject({ code: 'RETRY_INVALID' });
    setup.db.close();
  });

  test('marks ready only with complete details on an intact current-revision output and excludes corruption from Task 9', async () => {
    const setup = await serviceSetup();
    const queued = await setup.service.enqueue(generateInput(), { userId: 1 });
    await setup.service.runPending();
    const succeeded = setup.store.getScoped(1, 1, queued.asset.id)!;
    const details = {
      altText: 'Desktop settings page with account controls.',
      interactions: ['Save persists every field.'],
      responsiveBehavior: ['Sidebar collapses below 720px.'],
      accessibilityNotes: ['Visible focus follows DOM order.'],
      acceptanceCriteria: ['Keyboard users can edit and save.'],
    };
    await expect(setup.service.annotate({
      projectId: 1, designId: 1, assetId: succeeded.id,
      expectedAssetVersion: succeeded.assetVersion, functionalDetails: { ...details, interactions: [] },
      implementationReady: true,
    }, { userId: 1 })).rejects.toMatchObject({ code: 'ANNOTATION_INCOMPLETE' });
    const ready = await setup.service.annotate({
      projectId: 1, designId: 1, assetId: succeeded.id,
      expectedAssetVersion: succeeded.assetVersion, functionalDetails: details,
      implementationReady: true,
    }, { userId: 1 });
    expect(ready).toMatchObject({ implementationReady: true, readyByUserId: 1 });
    expect(await setup.service.listForRevision(1, 1, 1)).toHaveLength(1);

    await fsp.writeFile(join(setup.root, ready.path!), Uint8Array.from([1, 2, 3]));
    expect(await setup.service.listForRevision(1, 1, 1)).toEqual([]);
    await expect(setup.service.annotate({
      projectId: 1, designId: 1, assetId: ready.id,
      expectedAssetVersion: ready.assetVersion, functionalDetails: details,
      implementationReady: true,
    }, { userId: 1 })).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    setup.db.close();
  });
});

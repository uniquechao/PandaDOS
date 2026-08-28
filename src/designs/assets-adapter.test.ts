import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { createDesignAssetReferenceResolver, createDesignAssetRuntime } from './assets-adapter';
import { DesignAssetError, DesignAssetStorage, DesignAssetStore } from './assets';
import { migrateDesigns } from './store';
import type { DesignRevision, DesignTask } from './types';

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function png(width = 16, height = 16): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

function database() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  return db;
}

describe('production visual asset assembly ports', () => {
  test('builds a healthy disabled runtime without a provider secret or side effect', async () => {
    const db = database();
    const root = await fsp.mkdtemp(join(tmpdir(), 'panda-asset-runtime-'));
    roots.push(root);
    const task = { id: 9, projectId: 1, status: 'active', currentRevision: 2, documentMarkdown: '# Design' } as DesignTask;
    const revision = { designTaskId: 9, revision: 2, documentMarkdown: '# Design' } as DesignRevision;
    const runtime = createDesignAssetRuntime({
      db, storageRoot: root, generator: null,
      designStore: {
        getTask: (id) => id === 9 ? task : null,
        getRevision: (id, value) => id === 9 && value === 2 ? revision : null,
        isTaskProvisional: () => false,
      },
      authorizeOwner: () => true,
    });
    expect(runtime.service.capability()).toMatchObject({
      enabled: false, provider: null, model: null, reason: 'not_configured',
    });
    await expect(runtime.service.enqueue({
      projectId: 1, designId: 9, expectedRevision: 2, requestKey: 'paid-1',
      preset: 'full_page_mockup', prompt: 'Settings', size: '1024x1024',
      includeRevisionContext: false, references: [], acknowledgeExternalProcessingAndCost: true,
    }, { userId: 1 })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(runtime.store.listScoped(1, 9)).toEqual([]);
    expect(await fsp.readdir(root)).toEqual([]);
    db.close();
  });

  test('exposes only a bounded secure project-file reader and validates returned bytes itself', async () => {
    const db = database();
    const root = await fsp.mkdtemp(join(tmpdir(), 'panda-asset-resolver-'));
    roots.push(root);
    const calls: unknown[] = [];
    let bytes = png();
    const resolver = createDesignAssetReferenceResolver({
      store: new DesignAssetStore(db),
      storage: new DesignAssetStorage(root),
      projectFiles: {
        async read(scope, path, limit, signal) {
          calls.push({ scope, path, limit, signal });
          return bytes;
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(resolver.resolve(
      { projectId: 3, designId: 4 }, { source: 'project_file', path: 'docs/reference.png' }, signal,
    )).resolves.toMatchObject({ name: 'reference.png', mime: 'image/png' });
    expect(calls).toEqual([{
      scope: { projectId: 3, designId: 4 }, path: 'docs/reference.png',
      limit: 8 * 1024 * 1024, signal,
    }]);
    bytes = Uint8Array.from([137, 80, 78, 71]);
    await expect(resolver.resolve(
      { projectId: 3, designId: 4 }, { source: 'project_file', path: 'docs/reference.png' }, signal,
    )).rejects.toMatchObject({ code: 'REFERENCE_INVALID' });
    db.close();
  });

  test('requires explicit provider provenance whenever a generator is configured', async () => {
    const db = database();
    const root = await fsp.mkdtemp(join(tmpdir(), 'panda-asset-provider-'));
    roots.push(root);
    expect(() => createDesignAssetRuntime({
      db, storageRoot: root,
      generator: { async generate() { return { mime: 'image/png', data: png() }; } },
      designStore: { getTask: () => null, getRevision: () => null },
      authorizeOwner: () => true,
    })).toThrow(DesignAssetError);
    db.close();
  });
});

import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { DesignAssetError, type FunctionalDetails, type GenerateDesignAssetInput } from '../../designs/assets';
import type { DesignAsset, DesignTask } from '../../designs/types';
import { authDepsFromDb, createDispatcher } from '../middleware';
import {
  designAssetsRoutes,
  type DesignAssetsCapability,
  type DesignAssetsRouteService,
} from './design-assets';

function design(status: 'active' | 'archived' = 'active', projectId = 1): DesignTask {
  return { id: 9, projectId, status, currentRevision: 2 } as DesignTask;
}

function asset(overrides: Partial<DesignAsset> = {}): DesignAsset {
  return {
    id: 7, designTaskId: 9, designRevision: 2, prompt: 'private owner prompt', provider: 'openai',
    status: 'succeeded', path: '1/9/7.png', mimeType: 'image/png', width: 1024, height: 1024,
    metadata: { revisedPrompt: 'private provider prompt' }, error: null, kind: 'raster_reference',
    preset: 'full_page_mockup', size: '1024x1024', requestKey: 'private-key',
    requestDigest: 'a'.repeat(64), assetVersion: 4, byteSize: 8, outputSha256: 'b'.repeat(64),
    implementationReady: true, functionalDetails: {
      altText: 'Settings page', interactions: ['Save works.'], responsiveBehavior: ['Stacks on mobile.'],
      accessibilityNotes: ['Focus is visible.'], acceptanceCriteria: ['Keyboard save works.'],
    }, retryOfAssetId: null, providerRequestId: 'provider-request', runnable: false,
    stagingManifest: [{ path: '/private/staging' }], providerPrompt: 'private compiled prompt',
    promptCompilerVersion: 1, includeRevisionContext: false, contextSha256: null,
    referenceManifest: [{ identity: 'project:secret.png' }], providerModel: 'gpt-image-2',
    outputFormat: 'png', quality: 'medium', expectedOutputSha256: 'b'.repeat(64), expectedByteSize: 8,
    expectedMimeType: 'image/png', expectedWidth: 1024, expectedHeight: 1024,
    readyByUserId: 2, readyTs: 20, createdTs: 10, updatedTs: 20,
    ...overrides,
  };
}

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');

function setupRoutes(options: { archived?: boolean; enabled?: boolean } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const owner = users.create('owner');
  const member = users.create('member');
  const stranger = users.create('stranger');
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'root', '', '/workspace', '/claude')`);
  db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, '/workspace/one', ?, 1),
           (2, 'two', 1, '/workspace/two', ?, 1)`).run(owner.user.id, owner.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 1)')
    .run(member.user.id);
  const calls: Array<{ kind: string; input?: unknown }> = [];
  let failure: unknown = null;
  const capability: DesignAssetsCapability = options.enabled === false ? {
    enabled: false, provider: null, model: null, sizes: ['1024x1024', '1536x1024', '1024x1536'],
    formats: ['image/png', 'image/webp'], maxReferences: 4, maxReferenceBytes: 8 * 1024 * 1024,
    maxAggregateReferenceBytes: 20 * 1024 * 1024, requiresExplicitAcknowledgement: true,
    reason: 'not_configured',
  } : {
    enabled: true, provider: 'openai', model: 'gpt-image-2', sizes: ['1024x1024'],
    formats: ['image/png'], maxReferences: 4, maxReferenceBytes: 8 * 1024 * 1024,
    maxAggregateReferenceBytes: 20 * 1024 * 1024, requiresExplicitAcknowledgement: true,
    reason: null,
  };
  const service: DesignAssetsRouteService = {
    capability() { calls.push({ kind: 'capability' }); return capability; },
    async list() { calls.push({ kind: 'list' }); if (failure) throw failure; return [asset()]; },
    async content(projectId, designId, assetId) {
      calls.push({ kind: 'content', input: { projectId, designId, assetId } });
      if (failure) throw failure;
      const data = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
      return { asset: asset({ outputSha256: sha256(data) }), data };
    },
    async enqueue(input, actor) {
      calls.push({ kind: 'enqueue', input: { input, actor } });
      if (failure) throw failure;
      return { asset: asset({ status: 'queued', path: null, mimeType: null }), replayed: false };
    },
    async cancel(projectId, designId, assetId, actor) {
      calls.push({ kind: 'cancel', input: { projectId, designId, assetId, actor } });
      if (failure) throw failure;
      return asset({ status: 'cancelled' });
    },
    async annotate(input, actor) {
      calls.push({ kind: 'annotate', input: { input, actor } });
      if (failure) throw failure;
      return asset({ assetVersion: input.expectedAssetVersion + 1, implementationReady: input.implementationReady });
    },
  };
  const store = {
    getTask(id: number) { return id === 9 ? design(options.archived ? 'archived' : 'active') : null; },
    isTaskProvisional() { return false; },
  };
  const dispatch = createDispatcher(designAssetsRoutes({ store, service }), authDepsFromDb(db, users));
  return {
    db, dispatch, calls, admin, owner, member, stranger,
    fail(value: unknown) { failure = value; },
  };
}

function request(method: string, path: string, token?: string, body?: unknown, key?: string): Request {
  return new Request(`http://test${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function jsonResponse(value: Response | Promise<Response> | null) {
  const response = await value!;
  return { response, status: response.status, body: await response.json() as Record<string, any> };
}

const generateBody = {
  expectedRevision: 2,
  preset: 'full_page_mockup',
  prompt: 'Create the settings page.',
  size: '1024x1024',
  includeRevisionContext: false,
  references: [],
  acknowledgeExternalProcessingAndCost: true,
} satisfies Omit<GenerateDesignAssetInput, 'projectId' | 'designId' | 'requestKey' | 'retryOfAssetId'>;

const details: FunctionalDetails = {
  altText: 'Settings page', interactions: ['Save works.'], responsiveBehavior: ['Stacks on mobile.'],
  accessibilityNotes: ['Focus is visible.'], acceptanceCriteria: ['Keyboard save works.'],
};

describe('design visual asset routes', () => {
  test('capability and listing are member-readable, owner mutations stay owner-only, and cross scope is hidden', async () => {
    const setup = setupRoutes({ enabled: false });
    const base = '/api/projects/1/designs/9/assets';
    expect((await jsonResponse(setup.dispatch(request('GET', `${base}/capability`)))).status).toBe(401);
    expect((await jsonResponse(setup.dispatch(request('GET', `${base}/capability`, setup.stranger.token)))).status).toBe(403);
    const capability = await jsonResponse(setup.dispatch(request('GET', `${base}/capability`, setup.member.token)));
    expect(capability).toMatchObject({ status: 200, body: { ok: true, capability: { enabled: false, reason: 'not_configured' } } });
    expect((await jsonResponse(setup.dispatch(request('GET', base, setup.member.token)))).status).toBe(200);
    expect((await jsonResponse(setup.dispatch(request('POST', `${base}/generate`, setup.member.token, generateBody, 'paid-1')))).status).toBe(403);
    expect((await jsonResponse(setup.dispatch(request('POST', `${base}/generate`, setup.owner.token, generateBody, 'paid-1')))).status).toBe(503);
    expect(setup.calls.filter((call) => call.kind === 'enqueue')).toEqual([]);
    const cross = await jsonResponse(setup.dispatch(request('GET', '/api/projects/2/designs/9/assets', setup.owner.token)));
    expect(cross).toMatchObject({ status: 404, body: { error: { code: 'design.asset_not_found' } } });
    setup.db.close();
  });

  test('returns an explicit safe asset DTO without paths, prompts, request keys, manifests, or metadata', async () => {
    const setup = setupRoutes();
    const result = await jsonResponse(setup.dispatch(request(
      'GET', '/api/projects/1/designs/9/assets', setup.member.token,
    )));
    expect(result.body).toEqual({
      ok: true,
      assets: [{
        id: 7, designRevision: 2, status: 'succeeded', kind: 'raster_reference',
        preset: 'full_page_mockup', size: '1024x1024', provider: 'openai', providerModel: 'gpt-image-2',
        outputFormat: 'png', quality: 'medium', mimeType: 'image/png', width: 1024, height: 1024,
        byteSize: 8, outputSha256: 'b'.repeat(64), implementationReady: true,
        functionalDetails: details, retryOfAssetId: null, providerRequestId: 'provider-request',
        assetVersion: 4, error: null, createdTs: 10, updatedTs: 20,
        contentUrl: '/api/projects/1/designs/9/assets/7/content',
      }],
    });
    const serialized = JSON.stringify(result.body);
    for (const secret of ['/private', 'private owner', 'private provider', 'private-key', 'private compiled', 'secret.png']) {
      expect(serialized).not.toContain(secret);
    }
    setup.db.close();
  });

  test('serves only scoped verified bytes with fixed image headers and no storage key', async () => {
    const setup = setupRoutes();
    const result = await setup.dispatch(request(
      'GET', '/api/projects/1/designs/9/assets/7/content', setup.member.token,
    ))!;
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toBe('image/png');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    expect(result.headers.get('content-length')).toBe('8');
    expect(result.headers.get('etag')).toBe(`"${sha256(Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]))}"`);
    expect(result.headers.get('content-disposition')).toBe('inline; filename="design-asset-7.png"');
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]));
    setup.db.close();
  });

  test('strictly requires one paid key, exact body, consent, and revision before enqueue', async () => {
    const setup = setupRoutes();
    const url = '/api/projects/1/designs/9/assets/generate';
    for (const [body, key] of [
      [generateBody, undefined],
      [{ ...generateBody, acknowledgeExternalProcessingAndCost: false }, 'paid-1'],
      [{ ...generateBody, expectedRevision: '2' }, 'paid-1'],
      [{ ...generateBody, cwd: '/private/repo' }, 'paid-1'],
      [{ ...generateBody, references: [{ source: 'project_file', path: '../secret' }] }, 'paid-1'],
    ] as Array<[unknown, string | undefined]>) {
      const result = await jsonResponse(setup.dispatch(request('POST', url, setup.owner.token, body, key)));
      expect(result).toMatchObject({ status: 400, body: { error: { code: 'design.asset_invalid_request' } } });
    }
    const valid = await jsonResponse(setup.dispatch(request('POST', url, setup.owner.token, generateBody, 'paid-1')));
    expect(valid).toMatchObject({ status: 202, body: { ok: true, asset: { id: 7 }, replayed: false } });
    const call = setup.calls.find((item) => item.kind === 'enqueue')!.input as {
      input: GenerateDesignAssetInput; actor: { userId: number };
    };
    expect(call.input).toEqual({ projectId: 1, designId: 9, requestKey: 'paid-1', ...generateBody });
    expect(call.actor).toEqual({ userId: setup.owner.user.id });
    setup.db.close();
  });

  test('rejects non-canonical numeric path identifiers before scoped lookup', async () => {
    const setup = setupRoutes();
    for (const path of [
      '/api/projects/01/designs/9/assets',
      '/api/projects/1/designs/1e1/assets',
      '/api/projects/1/designs/9/assets/+7/content',
    ]) {
      const result = await jsonResponse(setup.dispatch(request('GET', path, setup.owner.token)));
      expect(result).toMatchObject({ status: 400, body: { error: { code: 'design.asset_invalid_request' } } });
    }
    expect(setup.calls).toEqual([]);
    setup.db.close();
  });

  test('supports renewed-consent retry, idempotent cancel, and versioned details while archived designs are read-only', async () => {
    const setup = setupRoutes();
    const base = '/api/projects/1/designs/9/assets/7';
    expect((await jsonResponse(setup.dispatch(request('POST', `${base}/retry`, setup.owner.token, generateBody, 'retry-1')))).status).toBe(202);
    const retryCall = setup.calls.find((item) => item.kind === 'enqueue')!.input as { input: GenerateDesignAssetInput };
    expect(retryCall.input).toMatchObject({ requestKey: 'retry-1', retryOfAssetId: 7 });
    expect((await jsonResponse(setup.dispatch(request('POST', `${base}/cancel`, setup.owner.token, {})))).status).toBe(200);
    const patched = await jsonResponse(setup.dispatch(request('PATCH', base, setup.owner.token, {
      expectedAssetVersion: 4, functionalDetails: details, implementationReady: true,
    })));
    expect(patched).toMatchObject({ status: 200, body: { asset: { assetVersion: 5, implementationReady: true } } });
    setup.db.close();

    const archived = setupRoutes({ archived: true });
    expect((await jsonResponse(archived.dispatch(request('GET', '/api/projects/1/designs/9/assets', archived.member.token)))).status).toBe(200);
    for (const [method, path, body, key] of [
      ['POST', '/api/projects/1/designs/9/assets/generate', generateBody, 'paid-1'],
      ['POST', '/api/projects/1/designs/9/assets/7/retry', generateBody, 'retry-1'],
      ['POST', '/api/projects/1/designs/9/assets/7/cancel', {}, undefined],
      ['PATCH', '/api/projects/1/designs/9/assets/7', { expectedAssetVersion: 4, functionalDetails: details, implementationReady: true }, undefined],
    ] as Array<[string, string, unknown, string | undefined]>) {
      const result = await jsonResponse(archived.dispatch(request(method, path, archived.owner.token, body, key)));
      expect(result).toMatchObject({ status: 409, body: { error: { code: 'design.asset_archived' } } });
    }
    archived.db.close();
  });

  test('maps stable service errors without returning technical diagnostics or secrets', async () => {
    const cases: Array<[DesignAssetError['code'], number, string]> = [
      ['INVALID_REQUEST', 400, 'design.asset_invalid_request'],
      ['NOT_FOUND', 404, 'design.asset_not_found'],
      ['REVISION_CONFLICT', 409, 'design.asset_revision_conflict'],
      ['ARCHIVED', 409, 'design.asset_archived'],
      ['PROVIDER_UNAVAILABLE', 503, 'design.asset_provider_unavailable'],
      ['IDEMPOTENCY_CONFLICT', 409, 'design.asset_idempotency_conflict'],
      ['QUEUE_FULL', 429, 'design.asset_queue_full'],
      ['REFERENCE_UNAVAILABLE', 409, 'design.asset_reference_unavailable'],
      ['REFERENCE_INVALID', 400, 'design.asset_reference_invalid'],
      ['STORAGE_FAILED', 500, 'design.asset_storage_failed'],
      ['STORAGE_CORRUPT', 409, 'design.asset_corrupt'],
      ['ASSET_VERSION_CONFLICT', 409, 'design.asset_version_conflict'],
      ['ANNOTATION_INCOMPLETE', 400, 'design.asset_annotation_incomplete'],
      ['RETRY_INVALID', 409, 'design.asset_retry_invalid'],
    ];
    for (const [code, status, errorCode] of cases) {
      const setup = setupRoutes();
      setup.fail(new DesignAssetError(code, 'secret OPENAI_API_KEY=/private/key owner prompt'));
      const result = await jsonResponse(setup.dispatch(request(
        'GET', '/api/projects/1/designs/9/assets', setup.owner.token,
      )));
      expect(result).toMatchObject({ status, body: { error: { code: errorCode } } });
      expect(JSON.stringify(result.body)).not.toContain('OPENAI_API_KEY');
      expect(JSON.stringify(result.body)).not.toContain('/private/key');
      setup.db.close();
    }
  });
});

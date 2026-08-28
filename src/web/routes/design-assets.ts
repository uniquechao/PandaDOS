import { createHash } from 'node:crypto';
import {
  DesignAssetError,
  functionalDetailsValid,
  type DesignAssetCapability,
  type FunctionalDetails,
  type GenerateDesignAssetInput,
} from '../../designs/assets';
import type { DesignAsset, DesignTask } from '../../designs/types';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

const MAX_BODY_BYTES = 32 * 1024;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRESETS = new Set(['full_page_mockup', 'component_states', 'visual_direction']);
const SIZES = new Set(['1024x1024', '1536x1024', '1024x1536']);

export type DesignAssetsCapability = DesignAssetCapability;

export interface DesignAssetsRouteService {
  capability(): DesignAssetsCapability;
  list(projectId: number, designId: number): Promise<DesignAsset[]>;
  content(projectId: number, designId: number, assetId: number): Promise<{ asset: DesignAsset; data: Uint8Array }>;
  enqueue(input: GenerateDesignAssetInput, actor: { userId: number }): Promise<{ asset: DesignAsset; replayed: boolean }>;
  cancel(projectId: number, designId: number, assetId: number, actor: { userId: number }): Promise<DesignAsset>;
  annotate(input: {
    projectId: number; designId: number; assetId: number; expectedAssetVersion: number;
    functionalDetails: FunctionalDetails; implementationReady: boolean;
  }, actor: { userId: number }): Promise<DesignAsset>;
}

export interface DesignAssetsRoutesDeps {
  store: {
    getTask(id: number): DesignTask | null;
    isTaskProvisional(id: number): boolean;
  };
  service: DesignAssetsRouteService;
}

interface GenerateBody {
  expectedRevision: number;
  preset: GenerateDesignAssetInput['preset'];
  prompt: string;
  size: GenerateDesignAssetInput['size'];
  includeRevisionContext: boolean;
  references: GenerateDesignAssetInput['references'];
  acknowledgeExternalProcessingAndCost: true;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

const PUBLIC_ASSET_ERRORS = new Set([
  'staging_failed', 'provider_failure', 'cancelled', 'invalid_output', 'storage_failure',
  'interrupted_staging', 'interrupted', 'legacy_status',
]);

function safeControl(value: string | null, max = 200): string | null {
  return value !== null && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

async function boundedJson(req: Request): Promise<unknown | null> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function reference(value: unknown): value is GenerateDesignAssetInput['references'][number] {
  if (!record(value)) return false;
  if (value.source === 'design_asset') {
    return Object.keys(value).length === 2 && positive(value.assetId);
  }
  return value.source === 'project_file'
    && Object.keys(value).length === 2
    && typeof value.path === 'string'
    && value.path.length > 0
    && value.path.length <= 1_000
    && !value.path.includes('\0')
    && !value.path.startsWith('/')
    && value.path.split('/').every((part) => part && part !== '.' && part !== '..');
}

function generateBody(value: unknown): value is GenerateBody {
  if (!record(value)
    || Object.keys(value).length !== 7
    || !['expectedRevision', 'preset', 'prompt', 'size', 'includeRevisionContext', 'references',
      'acknowledgeExternalProcessingAndCost'].every((key) => Object.hasOwn(value, key))
    || !positive(value.expectedRevision)
    || !PRESETS.has(value.preset as string)
    || !SIZES.has(value.size as string)
    || typeof value.prompt !== 'string'
    || !value.prompt.trim()
    || [...value.prompt].length > 2_000
    || Buffer.byteLength(value.prompt, 'utf8') > 8 * 1024
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.prompt)
    || typeof value.includeRevisionContext !== 'boolean'
    || !Array.isArray(value.references)
    || value.references.length > 4
    || !value.references.every(reference)
    || value.acknowledgeExternalProcessingAndCost !== true) return false;
  return true;
}

function key(req: Request): string | null {
  const value = req.headers.get('idempotency-key');
  return value !== null && KEY_RE.test(value) ? value : null;
}

function scopedDesign(deps: DesignAssetsRoutesDeps, projectId: number, designId: number): DesignTask | null {
  const task = deps.store.getTask(designId);
  return task && task.projectId === projectId && !deps.store.isTaskProvisional(designId) ? task : null;
}

function assetView(projectId: number, designId: number, asset: DesignAsset) {
  return {
    id: asset.id,
    designRevision: asset.designRevision,
    status: asset.status,
    kind: asset.kind,
    preset: asset.preset,
    size: asset.size,
    provider: safeControl(asset.provider),
    providerModel: safeControl(asset.providerModel),
    outputFormat: asset.outputFormat,
    quality: safeControl(asset.quality, 32),
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    byteSize: asset.byteSize,
    outputSha256: asset.outputSha256 && /^[a-f0-9]{64}$/.test(asset.outputSha256) ? asset.outputSha256 : null,
    implementationReady: asset.implementationReady,
    functionalDetails: functionalDetailsValid(asset.functionalDetails) ? asset.functionalDetails : null,
    retryOfAssetId: asset.retryOfAssetId,
    providerRequestId: safeControl(asset.providerRequestId),
    assetVersion: asset.assetVersion,
    error: asset.error && PUBLIC_ASSET_ERRORS.has(asset.error) ? asset.error : asset.error === null ? null : 'generation_failed',
    createdTs: asset.createdTs,
    updatedTs: asset.updatedTs,
    contentUrl: asset.status === 'succeeded'
      ? `/api/projects/${projectId}/designs/${designId}/assets/${asset.id}/content`
      : null,
  };
}

function invalid(): Response {
  return json(apiError('design.asset_invalid_request', 'The visual asset request is invalid.', 400), 400);
}

function notFound(): Response {
  return json(apiError('design.asset_not_found', 'The visual asset does not exist in this project.', 404), 404);
}

function archived(): Response {
  return json(apiError('design.asset_archived', 'Archived designs are read-only.', 409), 409);
}

function errorResponse(error: unknown, currentRevision?: number): Response {
  if (!(error instanceof DesignAssetError)) {
    return json(apiError('design.asset_operation_failed', 'The visual asset operation could not be completed.', 500), 500);
  }
  const mapped: Record<DesignAssetError['code'], { status: number; code: string; fallback: string }> = {
    INVALID_REQUEST: { status: 400, code: 'design.asset_invalid_request', fallback: 'The visual asset request is invalid.' },
    FORBIDDEN: { status: 403, code: 'design.asset_forbidden', fallback: 'You cannot manage visual assets.' },
    NOT_FOUND: { status: 404, code: 'design.asset_not_found', fallback: 'The visual asset does not exist in this project.' },
    REVISION_CONFLICT: { status: 409, code: 'design.asset_revision_conflict', fallback: 'The design revision changed.' },
    ARCHIVED: { status: 409, code: 'design.asset_archived', fallback: 'Archived designs are read-only.' },
    PROVIDER_UNAVAILABLE: { status: 503, code: 'design.asset_provider_unavailable', fallback: 'Image generation is not configured.' },
    IDEMPOTENCY_CONFLICT: { status: 409, code: 'design.asset_idempotency_conflict', fallback: 'The idempotency key identifies another request.' },
    QUEUE_FULL: { status: 429, code: 'design.asset_queue_full', fallback: 'The visual asset queue is full.' },
    REFERENCE_UNAVAILABLE: { status: 409, code: 'design.asset_reference_unavailable', fallback: 'A selected reference is unavailable.' },
    REFERENCE_INVALID: { status: 400, code: 'design.asset_reference_invalid', fallback: 'A selected reference is invalid.' },
    STORAGE_FAILED: { status: 500, code: 'design.asset_storage_failed', fallback: 'The generated asset could not be stored.' },
    STORAGE_CORRUPT: { status: 409, code: 'design.asset_corrupt', fallback: 'The generated asset is unavailable or corrupt.' },
    ASSET_VERSION_CONFLICT: { status: 409, code: 'design.asset_version_conflict', fallback: 'The visual asset changed.' },
    ANNOTATION_INCOMPLETE: { status: 400, code: 'design.asset_annotation_incomplete', fallback: 'Complete the functional details first.' },
    RETRY_INVALID: { status: 409, code: 'design.asset_retry_invalid', fallback: 'This visual asset cannot be retried.' },
  };
  const value = mapped[error.code];
  return json(apiError(
    value.code,
    value.fallback,
    value.status,
    error.code === 'REVISION_CONFLICT' && currentRevision !== undefined ? { currentRevision } : {},
  ), value.status);
}

function parseIds(params: Record<string, string>, includeAsset = false): {
  projectId: number; designId: number; assetId?: number;
} | null {
  const parse = (value: string | undefined): number => {
    if (!value || !/^[1-9]\d{0,15}$/.test(value)) return Number.NaN;
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : Number.NaN;
  };
  const projectId = parse(params.projectId);
  const designId = parse(params.designId);
  const assetId = includeAsset ? parse(params.assetId) : undefined;
  if (!positive(projectId) || !positive(designId) || (includeAsset && !positive(assetId))) return null;
  return { projectId, designId, ...(assetId === undefined ? {} : { assetId }) };
}

export function designAssetsRoutes(deps: DesignAssetsRoutesDeps): RouteDef[] {
  const load = (params: Record<string, string>, includeAsset = false):
    | { error: Response }
    | { ids: { projectId: number; designId: number; assetId?: number }; task: DesignTask } => {
    const ids = parseIds(params, includeAsset);
    if (!ids) return { error: invalid() } as const;
    const task = scopedDesign(deps, ids.projectId, ids.designId);
    if (!task) return { error: notFound() } as const;
    return { ids, task } as const;
  };
  const generate = async (req: Request, params: Record<string, string>, retry = false, userId?: number): Promise<Response> => {
    const loaded = load(params, retry);
    if ('error' in loaded) return loaded.error;
    if (loaded.task.status === 'archived') return archived();
    const requestKey = key(req);
    const body = await boundedJson(req);
    if (!requestKey || !generateBody(body)) return invalid();
    const capability = deps.service.capability();
    if (!capability.enabled) return errorResponse(new DesignAssetError('PROVIDER_UNAVAILABLE', 'not configured'));
    try {
      const result = await deps.service.enqueue({
        projectId: loaded.ids.projectId,
        designId: loaded.ids.designId,
        requestKey,
        ...body,
        ...(retry ? { retryOfAssetId: loaded.ids.assetId! } : {}),
      }, { userId: userId! });
      return json({ ok: true, asset: assetView(loaded.ids.projectId, loaded.ids.designId, result.asset), replayed: result.replayed }, 202);
    } catch (error) {
      return errorResponse(error, loaded.task.currentRevision);
    }
  };
  return [
    {
      method: 'GET', path: '/api/projects/:projectId/designs/:designId/assets/capability', auth: 'project-access',
      handler: ({ params }) => {
        const loaded = load(params);
        return 'error' in loaded ? loaded.error : json({ ok: true, capability: deps.service.capability() });
      },
    },
    {
      method: 'GET', path: '/api/projects/:projectId/designs/:designId/assets', auth: 'project-access',
      handler: async ({ params }) => {
        const loaded = load(params);
        if ('error' in loaded) return loaded.error;
        try {
          const assets = await deps.service.list(loaded.ids.projectId, loaded.ids.designId);
          return json({ ok: true, assets: assets.map((item) => assetView(loaded.ids.projectId, loaded.ids.designId, item)) });
        } catch (error) { return errorResponse(error, loaded.task.currentRevision); }
      },
    },
    {
      method: 'GET', path: '/api/projects/:projectId/designs/:designId/assets/:assetId/content', auth: 'project-access',
      handler: async ({ params }) => {
        const loaded = load(params, true);
        if ('error' in loaded) return loaded.error;
        try {
          const result = await deps.service.content(loaded.ids.projectId, loaded.ids.designId, loaded.ids.assetId!);
          const { asset, data } = result;
          if (asset.designTaskId !== loaded.ids.designId || asset.id !== loaded.ids.assetId
            || asset.status !== 'succeeded' || (asset.mimeType !== 'image/png' && asset.mimeType !== 'image/webp')
            || !asset.outputSha256 || asset.byteSize !== data.length
            || createHash('sha256').update(data).digest('hex') !== asset.outputSha256) {
            throw new DesignAssetError('STORAGE_CORRUPT', 'Controlled asset bytes do not match metadata.');
          }
          const extension = asset.mimeType === 'image/png' ? 'png' : 'webp';
          return new Response(data as BodyInit, { headers: {
            'content-type': asset.mimeType,
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=0, must-revalidate',
            'content-length': String(data.length),
            etag: `"${asset.outputSha256}"`,
            'content-disposition': `inline; filename="design-asset-${asset.id}.${extension}"`,
          } });
        } catch (error) { return errorResponse(error, loaded.task.currentRevision); }
      },
    },
    {
      method: 'POST', path: '/api/projects/:projectId/designs/:designId/assets/generate', auth: 'project-owner',
      handler: ({ req, params, user }) => generate(req, params, false, user!.id),
    },
    {
      method: 'POST', path: '/api/projects/:projectId/designs/:designId/assets/:assetId/retry', auth: 'project-owner',
      handler: ({ req, params, user }) => generate(req, params, true, user!.id),
    },
    {
      method: 'POST', path: '/api/projects/:projectId/designs/:designId/assets/:assetId/cancel', auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const loaded = load(params, true);
        if ('error' in loaded) return loaded.error;
        if (loaded.task.status === 'archived') return archived();
        const body = await boundedJson(req);
        if (!record(body) || Object.keys(body).length !== 0) return invalid();
        try {
          const result = await deps.service.cancel(loaded.ids.projectId, loaded.ids.designId, loaded.ids.assetId!, { userId: user!.id });
          return json({ ok: true, asset: assetView(loaded.ids.projectId, loaded.ids.designId, result) });
        } catch (error) { return errorResponse(error, loaded.task.currentRevision); }
      },
    },
    {
      method: 'PATCH', path: '/api/projects/:projectId/designs/:designId/assets/:assetId', auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const loaded = load(params, true);
        if ('error' in loaded) return loaded.error;
        if (loaded.task.status === 'archived') return archived();
        const body = await boundedJson(req);
        if (!record(body) || Object.keys(body).length !== 3
          || !['expectedAssetVersion', 'functionalDetails', 'implementationReady'].every((item) => Object.hasOwn(body, item))
          || !nonnegative(body.expectedAssetVersion) || typeof body.implementationReady !== 'boolean'
          || !functionalDetailsValid(body.functionalDetails)) return invalid();
        try {
          const result = await deps.service.annotate({
            projectId: loaded.ids.projectId, designId: loaded.ids.designId, assetId: loaded.ids.assetId!,
            expectedAssetVersion: body.expectedAssetVersion,
            functionalDetails: body.functionalDetails,
            implementationReady: body.implementationReady,
          }, { userId: user!.id });
          return json({ ok: true, asset: assetView(loaded.ids.projectId, loaded.ids.designId, result) });
        } catch (error) { return errorResponse(error, loaded.task.currentRevision); }
      },
    },
  ];
}

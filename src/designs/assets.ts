import type { Database } from 'bun:sqlite';
import { constants, promises as fsp } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, posix } from 'node:path';
import {
  DESIGN_IMAGE_PRESETS,
  DESIGN_IMAGE_PROMPT_COMPILER_VERSION,
  DESIGN_IMAGE_SIZES,
  compileDesignImagePrompt,
  inspectDesignRaster,
  type DesignImageGenerator,
  type DesignImagePreset,
  type DesignImageReference,
  type DesignImageReferenceMime,
  type DesignImageSize,
} from './image-provider';
import { canonicalDesignJson, type DesignProjectionAsset } from './files';
import type { DesignProjectionAssets } from './files-adapter';
import type { DesignAsset, DesignAssetStatus } from './types';

const HASH_RE = /^[a-f0-9]{64}$/;
const REQUEST_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_REFERENCES = 4;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_PIXELS = 16_000_000;
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_DETAILS_BYTES = 16 * 1024;
const MAX_DETAIL_ITEMS = 20;
const MAX_DETAIL_ITEM_BYTES = 1_000;
const ASSET_STATUSES = new Set<DesignAssetStatus>(['queued', 'running', 'succeeded', 'failed', 'cancelled']);

export type DesignAssetErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'ARCHIVED'
  | 'PROVIDER_UNAVAILABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUEUE_FULL'
  | 'REFERENCE_UNAVAILABLE'
  | 'REFERENCE_INVALID'
  | 'STORAGE_FAILED'
  | 'STORAGE_CORRUPT'
  | 'ASSET_VERSION_CONFLICT'
  | 'ANNOTATION_INCOMPLETE'
  | 'RETRY_INVALID';

export class DesignAssetError extends Error {
  constructor(readonly code: DesignAssetErrorCode, message: string) {
    super(message);
    this.name = 'DesignAssetError';
  }
}

export interface FunctionalDetails {
  altText: string;
  interactions: string[];
  responsiveBehavior: string[];
  accessibilityNotes: string[];
  acceptanceCriteria: string[];
}

export interface DesignAssetCapability {
  enabled: boolean;
  provider: 'openai' | null;
  model: string | null;
  sizes: readonly DesignImageSize[];
  formats: readonly ('image/png' | 'image/webp')[];
  maxReferences: number;
  maxReferenceBytes: number;
  maxAggregateReferenceBytes: number;
  requiresExplicitAcknowledgement: true;
  reason: 'not_configured' | null;
}

export type DesignAssetReferenceDescriptor =
  | { source: 'design_asset'; assetId: number }
  | { source: 'project_file'; path: string };

export interface DesignAssetReferenceResolver {
  resolve(
    scope: { projectId: number; designId: number },
    descriptor: DesignAssetReferenceDescriptor,
    signal?: AbortSignal,
  ): Promise<{ name: string; mime: string; data: Uint8Array }>;
}

export interface CanonicalDesignAssetRequest {
  schemaVersion: 1;
  compilerVersion: number;
  projectId: number;
  designId: number;
  revision: number;
  preset: string;
  prompt: string;
  includeRevisionContext: boolean;
  contextSha256: string | null;
  size: string;
  acknowledgement: true;
  provider: string;
  model: string;
  outputFormat: string;
  quality: string;
  references: ReadonlyArray<{ source: string; identity: string; sha256: string }>;
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string | null): unknown | null {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function requiredJson(value: unknown): string {
  return JSON.stringify(value);
}

export function canonicalDesignAssetRequestDigest(request: CanonicalDesignAssetRequest): string {
  return sha256(canonicalDesignJson(request));
}

function validDetailString(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_DETAIL_ITEM_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validDraftAltText(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MAX_DETAIL_ITEM_BYTES
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validDetailList(value: unknown, requireItems: boolean): value is string[] {
  return Array.isArray(value)
    && value.length <= MAX_DETAIL_ITEMS
    && (!requireItems || value.length > 0)
    && value.every(validDetailString);
}

function validFunctionalDetails(value: unknown, requireComplete: boolean): value is FunctionalDetails {
  if (!isRecord(value)
    || Object.keys(value).some((key) => ![
      'altText', 'interactions', 'responsiveBehavior', 'accessibilityNotes', 'acceptanceCriteria',
    ].includes(key))
    || (requireComplete ? !validDetailString(value.altText) : !validDraftAltText(value.altText))
    || !validDetailList(value.interactions, requireComplete)
    || !validDetailList(value.responsiveBehavior, requireComplete)
    || !validDetailList(value.accessibilityNotes, requireComplete)
    || !validDetailList(value.acceptanceCriteria, requireComplete)) return false;
  return Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_DETAILS_BYTES;
}

export function functionalDetailsComplete(value: unknown): value is FunctionalDetails {
  return validFunctionalDetails(value, true);
}

export function functionalDetailsValid(value: unknown): value is FunctionalDetails {
  return validFunctionalDetails(value, false);
}

interface DesignAssetRow {
  id: number;
  design_task_id: number;
  design_revision: number | null;
  prompt: string;
  provider: string | null;
  status: string;
  path: string | null;
  mime_type: string | null;
  width: number | null;
  height: number | null;
  metadata_json: string | null;
  error: string | null;
  kind: string;
  preset: string | null;
  size: string | null;
  request_key: string | null;
  request_digest: string | null;
  asset_version: number;
  byte_size: number | null;
  output_sha256: string | null;
  implementation_ready: number;
  functional_details_json: string | null;
  retry_of_asset_id: number | null;
  provider_request_id: string | null;
  runnable: number;
  staging_manifest_json: string | null;
  provider_prompt: string | null;
  prompt_compiler_version: number | null;
  include_revision_context: number;
  context_sha256: string | null;
  reference_manifest_json: string | null;
  provider_model: string | null;
  output_format: string | null;
  quality: string | null;
  expected_output_sha256: string | null;
  expected_byte_size: number | null;
  expected_mime_type: string | null;
  expected_width: number | null;
  expected_height: number | null;
  ready_by_user_id: number | null;
  ready_ts: number | null;
  created_ts: number;
  updated_ts: number;
}

function mapAsset(row: DesignAssetRow): DesignAsset {
  const status = ASSET_STATUSES.has(row.status as DesignAssetStatus)
    ? row.status as DesignAssetStatus
    : 'failed';
  return {
    id: row.id,
    designTaskId: row.design_task_id,
    designRevision: row.design_revision,
    prompt: row.prompt,
    provider: row.provider,
    status,
    path: row.path,
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    metadata: parseJson(row.metadata_json),
    error: row.error ?? (status === 'failed' && row.status !== 'failed' ? 'legacy_status' : null),
    kind: row.kind === 'input_reference' ? 'input_reference' : 'raster_reference',
    preset: row.preset as DesignAsset['preset'],
    size: row.size as DesignAsset['size'],
    requestKey: row.request_key,
    requestDigest: row.request_digest,
    assetVersion: row.asset_version,
    byteSize: row.byte_size,
    outputSha256: row.output_sha256,
    implementationReady: row.implementation_ready === 1,
    functionalDetails: parseJson(row.functional_details_json),
    retryOfAssetId: row.retry_of_asset_id,
    providerRequestId: row.provider_request_id,
    runnable: row.runnable === 1,
    stagingManifest: parseJson(row.staging_manifest_json),
    providerPrompt: row.provider_prompt,
    promptCompilerVersion: row.prompt_compiler_version,
    includeRevisionContext: row.include_revision_context === 1,
    contextSha256: row.context_sha256,
    referenceManifest: parseJson(row.reference_manifest_json),
    providerModel: row.provider_model,
    outputFormat: row.output_format as DesignAsset['outputFormat'],
    quality: row.quality,
    expectedOutputSha256: row.expected_output_sha256,
    expectedByteSize: row.expected_byte_size,
    expectedMimeType: row.expected_mime_type as DesignAsset['expectedMimeType'],
    expectedWidth: row.expected_width,
    expectedHeight: row.expected_height,
    readyByUserId: row.ready_by_user_id,
    readyTs: row.ready_ts,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
  };
}

export interface ReserveDesignAssetInput {
  designId: number;
  revision: number;
  requestKey: string;
  requestDigest: string;
  preset: DesignImagePreset;
  size: DesignImageSize;
  prompt: string;
  providerPrompt: string;
  provider: string;
  model: string;
  outputFormat: 'png' | 'webp';
  quality: string;
  compilerVersion: number;
  includeRevisionContext: boolean;
  contextSha256: string | null;
  referenceManifest: unknown[];
  retryOfAssetId: number | null;
  createdTs: number;
}

export class DesignAssetStore {
  constructor(private readonly db: Database) {}

  reserveOrReplay(input: ReserveDesignAssetInput): { asset: DesignAsset; created: boolean } {
    try {
      const row = this.db.query<DesignAssetRow, Array<string | number | null>>(
        `INSERT INTO design_assets
          (design_task_id, design_revision, prompt, provider, status, kind, preset, size,
           request_key, request_digest, asset_version, implementation_ready, retry_of_asset_id,
           runnable, provider_prompt, prompt_compiler_version, include_revision_context,
           context_sha256, reference_manifest_json, provider_model, output_format, quality,
           created_ts, updated_ts)
         VALUES (?, ?, ?, ?, 'queued', 'raster_reference', ?, ?, ?, ?, 0, 0, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      ).get(
        input.designId, input.revision, input.prompt, input.provider, input.preset, input.size,
        input.requestKey, input.requestDigest, input.retryOfAssetId, input.providerPrompt,
        input.compilerVersion, input.includeRevisionContext ? 1 : 0, input.contextSha256,
        requiredJson(input.referenceManifest), input.model, input.outputFormat, input.quality,
        input.createdTs, input.createdTs,
      );
      if (!row) throw new Error('asset insert returned no row');
      return { asset: mapAsset(row), created: true };
    } catch (error) {
      const existing = this.getByRequestKey(input.designId, input.requestKey);
      if (!existing) throw error;
      if (existing.requestDigest !== input.requestDigest) {
        throw new DesignAssetError('IDEMPOTENCY_CONFLICT', 'The request key identifies a different asset request.');
      }
      return { asset: existing, created: false };
    }
  }

  getByRequestKey(designId: number, key: string): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, [number, string]>(
      'SELECT * FROM design_assets WHERE design_task_id = ? AND request_key = ?',
    ).get(designId, key);
    return row ? mapAsset(row) : null;
  }

  getScoped(projectId: number, designId: number, assetId: number): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, [number, number, number]>(
      `SELECT asset.* FROM design_assets asset
       JOIN design_tasks task ON task.id = asset.design_task_id
       WHERE task.project_id = ? AND asset.design_task_id = ? AND asset.id = ?`,
    ).get(projectId, designId, assetId);
    return row ? mapAsset(row) : null;
  }

  listScoped(projectId: number, designId: number): DesignAsset[] {
    return this.db.query<DesignAssetRow, [number, number]>(
      `SELECT asset.* FROM design_assets asset
       JOIN design_tasks task ON task.id = asset.design_task_id
       WHERE task.project_id = ? AND asset.design_task_id = ? ORDER BY asset.id`,
    ).all(projectId, designId).map(mapAsset);
  }

  projectIdForAsset(assetId: number): number | null {
    return this.db.query<{ projectId: number }, [number]>(
      `SELECT task.project_id AS projectId FROM design_assets asset
       JOIN design_tasks task ON task.id = asset.design_task_id WHERE asset.id = ?`,
    ).get(assetId)?.projectId ?? null;
  }

  listReadyForRevision(projectId: number, designId: number, revision: number): DesignAsset[] {
    return this.db.query<DesignAssetRow, [number, number, number]>(
      `SELECT asset.* FROM design_assets asset
       JOIN design_tasks task ON task.id = asset.design_task_id
       WHERE task.project_id = ? AND asset.design_task_id = ? AND asset.design_revision = ?
         AND asset.status = 'succeeded' AND asset.implementation_ready = 1
       ORDER BY asset.id`,
    ).all(projectId, designId, revision).map(mapAsset);
  }

  markRunnable(id: number, expectedVersion: number, stagingManifest: string): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, [string, number, number, number]>(
      `UPDATE design_assets SET runnable = 1, staging_manifest_json = ?,
         asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND status = 'queued' AND runnable = 0 AND asset_version = ? RETURNING *`,
    ).get(stagingManifest, Date.now(), id, expectedVersion);
    return row ? mapAsset(row) : null;
  }

  countQueued(): number {
    return this.db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM design_assets WHERE status = 'queued'",
    ).get()!.n;
  }

  claimNext(excludedDesignIds: readonly number[]): DesignAsset | null {
    const params: number[] = [];
    const excluded = excludedDesignIds.length
      ? `AND candidate.design_task_id NOT IN (${excludedDesignIds.map(() => '?').join(',')})`
      : '';
    params.push(...excludedDesignIds);
    const candidate = this.db.query<{ id: number; version: number }, number[]>(
      `SELECT candidate.id, candidate.asset_version AS version
       FROM design_assets candidate
       WHERE candidate.status = 'queued' AND candidate.runnable = 1
         ${excluded}
         AND NOT EXISTS (
           SELECT 1 FROM design_assets running
           WHERE running.design_task_id = candidate.design_task_id AND running.status = 'running'
         )
       ORDER BY candidate.created_ts, candidate.id LIMIT 1`,
    ).get(...params);
    if (!candidate) return null;
    const row = this.db.query<DesignAssetRow, [number, number, number]>(
      `UPDATE design_assets SET status = 'running', asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND status = 'queued' AND runnable = 1 AND asset_version = ? RETURNING *`,
    ).get(Date.now(), candidate.id, candidate.version);
    return row ? mapAsset(row) : null;
  }

  persistExpectedOutput(id: number, expectedVersion: number, value: {
    sha256: string; bytes: number; mime: 'image/png' | 'image/webp'; width: number; height: number;
    providerRequestId?: string;
    metadata?: Record<string, unknown>;
  }): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, Array<string | number | null>>(
      `UPDATE design_assets SET expected_output_sha256 = ?, expected_byte_size = ?,
         expected_mime_type = ?, expected_width = ?, expected_height = ?, provider_request_id = ?,
         metadata_json = ?, asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND status = 'running' AND asset_version = ? RETURNING *`,
    ).get(value.sha256, value.bytes, value.mime, value.width, value.height,
      value.providerRequestId ?? null, value.metadata ? requiredJson(value.metadata) : null,
      Date.now(), id, expectedVersion);
    return row ? mapAsset(row) : null;
  }

  completeRunning(id: number, expectedVersion: number, path: string): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, [string, number, number, number]>(
      `UPDATE design_assets SET status = 'succeeded', path = ?,
         mime_type = expected_mime_type, width = expected_width, height = expected_height,
         byte_size = expected_byte_size, output_sha256 = expected_output_sha256,
         error = NULL, runnable = 0, asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND status = 'running' AND asset_version = ?
         AND expected_output_sha256 IS NOT NULL RETURNING *`,
    ).get(path, Date.now(), id, expectedVersion);
    return row ? mapAsset(row) : null;
  }

  failRunning(id: number, expectedVersion: number, errorCode: string): DesignAsset | null {
    return this.fail(id, expectedVersion, 'running', errorCode);
  }

  failQueued(id: number, expectedVersion: number, errorCode: string): DesignAsset | null {
    return this.fail(id, expectedVersion, 'queued', errorCode);
  }

  private fail(id: number, expectedVersion: number, from: 'queued' | 'running', errorCode: string): DesignAsset | null {
    const row = this.db.query<DesignAssetRow, [string, number, number, number]>(
      `UPDATE design_assets SET status = 'failed', error = ?, runnable = 0,
         asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND status = '${from}' AND asset_version = ? RETURNING *`,
    ).get(errorCode.slice(0, 4000), Date.now(), id, expectedVersion);
    return row ? mapAsset(row) : null;
  }

  cancelScoped(projectId: number, designId: number, assetId: number, _actorUserId: number): DesignAsset | null {
    const current = this.getScoped(projectId, designId, assetId);
    if (!current) return null;
    if (current.status !== 'queued' && current.status !== 'running') return current;
    const row = this.db.query<DesignAssetRow, [number, number, number]>(
      `UPDATE design_assets SET status = 'cancelled', runnable = 0,
         asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND asset_version = ? AND status IN ('queued','running') RETURNING *`,
    ).get(Date.now(), assetId, current.assetVersion);
    return row ? mapAsset(row) : this.getScoped(projectId, designId, assetId);
  }

  annotateScoped(input: {
    projectId: number; designId: number; assetId: number; expectedAssetVersion: number;
    functionalDetails: FunctionalDetails | null; implementationReady: boolean;
    actorUserId: number; ts: number;
  }): DesignAsset {
    const current = this.getScoped(input.projectId, input.designId, input.assetId);
    if (!current) throw new DesignAssetError('NOT_FOUND', 'The design asset was not found.');
    if ((input.implementationReady && input.functionalDetails === null)
      || (input.functionalDetails !== null && !validFunctionalDetails(input.functionalDetails, input.implementationReady))) {
      throw new DesignAssetError(
        input.implementationReady ? 'ANNOTATION_INCOMPLETE' : 'INVALID_REQUEST',
        'Functional details are invalid.',
      );
    }
    if (input.implementationReady) {
      const currentRevision = this.db.query<{ revision: number }, [number]>(
        'SELECT current_revision AS revision FROM design_tasks WHERE id = ?',
      ).get(input.designId)?.revision;
      if (current.status !== 'succeeded'
        || current.designRevision !== currentRevision
        || !current.path || !current.mimeType || !current.outputSha256 || !current.byteSize
        || !current.width || !current.height) {
        throw new DesignAssetError('REVISION_CONFLICT', 'Only a complete current succeeded asset can be implementation-ready.');
      }
    }
    const row = this.db.query<DesignAssetRow, Array<string | number | null>>(
      `UPDATE design_assets SET functional_details_json = ?, implementation_ready = ?,
         ready_by_user_id = ?, ready_ts = ?, asset_version = asset_version + 1, updated_ts = ?
       WHERE id = ? AND asset_version = ? RETURNING *`,
    ).get(
      input.functionalDetails === null ? null : requiredJson(input.functionalDetails),
      input.implementationReady ? 1 : 0,
      input.implementationReady ? input.actorUserId : null,
      input.implementationReady ? input.ts : null,
      input.ts, input.assetId, input.expectedAssetVersion,
    );
    if (!row) throw new DesignAssetError('ASSET_VERSION_CONFLICT', 'The design asset changed.');
    return mapAsset(row);
  }

  listQueuedAndRunning(): DesignAsset[] {
    return this.db.query<DesignAssetRow, []>(
      "SELECT * FROM design_assets WHERE status IN ('queued','running') ORDER BY id",
    ).all().map(mapAsset);
  }
}

interface StagedReference {
  ordinal: number;
  path: string;
  name: string;
  mime: DesignImageReferenceMime;
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

interface PreparedOutput {
  tempPath: string;
  relativePath: string;
  finalPath: string;
  sha256: string;
  bytes: number;
  mime: 'image/png' | 'image/webp';
  width: number;
  height: number;
}

function extensionForMime(mime: string): 'png' | 'jpg' | 'webp' {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  throw new DesignAssetError('REFERENCE_INVALID', 'The reference image type is unsupported.');
}

export class DesignAssetStorage {
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new DesignAssetError('STORAGE_FAILED', 'The asset storage root must be absolute.');
  }

  private async ensureDirectory(path: string): Promise<void> {
    await fsp.mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await fsp.lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new DesignAssetError('STORAGE_FAILED', 'Asset storage directory is unsafe.');
    await fsp.chmod(path, 0o700);
  }

  private async writeExclusive(path: string, data: Uint8Array): Promise<void> {
    const handle = await fsp.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.write(data, 0, data.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async stageReferences(assetId: number, references: Array<DesignImageReference & { width: number; height: number }>): Promise<StagedReference[]> {
    if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new DesignAssetError('STORAGE_FAILED', 'Asset ID is invalid.');
    await this.ensureDirectory(this.root);
    const stagingRoot = join(this.root, 'staging');
    const directory = join(stagingRoot, String(assetId));
    await this.ensureDirectory(stagingRoot);
    await this.ensureDirectory(directory);
    const manifest: StagedReference[] = [];
    try {
      for (let ordinal = 0; ordinal < references.length; ordinal++) {
        const reference = references[ordinal]!;
        const extension = extensionForMime(reference.mime);
        const relativePath = `staging/${assetId}/${ordinal}.${extension}`;
        await this.writeExclusive(join(this.root, relativePath), reference.data);
        manifest.push({
          ordinal,
          path: relativePath,
          name: `reference-${ordinal}.${extension}`,
          mime: reference.mime as DesignImageReferenceMime,
          sha256: sha256(reference.data),
          bytes: reference.data.length,
          width: reference.width,
          height: reference.height,
        });
      }
      return manifest;
    } catch (error) {
      await this.cleanupStaging(assetId);
      if (error instanceof DesignAssetError) throw error;
      throw new DesignAssetError('STORAGE_FAILED', 'Reference staging failed.');
    }
  }

  async readStaged(asset: DesignAsset): Promise<DesignImageReference[]> {
    if (!Array.isArray(asset.stagingManifest)) throw new DesignAssetError('STORAGE_CORRUPT', 'Staged references are unavailable.');
    const output: DesignImageReference[] = [];
    for (let ordinal = 0; ordinal < asset.stagingManifest.length; ordinal++) {
      const item = asset.stagingManifest[ordinal];
      if (!isRecord(item)
        || item.ordinal !== ordinal
        || typeof item.path !== 'string'
        || !item.path.startsWith(`staging/${asset.id}/`)
        || typeof item.name !== 'string'
        || typeof item.mime !== 'string'
        || typeof item.sha256 !== 'string'
        || typeof item.bytes !== 'number') {
        throw new DesignAssetError('STORAGE_CORRUPT', 'Staged reference manifest is invalid.');
      }
      const bytes = await this.readNoFollow(join(this.root, item.path), item.bytes);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) {
        throw new DesignAssetError('STORAGE_CORRUPT', 'Staged reference bytes changed.');
      }
      output.push({ name: basename(item.name), mime: item.mime, data: bytes });
    }
    return output;
  }

  private async readNoFollow(path: string, expectedBytes?: number): Promise<Uint8Array> {
    try {
      const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (expectedBytes !== undefined && stat.size !== expectedBytes) || stat.size > MAX_OUTPUT_BYTES) {
          throw new Error('invalid asset file');
        }
        const data = new Uint8Array(stat.size);
        let offset = 0;
        while (offset < data.length) {
          const read = await handle.read(data, offset, data.length - offset, offset);
          if (read.bytesRead <= 0) break;
          offset += read.bytesRead;
        }
        if (offset !== data.length) throw new Error('short asset read');
        return data;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof DesignAssetError) throw error;
      throw new DesignAssetError('STORAGE_CORRUPT', 'Controlled asset bytes are unavailable.');
    }
  }

  async prepareOutput(asset: DesignAsset, data: Uint8Array, mime: 'image/png' | 'image/webp'): Promise<PreparedOutput> {
    const info = inspectDesignRaster(data);
    if (!info || info.mime !== mime || data.length === 0 || data.length > MAX_OUTPUT_BYTES) {
      throw new DesignAssetError('STORAGE_FAILED', 'Generated raster output is invalid.');
    }
    await this.ensureDirectory(this.root);
    const projectId = await this.projectIdForAsset(asset);
    const directory = join(this.root, String(projectId), String(asset.designTaskId));
    await this.ensureDirectory(join(this.root, String(projectId)));
    await this.ensureDirectory(directory);
    const extension = extensionForMime(mime);
    const relativePath = `${projectId}/${asset.designTaskId}/${asset.id}.${extension}`;
    const finalPath = join(this.root, relativePath);
    const tempPath = join(directory, `.${asset.id}-${randomUUID()}.tmp`);
    await this.writeExclusive(tempPath, data);
    return {
      tempPath, relativePath, finalPath, sha256: sha256(data), bytes: data.length,
      mime, width: info.width, height: info.height,
    };
  }

  private projectIds = new Map<number, number>();

  bindProject(assetId: number, projectId: number): void {
    this.projectIds.set(assetId, projectId);
  }

  private async projectIdForAsset(asset: DesignAsset): Promise<number> {
    const projectId = this.projectIds.get(asset.id);
    if (!projectId) throw new DesignAssetError('STORAGE_FAILED', 'Asset storage scope is unavailable.');
    return projectId;
  }

  async publishOutput(prepared: PreparedOutput): Promise<void> {
    try {
      await fsp.link(prepared.tempPath, prepared.finalPath);
      await fsp.unlink(prepared.tempPath);
      const dir = await fsp.open(dirname(prepared.finalPath), constants.O_RDONLY).catch(() => null);
      if (dir) { try { await dir.sync(); } finally { await dir.close(); } }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        await fsp.unlink(prepared.tempPath).catch(() => {});
        const bytes = await this.readNoFollow(prepared.finalPath, prepared.bytes);
        if (sha256(bytes) === prepared.sha256) return;
      }
      throw new DesignAssetError('STORAGE_FAILED', 'Generated asset publish failed.');
    }
  }

  async readSucceeded(asset: DesignAsset): Promise<Uint8Array> {
    if (!asset.path || !asset.mimeType || !asset.outputSha256 || !asset.byteSize || !asset.width || !asset.height) {
      throw new DesignAssetError('STORAGE_CORRUPT', 'Generated asset metadata is incomplete.');
    }
    const projectId = await this.projectIdForAsset(asset);
    const extension = extensionForMime(asset.mimeType);
    const expectedPath = `${projectId}/${asset.designTaskId}/${asset.id}.${extension}`;
    if (asset.path !== expectedPath) throw new DesignAssetError('STORAGE_CORRUPT', 'Generated asset path is invalid.');
    const data = await this.readNoFollow(join(this.root, expectedPath), asset.byteSize);
    const info = inspectDesignRaster(data);
    if (!info || info.mime !== asset.mimeType || info.width !== asset.width || info.height !== asset.height
      || sha256(data) !== asset.outputSha256) {
      throw new DesignAssetError('STORAGE_CORRUPT', 'Generated asset bytes do not match metadata.');
    }
    return data;
  }

  async verifyExpected(asset: DesignAsset): Promise<string | null> {
    if (!asset.expectedMimeType || !asset.expectedOutputSha256 || !asset.expectedByteSize
      || !asset.expectedWidth || !asset.expectedHeight) return null;
    const projectId = await this.projectIdForAsset(asset);
    const relativePath = `${projectId}/${asset.designTaskId}/${asset.id}.${extensionForMime(asset.expectedMimeType)}`;
    try {
      const data = await this.readNoFollow(join(this.root, relativePath), asset.expectedByteSize);
      const info = inspectDesignRaster(data);
      return info && info.mime === asset.expectedMimeType
        && info.width === asset.expectedWidth && info.height === asset.expectedHeight
        && sha256(data) === asset.expectedOutputSha256
        ? relativePath
        : null;
    } catch {
      return null;
    }
  }

  async removeOutput(asset: DesignAsset): Promise<void> {
    const projectId = this.projectIds.get(asset.id);
    const mime = asset.mimeType ?? asset.expectedMimeType;
    if (!projectId || !mime) return;
    const path = join(this.root, `${projectId}/${asset.designTaskId}/${asset.id}.${extensionForMime(mime)}`);
    await fsp.unlink(path).catch(() => {});
  }

  async cleanupStaging(assetId: number): Promise<void> {
    if (!Number.isSafeInteger(assetId) || assetId <= 0) return;
    await fsp.rm(join(this.root, 'staging', String(assetId)), { recursive: true, force: true }).catch(() => {});
  }
}

export interface GenerateDesignAssetInput {
  projectId: number;
  designId: number;
  expectedRevision: number;
  requestKey: string;
  preset: DesignImagePreset;
  prompt: string;
  size: DesignImageSize;
  includeRevisionContext: boolean;
  references: DesignAssetReferenceDescriptor[];
  acknowledgeExternalProcessingAndCost: true;
  retryOfAssetId?: number;
}

interface DesignAssetTaskSnapshot {
  projectId: number;
  designId: number;
  currentRevision: number;
  status: string;
  documentMarkdown: string;
}

export interface DesignAssetServiceDeps {
  store: DesignAssetStore;
  storage: DesignAssetStorage;
  generator: DesignImageGenerator | null;
  taskLookup(designId: number): DesignAssetTaskSnapshot | null | Promise<DesignAssetTaskSnapshot | null>;
  revisionLookup(designId: number, revision: number): { revision: number; documentMarkdown: string } | null
    | Promise<{ revision: number; documentMarkdown: string } | null>;
  authorizeOwner(projectId: number, userId: number): boolean | Promise<boolean>;
  referenceResolver: DesignAssetReferenceResolver;
  provider: { name: string; model: string; outputFormat: 'png' | 'webp'; quality: string };
  maxConcurrent?: number;
  maxQueued?: number;
  schedule?: (run: () => Promise<void>) => void;
  now?: () => number;
  checkpoint?: (point: 'after_output_publish') => void | Promise<void>;
}

function validPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDescriptor(value: unknown): value is DesignAssetReferenceDescriptor {
  if (!isRecord(value)) return false;
  if (value.source === 'design_asset') {
    return Object.keys(value).length === 2 && validPositive(value.assetId);
  }
  if (value.source === 'project_file') {
    return Object.keys(value).length === 2
      && typeof value.path === 'string'
      && value.path.length > 0
      && value.path.length <= 1_000
      && !value.path.includes('\0')
      && !posix.isAbsolute(value.path)
      && value.path.split('/').every((part) => part && part !== '.' && part !== '..');
  }
  return false;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = '';
  let bytes = 0;
  for (const point of value) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > maxBytes) break;
    output += point;
    bytes += size;
  }
  return output;
}

function providerProvenance(result: Awaited<ReturnType<DesignImageGenerator['generate']>>): {
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
} {
  const providerRequestId = typeof result.providerRequestId === 'string'
    && result.providerRequestId.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(result.providerRequestId)
    ? result.providerRequestId
    : undefined;
  const revisedPrompt = typeof result.revisedPrompt === 'string'
    ? truncateUtf8(result.revisedPrompt.replace(/\r\n?/g, '\n'), 8 * 1024)
    : undefined;
  const usage = isRecord(result.usage)
    ? Object.fromEntries(['inputTokens', 'outputTokens', 'totalTokens'].flatMap((key) => {
      const value = result.usage?.[key as keyof typeof result.usage];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    }))
    : undefined;
  const metadata = revisedPrompt !== undefined || (usage && Object.keys(usage).length > 0)
    ? { ...(revisedPrompt === undefined ? {} : { revisedPrompt }), ...(usage && Object.keys(usage).length ? { usage } : {}) }
    : undefined;
  return { providerRequestId, metadata };
}

export class DesignAssetService implements DesignProjectionAssets {
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly now: () => number;
  private readonly schedule: (run: () => Promise<void>) => void;
  private readonly active = new Map<number, { designId: number; controller: AbortController }>();
  private draining: Promise<void> | null = null;
  private recovery: Promise<void> | null = null;
  private recoveryController: AbortController | null = null;
  private stopped = false;
  private epoch = 0;

  constructor(private readonly deps: DesignAssetServiceDeps) {
    this.maxConcurrent = deps.maxConcurrent ?? 1;
    this.maxQueued = deps.maxQueued ?? 20;
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((run) => queueMicrotask(() => { void run(); }));
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > 8
      || !Number.isSafeInteger(this.maxQueued) || this.maxQueued < 1 || this.maxQueued > 1_000) {
      throw new DesignAssetError('INVALID_REQUEST', 'Asset queue configuration is invalid.');
    }
  }

  capability(): DesignAssetCapability {
    if (!this.deps.generator) {
      return {
        enabled: false, provider: null, model: null,
        sizes: [...DESIGN_IMAGE_SIZES], formats: ['image/png', 'image/webp'],
        maxReferences: MAX_REFERENCES, maxReferenceBytes: MAX_REFERENCE_BYTES,
        maxAggregateReferenceBytes: MAX_REFERENCE_TOTAL_BYTES,
        requiresExplicitAcknowledgement: true, reason: 'not_configured',
      };
    }
    return {
      enabled: true, provider: 'openai', model: this.deps.provider.model,
      sizes: [...DESIGN_IMAGE_SIZES],
      formats: [this.deps.provider.outputFormat === 'png' ? 'image/png' : 'image/webp'],
      maxReferences: MAX_REFERENCES, maxReferenceBytes: MAX_REFERENCE_BYTES,
      maxAggregateReferenceBytes: MAX_REFERENCE_TOTAL_BYTES,
      requiresExplicitAcknowledgement: true, reason: null,
    };
  }

  async enqueue(input: GenerateDesignAssetInput, actor: { userId: number }): Promise<{ asset: DesignAsset; replayed: boolean }> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    if (!this.deps.generator) throw new DesignAssetError('PROVIDER_UNAVAILABLE', 'Image generation is not configured.');
    if (!isRecord(input)
      || Object.keys(input).some((key) => ![
        'projectId', 'designId', 'expectedRevision', 'requestKey', 'preset', 'prompt', 'size',
        'includeRevisionContext', 'references', 'acknowledgeExternalProcessingAndCost', 'retryOfAssetId',
      ].includes(key))
      || !validPositive(input.projectId) || !validPositive(input.designId) || !validPositive(input.expectedRevision)
      || !validPositive(actor.userId)
      || !REQUEST_KEY_RE.test(input.requestKey)
      || !(DESIGN_IMAGE_PRESETS as readonly unknown[]).includes(input.preset)
      || !(DESIGN_IMAGE_SIZES as readonly unknown[]).includes(input.size)
      || typeof input.prompt !== 'string'
      || !Array.isArray(input.references) || input.references.length > MAX_REFERENCES
      || !input.references.every(validDescriptor)
      || input.acknowledgeExternalProcessingAndCost !== true
      || typeof input.includeRevisionContext !== 'boolean'
      || (input.retryOfAssetId !== undefined && !validPositive(input.retryOfAssetId))) {
      throw new DesignAssetError('INVALID_REQUEST', 'The visual asset request is invalid.');
    }
    const authorized = await this.deps.authorizeOwner(input.projectId, actor.userId);
    this.requireLiveEpoch(epoch);
    if (!authorized) {
      throw new DesignAssetError('FORBIDDEN', 'Only the project owner can generate visual assets.');
    }
    const task = await this.deps.taskLookup(input.designId);
    this.requireLiveEpoch(epoch);
    if (!task || task.projectId !== input.projectId || task.designId !== input.designId) {
      throw new DesignAssetError('NOT_FOUND', 'The design was not found.');
    }
    if (task.status === 'archived') throw new DesignAssetError('ARCHIVED', 'The design is archived.');
    if (task.currentRevision !== input.expectedRevision) {
      throw new DesignAssetError('REVISION_CONFLICT', 'The design revision changed.');
    }
    const immutable = await this.deps.revisionLookup(input.designId, input.expectedRevision);
    this.requireLiveEpoch(epoch);
    if (!immutable || immutable.revision !== input.expectedRevision) {
      throw new DesignAssetError('REVISION_CONFLICT', 'The immutable design revision is unavailable.');
    }
    if (input.retryOfAssetId !== undefined) {
      const parent = this.deps.store.getScoped(input.projectId, input.designId, input.retryOfAssetId);
      if (!parent || (parent.status !== 'failed' && parent.status !== 'cancelled') || parent.requestKey === input.requestKey) {
        throw new DesignAssetError('RETRY_INVALID', 'Only a failed or cancelled asset can be retried with a new key.');
      }
    }

    const resolved: Array<DesignImageReference & { width: number; height: number }> = [];
    const requestReferences: Array<{ source: string; identity: string; sha256: string }> = [];
    let totalBytes = 0;
    for (let index = 0; index < input.references.length; index++) {
      const descriptor = input.references[index]!;
      let source: { name: string; mime: string; data: Uint8Array };
      try {
        source = await this.deps.referenceResolver.resolve(
          { projectId: input.projectId, designId: input.designId }, descriptor,
        );
      } catch {
        this.requireLiveEpoch(epoch);
        throw new DesignAssetError('REFERENCE_UNAVAILABLE', 'A selected reference is unavailable.');
      }
      this.requireLiveEpoch(epoch);
      if (!isRecord(source) || typeof source.name !== 'string' || typeof source.mime !== 'string'
        || !(source.data instanceof Uint8Array)) {
        throw new DesignAssetError('REFERENCE_INVALID', 'A selected reference is invalid.');
      }
      const info = inspectDesignRaster(source.data);
      totalBytes += source.data.length;
      if (!info || info.mime !== source.mime || source.data.length > MAX_REFERENCE_BYTES
        || totalBytes > MAX_REFERENCE_TOTAL_BYTES || info.width * info.height > MAX_REFERENCE_PIXELS) {
        throw new DesignAssetError('REFERENCE_INVALID', 'A selected reference is invalid.');
      }
      const extension = extensionForMime(info.mime);
      resolved.push({ name: `reference-${index}.${extension}`, mime: info.mime, data: source.data.slice(), width: info.width, height: info.height });
      requestReferences.push({
        source: descriptor.source,
        identity: descriptor.source === 'design_asset' ? `asset:${descriptor.assetId}` : `project:${descriptor.path}`,
        sha256: sha256(source.data),
      });
    }
    const context = input.includeRevisionContext ? truncateUtf8(immutable.documentMarkdown, 4 * 1024) : undefined;
    let compiled: ReturnType<typeof compileDesignImagePrompt>;
    try {
      compiled = compileDesignImagePrompt({ preset: input.preset, ownerPrompt: input.prompt, revisionContext: context });
    } catch {
      throw new DesignAssetError('INVALID_REQUEST', 'The visual asset prompt is invalid.');
    }
    const requestDigest = canonicalDesignAssetRequestDigest({
      schemaVersion: 1,
      compilerVersion: compiled.compilerVersion,
      projectId: input.projectId,
      designId: input.designId,
      revision: input.expectedRevision,
      preset: input.preset,
      prompt: input.prompt.replace(/\r\n?/g, '\n').trim(),
      includeRevisionContext: input.includeRevisionContext,
      contextSha256: context === undefined ? null : sha256(context),
      size: input.size,
      acknowledgement: true,
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
      outputFormat: this.deps.provider.outputFormat,
      quality: this.deps.provider.quality,
      references: requestReferences,
    });
    const replay = this.deps.store.getByRequestKey(input.designId, input.requestKey);
    if (replay) {
      if (replay.requestDigest !== requestDigest) throw new DesignAssetError('IDEMPOTENCY_CONFLICT', 'The request key identifies different input.');
      return { asset: replay, replayed: true };
    }
    if (this.deps.store.countQueued() >= this.maxQueued) throw new DesignAssetError('QUEUE_FULL', 'The visual asset queue is full.');
    const reserved = this.deps.store.reserveOrReplay({
      designId: input.designId,
      revision: input.expectedRevision,
      requestKey: input.requestKey,
      requestDigest,
      preset: input.preset,
      size: input.size,
      prompt: input.prompt.replace(/\r\n?/g, '\n').trim(),
      providerPrompt: compiled.prompt,
      provider: this.deps.provider.name,
      model: this.deps.provider.model,
      outputFormat: this.deps.provider.outputFormat,
      quality: this.deps.provider.quality,
      compilerVersion: compiled.compilerVersion,
      includeRevisionContext: input.includeRevisionContext,
      contextSha256: context === undefined ? null : sha256(context),
      referenceManifest: requestReferences,
      retryOfAssetId: input.retryOfAssetId ?? null,
      createdTs: this.now(),
    });
    if (!reserved.created) return { asset: reserved.asset, replayed: true };
    this.deps.storage.bindProject(reserved.asset.id, input.projectId);
    try {
      const staging = await this.deps.storage.stageReferences(reserved.asset.id, resolved);
      this.requireLiveEpoch(epoch);
      const runnable = this.deps.store.markRunnable(reserved.asset.id, reserved.asset.assetVersion, requiredJson(staging));
      if (!runnable) throw new DesignAssetError('STORAGE_FAILED', 'The staged visual asset changed.');
      this.schedule(async () => { await this.runPending(); });
      return { asset: runnable, replayed: false };
    } catch (error) {
      if (!this.liveEpoch(epoch)) {
        await this.deps.storage.cleanupStaging(reserved.asset.id).catch(() => {});
        throw new DesignAssetError('STORAGE_FAILED', 'Asset service stopped during staging.');
      }
      const current = this.deps.store.getScoped(input.projectId, input.designId, reserved.asset.id);
      if (current?.status === 'queued') this.deps.store.failQueued(current.id, current.assetVersion, 'staging_failed');
      await this.deps.storage.cleanupStaging(reserved.asset.id);
      if (error instanceof DesignAssetError) throw error;
      throw new DesignAssetError('STORAGE_FAILED', 'Reference staging failed.');
    }
  }

  async runPending(): Promise<void> {
    if (this.draining) return await this.draining;
    this.draining = this.drainLoop();
    try { await this.draining; } finally { this.draining = null; }
  }

  private async drainLoop(): Promise<void> {
    while (!this.stopped) {
      const started: Promise<void>[] = [];
      while (this.active.size < this.maxConcurrent) {
        const claimed = this.deps.store.claimNext([...this.active.values()].map((item) => item.designId));
        if (!claimed) break;
        const controller = new AbortController();
        this.active.set(claimed.id, { designId: claimed.designTaskId, controller });
        const epoch = this.epoch;
        const work = this.process(claimed, controller, epoch).finally(() => { this.active.delete(claimed.id); });
        started.push(work);
      }
      if (started.length === 0) return;
      await Promise.all(started);
    }
  }

  private live(epoch: number, signal: AbortSignal): boolean {
    return this.liveEpoch(epoch) && !signal.aborted;
  }

  private liveEpoch(epoch: number): boolean {
    return !this.stopped && this.epoch === epoch;
  }

  private requireLiveEpoch(epoch: number): void {
    if (!this.liveEpoch(epoch)) {
      throw new DesignAssetError('STORAGE_FAILED', 'Asset service is stopped.');
    }
  }

  private async discardControlledOutput(
    claimed: DesignAsset,
    prepared?: PreparedOutput,
    expected?: DesignAsset,
  ): Promise<void> {
    if (prepared) await fsp.unlink(prepared.tempPath).catch(() => {});
    if (expected) await this.deps.storage.removeOutput(expected).catch(() => {});
    await this.deps.storage.cleanupStaging(claimed.id).catch(() => {});
  }

  private async process(claimed: DesignAsset, controller: AbortController, epoch: number): Promise<void> {
    let version = claimed.assetVersion;
    let result: Awaited<ReturnType<DesignImageGenerator['generate']>>;
    let references: DesignImageReference[];
    try {
      references = await this.deps.storage.readStaged(claimed);
    } catch {
      if (!this.live(epoch, controller.signal)) {
        await this.discardControlledOutput(claimed);
        return;
      }
      const projectId = this.deps.store.projectIdForAsset(claimed.id) ?? 0;
      const current = this.deps.store.getScoped(projectId, claimed.designTaskId, claimed.id);
      if (current?.status === 'running') this.deps.store.failRunning(claimed.id, current.assetVersion, 'storage_failure');
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    if (!this.live(epoch, controller.signal)) {
      await this.discardControlledOutput(claimed);
      return;
    }
    try {
      result = await this.deps.generator!.generate({
        prompt: claimed.providerPrompt!, size: claimed.size!, references, signal: controller.signal,
      });
    } catch {
      if (!this.live(epoch, controller.signal)) {
        await this.discardControlledOutput(claimed);
        return;
      }
      const projectId = this.deps.store.projectIdForAsset(claimed.id) ?? 0;
      const current = this.deps.store.getScoped(projectId, claimed.designTaskId, claimed.id);
      if (current?.status === 'running') this.deps.store.failRunning(claimed.id, current.assetVersion, controller.signal.aborted ? 'cancelled' : 'provider_failure');
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    // A provider/mocked port may ignore AbortSignal. Shutdown must not let that late
    // result mutate durable state; startup recovery will fail the ambiguous call.
    if (!this.live(epoch, controller.signal)) {
      await this.discardControlledOutput(claimed);
      return;
    }
    const projectId = this.deps.store.projectIdForAsset(claimed.id)!;
    this.deps.storage.bindProject(claimed.id, projectId);
    const current = this.deps.store.getScoped(projectId, claimed.designTaskId, claimed.id);
    if (!current || current.status !== 'running') {
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    version = current.assetVersion;
    const info = inspectDesignRaster(result.data);
    const [wantedWidth, wantedHeight] = claimed.size!.split('x').map(Number);
    if (!info || (result.mime !== 'image/png' && result.mime !== 'image/webp')
      || info.mime !== result.mime || info.width !== wantedWidth || info.height !== wantedHeight
      || result.data.length === 0 || result.data.length > MAX_OUTPUT_BYTES) {
      this.deps.store.failRunning(claimed.id, version, 'invalid_output');
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    let prepared: PreparedOutput;
    try {
      prepared = await this.deps.storage.prepareOutput(current, result.data, result.mime);
    } catch {
      if (!this.live(epoch, controller.signal)) {
        await this.discardControlledOutput(claimed);
        return;
      }
      this.deps.store.failRunning(claimed.id, version, 'storage_failure');
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    if (!this.live(epoch, controller.signal)) {
      await this.discardControlledOutput(claimed, prepared);
      return;
    }
    const expected = this.deps.store.persistExpectedOutput(claimed.id, version, {
      sha256: prepared.sha256, bytes: prepared.bytes, mime: prepared.mime,
      width: prepared.width, height: prepared.height, ...providerProvenance(result),
    });
    if (!expected) {
      await fsp.unlink(prepared.tempPath).catch(() => {});
      return;
    }
    try {
      await this.deps.storage.publishOutput(prepared);
    } catch {
      if (!this.live(epoch, controller.signal)) {
        await this.discardControlledOutput(claimed, prepared, expected);
        return;
      }
      this.deps.store.failRunning(claimed.id, expected.assetVersion, 'storage_failure');
      await this.deps.storage.cleanupStaging(claimed.id);
      return;
    }
    if (!this.live(epoch, controller.signal)) {
      await this.discardControlledOutput(claimed, prepared, expected);
      return;
    }
    try {
      await this.deps.checkpoint?.('after_output_publish');
    } catch (error) {
      if (!this.live(epoch, controller.signal)) {
        await this.discardControlledOutput(claimed, prepared, expected);
        return;
      }
      throw error;
    }
    if (!this.live(epoch, controller.signal)) {
      await this.discardControlledOutput(claimed, prepared, expected);
      return;
    }
    const completed = this.deps.store.completeRunning(claimed.id, expected.assetVersion, prepared.relativePath);
    if (!completed) await this.deps.storage.removeOutput(expected);
    await this.deps.storage.cleanupStaging(claimed.id);
  }

  async cancel(projectId: number, designId: number, assetId: number, actor: { userId: number }): Promise<DesignAsset> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    const authorized = await this.deps.authorizeOwner(projectId, actor.userId);
    this.requireLiveEpoch(epoch);
    if (!authorized) throw new DesignAssetError('FORBIDDEN', 'Only the owner can cancel generation.');
    const cancelled = this.deps.store.cancelScoped(projectId, designId, assetId, actor.userId);
    if (!cancelled) throw new DesignAssetError('NOT_FOUND', 'The design asset was not found.');
    this.deps.storage.bindProject(assetId, projectId);
    this.active.get(assetId)?.controller.abort();
    await this.deps.storage.cleanupStaging(assetId);
    if (cancelled.status === 'cancelled') await this.deps.storage.removeOutput(cancelled);
    return cancelled;
  }

  async list(projectId: number, designId: number): Promise<DesignAsset[]> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    const task = await this.deps.taskLookup(designId);
    this.requireLiveEpoch(epoch);
    if (!task || task.projectId !== projectId || task.designId !== designId) {
      throw new DesignAssetError('NOT_FOUND', 'The design was not found.');
    }
    return this.deps.store.listScoped(projectId, designId);
  }

  async content(projectId: number, designId: number, assetId: number): Promise<{ asset: DesignAsset; data: Uint8Array }> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    const task = await this.deps.taskLookup(designId);
    this.requireLiveEpoch(epoch);
    if (!task || task.projectId !== projectId || task.designId !== designId) {
      throw new DesignAssetError('NOT_FOUND', 'The design was not found.');
    }
    const asset = this.deps.store.getScoped(projectId, designId, assetId);
    if (!asset || asset.status !== 'succeeded') throw new DesignAssetError('NOT_FOUND', 'The design asset was not found.');
    this.deps.storage.bindProject(asset.id, projectId);
    return { asset, data: await this.deps.storage.readSucceeded(asset) };
  }

  recover(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.recovery) return this.recovery;
    if (this.stopped || options.signal?.aborted) return Promise.resolve();
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    this.recoveryController = controller;
    const epoch = this.epoch;
    const recovery = this.recoverLoop(controller.signal, epoch).finally(() => {
      options.signal?.removeEventListener('abort', abort);
      if (this.recovery === recovery) this.recovery = null;
      if (this.recoveryController === controller) this.recoveryController = null;
    });
    this.recovery = recovery;
    return recovery;
  }

  private async recoverLoop(signal: AbortSignal, epoch: number): Promise<void> {
    const wait = async <T>(operation: Promise<T>): Promise<{ aborted: true } | { aborted: false; value: T }> => {
      if (!this.live(epoch, signal)) return { aborted: true };
      let onAbort!: () => void;
      const aborted = new Promise<{ aborted: true }>((resolve) => {
        onAbort = () => resolve({ aborted: true });
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([
          operation.then((value) => ({ aborted: false as const, value })),
          aborted,
        ]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    };
    for (const asset of this.deps.store.listQueuedAndRunning()) {
      if (!this.live(epoch, signal)) return;
      const projectId = this.deps.store.projectIdForAsset(asset.id);
      if (projectId) this.deps.storage.bindProject(asset.id, projectId);
      if (asset.status === 'queued') {
        if (!asset.runnable || !Array.isArray(asset.stagingManifest)) {
          this.deps.store.failQueued(asset.id, asset.assetVersion, 'interrupted_staging');
          if ((await wait(this.deps.storage.cleanupStaging(asset.id))).aborted) return;
        }
        continue;
      }
      const verified = await wait(this.deps.storage.verifyExpected(asset));
      if (verified.aborted || !this.live(epoch, signal)) return;
      if (verified.value) {
        this.deps.store.completeRunning(asset.id, asset.assetVersion, verified.value);
      } else {
        this.deps.store.failRunning(asset.id, asset.assetVersion, 'interrupted');
        if ((await wait(this.deps.storage.removeOutput(asset))).aborted) return;
      }
      if ((await wait(this.deps.storage.cleanupStaging(asset.id))).aborted) return;
    }
    // A process intentionally started without provider credentials exposes a disabled
    // capability and preserves runnable queued work for a later configured restart.
    if (this.live(epoch, signal) && this.deps.generator) await this.runPending();
  }

  async shutdown(timeoutMs = 5_000): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new DesignAssetError('INVALID_REQUEST', 'Shutdown timeout is invalid.');
    }
    this.stopped = true;
    this.epoch++;
    this.recoveryController?.abort(new DOMException('shutdown', 'AbortError'));
    for (const item of this.active.values()) item.controller.abort();
    const pending = [this.draining, this.recovery].filter((value): value is Promise<void> => value !== null);
    if (pending.length === 0 || timeoutMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending.map((value) => value.catch(() => {}))).then(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async annotate(input: {
    projectId: number; designId: number; assetId: number; expectedAssetVersion: number;
    functionalDetails: FunctionalDetails; implementationReady: boolean;
  }, actor: { userId: number }): Promise<DesignAsset> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    const authorized = await this.deps.authorizeOwner(input.projectId, actor.userId);
    this.requireLiveEpoch(epoch);
    if (!authorized) throw new DesignAssetError('FORBIDDEN', 'Only the owner can annotate assets.');
    const task = await this.deps.taskLookup(input.designId);
    this.requireLiveEpoch(epoch);
    if (!task || task.projectId !== input.projectId) throw new DesignAssetError('NOT_FOUND', 'The design was not found.');
    if (task.status === 'archived') throw new DesignAssetError('ARCHIVED', 'The design is archived.');
    const asset = this.deps.store.getScoped(input.projectId, input.designId, input.assetId);
    if (!asset) throw new DesignAssetError('NOT_FOUND', 'The design asset was not found.');
    this.deps.storage.bindProject(asset.id, input.projectId);
    if (!validFunctionalDetails(input.functionalDetails, false)) throw new DesignAssetError('INVALID_REQUEST', 'Functional details are invalid.');
    if (input.implementationReady) {
      if (!functionalDetailsComplete(input.functionalDetails)) throw new DesignAssetError('ANNOTATION_INCOMPLETE', 'Functional details are incomplete.');
      if (asset.status !== 'succeeded' || asset.designRevision !== task.currentRevision) {
        throw new DesignAssetError('REVISION_CONFLICT', 'Only a current succeeded asset can be implementation-ready.');
      }
      await this.deps.storage.readSucceeded(asset);
      this.requireLiveEpoch(epoch);
    }
    return this.deps.store.annotateScoped({
      ...input, actorUserId: actor.userId, ts: this.now(),
    });
  }

  async listForRevision(projectId: number, designId: number, revision: number): Promise<DesignProjectionAsset[]> {
    const epoch = this.epoch;
    this.requireLiveEpoch(epoch);
    const output: DesignProjectionAsset[] = [];
    for (const asset of this.deps.store.listReadyForRevision(projectId, designId, revision)) {
      try {
        this.deps.storage.bindProject(asset.id, projectId);
        const data = await this.deps.storage.readSucceeded(asset);
        output.push({
          id: asset.id,
          name: `visual-${asset.id}.${extensionForMime(asset.mimeType!)}`,
          mimeType: asset.mimeType as DesignProjectionAsset['mimeType'],
          data,
          sha256: asset.outputSha256!,
        });
      } catch {
        // Corrupt/missing controlled bytes are excluded from implementation publication.
      }
    }
    return output;
  }
}

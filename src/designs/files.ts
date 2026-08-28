import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { GitResult } from '../executor/driver';
import { gitLockKey, type KeyedMutex } from '../issues/mutex';
import { inspectDesignRaster } from './image-provider';

const encoder = new TextEncoder();
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_GRAPH_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_ASSETS = 100;
const CONFLICT_TTL_MS = 10 * 60 * 1000;
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type DesignFilesErrorCode =
  | 'INVALID_REQUEST'
  | 'REVISION_CONFLICT'
  | 'SNAPSHOT_NOT_FOUND'
  | 'TARGET_INVALID'
  | 'REPO_UNAVAILABLE'
  | 'UNSAFE_PATH'
  | 'ASSET_INVALID'
  | 'MANIFEST_INVALID'
  | 'EXTERNAL_CHANGE'
  | 'CONFLICT_STALE'
  | 'WRITE_FAILED';

export class DesignFilesError extends Error {
  constructor(readonly code: DesignFilesErrorCode, message: string) {
    super(message);
    this.name = 'DesignFilesError';
  }

  toJSON(): Record<string, string> {
    return { name: this.name, code: this.code };
  }
}

export interface DesignProjectionAsset {
  id: number;
  name: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: Uint8Array;
  sha256: string;
}

export interface DesignProjectionPersona {
  key: string;
  source: string;
  contentHash: string;
  gitCommit?: string;
}

export interface DesignFilesSnapshot {
  projectId: number;
  designId: number;
  revision: number;
  documentMarkdown: string;
  graph: unknown;
  assets: DesignProjectionAsset[];
  personas?: DesignProjectionPersona[];
}

export interface DesignFilesDriver {
  listDirectoryNoFollowWithin(
    root: string,
    relativePath: string,
  ): Promise<Array<{ name: string; type: 'file' | 'dir' | 'symlink' | 'other' }> | null>;
  readFileNoFollowWithin(
    root: string,
    relativePath: string,
    limit: number,
  ): Promise<{ data: Uint8Array; size: number } | null>;
  replaceFileNoFollowWithin(
    root: string,
    relativePath: string,
    data: Uint8Array,
    expectedSha256: string | null,
  ): Promise<'written' | 'unchanged' | 'conflict'>;
  removeFileNoFollowWithin(
    root: string,
    relativePath: string,
    expectedSha256: string,
  ): Promise<'removed' | 'missing' | 'conflict'>;
  git(cwd: string, args: string[]): Promise<GitResult>;
}

export interface DesignFilesTarget {
  driver: DesignFilesDriver;
  cwd: string;
  kind: 'project' | 'design_worktree';
  stableKey: string;
}

type MaybePromise<T> = T | Promise<T>;

export interface DesignFilesServiceDeps {
  mutex: KeyedMutex;
  loadCurrentSnapshot(projectId: number, designId: number): MaybePromise<DesignFilesSnapshot | null>;
  loadRevisionSnapshot(projectId: number, designId: number, revision: number): MaybePromise<DesignFilesSnapshot | null>;
  resolveTarget(projectId: number, designId: number): MaybePromise<DesignFilesTarget>;
  conflictSecret: string | Uint8Array;
  now?: () => number;
}

export interface DesignProjectionManifest {
  schemaVersion: 1;
  generatedBy: 'PandaDOS';
  authoritativeSource: 'database';
  designId: number;
  projectId: number;
  revision: number;
  slug: string;
  publishedAt: number;
  target: {
    kind: 'project' | 'design_worktree';
    branch: string | null;
    head: string | null;
    identitySha256: string;
  };
  document: { path: 'DESIGN.md'; contentSha256: string; fileSha256: string; bytes: number };
  graph: { path: 'issue-graph.json'; contentSha256: string; fileSha256: string; bytes: number };
  assets: Array<{ id: number; path: string; sha256: string; bytes: number; mimeType: string }>;
  personas?: Array<{ key: string; source: string; contentHash: string; gitCommit?: string }>;
  bundleSha256: string;
  selfDigest: string;
}

export interface RenderedDesignProjectionBundle {
  files: Map<string, Uint8Array>;
  manifest: DesignProjectionManifest;
}

export type DesignFileClassification =
  | 'unchanged'
  | 'safe_update'
  | 'already_target'
  | 'local_only'
  | 'conflict';

export interface DesignFileDiffItem {
  path: string;
  classification: DesignFileClassification;
  baseSha256: string | null;
  localSha256: string | null;
  incomingSha256: string | null;
  baseBytes: number | null;
  localBytes: number | null;
  incomingBytes: number | null;
  baseText?: string | null;
  localText?: string | null;
  incomingText?: string | null;
}

export interface DesignFilesDiffResult {
  projectId: number;
  designId: number;
  revision: number;
  targetKind: 'project' | 'design_worktree';
  files: DesignFileDiffItem[];
  conflictToken?: string;
}

export interface PublishDesignFilesInput {
  projectId: number;
  designId: number;
  expectedRevision: number;
  resolution?: 'overwrite';
  conflictToken?: string;
}

interface TechnicalTarget {
  kind: 'project' | 'design_worktree';
  branch: string | null;
  head: string | null;
  stableKey: string;
}

interface PreparedState {
  snapshot: DesignFilesSnapshot;
  target: DesignFilesTarget;
  technical: TechnicalTarget;
  base: RenderedDesignProjectionBundle | null;
  incoming: RenderedDesignProjectionBundle;
  local: Map<string, Uint8Array | null>;
  diff: DesignFileDiffItem[];
  baseBundleSha256: string | null;
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new DesignFilesError('INVALID_REQUEST', 'Canonical JSON contains a non-finite number.');
    return value;
  }
  if (typeof value !== 'object') throw new DesignFilesError('INVALID_REQUEST', 'Canonical JSON contains an unsupported value.');
  if (seen.has(value)) throw new DesignFilesError('INVALID_REQUEST', 'Canonical JSON contains a cycle.');
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
    if (!isPlainRecord(value)) throw new DesignFilesError('INVALID_REQUEST', 'Canonical JSON requires plain objects.');
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      output[key] = canonicalValue(value[key], seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalDesignJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value, new Set()), null, 2)}\n`;
}

function validPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function designFileSlug(designId: number): string {
  if (!validPositiveId(designId)) throw new DesignFilesError('INVALID_REQUEST', 'Design ID is invalid.');
  return `design-${designId}`;
}

function normalizedMarkdown(markdown: string): string {
  if (typeof markdown !== 'string' || markdown.includes('\0')) {
    throw new DesignFilesError('INVALID_REQUEST', 'Design Markdown is invalid.');
  }
  return `${markdown.replace(/(?:\r\n|\r|\n)+$/u, '')}\n`;
}

function sortedGraph(graph: unknown): unknown {
  if (!isPlainRecord(graph) || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new DesignFilesError('INVALID_REQUEST', 'Design graph is invalid.');
  }
  const compare = (left: unknown, right: unknown, fields: string[]): number => {
    const a = isPlainRecord(left) ? left : {};
    const b = isPlainRecord(right) ? right : {};
    for (const field of fields) {
      const av = a[field]; const bv = b[field];
      const comparison = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : compareText(String(av ?? ''), String(bv ?? ''));
      if (comparison !== 0) return comparison;
    }
    return 0;
  };
  return {
    ...graph,
    nodes: [...graph.nodes].sort((a, b) => compare(a, b, ['ordinal', 'nodeId'])),
    edges: [...graph.edges].sort((a, b) => compare(a, b, ['fromNodeId', 'toNodeId', 'kind'])),
  };
}

function safeAsset(asset: DesignProjectionAsset): { path: string; data: Uint8Array } {
  const mimeExtensions: Record<DesignProjectionAsset['mimeType'], readonly string[]> = {
    'image/png': ['png'],
    'image/jpeg': ['jpg', 'jpeg'],
    'image/webp': ['webp'],
  };
  if (!validPositiveId(asset.id)
    || typeof asset.name !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(asset.name)
    || !(asset.data instanceof Uint8Array)
    || asset.data.length === 0
    || asset.data.length > MAX_ASSET_BYTES
    || !HASH_RE.test(asset.sha256)
    || sha256(asset.data) !== asset.sha256) {
    throw new DesignFilesError('ASSET_INVALID', 'Design projection asset is invalid.');
  }
  const extension = asset.name.split('.').at(-1)?.toLowerCase() ?? '';
  if (!mimeExtensions[asset.mimeType]?.includes(extension)) {
    throw new DesignFilesError('ASSET_INVALID', 'Design projection asset MIME and extension differ.');
  }
  const raster = inspectDesignRaster(asset.data);
  if (!raster || raster.mime !== asset.mimeType || raster.width <= 0 || raster.height <= 0) {
    throw new DesignFilesError('ASSET_INVALID', 'Design projection asset MIME does not match its bytes.');
  }
  return { path: `assets/${asset.id}-${asset.name}`, data: asset.data.slice() };
}

function validPersona(persona: DesignProjectionPersona): boolean {
  return typeof persona.key === 'string'
    && persona.key.length > 0
    && persona.key.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(persona.key)
    && typeof persona.source === 'string'
    && persona.source.length > 0
    && persona.source.length <= 256
    && HASH_RE.test(persona.contentHash)
    && (persona.gitCommit === undefined || COMMIT_RE.test(persona.gitCommit));
}

export function renderDesignProjectionBundle(
  snapshot: DesignFilesSnapshot,
  target: TechnicalTarget,
  publishedAt: number,
): RenderedDesignProjectionBundle {
  if (!validPositiveId(snapshot.projectId)
    || !validPositiveId(snapshot.designId)
    || !validPositiveId(snapshot.revision)
    || !Number.isSafeInteger(publishedAt)
    || publishedAt < 0
    || !target.stableKey
    || target.stableKey.length > 512
    || (target.branch !== null && (target.branch.length > 512 || /[\u0000-\u001f\u007f]/.test(target.branch)))
    || (target.head !== null && !COMMIT_RE.test(target.head))) {
    throw new DesignFilesError('INVALID_REQUEST', 'Design projection snapshot is invalid.');
  }
  const slug = designFileSlug(snapshot.designId);
  const markdown = normalizedMarkdown(snapshot.documentMarkdown);
  const documentContent = encoder.encode(markdown);
  const document = encoder.encode(
    `<!-- PandaDOS design schema=1 design=${snapshot.designId} revision=${snapshot.revision} -->\n${markdown}`,
  );
  if (document.length > MAX_DOCUMENT_BYTES) throw new DesignFilesError('INVALID_REQUEST', 'Design document is too large.');
  const graphContent = encoder.encode(canonicalDesignJson(sortedGraph(snapshot.graph)));
  const graph = encoder.encode(canonicalDesignJson({
    schemaVersion: 1,
    designId: snapshot.designId,
    revision: snapshot.revision,
    graph: sortedGraph(snapshot.graph),
  }));
  if (graph.length > MAX_GRAPH_BYTES) throw new DesignFilesError('INVALID_REQUEST', 'Design graph is too large.');
  if (!Array.isArray(snapshot.assets) || snapshot.assets.length > MAX_ASSETS) {
    throw new DesignFilesError('ASSET_INVALID', 'Too many design projection assets.');
  }
  const sortedAssets = [...snapshot.assets].sort((a, b) => a.id - b.id || compareText(a.name, b.name));
  const seenAssets = new Set<number>();
  let assetBytes = 0;
  const files = new Map<string, Uint8Array>([['DESIGN.md', document], ['issue-graph.json', graph]]);
  const assets = sortedAssets.map((asset) => {
    if (seenAssets.has(asset.id)) throw new DesignFilesError('ASSET_INVALID', 'Duplicate design asset ID.');
    seenAssets.add(asset.id);
    const safe = safeAsset(asset);
    assetBytes += safe.data.length;
    if (assetBytes > MAX_ASSET_TOTAL_BYTES) throw new DesignFilesError('ASSET_INVALID', 'Design assets are too large.');
    files.set(safe.path, safe.data);
    return { id: asset.id, path: safe.path, sha256: asset.sha256, bytes: safe.data.length, mimeType: asset.mimeType };
  });
  const seenPersonas = new Set<string>();
  const personas = snapshot.personas === undefined
    ? undefined
    : [...snapshot.personas].sort((a, b) => compareText(a.key, b.key)).map((persona) => {
      if (!validPersona(persona) || seenPersonas.has(persona.key)) {
        throw new DesignFilesError('INVALID_REQUEST', 'Persona provenance is invalid.');
      }
      seenPersonas.add(persona.key);
      return {
        key: persona.key,
        source: persona.source,
        contentHash: persona.contentHash,
        ...(persona.gitCommit === undefined ? {} : { gitCommit: persona.gitCommit }),
      };
    });
  const documentRecord = {
    path: 'DESIGN.md' as const,
    contentSha256: sha256(documentContent),
    fileSha256: sha256(document),
    bytes: document.length,
  };
  const graphRecord = {
    path: 'issue-graph.json' as const,
    contentSha256: sha256(graphContent),
    fileSha256: sha256(graph),
    bytes: graph.length,
  };
  const manifestTarget = {
    kind: target.kind,
    branch: target.branch,
    head: target.head,
    identitySha256: sha256(target.stableKey),
  };
  const bundleSha256 = sha256(canonicalDesignJson({
    schemaVersion: 1,
    projectId: snapshot.projectId,
    designId: snapshot.designId,
    revision: snapshot.revision,
    target: { kind: target.kind, stableKey: target.stableKey, branch: target.branch, head: target.head },
    document: documentRecord,
    graph: graphRecord,
    assets,
    ...(personas === undefined ? {} : { personas }),
  }));
  const withoutSelf = {
    schemaVersion: 1 as const,
    generatedBy: 'PandaDOS' as const,
    authoritativeSource: 'database' as const,
    designId: snapshot.designId,
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    slug,
    publishedAt,
    target: manifestTarget,
    document: documentRecord,
    graph: graphRecord,
    assets,
    ...(personas === undefined ? {} : { personas }),
    bundleSha256,
  };
  const manifest: DesignProjectionManifest = {
    ...withoutSelf,
    selfDigest: sha256(canonicalDesignJson(withoutSelf)),
  };
  const manifestBytes = encoder.encode(canonicalDesignJson(manifest));
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new DesignFilesError('INVALID_REQUEST', 'Design manifest is too large.');
  files.set('manifest.json', manifestBytes);
  return { files, manifest };
}

function parseUtf8(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new DesignFilesError('MANIFEST_INVALID', 'Design projection manifest is invalid.');
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validManifestFile(
  value: unknown,
  path: 'DESIGN.md' | 'issue-graph.json',
): boolean {
  return isPlainRecord(value)
    && exactKeys(value, ['path', 'contentSha256', 'fileSha256', 'bytes'])
    && value.path === path
    && HASH_RE.test(String(value.contentSha256))
    && HASH_RE.test(String(value.fileSha256))
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0;
}

function validManifestAsset(value: unknown): boolean {
  return isPlainRecord(value)
    && exactKeys(value, ['id', 'path', 'sha256', 'bytes', 'mimeType'])
    && validPositiveId(value.id)
    && typeof value.path === 'string'
    && new RegExp(`^assets/${value.id}-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$`).test(value.path)
    && HASH_RE.test(String(value.sha256))
    && typeof value.bytes === 'number'
    && Number.isSafeInteger(value.bytes)
    && value.bytes > 0
    && (value.mimeType === 'image/png' || value.mimeType === 'image/jpeg' || value.mimeType === 'image/webp');
}

function validManifestPersona(value: unknown): boolean {
  if (!isPlainRecord(value)
    || !exactKeys(value, value.gitCommit === undefined
      ? ['key', 'source', 'contentHash']
      : ['key', 'source', 'contentHash', 'gitCommit'])) return false;
  return validPersona(value as unknown as DesignProjectionPersona);
}

export function parseDesignProjectionManifest(bytes: Uint8Array): DesignProjectionManifest {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new DesignFilesError('MANIFEST_INVALID', 'Design projection manifest is invalid.');
  }
  const value = parseUtf8(bytes);
  if (!isPlainRecord(value)
    || !exactKeys(value, value.personas === undefined
      ? [
        'schemaVersion', 'generatedBy', 'authoritativeSource', 'designId', 'projectId',
        'revision', 'slug', 'publishedAt', 'target', 'document', 'graph', 'assets',
        'bundleSha256', 'selfDigest',
      ]
      : [
        'schemaVersion', 'generatedBy', 'authoritativeSource', 'designId', 'projectId',
        'revision', 'slug', 'publishedAt', 'target', 'document', 'graph', 'assets', 'personas',
        'bundleSha256', 'selfDigest',
      ])
    || value.schemaVersion !== 1
    || value.generatedBy !== 'PandaDOS'
    || value.authoritativeSource !== 'database'
    || !validPositiveId(value.designId)
    || !validPositiveId(value.projectId)
    || !validPositiveId(value.revision)
    || value.slug !== designFileSlug(value.designId)
    || typeof value.publishedAt !== 'number'
    || !Number.isSafeInteger(value.publishedAt)
    || value.publishedAt < 0
    || !isPlainRecord(value.target)
    || !exactKeys(value.target, ['kind', 'branch', 'head', 'identitySha256'])
    || (value.target.kind !== 'project' && value.target.kind !== 'design_worktree')
    || (value.target.branch !== null
      && (typeof value.target.branch !== 'string'
        || !value.target.branch
        || value.target.branch.length > 512
        || /[\u0000-\u001f\u007f]/.test(value.target.branch)))
    || (value.target.head !== null
      && (typeof value.target.head !== 'string' || !COMMIT_RE.test(value.target.head)))
    || !HASH_RE.test(String(value.target.identitySha256))
    || !validManifestFile(value.document, 'DESIGN.md')
    || !validManifestFile(value.graph, 'issue-graph.json')
    || !Array.isArray(value.assets)
    || value.assets.length > MAX_ASSETS
    || !value.assets.every(validManifestAsset)
    || (value.personas !== undefined
      && (!Array.isArray(value.personas) || !value.personas.every(validManifestPersona)))
    || !HASH_RE.test(String(value.bundleSha256))
    || !HASH_RE.test(String(value.selfDigest))) {
    throw new DesignFilesError('MANIFEST_INVALID', 'Design projection manifest is invalid.');
  }
  const { selfDigest, ...withoutSelf } = value;
  if (sha256(canonicalDesignJson(withoutSelf)) !== selfDigest
    || canonicalDesignJson(value) !== new TextDecoder().decode(bytes)) {
    throw new DesignFilesError('MANIFEST_INVALID', 'Design projection manifest integrity check failed.');
  }
  return value as unknown as DesignProjectionManifest;
}

export function classifyDesignFile(
  localSha256: string | null,
  baseSha256: string | null,
  incomingSha256: string | null,
): DesignFileClassification {
  if (localSha256 === incomingSha256) return localSha256 === baseSha256 ? 'unchanged' : 'already_target';
  if (baseSha256 === null) return localSha256 === null ? 'safe_update' : 'conflict';
  if (localSha256 === null) return 'conflict';
  if (localSha256 === baseSha256) return 'safe_update';
  if (incomingSha256 === baseSha256) return 'local_only';
  return 'conflict';
}

function boundedFile(path: string): number {
  if (path === 'DESIGN.md') return MAX_DOCUMENT_BYTES;
  if (path === 'issue-graph.json') return MAX_GRAPH_BYTES;
  if (path === 'manifest.json') return MAX_MANIFEST_BYTES;
  if (/^assets\/[1-9]\d*-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(path)) return MAX_ASSET_BYTES;
  throw new DesignFilesError('UNSAFE_PATH', 'Owned design projection path is invalid.');
}

function projectionText(path: string, bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  if (path !== 'DESIGN.md' && path !== 'issue-graph.json' && path !== 'manifest.json') return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

function fullPath(designId: number, path: string): string {
  boundedFile(path);
  return `.panda/designs/${designFileSlug(designId)}/${path}`;
}

function validRequest(input: PublishDesignFilesInput): boolean {
  return validPositiveId(input.projectId)
    && validPositiveId(input.designId)
    && validPositiveId(input.expectedRevision)
    && (input.resolution === undefined || input.resolution === 'overwrite')
    && (input.resolution === 'overwrite' ? typeof input.conflictToken === 'string' : input.conflictToken === undefined);
}

function safeTarget(target: DesignFilesTarget): boolean {
  return typeof target.cwd === 'string'
    && target.cwd.startsWith('/')
    && !target.cwd.includes('\0')
    && typeof target.stableKey === 'string'
    && target.stableKey.length > 0
    && target.stableKey.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(target.stableKey)
    && (target.kind === 'project' || target.kind === 'design_worktree');
}

export class DesignFilesService {
  private readonly now: () => number;
  private readonly secret: Buffer;

  constructor(private readonly deps: DesignFilesServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.secret = Buffer.from(deps.conflictSecret);
    if (this.secret.length < 16) throw new DesignFilesError('INVALID_REQUEST', 'Conflict token secret is too short.');
  }

  async diff(input: PublishDesignFilesInput): Promise<DesignFilesDiffResult> {
    if (!validRequest({ ...input, resolution: undefined, conflictToken: undefined })) {
      throw new DesignFilesError('INVALID_REQUEST', 'Design file request is invalid.');
    }
    return await this.deps.mutex.runExclusive(gitLockKey(input.projectId), async () => {
      const prepared = await this.prepare(input);
      return this.diffResult(prepared, true);
    });
  }

  async publish(input: PublishDesignFilesInput): Promise<{
    status: 'published' | 'noop' | 'local_changes';
    revision: number;
    targetKind: 'project' | 'design_worktree';
    bundleSha256: string;
  }> {
    if (!validRequest(input)) throw new DesignFilesError('INVALID_REQUEST', 'Design file request is invalid.');
    return await this.deps.mutex.runExclusive(gitLockKey(input.projectId), async () => {
      const prepared = await this.prepare(input);
      const conflicts = prepared.diff.some((item) => item.classification === 'conflict');
      const localOnly = prepared.diff.some((item) => item.classification === 'local_only');
      if (input.resolution === 'overwrite') {
        if (!input.conflictToken || !this.verifyToken(input.conflictToken, prepared)) {
          throw new DesignFilesError('CONFLICT_STALE', 'Design file conflict token is stale.');
        }
      } else if (conflicts) {
        throw new DesignFilesError('EXTERNAL_CHANGE', 'Design projection has external changes.');
      } else if (localOnly) {
        return {
          status: 'local_changes',
          revision: prepared.snapshot.revision,
          targetKind: prepared.target.kind,
          bundleSha256: prepared.incoming.manifest.bundleSha256,
        };
      }
      const dataPaths = prepared.diff
        .map((item) => item.path)
        .filter((path) => path !== 'manifest.json')
        .sort((left, right) => {
          const priority = (path: string): number => path === 'DESIGN.md' ? 0 : path.startsWith('assets/') ? 1 : 2;
          return priority(left) - priority(right) || compareText(left, right);
        });
      let writes = 0;
      for (const path of dataPaths) {
        const incoming = prepared.incoming.files.get(path) ?? null;
        const local = prepared.local.get(path) ?? null;
        if (incoming === null) {
          if (local === null) continue;
          await this.assertTargetFresh(prepared);
          await this.removeAndVerify(prepared, path, sha256(local));
          writes++;
          continue;
        }
        if (local && sha256(local) === sha256(incoming)) continue;
        await this.assertTargetFresh(prepared);
        await this.writeAndVerify(prepared, path, incoming, local ? sha256(local) : null);
        writes++;
      }
      const manifest = prepared.incoming.files.get('manifest.json')!;
      const localManifest = prepared.local.get('manifest.json') ?? null;
      await this.assertTargetFresh(prepared);
      if (!localManifest || sha256(localManifest) !== sha256(manifest)) {
        await this.writeAndVerify(prepared, 'manifest.json', manifest, localManifest ? sha256(localManifest) : null);
        writes++;
      }
      await this.assertTargetFresh(prepared);
      return {
        status: writes === 0 ? 'noop' : 'published',
        revision: prepared.snapshot.revision,
        targetKind: prepared.target.kind,
        bundleSha256: prepared.incoming.manifest.bundleSha256,
      };
    });
  }

  private async prepare(input: PublishDesignFilesInput): Promise<PreparedState> {
    const snapshot = await this.deps.loadCurrentSnapshot(input.projectId, input.designId);
    if (!snapshot || snapshot.projectId !== input.projectId || snapshot.designId !== input.designId) {
      throw new DesignFilesError('SNAPSHOT_NOT_FOUND', 'Design snapshot was not found.');
    }
    if (snapshot.revision !== input.expectedRevision) {
      throw new DesignFilesError('REVISION_CONFLICT', 'Design revision changed.');
    }
    const target = await this.deps.resolveTarget(input.projectId, input.designId);
    if (!safeTarget(target)) throw new DesignFilesError('TARGET_INVALID', 'Design file target is invalid.');
    const technical = await this.technicalTarget(target);
    await this.preflight(target, input.designId);
    const manifestPath = fullPath(input.designId, 'manifest.json');
    const localManifestFile = await this.secureRead(target, manifestPath, MAX_MANIFEST_BYTES + 1);
    if (localManifestFile && localManifestFile.size > MAX_MANIFEST_BYTES) {
      throw new DesignFilesError('MANIFEST_INVALID', 'Design manifest is too large.');
    }
    let priorManifest: DesignProjectionManifest | null = null;
    let base: RenderedDesignProjectionBundle | null = null;
    if (localManifestFile) {
      try {
        priorManifest = parseDesignProjectionManifest(localManifestFile.data);
        if (priorManifest.projectId !== input.projectId
          || priorManifest.designId !== input.designId
          || priorManifest.target.identitySha256 !== sha256(target.stableKey)) {
          throw new DesignFilesError('MANIFEST_INVALID', 'Design manifest belongs to another target.');
        }
        const baseSnapshot = await this.deps.loadRevisionSnapshot(input.projectId, input.designId, priorManifest.revision);
        if (!baseSnapshot
          || baseSnapshot.projectId !== input.projectId
          || baseSnapshot.designId !== input.designId
          || baseSnapshot.revision !== priorManifest.revision) {
          throw new DesignFilesError('MANIFEST_INVALID', 'Design manifest base revision is unavailable.');
        }
        base = renderDesignProjectionBundle(baseSnapshot, {
          kind: priorManifest.target.kind,
          branch: priorManifest.target.branch,
          head: priorManifest.target.head,
          stableKey: target.stableKey,
        }, priorManifest.publishedAt);
        if (base.manifest.selfDigest !== priorManifest.selfDigest) {
          throw new DesignFilesError('MANIFEST_INVALID', 'Design manifest does not match its immutable base.');
        }
      } catch (error) {
        if (!(error instanceof DesignFilesError) || error.code !== 'MANIFEST_INVALID') throw error;
        // An untrusted or obsolete manifest cannot establish an authoritative base.
        // Keep its bounded bytes as local state so only a signed overwrite decision
        // can rebuild the owned projection from the current immutable revision.
        priorManifest = null;
        base = null;
      }
    }
    let incoming = renderDesignProjectionBundle(snapshot, technical, this.now());
    if (priorManifest && incoming.manifest.bundleSha256 === priorManifest.bundleSha256) {
      incoming = renderDesignProjectionBundle(snapshot, technical, priorManifest.publishedAt);
    }
    const paths = new Set<string>([
      ...incoming.files.keys(),
      ...(base ? base.files.keys() : []),
      'manifest.json',
    ]);
    const local = new Map<string, Uint8Array | null>();
    const diff: DesignFileDiffItem[] = [];
    for (const path of [...paths].sort(compareText)) {
      const file = path === 'manifest.json' && localManifestFile
        ? localManifestFile
        : await this.secureRead(target, fullPath(input.designId, path), boundedFile(path) + 1);
      if (file && file.size > boundedFile(path)) throw new DesignFilesError('UNSAFE_PATH', 'Owned design file is too large.');
      const bytes = file?.data ?? null;
      local.set(path, bytes);
      const baseBytes = base?.files.get(path) ?? null;
      const incomingBytes = incoming.files.get(path) ?? null;
      const localHash = bytes ? sha256(bytes) : null;
      const baseHash = baseBytes ? sha256(baseBytes) : null;
      const incomingHash = incomingBytes ? sha256(incomingBytes) : null;
      diff.push({
        path,
        classification: classifyDesignFile(localHash, baseHash, incomingHash),
        baseSha256: baseHash,
        localSha256: localHash,
        incomingSha256: incomingHash,
        baseBytes: baseBytes?.length ?? null,
        localBytes: bytes?.length ?? null,
        incomingBytes: incomingBytes?.length ?? null,
        ...(path === 'DESIGN.md' || path === 'issue-graph.json' || path === 'manifest.json'
          ? {
            baseText: projectionText(path, baseBytes),
            localText: projectionText(path, bytes),
            incomingText: projectionText(path, incomingBytes),
          }
          : {}),
      });
    }
    return {
      snapshot,
      target,
      technical,
      base,
      incoming,
      local,
      diff,
      baseBundleSha256: priorManifest?.bundleSha256 ?? null,
    };
  }

  private async technicalTarget(target: DesignFilesTarget): Promise<TechnicalTarget> {
    let inside: GitResult;
    let branchResult: GitResult;
    let headResult: GitResult;
    try {
      inside = await target.driver.git(target.cwd, ['rev-parse', '--is-inside-work-tree']);
      branchResult = await target.driver.git(target.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      headResult = await target.driver.git(target.cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    } catch {
      throw new DesignFilesError('REPO_UNAVAILABLE', 'Projection target Git metadata is unavailable.');
    }
    if (inside.code !== 0 || inside.out.trim() !== 'true') {
      throw new DesignFilesError('REPO_UNAVAILABLE', 'Projection target is not a Git worktree.');
    }
    const branch = branchResult.code === 0 ? branchResult.out.trim() : null;
    const head = headResult.code === 0 ? headResult.out.trim() : null;
    if ((branch !== null && (!branch || branch.length > 512 || /[\u0000-\u001f\u007f]/.test(branch)))
      || (head !== null && !COMMIT_RE.test(head))) {
      throw new DesignFilesError('REPO_UNAVAILABLE', 'Projection target Git metadata is invalid.');
    }
    return { kind: target.kind, branch, head, stableKey: target.stableKey };
  }

  private async preflight(target: DesignFilesTarget, designId: number): Promise<void> {
    const levels = [
      { parent: '', child: '.panda' },
      { parent: '.panda', child: 'designs' },
      { parent: '.panda/designs', child: designFileSlug(designId) },
      { parent: `.panda/designs/${designFileSlug(designId)}`, child: 'assets' },
    ];
    for (const level of levels) {
      const entries = await this.secureList(target, level.parent);
      const entry = entries?.find((item) => item.name === level.child);
      if (entry && entry.type !== 'dir') throw new DesignFilesError('UNSAFE_PATH', 'Design projection directory is unsafe.');
    }
    const owned = new Set(['DESIGN.md', 'issue-graph.json', 'manifest.json']);
    const root = `.panda/designs/${designFileSlug(designId)}`;
    for (const entry of await this.secureList(target, root) ?? []) {
      if (owned.has(entry.name) && entry.type !== 'file') throw new DesignFilesError('UNSAFE_PATH', 'Owned design file is unsafe.');
    }
  }

  private diffResult(prepared: PreparedState, includeToken: boolean): DesignFilesDiffResult {
    const hasUserChanges = prepared.diff.some((item) => item.classification === 'conflict' || item.classification === 'local_only');
    return {
      projectId: prepared.snapshot.projectId,
      designId: prepared.snapshot.designId,
      revision: prepared.snapshot.revision,
      targetKind: prepared.target.kind,
      files: prepared.diff,
      ...(includeToken && hasUserChanges ? { conflictToken: this.token(prepared) } : {}),
    };
  }

  private tokenPayload(prepared: PreparedState): Record<string, unknown> {
    return {
      version: 1,
      projectId: prepared.snapshot.projectId,
      designId: prepared.snapshot.designId,
      revision: prepared.snapshot.revision,
      targetKind: prepared.target.kind,
      targetStableKeySha256: sha256(prepared.target.stableKey),
      technicalTargetSha256: this.technicalTargetSha256(prepared.target, prepared.technical),
      baseBundleSha256: prepared.baseBundleSha256,
      incomingBundleSha256: prepared.incoming.manifest.bundleSha256,
      local: prepared.diff.map((item) => ({ path: item.path, sha256: item.localSha256 })),
      expiresTs: this.now() + CONFLICT_TTL_MS,
    };
  }

  private technicalTargetSha256(target: DesignFilesTarget, technical: TechnicalTarget): string {
    return sha256(canonicalDesignJson({
      kind: target.kind,
      cwdSha256: sha256(target.cwd),
      stableKeySha256: sha256(target.stableKey),
      branch: technical.branch,
      head: technical.head,
    }));
  }

  private async assertTargetFresh(prepared: PreparedState): Promise<void> {
    try {
      const target = await this.deps.resolveTarget(prepared.snapshot.projectId, prepared.snapshot.designId);
      if (!safeTarget(target)
        || target.cwd !== prepared.target.cwd
        || target.kind !== prepared.target.kind
        || target.stableKey !== prepared.target.stableKey) {
        throw new Error('target identity changed');
      }
      const technical = await this.technicalTarget(target);
      if (this.technicalTargetSha256(target, technical)
        !== this.technicalTargetSha256(prepared.target, prepared.technical)) {
        throw new Error('technical target changed');
      }
    } catch {
      throw new DesignFilesError('CONFLICT_STALE', 'Design projection target changed during publish.');
    }
  }

  private token(prepared: PreparedState): string {
    const payload = Buffer.from(canonicalDesignJson(this.tokenPayload(prepared))).toString('base64url');
    const signature = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  private verifyToken(token: string, prepared: PreparedState): boolean {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined || payload.length > 64 * 1024) return false;
    const expected = createHmac('sha256', this.secret).update(payload).digest();
    let supplied: Buffer;
    try { supplied = Buffer.from(signature, 'base64url'); } catch { return false; }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return false; }
    if (!isPlainRecord(parsed)
      || typeof parsed.expiresTs !== 'number'
      || !Number.isSafeInteger(parsed.expiresTs)
      || parsed.expiresTs <= this.now()) return false;
    const expectedPayload = this.tokenPayload(prepared);
    expectedPayload.expiresTs = parsed.expiresTs;
    return canonicalDesignJson(parsed) === canonicalDesignJson(expectedPayload);
  }

  private async writeAndVerify(
    prepared: PreparedState,
    path: string,
    incoming: Uint8Array,
    expectedLocalSha: string | null,
  ): Promise<void> {
    let result: 'written' | 'unchanged' | 'conflict';
    try {
      result = await prepared.target.driver.replaceFileNoFollowWithin(
        prepared.target.cwd,
        fullPath(prepared.snapshot.designId, path),
        incoming,
        expectedLocalSha,
      );
    } catch {
      throw new DesignFilesError('WRITE_FAILED', 'Design projection write failed.');
    }
    if (result === 'conflict') throw new DesignFilesError('CONFLICT_STALE', 'Design projection changed during write.');
    const read = await this.secureRead(
      prepared.target,
      fullPath(prepared.snapshot.designId, path),
      boundedFile(path) + 1,
    );
    if (!read || read.size !== incoming.length || sha256(read.data) !== sha256(incoming)) {
      throw new DesignFilesError('WRITE_FAILED', 'Design projection read-back verification failed.');
    }
  }

  private async removeAndVerify(
    prepared: PreparedState,
    path: string,
    expectedLocalSha: string,
  ): Promise<void> {
    let result: 'removed' | 'missing' | 'conflict';
    try {
      result = await prepared.target.driver.removeFileNoFollowWithin(
        prepared.target.cwd,
        fullPath(prepared.snapshot.designId, path),
        expectedLocalSha,
      );
    } catch {
      throw new DesignFilesError('WRITE_FAILED', 'Design projection removal failed.');
    }
    if (result !== 'removed') throw new DesignFilesError('CONFLICT_STALE', 'Design projection changed during removal.');
    const read = await this.secureRead(
      prepared.target,
      fullPath(prepared.snapshot.designId, path),
      boundedFile(path) + 1,
    );
    if (read !== null) throw new DesignFilesError('WRITE_FAILED', 'Design projection removal verification failed.');
  }

  private async secureRead(
    target: DesignFilesTarget,
    relativePath: string,
    limit: number,
  ): Promise<{ data: Uint8Array; size: number } | null> {
    try {
      return await target.driver.readFileNoFollowWithin(target.cwd, relativePath, limit);
    } catch {
      throw new DesignFilesError('UNSAFE_PATH', 'Design projection path failed secure read validation.');
    }
  }

  private async secureList(
    target: DesignFilesTarget,
    relativePath: string,
  ): Promise<Array<{ name: string; type: 'file' | 'dir' | 'symlink' | 'other' }> | null> {
    try {
      return await target.driver.listDirectoryNoFollowWithin(target.cwd, relativePath);
    } catch {
      throw new DesignFilesError('UNSAFE_PATH', 'Design projection path failed secure directory validation.');
    }
  }
}

import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import {
  DesignAssetError,
  DesignAssetService,
  DesignAssetStorage,
  DesignAssetStore,
  type DesignAssetReferenceResolver,
  type DesignAssetServiceDeps,
} from './assets';
import { inspectDesignRaster, type DesignImageGenerator } from './image-provider';
import type { DesignRevision, DesignTask } from './types';

const MAX_PROJECT_REFERENCE_BYTES = 8 * 1024 * 1024;

export interface DesignAssetSnapshotStore {
  getTask(id: number): DesignTask | null;
  getRevision(id: number, revision: number): DesignRevision | null;
  isTaskProvisional?(id: number): boolean;
}

export interface DesignAssetProjectFileReader {
  read(
    scope: { projectId: number; designId: number },
    relativePath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export function createDesignAssetReferenceResolver(input: {
  store: DesignAssetStore;
  storage: DesignAssetStorage;
  projectFiles?: DesignAssetProjectFileReader;
}): DesignAssetReferenceResolver {
  return {
    async resolve(scope, descriptor, signal) {
      if (signal?.aborted) throw new DesignAssetError('REFERENCE_UNAVAILABLE', 'Reference resolution was cancelled.');
      if (descriptor.source === 'design_asset') {
        const asset = input.store.getScoped(scope.projectId, scope.designId, descriptor.assetId);
        if (!asset || asset.status !== 'succeeded') {
          throw new DesignAssetError('REFERENCE_UNAVAILABLE', 'The selected design asset is unavailable.');
        }
        input.storage.bindProject(asset.id, scope.projectId);
        const data = await input.storage.readSucceeded(asset);
        const mime = asset.mimeType;
        if (mime !== 'image/png' && mime !== 'image/webp') {
          throw new DesignAssetError('REFERENCE_INVALID', 'The selected design asset is invalid.');
        }
        return { name: `asset-${asset.id}.${mime === 'image/png' ? 'png' : 'webp'}`, mime, data };
      }
      if (!input.projectFiles) {
        throw new DesignAssetError('REFERENCE_UNAVAILABLE', 'Secure project-file reads are unavailable.');
      }
      let data: Uint8Array;
      try {
        data = await input.projectFiles.read(scope, descriptor.path, MAX_PROJECT_REFERENCE_BYTES, signal);
      } catch (error) {
        if (error instanceof DesignAssetError) throw error;
        throw new DesignAssetError('REFERENCE_UNAVAILABLE', 'The selected project file is unavailable.');
      }
      if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_PROJECT_REFERENCE_BYTES) {
        throw new DesignAssetError('REFERENCE_INVALID', 'The selected project file is invalid.');
      }
      const raster = inspectDesignRaster(data);
      if (!raster || (raster.mime !== 'image/png' && raster.mime !== 'image/jpeg' && raster.mime !== 'image/webp')) {
        throw new DesignAssetError('REFERENCE_INVALID', 'The selected project file is not a supported raster.');
      }
      return { name: basename(descriptor.path), mime: raster.mime, data };
    },
  };
}

export interface CreateDesignAssetRuntimeInput {
  db: Database;
  designStore: DesignAssetSnapshotStore;
  storageRoot: string;
  generator: DesignImageGenerator | null;
  provider?: { name: 'openai'; model: string; outputFormat: 'png' | 'webp'; quality: string };
  authorizeOwner(projectId: number, userId: number): boolean | Promise<boolean>;
  projectFiles?: DesignAssetProjectFileReader;
  maxConcurrent?: number;
  maxQueued?: number;
  schedule?: DesignAssetServiceDeps['schedule'];
  now?: () => number;
}

export function createDesignAssetRuntime(input: CreateDesignAssetRuntimeInput): {
  service: DesignAssetService;
  store: DesignAssetStore;
  storage: DesignAssetStorage;
} {
  if (input.generator && !input.provider) {
    throw new DesignAssetError('INVALID_REQUEST', 'Configured image generation requires provider provenance.');
  }
  const store = new DesignAssetStore(input.db);
  const storage = new DesignAssetStorage(input.storageRoot);
  const referenceResolver = createDesignAssetReferenceResolver({
    store, storage, ...(input.projectFiles ? { projectFiles: input.projectFiles } : {}),
  });
  const service = new DesignAssetService({
    store,
    storage,
    generator: input.generator,
    taskLookup: (designId) => {
      const task = input.designStore.getTask(designId);
      if (!task || input.designStore.isTaskProvisional?.(designId)) return null;
      return {
        projectId: task.projectId,
        designId: task.id,
        currentRevision: task.currentRevision,
        status: task.status,
        documentMarkdown: task.documentMarkdown ?? '',
      };
    },
    revisionLookup: (designId, revision) => {
      const value = input.designStore.getRevision(designId, revision);
      return value ? { revision: value.revision, documentMarkdown: value.documentMarkdown } : null;
    },
    authorizeOwner: input.authorizeOwner,
    referenceResolver,
    provider: input.provider ?? {
      name: 'openai', model: 'unconfigured', outputFormat: 'png', quality: 'medium',
    },
    ...(input.maxConcurrent === undefined ? {} : { maxConcurrent: input.maxConcurrent }),
    ...(input.maxQueued === undefined ? {} : { maxQueued: input.maxQueued }),
    ...(input.schedule === undefined ? {} : { schedule: input.schedule }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { service, store, storage };
}

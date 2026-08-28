import type { Project } from '../core/types';
import type { KeyedMutex } from '../issues/mutex';
import {
  DesignFilesError,
  DesignFilesService,
  type DesignFilesDriver,
  type DesignFilesServiceDeps,
  type DesignFilesSnapshot,
  type DesignFilesTarget,
  type DesignProjectionAsset,
  type DesignProjectionPersona,
} from './files';
import type { DesignStore } from './store';
import type { DesignWorktreeStore } from './worktree';

type MaybePromise<T> = T | Promise<T>;

export type DesignFilesSnapshotStore = Pick<
  DesignStore,
  'getTask' | 'getRevision' | 'isTaskProvisional'
>;

/** Supplies approved immutable bytes; DB paths and client asset IDs are never projection paths. */
export interface DesignProjectionAssets {
  listForRevision(
    projectId: number,
    designId: number,
    revision: number,
  ): MaybePromise<DesignProjectionAsset[]>;
}

/** Supplies provenance only. Implementations must never return persona prompt or secret content. */
export interface DesignProjectionPersonas {
  listForRevision(
    projectId: number,
    designId: number,
    revision: number,
  ): MaybePromise<DesignProjectionPersona[]>;
}

export interface DesignFilesSnapshotAccess {
  loadCurrentSnapshot(projectId: number, designId: number): Promise<DesignFilesSnapshot | null>;
  loadRevisionSnapshot(projectId: number, designId: number, revision: number): Promise<DesignFilesSnapshot | null>;
}

const EMPTY_ASSETS: DesignProjectionAssets = { listForRevision: () => [] };
const EMPTY_PERSONAS: DesignProjectionPersonas = { listForRevision: () => [] };

export function createDesignFilesSnapshotAccess(input: {
  store: DesignFilesSnapshotStore;
  assets?: DesignProjectionAssets;
  personas?: DesignProjectionPersonas;
}): DesignFilesSnapshotAccess {
  const assets = input.assets ?? EMPTY_ASSETS;
  const personas = input.personas ?? EMPTY_PERSONAS;

  const load = async (
    projectId: number,
    designId: number,
    requestedRevision: number | 'current',
  ): Promise<DesignFilesSnapshot | null> => {
    const task = input.store.getTask(designId);
    if (!task
      || task.projectId !== projectId
      || input.store.isTaskProvisional(designId)) return null;
    const revisionNumber = requestedRevision === 'current'
      ? task.currentRevision
      : requestedRevision;
    const immutable = input.store.getRevision(designId, revisionNumber);
    if (!immutable
      || immutable.designTaskId !== designId
      || immutable.revision !== revisionNumber) return null;
    const [revisionAssets, revisionPersonas] = await Promise.all([
      assets.listForRevision(projectId, designId, revisionNumber),
      personas.listForRevision(projectId, designId, revisionNumber),
    ]);
    return {
      projectId,
      designId,
      revision: revisionNumber,
      documentMarkdown: immutable.documentMarkdown,
      graph: immutable.graph,
      assets: [...revisionAssets],
      personas: [...revisionPersonas],
    };
  };

  return {
    loadCurrentSnapshot: (projectId, designId) => load(projectId, designId, 'current'),
    loadRevisionSnapshot: (projectId, designId, revision) => load(projectId, designId, revision),
  };
}

export type DesignFilesWorktreeLookup = Pick<DesignWorktreeStore, 'getActiveByDesign'>;

export interface DesignFilesTargetResolverDeps {
  projectLookup(projectId: number): MaybePromise<Project | null | undefined>;
  worktreeLookup: DesignFilesWorktreeLookup;
  driverForProject(project: Project): DesignFilesDriver;
}

export function createDesignFilesTargetResolver(
  deps: DesignFilesTargetResolverDeps,
): (projectId: number, designId: number) => Promise<DesignFilesTarget> {
  return async (projectId, designId) => {
    const project = await deps.projectLookup(projectId);
    if (!project || project.id !== projectId) {
      throw new DesignFilesError('TARGET_INVALID', 'Design projection project target is unavailable.');
    }
    const driver = deps.driverForProject(project);
    const run = deps.worktreeLookup.getActiveByDesign(projectId, designId);
    if (run?.assignmentActive) {
      if (run.projectId !== projectId
        || run.designId !== designId
        || run.executionMode !== 'worktree'
        || run.lifecycleState !== 'executing'
        || run.errorCode !== null
        || !run.worktreeCwd
        || !run.worktreeBranch
        || !run.observedHeadSha) {
        throw new DesignFilesError('TARGET_INVALID', 'The active design worktree requires recovery.');
      }
      return {
        driver,
        cwd: run.worktreeCwd,
        kind: 'design_worktree',
        stableKey: `design-worktree:${run.id}`,
      };
    }
    return { driver, cwd: project.cwd, kind: 'project', stableKey: `project:${project.id}` };
  };
}

export interface CreateDesignFilesServiceInput extends DesignFilesTargetResolverDeps {
  store: DesignFilesSnapshotStore;
  assets?: DesignProjectionAssets;
  personas?: DesignProjectionPersonas;
  mutex: KeyedMutex;
  conflictSecret: string | Uint8Array;
  now?: () => number;
}

/** Composition boundary used by later server wiring; the caller must provide the shared Git mutex. */
export function createDesignFilesService(input: CreateDesignFilesServiceInput): DesignFilesService {
  const snapshots = createDesignFilesSnapshotAccess(input);
  const deps: DesignFilesServiceDeps = {
    mutex: input.mutex,
    loadCurrentSnapshot: snapshots.loadCurrentSnapshot,
    loadRevisionSnapshot: snapshots.loadRevisionSnapshot,
    resolveTarget: createDesignFilesTargetResolver(input),
    conflictSecret: input.conflictSecret,
    ...(input.now ? { now: input.now } : {}),
  };
  return new DesignFilesService(deps);
}

import type { DesignFilesSnapshotStore } from '../../designs/files-adapter';
import {
  DesignFilesError,
  type DesignFileDiffItem,
  type DesignFilesDiffResult,
  type PublishDesignFilesInput,
} from '../../designs/files';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export interface DesignFilesRouteService {
  diff(input: PublishDesignFilesInput): Promise<DesignFilesDiffResult>;
  publish(input: PublishDesignFilesInput): Promise<{
    status: 'published' | 'noop' | 'local_changes';
    revision: number;
    targetKind: 'project' | 'design_worktree';
    bundleSha256: string;
  }>;
}

export interface DesignFilesRoutesDeps {
  store: Pick<DesignFilesSnapshotStore, 'getTask' | 'isTaskProvisional'>;
  service: DesignFilesRouteService;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function queryRevision(url: URL): number | null {
  const keys = [...url.searchParams.keys()];
  const values = url.searchParams.getAll('expectedRevision');
  if (keys.length !== 1 || keys[0] !== 'expectedRevision' || values.length !== 1) return null;
  const raw = values[0]!;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  return positiveInteger(Number(raw));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function signedToken(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64 * 1024
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

async function publishInput(req: Request, projectId: number, designId: number): Promise<PublishDesignFilesInput | null> {
  const body = await req.json().catch(() => null);
  if (!isRecord(body)) return null;
  const keys = Object.keys(body);
  if (keys.some((key) => !['expectedRevision', 'resolution', 'conflictToken'].includes(key))) return null;
  const expectedRevision = positiveInteger(body.expectedRevision);
  if (expectedRevision === null) return null;
  if (body.resolution === undefined && body.conflictToken === undefined) {
    return { projectId, designId, expectedRevision };
  }
  if (body.resolution !== 'overwrite' || !signedToken(body.conflictToken)) return null;
  return {
    projectId,
    designId,
    expectedRevision,
    resolution: 'overwrite',
    conflictToken: body.conflictToken,
  };
}

function validProjectionPath(path: string): boolean {
  return path === 'DESIGN.md'
    || path === 'issue-graph.json'
    || path === 'manifest.json'
    || /^assets\/[1-9]\d*-[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(path);
}

function diffItemView(item: DesignFileDiffItem): DesignFileDiffItem {
  if (!validProjectionPath(item.path)) {
    throw new DesignFilesError('UNSAFE_PATH', 'Design projection returned an unsafe relative path.');
  }
  return {
    path: item.path,
    classification: item.classification,
    baseSha256: item.baseSha256,
    localSha256: item.localSha256,
    incomingSha256: item.incomingSha256,
    baseBytes: item.baseBytes,
    localBytes: item.localBytes,
    incomingBytes: item.incomingBytes,
    ...(item.baseText === undefined ? {} : { baseText: item.baseText }),
    ...(item.localText === undefined ? {} : { localText: item.localText }),
    ...(item.incomingText === undefined ? {} : { incomingText: item.incomingText }),
  };
}

function diffView(diff: DesignFilesDiffResult): DesignFilesDiffResult {
  return {
    projectId: diff.projectId,
    designId: diff.designId,
    revision: diff.revision,
    targetKind: diff.targetKind,
    files: diff.files.map(diffItemView),
    ...(diff.conflictToken === undefined ? {} : { conflictToken: diff.conflictToken }),
  };
}

function invalidRequest(): Response {
  return json(apiError(
    'design.files_invalid_request',
    'The design file request is invalid.',
    400,
  ), 400);
}

function notFound(): Response {
  return json(apiError(
    'design.not_found',
    'The design does not exist in this project.',
    404,
  ), 404);
}

function errorResponse(error: unknown, currentRevision?: number, diff?: DesignFilesDiffResult): Response {
  if (!(error instanceof DesignFilesError)) {
    return json(apiError(
      'design.files_publish_failed',
      'The design files operation could not be completed.',
      500,
    ), 500);
  }
  const mapped: Record<DesignFilesError['code'], { status: number; code: string; fallback: string }> = {
    INVALID_REQUEST: { status: 400, code: 'design.files_invalid_request', fallback: 'The design file request is invalid.' },
    REVISION_CONFLICT: { status: 409, code: 'design.files_revision_conflict', fallback: 'The design revision changed. Refresh and try again.' },
    SNAPSHOT_NOT_FOUND: { status: 404, code: 'design.not_found', fallback: 'The design does not exist in this project.' },
    TARGET_INVALID: { status: 409, code: 'design.files_target_unavailable', fallback: 'The design file target is unavailable or requires recovery.' },
    REPO_UNAVAILABLE: { status: 502, code: 'design.files_repo_unavailable', fallback: 'The design repository is unavailable.' },
    UNSAFE_PATH: { status: 409, code: 'design.files_unsafe_projection', fallback: 'The design projection contains an unsafe path.' },
    ASSET_INVALID: { status: 409, code: 'design.files_asset_invalid', fallback: 'A design asset is invalid.' },
    MANIFEST_INVALID: { status: 409, code: 'design.files_manifest_invalid', fallback: 'The design file manifest is invalid.' },
    EXTERNAL_CHANGE: { status: 409, code: 'design.files_external_change', fallback: 'The design projection has external changes.' },
    CONFLICT_STALE: { status: 409, code: 'design.files_conflict_stale', fallback: 'The design file conflict changed. Refresh and try again.' },
    WRITE_FAILED: { status: 502, code: 'design.files_publish_failed', fallback: 'The design files could not be published.' },
  };
  const value = mapped[error.code];
  return json({
    ...apiError(
      value.code,
      value.fallback,
      value.status,
      error.code === 'REVISION_CONFLICT' && currentRevision !== undefined ? { currentRevision } : {},
    ),
    ...(diff === undefined ? {} : { diff: diffView(diff) }),
  }, value.status);
}

function scopedDesign(deps: DesignFilesRoutesDeps, projectId: number, designId: number) {
  const design = deps.store.getTask(designId);
  return design
    && design.projectId === projectId
    && !deps.store.isTaskProvisional(designId)
    ? design
    : null;
}

export function designFilesRoutes(deps: DesignFilesRoutesDeps): RouteDef[] {
  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/designs/:designId/file-diff',
      auth: 'project-access',
      handler: async ({ params, url }) => {
        const projectId = positiveInteger(Number(params.projectId));
        const designId = positiveInteger(Number(params.designId));
        const expectedRevision = queryRevision(url);
        if (projectId === null || designId === null || expectedRevision === null) return invalidRequest();
        const design = scopedDesign(deps, projectId, designId);
        if (!design) return notFound();
        try {
          const diff = diffView(await deps.service.diff({ projectId, designId, expectedRevision }));
          return json({ ok: true, diff });
        } catch (error) {
          return errorResponse(error, deps.store.getTask(designId)?.currentRevision);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/designs/:designId/publish-files',
      auth: 'project-owner',
      handler: async ({ req, params }) => {
        const projectId = positiveInteger(Number(params.projectId));
        const designId = positiveInteger(Number(params.designId));
        if (projectId === null || designId === null) return invalidRequest();
        const design = scopedDesign(deps, projectId, designId);
        if (!design) return notFound();
        const input = await publishInput(req, projectId, designId);
        if (!input) return invalidRequest();
        try {
          const result = await deps.service.publish(input);
          return json({
            ok: true,
            publication: {
              status: result.status,
              revision: result.revision,
              targetKind: result.targetKind,
              bundleSha256: result.bundleSha256,
            },
          });
        } catch (error) {
          if (error instanceof DesignFilesError && error.code === 'EXTERNAL_CHANGE') {
            try {
              const diff = await deps.service.diff({ projectId, designId, expectedRevision: input.expectedRevision });
              return errorResponse(error, deps.store.getTask(designId)?.currentRevision, diff);
            } catch (diffError) {
              return errorResponse(diffError, deps.store.getTask(designId)?.currentRevision);
            }
          }
          return errorResponse(error, deps.store.getTask(designId)?.currentRevision);
        }
      },
    },
  ];
}

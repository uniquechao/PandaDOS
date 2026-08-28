import type { Database } from 'bun:sqlite';
import {
  DesignWorktreeError,
  type CreateDesignWorktreeInput,
  type DesignExecutionRun,
  type DesignWorktreeActor,
  type DesignWorktreeMutationInput,
} from '../../designs/worktree';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export interface DesignWorktreeRouteService {
  getRun(projectId: number, designId: number): DesignExecutionRun | null;
  create(input: CreateDesignWorktreeInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun>;
  inspect(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun>;
  execute(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun>;
  archive(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun>;
  clean(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun>;
}

export interface DesignWorktreeRoutesDeps {
  db: Database;
  service: DesignWorktreeRouteService;
  /** Post-transition scheduler kick; idempotent execute replays invoke it again. */
  onExecuted?: (run: DesignExecutionRun) => Promise<void> | void;
}

function pathId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function strictObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null;
}

function exactKeys(body: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(body, key))
    && Object.keys(body).every((key) => allowed.has(key));
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function digest(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function key(value: string | null): string | null {
  return value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function inScope(db: Database, projectId: number, designId: number): boolean {
  return !!db.query<{ ok: number }, [number, number]>(
    'SELECT 1 AS ok FROM design_tasks WHERE id = ? AND project_id = ?',
  ).get(designId, projectId);
}

function actor(userId: number): DesignWorktreeActor {
  return { userId, actorKey: `user:${userId}` };
}

export function designWorktreeDto(run: DesignExecutionRun) {
  return {
    id: run.id,
    projectId: run.projectId,
    designId: run.designId,
    publicationId: run.publicationId,
    revision: run.revision,
    graphDigest: run.graphDigest,
    executionMode: run.executionMode,
    lifecycleState: run.lifecycleState,
    assignmentActive: run.assignmentActive,
    baseRef: run.baseRef,
    baseSha: run.baseSha,
    worktreeBranch: run.worktreeBranch,
    observedHeadSha: run.observedHeadSha,
    observedUpstream: run.observedUpstream,
    observedAhead: run.observedAhead,
    observedBehind: run.observedBehind,
    errorCode: run.errorCode,
    createdTs: run.createdTs,
    updatedTs: run.updatedTs,
    archivedTs: run.archivedTs,
    cleanedTs: run.cleanedTs,
  };
}

function failure(error: unknown): Response {
  if (!(error instanceof DesignWorktreeError)) {
    return json(apiError('design.operation_failed', 'The design operation could not be completed.', 500), 500);
  }
  const invalid = new Set(['INVALID_REQUEST', 'BASE_INVALID']);
  const missing = new Set(['PROJECT_NOT_FOUND', 'RUN_NOT_FOUND']);
  const forbidden = error.code === 'FORBIDDEN';
  const status = invalid.has(error.code) ? 400 : missing.has(error.code) ? 404 : forbidden ? 403 : 409;
  const code = status === 404 ? 'design.not_found'
    : status === 403 ? 'design.forbidden'
      : status === 400 ? 'design.invalid_request' : 'design.stage_conflict';
  return json(apiError(code, status === 409
    ? 'The execution workspace is not available in its current state.'
    : 'The design worktree request could not be completed.', status), status);
}

export function designWorktreeRoutes(deps: DesignWorktreeRoutesDeps): RouteDef[] {
  const prefix = '/api/projects/:projectId/designs/:designId/worktree';
  const scoped = (params: Record<string, string>) => {
    const projectId = pathId(params.projectId);
    const designId = pathId(params.designId);
    return projectId && designId && inScope(deps.db, projectId, designId) ? { projectId, designId } : null;
  };
  const mutate = (method: 'inspect' | 'execute' | 'archive' | 'clean'): RouteDef => ({
    method: 'POST', path: `${prefix}/${method}`, auth: 'project-owner',
    async handler({ req, params, user }) {
      const ids = scoped(params);
      if (!ids || !user) return json(apiError('design.not_found', 'The design does not exist in this project.', 404), 404);
      const body = strictObject(await req.json().catch(() => null));
      if (!body || !exactKeys(body, ['publicationId', 'expectedRevision', 'graphDigest'])) {
        return json(apiError('design.invalid_request', 'The design request is invalid.', 400), 400);
      }
      const publicationId = positiveInt(body.publicationId);
      const revision = positiveInt(body.expectedRevision);
      const graphDigest = digest(body.graphDigest);
      const run = deps.service.getRun(ids.projectId, ids.designId);
      if (!publicationId || !revision || !graphDigest || !run
        || run.publicationId !== publicationId || run.revision !== revision || run.graphDigest !== graphDigest) {
        return json(apiError('design.revision_conflict', 'The design changed. Refresh it and try again.', 409), 409);
      }
      try {
        const run = await deps.service[method](
          { ...ids, publicationId }, actor(user.id),
        );
        if (method === 'execute') await deps.onExecuted?.(run);
        return json({ worktree: designWorktreeDto(run) });
      } catch (error) { return failure(error); }
    },
  });
  return [
    {
      method: 'GET', path: prefix, auth: 'project-access',
      handler({ params }) {
        const ids = scoped(params);
        if (!ids) return json(apiError('design.not_found', 'The design does not exist in this project.', 404), 404);
        const run = deps.service.getRun(ids.projectId, ids.designId);
        return json({ worktree: run ? designWorktreeDto(run) : null });
      },
    },
    {
      method: 'POST', path: prefix, auth: 'project-owner',
      async handler({ req, params, user }) {
        const ids = scoped(params);
        if (!ids || !user) return json(apiError('design.not_found', 'The design does not exist in this project.', 404), 404);
        const body = strictObject(await req.json().catch(() => null));
        if (!body || !exactKeys(body, ['expectedRevision', 'graphDigest', 'executionMode'], ['baseRef'])) {
          return json(apiError('design.invalid_request', 'The design request is invalid.', 400), 400);
        }
        const revision = positiveInt(body.expectedRevision);
        const graphDigest = digest(body.graphDigest);
        const mode = body.executionMode === 'current' || body.executionMode === 'worktree' ? body.executionMode : null;
        const baseRef = typeof body.baseRef === 'string' ? body.baseRef : undefined;
        const idempotencyKey = key(req.headers.get('Idempotency-Key'));
        if (!revision || !graphDigest || !mode || !idempotencyKey
          || (mode === 'worktree' && !baseRef) || (mode === 'current' && baseRef !== undefined)) {
          return json(apiError('design.invalid_request', 'The design request is invalid.', 400), 400);
        }
        try {
          const worktree = await deps.service.create({
            ...ids, revision, graphDigest, executionMode: mode, idempotencyKey,
            ...(baseRef === undefined ? {} : { baseRef }),
          }, actor(user.id));
          return json({ worktree: designWorktreeDto(worktree) }, 201);
        } catch (error) { return failure(error); }
      },
    },
    mutate('inspect'), mutate('execute'), mutate('archive'), mutate('clean'),
  ];
}

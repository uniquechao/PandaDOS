import type { DesignRunCoordinator, DesignRunView, StartDesignRunInput } from '../../designs/run-coordinator';
import { DesignRunCoordinatorError } from '../../designs/run-coordinator';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

const ID_RE = /^[1-9]\d{0,15}$/;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MODES = new Set(['goal', 'solution', 'review', 'graph']);

type DesignRunService = Pick<DesignRunCoordinator, 'start' | 'getScoped' | 'cancel'>;

export interface DesignRunRoutesDeps {
  coordinator: DesignRunService;
}

function canonicalId(value: string | undefined): number | null {
  if (!value || !ID_RE.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function canonicalRunId(value: string | undefined): string | null {
  return value && RUN_ID_RE.test(value) ? value : null;
}

async function objectBody(req: Request): Promise<Record<string, unknown> | null> {
  const parsed = await req.json().catch(() => null);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function invalid(): Response {
  return json(apiError('design.run_invalid', 'The design run request is invalid.', 400), 400);
}

function runError(error: unknown): Response {
  if (!(error instanceof DesignRunCoordinatorError)) {
    return json(apiError('design.run_operation_failed', 'The design run operation could not be completed.', 500), 500);
  }
  const mapped: Record<string, { status: number; code: string; fallback: string }> = {
    DESIGN_RUN_NOT_FOUND: { status: 404, code: 'design.run_not_found', fallback: 'The design run does not exist in this project.' },
    DESIGN_RUN_FORBIDDEN: { status: 403, code: 'design.run_forbidden', fallback: 'You cannot manage this design run.' },
    DESIGN_RUN_INVALID: { status: 400, code: 'design.run_invalid', fallback: 'The design run request is invalid.' },
    DESIGN_RUN_STALE: { status: 409, code: 'design.run_stale', fallback: 'The design changed. Refresh and try again.' },
    DESIGN_RUN_IDEMPOTENCY_CONFLICT: { status: 409, code: 'design.run_idempotency_conflict', fallback: 'This idempotency key was already used for a different request.' },
    DESIGN_RUN_NOT_ACTIONABLE: { status: 409, code: 'design.run_not_actionable', fallback: 'The design run cannot perform that action in its current state.' },
    DESIGN_RUN_FAILED: { status: 503, code: 'design.run_operation_failed', fallback: 'The design run operation could not be completed.' },
  };
  const value = mapped[error.code] ?? mapped.DESIGN_RUN_FAILED!;
  return json(apiError(value.code, value.fallback, value.status,
    error.code === 'DESIGN_RUN_STALE' && error.currentRevision
      ? { currentRevision: error.currentRevision }
      : undefined), value.status);
}

function startInput(value: Record<string, unknown>, req: Request, actorUserId: number): StartDesignRunInput | null {
  if (!exactKeys(value, ['expectedRevision', 'mode', 'message', 'personas'], ['expectedRevision', 'mode'])
    || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) <= 0
    || typeof value.mode !== 'string' || !MODES.has(value.mode)
    || (value.message !== undefined && (typeof value.message !== 'string' || value.message.length > 8_000))
    || (value.personas !== undefined && (!Array.isArray(value.personas)
      || value.personas.length > 10
      || value.personas.some((persona) => typeof persona !== 'string' || !persona || persona.length > 160)))) return null;
  const idempotencyKey = req.headers.get('idempotency-key');
  if (!idempotencyKey || !IDEMPOTENCY_RE.test(idempotencyKey)) return null;
  return {
    expectedRevision: value.expectedRevision as number,
    mode: value.mode as StartDesignRunInput['mode'],
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(Array.isArray(value.personas) ? { personas: value.personas as string[] } : {}),
    idempotencyKey,
    actorUserId,
  };
}

export function designRunRoutes(deps: DesignRunRoutesDeps): RouteDef[] {
  return [
    {
      method: 'POST', path: '/api/projects/:projectId/designs/:designId/runs', auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const projectId = canonicalId(params.projectId);
        const designId = canonicalId(params.designId);
        const value = await objectBody(req);
        if (!projectId || !designId || !value || !user) return invalid();
        const input = startInput(value, req, user.id);
        if (!input) return invalid();
        try {
          const run = deps.coordinator.start(projectId, designId, input);
          return json({ run }, 202);
        } catch (error) {
          return runError(error);
        }
      },
    },
    {
      method: 'GET', path: '/api/projects/:projectId/designs/:designId/runs/:runId', auth: 'project-access',
      handler: ({ params }) => {
        const projectId = canonicalId(params.projectId);
        const designId = canonicalId(params.designId);
        const runId = canonicalRunId(params.runId);
        if (!projectId || !designId || !runId) return invalid();
        try {
          return json({ run: deps.coordinator.getScoped(projectId, designId, runId) });
        } catch (error) {
          return runError(error);
        }
      },
    },
    {
      method: 'POST', path: '/api/projects/:projectId/designs/:designId/runs/:runId/cancel', auth: 'project-owner',
      handler: async ({ req, params }) => {
        const projectId = canonicalId(params.projectId);
        const designId = canonicalId(params.designId);
        const runId = canonicalRunId(params.runId);
        const value = await objectBody(req);
        if (!projectId || !designId || !runId || !value
          || !exactKeys(value, ['expectedRevision'], ['expectedRevision'])
          || !Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) <= 0) return invalid();
        try {
          return json({ run: deps.coordinator.cancel(
            projectId, designId, runId, value.expectedRevision as number,
          ) });
        } catch (error) {
          return runError(error);
        }
      },
    },
  ];
}

export type { DesignRunView };

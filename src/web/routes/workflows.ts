/** 项目级工作流模板 CRUD、复制、不可变版本发布与图结构校验。 */
import type { Database } from 'bun:sqlite';
import type { AgentKind } from '../../core/types';
import {
  MAX_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_WORKFLOW_NAME_LENGTH,
  WorkflowTemplateStore,
  validateWorkflowGraph,
  type WorkflowValidationIssue,
} from '../../issues/workflows';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export interface WorkflowsRoutesDeps {
  db: Database;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => null);
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function id(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function supportedProjectAgents(db: Database, projectId: number): AgentKind[] {
  const row = db
    .query<{ supports_claude: number; supports_codex: number }, [number]>(
      `SELECT e.supports_claude, e.supports_codex
       FROM projects p JOIN executors e ON e.id = p.executor_id
       WHERE p.id = ?`,
    )
    .get(projectId);
  if (!row) return [];
  return [
    ...(row.supports_claude === 1 ? (['claude'] as const) : []),
    ...(row.supports_codex === 1 ? (['codex'] as const) : []),
  ];
}

function nameOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= MAX_WORKFLOW_NAME_LENGTH ? name : null;
}

function descriptionOf(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const description = value.trim();
  return description.length <= MAX_WORKFLOW_DESCRIPTION_LENGTH ? description || null : undefined;
}

function graphError(issues: WorkflowValidationIssue[]): Response {
  return json(
    apiError(
      'workflow.graph_invalid',
      'The workflow graph is invalid. Fix the marked structure issues.',
      400,
      { count: issues.length },
      { issues },
    ),
    400,
  );
}

function nameConflict(error: unknown): boolean {
  return String(error).includes('UNIQUE constraint failed: project_workflow_templates.project_id, project_workflow_templates.name');
}

function technicalFailure(error: unknown): Response {
  return json(
    apiError('workflow.save_failed', 'The workflow template could not be saved.', 500, {}, String(error).slice(0, 500)),
    500,
  );
}

export function workflowsRoutes(deps: WorkflowsRoutesDeps): RouteDef[] {
  const store = new WorkflowTemplateStore(deps.db);
  const validate = (projectId: number, graph: unknown) =>
    validateWorkflowGraph(graph, supportedProjectAgents(deps.db, projectId));

  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/workflows',
      auth: 'project-access',
      handler: ({ params }) => {
        const projectId = id(params.projectId);
        if (!projectId) return json(apiError('project.required', '缺少项目 ID。', 400), 400);
        return json({ ok: true, workflows: store.list(projectId) });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/workflows/validate',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const projectId = id(params.projectId);
        if (!projectId) return json(apiError('project.required', '缺少项目 ID。', 400), 400);
        const body = await readBody(req);
        const result = validate(projectId, body.graph);
        return result.ok
          ? json({ ok: true, graph: result.graph, graphHash: result.graphHash })
          : graphError(result.issues);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/workflows',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const projectId = id(params.projectId);
        if (!projectId) return json(apiError('project.required', '缺少项目 ID。', 400), 400);
        const body = await readBody(req);
        const name = nameOf(body.name);
        if (!name) {
          return json(
            apiError(
              'workflow.name_invalid',
              `The workflow name is required and cannot exceed ${MAX_WORKFLOW_NAME_LENGTH} characters.`,
              400,
              { max: MAX_WORKFLOW_NAME_LENGTH },
            ),
            400,
          );
        }
        const description = descriptionOf(body.description);
        if (body.description !== undefined && description === undefined) {
          return json(
            apiError(
              'workflow.description_invalid',
              `The workflow description cannot exceed ${MAX_WORKFLOW_DESCRIPTION_LENGTH} characters.`,
              400,
              { max: MAX_WORKFLOW_DESCRIPTION_LENGTH },
            ),
            400,
          );
        }
        const graph = validate(projectId, body.graph);
        if (!graph.ok) return graphError(graph.issues);
        try {
          return json({
            ok: true,
            workflow: store.create({
              projectId,
              name,
              description: description ?? null,
              graph: graph.graph,
              graphJson: graph.graphJson,
              graphHash: graph.graphHash,
              createdBy: user!.id,
            }),
          });
        } catch (error) {
          return nameConflict(error)
            ? json(apiError('workflow.name_conflict', 'A workflow template with this name already exists.', 409), 409)
            : technicalFailure(error);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/workflows/:workflowId',
      auth: 'project-access',
      handler: ({ params }) => {
        const projectId = id(params.projectId);
        const workflowId = id(params.workflowId);
        if (!projectId || !workflowId) {
          return json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        }
        const workflow = store.get(projectId, workflowId);
        return workflow
          ? json({ ok: true, workflow })
          : json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/workflows/:workflowId/copy',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const projectId = id(params.projectId);
        const workflowId = id(params.workflowId);
        if (!projectId || !workflowId) {
          return json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        }
        const body = await readBody(req);
        const name = nameOf(body.name);
        if (!name) {
          return json(apiError('workflow.name_invalid', 'Enter a valid name for the workflow copy.', 400), 400);
        }
        try {
          const workflow = store.copy(projectId, workflowId, name, user!.id);
          return workflow
            ? json({ ok: true, workflow })
            : json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        } catch (error) {
          return nameConflict(error)
            ? json(apiError('workflow.name_conflict', 'A workflow template with this name already exists.', 409), 409)
            : technicalFailure(error);
        }
      },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId/workflows/:workflowId',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const projectId = id(params.projectId);
        const workflowId = id(params.workflowId);
        if (!projectId || !workflowId) {
          return json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        }
        const body = await readBody(req);
        const patch: { name?: string; description?: string | null; status?: 'active' | 'archived' } = {};
        if ('name' in body) {
          const name = nameOf(body.name);
          if (!name) return json(apiError('workflow.name_invalid', 'Enter a valid workflow template name.', 400), 400);
          patch.name = name;
        }
        if ('description' in body) {
          const description = descriptionOf(body.description);
          if (description === undefined) {
            return json(apiError('workflow.description_invalid', 'The workflow description is invalid.', 400), 400);
          }
          patch.description = description;
        }
        if ('status' in body) {
          if (body.status !== 'active' && body.status !== 'archived') {
            return json(apiError('workflow.status_invalid', 'The workflow status is invalid.', 400), 400);
          }
          patch.status = body.status;
        }
        if (!Object.keys(patch).length) {
          return json(apiError('workflow.patch_required', 'There are no workflow details to save.', 400), 400);
        }
        try {
          const workflow = store.rename(projectId, workflowId, patch);
          return workflow
            ? json({ ok: true, workflow })
            : json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        } catch (error) {
          return nameConflict(error)
            ? json(apiError('workflow.name_conflict', 'A workflow template with this name already exists.', 409), 409)
            : technicalFailure(error);
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/projects/:projectId/workflows/:workflowId',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const projectId = id(params.projectId);
        const workflowId = id(params.workflowId);
        if (!projectId || !workflowId) {
          return json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        }
        const body = await readBody(req);
        const graph = validate(projectId, body.graph);
        if (!graph.ok) return graphError(graph.issues);
        try {
          const workflow = store.publish(
            projectId,
            workflowId,
            graph.graph,
            graph.graphJson,
            graph.graphHash,
            user!.id,
          );
          return workflow
            ? json({ ok: true, workflow })
            : json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        } catch (error) {
          return technicalFailure(error);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId/workflows/:workflowId',
      auth: 'project-access',
      handler: ({ params }) => {
        const projectId = id(params.projectId);
        const workflowId = id(params.workflowId);
        if (!projectId || !workflowId || !store.delete(projectId, workflowId)) {
          return json(apiError('workflow.not_found', 'The workflow template does not exist.', 404), 404);
        }
        return json({ ok: true, deleted: true });
      },
    },
  ];
}

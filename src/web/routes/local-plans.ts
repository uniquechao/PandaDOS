import type { LocalPlanService } from '../local-plans';
import { LocalPlanError } from '../local-plans';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

export function localPlansRoutes(service: LocalPlanService): RouteDef[] {
  const handle = async (action: () => Promise<unknown>): Promise<Response> => {
    try { return json(await action()); }
    catch (error) {
      const reason = error instanceof LocalPlanError ? error : new LocalPlanError('unavailable', String(error));
      const status = reason.code === 'forbidden' ? 403 : reason.code === 'not_found' ? 404
        : reason.code === 'changed' || reason.code === 'published' ? 409 : reason.code === 'invalid' ? 400 : 503;
      return json(apiError(`local_plans.${reason.code}`, 'Could not read or execute the local issue plan.', status, reason.refresh ? { refresh: true } : {}, reason.details), status);
    }
  };
  return [
    { method: 'GET', path: '/api/projects/:projectId/local-plans', auth: 'project-access',
      handler: ({ req, params, user }) => handle(() => {
        const query = new URL(req.url).searchParams;
        return service.list(Number(params.projectId), user!.id, { page: Number(query.get('page')),
          pageSize: Number(query.get('pageSize')), q: query.get('q') ?? '', status: query.get('status') ?? '' });
      }) },
    { method: 'POST', path: '/api/projects/:projectId/local-plans/refresh', auth: 'project-access',
      handler: ({ params, user }) => handle(async () => {
        await service.refresh(Number(params.projectId), user!.id);
        return { ok: true };
      }) },
    { method: 'GET', path: '/api/projects/:projectId/local-plans/detail', auth: 'project-access',
      handler: ({ req, params, user }) => handle(() => service.detail(Number(params.projectId), user!.id,
        new URL(req.url).searchParams.get('id') ?? '')) },
    { method: 'POST', path: '/api/projects/:projectId/local-plans/execute', auth: 'project-access',
      handler: ({ req, params, user }) => handle(async () => {
        const body = await req.json().catch(() => null);
        if (!body || typeof body.path !== 'string' || typeof body.planId !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(body.planId)
          || typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest)) {
          throw new LocalPlanError('invalid', 'Expected path, planId and the preview SHA-256 digest');
        }
        return { execution: await service.execute(Number(params.projectId), user!.id, body) };
      }) },
  ];
}

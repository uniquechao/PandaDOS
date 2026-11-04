import type { AgentModelSettings } from '../../core/agent-model-settings';
import type { AgentModelSelection } from '../../../shared/agent-models';
import { json, type RouteDef } from '../middleware';
async function readBody(req: Request): Promise<Record<string, unknown>> {
  try { const body = await req.json(); return body && typeof body === 'object' && !Array.isArray(body) ? body : {}; }
  catch { return {}; }
}
import { apiError } from '../errors';

export function agentModelsRoutes(service: AgentModelSettings): RouteDef[] {
  return (['issue','conversation'] as const).flatMap(kind => {
    const base = `/api/projects/:projectId/${kind === 'issue' ? 'issues/:issueId' : 'conversations/:convId'}`;
    const target = (params: Record<string,string | undefined>) => service.target(kind,params[kind === 'issue' ? 'issueId' : 'convId'] ?? '',Number(params.projectId));
    const failure = (error: unknown) => {
      const code = error instanceof Error ? error.message : 'model_operation_failed';
      const status = code === 'model_target_unavailable' ? 404 : code === 'model_selection_invalid' ? 400 : code === 'model_settings_conflict' || code === 'model_target_changed' ? 409 : 502;
      return json(apiError(`agent_models.${code}`, '模型设置操作未完成，请刷新后重试。', status),status);
    };
    return [
      { method:'GET',path:`${base}/model-options`,auth:'project-access',handler:async ({params}) => {
        try { return json({ ok:true,catalog:await service.catalog(target(params)) }); } catch(error) { return failure(error); }
      } },
      { method:'GET',path:`${base}/model-settings`,auth:'project-access',handler:async ({params}) => {
        try { return json({ ok:true,...service.state(target(params)) }); } catch(error) { return failure(error); }
      } },
      { method:'PATCH',path:`${base}/model-settings`,auth:'project-access',handler:async ({params,req}) => {
        try {
          const body=await readBody(req);
          if (!Number.isSafeInteger(body.revision) || Number(body.revision)<0 || typeof body.model !== 'string' || body.effort !== null && typeof body.effort !== 'string') throw new Error('model_selection_invalid');
          return json({ ok:true,...await service.save(target(params),{ model:body.model,effort:body.effort } as AgentModelSelection,Number(body.revision)) });
        } catch(error) { return failure(error); }
      } },
    ] as RouteDef[];
  });
}

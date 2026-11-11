import type { IssueEngine } from '../../issues/engine';
import type { IssueIncidentService } from '../issue-incidents';
import { parseIssueId } from '../../../shared/issue-id';
import { SUPPORTED_LOCALES } from '../../../shared/i18n/locales';
import { redactDiagnostic } from '../../../shared/issue-diagnostics';
import { json, type RouteDef } from '../middleware';
import { apiError } from '../errors';

export function issueIncidentRoutes(engine: IssueEngine, service: IssueIncidentService): RouteDef[] {
  const base='/api/projects/:projectId/issues/:issueId/incidents';
  return [
    ['POST',`${base}/open`,'open'],
    ['GET',`${base}/:incidentId`,'view'],
    ['POST',`${base}/:incidentId/messages`,'send'],
    ['POST',`${base}/:incidentId/refresh`,'refresh'],
    ['POST',`${base}/:incidentId/stop`,'stop'],
    ['POST',`${base}/:incidentId/actions`,'action'],
    ['POST',`${base}/:incidentId/resolve-and-resume`,'resolve'],
  ].map(([method,path,action])=>({method:method as 'GET'|'POST',path,auth:'project-access' as const,
    handler:async({req,params,user})=>{
      const issueId=parseIssueId(params.issueId);const issue=issueId ? engine.store.get(issueId) : null;
      if(!issue || issue.projectId!==Number(params.projectId))return json({ok:false,error:'incident_not_found'},404);
      const id=params.incidentId ?? '';
      // Validate incident ownership before accepting any content or action.
      try {
        if(action!=='open')service.view(issue.id,id);
        const b=method==='GET' ? {} : await req.json().catch(()=>({}));
        if(!b || typeof b!=='object')return json({ok:false,error:'incident_invalid_request'},400);
        const key=typeof b.key==='string' ? b.key : '';
        if(!['open','view','stop'].includes(action) && (!key || key.length>100))return json({ok:false,error:'incident_invalid_request'},400);
        if(action==='open')return json({...await service.open(issue.id,user!.id,SUPPORTED_LOCALES.includes(b.locale) ? b.locale : 'en'),viewerUserId:user!.id});
        if(action==='view')return json({...service.view(issue.id,id),viewerUserId:user!.id});
        if(action==='stop')return json(await service.stopTurn(issue.id,id));
        if(action==='resolve')return json(await service.resolve(issue.id,id,key,typeof b.guidance==='string' ? b.guidance : '',user!.id));
        if(action==='action') {
          if(!['branch','environment','verify'].includes(b.kind) || typeof b.sha!=='string')return json({ok:false,error:'incident_invalid_request'},400);
          return json(await service.action(issue.id,id,key,b.kind,b.sha,user!.id));
        }
        return json(await service.send(issue.id,id,key,action==='refresh' ? 'Recheck the current workspace and evidence. Explain what is still unresolved.' : typeof b.content==='string' ? b.content : '',user!.id));
      } catch(error) {
        const reason=redactDiagnostic(error instanceof Error ? error.message : String(error));
        return json(apiError(reason==='incident_busy' ? 'incident.busy' : 'incident.operation_failed','The fault conversation operation could not be completed. Check the current state and try again.',409,{},reason),reason==='incident_not_found' ? 404 : 409);
      }
    },
  }));
}

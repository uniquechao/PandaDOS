import type { Database } from 'bun:sqlite';
import type { IndependentTextRunner } from '../core/independent-text';
import type { ExecutorDriver } from '../executor/driver';
import { LocalDriver } from '../executor/local';
import { getProject, type IssueEngine } from '../issues/engine';
import { RoomLocalCliRuntime } from '../rooms/local-cli';
import { redactDiagnosticValue, diagnosticData } from '../../shared/issue-diagnostics';
import { IssueIncidentService } from './issue-incidents';
import { failureTail } from '../issues/validation';

/** Composition only: issue domain depends on a neutral text port, never on room domain. */
export function createIssueIncidentService(db: Database, engine: IssueEngine, driverForProject: (p:NonNullable<ReturnType<typeof getProject>>)=>ExecutorDriver,
  stateDir: string, acquire:(signal:AbortSignal)=>Promise<()=>void>, runner?: IndependentTextRunner) {
  const transport=new RoomLocalCliRuntime({stateDir,acquire});
  return new IssueIncidentService({engine,
    model:issueId=>{
      const issue=engine.store.get(issueId)!;const project=getProject(db,issue.projectId)!;
      // Do not silently substitute another machine/account when the bound executor is remote.
      if(!runner && !(driverForProject(project) instanceof LocalDriver))throw new Error('incident_remote_runtime_unavailable');
      const selection=db.query<{model:string;effort:string|null},[string,string,string]>(`SELECT model,effort FROM agent_model_settings WHERE agent=? AND ((target_kind='issue' AND target_id=?) OR (target_kind='conversation' AND target_id=?)) ORDER BY CASE target_kind WHEN 'issue' THEN 0 ELSE 1 END LIMIT 1`).get(issue.agent,issueId,issue.convId??'');
      const provider=transport.modelCatalog().providers.find(p=>p.provider===issue.agent);
      const model=selection?.model ?? provider?.defaultModel;
      if(!model)throw new Error('incident_model_not_configured');
      return {agent:issue.agent,model,effort:selection?.effort==='high' ? 'high' : selection?.effort==='low' ? 'low' : 'medium'};
    },
    evidence:async issueId=>{
      const issue=engine.store.get(issueId)!;const project=getProject(db,issue.projectId)!;
      const attempt=engine.incidentWorkspace(issueId);const driver=driverForProject(project);const cwd=attempt?.cwd??project.cwd;
      const stop=engine.incidentStopId(issueId);
      const preceding=engine.store.listEvents(issueId).filter(e=>e.kind==='transition' && e.id<stop).at(-1)?.id??0;
      const events=engine.store.listEvents(issueId).filter(e=>e.id>=preceding && /^(error|validation_|environment_|transition$|tests_failed$|incident_repair$|workspace_)/.test(e.kind)).slice(-20)
        .map(e=>{
          const data=diagnosticData(e);
          const selected:Record<string,unknown>={};
          for(const [key,value] of Object.entries(data)) {
            if(key==='out'||key==='err')continue;
            selected[key]=typeof value==='string' ? value.slice(0,1200) : JSON.stringify(value).length>2000 ? JSON.stringify(value).slice(0,2000) : value;
          }
          if(typeof data.out==='string'||typeof data.err==='string')selected.failureOutput=failureTail({out:data.out??'',err:data.err??''},1600);
          return {id:e.id,kind:e.kind,ts:e.ts,data:redactDiagnosticValue(selected)};
        });
      const facts:Record<string,unknown>={issue:{id:issue.id,title:issue.title,status:issue.status},stopEventId:stop,
        workspace:attempt ? {id:attempt.id,cwd:attempt.cwd,expectedBranch:attempt.branch,phase:attempt.phase,baseSha:attempt.base_sha,resultSha:attempt.result_sha,stopConfirmed:attempt.stop_confirmed} : {cwd},events};
      for(const [name,args] of [['actualBranch',['branch','--show-current']],['headSha',['rev-parse','HEAD']],['gitStatus',['status','--porcelain']]] as const) {
        try {const result=await driver.git(cwd,[...args]);facts[name]=result.code===0 ? result.out.trim().slice(0,6000) : {unavailable:result.err.slice(0,1500)};}
        catch(error){facts[name]={unavailable:String(error).slice(0,1500)};}
      }
      // Put current Git facts first so bounded context never hides them behind large history.
      return JSON.stringify(redactDiagnosticValue({headSha:facts.headSha,actualBranch:facts.actualBranch,gitStatus:facts.gitStatus,...facts}),null,2);
    },
    run:runner??((request,signal)=>transport.runIndependentText(request,signal)),
  });
}

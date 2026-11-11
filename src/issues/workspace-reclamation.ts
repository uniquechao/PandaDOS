import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { runWorkspaceReclamation, type ReclamationRequest, type ReclamationResult } from '../executor/workspace-reclamation';
import { redactDiagnostic } from '../../shared/issue-diagnostics';
import { KeyedMutex } from './mutex';
import { WorkspaceExecutionDeferred } from './workspace-deferral';

export interface WorkspaceReclamationPolicy {
 idleMs:number; minFreeBytes:number; cacheMaxBytes:number; archiveMaxBytes:number;
 archiveRetentionMs:number; retryMs:number; tickMs:number; batchSize:number;
}
export const DEFAULT_WORKSPACE_RECLAMATION_POLICY:Readonly<WorkspaceReclamationPolicy>={
 idleMs:6*60*60_000,minFreeBytes:2*1024**3,cacheMaxBytes:2*1024**3,archiveMaxBytes:4*1024**3,
 archiveRetentionMs:7*24*60*60_000,retryMs:60_000,tickMs:30_000,batchSize:8,
};
export function workspaceReclamationPolicyFromEnv(env:Record<string,string|undefined>):Partial<WorkspaceReclamationPolicy> {
 const result:Partial<WorkspaceReclamationPolicy>={};
 const names={PANDA_WORKSPACE_MIN_FREE_BYTES:'minFreeBytes',PANDA_WORKSPACE_CACHE_MAX_BYTES:'cacheMaxBytes',PANDA_WORKSPACE_ARCHIVE_MAX_BYTES:'archiveMaxBytes',PANDA_WORKSPACE_IDLE_MS:'idleMs',PANDA_WORKSPACE_ARCHIVE_RETENTION_MS:'archiveRetentionMs'} as const;
 for(const [name,key] of Object.entries(names)) {
  const raw=env[name];if(raw===undefined)continue;const n=Number(raw);
  if(!raw.trim()||!Number.isSafeInteger(n)||n<0)throw new Error(`reclamation_policy_invalid:${name}`);
  result[key]=n;
 }
 return result;
}
export interface ReclamationJob {
 id:string;resource_key:string;kind:'candidate'|'environment';project_id:number;workspace_id:number;
 attempt_id:string;integration_id:string|null;executor_id:number;cwd:string;generation:number;
 state:string;reason:string|null;details:string|null;token:string|null;owner_pid:number|null;
 archive_path:string|null;archive_sha256:string|null;archive_bytes:number;archive_pinned:number;
 archive_purged_ts:number|null;archive_prune_state:string;archive_prune_reason:string|null;receipt_json:string|null;retry_count:number;next_check_ts:number;created_ts:number;updated_ts:number;
}
interface Capacity {executor_id:number;available_bytes:number|null;total_bytes:number|null;cache_bytes:number;archive_bytes:number;checked_ts:number;reason:string|null}
interface Binding {
 current_attempt:string|null;environment_generation:number;environment_state:string;module_cwd:string;module_branch:string;
 project_id:number;executor_id:number;module_key:number;workspace_root:string;project_cwd:string;project_executor:number;
 released_ts:number|null;stop_confirmed:number;integrated_sha:string|null;result_sha:string|null;issue_status:string;
 candidate_sha:string|null;integration_phase:string|null;integration_cwd:string|null;executor_start_ts:number|null;
}
export interface WorkspaceReclamationDeps {
 db:Database;mutex:KeyedMutex;driverForProject(project:Project):ExecutorDriver;
 projectForId(id:number):Project|undefined;policy?:Partial<WorkspaceReclamationPolicy>;
}

/** Called inside release's transaction: a crash cannot lose the reclamation intent. */
export function enqueueReleasedWorkspaceCandidates(db:Database,attemptId:string,now=Date.now()):void {
 const rows=db.query<{id:string;workspace_id:number;project_id:number;executor_id:number;cwd:string},[string]>(`SELECT j.id,a.workspace_id,w.project_id,w.executor_id,j.cwd
  FROM workspace_integrations j JOIN workspace_attempts a ON a.id=j.attempt_id JOIN module_workspaces w ON w.id=a.workspace_id
  WHERE a.id=? AND a.released_ts IS NOT NULL AND a.stop_confirmed=1 AND a.integrated_sha IS NOT NULL`).all(attemptId);
 for(const row of rows)db.query(`INSERT OR IGNORE INTO workspace_reclamation_jobs
  (id,resource_key,kind,project_id,workspace_id,attempt_id,integration_id,executor_id,cwd,created_ts,updated_ts)
  VALUES(?,?,'candidate',?,?,?,?,?,?,?,?)`).run(randomUUID(),`candidate:${row.id}`,row.project_id,row.workspace_id,attemptId,row.id,row.executor_id,row.cwd,now,now);
}

/** Program-owned durable queue. A model can select a project-scoped job, never a path or command. */
export class WorkspaceReclamationService {
 readonly policy:WorkspaceReclamationPolicy;
 private stopped=false;
 private flight:Promise<void>|null=null;
 private timer:ReturnType<typeof setInterval>|undefined;
 constructor(private readonly deps:WorkspaceReclamationDeps) {
  this.policy={...DEFAULT_WORKSPACE_RECLAMATION_POLICY,...deps.policy};
  for(const value of Object.values(this.policy))if(!Number.isSafeInteger(value)||value<0)throw new Error('reclamation_policy_invalid');
  if(this.policy.tickMs<1||this.policy.batchSize<1)throw new Error('reclamation_policy_invalid');
 }
 private get db(){return this.deps.db;}
 start():void {if(this.stopped||this.timer)return;void this.tick();this.timer=setInterval(()=>void this.tick(),this.policy.tickMs);}
 async stop():Promise<void>{this.stopped=true;if(this.timer)clearInterval(this.timer);await this.flight;}
 list(projectId:number):{jobs:ReclamationJob[];capacity:Capacity|null;policy?:Readonly<WorkspaceReclamationPolicy>} {
  const project=this.deps.projectForId(projectId);
  return {jobs:this.db.query<ReclamationJob,[number]>("SELECT * FROM workspace_reclamation_jobs WHERE project_id=? ORDER BY CASE WHEN state='reclaimed' THEN 1 ELSE 0 END,updated_ts DESC,id LIMIT 100").all(projectId),
   capacity:project?this.db.query<Capacity,[number]>('SELECT * FROM workspace_capacity WHERE executor_id=?').get(project.executorId):null,policy:this.policy};
 }
 request(projectId:number,id:string):void {
  if(this.stopped)throw new Error('reclamation_stopped');
  const row=this.db.query<ReclamationJob,[number,string]>('SELECT * FROM workspace_reclamation_jobs WHERE project_id=? AND id=?').get(projectId,id);
  if(!row)throw new Error('reclamation_not_found');
  if(row.state==='reclaimed')return;
  this.db.query("UPDATE workspace_reclamation_jobs SET state=CASE WHEN token IS NULL THEN 'pending' ELSE 'uncertain' END,next_check_ts=0 WHERE id=? AND project_id=?").run(id,projectId);
 }
 async pin(projectId:number,id:string,pinned:boolean):Promise<void>{
  const job=this.db.query<ReclamationJob,[number,string]>('SELECT * FROM workspace_reclamation_jobs WHERE project_id=? AND id=?').get(projectId,id);
  if(!job)throw new Error('reclamation_not_found');
  await this.deps.mutex.runExclusive(`reclamation-executor:${job.executor_id}`,()=>{
   const state=this.db.query<ReclamationJob,[string]>('SELECT * FROM workspace_reclamation_jobs WHERE id=?').get(id);
   if(state&&['dispatching','uncertain'].includes(state.archive_prune_state))throw new Error('reclamation_archive_busy');
   const r=this.db.query("UPDATE workspace_reclamation_jobs SET archive_pinned=? WHERE id=? AND project_id=? AND archive_purged_ts IS NULL AND archive_prune_state='none'").run(pinned?1:0,id,projectId);
   if(!r.changes)throw new Error('reclamation_archive_unavailable');
  });
 }
 reconcile(pressureExecutors=new Set<number>()):void {
  const now=Date.now();
  this.db.transaction(()=>{
   for(const a of this.db.query<{id:string},[]>(`SELECT id FROM workspace_attempts WHERE released_ts IS NOT NULL AND stop_confirmed=1 AND integrated_sha IS NOT NULL`).all())enqueueReleasedWorkspaceCandidates(this.db,a.id,now);
   const idle=this.db.query<{id:number;project_id:number;executor_id:number;cwd:string;environment_generation:number;updated_ts:number;attempt_id:string},[]>(`SELECT w.*,a.id attempt_id
    FROM module_workspaces w JOIN workspace_attempts a ON a.workspace_id=w.id AND a.released_ts IS NOT NULL
    WHERE w.current_attempt IS NULL AND w.kind='module-worktree' AND w.environment_state<>'cold'
    AND a.id=(SELECT x.id FROM workspace_attempts x WHERE x.workspace_id=w.id ORDER BY x.created_ts DESC,x.rowid DESC LIMIT 1)`).all();
   for(const w of idle) {
    if(!pressureExecutors.has(w.executor_id)&&now-w.updated_ts<this.policy.idleMs)continue;
    this.db.query(`INSERT OR IGNORE INTO workspace_reclamation_jobs
     (id,resource_key,kind,project_id,workspace_id,attempt_id,executor_id,cwd,generation,created_ts,updated_ts)
     VALUES(?,?,'environment',?,?,?,?,?,?,?,?)`).run(randomUUID(),`environment:${w.id}:${w.attempt_id}`,w.project_id,w.id,w.attempt_id,w.executor_id,w.cwd,w.environment_generation,now,now);
   }
  })();
 }
 private baseRequest(project:Project):ReclamationRequest {
  const e=this.db.query<{workspace_root:string},[number]>('SELECT workspace_root FROM executors WHERE id=?').get(project.executorId);
  if(!e||!posix.isAbsolute(e.workspace_root))throw new Error('reclamation_executor_unavailable');
  return {action:'capacity',jobId:randomUUID(),kind:'environment',projectId:project.id,executorId:project.executorId,
   workspaceRoot:e.workspace_root,projectCwd:project.cwd,cwd:project.cwd,branch:null,targetRef:`refs/heads/${project.workBranch??'main'}`,
   attemptIds:[],generation:0,minFreeBytes:this.policy.minFreeBytes,archiveMaxBytes:this.policy.archiveMaxBytes};
 }
 private async capacity(project:Project,measureCache=false,cwd?:string):Promise<Capacity> {
  const request=this.baseRequest(project);request.probePaths=cwd?[cwd]:[];
  if(measureCache) {
   const rows=this.db.query<{cwd:string;id:string},[number]>(`SELECT w.cwd,a.id FROM module_workspaces w JOIN workspace_attempts a ON a.workspace_id=w.id WHERE w.executor_id=?
    UNION SELECT COALESCE(a.execution_cwd,w.cwd),a.id FROM module_workspaces w JOIN workspace_attempts a ON a.workspace_id=w.id WHERE w.executor_id=?1
    UNION SELECT j.cwd,a.id FROM workspace_integrations j JOIN workspace_attempts a ON a.id=j.attempt_id JOIN module_workspaces w ON w.id=a.workspace_id WHERE w.executor_id=?1
    UNION SELECT w.cwd,r.id FROM workspace_merge_agents r JOIN workspace_attempts a ON a.id=r.attempt_id JOIN module_workspaces w ON w.id=a.workspace_id WHERE w.executor_id=?1
    UNION SELECT j.cwd,r.id FROM workspace_merge_agents r JOIN workspace_integrations j ON j.id=r.integration_id JOIN module_workspaces w ON w.project_id=r.project_id AND w.id=(SELECT workspace_id FROM workspace_attempts WHERE id=r.attempt_id) WHERE w.executor_id=?1`).all(project.executorId);
   const ownedRoot=posix.join(request.workspaceRoot,'.panda-worktrees')+'/';
   request.cachePaths=[...new Set(rows.filter(r=>r.cwd.startsWith(ownedRoot)).map(r=>posix.join(r.cwd,'.panda/tmp/runtime',r.id)))];
  }
  let result:ReclamationResult;
  try {
   result=await runWorkspaceReclamation(this.deps.driverForProject(project),project.cwd,request);
   if(result.state!=='ready'||!Number.isSafeInteger(result.availableBytes)||!Number.isSafeInteger(result.totalBytes))throw new Error(result.reason??'capacity_unknown');
  } catch(error) {
   this.db.query(`INSERT INTO workspace_capacity(executor_id,checked_ts,reason) VALUES(?,?,?) ON CONFLICT(executor_id) DO UPDATE SET checked_ts=excluded.checked_ts,reason=excluded.reason`).run(project.executorId,Date.now(),redactDiagnostic(String(error)).slice(-1000));
   throw error;
  }
  this.db.query(`INSERT INTO workspace_capacity(executor_id,available_bytes,total_bytes,cache_bytes,archive_bytes,checked_ts,reason) VALUES(?,?,?,?,?,?,NULL)
   ON CONFLICT(executor_id) DO UPDATE SET available_bytes=excluded.available_bytes,total_bytes=excluded.total_bytes,
   cache_bytes=CASE WHEN ? THEN excluded.cache_bytes ELSE workspace_capacity.cache_bytes END,archive_bytes=excluded.archive_bytes,checked_ts=excluded.checked_ts,reason=NULL`)
   .run(project.executorId,result.availableBytes!,result.totalBytes!,result.cacheBytes??0,result.archiveBytes??0,Date.now(),measureCache?1:0);
  return this.db.query<Capacity,[number]>('SELECT * FROM workspace_capacity WHERE executor_id=?').get(project.executorId)!;
 }
 async assertCapacity(project:Project,phase:'start'|'candidate'|'dependencies',cwd?:string):Promise<void> {
  let snapshot:Capacity;
  try {snapshot=await this.capacity(project,phase==='start',cwd);}catch {throw new WorkspaceResourceDeferred('executor_capacity_unknown');}
  if(snapshot.available_bytes===null||snapshot.available_bytes<this.policy.minFreeBytes)throw new WorkspaceResourceDeferred('executor_disk_low');
  if(phase==='start'&&snapshot.cache_bytes>this.policy.cacheMaxBytes)throw new WorkspaceResourceDeferred('executor_cache_pressure');
 }
 tick():Promise<void> {
  if(this.stopped)return Promise.resolve();
  if(this.flight)return this.flight;
  this.flight=this.performTick().catch(()=>{}).finally(()=>{this.flight=null;});return this.flight;
 }
 private async performTick():Promise<void> {
  const projects=this.db.query<{id:number;executor_id:number},[]>('SELECT id,executor_id FROM projects WHERE status=\'active\' ORDER BY id').all();
  const measured=new Set<number>(),pressure=new Set<number>();
  for(const p of projects) {
   if(this.stopped)return;if(measured.has(p.executor_id))continue;
   const project=this.deps.projectForId(p.id);if(!project)continue;measured.add(p.executor_id);
   try {
    const c=await this.capacity(project,true);
    if((c.available_bytes??0)<this.policy.minFreeBytes||c.cache_bytes>this.policy.cacheMaxBytes)pressure.add(project.executorId);
    await this.pruneArchives(project,c.archive_bytes);
   }catch {/* An unreachable executor is visible in the capacity ledger; never fall back locally. */}
  }
  if(this.stopped)return;this.reconcile(pressure);
  const jobs=this.db.query<ReclamationJob,[number,number]>(`SELECT * FROM workspace_reclamation_jobs WHERE state<>'reclaimed' AND next_check_ts<=?
   ORDER BY CASE WHEN token IS NOT NULL THEN 0 WHEN kind='candidate' THEN 1 ELSE 2 END,created_ts,id LIMIT ?`).all(Date.now(),this.policy.batchSize);
  for(const job of jobs) {
   if(this.stopped)return;
   try {await this.deps.mutex.runExclusive(`reclamation-executor:${job.executor_id}`,()=>this.process(job));}
   catch(error) {this.db.query("UPDATE workspace_reclamation_jobs SET state='uncertain',reason='controller_failure',details=?,next_check_ts=?,updated_ts=? WHERE id=?").run(redactDiagnostic(String(error)).slice(-2000),Date.now()+this.policy.retryMs,Date.now(),job.id);}
  }
 }
 private binding(job:ReclamationJob):Binding|null {
  return this.db.query<Binding,[string,string|null,number]>(`SELECT w.current_attempt,w.environment_generation,w.environment_state,w.cwd module_cwd,w.branch module_branch,w.project_id,w.executor_id,w.module_key,
   e.workspace_root,p.cwd project_cwd,p.executor_id project_executor,a.released_ts,a.stop_confirmed,a.integrated_sha,a.result_sha,a.executor_start_ts,i.status issue_status,
   j.candidate_sha,j.phase integration_phase,j.cwd integration_cwd
   FROM module_workspaces w JOIN workspace_attempts a ON a.workspace_id=w.id AND a.id=? JOIN projects p ON p.id=w.project_id
   JOIN executors e ON e.id=w.executor_id JOIN issues i ON i.id=a.issue_id LEFT JOIN workspace_integrations j ON j.id=? AND j.attempt_id=a.id WHERE w.id=?`).get(job.attempt_id,job.integration_id,job.workspace_id);
 }
 private blocker(job:ReclamationJob,b:Binding|null):string|null {
  if(!b||b.executor_id!==job.executor_id||b.project_executor!==job.executor_id||b.project_id!==job.project_id)return 'execution_location_changed';
  const expected=posix.join(b.workspace_root,'.panda-worktrees',`project-${job.project_id}`,job.kind==='candidate'?`integration/${job.integration_id}`:`module-${b.module_key}`);
  if(job.cwd!==expected||(job.kind==='candidate'?b.integration_cwd:b.module_cwd)!==job.cwd)return 'workspace_binding_changed';
  if(b.released_ts===null||!b.stop_confirmed)return 'execution_not_released';
  if(job.kind==='candidate'&&(!b.integrated_sha||b.issue_status!=='done'||!['published','validated'].includes(b.integration_phase??'')||!b.candidate_sha))return 'candidate_not_published';
  if(this.db.query(`SELECT 1 FROM workspace_merge_agents WHERE attempt_id=? AND (stop_confirmed=0 OR state IN ('starting','dispatching','running','stopping','uncertain'))`).get(job.attempt_id))return 'merge_writer_active';
  if(job.kind==='environment') {
   if(b.current_attempt!==null)return 'module_held';
   if(b.environment_generation!==job.generation)return 'environment_generation_changed';
   if(this.db.query('SELECT 1 FROM workspace_attempts WHERE workspace_id=? AND (released_ts IS NULL OR stop_confirmed=0)').get(job.workspace_id))return 'execution_not_stopped';
   const last=this.db.query<{id:string},[number]>('SELECT id FROM workspace_attempts WHERE workspace_id=? ORDER BY created_ts DESC,rowid DESC LIMIT 1').get(job.workspace_id);
   if(last?.id!==job.attempt_id)return 'environment_reused';
  }
  return null;
 }
 private async process(job:ReclamationJob):Promise<void> {
  const resource=job.kind==='candidate'?`integration:${job.integration_id}`:`workspace:${job.workspace_id}`;
  await this.deps.mutex.runExclusive(resource,async()=>{
   const fresh=this.db.query<ReclamationJob,[string]>('SELECT * FROM workspace_reclamation_jobs WHERE id=?').get(job.id);if(!fresh||fresh.state==='reclaimed')return;job=fresh;
   let binding=this.binding(job),reason=this.blocker(job,binding);
   if(reason){this.record(job,{state:'retained',reason});return;}
   const project=this.deps.projectForId(job.project_id);
   if(!project||project.executorId!==job.executor_id||project.cwd!==binding!.project_cwd){this.record(job,{state:'retained',reason:'execution_location_changed'});return;}
   let claimed=false;
   this.db.transaction(()=>{
    binding=this.binding(job);reason=this.blocker(job,binding);if(reason)return;
    if(this.db.query('SELECT 1 FROM workspace_operations WHERE resource=?').get(`workspace-repository:${job.executor_id}:${job.project_id}`)){reason='repository_busy';return;}
    const previous=this.db.query<{token:string;operation:string;owner_pid:number},[string]>('SELECT * FROM workspace_operations WHERE resource=?').get(resource);
    if(previous) {
     if(!job.token||previous.token!==job.token||previous.operation!==`reclaim:${job.id}`){reason='workspace_operation_pending';return;}
     if(previous.owner_pid!==process.pid) {
      try {process.kill(previous.owner_pid,0);reason='controller_active';return;}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH'){reason='controller_unknown';return;}}
     }
    }
    const token=job.token??randomUUID();
    this.db.query(`INSERT INTO workspace_operations(resource,token,operation,owner_pid,created_ts) VALUES(?,?,?,?,?)
     ON CONFLICT(resource) DO UPDATE SET owner_pid=excluded.owner_pid WHERE workspace_operations.token=excluded.token`).run(resource,token,`reclaim:${job.id}`,process.pid,Date.now());
    this.db.query("UPDATE workspace_reclamation_jobs SET state='checking',token=?,owner_pid=?,updated_ts=? WHERE id=?").run(token,process.pid,Date.now(),job.id);
    if(job.kind==='environment')this.db.query("UPDATE module_workspaces SET environment_state='cooling' WHERE id=?").run(job.workspace_id);
    job.token=token;claimed=true;
   })();
   if(!claimed){this.record(job,{state:'retained',reason:reason??'reclamation_claim_failed'});return;}
   const b=binding!;
   const attempts=job.kind==='candidate'?[{id:job.attempt_id,executor_start_ts:b.executor_start_ts}]:this.db.query<{id:string;executor_start_ts:number|null},[number]>('SELECT id,executor_start_ts FROM workspace_attempts WHERE workspace_id=? ORDER BY created_ts,rowid').all(job.workspace_id);
   const mergeIds=job.kind==='candidate'
    ?this.db.query<{id:string},[string]>('SELECT id FROM workspace_merge_agents WHERE attempt_id=? ORDER BY id').all(job.attempt_id).map(r=>r.id)
    :this.db.query<{id:string},[number]>('SELECT r.id FROM workspace_merge_agents r JOIN workspace_attempts a ON a.id=r.attempt_id WHERE a.workspace_id=? ORDER BY r.id').all(job.workspace_id).map(r=>r.id);
   const request={...this.baseRequest(project),action:'reclaim',jobId:job.id,kind:job.kind,cwd:job.cwd,
    branch:job.kind==='candidate'?null:b.module_branch,expectedHead:job.kind==='candidate'?b.candidate_sha:null,resultSha:job.kind==='candidate'?b.result_sha:null,
    targetRef:`refs/heads/${this.db.query<{integration_branch:string|null;work_branch:string|null},[number]>('SELECT integration_branch,work_branch FROM projects WHERE id=?').get(project.id)!.integration_branch??project.workBranch??'main'}`,
    attemptIds:[...attempts.map(a=>a.id),...mergeIds],startedTs:Math.min(...attempts.map(a=>a.executor_start_ts??0)),generation:job.generation};
   let result:ReclamationResult;
   try {result=await runWorkspaceReclamation(this.deps.driverForProject(project),project.cwd,request);}
   catch(error){result={state:'uncertain',reason:'executor_result_unknown',details:redactDiagnostic(String(error)).slice(-1800)};}
   if(result.state==='ready')result={state:'uncertain',reason:'executor_receipt_invalid'};
   const uncertain=result.state==='uncertain'||['reclamation_busy','dependency_busy','repository_busy','archive_busy','live_writer','writer_inspection_denied'].includes(result.reason??'');
   this.db.transaction(()=>{
    this.record(job,uncertain?{...result,state:'uncertain'}:result);
    if(uncertain)return;
    this.db.query('DELETE FROM workspace_operations WHERE resource=? AND token=?').run(resource,job.token!);
    this.db.query('UPDATE workspace_reclamation_jobs SET token=NULL,owner_pid=NULL WHERE id=?').run(job.id);
    if(job.kind==='environment')this.db.query(`UPDATE module_workspaces SET environment_state=?,environment_generation=environment_generation+?
     WHERE id=? AND current_attempt IS NULL AND environment_generation=?`).run(result.state==='reclaimed'?'cold':'warm',result.state==='reclaimed'?1:0,job.workspace_id,job.generation);
   })();
  });
 }
 private record(job:ReclamationJob,result:ReclamationResult):void {
  const retry=Date.now()+this.policy.retryMs*Math.min(30,2**Math.min(job.retry_count,5));
  this.db.query(`UPDATE workspace_reclamation_jobs SET state=?,reason=?,details=?,archive_path=COALESCE(?,archive_path),archive_sha256=COALESCE(?,archive_sha256),
   archive_bytes=CASE WHEN ? IS NULL THEN archive_bytes ELSE ? END,receipt_json=?,retry_count=retry_count+?,next_check_ts=?,updated_ts=? WHERE id=?`)
   .run(result.state,result.reason??null,result.details?redactDiagnostic(result.details).slice(-2000):null,result.archive?.path??null,result.archive?.sha256??null,
    result.archive?.bytes??null,result.archive?.bytes??null,JSON.stringify(result),result.state==='reclaimed'?0:1,retry,Date.now(),job.id);
 }
 private async pruneArchives(project:Project,total:number):Promise<void> {
  const rows=this.db.query<ReclamationJob,[number]>(`SELECT * FROM workspace_reclamation_jobs WHERE executor_id=? AND state='reclaimed' AND archive_path IS NOT NULL AND archive_purged_ts IS NULL AND archive_pinned=0 ORDER BY updated_ts,id`).all(project.executorId);
  let remaining=total,madeRoom=false;
  const waiting=this.db.query('SELECT 1 FROM workspace_reclamation_jobs WHERE executor_id=? AND reason=\'archive_quota\' AND state<>\'reclaimed\'').get(project.executorId);
  for(const job of rows) {
   if(job.archive_prune_state==='none'&&Date.now()-job.updated_ts<this.policy.archiveRetentionMs&&remaining<=(waiting?this.policy.archiveMaxBytes/2:this.policy.archiveMaxBytes)&&(!waiting||madeRoom))continue;
   const own=this.deps.projectForId(job.project_id);if(!own||own.executorId!==job.executor_id)continue;
   await this.deps.mutex.runExclusive(`reclamation-executor:${job.executor_id}`,async()=>{
    const fresh=this.db.query<ReclamationJob,[string]>('SELECT * FROM workspace_reclamation_jobs WHERE id=?').get(job.id);
    if(!fresh||fresh.archive_pinned||fresh.archive_purged_ts!==null)return;
    const claim=this.db.query("UPDATE workspace_reclamation_jobs SET archive_prune_state='dispatching',archive_prune_reason=NULL WHERE id=? AND archive_pinned=0 AND archive_purged_ts IS NULL").run(job.id);
    if(!claim.changes)return;
    try {
     const result=await runWorkspaceReclamation(this.deps.driverForProject(own),own.cwd,{...this.baseRequest(own),action:'prune',archives:[{jobId:job.id,path:job.archive_path!,sha256:job.archive_sha256!,bytes:job.archive_bytes}]});
     if(result.purged?.includes(job.id)){this.db.query("UPDATE workspace_reclamation_jobs SET archive_purged_ts=?,archive_prune_state='purged',archive_prune_reason=NULL WHERE id=?").run(Date.now(),job.id);remaining-=job.archive_bytes;madeRoom=true;}
     else this.db.query('UPDATE workspace_reclamation_jobs SET archive_prune_state=?,archive_prune_reason=? WHERE id=?').run(['archive_busy','reclamation_busy'].includes(result.reason??'')||result.state==='uncertain'?'uncertain':'none',result.reason??'archive_prune_failed',job.id);
    }catch(error){this.db.query("UPDATE workspace_reclamation_jobs SET archive_prune_state='uncertain',archive_prune_reason=? WHERE id=?").run(redactDiagnostic(String(error)).slice(-1000),job.id);}
   });
  }
 }
}
export class WorkspaceResourceDeferred extends WorkspaceExecutionDeferred {
 constructor(reason:string){super();this.message=reason;this.name='WorkspaceResourceDeferred';}
}

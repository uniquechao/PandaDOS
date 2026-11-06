import { prepareDependencies } from './dependency-preparation';
import { randomUUID, createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { Conversation, Project } from '../core/types';
import { workspaceEnvironment } from '../core/workspace-ownership';
import { worktreeTmux, chatTmux } from '../core/conversations';
import type { ExecutorDriver } from '../executor/driver';
import type { EngineIssue, EngineExecutionWorkspace, EngineExecutionWorkspaceOps } from './engine';
import { KeyedMutex, gitLockKey, tmuxLockKey } from './mutex';
import { BUSY_STATES, orderPending } from './queue';
import { moduleIssueRelPath } from './module-docs';
import { issueMetaProjection, moduleMetaProjection } from './project-data-sync';
import type { IssueId } from '../../shared/issue-id';

export class WorkspaceOperationUncertain extends Error {}

export interface WorkspaceAttempt {
 id:string; workspace_id:number; issue_id:IssueId; conversation_id:string|null; agent:string;
 execution_run_id:string|null; executor_start_ts:number; phase:string; base_sha:string|null; result_sha:string|null; integrated_sha:string|null;
 compute_held:number; stop_confirmed:number; released_ts:number|null; diagnostic:string|null;
 cwd:string; branch:string; project_id:number; executor_id:number; module_key:number; kind:string;
}
interface Integration { id:string; attempt_id:string; target_sha:string; result_sha:string; cwd:string;
 candidate_sha:string|null; phase:string; diagnostic:string|null }
export interface ModuleWorkspaceDeps {
 db:Database; mutex:KeyedMutex; driverForProject(project:Project):ExecutorDriver;
 legacy:EngineExecutionWorkspaceOps;
 conversations: {get(id:string):Conversation|undefined; createInWorkspaceWithId(id:string,projectId:number,label:string,agent:'codex'|'claude',cwd:string):Conversation};
}

/** Durable reservations are not leases: an expired clock never authorizes a second writer. */
export class ModuleWorkspaceService implements EngineExecutionWorkspaceOps {
 constructor(private readonly deps:ModuleWorkspaceDeps) {}
 private get db() { return this.deps.db; }
 enabled(issue:Pick<EngineIssue,'id'>):boolean {
   return this.db.query<{workspace_mode:string},[IssueId]>('SELECT workspace_mode FROM issues WHERE id=?').get(issue.id)?.workspace_mode === 'module';
 }
 attempt(issueId:IssueId):WorkspaceAttempt|null {
   return this.db.query<WorkspaceAttempt,[IssueId]>(`SELECT a.*,COALESCE(a.execution_cwd,w.cwd) cwd,COALESCE(a.execution_branch,w.branch) branch,w.project_id,w.executor_id,w.module_key,COALESCE(a.execution_kind,w.kind) kind
     FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id
     WHERE a.issue_id=? ORDER BY a.created_ts DESC,a.rowid DESC LIMIT 1`).get(issueId);
 }
 assertOwned(attempt:WorkspaceAttempt):void {
   const row=this.db.query(`SELECT 1 FROM workspace_attempts a JOIN module_workspaces w ON w.current_attempt=a.id
     JOIN issues i ON i.id=a.issue_id
     WHERE a.id=? AND w.id=? AND a.released_ts IS NULL AND i.project_id=w.project_id
     AND COALESCE(i.module_id,0)=w.module_key AND i.agent=a.agent
     AND (i.conv_id IS NULL OR i.conv_id=a.conversation_id)`).get(attempt.id,attempt.workspace_id);
   if(!row) throw new Error('工作区执行轮次已失效，已停止操作');
 }
 held(issueId:IssueId):boolean { return this.attempt(issueId)?.released_ts === null; }
 capacity(projectId:number):number {
   return this.db.query<{module_concurrency:number},[number]>('SELECT module_concurrency FROM projects WHERE id=?').get(projectId)?.module_concurrency ?? 2;
 }
 canStart(issue:EngineIssue, siblings:EngineIssue[]):boolean {
   if(!this.enabled(issue)) return !siblings.some(i=>i.id!==issue.id && BUSY_STATES.includes(i.status));
   if(siblings.some(i=>i.id!==issue.id && !this.enabled(i) && (BUSY_STATES.includes(i.status)||i.status==='paused'||i.status==='blocked'))) return false;
   const occupied=this.db.query<{issue_id:string},[number,number]>(`SELECT a.issue_id FROM module_workspaces w
     JOIN workspace_attempts a ON a.id=w.current_attempt AND a.released_ts IS NULL WHERE w.project_id=? AND w.module_key=?`).get(issue.projectId,issue.moduleId??0);
   if(occupied && occupied.issue_id!==issue.id) return false;
   if(this.attempt(issue.id)?.result_sha)return true;
   const count=this.db.query<{n:number},[number,IssueId]>(`SELECT COUNT(*) n FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id
     WHERE w.project_id=? AND a.released_ts IS NULL AND a.compute_held=1 AND a.issue_id<>?`).get(issue.projectId,issue.id)!.n;
   return count<this.capacity(issue.projectId);
 }
 retainedBlocker(issue:EngineIssue):string|null {
   const owner=this.db.query<{id:string;status:string},[number,number]>(`SELECT i.id,i.status FROM module_workspaces w
     JOIN workspace_attempts a ON a.id=w.current_attempt AND a.released_ts IS NULL JOIN issues i ON i.id=a.issue_id
     WHERE w.project_id=? AND w.module_key=?`).get(issue.projectId,issue.moduleId??0);
   if(!owner||owner.id===issue.id)return null;
   const labels:Record<string,string>={cancelled:'已取消',done:'已完成',paused:'已暂停',blocked:'受阻'};
   return labels[owner.status]?`同模块工作区由 #${owner.id}（${labels[owner.status]}）保留，请清理并释放现场后再运行`:null;
 }
 pick(issues:EngineIssue[], siblings:EngineIssue[], preferred?:string):EngineIssue|undefined {
   return orderPending(issues,preferred).find(i=>this.canStart(i,siblings));
 }
 compute(issueId:IssueId, held:boolean):void {
   this.db.query('UPDATE workspace_attempts SET compute_held=CASE WHEN result_sha IS NULL THEN ? ELSE 0 END,updated_ts=? WHERE issue_id=? AND released_ts IS NULL').run(held?1:0,Date.now(),issueId);
 }
 async target(project:Project):Promise<string> {
   const saved=this.db.query<{integration_branch:string|null},[number]>('SELECT integration_branch FROM projects WHERE id=?').get(project.id)?.integration_branch;
   if(saved) return saved;
   const driver=this.deps.driverForProject(project);
   const target=project.workBranch?.trim() || (await this.git(driver,project.cwd,['symbolic-ref','--quiet','--short','HEAD'])).trim();
   await this.git(driver,project.cwd,['check-ref-format',`refs/heads/${target}`]);
   await this.git(driver,project.cwd,['rev-parse','--verify',`refs/heads/${target}^{commit}`]);
   this.db.query('UPDATE projects SET integration_branch=? WHERE id=? AND integration_branch IS NULL').run(target,project.id);
   return this.db.query<{integration_branch:string},[number]>('SELECT integration_branch FROM projects WHERE id=?').get(project.id)!.integration_branch;
 }
 private root(project:Project):string {
   const executor=this.db.query<{workspace_root:string},[number]>('SELECT workspace_root FROM executors WHERE id=?').get(project.executorId);
   if(!executor || !posix.isAbsolute(executor.workspace_root)) throw new Error('执行机工作区根目录未配置');
   return posix.join(executor.workspace_root,'.panda-worktrees',`project-${project.id}`);
 }
 private async git(driver:ExecutorDriver,cwd:string,args:string[]):Promise<string> {
   const mutating = true; // Reads also wait for a surviving command from a former controller.
   let r;
   if(mutating) {
     const common=await driver.git(cwd,['rev-parse','--path-format=absolute','--git-common-dir']);
     if(common.code!==0) throw new Error(common.err);
     try {
       r=await driver.runCommand(cwd,['flock','-x',posix.join(common.out.trim(),'panda-workspace.lock'),'git',...args],120_000);
       if(r.timedOut) throw new WorkspaceOperationUncertain('执行机 Git 操作结果未知，保留操作记录');
     } catch(e) { throw e instanceof WorkspaceOperationUncertain ? e : new WorkspaceOperationUncertain(String(e)); }
   } else r=await driver.git(cwd,args);
   if(r.code!==0) throw new Error(`${args[0]}：${(r.err||r.out).slice(0,500)}`);
   return r.out.trim();
 }
 /** Persistent short operation lock. Unknown owner is retained; never stolen by a timeout. */
 private async operation<T>(resource:string,operation:string,fn:()=>Promise<T>):Promise<T> {
   return this.deps.mutex.runExclusive(resource,async()=>{
     const token=randomUUID();
     const previous=this.db.query<{token:string;owner_pid:number},[string]>('SELECT token,owner_pid FROM workspace_operations WHERE resource=?').get(resource);
     if(previous) {
       let alive=true;
       try {process.kill(previous.owner_pid,0);} catch(e) {if((e as NodeJS.ErrnoException).code==='ESRCH')alive=false;}
       // The former controller cannot issue more commands. Executor-side flock still waits
       // for any surviving physical Git command before reconciliation mutates the repository.
       if(!alive) this.db.query('DELETE FROM workspace_operations WHERE resource=? AND token=?').run(resource,previous.token);
     }
     const claim=this.db.query('INSERT OR IGNORE INTO workspace_operations(resource,token,operation,owner_pid,created_ts) VALUES(?,?,?,?,?)').run(resource,token,operation,process.pid,Date.now());
     if(!claim.changes) throw new Error('工作区存在未确认的执行机操作，需核对现场后恢复');
     let uncertain=false;
     try {return await fn();} catch(e) {uncertain=e instanceof WorkspaceOperationUncertain;throw e;} finally {if(!uncertain)this.db.query('DELETE FROM workspace_operations WHERE resource=? AND token=?').run(resource,token);}
   });
 }
 private repoOperation<T>(project:Project,operation:string,fn:()=>Promise<T>):Promise<T> {
   return this.deps.mutex.runExclusive(gitLockKey(project.id),()=>this.operation(`workspace-repository:${project.executorId}:${project.id}`,operation,fn));
 }
 private async assertLocation(project:Project,cwd:string,branch?:string):Promise<void> {
   const driver=this.deps.driverForProject(project);
   if(!(await driver.statPath(cwd))?.isDirectory || await driver.readlink(cwd)) throw new Error('工作区目录遗失或被替换，禁止重建覆盖');
   const entries=await this.git(driver,project.cwd,['worktree','list','--porcelain']);
   if(!entries.split('\n').includes(`worktree ${cwd}`)) throw new Error('工作区登记路径不符，禁止操作');
   const expected=await this.git(driver,project.cwd,['rev-parse','--path-format=absolute','--git-common-dir']);
   const actual=await this.git(driver,cwd,['rev-parse','--path-format=absolute','--git-common-dir']);
   if(actual!==expected) throw new Error('工作区 Git 仓库已被替换，禁止操作');
   if(branch && await this.git(driver,cwd,['symbolic-ref','--short','HEAD'])!==branch) throw new Error('工作区分支发生变化，需恢复原分支');
 }
 async resolve(issue:EngineIssue,project:Project):Promise<EngineExecutionWorkspace> {
   if(!this.enabled(issue)) return this.deps.legacy.resolve(issue,project);
   let a=this.attempt(issue.id);
   if(!a || (a.released_ts!==null && issue.status==='pending')) {
     if(issue.status!=='pending') throw new Error('执行工作区记录缺失，禁止回落到项目目录');
     const target=await this.target(project);
     const inherited=await this.deps.legacy.resolve(issue,project);
     const cwd=posix.join(this.root(project),`module-${issue.moduleId??0}`);
     const branch=`panda/module-${project.id}-${issue.moduleId??0}`;
     const executionCwd=inherited.kind==='design-worktree'?inherited.cwd:cwd;
     const executionBranch=inherited.kind==='design-worktree'?inherited.branch!:branch;
     this.db.transaction(()=>{
       const busy=this.db.query<{n:number},[number]>(`SELECT COUNT(*) n FROM workspace_attempts a JOIN module_workspaces w ON w.id=a.workspace_id
         WHERE w.project_id=? AND a.released_ts IS NULL AND a.compute_held=1`).get(project.id)!.n;
       if(busy>=this.capacity(project.id)) throw new Error('项目并发名额已满');
       const now=Date.now();
       this.db.query(`INSERT OR IGNORE INTO module_workspaces(project_id,module_key,executor_id,cwd,branch,kind,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?)`)
         .run(project.id,issue.moduleId??0,project.executorId,cwd,branch,'module-worktree',now,now);
       const w=this.db.query<{id:number;cwd:string;executor_id:number;current_attempt:string|null},[number,number]>('SELECT * FROM module_workspaces WHERE project_id=? AND module_key=?').get(project.id,issue.moduleId??0);
       if(!w || w.cwd!==cwd || w.executor_id!==project.executorId || w.current_attempt) throw new Error('模块工作区仍被占用或执行位置不一致');
       const attempt=randomUUID();
       this.db.query(`INSERT INTO workspace_attempts(id,workspace_id,issue_id,agent,execution_executor_id,execution_cwd,execution_branch,execution_kind,execution_run_id,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(attempt,w.id,issue.id,issue.agent,project.executorId,executionCwd,executionBranch,inherited.kind==='design-worktree'?'design-worktree':'module-worktree',inherited.runId,now,now);
       this.db.query('UPDATE module_workspaces SET current_attempt=?,updated_ts=? WHERE id=? AND current_attempt IS NULL').run(attempt,now,w.id);
       for(let port=18000;port<60000;port++) {
         if(this.db.query('INSERT OR IGNORE INTO workspace_runtime_resources(attempt_id,executor_id,port) VALUES(?,?,?)').run(attempt,project.executorId,port).changes) break;
       }
     })();
     a=this.attempt(issue.id)!;
   }
   if(a.released_ts===null) {
     this.assertOwned(a);
     if(a.phase==='reserved'||a.phase==='preparing'||a.phase==='prepared') await this.prepare(issue,project,a);
     await this.assertLocation(project,a.cwd,a.branch);
   }
   if(issue.status==='pending' && a.released_ts===null && !a.result_sha) this.db.transaction(()=>{
     this.assertOwned(a!);
     const active=this.db.query<{n:number},[number,string]>(`SELECT COUNT(*) n FROM workspace_attempts x JOIN module_workspaces w ON w.id=x.workspace_id WHERE w.project_id=? AND x.released_ts IS NULL AND x.compute_held=1 AND x.id<>?`).get(project.id,a!.id)!.n;
     if(active>=this.capacity(project.id))throw new Error('项目并发名额已满');
     this.compute(issue.id,true);
   })();
   return {cwd:a.cwd,kind:'module-worktree',branch:a.branch,runId:a.id};
 }
 private async prepare(issue:EngineIssue,project:Project,a:WorkspaceAttempt):Promise<void> {
   const driver=this.deps.driverForProject(project);
   await this.operation(`workspace:${a.workspace_id}`,'prepare',async()=>{
     this.assertOwned(a);
     if(!a.executor_start_ts) {
       const clock=await driver.runCommand(project.cwd,['date','+%s'],10000);
       const ts=Number(clock.out.trim())*1000;
       if(clock.code!==0||!Number.isSafeInteger(ts)||ts<=0)throw new Error('无法确认执行机时钟，禁止启动');
       this.db.query('UPDATE workspace_attempts SET executor_start_ts=? WHERE id=? AND executor_start_ts IS NULL').run(ts,a.id);
     }
     if (a.phase==='prepared') {
       await this.assertLocation(project,a.cwd,a.branch);
       await this.projectDocuments(issue,project,a);
       await this.prepareEnvironment(issue,project,a);
       this.db.query("UPDATE workspace_attempts SET phase='ready',updated_ts=? WHERE id=?").run(Date.now(),a.id);
       return;
     }
     const target=await this.target(project);
     const base=a.base_sha ?? await this.git(driver,project.cwd,['rev-parse',`refs/heads/${target}`]);
     this.db.query("UPDATE workspace_attempts SET base_sha=?,phase='preparing',updated_ts=? WHERE id=? AND base_sha IS NULL").run(base,Date.now(),a.id);
     const entries=await this.git(driver,project.cwd,['worktree','list','--porcelain']);
     const registered=entries.split('\n\n').find(b=>b.split('\n').includes(`worktree ${a.cwd}`));
     if(!registered) {
       if(await driver.statPath(a.cwd)) throw new Error('工作区目录已存在但未登记，禁止覆盖');
       if(a.kind==='design-worktree') throw new Error('设计工作区遗失，禁止重建');
       const exists=await driver.git(project.cwd,['show-ref','--verify','--quiet',`refs/heads/${a.branch}`]);
       if(exists.code!==1) throw new Error('模块分支已存在但工作区遗失，需核对保留成果');
       await driver.mkdirp(posix.dirname(a.cwd));
       await this.repoOperation(project,'create-worktree',()=>this.git(driver,project.cwd,['worktree','add','-b',a.branch,a.cwd,base]));
     }
     await this.assertLocation(project,a.cwd,a.branch);
     const dirty=await this.git(driver,a.cwd,['status','--porcelain']);
     if(dirty) throw new Error('工作区有未保存改动，保留现场等待恢复：\n'+dirty.split('\n').slice(0,8).join('\n').slice(0,1200));
     // Fast-forward only. A failed prior publication cannot be silently folded into another issue.
     await this.git(driver,a.cwd,['merge','--ff-only',base]);
     const head=await this.git(driver,a.cwd,['rev-parse','HEAD']);
     if(a.kind!=='design-worktree' && head!==base) throw new Error('模块分支含未集成成果，禁止开启下一条');
     const resource=this.db.query<{port:number},[string]>('SELECT port FROM workspace_runtime_resources WHERE attempt_id=? AND node_run_id=0').get(a.id);
     if(!resource) throw new Error('未能分配独立运行端口');
     for(const path of Object.values(workspaceEnvironment(a.cwd,a.id,resource.port)).filter(v=>v.startsWith(a.cwd)&&!v.endsWith('.db')&&!v.endsWith('/admin-token'))) await driver.mkdirp(path);
     const excludes=await this.git(driver,a.cwd,['rev-parse','--git-path','info/exclude']);
     const excludePath=posix.isAbsolute(excludes)?excludes:posix.join(a.cwd,excludes);
     await this.repoOperation(project,'exclude-runtime',async()=>{
       const old=await driver.readFileRange(excludePath,0,65536).catch(()=>null);
       const content=old?new TextDecoder().decode(old.data):'';
       if(content.includes('/.panda/tmp/') && content.includes('/.worktrees/') && content.includes('\nnode_modules/\n'))return;
       if(!driver.replaceFileNoFollowWithin || (old && old.data.length>=65536))throw new Error('无法安全更新运行目录排除规则');
       const result=await driver.replaceFileNoFollowWithin(posix.dirname(excludePath),posix.basename(excludePath),new TextEncoder().encode(content+'\n/.panda/tmp/\n/.worktrees/\nnode_modules/\n'),old?createHash('sha256').update(old.data).digest('hex'):null);
       if(result==='conflict')throw new Error('Git 排除规则已变化，请保留现场后重试');
     });
     this.db.query("UPDATE workspace_attempts SET phase='prepared',updated_ts=? WHERE id=?").run(Date.now(),a.id);
     await this.projectDocuments(issue,project,a);
     await this.prepareEnvironment(issue,project,a);
     this.db.query("UPDATE workspace_attempts SET base_sha=?,phase='ready',updated_ts=? WHERE id=?").run(head,Date.now(),a.id);
     this.db.query("UPDATE module_workspaces SET lifecycle='ready',diagnostic=NULL,updated_ts=? WHERE id=?").run(Date.now(),a.workspace_id);
   });
 }
 private async prepareEnvironment(issue:EngineIssue,project:Project,a:WorkspaceAttempt):Promise<void> {
   try {
     await prepareDependencies(this.deps.driverForProject(project),a.cwd,this.environment(issue.id,a.cwd));
     this.db.query('UPDATE workspace_attempts SET diagnostic=NULL WHERE id=?').run(a.id);
   } catch(error) {
     this.db.query('UPDATE workspace_attempts SET diagnostic=? WHERE id=?').run(String(error).slice(-2000),a.id);
     throw error;
   }
 }
 private async projectDocuments(issue:EngineIssue,project:Project,a:WorkspaceAttempt):Promise<void> {
   const driver=this.deps.driverForProject(project);
   if(!driver.writeFileNoFollowWithin) throw new Error('执行机不支持安全工作区文档写入');
   const module=issue.moduleId ? this.db.query<{slug:string;display_name:string},[number]>('SELECT slug,display_name FROM project_modules WHERE id=?').get(issue.moduleId) : null;
   const path=issue.docPath??moduleIssueRelPath(module?.slug??'unclassified',issue.id,issue.title);
   const files=[{path, fallback:`# #${issue.id} ${issue.title}\n\n## 原始需求\n\n${issue.body??''}\n\n<!-- panda:issue-meta:start -->\n${issueMetaProjection(this.db,issue.id)}\n<!-- panda:issue-meta:end -->\n`}];
   if(module) files.push({path:`.panda/modules/${module.slug}/MODULE.md`,fallback:`# ${module.display_name}\n\n<!-- panda:module-meta:start -->\n${moduleMetaProjection(this.db,issue.moduleId!)}\n<!-- panda:module-meta:end -->\n`});
   files.push({path:'.panda/modules/INDEX.md',fallback:'# 项目模块索引\n\n'+this.db.query<{slug:string;display_name:string},[number]>('SELECT slug,display_name FROM project_modules WHERE project_id=? ORDER BY id').all(project.id).map(m=>`- [${m.display_name}](${m.slug}/MODULE.md)`).join('\n')+'\n'});
   for(const file of files) {
     if(await driver.statPath(posix.join(a.cwd,file.path))) continue;
     const source=await driver.readFileNoFollowWithin?.(project.cwd,file.path,8*1024*1024).catch(()=>null);
     const result=await driver.writeFileNoFollowWithin(a.cwd,file.path,source?.data??file.fallback);
     if(result==='conflict') throw new Error('工作区文档发生并发修改，保留原文');
   }
 }
 async conversationFor(issue:EngineIssue,workspace:EngineExecutionWorkspace):Promise<Conversation> {
   if(workspace.kind!=='module-worktree') return this.deps.legacy.conversationFor(issue,workspace);
   const a=this.attempt(issue.id)!;this.assertOwned(a);
   if(a.kind==='design-worktree' && a.execution_run_id) await this.deps.legacy.conversationFor(issue,{cwd:a.cwd,branch:a.branch,kind:'design-worktree',runId:a.execution_run_id});
   const id=a.conversation_id??randomUUID();
   const conv=this.deps.conversations.createInWorkspaceWithId(id,issue.projectId,`module:${issue.moduleId??0}`,issue.agent,a.cwd);
   this.db.query('UPDATE workspace_attempts SET conversation_id=? WHERE id=? AND conversation_id IS NULL').run(id,a.id);
   const actual=this.attempt(issue.id)!;
   if(actual.conversation_id!==id) throw new Error('工作区会话被并发修改');
   if(a.kind==='design-worktree' && a.execution_run_id) this.db.query('UPDATE design_run_conversations SET conversation_id=?,updated_ts=? WHERE run_id=? AND module_key=?').run(id,Date.now(),a.execution_run_id,issue.moduleId===null?`unassigned:${issue.agent}`:`module:${issue.moduleId}`);
   return conv;
 }
 async recordResult(issue:EngineIssue,workspace:EngineExecutionWorkspace,summary:string):Promise<void> {
   const a=this.attempt(issue.id);
   if(a?.kind==='design-worktree' && a.execution_run_id) await this.deps.legacy.recordResult?.(issue,{cwd:a.cwd,branch:a.branch,kind:'design-worktree',runId:a.execution_run_id},summary);
   else if(workspace.kind!=='module-worktree') await this.deps.legacy.recordResult?.(issue,workspace,summary);
 }
 environment(issueId:IssueId,cwd?:string):Record<string,string> {
   const a=this.attempt(issueId);if(!a) return {};
   this.assertOwned(a);
   const r=this.db.query<{port:number},[string]>('SELECT port FROM workspace_runtime_resources WHERE attempt_id=? AND node_run_id=0').get(a.id);
   if(!r) throw new Error('运行资源记录缺失');
   return workspaceEnvironment(cwd??a.cwd,a.id,r.port);
 }
 async stop(issue:EngineIssue,project:Project,force=false):Promise<void> {
   const a=this.attempt(issue.id);if(!a||a.stop_confirmed&&!force) return;
   this.assertOwned(a);
   const driver=this.deps.driverForProject(project);
   if(force || a.conversation_id || this.db.query('SELECT 1 FROM issue_workflows WHERE issue_id=?').get(issue.id)) {
     if(!driver.stopSessionConfirmed) throw new Error('执行机不支持确认进程停止，工作区继续保留');
     const session=worktreeTmux(project.id,a.conversation_id??a.id);
     const children=this.db.query<{conversation_id:string},[string]>(`SELECT n.conversation_id FROM issue_workflow_node_runs n JOIN issue_workflows f ON f.id=n.issue_workflow_id WHERE f.issue_id=? AND n.conversation_id IS NOT NULL`).all(issue.id).map(n=>chatTmux(n.conversation_id));
     const resolutions=this.db.query<{resolution_conversation_id:string},[string]>(`SELECT t.resolution_conversation_id FROM issue_workflow_worktrees t JOIN issue_workflows f ON f.id=t.issue_workflow_id WHERE f.issue_id=? AND t.resolution_conversation_id IS NOT NULL`).all(issue.id).map(n=>chatTmux(n.resolution_conversation_id));
     const sessions=[...new Set([session,...children,...resolutions])].sort();
     const stop=async(index:number):Promise<void>=> index<sessions.length
       ? this.deps.mutex.runExclusive(tmuxLockKey(sessions[index]!),()=>stop(index+1))
       : driver.stopSessionConfirmed!(session,a.id,a.executor_start_ts);
     await stop(0);
   }
   this.db.query('UPDATE workspace_attempts SET stop_confirmed=1,compute_held=0,updated_ts=? WHERE id=?').run(Date.now(),a.id);
 }
 async commit(issue:EngineIssue,project:Project,locked=false):Promise<void> {
   const a=this.attempt(issue.id)!;
   if(!locked)return this.deps.mutex.runExclusive(`workspace-git:${a.workspace_id}`,()=>this.commit(issue,project,true));this.assertOwned(a);
   if(a.result_sha) return;
   await this.stop(issue,project);
   const driver=this.deps.driverForProject(project);
   await this.operation(`workspace:${a.workspace_id}`,'commit',async()=>{
     this.assertOwned(a);
     await this.assertLocation(project,a.cwd,a.branch);
     await this.git(driver,a.cwd,['add','-A']);
     const staged=await driver.git(a.cwd,['diff','--cached','--quiet']);
     if(staged.code===1) await this.git(driver,a.cwd,['commit','-m',`${issue.title.slice(0,120)} (#${issue.id})`]);
     else if(staged.code!==0) throw new Error('无法确认暂存区');
     const sha=await this.git(driver,a.cwd,['rev-parse','HEAD']);
     await this.repoOperation(project,'retain-result',()=>this.git(driver,a.cwd,['update-ref',`refs/panda/results/${a.id}`,sha]));
     this.db.query("UPDATE workspace_attempts SET result_sha=?,phase='integrating',compute_held=0,updated_ts=? WHERE id=? AND result_sha IS NULL").run(sha,Date.now(),a.id);
   });
 }
 async integrate(issue:EngineIssue,project:Project,validate:(cwd:string)=>Promise<boolean>):Promise<{done:boolean;reason?:string}> {
   const a=this.attempt(issue.id)!;this.assertOwned(a);
   if(a.integrated_sha) return {done:true};
   if(!a.result_sha) await this.commit(issue,project);
   const fresh=this.attempt(issue.id)!;
   const driver=this.deps.driverForProject(project), target=await this.target(project);
   const targetRef=`refs/heads/${target}`;
   const tip=await this.git(driver,project.cwd,['rev-parse',targetRef]);
   // 只有已验证候选的发布记录可以用于崩溃恢复；成果的祖先关系本身不是验证证据。
   const published=this.db.query<{candidate_sha:string},[string]>("SELECT candidate_sha FROM workspace_integrations WHERE attempt_id=? AND candidate_sha IS NOT NULL AND phase IN ('validated','published') ORDER BY created_ts DESC").all(a.id);
   let recovered:string|undefined;
   for(const record of published) if((await driver.git(project.cwd,['merge-base','--is-ancestor',record.candidate_sha,tip])).code===0) {recovered=record.candidate_sha;break;}
   if(recovered) {
     this.db.query("UPDATE workspace_attempts SET integrated_sha=?,phase='integrated',updated_ts=? WHERE id=?").run(recovered,Date.now(),a.id);
     return {done:true};
   }
   const id=randomUUID();
   this.db.query(`INSERT OR IGNORE INTO workspace_integrations(id,attempt_id,target_sha,result_sha,cwd,created_ts,updated_ts) VALUES(?,?,?,?,?,?,?)`)
     .run(id,a.id,tip,fresh.result_sha!,posix.join(this.root(project),'integration',id),Date.now(),Date.now());
   let job=this.db.query<Integration,[string,string,string]>('SELECT * FROM workspace_integrations WHERE attempt_id=? AND target_sha=? AND result_sha=?').get(a.id,tip,fresh.result_sha!)!;
   return this.operation(`integration:${job.id}`,'integrate',async()=>{
     this.assertOwned(a);
     const status=(phase:string,diagnostic:string|null=null)=>{
       this.db.query('UPDATE workspace_integrations SET phase=?,diagnostic=?,updated_ts=? WHERE id=?').run(phase,diagnostic,Date.now(),job.id);
       this.db.query('UPDATE workspace_attempts SET diagnostic=?,updated_ts=? WHERE id=?').run(diagnostic,Date.now(),a.id);
     };
     if(job.phase==='reserved') {
       const entries=await this.git(driver,project.cwd,['worktree','list','--porcelain']);
       if(!entries.split('\n').includes(`worktree ${job.cwd}`)) {
         if(await driver.statPath(job.cwd)) throw new Error('集成候选目录已存在，禁止覆盖');
         await driver.mkdirp(posix.dirname(job.cwd));
         await this.repoOperation(project,'create-candidate',()=>this.git(driver,project.cwd,['worktree','add','--detach',job.cwd,tip]));
       }
       status('merging');job={...job,phase:'merging'};
     }
     await this.assertLocation(project,job.cwd);
     if(job.phase==='merging'||job.phase==='conflict') {
       const unmerged=await this.git(driver,job.cwd,['diff','--name-only','--diff-filter=U']);
       if(unmerged) {status('conflict','集成冲突，现场已保留');return {done:false,reason:'集成冲突，现场已保留'};}
       const mergeHead=await driver.git(job.cwd,['rev-parse','--verify','MERGE_HEAD']);
       if(mergeHead.code===0) {
         await this.git(driver,job.cwd,['commit','--no-edit']);
       } else {
         try {await this.git(driver,job.cwd,['merge','--no-ff','--no-edit',fresh.result_sha!]);}
         catch(e) {if(e instanceof WorkspaceOperationUncertain)throw e;status('conflict',String(e).slice(0,500));return {done:false,reason:'集成冲突或合并失败，现场已保留'};}
       }
       const candidate=await this.git(driver,job.cwd,['rev-parse','HEAD']);
       if((await driver.git(job.cwd,['merge-base','--is-ancestor',fresh.result_sha!,candidate])).code!==0) throw new Error('候选未包含固定成果');
       this.db.query("UPDATE workspace_integrations SET candidate_sha=?,phase='validating' WHERE id=?").run(candidate,job.id);
       job={...job,candidate_sha:candidate,phase:'validating'};
     }
     if(job.phase==='validating'||job.phase==='validation_failed') {
       for(const path of Object.values(this.environment(issue.id,job.cwd)).filter(v=>v.startsWith(job.cwd)&&!v.endsWith('.db')&&!v.endsWith('/admin-token'))) await driver.mkdirp(path);
       this.db.query('UPDATE workspace_attempts SET stop_confirmed=0 WHERE id=?').run(a.id);
       let valid=false;
       try {
         await this.prepareEnvironment(issue,project,{...a,cwd:job.cwd});
         valid=await validate(job.cwd);
       } finally {await this.stop(issue,project,true);}
       if(!valid) {status('validation_failed','集成候选验证未通过');return {done:false,reason:'集成候选验证未通过'};}
       if(await this.git(driver,job.cwd,['rev-parse','HEAD'])!==job.candidate_sha || await this.git(driver,job.cwd,['status','--porcelain','--untracked-files=no'])) {
         status('validation_failed','验证期间候选内容发生变化');return {done:false,reason:'验证期间候选内容发生变化'};
       }
       status('validated');job={...job,phase:'validated'};
     }
     return this.repoOperation(project,'publish-candidate',async()=>{
       this.assertOwned(a);
       const now=await this.git(driver,project.cwd,['rev-parse',targetRef]);
       if(now!==tip) {status('superseded','目标分支已前进，重新构建并验证');return {done:false,reason:'目标分支已前进，重新构建并验证'};}
       const trees=await this.git(driver,project.cwd,['worktree','list','--porcelain']);
       if(trees.split('\n').includes(`branch ${targetRef}`)) {status('validated','目标分支正在其它工作区检出，等待释放');return {done:false,reason:'目标分支正在其它工作区检出，等待释放'};}
       if(job.phase!=='validated'||!job.candidate_sha) return {done:false,reason:'候选尚未验证'};
       await this.git(driver,project.cwd,['update-ref',targetRef,job.candidate_sha,tip]);
       status('published');
       this.db.query("UPDATE workspace_attempts SET integrated_sha=?,phase='integrated',diagnostic=NULL,updated_ts=? WHERE id=?").run(job.candidate_sha,Date.now(),a.id);
       return {done:true};
     });
   });
 }
 async release(issue:EngineIssue,project:Project):Promise<void> {
   const a=this.attempt(issue.id);if(!a||a.released_ts!==null) return;
   await this.operation(`workspace:${a.workspace_id}`,'release',()=>this.deps.mutex.runExclusive(`workspace-git:${a.workspace_id}`,async()=>{
   if(this.attempt(issue.id)?.released_ts!==null)return;
   this.assertOwned(a);
   const current=this.db.query<{status:string},[string]>('SELECT status FROM issues WHERE id=?').get(issue.id);
   if(!current)throw new Error('任务已不存在，禁止释放');
   await this.stop(issue,project,current.status==='cancelled');
   if(!a.integrated_sha) {
     this.compute(issue.id,false);
     if(current.status!=='cancelled'||a.result_sha||a.kind==='design-worktree')return;
   }
   const driver=this.deps.driverForProject(project);
   await this.assertLocation(project,a.cwd,a.branch);
   if(await this.git(driver,a.cwd,['status','--porcelain'])) {
     if(!a.integrated_sha)return; // Never discard cancelled work, including untracked files.
     throw new Error('工作区仍有改动，禁止释放');
   }
   if(!a.integrated_sha) {
     const head=await this.git(driver,a.cwd,['rev-parse','HEAD']);
     const target=await this.git(driver,project.cwd,['rev-parse',`refs/heads/${await this.target(project)}`]);
     if(await this.git(driver,a.cwd,['merge-base',head,target])!==head)return;
   }
   this.db.transaction(()=>{
     this.assertOwned(a);
     const fresh=this.db.query<{status:string;result_sha:string|null},[string]>(`SELECT i.status,a.result_sha FROM issues i
       JOIN workspace_attempts a ON a.issue_id=i.id AND a.id=?`).get(a.id);
     if(!fresh||fresh.status!==current.status||fresh.result_sha!==a.result_sha)throw new Error('任务状态或成果已变化，保留现场');
     this.db.query("UPDATE workspace_attempts SET released_ts=?,phase='released',compute_held=0 WHERE id=?").run(Date.now(),a.id);
     this.db.query("UPDATE module_workspaces SET current_attempt=NULL,lifecycle='idle',updated_ts=? WHERE id=? AND current_attempt=?").run(Date.now(),a.workspace_id,a.id);
     // 保留节点与旧轮次的绑定；负数只作归档标记，不继续占用可分配端口。
     this.db.query('UPDATE workspace_runtime_resources SET port=-rowid WHERE attempt_id=?').run(a.id);
     if(!a.integrated_sha)this.db.query('INSERT INTO issue_events(issue_id,kind,data_json,ts) VALUES(?,?,?,?)')
       .run(issue.id,'workspace_released',JSON.stringify({attempt:a.id,reason:'cancelled-clean'}),Date.now());
   })();
   }));
 }
 async recover(issue:EngineIssue,project:Project):Promise<void> {
   const a=this.attempt(issue.id);if(!a)return;
   this.assertOwned(a);
   const driver=this.deps.driverForProject(project);
   const locks=this.db.query<{resource:string;token:string;owner_pid:number},never[]>('SELECT resource,token,owner_pid FROM workspace_operations').all()
     .filter(r=>r.resource===`workspace:${a.workspace_id}`||r.resource===`workspace-repository:${project.executorId}:${project.id}`||r.resource.startsWith('integration:')&&Boolean(this.db.query('SELECT 1 FROM workspace_integrations WHERE id=? AND attempt_id=?').get(r.resource.slice(12),a.id)));
   for(const lock of locks) {
     if(this.deps.mutex.isLocked(lock.resource))throw new Error('执行机操作仍在进行，不能接管');
     if(lock.owner_pid!==process.pid) {
       try {process.kill(lock.owner_pid,0);throw new Error('原控制进程仍存活，不能接管');}
       catch(e) {if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;}
     }
     // A surviving Git process owns this executor-side lock until it actually exits.
     await this.git(driver,project.cwd,['rev-parse','HEAD']);
     this.db.query('DELETE FROM workspace_operations WHERE resource=? AND token=?').run(lock.resource,lock.token);
   }
   this.db.query('UPDATE workspace_attempts SET diagnostic=NULL WHERE id=?').run(a.id);
   await this.resolve(issue,project);
 }
 async push(issue:EngineIssue,project:Project):Promise<{ok:boolean;detail?:string}> {
   const a=this.attempt(issue.id);if(!a?.integrated_sha) return {ok:false,detail:'尚未集成'};
   const driver=this.deps.driverForProject(project);
   if((await driver.git(project.cwd,['remote','get-url','origin'])).code!==0) return {ok:true};
   try {const r=await driver.git(project.cwd,['push','origin',`${a.integrated_sha}:refs/heads/${await this.target(project)}`]);return r.code===0?{ok:true}:{ok:false,detail:(r.err||r.out).slice(0,500)};}
   catch(e) {return {ok:false,detail:String(e).slice(0,500)};}
 }
}

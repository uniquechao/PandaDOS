import { afterEach, beforeEach, expect, test, setDefaultTimeout } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateDesigns } from '../designs/store';
import { migrateIssueEngine, IssueStore, getProject, IssueEngine } from './engine';
import { ConversationManager } from '../core/conversations';
import { LocalDriver } from '../executor/local';
import { KeyedMutex } from './mutex';
import { ModuleWorkspaceService } from './module-workspaces';
import { release as kernelRelease } from 'node:os';
import { testTmuxDirectory } from '../../scripts/test-tmux';
import { createProjectDataPersistence } from '../web/project-data-persistence';
import { moduleIssueRelPath } from './module-docs';
import { DEPENDENCY_PREPARATION_SCRIPT } from './dependency-preparation';
import { WorkspaceOperationUncertain } from './module-workspaces';

// Several end-to-end Git/engine flows exceed 5s under full-gate CPU contention.
// This changes the fixture ceiling, not operation deadlines or behavior assertions.
setDefaultTimeout(15_000);

class DiagnosticDriver extends LocalDriver {
 readonly commandTrace: Array<Record<string, unknown>> = [];
 private async record<T>(kind:string,cwd:string,args:string[],call:()=>Promise<T>):Promise<T> {
  const entry:Record<string,unknown>={kind,cwd,args:[...args],startedTs:Date.now()};
  this.commandTrace.push(entry);
  try {const result=await call();entry.result=result;return result;}
  catch(error) {entry.error=error instanceof Error?{message:error.message,stack:error.stack}:String(error);throw error;}
  finally {entry.finishedTs=Date.now();}
 }
 override async git(cwd:string,args:string[]) {
  return this.record('git',cwd,args,()=>super.git(cwd,args));
 }
 override async runCommand(cwd:string,argv:string[],timeoutMs:number,env?:Record<string,string>) {
  return this.record('command',cwd,argv,()=>super.runCommand(cwd,argv,timeoutMs,env));
 }
 override async stopSessionConfirmed(session:string,attempt:string,executorStartTs:number) {
  return this.record('stop-confirmed','/',[session,attempt,String(executorStartTs)],()=>super.stopSessionConfirmed(session,attempt,executorStartTs));
 }
}

const cleanup:Array<()=>void>=[];
beforeEach(()=>{
 // 不连接调用者的 tmux，也不继承执行轮次中可能超过 Unix socket 长度限制的目录。
 mkdirSync('.private',{recursive:true});
 const tmuxDir=mkdtempSync(process.cwd()+'/.private/tm-');
 const previous={TMUX:process.env.TMUX,TMUX_TMPDIR:process.env.TMUX_TMPDIR};
 delete process.env.TMUX;
 process.env.TMUX_TMPDIR=tmuxDir;
 cleanup.push(()=>{
  for(const [key,value] of Object.entries(previous)) {
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  rmSync(tmuxDir,{recursive:true,force:true});
 });
});
afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn();});
async function setup(diagnostics=false) {
 // A test's socket must fit sun_path even when the source worktree has a UUID path.
 const socketRoot=testTmuxDirectory();
 const previousSocket={TMUX:process.env.TMUX,TMUX_TMPDIR:process.env.TMUX_TMPDIR};
 delete process.env.TMUX;process.env.TMUX_TMPDIR=socketRoot;
 cleanup.push(()=>{
  for(const [key,value] of Object.entries(previousSocket)) {
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  rmSync(socketRoot,{recursive:true,force:true});
 });
 mkdirSync('.private/workspace-tests',{recursive:true});
 const root=mkdtempSync(process.cwd()+'/.private/workspace-tests/run-');
 let preserve=false;
 cleanup.push(()=>{if(!preserve)rmSync(root,{recursive:true,force:true});});
 const repo=root+'/repo';mkdirSync(repo);
 const db=openDb(':memory:');cleanup.push(()=>db.close());migrate(db);migrateIssueEngine(db);migrateDesigns(db);
 db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'owner','x','admin',1)");
 db.query("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','localhost','local','x',?,'/unused')").run(root+'/work');
 db.query("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'test',1,?,1,1)").run(repo);
 for(let id=1;id<=4;id++) db.query("INSERT INTO project_modules(id,project_id,slug,display_name,agent,source,created_ts) VALUES(?,1,?,?,'codex','manual',1)").run(id,`m${id}`,`模块${id}`);
 const driver=diagnostics?new DiagnosticDriver():new LocalDriver();
 async function git(cwd:string,args:string[]) {const r=await driver.git(cwd,args);if(r.code)throw new Error(r.err);return r.out.trim();}
 await git(repo,['init','-b','main']);await git(repo,['config','user.name','test']);await git(repo,['config','user.email','test@example.invalid']);
 writeFileSync(repo+'/same.txt','base\n');await git(repo,['add','.']);await git(repo,['commit','-m','base']);
 const project=getProject(db,1)!;const store=new IssueStore(db);
 const conversations=new ConversationManager(db,driver,{locate:async()=>null});
 const legacy={resolve:()=>({cwd:repo,kind:'project' as const,branch:null,runId:null}),conversationFor:async()=>{throw new Error('unexpected');}};
 const deps={db,mutex:new KeyedMutex(),driverForProject:()=>driver,projectForId:(id:number)=>getProject(db,id),legacy,conversations};
 const service=new ModuleWorkspaceService(deps);
 const issue=(moduleId:number)=>store.create(1,{title:'工作区回归',moduleId,agent:'codex',executionMode:'direct'});
 async function captureFailure(fn:()=>Promise<void>):Promise<void> {
  try {await fn();}
  catch(error) {
   preserve=true;
   try {
    const environment=Object.fromEntries(['PATH','HOME','LANG','TZ','TMPDIR','TMUX_TMPDIR','PANDA_WORKSPACE_ATTEMPT','PANDA_DATA_DIR','PANDA_DB','PANDA_DB_PATH','PANDA_PORT'].map(key=>[key,process.env[key]??null]));
    const state=Object.fromEntries(['module_workspaces','workspace_attempts','workspace_integrations','workspace_operations','workspace_runtime_resources'].map(table=>[table,db.query(`SELECT * FROM ${table}`).all()]));
    writeFileSync(root+'/failure.json',JSON.stringify({error:error instanceof Error?{message:error.message,stack:error.stack}:String(error),environment,runtime:{bun:Bun.version,kernel:kernelRelease(),pid:process.pid},state,commands:driver instanceof DiagnosticDriver?driver.commandTrace:[]},null,2),{mode:0o600});
    console.error('工作区测试失败现场已保留：'+root+'/failure.json');
   } catch(diagnosticError) {
    console.error('工作区测试诊断写入失败，原现场仍保留：'+root,diagnosticError);
   }
   throw error;
  }
 }
 return {root,repo,db,driver,git,project,store,service,issue,deps,captureFailure};
}

test('explicit incident branch alignment preserves changes and never resumes or rewrites frozen results',async()=>{
 const s=await setup();const issue=s.issue(1);
 const workspace=await s.service.resolve(issue,s.project);const a=s.service.attempt(issue.id)!;
 const sha=await s.git(workspace.cwd,['rev-parse','HEAD']);
 await s.git(workspace.cwd,['switch','-c','manual-prototype']);
 // Retained process docs may be untracked; the action must refuse rather than discard them.
 const dirty=await s.git(workspace.cwd,['status','--porcelain']);
 if(dirty)await s.git(workspace.cwd,['add','.']);
 if(dirty)await s.git(workspace.cwd,['commit','-m','preserve process documents']);
 const head=await s.git(workspace.cwd,['rev-parse','HEAD']);
 if(head!==sha)await s.git(s.repo,['update-ref',`refs/heads/${a.branch}`,head,sha]);
 writeFileSync(workspace.cwd+'/human.txt','retained');
 await expect(s.service.incidentRepair(issue,s.project,'branch',head)).rejects.toThrow('未提交改动');
 expect(readFileSync(workspace.cwd+'/human.txt','utf8')).toBe('retained');
 await s.git(workspace.cwd,['add','human.txt']);await s.git(workspace.cwd,['commit','-m','human work']);
 const newest=await s.git(workspace.cwd,['rev-parse','HEAD']);await s.git(s.repo,['update-ref',`refs/heads/${a.branch}`,newest,head]);
 await s.service.incidentRepair(issue,s.project,'branch',newest);
 expect(await s.git(workspace.cwd,['branch','--show-current'])).toBe(a.branch);
 expect(s.store.get(issue.id)?.status).toBe('pending');
 s.db.query("UPDATE workspace_attempts SET result_sha=? WHERE id=?").run(newest,a.id);
 await expect(s.service.incidentRepair(issue,s.project,'branch',newest)).rejects.toThrow('固定成果');
});

test('disconnected incident dependency preparation retains both ownership receipts until explicit physical verification',async()=>{
 const s=await setup();const issue=s.issue(1);const workspace=await s.service.resolve(issue,s.project);
 const head=await s.git(workspace.cwd,['rev-parse','HEAD']);
 const run=s.driver.runCommand.bind(s.driver);
 s.driver.runCommand=async(cwd,argv,timeout,env)=>{
  if(argv[2]===DEPENDENCY_PREPARATION_SCRIPT)throw new Error('SSH connection lost after dispatch');
  return run(cwd,argv,timeout,env);
 };
 await expect(s.service.incidentRepair(issue,s.project,'environment',head)).rejects.toBeInstanceOf(WorkspaceOperationUncertain);
 expect(s.db.query('SELECT COUNT(*) n FROM workspace_operations').get()).toMatchObject({n:2});
 s.driver.runCommand=run;
 await s.service.incidentRepair(issue,s.project,'verify',head);
 expect(s.db.query('SELECT COUNT(*) n FROM workspace_operations').get()).toMatchObject({n:0});
 expect(await s.git(workspace.cwd,['rev-parse','HEAD'])).toBe(head);
});

test('准备期间过程页回写不能污染新 worktree，准备完成后再投影执行目录',async()=>{
 const s=await setup(),a=s.issue(1);
 s.db.run('DELETE FROM project_data_outbox');
 const outbox=createProjectDataPersistence(s.db,()=>s.driver,s.deps.mutex);
 outbox.enqueue(1,'issue',a.id,'upsert');
 const original=s.driver.runCommand.bind(s.driver);
 let projected=false;
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>{
  if(!projected&&cwd!==s.repo&&argv.includes('status')&&argv.includes('--porcelain')) {
   projected=true;
   expect((await outbox.drain()).failed).toBe(0);
  }
  return original(cwd,argv,timeoutMs,env);
 };
 const w=await s.service.resolve(a,s.project);
 expect(projected).toBe(true);
 expect(s.service.attempt(a.id)?.phase).toBe('ready');
 const doc=moduleIssueRelPath('m1',a.id,a.title);
 expect(readFileSync(s.repo+'/'+doc,'utf8')).toContain(a.title);
 expect(readFileSync(w.cwd+'/'+doc,'utf8')).toContain(a.title);
 s.db.query("UPDATE issues SET status='implementing' WHERE id=?").run(a.id);
 expect((await outbox.drain()).failed).toBe(0);
 expect(readFileSync(w.cwd+'/'+doc,'utf8')).toContain('status: implementing');
 expect(readFileSync(s.repo+'/'+doc,'utf8')).toContain('status: pending');
});

test('准备期间真实代码改动仍阻止开工并原样保留',async()=>{
 const s=await setup(),a=s.issue(1);
 const original=s.driver.runCommand.bind(s.driver);
 let touched:string|undefined;
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>{
  if(!touched&&cwd!==s.repo&&argv.includes('status')&&argv.includes('--porcelain')) {
   touched=cwd;writeFileSync(cwd+'/same.txt','用户未保存的代码\n');
  }
  return original(cwd,argv,timeoutMs,env);
 };
 const failure=await s.service.resolve(a,s.project).then(()=>null,error=>error);
 expect(failure).toBeInstanceOf(Error);
 expect(failure.message).toContain('工作区有未保存改动');
 expect(failure.message).toContain('same.txt');
 expect(readFileSync(touched!+'/same.txt','utf8')).toBe('用户未保存的代码\n');
 expect(s.service.attempt(a.id)?.phase).toBe('preparing');
});

test('真实 Git：同模块复用、跨模块并发及主目录脏文件保持原样',async()=>{
 const s=await setup(true);const a=s.issue(1),a2=s.issue(1),b=s.issue(2),c=s.issue(3);
 await s.captureFailure(async()=>{
 writeFileSync(s.repo+'/user.txt','保留用户修改');
 // 失败也等待两个写者结束，再取证和关闭数据库，避免清理与另一模块创建重叠。
 const [ra,rb]=await Promise.allSettled([s.service.resolve(a,s.project),s.service.resolve(b,s.project)]);
 if(ra.status==='rejected')throw ra.reason;
 if(rb.status==='rejected')throw rb.reason;
 const wa=ra.value,wb=rb.value;
 expect(wa.cwd).not.toBe(wb.cwd);expect(s.service.canStart(a2,[a,b])).toBe(false);expect(s.service.canStart(c,[a,b])).toBe(false);
 writeFileSync(wa.cwd+'/a.txt','A1');writeFileSync(wb.cwd+'/b.txt','B');
 await s.service.commit(a,s.project);
 expect((await s.service.integrate(a,s.project,async()=>true)).reason).toContain('检出');
 expect(readFileSync(s.repo+'/user.txt','utf8')).toBe('保留用户修改');
 await s.git(s.repo,['checkout','--detach']);
 expect((await s.service.integrate(a,s.project,async()=>true)).done).toBe(true);
 await s.service.release(a,s.project);
 const wa2=await s.service.resolve(a2,s.project);
 expect(wa2.cwd).toBe(wa.cwd);expect(wa2.branch).toBe(wa.branch);expect(readFileSync(wa2.cwd+'/a.txt','utf8')).toBe('A1');
 expect(s.service.attempt(a2.id)?.base_sha).toBe(s.service.attempt(a.id)?.integrated_sha);
 expect(readFileSync(s.repo+'/user.txt','utf8')).toBe('保留用户修改');
 });
});

test('真实 Git：目标前进使旧验证失效，冲突现场不阻塞其它模块集成',async()=>{
 const s=await setup(true);const a=s.issue(1),b=s.issue(2),c=s.issue(3);
 await s.captureFailure(async()=>{
 const wa=await s.service.resolve(a,s.project),wb=await s.service.resolve(b,s.project);
 writeFileSync(wa.cwd+'/same.txt','A\n');writeFileSync(wb.cwd+'/same.txt','B\n');
 await s.service.commit(a,s.project);await s.service.commit(b,s.project);await s.git(s.repo,['checkout','--detach']);
 let validations=0;
 const first=await s.service.integrate(b,s.project,async()=>{validations++;await s.service.integrate(a,s.project,async()=>true);return true;});
 expect(first.done).toBe(false);expect(first.reason).toContain('前进');
 expect((await s.service.integrate(b,s.project,async()=>{validations++;return true;})).done).toBe(false);
 expect(validations).toBe(1);
 const conflict=s.db.query<{cwd:string},[string]>("SELECT cwd FROM workspace_integrations WHERE attempt_id=? AND phase='conflict'").get(s.service.attempt(b.id)!.id)!;
 expect((await s.git(conflict.cwd,['diff','--name-only','--diff-filter=U']))).toBe('same.txt');
 await s.service.release(a,s.project);
 const wc=await s.service.resolve(c,s.project);writeFileSync(wc.cwd+'/c.txt','C');await s.service.commit(c,s.project);
 expect((await s.service.integrate(c,s.project,async()=>true)).done).toBe(true);
 expect(await s.git(conflict.cwd,['diff','--name-only','--diff-filter=U'])).toBe('same.txt');
 });
});

test('持久占用：暂停释放名额但不释放模块；重建服务沿用轮次并拒绝陈旧占用',async()=>{
 const s=await setup();const a=s.issue(1),a2=s.issue(1),b=s.issue(2),c=s.issue(3);
 const wa=await s.service.resolve(a,s.project);await s.service.resolve(b,s.project);
 s.service.compute(a.id,false);expect(s.service.canStart(c,[a,b])).toBe(true);expect(s.service.canStart(a2,[a,b])).toBe(false);
 const resumed=new ModuleWorkspaceService(s.deps);expect(await resumed.resolve(a,s.project)).toEqual(wa);
 const stale=s.service.attempt(a.id)!;
 s.db.query('UPDATE module_workspaces SET current_attempt=NULL WHERE id=?').run(stale.workspace_id);
 expect(()=>resumed.assertOwned(stale)).toThrow('失效');
});

test('真实 Git：重复提交与重复发布幂等，归属范围不包含其它模块成果',async()=>{
 const s=await setup();const a=s.issue(1),b=s.issue(2);
 const wa=await s.service.resolve(a,s.project),wb=await s.service.resolve(b,s.project);
 writeFileSync(wa.cwd+'/a','A');writeFileSync(wb.cwd+'/b','B');
 await s.service.commit(a,s.project);const sha=s.service.attempt(a.id)!.result_sha;
 await s.service.commit(a,s.project);expect(s.service.attempt(a.id)!.result_sha).toBe(sha);
 await s.git(s.repo,['checkout','--detach']);
 let validations=0;await s.service.integrate(a,s.project,async()=>{validations++;return true;});
 await new ModuleWorkspaceService(s.deps).integrate(a,s.project,async()=>{validations++;return true;});
 expect(validations).toBe(1);
 const files=(await s.git(wa.cwd,['diff','--name-only',`${s.service.attempt(a.id)!.base_sha}..${sha}`])).split('\n');
 expect(files.filter(f=>!f.startsWith('.panda/'))).toEqual(['a']);
 expect(files.some(f=>f.includes('/m2/'))).toBe(false);
});

test('脏现场和遗失目录不可覆盖；改名不改变稳定路径',async()=>{
 const s=await setup();const a=s.issue(1);const w=await s.service.resolve(a,s.project);
 s.db.query("UPDATE project_modules SET slug='renamed',display_name='改名' WHERE id=1").run();
 expect((await s.service.resolve(a,s.project)).cwd).toBe(w.cwd);
 const b=s.issue(2);const root=s.root+'/work/.panda-worktrees/project-1/module-2';mkdirSync(root,{recursive:true});writeFileSync(root+'/user','不可覆盖');
 await expect(s.service.resolve(b,s.project)).rejects.toThrow('禁止覆盖');expect(readFileSync(root+'/user','utf8')).toBe('不可覆盖');
});

test('恢复和提交拒绝同路径同分支的替换仓库，保留两份现场',async()=>{
 const s=await setup(),a=s.issue(1),w=await s.service.resolve(a,s.project);
 writeFileSync(w.cwd+'/原现场.txt','保留原修改');
 renameSync(w.cwd,w.cwd+'-saved');mkdirSync(w.cwd);
 await s.git(w.cwd,['init','-b',w.branch!]);
 writeFileSync(w.cwd+'/用户文件.txt','替换目录中的用户修改');
 await expect(s.service.resolve(a,s.project)).rejects.toThrow('仓库已被替换');
 await expect(s.service.commit(a,s.project)).rejects.toThrow('仓库已被替换');
 expect(await s.git(w.cwd,['diff','--cached','--name-only'])).toBe('');
 expect(readFileSync(w.cwd+'/用户文件.txt','utf8')).toBe('替换目录中的用户修改');
 expect(readFileSync(w.cwd+'-saved/原现场.txt','utf8')).toBe('保留原修改');
 expect(s.service.held(a.id)).toBe(true);
});

test('引擎接线：两模块同时启动，暂停不释放同模块，完成集成才接力 A2',async()=>{
 const {IssueEngine}=await import('./engine');
 const s=await setup();
 const sessions=new Set<string>(), sent:Array<{session:string;text:string}>=[];
 s.driver.findExecutable=async()=>'/bin/true';
 s.driver.listSessions=async()=>[...sessions].map(name=>({name,createdTs:1,attached:false,command:'codex'}));
 s.driver.createSession=async name=>{sessions.add(name);};s.driver.killSession=async name=>{sessions.delete(name);};
 s.driver.sendKeys=async(session,text)=>{sent.push({session,text});};s.driver.capturePane=async()=> '›';
 s.driver.stopSessionConfirmed=async name=>{sessions.delete(name);};
 await s.service.target(s.project);await s.git(s.repo,['checkout','--detach']);
 const engine=new IssueEngine({db:s.db,driver:s.driver,convs:s.deps.conversations,locator:{locate:async()=>null},
  executionWorkspaces:s.service,moduleWorkspaces:s.service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},
  config:{resultSummaryTimeoutMs:0,validationTimeoutMs:0,autoMerge:false,kickoffMinBootMs:0}});
 const a=s.issue(1),a2=s.issue(1),b=s.issue(2),dependent=s.issue(3);
 s.store.addDependency(dependent.id,b.id);
 await engine.scheduleNext(1);
 expect(engine.store.get(a.id)?.status,JSON.stringify(engine.store.listEvents(a.id))).toBe('implementing');expect(engine.store.get(b.id)?.status).toBe('implementing');
 expect(engine.store.get(a2.id)?.status).toBe('pending');expect(sessions.size).toBe(2);
 const aw=s.service.attempt(a.id)!,bw=s.service.attempt(b.id)!;
 expect(aw.conversation_id).not.toBe(bw.conversation_id);
 await engine.applyEvent(a.id,'pause',{note:'回归暂停'});
 expect(s.service.attempt(a.id)?.id).toBe(aw.id);expect(s.service.attempt(a.id)?.compute_held).toBe(0);
 expect(engine.store.get(a2.id)?.status).toBe('pending');expect(sessions.size).toBe(2);
 await engine.unblockIssue(a.id,'继续');expect(s.service.attempt(a.id)?.id).toBe(aw.id);
 writeFileSync(aw.cwd+'/a.txt','A');
 await engine.applyEvent(a.id,'impl_done');await engine.applyEvent(a.id,'tests_passed');
 expect(engine.store.get(a.id)?.status).toBe('done');expect(engine.store.get(a2.id)?.status).toBe('implementing');
 expect(s.service.attempt(a2.id)?.cwd).toBe(aw.cwd);expect(readFileSync(aw.cwd+'/a.txt','utf8')).toBe('A');
 expect(engine.store.get(b.id)?.status).toBe('implementing');
 expect(sent.filter(x=>x.session.includes(aw.conversation_id!)).length).toBeGreaterThan(0);
 expect(engine.store.get(dependent.id)?.status).toBe('pending');
 writeFileSync(bw.cwd+'/b.txt','依赖成果');await engine.applyEvent(b.id,'impl_done');await engine.applyEvent(b.id,'tests_passed');
 expect(engine.store.get(dependent.id)?.status).toBe('implementing');expect(readFileSync(s.service.attempt(dependent.id)!.cwd+'/b.txt','utf8')).toBe('依赖成果');
});

test('取消：干净且基线已集成的现场释放后同模块可以接力',async()=>{
 const s=await setup(),a=s.issue(1),next=s.issue(1);
 const w=await s.service.resolve(a,s.project);
 rmSync(w.cwd+'/.panda/modules',{recursive:true,force:true});
 s.db.query("UPDATE issues SET status='cancelled' WHERE id=?").run(a.id);
 await s.service.release(s.store.get(a.id)!,s.project);
 expect(s.service.held(a.id)).toBe(false);
 expect(s.service.attempt(a.id)?.integrated_sha).toBeNull();
 expect(s.store.get(a.id)?.status).toBe('cancelled');
 expect(s.service.canStart(next,[s.store.get(a.id)!,next])).toBe(true);
 expect((await s.service.resolve(next,s.project)).cwd).toBe(w.cwd);
});

test('取消：已提交但未集成的成果仍保留并说明实际占用者',async()=>{
 const s=await setup(),a=s.issue(1),next=s.issue(1);
 const w=await s.service.resolve(a,s.project);
 writeFileSync(w.cwd+'/kept.txt','保留已提交成果');
 await s.git(w.cwd,['add','.']);await s.git(w.cwd,['commit','-m','unmerged work']);
 s.db.query("UPDATE issues SET status='cancelled' WHERE id=?").run(a.id);
 await s.service.release(s.store.get(a.id)!,s.project);
 expect(s.service.held(a.id)).toBe(true);
 expect(s.service.retainedBlocker(next)).toContain(a.id);
 expect(s.service.retainedBlocker(next)).toContain('已取消');
 expect(readFileSync(w.cwd+'/kept.txt','utf8')).toBe('保留已提交成果');
});

test('取消：停止未知时不释放；停止确认后保留脏现场且拒绝下一条接管',async()=>{
 const s=await setup(),a=s.issue(1),next=s.issue(1);
 const w=await s.service.resolve(a,s.project);const conv=await s.service.conversationFor(a,w);s.store.setConv(a.id,conv.id);
 writeFileSync(w.cwd+'/未完成.txt','保留');
 s.driver.stopSessionConfirmed=async()=>{throw new Error('停止未知');};
 await expect(s.service.release(s.store.get(a.id)!,s.project)).rejects.toThrow('停止未知');
 expect(s.service.attempt(a.id)?.stop_confirmed).toBe(0);expect(s.service.canStart(next,[a,next])).toBe(false);
 s.driver.stopSessionConfirmed=async()=>{};await s.service.release(s.store.get(a.id)!,s.project);
 expect(s.service.attempt(a.id)?.stop_confirmed).toBe(1);expect(s.service.held(a.id)).toBe(true);
 expect(readFileSync(w.cwd+'/未完成.txt','utf8')).toBe('保留');expect(s.service.canStart(next,[a,next])).toBe(false);
});

test('崩溃恢复：验证完成后发布已成功但未写回数据库，不再重验或重复合并',async()=>{
 const s=await setup(),a=s.issue(1);await s.service.resolve(a,s.project);await s.service.commit(a,s.project);
 expect((await s.service.integrate(a,s.project,async()=>true)).done).toBe(false);
 const attempt=s.service.attempt(a.id)!;
 const candidate=s.db.query<{candidate_sha:string;target_sha:string},[string]>("SELECT candidate_sha,target_sha FROM workspace_integrations WHERE attempt_id=? AND phase='validated'").get(attempt.id)!;
 await s.git(s.repo,['checkout','--detach']);await s.git(s.repo,['update-ref','refs/heads/main',candidate.candidate_sha,candidate.target_sha]);
 expect((await new ModuleWorkspaceService(s.deps).integrate(a,s.project,async()=>{throw new Error('不得重复验证');})).done).toBe(true);
 expect(s.service.attempt(a.id)?.integrated_sha).toBe(candidate.candidate_sha);
 await s.service.release(a,s.project);
 expect(s.db.query<{n:number},[string]>('SELECT COUNT(*) n FROM workspace_reclamation_jobs WHERE attempt_id=?').get(attempt.id)?.n).toBe(1);
 const old=attempt.id;const reopened=await s.service.resolve(s.store.get(a.id)!,s.project);
 expect(s.service.attempt(a.id)?.id).not.toBe(old);expect(reopened.cwd).toBe(attempt.cwd);
});

test('运行资源：不同模块端口、数据库与临时目录隔离，未分类任务使用独立串行工作区',async()=>{
 const s=await setup(),a=s.issue(1),b=s.issue(2);
 await s.service.resolve(a,s.project);await s.service.resolve(b,s.project);
 const ea=s.service.environment(a.id),eb=s.service.environment(b.id);
 for(const key of ['PORT','PANDA_DB','TMPDIR','PANDA_BUILD_DIR','XDG_CACHE_HOME'])expect(ea[key]).not.toBe(eb[key]);
 s.service.compute(a.id,false);
 const u=s.store.create(1,{title:'未分类一',agent:'codex'}),v=s.store.create(1,{title:'未分类二',agent:'codex'});
 const w=await s.service.resolve(u,s.project);expect(w.cwd.endsWith('/module-0')).toBe(true);expect(s.service.canStart(v,[u,v])).toBe(false);
});

test('设计专用工作区纳入同一占用，普通任务后续仍使用模块固定目录',async()=>{
 const s=await setup(),a=s.issue(1),b=s.issue(2),next=s.issue(1);
 const cwd=s.root+'/design';await s.git(s.repo,['worktree','add','-b','design-test',cwd]);
 const special={cwd,kind:'design-worktree' as const,branch:'design-test',runId:'test-design'};
 const service=new ModuleWorkspaceService({...s.deps,legacy:{...s.deps.legacy,resolve:issue=>issue.id===next.id?s.deps.legacy.resolve():special}});
 expect((await service.resolve(a,s.project)).cwd).toBe(cwd);
 await expect(service.resolve(b,s.project)).rejects.toThrow();
 writeFileSync(cwd+'/design.txt','设计成果');await service.commit(a,s.project);await s.git(s.repo,['checkout','--detach']);
 expect((await service.integrate(a,s.project,async()=>true)).done).toBe(true);await service.release(a,s.project);
 const ordinary=await service.resolve(next,s.project);expect(ordinary.cwd).not.toBe(cwd);expect(ordinary.cwd.endsWith('/module-1')).toBe(true);
 expect(readFileSync(ordinary.cwd+'/design.txt','utf8')).toBe('设计成果');
});

test('嵌套工作流使用父轮次标记、独立目录与端口，父轮次停止后拒绝再启动',async()=>{
 const {managedConversationEnvironment}=await import('../core/workspace-ownership');
 const s=await setup(),a=s.issue(1);const w=await s.service.resolve(a,s.project);
 const f=Number(s.db.query("INSERT INTO issue_workflows(issue_id,template_name,template_version,graph_json,graph_hash,context_json,created_ts,updated_ts) VALUES(?,'测试',1,'{}','test','{}',1,1)").run(a.id).lastInsertRowid);
 const environments:Record<string,string>[]=[],nodeConvs:string[]=[];
 for(let n=1;n<=2;n++) {
  const conv=s.deps.conversations.createInWorkspace(1,'节点','codex',w.cwd);nodeConvs.push(conv.id);
  const id=Number(s.db.query("INSERT INTO issue_workflow_node_runs(issue_workflow_id,node_key,token_key,conversation_id,created_ts,updated_ts) VALUES(?,?,?,?,1,1)").run(f,`n${n}`,`t${n}`,conv.id).lastInsertRowid);
  const child=w.cwd+`/.worktrees/node-${n}`;
  s.db.query("INSERT INTO issue_workflow_worktrees(issue_workflow_id,node_run_id,path,branch,base_ref,created_ts,updated_ts) VALUES(?,?,?,?,?,1,1)").run(f,id,child,`node-${n}`,'HEAD');
  const env=managedConversationEnvironment(s.db,conv.id)!;environments.push(env);expect(env.PANDA_WORKSPACE_CWD).toBe(child);expect(env.PANDA_WORKSPACE_ATTEMPT).toBe(s.service.attempt(a.id)!.id);
  s.db.query('UPDATE workspace_attempts SET stop_confirmed=1 WHERE issue_id=?').run(a.id);expect(()=>managedConversationEnvironment(s.db,conv.id)).toThrow('父轮次');s.db.query('UPDATE workspace_attempts SET stop_confirmed=0 WHERE issue_id=?').run(a.id);
 }
 expect(environments[0]!.PORT).not.toBe(environments[1]!.PORT);expect(environments[0]!.PANDA_DB).not.toBe(environments[1]!.PANDA_DB);
 s.db.query('UPDATE workspace_attempts SET released_ts=1 WHERE issue_id=?').run(a.id);
 expect(()=>managedConversationEnvironment(s.db,nodeConvs[0]!)).toThrow('父轮次');
});

test('真实锁文件：干净模块与深层 UUID 候选自动安装，准备失败重启后沿用现场恢复',async()=>{
 const s=await setup(true);
 await s.captureFailure(async()=>{
   mkdirSync(s.repo+'/fixture-dependency');
   writeFileSync(s.repo+'/fixture-dependency/package.json',JSON.stringify({name:'panda-fixture-dependency',version:'1.0.0',main:'index.js'}));
   writeFileSync(s.repo+'/fixture-dependency/index.js','module.exports = 42;\n');
   writeFileSync(s.repo+'/package.json',JSON.stringify({name:'acceptance-fixture',dependencies:{'panda-fixture-dependency':'file:./fixture-dependency'}}));
   writeFileSync(s.repo+'/.gitignore','node_modules/\n.panda/tmp/\n');
   const lock=await s.driver.runCommand(s.repo,['bun','install','--lockfile-only'],30000);
   expect(lock.code).toBe(0);
   await s.git(s.repo,['add','.']);await s.git(s.repo,['commit','-m','锁文件验收夹具']);
   const issue=s.issue(1);
   const run=s.driver.runCommand.bind(s.driver);
   let failed=false;
   s.driver.runCommand=async(cwd,argv,timeout,env)=>{
     if(!failed && argv[0]==='python3' && argv[2]?.includes('receipt.json')) {
       failed=true;
       return {code:1,out:'',err:'环境准备失败：模拟包源暂不可用',timedOut:false,durationMs:1};
     }
     return run(cwd,argv,timeout,env);
   };
   await expect(s.service.resolve(issue,s.project)).rejects.toThrow('依赖环境准备失败');
   const before=s.service.attempt(issue.id)!;
   expect(before.phase).toBe('prepared');expect(before.diagnostic).toContain('包源暂不可用');
   expect(await s.driver.statPath(before.cwd+'/node_modules')).toBeNull();
   writeFileSync(before.cwd+'/retained.txt','准备失败保留现场\n');
   const restarted=new ModuleWorkspaceService(s.deps);
   await restarted.recover(issue,s.project);
   const workspace=await restarted.resolve(issue,s.project);
   expect(restarted.attempt(issue.id)?.id).toBe(before.id);
   expect(readFileSync(workspace.cwd+'/retained.txt','utf8')).toContain('保留现场');
   expect(JSON.parse(readFileSync(workspace.cwd+'/.panda/tmp/dependencies/receipt.json','utf8')).phase).toBe('ready');
   const verify=['bun','-e',"if(require('panda-fixture-dependency')!==42) process.exit(1)"];
   expect((await s.driver.runCommand(workspace.cwd,verify,10000,restarted.environment(issue.id))).code).toBe(0);
   await restarted.commit(issue,s.project);
   const fixed=restarted.attempt(issue.id)!.result_sha;
   await s.git(s.repo,['checkout','--detach']);
   let candidate='';let candidateFailure=true;
   s.driver.runCommand=async(cwd,argv,timeout,env)=>{
     if(cwd.includes('/integration/') && argv[0]==='python3' && argv[2]?.includes('receipt.json')) {
       expect(env?.PANDA_DB).toStartWith(cwd);expect(env?.TMPDIR).toStartWith(cwd);
     }
     if(candidateFailure && cwd.includes('/integration/') && argv[0]==='python3' && argv[2]?.includes('receipt.json')) {
       candidateFailure=false;
       return {code:1,out:'',err:'环境准备失败：模拟候选执行机暂不可用',timedOut:false,durationMs:1};
     }
     return run(cwd,argv,timeout,env);
   };
   await expect(restarted.integrate(issue,s.project,async()=>true)).rejects.toThrow('候选执行机暂不可用');
   expect(restarted.attempt(issue.id)!.result_sha).toBe(fixed);
   const result=await new ModuleWorkspaceService(s.deps).integrate(issue,s.project,async cwd=>{
     candidate=cwd;
     expect(cwd).toContain('/integration/');expect(cwd.length).toBeGreaterThan(108);
     expect((await s.driver.statPath(cwd+'/node_modules'))?.isDirectory).toBe(true);
     const env=restarted.environment(issue.id,cwd);
     expect(env.PANDA_DB).not.toBe(restarted.environment(issue.id).PANDA_DB);
     expect(env.TMPDIR).toStartWith(cwd);
     return (await s.driver.runCommand(cwd,verify,10000,env)).code===0;
   });
   expect(result.done).toBe(true);expect(candidate).not.toBe(workspace.cwd);
   expect(restarted.attempt(issue.id)!.result_sha).toBe(fixed);
   expect(await s.git(s.repo,['show','main:retained.txt'])).toContain('保留现场');
   await restarted.release(issue,s.project);
   expect(restarted.attempt(issue.id)!.released_ts).not.toBeNull();
 });
},60000);

test('引擎环境恢复：启动失败暂停、重启保留退避、三次上限不刷业务失败',async()=>{
 const s=await setup();
 writeFileSync(s.repo+'/package.json',JSON.stringify({dependencies:{fixture:'1.0.0'}}));
 writeFileSync(s.repo+'/bun.lock','锁文件夹具');
 await s.git(s.repo,['add','.']);await s.git(s.repo,['commit','-m','准备失败夹具']);
 const run=s.driver.runCommand.bind(s.driver);
 s.driver.runCommand=async(cwd,argv,timeout,env)=>argv[0]==='python3'&&argv[2]?.includes('receipt.json')
  ? {code:1,out:'',err:'包源暂不可用',timedOut:false,durationMs:1}:run(cwd,argv,timeout,env);
 let now=Date.now();
 const makeEngine=()=>new IssueEngine({db:s.db,driver:s.driver,convs:s.deps.conversations,locator:{locate:async()=>null},
  moduleWorkspaces:s.service,executionWorkspaces:s.service,mutex:s.deps.mutex,pmFor:()=>({judgeDone:async()=> 'not_done'}),notify:{dispatch:async()=>{}},
  config:{resultSummaryTimeoutMs:0,now:()=>now}});
 const issue=s.issue(1),first=makeEngine();
 expect((await first.startIssue(issue.id)).ok).toBe(false);
 expect(first.store.get(issue.id)!.status).toBe('paused');
 expect(first.store.lastEnterInfo(issue.id,'paused')?.resumeState).toBe('pending');
 expect(s.service.attempt(issue.id)!.phase).toBe('prepared');
 const id=s.service.attempt(issue.id)!.id;
 const restarted=makeEngine();
 await restarted.tick();
 expect(restarted.store.countEvents(issue.id,'environment_recovery_attempt')).toBe(0);
 for(const delay of [30000,120000,300000]) {
  now+=delay;
  await restarted.tick();
 }
 expect(restarted.store.countEvents(issue.id,'environment_recovery_attempt')).toBe(3);
 expect(restarted.store.countEvents(issue.id,'environment_recovery_exhausted')).toBe(1);
 now+=3600000;await restarted.tick();await restarted.tick();
 expect(restarted.store.countEvents(issue.id,'environment_recovery_attempt')).toBe(3);
 expect(restarted.store.countEvents(issue.id,'tests_failed')).toBe(0);
 expect(restarted.store.get(issue.id)!.status).toBe('paused');
 expect(s.service.attempt(issue.id)!.id).toBe(id);
 expect(s.service.attempt(issue.id)!.released_ts).toBeNull();
},30000);

for(const failureKind of ['依赖准备','执行机 Git'] as const) {
test(`真实引擎候选验收：${failureKind}失败后重启自动恢复到 merging 并完成固定成果 CAS 集成`,async()=>{
 const s=await setup(true);
 await s.captureFailure(async()=>{
  mkdirSync(s.repo+'/fixture');
  writeFileSync(s.repo+'/fixture/package.json',JSON.stringify({name:'fixture',version:'1.0.0',main:'index.js'}));
  writeFileSync(s.repo+'/fixture/index.js','module.exports=42;\n');
  writeFileSync(s.repo+'/package.json',JSON.stringify({dependencies:{fixture:'file:./fixture'}}));
  expect((await s.driver.runCommand(s.repo,['bun','install','--lockfile-only'],30000)).code).toBe(0);
  await s.git(s.repo,['add','.']);await s.git(s.repo,['commit','-m','真实候选验收依赖']);
  const issue=s.issue(1),workspace=await s.service.resolve(issue,s.project);
  writeFileSync(workspace.cwd+'/result.txt','固定成果\n');
  await s.service.commit(issue,s.project);
  const fixed=s.service.attempt(issue.id)!.result_sha;
  await s.git(s.repo,['checkout','--detach']);
  s.db.query("UPDATE issues SET status='merging' WHERE id=?").run(issue.id);
  s.db.query("UPDATE projects SET validation_commands_json=? WHERE id=1").run(JSON.stringify([{label:'独立候选验收',argv:['bun','-e',"if(require('fixture')!==42) process.exit(1)"]}]));
  const run=s.driver.runCommand.bind(s.driver);let fail=true;
  s.driver.runCommand=async(cwd,argv,timeout,env)=>{
   if(fail && cwd.includes('/integration/') && (failureKind==='依赖准备'
      ? argv[0]==='python3' && argv[2]?.includes('receipt.json') : argv[0]==='flock')) {
    fail=false;return {code:1,out:'',err:'候选执行环境暂不可用',timedOut:failureKind==='执行机 Git',durationMs:1};
   }
   return run(cwd,argv,timeout,env);
  };
  let now=Date.now();
  const makeEngine=()=>new IssueEngine({db:s.db,driver:s.driver,convs:s.deps.conversations,locator:{locate:async()=>null},
   moduleWorkspaces:s.service,executionWorkspaces:s.service,mutex:s.deps.mutex,pmFor:()=>({judgeDone:async()=> 'not_done'}),
   notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0,now:()=>now}});
  const engine=makeEngine();await engine.tick();
  expect(engine.store.get(issue.id)!.status).toBe('paused');
  expect(engine.store.lastEnterInfo(issue.id,'paused')?.from).toBe('merging');
  expect(s.service.attempt(issue.id)!.result_sha).toBe(fixed);
  const restarted=makeEngine();now+=30000;await restarted.tick();
  expect(restarted.store.get(issue.id)!.status).toBe('done');
  expect(restarted.store.countEvents(issue.id,'tests_failed')).toBe(0);
  expect(restarted.store.countEvents(issue.id,'environment_recovery_attempt')).toBe(1);
  expect(restarted.store.countEvents(issue.id,'validation_passed')).toBe(1);
  expect(s.service.attempt(issue.id)!.result_sha).toBe(fixed);
  expect(s.service.attempt(issue.id)!.released_ts).not.toBeNull();
  expect(await s.git(s.repo,['show','main:result.txt'])).toBe('固定成果');
 });
},30000);

}

test('模块集成冲突交给合并 Agent，保留双方成果并在修复后重新验证', async () => {
 const s=await setup();const a=s.issue(1),b=s.issue(2);
 const wa=await s.service.resolve(a,s.project),wb=await s.service.resolve(b,s.project);
 writeFileSync(wa.cwd+'/same.txt','模块A\n');writeFileSync(wb.cwd+'/same.txt','模块B\n');
 await s.service.commit(a,s.project);await s.service.commit(b,s.project);
 await s.git(s.repo,['checkout','--detach']);
 expect((await s.service.integrate(a,s.project,async()=>true)).done).toBe(true);
 let repairs=0,validations=0;
 const mergeAgent={step:async(context:{cwd:string})=>{
  repairs++;writeFileSync(context.cwd+'/same.txt','模块A\n模块B\n');
  await s.git(context.cwd,['add','same.txt']);await s.git(context.cwd,['commit','--no-edit']);
  return {state:'resolved' as const};
 },cancel:async()=>{},retry:()=>{},answer:()=>false};
 const service=new ModuleWorkspaceService({...s.deps,...{mergeAgent}});
 const validate=async(cwd:string)=>{validations++;expect(readFileSync(cwd+'/same.txt','utf8')).toBe('模块A\n模块B\n');return true;};
 let result=await service.integrate(b,s.project,validate);
 for(let n=0;n<3&&!result.done;n++) result=await service.integrate(b,s.project,validate);
 expect(repairs).toBe(1);expect(result.done).toBe(true);expect(validations).toBe(1);
 const tip=await s.git(s.repo,['rev-parse','main']);
 expect(await s.git(s.repo,['show',tip+':same.txt'])).toBe('模块A\n模块B');
 expect(await s.git(s.repo,['merge-base','--is-ancestor',service.attempt(b.id)!.result_sha!,tip])).toBe('');
});

// The model boundary is simulated; ownership, journal, filesystem and Git are real.
import { ModuleMergeAgent } from './module-merge-agent';
import { managedConversationEnvironment, managedConversationOwned } from '../core/workspace-ownership';
async function mergeAgentFixture() {
 const s=await setup();const a=s.issue(1),b=s.issue(2);
 const wa=await s.service.resolve(a,s.project),wb=await s.service.resolve(b,s.project);
 writeFileSync(wa.cwd+'/same.txt','A\n');writeFileSync(wb.cwd+'/same.txt','B\n');
 await s.service.commit(a,s.project);await s.service.commit(b,s.project);await s.git(s.repo,['checkout','--detach']);
 await s.service.integrate(a,s.project,async()=>true);
 await s.service.integrate(b,s.project,async()=>true);
 s.db.query("UPDATE issues SET status='merging' WHERE id=?").run(b.id);
 const job=s.db.query<{id:string;cwd:string;target_sha:string;result_sha:string},[string]>('SELECT * FROM workspace_integrations WHERE attempt_id=?').get(s.service.attempt(b.id)!.id)!;
 const context={integrationId:job.id,attemptId:s.service.attempt(b.id)!.id,cwd:job.cwd,targetSha:job.target_sha,resultSha:job.result_sha,issue:s.store.get(b.id)!,project:s.project,reason:'集成冲突',files:['same.txt']};
 let sent=0,stopped=0,ready=true,stopFails=false,sendFails=false;
 s.driver.capturePane=async()=>ready?'› 修复合并':'OpenAI Codex\nLoading…';
 s.driver.listSessions=async()=>[{name:'ignored',createdTs:1,attached:false}];
 s.driver.sendKeys=async()=>{sent++;if(sendFails)throw new Error('lost receipt');};
 s.driver.stopSessionConfirmed=async()=>{stopped++;if(stopFails)throw new Error('stop unconfirmed');};
 const deps={db:s.db,mutex:s.deps.mutex,projectForId:s.deps.projectForId,driverForProject:(project:typeof s.project)=>{if(project.ownerUserId!==1)throw new Error('missing project isolation context');return s.driver;},conversations:{createInWorkspaceWithId:s.deps.conversations.createInWorkspaceWithId.bind(s.deps.conversations),activate:async(id:string,cwd?:string)=>{
  const conv=s.deps.conversations.get(id)!;
  expect(conv.workspaceCwd).toBe(cwd??null);expect(managedConversationOwned(s.db,1,id)).toBe(true);
  return conv;
 }}};
 const agent=new ModuleMergeAgent(deps);
 function run(){return s.db.query<any,[]>("SELECT * FROM workspace_merge_agents ORDER BY rowid DESC LIMIT 1").get()!;}
 function report(status='resolved',details='保留双方功能',extra:Record<string,unknown>={}) {
  const r=run(),base=job.cwd+'/.panda/tmp/merge-agent/'+r.id;
  writeFileSync(base+'/result.json',JSON.stringify({runId:r.id,integrationId:job.id,targetSha:job.target_sha,resultSha:job.result_sha,status,details,...extra}));writeFileSync(base+'/done','ok');
 }
 return {...s,a,b,job,context,agent,agentDeps:deps,run,report,stats:()=>({sent,stopped}),ready:(v:boolean)=>{ready=v;},stopFails:(v:boolean)=>{stopFails=v;},sendFails:(v:boolean)=>{sendFails=v;}};
}

test('合并 Agent：等真实输入框，持久启动记录且重建协调器不重复投递',async()=>{
 const s=await mergeAgentFixture();s.ready(false);
 await s.agent.step(s.context);expect(s.stats().sent).toBe(0);expect(s.run().state).toBe('dispatching');
 s.ready(true);await s.agent.step(s.context);expect(s.run().state).toBe('running');
 const run=s.run();const env=managedConversationEnvironment(s.db,run.conversation_id)!;
 expect(env.PANDA_WORKSPACE_CWD).toBe(s.job.cwd);expect(env.PANDA_WORKSPACE_ATTEMPT).toBe(run.id);
 // Simulate control-plane crash after confirmed send, before state write.
 s.db.query("UPDATE workspace_merge_agents SET state='dispatching' WHERE id=?").run(run.id);
 await new ModuleMergeAgent(s.agentDeps).step(s.context);
 expect(s.stats().sent).toBe(1);expect(s.run().state).toBe('running');
});

test('合并 Agent：项目单活跃，澄清释放名额且答复保存在下一轮上下文',async()=>{
 const s=await mergeAgentFixture();await s.agent.step(s.context);
 s.report('needs_clarification','双方负责人规则冲突，采用哪一个？');
 expect((await s.agent.step(s.context)).state).toBe('clarification');
 expect(s.run().stop_confirmed).toBe(1);expect(managedConversationOwned(s.db,1,s.run().conversation_id)).toBe(false);
 expect(s.agent.answer(s.b.id,'保留人工指定的负责人')).toBe(true);
 await s.agent.step(s.context);
 const context=JSON.parse(readFileSync(s.job.cwd+'/.panda/tmp/merge-agent/'+s.run().id+'/context.json','utf8'));
 expect(context.guidance).toBe('保留人工指定的负责人');expect(s.stats().sent).toBe(2);
});

test('合并 Agent：陈旧报告不被采纳，停止未知时项目占用不会释放',async()=>{
 const s=await mergeAgentFixture();await s.agent.step(s.context);
 s.report('resolved','旧结果',{targetSha:'0'.repeat(40)});s.stopFails(true);
 await expect(s.agent.step(s.context)).rejects.toThrow('stop unconfirmed');
 expect(s.run().state).toBe('stopping');expect(s.run().stop_confirmed).toBe(0);
 s.stopFails(false);await s.agent.cancel(s.b.id);s.agent.retry(s.b.id);
 expect(s.run().state).toBe('retry');expect(s.run().stop_confirmed).toBe(1);
});

test('合并 Agent：投递回执丢失不盲重发，取消只停止合并轮次',async()=>{
 const s=await mergeAgentFixture();s.sendFails(true);
 await expect(s.agent.step(s.context)).rejects.toThrow();
 expect(s.run().state).toBe('uncertain');
 await expect(new ModuleMergeAgent(s.agentDeps).step(s.context)).rejects.toThrow();
 expect(s.stats().sent).toBe(1);
 await s.agent.cancel(s.b.id);expect(s.run().stop_confirmed).toBe(1);
 expect(s.service.attempt(s.a.id)!.result_sha).not.toBeNull();
});

test('合并 Agent：固定成果修复后才重新验证和发布，旧会话不可重新激活',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});
 expect((await service.integrate(s.context.issue,s.project,async()=>true)).done).toBe(false);
 const run=s.run();writeFileSync(s.job.cwd+'/same.txt','A\nB\n');
 await s.git(s.job.cwd,['add','same.txt']);await s.git(s.job.cwd,['commit','--no-edit']);s.report();
 let validations=0;
 expect((await service.integrate(s.context.issue,s.project,async()=>{validations++;return true;})).done).toBe(true);
 expect(validations).toBe(1);expect(s.stats().stopped).toBeGreaterThan(0);
 expect(managedConversationOwned(s.db,1,run.conversation_id)).toBe(false);
 expect(()=>managedConversationEnvironment(s.db,run.conversation_id)).toThrow('归属已失效');
 expect(await s.git(s.repo,['show','main:same.txt'])).toBe('A\nB');
});

test('合并 Agent：目标前进先停止旧模型再重建，停止失败不生成新候选',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});
 await service.integrate(s.context.issue,s.project,async()=>true);
 // Advance canonical target using an unrelated commit, without touching either module.
 const candidate=s.root+'/advance';await s.git(s.repo,['worktree','add','--detach',candidate,'main']);
 writeFileSync(candidate+'/later.txt','later');await s.git(candidate,['add','.']);await s.git(candidate,['commit','-m','target advanced']);
 await s.git(s.repo,['update-ref','refs/heads/main',await s.git(candidate,['rev-parse','HEAD'])]);
 const count=()=>s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM workspace_integrations').get()!.n;
 const before=count();s.stopFails(true);
 await expect(service.integrate(s.context.issue,s.project,async()=>true)).rejects.toThrow('stop unconfirmed');expect(count()).toBe(before);
 s.stopFails(false);await service.integrate(s.context.issue,s.project,async()=>true);
 expect(s.run().stop_confirmed).toBe(1);expect(count()).toBe(before);
 await service.integrate(s.context.issue,s.project,async()=>true);expect(count()).toBe(before+1);
});

test('合并 Agent：项目唯一活跃修复者，待业务澄清的候选让出名额',async()=>{
 const s=await mergeAgentFixture();await s.agent.step(s.context);
 const c=s.issue(3),wc=await s.service.resolve(c,s.project);
 writeFileSync(wc.cwd+'/third.txt','C');await s.service.commit(c,s.project);
 s.db.query("UPDATE issues SET status='merging' WHERE id=?").run(c.id);
 await s.service.integrate(s.store.get(c.id)!,s.project,async()=>false);
 const job=s.db.query<any,[string]>('SELECT * FROM workspace_integrations WHERE attempt_id=?').get(s.service.attempt(c.id)!.id)!;
 const context={...s.context,integrationId:job.id,attemptId:job.attempt_id,cwd:job.cwd,targetSha:job.target_sha,resultSha:job.result_sha,issue:s.store.get(c.id)!,reason:'验证失败'};
 expect((await new ModuleMergeAgent(s.agentDeps).step(context)).state).toBe('waiting');
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM workspace_merge_agents').get()!.n).toBe(1);
 s.report('needs_clarification','负责人业务规则需要选择');await s.agent.step(s.context);
 expect((await new ModuleMergeAgent(s.agentDeps).step(context)).state).toBe('running');
 expect(s.db.query<{n:number},[]>("SELECT COUNT(*) n FROM workspace_merge_agents WHERE state='running'").get()!.n).toBe(1);
});

test('合并 Agent：反复验证失败最多自动修复三轮，显式恢复才重开预算',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});
 await service.integrate(s.context.issue,s.project,async()=>false);
 writeFileSync(s.job.cwd+'/same.txt','A\nB\n');await s.git(s.job.cwd,['add','same.txt']);await s.git(s.job.cwd,['commit','--no-edit']);
 for(let n=0;n<3;n++) {
  s.report();expect((await service.integrate(s.context.issue,s.project,async()=>false)).done).toBe(false);
  if(n<2)await service.integrate(s.context.issue,s.project,async()=>false);
 }
 await expect(service.integrate(s.context.issue,s.project,async()=>false)).rejects.toThrow('预算已耗尽');
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM workspace_merge_agents').get()!.n).toBe(3);
 expect(s.service.attempt(s.b.id)!.integrated_sha).toBeNull();
 await service.resumeMergeAgent(s.b.id);
 expect((await service.integrate(s.context.issue,s.project,async()=>true)).done).toBe(false);
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM workspace_merge_agents').get()!.n).toBe(4);
});

test('真实 tmux：合并会话使用候选目录和独立轮次，完成后验证并停止进程',async()=>{
 const s=await setup();const a=s.issue(1),b=s.issue(2);
 const wa=await s.service.resolve(a,s.project),wb=await s.service.resolve(b,s.project);
 writeFileSync(wa.cwd+'/same.txt','A\n');writeFileSync(wb.cwd+'/same.txt','B\n');
 await s.service.commit(a,s.project);await s.service.commit(b,s.project);await s.git(s.repo,['checkout','--detach']);
 await s.service.integrate(a,s.project,async()=>true);
 s.db.query("UPDATE issues SET status='merging' WHERE id=?").run(b.id);
 const executable=s.root+'/model-fixture';
 writeFileSync(executable,`#!/usr/bin/env python3
import sys,re,json,os,subprocess,time
from pathlib import Path
print('OpenAI Codex\\n› Ready',flush=True)
for line in sys.stdin:
 m=re.search(r'(\\.panda/tmp/merge-agent/[0-9a-f-]+/context\\.json)',line)
 if not m: continue
 print('• Working',flush=True)
 context=Path(m[1]); data=json.loads(context.read_text()); base=context.parent
 (base/'observed.json').write_text(json.dumps({'cwd':os.getcwd(),'attempt':os.environ.get('PANDA_WORKSPACE_ATTEMPT')}))
 Path('same.txt').write_text('A\\nB\\n')
 subprocess.run(['git','add','-A'],check=True)
 subprocess.run(['git','commit','--no-edit'],check=True)
 result={k:data[k] for k in ['runId','integrationId','targetSha','resultSha']}
 result.update(status='resolved',details='Deterministic model fixture: preserve A and B')
 (base/'result.json').write_text(json.dumps(result)); (base/'done').write_text('ok')
 print('Finished\\n› Ready',flush=True)
`,{mode:0o755});
 s.driver.findExecutable=async()=>executable;
 const conversations=s.deps.conversations;
 const agent=new ModuleMergeAgent({...s.deps,conversations});
 const service=new ModuleWorkspaceService({...s.deps,mergeAgent:agent});
 let done=false,checks=0;
 try {
  for(let n=0;n<30&&!done;n++) {
   done=(await service.integrate(s.store.get(b.id)!,s.project,async cwd=>{checks++;return readFileSync(cwd+'/same.txt','utf8')==='A\nB\n';})).done;
   if(!done)await Bun.sleep(150);
  }
  expect(done).toBe(true);expect(checks).toBe(1);
  const run=s.db.query<any,[]>('SELECT * FROM workspace_merge_agents ORDER BY rowid DESC LIMIT 1').get()!;
  const job=s.db.query<{cwd:string},[string]>('SELECT cwd FROM workspace_integrations WHERE id=?').get(run.integration_id)!;
  const observed=JSON.parse(readFileSync(job.cwd+'/.panda/tmp/merge-agent/'+run.id+'/observed.json','utf8'));
  expect(observed.cwd).toBe(job.cwd);expect(observed.attempt).toBe(run.id);expect(run.stop_confirmed).toBe(1);
  expect((await s.driver.listSessions()).some(x=>x.name.includes(run.conversation_id))).toBe(false);
 } finally {await agent.cancel(b.id);}
},30_000);

test('引擎合并澄清：答复交给修复轮次，不注入已停止的开发会话',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});
 await s.agent.step(s.context);s.report('needs_clarification','负责人按人工规则还是自动规则？');await s.agent.step(s.context);
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0}});
 const sent=s.stats().sent;
 expect((await engine.clarify(s.b.id,'采用人工指定负责人')).ok).toBe(true);
 expect(s.run().answer).toBe('采用人工指定负责人');expect(s.stats().sent).toBe(sent);
 expect(engine.store.execClarifyWait(s.b.id)).toBeNull();
});

test('引擎合并门禁：Agent修复后缺少系统验证命令不能发布候选',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});
 await service.integrate(s.context.issue,s.project,async()=>true);
 writeFileSync(s.job.cwd+'/same.txt','A\nB\n');await s.git(s.job.cwd,['add','same.txt']);await s.git(s.job.cwd,['commit','--no-edit']);s.report();
 const before=await s.git(s.repo,['rev-parse','main']);s.db.query("UPDATE issues SET status='done' WHERE id=?").run(s.a.id);
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0,validationTimeoutMs:0}});
 await engine.tick();
 expect(engine.store.get(s.b.id)!.status).toBe('paused');
 expect(await s.git(s.repo,['rev-parse','main'])).toBe(before);
 expect(service.attempt(s.b.id)!.integrated_sha).toBeNull();
});

test('引擎合并暂停：停止活跃修复者，保留候选并让出项目Agent名额',async()=>{
 const s=await mergeAgentFixture();const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});await s.agent.step(s.context);
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0}});
 expect((await engine.applyEvent(s.b.id,'pause',{note:'暂停合并'})).ok).toBe(true);
 expect(s.run().stop_confirmed).toBe(1);expect(s.run().state).toBe('superseded');
 expect(s.service.attempt(s.b.id)!.released_ts).toBeNull();
 expect((await s.driver.git(s.job.cwd,['rev-parse','--verify','MERGE_HEAD'])).code).toBe(0);
});

test('执行超时：下一轮由新 Agent 接管同一现场，旧会话不可重新启动',async()=>{
 const s=await setup(),sessions=new Set<string>();
 s.driver.findExecutable=async()=>'/bin/true';
 s.driver.listSessions=async()=>[...sessions].map(name=>({name,createdTs:1,attached:false,command:'codex'}));
 s.driver.createSession=async name=>{sessions.add(name);};s.driver.killSession=async name=>{sessions.delete(name);};
 s.driver.sendKeys=async()=>{};s.driver.capturePane=async()=> '› Ready';
 s.driver.stopSessionConfirmed=async name=>{sessions.delete(name);};
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,executionWorkspaces:s.service,moduleWorkspaces:s.service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},
  config:{resultSummaryTimeoutMs:0,kickoffMinBootMs:0,stopLossRuntimeMs:5000}});
 const issue=s.issue(1);await engine.scheduleNext(1);
 const old=engine.store.get(issue.id)!,before=s.service.attempt(issue.id)!;
 writeFileSync(before.cwd+'/partial.txt','保留已经完成的工作');
 s.db.query("UPDATE issue_events SET ts=? WHERE issue_id=? AND kind='transition'").run(Date.now()-15000,issue.id);
 await engine.tick();expect(engine.store.get(issue.id)!.status).toBe('paused');
 await engine.tick();
 const fresh=engine.store.get(issue.id)!;
 expect(fresh.status).toBe('implementing');expect(fresh.convId).not.toBe(old.convId);
 expect(s.service.attempt(issue.id)!.id).toBe(before.id);expect(s.service.attempt(issue.id)!.cwd).toBe(before.cwd);
 expect(readFileSync(before.cwd+'/partial.txt','utf8')).toBe('保留已经完成的工作');
 await expect(s.deps.conversations.activate(old.convId!)).rejects.toThrow('归属');
});

async function timeoutFixture(config:Record<string,unknown>={}) {
 const s=await setup(),sessions=new Set<string>(),sent:string[]=[];
 s.driver.findExecutable=async()=>'/bin/true';
 s.driver.listSessions=async()=>[...sessions].map(name=>({name,createdTs:1,attached:false,command:'codex'}));
 s.driver.createSession=async name=>{sessions.add(name);};s.driver.killSession=async name=>{sessions.delete(name);};
 s.driver.sendKeys=async(_session,text)=>{sent.push(text);};s.driver.capturePane=async()=> '› Ready';
 s.driver.stopSessionConfirmed=async name=>{sessions.delete(name);};
 const deps={db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,executionWorkspaces:s.service,moduleWorkspaces:s.service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done' as const,generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},
  config:{resultSummaryTimeoutMs:0,kickoffMinBootMs:0,stopLossRuntimeMs:5000,...config}};
 const engine=new IssueEngine(deps),issue=s.issue(1);await engine.scheduleNext(1);
 const expire=async()=>{
  s.db.query("UPDATE issue_events SET ts=? WHERE issue_id=? AND kind='transition'").run(Date.now()-15000,issue.id);
  s.db.query("UPDATE issue_events SET ts=? WHERE issue_id=? AND kind IN ('unblock_guidance','stop_loss_resumed')").run(Date.now()-15000,issue.id);
  await engine.tick();expect(engine.store.get(issue.id)!.status).toBe('paused');
 };
 return {...s,engine,issue,engineDeps:deps,expire,sent};
}

test('超时接管：重建协调器沿用已准备会话，不重复创建或投递',async()=>{
 const s=await timeoutFixture();await s.expire();
 const pause=s.store.lastEnterEventId(s.issue.id,'paused');
 const prepared=await s.service.prepareTimeoutTakeover(s.store.get(s.issue.id)!,s.project,pause,'runtime','implementing');
 const restartedService=new ModuleWorkspaceService(s.deps);
 const restarted=new IssueEngine({...s.engineDeps,moduleWorkspaces:restartedService,executionWorkspaces:restartedService});
 await restarted.tick();
 expect(s.store.get(s.issue.id)!.convId).toBe(prepared.conversationId);
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(1);
 await restarted.tick();await restarted.tick();
 expect(s.sent.filter(text=>(text.includes('超时恢复 Agent')||text.includes('timeout recovery agent')))).toHaveLength(1);
 expect(s.sent.find(text=>(text.includes('超时恢复 Agent')||text.includes('timeout recovery agent')))).toContain('ISSUE_READY');
 const snapshot=JSON.parse(readFileSync(prepared.contextPath,'utf8'));
 expect(snapshot.reason).toBe('runtime');expect(snapshot.issue.id).toBe(s.issue.id);
});

test('超时接管：停止确认失败时保留旧绑定，不启动第二个写者',async()=>{
 const s=await timeoutFixture();await s.expire();const before=s.store.get(s.issue.id)!.convId;
 s.driver.stopSessionConfirmed=async()=>{throw new Error('old process still alive');};
 await s.engine.tick();await s.engine.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('paused');expect(s.store.get(s.issue.id)!.convId).toBe(before);
 expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_timeout_takeovers').get()!.phase).toBe('failed');
 expect(s.store.listEvents(s.issue.id).filter(e=>e.kind==='timeout_takeover_failed')).toHaveLength(1);
 expect(s.sent.filter(text=>(text.includes('超时恢复 Agent')||text.includes('timeout recovery agent')))).toHaveLength(0);
});

test('超时接管：手动暂停和等待澄清均不触发恢复',async()=>{
 const s=await timeoutFixture();const before=s.store.get(s.issue.id)!.convId;
 await s.engine.applyEvent(s.issue.id,'pause',{note:'用户要求暂停'});await s.engine.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('paused');
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(0);
 await s.engine.unblockIssue(s.issue.id,'继续');
 s.store.logEvent(s.issue.id,'clarify_questions',{questions:'需要确认业务规则',source:'exec',stage:'implementing'});
 s.db.query("UPDATE issue_events SET ts=? WHERE issue_id=? AND kind='transition'").run(Date.now()-15000,s.issue.id);
 await s.engine.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('implementing');expect(s.store.get(s.issue.id)!.convId).toBe(before);
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(0);
});

test('超时接管：最多两次，重启和人工继续均不能清空自动预算',async()=>{
 const s=await timeoutFixture();
 for(let n=0;n<2;n++){await s.expire();await s.engine.tick();expect(s.store.get(s.issue.id)!.status).toBe('implementing');}
 await s.expire();const restarted=new IssueEngine(s.engineDeps);await restarted.tick();await restarted.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('paused');
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(2);
 expect(s.store.listEvents(s.issue.id).filter(e=>e.kind==='timeout_takeover_exhausted')).toHaveLength(1);
 expect((await restarted.unblockIssue(s.issue.id,'人工检查后继续')).ok).toBe(true);
 await s.expire();await restarted.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('paused');
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(2);
});

test('超时接管：容量不足不领取预算，恢复后才接管',async()=>{
 const s=await timeoutFixture();await s.expire();
 s.db.run('UPDATE projects SET module_concurrency=1 WHERE id=1');
 const other=s.store.create(1,{title:'占用容量',moduleId:2,agent:'codex',executionMode:'direct'});await s.service.resolve(other,s.project);s.service.compute(other.id,true);
 await s.engine.tick();
 expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(0);
 s.service.compute(other.id,false);await s.engine.tick();expect(s.store.get(s.issue.id)!.status).toBe('implementing');
});

test('验证超时：真实命令超时暂停后接管',async()=>{
 const s=await timeoutFixture();const before=s.store.get(s.issue.id)!.convId;
 s.db.query('UPDATE projects SET validation_commands_json=? WHERE id=1').run(JSON.stringify([{label:'test',argv:['sh','-c','sleep 10']} ]));
 s.store.setCompletionReport(s.issue.id,{version:1,outcome:'complete',objective:'完成',implementation:['完成'],advantages:[],disadvantages:[],verification:['修改'],completion:'已完成',unmetGoals:[],remainingWork:[],optionalFollowUps:[]});
 s.db.query("UPDATE issues SET status='testing' WHERE id=?").run(s.issue.id);
 // Use the real LocalDriver timeout and the ordinary validation/report path.
 const engine=new IssueEngine({...s.engineDeps,config:{...s.engineDeps.config,validationTimeoutMs:50}});
 await (engine as any).completeTesting(s.issue.id,'sentinel',true);
 expect(s.store.get(s.issue.id)!.status).toBe('paused');
 expect(s.store.listEvents(s.issue.id).find(e=>e.kind==='validation_failed')?.dataJson).toContain('"timedOut":true');
 await engine.tick();expect(s.store.get(s.issue.id)!.status).toBe('implementing');expect(s.store.get(s.issue.id)!.convId).not.toBe(before);
});

test('合并超时：保留冻结成果和候选，由新修复 Agent 继续并继承诊断',async()=>{
 const s=await mergeAgentFixture();let now=Date.now();
 const agent=new ModuleMergeAgent({...s.agentDeps,now:()=>now});
 const service=new ModuleWorkspaceService({...s.deps,mergeAgent:agent});await agent.step(s.context);
 const old=s.run();now+=31*60_000;
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,executionWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',generateClarifyingQuestions:async()=>null}),notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0}});
 await engine.tick();expect(s.store.get(s.b.id)!.status).toBe('paused');
 await engine.tick();expect(s.store.get(s.b.id)!.status).toBe('merging');
 const next=s.run();expect(next.id).not.toBe(old.id);expect(next.integration_id).toBe(old.integration_id);
 expect(service.attempt(s.b.id)!.result_sha).toBe(s.context.resultSha);
 expect(s.store.get(s.b.id)!.convId).toBe(s.context.issue.convId);
 const context=JSON.parse(readFileSync(s.job.cwd+'/.panda/tmp/merge-agent/'+next.id+'/context.json','utf8'));
 expect(context.timeoutRecovery.reason).toBe('merge-agent');expect(context.timeoutRecovery.mergeCandidate.cwd).toBe(s.job.cwd);
});

test('超时接管：人工继续可接续已准备现场，并终结旧接管意图',async()=>{
 const s=await timeoutFixture();await s.expire();
 const prepared=await s.service.prepareTimeoutTakeover(s.store.get(s.issue.id)!,s.project,s.store.lastEnterEventId(s.issue.id,'paused'),'runtime','implementing');
 expect((await s.engine.unblockIssue(s.issue.id,'人工已确认，接着做')).ok).toBe(true);
 expect(s.store.get(s.issue.id)!.status).toBe('implementing');
 expect(managedConversationOwned(s.db,1,prepared.conversationId!)).toBe(true);
 expect(s.db.query<{phase:string},[string]>('SELECT phase FROM issue_timeout_takeovers WHERE id=?').get(prepared.id)!.phase).toBe('failed');
});

test('启动与无进展超时：使用同一接管入口，禁用开关保持暂停',async()=>{
 for(const reason of ['startup','idle'] as const) {
  const s=await timeoutFixture();await s.engine.applyEvent(s.issue.id,'pause',{note:'超时',timeoutReason:reason});
  await s.engine.tick();expect(s.store.get(s.issue.id)!.status).toBe('implementing');
 }
 const disabled=await timeoutFixture({timeoutAgentEnabled:false});await disabled.expire();await disabled.engine.tick();
 expect(disabled.store.get(disabled.issue.id)!.status).toBe('paused');
 expect(disabled.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(0);
});

test('超时接管：诊断脱敏、保留子任务进度，工作流节点不被父会话替换',async()=>{
 const s=await timeoutFixture();
 s.db.query('UPDATE issues SET sub_index=2 WHERE id=?').run(s.issue.id);
 s.driver.capturePane=async()=> '› Ready\nAPI_KEY=should-stay-private';
 await s.expire();await s.engine.tick();
 const job=s.db.query<{context_path:string},[]>('SELECT context_path FROM issue_timeout_takeovers').get()!;
 const text=readFileSync(job.context_path,'utf8');expect(text).not.toContain('should-stay-private');
 expect(JSON.parse(text).issue.subIndex).toBe(2);expect(s.store.get(s.issue.id)!.subIndex).toBe(2);
 const graph=await timeoutFixture();await graph.expire();const before=graph.store.get(graph.issue.id)!.convId;
 graph.db.query("INSERT INTO issue_workflows(issue_id,template_name,template_version,graph_json,graph_hash,context_json,created_ts,updated_ts) VALUES(?,'测试',1,'{}','test','{}',1,1)").run(graph.issue.id);
 await graph.engine.tick();
 expect(graph.store.get(graph.issue.id)!.status).toBe('paused');expect(graph.store.get(graph.issue.id)!.convId).toBe(before);
 expect(graph.store.listEvents(graph.issue.id).find(e=>e.kind==='timeout_takeover_failed')?.dataJson).toContain('节点归属');
});

test('超时接管：诊断已落盘但暂停未提交时，重启仍补齐暂停和接管',async()=>{
 const s=await timeoutFixture();
 s.db.query("UPDATE issue_events SET ts=? WHERE issue_id=? AND kind='transition'").run(Date.now()-15000,s.issue.id);
 s.store.logEvent(s.issue.id,'stop_loss_triggered',{reason:'runtime',stage:'implementing'});
 const restarted=new IssueEngine(s.engineDeps);await restarted.tick();expect(s.store.get(s.issue.id)!.status).toBe('paused');
 await restarted.tick();expect(s.store.get(s.issue.id)!.status).toBe('implementing');
 const t=await timeoutFixture();t.store.logEvent(t.issue.id,'nudge_exhausted',{count:5,stage:'implementing'});
 await (t.engine as any).exhaustAutoRetry(t.store.get(t.issue.id)!,'nudge',5,0);
 expect(t.store.get(t.issue.id)!.status).toBe('paused');await t.engine.tick();expect(t.store.get(t.issue.id)!.status).toBe('implementing');
 const merge=await mergeAgentFixture();let now=Date.now();const agent=new ModuleMergeAgent({...merge.agentDeps,now:()=>now});await agent.step(merge.context);now+=31*60_000;
 await expect(agent.step(merge.context)).rejects.toThrow('合并 Agent 超时');
 const {MergeAgentTimeoutError}=await import('./module-merge-agent');
 await expect(new ModuleMergeAgent(merge.agentDeps).step(merge.context)).rejects.toBeInstanceOf(MergeAgentTimeoutError);
});

// PM supervises the existing autonomous executor and the independent merge Agent.
import type { PmLoopDecision, PmLoopObservation } from './pm-loop';
function supervisedEngine(s:Awaited<ReturnType<typeof timeoutFixture>>, decide:(o:PmLoopObservation)=>Promise<PmLoopDecision>,config:Record<string,unknown>={}) {
 return new IssueEngine({...s.engineDeps,pmFor:()=>({judgeDone:async()=> 'not_done' as const,superviseIssue:decide}),
  config:{...s.engineDeps.config,pmLoopEnabled:true,pmLoopIdleMs:100,pmLoopTickMs:10,...config}});
}

test('PM Loop：超时后由 PM 决定等待，旧固定接管不抢先执行',async()=>{
 const s=await timeoutFixture();await s.expire();let calls=0;
 const engine=supervisedEngine(s,async o=>{calls++;expect(o.facts).toHaveProperty('git');return {action:'wait',reason:'先保留现场核查',waitSeconds:60};});
 await engine.tick();expect(s.store.get(s.issue.id)!.status).toBe('paused');
 await engine.tickPmLoop();await engine.tick();await engine.tickPmLoop();
 expect(calls).toBe(1);expect(s.db.query<{n:number},[]>('SELECT COUNT(*) n FROM issue_timeout_takeovers').get()!.n).toBe(0);
});

test('PM Loop：恢复普通执行角色并保留原 worktree、改动及单一指令',async()=>{
 const s=await timeoutFixture(),before=s.service.attempt(s.issue.id)!;writeFileSync(before.cwd+'/partial.txt','keep');await s.expire();
 const engine=supervisedEngine(s,async()=>({action:'recover',reason:'执行进程已失去响应',instruction:'定位超时原因后继续完成原始目标。'}));
 await engine.tickPmLoop();await engine.tick();
 expect(s.store.get(s.issue.id)!.status).toBe('implementing');expect(s.service.attempt(s.issue.id)!.id).toBe(before.id);
 expect(readFileSync(before.cwd+'/partial.txt','utf8')).toBe('keep');
 expect(s.sent.at(-1)).toContain('定位超时原因后继续完成原始目标');expect(s.sent.at(-1)).toContain('ISSUE_READY');
 expect(s.sent.at(-1)).not.toMatch(/你现在是超时恢复 Agent|You are the timeout recovery agent/);
});

test('PM Loop：自主执行没有旧催办，空闲干预只发一条明确任务',async()=>{
 const s=await timeoutFixture();let now=Date.now(),calls=0;
 const engine=supervisedEngine(s,async()=>{calls++;return {action:'continue',reason:'输入已就绪，任务仍未交付',instruction:'继续完成当前 issue，修复定向验证发现的问题。'};},{now:()=>now,nudgeSec:0.001,fallbackSec:0.001,stopLossRuntimeMs:3_600_000});
 await engine.tick();await engine.tickPmLoop();const initial=s.sent.length;
 now+=200;await engine.tick();expect(s.sent).toHaveLength(initial);
 await engine.tickPmLoop();await engine.tickPmLoop();
 expect(calls).toBe(1);expect(s.sent).toHaveLength(initial+1);expect(s.sent.at(-1)).toContain('继续完成当前 issue');
 expect(s.sent.at(-1)!.length).toBeLessThanOrEqual(2000);
 expect(s.store.listEvents(s.issue.id).filter(e=>e.kind==='nudged')).toHaveLength(0);
});

test('PM Loop：原 issue tick 未返回时仍可独立观察，修改动作等待原入口释放',async()=>{
 const s=await timeoutFixture();let now=Date.now(),release!:()=>void,first=true,calls=0;
 s.driver.capturePane=async()=>{if(first){first=false;await new Promise<void>(r=>{release=r;});}return '› Ready';};
 const engine=supervisedEngine(s,async()=>{calls++;return {action:'wait',reason:'观察到执行入口仍在途',waitSeconds:60};},{now:()=>now,stopLossRuntimeMs:3_600_000});
 const pending=engine.tick();await Bun.sleep(10);
 await engine.tickPmLoop();now+=200;await engine.tickPmLoop();expect(calls).toBe(1);
 release();await pending;await engine.stop();
});

test('PM Loop：PM 推理期间人工暂停，迟到的续跑决定不注入',async()=>{
 const s=await timeoutFixture();let now=Date.now(),resolve!:(d:PmLoopDecision)=>void;
 const engine=supervisedEngine(s,async()=>new Promise(r=>{resolve=r;}),{now:()=>now,stopLossRuntimeMs:3_600_000});
 await engine.tickPmLoop();now+=200;const pending=engine.tickPmLoop();
 while(!resolve)await Bun.sleep(5);
 await engine.applyEvent(s.issue.id,'pause',{note:'用户暂停',actor:1});const sent=s.sent.length;
 resolve({action:'continue',reason:'旧现场空闲',instruction:'继续执行。'});await pending;
 expect(s.store.get(s.issue.id)!.status).toBe('paused');expect(s.sent).toHaveLength(sent);
});

test('PM Loop：合并超时恢复仍由独立合并 Agent 接续同一候选',async()=>{
 const s=await mergeAgentFixture();let now=Date.now();const agent=new ModuleMergeAgent({...s.agentDeps,now:()=>now});await agent.step(s.context);
 const service=new ModuleWorkspaceService({...s.deps,mergeAgent:agent}),old=s.run();now+=31*60_000;
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,executionWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',superviseIssue:async o=>{expect(o.facts).toHaveProperty('mergeAgent');expect(o.allowedActions).not.toContain('continue');return {action:'recover',reason:'合并 Agent 超时，保留候选恢复'};}}),
  notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0,pmLoopEnabled:true}});
 await engine.tick();expect(s.store.get(s.b.id)!.status).toBe('paused');
 await engine.tick();expect(s.run().id).toBe(old.id);
 await engine.tickPmLoop();
 expect(s.store.get(s.b.id)!.status).toBe('merging');expect(s.run().id).not.toBe(old.id);
 expect(s.run().integration_id).toBe(old.integration_id);expect(s.store.get(s.b.id)!.convId).toBe(s.context.issue.convId);
 expect(service.attempt(s.b.id)!.result_sha).toBe(s.context.resultSha);
});

test('PM Loop：合并 Agent 自动失败暂停也进入监督，人工合并暂停仍保持暂停',async()=>{
 const s=await mergeAgentFixture();await s.agent.step(s.context);s.report('failed','候选验证失败，需要继续修复');
 const service=new ModuleWorkspaceService({...s.deps,mergeAgent:s.agent});let decisions=0;
 const engine=new IssueEngine({db:s.db,driver:s.driver,locator:{locate:async()=>null},convs:s.deps.conversations,moduleWorkspaces:service,executionWorkspaces:service,mutex:s.deps.mutex,
  pmFor:()=>({judgeDone:async()=> 'not_done',superviseIssue:async()=>{decisions++;return {action:'recover',reason:'继续修复保留的合并候选'};}}),
  notify:{dispatch:async()=>{}},config:{resultSummaryTimeoutMs:0,pmLoopEnabled:true}});
 await engine.tick();expect(s.store.get(s.b.id)!.status).toBe('paused');const old=s.run();
 await engine.tickPmLoop();expect(decisions).toBe(1);expect(s.store.get(s.b.id)!.status).toBe('merging');
 expect(s.run().id).not.toBe(old.id);expect(s.run().integration_id).toBe(old.integration_id);
 await engine.applyEvent(s.b.id,'pause',{note:'人工暂停合并',actor:1});await engine.tickPmLoop();
 expect(s.store.get(s.b.id)!.status).toBe('paused');expect(decisions).toBe(1);
});

test('PM Loop：等待最终输入锁期间有新进展，旧指令不提交',async()=>{
 const s=await timeoutFixture();let now=Date.now(),decided=false,captures=0;
 const engine=supervisedEngine(s,async()=>{decided=true;return {action:'continue',reason:'空闲',instruction:'继续完成当前目标。'};},{now:()=>now,stopLossRuntimeMs:3_600_000});
 await engine.tick();await engine.tickPmLoop();const initial=s.sent.length;
 s.driver.capturePane=async()=>{
  if(decided&&++captures===3)writeFileSync(s.service.attempt(s.issue.id)!.cwd+'/new-progress.txt','progress while PM waits for final input');
  return '› Ready';
 };
 now+=200;await engine.tickPmLoop();expect(captures).toBeGreaterThanOrEqual(3);
 expect(s.sent).toHaveLength(initial);
 expect(s.store.listEvents(s.issue.id).some(e=>e.kind==='pm_loop_stale')).toBe(true);
});

test('PM Loop：未知动作仅在显式人工恢复后解除监督屏障',async()=>{
 const s=await timeoutFixture();const engine=supervisedEngine(s,async()=>({action:'wait',reason:'核查',waitSeconds:60}));await engine.tickPmLoop();
 s.db.query("UPDATE issue_pm_loops SET phase='uncertain',operation_id='unknown-old-action' WHERE issue_id=?").run(s.issue.id);
 await engine.applyEvent(s.issue.id,'pause',{note:'人工核查',actor:1});
 expect((await engine.unblockIssue(s.issue.id,'已确认旧动作结果，沿用现场继续',1)).ok).toBe(true);
 expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).toBe('watching');
});

import { afterEach, beforeEach, expect, test } from 'bun:test';
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
 const deps={db,mutex:new KeyedMutex(),driverForProject:()=>driver,legacy,conversations};
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

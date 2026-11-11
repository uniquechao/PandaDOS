import { afterEach, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from './engine';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();});

test('095 persists reclamation ownership, archive receipts and executor capacity without changing issue state',()=>{
 const db=openDb(':memory:');cleanups.push(()=>db.close());migrate(db);migrateIssueEngine(db);
 expect(db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_reclamation_jobs'").get()).not.toBeNull();
 expect(db.query("SELECT 1 FROM sqlite_master WHERE name='workspace_capacity'").get()).not.toBeNull();
 const columns=db.query<{name:string},[]>('PRAGMA table_info(module_workspaces)').all().map(r=>r.name);
 expect(columns).toContain('environment_state');
 expect(columns).toContain('environment_generation');
 migrateIssueEngine(db);
 expect(db.query<{n:number},[]>("SELECT COUNT(*) n FROM schema_migrations WHERE id=95").get()?.n).toBe(1);
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalDriver } from '../executor/local';
import { getProject, IssueStore } from './engine';
import { KeyedMutex } from './mutex';
import { ModuleWorkspaceService } from './module-workspaces';
import { WorkspaceExecutionDeferred } from './workspace-deferral';

async function scene() {
 mkdirSync('.private',{recursive:true});const root=mkdtempSync(process.cwd()+'/.private/gc-service-');
 cleanups.push(()=>rmSync(root,{recursive:true,force:true}));
 const db=openDb(':memory:');cleanups.push(()=>db.close());migrate(db);migrateIssueEngine(db);
 const driver=new LocalDriver(),mutex=new KeyedMutex();const repo=root+'/work/repo';mkdirSync(repo,{recursive:true});
 const git=async(cwd:string,args:string[])=>{const r=await driver.git(cwd,args);if(r.code)throw new Error(r.err);return r.out.trim();};
 await git(repo,['init','-b','main']);await git(repo,['config','user.name','test']);await git(repo,['config','user.email','test@example.invalid']);
 writeFileSync(repo+'/.gitignore','.panda/tmp/\nnode_modules/\n.build/\n');writeFileSync(repo+'/source.txt','original\n');
 await git(repo,['add','.']);await git(repo,['commit','-m','base']);const head=await git(repo,['rev-parse','HEAD']);await git(repo,['branch','target',head]);
 const moduleCwd=root+'/work/.panda-worktrees/project-1/module-0',integration=randomUUID(),candidateCwd=root+'/work/.panda-worktrees/project-1/integration/'+integration,attempt=randomUUID();
 mkdirSync(moduleCwd.substring(0,moduleCwd.lastIndexOf('/')),{recursive:true});await git(repo,['worktree','add','-b','panda/module-1-0',moduleCwd,head]);
 mkdirSync(candidateCwd.substring(0,candidateCwd.lastIndexOf('/')),{recursive:true});await git(repo,['worktree','add','--detach',candidateCwd,head]);
 db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'owner','x','admin',1)");
 db.query("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','localhost','x','x',?,'/unused')").run(root+'/work');
 db.query("INSERT INTO projects(id,name,executor_id,cwd,work_branch,integration_branch,owner_user_id,created_ts) VALUES(1,'test',1,?,'target','target',1,1)").run(repo);
 const store=new IssueStore(db),issue=store.create(1,{title:'gc lifecycle',agent:'codex',executionMode:'direct'});db.query("UPDATE issues SET status='done' WHERE id=?").run(issue.id);
 db.query("INSERT INTO module_workspaces(id,project_id,module_key,executor_id,cwd,branch,kind,lifecycle,created_ts,updated_ts) VALUES(1,1,0,1,?,'panda/module-1-0','module-worktree','idle',1,1)").run(moduleCwd);
 db.query("INSERT INTO workspace_attempts(id,workspace_id,issue_id,agent,phase,executor_start_ts,result_sha,integrated_sha,stop_confirmed,compute_held,released_ts,created_ts,updated_ts) VALUES(?,1,?,'codex','released',?,?,?,1,0,1,1,1)").run(attempt,issue.id,Date.now()-1000,head,head);
 db.query("INSERT INTO workspace_integrations(id,attempt_id,target_sha,result_sha,cwd,candidate_sha,phase,created_ts,updated_ts) VALUES(?,?,?,?,?,?,'published',1,1)").run(integration,attempt,head,head,candidateCwd,head);
 const deps={db,mutex,driverForProject:()=>driver,projectForId:(id:number)=>getProject(db,id),policy:{idleMs:0,minFreeBytes:0,retryMs:0,archiveMaxBytes:64*1024*1024,cacheMaxBytes:64*1024*1024}};
 const service=async(extra:Record<string,number>={})=>{
  const {WorkspaceReclamationService}=await import('./workspace-reclamation');
  const value=new WorkspaceReclamationService({...deps,policy:{...deps.policy,...extra}});cleanups.push(()=>value.stop());return value;
 };
 const put=(cwd:string,rel:string,text:string)=>{const p=cwd+'/'+rel;mkdirSync(p.substring(0,p.lastIndexOf('/')),{recursive:true});writeFileSync(p,text);};
 return {root,db,driver,mutex,repo,head,moduleCwd,candidateCwd,integration,attempt,issue,store,git,deps,service,put,project:getProject(db,1)!};
}

test('background reconciliation reclaims eligible candidates and cold module environments with durable receipts',async()=>{
 const s=await scene();s.put(s.candidateCwd,'.panda/tmp/diagnosis.log','diagnosis');s.put(s.moduleCwd,'node_modules/fixture/index.js','reinstall');
 s.put(s.moduleCwd,`.panda/tmp/runtime/${s.attempt}/cache/download`,'cache');s.put(s.moduleCwd,`.panda/tmp/runtime/${s.attempt}/data/panda.db`,'database');
 const gc=await s.service();await gc.tick();
 const jobs=gc.list(1).jobs;expect(jobs.filter(j=>j.state==='reclaimed')).toHaveLength(2);
 expect(existsSync(s.candidateCwd)).toBe(false);expect(existsSync(s.moduleCwd+'/node_modules/fixture')).toBe(false);
 expect(readFileSync(s.moduleCwd+`/.panda/tmp/runtime/${s.attempt}/data/panda.db`,'utf8')).toBe('database');
 expect(s.db.query<{environment_state:string;environment_generation:number},[]>('SELECT environment_state,environment_generation FROM module_workspaces').get()).toEqual({environment_state:'cold',environment_generation:1});
 expect(s.db.query('SELECT 1 FROM workspace_operations').get()).toBeNull();
 expect(s.db.query('SELECT 1 FROM workspace_integrations WHERE id=?').get(s.integration)).not.toBeNull();
},30_000);

test('held paused execution never becomes an idle environment or a reclaimable candidate',async()=>{
 const s=await scene();s.db.query('UPDATE module_workspaces SET current_attempt=?').run(s.attempt);
 s.db.query('UPDATE workspace_attempts SET released_ts=NULL,stop_confirmed=0').run();s.db.query("UPDATE issues SET status='paused'").run();
 s.put(s.moduleCwd,'node_modules/fixture/index.js','preserve');const gc=await s.service();await gc.tick();
 expect(existsSync(s.moduleCwd+'/node_modules/fixture/index.js')).toBe(true);expect(existsSync(s.candidateCwd)).toBe(true);
 expect(gc.list(1).jobs.filter(j=>j.state==='reclaimed')).toHaveLength(0);
},30_000);

test('lost remote deletion response is reconciled from the external receipt after restart',async()=>{
 const s=await scene();s.db.query("UPDATE module_workspaces SET environment_state='cold'").run();
 const original=s.driver.runCommand.bind(s.driver);let lost=false;
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>{
  const result=await original(cwd,argv,timeoutMs,env);
  if(!lost&&argv[0]==='python3'&&argv.at(-1)?.includes('"action":"reclaim"')){lost=true;return {...result,timedOut:true};}
  return result;
 };
 const first=await s.service();await first.tick();expect(lost).toBe(true);expect(existsSync(s.candidateCwd)).toBe(false);
 const job=first.list(1).jobs[0]!;expect(job.state).toBe('uncertain');await first.stop();
 const next=await s.service();next.request(1,job.id);await next.tick();expect(next.list(1).jobs[0]?.state).toBe('reclaimed');
 expect(s.db.query('SELECT 1 FROM workspace_operations').get()).toBeNull();
},30_000);

test('environment reclamation and a new module reservation are mutually exclusive',async()=>{
 const s=await scene();s.db.query('DELETE FROM workspace_integrations').run();s.put(s.moduleCwd,'node_modules/fixture/index.js','dependency');
 const original=s.driver.runCommand.bind(s.driver);let enter!:()=>void,leave!:()=>void;
 const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>leave=r);
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>{
  if(argv[0]==='python3'&&argv.at(-1)?.includes('"action":"reclaim"')){enter();await barrier;}
  return original(cwd,argv,timeoutMs,env);
 };
 const gc=await s.service(),flight=gc.tick();await entered;
 const pending=s.store.create(1,{title:'next module task',agent:'codex',executionMode:'direct'});
 const modules=new ModuleWorkspaceService({db:s.db,mutex:s.mutex,driverForProject:()=>s.driver,
  legacy:{resolve:()=>({cwd:s.repo,kind:'project',branch:null,runId:null}),conversationFor:async()=>{throw new Error('unused');}},
  conversations:{get:()=>undefined,createInWorkspaceWithId:()=>{throw new Error('unused');}}});
 let failure:unknown;const reserve=modules.resolve(pending,s.project).catch(e=>{failure=e;});
 try {
  await Bun.sleep(100);
  expect(s.db.query<{current_attempt:string|null},[]>('SELECT current_attempt FROM module_workspaces').get()?.current_attempt).toBeNull();
 } finally {leave();await flight;await reserve;}
 expect(failure).toBeInstanceOf(WorkspaceExecutionDeferred);
},30_000);

test('executor disk pressure defers startup and does not consume an environment recovery attempt',async()=>{
 const s=await scene();const original=s.driver.runCommand.bind(s.driver);
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>argv.at(-1)?.includes('"action":"capacity"')
  ?{code:0,out:JSON.stringify({state:'ready',availableBytes:1,totalBytes:100,cacheBytes:0,archiveBytes:0}),err:'',timedOut:false,durationMs:0}
  :original(cwd,argv,timeoutMs,env);
 const gc=await s.service({minFreeBytes:10});await expect(gc.assertCapacity(s.project,'start')).rejects.toBeInstanceOf(WorkspaceExecutionDeferred);
 expect(s.db.query<{n:number},[]>("SELECT COUNT(*) n FROM issue_events WHERE kind='environment_recovery_attempt'").get()?.n).toBe(0);
 expect(gc.list(1).capacity?.available_bytes).toBe(1);
},30_000);

test('archive retention respects pins and prunes only verified completed archives',async()=>{
 const s=await scene();s.db.query("UPDATE module_workspaces SET environment_state='cold'").run();const gc=await s.service({archiveRetentionMs:0});
 await gc.tick();const job=gc.list(1).jobs[0]!;expect(job.state).toBe('reclaimed');expect(existsSync(job.archive_path!)).toBe(true);
 await gc.pin(1,job.id,true);await gc.tick();expect(existsSync(job.archive_path!)).toBe(true);
 await gc.pin(1,job.id,false);await gc.tick();expect(existsSync(job.archive_path!)).toBe(false);
 expect(gc.list(1).jobs[0]?.archive_purged_ts).not.toBeNull();
 expect(()=>gc.request(999,job.id)).toThrow('reclamation_not_found');
},30_000);

test('cache budget includes workflow children, merge runs and integration candidates',async()=>{
 const s=await scene(),merge=randomUUID();
 // An old merge run uses a different runtime identity from its parent attempt.
 s.db.query(`INSERT INTO workspace_merge_agents(id,integration_id,attempt_id,project_id,conversation_id,state,reason,remaining,started_ts,stop_confirmed,updated_ts)
  VALUES(?,?,?,1,?,'resolved','test',1,1,1,1)`).run(merge,s.integration,s.attempt,randomUUID());
 s.put(s.moduleCwd,`.panda/tmp/runtime/${s.attempt}/node-42/cache/child`,'child cache');
 s.put(s.moduleCwd,`.panda/tmp/runtime/${merge}/cache/merge`,'merge cache');
 s.put(s.candidateCwd,`.panda/tmp/runtime/${s.attempt}/cache/candidate`,'candidate cache');
 const gc=await s.service({idleMs:Number.MAX_SAFE_INTEGER});await gc.tick();
 expect(gc.list(1).capacity!.cache_bytes).toBeGreaterThanOrEqual(4096*3);
},30_000);

test('PM lists recent failed jobs even after more than one hundred completed records',async()=>{
 const s=await scene();const gc=await s.service();gc.reconcile();const seed=gc.list(1).jobs[0]!;
 for(let n=0;n<110;n++)s.db.query(`INSERT INTO workspace_reclamation_jobs(id,resource_key,kind,project_id,workspace_id,attempt_id,executor_id,cwd,state,created_ts,updated_ts)
  VALUES(?,?,'candidate',1,1,?,1,?,'reclaimed',?,?)`).run(randomUUID(),'history:'+n,s.attempt,s.candidateCwd,n,n);
 s.db.query("UPDATE workspace_reclamation_jobs SET state='failed',reason='test',updated_ts=? WHERE id=?").run(Date.now()+1,seed.id);
 expect(gc.list(1).jobs[0]?.id).toBe(seed.id);
},30_000);

test('shutdown joins the current executor operation and does not start another job',async()=>{
 const s=await scene();const original=s.driver.runCommand.bind(s.driver);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);let commands=0;
 s.driver.runCommand=async(cwd,argv,timeoutMs,env)=>{
  if(argv.at(-1)?.includes('"action":"reclaim"')){commands++;enter();await barrier;}
  return original(cwd,argv,timeoutMs,env);
 };
 const gc=await s.service(),flight=gc.tick();await entered;let stopped=false;const stop=gc.stop().then(()=>{stopped=true;});
 await Bun.sleep(10);expect(stopped).toBe(false);release();await stop;await flight;
 expect(commands).toBe(1);expect(stopped).toBe(true);expect(gc.list(1).jobs.filter(j=>j.state==='pending')).toHaveLength(1);
},30_000);

test('the next issue rebuilds a cold environment on the same module worktree',async()=>{
 const s=await scene();s.db.query('DELETE FROM workspace_integrations').run();
 s.put(s.moduleCwd,'node_modules/fixture/index.js','old installation');s.put(s.moduleCwd,`.panda/tmp/runtime/${s.attempt}/data/panda.db`,'old data');
 const gc=await s.service();await gc.tick();expect(s.db.query<{environment_state:string},[]>('SELECT environment_state FROM module_workspaces').get()?.environment_state).toBe('cold');
 s.put(s.repo,'package.json',JSON.stringify({packageManager:'bun@1.3.14',dependencies:{fixture:'1.0.0'}}));s.put(s.repo,'bun.lock','fixture lock');
 await s.git(s.repo,['add','.']);await s.git(s.repo,['commit','-m','package inputs']);await s.git(s.repo,['update-ref','refs/heads/target','HEAD']);
 const bin=s.root+'/bin';mkdirSync(bin);writeFileSync(bin+'/bun','#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi\nmkdir -p node_modules/fixture\necho rebuilt > node_modules/fixture/index.js\n',{mode:0o755});
 const original=s.driver.runCommand.bind(s.driver);s.driver.runCommand=(cwd,argv,ms,env)=>original(cwd,argv,ms,{...env,PATH:bin+':'+process.env.PATH});
 const modules=new ModuleWorkspaceService({...s.deps,resources:gc,
  legacy:{resolve:()=>({cwd:s.repo,kind:'project',branch:null,runId:null}),conversationFor:async()=>{throw new Error('unused');}},
  conversations:{get:()=>undefined,createInWorkspaceWithId:()=>{throw new Error('unused');}}});
 const next=s.store.create(1,{title:'next issue',agent:'codex',executionMode:'direct'});const prepared=await modules.resolve(next,getProject(s.db,1)!);
 expect(prepared.cwd).toBe(s.moduleCwd);expect(readFileSync(s.moduleCwd+'/node_modules/fixture/index.js','utf8').trim()).toBe('rebuilt');
 expect(s.db.query<{environment_state:string},[]>('SELECT environment_state FROM module_workspaces').get()?.environment_state).toBe('warm');
 expect(readFileSync(s.moduleCwd+`/.panda/tmp/runtime/${s.attempt}/data/panda.db`,'utf8')).toBe('old data');
},30_000);

test('a restarted controller cannot acknowledge a pin while an archive deletion is unconfirmed',async()=>{
 const s=await scene();s.db.query("UPDATE module_workspaces SET environment_state='cold'").run();const gc=await s.service({archiveRetentionMs:0});await gc.tick();
 const job=gc.list(1).jobs[0]!,original=s.driver.runCommand.bind(s.driver);let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);
 s.driver.runCommand=async(cwd,argv,ms,env)=>{if(argv.at(-1)?.includes('"action":"prune"')){enter();await barrier;}return original(cwd,argv,ms,env);};
 const flight=gc.tick();await entered;
 const {WorkspaceReclamationService}=await import('./workspace-reclamation');const other=new WorkspaceReclamationService({...s.deps,mutex:new KeyedMutex()});cleanups.push(()=>other.stop());
 try {await expect(other.pin(1,job.id,true)).rejects.toThrow('reclamation_archive_busy');}
 finally {release();await flight;}
},30_000);

test('storage limits use explicit byte/millisecond settings and reject invalid values',async()=>{
 const {workspaceReclamationPolicyFromEnv}=await import('./workspace-reclamation');
 expect(workspaceReclamationPolicyFromEnv({PANDA_WORKSPACE_MIN_FREE_BYTES:'1024',PANDA_WORKSPACE_IDLE_MS:'60000'})).toEqual({minFreeBytes:1024,idleMs:60000});
 for(const value of ['','-1','1.5','Infinity','invalid'])expect(()=>workspaceReclamationPolicyFromEnv({PANDA_WORKSPACE_ARCHIVE_MAX_BYTES:value})).toThrow('reclamation_policy_invalid');
});

test('quota pressure makes room for an archive larger than half the budget',async()=>{
 const s=await scene(),{randomBytes}=await import('node:crypto');s.db.query("UPDATE module_workspaces SET environment_state='cold'").run();
 s.put(s.candidateCwd,'.panda/tmp/report.bin','');writeFileSync(s.candidateCwd+'/.panda/tmp/report.bin',randomBytes(20_000));
 const gc=await s.service({archiveMaxBytes:80_000});await gc.tick();const old=gc.list(1).jobs[0]!;expect(old.state).toBe('reclaimed');
 const issue=s.store.create(1,{title:'larger archive',agent:'codex'}),attempt=randomUUID(),integration=randomUUID();s.db.query("UPDATE issues SET status='done' WHERE id=?").run(issue.id);
 const cwd=s.root+'/work/.panda-worktrees/project-1/integration/'+integration;await s.git(s.repo,['worktree','add','--detach',cwd,s.head]);
 s.put(cwd,'.panda/tmp/report.bin','');writeFileSync(cwd+'/.panda/tmp/report.bin',randomBytes(70_000));
 s.db.query("INSERT INTO workspace_attempts(id,workspace_id,issue_id,agent,executor_start_ts,result_sha,integrated_sha,stop_confirmed,compute_held,released_ts,created_ts,updated_ts) VALUES(?,1,?,'codex',?,?,?,1,0,1,2,2)").run(attempt,issue.id,Date.now()-1000,s.head,s.head);
 s.db.query("INSERT INTO workspace_integrations(id,attempt_id,target_sha,result_sha,cwd,candidate_sha,phase,created_ts,updated_ts) VALUES(?,?,?,?,?,?,'published',2,2)").run(integration,attempt,s.head,s.head,cwd,s.head);
 await gc.tick();expect(gc.list(1).jobs.find(j=>j.integration_id===integration)?.reason).toBe('archive_quota');
 await gc.tick();expect(gc.list(1).jobs.find(j=>j.integration_id===integration)?.state).toBe('reclaimed');expect(existsSync(old.archive_path!)).toBe(false);
},30_000);

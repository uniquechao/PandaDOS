import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { LocalDriver } from './local';

const cleanups:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanups.splice(0).reverse())await fn();});
async function fixture(kind:'candidate'|'environment'='candidate') {
 mkdirSync('.private',{recursive:true});const base=mkdtempSync(process.cwd()+'/.private/reclaim-');
 cleanups.push(()=>rmSync(base,{recursive:true,force:true}));
 const workspaceRoot=base+'/work',projectCwd=workspaceRoot+'/repo',id=randomUUID(),attempt=randomUUID();
 mkdirSync(projectCwd,{recursive:true});const driver=new LocalDriver();
 const git=async(cwd:string,args:string[])=>{const r=await driver.git(cwd,args);if(r.code)throw new Error(r.err);return r.out.trim();};
 await git(projectCwd,['init','-b','main']);await git(projectCwd,['config','user.name','test']);await git(projectCwd,['config','user.email','test@example.invalid']);
 writeFileSync(projectCwd+'/.gitignore','.panda/tmp/\nnode_modules/\n.build/\n');writeFileSync(projectCwd+'/source.txt','base\n');
 await git(projectCwd,['add','.']);await git(projectCwd,['commit','-m','base']);const baseSha=await git(projectCwd,['rev-parse','HEAD']);
 const cwd=workspaceRoot+'/.panda-worktrees/project-1/'+(kind==='candidate'?'integration/'+id:'module-0');
 mkdirSync(cwd.substring(0,cwd.lastIndexOf('/')),{recursive:true});
 const branch=kind==='environment'?'panda/module-1-0':null;
 await git(projectCwd,['worktree','add',...(branch?['-b',branch]:['--detach']),cwd,baseSha]);
 writeFileSync(cwd+'/source.txt','delivered\n');await git(cwd,['add','.']);await git(cwd,['commit','-m','delivered']);
 const head=await git(cwd,['rev-parse','HEAD']);await git(projectCwd,['update-ref','refs/heads/target',head]);
 const request={action:'reclaim',jobId:randomUUID(),kind,projectId:1,executorId:1,workspaceRoot,projectCwd,cwd,branch,
  expectedHead:head,resultSha:head,targetRef:'refs/heads/target',attemptIds:[attempt],startedTs:Date.now(),generation:0,minFreeBytes:0,archiveMaxBytes:64*1024*1024};
 const run=async(overrides:Record<string,unknown>={})=>{
  const {runWorkspaceReclamation}=await import('./workspace-reclamation');
  return runWorkspaceReclamation(driver,projectCwd,{...request,...overrides});
 };
 return {base,workspaceRoot,projectCwd,cwd,head,baseSha,id,attempt,driver,git,request,run};
}
function put(root:string,rel:string,value:string) {const path=root+'/'+rel;mkdirSync(path.substring(0,path.lastIndexOf('/')),{recursive:true});writeFileSync(path,value);}

test('published stopped candidate archives diagnostics outside cwd, removes normally and reconciles a lost reply',async()=>{
 const f=await fixture();put(f.cwd,'.panda/tmp/diagnostic.log','unique diagnosis');put(f.cwd,`.panda/tmp/runtime/${f.attempt}/data/panda.db`,'preserve database');
 put(f.cwd,`.panda/tmp/runtime/${f.attempt}/cache/bun/download`,'reconstructible');put(f.cwd,'node_modules/fixture/index.js','dependency');
 const r=await f.run();expect(r.state,JSON.stringify(r)).toBe('reclaimed');expect(existsSync(f.cwd)).toBe(false);
 expect(await f.git(f.projectCwd,['worktree','list','--porcelain'])).not.toContain('worktree '+f.cwd);
 expect(r.archive?.path.startsWith(f.workspaceRoot+'/.panda-archives/')).toBe(true);
 expect(existsSync(r.archive!.path)).toBe(true);
 const listing=await f.driver.runCommand(f.projectCwd,['tar','-tzf',r.archive!.path],10_000);
 expect(listing.out).toContain('.panda/tmp/diagnostic.log');expect(listing.out).toContain('/data/panda.db');
 expect(listing.out).not.toContain('node_modules');expect(listing.out).not.toContain('/cache/');
 const replay=await f.run();expect(replay.state).toBe('reclaimed');expect(replay.archive).toEqual(r.archive);
 expect(await f.git(f.projectCwd,['rev-parse','refs/heads/target'])).toBe(f.head);
},30_000);
for(const problem of ['dirty','unpublished','writer','symlink'] as const)test('candidate retains '+problem+' scene',async()=>{
 const f=await fixture();
 if(problem==='dirty')writeFileSync(f.cwd+'/source.txt','uncommitted');
 if(problem==='unpublished')await f.git(f.projectCwd,['update-ref','refs/heads/target',f.baseSha]);
 if(problem==='writer'){
  const p=Bun.spawn(['sleep','30'],{cwd:f.cwd,env:{...process.env,PANDA_WORKSPACE_ATTEMPT:f.attempt},stdout:'ignore',stderr:'ignore'});
  cleanups.push(async()=>{p.kill();await p.exited;});
 }
 if(problem==='symlink'){
  const other=f.base+'/outside';mkdirSync(other);put(other,'keep','keep');
  rmSync(f.cwd,{recursive:true});symlinkSync(other,f.cwd);
 }
 const r=await f.run();expect(r.state).toBe('retained');expect(existsSync(f.cwd)).toBe(true);
 expect(r.reason).toBeTruthy();
},30_000);
test('archive quota retains the source and never publishes an unverified partial archive',async()=>{
 const f=await fixture();put(f.cwd,'.panda/tmp/diagnostic.log','unique information'.repeat(1000));
 const r=await f.run({archiveMaxBytes:16});expect(r.state).toBe('retained');expect(r.reason).toBe('archive_quota');
 expect(existsSync(f.cwd)).toBe(true);expect(readFileSync(f.cwd+'/.panda/tmp/diagnostic.log','utf8')).toContain('unique information');
},30_000);
test('idle environment removes only regenerable files, invalidates dependency receipt and preserves tracked dependency fixtures',async()=>{
 const f=await fixture('environment');put(f.cwd,'node_modules/keep.json','tracked fixture');
 await f.git(f.cwd,['add','-f','node_modules/keep.json']);await f.git(f.cwd,['commit','-m','fixture']);
 const head=await f.git(f.cwd,['rev-parse','HEAD']);
 put(f.cwd,'node_modules/dependency/index.js','reinstall');put(f.cwd,'.build/diagnostic.txt','retain build diagnostic');
 put(f.cwd,`.panda/tmp/runtime/${f.attempt}/cache/download`,'cache');put(f.cwd,`.panda/tmp/runtime/${f.attempt}/build/output`,'build');
 put(f.cwd,`.panda/tmp/runtime/${f.attempt}/data/panda.db`,'database');
 put(f.cwd,'.panda/tmp/dependencies/receipt.json',JSON.stringify({phase:'ready',fingerprint:'old'}));
 const r=await f.run({expectedHead:head});expect(r.state,JSON.stringify(r)).toBe('reclaimed');expect(existsSync(f.cwd)).toBe(true);
 expect(readFileSync(f.cwd+'/source.txt','utf8')).toBe('delivered\n');expect(readFileSync(f.cwd+'/node_modules/keep.json','utf8')).toBe('tracked fixture');
 expect(existsSync(f.cwd+'/node_modules/dependency')).toBe(false);expect(existsSync(f.cwd+'/.build')).toBe(false);
 expect(existsSync(f.cwd+`/.panda/tmp/runtime/${f.attempt}/cache`)).toBe(false);
 expect(readFileSync(f.cwd+`/.panda/tmp/runtime/${f.attempt}/data/panda.db`,'utf8')).toBe('database');
 expect(JSON.parse(readFileSync(f.cwd+'/.panda/tmp/dependencies/receipt.json','utf8')).phase).toBe('cold');
 expect(await f.git(f.cwd,['rev-parse','HEAD'])).toBe(head);expect(await f.git(f.cwd,['status','--porcelain'])).toBe('');
},30_000);
test('dependency installer lock prevents environment eviction',async()=>{
 const f=await fixture('environment');put(f.cwd,'node_modules/dependency/index.js','keep');put(f.cwd,'.panda/tmp/dependencies/install.lock','');
 const ready=f.base+'/locked';const p=Bun.spawn(['python3','-c','import fcntl,sys,time; f=open(sys.argv[1],"a+"); fcntl.flock(f,fcntl.LOCK_EX); open(sys.argv[2],"w").close(); time.sleep(30)',f.cwd+'/.panda/tmp/dependencies/install.lock',ready],{cwd:f.projectCwd,stdout:'ignore',stderr:'ignore'});
 cleanups.push(async()=>{p.kill();await p.exited;});
 for(let n=0;n<100&&!existsSync(ready);n++)await Bun.sleep(10);
 expect(existsSync(ready)).toBe(true);
 const r=await f.run();expect(r.state).toBe('retained');expect(r.reason).toBe('dependency_busy');
 expect(existsSync(f.cwd+'/node_modules/dependency/index.js')).toBe(true);
},30_000);

test('reclamation can free caches when available disk is below the new-task reserve',async()=>{
 const f=await fixture('environment');put(f.cwd,`.panda/tmp/runtime/${f.attempt}/cache/download`,'reconstructible');
 const r=await f.run({minFreeBytes:Number.MAX_SAFE_INTEGER});expect(r.state,JSON.stringify(r)).toBe('reclaimed');
 expect(existsSync(f.cwd+`/.panda/tmp/runtime/${f.attempt}/cache`)).toBe(false);
},30_000);

test('new ignored diagnostics after archive preparation are retained rather than lost on retry',async()=>{
 const f=await fixture();
 const {randomBytes}=await import('node:crypto');put(f.cwd,'.panda/tmp/report.bin','');writeFileSync(f.cwd+'/.panda/tmp/report.bin',randomBytes(8*1024*1024));
 const receipt=f.workspaceRoot+'/.panda-archives/receipts/'+f.request.jobId+'.json',ready=f.base+'/locked',release=f.base+'/release';
 const common=await f.git(f.projectCwd,['rev-parse','--path-format=absolute','--git-common-dir']);
 const watcher=Bun.spawn(['python3','-c',`import os,sys,time,json,fcntl
while True:
 try:
  if json.load(open(sys.argv[1]))['state']=='archiving':break
 except (FileNotFoundError,ValueError):pass
 time.sleep(.001)
f=open(sys.argv[2],'a+');fcntl.flock(f,fcntl.LOCK_EX);open(sys.argv[3],'w').close()
while not os.path.exists(sys.argv[4]):time.sleep(.005)
`,receipt,common+'/panda-workspace.lock',ready,release],{cwd:f.projectCwd,stdout:'ignore',stderr:'ignore'});
 cleanups.push(async()=>{watcher.kill();await watcher.exited;});
 const first=await f.run();writeFileSync(release,'release');await watcher.exited;
 expect(existsSync(ready)).toBe(true);expect(first.reason,JSON.stringify(first)).toBe('repository_busy');
 put(f.cwd,'.panda/tmp/new.db','new unique data');
 const second=await f.run();expect(second.state,JSON.stringify(second)).toBe('retained');
 expect(readFileSync(f.cwd+'/.panda/tmp/new.db','utf8')).toBe('new unique data');
},30_000);

test('an uninspectable process is retained even when it existed before the attempt',async()=>{
 const f=await fixture(),ready=f.base+'/nondumpable';
 const process=Bun.spawn(['python3','-c','import ctypes,sys,time; ctypes.CDLL(None).prctl(4,0); open(sys.argv[1],"w").close(); time.sleep(30)',ready],{cwd:f.projectCwd,stdout:'ignore',stderr:'ignore'});
 cleanups.push(async()=>{process.kill();await process.exited;});
 for(let n=0;n<100&&!existsSync(ready);n++)await Bun.sleep(10);expect(existsSync(ready)).toBe(true);
 const r=await f.run({startedTs:Date.now()+10_000});expect(r.state).toBe('retained');expect(r.reason).toBe('writer_inspection_denied');expect(existsSync(f.cwd)).toBe(true);
},30_000);

async function preparedArchive(f:Awaited<ReturnType<typeof fixture>>) {
 const {randomBytes}=await import('node:crypto');put(f.cwd,'.panda/tmp/report.bin','');writeFileSync(f.cwd+'/.panda/tmp/report.bin',randomBytes(8*1024*1024));
 const journal=f.workspaceRoot+'/.panda-archives/receipts/'+f.request.jobId+'.json',release=f.base+'/release';
 const common=await f.git(f.projectCwd,['rev-parse','--path-format=absolute','--git-common-dir']);
 const watcher=Bun.spawn(['python3','-c',`import os,sys,time,json,fcntl
while True:
 try:
  if json.load(open(sys.argv[1]))['state']=='archiving':break
 except (FileNotFoundError,ValueError):pass
 time.sleep(.001)
f=open(sys.argv[2],'a+');fcntl.flock(f,fcntl.LOCK_EX)
while not os.path.exists(sys.argv[3]):time.sleep(.005)
`,journal,common+'/panda-workspace.lock',release],{cwd:f.projectCwd,stdout:'ignore',stderr:'ignore'});
 cleanups.push(async()=>{watcher.kill();await watcher.exited;});
 let result;
 try {result=await f.run();}
 finally {writeFileSync(release,'release');await watcher.exited;}
 expect(result.reason,JSON.stringify(result)).toBe('repository_busy');
 return {journal,receipt:JSON.parse(readFileSync(journal,'utf8'))};
}
test('an archive sealed before a lost receipt is verified and adopted on restart',async()=>{
 const f=await fixture(),{journal,receipt}=await preparedArchive(f);
 await f.driver.runCommand(f.projectCwd,['python3','-c',"import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop('archive',None); d.pop('moves',None); d['state']='archiving'; open(p,'w').write(json.dumps(d))",journal],10_000);
 const r=await f.run();expect(r.state,JSON.stringify(r)).toBe('reclaimed');expect(existsSync(f.cwd)).toBe(false);
},30_000);
test('a partially moved trash generation is reconciled without moving tracked files',async()=>{
 const f=await fixture(),{receipt}=await preparedArchive(f);const move=receipt.moves[0];
 expect(move).toBeTruthy();const {renameSync}=await import('node:fs');mkdirSync(move.trash.substring(0,move.trash.lastIndexOf('/')),{recursive:true});renameSync(f.cwd+'/'+move.rel,move.trash);
 const r=await f.run();expect(r.state,JSON.stringify(r)).toBe('reclaimed');expect(existsSync(f.cwd)).toBe(false);expect(existsSync(move.trash)).toBe(false);
},30_000);

test('ignored standalone files are archived and removed together with ignored directories',async()=>{
 const f=await fixture();const {appendFileSync}=await import('node:fs');const common=await f.git(f.projectCwd,['rev-parse','--path-format=absolute','--git-common-dir']);
 appendFileSync(common+'/info/exclude','\ntrace.log\n.panda/feishu-colleague-tests.log\n');
 put(f.cwd,'trace.log','root diagnosis');put(f.cwd,'.panda/feishu-colleague-tests.log','channel diagnosis');
 const r=await f.run();expect(r.state,JSON.stringify(r)).toBe('reclaimed');
 const listing=await f.driver.runCommand(f.projectCwd,['tar','-tzf',r.archive!.path],10_000);
 expect(listing.out).toContain('trace.log');expect(listing.out).toContain('.panda/feishu-colleague-tests.log');
},30_000);

test('large executor inventories use a verified request file instead of exceeding argv limits',async()=>{
 const f=await fixture();const {runWorkspaceReclamation}=await import('./workspace-reclamation');
 const r=await runWorkspaceReclamation(f.driver,f.projectCwd,{...f.request,action:'capacity',probePaths:Array(2500).fill(f.projectCwd)});
 expect(r.state).toBe('ready');expect(r.availableBytes).toBeGreaterThan(0);
 const {readdirSync}=await import('node:fs');expect(readdirSync(f.workspaceRoot+'/.panda-archives/requests').filter(n=>n.endsWith('.json'))).toHaveLength(0);
},30_000);

test('streamed archive quota failure discards partial bytes and keeps the scene',async()=>{
 const f=await fixture(),{randomBytes}=await import('node:crypto');put(f.cwd,'.panda/tmp/report.bin','');writeFileSync(f.cwd+'/.panda/tmp/report.bin',randomBytes(128*1024));
 const r=await f.run({archiveMaxBytes:1024});expect(r.state).toBe('retained');expect(r.reason).toBe('archive_quota');expect(existsSync(f.cwd)).toBe(true);
 const {readdirSync}=await import('node:fs');expect(readdirSync(f.workspaceRoot+'/.panda-archives/project-1').filter(n=>n.endsWith('.partial')||n.endsWith('.tar.gz'))).toHaveLength(0);
},30_000);

test('surviving Git inherits the physical barriers when its collector process exits',async()=>{
 const f=await fixture();put(f.cwd,'.panda/tmp/diagnostic.log','diagnostic');
 const bin=f.base+'/bin',ready=f.base+'/git-ready',release=f.base+'/git-release';mkdirSync(bin);
 writeFileSync(bin+'/git',String.raw`#!/bin/sh
if [ "$3" = worktree ] && [ "$4" = remove ]; then
 printf '%s' "$$" > "$PANDA_TEST_GIT_READY"
 while [ ! -e "$PANDA_TEST_GIT_RELEASE" ]; do sleep .01; done
fi
exec /usr/bin/git "$@"
`,{mode:0o755});
 const {WORKSPACE_RECLAMATION_SCRIPT}=await import('./workspace-reclamation');
 const child=Bun.spawn(['python3','-c',WORKSPACE_RECLAMATION_SCRIPT,JSON.stringify(f.request)],{cwd:f.projectCwd,env:{...process.env,PATH:bin+':'+process.env.PATH,PANDA_TEST_GIT_READY:ready,PANDA_TEST_GIT_RELEASE:release},stdout:'ignore',stderr:'ignore'});
 cleanups.push(async()=>{child.kill();await child.exited;});
 for(let n=0;n<1000&&!existsSync(ready);n++)await Bun.sleep(5);expect(existsSync(ready)).toBe(true);
 const gitPid=Number(readFileSync(ready,'utf8'));cleanups.push(()=>{try{if(readFileSync('/proc/'+gitPid+'/cmdline','utf8').includes(f.base))process.kill(gitPid,'SIGKILL');}catch{}});
 const common=await f.git(f.projectCwd,['rev-parse','--path-format=absolute','--git-common-dir']);
 child.kill('SIGKILL');await child.exited;
 try {
  const probe=await f.driver.runCommand(f.projectCwd,['flock','-n',common+'/panda-workspace.lock','true'],1000);
  expect(probe.code).toBe(1);
  const job=await f.driver.runCommand(f.projectCwd,['flock','-n',f.workspaceRoot+'/.panda-archives/receipts/'+f.request.jobId+'.lock','true'],1000);
  expect(job.code).toBe(1);
 }finally {writeFileSync(release,'release');}
 for(let n=0;n<1000&&existsSync(f.cwd);n++)await Bun.sleep(5);
 const r=await f.run();expect(r.state,JSON.stringify(r)).toBe('reclaimed');expect(existsSync(f.cwd)).toBe(false);
},30_000);

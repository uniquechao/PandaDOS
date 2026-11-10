import { afterEach, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from './engine';
import { IssuePmLoop, parsePmLoopDecision, type PmLoopObservation, type PmLoopDecision } from './pm-loop';

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanups.splice(0).reverse())f();});
function fixture() {
 const db=openDb(':memory:');cleanups.push(()=>db.close());migrate(db);migrateIssueEngine(db);
 db.run("INSERT INTO users(id,username,token_hash,role,created_ts) VALUES(1,'owner','x','admin',1)");
 db.run("INSERT INTO executors(id,name,host,ssh_user,key_ref,workspace_root,claude_dir) VALUES(1,'local','localhost','runner','','/work','/unused')");
 db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'test',1,'/work',1,1)");
 const observations=new Map<string,PmLoopObservation>();
 for(const id of ['42','43']) {
  db.query("INSERT INTO issues(id,project_id,title,created_ts) VALUES(?,1,'goal',1)").run(id);
  observations.set(id,{issueId:id,projectId:1,scopeKey:`attempt:${id}:conv:1`,progressKey:'head:a:output:1',status:'implementing',allowedActions:['wait','continue','verify','recover','clarify','pause'],facts:{goal:'deliver',cwd:`/work/${id}`}});
 }
 let now=1000,calls=0;
 const applied:Array<{id:string;decision:PmLoopDecision;operationId:string}>=[];
 const deps={db,now:()=>now,list:()=>['42'],observe:async(id:string)=>observations.get(id)??null,
  decide:async(_o:PmLoopObservation,_s:AbortSignal):Promise<PmLoopDecision>=>{calls++;return {action:'wait',reason:'test is running',waitSeconds:60};},
  apply:async(o:PmLoopObservation,d:PmLoopDecision,operationId:string)=>{applied.push({id:o.issueId,decision:d,operationId});return 'applied' as const;},
  config:{idleMs:100,checkEveryMs:10,minWaitMs:50,maxWaitMs:1000,maxNoProgressRounds:3,maxInterventions:2,maxErrors:2}};
 return {db,deps,observations,applied,advance:(ms:number)=>{now+=ms;},calls:()=>calls};
}

test('healthy execution progresses without model calls or instructions',async()=>{
 const s=fixture(),loop=new IssuePmLoop(s.deps);
 await loop.tick();s.advance(200);s.observations.get('42')!.progressKey='head:b:output:2';await loop.tick();
 expect(s.calls()).toBe(0);expect(s.applied).toHaveLength(0);
});

test('waiting has a durable next check and survives coordinator restart',async()=>{
 const s=fixture(),loop=new IssuePmLoop(s.deps);await loop.tick();s.advance(101);await loop.tick();expect(s.calls()).toBe(1);
 const row=s.db.query<{next_check_ts:number},[]>('SELECT next_check_ts FROM issue_pm_loops').get()!;
 expect(row.next_check_ts).toBeGreaterThan(1101);
 const restarted=new IssuePmLoop(s.deps);s.advance(20);await restarted.tick();expect(s.calls()).toBe(1);
 s.advance(1001);await restarted.tick();expect(s.calls()).toBe(2);expect(s.applied).toHaveLength(0);
});

test('late decisions are discarded when ownership or observed progress changes',async()=>{
 for(const change of ['scopeKey','progressKey'] as const) {
  const s=fixture();s.observations.get('42')!.trigger='timeout';
  let resolve!:(d:PmLoopDecision)=>void;
  const loop=new IssuePmLoop({...s.deps,decide:async()=>new Promise(r=>{resolve=r;})});
  const pending=loop.tick();await Bun.sleep(5);s.observations.get('42')![change]+=':new';
  resolve({action:'recover',reason:'old evidence'});await pending;
  expect(s.applied).toHaveLength(0);
  expect(s.db.query<{n:number},[]>("SELECT COUNT(*) n FROM issue_events WHERE kind='pm_loop_stale'").get()!.n).toBe(1);
 }
});

test('a slow decision is single-flight and does not block another module',async()=>{
 const s=fixture();for(const o of s.observations.values())o.trigger='timeout';
 let finish!:(d:PmLoopDecision)=>void;let slow=0;
 const loop=new IssuePmLoop({...s.deps,list:()=>['42','43'],decide:async o=>o.issueId==='42'?new Promise(r=>{slow++;finish=r;}):{action:'continue',reason:'ready',instruction:'Finish the current delivery.'}});
 const first=loop.tick();await Bun.sleep(10);await loop.tick();
 expect(s.applied.map(x=>x.id)).toEqual(['43']);expect(slow).toBe(1);
 finish({action:'wait',reason:'working',waitSeconds:60});await first;
});

test('a missing action receipt becomes uncertain and is never replayed on restart',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';
 const deps={...s.deps,decide:async():Promise<PmLoopDecision>=>({action:'recover',reason:'dead executor'}),apply:async()=>{throw new Error('receipt lost after action');}};
 await new IssuePmLoop(deps).tick();
 expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).toBe('uncertain');
 let attempts=0;await new IssuePmLoop({...deps,apply:async()=>{attempts++;return 'applied';}}).tick();expect(attempts).toBe(0);
});

test('startup reconciles an in-flight action without repeating it',async()=>{
 const s=fixture();await new IssuePmLoop(s.deps).tick();
 s.db.run("UPDATE issue_pm_loops SET phase='applying',operation_id='sent-before-crash',decision_json='{}'");
 s.advance(1000);await new IssuePmLoop(s.deps).tick();
 expect(s.applied).toHaveLength(0);expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).toBe('uncertain');
});

test('repeated waiting without progress reaches a bounded pause',async()=>{
 const s=fixture(),loop=new IssuePmLoop(s.deps);await loop.tick();
 for(let i=0;i<5;i++){s.advance(1100);await loop.tick();}
 expect(s.calls()).toBe(3);expect(s.applied).toHaveLength(1);expect(s.applied[0].decision.action).toBe('pause');
});

test('model failures back off and eventually preserve the scene in a pause',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';let failures=0;
 const loop=new IssuePmLoop({...s.deps,decide:async()=>{failures++;throw new Error('provider unavailable');}});
 await loop.tick();await loop.tick();expect(failures).toBe(1);
 s.advance(1100);await loop.tick();s.advance(1100);await loop.tick();
 expect(failures).toBe(2);expect(s.applied.at(-1)?.decision.action).toBe('pause');
});

test('deferred actions retain their operation identity without another model call',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';let calls=0;const ops:string[]=[];
 const loop=new IssuePmLoop({...s.deps,decide:async()=>{calls++;return {action:'recover',reason:'stopped'};},apply:async(_o,_d,id)=>{ops.push(id);return ops.length===1?'deferred':'applied';}});
 await loop.tick();s.advance(100);await loop.tick();
 expect(calls).toBe(1);expect(ops).toHaveLength(2);expect(ops[0]).toBe(ops[1]);
});

test('decisions are bounded and cannot introduce unsupported actions or completion',()=>{
 const actions=['wait','continue','verify','recover','clarify','pause'] as const;
 expect(parsePmLoopDecision({action:'continue',reason:'idle',instruction:'Finish the current goal.'},actions).action).toBe('continue');
 for(const value of [{action:'done',reason:'looks done'},{action:'continue',reason:'idle',instruction:'x'.repeat(321)},{action:'continue',reason:'idle'},{action:'clarify',reason:'unclear',question:''},{action:'recover',reason:'stalled'}]) {
  expect(()=>parsePmLoopDecision(value,['wait','pause'])).toThrow();
 }
});

test('uncertainty survives scope mutations performed by the interrupted action',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';let actions=0;
 const deps={...s.deps,decide:async():Promise<PmLoopDecision>=>({action:'recover',reason:'recover executor'}),apply:async()=>{
  actions++;s.observations.get('42')!.scopeKey+=':rotated-conversation';throw new Error('lost outer receipt after changing the scene');
 }};
 await new IssuePmLoop(deps).tick();s.advance(1000);await new IssuePmLoop(deps).tick();
 expect(actions).toBe(1);expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).toBe('uncertain');
});

test('a deferred decision is invalidated when its action is no longer eligible',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';let calls=0;
 const loop=new IssuePmLoop({...s.deps,decide:async()=>{calls++;return {action:'continue',reason:'idle',instruction:'Finish current goal.'};},apply:async()=> 'deferred'});
 await loop.tick();s.observations.get('42')!.allowedActions=['wait','pause'];s.advance(100);await loop.tick();
 expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).not.toBe('ready');
 expect(s.db.query<{n:number},[]>("SELECT COUNT(*) n FROM issue_events WHERE kind='pm_loop_error'").get()!.n).toBe(0);
 expect(calls).toBe(1);
});

test('a permanently deferred action exhausts a durable budget instead of polling forever',async()=>{
 const s=fixture();s.observations.get('42')!.trigger='timeout';let calls=0,actions=0;
 const deps={...s.deps,decide:async():Promise<PmLoopDecision>=>{calls++;return {action:'recover',reason:'not responsive'};},apply:async()=>{actions++;return 'deferred' as const;}};
 await new IssuePmLoop(deps).tick();const restarted=new IssuePmLoop(deps);
 for(let n=0;n<10;n++){s.advance(1100);await restarted.tick();}
 expect(calls).toBe(1);expect(actions).toBeLessThanOrEqual(3);
 expect(s.db.query<{phase:string},[]>('SELECT phase FROM issue_pm_loops').get()!.phase).toBe('stopped');
});

import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { migrateDesigns } from '../designs/store';
import { UserStore } from '../core/users';
import { ConversationManager } from '../core/conversations';
import { KeyedMutex, tmuxLockKey } from '../issues/mutex';
import { ChatIdleReaper, CHAT_IDLE_TIMEOUT_MS, chatIdleTimeoutFromMinutes, idleInputEmpty, idleTurnFinished } from './chat-idle-reaper';
import type { IdleSessionState } from '../executor/idle-session';
import type { AgentKind } from '../core/types';

const encoder=new TextEncoder();
const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0))close();});
function fixture(agent:AgentKind='codex', intervalMs?:number) {
  const db=openDb(':memory:');migrate(db);migrateIssueEngine(db);migrateDesigns(db);
  cleanups.push(()=>db.close());
  const {user}=new UserStore(db).create('idle-test');
  db.run("INSERT INTO executors(name,host,port,ssh_user,key_ref,workspace_root,claude_dir) VALUES ('local','127.0.0.1',22,'panda','','/workspace','/claude')");
  db.query("INSERT INTO projects(name,executor_id,cwd,owner_user_id,created_ts) VALUES ('a',1,'/workspace',?,1)").run(user.id);
  let now=CHAT_IDLE_TIMEOUT_MS+10_000;
  let alive=true;
  let history=agent==='codex'?'{"type":"event_msg","payload":{"type":"task_complete"}}\n':'{"type":"assistant","message":{"stop_reason":"end_turn"}}\n';
  let mtime=1000;
  let nativePath=agent==='claude'?'/claude/idle-test.jsonl':'/history.jsonl';
  let state:IdleSessionState={name:'chat-idle-test',sessionId:'$2',paneId:'%3',panePid:123,activityTs:1,createdTs:1,attached:false,windows:1,panes:1,inMode:false,command:agent,processesIdle:true};
  const sent:string[]=[];
  let stopped=0;
  let inspectHook:(()=>Promise<void>)|undefined;
  const driver={
    async listSessions(){return alive?[{name:state.name,createdTs:1,attached:false,command:state.command}]:[];},
    async inspectIdleSession(){await inspectHook?.();return {...state};},
    async sleepSessionIfIdle(){alive=false;stopped++;return true;},
    async statPath(){return {size:encoder.encode(history).length,mtimeMs:mtime,isFile:true,isDirectory:false,mode:0o600};},
    async readFileRange(_path:string,offset:number,limit:number){const data=encoder.encode(history);return {data:data.slice(offset,offset+limit),size:data.length};},
    async listDir(){return [];},
    async capturePane():Promise<string>{return agent==='codex'?'› Ask Codex to do anything\n  ? for shortcuts':'❯\n';},
    async findExecutable(){return agent;},
    async createSession(){alive=true;},
    async killSession(){alive=false;},
    async sendKeys(_session:string,text:string){sent.push(text);},
    async writeFile(){},
  };
  db.query("INSERT INTO conversations(id,project_id,created_ts,agent,kind,agent_session_id) VALUES ('idle-test',1,1,?,'chat',?)").run(agent,agent==='codex'?'original-native-id':null);
  const mutex=new KeyedMutex();
  const reaper=new ChatIdleReaper({db,mutex,now:()=>now,intervalMs,execution:()=>({driver,locate:async()=>nativePath})});
  return {db,driver,mutex,reaper,sent,get stopped(){return stopped;},get history(){return history;},
    set history(v:string){history=v;},get state(){return state;},set state(v:IdleSessionState){state=v;},
    set now(v:number){now=v;},set mtime(v:number){mtime=v;},set nativePath(v:string){nativePath=v;},
    set inspectHook(v:(()=>Promise<void>)|undefined){inspectHook=v;}};
}

describe('idle conversation hibernation',()=>{
  for(const agent of ['codex','claude'] as const)test(`${agent}: remove runtime, then activate resumes original history`,async()=>{
    const f=fixture(agent);
    const before=f.db.query('SELECT * FROM conversations').get();
    expect(await f.reaper.tick()).toBe(1);
    expect(f.db.query('SELECT * FROM conversations').get()).toEqual(before);
    const manager=new ConversationManager(f.db,f.driver,{locate:async()=>'/history.jsonl'});
    await manager.activate('idle-test');
    expect(f.sent.at(-1)).toContain(agent==='codex'?'resume original-native-id':'--resume idle-test');
    expect((await f.driver.listSessions())).toHaveLength(1);
    expect(f.history).toContain(agent==='codex'?'task_complete':'end_turn');
  });
  test('two-hour deadline, recent use and recently written history are protected',async()=>{
    const f=fixture();f.now=CHAT_IDLE_TIMEOUT_MS;
    expect(await f.reaper.tick()).toBe(0);
    f.now=CHAT_IDLE_TIMEOUT_MS+10_000;f.mtime=20_000;
    expect(await f.reaper.tick()).toBe(0);
    f.mtime=1000;f.db.run('UPDATE conversations SET last_active_ts=20000');
    expect(await f.reaper.tick()).toBe(0);
  });
  test('all socket consumers pin a session; last disconnect restarts the idle deadline',async()=>{
    const f=fixture();const a=f.reaper.retain('chat-idle-test'),b=f.reaper.retain('chat-idle-test');
    a();a();expect(await f.reaper.tick()).toBe(0);b();
    expect(f.db.query<{last_active_ts:number},[]>('SELECT last_active_ts FROM conversations').get()!.last_active_ts).toBe(CHAT_IDLE_TIMEOUT_MS+10_000);
    expect(await f.reaper.tick()).toBe(0);
    f.now=2*CHAT_IDLE_TIMEOUT_MS+20_000;
    expect(await f.reaper.tick()).toBe(1);
  });
  for(const change of [{attached:true},{windows:2},{panes:2},{inMode:true},{processesIdle:false},{command:'python'}])test(`unsafe runtime ${JSON.stringify(change)} is retained`,async()=>{
    const f=fixture();f.state={...f.state,...change};expect(await f.reaper.tick()).toBe(0);
  });
  test('unfinished and unreadable native turns, drafts and missing resume ID survive',async()=>{
    const f=fixture();f.history='{"type":"event_msg","payload":{"type":"task_started"}}\n';
    expect(await f.reaper.tick()).toBe(0);
    f.history='invalid\n';expect(await f.reaper.tick()).toBe(0);
    f.history='{"type":"event_msg","payload":{"type":"task_complete"}}\n';
    f.driver.capturePane=async()=>'› an unsent draft\n';expect(await f.reaper.tick()).toBe(0);
    f.driver.capturePane=async()=>'› Ask Codex to do anything\n';
    f.db.run('UPDATE conversations SET agent_session_id=NULL');expect(await f.reaper.tick()).toBe(0);
  });
  test('issue-bound, design-owned, read-only, archived and managed conversations are excluded',async()=>{
    const f=fixture();
    for(const update of ["archived=1","kind='issue'","shared_read_only=1","workspace_cwd='/managed'"]){
      f.db.run('UPDATE conversations SET '+update);expect(await f.reaper.tick()).toBe(0);
      f.db.run("UPDATE conversations SET archived=0,kind='chat',shared_read_only=0,workspace_cwd=NULL");
    }
    f.db.run("INSERT INTO design_creation_sagas(saga_token,project_id,idempotency_key,request_json,conversation_id,phase,created_ts,updated_ts) VALUES ('owner',1,'owner','{}','idle-test','intent',1,1)");
    f.db.run("INSERT INTO design_saga_conversation_owners(conversation_id,saga_token,created_ts) VALUES ('idle-test','owner',1)");
    expect(await f.reaper.tick()).toBe(0);
  });
  test('activity, connection and container replacement during inspection prevent closure',async()=>{
    const f=fixture();let calls=0;
    f.inspectHook=async()=>{if(++calls===2)f.db.run('UPDATE conversations SET last_active_ts=?',[Date.now()]);};
    expect(await f.reaper.tick()).toBe(0);
    f.db.run('UPDATE conversations SET last_active_ts=NULL');calls=0;
    f.inspectHook=async()=>{if(++calls===2)f.reaper.retain('chat-idle-test');};
    expect(await f.reaper.tick()).toBe(0);
    const replaced=fixture();let reads=0;
    replaced.inspectHook=async()=>{if(++reads===2)replaced.state={...replaced.state,panePid:999};};
    expect(await replaced.reaper.tick()).toBe(0);
  });
  test('unfinished issue references protect the conversation even if its last Agent turn ended',async()=>{
    const f=fixture();
    f.db.run("INSERT INTO issues(id,project_id,title,status,conv_id,created_ts) VALUES ('idle-owner',1,'owner','pending','idle-test',1)");
    expect(await f.reaper.tick()).toBe(0);
  });
  test('reclaimed Claude sessions with a different native ID stay alive',async()=>{
    const f=fixture('claude');f.nativePath='/claude/a-manually-started-session.jsonl';
    expect(await f.reaper.tick()).toBe(0);
  });
  test('an unavailable executor cannot prevent an independent executor from reclaiming its idle chat',async()=>{
    const f=fixture();
    f.db.run("INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) SELECT 2,'second',executor_id,'/second',owner_user_id,1 FROM projects WHERE id=1");
    f.db.run("INSERT INTO conversations(id,project_id,created_ts,agent,kind,agent_session_id) VALUES ('other',2,1,'codex','chat','other-native')");
    f.state={...f.state,name:'chat-other'};
    const unavailable={...f.driver,listSessions:async()=>{throw new Error('offline');}};
    const reaper=new ChatIdleReaper({db:f.db,mutex:f.mutex,now:()=>CHAT_IDLE_TIMEOUT_MS+10_000,
      execution:p=>({driver:p.id===1?unavailable:f.driver,locate:async()=>'/history.jsonl'})});
    expect(await reaper.tick()).toBe(1);expect(f.stopped).toBe(1);
  });
  test('scheduled scans run automatically and stop cleanly',async()=>{
    const f=fixture('codex',5);f.reaper.start();
    try {
      for(let i=0;i<100&&!f.stopped;i++)await Bun.sleep(5);
      expect(f.stopped).toBe(1);
    } finally {await f.reaper.stop();}
  });
  test('does not queue behind a sender; scans single-flight and drains before stop',async()=>{
    const f=fixture();let release!:()=>void;
    const held=f.mutex.runExclusive(tmuxLockKey('chat-idle-test'),()=>new Promise<void>(r=>{release=r;}));
    await Promise.resolve();expect(await f.reaper.tick()).toBe(0);release();await held;
    let unblock!:()=>void;
    f.inspectHook=()=>new Promise<void>(r=>{unblock=r;});
    const first=f.reaper.tick();expect(f.reaper.tick()).toBe(first);
    while(!unblock)await Promise.resolve();
    const stop=f.reaper.stop();unblock();await stop;
    expect(await first).toBe(0);expect(f.stopped).toBe(0);expect(await f.reaper.tick()).toBe(0);
  });
});

test('tail and screen classification fail closed for interrupted turns and multiline drafts',()=>{
  expect(idleTurnFinished('codex','null\n')).toBe(false);
  expect(idleTurnFinished('codex','{"type":"event_msg","payload":{"type":"task_complete"}}\n{"type":"response_item","payload":{"type":"message","role":"user"}}\n')).toBe(false);
  expect(idleTurnFinished('claude','{"type":"assistant","message":{"stop_reason":"tool_use"}}\n')).toBe(false);
  expect(idleInputEmpty('codex','›\n  a multiline draft\n')).toBe(false);
  expect(idleInputEmpty('claude','❯ 1. Approve\n')).toBe(false);
});

test('configured idle timeout accepts 1–2 hours and defaults invalid values to 2h',()=>{
  expect(chatIdleTimeoutFromMinutes('60')).toBe(3_600_000);
  expect(chatIdleTimeoutFromMinutes('90')).toBe(5_400_000);
  for(const value of [undefined,'','bad','0','59','121'])expect(chatIdleTimeoutFromMinutes(value)).toBe(CHAT_IDLE_TIMEOUT_MS);
});

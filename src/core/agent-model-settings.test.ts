import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { UserStore } from './users';
import { ConversationManager, type ConvDriver } from './conversations';
import { AgentModelSettings, modelControlReady, selectedModelForConversation } from './agent-model-settings';
import { KeyedMutex } from '../issues/mutex';
import type { AgentModelApplyRequest, AgentModelApplyResult } from '../../shared/agent-models';
import { agentModelsRoutes } from '../web/routes/agent-models';
import { createDispatcher, authDepsFromDb } from '../web/middleware';

const cleanups: Array<() => Promise<void>>=[];
afterEach(async () => { for(const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
  const db=openDb(':memory:');migrate(db);migrateIssueEngine(db);
  const users=new UserStore(db);const alice=users.create('alice');const bob=users.create('bob');
  db.run("INSERT INTO executors(name,host,port,ssh_user,key_ref,workspace_root,claude_dir) VALUES('remote','host',22,'panda','','/repo','/agent/.claude')");
  db.query("INSERT INTO projects(name,executor_id,cwd,owner_user_id,created_ts) VALUES('demo',1,'/repo',?,1)").run(alice.user.id);
  let pane='›';let live=true;let owned=true;let discoveryError=false;let result:AgentModelApplyResult={state:'applied',model:'live-model',effort:'ultra'};
  let discoveryHook:(()=>Promise<void>)|null=null;
  const calls:AgentModelApplyRequest[]=[];const starts:string[]=[];
  const driver:ConvDriver={
    findExecutable:async agent => `/bin/${agent}`,listSessions:async () => live?[{name:convs.sessionName(c),command:c.agent}]:[],
    createSession:async () => {live=true;},killSession:async () => {live=false;},sendKeys:async (_session,text) => {starts.push(text);},
    capturePane:async () => pane, statPath:async () => ({size:0,isDirectory:true}),readFileRange:async () => ({data:new Uint8Array(),size:0}),writeFile:async () => {},
    discoverAgentModels:async (agent,cwd,env) => {
      expect(cwd).toBe('/repo');expect(env?.CODEX_HOME).toBe('/agent/.codex');
      if(discoveryError) throw new Error('protocol_timeout');
      const hook=discoveryHook;discoveryHook=null;await hook?.();
      return {agent,fetchedAt:Date.now(),models:[{id:'live-model',name:'live-model',efforts:['low','ultra']},{id:'no-effort',name:'no-effort',efforts:[]}]};
    },
    applyAgentModel:async request => {calls.push(request);return result;},
  };
  const convs=new ConversationManager(db,driver,{locate:async()=>null},{codexHome:'/agent/.codex'});
  const c=convs.create(1,'test','codex','chat');
  db.query('UPDATE conversations SET agent_session_id=? WHERE id=?').run('native-session',c.id);
  const mutex=new KeyedMutex();
  const service=new AgentModelSettings(db,async t => ({driver,cwd:'/repo',session:t.conversation?convs.sessionName(t.conversation):null,env:{CODEX_HOME:'/agent/.codex'},owned:()=>owned}),id=>convs.get(id),(key,work)=>mutex.runExclusive(key,work));
  cleanups.push(async()=>{await service.stop();db.close();});
  const target=()=>service.target('conversation',c.id,1);
  const dispatch=createDispatcher(agentModelsRoutes(service),authDepsFromDb(db,users));
  const request=async(method:string,url:string,token:string|undefined,body?:unknown)=>{
    const response=await dispatch(new Request(`http://x/api/projects/1${url}`,{method,headers:{...(token?{authorization:`Bearer ${token}`} : {}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}));
    return {status:response!.status,body:await response!.json() as any};
  };
  return {db,convs,c,service,target,calls,starts,mutex,alice,bob,request,
    setDiscoveryHook:(v:()=>Promise<void>)=>{discoveryHook=v;},setPane:(v:string)=>{pane=v;},setLive:(v:boolean)=>{live=v;},setOwned:(v:boolean)=>{owned=v;},setDiscoveryError:()=>{discoveryError=true;},setResult:(v:AgentModelApplyResult)=>{result=v;}};
}
const selection={model:'live-model',effort:'ultra'};
describe('模型配置实时能力与持久会话',()=>{
  test('从项目执行机发现，保存后确认生效，使用原生会话及实际 cwd',async()=>{
    const s=setup();expect((await s.service.catalog(s.target())).models[0]!.efforts).toContain('ultra');
    expect(await s.service.save(s.target(),selection,0)).toMatchObject({state:'applied',revision:1,actual:selection});
    expect(s.calls[0]).toMatchObject({cwd:'/repo',nativeSessionId:'native-session',env:{CODEX_HOME:'/agent/.codex'}});
  });
  test('忙碌时保留待生效，下一次安全时机应用且不发送任务文本',async()=>{
    const s=setup();s.setPane('• Working\n› task\nesc to interrupt');
    expect((await s.service.save(s.target(),selection,0)).state).toBe('pending');expect(s.calls).toHaveLength(0);
    s.setPane('›');await s.service.tick();expect(s.service.state(s.target()).state).toBe('applied');expect(s.starts).toHaveLength(0);
  });
  test('未启动会话配置持久化且启动与恢复携带所选模型和档位',async()=>{
    const s=setup();s.setLive(false);expect((await s.service.save(s.target(),selection,0)).state).toBe('pending');
    expect(selectedModelForConversation(s.db,s.c)).toEqual(selection);
    await s.convs.relaunch(s.c.id);
    expect(s.starts.at(-1)).toContain('--model');expect(s.starts.at(-1)).toContain('live-model');expect(s.starts.at(-1)).toContain('model_reasoning_effort="ultra"');
    expect(s.starts.at(-1)).toContain('resume native-session');expect(s.service.state(s.target()).actual).toBeNull();
  });
  test('不支持的模型/档位、发现失败均不写配置',async()=>{
    const s=setup();await expect(s.service.save(s.target(),{model:'made-up',effort:'ultra'},0)).rejects.toThrow('model_selection_invalid');
    await expect(s.service.save(s.target(),{model:'no-effort',effort:'ultra'},0)).rejects.toThrow('model_selection_invalid');
    s.setDiscoveryError();await expect(s.service.save(s.target(),selection,0)).rejects.toThrow('protocol_timeout');expect(s.service.state(s.target()).revision).toBe(0);
  });
  test('并发保存使用 CAS，只有一条配置能够生效',async()=>{
    const s=setup();const results=await Promise.allSettled([s.service.save(s.target(),selection,0),s.service.save(s.target(),selection,0)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(s.calls).toHaveLength(1);
  });
  test('绑定归属失效时不调用执行器',async()=>{
    const s=setup();s.setOwned(false);await expect(s.service.save(s.target(),selection,0)).rejects.toThrow('model_target_changed');expect(s.calls).toHaveLength(0);
  });
  test('协议失败不标记成功，不在后台盲目重发',async()=>{
    const s=setup();s.setResult({state:'failed',error:'model_apply_unconfirmed'});
    expect((await s.service.save(s.target(),selection,0)).state).toBe('failed');await s.service.tick();expect(s.calls).toHaveLength(1);
  });
  test('issue 尚无绑定会话时保存，绑定后配置仍由 issue 继承',async()=>{
    const s=setup();s.db.query("INSERT INTO issues(id,project_id,title,created_ts,agent,status) VALUES('issue-model',1,'test',1,'codex','pending')").run();
    const t=s.service.target('issue','issue-model',1);expect((await s.service.save(t,selection,0)).state).toBe('pending');
    s.db.query("UPDATE issues SET conv_id=? WHERE id='issue-model'").run(s.c.id);expect(selectedModelForConversation(s.db,s.c)).toEqual(selection);
    expect(()=>s.service.target('issue','issue-model',2)).toThrow('model_target_unavailable');
  });
  test('API 有项目权限、目标归属、能力校验与 CAS 校验',async()=>{
    const s=setup();const url=`/conversations/${s.c.id}`;
    expect((await s.request('GET',url+'/model-options',undefined)).status).toBe(401);
    expect((await s.request('GET',url+'/model-options',s.bob.token)).status).toBe(403);
    expect((await s.request('GET',url+'/model-options',s.alice.token)).body.catalog.models[0].id).toBe('live-model');
    expect((await s.request('PATCH',url+'/model-settings',s.alice.token,{...selection,revision:0})).body.state).toBe('applied');
    expect((await s.request('PATCH',url+'/model-settings',s.alice.token,{...selection,revision:0})).status).toBe(409);
    expect((await s.request('PATCH',url+'/model-settings',s.alice.token,{model:'bad',effort:null,revision:1})).status).toBe(400);
  });
  test('重新发现期间的旧配置不会覆盖较新的保存',async()=>{
    const s=setup();s.setLive(false);await s.service.save(s.target(),selection,0);s.setLive(true);
    let entered!:()=>void;let release!:()=>void;
    const ready=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
    s.setDiscoveryHook(async()=>{entered();await gate;});
    const tick=s.service.tick();await ready;
    const saved=s.service.save(s.target(),selection,1);
    // 新选择先持久化，再排队等同一会话锁。
    for(let i=0;i<20&&s.service.state(s.target()).revision!==2;i++)await Bun.sleep(5);
    expect(s.service.state(s.target()).revision).toBe(2);release();
    await Promise.all([tick,saved]);expect(s.calls).toHaveLength(1);expect(s.service.state(s.target()).state).toBe('applied');
  });
  test('Claude 启动与恢复使用所选模型及 CLI effort，终态 issue 拒绝写入',async()=>{
    const s=setup();const c=s.convs.create(1,'claude','claude','chat');
    const t=s.service.target('conversation',c.id,1);
    await s.service.save(t,{model:'live-model',effort:'low'},0);await s.convs.relaunch(c.id);
    expect(s.starts.at(-1)).toContain('--model');expect(s.starts.at(-1)).toContain('--effort');expect(s.starts.at(-1)).toContain('low');
    s.db.query("INSERT INTO issues(id,project_id,title,created_ts,agent,status) VALUES('closed-model',1,'test',1,'codex','done')").run();
    await expect(s.service.save(s.service.target('issue','closed-model',1),selection,0)).rejects.toThrow('model_target_unavailable');
  });
  test('控制入口保留用户草稿，并拒绝菜单、执行提示和 shell',()=>{
    expect(modelControlReady('claude','❯')).toBe(true);
    expect(modelControlReady('claude','❯ draft')).toBe(true);
    for(const pane of ['❯ 1. yes\n 2. no','bash $','❯\nesc to interrupt']) expect(modelControlReady('claude',pane)).toBe(false);
  });
});

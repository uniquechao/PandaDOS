import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { LocalDriver } from './local';
import { PaneCacheDriver } from './pane-cache';
import { applyAgentModel, discoverAgentModels } from './agent-model-protocol';
import type { AgentModelApplyRequest } from '../../shared/agent-models';

const paths:string[]=[];
afterEach(()=>{for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture() {
  mkdirSync('.panda/tmp',{recursive:true});const dir=mkdtempSync('.panda/tmp/model-protocol-test-');paths.push(dir);
  const executable=resolve(dir,'cli.py');
  writeFileSync(executable,`#!/usr/bin/env python3
import sys,json,os
for line in sys.stdin:
 r=json.loads(line)
 if r.get('type')=='control_request':
  print(json.dumps({'type':'control_response','response':{'request_id':r['request_id'],'subtype':'success','response':{'models':[{'value':'sonnet','displayName':'Sonnet','resolvedModel':'live-claude','supportsEffort':True,'supportedEffortLevels':['low','max']},{'value':'haiku','displayName':'Haiku'}],'account':{'secret':'never-export'}}}}),flush=True)
  continue
 method=r.get('method');data={}
 if method=='initialized':continue
 if method=='model/list':
  data={'data':[{'id':'live-codex','model':'live-codex','displayName':'Live','supportedReasoningEfforts':[{'reasoningEffort':'ultra'}],'defaultReasoningEffort':'ultra','hidden':False}],'nextCursor':None}
 elif method=='thread/read':data={'thread':{'cwd':os.environ.get('FAKE_CWD',os.getcwd()),'status':{'type':'active' if os.environ.get('FAKE_BUSY') else 'idle'}}}
 elif method=='thread/settings/update':
  if os.environ.get('FAKE_REJECT'):
   print(json.dumps({'id':r['id'],'error':{'message':'reject'}}),flush=True);continue
  assert r['params']['model']=='live-codex';assert r['params']['effort']=='ultra'
 elif method!='initialize':
  print(json.dumps({'id':r.get('id'),'error':{'message':'forbidden'}}),flush=True);continue
 print(json.dumps({'id':r['id'],'result':data}),flush=True)
`,{mode:0o700});
  const local=new LocalDriver();const driver={findExecutable:async()=>executable,runCommand:local.runCommand.bind(local)};
  const request:AgentModelApplyRequest={agent:'codex',cwd:resolve(dir),session:'test',nativeSessionId:'native',model:'live-codex',effort:'ultra'};
  return {driver,local,request,dir};
}
test('真实子进程协议解析 Claude 与 Codex 的实时目录，不导出账户信息',async()=>{
  const s=fixture();const claude=await discoverAgentModels(s.driver,'claude',resolve(s.dir));
  expect(claude.models).toEqual([{id:'sonnet',name:'Sonnet',resolvedModel:'live-claude',efforts:['low','max']},{id:'haiku',name:'Haiku',efforts:[]}]);
  expect(JSON.stringify(claude)).not.toContain('never-export');
  expect((await discoverAgentModels(s.driver,'codex',resolve(s.dir))).models[0]).toMatchObject({id:'live-codex',efforts:['ultra'],defaultEffort:'ultra'});
});
test('Codex 只更新绑定的空闲 thread，拒绝 cwd 不匹配与协议错误',async()=>{
  const s=fixture();expect(await applyAgentModel(s.driver,s.request)).toMatchObject({state:'applied',model:'live-codex',effort:'ultra'});
  expect(await applyAgentModel(s.driver,{...s.request,env:{FAKE_BUSY:'1'}})).toEqual({state:'pending'});
  await expect(applyAgentModel(s.driver,{...s.request,env:{FAKE_CWD:'/another'}})).rejects.toThrow('thread_workspace_mismatch');
  await expect(applyAgentModel(s.driver,{...s.request,env:{FAKE_REJECT:'1'}})).rejects.toThrow('protocol_request_rejected');
  expect(await applyAgentModel(s.driver,{...s.request,nativeSessionId:null})).toEqual({state:'pending'});
});
test('缓存包装器透传实时发现/切换，并在切换后失效抓屏缓存',async()=>{
  const s=fixture();let reads=0;const local=s.local;
  local.discoverAgentModels=async(agent,cwd,env)=>discoverAgentModels(s.driver,agent,cwd,env);
  local.applyAgentModel=async request=>applyAgentModel(s.driver,request);
  local.capturePane=async()=>String(++reads);
  const wrapped=new PaneCacheDriver(local);
  expect((await wrapped.discoverAgentModels('codex',s.request.cwd)).models[0]!.id).toBe('live-codex');
  expect(await wrapped.capturePane('test')).toBe('1');await wrapped.applyAgentModel(s.request);expect(await wrapped.capturePane('test')).toBe('2');
});

test('Claude 使用原生菜单会话确认，保留草稿且不提交文本或改全局默认',async()=>{
  const s=fixture();const tmux=resolve(s.dir,'tmux');const statePath=resolve(s.dir,'state.json');
  writeFileSync(tmux,`#!/usr/bin/env python3
import sys,json,os
path=os.environ['FAKE_TMUX_STATE']
try:
 with open(path) as file:state=json.load(file)
except FileNotFoundError:state={'phase':'idle','cursor':1,'effort':'medium','keys':[]}
args=sys.argv[1:]
if args[0]=='send-keys':
 key=args[-1];state['keys'].append(key)
 if key=='M-p':state['phase']='menu'
 elif key=='Down':state['cursor']+=1
 elif key=='Up':state['cursor']-=1
 elif key=='Right':state['effort']='high'
 elif key=='Left':state['effort']='medium'
 elif key in ['s','Escape']:state['phase']='confirmed' if key=='s' else 'idle'
 with open(path,'w') as file:json.dump(state,file)
else:
 if state['phase']=='menu':
  print('Select model')
  for index,name in [(1,'Default'),(2,'Sonnet')]:print(('❯' if state['cursor']==index else ' ')+' '+str(index)+'. '+name+'  description')
  print(state['effort'].title()+' effort ←/→ to adjust')
  print('Enter to set as default · s to use this session only · Esc to cancel' if not os.environ.get('FAKE_UNSUPPORTED') else 'Enter to set as default')
 elif state['phase']=='confirmed':print('Model set to Sonnet (live-claude) for this session only\\n❯ draft retained')
 else:print('❯ draft retained')
`,{mode:0o700});
  const request:AgentModelApplyRequest={...s.request,agent:'claude',model:'sonnet',modelName:'Sonnet',resolvedModel:'live-claude',effort:'high',env:{PATH:resolve(s.dir)+':'+process.env.PATH,FAKE_TMUX_STATE:statePath}};
  expect(await applyAgentModel(s.driver,request)).toMatchObject({state:'applied',model:'sonnet',effort:'high'});
  const state=JSON.parse(await Bun.file(statePath).text());
  expect(state.keys).toEqual(['M-p','Down','Right','s']);
  expect(state.keys).not.toContain('Enter');
  rmSync(statePath);
  await expect(applyAgentModel(s.driver,{...request,env:{...request.env,FAKE_UNSUPPORTED:'1'}})).rejects.toThrow('model_session_control_unsupported');
  expect(JSON.parse(await Bun.file(statePath).text()).keys).toEqual(['M-p','Escape']);
});

import type { AgentKind } from '../core/types';
import type { AgentModelApplyRequest, AgentModelApplyResult, AgentModelCatalog } from '../../shared/agent-models';
import { validModelToken } from '../../shared/agent-models';

/** 固定控制协议脚本；本地和 SSH 共用。只输出模型元数据，不输出账户或凭据。 */
export const AGENT_MODEL_PROTOCOL = String.raw`
import sys,json,subprocess,selectors,os,time
exe,agent,operation=sys.argv[1:4]
request=json.loads(sys.argv[4]); proc=None
try:
 if agent=='claude' and operation=='apply':
  import re
  session=request['session']; control_deadline=time.monotonic()+16
  def tmux(*args):
   remaining=control_deadline-time.monotonic()
   if remaining<=0:raise RuntimeError('model_control_timeout')
   result=subprocess.run(['tmux',*args],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=min(3,remaining),text=True)
   if result.returncode:raise RuntimeError('model_control_failed')
   return result.stdout
  def screen():return tmux('capture-pane','-p','-t',session)
  def key(value):tmux('send-keys','-t',session,value);time.sleep(.15)
  before=screen()
  tail='\n'.join(before.splitlines()[-12:])
  if re.search(r'esc to (?:interrupt|cancel)|thinking|working|running',tail,re.I):
   print(json.dumps({'state':'pending'}));sys.exit(0)
  key('M-p')
  def menu():
   text=screen()
   if 'Select model' not in text or 's to use this session only' not in text:raise RuntimeError('model_session_control_unsupported')
   rows=[]
   for line in text.splitlines():
    match=re.match(r'^\s*(❯)?\s*(\d+)\.\s+(.+)$',line)
    if match:rows.append((int(match[2]),bool(match[1]),match[3]))
   cursor=[row[0] for row in rows if row[1]]
   wanted=[row[0] for row in rows if row[2].startswith(request['modelName']) and (len(row[2])==len(request['modelName']) or row[2][len(request['modelName'])].isspace())]
   if len(cursor)!=1 or len(wanted)!=1:raise RuntimeError('model_menu_changed')
   return text,cursor[0],wanted[0]
  try:
   for step in range(30):
    text,cursor,wanted=menu()
    if cursor==wanted:break
    key('Down' if cursor<wanted else 'Up')
   else:raise RuntimeError('model_menu_changed')
   effort=request.get('effort')
   if effort:
    levels={'low':'low','medium':'medium','high':'high','very high':'xhigh','extra high':'xhigh','xhigh':'xhigh','max':'max'}
    for step in range(15):
     text,cursor,wanted=menu()
     match=re.search(r'(?i)\b(very high|extra high|xhigh|low|medium|high|max) effort\b',text)
     if not match:raise RuntimeError('model_effort_control_unsupported')
     current=levels[match[1].lower()]
     if current==effort:break
     order=['low','medium','high','xhigh','max']
     if effort not in order:raise RuntimeError('model_effort_control_unsupported')
     key('Right' if order.index(current)<order.index(effort) else 'Left')
    else:raise RuntimeError('model_effort_control_unsupported')
   text,cursor,wanted=menu()
   if cursor!=wanted:raise RuntimeError('model_menu_changed')
   key('s')
   for check in range(15):
    after=screen()
    if 'Select model' not in after and after!=before and re.search(r'(?i)Model set to .+ for this session only',after) and (request.get('resolvedModel','').lower() in after.lower() if request.get('resolvedModel') else request['modelName'].lower() in after.lower()):
     # 仅接受当前原生菜单的会话回执，禁止全局默认设置确认。
     print(json.dumps({'state':'applied','model':request['model'],'effort':effort}));sys.exit(0)
    time.sleep(.15)
   raise RuntimeError('model_apply_unconfirmed')
  except Exception:
   # 只取消仍由本操作打开的模型菜单，不对其它状态盲发 Escape。
   if 'Select model' in screen():key('Escape')
   raise
 args=['app-server','proxy'] if operation=='apply' else ['app-server','--stdio']
 if agent=='claude': args=['--print','--input-format','stream-json','--output-format','stream-json','--verbose','--safe-mode','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','']
 proc=subprocess.Popen([exe]+args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
 selector=selectors.DefaultSelector();selector.register(proc.stdout,selectors.EVENT_READ)
 buffer=b''; deadline=time.monotonic()+18
 def write(value):
  proc.stdin.write((json.dumps(value)+'\n').encode());proc.stdin.flush()
 def receive():
  global buffer
  while b'\n' not in buffer:
   remaining=deadline-time.monotonic()
   if remaining<=0 or not selector.select(remaining):raise RuntimeError('protocol_timeout')
   chunk=os.read(proc.stdout.fileno(),65536)
   if not chunk:raise RuntimeError('protocol_closed')
   buffer+=chunk
   if len(buffer)>2097152:raise RuntimeError('protocol_output_limit')
  line,buffer=buffer.split(b'\n',1)
  return json.loads(line)
 def rpc(id,method,params):
  write({'id':id,'method':method,'params':params})
  while True:
   value=receive()
   if value.get('id')==id:
    if 'error' in value:raise RuntimeError('protocol_request_rejected')
    return value.get('result',{})
 if agent=='claude':
  write({'type':'control_request','request_id':'models','request':{'subtype':'initialize'}})
  while True:
   value=receive()
   if value.get('type')=='control_response' and value.get('response',{}).get('request_id')=='models':
    response=value['response']
    if response.get('subtype')!='success':raise RuntimeError('initialize_rejected')
    models=response.get('response',{}).get('models')
    if not isinstance(models,list):raise RuntimeError('model_catalog_unsupported')
    print(json.dumps({'models':[{'id':m.get('value'),'name':m.get('displayName',m.get('value')),'resolvedModel':m.get('resolvedModel'),'efforts':m.get('supportedEffortLevels',[]) if m.get('supportsEffort') else []} for m in models]}));break
 else:
  rpc(1,'initialize',{'clientInfo':{'name':'pandados-model-settings','version':'1'},'capabilities':{'experimentalApi':True}})
  write({'method':'initialized'})
  if operation=='discover':
   models=[];cursor=None
   for page in range(10):
    result=rpc(2+page,'model/list',{'limit':100,'cursor':cursor,'includeHidden':False})
    models.extend({'id':m.get('model',m.get('id')),'name':m.get('displayName',m.get('id')),'efforts':[e['reasoningEffort'] for e in m.get('supportedReasoningEfforts',[])],'defaultEffort':m.get('defaultReasoningEffort')} for m in result.get('data',[]) if not m.get('hidden'))
    cursor=result.get('nextCursor')
    if not cursor:break
   if cursor:raise RuntimeError('model_catalog_limit')
   print(json.dumps({'models':models}))
  else:
   thread=rpc(2,'thread/read',{'threadId':request['nativeSessionId'],'includeTurns':False})['thread']
   if thread.get('cwd')!=request['cwd']:raise RuntimeError('thread_workspace_mismatch')
   if thread.get('status',{}).get('type')!='idle':print(json.dumps({'state':'pending'}))
   else:
    params={'threadId':request['nativeSessionId'],'model':request['model']}
    if request.get('effort') is not None:params['effort']=request['effort']
    rpc(3,'thread/settings/update',params)
    # RPC 成功明确确认后续轮次的配置；不会启动或中断当前轮次。
    print(json.dumps({'state':'applied','model':request['model'],'effort':request.get('effort')}))
except Exception as error:
 print(json.dumps({'error':str(error) if str(error).startswith(('protocol_','model_','initialize_','thread_')) else 'protocol_failed'}))
finally:
 if proc:
  import signal
  try:os.killpg(proc.pid,signal.SIGTERM)
  except ProcessLookupError:pass
  try:proc.wait(timeout=1)
  except subprocess.TimeoutExpired:
   try:os.killpg(proc.pid,signal.SIGKILL)
   except ProcessLookupError:pass
   proc.wait()
`;

export interface AgentModelProtocolDriver {
  findExecutable(agent: AgentKind): Promise<string | null>;
  runCommand(cwd: string, argv: string[], timeout: number, env?: Record<string, string>): Promise<{ code: number; out: string; timedOut: boolean }>;
}
async function protocol(driver: AgentModelProtocolDriver, agent: AgentKind, cwd: string, operation: string, request: unknown, env?: Record<string,string>): Promise<any> {
  const executable = await driver.findExecutable(agent);
  if (!executable) throw new Error('agent_not_installed');
  const result = await driver.runCommand(cwd, ['python3', '-c', AGENT_MODEL_PROTOCOL, executable, agent, operation, JSON.stringify(request)], 22_000, env);
  if (result.code || result.timedOut) throw new Error('model_protocol_failed');
  const data = JSON.parse(result.out.trim());
  if (data.error) throw new Error(data.error);
  return data;
}
export async function discoverAgentModels(driver: AgentModelProtocolDriver, agent: AgentKind, cwd: string, env?: Record<string,string>): Promise<AgentModelCatalog> {
  const data = await protocol(driver, agent, cwd, 'discover', {}, env);
  if (!Array.isArray(data.models) || !data.models.length || data.models.length > 1000) throw new Error('model_catalog_empty');
  const seen = new Set<string>();
  const models = data.models.map((m: any) => {
    if (!validModelToken(m.id) || seen.has(m.id) || !Array.isArray(m.efforts) || m.efforts.length > 20 || m.efforts.some((e: unknown) => !validModelToken(e))) throw new Error('model_catalog_invalid');
    seen.add(m.id);
    return { id: m.id, name: typeof m.name === 'string' ? m.name.slice(0, 200) : m.id, efforts: [...new Set<string>(m.efforts)], ...(validModelToken(m.resolvedModel) ? { resolvedModel: m.resolvedModel } : {}), ...(m.efforts.includes(m.defaultEffort) ? { defaultEffort: m.defaultEffort } : {}) };
  });
  return { agent, models, fetchedAt: Date.now() };
}
export async function applyAgentModel(driver: AgentModelProtocolDriver, request: AgentModelApplyRequest): Promise<AgentModelApplyResult> {
  if (request.agent === 'codex' && !request.nativeSessionId) return { state: 'pending' };
  const result = await protocol(driver, request.agent, request.cwd, 'apply', request, request.env);
  if (result.state === 'pending') return result;
  if (result.state !== 'applied' || result.model !== request.model || result.effort !== request.effort) throw new Error('model_apply_unconfirmed');
  return result;
}

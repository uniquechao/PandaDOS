import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { LocalDriver } from './local';
import { STOP_WORKSPACE_PROCESSES, workspaceEnvArgs } from './workspace-processes';

test('真实 Local 进程：停止指定轮次及其子进程，不停止其它轮次',async()=>{
 const attempt=randomUUID(),other=randomUUID(),driver=new LocalDriver(),startTs=String(Date.now());
 const start=(id:string)=>Bun.spawn(['python3','-c','import subprocess,time; child=subprocess.Popen(["sleep","60"]); print(child.pid,flush=True); time.sleep(60)'],{env:{...process.env,PANDA_WORKSPACE_ATTEMPT:id},stdout:'pipe',stderr:'ignore'});
 const a=start(attempt),b=start(other),fixturePids=[String(a.pid),String(b.pid)];
 // 只隔离测试的进程枚举；stat/environ、信号发送和退出确认仍访问真实 /proc。
 // 全量门禁中的其它进程不属于本 fixture，不能影响本测试或被本测试停止。
 const stopProgram=()=>`import os
original_listdir=os.listdir
fixture_pids=${JSON.stringify(fixturePids)}
os.listdir=lambda path: fixture_pids if path=='/proc' else original_listdir(path)
`+STOP_WORKSPACE_PROCESSES;
 const stop=(id:string)=>driver.runCommand(process.cwd(),['python3','-c',stopProgram(),id,startTs],15000);
 const ready=async(proc:typeof a)=>{
  const reader=proc.stdout.getReader();
  const decoder=new TextDecoder();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
   const pid=await Promise.race([
    (async()=>{
     let output='';
     while(!output.includes('\n')) {
      const chunk=await reader.read();
      if(chunk.done) throw new Error('测试进程在子进程就绪前退出');
      output+=decoder.decode(chunk.value,{stream:true});
     }
     const child=output.split('\n')[0].trim();
     if(!/^\d+$/.test(child)) throw new Error('测试进程未返回有效子进程 ID');
     fixturePids.push(child);
     return child;
    })(),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('等待测试子进程就绪超时')),5000);}),
   ]);
   return pid;
  } finally {clearTimeout(timer);await reader.cancel();reader.releaseLock();}
 };
 const running=async(pid:string)=>{
  try {return (await readFile(`/proc/${pid}/stat`,'utf8')).split(') ').pop()!.split(' ')[0]!=='Z';}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
 };
 try {
  const [childA,childB]=await Promise.all([ready(a),ready(b)]);
  expect(await running(childA)).toBe(true);expect(await running(childB)).toBe(true);
  const stopped=await stop(attempt);
  expect(stopped.code,stopped.err).toBe(0);expect(stopped.out.trim()).toBe('stopped');
  await a.exited;expect(await running(childA)).toBe(false);
  expect(b.exitCode).toBeNull();expect(await running(childB)).toBe(true);
  const again=await stop(attempt);expect(again.code,again.err).toBe(0);
 } finally {try {await stop(attempt);await stop(other);} finally {a.kill();b.kill();}}
},20000);

test('环境参数保留特殊字符并拒绝非法名称和 NUL',()=>{
 expect(workspaceEnvArgs({PORT:'18000',TMPDIR:"路径 ' $HOME"})).toEqual(['PORT=18000',"TMPDIR=路径 ' $HOME"]);
 expect(()=>workspaceEnvArgs({'A;id':'x'})).toThrow();expect(()=>workspaceEnvArgs({A:'\0'})).toThrow();
});

for(const scenario of ['foreign-login','same-domain','login-controller','writable-scope','user-owned-scope','own-environ','missing-cgroup','marked-login'] as const) {
 test(`停止确认：隔离登录进程 ${scenario}`,async()=>{
  const fixture=String.raw`
import builtins,io,types,os
original_open=builtins.open
original_stat=os.stat
original_access=os.access
uid=os.getuid()
scenario=${JSON.stringify(scenario)}
prefix='/user.slice/user-'+str(uid)+'.slice/'
login=prefix+'session-123.scope'
service=prefix+'user@'+str(uid)+'.service/app.slice/panda.service'
signalled=False
def fixture_open(path,*args,**kwargs):
 if path=='/proc/stat': return io.StringIO('btime 0\n')
 if path=='/proc/self/cgroup': return io.StringIO('0::'+(login if scenario=='login-controller' else service)+'\n')
 if path=='/proc/424242/cgroup':
  if scenario=='missing-cgroup': raise FileNotFoundError(path)
  return io.StringIO('0::'+(service if scenario=='same-domain' else login)+'\n')
 if path=='/proc/424242/stat':
  fields=['0']*20
  fields[0]='Z' if signalled else 'S'
  fields[19]='100'
  return io.StringIO('424242 (sshd) '+' '.join(fields))
 if path=='/proc/424242/environ':
  if scenario=='marked-login': return io.BytesIO(b'PANDA_WORKSPACE_ATTEMPT='+__import__('sys').argv[1].encode()+b'\0')
  raise PermissionError(13,'Permission denied',path)
 return original_open(path,*args,**kwargs)
def fixture_stat(path,*args,**kwargs):
 if path=='/proc/424242': return types.SimpleNamespace(st_uid=uid)
 if path=='/proc/424242/environ': return types.SimpleNamespace(st_uid=uid if scenario=='own-environ' else 0)
 if path=='/sys/fs/cgroup'+login: return types.SimpleNamespace(st_uid=uid if scenario=='user-owned-scope' else 0)
 return original_stat(path,*args,**kwargs)
def fixture_access(path,mode,*args,**kwargs):
 if path=='/sys/fs/cgroup'+login+'/cgroup.procs': return scenario=='writable-scope'
 return original_access(path,mode,*args,**kwargs)
def fixture_kill(pid,sig):
 global signalled
 if scenario!='marked-login': raise AssertionError('不得停止未确认归属的登录进程')
 signalled=True
builtins.open=fixture_open
os.stat=fixture_stat
os.access=fixture_access
os.listdir=lambda path: ['424242'] if path=='/proc' else []
os.kill=fixture_kill
`;
  const result=await new LocalDriver().runCommand(process.cwd(),['python3','-c',fixture+STOP_WORKSPACE_PROCESSES,randomUUID(),'0'],15000);
  if(scenario==='foreign-login'||scenario==='marked-login') {
   expect(result.code,result.err).toBe(0);expect(result.out.trim()).toBe('stopped');
  } else {
   expect(result.code).not.toBe(0);expect(result.out).not.toContain('stopped');
  }
 });
}

// 在真实 Python 中控制 /proc 读取的边界，稳定复现 stat 与 environ 之间的退出竞态。
// 只允许已确认退出的进程通过；活跃但不可检查的进程必须保持失败。
for(const transition of ['zombie','gone','delayed-zombie','delayed-gone','slow-zombie','slow-gone','alive'] as const) {
 test(`停止确认：environ 拒绝访问后重新核对进程 ${transition}`,async()=>{
  const fixture=String.raw`
import builtins,io,types,os
original_open=builtins.open
original_stat=os.stat
original_listdir=os.listdir
reads=0
transition=${JSON.stringify(transition)}
def fixture_open(path,*args,**kwargs):
 global reads
 if path=='/proc/stat': return io.StringIO('btime 0\n')
 if path=='/proc/424242/stat':
  reads+=1
  exited=reads>(30 if transition.startswith('slow-') else 3 if transition.startswith('delayed-') else 1)
  if exited and transition.endswith('gone'): raise FileNotFoundError(path)
  fields=['0']*20
  fields[0]='Z' if exited and transition.endswith('zombie') else 'S'
  fields[19]='100'
  return io.StringIO('424242 (fixture) '+' '.join(fields))
 if path=='/proc/424242/environ': raise PermissionError(13,'Permission denied',path)
 return original_open(path,*args,**kwargs)
builtins.open=fixture_open
os.stat=lambda path,*args,**kwargs: types.SimpleNamespace(st_uid=os.getuid()) if path=='/proc/424242' else original_stat(path,*args,**kwargs)
os.listdir=lambda path: ['424242'] if path=='/proc' else original_listdir(path)
def unexpected_kill(*args): raise AssertionError('不可向归属未知的进程发送信号')
os.kill=unexpected_kill
`;
  const result=await new LocalDriver().runCommand(process.cwd(),['python3','-c',fixture+STOP_WORKSPACE_PROCESSES,randomUUID(),'0'],15000);
  if(transition==='alive') {
   expect(result.code).not.toBe(0);
   expect(result.err).toContain('PermissionError');
   expect(result.out).not.toContain('stopped');
  } else {
   expect(result.code,result.err).toBe(0);
   expect(result.out.trim()).toBe('stopped');
  }
 });
}

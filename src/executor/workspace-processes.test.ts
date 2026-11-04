import { expect,test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LocalDriver } from './local';
import { STOP_WORKSPACE_PROCESSES, workspaceEnvArgs } from './workspace-processes';

test('真实 Local 进程：停止指定轮次及其子进程，不停止其它轮次',async()=>{
 const attempt=randomUUID(),other=randomUUID(),driver=new LocalDriver(),startTs=String(Date.now());
 const start=(id:string)=>Bun.spawn(['python3','-c','import subprocess,time; subprocess.Popen(["sleep","60"]); time.sleep(60)'],{env:{...process.env,PANDA_WORKSPACE_ATTEMPT:id},stdout:'ignore',stderr:'ignore'});
 const a=start(attempt),b=start(other);
 try {
  await new Promise(r=>setTimeout(r,150));
  const stopped=await driver.runCommand(process.cwd(),['python3','-c',STOP_WORKSPACE_PROCESSES,attempt,startTs],15000);
  expect(stopped.code,stopped.err).toBe(0);expect(stopped.out.trim()).toBe('stopped');
  await a.exited;expect(b.exitCode).toBeNull();
  const again=await driver.runCommand(process.cwd(),['python3','-c',STOP_WORKSPACE_PROCESSES,attempt,startTs],15000);expect(again.code).toBe(0);
 } finally {await driver.runCommand(process.cwd(),['python3','-c',STOP_WORKSPACE_PROCESSES,other,startTs],15000);a.kill();b.kill();}
},20000);

test('环境参数保留特殊字符并拒绝非法名称和 NUL',()=>{
 expect(workspaceEnvArgs({PORT:'18000',TMPDIR:"路径 ' $HOME"})).toEqual(['PORT=18000',"TMPDIR=路径 ' $HOME"]);
 expect(()=>workspaceEnvArgs({'A;id':'x'})).toThrow();expect(()=>workspaceEnvArgs({A:'\0'})).toThrow();
});

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

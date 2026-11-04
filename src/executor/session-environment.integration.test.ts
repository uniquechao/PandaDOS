import { test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { LocalDriver } from './local';
import { SshDriver } from './ssh';
import { workspaceEnvironment } from '../core/workspace-ownership';
import { prepareDependencies } from '../issues/dependency-preparation';
import { testTmuxDirectory } from '../../scripts/test-tmux';

// This fixture reads Linux /proc and launches its own sshd; do not fail portable suites without that capability.
const hasSshFixture = process.platform === 'linux' && existsSync('/usr/sbin/sshd');
test.skipIf(!hasSshFixture)('真实 Local 与隔离 SSH：深层工作区环境、会话重建与锁文件依赖准备',async()=>{
 mkdirSync('.private',{recursive:true});
 const root=mkdtempSync(process.cwd()+'/.private/ssh-env-');
 const socket=testTmuxDirectory();
 const previous={TMUX:process.env.TMUX,TMUX_TMPDIR:process.env.TMUX_TMPDIR};
 delete process.env.TMUX;process.env.TMUX_TMPDIR=socket;
 const key=root+'/key';
 const listener=createServer();
 await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
 const port=(listener.address() as {port:number}).port;
 await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
 execFileSync('ssh-keygen',['-q','-t','ed25519','-N','','-f',key]);
 writeFileSync(root+'/authorized_keys',readFileSync(key+'.pub'),{mode:0o600});
 const config=root+'/sshd_config';
 writeFileSync(config,[`Port ${port}`,'ListenAddress 127.0.0.1',`HostKey ${key}`,`AuthorizedKeysFile ${root}/authorized_keys`,
  'Subsystem sftp internal-sftp','StrictModes no','UsePAM no','PasswordAuthentication no','KbdInteractiveAuthentication no',
  `PidFile ${root}/sshd.pid`,`SetEnv TMUX_TMPDIR=${socket} PATH=${process.env.PATH}`,'LogLevel ERROR'].join('\n')+'\n');
 const sshd=Bun.spawn(['/usr/sbin/sshd','-D','-e','-f',config],{stdout:'ignore',stderr:'pipe'});
 // Bun's os.userInfo may report an environment placeholder in containers; sshd authenticates the real UID account.
 const username=execFileSync('id',['-un'],{encoding:'utf8'}).trim();
 const remote=new SshDriver({host:'127.0.0.1',port,username,privateKeyPath:key,readyTimeoutMs:3000});
 const local=new LocalDriver();
 const sessions:string[]=[];
 try {
  // 等待监听，不使用任何生产 SSH 账号授权或服务配置。
  for(let n=0;n<40;n++) {
   if(sshd.exitCode!==null)throw new Error(await new Response(sshd.stderr).text());
   try {const probe=await Bun.connect({hostname:'127.0.0.1',port,socket:{data(){},open(socket){socket.end();},error(){}}});probe.end();break;}
   catch {await Bun.sleep(50);}
  }
  const keeper='accept-keeper-'+randomUUID();sessions.push(keeper);
  await local.createSession(keeper,root);
  for(const [label,driver] of [['local',local],['ssh',remote]] as const) {
   const cwd=root+'/'+label+'/integration/'+randomUUID()+'/深层候选目录';
   mkdirSync(cwd+'/fixture',{recursive:true});
   writeFileSync(cwd+'/fixture/package.json',JSON.stringify({name:'fixture',version:'1.0.0',main:'index.js'}));
   writeFileSync(cwd+'/fixture/index.js','module.exports=42;\n');
   writeFileSync(cwd+'/package.json',JSON.stringify({dependencies:{fixture:'file:./fixture'}}));
   expect((await local.runCommand(cwd,['bun','install','--lockfile-only'],30000)).code).toBe(0);
   expect(await driver.statPath(cwd+'/node_modules')).toBeNull();
   const env=workspaceEnvironment(cwd,randomUUID(),23000+(label==='ssh'?1:0));
   for(const value of Object.values(env).filter(v=>v.startsWith(cwd)&&!v.endsWith('.db')&&!v.endsWith('/admin-token')))await driver.mkdirp(value);
   await prepareDependencies(driver,cwd,env);
   expect((await driver.runCommand(cwd,['bun','-e',"if(require('fixture')!==42) process.exit(1)"],10000,env)).code).toBe(0);
   const session='accept-'+randomUUID();sessions.push(session);
   // TMUX_TMPDIR 是 pane 环境的一部分；控制端使用独立短 socket，不能误连调用者会话。
   for(let generation=0;generation<2;generation++) {
    await driver.createSession(session,cwd,env);
    const check=await driver.runCommand(cwd,['python3','-c',String.raw`
import os, subprocess, json, time
pid=subprocess.check_output(['tmux','display-message','-p','-t',os.environ['SESSION'],'#{pane_pid}'],text=True).strip()
for _ in range(40):
    data=dict(item.split(b'=',1) for item in open('/proc/'+pid+'/environ','rb').read().split(b'\0') if b'=' in item)
    if b'PANDA_WORKSPACE_ATTEMPT' in data: break
    time.sleep(.05)
print(json.dumps({k.decode():v.decode() for k,v in data.items() if k.startswith(b'PANDA_') or k==b'TMUX_TMPDIR'}))
`],10000,{SESSION:session,TMUX_TMPDIR:socket});
    expect(check.code).toBe(0);
    const actual=JSON.parse(check.out);
    expect(actual.PANDA_WORKSPACE_ATTEMPT).toBe(env.PANDA_WORKSPACE_ATTEMPT);
    expect(actual.PANDA_WORKSPACE_CWD).toBe(cwd);
    expect(actual.PANDA_DB).toBe(env.PANDA_DB);
    expect(actual.TMUX_TMPDIR).toBe(env.TMUX_TMPDIR);
    await driver.killSession(session);
   }
  }
 } finally {
  for(const name of [...sessions].reverse())await local.killSession(name).catch(()=>{});
  await remote.close();sshd.kill();await sshd.exited;
  for(const [key,value] of Object.entries(previous)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  rmSync(root,{recursive:true,force:true});rmSync(socket,{recursive:true,force:true});
 }
},60000);

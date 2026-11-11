import { test, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { LocalDriver } from '../executor/local';
import { prepareDependencies, DependencyPreparationError, confirmDependencyPreparationStopped } from './dependency-preparation';

test('dependency disconnect and timeout remain uncertain, while a confirmed failed command does not',async()=>{
 for(const mode of ['disconnect','timeout','failed'] as const){
  let error:unknown;
  try{await prepareDependencies({runCommand:async()=>{if(mode==='disconnect')throw new Error('SSH lost');return {code:1,out:'',err:'failed',timedOut:mode==='timeout',durationMs:1};}},'/unused');}catch(e){error=e;}
  expect(error).toBeInstanceOf(DependencyPreparationError);
  expect((error as DependencyPreparationError).uncertain).toBe(mode!=='failed');
 }
});

test('dependency verification refuses a live installer lock and accepts only after it is released',async()=>{
 mkdirSync('.private',{recursive:true});const root=mkdtempSync(process.cwd()+'/.private/deps-barrier-');
 mkdirSync(root+'/.panda/tmp/dependencies',{recursive:true});
 const child=Bun.spawn(['python3','-u','-c',"import fcntl,time; f=open('.panda/tmp/dependencies/install.lock','a+'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(20)"],{cwd:root,stdout:'pipe',stderr:'ignore'});
 try{
  const reader=child.stdout.getReader();await reader.read();reader.releaseLock();
  await expect(confirmDependencyPreparationStopped(new LocalDriver(),root)).rejects.toThrow('仍在执行');
  child.kill();await child.exited;
  await confirmDependencyPreparationStopped(new LocalDriver(),root);
 }finally{child.kill();await child.exited;rmSync(root,{recursive:true,force:true});}
});

for(const [manager,lock,version,expected] of [
 ['bun','bun.lock','1.3.14',['install','--frozen-lockfile']],
 ['npm','package-lock.json','10.0.0',['ci','--include=dev']],
 ['pnpm','pnpm-lock.yaml','10.0.0',['install','--frozen-lockfile','--prod=false']],
 ['yarn','yarn.lock','1.22.0',['install','--frozen-lockfile']],
 ['yarn','yarn.lock','4.0.0',['install','--immutable']],
] as const) {
 test(`依赖准备 ${manager} ${version}：冻结安装、幂等回执与依赖损坏后重装`,async()=>{
  mkdirSync('.private',{recursive:true});const root=mkdtempSync(process.cwd()+'/.private/deps-');
  try {
   mkdirSync(root+'/bin');
   writeFileSync(root+'/package.json',JSON.stringify({packageManager:manager+'@'+version,devDependencies:{fixture:'1.0.0'}}));
   writeFileSync(root+'/'+lock,'锁文件夹具');
   writeFileSync(root+'/bin/'+manager,`#!/bin/sh\nif [ "$1" = "--version" ]; then echo '${version}'; exit 0; fi\nprintf '%s\\n' "$@" > install-args\necho installed >> calls\nmkdir -p node_modules\n`,{mode:0o755});
   const env={PATH:root+'/bin:'+process.env.PATH};const driver=new LocalDriver();
   await prepareDependencies(driver,root,env);
   expect(readFileSync(root+'/install-args','utf8').trim().split('\n')).toEqual([...expected]);
   await prepareDependencies(driver,root,env);
   expect(readFileSync(root+'/calls','utf8').trim().split('\n')).toHaveLength(1);
   writeFileSync(root+'/node_modules/unexpected','依赖输入变化');
   await prepareDependencies(driver,root,env);
   expect(readFileSync(root+'/calls','utf8').trim().split('\n')).toHaveLength(2);
   expect(JSON.parse(readFileSync(root+'/.panda/tmp/dependencies/receipt.json','utf8')).phase).toBe('ready');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
}

test('依赖准备拒绝锁文件歧义和共享依赖软链，并保留明确环境诊断',async()=>{
 mkdirSync('.private',{recursive:true});const root=mkdtempSync(process.cwd()+'/.private/deps-');
 try {
  writeFileSync(root+'/package.json',JSON.stringify({dependencies:{fixture:'1.0.0'}}));
  const driver=new LocalDriver();
  await expect(prepareDependencies(driver,root)).rejects.toThrow('锁文件不明确');
  writeFileSync(root+'/bun.lock','锁文件夹具');writeFileSync(root+'/package-lock.json','{}');
  await expect(prepareDependencies(driver,root)).rejects.toThrow('锁文件不明确');
  rmSync(root+'/package-lock.json');mkdirSync(root+'/shared');symlinkSync(root+'/shared',root+'/node_modules');
  await expect(prepareDependencies(driver,root)).rejects.toThrow('共享软链');
  expect(JSON.parse(readFileSync(root+'/.panda/tmp/dependencies/receipt.json','utf8')).phase).toBe('failed');
 } finally {rmSync(root,{recursive:true,force:true});}
});

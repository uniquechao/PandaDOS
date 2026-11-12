import type { ExecutorDriver, GitResult } from '../executor/driver';

// Untracking preserves disk contents and history. Stage tracked changes as a group so Git
// can update previously tracked files beneath ignored directories without force-adding data.
export const RUNTIME_GIT_ROOTS=['.panda/tmp','.panda/conversations','node_modules'];
export async function stageSourceChanges(driver:Pick<ExecutorDriver,'git'>,cwd:string):Promise<GitResult> {
 const runtime=await driver.git(cwd,['rm','--cached','-r','-f','--quiet','--ignore-unmatch','--',...RUNTIME_GIT_ROOTS.map(p=>`:(literal)${p}`)]);
 if(runtime.code!==0)return runtime;
 const tracked=await driver.git(cwd,['add','-u','--','.']);
 if(tracked.code!==0)return tracked;
 const reset=await driver.git(cwd,['reset','--quiet','--','.build']);
 if(reset.code!==0)return reset;
 const files=await driver.git(cwd,['ls-files','--others','--exclude-standard','-z']);
 if(files.code!==0)return files;
 const roots=[...RUNTIME_GIT_ROOTS,'.build'];
 const source=[...new Set(files.out.split('\0').filter(p=>p&&!roots.some(root=>p===root||p.startsWith(root+'/'))))];
 let batch:string[]=[],bytes=0;
 const add=()=>driver.git(cwd,['add','-A','--',...batch.map(p=>`:(literal)${p}`)]);
 for(const file of source) {
  const size=Buffer.byteLength(file)*4+8; // SSH quoting may expand characters; stay well below argv limits.
  if(batch.length&&(bytes+size>48_000||batch.length>=500)) {
   const r=await add();if(r.code!==0)return r;batch=[];bytes=0;
  }
  batch.push(file);bytes+=size;
 }
 return batch.length?add():{code:0,out:'',err:''};
}

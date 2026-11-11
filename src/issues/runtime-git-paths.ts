import type { ExecutorDriver, GitResult } from '../executor/driver';

// Untracking preserves disk contents and history. Enumerating source paths also avoids Git's
// ignored-directory/exclusion-pathspec incompatibility, without force-adding ignored data.
export const RUNTIME_GIT_ROOTS=['.panda/tmp','.panda/conversations','node_modules'];
export async function stageSourceChanges(driver:Pick<ExecutorDriver,'git'>,cwd:string):Promise<GitResult> {
 const tracked=await driver.git(cwd,['ls-files','-z','--',...RUNTIME_GIT_ROOTS]);
 if(tracked.code!==0)return tracked;
 const names=tracked.out.split('\0').filter(Boolean);
 for(let n=0;n<names.length;n+=100) {
  const r=await driver.git(cwd,['rm','--cached','-f','--ignore-unmatch','--',...names.slice(n,n+100).map(p=>`:(literal)${p}`)]);
  if(r.code!==0)return r;
 }
 const reset=await driver.git(cwd,['reset','--quiet','--','.build']);
 if(reset.code!==0)return reset;
 const files=await driver.git(cwd,['ls-files','--cached','--others','--exclude-standard','-z']);
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

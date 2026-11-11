import { expect,test } from 'bun:test';
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { LocalDriver } from '../executor/local';

test('automatic staging removes runtime index entries while preserving disk data and module documents',async()=>{
 mkdirSync('.private',{recursive:true});const cwd=mkdtempSync(process.cwd()+'/.private/runtime-index-'),driver=new LocalDriver();
 const git=async(args:string[])=>{const r=await driver.git(cwd,args);if(r.code)throw new Error(r.err);return r.out;};
 const put=(rel:string,data:string)=>{const p=cwd+'/'+rel;mkdirSync(p.substring(0,p.lastIndexOf('/')),{recursive:true});writeFileSync(p,data);};
 try {
  await git(['init','-b','main']);await git(['config','user.name','test']);await git(['config','user.email','test@example.invalid']);
  put('source.ts','before');put('.panda/conversations/old.jsonl','old session');put('node_modules/.vitest/results.json','old runtime');
  await git(['add','-A']);await git(['commit','-m','legacy runtime files']);
  put('source.ts','after');put('.panda/conversations/old.jsonl','new session');put('.panda/tmp/runtime/test/data/panda.db','database');
  put('.panda/modules/module/MODULE.md','knowledge');put('node_modules/new-package/index.js','package');put('.build/output','artifact');
  await git(['add','-A']);
  put('.gitignore','.panda/tmp/\nnode_modules/\n.build/\n');put('*','literal source filename');
  const {stageSourceChanges}=await import('./runtime-git-paths');const r=await stageSourceChanges(driver,cwd);expect(r.code).toBe(0);
  const staged=await git(['diff','--cached','--name-status']);expect(staged).toContain('source.ts');expect(staged).toContain('*');expect(staged).toContain('.panda/modules/module/MODULE.md');
  expect(await git(['ls-files','--','.panda/conversations','.panda/tmp','node_modules'])).toBe('');
  expect(await git(['diff','--cached','--name-only','--','.build'])).toBe('');
  expect(readFileSync(cwd+'/.panda/conversations/old.jsonl','utf8')).toBe('new session');
  expect(readFileSync(cwd+'/.panda/tmp/runtime/test/data/panda.db','utf8')).toBe('database');
  expect(readFileSync(cwd+'/node_modules/.vitest/results.json','utf8')).toBe('old runtime');
 }finally {rmSync(cwd,{recursive:true,force:true});}
},30_000);

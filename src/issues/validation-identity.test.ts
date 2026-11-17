import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {LocalDriver} from '../executor/local';
import {candidateInputSnapshot,validationIdentity,validationCheckKey} from './validation-identity';
import {randomUUID} from 'node:crypto';
test('validation identity changes for uncommitted and untracked bytes, dependencies and commands',async()=>{
 mkdirSync('.private/validation-tests',{recursive:true});
 const cwd=mkdtempSync(process.cwd()+'/.private/validation-tests/repo-');
 const d=new LocalDriver();
 try{
  await d.git(cwd,['init']);writeFileSync(cwd+'/a.ts','one');await d.git(cwd,['add','a.ts']);
  const first=await validationIdentity(d,cwd);expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(await validationIdentity(d,cwd)).toBe(first);
  writeFileSync(cwd+'/a.ts','two');const edited=await validationIdentity(d,cwd);expect(edited).not.toBe(first);
  writeFileSync(cwd+'/untracked.ts','new');const added=await validationIdentity(d,cwd);expect(added).not.toBe(edited);
  writeFileSync(cwd+'/bun.lock','changed');expect(await validationIdentity(d,cwd)).not.toBe(added);
  expect(validationCheckKey(first!,['bun','test'])).not.toBe(validationCheckKey(first!,['bun','run','typecheck']));
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('candidate snapshot explains nested config and projected attachment drift without hashing runtime output',async()=>{
 mkdirSync('.private/validation-tests',{recursive:true});
 const cwd=mkdtempSync(process.cwd()+'/.private/validation-tests/repo-');
 const d=new LocalDriver();
 try {
  await d.git(cwd,['init']);
  writeFileSync(cwd+'/.gitignore','.panda/tmp/\n.env.local\n');
  mkdirSync(cwd+'/.panda/tmp/attachments/image',{recursive:true});
  mkdirSync(cwd+'/apps/web',{recursive:true});
  writeFileSync(cwd+'/.panda/tmp/attachments/image/reference.png','reference');
  writeFileSync(cwd+'/apps/web/.env.local','local config');
  const id=randomUUID();
  const commands=[{label:'Web validation',argv:['node','--version'],cwd:'apps/web'}];
  const before=await candidateInputSnapshot(d,cwd,commands,{},'start',id);
  expect(before?.digest).toMatch(/^[a-f0-9]{64}$/);
  writeFileSync(cwd+'/.panda/tmp/ordinary-output.log','ignored output');
  expect((await candidateInputSnapshot(d,cwd,commands,{},'current'))?.digest).toBe(before!.digest);
  writeFileSync(cwd+'/.panda/tmp/attachments/image/reference.png','changed reference');
  writeFileSync(cwd+'/apps/web/.env.local','changed configuration');
  const after=await candidateInputSnapshot(d,cwd,commands,{},'finish',id);
  expect(after).toMatchObject({changedPaths:['.panda/tmp/attachments/image/reference.png','apps/web/.env.local'],changedCount:2,environmentChanged:false});
  expect(after?.digest).not.toBe(before!.digest);
 } finally { rmSync(cwd,{recursive:true,force:true}); }
});

test('validation fingerprints distinguish generated dependency caches from actual dependency edits',async()=>{
 mkdirSync('.private/validation-tests',{recursive:true});
 const cwd=mkdtempSync(process.cwd()+'/.private/validation-tests/cache-');
 const d=new LocalDriver();
 try {
  await d.git(cwd,['init']);
  writeFileSync(cwd+'/.gitignore','node_modules/\n.panda/tmp/\n');
  for(const prefix of ['','apps/web/']) {
   const modules=cwd+'/'+prefix+'node_modules';
   mkdirSync(modules+'/fixture',{recursive:true});writeFileSync(modules+'/fixture/index.js','module.exports=42');
  }
  const commands=[{label:'check',argv:['node','--version']}];
  const first=await validationIdentity(d,cwd);
  const before=await candidateInputSnapshot(d,cwd,commands,{},'current');
  for(const prefix of ['','apps/web/']) {
   const modules=cwd+'/'+prefix+'node_modules';
   for(const dir of ['.vite/vitest','.vite-temp','.tmp'])mkdirSync(modules+'/'+dir,{recursive:true});
   writeFileSync(modules+'/.vite/vitest/results.json','generated results');
   writeFileSync(modules+'/.tmp/tsconfig.app.tsbuildinfo','generated build state');
   writeFileSync(modules+'/.vite-temp/vite.config.timestamp.mjs','generated config');
  }
  expect(await validationIdentity(d,cwd)).toBe(first);
  expect((await candidateInputSnapshot(d,cwd,commands,{},'current'))?.digest).toBe(before!.digest);
  writeFileSync(cwd+'/apps/web/node_modules/fixture/index.js','module.exports=43');
  expect((await candidateInputSnapshot(d,cwd,commands,{},'current'))?.digest).not.toBe(before!.digest);
  writeFileSync(cwd+'/node_modules/fixture/index.js','module.exports=43');
  expect(await validationIdentity(d,cwd)).not.toBe(first);
  const cacheOnly=await candidateInputSnapshot(d,cwd,commands,{},'current');
  writeFileSync(cwd+'/apps/web/node_modules/.tmp/source.js','actual executable input');
  expect((await candidateInputSnapshot(d,cwd,commands,{},'current'))?.digest).not.toBe(cacheOnly!.digest);
 } finally {rmSync(cwd,{recursive:true,force:true});}
});

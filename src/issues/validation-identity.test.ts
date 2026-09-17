import {expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {LocalDriver} from '../executor/local';
import {validationIdentity,validationCheckKey} from './validation-identity';
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

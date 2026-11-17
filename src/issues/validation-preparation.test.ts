import {expect,test} from 'bun:test';
import {splitValidationCommands} from './validation-preparation';

test('validation preparation preserves checks literally and rejects unsafe or mutable installation recipes',()=>{
 const check={label:'test',argv:['bun','--cwd','/declared-by-owner','test','--project','web']};
 expect(splitValidationCommands([check]).checks).toEqual([check]);
 for(const argv of [
  ['npm','--prefix','../outside','ci'],['npm','--prefix','/outside','ci'],
  ['npm','install','some-package'],['npm','ci','--omit=dev'],
 ])expect(()=>splitValidationCommands([{label:'install',argv}])).toThrow('validation_preparation');
 const frozen={label:'install',argv:['npm','--prefix','apps/web','ci','--prefer-offline']};
 const result=splitValidationCommands([frozen,check]);
 expect(result.checks).toEqual([check]);
 expect(result.preparation[0]).toMatchObject({cwd:'apps/web',argv:['npm','ci','--prefer-offline'],kind:'node'});
});

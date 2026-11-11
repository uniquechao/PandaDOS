import {test,expect} from 'bun:test';
import {incidentEvidence} from './incident-evidence';

test('branch cause is verified only from two concrete current branch facts',()=>{
 const facts=incidentEvidence(JSON.stringify({headSha:'a'.repeat(40),actualBranch:'codex/prototype',workspace:{expectedBranch:'panda/module',cwd:'/workspace'}}));
 expect(facts).toMatchObject({sha:'a'.repeat(40),actual:'codex/prototype',expected:'panda/module',branchMismatch:true,workspaceReadable:true});
 expect(incidentEvidence(JSON.stringify({actualBranch:'same',expectedBranch:'same'})).branchMismatch).toBe(false);
 expect(incidentEvidence(JSON.stringify({actualBranch:{unavailable:'permission denied'},expectedBranch:'expected'})).branchMismatch).toBe(false);
 expect(incidentEvidence(JSON.stringify({headSha:'not-a-sha',actualBranch:'actual'})).sha).toBe('');
});
test('missing/malformed evidence remains unknown, and command failure records keep their exact meaning',()=>{
 expect(incidentEvidence('not json')).toMatchObject({branchMismatch:false,sha:'',failure:'',workspaceReadable:false});
 expect(incidentEvidence('null').branchMismatch).toBe(false);
 const facts=incidentEvidence(JSON.stringify({events:[{kind:'transition',data:{note:'generic pause'}},{kind:'environment_preparation_failed',data:{note:'install failed'}},{kind:'error',data:{error:'most recent concrete failure'}}]}));
 expect(facts.failure).toBe('most recent concrete failure');
 expect(incidentEvidence(JSON.stringify({events:[{kind:'error',data:{error:'TOKEN=private-value'}}]})).failure).not.toContain('private-value');
});

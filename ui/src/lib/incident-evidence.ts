import {redactDiagnostic} from '../../../shared/issue-diagnostics';

/** Presentation facts only: absent evidence never becomes a verified root cause. */
export function incidentEvidence(evidence:string) {
  let data:Record<string,any>={};
  try {const value=JSON.parse(evidence);if(value && typeof value==='object' && !Array.isArray(value))data=value;}catch{/* unknown evidence stays in technical details */}
  const text=(value:unknown)=>typeof value==='string' ? redactDiagnostic(value) : '';
  const actual=text(data.actualBranch);
  const expected=text(data.workspace?.expectedBranch)||text(data.expectedBranch);
  const sha=typeof data.headSha==='string' && /^[a-f0-9]{40,64}$/.test(data.headSha) ? data.headSha : '';
  let failure='';
  if(Array.isArray(data.events))for(const event of [...data.events].reverse()) {
    if(!event || typeof event.kind!=='string' || !/^(error|validation_failed|tests_failed|environment_preparation_failed|environment_recovery_failed|incident_recovery_failed)$/.test(event.kind))continue;
    const details=event.data;
    if(!details || typeof details!=='object')continue;
    failure=text(details.error)||text(details.note)||text(details.failureOutput);
    if(failure)break;
  }
  return {sha,actual,expected,failure,branchMismatch:!!actual && !!expected && actual!==expected,
    workspaceReadable:!!sha && typeof data.workspace?.cwd==='string' && !!data.workspace.cwd};
}

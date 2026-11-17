import type { Database } from 'bun:sqlite';
import type { IssueId } from '../../shared/issue-id';
import { redactDiagnosticValue } from '../../shared/issue-diagnostics';

/** A command exiting zero cannot replace the gate's actual failure. */
export function validationFailureEvidence(db:Database,issueId:IssueId,integrationId?:string) {
  const rows=db.query<{id:number;kind:string;data_json:string|null},[IssueId]>(`SELECT id,kind,data_json FROM issue_events
    WHERE issue_id=? AND kind IN ('validation_failed','validation_error','validation_invalidated','environment_preparation_failed')
    ORDER BY id DESC LIMIT 16`).all(issueId);
  for(const row of rows) {
    let data:Record<string,unknown>;
    try {data=JSON.parse(row.data_json??'{}');}catch {continue;}
    if(!data||typeof data!=='object'||Array.isArray(data))continue;
    if(integrationId&&data.integrationId&&data.integrationId!==integrationId)continue;
    return {id:row.id,kind:row.kind,data:redactDiagnosticValue(data)};
  }
  return null;
}

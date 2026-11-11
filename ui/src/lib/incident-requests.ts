export interface IncidentRequest {key:string;kind:'send'|'resolve'|'action'|'refresh';payload:Record<string,string>}
export function incidentRequestRejected(error:{status:number;code:string}):boolean {
  return error.code!=='incident.busy' && error.status>=400 && error.status<500 && ![408,429].includes(error.status);
}
export function prepareIncidentRequest(saved:IncidentRequest|null,kind:IncidentRequest['kind'],payload:Record<string,string>):IncidentRequest {
  if(saved) {
    if(saved.kind!==kind || JSON.stringify(saved.payload)!==JSON.stringify(payload))throw new Error('incident_request_pending');
    return saved;
  }
  return {key:crypto.randomUUID(),kind,payload};
}

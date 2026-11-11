import { test,expect } from 'bun:test';
import { prepareIncidentRequest, incidentRequestRejected } from './incident-requests';
test('lost response keeps the exact original recovery/message identity and payload',()=>{
  const first=prepareIncidentRequest(null,'resolve',{guidance:'checked'});
  expect(prepareIncidentRequest(first,'resolve',{guidance:'checked'})).toEqual(first);
  expect(()=>prepareIncidentRequest(first,'resolve',{guidance:'changed'})).toThrow('incident_request_pending');
  expect(()=>prepareIncidentRequest(first,'send',{content:'new'})).toThrow('incident_request_pending');
  expect(prepareIncidentRequest(null,'send',{content:'hello'}).key).not.toBe(first.key);
});
test('in-flight busy, timeout and network errors preserve the original request key',()=>{
 for(const error of [{status:409,code:'incident.busy'},{status:408,code:'api.unknown'},{status:503,code:'api.unknown'},{status:0,code:'network.unreachable'}])expect(incidentRequestRejected(error)).toBe(false);
 expect(incidentRequestRejected({status:409,code:'incident.operation_failed'})).toBe(true);
});

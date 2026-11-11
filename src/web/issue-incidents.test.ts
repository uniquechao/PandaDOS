import { test, expect } from 'bun:test';
import { incidentFixture } from '../issues/incidents.test';
import { IssueIncidentService } from './issue-incidents';

test('opening automatically runs one isolated diagnosis; conversation and hold survive reopen', async () => {
  const f = incidentFixture(); const requests: any[]=[];
  const engine = {
    store:f.issues,incidents:f.store,
    incidentStopId:()=>f.issues.listEvents(f.issue.id).filter(e=>e.kind==='transition').at(-1)!.id,
    incidentAttemptId:()=>null,
    openIncident:async()=>f.store.open(f.issue,f.issues.listEvents(f.issue.id).at(-1)!.id,null,1,'zh-Hans'),
    resolveIncident:async()=>({ok:true,queued:true}),
  };
  const service = new IssueIncidentService({engine:engine as any,evidence:async()=>'{"actualBranch":"codex/test","expectedBranch":"panda/module"}',
    run:async r=>{requests.push(r);return '现场分支与登记分支不一致，请先确认基线。';},model:()=>({agent:'codex',model:'fixture',effort:'low'})});
  try {
    const first=await service.open(f.issue.id,1,'zh-Hans'); await service.wait(first.incident.id);
    const reopened=await service.open(f.issue.id,1,'zh-Hans'); await service.wait(first.incident.id);
    expect(requests).toHaveLength(1);
    expect(reopened.messages.at(-1)?.content).toContain('分支');
    expect(requests[0].scopeId).toBe(first.incident.id);
    expect(requests[0].input).toContain('codex/test');
    expect(requests[0].system).toContain('zh-Hans');
    await service.send(f.issue.id,first.incident.id,'followup','我已处理，请复查',1);
    await service.wait(first.incident.id);
    expect(requests).toHaveLength(2);
    expect(f.store.held(f.issue.id)).toBe(true);
    expect(f.issues.get(f.issue.id)?.status).toBe('paused');
    expect(()=>service.view('different' as any,first.incident.id)).toThrow('incident_not_found');
  } finally {await service.stop();f.db.close();}
});

test('diagnosis failure preserves evidence and hold; marking resolved does not trust model text',async()=>{
  const f=incidentFixture();let resolves=0;
  const engine={store:f.issues,incidents:f.store,incidentStopId:()=>f.issues.listEvents(f.issue.id).at(-1)!.id,incidentAttemptId:()=>null,
    openIncident:async()=>f.store.open(f.issue,f.issues.listEvents(f.issue.id).at(-1)!.id,null,1,'en'),
    resolveIncident:async()=>{resolves++;return {ok:true,queued:true};}};
  const service=new IssueIncidentService({engine:engine as any,evidence:async()=>'actual failure evidence',model:()=>({agent:'codex',model:'fixture',effort:'low'}),run:async()=>{throw new Error('CLI not configured');}});
  try {
    const first=await service.open(f.issue.id,1,'en');await service.wait(first.incident.id);
    expect(service.view(f.issue.id,first.incident.id).incident.runState).toBe('failed');
    expect(service.view(f.issue.id,first.incident.id).evidence).toContain('actual failure');
    expect(resolves).toBe(0);expect(f.store.held(f.issue.id)).toBe(true);
    await service.resolve(f.issue.id,first.incident.id,'resume','checked manually',1);
    expect(resolves).toBe(1);
  } finally {await service.stop();f.db.close();}
});

test('manual resolution waits for active repair; new conversation writes cannot race its side effects',async()=>{
 const f=incidentFixture();let release!:()=>void;let resolved=false;let started!:()=>void;
 const entered=new Promise<void>(r=>started=r);const barrier=new Promise<void>(r=>release=r);
 const engine={store:f.issues,incidents:f.store,incidentStopId:()=>f.issues.listEvents(f.issue.id).at(-1)!.id,incidentAttemptId:()=>null,
  openIncident:async()=>f.store.open(f.issue,f.issues.listEvents(f.issue.id).at(-1)!.id,null,1,'en'),
  incidentRepair:async()=>{started();await barrier;return {ok:true};},resolveIncident:async()=>{resolved=true;return {ok:true,queued:true};}};
 const service=new IssueIncidentService({engine:engine as any,evidence:async()=>'facts',model:()=>({agent:'codex',model:'fixture',effort:'low'}),run:async()=> 'diagnosis'});
 try{
  const opened=await service.open(f.issue.id,1,'en');await service.wait(opened.incident.id);
  const action=service.action(f.issue.id,opened.incident.id,'action','environment','a'.repeat(40),1);await entered;
  await expect(service.send(f.issue.id,opened.incident.id,'race','race',1)).rejects.toThrow('incident_busy');
  const resume=service.resolve(f.issue.id,opened.incident.id,'resume','checked',1);
  await Promise.resolve();expect(resolved).toBe(false);
  release();await action;await resume;expect(resolved).toBe(true);
 }finally{release();await service.stop();f.db.close();}
});

test('same-key repair retries join the original in-flight result instead of discarding request identity',async()=>{
 const f=incidentFixture();let release!:()=>void;let calls=0;const barrier=new Promise<void>(r=>release=r);
 const engine={store:f.issues,incidents:f.store,incidentStopId:()=>f.issues.listEvents(f.issue.id).at(-1)!.id,incidentAttemptId:()=>null,
  openIncident:async()=>f.store.open(f.issue,f.issues.listEvents(f.issue.id).at(-1)!.id,null,1,'en'),
  incidentRepair:async()=>{calls++;await barrier;return {ok:true};},resolveIncident:async()=>({ok:true,queued:true})};
 const service=new IssueIncidentService({engine:engine as any,evidence:async()=>'facts',model:()=>({agent:'codex',model:'fixture',effort:'low'}),run:async()=> 'diagnosis'});
 try {
  const v=await service.open(f.issue.id,1,'en');await service.wait(v.incident.id);
  const first=service.action(f.issue.id,v.incident.id,'same-key','environment','a'.repeat(40),1);
  const duplicate=service.action(f.issue.id,v.incident.id,'same-key','environment','a'.repeat(40),1);
  const both=Promise.all([first,duplicate]);release();
  expect(await both).toEqual([{ok:true,error:undefined},{ok:true,error:undefined}]);expect(calls).toBe(1);
 }finally{release();await service.stop();f.db.close();}
});

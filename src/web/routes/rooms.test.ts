import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { IssueStore, migrateIssueEngine, type IssueEngine } from '../../issues/engine';
import { RoomEngine } from '../../rooms/engine';
import { RoomStore } from '../../rooms/store';
import { migrateRooms } from '../../rooms/migrations';
import type { RoomFormalResult } from '../../rooms/contracts';
import type { RoomMember, RoomSnapshot } from '../../../shared/rooms';
import type { RoomModelCatalog } from '../../../shared/room-models';
import { createDispatcher, authDepsFromDb } from '../middleware';
import { RoomPublicationService } from '../room-publication';
import { roomRuntimeAccess } from '../room-runtime-access';
import { roomsRoutes, type RoomsRoutesDeps } from './rooms';

const cleanup: Array<()=>void> = [];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function setup(options: { responseTimeoutMs?: number; runtime?: Partial<RoomsRoutesDeps['runtime']> } = {}) {
  const db=openDb(':memory:');cleanup.push(()=>db.close());migrate(db);migrateIssueEngine(db);migrateRooms(db);
  const users=new UserStore(db);const owner=users.create('owner');const member=users.create('member');const outsider=users.create('outsider');
  db.run("INSERT INTO executors(name,host,ssh_user,key_ref,workspace_root,claude_dir,supports_claude,supports_codex) VALUES('test','127.0.0.1','test','test','/workspace','/workspace/claude',1,1)");
  for (const id of [1,2]) db.query('INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(?,?,1,?,?,?)').run(id,`Project ${id}`,`/workspace/p${id}`,owner.user.id,Date.now());
  db.query('INSERT INTO project_members(project_id,user_id,created_ts) VALUES(?,?,?)').run(1,member.user.id,Date.now());
  const service=new RoomEngine({store:new RoomStore(db)});const issuesStore=new IssueStore(db);let scheduled=0;let configured=true;
  let projectionFailure=false;
  let scheduleFailure=false;
  let beforeCreate: (()=>void|Promise<void>)|undefined;
  let afterCommit: (()=>void|Promise<void>)|undefined;
  const issues:Pick<IssueEngine,'createIssue'|'scheduleNext'>={
    async createIssue(projectId,input,_start,onCreated){await beforeCreate?.();const issue=db.transaction(()=>{const issue=issuesStore.create(projectId,{...input,executionMode:'direct'});onCreated?.(issue);return issue;})();await afterCommit?.();if(projectionFailure)throw new Error('private-projection-marker');return issue;},
    async scheduleNext(){scheduled++;if(scheduleFailure)throw new Error('temporary scheduling failure');},
  };
  const publication=new RoomPublicationService({db,rooms:service,issues,responseTimeoutMs:options.responseTimeoutMs});
  const dispatch=createDispatcher(roomsRoutes({db,service,publication,runtime:{configured:()=>configured,...options.runtime},coordinator:{wake(){},cancelRoom(){}}}),authDepsFromDb(db,users));
  const api=async (method:string,path:string,body?:unknown,token=owner.token,key:string=crypto.randomUUID())=>{
    const response=await dispatch(new Request(`http://rooms.test/api/projects/${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})}));
    if(!response)throw new Error('missing route');return {status:response.status,body:await response.json() as any};
  };
  const create=async(start=false,token=owner.token)=>{const result=await api('POST','1/rooms',{title:'Launch',request:'Write a clear introduction.',criteria:['Include three concrete examples.'],start,locale:'en'},token);expect(result.status).toBe(201);return result.body as RoomSnapshot;};
  const deliver=(snapshot:RoomSnapshot, markdown='# Introduction\n\nThree concrete examples.')=>{
    for(let i=0;i<8;i++) {
      const attempt=service.claimNext('route-test');if(!attempt)break;
      expect(service.dispatched(attempt)).toBe(true);
      const ctx=service.context(attempt);let result:RoomFormalResult;
      if(attempt.role==='coach')result={message:'A concise plan or decision.',decision:ctx.assessments.length?'complete':'continue'};
      else if(attempt.role==='planner')result={message:'Structure the introduction around three examples.'};
      else if(attempt.role==='writer')result={message:'Draft submitted.',artifact:{title:'Introduction',markdown}};
      else{const artifact=ctx.artifacts.at(-1)!;result={message:'The criteria are met.',review:{artifactId:artifact.id,artifactVersion:artifact.currentVersion,criteria:ctx.goal.criteria.map(c=>({criterionId:c.id,verdict:'passed',note:'Supported by this exact draft.'}))}};}
      expect(service.accept(attempt,result)).toBe(true);
    }
    return service.snapshot({projectId:1,roomId:snapshot.room.id});
  };
  return {db,users,owner,member,outsider,service,publication,issues,api,create,deliver,dispatch,issuesStore,get scheduled(){return scheduled;},set configured(value:boolean){configured=value;},set projectionFailure(value:boolean){projectionFailure=value;},set scheduleFailure(value:boolean){scheduleFailure=value;},set beforeCreate(fn:()=>void|Promise<void>){beforeCreate=fn;},set afterCommit(fn:()=>void|Promise<void>){afterCommit=fn;}};
}

describe('rooms project API',()=>{
  test('member model catalog is project scoped and supports runtimes without catalog hints',async()=>{
    let calls=0;
    const catalog:RoomModelCatalog={providers:[{provider:'codex',available:true,models:[{id:'gpt-5.4',efforts:['low','medium','high']}],metering:'cli_invocations'}]};
    const c=setup({runtime:{modelCatalog:()=>{calls++;return catalog;}}});
    const room=await c.create();
    expect((await c.api('GET',`1/rooms/${room.room.id}/member-models`,undefined,c.member.token)).body).toEqual(catalog);
    expect(calls).toBe(1);
    expect((await c.api('GET',`2/rooms/${room.room.id}/member-models`)).status).toBe(404);
    expect((await c.api('GET','1/rooms/missing/member-models')).status).toBe(404);
    expect((await c.api('GET',`1/rooms/${room.room.id}/member-models`,undefined,c.outsider.token)).status).toBe(403);
    expect(calls).toBe(1);
    const legacy=setup();const legacyRoom=await legacy.create();
    expect((await legacy.api('GET',`1/rooms/${legacyRoom.room.id}/member-models`)).body).toEqual({providers:[]});
  });

  test('batch members atomically add, edit and retire with room/member CAS and durable replay',async()=>{
    const c=setup(),room=await c.create();const root=`1/rooms/${room.room.id}`;
    const writer=room.members.find(member=>member.role==='writer')!,planner=room.members.find(member=>member.role==='planner')!;
    const input={expectedRoomVersion:room.room.version,changes:[
      {id:writer.id,expectedVersion:writer.version,displayName:'Lead writer',model:{provider:'codex',model:'gpt-5.4',effort:'high'}},
      {role:'writer',displayName:'Second writer',instructions:'Offer another draft.',model:{provider:'claude',model:'claude-sonnet-4-5',effort:'medium'}},
      {id:planner.id,expectedVersion:planner.version,remove:true},
    ]};
    const key=crypto.randomUUID();const result=await c.api('POST',`${root}/members/batch`,input,c.member.token,key);
    expect(result.status).toBe(200);
    const changed=result.body as RoomSnapshot;
    expect(changed.room.version).toBeGreaterThan(room.room.version);
    expect(changed.members.filter(member=>member.status==='active')).toHaveLength(4);
    expect(changed.members.find(member=>member.id===writer.id)).toMatchObject({displayName:'Lead writer',model:input.changes[0].model,address:writer.address});
    expect(changed.members.find(member=>member.id===planner.id)?.status).toBe('retired');
    expect(changed.members.find(member=>member.displayName==='Second writer')?.address).toContain(`room/${room.room.id}/agent/`);
    const replay=await c.api('POST',`${root}/members/batch`,input,c.member.token,key);
    expect(replay.status).toBe(200);expect(replay.body.room.version).toBe(changed.room.version);expect(replay.body.members).toEqual(changed.members);
    expect((await c.api('POST',`${root}/members/batch`,input)).status).toBe(409);
    expect((await c.api('POST',`${root}/members/batch`,{...input,expectedRoomVersion:changed.room.version},c.member.token,key)).body.error.code).toBe('rooms.idempotency_conflict');
    expect((await c.api('POST',`${root}/members/batch`,{expectedRoomVersion:changed.room.version,changes:[{id:writer.id,expectedVersion:writer.version,displayName:'Stale name'}]})).body.error.code).toBe('rooms.conflict');
    const cleared=await c.api('POST',`${root}/members/batch`,{expectedRoomVersion:changed.room.version,changes:[{id:writer.id,model:null}]});
    expect(cleared.status).toBe(200);expect(cleared.body.members.find((member:RoomMember)=>member.id===writer.id).model).toBeUndefined();
  });

  test('batch member foreign IDs, duplicate IDs and missing moderation roll back every change',async()=>{
    const c=setup(),room=await c.create(),other=await c.create();const root=`1/rooms/${room.room.id}`;
    const writer=room.members.find(member=>member.role==='writer')!,coach=room.members.find(member=>member.role==='coach')!;
    const input={expectedRoomVersion:room.room.version,changes:[{id:writer.id,displayName:'Must roll back'},{id:other.members[0].id,displayName:'Foreign member'}]};
    expect((await c.api('POST',`${root}/members/batch`,input)).status).toBe(404);
    expect((await c.api('POST',`2/rooms/${room.room.id}/members/batch`,{...input,changes:[input.changes[0]]})).status).toBe(404);
    expect((await c.api('POST',`${root}/members/batch`,{...input,changes:[input.changes[0],input.changes[0]]})).status).toBe(409);
    expect((await c.api('POST',`${root}/members/batch`,{...input,changes:[input.changes[0],{id:coach.id,remove:true}]})).status).toBe(400);
    const after=c.service.snapshot({projectId:1,roomId:room.room.id});
    expect(after.room.version).toBe(room.room.version);expect(after.members).toEqual(room.members);
  });

  test('member model inputs reject malformed shapes, unsafe identifiers and unrecognized settings',async()=>{
    const c=setup(),room=await c.create(),member=room.members[0];const root=`1/rooms/${room.room.id}`;
    const model={provider:'codex',model:'gpt-5.4',effort:'medium'};
    const invalidModels:unknown[]=[false,[],{}, {...model,provider:'openai'},{...model,effort:'max'},{...model,command:'private-command'},
      ...['','a'.repeat(201),'-model','model name','model\n','model\r','model\t','model\0','model\x7f','模型','$(command)','a;command'].map(value=>({...model,model:value}))];
    for(const invalid of invalidModels){
      const batch=await c.api('POST',`${root}/members/batch`,{expectedRoomVersion:room.room.version,changes:[{id:member.id,model:invalid}]});
      expect(batch.status).toBe(400);expect(batch.body.error.code).toBe('rooms.invalid_request');
      const legacy=await c.api('POST',`${root}/members/${member.id}/configure`,{expectedVersion:member.version,displayName:member.displayName,instructions:'',model:invalid});
      expect(legacy.status).toBe(400);
    }
    const invalidChanges:unknown[]=[null,{},[],Array.from({length:25},()=>({role:'writer'})),[null],[[]],[{}],[{role:'admin'}],[{role:'writer',address:'foreign'}],[{id:member.id,remove:'yes'}],[{id:member.id,remove:true,displayName:'ambiguous'}],[{role:'writer',expectedVersion:1}],[{id:member.id,instructions:4}],[{id:member.id,instructions:'x'.repeat(4001)}],[{id:member.id,displayName:' '}],[{id:member.id,expectedVersion:1.5}]];
    for(const changes of invalidChanges)expect((await c.api('POST',`${root}/members/batch`,{expectedRoomVersion:room.room.version,changes})).status).toBe(400);
    expect((await c.api('POST',`${root}/members/batch`,{expectedRoomVersion:room.room.version,changes:[{id:member.id,displayName:'x'}],actor:{userId:c.owner.user.id}})).status).toBe(400);
    expect(c.service.snapshot({projectId:1,roomId:room.room.id}).members).toEqual(room.members);
  });

  test('legacy member configure sets, preserves and clears the optional model without changing identity',async()=>{
    const c=setup(),room=await c.create(),member=room.members[0];const root=`1/rooms/${room.room.id}/members/${member.id}/configure`;
    const input={expectedVersion:member.version,displayName:member.displayName,instructions:'Preserve this instruction.',model:{provider:'deepseek',model:'deepseek-chat',effort:'low'}};
    const configured=await c.api('POST',root,input);expect(configured.status).toBe(200);
    let current=configured.body.members.find((value:RoomMember)=>value.id===member.id);
    expect(current.model).toEqual(input.model);expect(current.address).toBe(member.address);
    const renamed=await c.api('POST',root,{expectedVersion:current.version,displayName:'Updated moderator',instructions:current.instructions});
    expect(renamed.status).toBe(200);current=renamed.body.members.find((value:RoomMember)=>value.id===member.id);expect(current.model).toEqual(input.model);
    const cleared=await c.api('POST',root,{expectedVersion:current.version,displayName:current.displayName,instructions:current.instructions,model:null});
    expect(cleared.status).toBe(200);expect(cleared.body.members.find((value:RoomMember)=>value.id===member.id).model).toBeUndefined();
  });

  test('batch writes retain authorization, request keys and archived-project restrictions',async()=>{
    const c=setup(),room=await c.create();const path=`1/rooms/${room.room.id}/members/batch`;
    const input={expectedRoomVersion:room.room.version,changes:[{id:room.members[0].id,displayName:'Updated'}]};
    expect((await c.api('POST',path,input,c.outsider.token)).status).toBe(403);
    expect((await c.api('POST',path,input,c.owner.token,'')).status).toBe(400);
    const stream=new ReadableStream<Uint8Array>({pull(controller){
      c.db.query('DELETE FROM project_members WHERE project_id=1 AND user_id=?').run(c.member.user.id);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));controller.close();
    }},{highWaterMark:0});
    const revoked=await c.dispatch(new Request(`http://rooms.test/api/projects/${path}`,{method:'POST',headers:{authorization:`Bearer ${c.member.token}`,'Idempotency-Key':'revoked-member-batch'},body:stream}));
    expect(revoked!.status).toBe(403);
    c.db.run("UPDATE projects SET status='archived' WHERE id=1");
    expect((await c.api('POST',path,input)).status).toBe(409);
    expect(c.service.snapshot({projectId:1,roomId:room.room.id}).members).toEqual(room.members);
  });

  test('member runtime readiness overrides legacy defaults and ignores retired members',async()=>{
    const checked:RoomMember[][]=[];let defaultReady=false;
    const c=setup({runtime:{configuredFor:members=>{checked.push(members);return members.length?members.every(member=>member.model?.provider==='codex'):defaultReady;}}});
    expect((await c.api('GET','1/rooms')).body.runtime.configured).toBe(false);
    expect(checked.at(-1)).toEqual([]);
    expect((await c.api('POST','1/rooms',{title:'Unavailable default',request:'Goal',start:true})).body.error.code).toBe('rooms.not_configured');
    const room=await c.create();expect(room.runtime?.configured).toBe(false);
    const planner=room.members.find(member=>member.role==='planner')!;
    const changed=await c.api('POST',`1/rooms/${room.room.id}/members/batch`,{expectedRoomVersion:room.room.version,changes:room.members.map(member=>member.id===planner.id?{id:member.id,remove:true}:{id:member.id,model:{provider:'codex',model:'gpt-5.4',effort:'low'}})});
    expect(changed.status).toBe(200);expect(changed.body.runtime.configured).toBe(true);expect(changed.body.capabilities.canStart).toBe(true);
    expect(checked.at(-1)?.some(member=>member.status==='retired')).toBe(false);
    c.configured=false;
    const started=await c.api('POST',`1/rooms/${room.room.id}/missions/${room.mission!.id}/start`,{expectedVersion:changed.body.mission.version});expect(started.status).toBe(202);
    defaultReady=true;
    expect((await c.api('GET','1/rooms')).body.runtime.configured).toBe(true);
    expect((await c.api('POST','1/rooms',{title:'Available default',request:'Goal',start:true})).status).toBe(201);
  });

  test('start, resume and question answers recheck current member runtime readiness',async()=>{
    let ready=true;const c=setup({runtime:{configuredFor:()=>ready}});const room=await c.create();const root=`1/rooms/${room.room.id}/missions/${room.mission!.id}`;
    ready=false;
    expect((await c.api('POST',`${root}/start`,{expectedVersion:room.mission!.version})).body.error.code).toBe('rooms.not_configured');
    ready=true;const started=await c.api('POST',`${root}/start`,{expectedVersion:room.mission!.version});expect(started.status).toBe(202);
    const paused=await c.api('POST',`${root}/pause`,{expectedVersion:started.body.mission.version});expect(paused.status).toBe(200);
    ready=false;
    const snapshot=await c.api('GET',`1/rooms/${room.room.id}/view`);expect(snapshot.body.runtime.configured).toBe(false);expect(snapshot.body.capabilities.canResume).toBe(false);
    expect((await c.api('POST',`${root}/resume`,{expectedVersion:paused.body.mission.version})).body.error.code).toBe('rooms.not_configured');
    ready=true;expect((await c.api('POST',`${root}/resume`,{expectedVersion:paused.body.mission.version})).status).toBe(202);
    const attempt=c.service.claimNext('ask-route')!;expect(c.service.dispatched(attempt)).toBe(true);
    expect(c.service.accept(attempt,{message:'Choose a direction.',decision:'ask_user',question:{text:'Which audience?',options:['Readers','Editors']}})).toBe(true);
    const waiting=c.service.snapshot({projectId:1,roomId:room.room.id});expect(waiting.mission!.state).toBe('waiting_user');
    const answer={expectedVersion:waiting.mission!.version,questionId:waiting.mission!.question!.id,answer:'Readers'};
    ready=false;expect((await c.api('POST',`${root}/answer`,answer)).body.error.code).toBe('rooms.not_configured');
    expect(c.service.snapshot({projectId:1,roomId:room.room.id}).mission!.state).toBe('waiting_user');
    ready=true;expect((await c.api('POST',`${root}/answer`,answer)).status).toBe(202);
  });

  test('goal inputs, history paging, source grants and member configuration keep their real contracts',async()=>{
    const c=setup();const room=await c.create(false);const root=`1/rooms/${room.room.id}`;
    const changed=await c.api('POST',`${root}/missions/${room.mission!.id}/goal`,{expectedVersion:room.mission!.version,request:'Write only in Chinese.',userCriteria:['Include three examples.']});
    expect(changed.status).toBe(200);
    expect(changed.body.goal.criteria.map((item:{description:string})=>item.description)).toEqual(['Write only in Chinese.','Include three examples.']);
    expect((await c.api('POST',`${root}/missions/${room.mission!.id}/goal`,{expectedVersion:changed.body.mission.version,request:'Other',criteria:[],userCriteria:[]})).status).toBe(400);
    const member=changed.body.members[0];
    const configured=await c.api('POST',`${root}/members/${member.id}/configure`,{expectedVersion:member.version,displayName:'Audience coach',instructions:'Ask concise audience questions.'});
    expect(configured.status).toBe(200);
    expect(configured.body.members.find((item:{id:string})=>item.id===member.id).displayName).toBe('Audience coach');
    const granted=await c.api('POST',`${root}/sources`,{missionId:room.mission!.id,goalRevision:changed.body.goal.revision,title:'Approved notes',content:'Use three concrete scenarios.',audience:{kind:'room'}});
    expect(granted.status).toBe(201);
    const source=granted.body.sources[0];
    expect(source.status).toBe('active');
    expect((await c.api('POST',`${root}/sources/${source.id}/revoke`,{})).body.sources[0].status).toBe('revoked');
    for(let index=0;index<90;index++)c.service.contribute({projectId:1,roomId:room.room.id},{text:`Message ${index}`,audience:{kind:'room'},clientMessageId:`page-${index}`},{userId:c.owner.user.id});
    const view=await c.api('GET',`${root}/view`);expect(view.status).toBe(200);expect(view.body.contributions).toHaveLength(80);expect(view.body.history.hasMore).toBe(true);
    const older=await c.api('GET',`${root}/contributions?beforeSeq=${view.body.history.beforeSeq}`);expect(older.body.contributions).toHaveLength(10);expect(older.body.hasMore).toBe(false);
    expect((await c.api('GET',`${root}/contributions?limit=101`)).status).toBe(400);
    expect((await c.api('POST',`${root}/contributions`,{text:'Old goal',clientMessageId:'stale-goal',audience:{kind:'room'},missionId:room.mission!.id,goalRevision:1})).status).toBe(409);
  });

  test('polling returns artifact metadata; an authorized detail request returns immutable bodies',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const view=await c.api('GET',`${root}/view`);
    expect(view.body.artifacts[0].versions[0].contentLoaded).toBe(false);
    expect(view.body.artifacts[0].versions[0].markdown).toBe('');
    const detail=await c.api('GET',`${root}/artifacts/${artifact.id}`);
    expect(detail.body.artifact.versions[0].markdown).toBe(artifact.versions[0].markdown);
    expect((await c.api('GET',`2/rooms/${room.room.id}/artifacts/${artifact.id}`)).status).toBe(404);
    const edited=await c.api('POST',`${root}/artifacts/${artifact.id}/edit`,{expectedVersion:1,expectedMissionVersion:room.mission!.version,title:'Edited',markdown:'A user-edited formal document.'});
    expect(edited.status).toBe(200);expect(edited.body.mission.state).toBe('paused');expect(edited.body.artifacts[0].currentVersion).toBe(2);
    expect((await c.api('POST',`${root}/artifacts/${artifact.id}/edit`,{expectedVersion:1,expectedMissionVersion:room.mission!.version,title:'Stale',markdown:'Must not overwrite.'})).status).toBe(409);
  });

  test('a hung publication scheduler has a bounded stop and a separate truthful resource barrier',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];
    let release!:()=>void;c.issues.scheduleNext=()=>new Promise<void>(resolve=>{release=resolve;});
    const published=await c.publication.publish({projectId:1,roomId:room.room.id},{artifactId:artifact.id,artifactVersion:1,title:'Execute',body:'Execute this approved document.'},room.mission!.version,{actor:{userId:c.owner.user.id},key:'drain'});
    expect(published.issueId).toBeTruthy();
    const draining=await c.publication.stop(1);expect(draining.settled).toBe(false);expect(draining.pending).toBe(1);
    let closed=false;void draining.done.then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
    expect(c.db.query('SELECT 1 AS ok').get()).toEqual({ok:1});
    release();await draining.done;expect(closed).toBe(true);
    expect(await c.publication.stop(1)).toBe(draining);
  });

  test('creates durable isolated members; idempotent creation and project scope are enforced',async()=>{
    const c=setup();const payload={title:'Room A',request:'A goal',start:false};const key=crypto.randomUUID();
    const a=await c.api('POST','1/rooms',payload,c.owner.token,key);const replay=await c.api('POST','1/rooms',payload,c.owner.token,key);
    expect(a.status).toBe(201);expect(replay.body.room.id).toBe(a.body.room.id);
    expect((await c.api('POST','1/rooms',{...payload,title:'Other'},c.owner.token,key)).status).toBe(409);
    expect((await c.api('GET',`2/rooms/${a.body.room.id}/snapshot`)).status).toBe(404);
    expect((await c.api('GET','1/rooms',undefined,c.outsider.token)).status).toBe(403);
    const b=await c.create(false,c.member.token);
    expect(b.members.every(m=>!a.body.members.some((old:{id:string})=>old.id===m.id))).toBe(true);
    expect(b.members.every(m=>m.address===`room/${b.room.id}/agent/${m.id}`)).toBe(true);
    const moved=await c.api('POST',`1/rooms/${b.room.id}/contributions`,{text:'Cross-room message',audience:{kind:'members',memberIds:[a.body.members[0].id]},clientMessageId:'cross-room'});
    expect([400,404]).toContain(moved.status);
  });

  test('configuration missing permits drafts but blocks starting; stale commands and forged actors fail',async()=>{
    const c=setup();c.configured=false;const room=await c.create();expect(room.runtime?.configured).toBe(false);expect(room.capabilities.canStart).toBe(false);
    const path=`1/rooms/${room.room.id}/missions/${room.mission!.id}/start`;
    expect((await c.api('POST',path,{expectedVersion:room.mission!.version})).status).toBe(409);
    c.configured=true;
    expect((await c.api('POST',path,{expectedVersion:room.mission!.version,actor:{userId:c.owner.user.id}})).status).toBe(400);
    const started=await c.api('POST',path,{expectedVersion:room.mission!.version});expect(started.status).toBe(202);
    expect((await c.api('POST',path,{expectedVersion:room.mission!.version})).status).toBe(409);
    const oversized=await c.api('POST','1/rooms',{title:'x',request:'x'.repeat(130_000)});expect(oversized.status).toBe(400);
    expect(JSON.stringify(oversized.body)).not.toContain('SQL');
  });

  test('revoking membership fences a running result and removes read access',async()=>{
    const c=setup();const room=await c.create(true,c.member.token);const runner=roomRuntimeAccess(c.db,c.service);const attempt=runner.claimNext('revoked')!;
    expect(attempt).toBeTruthy();c.db.query('DELETE FROM project_members WHERE project_id=1 AND user_id=?').run(c.member.user.id);
    expect(runner.accept(attempt,{message:'This must not be public.',decision:'continue'})).toBe(false);
    const snapshot=c.service.snapshot({projectId:1,roomId:room.room.id});
    expect(snapshot.contributions.some(m=>m.text.includes('This must not'))).toBe(false);
    expect(snapshot.mission!.state).toBe('interrupted');
    expect((await c.api('GET',`1/rooms/${room.room.id}/snapshot`,undefined,c.member.token)).status).toBe(403);
  });

  test('preview never creates an issue; publication is atomic and retries retain one IssueId',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));expect(room.mission!.state).toBe('completed');
    const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:artifact.currentVersion});expect(preview.status).toBe(200);expect(c.issuesStore.listByProject(1)).toHaveLength(0);
    const input={draft:preview.body.draft,expectedVersion:room.mission!.version};const key=crypto.randomUUID();
    c.projectionFailure=true;
    const published=await c.api('POST',root+'/issues',input,c.owner.token,key);expect(published.status).toBe(201);
    const replay=await c.api('POST',root+'/issues',input,c.owner.token,key);expect(replay.body.issueId).toBe(published.body.issueId);expect(c.issuesStore.listByProject(1)).toHaveLength(1);expect(c.scheduled).toBe(2);
    expect(published.body.snapshot.issueLinks[0].artifactVersion).toBe(artifact.currentVersion);
    expect(JSON.stringify(published.body)).not.toContain('private-projection-marker');
    expect((await c.api('POST',root+'/issues',{...input,draft:{...input.draft,title:'Changed'}},c.owner.token,key)).status).toBe(409);
  });

  test('new missions preserve member identity and historical artifacts; archived projects are read-only',async()=>{
    const c=setup();const previous=c.deliver(await c.create(true));
    const next=await c.api('POST',`1/rooms/${previous.room.id}/missions`,{request:'A new goal'});expect(next.status).toBe(201);
    expect(next.body.mission.id).not.toBe(previous.mission!.id);expect(next.body.members.map((m:{id:string})=>m.id)).toEqual(previous.members.map(m=>m.id));expect(next.body.artifacts).toHaveLength(1);
    c.db.run("UPDATE projects SET status='archived' WHERE id=1");
    const read=await c.api('GET',`1/rooms/${previous.room.id}/snapshot`);expect(read.status).toBe(200);expect(Object.values(read.body.capabilities).every(value=>value===false)).toBe(true);
    expect((await c.api('POST','1/rooms',{title:'Blocked',request:'No writing'})).status).toBe(409);
  });

  test('preview preserves a long artifact for editing and publishing still enforces issue limits',async()=>{
    const c=setup();const markdown='# Long deliverable\n\n'+'Evidence. '.repeat(1_000);
    const room=c.deliver(await c.create(true),markdown);const artifact=room.artifacts[0];
    const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1});
    expect(preview.status).toBe(200);expect(preview.body.draft.body).toBe(markdown);
    expect((await c.api('POST',root+'/issues',{draft:preview.body.draft,expectedVersion:room.mission!.version})).status).toBe(400);
    expect(c.issuesStore.listByProject(1)).toHaveLength(0);
    const result=await c.api('POST',root+'/issues',{draft:{...preview.body.draft,body:'Implement the first verified example.'},expectedVersion:room.mission!.version});
    expect(result.status).toBe(201);expect(result.body.snapshot.artifacts[0].versions[0].markdown).toBe(markdown);
  });

  test('preview rechecks access after receiving an asynchronously streamed request',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];
    const stream=new ReadableStream<Uint8Array>({pull(controller){
      c.db.query('DELETE FROM project_members WHERE project_id=1 AND user_id=?').run(c.member.user.id);
      controller.enqueue(new TextEncoder().encode(JSON.stringify({artifactId:artifact.id,artifactVersion:1})));controller.close();
    }},{highWaterMark:0});
    const response=await c.dispatch(new Request(`http://rooms.test/api/projects/1/rooms/${room.room.id}/issues/preview`,{method:'POST',headers:{authorization:`Bearer ${c.member.token}`},body:stream}));
    expect(response!.status).toBe(403);expect(await response!.text()).not.toContain('Three concrete examples.');
  });

  test('execution capability changes before insertion roll back the issue and source link',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1});
    c.beforeCreate=()=>{c.db.run('UPDATE executors SET supports_claude=0 WHERE id=1');};
    const result=await c.api('POST',root+'/issues',{draft:{...preview.body.draft,agent:'claude'},expectedVersion:room.mission!.version});
    expect(result.status).toBe(409);expect(c.issuesStore.listByProject(1)).toHaveLength(0);
    expect(c.service.snapshot({projectId:1,roomId:room.room.id}).issueLinks).toHaveLength(0);
  });

  test('revocation during publication hides the committed snapshot from the former member',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1},c.member.token);
    c.afterCommit=()=>{c.db.query('DELETE FROM project_members WHERE project_id=1 AND user_id=?').run(c.member.user.id);};
    const result=await c.api('POST',root+'/issues',{draft:preview.body.draft,expectedVersion:room.mission!.version},c.member.token);
    expect(result.status).toBe(403);expect(result.body.snapshot).toBeUndefined();
    expect(c.issuesStore.listByProject(1)).toHaveLength(1);
    expect(c.service.snapshot({projectId:1,roomId:room.room.id}).issueLinks).toHaveLength(1);
    expect(c.scheduled).toBe(1);
  });

  test('a committed issue is returned when its module projection hangs, without duplicating publication',async()=>{
    const c=setup({responseTimeoutMs:20});const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1});
    let release!:()=>void;const projection=new Promise<void>(resolve=>{release=resolve;});c.afterCommit=()=>projection;
    const input={draft:preview.body.draft,expectedVersion:room.mission!.version};const key=crypto.randomUUID();
    try {
      const result=await c.api('POST',root+'/issues',input,c.owner.token,key);
      expect(result.status).toBe(201);expect(c.scheduled).toBe(1);
      const replay=await c.api('POST',root+'/issues',input,c.owner.token,key);
      expect(replay.body.issueId).toBe(result.body.issueId);expect(c.issuesStore.listByProject(1)).toHaveLength(1);
    } finally { release(); await projection; }
  });

  test('publication pending keeps one in-flight creation and the original request key retrieves its result',async()=>{
    const c=setup({responseTimeoutMs:20});const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1});
    let release!:()=>void;const preparation=new Promise<void>(resolve=>{release=resolve;});let creates=0;
    c.beforeCreate=async()=>{creates++;await preparation;};
    const input={draft:preview.body.draft,expectedVersion:room.mission!.version};const key=crypto.randomUUID();
    try {
      const pending=await c.api('POST',root+'/issues',input,c.owner.token,key);
      expect(pending.status).toBe(503);expect(JSON.stringify(pending.body)).toContain('rooms.publication_pending');
      expect(c.issuesStore.listByProject(1)).toHaveLength(0);
      expect((await c.api('POST',root+'/issues',input,c.owner.token,key)).status).toBe(503);
      expect(creates).toBe(1);
      expect((await c.api('POST',root+'/issues',{...input,draft:{...input.draft,title:'Changed'}},c.owner.token,key)).status).toBe(409);
      release();
      const completed=await c.api('POST',root+'/issues',input,c.owner.token,key);
      expect(completed.status).toBe(201);expect(c.issuesStore.listByProject(1)).toHaveLength(1);expect(creates).toBe(1);
    } finally { release(); await preparation; }
  });

  test('committed publications recover scheduling after a transient failure and service restart',async()=>{
    const c=setup();const room=c.deliver(await c.create(true));const artifact=room.artifacts[0];const root=`1/rooms/${room.room.id}`;
    const preview=await c.api('POST',root+'/issues/preview',{artifactId:artifact.id,artifactVersion:1});
    c.scheduleFailure=true;
    const result=await c.api('POST',root+'/issues',{draft:preview.body.draft,expectedVersion:room.mission!.version});
    expect(result.status).toBe(201);expect(c.scheduled).toBe(1);
    await c.publication.stop();c.scheduleFailure=false;
    const restarted=new RoomPublicationService({db:c.db,rooms:c.service,issues:c.issues});
    restarted.start();
    try {
      await restarted.recoverPending();expect(c.scheduled).toBe(2);
      c.db.query("UPDATE issues SET status='implementing' WHERE id=?").run(result.body.issueId);
      await restarted.recoverPending();expect(c.scheduled).toBe(2);
      expect(c.issuesStore.listByProject(1)).toHaveLength(1);
    } finally { await restarted.stop(); }
  });
});


describe('Agent member proposal API', () => {
  test('validated proposal is project-scoped, retriable and never changes saved members', async () => {
    let calls = 0;
    const s = setup({ runtime: {
      modelCatalog: () => ({ providers: [{ provider: 'codex', available: true, defaultModel: 'test', models: [] }] }),
      designMembers: async request => {
        calls++; const input = JSON.parse(request.messages[1].content);
        expect(input.members).toHaveLength(4);
        return JSON.stringify({ summary: 'Rename writer', operations: [{ kind: 'update', key: input.members.find((m: any) => m.role === 'writer').key, fields: { displayName: 'Lead writer' } }] });
      },
    } });
    const room = await s.create();
    const path = `1/rooms/${room.room.id}/members/propose`;
    const input = { expectedRoomVersion: room.room.version, instruction: 'Rename the writer', members: room.members.map(m => ({ key: m.id, memberId: m.id, role: m.role, displayName: m.displayName, instructions: m.instructions ?? '', model: m.model ?? null })) };
    const first = await s.api('POST', path, input, s.owner.token, 'proposal');
    expect(first.status).toBe(200); expect(first.body.operations).toHaveLength(1);
    expect((await s.api('POST', path, input, s.owner.token, 'proposal')).body).toEqual(first.body); expect(calls).toBe(1);
    expect(s.service.snapshot({ projectId: 1, roomId: room.room.id }).members).toEqual(room.members);
    expect((await s.api('POST', path, input, s.outsider.token)).status).toBe(403);
    expect((await s.api('POST', `2/rooms/${room.room.id}/members/propose`, input)).status).toBe(404);
    expect((await s.api('POST', path, { ...input, expectedRoomVersion: room.room.version + 1 })).status).toBe(409);
    expect((await s.api('POST', path, { ...input, members: [{ ...input.members[0], memberId: 'foreign' }] })).status).toBe(404);
    expect(calls).toBe(1);
  });
  test('active execution and a changed roster reject proposals before application', async () => {
    let calls = 0;
    const s = setup({ runtime: { modelCatalog: () => ({ providers: [{ provider: 'codex', available: true, defaultModel: 'test', models: [] }] }), designMembers: async () => { calls++; return '{"summary":"","operations":[]}'; } } });
    const room = await s.create(true);
    const input = { expectedRoomVersion: room.room.version, instruction: 'Change the team', members: room.members.map(m => ({ key: m.id, memberId: m.id, role: m.role, displayName: m.displayName, instructions: '', model: null })) };
    expect((await s.api('POST', `1/rooms/${room.room.id}/members/propose`, input)).status).toBe(409);
    expect(calls).toBe(0);
  });
});

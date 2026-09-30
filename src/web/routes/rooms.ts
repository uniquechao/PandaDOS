import type { Database } from 'bun:sqlite';
import { DEFAULT_ROOM_BUDGET, ROOM_ROLES, type RoomAudience, type RoomBudgetLimits, type RoomCommand, type RoomCommandInput, type RoomCreateInput, type RoomIssueDraft, type RoomMember, type RoomMemberChange, type RoomMembersInput, type RoomSnapshot } from '../../../shared/rooms';
import { matchSupportedLocale } from '../../../shared/i18n/locales';
import { ProjectMemberStore } from '../../core/members';
import { getProject } from '../../issues/engine';
import { RoomError, type RoomActor, type RoomCommandMeta, type RoomScope, type RoomService } from '../../rooms/contracts';
import { apiError } from '../errors';
import { json, type RouteCtx, type RouteDef } from '../middleware';
import type { RoomPublicationService } from '../room-publication';
import type { RoomIssueFeedbackService } from '../room-issue-feedback';
import { roomDiagnostics } from '../../rooms/observability';
import { RoomReadModel } from '../../rooms/read-model';
import { RoomStore, roomMemberModel } from '../../rooms/store';
import type { RoomRuntime } from '../../rooms/runtime';
import { RoomMemberDesigner, parseMemberDesignInput } from '../../rooms/member-designer';

export interface RoomsRoutesDeps {
  db: Database;
  service: RoomService;
  runtime: Pick<RoomRuntime, 'configured' | 'configuredFor' | 'modelCatalog' | 'capabilities' | 'probe' | 'designMembers'>;
  memberDesigner?: RoomMemberDesigner;
  coordinator: { wake(): void; cancelRoom(roomId: string): void };
  publication: RoomPublicationService;
  feedback?: RoomIssueFeedbackService;
}
const FALLBACKS: Record<RoomError['code'] | 'operation_failed', [number, string]> = {
  not_found: [404, 'The room resource does not exist in this project.'],
  invalid_request: [400, 'Check the room request and try again.'],
  conflict: [409, 'The room changed. Refresh it and try again.'],
  idempotency_conflict: [409, 'This request key was already used for a different action.'],
  state_conflict: [409, 'This action is not available in the current room state.'],
  scope_mismatch: [404, 'The room resource does not exist in this project.'],
  budget_exhausted: [409, 'A collaboration limit has been reached.'],
  not_configured: [409, 'Configure the platform model before starting collaboration.'],
  unavailable: [409, 'The selected execution capability is unavailable.'],
  publication_pending: [503, 'Publication is still in progress. Retry this same request to retrieve its result.'],
  forbidden: [403, 'You do not have permission to perform this room action.'],
  operation_failed: [500, 'The room action could not be completed.'],
};
function errorResponse(error: unknown): Response {
  const code = error instanceof RoomError ? error.code : 'operation_failed';
  const [status, fallback] = FALLBACKS[code];
  // Private runtime errors, provider bodies and SQL details never enter the collaboration API.
  return json(apiError(`rooms.${code}`, fallback, status), status);
}
function exact(value: Record<string, unknown>, keys: string[]): void { if (Object.keys(value).some(k => !keys.includes(k))) throw new RoomError('invalid_request'); }
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomError('invalid_request'); return value as Record<string, unknown>; }
function text(value: unknown, max: number): string { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new RoomError('invalid_request'); return value; }
function integer(value: unknown, min = 1): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new RoomError('invalid_request'); return value; }
async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.body) throw new RoomError('invalid_request');
  const reader = req.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 128_000) { await reader.cancel(); throw new RoomError('invalid_request'); }
      chunks.push(chunk.value);
    }
    const data = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
    return record(JSON.parse(new TextDecoder().decode(data)));
  } catch (error) { if (error instanceof RoomError) throw error; throw new RoomError('invalid_request'); }
  finally { reader.releaseLock(); }
}
function budget(value: unknown): Partial<RoomBudgetLimits> | undefined {
  if (value === undefined) return undefined;
  const b = record(value); exact(b, ['modelRequests','activeMs','rounds']);
  if (!Object.keys(b).length) throw new RoomError('invalid_request');
  const result: Partial<RoomBudgetLimits> = {};
  for (const key of ['modelRequests','activeMs','rounds'] as const) if (b[key] !== undefined) result[key] = integer(b[key]);
  return result;
}
function criteria(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 12) throw new RoomError('invalid_request');
  return value.map(v => text(v, 500));
}
function audience(value: unknown): RoomAudience {
  const v = record(value);
  if (v.kind === 'room') { exact(v, ['kind']); return { kind: 'room' }; }
  exact(v, ['kind','memberIds']);
  if (v.kind !== 'members' || !Array.isArray(v.memberIds) || v.memberIds.length < 1 || v.memberIds.length > 20) throw new RoomError('invalid_request');
  return { kind: 'members', memberIds: [...new Set(v.memberIds.map(id => text(id, 100)))] };
}
function memberModel(value: unknown) {
  const model = roomMemberModel(value);
  if (/[^\x21-\x7e]/.test(model.model)) throw new RoomError('invalid_request');
  return model;
}
function memberChanges(value: unknown): RoomMemberChange[] {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new RoomError('invalid_request');
  return value.map(item => {
    const change = record(item); exact(change, ['id', 'expectedVersion', 'remove', 'role', 'displayName', 'instructions', 'model']);
    if (change.remove !== undefined && typeof change.remove !== 'boolean') throw new RoomError('invalid_request');
    if (change.role !== undefined && !ROOM_ROLES.includes(change.role as RoomMemberChange['role'] & string)) throw new RoomError('invalid_request');
    if (change.instructions !== undefined && (typeof change.instructions !== 'string' || change.instructions.length > 4000)) throw new RoomError('invalid_request');
    if (change.id === undefined && (change.role === undefined || change.expectedVersion !== undefined || change.remove === true)) throw new RoomError('invalid_request');
    if (change.remove === true) exact(change, ['id', 'expectedVersion', 'remove']);
    return {
      ...(change.id === undefined ? {} : { id: text(change.id, 100) }),
      ...(change.expectedVersion === undefined ? {} : { expectedVersion: integer(change.expectedVersion) }),
      ...(change.remove === undefined ? {} : { remove: change.remove as boolean }),
      ...(change.role === undefined ? {} : { role: change.role as RoomMemberChange['role'] }),
      ...(change.displayName === undefined ? {} : { displayName: text(change.displayName, 80) }),
      ...(change.instructions === undefined ? {} : { instructions: change.instructions as string }),
      ...(change.model === undefined ? {} : { model: change.model === null ? null : memberModel(change.model) }),
    };
  });
}
function scope(ctx: RouteCtx): RoomScope { return { projectId: integer(Number(ctx.params.projectId)), roomId: text(ctx.params.roomId, 100) }; }
function meta(ctx: RouteCtx, actor: RoomActor): RoomCommandMeta {
  const key = ctx.req.headers.get('Idempotency-Key');
  if (!key || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) throw new RoomError('invalid_request');
  return { actor, key };
}
export function roomsRoutes(deps: RoomsRoutesDeps): RouteDef[] {
  const memberDesigner = deps.memberDesigner ?? new RoomMemberDesigner(deps.runtime);
  const reads = new RoomReadModel(new RoomStore(deps.db));
  const base = '/api/projects/:projectId/rooms';
  const actor = (ctx: RouteCtx): RoomActor => {
    if (!ctx.user) throw new RoomError('forbidden');
    const project = getProject(deps.db, integer(Number(ctx.params.projectId)));
    const liveUser = deps.db.query<{ role: string },[number]>('SELECT role FROM users WHERE id=?').get(ctx.user.id);
    if(!project || !liveUser || (liveUser.role!=='admin' && project.ownerUserId!==ctx.user.id && !new ProjectMemberStore(deps.db).isMember(project.id,ctx.user.id)))throw new RoomError('forbidden');
    if(project.status!=='active')throw new RoomError('state_conflict');
    const settings = deps.db.query<{ locale: string | null }, [number]>('SELECT locale FROM user_settings WHERE user_id=?').get(ctx.user.id);
    return { userId: ctx.user.id, locale: matchSupportedLocale(settings?.locale ? [settings.locale] : []) };
  };
  const runtimeConfigured = (members: RoomMember[] = []): boolean => deps.runtime.configuredFor?.(members.filter(member => member.status === 'active')) ?? deps.runtime.configured();
  const decorate = (snapshot: RoomSnapshot): RoomSnapshot => {
    const active=getProject(deps.db,snapshot.room.projectId)?.status==='active';
    const configured=runtimeConfigured(snapshot.members);
    const capabilities={...snapshot.capabilities};
    if(!active)for(const key of Object.keys(capabilities) as Array<keyof typeof capabilities>)capabilities[key]=false;
    return {...snapshot, ...(deps.feedback ? { issueFeedback: deps.feedback.list({projectId:snapshot.room.projectId,roomId:snapshot.room.id}) } : {}), runtime:{configured},capabilities:{...capabilities,canStart:capabilities.canStart&&configured,canResume:capabilities.canResume&&configured}};
  };
  const requireRuntime = (members: RoomMember[] = []) => { if (!runtimeConfigured(members)) throw new RoomError('not_configured'); };
  const route = (method: RouteDef['method'], path: string, handler: (ctx: RouteCtx) => Response | Promise<Response>): RouteDef => ({ method, path: base+path, auth: 'project-access', handler: async ctx => { try { return await handler(ctx); } catch(error) { return errorResponse(error); } } });
  const parseMission = (b: Record<string, unknown>) => {
    if(b.criteria!==undefined&&b.userCriteria!==undefined)throw new RoomError('invalid_request');
    return { request: text(b.request, 8_000), ...(b.criteria === undefined ? {} : { criteria: criteria(b.criteria) }), ...(b.userCriteria === undefined ? {} : { userCriteria: criteria(b.userCriteria) }), ...(b.baselineArtifactRefs===undefined?{}:{baselineArtifactRefs:artifactRefs(b.baselineArtifactRefs)}), ...(b.budget === undefined ? {} : { budget: budget(b.budget) }), ...(b.locale === undefined ? {} : { locale: matchSupportedLocale([text(b.locale, 30)]) }) };
  };
  const routes: RouteDef[] = [
    route('GET','',ctx => json({ rooms: deps.service.list(integer(Number(ctx.params.projectId))), canWrite: getProject(deps.db,Number(ctx.params.projectId))?.status==='active', runtime: { configured: runtimeConfigured() }, defaults: DEFAULT_ROOM_BUDGET })),
    route('POST','',async ctx => {
      const b = await body(ctx.req); exact(b,['title','request','criteria','userCriteria','baselineArtifactRefs','templateKey','budget','start','locale']);
      if (b.start !== undefined && typeof b.start !== 'boolean') throw new RoomError('invalid_request');
      if (b.templateKey !== undefined && !['product','writing'].includes(String(b.templateKey))) throw new RoomError('invalid_request');
      const commandMeta=meta(ctx,actor(ctx));
      if (b.start === true) requireRuntime();
      const input: RoomCreateInput = { ...parseMission(b), title: text(b.title, 160), templateKey: b.templateKey as RoomCreateInput['templateKey'], start: b.start === true };
      const result = deps.service.create(integer(Number(ctx.params.projectId)), input, commandMeta);
      deps.coordinator.wake(); return json(decorate(result),201);
    }),
    route('GET','/:roomId/snapshot',ctx => { deps.feedback?.sync(scope(ctx));return json(decorate(deps.service.snapshot(scope(ctx)))); }),
    route('GET','/:roomId/view',ctx => { const s=scope(ctx);deps.feedback?.sync(s);const view=reads.view(s);return json({...decorate(view),history:view.history}); }),
    route('GET','/:roomId/member-models',ctx => { deps.service.snapshot(scope(ctx));return json(deps.runtime.modelCatalog?.() ?? {providers:[]}); }),
    route('GET','/:roomId/contributions',ctx => {
      const url=new URL(ctx.req.url);const before=url.searchParams.get('beforeSeq'),limit=url.searchParams.get('limit');
      return json(reads.history(scope(ctx),before===null?undefined:integer(Number(before)),limit===null?80:integer(Number(limit))));
    }),
    route('GET','/:roomId/artifacts/:artifactId',ctx => json({artifact:reads.artifact(scope(ctx),text(ctx.params.artifactId,100))})),
    route('GET','/:roomId/sources/:sourceId',ctx => json({source:reads.source(scope(ctx),text(ctx.params.sourceId,100))})),
    route('POST','/:roomId/sources',async ctx => {
      const b=await body(ctx.req);exact(b,['missionId','goalRevision','title','content','audience']);
      const result=deps.service.grantSource(scope(ctx),{missionId:text(b.missionId,100),goalRevision:integer(b.goalRevision),title:text(b.title,160),content:text(b.content,64000),audience:audience(b.audience)},meta(ctx,actor(ctx)));
      deps.coordinator.wake();return json(decorate(result),201);
    }),
    route('POST','/:roomId/sources/:sourceId/revoke',async ctx => {
      const b=await body(ctx.req);exact(b,[]);const s=scope(ctx);
      const result=deps.service.revokeSource(s,text(ctx.params.sourceId,100),meta(ctx,actor(ctx)));
      deps.coordinator.wake();return json(decorate(result));
    }),
    route('POST','/:roomId/artifacts/:artifactId/edit',async ctx => {
      const b=await body(ctx.req);exact(b,['expectedVersion','expectedMissionVersion','title','markdown']);
      const result=deps.service.editArtifact(scope(ctx),text(ctx.params.artifactId,100),{expectedVersion:integer(b.expectedVersion),expectedMissionVersion:integer(b.expectedMissionVersion),title:text(b.title,200),markdown:text(b.markdown,48000)},meta(ctx,actor(ctx)));
      return json(decorate(result));
    }),
    route('POST','/:roomId/members/propose',async ctx => {
      const s = scope(ctx), caller = actor(ctx), commandMeta = meta(ctx, caller);
      const snapshot = deps.service.snapshot(s);
      const input = parseMemberDesignInput(await body(ctx.req), snapshot);
      const authorize = () => {
        actor(ctx);
        const current = deps.service.snapshot(s);
        if (current.room.version !== input.expectedRoomVersion || current.mission?.id !== snapshot.mission?.id || current.goal?.revision !== snapshot.goal?.revision) throw new RoomError('conflict');
        if (current.room.status !== 'active' || !current.capabilities.canPublish
          || ['queued', 'running', 'quiescing'].includes(current.mission?.state ?? '')
          || current.members.some(member => member.activity?.state === 'working')) throw new RoomError('state_conflict');
      };
      return json(await memberDesigner.propose(snapshot, input, caller.userId, commandMeta.key, authorize));
    }),
    route('POST','/:roomId/members/batch',async ctx => {
      const b=await body(ctx.req);exact(b,['expectedRoomVersion','changes']);
      const input:RoomMembersInput={expectedRoomVersion:integer(b.expectedRoomVersion),changes:memberChanges(b.changes)};
      return json(decorate(deps.service.applyMembers(scope(ctx),input,meta(ctx,actor(ctx)))));
    }),
    route('POST','/:roomId/members/:memberId/configure',async ctx => {
      const b=await body(ctx.req);exact(b,['expectedVersion','displayName','instructions','model']);
      if(typeof b.instructions!=='string'||b.instructions.length>4000)throw new RoomError('invalid_request');
      const result=deps.service.configureMember(scope(ctx),text(ctx.params.memberId,100),{expectedVersion:integer(b.expectedVersion),displayName:text(b.displayName,80),instructions:b.instructions,...(b.model===undefined?{}:{model:b.model===null?null:memberModel(b.model)})},meta(ctx,actor(ctx)));
      return json(decorate(result));
    }),
    route('POST','/:roomId/missions',async ctx => { const b=await body(ctx.req);exact(b,['request','criteria','userCriteria','baselineArtifactRefs','budget','locale']);return json(decorate(deps.service.newMission(scope(ctx),parseMission(b),meta(ctx,actor(ctx)))),201); }),
    route('POST','/:roomId/contributions',async ctx => {
      const b = await body(ctx.req); exact(b,['text','audience','clientMessageId','replyTo','missionId','goalRevision']);
      const result = deps.service.contribute(scope(ctx), { text: text(b.text, 8_000), audience: audience(b.audience), clientMessageId: text(b.clientMessageId,128), ...(b.replyTo === undefined ? {} : { replyTo: text(b.replyTo,100) }), ...(b.missionId === undefined ? {} : {missionId:text(b.missionId,100)}), ...(b.goalRevision === undefined ? {} : {goalRevision:integer(b.goalRevision)}) },actor(ctx));
      deps.coordinator.wake();return json(decorate(result),201);
    }),
    route('POST','/:roomId/archive',async ctx => { const b=await body(ctx.req);exact(b,['expectedVersion']);return json(decorate(deps.service.archive(scope(ctx),integer(b.expectedVersion,0),meta(ctx,actor(ctx))))); }),
    route('POST','/:roomId/artifacts/:artifactId/adopt',async ctx => { const b=await body(ctx.req);exact(b,['version']);return json(decorate(deps.service.adopt(scope(ctx),text(ctx.params.artifactId,100),integer(b.version),meta(ctx,actor(ctx))))); }),
    route('POST','/:roomId/issues/preview',async ctx => { const b=await body(ctx.req);exact(b,['artifactId','artifactVersion']);actor(ctx);return json({draft:deps.publication.preview(scope(ctx),text(b.artifactId,100),integer(b.artifactVersion))}); }),
    route('POST','/:roomId/issues',async ctx => {
      const b=await body(ctx.req);exact(b,['draft','expectedVersion']);const d=record(b.draft);exact(d,['artifactId','artifactVersion','title','body','moduleId','agent']);
      if(d.agent!==undefined && d.agent!=='claude' && d.agent!=='codex')throw new RoomError('invalid_request');
      const draft:RoomIssueDraft={artifactId:text(d.artifactId,100),artifactVersion:integer(d.artifactVersion),title:text(d.title,200),body:text(d.body,8_000),moduleId:d.moduleId==null?null:integer(d.moduleId),...(d.agent?{agent:d.agent as 'claude'|'codex'}:{})};
      const result=await deps.publication.publish(scope(ctx),draft,integer(b.expectedVersion,0),meta(ctx,actor(ctx)));return json({...result,snapshot:decorate(result.snapshot)},201);
    }),
    route('POST','/:roomId/issues/:issueId/answer',async ctx => {
      if(!deps.feedback)throw new RoomError('unavailable');
      const b=await body(ctx.req);exact(b,['questionId','answer']);
      const caller=actor(ctx);
      return json(await deps.feedback.answer(scope(ctx),text(ctx.params.issueId,100),integer(b.questionId),text(b.answer,4000),meta(ctx,caller),()=>{actor(ctx);}));
    }),
  ];
  for (const command of ['start','pause','resume','stop','goal','budget','answer'] as const) routes.push(route('POST',`/:roomId/missions/:missionId/${command}`,async ctx => {
    const b=await body(ctx.req);exact(b,['expectedVersion','request','criteria','userCriteria','baselineArtifactRefs','budget','questionId','answer','guidance']);
    if(b.criteria!==undefined&&b.userCriteria!==undefined)throw new RoomError('invalid_request');
    const input:RoomCommandInput={expectedVersion:integer(b.expectedVersion,0),...(b.request===undefined?{}:{request:text(b.request,8_000)}),...(b.criteria===undefined?{}:{criteria:criteria(b.criteria)}),...(b.userCriteria===undefined?{}:{userCriteria:criteria(b.userCriteria)}),...(b.baselineArtifactRefs===undefined?{}:{baselineArtifactRefs:artifactRefs(b.baselineArtifactRefs)}),...(b.budget===undefined?{}:{budget:budget(b.budget)}),...(b.questionId===undefined?{}:{questionId:text(b.questionId,100)}),...(b.answer===undefined?{}:{answer:text(b.answer,8_000)}),...(b.guidance===undefined?{}:{guidance:text(b.guidance,8_000)})};
    const roomScope=scope(ctx),commandMeta=meta(ctx,actor(ctx));
    if (['start','resume','answer'].includes(command)) requireRuntime(deps.service.snapshot(roomScope).members);
    const result=deps.service.command(roomScope,text(ctx.params.missionId,100),command as RoomCommand,input,commandMeta);
    // wake() cancels only attempts whose persisted epoch is obsolete. Replaying
    // an older idempotent pause/goal must never abort a newly resumed attempt.
    deps.coordinator.wake();return json(decorate(result),['start','resume','answer'].includes(command)?202:200);
  }));
  routes.push({ method:'GET',path:'/api/rooms/diagnostics',auth:'admin',handler:()=>json(roomDiagnostics.snapshot()) });
  routes.push({ method:'GET',path:'/api/rooms/runtime-capabilities',auth:'admin',handler:()=>json({configured:deps.runtime.configured(),capabilities:deps.runtime.capabilities?.()??null}) });
  routes.push({ method:'POST',path:'/api/rooms/runtime-capabilities/probe',auth:'admin',handler:async ctx=>{
    try {
      const b=await body(ctx.req);exact(b,[]);
      if(!deps.runtime.probe)throw new RoomError('unavailable');
      const beforeRequest=()=>!!ctx.user&&deps.db.query<{role:string},[number]>('SELECT role FROM users WHERE id=?').get(ctx.user.id)?.role==='admin';
      if(!beforeRequest())throw new RoomError('forbidden');
      const capabilities=await deps.runtime.probe(ctx.req.signal,beforeRequest);
      if(!beforeRequest())throw new RoomError('forbidden');
      return json({capabilities});
    }catch(error){return errorResponse(error);}
  }});
  return routes;
}

function artifactRefs(value: unknown): Array<{artifactId:string;version:number}> {
  if(!Array.isArray(value)||value.length>8)throw new RoomError('invalid_request');
  return value.map(item=>{const ref=record(item);exact(ref,['artifactId','version']);return {artifactId:text(ref.artifactId,100),version:integer(ref.version)};});
}

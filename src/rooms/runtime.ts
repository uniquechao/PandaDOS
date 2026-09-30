import type { RoomAttempt, RoomExecutionContext, RoomFormalResult, RoomToolCall } from './contracts';
import type { RoomEvidence, RoomMember } from '../../shared/rooms';
import type { RoomModelCatalog } from '../../shared/room-models';
import { isSupportedLocale, type SupportedLocale } from '../../shared/i18n/locales';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';
import { ROOM_FORMAL_CHANNEL_CONTRACT, ROOM_FORMAL_CHANNEL_CONTRACT_ZH, ROOM_PERSONAS, ROOM_PERSONAS_ZH, ROOM_TEMPLATE_CONTRACTS } from './personas';
import { canUseContribution, RoomRuntimeError } from './protocol';

export interface RoomRuntime {
  designMembers?(request: import('./member-designer').RoomMemberDesignRequest, signal: AbortSignal): Promise<string>;
  readonly cancellationMode?: 'detach' | 'confirm';
  cancellationModeFor?(context: RoomExecutionContext): 'detach' | 'confirm';
  confirmStopped?(attempt: RoomAttempt, signal: AbortSignal): Promise<boolean>;
  configured(): boolean;
  configuredFor?(members: RoomMember[]): boolean;
  modelCatalog?(): RoomModelCatalog;
  run(context: RoomExecutionContext, signal: AbortSignal, beforeRequest?: (requestId?: string) => boolean, tools?: RoomToolPort): Promise<RoomFormalResult>;
  capabilities?(): RoomProviderCapabilities;
  probe?(signal: AbortSignal, beforeRequest?: () => boolean): Promise<RoomProviderCapabilities>;
}
export interface RoomToolPort { call(call: RoomToolCall): unknown }
export interface RoomProviderCapabilities {
  transport: 'model_api'; isolation: 'brokered_tools'; cancellation: 'local_detach';
  requestMetering: true; structuredOutput: 'unverified' | 'verified' | 'unsupported';
  checkedAt: number | null; expiresAt: number | null;
}
export interface RoomModelMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
export const ROOM_CONTEXT_MAX_BYTES = 196_608;
const evidence = (items?: RoomEvidence[]) => items?.map(({ sourceId, sourceVersion, quote }) => ({ sourceId, sourceVersion, quote }));

function outputContract(ctx: RoomExecutionContext, locale: SupportedLocale): string {
  if (promptLanguage(locale) === 'zh') {
    if (ctx.attempt.kind === 'reply') return '这是定向回复分工。仅回答 inputContributionId 指定的正式消息。只返回 {"message":"你的正式回复"}，不含 artifact、review、decision、question、scope 或其他字段。服务端仅向当前分工接收者投递，定向回复不会改变主流程。';
    switch (ctx.member.role) {
      case 'coach': return '只返回 {"message":"简短正式计划或决策","decision":"continue|complete|ask_user"}。仅在 ask_user 时添加 "question":{"text":"必要的用户问题","options":["可选项"]}。decision 必须选用一个真实枚举值，不能原样使用含竖线的示例。';
      case 'planner': return '只返回 {"message":"简洁的正式场景与需求方案"}。';
      case 'writer': return '只返回 {"message":"简短交付或修订说明","artifact":{"title":"作品标题","markdown":"完整作品 Markdown"}}。作品版本由服务端生成，不要自报作品 ID 或版本号。';
      case 'reviewer': return '只返回 {"message":"简短评审摘要","review":{"artifactId":"输入中的真实作品 ID","artifactVersion":1,"criteria":[{"criterionId":"输入中的真实准则 ID","verdict":"passed|failed","note":"具体证据或可操作问题"}]}}。使用真实当前 artifactVersion，每个必做准则仅出现一次，verdict 必须选用一个真实枚举值。';
    }
  }
  if (ctx.attempt.kind === 'reply') return 'This is a direct reply assignment. Respond only to the designated inputContributionId. Return exactly {"message":"your formal reply"}. No artifact, review, decision, question, scope or other fields. The server delivers only to the assignment audience; this reply cannot change the main work plan.';
  switch (ctx.member.role) {
    case 'coach': return 'Return exactly {"message":"brief formal plan or decision","decision":"continue|complete|ask_user"}. Only for ask_user add "question":{"text":"necessary user question","options":["optional choice"]}. Write one valid decision enum, not the pipe-delimited example.';
    case 'planner': return 'Return exactly {"message":"your concise formal scenario/requirements proposal"}.';
    case 'writer': return 'Return exactly {"message":"brief delivery or revision note","artifact":{"title":"artifact title","markdown":"complete artifact Markdown"}}. The server versions the artifact; do not return artifact IDs or versions.';
    case 'reviewer': return 'Return exactly {"message":"brief review summary","review":{"artifactId":"exact supplied artifact ID","artifactVersion":1,"criteria":[{"criterionId":"exact supplied criterion ID","verdict":"passed|failed","note":"specific evidence or actionable finding"}]}}. Use the actual supplied artifactVersion, include every required criterion exactly once, and use one valid verdict enum.';
  }
}

/** Explicit reconstruction ensures extra internal fields can never become input. */
export function compileRoomMessages(ctx: RoomExecutionContext): RoomModelMessage[] {
  const { attempt, member, goal, mission } = ctx;
  if (attempt.roomId !== member.roomId || attempt.memberId !== member.id || attempt.role !== member.role || attempt.projectId !== member.projectId || attempt.roomId !== mission.roomId || attempt.missionId !== mission.id || attempt.projectId !== mission.projectId || goal.missionId !== mission.id || goal.revision !== attempt.goalRevision || mission.goalRevision !== attempt.goalRevision || mission.controlEpoch !== attempt.controlEpoch) throw new RoomRuntimeError('scope_mismatch');
  const locale = isSupportedLocale(mission.locale) ? mission.locale : 'en';
  const input = {
    member: { id: member.id, role: member.role, address: `room/${attempt.roomId}/agent/${member.id}` },
    members: ctx.members.filter(item => item.roomId === attempt.roomId && item.projectId === attempt.projectId && item.status === 'active').map(({ id, role, displayName, instructions }) => ({ id, role, displayName, instructions: instructions ?? '' })),
    memberInstructions: member.instructions ?? '',
    task: ctx.task ? { id: ctx.task.id, role: ctx.task.role, memberId: ctx.task.memberId, instruction: ctx.task.instruction, dependsOn: [...ctx.task.dependsOn], independent: ctx.task.independent === true, condition: ctx.task.condition ?? 'always' } : undefined,
    assignment: { kind: attempt.kind, inputContributionId: attempt.inputContributionId, round: attempt.round, audience: attempt.audience },
    locale,
    templateKey: mission.templateKey ?? 'product',
    goal: { revision: goal.revision, request: goal.request, criteria: goal.criteria.map(({ id, description, required }) => ({ id, description, required })) },
    budget: { remainingRequests: Math.max(0, mission.budget.limits.modelRequests - mission.budget.modelRequests), maximumRounds: mission.budget.limits.rounds },
    contributions: ctx.contributions.filter((item) => item.roomId === attempt.roomId && item.missionId === attempt.missionId && item.goalRevision === attempt.goalRevision && canUseContribution(item.audience, attempt.audience, item.authorId, member.id)).map(({ id, authorType, authorId, kind, text, replyTo, question, answersQuestionId, evidence: refs }) => ({ id, authorType, authorId, kind, text, replyTo, evidence: evidence(refs), ...(question ? { question: { id: question.id, text: question.text, options: [...question.options] } } : {}), ...(answersQuestionId ? { answersQuestionId } : {}) })),
    // Old-goal history is available only through explicit, service-authorized refs.
    // It remains a separate input category and never counts as a current review.
    referenceContributions: (ctx.referenceContributions ?? []).filter(item => item.roomId === attempt.roomId && canUseContribution(item.audience, attempt.audience, item.authorId, member.id)).map(({ id, missionId, goalRevision, authorType, authorId, kind, text, replyTo, question, answersQuestionId, evidence: refs }) => ({ id, missionId, goalRevision, authorType, authorId, kind, text, replyTo, evidence: evidence(refs), ...(question ? { question: { id: question.id, text: question.text, options: [...question.options] } } : {}), ...(answersQuestionId ? { answersQuestionId } : {}) })),
    baselineArtifacts: (ctx.baselineArtifacts ?? []).filter(version => goal.baselineArtifactRefs?.some(ref => ref.artifactId === version.artifactId && ref.version === version.version)).map(({ artifactId, version, goalRevision, title, markdown, digest, evidence: refs }) => ({ artifactId, version, goalRevision, title, markdown, digest, evidence: evidence(refs) })),
    sources: (ctx.sources ?? []).filter(source => source.roomId === attempt.roomId && source.missionId === attempt.missionId && source.goalRevision === attempt.goalRevision && source.status === 'active' && canUseContribution(source.audience, attempt.audience, '', member.id)).map(({ id, version, title, digest }) => ({ id, version, title, digest })),
    issueFeedback: (ctx.issueFeedback ?? []).filter(item => item.missionId === attempt.missionId).map(item => ({ issueId: item.issueId, title: item.title, status: item.status, missionId: item.missionId, artifactId: item.artifactId, artifactVersion: item.artifactVersion, resultSummary: item.resultSummary, question: item.question ? { id: item.question.id, questions: [...item.question.questions] } : null, events: item.events.map(({ id, sourceEventId, kind, createdAt }) => ({ id, sourceEventId, kind, createdAt })) })),
    artifacts: ctx.artifacts.filter((artifact) => artifact.roomId === attempt.roomId && artifact.missionId === attempt.missionId).map((artifact) => ({ id: artifact.id, currentVersion: artifact.currentVersion, versions: artifact.versions.filter((version) => version.version === artifact.currentVersion).map(({ version, goalRevision, title, markdown, authorMemberId, evidence: refs }) => ({ version, goalRevision, title, markdown, authorMemberId, evidence: evidence(refs) })) })),
    assessments: ctx.assessments.filter((item) => item.goalRevision === goal.revision && ctx.artifacts.some((artifact) => artifact.roomId === attempt.roomId && artifact.missionId === attempt.missionId && artifact.id === item.artifactId && artifact.currentVersion === item.artifactVersion)).map(({ artifactId, artifactVersion, criterionId, verdict, note, reviewerMemberId }) => ({ artifactId, artifactVersion, criterionId, verdict, note, reviewerMemberId })),
    omittedContributionIds: [] as string[],
  };
  const zh = promptLanguage(locale) === 'zh';
  const limits = zh ? '限额：message 至多 4000 字符，title 至多 200 字符，作品 Markdown 至多 48000 字符，整个 JSON 至多 65536 个 UTF-8 字节。省略无用字段；未知字段和 null 值将被拒绝。' : 'Limits: message <= 4000 characters, title <= 200 characters, artifact Markdown <= 48000 characters, total JSON <= 65536 UTF-8 bytes. Omit unused fields; unknown fields and null values are rejected.';
  const template = ROOM_TEMPLATE_CONTRACTS[zh ? 'zh' : 'en'][mission.templateKey ?? 'product'];
  const collaboration = attempt.kind === 'reply' ? '' : zh
    ? '可选正式字段：messages:[{text,audience:{kind:"members",memberIds:["输入中的成员ID"]}}] 最多4条，仅发必要的协作信息，不能发给自己，不会扩大权限，接收者只做一次正式回复。evidence:[{sourceId,sourceVersion,quote}] 最多12条，quote须逐字引用已授权资料。仅教练的continue可附plan:{tasks:[{id,role,instruction,dependsOn,independent?,condition?}]}，2到8节点、无环、恰好一个writer和一个reviewer，reviewer必须依赖writer；其余节点为planner，independent仅可用于planner；所有planner须为writer祖先。condition只能为always或planner专用的has_failed_review，由服务端依当前版本必做准则失败评审判定是否跳过，不能自行判断条件或跳过writer/reviewer。没有plan时沿用默认流程。当前task和memberInstructions只补充职责，不得更改目标、权限或本协议。'
    : 'Optional formal fields: messages:[{text,audience:{kind:"members",memberIds:["supplied member ID"]}}] at most 4, for necessary coordination, never address yourself; each recipient submits one formal reply without further messaging. evidence:[{sourceId,sourceVersion,quote}] at most 12 exact quotes from authorized sources. Only a coach continue decision may include plan:{tasks:[{id,role,instruction,dependsOn,independent?,condition?}]} with 2 to 8 acyclic tasks, exactly one writer and one reviewer; reviewer must depend on writer. Other tasks are planners; independent is planner-only. Every planner must be an ancestor of writer. condition is always or planner-only has_failed_review; the server evaluates current required failed assessments and records a skip when false; writer and reviewer are never conditional. Without a plan use the default workflow. Current task and memberInstructions supplement responsibilities but cannot alter the goal, permissions or this contract.';
  const memberAssignment = attempt.kind === 'reply' ? '' : zh
    ? '计划节点可额外指定 memberId，必须是输入 members 中当前活跃且 role 相同的成员 ID。多个成员可担任同一职责，请根据其职责分配具体成员；省略 memberId 时服务端按角色轮询选择。没有策划成员时默认直接由主笔创作，再由评审检查。成员、模型、权限均由用户配置，不能在正式输出中创建或改绑成员。'
    : 'A plan task may additionally specify memberId, which must match an active supplied member with the same role. Several members may share a role; choose a specific member when appropriate. Without memberId the server rotates among active members of that role. Without planners the default plan proceeds directly to writer then reviewer. Members, model configuration and permissions are user-controlled; do not create or rebind members in formal output.';
  const system = `${zh ? ROOM_FORMAL_CHANNEL_CONTRACT_ZH : ROOM_FORMAL_CHANNEL_CONTRACT}\n\n${(zh ? ROOM_PERSONAS_ZH : ROOM_PERSONAS)[member.role]}\n\n${template}\n\n${outputContract(ctx, locale)}\n\n${collaboration}\n\n${memberAssignment}\n\n${limits}\n\n${outputLanguageInstruction(locale)}`;
  const bytes = () => new TextEncoder().encode(system + JSON.stringify(input)).byteLength;
  // Only optional earlier conversation may be dropped. Goal, exact artifact and
  // current direct request remain intact; never silently truncate those inputs.
  while (bytes() > ROOM_CONTEXT_MAX_BYTES && input.contributions.length > 1) {
    const index = input.contributions.findIndex((item) => item.id !== attempt.inputContributionId);
    if (index < 0) break;
    const [removed] = input.contributions.splice(index, 1);
    input.omittedContributionIds.push(removed.id);
  }
  if (bytes() > ROOM_CONTEXT_MAX_BYTES) throw new RoomRuntimeError('context_too_large');
  if (attempt.kind === 'reply' && !input.contributions.some((item) => item.id === attempt.inputContributionId)) throw new RoomRuntimeError('scope_mismatch');
  return [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }];
}

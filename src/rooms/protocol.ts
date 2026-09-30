import type { RoomAudience } from '../../shared/rooms';
import type { RoomExecutionContext, RoomFormalResult } from './contracts';

export const ROOM_SUBMISSION_MAX_BYTES = 65_536;
export const ROOM_MESSAGE_MAX_CHARS = 4_000;
export const ROOM_ARTIFACT_MAX_CHARS = 48_000;

/** Errors deliberately contain no provider body, model text or credentials. */
export class RoomRuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'RoomRuntimeError'; }
}

function invalid(): never { throw new RoomRuntimeError('protocol_invalid'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some((key) => !keys.includes(key))) invalid();
  return data;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
  // Channel delimiters are not formal collaboration content. Semantic redaction is
  // not claimed: privacy primarily comes from never supplying private transcripts.
  if (/<\/?(?:think|thinking|analysis|tool_call|tool_result|function_call)\b|(?:^|\n)\s*(?:reasoning_content|tool_calls|tool_call_id)\s*:/i.test(value)) invalid();
  return value;
}

/** A public result is a fresh whitelist projection, never the raw provider object. */
export function parseRoomFormalResult(content: string, ctx: RoomExecutionContext): RoomFormalResult {
  if (new TextEncoder().encode(content).byteLength > ROOM_SUBMISSION_MAX_BYTES) invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { invalid(); }
  const data = record(parsed, ['message', 'artifact', 'review', 'decision', 'question', 'plan', 'messages', 'evidence']);
  const result: RoomFormalResult = { message: text(data.message, ROOM_MESSAGE_MAX_CHARS) };
  if (ctx.attempt.kind === 'reply') {
    if (Object.keys(data).some((key) => key !== 'message')) invalid();
    return result;
  }

  if (data.artifact !== undefined) {
    if (ctx.member.role !== 'writer') invalid();
    const artifact = record(data.artifact, ['title', 'markdown']);
    result.artifact = { title: text(artifact.title, 200), markdown: text(artifact.markdown, ROOM_ARTIFACT_MAX_CHARS) };
  }
  if (data.review !== undefined) {
    if (ctx.member.role !== 'reviewer') invalid();
    const review = record(data.review, ['artifactId', 'artifactVersion', 'criteria']);
    const artifactId = text(review.artifactId, 200);
    if (!Number.isSafeInteger(review.artifactVersion) || (review.artifactVersion as number) < 1) invalid();
    const artifactVersion = review.artifactVersion as number;
    const artifact = ctx.artifacts.find((item) => item.id === artifactId);
    const version = artifact?.versions.find((item) => item.version === artifactVersion);
    if (!artifact || artifact.currentVersion !== artifactVersion || !version || version.goalRevision !== ctx.goal.revision || version.authorMemberId === ctx.member.id) invalid();
    if (!Array.isArray(review.criteria) || !review.criteria.length || review.criteria.length > 20) invalid();
    const seen = new Set<string>();
    const criteria = review.criteria.map((raw) => {
      const item = record(raw, ['criterionId', 'verdict', 'note']);
      const criterionId = text(item.criterionId, 200);
      if (seen.has(criterionId) || !ctx.goal.criteria.some((criterion) => criterion.id === criterionId)) invalid();
      seen.add(criterionId);
      if (item.verdict !== 'passed' && item.verdict !== 'failed') invalid();
      return { criterionId, verdict: item.verdict, note: text(item.note, 2_000) } as const;
    });
    if (ctx.goal.criteria.some((criterion) => criterion.required && !seen.has(criterion.id))) invalid();
    result.review = { artifactId, artifactVersion, criteria };
  }
  if (data.decision !== undefined) {
    if (ctx.member.role !== 'coach' || !['continue', 'complete', 'ask_user'].includes(data.decision as string)) invalid();
    result.decision = data.decision as RoomFormalResult['decision'];
  }
  if (data.question !== undefined) {
    if (ctx.member.role !== 'coach' || data.decision !== 'ask_user') invalid();
    const question = record(data.question, ['text', 'options']);
    if (question.options !== undefined && (!Array.isArray(question.options) || question.options.length > 5)) invalid();
    result.question = { text: text(question.text, 2_000), options: (question.options as unknown[] | undefined)?.map((option) => text(option, 300)) ?? [] };
  }
  if (data.plan !== undefined) {
    if (ctx.member.role !== 'coach' || result.decision !== 'continue') invalid();
    const plan = record(data.plan, ['tasks']);
    if (!Array.isArray(plan.tasks) || plan.tasks.length < 2 || plan.tasks.length > 8) invalid();
    const tasks = plan.tasks.map(raw => {
      const task = record(raw, ['id', 'role', 'memberId', 'instruction', 'dependsOn', 'independent', 'condition']);
      const id = text(task.id, 80);
      if (!/^[a-zA-Z0-9_-]+$/.test(id) || !['planner', 'writer', 'reviewer'].includes(task.role as string)) invalid();
      if (!Array.isArray(task.dependsOn) || task.dependsOn.length > 7 || task.dependsOn.some(dep => typeof dep !== 'string')) invalid();
      if (new Set(task.dependsOn).size !== task.dependsOn.length) invalid();
      if (task.independent !== undefined && (typeof task.independent !== 'boolean' || (task.independent && task.role !== 'planner'))) invalid();
      if (task.condition !== undefined && task.condition !== 'always' && (task.condition !== 'has_failed_review' || task.role !== 'planner')) invalid();
      const memberId = task.memberId === undefined ? undefined : text(task.memberId, 200);
      if (memberId !== undefined && !ctx.members.some(member => member.id === memberId && member.role === task.role && member.status === 'active' && member.roomId === ctx.attempt.roomId && member.projectId === ctx.attempt.projectId)) invalid();
      return { id, role: task.role as 'planner' | 'writer' | 'reviewer', ...(memberId !== undefined ? { memberId } : {}), instruction: text(task.instruction, 2_000), dependsOn: task.dependsOn as string[], ...(task.independent !== undefined ? { independent: task.independent as boolean } : {}), ...(task.condition !== undefined ? { condition: task.condition as 'always' | 'has_failed_review' } : {}) };
    });
    const byId = new Map(tasks.map(task => [task.id, task]));
    if (byId.size !== tasks.length || tasks.filter(task => task.role === 'writer').length !== 1 || tasks.filter(task => task.role === 'reviewer').length !== 1) invalid();
    const active = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (active.has(id) || !byId.has(id)) invalid();
      if (visited.has(id)) return;
      active.add(id); byId.get(id)!.dependsOn.forEach(visit); active.delete(id); visited.add(id);
    };
    tasks.forEach(task => visit(task.id));
    const writer = tasks.find(task => task.role === 'writer')!;
    const reviewer = tasks.find(task => task.role === 'reviewer')!;
    const ancestors = (id: string): string[] => byId.get(id)!.dependsOn.flatMap(dep => [dep, ...ancestors(dep)]);
    if (!ancestors(reviewer.id).includes(writer.id)) invalid();
    if (tasks.some(task => task.role === 'planner' && !ancestors(writer.id).includes(task.id))) invalid();
    result.plan = { tasks };
  }
  if (data.messages !== undefined) {
    if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 4) invalid();
    result.messages = data.messages.map(raw => {
      const message = record(raw, ['text', 'audience']);
      const audience = record(message.audience, ['kind', 'memberIds']);
      if (audience.kind !== 'members' || !Array.isArray(audience.memberIds) || !audience.memberIds.length || audience.memberIds.length > ctx.members.length || new Set(audience.memberIds).size !== audience.memberIds.length) invalid();
      const ids = audience.memberIds.map(id => text(id, 200));
      if (ids.some(id => id === ctx.member.id || !ctx.members.some(member => member.id === id && member.roomId === ctx.attempt.roomId && member.projectId === ctx.attempt.projectId && member.status === 'active'))) invalid();
      const outputAudience = ctx.attempt.audience;
      if (outputAudience.kind === 'members' && ids.some(id => !outputAudience.memberIds.includes(id))) invalid();
      return { text: text(message.text, ROOM_MESSAGE_MAX_CHARS), audience: { kind: 'members' as const, memberIds: ids } };
    });
  }
  if (data.evidence !== undefined) {
    if (!Array.isArray(data.evidence) || data.evidence.length < 1 || data.evidence.length > 12) invalid();
    result.evidence = data.evidence.map(raw => {
      const item = record(raw, ['sourceId', 'sourceVersion', 'quote']);
      const sourceId = text(item.sourceId, 200);
      if (!Number.isSafeInteger(item.sourceVersion) || (item.sourceVersion as number) < 1) invalid();
      const source = ctx.sources?.find(source => source.id === sourceId && source.version === item.sourceVersion && source.status === 'active' && source.roomId === ctx.attempt.roomId && source.missionId === ctx.attempt.missionId && source.goalRevision === ctx.attempt.goalRevision && canUseContribution(source.audience, ctx.attempt.audience, '', ctx.member.id));
      if (!source) invalid();
      return { sourceId, sourceVersion: item.sourceVersion as number, quote: text(item.quote, 2_000) };
    });
  }
  if (ctx.member.role === 'coach' && !result.decision) invalid();
  if (result.decision === 'ask_user' && !result.question) invalid();
  if (ctx.member.role === 'writer' && !result.artifact) invalid();
  if (ctx.member.role === 'reviewer' && !result.review) invalid();
  return result;
}

/** Derived output must not widen the audience of any input. */
export function canUseContribution(
  input: RoomAudience,
  output: RoomAudience,
  authorId: string,
  memberId: string,
): boolean {
  if (input.kind === 'room') return true;
  const allowed = new Set([...input.memberIds, authorId]);
  if (!allowed.has(memberId) || output.kind === 'room') return false;
  return output.memberIds.every((id) => allowed.has(id));
}

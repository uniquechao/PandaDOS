import type {
  RoomAudience, RoomCreateInput, RoomCommand, RoomCommandInput, RoomSnapshot,
  RoomSummary, RoomMember, RoomGoal, RoomMission, RoomContribution,
  RoomArtifact, RoomArtifactVersion, RoomAssessment, RoomRole, RoomIssueLink, RoomSourceGrant, RoomPlanTask, RoomEvidence, RoomMembersInput, RoomMemberModel,
} from '../../shared/rooms';
import type { RoomIssueFeedback } from '../../shared/room-issues';

export interface RoomActor { userId: number; locale?: string }
export interface RoomScope { projectId: number; roomId: string }
export interface RoomCommandMeta { actor: RoomActor; key: string }
export interface RoomAttempt {
  id: string; assignmentId: string; roomId: string; projectId: number; missionId: string;
  memberId: string; role: RoomRole; kind: 'work' | 'reply'; goalRevision: number;
  round: number; controlEpoch: number; fence: number; workerId: string;
  leaseUntil: number; deadlineTs: number; audience: RoomAudience; inputContributionId?: string;
  cancelMode?: 'detach' | 'confirm';
}
/** Every field is a formal, authorized input. No raw provider transcript is part of this port. */
export interface RoomExecutionContext {
  attempt: RoomAttempt; member: RoomMember; members: RoomMember[];
  mission: RoomMission; goal: RoomGoal; contributions: RoomContribution[];
  artifacts: RoomArtifact[]; assessments: RoomAssessment[];
  /** Explicitly authorized exact historical inputs; old assessments never become current. */
  baselineArtifacts?: RoomArtifactVersion[];
  referenceContributions?: RoomContribution[];
  sources?: Array<Omit<RoomSourceGrant, 'content'>>;
  task?: RoomPlanTask;
  issueFeedback?: RoomIssueFeedback[];
}
export interface RoomFormalResult {
  message: string;
  artifact?: { title: string; markdown: string };
  review?: { artifactId: string; artifactVersion: number; criteria: Array<{ criterionId: string; verdict: 'passed' | 'failed'; note: string }> };
  decision?: 'continue' | 'complete' | 'ask_user';
  question?: { text: string; options?: string[] };
  plan?: { tasks: RoomPlanTask[] };
  messages?: Array<{ text: string; audience: { kind: 'members'; memberIds: string[] } }>;
  evidence?: RoomEvidence[];
}
export interface RoomToolCall { id: string; name: 'read_source' | 'read_artifact' | 'search_sources'; args: Record<string, unknown> }
export interface RoomRunPort {
  claimNext(workerId: string, now?: number): RoomAttempt | null;
  context(attempt: RoomAttempt): RoomExecutionContext;
  /** Called exactly once immediately before physical fetch; false forbids dispatch. */
  dispatched(attempt: RoomAttempt, now?: number, requestId?: string): boolean;
  tool?(attempt: RoomAttempt, call: RoomToolCall): unknown;
  /** Must be persisted before any external execution starts. Confirm cannot downgrade. */
  setCancellationMode?(attempt: RoomAttempt, mode: 'detach' | 'confirm'): boolean;
  pendingStops?(): RoomAttempt[];
  /** Trusted runtime acknowledgement of this exact fenced execution's termination. */
  confirmStopped?(attempt: RoomAttempt, now?: number): boolean;
  renew(attempt: RoomAttempt, now?: number): boolean;
  accept(attempt: RoomAttempt, result: RoomFormalResult, now?: number): boolean;
  fail(attempt: RoomAttempt, code: string, now?: number): void;
  recover(now?: number): void;
  isCurrent(attempt: RoomAttempt, now?: number): boolean;
}
export interface RoomService extends RoomRunPort {
  list(projectId: number): RoomSummary[];
  snapshot(scope: RoomScope): RoomSnapshot;
  create(projectId: number, input: RoomCreateInput, meta: RoomCommandMeta): RoomSnapshot;
  newMission(scope: RoomScope, input: Pick<RoomCreateInput, 'request' | 'criteria' | 'userCriteria' | 'baselineArtifactRefs' | 'budget' | 'locale'>, meta: RoomCommandMeta): RoomSnapshot;
  command(scope: RoomScope, missionId: string, command: RoomCommand, input: RoomCommandInput, meta: RoomCommandMeta): RoomSnapshot;
  contribute(scope: RoomScope, input: { text: string; audience: RoomAudience; clientMessageId: string; replyTo?: string; missionId?: string; goalRevision?: number }, actor: RoomActor): RoomSnapshot;
  archive(scope: RoomScope, expectedVersion: number, meta: RoomCommandMeta): RoomSnapshot;
  adopt(scope: RoomScope, artifactId: string, version: number, meta: RoomCommandMeta): RoomSnapshot;
  grantSource(scope: RoomScope, input: { missionId: string; goalRevision: number; title: string; content: string; audience: RoomAudience }, meta: RoomCommandMeta): RoomSnapshot;
  revokeSource(scope: RoomScope, sourceId: string, meta: RoomCommandMeta): RoomSnapshot;
  editArtifact(scope: RoomScope, artifactId: string, input: { expectedVersion: number; expectedMissionVersion: number; title: string; markdown: string }, meta: RoomCommandMeta): RoomSnapshot;
  configureMember(scope: RoomScope, memberId: string, input: { expectedVersion: number; displayName: string; instructions: string; model?: RoomMemberModel | null }, meta: RoomCommandMeta): RoomSnapshot;
  applyMembers(scope: RoomScope, input: RoomMembersInput, meta: RoomCommandMeta): RoomSnapshot;
  /** Must be called inside the same DB transaction as the issue insert. */
  linkIssue(scope: RoomScope, input: Omit<RoomIssueLink, 'id' | 'roomId' | 'createdAt'>, publicationKey: string, actorUserId: number): RoomIssueLink;
}
export class RoomError extends Error {
  constructor(public readonly code: 'not_found' | 'invalid_request' | 'conflict' | 'idempotency_conflict' | 'state_conflict' | 'scope_mismatch' | 'budget_exhausted' | 'not_configured' | 'unavailable' | 'forbidden' | 'publication_pending', message: string = code) { super(message); this.name = 'RoomError'; }
}

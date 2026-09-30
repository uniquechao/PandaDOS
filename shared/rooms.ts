import type { IssueId } from './issue-id';
import type { RoomIssueFeedback } from './room-issues';

export const ROOM_ROLES = ['coach', 'planner', 'writer', 'reviewer'] as const;
export type RoomRole = typeof ROOM_ROLES[number];
export type RoomModelProvider = 'claude' | 'codex' | 'deepseek';
export type RoomReasoningEffort = 'low' | 'medium' | 'high';
export interface RoomMemberModel { provider: RoomModelProvider; model: string; effort: RoomReasoningEffort }
export interface RoomMemberChange { id?: string; expectedVersion?: number; remove?: boolean; role?: RoomRole; displayName?: string; instructions?: string; /** null restores the configured room runtime default. */ model?: RoomMemberModel | null }
export interface RoomMembersInput { expectedRoomVersion: number; changes: RoomMemberChange[] }
export type RoomState = 'draft' | 'queued' | 'running' | 'quiescing' | 'waiting_user' | 'paused' | 'exhausted' | 'interrupted' | 'completed' | 'stopped';
export type RoomPhase = 'aligning' | 'producing' | 'reviewing' | 'finalizing';
export type RoomAudience = { kind: 'room' } | { kind: 'members'; memberIds: string[] };
export interface RoomBudgetLimits { modelRequests: number; activeMs: number; rounds: number }
export interface RoomBudget { limits: RoomBudgetLimits; modelRequests: number; reservedRequests?: number; activeMs: number }
export const DEFAULT_ROOM_BUDGET: RoomBudgetLimits = { modelRequests: 48, activeMs: 1_200_000, rounds: 4 };
export const MAX_ROOM_BUDGET: RoomBudgetLimits = { modelRequests: 200, activeMs: 7_200_000, rounds: 12 };
export interface RoomRecord { id: string; projectId: number; title: string; status: 'active' | 'archived'; version: number; eventCursor: number; createdAt: number; updatedAt: number }
export interface RoomMember { id: string; projectId: number; roomId: string; role: RoomRole; displayName: string; address: string; modelProfile: string; model?: RoomMemberModel; status: 'active' | 'retired'; version: number; instructions?: string; activity?: { state: 'idle' | 'queued' | 'working'; kind?: 'work' | 'reply'; taskId?: string } }
export interface RoomCriterion { id: string; description: string; required: boolean; origin?: 'request' | 'user' }
export interface RoomArtifactRef { artifactId: string; version: number }
export interface RoomGoal { id: string; missionId: string; revision: number; request: string; criteria: RoomCriterion[]; baselineArtifactRefs?: RoomArtifactRef[]; createdAt: number }
export interface RoomQuestion { id: string; text: string; options: string[] }
export interface RoomMission {
  id: string; roomId: string; projectId: number; state: RoomState; phase: RoomPhase;
  version: number; controlEpoch: number; goalRevision: number; round: number;
  nextRole: RoomRole; locale: string; actorUserId: number; budget: RoomBudget;
  templateKey?: 'product' | 'writing';
  question: RoomQuestion | null; reasonCode: string | null; createdAt: number; updatedAt: number;
}
export interface RoomContribution {
  id: string; roomId: string; missionId: string; goalRevision: number; seq: number;
  authorType: 'user' | 'member' | 'system'; authorId: string;
  kind: 'message' | 'plan' | 'artifact' | 'review' | 'decision' | 'question';
  text: string; audience: RoomAudience; artifactId?: string; artifactVersion?: number;
  replyTo?: string; question?: RoomQuestion; answersQuestionId?: string; evidence?: RoomEvidence[]; taskId?: string; createdAt: number;
}
export interface RoomEvidence { sourceId: string; sourceVersion: number; quote: string }
export interface RoomSourceGrant { id: string; roomId: string; missionId: string; goalRevision: number; version: number; title: string; content: string; contentLoaded?: boolean; digest: string; audience: RoomAudience; status: 'active' | 'revoked'; createdAt: number }
export interface RoomPlanTask { id: string; role: Exclude<RoomRole, 'coach'>; memberId?: string; instruction: string; dependsOn: string[]; independent?: boolean; condition?: 'always' | 'has_failed_review' }
export interface RoomPlan { id: string; missionId: string; goalRevision: number; round: number; state: string; tasks: Array<RoomPlanTask & { assignmentId: string; state: string }>; createdAt: number }
export interface RoomArtifactVersion { artifactId: string; version: number; goalRevision: number; title: string; markdown: string; digest: string; authorMemberId: string; authorType?: 'member' | 'user'; authorUserId?: number; evidence?: RoomEvidence[]; contentLoaded?: boolean; createdAt: number }
export interface RoomArtifact { id: string; roomId: string; missionId: string; title: string; currentVersion: number; adoptedVersion: number | null; versions: RoomArtifactVersion[] }
export interface RoomAssessment { id: string; artifactId: string; artifactVersion: number; goalRevision: number; criterionId: string; verdict: 'passed' | 'failed'; note: string; reviewerMemberId: string; createdAt: number }
export interface RoomIssueLink { id: string; roomId: string; missionId: string; artifactId: string; artifactVersion: number; issueId: IssueId; title: string; status?: string; createdAt: number }
export interface RoomCapabilities { canStart: boolean; canPause: boolean; canResume: boolean; canStop: boolean; canEditGoal: boolean; canAddBudget: boolean; canPublish: boolean; canContribute: boolean; canArchive: boolean }
export interface RoomSnapshot { room: RoomRecord; members: RoomMember[]; mission: RoomMission | null; goal: RoomGoal | null; goals?: RoomGoal[]; missions?: RoomMission[]; contributions: RoomContribution[]; artifacts: RoomArtifact[]; assessments: RoomAssessment[]; issueLinks: RoomIssueLink[]; issueFeedback?: RoomIssueFeedback[]; sources?: RoomSourceGrant[]; plans?: RoomPlan[]; capabilities: RoomCapabilities; runtime?: { configured: boolean }; history?: { hasMore: boolean; beforeSeq: number | null }; eventCursor: number }
export interface RoomSummary { room: RoomRecord; mission: RoomMission | null; goal: RoomGoal | null; memberCount: number; latestArtifact: { id: string; title: string; version: number } | null }
export interface RoomCreateInput { title: string; request: string; /** User-added criteria only; never include original-request. */ criteria?: string[]; userCriteria?: string[]; baselineArtifactRefs?: RoomArtifactRef[]; templateKey?: 'product' | 'writing'; budget?: Partial<RoomBudgetLimits>; start?: boolean; locale?: string }
export type RoomCommand = 'start' | 'pause' | 'resume' | 'stop' | 'goal' | 'budget' | 'answer';
export interface RoomCommandInput { expectedVersion: number; request?: string; /** Legacy user-added criteria; mutually exclusive with userCriteria. */ criteria?: string[]; userCriteria?: string[]; baselineArtifactRefs?: RoomArtifactRef[]; budget?: Partial<RoomBudgetLimits>; questionId?: string; answer?: string; guidance?: string }
export interface RoomIssueDraft { artifactId: string; artifactVersion: number; title: string; body: string; moduleId?: number | null; agent?: 'claude' | 'codex' }
export interface RoomEvent { seq: number; type: string; createdAt: number }

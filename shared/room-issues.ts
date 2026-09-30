import type { IssueId } from './issue-id';

export interface RoomIssueFeedbackEvent {
  id: string;
  sourceEventId: number;
  kind: 'started' | 'clarification_needed' | 'clarification_answered' | 'blocked' | 'paused' | 'done' | 'cancelled';
  createdAt: number;
}
export interface RoomIssueFeedback {
  issueId: IssueId;
  title: string;
  status: string;
  missionId: string;
  artifactId: string;
  artifactVersion: number;
  resultSummary: string | null;
  question: { id: number; questions: string[] } | null;
  events: RoomIssueFeedbackEvent[];
}
export interface RoomIssueAnswerReceipt {
  issueId: IssueId;
  questionId: number;
  status: 'accepted' | 'uncertain';
}

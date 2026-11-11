import type { IssueId } from './issue-id';
export interface IssueIncident {
  id: string; issueId: IssueId; projectId: number; stopEventId: number; attemptId: string | null;
  state: 'open' | 'queued' | 'resumed' | 'stale';
  runState: 'idle' | 'queued' | 'running' | 'failed' | 'interrupted';
  locale: string; error: string | null; createdTs: number;
}
export interface IncidentMessage {
  id: number; role: 'user' | 'assistant'; content: string; requestKey: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'interrupted'; createdTs: number;
}
export interface IncidentView {
  incident: IssueIncident; messages: IncidentMessage[]; issueStatus: string; evidence: string;
  current: boolean; pendingRecovery: boolean;
  viewerUserId?: number;
}

import type { IssueId } from '../../shared/issue-id';

/** Bound every persisted sync intent, deferred action and result consistently. */
export const MAX_EXECUTION_SYNC_JSON = 200_000;

export type IssueExecutionSyncState =
  | 'requested'
  | 'boundary_waiting'
  | 'applied'
  | 'ignored'
  | 'supplemented'
  | 'stale';

export type IssueExecutionSyncDecision = 'apply' | 'ignore' | 'supplement';

export interface IssueExecutionSyncRequest {
  sourceKind: string;
  sourceKey: string;
  sourceRevision: string;
  sourceDigest: string;
  diff: unknown;
  requestedBy?: number | null;
}

export interface IssueExecutionSync {
  id: number;
  issueId: IssueId;
  sourceKind: string;
  sourceKey: string;
  sourceRevision: string;
  sourceDigest: string;
  diffJson: string;
  state: IssueExecutionSyncState;
  boundaryKind: string | null;
  deferredActionJson: string | null;
  requestedBy: number | null;
  requestedTs: number;
  acknowledgedTs: number | null;
  decidedBy: number | null;
  decidedTs: number | null;
  resumeState: 'idle' | 'pending' | 'running' | 'complete';
  /** Stable across claims/restarts; deferred DB/event consumers must CAS/idempotently key on it. */
  resumeKey: string | null;
  resumeToken: string | null;
  resumeClaimedTs: number | null;
  resumedTs: number | null;
}

export interface IssueExecutionSyncEffectContext {
  /** External I/O is represented by a stable intent committed with the database effect receipt. */
  enqueueExternalEffect(intentKey: string, kind: string, payload: unknown): void;
}

export interface IssueExecutionSyncEffectReceipt {
  syncId: number;
  resumeKey: string;
  result: unknown;
  completedTs: number;
}

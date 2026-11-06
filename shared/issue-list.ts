import type { IssueId } from './issue-id';
import type { IssueWorkspaceView } from '../src/core/workspace-ownership';

/** Stable board groups; history groups are paged by the server. */
export const ISSUE_LIST_GROUPS = {
  review: ['clarifying', 'plan_review', 'merge_review'],
  doing: ['planning', 'implementing', 'testing', 'merging'],
  todo: ['pending'],
  blocked: ['blocked', 'paused'],
  finished: ['done'],
  cancelled: ['cancelled'],
} as const;
export type IssueListGroup = keyof typeof ISSUE_LIST_GROUPS;
export type IssueListStatus = typeof ISSUE_LIST_GROUPS[IssueListGroup][number];
export const ISSUE_LIST_PAGE_SIZE = 20;
export const PAGED_ISSUE_GROUPS: readonly IssueListGroup[] = ['blocked', 'finished', 'cancelled'];

/** Deliberate allowlist: never send body, plans, reports or diagnostics in a list. */
export interface IssueSummary {
  id: IssueId;
  projectId: number;
  title: string;
  status: IssueListStatus;
  module: string;
  moduleId: number | null;
  agent: 'claude' | 'codex';
  createdTs: number;
  doneTs: number | null;
  pinnedTs: number | null;
  createdBy: number | null;
  createdByName: string | null;
  workspace?: Pick<IssueWorkspaceView, 'cwd' | 'branch' | 'computeHeld' | 'retained' | 'integratedSha' | 'reason'> | null;
  waitingInput?: boolean;
  awaitingClarify?: boolean;
  attentionKind?: 'none' | 'clarify' | 'choice' | 'review' | 'stalled' | 'verify' | 'blocked';
}

export interface IssueListPage {
  items: IssueSummary[];
  total: number;
  page: number;
  pageSize: number | null;
}

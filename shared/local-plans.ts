import type { LocalPlan } from './local-plan-format.mjs';
import type { IssueId } from './issue-id';

export interface LocalPlanExecution {
  planId: string;
  digest: string;
  title: string;
  path: string;
  createdTs: number;
  plan: LocalPlan;
  effectsPending: boolean;
  lastError: string | null;
  issues: Array<{
    key: string;
    issueId: IssueId;
    title: string;
    status: string;
    blockers: Array<{ issueId: IssueId; status: string }>;
  }>;
}
export interface LocalPlanEffect {
  key: string;
  kind: 'module-doc' | 'scheduler';
  projectId: number;
  issueId: IssueId | null;
  issueIds: readonly IssueId[];
  moduleId?: number | null;
  agent?: 'claude' | 'codex';
}
export interface LocalPlanCandidate {
  path: string;
  digest: string;
  plan: LocalPlan | null;
  error: string | null;
  execution: LocalPlanExecution | null;
  changed: boolean;
}
export interface LocalPlansView {
  candidates: LocalPlanCandidate[];
  executions: LocalPlanExecution[];
}

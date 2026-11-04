export const MAX_PLAN_BYTES: number;
export const MAX_PLAN_ISSUES: number;
export interface LocalPlanIssue {
  position: number;
  title: string;
  category: 'task' | 'debug' | 'design';
  module: string | null;
  agent: 'claude' | 'codex' | null;
  body: string;
  acceptance: string[];
  issueBody: string;
  dependsOn: number[];
}
export interface LocalPlan {
  schemaVersion: 1;
  planId: string;
  title: string;
  issues: LocalPlanIssue[];
}
export function parseLocalPlan(markdown: string): LocalPlan;

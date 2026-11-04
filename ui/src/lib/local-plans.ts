import type { LocalPlanCandidate, LocalPlanExecution, LocalPlansView } from '../../../shared/local-plans';

export interface PlanExecuteInput { path: string; planId: string; digest: string }

export function executionInput(candidate: LocalPlanCandidate): PlanExecuteInput {
  if (!candidate.plan || candidate.error || candidate.execution) throw new Error('plan_not_executable');
  return { path: candidate.path, planId: candidate.plan.planId, digest: candidate.digest };
}

/** Published snapshots remain visible even when their source files are renamed, deleted or invalid. */
export function planRows(view: LocalPlansView): LocalPlanCandidate[] {
  const seen = new Set(view.candidates.flatMap(item => item.execution ? [item.execution.planId] : []));
  return [...view.candidates, ...view.executions.filter(item => !seen.has(item.planId)).map(item => ({
    path: item.path, digest: item.digest, plan: item.plan, execution: item, error: null, changed: false,
  }))];
}

export function completedTasks(execution: LocalPlanExecution): number {
  return execution.issues.filter(item => item.status === 'done').length;
}

export type PlanFilter = 'all' | 'draft' | 'published';
export function planRowKey(row: LocalPlanCandidate): string {
  return row.execution ? `published:${row.execution.planId}` : `file:${row.path}`;
}
export function planDocument(row: LocalPlanCandidate) {
  return row.execution?.plan ?? row.plan;
}
export function filterPlans(rows: LocalPlanCandidate[], filter: PlanFilter, query: string): LocalPlanCandidate[] {
  const search = query.trim().toLocaleLowerCase();
  return rows.filter(row => (filter === 'all' || (filter === 'published' ? !!row.execution : !!row.plan && !row.error && !row.execution))
    && (!search || `${planDocument(row)?.title ?? ''}\n${row.path}`.toLocaleLowerCase().includes(search)));
}
export function selectedPlan(rows: LocalPlanCandidate[], key: string | null): LocalPlanCandidate | undefined {
  const selected = rows.find(row => planRowKey(row) === key)
    ?? (key?.startsWith('file:') ? rows.find(row => row.path === key.slice(5)) : undefined);
  return selected ?? rows.find(row => row.plan && !row.error && !row.execution)
    ?? rows.filter(row => row.execution).sort((a, b) => b.execution!.createdTs - a.execution!.createdTs)[0] ?? rows[0];
}
/** Capture text and version once; live polls may update execution facts, never this document. */
export function capturePlan(row: LocalPlanCandidate): LocalPlanCandidate {
  return { ...row, plan: planDocument(row), digest: row.execution?.digest ?? row.digest };
}
export function previewChanged(snapshot: LocalPlanCandidate, view: LocalPlansView): boolean {
  if (snapshot.execution) return false;
  const source = view.candidates.find(row => row.path === snapshot.path);
  return !source || !!source.error || source.digest !== snapshot.digest || source.plan?.planId !== snapshot.plan?.planId;
}
export function executionCounts(execution: LocalPlanExecution) {
  const running = new Set(['planning', 'implementing', 'testing', 'merging']);
  return {
    done: completedTasks(execution), total: execution.issues.length,
    running: execution.issues.filter(issue => running.has(issue.status)).length,
    pending: execution.issues.filter(issue => issue.status === 'pending').length,
    cancelled: execution.issues.filter(issue => issue.status === 'cancelled').length,
    attention: execution.issues.filter(issue => !running.has(issue.status) && !['pending', 'done', 'cancelled'].includes(issue.status)).length,
  };
}

export function readPlanRequest(value: string | null): PlanExecuteInput | null {
  try {
    const item = JSON.parse(value ?? 'null');
    return item && typeof item.path === 'string' && typeof item.planId === 'string'
      && typeof item.digest === 'string' && /^[a-f0-9]{64}$/.test(item.digest)
      ? { path: item.path, planId: item.planId, digest: item.digest } : null;
  } catch { return null; }
}

import { expect, test } from 'bun:test';
import { parseLocalPlan } from '../../../shared/local-plan-format.mjs';
import { capturePlan, completedTasks, executionCounts, executionInput, filterPlans, planDocument, planRowKey, planRows, previewChanged, readPlanRequest, selectedPlan } from './local-plans';
import type { LocalPlanCandidate, LocalPlanExecution } from '../../../shared/local-plans';

const plan = parseLocalPlan('```pandados-plan\n' + JSON.stringify({ schemaVersion: 1, planId: 'p', title: 'User title',
  issues: [{ title: 'Task', body: 'Body', acceptance: ['Accepted'] }] }) + '\n```');
const candidate: LocalPlanCandidate = { path: '.panda/plans/p.md', digest: 'a'.repeat(64), plan, error: null, execution: null, changed: false };
const execution: LocalPlanExecution = { planId: 'p', title: plan.title, digest: candidate.digest,
  path: candidate.path, plan, createdTs: 0, effectsPending: false, lastError: null,
  issues: [{ key: '1', issueId: '20261010-abcdef0', title: 'Task', status: 'done', blockers: [] }] };

test('capture preview version without preallocating any official issue identity', () => {
  const input = executionInput(candidate);
  expect(input).toEqual({ path: candidate.path, planId: 'p', digest: candidate.digest });
  expect(readPlanRequest(JSON.stringify(input))).toEqual(input);
  expect(readPlanRequest('{')).toBeNull();
  expect(() => executionInput({ ...candidate, execution })).toThrow();
});
test('preserve published snapshots after file deletion and count only completed tasks', () => {
  expect(planRows({ candidates: [], executions: [execution] })[0].plan).toEqual(plan);
  expect(planRows({ candidates: [{ ...candidate, execution }], executions: [execution] })).toHaveLength(1);
  expect(completedTasks(execution)).toBe(1);
  expect(completedTasks({ ...execution, issues: [{ ...execution.issues[0], status: 'cancelled' }] })).toBe(0);
});

test('default selection prefers valid drafts, then the newest publication, and preserves an explicit choice', () => {
  const older = { ...candidate, path: 'old.md', execution };
  const newer = { ...candidate, path: 'new.md', execution: { ...execution, planId: 'new', createdTs: 10 } };
  const invalid = { ...candidate, path: 'invalid.md', error: 'invalid' };
  expect(selectedPlan([invalid, older, newer, candidate], null)).toBe(candidate);
  expect(selectedPlan([invalid, older, newer], null)).toBe(newer);
  expect(selectedPlan([candidate, older, newer], planRowKey(older))).toBe(older);
  expect(selectedPlan([older], `file:${older.path}`)).toBe(older);
});

test('filters search published snapshot titles and retain invalid files in the all view', () => {
  const published = { ...candidate, plan: { ...plan, title: 'Changed source' }, execution };
  const invalid = { ...candidate, path: 'broken.md', plan: null, error: 'invalid' };
  expect(filterPlans([candidate, published, invalid], 'draft', '')).toEqual([candidate]);
  expect(filterPlans([candidate, published, invalid], 'published', ' USER TITLE ')).toEqual([published]);
  expect(filterPlans([invalid], 'all', 'broken')).toEqual([invalid]);
  expect(planDocument(published)).toBe(execution.plan);
});

test('frozen previews detect changed, unavailable and replaced sources while publication snapshots survive deletion', () => {
  const snapshot = capturePlan(candidate);
  expect(previewChanged(snapshot, { candidates: [candidate], executions: [] })).toBe(false);
  for (const source of [{ ...candidate, digest: 'b'.repeat(64) }, { ...candidate, error: 'invalid' },
    { ...candidate, plan: { ...plan, planId: 'replacement' } }]) {
    expect(previewChanged(snapshot, { candidates: [source], executions: [] })).toBe(true);
  }
  expect(previewChanged(snapshot, { candidates: [], executions: [] })).toBe(true);
  const published = capturePlan({ ...candidate, digest: 'b'.repeat(64), plan: null, error: 'invalid', execution });
  expect(published.digest).toBe(execution.digest);
  expect(published.plan).toBe(execution.plan);
  expect(previewChanged(published, { candidates: [], executions: [execution] })).toBe(false);
});

test('progress reports factual lifecycle groups and never counts cancelled tasks as done', () => {
  const statuses = ['done', 'implementing', 'testing', 'pending', 'paused', 'blocked', 'plan_review', 'cancelled'];
  const result = executionCounts({ ...execution, issues: statuses.map((status, i) => ({
    ...execution.issues[0]!, issueId: String(i), status,
  })) });
  expect(result).toEqual({ done: 1, total: 8, running: 2, pending: 1, attention: 3, cancelled: 1 });
});

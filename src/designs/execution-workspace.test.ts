import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Project } from '../core/types';
import type { EngineIssue } from '../issues/engine';
import { DesignExecutionWorkspaceAdapter, ExecutionWorkspaceError } from './execution-workspace';

const project = { id: 4, cwd: '/repo' } as Project;
const issue = (id: number) => ({ id, projectId: 4, moduleId: null, agent: 'codex' }) as EngineIssue;

function dbReturning(row: Record<string, unknown> | null): Database {
  return {
    query() { return { get: () => row }; },
  } as unknown as Database;
}

describe('DesignExecutionWorkspaceAdapter', () => {
  test('uses only the authoritative Issue publication link and falls back for unlinked/current runs', () => {
    for (const row of [null, {
      run_id: 'r', execution_mode: 'current', lifecycle_state: 'executing', assignment_active: 0,
    }]) {
      const adapter = new DesignExecutionWorkspaceAdapter({ db: dbReturning(row), conversations: {} as never });
      expect(adapter.resolve(issue(10), project)).toEqual({ kind: 'project', cwd: '/repo', branch: null, runId: null });
    }
  });

  test('fails closed while a linked worktree assignment is prepared but not executing', () => {
    const adapter = new DesignExecutionWorkspaceAdapter({ db: dbReturning({
      run_id: 'r', execution_mode: 'worktree', lifecycle_state: 'ready', assignment_active: 0,
    }), conversations: {} as never });
    expect(() => adapter.resolve(issue(10), project)).toThrow(ExecutionWorkspaceError);
  });

  test('returns the exact healthy active worktree for every linked Issue without any Git lifecycle call', () => {
    let lookups = 0;
    const db = { query() { return { get() { lookups++; return {
      run_id: 'run-1', run_project_id: 4, run_design_id: 9, run_publication_id: 7,
      execution_mode: 'worktree', lifecycle_state: 'executing', assignment_active: 1,
      worktree_cwd: '/managed/design-4-9', worktree_branch: 'codex/design-4-9',
      observed_head_sha: 'a'.repeat(40), error_code: null,
    }; } }; } } as unknown as Database;
    const adapter = new DesignExecutionWorkspaceAdapter({ db, conversations: {} as never });
    expect([11, 12, 13].map((id) => adapter.resolve(issue(id), project))).toEqual(Array(3).fill({
      kind: 'design-worktree', cwd: '/managed/design-4-9', branch: 'codex/design-4-9', runId: 'run-1',
    }));
    expect(lookups).toBe(3);
  });

  test('fails closed when an active linked worktree is unhealthy or mismatched', () => {
    const unhealthy = new DesignExecutionWorkspaceAdapter({ db: dbReturning({
      run_id: 'r', run_project_id: 4, run_design_id: 9, run_publication_id: 7,
      execution_mode: 'worktree', lifecycle_state: 'executing', assignment_active: 1,
      worktree_cwd: '/managed/design-4-9', worktree_branch: 'codex/design-4-9',
      observed_head_sha: null, error_code: 'WORKTREE_MISSING',
    }), conversations: {} as never });
    expect(() => unhealthy.resolve(issue(1), project)).toThrow(ExecutionWorkspaceError);
    try { unhealthy.resolve(issue(1), project); } catch (error) {
      expect((error as ExecutionWorkspaceError).code).toBe('RUN_UNHEALTHY');
    }
  });
});

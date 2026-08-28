import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ConversationManager } from '../core/conversations';
import type { Conversation, Project } from '../core/types';
import type {
  EngineExecutionWorkspace,
  EngineExecutionWorkspaceOps,
  EngineIssue,
} from '../issues/engine';

export type ExecutionWorkspaceErrorCode = 'RUN_UNHEALTHY' | 'WORKTREE_MISMATCH';

export class ExecutionWorkspaceError extends Error {
  constructor(readonly code: ExecutionWorkspaceErrorCode) {
    super('The linked design execution workspace is unavailable.');
    this.name = 'ExecutionWorkspaceError';
  }
}

interface LinkedRunRow {
  run_id: string | null;
  run_project_id: number | null;
  run_design_id: number | null;
  run_publication_id: number | null;
  execution_mode: 'current' | 'worktree' | null;
  lifecycle_state: string | null;
  assignment_active: number | null;
  worktree_cwd: string | null;
  worktree_branch: string | null;
  observed_head_sha: string | null;
  error_code: string | null;
}

interface ConversationBindingRow { conversation_id: string; context_path: string | null }

export interface DesignExecutionWorkspaceDeps {
  db: Database;
  conversations: Pick<ConversationManager, 'get' | 'createInWorkspaceWithId'>;
  now?: () => number;
}

function projectWorkspace(project: Project): EngineExecutionWorkspace {
  return { kind: 'project', cwd: project.cwd, branch: null, runId: null };
}

function conversationId(runId: string, moduleKey: string): string {
  const hex = createHash('sha256').update(`${runId}\0${moduleKey}`, 'utf8').digest('hex');
  return `dw-${hex.slice(0, 32)}`;
}

function moduleKey(issue: EngineIssue): string {
  return issue.moduleId === null ? `unassigned:${issue.agent}` : `module:${issue.moduleId}`;
}

export class DesignExecutionWorkspaceAdapter implements EngineExecutionWorkspaceOps {
  private readonly now: () => number;
  constructor(private readonly deps: DesignExecutionWorkspaceDeps) {
    this.now = deps.now ?? Date.now;
  }

  resolve(issue: EngineIssue, project: Project): EngineExecutionWorkspace {
    const row = this.deps.db.query<LinkedRunRow, [number, number]>(`
      SELECT run.id AS run_id, run.project_id AS run_project_id,
             run.design_task_id AS run_design_id, run.publication_id AS run_publication_id,
             run.execution_mode, run.lifecycle_state, run.assignment_active,
             run.worktree_cwd, run.worktree_branch, run.observed_head_sha, run.error_code
      FROM design_issue_links link
      JOIN design_publications publication
        ON publication.id = link.publication_id
       AND publication.design_task_id = link.design_task_id
       AND publication.project_id = link.project_id
      LEFT JOIN design_execution_runs run
        ON run.publication_id = publication.id
       AND run.design_task_id = publication.design_task_id
       AND run.project_id = publication.project_id
       AND run.approved_revision = publication.revision
       AND run.graph_digest = publication.graph_digest
      WHERE link.issue_id = ? AND link.project_id = ?
    `).get(issue.id, project.id);
    if (!row || !row.run_id || row.execution_mode === 'current') return projectWorkspace(project);
    // A publication-bound worktree decision is authoritative.  Until the owner has executed
    // the healthy assignment, linked Issues must stay pending instead of silently running in
    // the project checkout.
    if (row.execution_mode !== 'worktree'
      || row.lifecycle_state !== 'executing'
      || row.assignment_active !== 1) {
      throw new ExecutionWorkspaceError('RUN_UNHEALTHY');
    }
    const expectedBranch = `codex/design-${project.id}-${row.run_design_id}`;
    if (row.error_code || !row.worktree_cwd || !row.observed_head_sha) {
      throw new ExecutionWorkspaceError('RUN_UNHEALTHY');
    }
    if (row.run_project_id !== project.id || row.run_publication_id === null
      || row.worktree_branch !== expectedBranch || !posix.isAbsolute(row.worktree_cwd)) {
      throw new ExecutionWorkspaceError('WORKTREE_MISMATCH');
    }
    return {
      kind: 'design-worktree', cwd: row.worktree_cwd,
      branch: row.worktree_branch, runId: row.run_id,
    };
  }

  async conversationFor(issue: EngineIssue, workspace: EngineExecutionWorkspace): Promise<Conversation> {
    if (workspace.kind !== 'design-worktree' || !workspace.runId || !workspace.branch) {
      throw new ExecutionWorkspaceError('WORKTREE_MISMATCH');
    }
    const key = moduleKey(issue);
    const existing = this.deps.db.query<ConversationBindingRow, [string, string]>(
      'SELECT conversation_id, context_path FROM design_run_conversations WHERE run_id = ? AND module_key = ?',
    ).get(workspace.runId, key);
    if (existing) {
      const conversation = this.deps.conversations.get(existing.conversation_id);
      if (!conversation || conversation.projectId !== issue.projectId
        || conversation.agent !== issue.agent || conversation.workspaceCwd !== workspace.cwd) {
        throw new ExecutionWorkspaceError('WORKTREE_MISMATCH');
      }
      return conversation;
    }
    const run = this.deps.db.query<{
      project_id: number; approved_revision: number; graph_digest: string; worktree_cwd: string | null;
    }, [string]>(`SELECT project_id, approved_revision, graph_digest, worktree_cwd
                  FROM design_execution_runs WHERE id = ? AND lifecycle_state = 'executing'
                    AND assignment_active = 1 AND error_code IS NULL`).get(workspace.runId);
    if (!run || run.project_id !== issue.projectId || run.worktree_cwd !== workspace.cwd) {
      throw new ExecutionWorkspaceError('RUN_UNHEALTHY');
    }
    if (issue.moduleId !== null) {
      const module = this.deps.db.query<{ agent: string }, [number, number]>(
        "SELECT agent FROM project_modules WHERE id = ? AND project_id = ? AND status = 'active'",
      ).get(issue.moduleId, issue.projectId);
      if (!module || module.agent !== issue.agent) throw new ExecutionWorkspaceError('WORKTREE_MISMATCH');
    }
    const id = conversationId(workspace.runId, key);
    const ts = this.now();
    const contextPath = posix.join(workspace.cwd, '.panda', 'tmp', 'design-runs', workspace.runId, `${key.replace(':', '-')}.md`);
    return this.deps.db.transaction(() => {
      const raced = this.deps.db.query<ConversationBindingRow, [string, string]>(
        'SELECT conversation_id, context_path FROM design_run_conversations WHERE run_id = ? AND module_key = ?',
      ).get(workspace.runId!, key);
      if (raced) {
        const conversation = this.deps.conversations.get(raced.conversation_id);
        if (!conversation) throw new ExecutionWorkspaceError('WORKTREE_MISMATCH');
        return conversation;
      }
      const conversation = this.deps.conversations.createInWorkspaceWithId(
        id, issue.projectId, `Design run ${workspace.runId} · ${key}`, issue.agent, workspace.cwd,
      );
      this.deps.db.query(`INSERT INTO design_run_conversations
        (run_id, project_id, module_id, module_key, conversation_id, seed_revision,
         seed_digest, context_path, created_ts, updated_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(workspace.runId, issue.projectId, issue.moduleId, key, id, run.approved_revision,
          run.graph_digest, contextPath, ts, ts);
      return conversation;
    })();
  }

  contextFor(issue: EngineIssue, workspace: EngineExecutionWorkspace): string | null {
    if (workspace.kind !== 'design-worktree' || !workspace.runId) return null;
    return this.deps.db.query<{ context_path: string | null }, [string, string]>(
      'SELECT context_path FROM design_run_conversations WHERE run_id = ? AND module_key = ?',
    ).get(workspace.runId, moduleKey(issue))?.context_path ?? null;
  }

  async recordResult(issue: EngineIssue, workspace: EngineExecutionWorkspace, summary: string): Promise<void> {
    if (workspace.kind !== 'design-worktree' || !workspace.runId) return;
    const bounded = summary.slice(0, 65_536);
    this.deps.db.query(`UPDATE design_run_conversations
      SET handoff_summary = ?, updated_ts = ? WHERE run_id = ? AND module_key = ?`)
      .run(bounded, this.now(), workspace.runId, moduleKey(issue));
  }
}

export function createDesignExecutionWorkspaceAdapter(
  deps: DesignExecutionWorkspaceDeps,
): EngineExecutionWorkspaceOps & Pick<DesignExecutionWorkspaceAdapter, 'contextFor'> {
  return new DesignExecutionWorkspaceAdapter(deps);
}

/**
 * 并行写节点的 Git worktree 生命周期与汇合冲突恢复。
 *
 * worktree 行是唯一事实源：节点启动前 preparing→active，节点完成后固化 head_sha；汇合按
 * finished_ts/id 顺序合并。冲突保留在主工作区并交独立 Agent 处理，无法安全收口时置 paused，
 * 用户修复主工作区后通过既有 issue unblock 入口重试同一次汇合。
 */
import type { Database } from 'bun:sqlite';
import { chatTmux } from '../core/conversations';
import type {
  AgentKind,
  IssueWorkflowNodeRun,
  IssueWorkflowWorktree,
  WorkflowGraphSnapshot,
} from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { readDriverText } from '../core/skills';
import { gitLockKey, KeyedMutex, tmuxLockKey } from './mutex';
import type { WorkflowNodeConversationOps } from './workflow-node-runner';

const MAX_CONFLICT_RESULT_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_CHARS = 8_000;

type WorktreeDriver = Pick<
  ExecutorDriver,
  'git' | 'writeFile' | 'statPath' | 'readFileRange' | 'sendKeys'
>;

interface WorktreeRow {
  id: number;
  issue_workflow_id: number;
  node_run_id: number;
  path: string;
  branch: string;
  base_ref: string;
  base_sha: string | null;
  head_sha: string | null;
  status: string;
  conflict_details: string | null;
  resolution_conversation_id: string | null;
  created_ts: number;
  updated_ts: number;
  merged_ts: number | null;
  cleaned_ts: number | null;
}

interface RunLookupRow {
  issue_workflow_id: number;
  issue_id: number;
  project_id: number;
  cwd: string;
  node_key: string;
  parallel_group_key: string | null;
  graph_json: string;
}

interface WorkflowLookupRow {
  issue_id: number;
  project_id: number;
  cwd: string;
}

export type WorktreeStepResult =
  | { state: 'completed' }
  | { state: 'running' }
  | { state: 'paused'; reason: string };

export interface WorkflowWorktreeCoordinator {
  prepare(runId: number): Promise<string | null>;
  finalize(run: IssueWorkflowNodeRun): Promise<{ ok: true } | { ok: false; reason: string }>;
  mergeAtJoin(
    workflowId: number,
    predecessorRunIds: readonly number[],
    locale?: SupportedLocale,
  ): Promise<WorktreeStepResult>;
  cleanupFailed?(workflowId: number): Promise<void>;
}

export interface WorkflowWorktreeManagerDeps {
  db: Database;
  driver: WorktreeDriver;
  conversations: WorkflowNodeConversationOps;
  mutex: KeyedMutex;
  now?: () => number;
  logEvent(issueId: number, kind: string, data?: Record<string, unknown>): void;
}

function mapWorktree(row: WorktreeRow): IssueWorkflowWorktree {
  return {
    id: row.id,
    issueWorkflowId: row.issue_workflow_id,
    nodeRunId: row.node_run_id,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    status: row.status as IssueWorkflowWorktree['status'],
    conflictDetails: row.conflict_details,
    resolutionConversationId: row.resolution_conversation_id,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    mergedTs: row.merged_ts,
    cleanedTs: row.cleaned_ts,
  };
}

function safeNodeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'node';
}

function diagnostic(value: unknown): string {
  return String(value).slice(0, MAX_DIAGNOSTIC_CHARS);
}

function conflictPaths(cwd: string, workflowId: number, worktreeId: number) {
  const rel = `.panda/tmp/workflows/${workflowId}/conflicts/${worktreeId}`;
  const base = `${cwd.replace(/\/+$/, '')}/${rel}`;
  return {
    context: `${base}/context.json`,
    result: `${base}/result.json`,
    done: `${base}/done`,
    contextRel: `${rel}/context.json`,
    resultRel: `${rel}/result.json`,
    doneRel: `${rel}/done`,
  };
}

export function buildWorkflowConflictPrompt(
  agent: AgentKind,
  paths: ReturnType<typeof conflictPaths>,
  locale: SupportedLocale = DEFAULT_LOCALE,
  resume = false,
): string {
  if (promptLanguage(locale) === 'en') {
    return [
      resume ? `Resume the merge-conflict resolution described in ${paths.contextRel}.` : `Resolve the Git merge conflict described in ${paths.contextRel}.`,
      'Work only in the current working tree. Preserve both branches\' intended behavior, run focused checks when useful, stage the resolved files, and finish the pending merge commit.',
      `Do not add files under .panda/tmp. Write ${paths.resultRel} as JSON with exactly {"schemaVersion":1,"status":"resolved or blocked","details":"natural-language result or remaining risk"}.`,
      `Create ${paths.doneRel} containing ok only after result.json is complete. Use status blocked when a safe automatic resolution is not possible.`,
      agent === 'codex' ? 'Proceed without requesting approval.' : '',
      outputLanguageInstruction(locale),
    ].filter(Boolean).join(' ');
  }
  return [
    resume ? `继续处理 ${paths.contextRel} 描述的合并冲突。` : `处理 ${paths.contextRel} 描述的 Git 合并冲突。`,
    '只在当前工作树操作；保留两条分支的预期行为，必要时运行定向检查，暂存已解决文件并完成当前合并提交。',
    `不要添加 .panda/tmp 下的文件。把 ${paths.resultRel} 写成 JSON，形状必须严格为 {"schemaVersion":1,"status":"resolved 或 blocked","details":"自然语言结果或剩余风险"}。`,
    `result.json 完整写入后才创建 ${paths.doneRel}，内容写 ok；无法安全自动解决时使用 blocked。`,
    agent === 'codex' ? '无需请求审批，直接执行。' : '',
    outputLanguageInstruction(locale),
  ].filter(Boolean).join(' ');
}

function parseConflictResult(raw: string): { status: 'resolved' | 'blocked'; details: string } | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const status = value.status;
    const details = typeof value.details === 'string' ? value.details.trim() : '';
    return value.schemaVersion === 1 && (status === 'resolved' || status === 'blocked') && details
      ? { status, details: details.slice(0, MAX_DIAGNOSTIC_CHARS) }
      : null;
  } catch {
    return null;
  }
}

export class WorkflowWorktreeManager implements WorkflowWorktreeCoordinator {
  private readonly now: () => number;
  private readonly ownedResolvers = new Set<number>();

  constructor(private readonly deps: WorkflowWorktreeManagerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private rowByRun(runId: number): IssueWorkflowWorktree | null {
    const row = this.deps.db
      .query<WorktreeRow, [number]>('SELECT * FROM issue_workflow_worktrees WHERE node_run_id = ?')
      .get(runId);
    return row ? mapWorktree(row) : null;
  }

  private rowById(id: number): IssueWorkflowWorktree | null {
    const row = this.deps.db
      .query<WorktreeRow, [number]>('SELECT * FROM issue_workflow_worktrees WHERE id = ?')
      .get(id);
    return row ? mapWorktree(row) : null;
  }

  private workflow(workflowId: number): WorkflowLookupRow {
    const row = this.deps.db
      .query<WorkflowLookupRow, [number]>(
        `SELECT iw.issue_id, i.project_id, p.cwd FROM issue_workflows iw
         JOIN issues i ON i.id = iw.issue_id JOIN projects p ON p.id = i.project_id
         WHERE iw.id = ?`,
      )
      .get(workflowId);
    if (!row) throw new Error('workflow.worktree_workflow_missing');
    return row;
  }

  async prepare(runId: number): Promise<string | null> {
    const lookup = this.deps.db
      .query<RunLookupRow, [number]>(
        `SELECT r.issue_workflow_id, iw.issue_id, i.project_id, p.cwd, r.node_key,
                r.parallel_group_key, iw.graph_json
         FROM issue_workflow_node_runs r
         JOIN issue_workflows iw ON iw.id = r.issue_workflow_id
         JOIN issues i ON i.id = iw.issue_id JOIN projects p ON p.id = i.project_id
         WHERE r.id = ?`,
      )
      .get(runId);
    if (!lookup) throw new Error('workflow.worktree_run_missing');
    const graph = JSON.parse(lookup.graph_json) as WorkflowGraphSnapshot;
    const node = graph.nodes.find((candidate) => candidate.key === lookup.node_key);
    if (!node || node.executionMode !== 'write' || !lookup.parallel_group_key) return null;
    const existing = this.rowByRun(runId);
    if (existing?.status === 'active') return existing.path;
    if (existing?.status === 'preparing') {
      return this.deps.mutex.runExclusive(gitLockKey(lookup.project_id), async () => {
        const valid = await this.deps.driver.git(existing.path, ['rev-parse', '--is-inside-work-tree']);
        if (valid.code !== 0) {
          await this.deps.driver.git(lookup.cwd, ['worktree', 'prune']);
          const branchExists = await this.deps.driver.git(
            lookup.cwd,
            ['show-ref', '--verify', '--quiet', `refs/heads/${existing.branch}`],
          );
          const added = await this.deps.driver.git(
            lookup.cwd,
            branchExists.code === 0
              ? ['worktree', 'add', existing.path, existing.branch]
              : ['worktree', 'add', '-b', existing.branch, existing.path, existing.baseSha ?? 'HEAD'],
          );
          if (added.code !== 0) throw new Error(`workflow.worktree_recover_failed:${diagnostic(added.err || added.out)}`);
        }
        this.deps.db.query(
          `UPDATE issue_workflow_worktrees SET status = 'active', updated_ts = ? WHERE id = ?`,
        ).run(this.now(), existing.id);
        this.deps.logEvent(lookup.issue_id, 'workflow_worktree_recovered', {
          workflowId: lookup.issue_workflow_id,
          runId,
          worktreeId: existing.id,
        });
        return existing.path;
      });
    }

    const path = `${lookup.cwd.replace(/\/+$/, '')}/.worktrees/workflow-${lookup.issue_workflow_id}/run-${runId}`;
    const branch = `workflow/${lookup.issue_id}/${runId}-${safeNodeKey(lookup.node_key)}`;
    return this.deps.mutex.runExclusive(gitLockKey(lookup.project_id), async () => {
      const baseRefResult = await this.deps.driver.git(lookup.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
      const baseShaResult = await this.deps.driver.git(lookup.cwd, ['rev-parse', '--verify', 'HEAD']);
      if (baseShaResult.code !== 0) throw new Error(`workflow.worktree_base_missing:${diagnostic(baseShaResult.err)}`);
      const baseRef = baseRefResult.code === 0 ? baseRefResult.out.trim() : 'HEAD';
      const baseSha = baseShaResult.out.trim();
      const ts = this.now();
      const row = this.deps.db
        .query<{ id: number }, [number, number, string, string, string, string, number, number]>(
          `INSERT INTO issue_workflow_worktrees
             (issue_workflow_id, node_run_id, path, branch, base_ref, base_sha, status, created_ts, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, 'preparing', ?, ?) RETURNING id`,
        )
        .get(lookup.issue_workflow_id, runId, path, branch, baseRef, baseSha, ts, ts)!;
      const added = await this.deps.driver.git(lookup.cwd, ['worktree', 'add', '-b', branch, path, baseSha]);
      if (added.code !== 0) {
        this.deps.db.query(
          `UPDATE issue_workflow_worktrees SET status = 'failed', conflict_details = ?, updated_ts = ? WHERE id = ?`,
        ).run(diagnostic(added.err || added.out), this.now(), row.id);
        throw new Error(`workflow.worktree_add_failed:${diagnostic(added.err || added.out)}`);
      }
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees SET status = 'active', updated_ts = ? WHERE id = ?`,
      ).run(this.now(), row.id);
      this.deps.logEvent(lookup.issue_id, 'workflow_worktree_created', {
        workflowId: lookup.issue_workflow_id,
        runId,
        worktreeId: row.id,
        branch,
        baseSha,
      });
      return path;
    });
  }

  async finalize(run: IssueWorkflowNodeRun): Promise<{ ok: true } | { ok: false; reason: string }> {
    const worktree = this.rowByRun(run.id);
    if (!worktree || worktree.status === 'cleaned' || worktree.headSha) return { ok: true };
    const lookup = this.workflow(run.issueWorkflowId);
    return this.deps.mutex.runExclusive(gitLockKey(lookup.project_id), async () => {
      await this.deps.driver.git(worktree.path, ['reset', '--quiet', '--', '.panda/tmp']);
      const add = await this.deps.driver.git(worktree.path, [
        'add', '-A', '--', '.', ':(exclude).panda/tmp', ':(exclude).panda/tmp/**',
      ]);
      if (add.code !== 0) return { ok: false, reason: `workflow.worktree_stage_failed:${diagnostic(add.err || add.out)}` };
      const staged = await this.deps.driver.git(worktree.path, ['diff', '--cached', '--quiet']);
      if (staged.code === 1) {
        const commit = await this.deps.driver.git(worktree.path, [
          'commit', '-m', `workflow: #${lookup.issue_id} ${run.nodeKey} (run ${run.id})`,
        ]);
        if (commit.code !== 0) return { ok: false, reason: `workflow.worktree_commit_failed:${diagnostic(commit.err || commit.out)}` };
      } else if (staged.code !== 0) {
        return { ok: false, reason: `workflow.worktree_diff_failed:${diagnostic(staged.err || staged.out)}` };
      }
      const head = await this.deps.driver.git(worktree.path, ['rev-parse', '--verify', 'HEAD']);
      if (head.code !== 0) return { ok: false, reason: `workflow.worktree_head_failed:${diagnostic(head.err || head.out)}` };
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees SET head_sha = ?, updated_ts = ? WHERE id = ?`,
      ).run(head.out.trim(), this.now(), worktree.id);
      this.deps.logEvent(lookup.issue_id, 'workflow_worktree_ready', {
        workflowId: run.issueWorkflowId,
        runId: run.id,
        worktreeId: worktree.id,
        headSha: head.out.trim(),
      });
      return { ok: true };
    });
  }

  private async cleanup(worktree: IssueWorkflowWorktree, lookup: WorkflowLookupRow): Promise<boolean> {
    const removed = await this.deps.driver.git(lookup.cwd, ['worktree', 'remove', '--force', worktree.path]);
    if (removed.code !== 0) {
      const listed = await this.deps.driver.git(lookup.cwd, ['worktree', 'list', '--porcelain']);
      if (listed.code !== 0 || listed.out.split('\n').some((line) => line === `worktree ${worktree.path}`)) {
        this.deps.db.query(
          `UPDATE issue_workflow_worktrees SET status = 'cleanup_pending', conflict_details = ?, updated_ts = ? WHERE id = ?`,
        ).run(diagnostic(removed.err || removed.out), this.now(), worktree.id);
        return false;
      }
    }
    const deleted = await this.deps.driver.git(lookup.cwd, ['branch', '-D', worktree.branch]);
    if (deleted.code !== 0) {
      const exists = await this.deps.driver.git(lookup.cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${worktree.branch}`]);
      if (exists.code === 0) {
        this.deps.db.query(
          `UPDATE issue_workflow_worktrees SET status = 'cleanup_pending', conflict_details = ?, updated_ts = ? WHERE id = ?`,
        ).run(diagnostic(deleted.err || deleted.out), this.now(), worktree.id);
        return false;
      }
    }
    const ts = this.now();
    if (worktree.resolutionConversationId) {
      await this.deps.conversations.closeChat?.(worktree.resolutionConversationId).catch(() => {});
    }
    this.deps.db.query(
      `UPDATE issue_workflow_worktrees
       SET status = 'cleaned', conflict_details = NULL, cleaned_ts = ?, updated_ts = ? WHERE id = ?`,
    ).run(ts, ts, worktree.id);
    this.deps.logEvent(lookup.issue_id, 'workflow_worktree_cleaned', {
      workflowId: worktree.issueWorkflowId,
      runId: worktree.nodeRunId,
      worktreeId: worktree.id,
    });
    return true;
  }

  private async unresolved(cwd: string): Promise<string[]> {
    const result = await this.deps.driver.git(cwd, ['diff', '--name-only', '--diff-filter=U']);
    return result.code === 0 ? result.out.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  }

  private async finishResolved(worktree: IssueWorkflowWorktree, lookup: WorkflowLookupRow): Promise<WorktreeStepResult> {
    const files = await this.unresolved(lookup.cwd);
    if (files.length) return { state: 'paused', reason: `workflow.merge_conflict_unresolved:${files.join(',')}` };
    const mergeHead = await this.deps.driver.git(lookup.cwd, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD']);
    if (mergeHead.code === 0) {
      const staged = await this.deps.driver.git(lookup.cwd, ['add', '-u']);
      if (staged.code !== 0) return { state: 'paused', reason: `workflow.merge_stage_failed:${diagnostic(staged.err || staged.out)}` };
      const commit = await this.deps.driver.git(lookup.cwd, ['commit', '--no-edit']);
      if (commit.code !== 0) return { state: 'paused', reason: `workflow.merge_commit_failed:${diagnostic(commit.err || commit.out)}` };
    }
    if (worktree.headSha) {
      const applied = await this.deps.driver.git(
        lookup.cwd,
        ['merge-base', '--is-ancestor', worktree.headSha, 'HEAD'],
      );
      if (applied.code !== 0) {
        return { state: 'paused', reason: `workflow.merge_not_applied:${worktree.branch}` };
      }
    }
    const ts = this.now();
    this.deps.db.query(
      `UPDATE issue_workflow_worktrees
       SET status = 'merged', conflict_details = NULL, merged_ts = COALESCE(merged_ts, ?), updated_ts = ? WHERE id = ?`,
    ).run(ts, ts, worktree.id);
    const refreshed = this.rowById(worktree.id)!;
    return await this.cleanup(refreshed, lookup) ? { state: 'completed' } : { state: 'running' };
  }

  private resolverAgent(worktree: IssueWorkflowWorktree): AgentKind {
    const row = this.deps.db
      .query<{ agent: string | null }, [number]>(
        'SELECT agent FROM issue_workflow_node_runs WHERE id = ?',
      )
      .get(worktree.nodeRunId);
    return row?.agent === 'claude' ? 'claude' : 'codex';
  }

  private async startResolver(
    worktree: IssueWorkflowWorktree,
    lookup: WorkflowLookupRow,
    files: string[],
    locale: SupportedLocale,
  ): Promise<WorktreeStepResult> {
    const agent = this.resolverAgent(worktree);
    const paths = conflictPaths(lookup.cwd, worktree.issueWorkflowId, worktree.id);
    const conversation = this.deps.conversations.create(
      lookup.project_id,
      `workflow-conflict:${worktree.issueWorkflowId}:${worktree.id}`,
      agent,
      'chat',
    );
    const context = {
      schemaVersion: 1,
      workflowId: worktree.issueWorkflowId,
      worktreeId: worktree.id,
      branch: worktree.branch,
      conflictFiles: files,
      gitState: 'MERGE_HEAD',
      resultContract: { resultPath: paths.resultRel, donePath: paths.doneRel, statusValues: ['resolved', 'blocked'] },
    };
    try {
      await this.deps.driver.writeFile(paths.context, JSON.stringify(context, null, 2));
      const session = chatTmux(conversation.id);
      await this.deps.mutex.runExclusive(tmuxLockKey(session), async () => {
        const active = await this.deps.conversations.activate(conversation.id, lookup.cwd);
        if (!active) throw new Error('workflow.conflict_conversation_missing');
        await this.deps.driver.sendKeys(session, buildWorkflowConflictPrompt(agent, paths, locale));
      });
      this.ownedResolvers.add(worktree.id);
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees
         SET status = 'resolving', resolution_conversation_id = ?, updated_ts = ? WHERE id = ?`,
      ).run(conversation.id, this.now(), worktree.id);
      this.deps.logEvent(lookup.issue_id, 'workflow_conflict_resolution_started', {
        workflowId: worktree.issueWorkflowId,
        worktreeId: worktree.id,
        conversationId: conversation.id,
        files,
      });
      return { state: 'running' };
    } catch (error) {
      const reason = `workflow.conflict_agent_start_failed:${diagnostic(error)}`;
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees SET status = 'paused', conflict_details = ?, updated_ts = ? WHERE id = ?`,
      ).run(reason, this.now(), worktree.id);
      return { state: 'paused', reason };
    }
  }

  private async pollResolver(
    worktree: IssueWorkflowWorktree,
    lookup: WorkflowLookupRow,
    locale: SupportedLocale,
  ): Promise<WorktreeStepResult> {
    const paths = conflictPaths(lookup.cwd, worktree.issueWorkflowId, worktree.id);
    const done = await this.deps.driver.statPath(paths.done).catch(() => null);
    if (!done?.isFile) {
      if (worktree.resolutionConversationId && !this.ownedResolvers.has(worktree.id)) {
        const session = chatTmux(worktree.resolutionConversationId);
        await this.deps.mutex.runExclusive(tmuxLockKey(session), async () => {
          const active = await this.deps.conversations.activate(worktree.resolutionConversationId!, lookup.cwd);
          if (!active) throw new Error('workflow.conflict_conversation_missing');
          await this.deps.driver.sendKeys(
            session,
            buildWorkflowConflictPrompt(this.resolverAgent(worktree), paths, locale, true),
          );
        });
        this.ownedResolvers.add(worktree.id);
        this.deps.logEvent(lookup.issue_id, 'workflow_conflict_resolution_resumed', {
          workflowId: worktree.issueWorkflowId,
          worktreeId: worktree.id,
          conversationId: worktree.resolutionConversationId,
        });
      }
      return { state: 'running' };
    }
    const raw = await readDriverText(this.deps.driver, paths.result, MAX_CONFLICT_RESULT_BYTES);
    const parsed = raw ? parseConflictResult(raw) : null;
    if (!parsed || parsed.status === 'blocked') {
      const reason = parsed?.details ?? 'workflow.conflict_result_invalid';
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees SET status = 'paused', conflict_details = ?, updated_ts = ? WHERE id = ?`,
      ).run(reason, this.now(), worktree.id);
      this.deps.logEvent(lookup.issue_id, 'workflow_conflict_resolution_paused', {
        workflowId: worktree.issueWorkflowId,
        worktreeId: worktree.id,
        reason,
      });
      return { state: 'paused', reason };
    }
    return this.finishResolved(worktree, lookup);
  }

  private async mergeOne(
    worktree: IssueWorkflowWorktree,
    lookup: WorkflowLookupRow,
    locale: SupportedLocale,
  ): Promise<WorktreeStepResult> {
    if (worktree.status === 'cleaned') return { state: 'completed' };
    if (worktree.status === 'cleanup_pending' || worktree.status === 'merged') {
      return await this.cleanup(worktree, lookup) ? { state: 'completed' } : { state: 'running' };
    }
    if (worktree.status === 'resolving') return this.pollResolver(worktree, lookup, locale);
    if (worktree.status === 'paused') return this.finishResolved(worktree, lookup);
    if (worktree.status === 'failed') {
      return { state: 'paused', reason: worktree.conflictDetails ?? 'workflow.worktree_failed' };
    }
    if (!worktree.headSha) return { state: 'running' };

    const merged = await this.deps.driver.git(lookup.cwd, ['merge', '--no-ff', '--no-edit', worktree.branch]);
    if (merged.code === 0) {
      const ts = this.now();
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees
         SET status = 'merged', conflict_details = NULL, merged_ts = ?, updated_ts = ? WHERE id = ?`,
      ).run(ts, ts, worktree.id);
      this.deps.logEvent(lookup.issue_id, 'workflow_worktree_merged', {
        workflowId: worktree.issueWorkflowId,
        runId: worktree.nodeRunId,
        worktreeId: worktree.id,
        branch: worktree.branch,
      });
      return await this.cleanup(this.rowById(worktree.id)!, lookup)
        ? { state: 'completed' }
        : { state: 'running' };
    }
    const files = await this.unresolved(lookup.cwd);
    const details = JSON.stringify({ code: 'workflow.merge_conflict', files, stderr: diagnostic(merged.err || merged.out) });
    if (!files.length) {
      this.deps.db.query(
        `UPDATE issue_workflow_worktrees SET status = 'paused', conflict_details = ?, updated_ts = ? WHERE id = ?`,
      ).run(details, this.now(), worktree.id);
      return { state: 'paused', reason: `workflow.merge_failed:${diagnostic(merged.err || merged.out)}` };
    }
    this.deps.db.query(
      `UPDATE issue_workflow_worktrees SET status = 'merging', conflict_details = ?, updated_ts = ? WHERE id = ?`,
    ).run(details, this.now(), worktree.id);
    this.deps.logEvent(lookup.issue_id, 'workflow_merge_conflict', {
      workflowId: worktree.issueWorkflowId,
      runId: worktree.nodeRunId,
      worktreeId: worktree.id,
      files,
    });
    return this.startResolver(this.rowById(worktree.id)!, lookup, files, locale);
  }

  async mergeAtJoin(
    workflowId: number,
    predecessorRunIds: readonly number[],
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): Promise<WorktreeStepResult> {
    const lookup = this.workflow(workflowId);
    const unique = [...new Set(predecessorRunIds)];
    const rows = unique.length
      ? this.deps.db.query<WorktreeRow, number[]>(
          `SELECT w.* FROM issue_workflow_worktrees w
           JOIN issue_workflow_node_runs r ON r.id = w.node_run_id
           WHERE w.node_run_id IN (${unique.map(() => '?').join(',')})
           ORDER BY r.finished_ts, r.id`,
        ).all(...unique).map(mapWorktree)
      : [];
    for (const row of rows) {
      const result = await this.deps.mutex.runExclusive(gitLockKey(lookup.project_id), () =>
        this.mergeOne(row, lookup, locale),
      );
      if (result.state !== 'completed') return result;
    }
    return { state: 'completed' };
  }

  async cleanupFailed(workflowId: number): Promise<void> {
    const lookup = this.workflow(workflowId);
    const rows = this.deps.db
      .query<WorktreeRow, [number]>(
        `SELECT w.* FROM issue_workflow_worktrees w
         JOIN issue_workflow_node_runs r ON r.id = w.node_run_id
         WHERE w.issue_workflow_id = ? AND r.status = 'failed'
           AND w.status IN ('preparing', 'active', 'failed', 'cleanup_pending')
         ORDER BY w.id`,
      )
      .all(workflowId)
      .map(mapWorktree);
    for (const row of rows) {
      await this.deps.mutex.runExclusive(gitLockKey(lookup.project_id), async () => {
        const cleaned = await this.cleanup(row, lookup);
        if (cleaned) {
          this.deps.logEvent(lookup.issue_id, 'workflow_worktree_failed_attempt_cleaned', {
            workflowId,
            runId: row.nodeRunId,
            worktreeId: row.id,
          });
        }
      });
    }
  }
}

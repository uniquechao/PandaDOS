/**
 * 可恢复的 issue 工作流图调度器。
 *
 * 内存只保存“本进程已接管的 run”集合；控制流、重试、并行 token、汇合和循环次数均由
 * issue_workflow_* 表重建。服务重启后首个 tick 会恢复 running 对话、补收结果和补派已落库连线。
 */
import type { Database } from 'bun:sqlite';
import type {
  IssueWorkflowNodeRun,
  WorkflowEdgeDefinition,
  WorkflowGraphSnapshot,
  WorkflowNodeDefinition,
} from '../core/types';
import type { SupportedLocale } from '../../shared/i18n/locales';
import { WorkflowNodeRunner } from './workflow-node-runner';
import type { WorkflowWorktreeCoordinator } from './workflow-worktrees';

interface WorkflowRow {
  id: number;
  issue_id: number;
  status: string;
  pause_reason: string | null;
  graph_json: string;
  max_loop_iterations: number;
  started_ts: number | null;
  completed_ts: number | null;
}

interface ParallelGroup {
  forkRunId: number;
  parentGroup: string | null;
  parentToken: string;
}

export type WorkflowTickResult =
  | { state: 'running' }
  | { state: 'completed' }
  | { state: 'paused'; reason: string }
  | { state: 'failed'; reason: string };

export interface WorkflowSchedulerDeps {
  db: Database;
  nodes: WorkflowNodeRunner;
  worktrees?: WorkflowWorktreeCoordinator;
  now?: () => number;
  logEvent(issueId: number, kind: string, data?: unknown): void;
}

function parseGroup(value: string | null): ParallelGroup | null {
  if (!value) return null;
  try {
    const row = JSON.parse(value) as Partial<ParallelGroup>;
    return Number.isInteger(row.forkRunId) && row.forkRunId! > 0 &&
      typeof row.parentToken === 'string' &&
      (row.parentGroup === null || typeof row.parentGroup === 'string')
      ? { forkRunId: row.forkRunId!, parentGroup: row.parentGroup ?? null, parentToken: row.parentToken }
      : null;
  } catch {
    return null;
  }
}

function retryLimit(node: WorkflowNodeDefinition): number {
  const value = Number(node.config?.retryLimit);
  return Number.isInteger(value) && value >= 0 && value <= 3 ? value : 1;
}

export class WorkflowScheduler {
  private readonly now: () => number;
  /** 新建于本进程的 run 不需要“重启恢复”提示；服务重启后集合为空，恰好全部恢复一次。 */
  private readonly ownedRuns = new Set<number>();

  constructor(private readonly deps: WorkflowSchedulerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private workflowByIssue(issueId: number): WorkflowRow | null {
    return this.deps.db
      .query<WorkflowRow, [number]>('SELECT * FROM issue_workflows WHERE issue_id = ?')
      .get(issueId) ?? null;
  }

  private graph(row: WorkflowRow): WorkflowGraphSnapshot {
    return JSON.parse(row.graph_json) as WorkflowGraphSnapshot;
  }

  private runs(workflowId: number): IssueWorkflowNodeRun[] {
    return this.deps.db
      .query<{ id: number }, [number]>(
        'SELECT id FROM issue_workflow_node_runs WHERE issue_workflow_id = ? ORDER BY id',
      )
      .all(workflowId)
      .map(({ id }) => this.deps.nodes.getRun(id)!)
      .filter(Boolean);
  }

  private node(graph: WorkflowGraphSnapshot, key: string): WorkflowNodeDefinition {
    const node = graph.nodes.find((candidate) => candidate.key === key);
    if (!node) throw new Error(`工作流节点 ${key} 不存在`);
    return node;
  }

  private outgoing(graph: WorkflowGraphSnapshot, key: string): WorkflowEdgeDefinition[] {
    return graph.edges
      .filter((edge) => edge.fromNodeKey === key)
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
  }

  private insertControlRun(input: {
    workflowId: number;
    node: WorkflowNodeDefinition;
    iteration: number;
    tokenKey: string;
    parentRunId: number | null;
    predecessorRunIds: number[];
    parallelGroupKey: string | null;
    status: 'waiting_join' | 'succeeded';
    selectedEdgeKeys?: string[];
  }): IssueWorkflowNodeRun {
    const ts = this.now();
    const attempt = this.deps.db
      .query<{ attempt: number }, [number, string]>(
        `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
         FROM issue_workflow_node_runs WHERE issue_workflow_id = ? AND node_key = ?`,
      )
      .get(input.workflowId, input.node.key)!.attempt;
    const id = this.deps.db
      .query<
        { id: number },
        [number, string, number, number, string, number | null, string, string | null, string, string, number, number, number | null]
      >(
        `INSERT INTO issue_workflow_node_runs
           (issue_workflow_id, node_key, attempt, iteration, token_key, parent_run_id,
            predecessor_run_ids_json, parallel_group_key, status, selected_edge_keys_json,
            created_ts, updated_ts, finished_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        input.workflowId,
        input.node.key,
        attempt,
        input.iteration,
        input.tokenKey,
        input.parentRunId,
        JSON.stringify([...new Set(input.predecessorRunIds)]),
        input.parallelGroupKey,
        input.status,
        JSON.stringify(input.selectedEdgeKeys ?? []),
        ts,
        ts,
        input.status === 'succeeded' ? ts : null,
      )!.id;
    return this.deps.nodes.getRun(id)!;
  }

  private resultAncestors(runIds: readonly number[]): number[] {
    const result = new Set<number>();
    const seen = new Set<number>();
    const visit = (id: number): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const run = this.deps.nodes.getRun(id);
      if (!run || run.status !== 'succeeded') return;
      if (run.outputText) {
        result.add(run.id);
        return;
      }
      const previous = run.predecessorRunIds.length
        ? run.predecessorRunIds
        : run.parentRunId
          ? [run.parentRunId]
          : [];
      previous.forEach(visit);
    };
    runIds.forEach(visit);
    return [...result];
  }

  private childOf(fromRunId: number, nodeKey: string): IssueWorkflowNodeRun | null {
    const row = this.deps.db
      .query<{ id: number }, [number, string]>(
        `SELECT id FROM issue_workflow_node_runs
         WHERE parent_run_id = ? AND node_key = ? ORDER BY id LIMIT 1`,
      )
      .get(fromRunId, nodeKey);
    return row ? this.deps.nodes.getRun(row.id) : null;
  }

  private nextVisit(
    workflow: WorkflowRow,
    graph: WorkflowGraphSnapshot,
    target: WorkflowNodeDefinition,
    tokenKey: string,
    parentIteration: number,
  ): { ok: true; iteration: number } | { ok: false; reason: string } {
    const prior = this.deps.db
      .query<{ visits: number; max_iteration: number | null }, [number, string, string]>(
        `SELECT COUNT(DISTINCT iteration) AS visits, MAX(iteration) AS max_iteration
         FROM issue_workflow_node_runs
         WHERE issue_workflow_id = ? AND node_key = ? AND token_key = ?`,
      )
      .get(workflow.id, target.key, tokenKey)!;
    const iteration = prior.visits > 0 ? Math.max(parentIteration + 1, (prior.max_iteration ?? 0) + 1) : parentIteration;
    if (prior.visits >= target.maxVisits) {
      return { ok: false, reason: `workflow.node_visit_limit:${target.key}` };
    }
    if (iteration > workflow.max_loop_iterations || iteration > graph.maxLoopIterations) {
      return { ok: false, reason: `workflow.loop_limit:${target.key}` };
    }
    return { ok: true, iteration };
  }

  private transitionExists(fromRunId: number, edgeKey: string, iteration: number): boolean {
    return !!this.deps.db
      .query<{ id: number }, [number, string, number]>(
        `SELECT id FROM issue_workflow_transitions
         WHERE from_run_id = ? AND edge_key = ? AND iteration = ?`,
      )
      .get(fromRunId, edgeKey, iteration);
  }

  private recordTransition(
    workflow: WorkflowRow,
    run: IssueWorkflowNodeRun,
    edge: WorkflowEdgeDefinition,
    parallelGroupKey: string | null,
  ): void {
    if (this.transitionExists(run.id, edge.key, run.iteration)) return;
    this.deps.db
      .query(
        `INSERT OR IGNORE INTO issue_workflow_transitions
           (issue_workflow_id, from_run_id, edge_key, to_node_key, decision_text,
            iteration, parallel_group_key, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workflow.id,
        run.id,
        edge.key,
        edge.toNodeKey,
        run.routeReason,
        run.iteration,
        parallelGroupKey,
        this.now(),
      );
    this.deps.logEvent(workflow.issue_id, 'workflow_transition_selected', {
      workflowId: workflow.id,
      runId: run.id,
      edgeKey: edge.key,
      toNodeKey: edge.toNodeKey,
      iteration: run.iteration,
      ...(run.routeReason ? { reason: run.routeReason } : {}),
    });
  }

  private failWorkflow(workflow: WorkflowRow, reason: string): WorkflowTickResult {
    const ts = this.now();
    this.deps.db.transaction(() => {
      this.deps.db
        .query(
          `UPDATE issue_workflows
           SET status = 'failed', pause_reason = ?, updated_ts = ?, completed_ts = ?
           WHERE id = ? AND status IN ('pending', 'running', 'paused')`,
        )
        .run(reason, ts, ts, workflow.id);
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET status = 'blocked', error_code = ?, finished_ts = ?, updated_ts = ?
           WHERE issue_workflow_id = ? AND status IN ('queued', 'running', 'routing', 'waiting_join')`,
        )
        .run(reason, ts, ts, workflow.id);
    })();
    this.deps.logEvent(workflow.issue_id, 'workflow_failed', { workflowId: workflow.id, reason });
    return { state: 'failed', reason };
  }

  private completeWorkflow(workflow: WorkflowRow, endRunId: number): WorkflowTickResult {
    const ts = this.now();
    this.deps.db
      .query(
        `UPDATE issue_workflows
         SET status = 'completed', pause_reason = NULL, updated_ts = ?, completed_ts = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(ts, ts, workflow.id);
    this.deps.logEvent(workflow.issue_id, 'workflow_completed', {
      workflowId: workflow.id,
      endRunId,
    });
    return { state: 'completed' };
  }

  private pauseWorkflow(workflow: WorkflowRow, reason: string): WorkflowTickResult {
    this.deps.db
      .query(
        `UPDATE issue_workflows SET status = 'paused', pause_reason = ?, updated_ts = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(reason, this.now(), workflow.id);
    this.deps.logEvent(workflow.issue_id, 'workflow_paused', { workflowId: workflow.id, reason });
    return { state: 'paused', reason };
  }

  private async advanceJoin(
    workflow: WorkflowRow,
    graph: WorkflowGraphSnapshot,
    target: WorkflowNodeDefinition,
    arriving: IssueWorkflowNodeRun,
    locale: SupportedLocale | undefined,
  ): Promise<WorkflowTickResult> {
    const group = parseGroup(arriving.parallelGroupKey);
    if (!group) return this.failWorkflow(workflow, `workflow.join_group_missing:${target.key}`);
    const forkRun = this.deps.nodes.getRun(group.forkRunId);
    if (!forkRun) return this.failWorkflow(workflow, `workflow.fork_run_missing:${group.forkRunId}`);
    const forkEdges = this.outgoing(graph, forkRun.nodeKey);
    const arrivals = this.deps.db
      .query<{ from_run_id: number }, [number, string, string]>(
        `SELECT DISTINCT t.from_run_id FROM issue_workflow_transitions t
         WHERE t.issue_workflow_id = ? AND t.to_node_key = ? AND t.parallel_group_key = ?
         ORDER BY t.from_run_id`,
      )
      .all(workflow.id, target.key, arriving.parallelGroupKey!)
      .map(({ from_run_id }) => this.deps.nodes.getRun(from_run_id)!)
      .filter(Boolean);
    const arrivedEdges = new Set<string>();
    for (const edge of forkEdges) {
      const prefix = `${group.parentToken}>${edge.key}`;
      if (arrivals.some((run) => run.tokenKey === prefix || run.tokenKey.startsWith(`${prefix}>`))) {
        arrivedEdges.add(edge.key);
      }
    }
    const iteration = Math.max(...arrivals.map((run) => run.iteration), arriving.iteration);
    let joinRun = this.runs(workflow.id).find(
      (run) => run.nodeKey === target.key && run.tokenKey === group.parentToken &&
        run.iteration === iteration && (run.status === 'waiting_join' || run.status === 'succeeded'),
    );
    if (joinRun?.status === 'succeeded') return this.emitSelected(workflow, graph, joinRun, locale);
    if (!joinRun) {
      joinRun = this.insertControlRun({
        workflowId: workflow.id,
        node: target,
        iteration,
        tokenKey: group.parentToken,
        parentRunId: arriving.id,
        predecessorRunIds: arrivals.map((run) => run.id),
        parallelGroupKey: group.parentGroup,
        status: 'waiting_join',
      });
      this.deps.logEvent(workflow.issue_id, 'workflow_join_waiting', {
        workflowId: workflow.id,
        runId: joinRun.id,
        nodeKey: target.key,
        arrived: arrivedEdges.size,
        expected: forkEdges.length,
      });
    } else {
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET predecessor_run_ids_json = ?, updated_ts = ? WHERE id = ? AND status = 'waiting_join'`,
        )
        .run(JSON.stringify(arrivals.map((run) => run.id)), this.now(), joinRun.id);
    }
    if (arrivedEdges.size < forkEdges.length) return { state: 'running' };
    if (this.deps.worktrees) {
      const groupRunIds = this.runs(workflow.id)
        .filter((run) => run.parallelGroupKey === arriving.parallelGroupKey && run.status === 'succeeded')
        .map((run) => run.id);
      const merged = await this.deps.worktrees.mergeAtJoin(workflow.id, groupRunIds, locale);
      if (merged.state === 'running') return { state: 'running' };
      if (merged.state === 'paused') return this.pauseWorkflow(workflow, merged.reason);
    }
    const edges = this.outgoing(graph, target.key);
    if (edges.length !== 1) return this.failWorkflow(workflow, `workflow.join_edge_invalid:${target.key}`);
    const ts = this.now();
    this.deps.db
      .query(
        `UPDATE issue_workflow_node_runs
         SET status = 'succeeded', selected_edge_keys_json = ?, finished_ts = ?, updated_ts = ?
         WHERE id = ? AND status = 'waiting_join'`,
      )
      .run(JSON.stringify([edges[0]!.key]), ts, ts, joinRun.id);
    joinRun = this.deps.nodes.getRun(joinRun.id)!;
    this.deps.logEvent(workflow.issue_id, 'workflow_node_succeeded', {
      workflowId: workflow.id,
      runId: joinRun.id,
      nodeKey: target.key,
      iteration: joinRun.iteration,
    });
    return this.emitSelected(workflow, graph, joinRun, locale);
  }

  private async dispatch(
    workflow: WorkflowRow,
    graph: WorkflowGraphSnapshot,
    from: IssueWorkflowNodeRun,
    edge: WorkflowEdgeDefinition,
    locale: SupportedLocale | undefined,
  ): Promise<WorkflowTickResult> {
    const source = this.node(graph, from.nodeKey);
    const target = this.node(graph, edge.toNodeKey);
    let tokenKey = from.tokenKey;
    let parallelGroupKey = from.parallelGroupKey;
    if (source.kind === 'fork') {
      parallelGroupKey = JSON.stringify({
        forkRunId: from.id,
        parentGroup: from.parallelGroupKey,
        parentToken: from.tokenKey,
      } satisfies ParallelGroup);
      tokenKey = `${from.tokenKey}>${edge.key}`;
    }
    this.recordTransition(workflow, from, edge, parallelGroupKey);
    if (target.kind === 'join') {
      const arriving = { ...from, tokenKey, parallelGroupKey };
      return this.advanceJoin(workflow, graph, target, arriving, locale);
    }
    const existing = this.childOf(from.id, target.key);
    if (existing) return { state: 'running' };
    const visit = this.nextVisit(workflow, graph, target, tokenKey, from.iteration);
    if (!visit.ok) return this.failWorkflow(workflow, visit.reason);
    const predecessorRunIds = this.resultAncestors([from.id]);
    if (target.kind === 'agent') {
      try {
        const started = await this.deps.nodes.start({
          issueWorkflowId: workflow.id,
          nodeKey: target.key,
          iteration: visit.iteration,
          tokenKey,
          parentRunId: from.id,
          parallelGroupKey,
          predecessorRunIds,
          ...(this.deps.worktrees
            ? { prepareRun: (runId: number) => this.deps.worktrees!.prepare(runId) }
            : {}),
          ...(locale ? { locale } : {}),
        });
        this.ownedRuns.add(started.run.id);
        this.deps.logEvent(workflow.issue_id, 'workflow_node_started', {
          workflowId: workflow.id,
          runId: started.run.id,
          nodeKey: target.key,
          attempt: started.run.attempt,
          iteration: started.run.iteration,
          agent: started.run.agent,
        });
      } catch (error) {
        this.deps.logEvent(workflow.issue_id, 'workflow_node_failed', {
          workflowId: workflow.id,
          nodeKey: target.key,
          code: 'workflow.node_start_failed',
          details: String(error).slice(0, 500),
        });
      }
      return { state: 'running' };
    }
    const selected = target.kind === 'fork'
      ? this.outgoing(graph, target.key).map((candidate) => candidate.key)
      : target.kind === 'end'
        ? []
        : this.outgoing(graph, target.key).map((candidate) => candidate.key).slice(0, 1);
    const control = this.insertControlRun({
      workflowId: workflow.id,
      node: target,
      iteration: visit.iteration,
      tokenKey,
      parentRunId: from.id,
      predecessorRunIds,
      parallelGroupKey,
      status: 'succeeded',
      selectedEdgeKeys: selected,
    });
    this.deps.logEvent(workflow.issue_id, 'workflow_node_succeeded', {
      workflowId: workflow.id,
      runId: control.id,
      nodeKey: target.key,
      iteration: control.iteration,
    });
    if (target.kind === 'end') return this.completeWorkflow(workflow, control.id);
    return this.emitSelected(workflow, graph, control, locale);
  }

  private async emitSelected(
    workflow: WorkflowRow,
    graph: WorkflowGraphSnapshot,
    run: IssueWorkflowNodeRun,
    locale: SupportedLocale | undefined,
  ): Promise<WorkflowTickResult> {
    for (const key of run.selectedEdgeKeys) {
      const edge = graph.edges.find((candidate) => candidate.key === key && candidate.fromNodeKey === run.nodeKey);
      if (!edge) return this.failWorkflow(workflow, `workflow.selected_edge_invalid:${key}`);
      const result = await this.dispatch(workflow, graph, run, edge, locale);
      if (result.state !== 'running') return result;
    }
    return { state: 'running' };
  }

  async begin(issueId: number, locale?: SupportedLocale): Promise<WorkflowTickResult | null> {
    const workflow = this.workflowByIssue(issueId);
    if (!workflow) return null;
    const graph = this.graph(workflow);
    if (workflow.status === 'completed') return { state: 'completed' };
    if (workflow.status === 'failed') return { state: 'failed', reason: workflow.pause_reason ?? 'workflow.failed' };
    if (workflow.status === 'paused') {
      this.deps.db
        .query("UPDATE issue_workflows SET status = 'running', pause_reason = NULL, updated_ts = ? WHERE id = ?")
        .run(this.now(), workflow.id);
      const blocked = this.runs(workflow.id).filter((run) => run.status === 'blocked');
      for (const run of blocked) {
        const node = this.node(graph, run.nodeKey);
        if (node.kind !== 'agent') continue;
        try {
          const started = await this.deps.nodes.start({
            issueWorkflowId: workflow.id,
            nodeKey: run.nodeKey,
            iteration: run.iteration,
            tokenKey: run.tokenKey,
            parentRunId: run.parentRunId,
            parallelGroupKey: run.parallelGroupKey,
            predecessorRunIds: run.predecessorRunIds,
            ...(this.deps.worktrees
              ? { prepareRun: (runId: number) => this.deps.worktrees!.prepare(runId) }
              : {}),
            ...(locale ? { locale } : {}),
          });
          this.ownedRuns.add(started.run.id);
          this.deps.logEvent(issueId, 'workflow_node_resumed', {
            workflowId: workflow.id,
            blockedRunId: run.id,
            runId: started.run.id,
            nodeKey: run.nodeKey,
          });
        } catch (error) {
          return this.failWorkflow(workflow, `workflow.node_resume_failed:${String(error).slice(0, 300)}`);
        }
      }
    }
    let root = this.runs(workflow.id).find((run) => run.nodeKey === graph.entryNodeKey && run.parentRunId === null);
    if (!root) {
      const ts = this.now();
      this.deps.db
        .query(
          `UPDATE issue_workflows SET status = 'running', started_ts = COALESCE(started_ts, ?),
                  updated_ts = ?, pause_reason = NULL WHERE id = ?`,
        )
        .run(ts, ts, workflow.id);
      const entry = this.node(graph, graph.entryNodeKey);
      const edges = this.outgoing(graph, entry.key);
      if (edges.length !== 1) return this.failWorkflow(workflow, 'workflow.entry_edge_invalid');
      root = this.insertControlRun({
        workflowId: workflow.id,
        node: entry,
        iteration: 1,
        tokenKey: 'root',
        parentRunId: null,
        predecessorRunIds: [],
        parallelGroupKey: null,
        status: 'succeeded',
        selectedEdgeKeys: [edges[0]!.key],
      });
      this.deps.logEvent(issueId, 'workflow_started', { workflowId: workflow.id, runId: root.id });
      this.deps.logEvent(issueId, 'workflow_node_succeeded', {
        workflowId: workflow.id,
        runId: root.id,
        nodeKey: root.nodeKey,
        iteration: 1,
      });
    }
    return this.emitSelected({ ...workflow, status: 'running' }, graph, root, locale);
  }

  private async retryFailures(
    workflow: WorkflowRow,
    graph: WorkflowGraphSnapshot,
    locale?: SupportedLocale,
  ): Promise<WorkflowTickResult> {
    const runs = this.runs(workflow.id);
    for (const failed of runs.filter((run) => run.status === 'failed')) {
      const siblings = runs.filter(
        (run) => run.nodeKey === failed.nodeKey && run.tokenKey === failed.tokenKey &&
          run.iteration === failed.iteration,
      );
      if (siblings.some((run) => run.id > failed.id)) continue;
      const node = this.node(graph, failed.nodeKey);
      const limit = retryLimit(node);
      if (siblings.length > limit) {
        return this.failWorkflow(workflow, failed.errorCode ?? `workflow.node_failed:${failed.nodeKey}`);
      }
      try {
        const started = await this.deps.nodes.start({
          issueWorkflowId: workflow.id,
          nodeKey: failed.nodeKey,
          iteration: failed.iteration,
          tokenKey: failed.tokenKey,
          parentRunId: failed.parentRunId,
          parallelGroupKey: failed.parallelGroupKey,
          predecessorRunIds: failed.predecessorRunIds,
          ...(this.deps.worktrees
            ? { prepareRun: (runId: number) => this.deps.worktrees!.prepare(runId) }
            : {}),
          ...(locale ? { locale } : {}),
        });
        this.ownedRuns.add(started.run.id);
        this.deps.logEvent(workflow.issue_id, 'workflow_node_retrying', {
          workflowId: workflow.id,
          failedRunId: failed.id,
          runId: started.run.id,
          nodeKey: failed.nodeKey,
          attempt: started.run.attempt,
        });
      } catch (error) {
        this.deps.logEvent(workflow.issue_id, 'workflow_node_failed', {
          workflowId: workflow.id,
          nodeKey: failed.nodeKey,
          code: 'workflow.node_retry_start_failed',
          details: String(error).slice(0, 500),
        });
      }
    }
    return { state: 'running' };
  }

  async tick(issueId: number, locale?: SupportedLocale): Promise<WorkflowTickResult | null> {
    let workflow = this.workflowByIssue(issueId);
    if (!workflow) return null;
    if (workflow.status === 'pending' || workflow.status === 'paused') return this.begin(issueId, locale);
    if (workflow.status === 'completed') return { state: 'completed' };
    if (workflow.status === 'failed') return { state: 'failed', reason: workflow.pause_reason ?? 'workflow.failed' };
    if (workflow.status !== 'running') return { state: 'running' };
    const graph = this.graph(workflow);
    const active = this.runs(workflow.id).filter((run) => run.status === 'running' || run.status === 'routing');
    for (const run of active) {
      if (!this.ownedRuns.has(run.id)) {
        try {
          await this.deps.worktrees?.prepare(run.id);
          await this.deps.nodes.resume(run.id, locale);
          this.ownedRuns.add(run.id);
          this.deps.logEvent(issueId, 'workflow_node_resumed', {
            workflowId: workflow.id,
            runId: run.id,
            nodeKey: run.nodeKey,
          });
        } catch (error) {
          const ts = this.now();
          this.deps.db
            .query(
              `UPDATE issue_workflow_node_runs
               SET status = 'failed', error_code = 'workflow.node_resume_failed', error_details = ?,
                   finished_ts = ?, updated_ts = ? WHERE id = ? AND status IN ('running', 'routing')`,
            )
            .run(String(error).slice(0, 2_000), ts, ts, run.id);
        }
      }
      const before = this.deps.nodes.getRun(run.id);
      if (!before || (before.status !== 'running' && before.status !== 'routing')) continue;
      const collected = await this.deps.nodes.collect(run.id);
      if (collected.state === 'completed') {
        const finalized = await this.deps.worktrees?.finalize(collected.run);
        if (finalized && !finalized.ok) return this.pauseWorkflow(workflow, finalized.reason);
        this.deps.logEvent(issueId, 'workflow_node_succeeded', {
          workflowId: workflow.id,
          runId: collected.run.id,
          nodeKey: collected.run.nodeKey,
          attempt: collected.run.attempt,
          iteration: collected.run.iteration,
          selectedEdgeKeys: collected.run.selectedEdgeKeys,
        });
      } else if (collected.state === 'failed') {
        this.deps.logEvent(issueId, 'workflow_node_failed', {
          workflowId: workflow.id,
          runId: collected.run.id,
          nodeKey: collected.run.nodeKey,
          attempt: collected.run.attempt,
          code: collected.errorCode,
        });
      }
    }
    workflow = this.workflowByIssue(issueId)!;
    for (const run of this.runs(workflow.id).filter((candidate) => candidate.status === 'succeeded')) {
      const finalized = await this.deps.worktrees?.finalize(run);
      if (finalized && !finalized.ok) return this.pauseWorkflow(workflow, finalized.reason);
      const result = await this.emitSelected(workflow, graph, run, locale);
      if (result.state !== 'running') return result;
    }
    await this.deps.worktrees?.cleanupFailed?.(workflow.id);
    const retry = await this.retryFailures(workflow, graph, locale);
    if (retry.state !== 'running') return retry;
    const refreshed = this.workflowByIssue(issueId)!;
    return refreshed.status === 'completed'
      ? { state: 'completed' }
      : refreshed.status === 'failed'
        ? { state: 'failed', reason: refreshed.pause_reason ?? 'workflow.failed' }
        : { state: 'running' };
  }

  pause(issueId: number, reason: string): void {
    const workflow = this.workflowByIssue(issueId);
    if (!workflow || workflow.status !== 'running') return;
    const ts = this.now();
    this.deps.db.transaction(() => {
      this.deps.db
        .query("UPDATE issue_workflows SET status = 'paused', pause_reason = ?, updated_ts = ? WHERE id = ?")
        .run(reason, ts, workflow.id);
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs SET status = 'blocked', error_code = ?, updated_ts = ?
           WHERE issue_workflow_id = ? AND status IN ('queued', 'running', 'routing')`,
        )
        .run(reason, ts, workflow.id);
    })();
    this.deps.logEvent(issueId, 'workflow_paused', { workflowId: workflow.id, reason });
  }

  cancel(issueId: number): void {
    const workflow = this.workflowByIssue(issueId);
    if (!workflow || workflow.status === 'completed' || workflow.status === 'cancelled') return;
    const ts = this.now();
    this.deps.db.transaction(() => {
      this.deps.db
        .query("UPDATE issue_workflows SET status = 'cancelled', updated_ts = ?, completed_ts = ? WHERE id = ?")
        .run(ts, ts, workflow.id);
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs SET status = 'cancelled', finished_ts = ?, updated_ts = ?
           WHERE issue_workflow_id = ? AND status IN ('queued', 'running', 'routing', 'waiting_join', 'blocked')`,
        )
        .run(ts, ts, workflow.id);
    })();
    this.deps.logEvent(issueId, 'workflow_cancelled', { workflowId: workflow.id });
  }
}

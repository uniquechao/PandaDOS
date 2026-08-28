/**
 * 工作流 Agent 节点执行协议。
 *
 * 每次节点进入都创建独立 chat 对话（独立 tmux，仍位于项目 cwd），完整上下文经受控 JSON
 * 文件交给 Agent；短提示只描述读写协议，避免 sendKeys 的 2000 字符预算截断用户原文或知识。
 * Agent 最后写 done，控制面再读取 result.json，严格校验候选连线并持久化自然语言结果。
 */
import type { Database } from 'bun:sqlite';
import { chatTmux } from '../core/conversations';
import { readDriverText } from '../core/skills';
import type {
  AgentKind,
  Conversation,
  IssueWorkflowNodeRun,
  IssueWorkflowSharedContext,
  WorkflowEdgeDefinition,
  WorkflowGraphSnapshot,
  WorkflowNodeDefinition,
} from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { outputLanguageInstruction, promptLanguage } from '../agents/prompts/language';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { KeyedMutex, tmuxLockKey } from './mutex';

export const WORKFLOW_RUN_SCRATCH_BASE = '.panda/tmp/workflows';
export const MAX_WORKFLOW_NODE_OUTPUT_CHARS = 64_000;
export const MAX_WORKFLOW_ROUTE_REASON_CHARS = 4_000;
const MAX_RESULT_BYTES = 256 * 1024;

type WorkflowNodeDriver = Pick<
  ExecutorDriver,
  'writeFile' | 'statPath' | 'readFileRange' | 'sendKeys'
>;

export interface WorkflowNodeConversationOps {
  create(
    projectId: number,
    label: string,
    agent?: AgentKind,
    kind?: 'issue' | 'chat',
  ): Conversation;
  activate(id: string, cwdOverride?: string): Promise<Conversation | null>;
  closeChat?(id: string): Promise<void>;
}

interface WorkflowLookupRow {
  id: number;
  issue_id: number;
  project_id: number;
  cwd: string;
  template_name: string;
  graph_json: string;
  context_json: string;
}

interface NodeRunRow {
  id: number;
  issue_workflow_id: number;
  node_key: string;
  attempt: number;
  iteration: number;
  token_key: string;
  parent_run_id: number | null;
  predecessor_run_ids_json: string | null;
  parallel_group_key: string | null;
  agent: string | null;
  conversation_id: string | null;
  status: string;
  selected_edge_keys_json: string | null;
  output_text: string | null;
  route_reason: string | null;
  error_code: string | null;
  error_details: string | null;
  created_ts: number;
  updated_ts: number;
  started_ts: number | null;
  finished_ts: number | null;
}

export interface WorkflowPreviousResult {
  runId: number;
  nodeKey: string;
  agent: AgentKind | null;
  outputText: string;
  selectedEdgeKeys: string[];
  routeReason: string | null;
}

export interface WorkflowNodeContextFile {
  schemaVersion: 1;
  workflow: {
    id: number;
    issueId: number;
    templateName: string;
  };
  sharedContext: IssueWorkflowSharedContext;
  node: WorkflowNodeDefinition;
  workspace: {
    cwd: string;
    isolatedWorktree: boolean;
  };
  previousResults: WorkflowPreviousResult[];
  candidateEdges: WorkflowEdgeDefinition[];
  resultContract: {
    schemaVersion: 1;
    resultPath: string;
    donePath: string;
    selectedEdgeKeyValues: string[];
    outputMaxChars: number;
    routeReasonMaxChars: number;
  };
}

export interface StartWorkflowNodeInput {
  issueWorkflowId: number;
  nodeKey: string;
  iteration?: number;
  tokenKey: string;
  parentRunId?: number | null;
  parallelGroupKey?: string | null;
  predecessorRunIds?: number[];
  /** run 落库后、Agent 启动前准备隔离目录；返回 null/undefined 表示仍用项目 cwd。 */
  prepareRun?: (runId: number) => Promise<string | null | undefined>;
  locale?: SupportedLocale;
}

export interface StartedWorkflowNode {
  run: IssueWorkflowNodeRun;
  conversation: Conversation;
  session: string;
  contextPath: string;
  resultPath: string;
  donePath: string;
}

export type CollectWorkflowNodeResult =
  | { state: 'pending'; run: IssueWorkflowNodeRun }
  | { state: 'completed'; run: IssueWorkflowNodeRun }
  | { state: 'failed'; run: IssueWorkflowNodeRun; errorCode: string };

export interface WorkflowNodeRunnerDeps {
  db: Database;
  driver: WorkflowNodeDriver;
  conversations: WorkflowNodeConversationOps;
  mutex: KeyedMutex;
  now?: () => number;
}

function runStatus(value: string): IssueWorkflowNodeRun['status'] {
  switch (value) {
    case 'running':
    case 'routing':
    case 'waiting_join':
    case 'succeeded':
    case 'failed':
    case 'blocked':
    case 'cancelled':
    case 'skipped':
      return value;
    default:
      return 'queued';
  }
}

function mapRun(row: NodeRunRow): IssueWorkflowNodeRun {
  let selectedEdgeKeys: string[] = [];
  let predecessorRunIds: number[] = [];
  try {
    const value = JSON.parse(row.selected_edge_keys_json ?? '[]');
    if (Array.isArray(value)) selectedEdgeKeys = value.filter((key): key is string => typeof key === 'string');
  } catch {
    selectedEdgeKeys = [];
  }
  try {
    const value = JSON.parse(row.predecessor_run_ids_json ?? '[]');
    if (Array.isArray(value)) {
      predecessorRunIds = value.filter((id): id is number => Number.isInteger(id) && id > 0);
    }
  } catch {
    predecessorRunIds = [];
  }
  return {
    id: row.id,
    issueWorkflowId: row.issue_workflow_id,
    nodeKey: row.node_key,
    attempt: row.attempt,
    iteration: row.iteration,
    tokenKey: row.token_key,
    parentRunId: row.parent_run_id,
    predecessorRunIds,
    parallelGroupKey: row.parallel_group_key,
    agent: row.agent === 'claude' || row.agent === 'codex' ? row.agent : null,
    conversationId: row.conversation_id,
    status: runStatus(row.status),
    selectedEdgeKeys,
    outputText: row.output_text,
    routeReason: row.route_reason,
    errorCode: row.error_code,
    errorDetails: row.error_details,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    startedTs: row.started_ts,
    finishedTs: row.finished_ts,
  };
}

export function workflowNodePaths(cwd: string, issueWorkflowId: number, runId: number): {
  scratch: string;
  context: string;
  result: string;
  done: string;
  contextRel: string;
  resultRel: string;
  doneRel: string;
} {
  const rel = `${WORKFLOW_RUN_SCRATCH_BASE}/${issueWorkflowId}/runs/${runId}`;
  const base = `${cwd.replace(/\/+$/, '')}/${rel}`;
  return {
    scratch: base,
    context: `${base}/context.json`,
    result: `${base}/result.json`,
    done: `${base}/done`,
    contextRel: `${rel}/context.json`,
    resultRel: `${rel}/result.json`,
    doneRel: `${rel}/done`,
  };
}

export function buildWorkflowNodePrompt(
  agent: AgentKind,
  paths: ReturnType<typeof workflowNodePaths>,
  executionMode: WorkflowNodeDefinition['executionMode'],
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  const readOnly = executionMode === 'read';
  if (promptLanguage(locale) === 'en') {
    return [
      `Execute this workflow node in its independent ${agent === 'codex' ? 'Codex' : 'Claude Code'} conversation.`,
      `Read ${paths.contextRel}; it contains the immutable shared issue context, project knowledge, document paths, node instructions, predecessor results, and candidate edges.`,
      `Read the referenced module and issue process documents when their paths are present. Preserve all quoted user and technical material verbatim.`,
      readOnly
        ? `This is a read-only node: do not modify repository files outside ${paths.scratch}/.`
        : 'This is a write node: make the requested repository changes in the current working tree before reporting the result; do not switch branches or worktrees.',
      `Write ${paths.resultRel} as JSON with exactly {"schemaVersion":1,"output":"natural-language result","selectedEdgeKey":"one exact candidate edge key","routeReason":"why the result satisfies that edge condition"}.`,
      `Do not translate keys, paths, or protocol values. After the JSON file is complete, create ${paths.doneRel} containing ok as the final action.`,
      agent === 'codex' ? 'Proceed without requesting approval.' : '',
      outputLanguageInstruction(locale),
    ].filter(Boolean).join(' ');
  }
  return [
    `在这条独立的 ${agent === 'codex' ? 'Codex' : 'Claude Code'} 对话中执行工作流节点。`,
    `读取 ${paths.contextRel}；其中包含不可变的共享 issue 上下文、项目知识、文档路径、节点指令、前序节点成果和候选连线。`,
    '文档路径存在时读取对应模块文档和 issue 过程页；所有引用的用户原文与技术材料必须逐字保留。',
    readOnly
      ? `这是只读节点：除 ${paths.scratch}/ 下的协议产物外，不要修改仓库文件。`
      : '这是写入节点：先在当前工作树完成要求的仓库改动，再报告结果；不要切换分支或工作树。',
    `把 ${paths.resultRel} 写成 JSON，形状必须严格为 {"schemaVersion":1,"output":"自然语言成果","selectedEdgeKey":"一个候选连线的精确 key","routeReason":"该成果为何满足这条连线条件"}。`,
    `不要翻译字段名、路径或协议值；JSON 完整写入后，最后创建 ${paths.doneRel}，内容写 ok。`,
    agent === 'codex' ? '无需请求审批，直接执行。' : '',
    outputLanguageInstruction(locale),
  ].filter(Boolean).join(' ');
}

export function buildWorkflowNodeResumePrompt(
  agent: AgentKind,
  paths: ReturnType<typeof workflowNodePaths>,
  locale: SupportedLocale = DEFAULT_LOCALE,
): string {
  if (promptLanguage(locale) === 'en') {
    return [
      `Resume workflow node execution from ${paths.contextRel}.`,
      `If work is incomplete, continue it in this same ${agent === 'codex' ? 'Codex' : 'Claude Code'} conversation.`,
      `When complete, ensure ${paths.resultRel} follows the declared JSON contract, then create ${paths.doneRel} containing ok as the final action.`,
      outputLanguageInstruction(locale),
    ].join(' ');
  }
  return [
    `从 ${paths.contextRel} 恢复工作流节点执行。`,
    `若任务尚未完成，请在当前 ${agent === 'codex' ? 'Codex' : 'Claude Code'} 对话中继续。`,
    `完成后确认 ${paths.resultRel} 符合其中声明的 JSON 契约，并在最后创建 ${paths.doneRel}，内容写 ok。`,
    outputLanguageInstruction(locale),
  ].join(' ');
}

type ParsedNodeResult =
  | { ok: true; output: string; selectedEdgeKey: string; routeReason: string }
  | { ok: false; code: string; details: string };

export function parseWorkflowNodeResult(
  raw: string,
  candidateEdges: readonly WorkflowEdgeDefinition[],
): ParsedNodeResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: 'workflow.result_json_invalid', details: String(error) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'workflow.result_schema_invalid', details: 'result must be an object' };
  }
  const row = value as Record<string, unknown>;
  const output = typeof row.output === 'string' ? row.output.trim() : '';
  const selectedEdgeKey = typeof row.selectedEdgeKey === 'string' ? row.selectedEdgeKey.trim() : '';
  const routeReason = typeof row.routeReason === 'string' ? row.routeReason.trim() : '';
  if (row.schemaVersion !== 1 || !output || !selectedEdgeKey || !routeReason) {
    return { ok: false, code: 'workflow.result_schema_invalid', details: 'required result fields are missing' };
  }
  if (output.length > MAX_WORKFLOW_NODE_OUTPUT_CHARS) {
    return { ok: false, code: 'workflow.result_too_large', details: `output exceeds ${MAX_WORKFLOW_NODE_OUTPUT_CHARS} chars` };
  }
  if (routeReason.length > MAX_WORKFLOW_ROUTE_REASON_CHARS) {
    return { ok: false, code: 'workflow.route_reason_too_large', details: `routeReason exceeds ${MAX_WORKFLOW_ROUTE_REASON_CHARS} chars` };
  }
  if (!candidateEdges.some((edge) => edge.key === selectedEdgeKey)) {
    return { ok: false, code: 'workflow.route_invalid', details: `unknown selectedEdgeKey: ${selectedEdgeKey}` };
  }
  return { ok: true, output, selectedEdgeKey, routeReason };
}

export class WorkflowNodeRunner {
  private readonly now: () => number;

  constructor(private readonly deps: WorkflowNodeRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  getRun(runId: number): IssueWorkflowNodeRun | null {
    const row = this.deps.db
      .query<NodeRunRow, [number]>('SELECT * FROM issue_workflow_node_runs WHERE id = ?')
      .get(runId);
    return row ? mapRun(row) : null;
  }

  private lookup(issueWorkflowId: number): {
    row: WorkflowLookupRow;
    graph: WorkflowGraphSnapshot;
    sharedContext: IssueWorkflowSharedContext;
  } {
    const row = this.deps.db
      .query<WorkflowLookupRow, [number]>(
        `SELECT iw.id, iw.issue_id, i.project_id, p.cwd, iw.template_name,
                iw.graph_json, iw.context_json
         FROM issue_workflows iw
         JOIN issues i ON i.id = iw.issue_id
         JOIN projects p ON p.id = i.project_id
         WHERE iw.id = ?`,
      )
      .get(issueWorkflowId);
    if (!row) throw new Error('工作流实例不存在');
    return {
      row,
      graph: JSON.parse(row.graph_json) as WorkflowGraphSnapshot,
      sharedContext: JSON.parse(row.context_json) as IssueWorkflowSharedContext,
    };
  }

  private previousResults(issueWorkflowId: number, runIds: readonly number[]): WorkflowPreviousResult[] {
    const out: WorkflowPreviousResult[] = [];
    for (const runId of [...new Set(runIds)]) {
      const run = this.getRun(runId);
      if (!run || run.issueWorkflowId !== issueWorkflowId || run.status !== 'succeeded' || !run.outputText) {
        throw new Error(`前序节点运行 ${runId} 不可用`);
      }
      out.push({
        runId: run.id,
        nodeKey: run.nodeKey,
        agent: run.agent,
        outputText: run.outputText,
        selectedEdgeKeys: run.selectedEdgeKeys,
        routeReason: run.routeReason,
      });
    }
    return out;
  }

  async start(input: StartWorkflowNodeInput): Promise<StartedWorkflowNode> {
    const { row, graph, sharedContext } = this.lookup(input.issueWorkflowId);
    const node = graph.nodes.find((candidate) => candidate.key === input.nodeKey);
    if (!node || node.kind !== 'agent' || !node.agent) throw new Error('所选节点不是可执行 Agent 节点');
    const agent = node.agent;
    const candidateEdges = graph.edges
      .filter((edge) => edge.fromNodeKey === node.key)
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
    if (!candidateEdges.length) throw new Error('Agent 节点没有候选连线');
    // 调度器会把控制节点压平为最近的 Agent 成果；直接调用方未传显式清单时，
    // 才沿用 parentRunId 作为前序成果，避免把无 output 的 fork/join 控制 run 当成成果读取。
    const predecessorIds = input.predecessorRunIds !== undefined
      ? input.predecessorRunIds
      : input.parentRunId
        ? [input.parentRunId]
        : [];
    const previousResults = this.previousResults(input.issueWorkflowId, predecessorIds);
    const ts = this.now();
    let runId = 0;
    let conversation!: Conversation;
    const prepare = this.deps.db.transaction(() => {
      const attempt = this.deps.db
        .query<{ attempt: number }, [number, string]>(
          `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt
           FROM issue_workflow_node_runs WHERE issue_workflow_id = ? AND node_key = ?`,
        )
        .get(input.issueWorkflowId, node.key)!.attempt;
      const predecessorRunIds = [...new Set(predecessorIds)];
      const inserted = this.deps.db
        .query<{ id: number }, [number, string, number, number, string, number | null, string, string | null, string, number, number]>(
          `INSERT INTO issue_workflow_node_runs
             (issue_workflow_id, node_key, attempt, iteration, token_key, parent_run_id,
              predecessor_run_ids_json, parallel_group_key, agent, status, created_ts, updated_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?) RETURNING id`,
        )
        .get(
          input.issueWorkflowId,
          node.key,
          attempt,
          input.iteration ?? 1,
          input.tokenKey,
          input.parentRunId ?? null,
          JSON.stringify(predecessorRunIds),
          input.parallelGroupKey ?? null,
          agent,
          ts,
          ts,
        )!;
      runId = inserted.id;
      conversation = this.deps.conversations.create(
        row.project_id,
        `workflow:${input.issueWorkflowId}:${node.key}:${attempt}`,
        agent,
        'chat',
      );
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET conversation_id = ?, status = 'running', started_ts = ?, updated_ts = ?
           WHERE id = ?`,
        )
        .run(conversation.id, ts, ts, runId);
    });
    prepare();

    let executionCwd = row.cwd;
    try {
      executionCwd = (await input.prepareRun?.(runId)) ?? row.cwd;
    } catch (error) {
      const failedTs = this.now();
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET status = 'failed', error_code = 'workflow.worktree_prepare_failed', error_details = ?,
               finished_ts = ?, updated_ts = ? WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(String(error).slice(0, 2_000), failedTs, failedTs, runId);
      throw error;
    }
    const paths = workflowNodePaths(executionCwd, input.issueWorkflowId, runId);
    const context: WorkflowNodeContextFile = {
      schemaVersion: 1,
      workflow: { id: row.id, issueId: row.issue_id, templateName: row.template_name },
      sharedContext,
      node,
      workspace: { cwd: executionCwd, isolatedWorktree: executionCwd !== row.cwd },
      previousResults,
      candidateEdges,
      resultContract: {
        schemaVersion: 1,
        resultPath: paths.resultRel,
        donePath: paths.doneRel,
        selectedEdgeKeyValues: candidateEdges.map((edge) => edge.key),
        outputMaxChars: MAX_WORKFLOW_NODE_OUTPUT_CHARS,
        routeReasonMaxChars: MAX_WORKFLOW_ROUTE_REASON_CHARS,
      },
    };
    const session = chatTmux(conversation.id);
    try {
      await this.deps.driver.writeFile(paths.context, JSON.stringify(context, null, 2));
      await this.deps.mutex.runExclusive(tmuxLockKey(session), async () => {
        const active = await this.deps.conversations.activate(conversation.id, executionCwd);
        if (!active) throw new Error('节点对话不存在');
        await this.deps.driver.sendKeys(
          session,
          buildWorkflowNodePrompt(agent, paths, node.executionMode, input.locale),
        );
      });
    } catch (error) {
      const failedTs = this.now();
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET status = 'failed', error_code = 'workflow.node_start_failed', error_details = ?,
               finished_ts = ?, updated_ts = ? WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .run(String(error).slice(0, 2_000), failedTs, failedTs, runId);
      throw error;
    }
    return {
      run: this.getRun(runId)!,
      conversation,
      session,
      contextPath: paths.context,
      resultPath: paths.result,
      donePath: paths.done,
    };
  }

  async collect(runId: number): Promise<CollectWorkflowNodeResult> {
    const run = this.getRun(runId);
    if (!run) throw new Error('节点运行不存在');
    if (run.status === 'succeeded') return { state: 'completed', run };
    if (run.status === 'failed') {
      return { state: 'failed', run, errorCode: run.errorCode ?? 'workflow.node_failed' };
    }
    const { row, graph } = this.lookup(run.issueWorkflowId);
    const node = graph.nodes.find((candidate) => candidate.key === run.nodeKey);
    if (!node) throw new Error('节点定义不存在');
    const candidateEdges = graph.edges.filter((edge) => edge.fromNodeKey === node.key);
    const paths = workflowNodePaths(row.cwd, run.issueWorkflowId, run.id);
    const done = await this.deps.driver.statPath(paths.done).catch(() => null);
    if (!done?.isFile) return { state: 'pending', run };
    const routingTs = this.now();
    this.deps.db
      .query(
        `UPDATE issue_workflow_node_runs SET status = 'routing', updated_ts = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      )
      .run(routingTs, run.id);
    const raw = await readDriverText(this.deps.driver, paths.result, MAX_RESULT_BYTES);
    const parsed = raw === null
      ? { ok: false as const, code: 'workflow.result_missing', details: paths.resultRel }
      : parseWorkflowNodeResult(raw, candidateEdges);
    const ts = this.now();
    if (!parsed.ok) {
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET status = 'failed', error_code = ?, error_details = ?, finished_ts = ?, updated_ts = ?
           WHERE id = ? AND status IN ('queued', 'running', 'routing')`,
        )
        .run(parsed.code, parsed.details.slice(0, 2_000), ts, ts, run.id);
      const failed = this.getRun(run.id)!;
      return { state: 'failed', run: failed, errorCode: parsed.code };
    }
    this.deps.db.transaction(() => {
      this.deps.db
        .query(
          `UPDATE issue_workflow_node_runs
           SET status = 'succeeded', selected_edge_keys_json = ?, output_text = ?, route_reason = ?,
               error_code = NULL, error_details = NULL, finished_ts = ?, updated_ts = ?
           WHERE id = ? AND status IN ('queued', 'running', 'routing')`,
        )
        .run(JSON.stringify([parsed.selectedEdgeKey]), parsed.output, parsed.routeReason, ts, ts, run.id);
    })();
    return { state: 'completed', run: this.getRun(run.id)! };
  }

  /** 服务重启后恢复已登记的独立节点会话；重复提示只要求检查并继续同一协议。 */
  async resume(runId: number, locale: SupportedLocale = DEFAULT_LOCALE): Promise<IssueWorkflowNodeRun> {
    const run = this.getRun(runId);
    if (!run || !run.conversationId || !run.agent) throw new Error('节点运行缺少可恢复对话');
    if (run.status !== 'running' && run.status !== 'routing') return run;
    const { row } = this.lookup(run.issueWorkflowId);
    const worktree = this.deps.db
      .query<{ path: string }, [number]>(
        `SELECT path FROM issue_workflow_worktrees
         WHERE node_run_id = ? AND status IN ('preparing', 'active', 'cleanup_pending')`,
      )
      .get(run.id);
    const executionCwd = worktree?.path ?? row.cwd;
    const paths = workflowNodePaths(executionCwd, run.issueWorkflowId, run.id);
    const session = chatTmux(run.conversationId);
    await this.deps.mutex.runExclusive(tmuxLockKey(session), async () => {
      const active = await this.deps.conversations.activate(run.conversationId!, executionCwd);
      if (!active) throw new Error('节点对话不存在');
      await this.deps.driver.sendKeys(
        session,
        buildWorkflowNodeResumePrompt(run.agent!, paths, locale),
      );
    });
    return this.getRun(run.id)!;
  }
}

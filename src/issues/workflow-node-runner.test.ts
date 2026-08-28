import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import type {
  AgentKind,
  Conversation,
  IssueWorkflowSharedContext,
  WorkflowGraphSnapshot,
} from '../core/types';
import { migrateIssueEngine } from './engine';
import { KeyedMutex } from './mutex';
import {
  parseWorkflowNodeResult,
  WorkflowNodeRunner,
  workflowNodePaths,
  type WorkflowNodeConversationOps,
} from './workflow-node-runner';
import { WorkflowScheduler } from './workflow-scheduler';
import type { WorkflowWorktreeCoordinator } from './workflow-worktrees';
import { validateWorkflowGraph, WorkflowTemplateStore } from './workflows';

class MemoryDriver {
  readonly files = new Map<string, Uint8Array>();
  readonly prompts: Array<{ session: string; text: string }> = [];

  async writeFile(path: string, data: Uint8Array | string) {
    this.files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  async statPath(path: string) {
    const data = this.files.get(path);
    return data
      ? { size: data.length, mtimeMs: 1, isDirectory: false, isFile: true, mode: 0o600 }
      : null;
  }

  async readFileRange(path: string, offset: number, limit: number) {
    const data = this.files.get(path) ?? new Uint8Array();
    return { data: data.slice(offset, offset + limit), size: data.length };
  }

  async sendKeys(session: string, text: string) {
    this.prompts.push({ session, text });
  }

  text(path: string): string {
    return new TextDecoder().decode(this.files.get(path));
  }
}

class FakeConversations implements WorkflowNodeConversationOps {
  readonly rows = new Map<string, Conversation>();
  readonly activated: string[] = [];
  readonly activationCwds: Array<string | undefined> = [];
  private next = 1;

  constructor(private readonly db: ReturnType<typeof openDb>) {}

  create(projectId: number, label: string, agent: AgentKind = 'claude', kind: 'issue' | 'chat' = 'issue') {
    const conversation: Conversation = {
      id: `node-conv-${this.next++}`,
      projectId,
      label,
      createdTs: 1,
      archived: false,
      agent,
      kind,
      lastActiveTs: null,
      autoApprove: 'cautious',
      workspaceCwd: null,
    };
    this.db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(conversation.id, projectId, label, 1, agent, kind);
    this.rows.set(conversation.id, conversation);
    return conversation;
  }

  async activate(id: string, cwd?: string) {
    this.activated.push(id);
    this.activationCwds.push(cwd);
    return this.rows.get(id) ?? null;
  }
}

function graph(): WorkflowGraphSnapshot {
  return {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 5,
    nodes: [
      { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
      { key: 'code', kind: 'agent', title: '实现', instructions: '实现用户需求', agent: 'codex', executionMode: 'write', maxVisits: 2, positionX: 100, positionY: 0, config: null },
      { key: 'review', kind: 'agent', title: '评审', instructions: '评审实现结果', agent: 'claude', executionMode: 'read', maxVisits: 2, positionX: 200, positionY: 0, config: null },
      { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 300, positionY: 0, config: null },
    ],
    edges: [
      { key: 'issue-code', fromNodeKey: 'issue', toNodeKey: 'code', conditionText: null, priority: 0, isDefault: false },
      { key: 'code-review', fromNodeKey: 'code', toNodeKey: 'review', conditionText: '实现已经完成，可以开始评审', priority: 0, isDefault: false },
      { key: 'review-end', fromNodeKey: 'review', toNodeKey: 'end', conditionText: '评审通过', priority: 0, isDefault: false },
    ],
  };
}

function setup(workflowGraph: WorkflowGraphSnapshot = graph()) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'owner', 'x', 'admin', 1)`);
  db.run(
    `INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES (1, 'local', '127.0.0.1', 22, '', '', '/tmp', '')`,
  );
  db.run(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'demo', 1, '/workspace/demo', 1, 1)`,
  );
  db.run(
    `INSERT INTO issues (id, project_id, title, body, category, created_by, created_ts)
     VALUES (33, 1, '用户原始标题', '用户原始正文', 'task', 1, 2)`,
  );
  const validated = validateWorkflowGraph(workflowGraph, ['claude', 'codex']);
  if (!validated.ok) throw new Error('测试工作流无效');
  const store = new WorkflowTemplateStore(db, () => 3);
  const template = store.create({
    projectId: 1,
    name: '实现与评审',
    graph: validated.graph,
    graphJson: validated.graphJson,
    graphHash: validated.graphHash,
  });
  const context: IssueWorkflowSharedContext = {
    schemaVersion: 1,
    issue: { id: 33, title: '用户原始标题', body: '用户原始正文', category: 'task', createdTs: 2 },
    project: {
      id: 1,
      name: 'demo',
      goal: '项目目标',
      readmeSummary: '项目简介',
      understanding: '项目知识原文',
      understandingAgent: 'claude',
      understandingTs: 2,
    },
    module: { id: 5, slug: 'demo-module', displayName: '示例模块', agent: 'codex' },
    documents: {
      module: '.panda/modules/demo-module/MODULE.md',
      issueProcess: '.panda/modules/demo-module/issues/33-issue.md',
    },
  };
  const workflow = store.attachIssue(33, template, context);
  const driver = new MemoryDriver();
  const conversations = new FakeConversations(db);
  let now = 10;
  const runner = new WorkflowNodeRunner({
    db,
    driver,
    conversations,
    mutex: new KeyedMutex(),
    now: () => now++,
  });
  return { db, driver, conversations, runner, workflow };
}

function schedulerFor(
  s: ReturnType<typeof setup>,
  events: string[] = [],
  worktrees?: WorkflowWorktreeCoordinator,
) {
  return new WorkflowScheduler({
    db: s.db,
    nodes: s.runner,
    ...(worktrees ? { worktrees } : {}),
    now: (() => {
      let now = 100;
      return () => now++;
    })(),
    logEvent: (_issueId, kind) => events.push(kind),
  });
}

describe('工作流节点独立会话与结果协议', () => {
  test('Codex 写节点读取完整共享上下文，并持久化自然语言成果和 Agent 路由', async () => {
    const s = setup();
    const started = await s.runner.start({
      issueWorkflowId: s.workflow.id,
      nodeKey: 'code',
      tokenKey: 'root',
      locale: 'zh-Hans',
    });
    expect(started.conversation).toMatchObject({ agent: 'codex', kind: 'chat' });
    expect(started.session).toBe(`chat-${started.conversation.id}`);
    expect(s.conversations.activated).toEqual([started.conversation.id]);
    expect(started.run).toMatchObject({ status: 'running', nodeKey: 'code', attempt: 1, conversationId: started.conversation.id });

    const context = JSON.parse(s.driver.text(started.contextPath));
    expect(context).toMatchObject({
      sharedContext: {
        issue: { title: '用户原始标题', body: '用户原始正文' },
        project: { understanding: '项目知识原文' },
        documents: {
          module: '.panda/modules/demo-module/MODULE.md',
          issueProcess: '.panda/modules/demo-module/issues/33-issue.md',
        },
      },
      node: { key: 'code', instructions: '实现用户需求', agent: 'codex', executionMode: 'write' },
      previousResults: [],
      candidateEdges: [{ key: 'code-review', conditionText: '实现已经完成，可以开始评审' }],
      resultContract: { selectedEdgeKeyValues: ['code-review'] },
    });
    expect(s.driver.prompts[0]).toMatchObject({ session: started.session });
    expect(s.driver.prompts[0]!.text).toContain(started.contextPath.replace('/workspace/demo/', ''));
    expect(s.driver.prompts[0]!.text).toContain('最后创建');
    expect(s.driver.prompts[0]!.text.length).toBeLessThan(2_000);
    expect(await s.runner.collect(started.run.id)).toMatchObject({ state: 'pending' });

    await s.driver.writeFile(started.resultPath, JSON.stringify({
      schemaVersion: 1,
      output: '实现完成，保留这段自然语言成果。',
      selectedEdgeKey: 'code-review',
      routeReason: '实现已经完成，可以开始评审。',
    }));
    await s.driver.writeFile(started.donePath, 'ok');
    const collected = await s.runner.collect(started.run.id);
    expect(collected.state).toBe('completed');
    expect(collected.run).toMatchObject({
      status: 'succeeded',
      outputText: '实现完成，保留这段自然语言成果。',
      selectedEdgeKeys: ['code-review'],
      routeReason: '实现已经完成，可以开始评审。',
    });
  });

  test('Claude Code 评审节点使用另一独立会话并注入前序节点成果', async () => {
    const s = setup();
    const code = await s.runner.start({ issueWorkflowId: s.workflow.id, nodeKey: 'code', tokenKey: 'root' });
    await s.driver.writeFile(code.resultPath, JSON.stringify({
      schemaVersion: 1,
      output: '代码成果原文',
      selectedEdgeKey: 'code-review',
      routeReason: '进入评审',
    }));
    await s.driver.writeFile(code.donePath, 'ok');
    await s.runner.collect(code.run.id);

    const review = await s.runner.start({
      issueWorkflowId: s.workflow.id,
      nodeKey: 'review',
      tokenKey: 'root',
      parentRunId: code.run.id,
      predecessorRunIds: [code.run.id],
      locale: 'en',
    });
    expect(review.conversation).toMatchObject({ agent: 'claude', kind: 'chat' });
    expect(review.conversation.id).not.toBe(code.conversation.id);
    expect(review.session).not.toBe(code.session);
    const context = JSON.parse(s.driver.text(review.contextPath));
    expect(context.previousResults).toEqual([
      expect.objectContaining({ runId: code.run.id, nodeKey: 'code', outputText: '代码成果原文' }),
    ]);
    expect(s.driver.prompts.at(-1)!.text).toContain('This is a read-only node');
    expect(s.driver.prompts.at(-1)!.text).toContain('English (en)');
  });

  test('并行写节点在准备完成的 worktree cwd 启动独立会话', async () => {
    const s = setup();
    const worktree = '/workspace/demo/.worktrees/workflow-1/run-1';
    const started = await s.runner.start({
      issueWorkflowId: s.workflow.id,
      nodeKey: 'code',
      tokenKey: 'root>branch-code',
      parallelGroupKey: '{"forkRunId":1}',
      prepareRun: async () => worktree,
    });
    expect(s.conversations.activationCwds.at(-1)).toBe(worktree);
    expect(started.contextPath.startsWith(`${worktree}/`)).toBe(true);
    expect(JSON.parse(s.driver.text(started.contextPath)).workspace).toEqual({
      cwd: worktree,
      isolatedWorktree: true,
    });
  });

  test('done 后缺失结果或选择非候选连线会以稳定错误码失败', async () => {
    const s = setup();
    const missing = await s.runner.start({ issueWorkflowId: s.workflow.id, nodeKey: 'code', tokenKey: 'a' });
    await s.driver.writeFile(missing.donePath, 'ok');
    const missingResult = await s.runner.collect(missing.run.id);
    expect(missingResult).toMatchObject({ state: 'failed', errorCode: 'workflow.result_missing' });

    const invalid = await s.runner.start({ issueWorkflowId: s.workflow.id, nodeKey: 'code', tokenKey: 'b' });
    await s.driver.writeFile(invalid.resultPath, JSON.stringify({
      schemaVersion: 1,
      output: '完成',
      selectedEdgeKey: 'not-an-edge',
      routeReason: '错误选择',
    }));
    await s.driver.writeFile(invalid.donePath, 'ok');
    const invalidResult = await s.runner.collect(invalid.run.id);
    expect(invalidResult).toMatchObject({ state: 'failed', errorCode: 'workflow.route_invalid' });
    expect(invalidResult.run.errorDetails).toContain('not-an-edge');
  });

  test('结果解析保留自然语言原文并拒绝协议字段缺失', () => {
    const edges = graph().edges.filter((edge) => edge.fromNodeKey === 'review');
    expect(parseWorkflowNodeResult(JSON.stringify({
      schemaVersion: 1,
      output: '原文',
      selectedEdgeKey: 'review-end',
      routeReason: '评审通过',
    }), edges)).toEqual({
      ok: true,
      output: '原文',
      selectedEdgeKey: 'review-end',
      routeReason: '评审通过',
    });
    expect(parseWorkflowNodeResult('{}', edges)).toMatchObject({
      ok: false,
      code: 'workflow.result_schema_invalid',
    });
  });
});

describe('可恢复工作流调度', () => {
  test('服务重启后恢复独立会话并顺序推进，失败节点只重试一次', async () => {
    const s = setup();
    const events: string[] = [];
    const first = schedulerFor(s, events);
    expect(await first.begin(33, 'zh-Hans')).toEqual({ state: 'running' });
    const code1 = s.db.query<{ id: number }, []>(
      "SELECT id FROM issue_workflow_node_runs WHERE node_key = 'code' ORDER BY id DESC LIMIT 1",
    ).get()!;
    const code1Paths = workflowNodePaths('/workspace/demo', s.workflow.id, code1.id);
    await s.driver.writeFile(code1Paths.result, JSON.stringify({
      schemaVersion: 1,
      output: '无效路由触发重试',
      selectedEdgeKey: 'missing',
      routeReason: '测试失败重试',
    }));
    await s.driver.writeFile(code1Paths.done, 'ok');

    const restarted = schedulerFor(s, events);
    expect(await restarted.tick(33, 'zh-Hans')).toEqual({ state: 'running' });
    const codeRuns = s.db.query<{ id: number; attempt: number; status: string }, []>(
      "SELECT id, attempt, status FROM issue_workflow_node_runs WHERE node_key = 'code' ORDER BY id",
    ).all();
    expect(codeRuns).toHaveLength(2);
    expect(codeRuns.map((run) => [run.attempt, run.status])).toEqual([[1, 'failed'], [2, 'running']]);
    expect(events).toContain('workflow_node_resumed');
    expect(events).toContain('workflow_node_retrying');

    const code2Paths = workflowNodePaths('/workspace/demo', s.workflow.id, codeRuns[1]!.id);
    await s.driver.writeFile(code2Paths.result, JSON.stringify({
      schemaVersion: 1,
      output: '实现完成',
      selectedEdgeKey: 'code-review',
      routeReason: '进入评审',
    }));
    await s.driver.writeFile(code2Paths.done, 'ok');
    await restarted.tick(33, 'zh-Hans');
    const review = s.db.query<{ id: number; predecessor_run_ids_json: string }, []>(
      "SELECT id, predecessor_run_ids_json FROM issue_workflow_node_runs WHERE node_key = 'review' ORDER BY id DESC LIMIT 1",
    ).get()!;
    expect(JSON.parse(review.predecessor_run_ids_json)).toEqual([codeRuns[1]!.id]);
    const reviewPaths = workflowNodePaths('/workspace/demo', s.workflow.id, review.id);
    await s.driver.writeFile(reviewPaths.result, JSON.stringify({
      schemaVersion: 1,
      output: '评审通过',
      selectedEdgeKey: 'review-end',
      routeReason: '可以结束',
    }));
    await s.driver.writeFile(reviewPaths.done, 'ok');
    expect(await restarted.tick(33, 'zh-Hans')).toEqual({ state: 'completed' });
  });

  test('并行分支全部到达后只汇合一次，先到分支保持等待', async () => {
    const parallel: WorkflowGraphSnapshot = {
      schemaVersion: 1,
      entryNodeKey: 'issue',
      maxLoopIterations: 5,
      nodes: [
        { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
        { key: 'fork', kind: 'fork', title: '并行', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 1, positionY: 0, config: { joinNodeKey: 'join' } },
        { key: 'a', kind: 'agent', title: 'A', instructions: '执行 A', agent: 'codex', executionMode: 'read', maxVisits: 1, positionX: 2, positionY: -1, config: null },
        { key: 'b', kind: 'agent', title: 'B', instructions: '执行 B', agent: 'claude', executionMode: 'read', maxVisits: 1, positionX: 2, positionY: 1, config: null },
        { key: 'join', kind: 'join', title: '汇合', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 3, positionY: 0, config: null },
        { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 4, positionY: 0, config: null },
      ],
      edges: [
        { key: 'start', fromNodeKey: 'issue', toNodeKey: 'fork', conditionText: null, priority: 0, isDefault: false },
        { key: 'branch-a', fromNodeKey: 'fork', toNodeKey: 'a', conditionText: null, priority: 1, isDefault: false },
        { key: 'branch-b', fromNodeKey: 'fork', toNodeKey: 'b', conditionText: null, priority: 0, isDefault: false },
        { key: 'a-join', fromNodeKey: 'a', toNodeKey: 'join', conditionText: 'A 完成', priority: 0, isDefault: false },
        { key: 'b-join', fromNodeKey: 'b', toNodeKey: 'join', conditionText: 'B 完成', priority: 0, isDefault: false },
        { key: 'finish', fromNodeKey: 'join', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: false },
      ],
    };
    const s = setup(parallel);
    const worktreeCalls = { prepared: [] as number[], finalized: [] as number[], merged: [] as number[][] };
    const worktrees: WorkflowWorktreeCoordinator = {
      async prepare(runId) {
        worktreeCalls.prepared.push(runId);
        return null;
      },
      async finalize(run) {
        if (run.nodeKey === 'a' || run.nodeKey === 'b') worktreeCalls.finalized.push(run.id);
        return { ok: true };
      },
      async mergeAtJoin(_workflowId, runIds) {
        worktreeCalls.merged.push([...runIds]);
        return { state: 'completed' };
      },
    };
    const scheduler = schedulerFor(s, [], worktrees);
    await scheduler.begin(33);
    const runs = s.db.query<{ id: number; node_key: string }, []>(
      "SELECT id, node_key FROM issue_workflow_node_runs WHERE node_key IN ('a', 'b') ORDER BY id",
    ).all();
    expect(worktreeCalls.prepared.sort((a, b) => a - b)).toEqual(runs.map((run) => run.id).sort((a, b) => a - b));
    for (const run of runs) {
      if (run.node_key !== 'a') continue;
      const paths = workflowNodePaths('/workspace/demo', s.workflow.id, run.id);
      await s.driver.writeFile(paths.result, JSON.stringify({ schemaVersion: 1, output: 'A 完成', selectedEdgeKey: 'a-join', routeReason: 'A 完成' }));
      await s.driver.writeFile(paths.done, 'ok');
    }
    expect(await scheduler.tick(33)).toEqual({ state: 'running' });
    expect(s.db.query<{ status: string }, []>("SELECT status FROM issue_workflow_node_runs WHERE node_key = 'join'").get()).toEqual({ status: 'waiting_join' });

    const b = runs.find((run) => run.node_key === 'b')!;
    const bPaths = workflowNodePaths('/workspace/demo', s.workflow.id, b.id);
    await s.driver.writeFile(bPaths.result, JSON.stringify({ schemaVersion: 1, output: 'B 完成', selectedEdgeKey: 'b-join', routeReason: 'B 完成' }));
    await s.driver.writeFile(bPaths.done, 'ok');
    expect(await scheduler.tick(33)).toEqual({ state: 'completed' });
    expect([...new Set(worktreeCalls.finalized)].sort((a, b) => a - b)).toEqual(runs.map((run) => run.id).sort((a, b) => a - b));
    expect(worktreeCalls.merged.at(-1)!.sort((a, b) => a - b)).toEqual(runs.map((run) => run.id).sort((a, b) => a - b));
    expect(s.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM issue_workflow_node_runs WHERE node_key = 'join'").get()!.n).toBe(1);
  });

  test('循环按节点访问上限停止，不会无限重新派发', async () => {
    const loop: WorkflowGraphSnapshot = {
      schemaVersion: 1,
      entryNodeKey: 'issue',
      maxLoopIterations: 2,
      nodes: [
        { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
        { key: 'review', kind: 'agent', title: '循环评审', instructions: '判断是否返工', agent: 'claude', executionMode: 'read', maxVisits: 2, positionX: 1, positionY: 0, config: null },
        { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 2, positionY: 0, config: null },
      ],
      edges: [
        { key: 'start', fromNodeKey: 'issue', toNodeKey: 'review', conditionText: null, priority: 0, isDefault: false },
        { key: 'rework', fromNodeKey: 'review', toNodeKey: 'review', conditionText: '需要返工', priority: 1, isDefault: false },
        { key: 'finish', fromNodeKey: 'review', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: true },
      ],
    };
    const s = setup(loop);
    const scheduler = schedulerFor(s);
    await scheduler.begin(33);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const run = s.db.query<{ id: number }, [number]>(
        "SELECT id FROM issue_workflow_node_runs WHERE node_key = 'review' AND iteration = ? ORDER BY id DESC LIMIT 1",
      ).get(attempt)!;
      const paths = workflowNodePaths('/workspace/demo', s.workflow.id, run.id);
      await s.driver.writeFile(paths.result, JSON.stringify({
        schemaVersion: 1,
        output: `第 ${attempt} 次仍需返工`,
        selectedEdgeKey: 'rework',
        routeReason: '需要返工',
      }));
      await s.driver.writeFile(paths.done, 'ok');
      const result = await scheduler.tick(33);
      if (attempt === 1) expect(result).toEqual({ state: 'running' });
      else expect(result).toEqual({ state: 'failed', reason: 'workflow.node_visit_limit:review' });
    }
    expect(s.db.query<{ status: string; pause_reason: string }, []>(
      'SELECT status, pause_reason FROM issue_workflows WHERE issue_id = 33',
    ).get()).toEqual({ status: 'failed', pause_reason: 'workflow.node_visit_limit:review' });
  });
});

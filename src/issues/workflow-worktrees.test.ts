import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import type { AgentKind, Conversation, IssueWorkflowSharedContext, WorkflowGraphSnapshot } from '../core/types';
import { LocalDriver } from '../executor/local';
import { migrateIssueEngine } from './engine';
import { KeyedMutex } from './mutex';
import { WorkflowNodeRunner, type WorkflowNodeConversationOps } from './workflow-node-runner';
import { validateWorkflowGraph, WorkflowTemplateStore } from './workflows';
import { WorkflowWorktreeManager } from './workflow-worktrees';

class GitTestDriver extends LocalDriver {
  readonly prompts: Array<{ session: string; text: string }> = [];
  override async sendKeys(session: string, text: string) {
    this.prompts.push({ session, text });
  }
}

class FakeConversations implements WorkflowNodeConversationOps {
  readonly rows = new Map<string, Conversation>();
  readonly activations: Array<{ id: string; cwd?: string }> = [];
  private next = 1;

  constructor(private readonly db: ReturnType<typeof openDb>) {}

  create(projectId: number, label: string, agent: AgentKind = 'claude', kind: 'issue' | 'chat' = 'issue') {
    const row: Conversation = {
      id: `worktree-conv-${this.next++}`,
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
    ).run(row.id, projectId, label, 1, agent, kind);
    this.rows.set(row.id, row);
    return row;
  }

  async activate(id: string, cwd?: string) {
    this.activations.push({ id, ...(cwd ? { cwd } : {}) });
    return this.rows.get(id) ?? null;
  }
}

const cleanups: string[] = [];
afterEach(async () => {
  while (cleanups.length) await fsp.rm(cleanups.pop()!, { recursive: true, force: true });
});

function graph(): WorkflowGraphSnapshot {
  return {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 3,
    nodes: [
      { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
      { key: 'fork', kind: 'fork', title: '并行', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 1, positionY: 0, config: { joinNodeKey: 'join' } },
      { key: 'a', kind: 'agent', title: 'A', instructions: '修改 A', agent: 'codex', executionMode: 'write', maxVisits: 1, positionX: 2, positionY: -1, config: null },
      { key: 'b', kind: 'agent', title: 'B', instructions: '修改 B', agent: 'claude', executionMode: 'write', maxVisits: 1, positionX: 2, positionY: 1, config: null },
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
}

async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-worktrees-'));
  cleanups.push(root);
  const repo = path.join(root, 'repo');
  await fsp.mkdir(repo);
  const driver = new GitTestDriver();
  const git = (cwd: string, args: string[]) => driver.git(cwd, args);
  await git(repo, ['init', '-q']);
  await git(repo, ['config', 'user.name', 'Test']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await fsp.writeFile(path.join(repo, 'README.md'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-qm', 'base']);

  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'owner', 'x', 'admin', 1)`);
  db.run(
    `INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES (1, 'local', '127.0.0.1', 22, '', '', '/tmp', '')`,
  );
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'demo', 1, ?, 1, 1)`,
  ).run(repo);
  db.run(
    `INSERT INTO issues (id, project_id, title, body, category, created_by, created_ts)
     VALUES (33, 1, '并行修改', '测试 worktree', 'task', 1, 2)`,
  );
  const validated = validateWorkflowGraph(graph(), ['claude', 'codex']);
  if (!validated.ok) throw new Error('测试工作流无效');
  const templates = new WorkflowTemplateStore(db, () => 3);
  const template = templates.create({
    projectId: 1,
    name: '并行写入',
    graph: validated.graph,
    graphJson: validated.graphJson,
    graphHash: validated.graphHash,
  });
  const context: IssueWorkflowSharedContext = {
    schemaVersion: 1,
    issue: { id: 33, title: '并行修改', body: '测试 worktree', category: 'task', createdTs: 2 },
    project: { id: 1, name: 'demo', goal: null, readmeSummary: null, understanding: null, understandingAgent: null, understandingTs: null },
    module: null,
    documents: { module: null, issueProcess: null },
  };
  const workflow = templates.attachIssue(33, template, context);
  const group = JSON.stringify({ forkRunId: 1, parentGroup: null, parentToken: 'root' });
  const insertRun = (nodeKey: string, finishedTs: number) => db.query<{ id: number }, [number, string, string, string, number, number, number]>(
    `INSERT INTO issue_workflow_node_runs
       (issue_workflow_id, node_key, attempt, iteration, token_key, parallel_group_key,
        status, selected_edge_keys_json, created_ts, updated_ts, finished_ts)
     VALUES (?, ?, 1, 1, ?, ?, 'succeeded', '[]', ?, ?, ?) RETURNING id`,
  ).get(workflow.id, nodeKey, `root>${nodeKey}`, group, finishedTs - 1, finishedTs - 1, finishedTs)!.id;
  const conversations = new FakeConversations(db);
  const events: Array<{ kind: string; data?: Record<string, unknown> }> = [];
  const manager = new WorkflowWorktreeManager({
    db,
    driver,
    conversations,
    mutex: new KeyedMutex(),
    now: (() => { let now = 100; return () => now++; })(),
    logEvent: (_issueId, kind, data) => events.push({ kind, data }),
  });
  const runner = new WorkflowNodeRunner({ db, driver, conversations, mutex: new KeyedMutex() });
  return { root, repo, db, driver, git, workflow, insertRun, conversations, events, manager, runner };
}

async function prepareChange(
  s: Awaited<ReturnType<typeof setup>>,
  nodeKey: string,
  finishedTs: number,
  file: string,
  content: string,
) {
  const runId = s.insertRun(nodeKey, finishedTs);
  const cwd = await s.manager.prepare(runId);
  if (!cwd) throw new Error('未创建 worktree');
  await fsp.writeFile(path.join(cwd, file), content);
  const run = s.runner.getRun(runId)!;
  expect(await s.manager.finalize(run)).toEqual({ ok: true });
  return { runId, cwd, worktree: s.db.query<{ id: number; branch: string }, [number]>(
    'SELECT id, branch FROM issue_workflow_worktrees WHERE node_run_id = ?',
  ).get(runId)! };
}

describe('并行写节点 worktree', () => {
  test('服务在 preparing 阶段重启后可重建缺失 worktree', async () => {
    const s = await setup();
    const runId = s.insertRun('a', 10);
    const head = (await s.git(s.repo, ['rev-parse', 'HEAD'])).out.trim();
    const worktreePath = path.join(s.repo, `.worktrees/workflow-${s.workflow.id}/run-${runId}`);
    const branch = `workflow/33/${runId}-a`;
    s.db.query(
      `INSERT INTO issue_workflow_worktrees
         (issue_workflow_id, node_run_id, path, branch, base_ref, base_sha, status, created_ts, updated_ts)
       VALUES (?, ?, ?, ?, 'master', ?, 'preparing', 1, 1)`,
    ).run(s.workflow.id, runId, worktreePath, branch, head);
    expect(await s.manager.prepare(runId)).toBe(worktreePath);
    expect((await s.git(worktreePath, ['rev-parse', '--is-inside-work-tree'])).out.trim()).toBe('true');
    expect(s.db.query<{ status: string }, [number]>(
      'SELECT status FROM issue_workflow_worktrees WHERE node_run_id = ?',
    ).get(runId)).toEqual({ status: 'active' });
  });

  test('失败 attempt 在重试前清理隔离目录，不触碰可恢复的冲突现场', async () => {
    const s = await setup();
    const failed = await prepareChange(s, 'a', 10, 'failed.txt', '失败尝试\n');
    s.db.query("UPDATE issue_workflow_node_runs SET status = 'failed' WHERE id = ?").run(failed.runId);
    await s.manager.cleanupFailed(s.workflow.id);
    await expect(fsp.stat(failed.cwd)).rejects.toThrow();
    expect(s.db.query<{ status: string }, [number]>(
      'SELECT status FROM issue_workflow_worktrees WHERE node_run_id = ?',
    ).get(failed.runId)).toEqual({ status: 'cleaned' });
    expect(s.events.map((event) => event.kind)).toContain('workflow_worktree_failed_attempt_cleaned');
  });

  test('隔离节点写入并按完成顺序合并，随后删除 worktree 和临时分支', async () => {
    const s = await setup();
    const a = await prepareChange(s, 'a', 30, 'a.txt', 'A\n');
    const b = await prepareChange(s, 'b', 20, 'b.txt', 'B\n');
    expect(a.cwd).not.toBe(b.cwd);
    expect(await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId], 'zh-Hans')).toEqual({ state: 'completed' });
    expect(await fsp.readFile(path.join(s.repo, 'a.txt'), 'utf8')).toBe('A\n');
    expect(await fsp.readFile(path.join(s.repo, 'b.txt'), 'utf8')).toBe('B\n');
    const mergedOrder = s.events.filter((event) => event.kind === 'workflow_worktree_merged')
      .map((event) => event.data?.runId);
    expect(mergedOrder).toEqual([b.runId, a.runId]);
    expect(s.db.query<{ status: string }, []>('SELECT status FROM issue_workflow_worktrees ORDER BY id').all())
      .toEqual([{ status: 'cleaned' }, { status: 'cleaned' }]);
    await expect(fsp.stat(a.cwd)).rejects.toThrow();
    await expect(fsp.stat(b.cwd)).rejects.toThrow();
    expect((await s.git(s.repo, ['branch', '--list', 'workflow/*'])).out.trim()).toBe('');
  });

  test('冲突先交独立 Agent，Agent 安全解决后继续汇合', async () => {
    const s = await setup();
    const a = await prepareChange(s, 'a', 10, 'README.md', 'from A\n');
    const b = await prepareChange(s, 'b', 20, 'README.md', 'from B\n');
    expect(await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId], 'zh-Hans')).toEqual({ state: 'running' });
    const conflict = s.db.query<{ id: number; status: string; resolution_conversation_id: string }, [number]>(
      'SELECT id, status, resolution_conversation_id FROM issue_workflow_worktrees WHERE node_run_id = ?',
    ).get(b.runId)!;
    expect(conflict.status).toBe('resolving');
    expect(s.conversations.activations.at(-1)).toEqual({ id: conflict.resolution_conversation_id, cwd: s.repo });
    expect(s.driver.prompts.at(-1)!.text).toContain('无法安全自动解决时使用 blocked');

    await fsp.writeFile(path.join(s.repo, 'README.md'), 'from A\nfrom B\n');
    await s.git(s.repo, ['add', 'README.md']);
    await s.git(s.repo, ['commit', '--no-edit']);
    const resultDir = path.join(s.repo, `.panda/tmp/workflows/${s.workflow.id}/conflicts/${conflict.id}`);
    await fsp.mkdir(resultDir, { recursive: true });
    await fsp.writeFile(path.join(resultDir, 'result.json'), JSON.stringify({ schemaVersion: 1, status: 'resolved', details: '已保留两侧修改' }));
    await fsp.writeFile(path.join(resultDir, 'done'), 'ok');
    expect(await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId], 'zh-Hans')).toEqual({ state: 'completed' });
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('from A\nfrom B\n');
    expect(s.db.query<{ status: string }, [number]>(
      'SELECT status FROM issue_workflow_worktrees WHERE id = ?',
    ).get(conflict.id)).toEqual({ status: 'cleaned' });
  });

  test('Agent 报告 blocked 时保留诊断并暂停，人工解决后可从同一汇合恢复', async () => {
    const s = await setup();
    const a = await prepareChange(s, 'a', 10, 'README.md', 'left\n');
    const b = await prepareChange(s, 'b', 20, 'README.md', 'right\n');
    await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId]);
    const conflict = s.db.query<{ id: number }, [number]>(
      'SELECT id FROM issue_workflow_worktrees WHERE node_run_id = ?',
    ).get(b.runId)!;
    const resultDir = path.join(s.repo, `.panda/tmp/workflows/${s.workflow.id}/conflicts/${conflict.id}`);
    await fsp.mkdir(resultDir, { recursive: true });
    await fsp.writeFile(path.join(resultDir, 'result.json'), JSON.stringify({ schemaVersion: 1, status: 'blocked', details: '需要人工确认业务语义' }));
    await fsp.writeFile(path.join(resultDir, 'done'), 'ok');
    expect(await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId])).toEqual({ state: 'paused', reason: '需要人工确认业务语义' });
    expect(s.db.query<{ status: string; conflict_details: string }, [number]>(
      'SELECT status, conflict_details FROM issue_workflow_worktrees WHERE id = ?',
    ).get(conflict.id)).toEqual({ status: 'paused', conflict_details: '需要人工确认业务语义' });

    await fsp.writeFile(path.join(s.repo, 'README.md'), '人工确认后的内容\n');
    await s.git(s.repo, ['add', 'README.md']);
    await s.git(s.repo, ['commit', '--no-edit']);
    expect(await s.manager.mergeAtJoin(s.workflow.id, [a.runId, b.runId])).toEqual({ state: 'completed' });
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('人工确认后的内容\n');
  });
});

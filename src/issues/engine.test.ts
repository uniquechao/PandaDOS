import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { ConversationManager } from '../core/conversations';
import { LocalDriver } from '../executor/local';
import type { CommandResult } from '../executor/driver';
import { gitLockKey, KeyedMutex, tmuxLockKey } from './mutex';
import { ModuleManager, ModuleStore } from './modules';
import { MAX_TEST_FAILURES, transition } from './machine';
import { BUSY_STATES, moduleKeyOf } from './queue';
import type { Project, ProjectModule, WorkflowGraphSnapshot } from '../core/types';
import { migrateDesigns } from '../designs/store';
import {
  DEFAULT_ENGINE_CONFIG,
  getProject,
  formatClarifyAppend,
  IssueEngine,
  MAX_AGENT_RESTARTS,
  migrateIssueEngine,
  parseValidationCommands,
  demoteAgentlessResume,
  parseValidationScope,
  type EngineClarifyInput,
  type EngineClarifyResult,
  type EngineConfig,
  type EngineNotifyEvent,
  type EngineDoneJudgement,
  type EngineMergeCandidate,
  type EngineMergeGroup,
  type EngineDeps,
  type EngineIssue,
  type DesignIssueDraft,
  type IssueExecutionSync,
  type IssueExecutionSyncEffectContext,
  type PreparedDesignBatch,
} from './engine';
import { workflowNodePaths } from './workflow-node-runner';
import { validateWorkflowGraph, WorkflowTemplateStore } from './workflows';

// ---------- 假 Driver：文件/git 走真 fs（LocalDriver），tmux 进内存录制 ----------

class FakeDriver extends LocalDriver {
  tmuxSessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  keys: Array<{ session: string; key: string }> = [];
  executables = new Map([
    ['claude', 'claude'],
    ['codex', 'codex'],
  ]);
  pane = '';
  /** 每会话的 #{pane_current_command}（不设 = 老实现/解析失败，判活退化成只看屏） */
  paneCommands = new Map<string, string>();
  gitCalls: Array<{ cwd: string; args: string[] }> = [];
  managedUpstream: 'missing' | 'present' | null = null;
  failCommit: string | null = null;
  pretendCommitSuccess = false;
  onGit: ((cwd: string, args: string[]) => void | Promise<void>) | null = null;
  override async git(cwd: string, args: string[]) {
    this.gitCalls.push({ cwd, args: [...args] });
    await this.onGit?.(cwd, args);
    if (args[0] === 'commit' && this.failCommit) {
      return { code: 128, out: '', err: this.failCommit };
    }
    if (args[0] === 'commit' && this.pretendCommitSuccess) {
      return { code: 0, out: '', err: '' };
    }
    if (this.managedUpstream && args.join('\0') === 'rev-parse\0--symbolic-full-name\0@{upstream}') {
      return this.managedUpstream === 'present'
        ? { code: 0, out: 'refs/remotes/origin/codex/design-1-1\n', err: '' }
        : { code: 128, out: '', err: 'no upstream' };
    }
    // managedUpstream 即「这个 worktree 背后有托管远端」的开关：origin 预检也要跟着成立
    if (this.managedUpstream && args.join('\0') === 'remote\0get-url\0origin') {
      return { code: 0, out: 'git@example.com:managed/design.git\n', err: '' };
    }
    if (this.managedUpstream && args[0] === 'push') return { code: 0, out: '', err: '' };
    return super.git(cwd, args);
  }
  /** 门禁执行（#279）：记账 + 可编排结果；不设 onRunCommand 则真跑（临时仓库里通常没门禁命令） */
  runCalls: Array<{ cwd: string; argv: string[]; timeoutMs: number }> = [];
  onRunCommand: ((argv: string[]) => Partial<CommandResult> | null) | null = null;
  override async runCommand(cwd: string, argv: string[], timeoutMs: number) {
    this.runCalls.push({ cwd, argv: [...argv], timeoutMs });
    const planned = this.onRunCommand?.(argv);
    if (planned) {
      return { code: 0, out: '', err: '', timedOut: false, durationMs: 1, ...planned };
    }
    return super.runCommand(cwd, argv, timeoutMs);
  }
  /** listSessions 调用次数（issue #97：健康路径必须零额外 tmux 调用） */
  listCalls = 0;
  override async findExecutable(agent: 'claude' | 'codex') {
    return this.executables.get(agent) ?? null;
  }
  override async listSessions() {
    this.listCalls++;
    return [...this.tmuxSessions].map((name) => {
      const command = this.paneCommands.get(name);
      return { name, createdTs: 0, attached: false, ...(command ? { command } : {}) };
    });
  }
  override async createSession(name: string, _cwd: string) {
    this.tmuxSessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.tmuxSessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  override async sendKey(session: string, key: string) {
    this.keys.push({ session, key });
  }
  override async capturePane(_session: string) {
    return this.pane;
  }
  prompts(): string[] {
    return this.sent.map((s) => s.text).filter((t) => !t.startsWith('claude '));
  }
}

// ---------- jsonl 帮手 ----------

function asst(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
}
function userText(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------- 环境 ----------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('issue 引擎迁移', () => {
  test('036 为存量 issue 增加 nullable 目标分支/源 ref，重复迁移幂等', () => {
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const owner = users.create('migration-owner');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', '', '/workspace', '/claude')`,
    );
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('demo', 1, '/workspace/demo', ?, 1)`,
    ).run(owner.user.id);
    db.run(`INSERT INTO issues (project_id, title, created_ts) VALUES (1, 'legacy', 1)`);

    const first = migrateIssueEngine(db);
    const second = migrateIssueEngine(db);
    expect(first.applied.filter((id) => id >= 30 && id < 40)).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37, 38, 39,
    ]);
    expect(second).toEqual(first);
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(issues)')
      .all()
      .map((c) => c.name);
    expect(columns).toContain('target_branch');
    expect(columns).toContain('source_ref');
    expect(
      db.query<{ target_branch: string | null; source_ref: string | null }, []>(
        `SELECT target_branch, source_ref FROM issues WHERE title = 'legacy'`,
      ).get(),
    ).toEqual({ target_branch: null, source_ref: null });
    db.close();
  });
});

async function setup(opts: {
  clarify?: (project: Project, input: EngineClarifyInput) => Promise<EngineClarifyResult>;
  organize?: EngineDeps['organize'];
  config?: Partial<EngineConfig>;
  modulesFor?: EngineDeps['modulesFor'];
  onNotify?: (event: EngineNotifyEvent) => void | Promise<void>;
  executionWorkspaces?: EngineDeps['executionWorkspaces'];
  flushProjectData?: EngineDeps['flushProjectData'];
} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-engine-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));

  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db); // 030：module/impl_mode 列 + project_active_conv
  if (opts.executionWorkspaces) migrateDesigns(db);
  const users = new UserStore(db);
  const { user: admin } = users.create('admin', 'admin');
  users.putSettings(admin.id, { locale: 'zh-Hans' }); // legacy prompt assertions in this suite
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );

  // 真 git 仓库（分支流要真验证）
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  const driver = new FakeDriver();
  const g = (args: string[]) => driver.git(repo, args);
  await g(['init']);
  await g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await g(['config', 'user.email', 't@t']);
  await g(['config', 'user.name', 't']);
  await fsp.writeFile(path.join(repo, 'README.md'), 'hello\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);

  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
     VALUES (?, 1, ?, ?, ?, ?)`,
  ).run('demo', repo, admin.id, '演示项目', Date.now());
  const projectId = 1;
  // 测试基线用「手动确认」模式（保留卡点老流程的既有用例）；自动流单测用 setManualReview(false)
  const setManualReview = (on: boolean) =>
    db.query('UPDATE projects SET manual_review = ? WHERE id = ?').run(on ? 1 : 0, projectId);
  setManualReview(true);

  const jsonl = new Map<string, string>();
  const locator = {
    /** 测试钩子：reclaim 命中的新 jsonl 路径（null = 无候选，reclaim 落空） */
    reclaimTo: null as string | null,
    reclaimCalls: 0,
    async locate(id: string) {
      const p = jsonl.get(id);
      if (!p) return null;
      try {
        await fsp.stat(p);
        return p;
      } catch {
        return null;
      }
    },
    async reclaim(id: string) {
      locator.reclaimCalls++;
      if (!locator.reclaimTo) return null;
      jsonl.set(id, locator.reclaimTo); // 模拟真 locator 的重绑回填
      return locator.reclaimTo;
    },
  };
  const convs = new ConversationManager(db, driver, locator);

  const pm = {
    questions: null as string[] | null,
    judgement: 'not_done' as EngineDoneJudgement,
    judgeCalls: 0,
    failureJudgement: 'ordinary_exit' as 'resume_conflict' | 'ordinary_exit' | 'unknown',
    failureCalls: 0,
    /** 测试注入的合并计划：id 组 → 合并后 title/body（默认不合并） */
    merges: [] as EngineMergeGroup[],
    mergeCalls: [] as Array<{ module: string; ids: number[] }>,
    async judgeDone() {
      pm.judgeCalls++;
      return pm.judgement;
    },
    async judgeAgentFailure() {
      pm.failureCalls++;
      return pm.failureJudgement;
    },
    async generateClarifyingQuestions() {
      return pm.questions;
    },
    async mergeModuleTasks(module: string, candidates: EngineMergeCandidate[]): Promise<EngineMergeGroup[]> {
      pm.mergeCalls.push({ module, ids: candidates.map((c) => c.id) });
      // 只回给定候选里都存在的合并组（模拟 LLM 保守）
      const ids = new Set(candidates.map((c) => c.id));
      return pm.merges.filter((g) => g.members.every((m) => ids.has(m)));
    },
  };

  const notifications: EngineNotifyEvent[] = [];
  const notify = {
    async dispatch(e: EngineNotifyEvent) {
      notifications.push(e);
      await opts.onNotify?.(e);
    },
  };

  let fakeNow = Date.now();
  const clock = {
    now: () => fakeNow,
    advance(ms: number) {
      fakeNow += ms;
    },
  };

  const mutex = new KeyedMutex();
  const engine = new IssueEngine({
    db,
    driver,
    convs,
    locator,
    ...(opts.executionWorkspaces ? { executionWorkspaces: opts.executionWorkspaces } : {}),
    pmFor: () => pm,
    notify,
    mutex,
    ...(opts.flushProjectData ? { flushProjectData: opts.flushProjectData } : {}),
    ...(opts.modulesFor ? { modulesFor: opts.modulesFor } : {}),
    ...(opts.clarify ? { clarify: opts.clarify } : {}),
    ...(opts.organize ? { organize: opts.organize } : {}),
    // 收尾摘要默认关（#275 之后不再轮询，但开着会连带启用「完成度门禁」——
    // 绝大多数用例并不产出结构化报告，开着会把它们全挡在 done 之外；专项测试经 opts.config 显式开）
    config: { directExecution: false, kickoffMinBootMs: 0, now: clock.now, resultSummaryTimeoutMs: 0, ...(opts.config ?? {}) },
  });

  /** 给 issue 的 conv 建 jsonl 并登记 */
  async function bindJsonl(issueId: number): Promise<string> {
    const convId = engine.store.get(issueId)!.convId!;
    const p = path.join(dir, `${convId}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(convId, p);
    return p;
  }
  async function appendOutput(jsonlPath: string, ...lines: string[]) {
    await fsp.appendFile(jsonlPath, lines.map((l) => l + '\n').join(''));
  }

  return { dir, db, users, admin, repo, driver, convs, jsonl, locator, pm, notifications, clock, engine, mutex, projectId, setManualReview, bindJsonl, appendOutput, g };
}

describe('design execution workspace port', () => {
  test('managed issues reuse a run/module conversation without mutating the permanent module binding', async () => {
    let workspace = '';
    let healthy = true;
    let convsRef: ConversationManager;
    const byModule = new Map<string, ReturnType<ConversationManager['createInWorkspace']>>();
    const executionWorkspaces: NonNullable<EngineDeps['executionWorkspaces']> = {
      resolve: () => {
        if (!healthy) throw new Error('WORKTREE_UNHEALTHY');
        return { cwd: workspace, kind: 'design-worktree', branch: 'codex/design-1-1', runId: 'run-1' };
      },
      conversationFor: async (issue, resolved) => {
        const key = `${resolved.runId}:module:${issue.moduleId ?? 'none'}`;
        let conv = byModule.get(key);
        if (!conv) {
          conv = convsRef.createInWorkspace(issue.projectId, key, issue.agent, resolved.cwd);
          byModule.set(key, conv);
        }
        return conv;
      },
    };
    const s = await setup({ executionWorkspaces });
    convsRef = s.convs;
    workspace = path.join(s.dir, 'design-worktree');
    expect((await s.driver.git(s.repo, [
      'worktree', 'add', '--no-track', '-b', 'codex/design-1-1', workspace, 'HEAD',
    ])).code).toBe(0);
    const permanent = s.convs.create(s.projectId, 'permanent module', 'claude');
    s.db.query(`INSERT INTO project_modules
      (project_id, slug, display_name, agent, source, status, conversation_id, created_ts)
      VALUES (1, 'design-module', 'Design module', 'claude', 'manual', 'active', ?, 1)`)
      .run(permanent.id);

    const first = await s.engine.createIssue(s.projectId, {
      title: 'worktree first', moduleId: 1,
    }, false);
    expect((await s.engine.startIssue(first.id)).ok).toBe(true);
    const bound = s.engine.store.get(first.id)!;
    expect(bound.convId).not.toBe(permanent.id);
    expect(s.convs.get(bound.convId!)?.workspaceCwd).toBe(workspace);
    expect(s.db.query<{ conversation_id: string }, []>(
      'SELECT conversation_id FROM project_modules WHERE id = 1',
    ).get()?.conversation_id).toBe(permanent.id);
    expect(s.driver.gitCalls.filter((call) => call.args[0] === 'checkout')).toEqual([]);
    expect(s.driver.gitCalls.some((call) => call.cwd === workspace && call.args[0] === 'symbolic-ref')).toBe(true);

    const finish = async (issueId: number) => {
      expect((await s.engine.applyEvent(issueId, 'plan_ready')).ok).toBe(true);
      expect(s.engine.store.get(issueId)?.status).toBe('implementing');
      expect((await s.engine.applyEvent(issueId, 'impl_done')).ok).toBe(true);
      expect((await s.engine.applyEvent(issueId, 'tests_passed')).ok).toBe(true);
    };
    s.setManualReview(false);
    s.driver.managedUpstream = 'missing';
    await finish(first.id);
    expect(s.driver.gitCalls.some((call) => call.cwd === workspace && call.args.join('\0')
      === 'push\0--set-upstream\0origin\0HEAD')).toBe(true);

    const second = await s.engine.createIssue(s.projectId, {
      title: 'worktree second', moduleId: 1,
    }, false);
    expect((await s.engine.startIssue(second.id)).ok).toBe(true);
    expect(s.engine.store.get(second.id)?.convId).toBe(bound.convId);
    s.driver.managedUpstream = 'present';
    await finish(second.id);
    expect(s.driver.gitCalls.some((call) => call.cwd === workspace && call.args.join('\0')
      === 'push\0origin\0HEAD')).toBe(true);

    healthy = false;
    const blocked = await s.engine.createIssue(s.projectId, { title: 'unhealthy' }, false);
    const before = s.driver.gitCalls.length;
    expect(await s.engine.startIssue(blocked.id)).toMatchObject({ ok: false });
    expect(s.engine.store.get(blocked.id)?.convId).toBeNull();
    expect(s.driver.gitCalls).toHaveLength(before);
  });
});

describe('工作流 issue 生命周期接线', () => {
  test('无需原 issue 对话即可推进，并保持现有 merge_review 卡点', async () => {
    const s = await setup();
    const graph: WorkflowGraphSnapshot = {
      schemaVersion: 1,
      entryNodeKey: 'issue',
      maxLoopIterations: 3,
      nodes: [
        { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
        { key: 'code', kind: 'agent', title: '实现', instructions: '完成实现', agent: 'codex', executionMode: 'write', maxVisits: 1, positionX: 1, positionY: 0, config: null },
        { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 2, positionY: 0, config: null },
      ],
      edges: [
        { key: 'start', fromNodeKey: 'issue', toNodeKey: 'code', conditionText: null, priority: 0, isDefault: false },
        { key: 'finish', fromNodeKey: 'code', toNodeKey: 'end', conditionText: '实现完成', priority: 0, isDefault: false },
      ],
    };
    const validated = validateWorkflowGraph(graph, ['claude', 'codex']);
    if (!validated.ok) throw new Error('测试工作流无效');
    const template = new WorkflowTemplateStore(s.db).create({
      projectId: s.projectId,
      name: '单节点工作流',
      graph: validated.graph,
      graphJson: validated.graphJson,
      graphHash: validated.graphHash,
    });
    const issue = await s.engine.createIssue(s.projectId, {
      title: '工作流任务',
      body: '按节点执行',
      createdBy: s.admin.id,
      workflowTemplateId: template.template.id,
    });
    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'implementing', convId: null });
    expect(s.engine.store.listDriving().map((row) => row.id)).toContain(issue.id);
    const workflow = s.engine.workflowSnapshot(issue.id)!;
    const run = s.db.query<{ id: number }, [number]>(
      "SELECT id FROM issue_workflow_node_runs WHERE issue_workflow_id = ? AND node_key = 'code'",
    ).get(workflow.id)!;
    const paths = workflowNodePaths(s.repo, workflow.id, run.id);
    await fsp.writeFile(paths.result, JSON.stringify({
      schemaVersion: 1,
      output: '实现完成',
      selectedEdgeKey: 'finish',
      routeReason: '实现完成',
    }));
    await fsp.writeFile(paths.done, 'ok');
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('merge_review');
    expect(s.engine.store.listGates(issue.id).map((gate) => gate.kind)).toEqual(['merge_review']);
    expect(s.engine.store.listEvents(issue.id).map((event) => event.kind)).toContain('workflow_completed');

    s.db.query("UPDATE issues SET status = 'testing' WHERE id = ?").run(issue.id);
    s.db.query("UPDATE issue_workflows SET status = 'failed' WHERE issue_id = ?").run(issue.id);
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    s.db.query("UPDATE issue_workflows SET status = 'paused' WHERE issue_id = ?").run(issue.id);
    const queued = await s.engine.createIssue(s.projectId, { title: '必须等待冲突恢复' }, false);
    expect(await s.engine.startIssue(queued.id)).toEqual({
      ok: false,
      error: '项目忙（已有 issue 在跑），先排队',
      deferral: 'project-busy', // #283：正常排队，不是故障
    });
  });
});

// ---------- 全链路 ----------

describe('引擎全链路：pending→planning→卡点①→implementing→testing→卡点②→merging→done', () => {
  test('主干快乐路径（含 git 分支流 / gate / 队列接力 / kickoff 幂等）', async () => {
    const s = await setup();
    const { engine, driver, notifications } = s;

    // 建 issue（task，PM 判不含糊 → 跳过 clarifying 直进 planning）
    const issue = await engine.createIssue(s.projectId, {
      title: '加导出功能',
      body: '支持 CSV',
      module: 'export',
      createdBy: s.admin.id,
    });
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.get(issue.id)!.convId).toBeTruthy();
    // 对话被激活：claude --session-id 已注入
    expect(driver.sent.some((x) => x.text.startsWith('claude --session-id'))).toBe(true);

    const jl = await s.bindJsonl(issue.id);

    // tick → kickoff planning prompt（幂等：第二次 tick 不重发）
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
    const sentAfterKick = driver.sent.length;
    await engine.tick();
    expect(driver.sent.length).toBe(sentAfterKick);

    // 引擎重启（同 DB 新实例）也不重发 —— 判据在 issue_events
    const engine2 = new IssueEngine({
      db: s.db,
      driver,
      convs: s.convs,
      locator: { locate: (id) => s.jsonl.get(id) ? Promise.resolve(s.jsonl.get(id)!) : Promise.resolve(null) },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
    });
    await engine2.tick();
    expect(driver.sent.length).toBe(sentAfterKick);

    // CC 输出计划块 → plan_review + 卡点①
    await s.appendOutput(jl, asst('拆解：\nSUBTASKS_BEGIN\n1. 写导出器\n2. 加测试\nSUBTASKS_END'));
    await engine.tick();
    let cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('plan_review');
    expect(engine.store.subtasksOf(cur).map((x) => x.text)).toEqual(['写导出器', '加测试']);
    const gates = engine.store.listGates(issue.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.kind).toBe('plan');
    expect(gates[0]!.status).toBe('waiting');
    expect(notifications.some((n) => n.kind === 'gate_waiting')).toBe(true);

    // 卡点① approve → implementing。引擎不建/不切分支：只记下开发者当前所在分支（此仓库在 main）
    const r1 = await engine.decideGate(gates[0]!.id, s.admin.id, 'approve');
    expect(r1.ok).toBe(true);
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('implementing');
    expect(cur.branch).toBe('main');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe(''); // 绝不建 issue/<id>

    // 同一卡点不能二次决定（waiting→decided CAS 防重放）
    expect((await engine.decideGate(gates[0]!.id, s.admin.id, 'approve')).ok).toBe(false);

    // tick → 喂子任务 1
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes('【实施 子任务 1/2】') && t.includes(`SUBTASK_DONE:${issue.id}`))).toBe(true);

    // 分支上做点真实改动（merge 才有内容）
    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: export']);

    // 同一批两个 SUBTASK_DONE（v1 布尔丢 DONE 的修复验证）→ 全部完成 → testing
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}\n继续\nSUBTASK_DONE:${issue.id}`));
    await engine.tick();
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('testing');
    expect(cur.subIndex).toBe(2);

    // tick → testing prompt
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes(`STAGE_DONE:${issue.id}:testing`))).toBe(true);

    // 错 id / 错 stage / tool_result 里的哨兵全都不推进
    await s.appendOutput(
      jl,
      asst(`STAGE_DONE:999:testing`),
      asst(`STAGE_DONE:${issue.id}:implementing`),
      toolResult(`STAGE_DONE:${issue.id}:testing`),
      asst(`我完成后会输出 STAGE_DONE:${issue.id}:testing 这行`),
    );
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');

    // 排队第二条 issue：项目忙 → 保持 pending
    const issue2 = await engine.createIssue(s.projectId, { title: '修样式', module: 'export' });
    expect(engine.store.get(issue2.id)!.status).toBe('pending');

    // 正确哨兵 → merge_review + 卡点②（payload 带 diff / 本 issue 的 commit ids）
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('merge_review');
    const gate2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(gate2.payloadJson!) as {
      diff: string; branch: string; base: string; commits?: Array<{ subject: string }>;
    };
    expect(payload.branch).toBe('main'); // 改动就落在开发者的分支上（此处 main）
    expect(payload.diff).toContain('export.ts');
    expect(payload.commits!.some((c) => c.subject.includes('feat: export'))).toBe(true);

    // 卡点② approve → merging（引擎不做本地合并，直接放行）→ done + done_ts + 通知 + 接力 issue2
    const r2 = await engine.decideGate(gate2.id, s.admin.id, 'approve');
    expect(r2.ok).toBe(true);
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('done');
    expect(cur.doneTs).toBeGreaterThan(0);
    expect(notifications.some((n) => n.kind === 'issue_done' && n.issueId === issue.id)).toBe(true);
    // 改动就在 main 上（直接提交，无本地 merge 提交）；仍停在 main，不建 issue 分支
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.stat(path.join(s.repo, 'export.ts')).then(() => true, () => false)).toBe(true);
    expect((await s.g(['log', '--oneline', '-1'])).out).toContain('feat: export');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
    // 队列接力：issue2 自动开跑
    expect(engine.store.get(issue2.id)!.status).toBe('planning');

    // 全量时间线落了关键事件
    const kinds = engine.store.listEvents(issue.id).map((e) => e.kind);
    for (const k of ['created', 'transition', 'injected', 'sentinel', 'subtask_done', 'gate_created', 'gate_decided']) {
      expect(kinds).toContain(k);
    }
  }, 30000);
});

describe('卡点 reject 回退', () => {
  test('卡点① reject（带意见）→ 回 planning，重排 prompt 带意见', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 A' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    expect((await engine.applyEvent(issue.id, 'plan_ready')).ok).toBe(true);
    const gate = engine.store.listGates(issue.id)[0]!;

    // reject 必须带意见
    expect((await engine.decideGate(gate.id, s.admin.id, 'reject')).ok).toBe(false);
    const r = await engine.decideGate(gate.id, s.admin.id, 'reject', '第 2 步拆太粗');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 回炉 kickoff：planning prompt 带驳回意见
    await engine.tick();
    const rework = s.driver.prompts().filter((t) => t.includes('驳回'));
    expect(rework.length).toBe(1);
    expect(rework[0]).toContain('第 2 步拆太粗');
  });

  test('卡点② reject → 回 implementing，返工 prompt 带 review 意见', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 B' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    await engine.applyEvent(issue.id, 'tests_passed');
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');
    const gate = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const r = await engine.decideGate(gate.id, s.admin.id, 'reject', '命名不符合规范');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    await engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('【返工】') && t.includes('命名不符合规范'))).toBe(true);
  });
});

describe('testing 失败回退计数（≤3 回 implementing，超限 blocked）', () => {
  test('TESTS_FAILED ×4 → 第 4 次 blocked（failCount 从 issue_events 数）', async () => {
    // #274：默认阈值下止损闸的「同阶段重入 ≥3」会在第 3 次失败就先接管（两者都终于 blocked，
    // 只是报的原因不同）。本例考的是 MAX_TEST_FAILURES 这条计数，所以把止损阈值调高让开。
    const s = await setup({ config: { stopLossStageReentry: 99 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 C' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    for (let round = 1; round <= 4; round++) {
      expect(engine.store.get(issue.id)!.status).toBe('testing');
      await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 第 ${round} 轮挂了`));
      await engine.tick();
      const st = engine.store.get(issue.id)!.status;
      if (round <= 3) {
        expect(st).toBe('implementing');
        await engine.applyEvent(issue.id, 'impl_done'); // 回到 testing 再来一轮
      } else {
        expect(st).toBe('paused');
      }
    }
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(4);
    expect(s.notifications.some((n) => n.kind === 'status_change' && n.issueId === issue.id && n.to === 'paused')).toBe(true);
    // paused 后必须带解除方法；解除后从受阻前的 testing 继续，且保留执行上下文
    const missing = await engine.unblockIssue(issue.id, '   ', s.admin.id);
    expect(missing.ok).toBe(false);
    expect(engine.store.get(issue.id)!.status).toBe('paused');
    const beforeResume = engine.store.get(issue.id)!;
    const r = await engine.unblockIssue(issue.id, '修复失败测试后继续', s.admin.id);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ from: 'paused', to: 'testing' });
    const resumed = engine.store.get(issue.id)!;
    expect(resumed.status).toBe('testing');
    expect(resumed.convId).toBe(beforeResume.convId);
    expect(resumed.subtasksJson).toBe(beforeResume.subtasksJson);
    expect(resumed.subIndex).toBe(beforeResume.subIndex);
    const blockedTransition = engine.store.listEvents(issue.id)
      .findLast((event) => event.kind === 'transition' && (event.dataJson ?? '').includes('"to":"paused"'));
    expect(blockedTransition?.dataJson).toContain('"resumeState":"testing"');
    expect(blockedTransition?.dataJson).toContain('"subIndex":0');
    await engine.tick();
    const recovery = s.driver.prompts().find((prompt) => prompt.includes('【受阻恢复·继续运行】'));
    expect(recovery).toContain('修复失败测试后继续');
    expect(recovery).toContain(`STAGE_DONE:${issue.id}:testing`);
    expect(recovery).not.toContain('实施已完成');
  });

  for (const stage of ['planning', 'implementing', 'testing'] as const) {
    test(`恢复 ${stage} 必须切回本 issue 会话并继续注入`, async () => {
      const s = await setup();
      const issue = await s.engine.createIssue(s.projectId, { title: '恢复开发现场' });
      await s.bindJsonl(issue.id);
      s.engine.store.setSubtasks(issue.id, ['开发功能']);
      if (stage !== 'planning') {
        await s.engine.applyEvent(issue.id, 'plan_ready');
        await s.engine.applyEvent(issue.id, 'plan_approved');
      }
      if (stage === 'testing') await s.engine.applyEvent(issue.id, 'impl_done');
      await s.engine.blockIssue(issue.id, '等待外部授权');
      const other = s.convs.create(s.projectId, '其他会话');
      await s.convs.activate(other.id);
      await s.engine.unblockIssue(issue.id, '授权已完成，继续');
      expect(s.convs.currentConv(s.projectId)).toBe(s.engine.store.get(issue.id)!.convId!);
      await s.engine.tick();
      expect(s.driver.prompts().some(p => p.includes('授权已完成，继续'))).toBe(true);
      expect(s.engine.store.countEvents(issue.id, 'conv_displaced')).toBe(0);
    });
  }

  test('恢复 testing 清除过期未完成报告，等待本轮补报而非重复旧阻塞', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '恢复验证' });
    const jl = await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['开发功能']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    await s.engine.applyEvent(issue.id, 'impl_done');
    const report = { version: 1 as const, outcome: 'complete' as const, objective: '开发功能',
      implementation: ['已开发'], advantages: [], disadvantages: [], verification: ['已验证'],
      completion: '完成', unmetGoals: [], remainingWork: ['等待授权'] };
    s.engine.store.setCompletionReport(issue.id, report);
    await s.engine.blockIssue(issue.id, '等待授权');
    await s.engine.unblockIssue(issue.id, '已授权');
    expect(s.engine.store.get(issue.id)!.completionReport).toBeNull();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');
    expect(s.engine.store.countEvents(issue.id, 'completion_report_retry')).toBe(1);
  });

  test('implementing 恢复只续行当前未完成子任务，不重发已完成项', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '续行实施' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['已完成步骤', '当前步骤']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    s.engine.store.advanceSubtask(issue.id);
    await s.engine.blockIssue(issue.id, '等待人工修复权限');

    expect((await s.engine.unblockIssue(issue.id, '权限已修复，继续当前步骤')).ok).toBe(true);
    await s.engine.tick();

    const recovery = s.driver.prompts().find((prompt) => prompt.includes('【受阻恢复·继续运行】'));
    expect(recovery).toContain('权限已修复，继续当前步骤');
    expect(recovery).toContain('当前步骤');
    expect(recovery).not.toContain('已完成步骤');
    expect(s.engine.store.get(issue.id)!.subIndex).toBe(1);
  });
});

describe('默认自动流：manual_review 关闭时计划卡点自动放行', () => {
  test('plan_ready 不建卡点：auto_approved 事件 + 直接 implementing + 通知', async () => {
    const s = await setup();
    s.setManualReview(false); // 生产默认：全自动流
    const issue = await s.engine.createIssue(s.projectId, { title: '自动流任务', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['步骤一', '步骤二']);

    const r = await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(r.ok).toBe(true);
    // 不停在 plan_review：直接进 implementing，无卡点
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.store.listGates(issue.id)).toHaveLength(0);
    // 审计事件 + 自动确认通知
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_approved' && (e.dataJson ?? '').includes('"plan"'))).toBe(true);
    expect(s.notifications.some((n) => n.summaryCode === 'status_transition' && n.to === 'implementing')).toBe(true);
    expect(s.notifications.some((n) => n.kind === 'gate_waiting')).toBe(false);
    // 起点 commit 照记（impl_base）
    expect(evs.some((e) => e.kind === 'impl_base')).toBe(true);
  });

  test('manual_review 开启：保留 plan_review 卡点等人批', async () => {
    const s = await setup(); // setup 基线即手动模式
    const issue = await s.engine.createIssue(s.projectId, { title: '手动流任务' });
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(s.engine.store.get(issue.id)!.status).toBe('plan_review');
    expect(s.engine.store.listGates(issue.id)).toHaveLength(1);
  });

  // B-02：没有 origin 的项目（本地私有仓库）不是故障，记 push_skipped 就够，别刷 error + 通知
  test('tests_passed 自动收尾：add+commit「<标题> (#id)」，无 remote 时记 push_skipped 并照常 done', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '导出功能', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready'); // 自动 → implementing（记 impl_base）
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');

    // 工作树留下未提交改动 → 自动收尾要替我们 commit
    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export const x = 1;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    const cur = s.engine.store.get(issue.id)!;
    expect(cur.status).toBe('done'); // 无 origin：跳过 push 也不挡完成
    expect(s.engine.store.listGates(issue.id)).toHaveLength(0); // 不建 merge_review 卡点
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_approved' && (e.dataJson ?? '').includes('merge_review'))).toBe(true);
    expect(evs.some((e) => e.kind === 'auto_commit' && (e.dataJson ?? '').includes(`(#${issue.id})`))).toBe(true);
    expect(evs.some((e) => e.kind === 'push_skipped' && (e.dataJson ?? '').includes('no-remote'))).toBe(true);
    // 不是故障：既不记 error，也不发失败通知，更不留「未推送」标记
    expect(evs.some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('auto_push'))).toBe(false);
    expect(evs.some((e) => e.kind === 'auto_push_failed')).toBe(false);
    expect(s.notifications.some((n) => n.summaryCode === 'auto_git_failure')).toBe(false);
    // 没有远端就根本不该去 push
    expect(s.driver.gitCalls.some(({ args }) => args[0] === 'push')).toBe(false);
    // commit 真实落库且在本 issue 范围内（impl_commits 快照含自动提交）
    const log = await s.g(['log', '-1', '--pretty=%s']);
    expect(log.out.trim()).toBe(`导出功能 (#${issue.id})`);
    const snap = s.engine.implCommits(issue.id)!;
    expect(snap.commits.some((c) => c.subject.includes(`(#${issue.id})`))).toBe(true);
    expect(snap.files.some((f) => f.path === 'export.ts')).toBe(true);
  });

  test('tests_passed 自动收尾：先刷新协作过程页，再进入 git add/commit', async () => {
    const order: string[] = [];
    const s = await setup({
      flushProjectData: async (projectId) => { order.push(`flush:${projectId}`); },
    });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '过程页刷新顺序' });
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'ordered.ts'), 'export const ordered = true;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    s.driver.onGit = (_cwd, args) => {
      if (args[0] === 'add') order.push('git:add');
    };

    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(order.slice(0, 2)).toEqual([`flush:${s.projectId}`, 'git:add']);
    expect(s.engine.store.get(issue.id)!.status).toBe('done');
  });

  test('协作过程页刷新失败时阻止 git add/commit，并保留工作区进入 blocked', async () => {
    const s = await setup({
      flushProjectData: async () => { throw new Error('disk unavailable'); },
    });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '刷新失败' });
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'unflushed.ts'), 'export const pending = true;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    const callsBefore = s.driver.gitCalls.length;

    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.driver.gitCalls.slice(callsBefore).some((call) => call.args[0] === 'add')).toBe(false);
    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    const blocked = s.engine.store.listEvents(issue.id).findLast((event) => event.kind === 'transition');
    expect(blocked?.dataJson).toContain('协作过程页刷新失败：Error: disk unavailable');
    expect((await s.g(['status', '--porcelain'])).out).toContain('unflushed.ts');
  });

  test('tests_passed 自动收尾：commit 失败时保留工作区并进入 blocked', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '提交失败', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'pending.ts'), 'export const pending = true;\n');
    s.driver.failCommit = 'Author identity unknown';

    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    const current = s.engine.store.get(issue.id)!;
    expect(current.status).toBe('blocked');
    const blocked = s.engine.store.listEvents(issue.id).findLast((event) => event.kind === 'transition');
    expect(blocked?.dataJson).toContain('自动提交失败，工作区改动已保留');
    expect(blocked?.dataJson).toContain('Author identity unknown');
    expect((await s.g(['status', '--porcelain'])).out).toContain('pending.ts');
    expect(s.engine.store.countEvents(issue.id, 'auto_approved')).toBe(1);
    expect(s.notifications.some((n) => n.summaryCode === 'auto_git_failure'
      && n.summaryParams?.action === 'commit')).toBe(true);
  });

  test('tests_passed 自动收尾：实现范围为空且工作区有改动时进入 blocked', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '空实现范围', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'orphan.ts'), 'export const orphan = true;\n');
    s.driver.pretendCommitSuccess = true;

    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    const current = s.engine.store.get(issue.id)!;
    expect(current.status).toBe('blocked');
    const blocked = s.engine.store.listEvents(issue.id).findLast((event) => event.kind === 'transition');
    expect(blocked?.dataJson).toContain('实现范围为空，但工作区仍有未提交改动');
    expect((await s.g(['status', '--porcelain'])).out).toContain('orphan.ts');
    expect(s.engine.store.countEvents(issue.id, 'auto_approved')).toBe(1);
  });

  test('tests_passed 自动收尾：有 origin 时 push 成功（auto_push 事件 + 远端可见）', async () => {
    const s = await setup();
    s.setManualReview(false);
    // 造 bare 远端并接为 origin
    const origin = path.join(s.dir, 'origin.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);

    const issue = await s.engine.createIssue(s.projectId, { title: '推远端', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'push.ts'), 'export const y = 2;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(true);
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    // 远端 main 与本地 HEAD 一致
    const localHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    const remoteHead = (await s.driver.git(origin, ['rev-parse', 'main'])).out.trim();
    expect(remoteHead).toBe(localHead);
  });

  // ---- #272：自动提交/推送的自愈与重试 ----

  /**
   * 造一个「远端已经比我新」的局面：另开一个 clone 提交并推上去。
   * 返回 bare origin 路径；`file` 给定时两边会改同一个文件，用来制造 rebase 冲突。
   */
  async function advanceOrigin(
    s: Awaited<ReturnType<typeof setup>>,
    name: string,
    file: { path: string; content: string },
  ): Promise<string> {
    const origin = path.join(s.dir, `${name}.git`);
    expect((await s.driver.git(s.dir, ['init', '--bare', origin])).code).toBe(0);
    await s.g(['remote', 'add', 'origin', origin]);
    expect((await s.g(['push', 'origin', 'HEAD'])).code).toBe(0);
    const other = path.join(s.dir, `${name}-other`);
    // 必须显式 -b main：bare 仓库的 HEAD 默认指向 master，直接 clone 会落到一条空的 master 上
    expect((await s.driver.git(s.dir, ['clone', '-b', 'main', origin, other])).code).toBe(0);
    await s.driver.git(other, ['config', 'user.email', 'o@o']);
    await s.driver.git(other, ['config', 'user.name', 'o']);
    await fsp.writeFile(path.join(other, file.path), file.content);
    await s.driver.git(other, ['add', '.']);
    await s.driver.git(other, ['commit', '-m', '远端先走一步']);
    expect((await s.driver.git(other, ['push', 'origin', 'HEAD:main'])).code).toBe(0);
    return origin;
  }

  test('commit 失败先补身份重试一次：自愈成功就照常 done，不再打成 blocked', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '身份自愈', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');

    // 开跑后现场变成「没有身份」：第一次 commit 失败，补上身份后第二次才过
    const real = s.driver.git.bind(s.driver);
    let identityWritten = false;
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] !== 'config') return real(cwd, args);
      s.driver.gitCalls.push({ cwd, args: [...args] });
      if (args[1] === '--get') {
        return identityWritten ? { code: 0, out: 'panda\n', err: '' } : { code: 1, out: '', err: '' };
      }
      identityWritten = true;
      s.driver.failCommit = null; // 身份补上了，下一次 commit 就能过
      return { code: 0, out: '', err: '' };
    };
    s.driver.failCommit = 'Author identity unknown';

    await fsp.writeFile(path.join(s.repo, 'healed.ts'), 'export const healed = true;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done'); // 不再因为缺身份就 blocked
    const evs = s.engine.store.listEvents(issue.id);
    const recovered = evs.find((e) => e.kind === 'git_identity' && (e.dataJson ?? '').includes('"recovered":true'));
    expect(recovered?.dataJson).toContain('"applied":true');
    expect(evs.some((e) => e.kind === 'auto_commit')).toBe(true);
    expect(evs.some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('auto_commit'))).toBe(false);
    expect((await s.g(['log', '-1', '--pretty=%s'])).out.trim()).toBe(`身份自愈 (#${issue.id})`);
  });

  test('commit 失败但身份本来就在：不做无谓重试，仍按原样 blocked', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '真失败', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'pending.ts'), 'export const pending = true;\n');
    s.driver.failCommit = 'fatal: 磁盘满了';

    await s.engine.applyEvent(issue.id, 'impl_done');
    const before = s.driver.gitCalls.length;
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    // 身份齐全 → 不该写任何配置，也只该试一次 commit
    expect(s.driver.gitCalls.slice(before).filter(({ args }) => args[0] === 'commit')).toHaveLength(1);
    expect(s.driver.gitCalls.slice(before).some(({ args }) =>
      args[0] === 'config' && args[1] !== '--get')).toBe(false);
    // 开跑前的预检事件照旧，但不该有「提交失败后现补」那一条
    expect(s.engine.store.listEvents(issue.id)
      .some((e) => e.kind === 'git_identity' && (e.dataJson ?? '').includes('"recovered":true'))).toBe(false);
  });

  test('push 被拒（远端更新）：fetch + rebase 后重试一次即成功', async () => {
    const s = await setup();
    s.setManualReview(false);
    const origin = await advanceOrigin(s, 'origin-rejected', { path: 'remote.ts', content: 'export const r = 1;\n' });

    const issue = await s.engine.createIssue(s.projectId, { title: '被拒重推', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'local.ts'), 'export const l = 2;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.find((e) => e.kind === 'auto_push_retry')?.dataJson).toContain('"result":"rebased"');
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(true);
    expect(evs.some((e) => e.kind === 'auto_push_failed')).toBe(false);
    expect(s.notifications.some((n) => n.summaryCode === 'auto_git_failure')).toBe(false);
    // 远端最终既有别人的提交，也有本 issue 的提交
    const remoteLog = await s.driver.git(origin, ['log', '--pretty=%s', 'main']);
    expect(remoteLog.out).toContain(`被拒重推 (#${issue.id})`);
    expect(remoteLog.out).toContain('远端先走一步');
  });

  test('rebase 冲突：abort 收干净、留下 auto_push_failed 可见标记，done 但不静默', async () => {
    const s = await setup();
    s.setManualReview(false);
    await advanceOrigin(s, 'origin-conflict', { path: 'clash.ts', content: 'export const from = "remote";\n' });

    const issue = await s.engine.createIssue(s.projectId, { title: '推不上去', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'clash.ts'), 'export const from = "local";\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done'); // push 失败不挡完成
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.find((e) => e.kind === 'auto_push_retry')?.dataJson).toContain('"result":"rebase_failed"');
    const marker = evs.find((e) => e.kind === 'auto_push_failed');
    expect(marker?.dataJson).toContain('"branch":"main"'); // 持久可见标记，UI 据此提示未推送
    expect(evs.some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('auto_push'))).toBe(true);
    expect(s.notifications.some((n) => n.summaryCode === 'auto_git_failure'
      && n.summaryParams?.action === 'push')).toBe(true);
    // rebase 必须已经 abort 干净，否则下一条 issue 一开跑就撞「工作区有未保存改动」
    expect((await s.g(['symbolic-ref', '--short', 'HEAD'])).out.trim()).toBe('main');
    expect((await s.g(['status', '--porcelain'])).out).not.toContain('UU ');
  });

  test('push 失败但不是被拒：不做无谓的 fetch/rebase，直接留下 auto_push_failed', async () => {
    const s = await setup();
    s.setManualReview(false);
    // origin 指向一个根本不存在的仓库：预检过得去，push 报的是「不是 git 仓库」而非 rejected
    await s.g(['remote', 'add', 'origin', path.join(s.dir, 'nowhere.git')]);

    const issue = await s.engine.createIssue(s.projectId, { title: '远端不存在', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'nowhere.ts'), 'export const n = 1;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    const before = s.driver.gitCalls.length;
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_push_retry')).toBe(false); // rebase 治不了这种病
    expect(evs.some((e) => e.kind === 'auto_push_failed')).toBe(true);
    const after = s.driver.gitCalls.slice(before);
    expect(after.filter(({ args }) => args[0] === 'push')).toHaveLength(1); // 只试一次
    expect(after.some(({ args }) => args[0] === 'fetch' || args[0] === 'rebase')).toBe(false);
  });

  for (const failureAt of ['push', 'fetch', 'retry'] as const) {
    test(`推送流程 ${failureAt} 抛异常仍完成开发任务并记录未推送`, async () => {
      const s = await setup();
      s.setManualReview(false);
      await advanceOrigin(s, `origin-throw-${failureAt}`, { path: 'remote.ts', content: 'export const r = 1;\n' });
      const issue = await s.engine.createIssue(s.projectId, { title: '开发已完成', module: 'auto' });
      await s.bindJsonl(issue.id);
      s.engine.store.setSubtasks(issue.id, ['做完']);
      await s.engine.applyEvent(issue.id, 'plan_ready');
      await fsp.writeFile(path.join(s.repo, 'local.ts'), 'export const l = 2;\n');
      await s.engine.applyEvent(issue.id, 'impl_done');
      const real = s.driver.git.bind(s.driver);
      let pushes = 0;
      s.driver.git = async (cwd, args) => {
        if (args[0] === 'push') pushes++;
        if ((failureAt === 'push' && args[0] === 'push')
          || (failureAt === 'fetch' && args[0] === 'fetch')
          || (failureAt === 'retry' && args[0] === 'push' && pushes === 2)) {
          throw new Error('git transport timed out');
        }
        return real(cwd, args);
      };
      await s.engine.applyEvent(issue.id, 'tests_passed');

      expect(s.engine.store.get(issue.id)!.status).toBe('done');
      const events = s.engine.store.listEvents(issue.id);
      expect(events.filter(e => e.kind === 'auto_push_failed')).toHaveLength(1);
      expect(events.find(e => e.kind === 'auto_push_failed')?.dataJson).toContain('git transport timed out');
      expect(events.some(e => e.kind === 'auto_push')).toBe(false);
      expect(s.notifications.some(n => n.summaryCode === 'auto_git_failure' && n.summaryParams?.action === 'push')).toBe(true);
      expect((await s.g(['log', '-1', '--pretty=%s'])).out).toContain(`开发已完成 (#${issue.id})`);
      expect((await s.g(['symbolic-ref', '--short', 'HEAD'])).out.trim()).toBe('main');
    });
  }

  test('rebase 成功但重推仍失败：auto_push_retry 与 auto_push_failed 同时留痕', async () => {
    const s = await setup();
    s.setManualReview(false);
    await advanceOrigin(s, 'origin-retry-failed', { path: 'remote.ts', content: 'export const r = 1;\n' });

    const issue = await s.engine.createIssue(s.projectId, { title: '推两次都失败', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    // 从这里开始所有 push 都被远端拒（rebase/fetch 仍走真 git）
    const real = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] !== 'push') return real(cwd, args);
      s.driver.gitCalls.push({ cwd, args: [...args] });
      return { code: 1, out: '', err: '! [rejected]        HEAD -> main (fetch first)' };
    };
    await fsp.writeFile(path.join(s.repo, 'local.ts'), 'export const l = 2;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    const before = s.driver.gitCalls.length;
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.find((e) => e.kind === 'auto_push_retry')?.dataJson).toContain('"result":"rebased"');
    expect(evs.some((e) => e.kind === 'auto_push_failed')).toBe(true);
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(false);
    expect(s.notifications.some((n) => n.summaryCode === 'auto_git_failure'
      && n.summaryParams?.action === 'push')).toBe(true);
    // 只重试一次，不许打转
    expect(s.driver.gitCalls.slice(before).filter(({ args }) => args[0] === 'push')).toHaveLength(2);
  });

  test('无业务改动但启动生成 agent 指引：提交项目级指引并推送', async () => {
    const s = await setup();
    s.setManualReview(false);
    const origin = path.join(s.dir, 'origin2.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);

    const issue = await s.engine.createIssue(s.projectId, { title: '干净收尾', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed'); // 工作树干净

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_commit')).toBe(true); // AGENTS.md / CLAUDE.md 是项目约束
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(true); // 但照样推
  });
});

describe('未执行子任务编辑', () => {
  test('计划待确认时可改任一未执行项，并同步 waiting gate 与审计事件', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '可改计划' });
    s.engine.store.setSubtasks(issue.id, ['第一项', '第二项']);
    await s.engine.applyEvent(issue.id, 'plan_ready');

    const result = await s.engine.updateUnstartedSubtask(issue.id, 0, '调整后的第一项', s.admin.id);

    expect(result).toEqual({ ok: true, index: 0, subtask: { text: '调整后的第一项', done: false } });
    const fresh = s.engine.store.get(issue.id)!;
    expect(s.engine.store.subtasksOf(fresh).map((subtask) => subtask.text)).toEqual([
      '调整后的第一项',
      '第二项',
    ]);
    expect(JSON.parse(fresh.planJson ?? '{}').subtasks).toEqual(['调整后的第一项', '第二项']);
    const gate = s.engine.store.listGates(issue.id).find((candidate) => candidate.status === 'waiting')!;
    expect(JSON.parse(gate.payloadJson ?? '{}').subtasks).toEqual(['调整后的第一项', '第二项']);
    const event = s.engine.store.listEvents(issue.id).find((candidate) => candidate.kind === 'subtask_edited');
    expect(JSON.parse(event?.dataJson ?? '{}')).toEqual({ idx: 0, actor: s.admin.id });
  });

  test('顺序执行只允许修改当前游标之后的项，排队期间推进游标后会按最新状态拒绝', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '顺序任务', implMode: 'seq' });
    s.engine.store.setSubtasks(issue.id, ['当前项', '下一项', '最后一项']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const gate = s.engine.store.listGates(issue.id).find((candidate) => candidate.kind === 'plan')!;
    await s.engine.decideGate(gate.id, s.admin.id, 'approve');

    expect(await s.engine.updateUnstartedSubtask(issue.id, 0, '不能改当前项')).toEqual({
      ok: false,
      reason: 'already_dispatched',
    });
    expect(await s.engine.updateUnstartedSubtask(issue.id, 2, '可修改的最后一项')).toEqual({
      ok: true,
      index: 2,
      subtask: { text: '可修改的最后一项', done: false },
    });

    let release!: () => void;
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = s.mutex.runExclusive(`issue-meta:${s.projectId}`, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await lockEntered;
    const queued = s.engine.updateUnstartedSubtask(issue.id, 1, '竞态中的修改');
    s.engine.store.advanceSubtask(issue.id);
    release();
    await held;

    expect(await queued).toEqual({ ok: false, reason: 'already_dispatched' });
    expect(s.engine.store.subtasksOf(s.engine.store.get(issue.id)!).map((subtask) => subtask.text)).toEqual([
      '当前项',
      '下一项',
      '可修改的最后一项',
    ]);
  });

  test('并行执行开始后所有子任务都已派发，索引越界也会明确拒绝', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '并行任务', implMode: 'team' });
    s.engine.store.setSubtasks(issue.id, ['甲', '乙']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const gate = s.engine.store.listGates(issue.id).find((candidate) => candidate.kind === 'plan')!;
    await s.engine.decideGate(gate.id, s.admin.id, 'approve');

    expect(await s.engine.updateUnstartedSubtask(issue.id, 1, '不能改')).toEqual({
      ok: false,
      reason: 'already_dispatched',
    });
    expect(await s.engine.updateUnstartedSubtask(issue.id, 9, '不存在')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('正式模块绑定', () => {
  const mod = (id: number, slug: string, agent: 'claude' | 'codex'): ProjectModule => ({
    id,
    projectId: 1,
    slug,
    displayName: slug,
    agent,
    source: 'manual',
    status: 'active',
    conversationId: null,
    syncStatus: 'ready',
    syncError: null,
    createdBy: 1,
    createdTs: 1,
    lastUsedTs: null,
  });

  test('创建写 module_id 且采用模块固定代理；只有 pending 能换模块', async () => {
    const recorded: Array<{ moduleId: number; issueId: number; title: string; body: string | null }> = [];
    let selected = mod(11, 'export-tools', 'codex');
    const s = await setup({
      modulesFor: () => ({
        resolve: async () => selected,
        recordIssue: async (module, issue) => {
          recorded.push({ moduleId: module.id, issueId: issue.id, title: issue.title, body: issue.body });
        },
      }),
    });
    s.db.query(
      `INSERT INTO project_modules
         (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (11, ?, 'export-tools', 'export-tools', 'codex', 'manual', ?, 1),
              (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id, s.projectId, s.admin.id);
    const issue = await s.engine.createIssue(
      s.projectId,
      { title: '导出', moduleName: '数据导出', agent: 'claude' },
      false,
    );
    expect(issue.moduleId).toBe(11);
    expect(issue.module).toBe('export-tools');
    expect(issue.agent).toBe('codex');

    const contentUpdated = await s.engine.updatePendingMeta(issue.id, {
      title: '导出新版',
      body: '以当前需求为准',
    });
    expect(contentUpdated.title).toBe('导出新版');
    expect(contentUpdated.body).toBe('以当前需求为准');

    selected = mod(12, 'billing-core', 'claude');
    const moved = await s.engine.changePendingModule(issue.id, { moduleId: 12 });
    expect(moved.moduleId).toBe(12);
    expect(moved.agent).toBe('claude');
    expect(recorded).toEqual([
      { moduleId: 11, issueId: issue.id, title: '导出', body: null },
      { moduleId: 11, issueId: issue.id, title: '导出新版', body: '以当前需求为准' },
      { moduleId: 12, issueId: issue.id, title: '导出新版', body: '以当前需求为准' },
    ]);

    await s.engine.startIssue(issue.id);
    const running = s.engine.store.get(issue.id)!;
    const moduleConv = s.db
      .query<{ conversation_id: string }, [number]>(
        'SELECT conversation_id FROM project_modules WHERE id = ?',
      )
      .get(12)!.conversation_id;
    expect(running.convId).toBe(moduleConv);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(true);
    // 已开跑的仍然不许换模块，驱动中一律拒
    await expect(s.engine.changePendingModule(issue.id, { moduleId: 11 })).rejects.toThrow(
      /只有待办、受阻或已取消/,
    );

    const next = await s.engine.createIssue(s.projectId, { title: '同模块后续', moduleId: 12 }, false);
    await s.engine.cancelIssue(issue.id, s.admin.id);
    // #277 / I-01：每条 issue 换一条新 transcript，模块指针跟着挪；tmux 仍是同一个（slug 派生）
    const nextConv = s.engine.store.get(next.id)!.convId!;
    expect(nextConv).not.toBe(moduleConv);
    expect(
      s.db
        .query<{ conversation_id: string }, [number]>(
          'SELECT conversation_id FROM project_modules WHERE id = ?',
        )
        .get(12)!.conversation_id,
    ).toBe(nextConv);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(true);
    await s.engine.cancelIssue(next.id, s.admin.id);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(false);
    expect(s.engine.store.listEvents(next.id).some((e) => e.kind === 'module_sleep')).toBe(true);
  });

  test('blocked 的 issue 挂在旧会话上时，同模块下一条轮换到新 conv，tmux 不变、旧 conv 仍可读', async () => {
    // blocked 既不在 BUSY_STATES 里（项目不算忙、下一条会被挑起来）、进 blocked 也不清
    // conv_id。#277 之前靠 setConv 为模块会话开洞让两条共用一条 transcript；现在改为
    // **轮换**：blocked 那条的 segment 已经收了，下一条另起一条 conv，旧的留着可查。
    // 两种做法都必须保证同一件事：一条 blocked 不能把整个模块永久卡死。
    const selected = mod(12, 'billing-core', 'claude');
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => selected, recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const first = await s.engine.createIssue(s.projectId, { title: '先跑这条', moduleId: 12 }, false);
    await s.engine.startIssue(first.id);
    const moduleConv = s.db
      .query<{ conversation_id: string }, [number]>('SELECT conversation_id FROM project_modules WHERE id = ?')
      .get(12)!.conversation_id;
    expect(s.engine.store.get(first.id)!.convId).toBe(moduleConv);

    const next = await s.engine.createIssue(s.projectId, { title: '同模块后续', moduleId: 12 }, false);
    // 第一条卡住进 blocked（例：tests_failed 累计超限）——它仍持有模块会话
    await s.engine.applyEvent(first.id, 'block');
    expect(s.engine.store.get(first.id)!.status).toBe('blocked');
    expect(s.engine.store.get(first.id)!.convId).toBe(moduleConv);

    // blocked 的 onEnter 会接力 scheduleNext：下一条必须已开跑，且拿到一条**新的** conv
    const nextConv = s.engine.store.get(next.id)!.convId!;
    expect(nextConv).not.toBe(moduleConv);
    expect(s.engine.store.get(next.id)!.status).not.toBe('pending');
    // 模块指针挪到新 conv；tmux 名由 slug 派生，所以仍是同一个运行容器
    expect(
      s.db
        .query<{ conversation_id: string }, [number]>(
          'SELECT conversation_id FROM project_modules WHERE id = ?',
        )
        .get(12)!.conversation_id,
    ).toBe(nextConv);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(true);
    expect(s.engine.store.listEvents(next.id).some((e) => e.kind === 'module_conv_rotated')).toBe(true);
    // 旧 conv 不归档不删：blocked 那条的上下文仍可查
    expect(s.convs.get(moduleConv)?.archived).toBe(false);
    // 且不能留下「对话已绑定未关闭 issue」这类接力失败记录
    expect(
      s.engine.store.listEvents(next.id).filter((e) => e.kind === 'error'),
    ).toEqual([]);

    const firstEvents = s.engine.store.listEvents(first.id);
    const nextEvents = s.engine.store.listEvents(next.id);
    expect(firstEvents.some((e) => e.kind === 'conversation_segment_started')).toBe(true);
    expect(firstEvents.some((e) => e.kind === 'conversation_segment_ended')).toBe(true);
    expect(nextEvents.some((e) => e.kind === 'conversation_segment_started')).toBe(true);

    // 分段按 conv 各归各的：旧 conv 只剩 blocked 那条，新 conv 是新起的一段
    expect(s.engine.store.listConversationSegments(moduleConv)
      .map((x) => ({ issueId: x.issueId, title: x.title, endTs: x.endTs }))).toEqual([
      { issueId: first.id, title: '先跑这条', endTs: expect.any(Number) },
    ]);
    expect(s.engine.store.listConversationSegments(nextConv)
      .map((x) => ({ issueId: x.issueId, title: x.title, endTs: x.endTs }))).toEqual([
      { issueId: next.id, title: '同模块后续', endTs: null },
    ]);
  });

  test('listModuleSegments：跨会话汇总本模块的整条时间线，每段带 convId', async () => {
    // 轮换之后模块历史散在多条 conv 上，只按当前 conv 读会让人以为「换了对话记录就没了」。
    const selected = mod(12, 'billing-core', 'claude');
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => selected, recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const first = await s.engine.createIssue(s.projectId, { title: '第一条', moduleId: 12 }, false);
    await s.engine.startIssue(first.id);
    const firstConv = s.engine.store.get(first.id)!.convId!;
    const next = await s.engine.createIssue(s.projectId, { title: '第二条', moduleId: 12 }, false);
    await s.engine.applyEvent(first.id, 'block'); // 接力把第二条挑起来 → 轮换到新 conv
    const nextConv = s.engine.store.get(next.id)!.convId!;
    expect(nextConv).not.toBe(firstConv);

    // 单会话视角各自只看得见半截
    expect(s.engine.store.listConversationSegments(firstConv).map((x) => x.issueId)).toEqual([first.id]);
    expect(s.engine.store.listConversationSegments(nextConv).map((x) => x.issueId)).toEqual([next.id]);
    // 模块视角是完整时间线，按开始时间排序，每段自带 convId
    expect(
      s.engine.store.listModuleSegments(12).map((x) => ({ issueId: x.issueId, convId: x.convId, title: x.title })),
    ).toEqual([
      { issueId: first.id, convId: firstConv, title: '第一条' },
      { issueId: next.id, convId: nextConv, title: '第二条' },
    ]);
    // 别的模块不串味
    expect(s.engine.store.listModuleSegments(99)).toEqual([]);
  });

  test('旧会话上还挂着未结束的 segment（崩溃/历史数据）时不轮换：接着用同一条 conv', async () => {
    // 轮换的判据是「这条 transcript 还有没有人用」，不是「issue 是不是终态」。blocked 那条
    // 若因崩溃没落 conversation_segment_ended，它的半截上下文仍挂在会话上，此刻换 conv
    // 等于把人家的活儿扔了——这时必须退回原来的顺序复用（setConv 的模块会话豁免）。
    const selected = mod(12, 'billing-core', 'claude');
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => selected, recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const first = await s.engine.createIssue(s.projectId, { title: '崩在半路', moduleId: 12 }, false);
    await s.engine.startIssue(first.id);
    const moduleConv = s.engine.store.get(first.id)!.convId!;
    await s.engine.applyEvent(first.id, 'block');
    // 造出「段没收干净」的现场
    s.db.run(`DELETE FROM issue_events WHERE issue_id = ? AND kind = 'conversation_segment_ended'`, [first.id]);

    const next = await s.engine.createIssue(s.projectId, { title: '同模块后续', moduleId: 12 }, false);
    expect((await s.engine.startIssue(next.id)).ok).toBe(true);
    expect(s.engine.store.get(next.id)!.convId).toBe(moduleConv); // 不换，顺序复用
    expect(s.engine.store.listEvents(next.id).some((e) => e.kind === 'module_conv_rotated')).toBe(false);
    expect(
      s.db
        .query<{ conversation_id: string }, [number]>(
          'SELECT conversation_id FROM project_modules WHERE id = ?',
        )
        .get(12)!.conversation_id,
    ).toBe(moduleConv);
  });

  // ---------- #277 / I-02：技能按模块挂载（注入侧） ----------

  /** 在项目 cwd 里造几个未被 git 跟踪的技能 */
  const putSkills = async (repo: string, names: string[]) => {
    for (const name of names) {
      await fsp.mkdir(path.join(repo, '.claude', 'skills', name), { recursive: true });
      await fsp.writeFile(path.join(repo, '.claude', 'skills', name, 'SKILL.md'), `# ${name}\n`);
    }
  };
  const mountEvent = (s: { engine: { store: { listEvents: (id: number) => Array<{ kind: string; dataJson: string | null }> } } }, issueId: number) => {
    const ev = s.engine.store.listEvents(issueId).find((e) => e.kind === 'skill_visibility');
    return ev ? (JSON.parse(ev.dataJson ?? '{}') as Record<string, unknown>) : null;
  };
  const seedModule = (s: Awaited<ReturnType<typeof setup>>) =>
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

  test('模块技能使用独立会话设置，默认手动重技能且不移动任何文件', async () => {
    const s = await setup({modulesFor:()=>({resolve:async()=>mod(12,'billing-core','claude'),recordIssue:async()=>{}})});
    seedModule(s);await putSkills(s.repo,['pandados-i18n','superpowers']);
    const issue=await s.engine.createIssue(s.projectId,{title:'技能隔离',moduleId:12});
    const ev=mountEvent(s,issue.id)!;
    expect((ev.inventory as Array<{name:string;mode:string}>).map(x=>[x.name,x.mode])).toEqual([['pandados-i18n','auto'],['superpowers','manual']]);
    expect((await fsp.readdir(path.join(s.repo,'.claude/skills'))).sort()).toEqual(['pandados-i18n','superpowers']);
    expect(await fsp.readFile(path.join(s.repo,`.panda/tmp/skill-sessions/${s.engine.store.get(issue.id)!.convId}.sh`),'utf8')).toContain('user-invocable-only');
    expect((await s.g(['status','--porcelain'])).out).not.toContain('skill-sessions');
    s.db.run('INSERT INTO skill_policies(project_id,module_id,issue_id,policy_json) VALUES(?,0,?,?)',
      [s.projectId,issue.id,JSON.stringify({superpowers:'disabled'})]);
    await s.convs.relaunch(s.engine.store.get(issue.id)!.convId!);
    expect(await fsp.readFile(path.join(s.repo,`.panda/tmp/skill-sessions/${s.engine.store.get(issue.id)!.convId}.sh`),'utf8')).toContain('"superpowers":"off"');
  });
  test('模块显式技能列表兼容为会话策略，文件保持原位',async()=>{
    const s=await setup({modulesFor:()=>({resolve:async()=>mod(12,'billing-core','claude'),recordIssue:async()=>{}})});
    seedModule(s);await putSkills(s.repo,['pandados-i18n','superpowers']);
    s.db.run('UPDATE project_modules SET skills_json=? WHERE id=12',[JSON.stringify(['superpowers'])]);
    const issue=await s.engine.createIssue(s.projectId,{title:'选择技能',moduleId:12});
    const ev=mountEvent(s,issue.id)!;
    expect((ev.inventory as Array<{name:string;mode:string}>).map(x=>[x.name,x.mode])).toEqual([['pandados-i18n','manual'],['superpowers','auto']]);
    expect((await fsp.readdir(path.join(s.repo,'.claude/skills'))).sort()).toEqual(['pandados-i18n','superpowers']);
  });
  test('被跟踪的技能可限制自动调用而不形成 git 删除',async()=>{
    const s=await setup({modulesFor:()=>({resolve:async()=>mod(12,'billing-core','claude'),recordIssue:async()=>{}})});
    seedModule(s);await putSkills(s.repo,['superpowers']);
    await s.g(['add','.claude/skills']);await s.g(['commit','-m','skill']);
    const issue=await s.engine.createIssue(s.projectId,{title:'跟踪技能',moduleId:12});
    expect(mountEvent(s,issue.id)).toBeTruthy();
    expect((await s.g(['diff','--name-only'])).out).not.toContain('.claude/skills');
    expect(await fsp.readFile(path.join(s.repo,'.claude/skills/superpowers/SKILL.md'),'utf8')).toContain('superpowers');
  });

  test('项目没有任何技能时不写 .gitignore、不落事件', async () => {
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => mod(12, 'billing-core', 'claude'), recordIssue: async () => {} }),
    });
    seedModule(s);
    const issue = await s.engine.createIssue(s.projectId, { title: '无技能项目', moduleId: 12 }, false);
    expect((await s.engine.startIssue(issue.id)).ok).toBe(true);
    expect(mountEvent(s, issue.id)).toMatchObject({inventory:[]});
    expect(s.engine.store.listEvents(issue.id).filter((e) => e.kind === 'error')).toEqual([]);
    expect(await fsp.exists(path.join(s.repo, '.gitignore'))).toBe(false);
  });

  test('模块会话的复用豁免不扩散：非模块会话仍独占，占用者在驱动中也照样拒绝', async () => {
    // setConv 的独占守卫只对「模块会话 + 占用者已停驱动」开洞，其余一律维持原样，
    // 否则 debug/项目对话会被两条 issue 同时抢。
    const s = await setup({ modulesFor: () => ({ resolve: async () => mod(12, 'billing-core', 'claude'), recordIssue: async () => {} }) });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const a = await s.engine.createIssue(s.projectId, { title: 'A', moduleId: 12 }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', moduleId: 12 }, false);

    // ① 非模块会话（未登记在 project_modules 上）：blocked 占用者也不放行
    const loose = s.convs.create(s.projectId, 'debug-conv', 'claude');
    s.engine.store.setConv(a.id, loose.id);
    s.db.query(`UPDATE issues SET status = 'blocked' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, loose.id)).toThrow(/对话已绑定未关闭/);

    // ② 模块会话但占用者仍在驱动中：拒绝（同时只能有一条在跑）
    const modConv = s.convs.create(s.projectId, 'module:billing-core', 'claude');
    s.db.query('UPDATE project_modules SET conversation_id = ? WHERE id = 12').run(modConv.id);
    s.engine.store.setConv(a.id, modConv.id);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, modConv.id)).toThrow(/对话已绑定未关闭/);

    // ③ 同一条模块会话，占用者停驱动后放行
    s.db.query(`UPDATE issues SET status = 'blocked' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, modConv.id)).not.toThrow();
  });

  test('绑会话失败落回 {ok:false} 而不是抛穿 applyEvent——接力记错继续，队列不冻', async () => {
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => mod(12, 'billing-core', 'claude'), recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    // 造一条「模块会话被另一个项目里仍在驱动的 issue 攥着」的坏现场（跨项目 setConv 守卫是全局的）
    const conv = s.convs.create(s.projectId, 'module:billing-core', 'claude');
    s.db.query('UPDATE project_modules SET conversation_id = ? WHERE id = 12').run(conv.id);
    s.db.query(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
       VALUES (99, 'other', 1, ?, ?, 1)`,
    ).run(s.repo, s.admin.id);
    s.db.run(
      `INSERT INTO issues (id, project_id, title, category, module, impl_mode, agent, status, conv_id, created_by, created_ts)
       VALUES (900, 99, '别项目占着', 'task', 'x', 'seq', 'claude', 'implementing', ?, ?, 1)`,
      [conv.id, s.admin.id],
    );

    const issue = await s.engine.createIssue(s.projectId, { title: '起不来的一条', moduleId: 12 }, false);
    const r = await s.engine.startIssue(issue.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/绑定会话失败/);
    expect(s.engine.store.get(issue.id)!.status).toBe('pending'); // 没被半开跑卡住

    // 关键：done/blocked 接力路径上也不能把 applyEvent 打挂
    const trigger = await s.engine.createIssue(s.projectId, { title: '触发接力', moduleId: 12 }, false);
    await s.engine.applyEvent(trigger.id, 'cancel'); // cancel 的 onEnter 同样走 scheduleNext
    expect(s.engine.store.get(trigger.id)!.status).toBe('cancelled');
    expect(
      s.engine.store.listEvents(issue.id).some((e) => e.kind === 'error'),
    ).toBe(true); // 接力失败有留痕
  });

  test('接力优先同模块按 module_id 判定——module 文本列与 slug 不同步也不影响', async () => {
    // 035 回填留下的旧文本会让「同模块连着跑」失效：接力优先必须按模块键（module_id）命中。
    const mods = new Map([
      [11, mod(11, 'alpha', 'claude')],
      [12, mod(12, 'beta', 'claude')],
    ]);
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({
        resolve: async (input) => mods.get(input.moduleId!)!,
        recordIssue: async () => {},
      }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (11, ?, 'alpha', 'alpha', 'claude', 'manual', ?, 1),
              (12, ?, 'beta', 'beta', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id, s.projectId, s.admin.id);

    // 模块 12 有一条最早的 pending（不接力时它会被 FIFO/模块排位挑走）
    const other = await s.engine.createIssue(s.projectId, { title: '别的模块更早', moduleId: 12 }, false);
    const running = await s.engine.createIssue(s.projectId, { title: '模块 11 第一条', moduleId: 11 }, false);
    const sibling = await s.engine.createIssue(s.projectId, { title: '模块 11 第二条', moduleId: 11 }, false);
    // 模拟 035 遗留：模块 11 的 issue 文本列还是旧显示名，与 slug 不同步
    s.db.query(`UPDATE issues SET module = '需求' WHERE module_id = 11`).run();

    await s.engine.startIssue(running.id);
    await s.engine.applyEvent(running.id, 'block'); // done/blocked 都走同一条接力

    // 接力必须留在模块 11 → 挑中 sibling，而不是更早的 other
    expect(s.engine.store.get(sibling.id)!.status).not.toBe('pending');
    expect(s.engine.store.get(other.id)!.status).toBe('pending');
  });

  test('mergeModules：issues 两列重指、pending 未绑会话换代理、来源归档留会话、拒绝执行中来源', async () => {
    let manager: ModuleManager;
    const pages: string[] = [];
    const indexRefreshes: string[][] = [];
    const s = await setup({ modulesFor: () => manager });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('显式 moduleId 不应咨询分类器');
      },
      docs: {
        async ensureModule() {},
        async refreshIndex(list) {
          indexRefreshes.push(list.map((m) => m.slug));
        },
        async createIssuePage(module, issue) {
          pages.push(`${module.slug}#${issue.id}`);
          return `.panda/modules/${module.slug}/issues/${issue.id}-x.md`;
        },
        async refreshIssueIndex() {},
      },
    });
    const target = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: 'Issue 引擎',
      agent: 'claude',
      source: 'legacy',
    });
    const source = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-two',
      displayName: '旧模块二',
      agent: 'codex',
      source: 'legacy',
    });
    s.db.run(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES ('conv-src', 1, 'src', 1, 'codex', 'issue'), ('conv-d', 1, 'd', 1, 'codex', 'issue')`,
    );
    moduleStore.setConversation(source.id, 'conv-src');

    const mk = (title: string) =>
      s.engine.createIssue(s.projectId, { title, moduleId: source.id }, false);
    const a = await mk('甲');
    const b = await mk('乙');
    const c = await mk('丙');
    const d = await mk('丁');
    const setStatus = (id: number, st: string) =>
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(st, id);
    setStatus(b.id, 'done');
    setStatus(c.id, 'implementing');
    s.engine.store.setConv(d.id, 'conv-d');

    // 来源有执行中 issue → 整体拒绝，一切未动
    await expect(s.engine.mergeModules(s.projectId, [source.id], target.id)).rejects.toThrow(/执行中/);
    expect(moduleStore.get(source.id)!.status).toBe('active');
    expect(s.engine.store.get(a.id)!.moduleId).toBe(source.id);

    setStatus(c.id, 'done');
    const r = await s.engine.mergeModules(s.projectId, [source.id], target.id);
    expect([...r.movedIssueIds].sort((x, y) => x - y)).toEqual([a.id, b.id, c.id, d.id]);
    expect(r.target.id).toBe(target.id);

    // pending 未绑会话：两列重指 + 代理翻成目标模块代理
    expect(s.engine.store.get(a.id)!).toMatchObject({
      module: 'issue-engine',
      moduleId: target.id,
      agent: 'claude',
    });
    // 非 pending：重指但不翻代理
    expect(s.engine.store.get(b.id)!).toMatchObject({ moduleId: target.id, agent: 'codex' });
    // pending 已绑会话：保持原代理与会话（在途上下文不脚下换）
    expect(s.engine.store.get(d.id)!).toMatchObject({
      moduleId: target.id,
      agent: 'codex',
      convId: 'conv-d',
    });
    // 来源归档、会话留档不迁移
    expect(moduleStore.get(source.id)!).toMatchObject({ status: 'archived', conversationId: 'conv-src' });
    // 每条被移 issue 记 module_changed(via merge)
    const ev = s.engine.store.listEvents(a.id).find((e) => e.kind === 'module_changed');
    expect(ev?.dataJson).toContain('"via":"merge"');
    expect(ev?.dataJson).toContain(`"fromModuleId":${source.id}`);
    // 目标目录补建全部过程页；INDEX 刷新后只剩目标
    expect(pages.filter((p) => p.startsWith('issue-engine#')).length).toBe(4);
    expect(indexRefreshes.at(-1)).toEqual(['issue-engine']);
  });

  test('智能整理：触发→方案清洗落事件→逐项执行 create/rename/merge/move + 防重放 + 单飞', async () => {
    let manager: ModuleManager;
    const renameDirs: Array<{ from: string; to: string }> = [];
    let plan = '';
    const organizeCalls: Array<{ agent: string; issues: number }> = [];
    const s = await setup({
      modulesFor: () => manager,
      organize: async (_p, input) => {
        organizeCalls.push({ agent: input.agent, issues: input.issues.length });
        return { ok: true, planText: plan };
      },
    });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('显式 moduleId 不应咨询分类器');
      },
      docs: {
        async ensureModule() {},
        async refreshIndex() {},
        async createIssuePage(module, issue) {
          return `.panda/modules/${module.slug}/issues/${issue.id}-x.md`;
        },
        async refreshIssueIndex() {},
        async renameDir(module, newSlug) {
          renameDirs.push({ from: module.slug, to: newSlug });
        },
      },
    });
    const m1 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-01',
      displayName: 'Git 页面',
      agent: 'claude',
      source: 'legacy',
    });
    const m2 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-02',
      displayName: '执行',
      agent: 'claude',
      source: 'legacy',
    });
    const m3 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-03',
      displayName: '执行页面',
      agent: 'codex',
      source: 'legacy',
    });
    const a = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m1.id }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '乙', moduleId: m2.id }, false);
    const c = await s.engine.createIssue(s.projectId, { title: '丙', moduleId: m3.id }, false);
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('done', b.id);

    plan = JSON.stringify({
      actions: [
        { kind: 'rename', moduleId: m1.id, slug: 'git-pages', displayName: 'Git 页面', reason: '去序号' },
        { kind: 'merge', targetId: m2.id, sourceIds: [m3.id], reason: '同为执行域' },
        { kind: 'create', slug: 'file-preview', displayName: '文件预览', agent: 'claude', reason: '独立职责' },
        { kind: 'move', issueIds: [b.id], to: 'file-preview', reason: '归错类' },
        { kind: 'merge', targetId: 999, sourceIds: [m1.id], reason: '幻觉目标' }, // 清洗丢弃
      ],
    });
    const kicked = s.engine.organizeModules(s.projectId, 'claude');
    expect(kicked.ok).toBe(true);
    // 单飞：在途重复触发被拒
    expect(s.engine.organizeModules(s.projectId)).toMatchObject({ ok: false });
    expect(s.engine.organizeStatus(s.projectId).running).toBe(true);
    await s.engine.waitOrganize();
    expect(organizeCalls).toEqual([{ agent: 'claude', issues: 3 }]);

    const st = s.engine.organizeStatus(s.projectId);
    expect(st.running).toBe(false);
    expect(st.failed).toBeNull();
    expect(st.suggestion!.actions.length).toBe(4); // 幻觉 merge 被清洗
    expect(st.suggestion!.actions.map((x) => x.kind)).toEqual(['rename', 'merge', 'create', 'move']);
    expect(st.suggestion!.actions[1]).toMatchObject({ targetName: '执行', sourceNames: ['执行页面'] });
    expect(s.notifications.some((n) => n.summaryCode === 'module_organization')).toBe(true);

    // 逐项执行：rename → slug 三处同步（模块行 / 文档目录 / issues.module 文本列）
    expect(await s.engine.applyOrganizeAction(s.projectId, 0)).toMatchObject({
      ok: true,
      result: { kind: 'rename', params: { name: 'Git 页面', slug: 'git-pages' } },
    });
    expect(renameDirs).toEqual([{ from: 'legacy-module-01', to: 'git-pages' }]);
    expect(moduleStore.get(m1.id)!.slug).toBe('git-pages');
    expect(s.engine.store.get(a.id)!).toMatchObject({ module: 'git-pages', moduleId: m1.id });
    // 防重放
    expect(await s.engine.applyOrganizeAction(s.projectId, 0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('已执行'),
    });

    // merge：沿用 mergeModules 全套语义（来源归档、issue 重指）
    expect(await s.engine.applyOrganizeAction(s.projectId, 1)).toMatchObject({
      ok: true,
      result: { kind: 'merge', params: { target: '执行', count: 1 } },
    });
    expect(moduleStore.get(m3.id)!.status).toBe('archived');
    expect(s.engine.store.get(c.id)!.moduleId).toBe(m2.id);

    // move 依赖新模块：先跳过 create 直接 move → 明确报错；create 后 move 成功（done 也能挪）
    expect(await s.engine.applyOrganizeAction(s.projectId, 3)).toMatchObject({
      ok: false,
      error: expect.stringContaining('file-preview'),
    });
    expect(await s.engine.applyOrganizeAction(s.projectId, 2)).toMatchObject({
      ok: true,
      result: {
        kind: 'create', params: { name: '文件预览', slug: 'file-preview', agent: 'claude' },
      },
    });
    const created = moduleStore.listByProject(s.projectId).find((m) => m.slug === 'file-preview')!;
    expect(created).toMatchObject({ displayName: '文件预览', agent: 'claude', source: 'manual' });
    expect(await s.engine.applyOrganizeAction(s.projectId, 3)).toMatchObject({
      ok: true,
      result: { kind: 'move', params: { target: '文件预览', count: 1 } },
    });
    expect(s.engine.store.get(b.id)!).toMatchObject({
      module: 'file-preview',
      moduleId: created.id,
      status: 'done',
      agent: 'claude', // 非 pending：挪模块不翻代理
    });
    const mv = s.engine.store.listEvents(b.id).find((e) => e.kind === 'module_changed');
    expect(mv?.dataJson).toContain('"via":"organize"');
    // applied 标记全量回放
    expect(s.engine.organizeStatus(s.projectId).suggestion!.actions.map((x) => x.applied)).toEqual([
      true, true, true, true,
    ]);
  });

  test('智能整理：分析失败落 module_organize_failed；驱动中 issue 拒绝挪模块', async () => {
    let manager: ModuleManager;
    const s = await setup({
      modulesFor: () => manager,
      organize: async () => ({ ok: false, reason: 'timeout' }),
    });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('不应咨询');
      },
      docs: { async ensureModule() {}, async refreshIndex() {} },
    });
    const m1 = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: 'Issue 引擎',
      agent: 'claude',
      source: 'legacy',
    });
    const m2 = moduleStore.create({
      projectId: s.projectId,
      slug: 'file-preview',
      displayName: '文件预览',
      agent: 'claude',
      source: 'manual',
    });
    const a = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m1.id }, false);
    expect(s.engine.organizeModules(s.projectId).ok).toBe(true);
    await s.engine.waitOrganize();
    const st = s.engine.organizeStatus(s.projectId);
    expect(st.suggestion).toBeNull();
    expect(st.failed).toMatchObject({ reason: 'timeout' });

    // 驱动中 issue 拒绝挪（全批不动）
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('implementing', a.id);
    await expect(s.engine.moveIssuesToModule(s.projectId, [a.id], m2.id)).rejects.toThrow(/执行中/);
    expect(s.engine.store.get(a.id)!.moduleId).toBe(m1.id);

    // pending 未绑会话跨代理挪 → 代理随目标模块翻
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('pending', a.id);
    const codexM = moduleStore.create({
      projectId: s.projectId,
      slug: 'codex-side',
      displayName: 'Codex 侧',
      agent: 'codex',
      source: 'manual',
    });
    const r = await s.engine.moveIssuesToModule(s.projectId, [a.id], codexM.id);
    expect(r.movedIssueIds).toEqual([a.id]);
    expect(s.engine.store.get(a.id)!).toMatchObject({ moduleId: codexM.id, agent: 'codex' });
  });

  test('renameModule 透传；archiveModule 有未完结 issue 时拒绝、清空后放行', async () => {
    let manager: ModuleManager;
    const s = await setup({ modulesFor: () => manager });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('不应咨询');
      },
      docs: { async ensureModule() {}, async refreshIndex() {} },
    });
    const m = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: '旧名',
      agent: 'claude',
      source: 'legacy',
    });
    const renamed = await s.engine.renameModule(s.projectId, m.id, '新名字');
    expect(renamed.displayName).toBe('新名字');

    const issue = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m.id }, false);
    await expect(s.engine.archiveModule(s.projectId, m.id)).rejects.toThrow(/未完结/);
    await s.engine.cancelIssue(issue.id, s.admin.id);
    const archived = await s.engine.archiveModule(s.projectId, m.id);
    expect(archived.status).toBe('archived');
  });

});

describe('ISSUE_BLOCKED 哨兵 / clarifying / 手动旁路封死', () => {
  test('ISSUE_BLOCKED（核 id）任何驱动阶段都认，带原因转 blocked', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 D' });
    const jl = await s.bindJsonl(issue.id);
    await s.appendOutput(jl, asst(`ISSUE_BLOCKED:999 别人的`), asst(`ISSUE_BLOCKED:${issue.id} 缺少 API key`));
    await engine.tick();
    const cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('blocked');
    const ev = engine.store.listEvents(issue.id).find((e) => e.kind === 'sentinel');
    expect(ev!.dataJson).toContain('缺少 API key');
  });

  // #275 / I-05：完成报告改为随最后一次 STAGE_DONE 内联带出，不再另起一轮满窗注入
  test('随 STAGE_DONE:testing 内联带出的完成报告落库，并记 completion_report{via:sentinel}', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '带报告收尾' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    expect(engine.store.get(issue.id)!.status).toBe('testing');

    const report = {
      version: 1, outcome: 'complete', objective: '把导出做完',
      implementation: ['加了 CSV 导出'], advantages: ['快'], disadvantages: [],
      verification: ['跑了单测'], completion: '已完成', unmetGoals: [], remainingWork: [],
    };
    await s.appendOutput(jl, asst(
      `STAGE_DONE:${issue.id}:testing\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`,
    ));
    await engine.tick();

    expect(engine.store.get(issue.id)!.completionReport)
      .toMatchObject({ outcome: 'complete', objective: '把导出做完' });
    const ev = engine.store.listEvents(issue.id).find((e) => e.kind === 'completion_report');
    expect(ev?.dataJson).toContain('"via":"sentinel"');
    expect(ev?.dataJson).toContain('"outcome":"complete"');
    // 报告不影响推进：该过的阶段照过
    expect(['merge_review', 'merging', 'done']).toContain(engine.store.get(issue.id)!.status);
  });

  test('报告块格式写坏：不落库、不阻断推进，但留痕便于排查', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '坏报告' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing\nREPORT_BEGIN\n{坏\nREPORT_END`));
    await engine.tick();

    expect(engine.store.get(issue.id)!.completionReport).toBeNull();
    expect(engine.store.listEvents(issue.id)
      .find((e) => e.kind === 'completion_report')?.dataJson).toContain('"invalid":true');
    expect(['merge_review', 'merging', 'done']).toContain(engine.store.get(issue.id)!.status);
  });

  test('没有报告块：不落库也不留痕，收尾照常', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '无报告' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();

    expect(engine.store.get(issue.id)!.completionReport).toBeNull();
    expect(engine.store.countEvents(issue.id, 'completion_report')).toBe(0);
  });

  // #275 / B-08：同一条回复里两个协议标记都出现时，原来一律判 blocked，把用户的问题吞掉了
  test('混发 NEED_CLARIFY + ISSUE_BLOCKED：按澄清处理，不进 blocked，并落 sentinel_conflict', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '混发哨兵' });
    const jl = await s.bindJsonl(issue.id);
    await s.appendOutput(jl, asst(
      `1. 用方案 A 还是 B？\n2. 阈值取多少？\nNEED_CLARIFY:${issue.id}\nISSUE_BLOCKED:${issue.id} 需求不明确`,
    ));
    await engine.tick();

    const cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('planning'); // 停在原地等回答，不是 blocked
    expect(engine.store.countEvents(issue.id, 'sentinel')).toBe(0); // 没走 blocked 那条路
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(true);

    const conflict = engine.store.listEvents(issue.id).find((e) => e.kind === 'sentinel_conflict');
    expect(conflict?.dataJson).toContain('需求不明确'); // 被忽略的 blocked 原因要留痕，便于观测
    expect(conflict?.dataJson).toContain('用方案 A 还是 B？');
    // 澄清问题照常记全，不因为混发而丢
    const qs = engine.store.listEvents(issue.id).findLast((e) => e.kind === 'clarify_questions');
    expect(qs?.dataJson).toContain('阈值取多少？');
  });

  test('单独出现时各走各的：只有 ISSUE_BLOCKED → blocked 且无冲突事件', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '只受阻' });
    const jl = await s.bindJsonl(issue.id);
    await s.appendOutput(jl, asst(`ISSUE_BLOCKED:${issue.id} 缺少凭据`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('blocked');
    expect(engine.store.countEvents(issue.id, 'sentinel_conflict')).toBe(0);
  });

  test('单独出现时各走各的：只有 NEED_CLARIFY → 等待澄清且无冲突事件', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '只澄清' });
    const jl = await s.bindJsonl(issue.id);
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(true);
    expect(engine.store.countEvents(issue.id, 'sentinel_conflict')).toBe(0);
  });

  test('澄清前置到创建时：design 也直进 planning；pending 补充不迁移；clarifying 存量兼容', async () => {
    const s = await setup();
    s.pm.questions = ['要支持哪些格式？', '要不要鉴权？']; // 旧开跑时路径已删：不再被咨询
    const issue = await s.engine.createIssue(s.projectId, { title: '模糊需求', category: 'design' });
    expect(s.engine.store.get(issue.id)!.status).toBe('planning'); // 不再进 clarifying
    expect(s.notifications.some((n) => n.summary?.includes('要支持哪些格式'))).toBe(false);

    // 排队中的 pending 补充澄清：并入 body、记事件、不做状态迁移
    const b = await s.engine.createIssue(s.projectId, { title: '排队任务', body: '原始需求' });
    expect(s.engine.store.get(b.id)!.status).toBe('pending');
    const r = await s.engine.clarify(b.id, 'CSV 就行，不用鉴权');
    expect(r.ok).toBe(true);
    let cur = s.engine.store.get(b.id)!;
    expect(cur.status).toBe('pending');
    expect(cur.body).toContain('原始需求');
    expect(cur.body).toContain('【澄清补充】CSV 就行');
    expect(s.engine.store.listEvents(b.id).some((e) => e.kind === 'clarified')).toBe(true);

    // 已开跑（planning，驱动态）：澄清答复直达会话、不迁移状态（详见「执行中澄清」专门用例）
    const rd = await s.engine.clarify(issue.id, '晚了但仍有效');
    expect(rd.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】晚了但仍有效'))).toBe(true);

    // clarifying 存量兼容：老数据（已绑对话、卡在 clarifying）答复 → 并入 body → planning
    const conv = s.convs.create(s.projectId, 'legacy', 'claude');
    s.engine.store.setConv(b.id, conv.id);
    expect((await s.engine.applyEvent(b.id, 'start_clarifying')).ok).toBe(true);
    const r2 = await s.engine.clarify(b.id, '补充完毕');
    expect(r2.ok).toBe(true);
    cur = s.engine.store.get(b.id)!;
    expect(cur.status).toBe('planning');
    expect(cur.body).toContain('【澄清补充】补充完毕');
  });

  test('patchMeta 写 images_json：存图 / 覆盖 / 清空(null)', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(
      s.projectId,
      { title: '带图任务', imagesJson: JSON.stringify(['.panda/uploads/a/1.png']) },
      false,
    );
    expect(JSON.parse(s.engine.store.get(issue.id)!.imagesJson!)).toEqual(['.panda/uploads/a/1.png']);

    // 覆盖为新的一组
    s.engine.store.patchMeta(issue.id, {
      imagesJson: JSON.stringify(['.panda/uploads/b/2.png', '.panda/uploads/b/3.png']),
    });
    expect(JSON.parse(s.engine.store.get(issue.id)!.imagesJson!)).toEqual([
      '.panda/uploads/b/2.png',
      '.panda/uploads/b/3.png',
    ]);

    // 清空：null → images_json 置空
    s.engine.store.patchMeta(issue.id, { imagesJson: null });
    expect(s.engine.store.get(issue.id)!.imagesJson).toBeNull();
  });

  test('033/044 澄清反馈、旧总结与结构化完成报告：读写往返 + 超长截断 + null 清空', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '普通任务' }, false);
    // 新建默认 null（存量行向后兼容同语义）
    expect(s.engine.store.get(issue.id)!.clarifyFeedback).toBeNull();
    expect(s.engine.store.get(issue.id)!.resultSummary).toBeNull();
    expect(s.engine.store.get(issue.id)!.completionReport).toBeNull();

    s.engine.store.setClarifyFeedback(issue.id, '理解：做 X；思路：改 Y；风险：Z');
    s.engine.store.setResultSummary(issue.id, '完成 X，改动 a.ts/b.ts，测试通过，无遗留');
    s.engine.store.setCompletionReport(issue.id, {
      version: 1,
      outcome: 'complete',
      objective: '完成 X',
      implementation: ['修改 a.ts/b.ts'],
      advantages: ['改动集中'],
      disadvantages: [],
      verification: ['测试通过'],
      completion: '目标全部完成',
      unmetGoals: [],
      remainingWork: [],
    });
    let cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback).toBe('理解：做 X；思路：改 Y；风险：Z');
    expect(cur.resultSummary).toBe('完成 X，改动 a.ts/b.ts，测试通过，无遗留');
    expect(cur.completionReport?.objective).toBe('完成 X');

    // 超长截断（feedback 8000 / summary 16000）
    s.engine.store.setClarifyFeedback(issue.id, 'x'.repeat(9000));
    s.engine.store.setResultSummary(issue.id, 'y'.repeat(20000));
    cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback!.length).toBe(8000);
    expect(cur.resultSummary!.length).toBe(16000);

    // null 清空
    s.engine.store.setClarifyFeedback(issue.id, null);
    s.engine.store.setResultSummary(issue.id, null);
    s.engine.store.setCompletionReport(issue.id, null);
    cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback).toBeNull();
    expect(cur.resultSummary).toBeNull();
    expect(cur.completionReport).toBeNull();
  });

  test('全类别开跑直进 planning；startIssue 只认 pending；非法转换被拒', async () => {
    const s = await setup();
    s.pm.questions = ['会被跳过吗']; // 旧路径已删，任何类别都不再咨询
    const issue = await s.engine.createIssue(s.projectId, { title: '修 bug', category: 'debug' });
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');

    expect((await s.engine.startIssue(issue.id)).ok).toBe(false); // 已不在 pending
    expect((await s.engine.applyEvent(issue.id, 'merged')).ok).toBe(false); // 非法转换
    expect((await s.engine.applyEvent(issue.id, 'tests_failed')).ok).toBe(false);

    // task 同样直进（执行中不清楚走 ISSUE_BLOCKED；创建时澄清是后台分析，不改状态）
    await s.engine.cancelIssue(issue.id); // 腾出项目队列，否则新 task 只会排队
    const task = await s.engine.createIssue(s.projectId, { title: '很模糊的任务' });
    expect(s.engine.store.get(task.id)!.status).toBe('planning');
  });

  test('同项目并发 startIssue 只能一条赢：单 busy、单激活对话，败者保持纯 pending', async () => {
    const s = await setup();
    const a = await s.engine.createIssue(s.projectId, { title: '并发开跑 A' }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '并发开跑 B' }, false);
    expect(s.engine.store.get(a.id)!.status).toBe('pending');
    expect(s.engine.store.get(b.id)!.status).toBe('pending');

    const results = await Promise.all([s.engine.startIssue(a.id), s.engine.startIssue(b.id)]);
    const fresh = [s.engine.store.get(a.id)!, s.engine.store.get(b.id)!];
    const winners = fresh.filter((issue) => issue.status === 'planning');
    const losers = fresh.filter((issue) => issue.status === 'pending');
    const busy = fresh.filter((issue) => BUSY_STATES.includes(issue.status));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(winners[0]!.convId).toBeTruthy();
    expect(losers[0]!.convId).toBeNull();
    expect(s.convs.currentConv(s.projectId)).toBe(winners[0]!.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });

  test('队首激活失败转 blocked 后立即接力下一条，项目不因 scheduling guard 冻结', async () => {
    const s = await setup();
    const a = await s.engine.createIssue(s.projectId, { title: '激活会失败的 A' }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '应接力的 B' }, false);
    const createSession = s.driver.createSession.bind(s.driver);
    let failFirstActivation = true;
    s.driver.createSession = async (name: string, cwd: string) => {
      if (failFirstActivation) {
        failFirstActivation = false;
        throw new Error('测试注入：首次激活失败');
      }
      await createSession(name, cwd);
    };

    await s.engine.scheduleNext(s.projectId);

    const freshA = s.engine.store.get(a.id)!;
    const freshB = s.engine.store.get(b.id)!;
    const busy = [freshA, freshB].filter((issue) => BUSY_STATES.includes(issue.status));
    expect(freshA.status).toBe('paused');
    expect(freshB.status).toBe('planning');
    expect(busy).toHaveLength(1);
    expect(busy[0]!.id).toBe(b.id);
    expect(freshB.convId).toBeTruthy();
    expect(s.convs.currentConv(s.projectId)).toBe(freshB.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });

  test('终态收尾中同一 Issue 被外部改回 pending 时，调度不重入当前 transition', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '同 issue transition 重入' }, false);
    let rewound = false;
    s.driver.onGit = () => {
      if (rewound) return;
      rewound = true;
      // 模拟旧版文件同步：onEnter 已通过状态检查并进入异步 Git 收尾后，把本 Issue 改回 pending。
      s.db.query("UPDATE issues SET status = 'pending' WHERE id = ?").run(issue.id);
    };

    const blocked = s.engine.blockIssue(issue.id, '模拟文件同步竞态');
    const settled = await Promise.race([
      blocked.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(settled).toBe(true);
    if (!settled) return;
    expect(rewound).toBe(true);
    expect(s.engine.store.get(issue.id)?.status).toBe('pending');

    await s.engine.scheduleNext(s.projectId);
    expect(s.engine.store.get(issue.id)?.status).toBe('planning');
  });

  test('unblock 的 fallback 排队通知窗口也占项目启动权：并发 start 后仍只能单 active', async () => {
    let deferredIssueId = 0;
    let releaseUnblockNotify!: () => void;
    let markUnblockNotifyEntered!: () => void;
    const unblockNotifyEntered = new Promise<void>((resolve) => {
      markUnblockNotifyEntered = resolve;
    });
    const unblockNotifyHold = new Promise<void>((resolve) => {
      releaseUnblockNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (
          event.issueId === deferredIssueId &&
          event.kind === 'status_change' &&
          event.from === 'blocked' &&
          event.to === 'pending'
        ) {
          markUnblockNotifyEntered();
          await unblockNotifyHold;
        }
      },
    });
    const a = await s.engine.createIssue(s.projectId, { title: '解除受阻 A' }, false);
    expect((await s.engine.blockIssue(a.id, '先受阻')).ok).toBe(true);
    const b = await s.engine.createIssue(s.projectId, { title: '排队 B' }, false);
    expect(s.engine.store.get(a.id)!.convId).toBeNull();
    expect(s.engine.store.get(b.id)!.convId).toBeNull();
    deferredIssueId = a.id;

    const unblock = s.engine.unblockIssue(a.id, '释放并发测试中的受阻任务', s.admin.id);
    await unblockNotifyEntered;
    expect(s.engine.store.get(a.id)!.status).toBe('pending'); // CAS 已落，A transition tail 仍被通知占用

    let bSettled = false;
    let starts!: Promise<[Awaited<ReturnType<typeof s.engine.startIssue>>, Awaited<ReturnType<typeof s.engine.startIssue>>]>;
    let bSettledBeforeRelease = false;
    let bPlannedBeforeRelease = false;
    try {
      const startA = s.engine.startIssue(a.id);
      const startB = s.engine.startIssue(b.id).then((result) => {
        bSettled = true;
        return result;
      });
      starts = Promise.all([startA, startB]);
      await flushMicrotasks();
      bSettledBeforeRelease = bSettled;
      bPlannedBeforeRelease = s.engine.store.get(b.id)!.status === 'planning';
    } finally {
      releaseUnblockNotify();
    }
    await Promise.all([unblock, starts]);

    const fresh = [s.engine.store.get(a.id)!, s.engine.store.get(b.id)!];
    const winners = fresh.filter((issue) => issue.status === 'planning');
    const losers = fresh.filter((issue) => issue.status === 'pending');
    const busy = fresh.filter((issue) => BUSY_STATES.includes(issue.status));
    expect(bSettledBeforeRelease).toBe(false);
    expect(bPlannedBeforeRelease).toBe(false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(winners[0]!.convId).toBeTruthy();
    expect(losers[0]!.convId).toBeNull();
    expect(s.convs.currentConv(s.projectId)).toBe(winners[0]!.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });
});

describe('止损闸触发（#274 / I-06）', () => {
  const stopLossEvent = (s: Awaited<ReturnType<typeof setup>>, id: number) => {
    const raw = s.engine.store.listEvents(id).find((e) => e.kind === 'stop_loss_triggered')?.dataJson;
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  };
  /** 最近一次 blocked 的 transition 事件数据 */
  const lastBlocked = (s: Awaited<ReturnType<typeof setup>>, id: number) => {
    const raw = s.engine.store.listEvents(id)
      .findLast((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('"to":"paused"'))?.dataJson;
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  };

  test('累计受阻到阈值：状态迁移落定当场触发，不用等下一轮 tick', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossBlockCount: 2 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '反复受阻' });
    await s.bindJsonl(issue.id);

    // 第 1 次受阻 → 人工解除，回原阶段
    await s.engine.applyEvent(issue.id, 'block', { note: '第一次' });
    expect((await s.engine.unblockIssue(issue.id, '接着干')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    expect(stopLossEvent(s, issue.id)).toBeNull();

    // 第 2 次受阻 → 再解除，解除落定的一瞬间就该被闸拦住
    await s.engine.applyEvent(issue.id, 'block', { note: '第二次' });
    expect((await s.engine.unblockIssue(issue.id, '再试一次')).ok).toBe(true);

    expect(stopLossEvent(s, issue.id)).toMatchObject({ reason: 'blocked', blockCount: 2, stage: 'planning' });
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    // 止损打的这次 blocked 必须带标记：不带的话计数会把它算进去，闸就会自我放大
    expect(lastBlocked(s, issue.id)).toMatchObject({ stopLoss: true });
    expect(String(lastBlocked(s, issue.id)!.note)).toContain('止损暂停');
    // 只发一条专用通知：通用的 issue_blocked 会说成「执行受阻」，与止损语义打架
    const notices = s.notifications.filter((n) => n.issueId === issue.id && n.kind === 'issue_blocked');
    expect(notices.map((n) => n.summaryCode)).toEqual(['issue_blocked', 'issue_blocked', 'stop_loss_paused']);
    expect(notices.at(-1)!.summaryParams).toMatchObject({ reason: 'blocked', blocks: 2 });

    // #275 的 attentionKind 要靠这两条事件把「止损暂停」从普通受阻里分出来，
    // 且 /events 接口是全量返回（listEvents 不过滤 kind），所以前端读得到。
    const events = s.engine.store.listEvents(issue.id);
    expect(JSON.parse(events.find((e) => e.kind === 'stop_loss_triggered')!.dataJson!))
      .toMatchObject({ reason: 'blocked', blockCount: 2, stage: 'planning' });
    expect(JSON.parse(events.findLast((e) => e.kind === 'transition')!.dataJson!))
      .toMatchObject({ to: 'paused', stopLoss: true, resumeState: 'planning' });
  });

  test('同阶段反复重入到阈值：触发并记下重入次数', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossStageReentry: 2 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '来回打转' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved'); // 首次进 implementing，不算重入
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_failed', { failCount: 1 }); // 重入 1
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_failed', { failCount: 2 }); // 重入 2 → 触发

    expect(stopLossEvent(s, issue.id)).toMatchObject({
      reason: 'stage_reentry', stageReentry: 2, stage: 'implementing',
    });
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
  });

  /**
   * 把该 issue 的 transition 事件整体回拨，造出「已经跑了很久」的现场。
   * 不能用 clock.advance：事件 ts 走的是真实 Date.now()，止损时长也必须按同一基准算。
   */
  const backdate = (s: Awaited<ReturnType<typeof setup>>, id: number, ms: number) =>
    s.db.query("UPDATE issue_events SET ts = ts - ? WHERE issue_id = ? AND kind = 'transition'")
      .run(ms, id);

  test('累计运行超时：不依赖任何迁移，由 tick 发现并当场收手不再注入', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossRuntimeMs: 60_000 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '跑太久' });
    await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff
    const sentBefore = s.driver.sent.length;

    backdate(s, issue.id, 10 * 60_000); // BUSY 里待了 10 分钟，超过 60s 阈值
    await s.engine.tick();

    expect(stopLossEvent(s, issue.id)).toMatchObject({ reason: 'runtime', stage: 'planning' });
    expect((stopLossEvent(s, issue.id)!.runtimeMs as number)).toBeGreaterThan(60_000);
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.driver.sent.length).toBe(sentBefore); // 命中即收手，本 tick 不催不判
  });

  test('同一锚点周期内只触发一次，不会每 3s 刷一条', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossRuntimeMs: 60_000 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '幂等' });
    await s.bindJsonl(issue.id);
    await s.engine.tick();
    backdate(s, issue.id, 10 * 60_000);
    for (let i = 0; i < 4; i++) { await s.engine.tick(); s.clock.advance(3_000); }
    expect(s.engine.store.countEvents(issue.id, 'stop_loss_triggered')).toBe(1);
  });

  test('暂停后队列不卡：同项目下一条 pending 照常接力开跑', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossRuntimeMs: 60_000 } });
    const first = await s.engine.createIssue(s.projectId, { title: '烧太久的' });
    await s.bindJsonl(first.id);
    const second = await s.engine.createIssue(s.projectId, { title: '排队的' }, false);
    expect(s.engine.store.get(second.id)!.status).toBe('pending');

    await s.engine.tick();
    backdate(s, first.id, 10 * 60_000); // 只把第一条做旧，接力起来的第二条应当安然无恙
    await s.engine.tick();

    expect(s.engine.store.get(first.id)!.status).toBe('paused');
    // blocked 的收尾分支会 scheduleNext 接力——止损暂停一条不能把整个项目队列堵死
    expect(s.engine.store.get(second.id)!.status).toBe('planning');
    expect(s.engine.store.countEvents(second.id, 'stop_loss_triggered')).toBe(0);
  });
});

describe('止损恢复通道（#274 / I-06）', () => {
  const triggered = (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    s.engine.store.countEvents(id, 'stop_loss_triggered');

  test('确认继续：回原阶段而不是重跑，并落新锚点', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossBlockCount: 2 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '回原阶段' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved'); // 停在 implementing

    await s.engine.applyEvent(issue.id, 'block', { note: '第一次' });
    expect((await s.engine.unblockIssue(issue.id, '继续')).ok).toBe(true);
    await s.engine.applyEvent(issue.id, 'block', { note: '第二次' });
    expect((await s.engine.unblockIssue(issue.id, '再继续')).ok).toBe(true);
    // 第 2 次解除落定即触发止损
    expect(triggered(s, issue.id)).toBe(1);
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.engine.store.countEvents(issue.id, 'stop_loss_resumed')).toBe(0);

    // 用户确认继续：回 implementing（原阶段），不是回 pending 重跑
    expect((await s.engine.unblockIssue(issue.id, '我知道贵，接着干')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.store.countEvents(issue.id, 'stop_loss_resumed')).toBe(1);
  });

  test('恢复后必须重新攒满计数才会再次暂停，不能一 tick 又停下', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossBlockCount: 2 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '推得动' });
    await s.bindJsonl(issue.id);

    await s.engine.applyEvent(issue.id, 'block', { note: 'a' });
    await s.engine.unblockIssue(issue.id, '继续');
    await s.engine.applyEvent(issue.id, 'block', { note: 'b' });
    await s.engine.unblockIssue(issue.id, '继续'); // → 触发止损
    expect(triggered(s, issue.id)).toBe(1);

    await s.engine.unblockIssue(issue.id, '确认继续'); // 落锚点
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    // 锚点之后 blocked 计数归零：连跑几轮 tick 也不该再被暂停
    for (let i = 0; i < 3; i++) { await s.engine.tick(); s.clock.advance(3_000); }
    expect(triggered(s, issue.id)).toBe(1);
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');

    // 重新攒满（锚点之后再受阻 2 次）才会第二次触发
    await s.engine.applyEvent(issue.id, 'block', { note: 'c' });
    await s.engine.unblockIssue(issue.id, '继续');
    await s.engine.applyEvent(issue.id, 'block', { note: 'd' });
    await s.engine.unblockIssue(issue.id, '继续');
    expect(triggered(s, issue.id)).toBe(2);
  });

  test('普通受阻的恢复不落锚点：别把烧钱账目一笔勾销', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, stopLossBlockCount: 5 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '普通受阻' });
    await s.bindJsonl(issue.id);
    await s.engine.applyEvent(issue.id, 'block', { note: '普通故障' });
    expect((await s.engine.unblockIssue(issue.id, '修好了')).ok).toBe(true);
    expect(s.engine.store.countEvents(issue.id, 'stop_loss_resumed')).toBe(0);
    // 这次受阻仍然计进止损账里
    expect(s.engine.store.stopLossStats(issue.id, 0, 'planning', Date.now()).blockCount).toBe(1);
  });
});

describe('止损计数 stopLossStats（#274 / I-06）', () => {
  /** 直接写 transition 事件：logEvent 用真实 Date.now()，时长断言需要可控时间戳 */
  const trans = (
    s: Awaited<ReturnType<typeof setup>>,
    issueId: number,
    to: string,
    ts: number,
    extra: Record<string, unknown> = {},
  ) => s.db
    .query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
    .run(issueId, 'transition', JSON.stringify({ event: 'e', to, ...extra }), ts);

  test('blocked 计数排除止损自己打的那次，否则闸会自我放大', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '反复受阻' });
    trans(s, issue.id, 'blocked', 100);
    trans(s, issue.id, 'implementing', 200);
    trans(s, issue.id, 'blocked', 300);
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 999).blockCount).toBe(2);

    // 止损闸自己打的这条带 stopLoss 标记，不计入
    trans(s, issue.id, 'blocked', 400, { stopLoss: true });
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 999).blockCount).toBe(2);
  });

  test('stageReentry 数的是重新进入「当前阶段」的次数', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '来回打转' });
    trans(s, issue.id, 'implementing', 100);
    trans(s, issue.id, 'testing', 200);
    trans(s, issue.id, 'implementing', 300); // tests_failed 打回
    trans(s, issue.id, 'testing', 400);
    trans(s, issue.id, 'implementing', 500);
    // 进入 implementing 3 次 = 重入 2 次：首次进入不算「重入」，否则 plan_approved
    // 那一下就把预算吃掉一格，阈值 3 会在第 2 次 tests_failed 就触发
    const st = s.engine.store.stopLossStats(issue.id, 0, 'implementing', 999);
    expect(st.stageReentry).toBe(2);
    expect(s.engine.store.stopLossStats(issue.id, 0, 'testing', 999).stageReentry).toBe(1);
  });

  test('runtimeMs 只累计 BUSY 区间，等人的时间不算在 issue 头上', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '算时长' });
    trans(s, issue.id, 'planning', 1_000);
    trans(s, issue.id, 'blocked', 3_000);      // planning 跑了 2000
    trans(s, issue.id, 'implementing', 6_000); // blocked 的 3000 不计
    // 最后一段没有下一条 transition，算到 now
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 10_000).runtimeMs).toBe(6_000);
    // now 往后推，正在跑的那段跟着涨
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 16_000).runtimeMs).toBe(12_000);

    // 停在非 BUSY 状态时，时钟再走也不涨
    trans(s, issue.id, 'blocked', 16_000);
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 99_000).runtimeMs).toBe(12_000);
  });

  test('锚点之后重新计：人工确认继续后不该背着旧账', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '锚点' });
    trans(s, issue.id, 'blocked', 100);
    trans(s, issue.id, 'implementing', 200);
    const anchor = (s.db.query<{ m: number }, [number]>(
      'SELECT MAX(id) m FROM issue_events WHERE issue_id = ?',
    ).get(issue.id))!.m;
    trans(s, issue.id, 'blocked', 300);
    trans(s, issue.id, 'implementing', 400);

    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 999)).toMatchObject({
      blockCount: 2, stageReentry: 1,
    });
    expect(s.engine.store.stopLossStats(issue.id, anchor, 'implementing', 999)).toMatchObject({
      blockCount: 1, stageReentry: 0,
    });
    // runtime 的计时窗口从**锚点时刻**起算，且锚点当时的状态取锚点之前最后一条 transition：
    // 这里锚点就是 implementing@200，于是 200→300 实现中(100) + 400→999 实现中(599) = 699，
    // 中间 300→400 停在 blocked 不计。
    expect(s.engine.store.stopLossStats(issue.id, anchor, 'implementing', 999).runtimeMs).toBe(699);
  });

  test('恢复后即使没有新的状态迁移，运行时长也要继续计（否则闸在第一次恢复后就哑了）', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '恢复后继续计时' });
    trans(s, issue.id, 'implementing', 1_000);
    trans(s, issue.id, 'blocked', 2_000);
    // 人工确认继续：unblock 的 transition 在前、锚点事件在后（afterCommit 里落）
    trans(s, issue.id, 'implementing', 3_000);
    s.db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(issue.id, 'stop_loss_resumed', '{}', 3_000);
    const anchor = (s.db.query<{ m: number }, [number]>(
      'SELECT MAX(id) m FROM issue_events WHERE issue_id = ?',
    ).get(issue.id))!.m;

    // 锚点之后一条 transition 都没有，但 issue 确实从 3_000 起就在跑
    expect(s.engine.store.stopLossStats(issue.id, anchor, 'implementing', 9_000).runtimeMs).toBe(6_000);
    expect(s.engine.store.stopLossStats(issue.id, anchor, 'implementing', 9_000).blockCount).toBe(0);
  });

  test('坏事件与缺 to 的事件跳过：宁可少算晚触发，也不要把闸算早', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '坏数据' });
    trans(s, issue.id, 'blocked', 100);
    s.db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(issue.id, 'transition', '{坏', 200);
    s.db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(issue.id, 'transition', '{"event":"e"}', 300); // 没有 to
    expect(s.engine.store.stopLossStats(issue.id, 0, 'implementing', 999)).toEqual({
      blockCount: 1, stageReentry: 0, runtimeMs: 0,
    });
  });
});

describe('催办退避与封顶（#273 / B-03）', () => {
  const nudges = (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    s.engine.store.countEvents(id, 'nudged');

  /**
   * 复现 #41 的真实病灶：代理每被催一次就吐点东西（tail 里的 assistant 消息会把
   * `w.nudged` 清零、activityTs 推到当下），于是「动一下 → 又静默 → 再催」可以无限循环。
   * 完全哑掉的会话反而只会被催一次，那不是本 issue 要治的形态。
   */
  const respond = async (s: Awaited<ReturnType<typeof setup>>, jl: string) => {
    await s.appendOutput(jl, asst('还在跑，稍等'));
    await s.engine.tick();
  };

  test('静默阈值按已催次数指数退避：120 → 240 → 480s，早于阈值一律不催', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '退避' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff

    // 第 1 次：基准 120s，与改造前完全一致（健康 issue 零回归）
    s.clock.advance(119_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(0);
    s.clock.advance(2_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(1);

    // 第 2 次：阈值抬到 240s，200s 还不够
    await respond(s, jl);
    s.clock.advance(200_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(1);
    s.clock.advance(45_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(2);

    // 第 3 次：阈值抬到 480s，400s 还不够
    await respond(s, jl);
    s.clock.advance(400_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(2);
    s.clock.advance(85_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(3);
  });

  test('到 nudgeMaxCount 封顶：停催、只通知一次、issue 不 block 也不改状态', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, nudgeMaxCount: 2 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '催不动的活' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();

    s.clock.advance(121_000); await s.engine.tick(); // 第 1 次
    await respond(s, jl);
    s.clock.advance(241_000); await s.engine.tick(); // 第 2 次（退避后）
    expect(nudges(s, issue.id)).toBe(2);
    const transitionsBefore = s.engine.store.countEvents(issue.id, 'transition');

    // 之后代理照样在动、照样静默，但预算已用完 → 再也不催
    for (let i = 0; i < 3; i++) {
      await respond(s, jl);
      s.clock.advance(3_600_000);
      await s.engine.tick();
    }
    expect(nudges(s, issue.id)).toBe(2);
    expect(s.engine.store.countEvents(issue.id, 'nudge_exhausted')).toBe(1); // 每 3s 一 tick，必须幂等
    expect(s.engine.store.listEvents(issue.id)
      .find((e) => e.kind === 'nudge_exhausted')?.dataJson).toContain('"count":2');

    const notices = s.notifications.filter((n) => n.summaryCode === 'auto_retry_exhausted');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.summaryParams).toMatchObject({ reason: 'nudge', count: 2 });

    // 刻意不 block：现场还在，代理自己完事照样能收尾
    expect(s.engine.store.get(issue.id)!.status).toBe('paused'); // 与封顶前同一状态
    expect(s.engine.store.countEvents(issue.id, 'transition')).toBe(transitionsBefore + 1);
  });

  test('封顶后代理彻底哑掉也能提醒：不挂在 w.nudged 下面', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, nudgeMaxCount: 1 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '催完就哑了' });
    await s.bindJsonl(issue.id);
    await s.engine.tick();

    s.clock.advance(121_000); await s.engine.tick(); // 唯一一次催办，w.nudged 从此停在 true
    expect(nudges(s, issue.id)).toBe(1);
    s.clock.advance(3_600_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'nudge_exhausted')).toBe(1);
  });

  test('人工介入（答澄清 / 解除阻塞）后重新给一份催办预算', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, nudgeMaxCount: 1 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '人工介入' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();

    s.clock.advance(121_000); await s.engine.tick();
    await respond(s, jl);
    s.clock.advance(3_600_000); await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(1);
    expect(s.engine.store.countEvents(issue.id, 'nudge_exhausted')).toBe(1);

    // 人一插手就重新计数：锚点之后的 nudged 事件数归零
    await s.engine.unblockIssue(issue.id,'已检查现场，继续');
    await s.engine.tick();
    await respond(s, jl);
    s.clock.advance(121_000);
    await s.engine.tick();
    expect(nudges(s, issue.id)).toBe(2);

    // 新一轮到顶要能再提醒一次（幂等只在同一锚点周期内生效）
    await respond(s, jl);
    s.clock.advance(3_600_000);
    await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'nudge_exhausted')).toBe(2);
    expect(s.notifications.filter((n) => n.summaryCode === 'auto_retry_exhausted')).toHaveLength(2);
  });

  // 发起人拍板：催办与判定各算 5 次，**任一到顶就彻底停催停判、静等人工**
  test('催办封顶后连兜底判定一起停：自动手段推不动了就别再换个名目烧钱', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, nudgeMaxCount: 1 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '封顶就全停' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst('还在跑测试')); // 给 judge 留一段可判定的尾巴
    await s.engine.tick();
    s.pm.judgement = 'not_done';

    s.clock.advance(121_000); await s.engine.tick(); // 第 1 次催办 → 用光预算
    const judgeCallsAtCap = s.pm.judgeCalls;
    for (let i = 0; i < 3; i++) { s.clock.advance(3_600_000); await s.engine.tick(); }

    expect(nudges(s, issue.id)).toBe(1);
    expect(s.engine.store.countEvents(issue.id, 'nudge_exhausted')).toBe(1);
    expect(s.pm.judgeCalls).toBe(judgeCallsAtCap); // 判定也停了，不再有新调用
  });

  test('判定用光预算同样停催：两条闸互为总闸', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, judgeMaxCount: 1 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '判定先到顶' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst('还在跑测试'));
    await s.engine.tick();
    s.pm.judgement = 'not_done';

    s.clock.advance(121_000); await s.engine.tick(); // 第 1 次催办
    s.clock.advance(241_000); await s.engine.tick(); // 第 1 次判定 → 用光判定预算
    expect(s.pm.judgeCalls).toBe(1);
    const nudgesAtCap = nudges(s, issue.id);

    for (let i = 0; i < 3; i++) { s.clock.advance(3_600_000); await s.engine.tick(); }
    expect(s.engine.store.countEvents(issue.id, 'judge_exhausted')).toBe(1);
    expect(nudges(s, issue.id)).toBe(nudgesAtCap); // 催办也停了
    expect(s.pm.judgeCalls).toBe(1);
  });
});

describe('兜底判定退避与封顶（#273 / B-04）', () => {
  /**
   * 判定用例一律关掉催办（nudgeMaxCount: 0）：nudge 会刷新 fedTs 把 idleMs 打回 0，
   * 判定节拍就没法确定性验证了。代价是每次都会先落一条 nudge 的 exhausted 通知，
   * 所以下面统计通知时按 reason 过滤。
   */
  const judgeSetup = (config: Record<string, unknown> = {}) =>
    setup({ config: { resultSummaryTimeoutMs: 0, nudgeMaxCount: 0, ...config } as never });

  /** 造一条有 assistant 尾巴的静默 issue（judgeFallback 需要可判定的窗口内容） */
  const idleIssue = async (s: Awaited<ReturnType<typeof setup>>, title: string) => {
    const issue = await s.engine.createIssue(s.projectId, { title });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff
    await s.appendOutput(jl, asst('还在跑，没结论'));
    await s.engine.tick(); // 消费掉，activityTs 定在此刻
    return issue;
  };

  test('同结论连击 → 间隔 240 → 240 → 480s 逐级翻倍，未到点一律不判', async () => {
    const s = await judgeSetup();
    const issue = await idleIssue(s, '反复判不完');
    s.pm.judgement = 'not_done';

    // 首判仍是 fallbackSec 基准（健康 issue 零回归）
    s.clock.advance(241_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(1);

    // 第一次复判还给基准价：结论刚出现一次，谈不上「反复」
    s.clock.advance(200_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(1);
    s.clock.advance(45_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(2);

    // 同结论第三次起才翻倍：480s
    s.clock.advance(400_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(2);
    s.clock.advance(85_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(3);

    expect(s.engine.store.countEvents(issue.id, 'judged')).toBe(3);
  });

  test('结论一变立刻回落基准：现场在动就不该继续拉长间隔', async () => {
    const s = await judgeSetup();
    const issue = await idleIssue(s, '结论变了');
    s.pm.judgement = 'not_done';

    s.clock.advance(241_000); await s.engine.tick(); // #1 not_done
    s.clock.advance(241_000); await s.engine.tick(); // #2 not_done（基准）
    s.clock.advance(481_000); await s.engine.tick(); // #3 not_done（480s）
    expect(s.pm.judgeCalls).toBe(3);

    // 此刻同结论连击 3，下一次要等 960s；结论变成 done 后应立刻回到 240s
    s.pm.judgement = 'done'; // planning 判 done 只发重输出指令，不改状态
    s.clock.advance(700_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(3); // 960s 还没到
    s.clock.advance(265_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(4); // #4 done → streak 归 1
    expect(s.engine.store.countEvents(issue.id, 'replan_requested')).toBe(1);

    // 回落到基准：241s 就能再判一次，而不是继续按 1920s 等
    s.clock.advance(241_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(5);
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
  });

  test('到 judgeMaxCount 封顶：停判、只通知一次、issue 不 block 也不改状态', async () => {
    const s = await judgeSetup({ judgeMaxCount: 3 });
    const issue = await idleIssue(s, '判不出结果');
    s.pm.judgement = 'not_done';

    s.clock.advance(241_000); await s.engine.tick();
    s.clock.advance(241_000); await s.engine.tick();
    s.clock.advance(481_000); await s.engine.tick();
    expect(s.pm.judgeCalls).toBe(3);
    const transitionsBefore = s.engine.store.countEvents(issue.id, 'transition');

    // 再等多久都不判了，转人工
    for (let i = 0; i < 3; i++) {
      s.clock.advance(3_600_000);
      await s.engine.tick();
    }
    expect(s.pm.judgeCalls).toBe(3);
    expect(s.engine.store.countEvents(issue.id, 'judge_exhausted')).toBe(1); // 每 3s 一 tick，必须幂等
    const ev = s.engine.store.listEvents(issue.id).find((e) => e.kind === 'judge_exhausted');
    expect(ev?.dataJson).toContain('"count":3');
    expect(ev?.dataJson).toContain('"result":"not_done"');

    const notices = s.notifications.filter((n) => n.summaryCode === 'auto_retry_exhausted'
      && n.summaryParams?.reason === 'judge');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.summaryParams).toMatchObject({ reason: 'judge', count: 3 });

    // 刻意不 block：状态与 transition 计数都不动
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.engine.store.countEvents(issue.id, 'transition')).toBe(transitionsBefore + 1);
  });

  test('封顶不影响 planning 的 judged=done 三振出局：那条先到先生效', async () => {
    const s = await judgeSetup({ judgeMaxCount: 10 });
    const issue = await idleIssue(s, '规划死循环仍要 block');
    s.pm.judgement = 'done';

    s.clock.advance(241_000); await s.engine.tick(); // #1 → replan
    s.clock.advance(241_000); await s.engine.tick(); // #2 → replan
    s.clock.advance(481_000); await s.engine.tick(); // #3 → 三振 blocked
    expect(s.engine.store.countEvents(issue.id, 'replan_requested')).toBe(2);
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.engine.store.countEvents(issue.id, 'judge_exhausted')).toBe(0);
  });
});

describe('三级完成判定：nudge(180s) → PM 保守判(360s)；limit 与解析解耦', () => {
  test('完整 JSONL 增长重置 fallback：nudge 后只有 thinking/tool_use 也不误判且可重新计时催促', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '长工具调用' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff，建立旧 activity/fed 基线
    await s.appendOutput(jl, asst('先读取现有实现')); // 给 fallback 留一段可判定的 assistant 尾巴
    await s.engine.tick();

    s.clock.advance(181_000);
    await s.engine.tick(); // 先触发一次 nudge，nudged=true
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    s.clock.advance(361_000); // 已超过 fallback 窗口，此刻新增非 assistant/tool_result 进度
    await s.appendOutput(
      jl,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '仍在分析大型代码库' },
            { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      }),
    );
    await s.engine.tick();

    expect(s.pm.judgeCalls).toBe(0);
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    // #273：第 2 次催办的静默阈值退避到 nudgeSec*2=240s，所以这里要多等一轮
    s.clock.advance(241_000);
    await s.engine.tick(); // 增长已清 nudged，并从增长时刻重新计时，允许新一轮催促
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(2);
  });

  test('完整 JSONL 增长即刷新判活：有效但不产出消息的记录也不误催、误判', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '持续写进度元数据' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff，建立旧 activity/fed 基线

    s.clock.advance(181_000);
    await s.appendOutput(jl, JSON.stringify({ type: 'progress', completed: 42 }));
    await s.engine.tick();

    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(0);
    expect(s.pm.judgeCalls).toBe(0);
  });

  test('nudge 的 plain user 回显不算代理进展：越过 fallback 后应 judge 而不是重新 nudge', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '回显不能续命' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst('正在处理任务'));
    await s.engine.tick(); // 给 judge recent 留 assistant 内容

    s.clock.advance(181_000);
    await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    await s.appendOutput(jl, userText('请继续；完成后按格式输出哨兵'));
    await s.engine.tick(); // 模拟 CLI 把刚注入的 nudge 原样记为 user
    s.clock.advance(361_000);
    await s.engine.tick();

    expect(s.pm.judgeCalls).toBe(1);
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);
  });

  test('安静 180s nudge 一次；360s 后 PM 判 done 推进（CAS 竞态防护路径）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 E' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff 子任务 1
    // 有点动静（judge 窗口要有内容），随后彻底安静
    await s.appendOutput(jl, asst('我先看看现有代码结构'));
    await engine.tick();

    // 安静 181s → nudge（只发一次）
    clock.advance(181_000);
    await engine.tick();
    const nudges = s.driver.prompts().filter((t) => t.includes(`SUBTASK_DONE:${issue.id}`) && t.includes('没完成请继续'));
    expect(nudges.length).toBe(1);
    await engine.tick();
    expect(
      s.driver.prompts().filter((t) => t.includes('没完成请继续')).length,
    ).toBe(1);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    // 再安静 361s → PM 判 done → implementing 收尾进 testing
    s.pm.judgement = 'done';
    clock.advance(361_000);
    await engine.tick();
    expect(s.pm.judgeCalls).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    expect(engine.store.countEvents(issue.id, 'judged')).toBe(1);
  });

  test('会话失效自动重新认领：nudge 后仍零增长 → 重绑新 jsonl，末尾起 tail + 立即再催', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC' });
    await s.bindJsonl(issue.id); // 绑定的「死」jsonl：之后永远零增长
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ '; // pane 有 CC 输入框特征（真会话活着，只是绑定错了）
    await engine.tick(); // kickoff 子任务 1（fedTs 起点）

    // pane 里真正活着的会话写的是另一个 jsonl；其中换绑前就存在的哨兵不得被重放
    const jl2 = path.join(s.dir, 'reclaimed.jsonl');
    await fsp.writeFile(jl2, asst(`SUBTASK_DONE:${issue.id}`) + '\n');
    s.locator.reclaimTo = jl2;

    // 181s 静默 → 先 nudge（还不 reclaim：先催后认领）
    clock.advance(181_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(0);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    // nudge 后 61s 仍零增长 → reclaim：重绑 + 记事件 + 立即再催
    clock.advance(61_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_reclaimed')).toBe(1);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(2);
    // 换绑前已存在的 SUBTASK_DONE 不重放（新文件末尾起 tail）
    expect(engine.store.get(issue.id)!.subIndex).toBe(0);

    // 新会话的新输出正常消费 → 子任务推进
    await s.appendOutput(jl2, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.subIndex).toBe(1);
  });

  test('会话失效但 pane 无输入框特征：不 reclaim（走 kickoff 超时/人工路径）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC3' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    // pane 保持空（无 ❯/╭─）：即使注入后零增长也不该 reclaim——真会话可能根本没起来
    await engine.tick(); // kickoff（ccReady 靠 jsonl 存在）
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(61_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(0);
  });

  test('consecutiveJudgedDone：连续 done 计数、非 done 断连、锚点截断', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '计数器' });
    const st = engine.store;
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(2);
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'not_done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(0); // 非 done 断连
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(1);
    // 锚点在最后一条 done 之后 → 不计更早的
    const maxId = (s.db.query<{ m: number }, [number]>(
      'SELECT MAX(id) m FROM issue_events WHERE issue_id = ?',
    ).get(issue.id))!.m;
    expect(st.consecutiveJudgedDone(issue.id, maxId)).toBe(0);
  });

  test('consecutiveJudged：末尾同结论连击、结论一变即断、锚点截断（#273 退避依据）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '同结论连击' });
    const st = engine.store;

    expect(st.consecutiveJudged(issue.id, 0)).toEqual({ result: null, streak: 0 });

    st.logEvent(issue.id, 'judged', { stage: 'implementing', result: 'not_done' });
    st.logEvent(issue.id, 'judged', { stage: 'implementing', result: 'not_done' });
    st.logEvent(issue.id, 'judged', { stage: 'implementing', result: 'not_done' });
    // consecutiveJudgedDone 对 not_done 一律返回 0，这正是它治不了 B-04 的原因
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(0);
    expect(st.consecutiveJudged(issue.id, 0)).toEqual({ result: 'not_done', streak: 3 });

    // 结论一变 streak 归 1：现场在动，退避间隔应随之落回基准
    st.logEvent(issue.id, 'judged', { stage: 'implementing', result: 'clarify' });
    expect(st.consecutiveJudged(issue.id, 0)).toEqual({ result: 'clarify', streak: 1 });

    // 锚点截断：人工介入之后从头数
    const maxId = (s.db.query<{ m: number }, [number]>(
      'SELECT MAX(id) m FROM issue_events WHERE issue_id = ?',
    ).get(issue.id))!.m;
    expect(st.consecutiveJudged(issue.id, maxId)).toEqual({ result: null, streak: 0 });

    // 坏事件当断点处理：宁可少数一次（退避变短），也不要把不同结论串成一条
    const other = await engine.createIssue(s.projectId, { title: '坏事件' });
    st.logEvent(other.id, 'judged', { stage: 'implementing', result: 'not_done' });
    s.db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)')
      .run(other.id, 'judged', '{坏', Date.now());
    expect(st.consecutiveJudged(other.id, 0)).toEqual({ result: null, streak: 0 });
  });

  test('会话失效但无可认领候选：不动原绑定，落错误事件且按冷却重试', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC2' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ ';
    await engine.tick(); // kickoff
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(61_000);
    await engine.tick(); // reclaim 落空
    expect(s.locator.reclaimCalls).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_reclaimed')).toBe(0);
    await engine.tick(); // 冷却期内不重试
    expect(s.locator.reclaimCalls).toBe(1);
    // #273：一次失败后冷却退避到 sessionStaleMs*2=120s，61s 还不够
    clock.advance(61_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(1);
    clock.advance(61_000);
    await engine.tick(); // 冷却过后再试
    expect(s.locator.reclaimCalls).toBe(2);
  });

  // ---- #273 / B-05：reclaim 退避与升级 ----

  /** 造一条「注入后 jsonl 零增长、但屏面有输入框」的 issue —— reclaim 的触发前提 */
  const staleIssue = async (s: Awaited<ReturnType<typeof setup>>, title: string) => {
    const issue = await s.engine.createIssue(s.projectId, { title });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ ';
    await s.engine.tick(); // kickoff
    s.clock.advance(181_000);
    await s.engine.tick(); // nudge：先催后认领
    return issue;
  };

  test('reclaim 冷却按连续失败指数退避：60 → 120 → 240s（#273 / B-05）', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, reclaimMaxFailures: 99 } });
    const issue = await staleIssue(s, '一直认不到');

    s.clock.advance(61_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(1); // 第 1 次仍是 sessionStaleMs 基准

    s.clock.advance(61_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(1); // 退避到 120s，61s 不够
    s.clock.advance(61_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(2);

    s.clock.advance(121_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(2); // 退避到 240s，121s 不够
    s.clock.advance(121_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(3);

    // 一路只落 reclaim 空转事件，不升级（本例把上限调得很高）
    expect(s.engine.store.countEvents(issue.id, 'agent_down')).toBe(0);
  });

  test('连续失败到上限：判会话确已丢失 → 转 agent_down 恢复路径，不再空转重扫（#273 / B-05）', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } }); // reclaimMaxFailures 默认 3
    const issue = await staleIssue(s, '会话真的没了');

    s.clock.advance(61_000); await s.engine.tick();  // 失败 1
    s.clock.advance(121_000); await s.engine.tick(); // 失败 2（退避 120s）
    expect(s.engine.store.countEvents(issue.id, 'agent_down')).toBe(0);

    s.clock.advance(241_000); await s.engine.tick(); // 失败 3（退避 240s）→ 升级
    expect(s.locator.reclaimCalls).toBe(3);
    expect(s.engine.store.countEvents(issue.id, 'agent_down')).toBe(1);
    expect(s.engine.store.countEvents(issue.id, 'agent_restarted')).toBe(1);

    // 重起后 resetWatch，本 tick 不再往旧 watch 注入，也不接着重扫
    s.clock.advance(61_000); await s.engine.tick();
    expect(s.locator.reclaimCalls).toBe(3);
  });

  test('认领成功清零失败数：之后要重新攒满次数才升级（#273 / B-05）', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0, reclaimMaxFailures: 2 } });
    const issue = await staleIssue(s, '认到了又丢');

    s.clock.advance(61_000); await s.engine.tick(); // 失败 1
    expect(s.locator.reclaimCalls).toBe(1);

    // 第 2 次给出新会话 → 认领成功，失败数清零
    const next = path.join(s.dir, 'reclaimed.jsonl');
    await fsp.writeFile(next, '');
    s.locator.reclaimTo = next;
    s.clock.advance(121_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'session_reclaimed')).toBe(1);

    // 重新造一轮「催了也不长」：先让 tail 增长清掉 nudged，再催一次
    s.locator.reclaimTo = null;
    await fsp.appendFile(next, asst('动了一下') + '\n');
    await s.engine.tick();
    s.clock.advance(481_000); await s.engine.tick(); // 第 3 次催办（催办退避到 480s）

    // 若失败数没被清零，上限 2 会在这一次就升级；清零了则还差一次
    s.clock.advance(61_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'agent_down')).toBe(0);
    s.clock.advance(121_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'agent_down')).toBe(1);
  });

  test('会话自愈：tmux 会话消失 → 自动重建 --resume + 恢复事件一次，接续催办驱动（issue #88）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '自愈' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff 子任务 1
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);
    expect(s.driver.tmuxSessions.has(session)).toBe(true);

    // 模拟 systemd 重启连坐：tmux 会话没了（capturePane 抓不到 → pane 空）
    s.driver.tmuxSessions.clear();
    const sentBefore = s.driver.sent.length;
    await engine.tick();
    // 会话被重建，且 jsonl 已落地 → --resume 续上下文
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
    expect(
      s.driver.sent.slice(sentBefore).some((x) => x.session === session && x.text === `claude --resume ${convId}`),
    ).toBe(true);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
    // kickoff 幂等：implementing 阶段已注入过，不重发子任务 prompt
    expect(s.driver.prompts().filter((t) => t.includes('【实施 子任务 1/1】')).length).toBe(1);

    // 接续驱动：静默 181s → 既有催办机制在新会话上催活；不再重复恢复
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
  });

  test('会话自愈失败进冷却：不向死会话注入、错误只落一次，冷却过后重试成功', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '自愈冷却' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);

    // 会话没了，且 tmux 起不来（createSession 一直失败）
    s.driver.tmuxSessions.clear();
    const orig = s.driver.createSession.bind(s.driver);
    let broken = true;
    s.driver.createSession = async (name: string, cwd: string) => {
      if (broken) throw new Error('tmux 挂了');
      return orig(name, cwd);
    };
    const sentBefore = s.driver.sent.length;
    await engine.tick(); // 尝试重建 → 失败落一次错误
    await engine.tick(); // 冷却期：静默跳过，不重试
    await engine.tick();
    const recoverErrors = () =>
      engine.store
        .listEvents(issue.id)
        .filter((e) => e.kind === 'error' && (e.dataJson ?? '').includes('recover')).length;
    expect(recoverErrors()).toBe(1);
    expect(s.driver.sent.length).toBe(sentBefore); // 冷却期对死会话零注入

    // 冷却过后 tmux 修好了 → 重试重建成功
    broken = false;
    clock.advance(61_000);
    await engine.tick();
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
    expect(recoverErrors()).toBe(1);
  });

  test('会话已消失且 Agent CLI 不存在：立即 blocked，不留在 driving 态反复恢复', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '缺会话且 Claude 未安装' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick();

    s.driver.tmuxSessions.clear();
    s.driver.executables.delete('claude');
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.driver.sent.length).toBe(sentBefore);
    expect(
      engine.store
        .listEvents(issue.id)
        .some((event) => event.kind === 'transition' && (event.dataJson ?? '').includes('找不到 Claude 可执行文件')),
    ).toBe(true);
  });

  test('激活绑定丢失且 Agent CLI 不存在：立即 blocked，不静默冻结', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '激活绑定丢失且 Claude 未安装' });
    await s.bindJsonl(issue.id);
    s.driver.tmuxSessions.clear();
    s.driver.executables.delete('claude');
    s.db.query('DELETE FROM project_active_conv WHERE project_id = ?').run(s.projectId);
    const sentBefore = s.driver.sent.length;

    await engine.tick();

    expect(engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.driver.sent.length).toBe(sentBefore);
  });

  // ---- issue #97：注入前的代理存活门禁 ----

  /** 驱动中的 issue：kickoff 已发，静默到该催办的时刻——此后每 tick 都会想注入点什么 */
  async function drivingIssue(title: string): Promise<{
    s: Awaited<ReturnType<typeof setup>>;
    issueId: number;
    convId: string;
    session: string;
  }> {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ ';
    await s.engine.tick(); // kickoff
    const convId = s.engine.store.get(issue.id)!.convId!;
    return { s, issueId: issue.id, convId, session: s.convs.tmuxName(s.projectId, convId) };
  }

  test('代理退回 bash：本 tick 零注入 + 强制重启 --resume + agent_down/agent_restarted（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('退回 bash');
    const { engine, clock } = s;
    expect(s.driver.tmuxSessions.has(session)).toBe(true);

    // 代理退出：tmux 会话还在（#88 的自愈不会触发），窗格只剩 shell
    s.driver.pane = `[root@VM p]# claude --resume ${convId}\n[root@VM p]#`;
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(181_000); // 早就该催办了：不设门禁的话这一 tick 会把催办打进 bash
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.countEvents(issueId, 'nudged')).toBe(0); // 一个字都没往 shell 里注
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
    // 唯一的新 send 是重启命令本身，且 --resume 续上下文（不新开会话）
    const after = s.driver.sent.slice(sentBefore);
    expect(after).toEqual([{ session, text: `claude --resume ${convId}` }]);
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
  });

  // 2026-07-27 生产误杀事故：#99 的代理 10:29:28 发起 tool_use:Bash（前台变 bash、屏幕被命令
  // 输出刷掉），10:29:52 就被判死 kill 掉，24 秒的沉默足够触发。会话文件是独立第三方证据——
  // 死代理永远不会再写，所以「最近写过」必须一票否决屏幕与前台命令。
  test('Codex resume 冲突经管家判定后 blocked 且不重启', async () => {
    const { s, issueId, session } = await drivingIssue('resume 冲突');
    s.db.query("UPDATE issues SET agent = 'codex' WHERE id = ?").run(issueId);
    s.driver.pane = 'Cannot resume: another active writer owns this session\n[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    s.pm.failureJudgement = 'resume_conflict';
    s.clock.advance(181_000);
    const before = s.driver.sent.length;
    await s.engine.tick();
    expect(s.engine.store.get(issueId)!.status).toBe('blocked');
    expect(s.pm.failureCalls).toBe(1);
    expect(s.driver.sent.slice(before)).toHaveLength(0);
    expect(s.engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);
  });

  test('代理正在跑前台命令（jsonl 刚写过）→ 屏幕和前台命令双双像 shell 也绝不重启（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('别误杀在跑的代理');
    const { engine, clock } = s;
    s.driver.pane = '  PASS  src/foo.test.ts\n[root@VM repo]#'; // 命令输出把代理 UI 刷没了
    s.driver.paneCommands.set(session, 'bash'); // 前台确实是 bash

    clock.advance(24_000); // 只沉默了 24s——正是事故里的时长
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);

    // 真死了（久久不写）才允许判死
    clock.advance(61_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
  });

  test('重启冷却：冷却期内不重复 kill，过后才再重启一次（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('重启冷却');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸（jsonl 静默 ≥60s）

    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
    // 重启后代理仍没起来（窗格还是 bash）：冷却期内只是静默跳过，绝不连环 kill
    await engine.tick();
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);

    clock.advance(61_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(2);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(2);
    expect(s.driver.sent.filter((x) => x.text === `claude --resume ${convId}`).length).toBe(2);
  });

  test('健康路径零额外 tmux 调用：屏面是代理 UI 就不查 listSessions（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('健康路径');
    const { engine, clock } = s;
    s.driver.pane = '❯ ';
    s.driver.listCalls = 0;
    clock.advance(181_000);
    await engine.tick(); // 正常催办
    expect(s.driver.listCalls).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
  });

  test('前台命令是 claude → 不重启（屏上出现 shell 提示符也不误杀在跑的代理，issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('别误杀');
    const { engine, clock } = s;
    // 代理正在跑 Bash 工具，屏面末行像提示符——只有前台命令能证明它还活着
    s.driver.pane = '⏺ Bash(ls -la)\n  ⎿ [root@VM p]#';
    s.driver.paneCommands.set(session, 'claude');
    clock.advance(181_000);
    await engine.tick();
    expect(s.driver.listCalls).toBeGreaterThan(0); // 可疑 → 花了一次核对
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1); // 照常催办
  });

  test('拿不到前台命令且屏面说不清 → unknown，保守不动（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('说不清');
    const { engine, clock } = s;
    s.driver.pane = '正在编译…'; // 无 UI 特征、无提示符，listSessions 也没给 command
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1);
  });

  test('重启必须无条件：换成 activate 那种「会话还在就短路」修不好这种壳（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('无条件重启');
    const { engine } = s;
    // 引擎抓到的是 shell；等 ConversationManager 自己再抓一次时屏面已经变了（残影/翻页）。
    // 走 activate 的话它会判 unknown 而短路 → 壳永远修不好；relaunch 不看这些，直接重起。
    let n = 0;
    const shellPane = `[root@VM p]# claude --resume ${convId}\n[root@VM p]#`;
    s.driver.capturePane = async () => (n++ === 0 ? shellPane : '❯ ');
    s.driver.paneCommands.set(session, 'bash');
    s.clock.advance(61_000); // 过判死硬闸

    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(s.driver.sent.filter((x) => x.text === `claude --resume ${convId}`).length).toBe(1);
  });

  test('listSessions 抛错 → unknown，绝不当死会话杀（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('判活失败');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#'; // 可疑 → 要核对，但核对本身失败了
    s.driver.listSessions = async () => {
      throw new Error('执行机不可达');
    };
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);
  });

  test('重启后接着跑：等代理真就绪才补催办，启动中不盲注（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('重启接续');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸
    await engine.tick(); // 判死 → 重启
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);

    // 新进程还在启动：没有输入框特征（jsonl 早就在，ccReady 骗不了人）→ 先不注入
    s.driver.pane = 'Starting…';
    s.driver.paneCommands.set(session, 'node');
    const sentAfterRestart = s.driver.sent.length;
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(0);
    expect(s.driver.sent.length).toBe(sentAfterRestart);

    // 输入框画出来了 → 补一次催办接着干
    s.driver.pane = '❯ ';
    s.driver.paneCommands.set(session, 'claude');
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(1);
    expect(s.driver.prompts().at(-1)).toContain('子任务');

    // 只补一次，不会每 tick 都催
    clock.advance(1000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(1);
  });

  test('连续重启到上限仍是 shell → block 并通知（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('起不来');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#'; // 重启多少次都只剩 shell（模拟登录过期）
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸

    for (let i = 0; i < MAX_AGENT_RESTARTS; i++) {
      await engine.tick();
      clock.advance(61_000); // 过冷却
    }
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS);
    expect(engine.store.get(issueId)!.status).not.toBe('paused');

    await engine.tick(); // 第 4 次判死：不再重启，交人工
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS);
    expect(engine.store.get(issueId)!.status).toBe('paused');
    // 原因写进 transition 事件 + issue_blocked 通知（人得知道是「代理起不来」而不是任务本身失败）
    expect(
      engine.store
        .listEvents(issueId)
        .some((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('代理起不来')),
    ).toBe(true);
    expect(
      s.notifications.some(
        (n) => n.kind === 'status_change' && n.to === 'paused' && n.issueId === issueId &&
          String(n.summaryParams?.detail ?? '').includes('代理起不来'),
      ),
    ).toBe(true);
  });

  test('重启计数跨 resetWatch 传递，确认代理活着后清零（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('计数不丢');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸
    await engine.tick(); // 重启 1（内部 resetWatch，计数不能被抹掉）
    clock.advance(61_000);
    await engine.tick(); // 重启 2

    // 代理真起来了 → 计数清零：之后再坏一次也是从头数，不会因为历史欠账提前 block
    s.driver.pane = '❯ ';
    s.driver.paneCommands.set(session, 'claude');
    await engine.tick();

    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    for (let i = 0; i < MAX_AGENT_RESTARTS; i++) {
      clock.advance(61_000);
      await engine.tick();
    }
    expect(engine.store.get(issueId)!.status).not.toBe('blocked'); // 清零过 → 还没到上限
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS + 2);
  });

  test('重启失败：落一次 error 且仍然零注入（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('重启失败');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    s.driver.createSession = async () => {
      throw new Error('tmux 挂了');
    };
    clock.advance(181_000);
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);
    expect(
      engine.store.listEvents(issueId).filter((e) => e.kind === 'error' && (e.dataJson ?? '').includes('agentRestart'))
        .length,
    ).toBe(1);
    expect(s.driver.sent.length).toBe(sentBefore); // 死会话零注入
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(0);
  });

  test('Agent CLI 已不存在时重启立即 blocked，不在 shell 中循环注入或空等三轮', async () => {
    const { s, issueId, session } = await drivingIssue('Claude 未安装');
    const { engine, clock } = s;
    s.driver.executables.delete('claude');
    s.driver.pane = 'zsh: command not found: claude\n~/repo ❯';
    s.driver.paneCommands.set(session, 'zsh');
    clock.advance(181_000);
    const sentBefore = s.driver.sent.length;

    await engine.tick();

    expect(engine.store.get(issueId)!.status).toBe('paused');
    expect(s.driver.sent.length).toBe(sentBefore);
    expect(
      engine.store
        .listEvents(issueId)
        .some((event) => event.kind === 'transition' && (event.dataJson ?? '').includes('找不到 Claude 可执行文件')),
    ).toBe(true);
  });

  test('planning 判 done 死循环出口：前两次注入重输出指令并允许再催，第三次转 blocked', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '规划死循环' });
    const jl = await s.bindJsonl(issue.id);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    await engine.tick(); // kickoff planning
    await s.appendOutput(jl, asst('规划完了（但没按格式输出块）'));
    await engine.tick(); // 消费活动，judge 窗口有内容
    s.pm.judgement = 'done';

    const replans = () => s.driver.prompts().filter((t) => t.includes('重新完整输出')).length;
    // planning nudge 新文案（去掉了无条件「别停下来等我」，附 NEED_CLARIFY 逃生口）
    const nudges = () => s.driver.prompts().filter((t) => t.includes('子任务规划好了就')).length;

    // 第 1 轮：180s 静默先 nudge，360s 判 done → 重输出指令（不推进不 block）
    clock.advance(181_000);
    await engine.tick();
    expect(nudges()).toBe(1);
    clock.advance(361_000);
    await engine.tick();
    expect(replans()).toBe(1);
    expect(engine.store.countEvents(issue.id, 'replan_requested')).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 重输出指令重置了 nudge 状态 → 第 2 轮还能再催、再判、再指令
    // （#273：第 2 次催办阈值退避到 240s）
    clock.advance(241_000);
    await engine.tick();
    expect(nudges()).toBe(2);
    clock.advance(361_000);
    await engine.tick();
    expect(replans()).toBe(2);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 第 3 轮：连续第 3 次判 done 仍无子任务块 → 转 blocked + issue_blocked 通知
    // （#273：第 3 次催办阈值退避到 480s）
    clock.advance(481_000);
    await engine.tick();
    expect(nudges()).toBe(3);
    clock.advance(361_000);
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('paused');
    expect(replans()).toBe(2); // 第三次不再指令，直接兜底
    expect(
      s.notifications.some((n) => n.kind === 'status_change' && n.to === 'paused' && String(n.summaryParams?.detail ?? '').includes('SUBTASKS')),
    ).toBe(true);
  });

  test('planning 判 done 后补上子任务块 → 正常推进且不再累计 strikes', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '规划迟到' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff
    await s.appendOutput(jl, asst('先想想'));
    await engine.tick();
    s.pm.judgement = 'done';
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(361_000);
    await engine.tick(); // 判 done → 重输出指令
    expect(engine.store.countEvents(issue.id, 'replan_requested')).toBe(1);
    // 代理响应指令补发块 → 正常走 plan_review
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 子任务甲\nSUBTASKS_END'));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('plan_review');
  });

  test('limit 命中不吞同批哨兵（解析在前，退避在后）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 F' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    // 同一批：一个 SUBTASK_DONE + 一句 limit 文案
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`), asst('You have hit your usage limit, try later'));
    await engine.tick();
    const cur = engine.store.get(issue.id)!;
    expect(cur.subIndex).toBe(1); // 哨兵没丢
    expect(engine.store.countEvents(issue.id, 'limit')).toBe(1); // 退避也记了
  });

  test('弹窗滞留超时 → 通知 + 事件（v1 黑洞 H16 防线）；有弹窗不 kickoff', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 G' });
    await s.bindJsonl(issue.id);
    s.driver.pane = '│ Do you want to proceed?\n ❯ 1. Yes\n   2. No\n';
    const before = s.driver.prompts().length;
    await engine.tick(); // 菜单挂着 → 不 kickoff，记 menuSince
    expect(s.driver.prompts().length).toBe(before);
    clock.advance(6 * 60 * 1000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'menu_stuck')).toBe(1);
    const stuck = s.notifications.find((n) => n.summaryCode === 'menu_stuck')!;
    expect(stuck).toBeTruthy();
    // #275 / B-07：状态并没有进 blocked，发受阻通知会让人去找一个不存在的故障
    expect(stuck.kind).toBe('choice_waiting');
    expect(engine.store.get(issue.id)!.status).not.toBe('blocked');
    // 菜单消失后恢复 kickoff
    s.driver.pane = '';
    await engine.tick();
    expect(s.driver.prompts().length).toBeGreaterThan(before);
  });

  test('codex 升级弹窗：自动选升级（冷却防重复），弹窗消失后恢复 kickoff', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '升级弹窗', agent: 'codex' });
    await s.bindJsonl(issue.id);
    const ones = () => s.driver.sent.filter((x) => x.text === '1').length;
    s.driver.pane = 'Update available! 0.144.6 -> 0.145.0\n› 1. Update now\n  2. Skip\nPress enter to continue\n';
    await engine.tick();
    expect(ones()).toBe(1); // 自动选「Update now」
    expect(engine.store.countEvents(issue.id, 'codex_update')).toBe(1);
    // 弹窗未消失：冷却期内不重复打 1，也不往弹窗里灌 kickoff prompt
    await engine.tick();
    expect(ones()).toBe(1);
    expect(s.driver.prompts().filter((t) => t.includes('SUBTASKS_BEGIN')).length).toBe(0);
    // 30s 冷却过后弹窗仍在 → 再点一次
    clock.advance(31_000);
    await engine.tick();
    expect(ones()).toBe(2);
    // 弹窗消失（升级完回到 composer）→ 恢复 kickoff planning
    s.driver.pane = '› ';
    await engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('codex › 菜单纳入滞留告警（menu_stuck 对 codex 生效）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: 'codex 弹窗滞留', agent: 'codex' });
    await s.bindJsonl(issue.id);
    s.driver.pane = '  Allow command?\n› 1. Yes, run it\n  2. No, tell me what to do\n';
    const before = s.driver.prompts().length;
    await engine.tick(); // 菜单挂着 → 不 kickoff，记 menuSince
    expect(s.driver.prompts().length).toBe(before);
    clock.advance(6 * 60 * 1000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'menu_stuck')).toBe(1);
    expect(s.notifications.some((n) => n.summaryCode === 'menu_stuck')).toBe(true);
  });

  test('blocked 接力：不建/不切分支，靠 impl_base 起点把 B 的范围与 A 的残留提交隔开', async () => {
    const s = await setup();
    const { engine } = s;

    // issue A → implementing，在当前分支（main）上留一个提交（引擎不建 issue 分支）
    const a = await engine.createIssue(s.projectId, { title: '功能 A', module: 'm' });
    const jlA = await s.bindJsonl(a.id);
    await engine.tick(); // kickoff planning
    await s.appendOutput(jlA, asst('SUBTASKS_BEGIN\n1. 写 A\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const gA = engine.store.listGates(a.id)[0]!;
    expect((await engine.decideGate(gA.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(a.id)!.status).toBe('implementing');
    expect(engine.store.get(a.id)!.branch).toBe('main');
    await fsp.writeFile(path.join(s.repo, 'a.ts'), 'a\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'wip-A-残留']);
    const wipASha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // 排队 issue B（项目忙 → pending）
    const b = await engine.createIssue(s.projectId, { title: '功能 B', module: 'm' });
    expect(engine.store.get(b.id)!.status).toBe('pending');

    // A 被哨兵 blocked → 不切分支（仍在 main，A 的提交留在原地）→ 接力 B
    await s.appendOutput(jlA, asst(`ISSUE_BLOCKED:${a.id} 卡住了`));
    await engine.tick();
    expect(engine.store.get(a.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.get(b.id)!.status).toBe('planning');

    // B 推进到 implementing → 起点 impl_base = 当前 HEAD（含 A 的残留），据此 B 的净范围不含 A 的提交
    const jlB = await s.bindJsonl(b.id);
    await engine.tick(); // kickoff B planning
    await s.appendOutput(jlB, asst('SUBTASKS_BEGIN\n1. 写 B\nSUBTASKS_END'));
    await engine.tick();
    const gB = engine.store.listGates(b.id)[0]!;
    expect((await engine.decideGate(gB.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(b.id)!.status).toBe('implementing');
    expect(engine.store.get(b.id)!.branch).toBe('main');
    // 隔离靠 commit 范围而非分支：B 的起点就是 A 残留那条，故 B 的净提交范围排除 wip-A-残留
    expect(engine.implBaseSha(b.id)).toBe(wipASha);
    // A 的残留提交仍安全保留在 main 上（未被回滚，可人工处理）
    expect((await s.g(['log', '--oneline', 'main'])).out).toContain('wip-A-残留');
  });
});

describe('I1 迁移/失忆恢复：无激活对话的驱动中 issue 自行激活', () => {
  test('DB 直插 implementing（conv 登记但无 project_active_conv 行）→ tick 激活对话 + kickoff', async () => {
    const s = await setup();
    const { engine, convs, driver } = s;
    // 模拟迁移产物：conversations 有行、issue 卡在 implementing、无激活行
    const conv = convs.create(s.projectId, '迁移来的对话');
    const issue = await engine.createIssue(s.projectId, { title: '迁移任务' }, false);
    engine.store.setConv(issue.id, conv.id);
    engine.store.setSubtasks(issue.id, ['继续实现导出']);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(issue.id);
    // 迁移对话有历史 jsonl（--resume 路径）
    const p = path.join(s.dir, `${conv.id}.jsonl`);
    await fsp.writeFile(p, '');
    s.jsonl.set(conv.id, p);

    expect(convs.currentConv(s.projectId)).toBeUndefined();
    await engine.tick();
    // 对话被激活（--resume：jsonl 已存在），且 kickoff 已注入子任务 prompt
    expect(convs.currentConv(s.projectId)).toBe(conv.id);
    expect(driver.sent.some((x) => x.text.startsWith('claude --resume'))).toBe(true);
    expect(driver.prompts().some((t) => t.includes(`SUBTASK_DONE:${issue.id}`))).toBe(true);
  });

  test('plan_review approve 且项目无激活对话 → 进 implementing 时同样激活', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const conv = convs.create(s.projectId, '迁移对话');
    const issue = await engine.createIssue(s.projectId, { title: '待批计划' }, false);
    engine.store.setConv(issue.id, conv.id);
    engine.store.setSubtasks(issue.id, ['a']);
    s.db.query(`UPDATE issues SET status = 'plan_review' WHERE id = ?`).run(issue.id);
    const gate = engine.store.createGate(issue.id, 'plan', {});

    expect(convs.currentConv(s.projectId)).toBeUndefined();
    const r = await engine.decideGate(gate.id, s.admin.id, 'approve');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(convs.currentConv(s.projectId)).toBe(conv.id); // onEnter(implementing) 补激活
  });

  test('已有别的激活对话时不夺占（浏览优先语义不回归）', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const browsing = convs.create(s.projectId, '用户在看的');
    await convs.activate(browsing.id);
    const conv = convs.create(s.projectId, 'issue 的');
    const issue = await engine.createIssue(s.projectId, { title: 'T' }, false);
    engine.store.setConv(issue.id, conv.id);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(issue.id);
    await engine.tick();
    expect(convs.currentConv(s.projectId)).toBe(browsing.id); // 没被抢
  });
});

describe('I2 门禁跳过可观测：conv_displaced 事件+通知一次，恢复后重置', () => {
  test('对话被切走 → 首次记事件+通知；重复 tick 不刷屏；切回再切走重新计一次', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const issue = await engine.createIssue(s.projectId, { title: '被让位' });
    await s.bindJsonl(issue.id);
    await engine.tick(); // 正常驱动一轮（kickoff）

    // 用户浏览：激活另一条对话 → 引擎让位
    const other = convs.create(s.projectId, '浏览');
    await convs.activate(other.id);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(1);
    expect(s.notifications.filter((n) => n.summaryCode === 'conversation_displaced').length).toBe(1);
    await engine.tick(); // 去重：不重复
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(1);
    expect(s.notifications.filter((n) => n.summaryCode === 'conversation_displaced').length).toBe(1);

    // 切回 issue 对话 → 标志复位；再切走 → 第二次事件
    await convs.activate(engine.store.get(issue.id)!.convId!);
    await engine.tick();
    await convs.activate(other.id);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(2);
    expect(s.notifications.filter((n) => n.summaryCode === 'conversation_displaced').length).toBe(2);
  });
});

describe('I3 activate 与注入互斥（project→tmux 嵌套锁）', () => {
  test('activate 的 kill+create+send 三连不被并发注入交错', async () => {
    const s = await setup();
    const { engine, driver, mutex } = s;
    const issue = await engine.createIssue(s.projectId, { title: '并发注入' }, false);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const seq: string[] = [];
    driver.killSession = async (name: string) => {
      seq.push('kill');
      driver.tmuxSessions.delete(name);
    };
    driver.createSession = async (name: string) => {
      seq.push('create');
      await sleep(30); // 拉开窗口：无 tmux 锁时注入会插进 create 与 send 之间
      driver.tmuxSessions.add(name);
    };
    driver.sendKeys = async (session: string, text: string) => {
      seq.push(text.startsWith('claude') ? 'send:claude' : `send:${text}`);
      driver.sent.push({ session, text });
    };

    // 模拟 PM/WS 注入者：与引擎同一把 mutex 的 tmuxLockKey，在三连中途尝试注入
    const injector = (async () => {
      while (!seq.includes('create')) await sleep(1);
      await mutex.runExclusive(tmuxLockKey('cc-1'), () => driver.sendKeys('cc-1', 'INJECT'));
    })();
    const [r] = await Promise.all([engine.startIssue(issue.id), injector]);
    expect(r.ok).toBe(true);

    const kill = seq.indexOf('kill');
    const create = seq.indexOf('create');
    const claude = seq.indexOf('send:claude');
    const inject = seq.indexOf('send:INJECT');
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(kill);
    expect(claude).toBeGreaterThan(create);
    // 修复前：inject 落在 create 与 send:claude 之间（文本会打进新起的 bash 被当 shell 命令）
    expect(inject).toBeGreaterThan(claude);
  });
});

describe('I4 kickoff 就绪真检测', () => {
  test('jsonl 未落地且无输入框特征 → 不 kickoff；jsonl 落地后 kickoff', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '等就绪' });
    await s.engine.tick(); // 未就绪（locate=null，pane 空）
    expect(s.driver.prompts().length).toBe(0);

    await s.bindJsonl(issue.id); // jsonl 落地 = CC 已启动
    await s.engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('pane 出现 CC 输入框特征（❯/╭─）即视为就绪（jsonl 尚未定位到也 kickoff）', async () => {
    const s = await setup();
    await s.engine.createIssue(s.projectId, { title: '看屏就绪' });
    s.driver.pane = '╭───────────────╮\n│ ❯ 试试 "fix lint errors" │\n╰───────────────╯';
    await s.engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('超时（默认 120s）仍未就绪 → block（note: CC 启动超时）', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '起不来' });
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('planning'); // 未超时先等
    s.clock.advance(121_000);
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(
      s.notifications.some((n) => n.kind === 'status_change' && n.to === 'paused' &&
        String(n.summaryParams?.detail ?? '').includes('CC 启动超时')),
    ).toBe(true);
    expect(s.driver.prompts().length).toBe(0); // 全程没盲注入过
  });
});

describe('I5/M1 引擎防冻结与优雅停机', () => {
  test('项目 A 卡住不阻塞项目 B；重复 tick 不重入 A；stop 等 A 归还', async () => {
    const s = await setup();
    const inserted = s.db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
       VALUES (?, 1, ?, ?, ?, ?)`,
    ).run('demo-2', s.repo, s.admin.id, '第二个演示项目', Date.now());
    const projectB = Number(inserted.lastInsertRowid);

    const a = await s.engine.createIssue(s.projectId, { title: 'A 卡住' });
    const b = await s.engine.createIssue(projectB, { title: 'B 应继续' });
    await s.bindJsonl(a.id);
    await s.bindJsonl(b.id);
    const sessionA = s.convs.tmuxName(a.projectId, s.engine.store.get(a.id)!.convId!);
    const sessionB = s.convs.tmuxName(b.projectId, s.engine.store.get(b.id)!.convId!);

    let releaseA!: (pane: string) => void;
    const hungPane = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const captures: string[] = [];
    let markBCaptured!: () => void;
    let bCaptured = false;
    const bCaptureLatch = new Promise<void>((resolve) => {
      markBCaptured = () => {
        bCaptured = true;
        resolve();
      };
    });
    s.driver.capturePane = async (session: string) => {
      captures.push(session);
      if (session === sessionB) markBCaptured();
      return session === sessionA ? hungPane : '';
    };

    const firstTick = s.engine.tick();
    // 新实现把 A/B flight 同步登记后用微任务启动；让已排队的 capture 回调各跑一轮。
    await Promise.resolve();
    await Promise.resolve();
    const bDroveBeforeRelease = bCaptured;

    await s.engine.tick(); // A 已在 flight：本次必须直接返回，且不能重入 A
    const aCapturesBeforeRelease = captures.filter((session) => session === sessionA).length;

    let stopped = false;
    const stopP = s.engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeRelease = stopped;
    const capturesAtStop = captures.length;
    await s.engine.tick(); // stop 已关闭入口，不得再 capture 任一项目
    const capturesAfterStoppedTick = captures.length;

    releaseA('');
    await Promise.all([firstTick, stopP]);
    await bCaptureLatch;

    expect(bDroveBeforeRelease).toBe(true);
    expect(aCapturesBeforeRelease).toBe(1);
    expect(stoppedBeforeRelease).toBe(false);
    expect(capturesAfterStoppedTick).toBe(capturesAtStop);
    expect(stopped).toBe(true);
  });

  test('tick 在途超 5 分钟 → console.error 告警一次，单飞标志不重置', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '卡死盘' });
    await s.bindJsonl(issue.id);
    let release!: (v: string) => void;
    const hang = new Promise<string>((r) => {
      release = r;
    });
    s.driver.capturePane = () => hang; // 模拟执行机调用永不归还
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    };
    try {
      const inflight = s.engine.tick(); // 卡在 capturePane
      s.clock.advance(6 * 60 * 1000);
      await s.engine.tick(); // 立即返回并告警
      await s.engine.tick(); // 不重复告警
      const warnings = errs.filter((m) => m.includes('未归还'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`项目 ${s.projectId}`);
      expect(warnings[0]).toContain(`issue #${issue.id}`);
      release('');
      await inflight;
    } finally {
      console.error = orig;
    }
  });

  test('M1 stop() 等待在途 tick 归还后才返回', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '停机等待' });
    await s.bindJsonl(issue.id);
    let release!: (v: string) => void;
    const hang = new Promise<string>((r) => {
      release = r;
    });
    s.driver.capturePane = () => hang;
    const inflight = s.engine.tick();
    let stopped = false;
    const stopP = s.engine.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // 在途 tick 未归还 → stop 等待
    release('');
    await stopP;
    expect(stopped).toBe(true);
    await inflight;
  });
});

describe('M3 通知时序 / M4 归档项目', () => {
  test('同 issue 串行：plan_ready 通知等待期间的 cancel 排队，最终 cancelled 且无 waiting gate', async () => {
    let releasePlanNotify!: () => void;
    let markPlanNotifyEntered!: () => void;
    const planNotifyEntered = new Promise<void>((resolve) => {
      markPlanNotifyEntered = resolve;
    });
    const planNotifyHold = new Promise<void>((resolve) => {
      releasePlanNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.to === 'plan_review') {
          markPlanNotifyEntered();
          await planNotifyHold;
        }
      },
    });
    const issue = await s.engine.createIssue(s.projectId, { title: '通知窗口取消' });
    s.engine.store.setSubtasks(issue.id, ['实现']);

    const planReady = s.engine.applyEvent(issue.id, 'plan_ready');
    await planNotifyEntered;
    expect(s.engine.store.get(issue.id)!.status).toBe('plan_review');
    let cancelSettled = false;
    const cancel = s.engine.cancelIssue(issue.id, s.admin.id).then((result) => {
      cancelSettled = true;
      return result;
    });
    await flushMicrotasks();
    const cancelSettledBeforeRelease = cancelSettled;

    releasePlanNotify();
    const [, cancelResult] = await Promise.all([planReady, cancel]);

    expect(cancelSettledBeforeRelease).toBe(false);
    expect(cancelResult.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
  });

  test('同 issue 串行：merge_review 内部 git await 期间 cancel 排队，不能遗留 waiting gate', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'review 定格窗口取消' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');

    let releaseHead!: () => void;
    let markHeadEntered!: () => void;
    const headEntered = new Promise<void>((resolve) => {
      markHeadEntered = resolve;
    });
    const headHold = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let headCalls = 0;
    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD' && headCalls++ === 0) {
        markHeadEntered();
        await headHold;
      }
      return rawGit(cwd, args);
    };

    const testsPassed = s.engine.applyEvent(issue.id, 'tests_passed');
    await headEntered;
    let cancelSettled = false;
    const cancel = s.engine.cancelIssue(issue.id, s.admin.id).then((result) => {
      cancelSettled = true;
      return result;
    });
    await flushMicrotasks();
    const cancelSettledBeforeRelease = cancelSettled;

    releaseHead();
    const [, cancelResult] = await Promise.all([testsPassed, cancel]);

    expect(cancelSettledBeforeRelease).toBe(false);
    expect(cancelResult.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
  });

  test('merge_review 生成卡点时 Git 抛错 → 安全 blocked，不遗留无 gate 的 review 半状态', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'review Git 异常' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);

    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] === 'symbolic-ref') throw new Error('模拟 Git 命令超时');
      return rawGit(cwd, args);
    };

    expect((await s.engine.applyEvent(issue.id, 'tests_passed')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
    expect(
      s.engine.store
        .listEvents(issue.id)
        .some((event) => event.kind === 'error' && (event.dataJson ?? '').includes('模拟 Git 命令超时')),
    ).toBe(true);
  });

  test('人工重试可为历史遗留的 merge_review 无 gate 状态重新生成卡点', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '恢复 review 卡点' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);
    expect(s.engine.store.casStatus(issue.id, 'testing', 'merge_review')).toBe(true);

    const recovered = await s.engine.retryMissingGate(issue.id, s.admin.id);

    expect(recovered.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('merge_review');
    expect(
      s.engine.store
        .listGates(issue.id)
        .filter((gate) => gate.kind === 'merge_review' && gate.status === 'waiting'),
    ).toHaveLength(1);
    expect(s.engine.store.listEvents(issue.id).some((event) => event.kind === 'gate_retry')).toBe(true);
    expect((await s.engine.retryMissingGate(issue.id, s.admin.id)).ok).toBe(false);
  });

  test('M3：merge 链通知按发生顺序（merge_review→merging 先于 merging→done 与 issue_done）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '顺序' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    await engine.applyEvent(issue.id, 'tests_passed');
    const gate = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    s.notifications.length = 0;
    expect((await engine.decideGate(gate.id, s.admin.id, 'approve')).ok).toBe(true);

    const iMerging = s.notifications.findIndex((n) => n.kind === 'status_change' && n.to === 'merging');
    const iDone = s.notifications.findIndex((n) => n.kind === 'status_change' && n.to === 'done');
    const iIssueDone = s.notifications.findIndex((n) => n.kind === 'issue_done');
    expect(iMerging).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iMerging); // 外层迁移先通知，嵌套 merged 在后
    expect(iIssueDone).toBeGreaterThan(iDone);
  });

  test('M4：项目归档后 listDriving 不含其 issue，tick 不再驱动', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '归档前在跑' });
    await s.bindJsonl(issue.id);
    expect(s.engine.store.listDriving().map((i) => i.id)).toEqual([issue.id]);

    s.db.query(`UPDATE projects SET status = 'archived' WHERE id = ?`).run(s.projectId);
    expect(s.engine.store.listDriving()).toEqual([]);
    await s.engine.tick();
    expect(s.driver.prompts().length).toBe(0); // 没有任何 kickoff/nudge 注入
  });
});

describe('debug 复用对话（busy 集合含 pending 已绑——v1 漏排修复）', () => {
  test('debug 复用空闲对话；pending 已绑的 conv 不算空闲；一 conv 一未关闭 issue 有约束', async () => {
    const s = await setup();
    const { engine, convs } = s;
    // 一条 pending issue 手动绑上 convA（没开跑也算占用——v1 漏了这半截）
    const t1 = await engine.createIssue(s.projectId, { title: '待办' }, false);
    const convA = convs.create(s.projectId, 'A');
    engine.store.setConv(t1.id, convA.id);
    // 一条空闲历史对话
    const freeConv = convs.create(s.projectId, '历史对话');

    const dbg = await engine.createIssue(s.projectId, { title: '修个报错', category: 'debug' }, false);
    const r = await engine.startIssue(dbg.id);
    expect(r.ok).toBe(true);
    const cur = engine.store.get(dbg.id)!;
    expect(cur.status).toBe('planning');
    expect(cur.convId).toBe(freeConv.id); // 复用空闲对话
    expect(cur.convId).not.toBe(convA.id); // pending 已绑的不抢

    // DB 层约束：把别人的 conv 绑给新 issue 直接抛错
    const t3 = await engine.createIssue(s.projectId, { title: '又一条' }, false);
    expect(() => engine.store.setConv(t3.id, convA.id)).toThrow();
  });
});

describe('规划前的 git 身份预检（#272 / B-01）', () => {
  /**
   * 只拦 `git config` 系调用（身份读/写），其余照常走真 git。
   * 用它模拟「执行机没有任何身份」而**不真的去写测试机的 ~/.gitconfig**。
   */
  function stubGitConfig(
    driver: FakeDriver,
    opts: { writeCode?: number; writeErr?: string } = {},
  ): void {
    const real = driver.git.bind(driver);
    driver.git = async (cwd: string, args: string[]) => {
      if (args[0] !== 'config') return real(cwd, args);
      driver.gitCalls.push({ cwd, args: [...args] });
      if (args[1] === '--get') return { code: 1, out: '', err: '' }; // 身份全空
      return { code: opts.writeCode ?? 0, out: '', err: opts.writeErr ?? '' };
    };
  }

  const identityEvent = (s: Awaited<ReturnType<typeof setup>>, issueId: number) => {
    const raw = s.engine.store.listEvents(issueId).find((e) => e.kind === 'git_identity')?.dataJson;
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  };

  test('仓库已有身份：只读不写，落 git_identity{applied:false}', async () => {
    const s = await setup(); // setup 的真仓库已配 local user.name/user.email
    const before = s.driver.gitCalls.length;
    const issue = await s.engine.createIssue(s.projectId, { title: '已有身份' });

    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    expect(identityEvent(s, issue.id)).toMatchObject({ applied: false, scope: null, name: 't', email: 't@t' });
    // 一个字都没动
    expect(s.driver.gitCalls.slice(before).some(({ args }) =>
      args[0] === 'config' && (args[1] === '--global' || args[1] === '--local'))).toBe(false);
  });

  test('身份为空：git_branch_prepared 之前补齐 global，且覆盖「无目标分支」这条 legacy 路径', async () => {
    const s = await setup();
    stubGitConfig(s.driver);
    const before = s.driver.gitCalls.length;

    const issue = await s.engine.createIssue(s.projectId, { title: '缺身份' });

    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    // 这条 issue 没有 targetBranch，走的正是刻意不做任何 Git 观察/变更的 legacy 路径
    expect(s.engine.store.countEvents(issue.id, 'git_branch_prepared')).toBe(0);
    expect(identityEvent(s, issue.id)).toMatchObject({
      applied: true,
      scope: 'global',
      name: 'admin', // run_user 为空 → 退项目属主用户名
      email: 'admin@users.noreply.pandados.local',
    });
    const configCalls = s.driver.gitCalls.slice(before).filter(({ args }) => args[0] === 'config');
    expect(configCalls.map(({ args }) => args)).toEqual([
      ['config', '--get', 'user.name'],
      ['config', '--get', 'user.email'],
      ['config', '--global', 'user.name', 'admin'],
      ['config', '--global', 'user.email', 'admin@users.noreply.pandados.local'],
    ]);
  });

  test('预检失败只记 error{where:git-identity}，绝不把 issue 打成 blocked', async () => {
    const s = await setup();
    stubGitConfig(s.driver, { writeCode: 4, writeErr: 'could not lock config file' });

    const issue = await s.engine.createIssue(s.projectId, { title: '身份写不动' });

    // 补不上身份也照常开跑——自动提交时还有一次自愈重试兜底
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    expect(s.engine.store.countEvents(issue.id, 'git_identity')).toBe(0);
    const err = s.engine.store.listEvents(issue.id)
      .find((e) => e.kind === 'error' && (e.dataJson ?? '').includes('git-identity'));
    expect(err?.dataJson).toContain('could not lock config file');
  });
});

describe('issue 目标/源分支准备', () => {
  test('规划前切换已有目标分支并记录实际分支', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/existing']);

    const issue = await s.engine.createIssue(s.projectId, {
      title: '复用已有分支',
      targetBranch: 'feature/existing',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/existing',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/existing');
    expect(s.engine.store.countEvents(issue.id, 'git_branch_prepared')).toBe(1);
  });

  test('分支准备等待 Git 锁期间仍保持 pending，watcher 不得激活或注入规划会话', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/waiting']);

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const creating = s.engine.createIssue(s.projectId, {
      title: '等待分支准备',
      targetBranch: 'feature/waiting',
    });
    await flushMicrotasks();
    const during = s.engine.store.listByProject(s.projectId).find((i) => i.title === '等待分支准备')!;
    const statusWhileLocked = during.status;
    await s.engine.tick();
    const activeWhileLocked = s.convs.currentConv(s.projectId);
    const promptsWhileLocked = s.driver.prompts().length;

    release();
    const [, issue] = await Promise.all([holder, creating]);
    expect(statusWhileLocked).toBe('pending');
    expect(activeWhileLocked).toBeUndefined();
    expect(promptsWhileLocked).toBe(0);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/waiting',
    });
  });

  test('分支准备期间 pending 删除与 start 串行，不能删掉 issue 却遗留 checkout 副作用', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/delete-race']);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '删除竞态',
      targetBranch: 'feature/delete-race',
    }, false);

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const starting = s.engine.startIssue(issue.id);
    await flushMicrotasks();
    let removeSettled = false;
    const removing = s.engine.removeIssue(issue.id).then((result) => {
      removeSettled = true;
      return result;
    });
    await flushMicrotasks();
    const removeSettledWhilePreparing = removeSettled;

    release();
    const [, startResult, removeResult] = await Promise.all([holder, starting, removing]);
    expect(removeSettledWhilePreparing).toBe(false);
    expect(startResult.ok).toBe(true);
    expect(removeResult.ok).toBe(false);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/delete-race',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/delete-race');
  });

  test('进入 implementing 前在 Git 锁内记录 impl_base，状态发布时锚点已经就绪', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, {
      title: '锁内记录实施起点',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const gate = s.engine.store.listGates(issue.id).find((g) => g.kind === 'plan')!;

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const approving = s.engine.decideGate(gate.id, s.admin.id, 'approve');
    await flushMicrotasks();
    const statusWhileLocked = s.engine.store.get(issue.id)!.status;
    const baseWhileLocked = s.engine.implBaseSha(issue.id);

    release();
    await Promise.all([holder, approving]);
    expect(statusWhileLocked).toBe('plan_review');
    expect(baseWhileLocked).toBeNull();
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.implBaseSha(issue.id)).toBe((await s.g(['rev-parse', 'HEAD'])).out.trim());
  });

  test('目标就是当前分支时允许脏工作区，保持原现场', async () => {
    const s = await setup();
    await s.g(['checkout', '-b', 'feature/current']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'dirty but same branch\n');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '留在当前分支',
      targetBranch: 'feature/current',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/current',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/current');
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('dirty but same branch\n');
  });

  test('目标不存在时可分别从本地分支和本地已知远程跟踪 ref 创建', async () => {
    const local = await setup();
    await local.g(['checkout', '-b', 'source/local']);
    await fsp.writeFile(path.join(local.repo, 'local-source.txt'), 'local\n');
    await local.g(['add', '.']);
    await local.g(['commit', '-m', 'local source']);
    const localSourceSha = (await local.g(['rev-parse', 'HEAD'])).out.trim();
    await local.g(['checkout', 'main']);

    const localIssue = await local.engine.createIssue(local.projectId, {
      title: '从本地源创建',
      targetBranch: 'feature/from-local',
      sourceRef: 'refs/heads/source/local',
    });
    expect(local.engine.store.get(localIssue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/from-local',
    });
    expect((await local.g(['rev-parse', 'HEAD'])).out.trim()).toBe(localSourceSha);

    const remote = await setup();
    const remoteSourceSha = (await remote.g(['rev-parse', 'HEAD'])).out.trim();
    await remote.g(['update-ref', 'refs/remotes/origin/release', remoteSourceSha]);
    const remoteIssue = await remote.engine.createIssue(remote.projectId, {
      title: '从远程源创建',
      targetBranch: 'feature/from-remote',
      sourceRef: 'refs/remotes/origin/release',
    });
    expect(remote.engine.store.get(remoteIssue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/from-remote',
    });
    expect((await remote.g(['rev-parse', 'HEAD'])).out.trim()).toBe(remoteSourceSha);
    expect((await remote.g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).code).not.toBe(0);
  });

  test('跨分支遇到脏工作区时安全 blocked，不切分支也不丢改动', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/clean-target']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'unsaved\n');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '脏现场不能切',
      targetBranch: 'feature/clean-target',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'blocked', branch: null });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('unsaved\n');
    expect(
      s.engine.store.listEvents(issue.id).some(
        (e) => e.kind === 'error' && (e.dataJson ?? '').includes('git-branch'),
      ),
    ).toBe(true);
  });

  test('跨分支 checkout 不覆盖 ignored 本地文件，冲突时保留原内容并转 blocked', async () => {
    const s = await setup();
    const ignoredPath = path.join(s.repo, 'local-cache.txt');
    await fsp.writeFile(path.join(s.repo, '.gitignore'), 'local-cache.txt\n');
    await s.g(['add', '.gitignore']);
    await s.g(['commit', '-m', 'ignore local cache']);
    await s.g(['checkout', '-b', 'feature/tracked-cache']);
    await fsp.writeFile(ignoredPath, 'tracked target content\n');
    await s.g(['add', '-f', 'local-cache.txt']);
    await s.g(['commit', '-m', 'track cache on target']);
    await s.g(['checkout', 'main']);
    await fsp.writeFile(ignoredPath, 'local ignored content\n');
    expect((await s.g(['status', '--porcelain'])).out.trim()).toBe('');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '不要覆盖 ignored 文件',
      targetBranch: 'feature/tracked-cache',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'blocked', branch: null });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.readFile(ignoredPath, 'utf8')).toBe('local ignored content\n');
  });

  test('自动收尾前发现实际分支漂移时转 blocked，不 commit/push 或污染 impl_tip', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '分支漂移保护',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');

    await s.g(['checkout', '-b', 'accidental']);
    await fsp.writeFile(path.join(s.repo, 'accidental.ts'), 'do not commit\n');
    const before = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'blocked',
      branch: 'main',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('accidental');
    expect((await s.g(['rev-parse', 'HEAD'])).out.trim()).toBe(before);
    expect((await s.g(['status', '--porcelain'])).out).toContain('?? accidental.ts');
    expect(s.engine.store.countEvents(issue.id, 'auto_commit')).toBe(0);
    expect(s.engine.implTipSha(issue.id)).toBeNull();
  });

  test('自动 Git 失败通知在释放项目 Git 锁后发送，不阻塞手动写操作', async () => {
    let mutex: KeyedMutex | undefined;
    let lockedDuringFailureNotice: boolean | undefined;
    const s = await setup({
      onNotify(event) {
        if (event.summaryCode === 'auto_git_failure' && event.summaryParams?.action === 'push') {
          lockedDuringFailureNotice = mutex?.isLocked(gitLockKey(1));
        }
      },
    });
    mutex = s.mutex;
    s.setManualReview(false);
    // 挂一个指不到任何仓库的 origin：预检过得去，push 必失败（这是本例要的失败通知）
    await s.g(['remote', 'add', 'origin', path.join(s.dir, 'missing-origin.git')]);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '失败通知释放 Git 锁',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'notify.ts'), 'export {}\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    expect(lockedDuringFailureNotice).toBe(false);
  });

  test('目标不存在且源缺失或无效时安全 blocked，不创建半成品分支', async () => {
    const s = await setup();
    const invalid = await s.engine.createIssue(s.projectId, {
      title: '无效源',
      targetBranch: 'feature/invalid-source',
      sourceRef: 'refs/remotes/origin/missing',
    });
    expect(s.engine.store.get(invalid.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--list', 'feature/invalid-source'])).out.trim()).toBe('');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');

    const missing = await s.engine.createIssue(s.projectId, {
      title: '未选源',
      targetBranch: 'feature/no-source',
    });
    expect(s.engine.store.get(missing.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--list', 'feature/no-source'])).out.trim()).toBe('');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
  });

  test('checkout 返回成功但最终分支异常时 blocked，并把观测到的实际分支同步到 issue', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/post-check']);
    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      const result = await rawGit(cwd, args);
      if (
        result.code === 0
        && args[0] === 'checkout'
        && args.includes('feature/post-check')
      ) {
        await rawGit(cwd, ['checkout', 'main']);
      }
      return result;
    };

    const issue = await s.engine.createIssue(s.projectId, {
      title: '切换后现场异常',
      targetBranch: 'feature/post-check',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'blocked',
      branch: 'main',
    });
    expect((await rawGit(s.repo, ['branch', '--show-current'])).out.trim()).toBe('main');
  });

  test('分支准备与自动 commit/push 复用项目 Git 锁，impl_base/tip 锚定目标分支', async () => {
    const s = await setup();
    s.setManualReview(false);
    const origin = path.join(s.dir, 'target-origin.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);
    const sourceSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    await s.g(['update-ref', 'refs/remotes/origin/release', sourceSha]);
    const rawGit = s.driver.git.bind(s.driver);
    let phase: 'prepare' | 'work' | 'finish' = 'prepare';
    let prepareReleased = false;
    let finishReleased = false;
    let prepareGitBeforeRelease = false;
    let finishGitBeforeRelease = false;
    s.driver.git = async (cwd: string, args: string[]) => {
      if (phase === 'prepare' && !prepareReleased) prepareGitBeforeRelease = true;
      if (phase === 'finish' && !finishReleased && args[0] === 'add') finishGitBeforeRelease = true;
      return rawGit(cwd, args);
    };

    let releasePrepare!: () => void;
    let markPrepareLock!: () => void;
    const prepareLocked = new Promise<void>((resolve) => {
      markPrepareLock = resolve;
    });
    const prepareHold = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const heldPrepare = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markPrepareLock();
      await prepareHold;
    });
    await prepareLocked;
    let createSettled = false;
    const creating = s.engine.createIssue(s.projectId, {
      title: '目标分支自动收尾',
      targetBranch: 'feature/auto-target',
      sourceRef: 'refs/remotes/origin/release',
    }).then((created) => {
      createSettled = true;
      return created;
    });
    await flushMicrotasks();
    const createWaitedForLock = !createSettled;
    prepareReleased = true;
    releasePrepare();
    const [, issue] = await Promise.all([heldPrepare, creating]);
    expect(createWaitedForLock).toBe(true);
    expect(prepareGitBeforeRelease).toBe(false);
    phase = 'work';

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/auto-target',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.implBaseSha(issue.id)).toBe(sourceSha);

    await fsp.writeFile(path.join(s.repo, 'auto-target.ts'), 'export const target = true;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');

    let releaseFinish!: () => void;
    let markFinishLock!: () => void;
    const finishLocked = new Promise<void>((resolve) => {
      markFinishLock = resolve;
    });
    const finishHold = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const heldFinish = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markFinishLock();
      await finishHold;
    });
    await finishLocked;
    phase = 'finish';
    let finishSettled = false;
    const finishing = s.engine.applyEvent(issue.id, 'tests_passed').then((result) => {
      finishSettled = true;
      return result;
    });
    await flushMicrotasks();
    const finishWaitedForLock = !finishSettled;
    finishReleased = true;
    releaseFinish();
    await Promise.all([heldFinish, finishing]);
    expect(finishWaitedForLock).toBe(true);
    expect(finishGitBeforeRelease).toBe(false);

    const localHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    const remoteHead = (await s.driver.git(origin, ['rev-parse', 'refs/heads/feature/auto-target'])).out.trim();
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'done',
      branch: 'feature/auto-target',
    });
    expect(remoteHead).toBe(localHead);
    expect(s.engine.implTipSha(issue.id)).toBe(localHead);
    const snap = s.engine.implCommits(issue.id)!;
    expect(snap.base).toBe(sourceSha);
    expect(snap.tip).toBe(localHead);
    expect(snap.files.map((f) => f.path)).toContain('auto-target.ts');
  }, 30000);
});

describe('历史 issue 未配置目标分支（沿用开发者分支且不做本地合并）', () => {
  test('开发者停在自己的分支 dev 上连续干活：prompt 报 dev、不建额外分支、approve 后不产生本地 merge、仍留在 dev', async () => {
    const s = await setup();
    const { engine } = s;
    // 开发者自己从 develop/main checkout 出分支 dev 并切过去（这是 GitLab MR 流的常态）
    await s.g(['checkout', '-b', 'dev']);

    const issue = await engine.createIssue(s.projectId, { title: '在 dev 上加功能', module: 'x' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // planning kickoff
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写点东西\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);

    // 未配置 targetBranch：implementing 留在 dev，不创建额外的 issue/<id>
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(engine.store.get(issue.id)!.branch).toBe('dev');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('dev');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    // 起点 sha 已记录（供 merge_review 只 diff 本 issue）
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);

    // 子任务 prompt 报的是 dev，绝不出现 issue/<id>
    await engine.tick();
    const subPrompt = s.driver.prompts().find((t) => t.includes('【实施 子任务'))!;
    expect(subPrompt).toContain('当前工作分支 dev');
    expect(subPrompt).not.toContain(`issue/${issue.id}`);

    // 在 dev 上做真实改动并提交
    await fsp.writeFile(path.join(s.repo, 'feat.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat on dev']);

    // SUBTASK_DONE → testing → STAGE_DONE → merge_review
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');

    // 起点/终点锚点：merge_review 定格 impl_tip=本 issue 最后一条提交（feat on dev），
    // 起点 impl_base=动手前的 dev tip（≠终点）——per-issue git 视图据此取 start..tip 只含本 issue。
    const devHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    expect(engine.implTipSha(issue.id)).toBe(devHead);
    expect(engine.implBaseSha(issue.id)).not.toBe(devHead);
    expect(engine.implBaseSha(issue.id)).not.toBeNull();

    // merge_review payload：只 diff 本 issue 的改动（含 feat.ts），分支 dev
    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(g2.payloadJson!) as { branch: string; diff: string };
    expect(payload.branch).toBe('dev');
    expect(payload.diff).toContain('feat.ts');

    // approve → merging（不做本地合并）→ done
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    // base(main) 未被动过：main 仍只有初始提交，没有 merge 提交、没有 feat.ts
    expect((await s.g(['log', '--oneline', 'main'])).out.trim().split('\n').length).toBe(1);
    // 收尾没切分支：仍停在 dev
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('dev');
    // 合并被显式跳过留痕
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
  }, 30000);

  test('工作区有未提交改动、且不在 base 分支：进 implementing 不再因 checkout 失败而 blocked（zd885k 回归）', async () => {
    const s = await setup();
    const { engine } = s;
    // 复现线上场景：项目 cwd 停在非 main 分支上、且有未提交改动（该文件与 main 版本不同）。
    // 老引擎会 `checkout -b issue/<id> main`，git 报「Your local changes would be overwritten by
    // checkout」→ 分支失败 → blocked → 反复 unblock 重来 → 一直堵塞。新引擎不 checkout，天然免疫。
    await s.g(['checkout', '-b', 'work']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'work committed\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'work 分支改了 README（与 main 不同）']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'dirty 未提交改动\n'); // 未提交本地改动

    const issue = await engine.createIssue(s.projectId, { title: 'PandaDOS 首页按图例改', module: 'ui' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 改首页\nSUBTASKS_END'));
    await engine.tick();
    const g = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g.id, s.admin.id, 'approve')).ok).toBe(true);

    // 关键：直接进 implementing，没有 git-branch 失败事件、没有被 blocked
    const cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('implementing');
    expect(cur.branch).toBe('work'); // 就在开发者当前分支上，不切走
    expect(
      engine.store.listEvents(issue.id).some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('git-branch')),
    ).toBe(false);
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('"to":"blocked"'))).toBe(false);
    // 未提交改动原样保留（引擎没动工作树）
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf-8')).toContain('dirty 未提交改动');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
  }, 30000);
});

describe('固定分支默认（沿用当前分支）+ 本 issue commit ids/文件改动耐久快照', () => {
  test('当前停在非 base 分支：沿用它、不切 main、不建 issue 分支；范围收本 issue 净提交（不比 main）', async () => {
    const s = await setup();
    const { engine } = s;

    // 用户切到自己的固定/长期分支 feat/x，并先落一条**别的**历史改动（用来证明范围不含它）
    await s.g(['checkout', '-b', 'feat/x']);
    await fsp.writeFile(path.join(s.repo, 'preexisting.ts'), 'pre\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', '别的历史改动 on feat/x']);
    const preSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // 没有配置 work_branch —— 引擎应默认沿用当前分支 feat/x，绝不从 main 切 issue/<id>
    const issue = await engine.createIssue(s.projectId, { title: '在 feat/x 上加功能', module: 'x' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写点东西\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);

    // implementing：留在 feat/x（不是 main、不是 issue/<id>），没有新建 issue 分支
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(engine.store.get(issue.id)!.branch).toBe('feat/x');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feat/x');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    // 起点 sha = 动手前的 feat/x tip（那条历史改动），供范围只取本 issue
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);
    expect(engine.implBaseSha(issue.id)).toBe(preSha);

    // 子任务 prompt 报 feat/x，绝不出现 issue/<id>
    await engine.tick();
    const subPrompt = s.driver.prompts().find((t) => t.includes('【实施 子任务'))!;
    expect(subPrompt).toContain('当前工作分支 feat/x');
    expect(subPrompt).not.toContain(`issue/${issue.id}`);

    // 本 issue 的真实改动落在 feat/x 上
    await fsp.writeFile(path.join(s.repo, 'feature.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: 本 issue 的改动']);
    const featSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // SUBTASK_DONE → testing → STAGE_DONE → merge_review
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');

    // 终点定格 = 本 issue 最后一条提交
    expect(engine.implTipSha(issue.id)).toBe(featSha);

    // 耐久快照：本 issue 涉及的 commit ids + 文件改动（不含那条历史改动）
    const snap = engine.implCommits(issue.id)!;
    expect(snap).not.toBeNull();
    expect(snap.base).toBe(preSha);
    expect(snap.tip).toBe(featSha);
    expect(snap.commits.map((c) => c.sha)).toEqual([featSha]);
    expect(snap.commits[0]!.subject).toContain('feat: 本 issue');
    expect(snap.files.map((f) => f.path)).toContain('feature.ts');
    expect(snap.files.map((f) => f.path)).not.toContain('preexisting.ts');

    // merge_review payload：只 diff 本 issue（start..tip），带 commit ids/文件；不含历史改动、不比 main
    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(g2.payloadJson!) as {
      branch: string; base: string; range?: string; diff: string;
      commits?: Array<{ sha: string }>; files?: Array<{ path: string }>;
    };
    expect(payload.branch).toBe('feat/x');
    expect(payload.range).toBe(`${preSha}..${featSha}`);
    expect(payload.commits!.map((c) => c.sha)).toEqual([featSha]);
    expect(payload.files!.map((f) => f.path)).toContain('feature.ts');
    expect(payload.diff).toContain('feature.ts');
    expect(payload.diff).not.toContain('preexisting.ts'); // 关键：没和 main 对比

    // approve → done：base(main) 未被动、仍留在 feat/x、合并被显式跳过
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    expect((await s.g(['log', '--oneline', 'main'])).out.trim().split('\n').length).toBe(1);
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feat/x');
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
    // done 兜底没有把 impl_tip 覆写成别的（仍是本 issue 提交），也没重复落快照
    expect(engine.implTipSha(issue.id)).toBe(featSha);
    expect(engine.store.countEvents(issue.id, 'impl_commits')).toBe(1);
  }, 30000);

  test('停在 main：也在 main 上直接干活并记录 impl_base + 提交快照，approve 后不产生本地 merge 提交', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '加导出', body: 'CSV', module: 'export' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写导出器\nSUBTASKS_END'));
    await engine.tick();
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);
    // 不建/不切分支：就在 main 上干活；起点 sha 照记
    expect(engine.store.get(issue.id)!.branch).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);

    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: export']);
    const exportSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');
    // 定格在本 issue 的提交，快照含该 commit id
    expect(engine.implTipSha(issue.id)).toBe(exportSha);
    const snap = engine.implCommits(issue.id)!;
    expect(snap.commits.map((c) => c.sha)).toEqual([exportSha]);
    expect(snap.files.map((f) => f.path)).toContain('export.ts');

    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    // 改动直接在 main 上，无本地 merge 提交；HEAD 就是本 issue 的提交
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['log', '--oneline', '-1'])).out).toContain('feat: export');
    // impl_tip 未被覆写，快照仍只一份（done 兜底不重复）
    expect(engine.implTipSha(issue.id)).toBe(exportSha);
    expect(engine.store.countEvents(issue.id, 'impl_commits')).toBe(1);
  }, 30000);
});

describe('同模块智能合并（调度前 LLM 归并）', () => {
  test('scheduleNext 前合并同模块 pending：host 换合并内容并开跑，被并入的 cancelled', async () => {
    const s = await setup();
    const { engine, pm } = s;
    // 同模块 web 三条 pending（未起跑）
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    const d = await engine.createIssue(s.projectId, { title: 'D', body: 'dd', module: 'web' }, false);
    // 另一模块的 pending 不受影响、不进 web 的候选
    const other = await engine.createIssue(s.projectId, { title: 'X', module: 'api' }, false);

    // LLM 判：B、C 可并（D 独立）
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '1) bb\n2) cc' }];

    await engine.scheduleNext(s.projectId, 'web');

    // LLM 只拿到 web 模块候选（含 b/c/d，不含 api 的 other）
    expect(pm.mergeCalls.length).toBe(1);
    expect(pm.mergeCalls[0]!.module).toBe('web');
    expect(pm.mergeCalls[0]!.ids.sort()).toEqual([b.id, c.id, d.id].sort());

    // host = 最早的 B：换成合并后 title/body，并已开跑
    const host = engine.store.get(b.id)!;
    expect(host.title).toBe('合并 B+C');
    // #289：摘要在前、各分支原文按 #id 分节追加——绝不用摘要覆盖原文
    expect(host.body).toContain('1) bb\n2) cc');
    expect(host.body).toContain(`### #${b.id} B`);
    expect(host.body).toContain('bb');
    expect(host.body).toContain(`### #${c.id} C`);
    expect(host.body).toContain('cc');
    expect(host.status).toBe('planning');
    // C 被折叠 → cancelled；D 仍 pending；other 不动
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
    expect(engine.store.get(d.id)!.status).toBe('pending');
    expect(engine.store.get(other.id)!.status).toBe('pending');
    // 事件留痕
    expect(engine.store.listEvents(b.id).some((e) => e.kind === 'tasks_merged')).toBe(true);
    expect(engine.store.listEvents(c.id).some((e) => e.kind === 'merged_into')).toBe(true);
  });

  // #289 / B-14：合并不得无损覆盖——摘要只能追加在原文前面，原文与澄清反馈进快照
  test('合并保留原文并存快照：宿主原文、被并项原文、澄清反馈都能回溯', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, {
      title: 'B', body: '定位：engine.ts:5245；量化：本周 36 次', module: 'web',
    }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: '验收：门禁全绿', module: 'web' }, false);
    engine.store.setClarifyFeedback(b.id, 'B 的澄清结论');
    engine.store.setClarifyFeedback(c.id, 'C 的澄清结论');
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要：两条都在改调度' }];

    await engine.scheduleNext(s.projectId, 'web');

    // 正文：摘要在前，两条原文分节追加，行号与验收段一个字没丢
    const host = engine.store.get(b.id)!;
    expect(host.body).toContain('摘要：两条都在改调度');
    expect(host.body).toContain('engine.ts:5245');
    expect(host.body).toContain('本周 36 次');
    expect(host.body).toContain('验收：门禁全绿');
    expect(host.body!.indexOf('摘要：')).toBeLessThan(host.body!.indexOf('engine.ts:5245'));

    // 快照：含宿主自己那条，字段齐全（拆回全靠它）
    const merged = engine.store.listEvents(b.id).find((e) => e.kind === 'tasks_merged')!;
    const data = JSON.parse(merged.dataJson!) as {
      snapshot: Array<{ id: number; title: string; body: string; clarifyFeedback: string | null }>;
    };
    expect(data.snapshot.map((x) => x.id).sort()).toEqual([b.id, c.id].sort());
    const hostSnap = data.snapshot.find((x) => x.id === b.id)!;
    expect(hostSnap).toMatchObject({ title: 'B', body: '定位：engine.ts:5245；量化：本周 36 次' });
    expect(hostSnap.clarifyFeedback).toBe('B 的澄清结论');
    expect(data.snapshot.find((x) => x.id === c.id)!.clarifyFeedback).toBe('C 的澄清结论');

    // 宿主的澄清反馈照旧清空（正文已并入多条，收尾后重新分析），但它已进快照
    expect(engine.store.get(b.id)!.clarifyFeedback).toBeNull();
  });

  test('正文超长：摘要与靠前分节保全，装不下的分节留一行说明（快照仍是全文）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const long = '正'.repeat(5000);
    const b = await engine.createIssue(s.projectId, { title: 'B', body: long, module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: long, module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];

    await engine.scheduleNext(s.projectId, 'web');

    const host = engine.store.get(b.id)!;
    expect(host.body!.length).toBeLessThanOrEqual(8000); // 不超过正文列上限
    expect(host.body).toContain('摘要');
    expect(host.body).toContain(`### #${b.id} B`);
    expect(host.body).toContain(`### #${c.id} C`); // 分节标题一定在，让人知道有哪些分支
    expect(host.body).toContain('见 tasks_merged 事件快照');
    // 快照不受正文上限影响：拆回要的是全文
    const merged = engine.store.listEvents(b.id).find((e) => e.kind === 'tasks_merged')!;
    const data = JSON.parse(merged.dataJson!) as { snapshot: Array<{ id: number; body: string }> };
    expect(data.snapshot.find((x) => x.id === c.id)!.body).toBe(long);
  });

  // #289 / B-14：合并可拆回；只允许宿主未起跑前拆（发起人拍板）
  test('合并 → 拆回：宿主与被并项各自恢复原文、澄清反馈与状态', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'B 的原文：engine.ts:5245', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'C 的原文：验收段', module: 'web' }, false);
    engine.store.setClarifyFeedback(b.id, 'B 的澄清');
    engine.store.setClarifyFeedback(c.id, 'C 的澄清');
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];

    // 让合并照跑、但别顺势开跑：拆回只允许宿主仍 pending
    const original = engine.startIssue.bind(engine);
    engine.startIssue = async () => ({ ok: false, error: '暂不开跑', deferral: 'project-busy' as const });
    try {
      await engine.scheduleNext(s.projectId, 'web');
    } finally {
      engine.startIssue = original;
    }
    expect(engine.store.get(b.id)!.title).toBe('合并 B+C');
    expect(engine.store.get(c.id)!.status).toBe('cancelled');

    const r = await engine.unmergeIssues(b.id, 7);
    expect(r).toEqual({ ok: true, restored: [c.id] });

    const host = engine.store.get(b.id)!;
    expect(host.title).toBe('B');
    expect(host.body).toBe('B 的原文：engine.ts:5245');
    expect(host.clarifyFeedback).toBe('B 的澄清');
    const folded = engine.store.get(c.id)!;
    expect(folded.status).toBe('pending'); // 被并项回到待办
    expect(folded.title).toBe('C');
    expect(folded.body).toBe('C 的原文：验收段');
    expect(folded.clarifyFeedback).toBe('C 的澄清');
    // 留痕
    expect(engine.store.listEvents(b.id).some((e) => e.kind === 'tasks_unmerged')).toBe(true);
    expect(engine.store.listEvents(c.id).some((e) => e.kind === 'unmerged_from')).toBe(true);
  });

  test('宿主已开跑 → 拒绝拆回；同一次合并也不给拆第二次', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];

    await engine.scheduleNext(s.projectId, 'web'); // 合并后顺势开跑
    expect(engine.store.get(b.id)!.status).toBe('planning');
    expect(await engine.unmergeIssues(b.id)).toMatchObject({ ok: false });

    // 没有合并记录的普通 issue 同样拒绝
    const plain = await engine.createIssue(s.projectId, { title: 'P' }, false);
    expect(await engine.unmergeIssues(plain.id)).toMatchObject({ ok: false });
    expect(await engine.unmergeIssues(999999)).toMatchObject({ ok: false, error: '无此 issue' });
  });

  test('拆回一次之后不再重复拆（否则会把手工改过的正文又覆盖回旧快照）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];
    const original = engine.startIssue.bind(engine);
    engine.startIssue = async () => ({ ok: false, error: '暂不开跑', deferral: 'project-busy' as const });
    try {
      await engine.scheduleNext(s.projectId, 'web');
    } finally {
      engine.startIssue = original;
    }

    expect((await engine.unmergeIssues(b.id)).ok).toBe(true);
    engine.store.patchMeta(b.id, { body: '拆回后我又手工改了' });
    expect(await engine.unmergeIssues(b.id)).toMatchObject({ ok: false });
    expect(engine.store.get(b.id)!.body).toBe('拆回后我又手工改了'); // 没被旧快照覆盖
  });

  // #289 / B-14：声明与截断在引擎侧判掉，绝不依赖 LLM 看到——候选正文送进 LLM 前会被
  // midTruncate 保头保尾截到 500 字，声明写在中段就被省掉了（#277 就是这么被合并的）。
  test('正文中段的范围声明仍然生效：该条被排除出候选，其余照常合并', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const buried = ['# 需求', '正文'.repeat(400), '【范围声明·置顶】本条独立，不得与任何其他 Issue 合并。', '正文'.repeat(400)].join('\n');
    const declared = await engine.createIssue(s.projectId, { title: 'A', body: buried, module: 'web' }, false);
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    // 声明那条根本没进候选清单
    expect(pm.mergeCalls[0]!.ids).not.toContain(declared.id);
    expect(pm.mergeCalls[0]!.ids.sort()).toEqual([b.id, c.id].sort());
    // 正文一个字没动，也没被折叠
    expect(engine.store.get(declared.id)!.body).toBe(buried);
    expect(['pending', 'planning']).toContain(engine.store.get(declared.id)!.status);
    // 留痕说明为什么跳过
    const skipped = engine.store.listEvents(declared.id).find((e) => e.kind === 'merge_skipped');
    expect(JSON.parse(skipped!.dataJson!)).toMatchObject({ issueId: declared.id, reason: 'no-merge-declared' });
    // 其余候选照常合并
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
  });

  test('正文疑似被截断的候选跳过本轮：不在损坏数据上做不可逆决策', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const truncated = await engine.createIssue(s.projectId, { title: 'A', body: '开头…[中间省略]…结尾', module: 'web' }, false);
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(pm.mergeCalls[0]!.ids).not.toContain(truncated.id);
    const skipped = engine.store.listEvents(truncated.id).find((e) => e.kind === 'merge_skipped');
    expect(JSON.parse(skipped!.dataJson!)).toMatchObject({ reason: 'body-truncated' });
  });

  test('过滤后候选不足两条 → 整轮不问 LLM（宁可漏合并，不可误合并）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    await engine.createIssue(s.projectId, { title: 'A', body: 'noMerge', module: 'web' }, false);
    await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);

    await engine.scheduleNext(s.projectId, 'web');

    expect(pm.mergeCalls).toEqual([]);
  });

  test('普通候选不受影响：既有确定性守卫与 host/置顶口径原样', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: '把门禁挪出会话', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: '修复自动提交', module: 'web' }, false);
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: 'y' }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(engine.store.listEvents(b.id).some((e) => e.kind === 'merge_skipped')).toBe(false);
    expect(engine.store.get(b.id)!.status).toBe('planning'); // host 是最早那条，照常开跑
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
  });

  test('autoMerge=false → 不问 LLM，直接按模块聚合挑选开跑', async () => {
    const s = await setup();
    // 关掉合并的引擎实例（复用同 DB/依赖）
    const engine = new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: { locate: (id) => (s.jsonl.get(id) ? Promise.resolve(s.jsonl.get(id)!) : Promise.resolve(null)) },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: s.mutex,
      config: { kickoffMinBootMs: 0, now: s.clock.now, autoMerge: false, resultSummaryTimeoutMs: 0 },
    });
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'web' }, false);
    s.pm.merges = [{ members: [b.id, c.id], title: '不该发生', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(s.pm.mergeCalls.length).toBe(0);
    expect(engine.store.get(b.id)!.title).toBe('B'); // 未被改写
    expect(engine.store.get(b.id)!.status).toBe('planning'); // 正常开跑
    expect(engine.store.get(c.id)!.status).toBe('pending'); // 未被折叠
  });

  test('不同 agent 的同模块任务不并（跨 agent 会改实施语义）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'web', agent: 'claude' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'web', agent: 'codex' }, false);
    // 即便 LLM「想」合并，引擎按 (agent,category,implMode) 分桶后两条各自单飞、不会送进同一次调用
    pm.merges = [{ members: [b.id, c.id], title: '跨 agent', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    // 两个桶各 1 条 → 都 <2，根本不问 LLM
    expect(pm.mergeCalls.length).toBe(0);
    expect(engine.store.get(c.id)!.status).toBe('pending');
    expect(engine.store.get(b.id)!.title).toBe('B');
  });

  test('目标分支或源 ref 不同的 pending 不自动合并，只向 LLM 提交 Git 意图相同的子组', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const sameA = await engine.createIssue(s.projectId, {
      title: 'same A',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    }, false);
    const sameB = await engine.createIssue(s.projectId, {
      title: 'same B',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    }, false);
    const otherTarget = await engine.createIssue(s.projectId, {
      title: 'other target',
      module: 'web',
      targetBranch: 'feature/other',
      sourceRef: 'refs/heads/main',
    }, false);
    const otherSource = await engine.createIssue(s.projectId, {
      title: 'other source',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/remotes/origin/main',
    }, false);
    pm.merges = [{
      members: [sameA.id, sameB.id],
      title: 'same pair merged',
      body: 'merged',
    }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(pm.mergeCalls).toEqual([{
      module: 'web',
      ids: [sameA.id, sameB.id],
    }]);
    expect(engine.store.get(sameA.id)!.title).toBe('same pair merged');
    expect(engine.store.get(sameB.id)!.status).toBe('cancelled');
    expect(engine.store.get(otherTarget.id)!.status).toBe('pending');
    expect(engine.store.get(otherSource.id)!.status).toBe('pending');
  });

  test('自动合并落地期间串行 pending Git 编辑，不能在重验后改出跨分支合并', async () => {
    let foldedId = 0;
    let markFoldNotify!: () => void;
    const foldNotify = new Promise<void>((resolve) => {
      markFoldNotify = resolve;
    });
    let releaseFoldNotify!: () => void;
    const foldNotifyHold = new Promise<void>((resolve) => {
      releaseFoldNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.issueId === foldedId && event.to === 'cancelled') {
          markFoldNotify();
          await foldNotifyHold;
        }
      },
    });
    const intent = { targetBranch: 'feature/85', sourceRef: 'refs/heads/main' };
    const a = await s.engine.createIssue(s.projectId, { title: 'A', module: 'web', ...intent }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', module: 'web', ...intent }, false);
    const c = await s.engine.createIssue(s.projectId, { title: 'C', module: 'web', ...intent }, false);
    foldedId = b.id;
    s.pm.merges = [{ members: [a.id, b.id, c.id], title: 'ABC', body: 'merged' }];

    const scheduled = s.engine.scheduleNext(s.projectId, 'web');
    await foldNotify;
    let editSettled = false;
    const edit = s.engine
      .updatePendingMeta(c.id, {
        targetBranch: 'feature/other',
        sourceRef: 'refs/heads/main',
      })
      .then(
        (updated) => {
          editSettled = true;
          return { ok: true as const, updated };
        },
        (error: Error) => {
          editSettled = true;
          return { ok: false as const, error };
        },
      );
    await flushMicrotasks();
    expect(editSettled).toBe(false);

    releaseFoldNotify();
    await scheduled;
    const editResult = await edit;
    // #93 起 cancelled 可编辑，所以这条编辑会成功——但它只落在**已被折叠的 C 自己**身上：
    // 折叠已经完成，C 是死的，改它的分支意图影响不到宿主 issue 的合并结果。
    // 本用例真正守的是**串行性**（上面 editSettled 必须为 false，编辑不能插进落地过程中间）。
    expect(editResult.ok).toBe(true);
    expect(s.engine.store.get(c.id)).toMatchObject({ status: 'cancelled', targetBranch: 'feature/other' });
    // 宿主 issue 的分支意图不受这条迟到编辑影响，跨分支合并仍不可能发生
    expect(s.engine.store.get(a.id)).toMatchObject({
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    });
  });

  test('三成员自动合并取消途中并发 start 不形成 issue-meta/transition 锁反转', async () => {
    let pausedId = 0;
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    let releasePause!: () => void;
    const pauseHold = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.issueId === pausedId && event.to === 'cancelled') {
          markPaused();
          await pauseHold;
        }
      },
    });
    const intent = { targetBranch: 'feature/merge-lock', sourceRef: 'refs/heads/main' };
    const a = await s.engine.createIssue(s.projectId, { title: 'A', module: 'web', ...intent }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', module: 'web', ...intent }, false);
    const c = await s.engine.createIssue(s.projectId, { title: 'C', module: 'web', ...intent }, false);
    pausedId = b.id;
    s.pm.merges = [{ members: [a.id, b.id, c.id], title: 'ABC', body: 'merged' }];

    const scheduled = s.engine.scheduleNext(s.projectId, 'web');
    await paused;
    let startSettled = false;
    const starting = s.engine.startIssue(c.id).then((result) => {
      startSettled = true;
      return result;
    });
    await flushMicrotasks();
    expect(startSettled).toBe(false);

    releasePause();
    const completed = await Promise.race([
      Promise.all([scheduled, starting]).then(([, result]) => ({ completed: true as const, result })),
      // 真 Git 分支准备在较慢的 macOS CI 上可能超过 250ms；保留超时防锁死，避免把正常 I/O 当死锁。
      new Promise<{ completed: false }>((resolve) => setTimeout(() => resolve({ completed: false }), 1_000)),
    ]);
    expect(completed.completed).toBe(true);
    if (!completed.completed) return;
    expect(completed.result.ok).toBe(false);
    expect(s.engine.store.get(a.id)!.status).toBe('planning');
    expect(s.engine.store.get(b.id)!.status).toBe('cancelled');
    expect(s.engine.store.get(c.id)!.status).toBe('cancelled');
  });
});

describe('置顶调整优先级（setPinned）', () => {
  test('置顶一条 pending：项目空闲时被优先开跑（压过同模块更早的 FIFO），留痕 pinned 事件', async () => {
    const s = await setup();
    const { engine } = s;
    // 三条 pending（未起跑）：A、C 同模块 a（A 更早），B 模块 b
    const a = await engine.createIssue(s.projectId, { title: 'A', module: 'a' }, false);
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'b' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'a' }, false);

    const r = await engine.setPinned(c.id, true, s.admin.id);
    expect(r.ok).toBe(true);

    // C 被置顶并优先开跑；A（同模块更早）、B 仍排队
    const cur = engine.store.get(c.id)!;
    expect(cur.pinnedTs).toBeGreaterThan(0);
    expect(cur.status).toBe('planning');
    expect(engine.store.get(a.id)!.status).toBe('pending');
    expect(engine.store.get(b.id)!.status).toBe('pending');
    expect(engine.store.listEvents(c.id).some((e) => e.kind === 'pinned')).toBe(true);
  });

  test('非 pending 不可置顶（已开跑无意义）', async () => {
    const s = await setup();
    const { engine } = s;
    const a = await engine.createIssue(s.projectId, { title: 'A' }, false);
    await engine.setPinned(a.id, true); // 置顶后立即被开跑 → planning
    expect(engine.store.get(a.id)!.status).toBe('planning');
    const r = await engine.setPinned(a.id, true); // 再置顶：已 planning → 拒绝
    expect(r.ok).toBe(false);
  });

  test('取消置顶：pinned_ts 清空、留痕 unpinned', async () => {
    const s = await setup();
    const { engine } = s;
    // 先占位一条在跑，避免置顶目标被立即开跑（便于验证 pin/unpin 的纯存取）
    const host = await engine.createIssue(s.projectId, { title: '占位', module: 'busy' }, false);
    await engine.setPinned(host.id, true); // host → planning，项目变忙
    const q = await engine.createIssue(s.projectId, { title: '排队', module: 'q' }, false);
    expect(engine.store.get(q.id)!.status).toBe('pending');

    await engine.setPinned(q.id, true);
    expect(engine.store.get(q.id)!.pinnedTs).toBeGreaterThan(0);
    expect(engine.store.get(q.id)!.status).toBe('pending'); // 项目忙 → 不抢跑，只调顺序

    const r = await engine.setPinned(q.id, false);
    expect(r.ok).toBe(true);
    expect(engine.store.get(q.id)!.pinnedTs).toBeNull();
    expect(engine.store.listEvents(q.id).some((e) => e.kind === 'unpinned')).toBe(true);
  });

  test('置顶被同模块合并吞并时：置顶带到 host（意图不丢）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    // LLM 判 B、C 可并（host 会是更早的 B，未置顶）
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: 'x' }];

    // 置顶较晚的 C → 触发调度：先合并（C 折叠入 host B）→ B 继承置顶 → B 开跑
    await engine.setPinned(c.id, true);

    const host = engine.store.get(b.id)!;
    expect(host.pinnedTs).toBeGreaterThan(0); // 置顶随合并带到 host
    expect(host.status).toBe('planning');
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
  });
});

// ---------- 创建时澄清（后台执行代理分析） ----------

describe('澄清派生：execClarifyWait / clarifyPendingOf（事件溯源、跨状态、免迁移）', () => {
  test('execClarifyWait：exec 问题无 clarified/timeout → 等待中；创建时问题不算；回答后 null', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'X' });
    expect(st.execClarifyWait(iss.id)).toBeNull(); // 没问题

    // 创建时问题（source≠exec）不算执行中等待
    st.logEvent(iss.id, 'clarify_questions', { questions: ['创建时问？'], source: 'create' });
    expect(st.execClarifyWait(iss.id)).toBeNull();

    // 执行中问题（source=exec）→ 等待中，带 since/questions/stage
    st.logEvent(iss.id, 'clarify_questions', {
      questions: ['用哪个库？', '下线钮蓝色？'],
      source: 'exec',
      stage: 'planning',
    });
    const w = st.execClarifyWait(iss.id);
    expect(w).not.toBeNull();
    expect(w!.questions).toEqual(['用哪个库？', '下线钮蓝色？']);
    expect(w!.stage).toBe('planning');
    expect(w!.since).toBeGreaterThan(0);

    // 回答后不再等待
    st.logEvent(iss.id, 'clarified', { answer: '用 A' });
    expect(st.execClarifyWait(iss.id)).toBeNull();
  });

  test('execClarifyWait：超时自动继续（clarify_timeout）后不再等待；下一轮 exec 又等待（最新一条为准）', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'Y' });
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q1'], source: 'exec', stage: 'implementing' });
    expect(st.execClarifyWait(iss.id)).not.toBeNull();
    st.logEvent(iss.id, 'clarify_timeout', {});
    expect(st.execClarifyWait(iss.id)).toBeNull();
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q2'], source: 'exec', stage: 'implementing' });
    expect(st.execClarifyWait(iss.id)!.questions).toEqual(['q2']);
  });

  test('clarifyPendingOf 跨状态：创建时问题（不限 pending）待答，回答后收起；执行中超时也收起', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'Z' });
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
    st.logEvent(iss.id, 'clarify_questions', { questions: ['创建时问？'], source: 'create' });
    expect(st.clarifyPendingOf(iss.id)).toBe(true); // 第 5 点：不受状态限制
    st.logEvent(iss.id, 'clarified', { answer: 'ok' });
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
    // 执行中问题 → 待答；20 分钟超时自动继续后收起
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q'], source: 'exec', stage: 'planning' });
    expect(st.clarifyPendingOf(iss.id)).toBe(true);
    st.logEvent(iss.id, 'clarify_timeout', {});
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
  });

  test('EngineConfig.clarifyTimeoutMs 默认 20 分钟', () => {
    expect(DEFAULT_ENGINE_CONFIG.clarifyTimeoutMs).toBe(20 * 60 * 1000);
  });
});

describe('执行中澄清：NEED_CLARIFY 检测 + 停催停判 + 超时自动继续', () => {
  test('检测：记 clarify_questions(exec)+通知+不推进；幂等；等待期停催停判', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '技能中心样式', body: '样式要跟首页一致' });
    const jl = await s.bindJsonl(issue.id);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    await engine.tick(); // kickoff planning

    // 代理按编号提问 + NEED_CLARIFY 哨兵（散文行/哨兵行都不当问题）
    await s.appendOutput(
      jl,
      asst(`需要先确认几点：\n1. 用哪个库 axios 还是 fetch？\n2. 下线钮改蓝色吗？\nNEED_CLARIFY:${issue.id}`),
    );
    await engine.tick();

    const qEv = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions');
    expect(qEv.length).toBe(1);
    expect(JSON.parse(qEv[0]!.dataJson!)).toMatchObject({ source: 'exec', stage: 'planning' });
    expect(JSON.parse(qEv[0]!.dataJson!).questions).toEqual([
      '用哪个库 axios 还是 fetch？',
      '下线钮改蓝色吗？',
    ]);
    // 原文留档（#110）：散文前提保留、哨兵行剔除——UI 靠它完整展示代理原话
    expect(JSON.parse(qEv[0]!.dataJson!).text).toBe(
      '需要先确认几点：\n1. 用哪个库 axios 还是 fetch？\n2. 下线钮改蓝色吗？',
    );
    expect(engine.store.get(issue.id)!.status).toBe('planning'); // 不推进
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(
      s.notifications.some((n) => n.issueId === issue.id && n.summaryCode === 'clarification_needed'),
    ).toBe(true);
    expect(s.notifications.some((n) => String(n.summaryParams?.questions ?? '').includes('下线钮改蓝色'))).toBe(true);
    // 推送带需求正文摘要：手机上收到就知道这条 issue 原来在做什么
    expect(s.notifications.some((n) => n.summaryParams?.body === '样式要跟首页一致')).toBe(true);
    const notifN = s.notifications.filter((n) => n.summaryCode === 'clarification_needed').length;

    // 幂等：再输出一遍 NEED_CLARIFY，不重复记事件/不重复推送
    await s.appendOutput(jl, asst(`还是那几个问题\nNEED_CLARIFY:${issue.id}`));
    await engine.tick();
    expect(engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions').length).toBe(1);
    expect(s.notifications.filter((n) => n.summaryCode === 'clarification_needed').length).toBe(notifN);

    // 等待期停催停判：静默超过 nudge(180s)/fallback(360s) 但未到 clarifyTimeout(600s)
    s.pm.judgement = 'done';
    clock.advance(400_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(0);
    expect(s.pm.judgeCalls).toBe(0);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
  });

  test('第二层保险：PM 空闲判 clarify（代理忘输出 NEED_CLARIFY）→ 标记等待，不 block/不 nudge', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 2_000_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '忘了哨兵' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff planning
    // 代理在提问但没输出 NEED_CLARIFY 哨兵（散文式提问）→ 哨兵路径不触发，靠 PM 兜底判 clarify
    await s.appendOutput(jl, asst('我需要你先确认：\n1. 用哪个库 axios 还是 fetch？\n等你回复'));
    await engine.tick(); // 消费活动
    s.pm.judgement = 'clarify';

    clock.advance(181_000);
    await engine.tick(); // 还没进入等待 → 先常规 nudge
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
    clock.advance(361_000);
    await engine.tick(); // 静默兜底判 clarify → 进入等待
    expect(s.pm.judgeCalls).toBe(1);

    const qEv = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions');
    expect(qEv.length).toBe(1);
    expect(JSON.parse(qEv[0]!.dataJson!)).toMatchObject({ source: 'exec', via: 'judge' });
    // 块级抽取（#110）：清单项后紧跟的续行并入同一条；原文另落 text 字段供 UI 完整展示
    expect(JSON.parse(qEv[0]!.dataJson!).questions).toEqual(['用哪个库 axios 还是 fetch？\n等你回复']);
    expect(JSON.parse(qEv[0]!.dataJson!).text).toContain('我需要你先确认：');
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(engine.store.get(issue.id)!.status).toBe('planning'); // 不 block
    expect(
      s.notifications.some((n) => n.issueId === issue.id && n.summaryCode === 'clarification_needed'),
    ).toBe(true);

    // 进入等待后停判：execClarifyWait 非空 → 不再 judge（clarifyTimeout 2000s 内不触发超时）
    clock.advance(400_000);
    await engine.tick();
    expect(s.pm.judgeCalls).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
  });

  test('答复直达会话：驱动态注入【澄清答复】+ 记 clarified(exec) + 解除等待 + 复位续跑', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '执行中澄清答复' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff planning
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick(); // 进入等待
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();

    const r = await engine.clarify(issue.id, '用 axios');
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ from: 'planning', to: 'planning' }); // 不迁移状态
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】用 axios'))).toBe(true);
    const clr = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarified');
    expect(clr.length).toBe(1);
    expect(JSON.parse(clr[0]!.dataJson!)).toMatchObject({ source: 'exec' });
    expect(engine.store.execClarifyWait(issue.id)).toBeNull(); // 解除等待
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(false);

    // 复位续跑：静默 181s 后常规 nudge 恢复（不再停催）
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
  });

  test('代理退回 shell 时答复不盲发：回明确错误 + 自动重启，答复不算已答（issue #97）', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '答复不能丢' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick(); // 进入等待
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);

    s.driver.pane = '[root@VM p]#'; // 代理没了，窗格只剩 bash
    s.driver.paneCommands.set(session, 'bash');
    s.clock.advance(61_000); // 过判死硬闸
    const sentBefore = s.driver.sent.length;
    const r = await engine.clarify(issue.id, '用 axios');

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining('已自动重启') });
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】'))).toBe(false); // 一个字都没进 bash
    expect(engine.store.countEvents(issue.id, 'clarified')).toBe(0); // 不算已答，等待状态保留
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(engine.store.countEvents(issue.id, 'agent_down')).toBe(1);
    // 已经把代理重起来了，用户重发就能落地
    expect(s.driver.sent.slice(sentBefore).some((x) => x.text === `claude --resume ${convId}`)).toBe(true);
  });

  test('第 5 点：创建时问题开跑后回答 → 注入会话 + clarified(post_start)；答前一直待答', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '开跑后补答' });
    // 模拟创建时澄清留下的问题（source≠exec）：开跑后仍应显示待答（clarifyPendingOf 跨状态）
    engine.store.logEvent(issue.id, 'clarify_questions', { source: 'create', questions: ['要支持哪些格式？'] });
    await s.bindJsonl(issue.id);
    await engine.tick(); // 已在 planning
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(true); // 第 5 点：开跑后仍待答
    expect(engine.store.execClarifyWait(issue.id)).toBeNull(); // 但非「执行中等待」（不停催）

    const r = await engine.clarify(issue.id, 'CSV 和 JSON 都要');
    expect(r.ok).toBe(true);
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】CSV 和 JSON 都要'))).toBe(true);
    const clr = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarified');
    expect(JSON.parse(clr[0]!.dataJson!)).toMatchObject({ source: 'post_start' });
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(false); // 答后收起
  });

  test('关键澄清超时仍等待回答，不自动继续或重复催办', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 300_000 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '关键决策' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst(`1. 哪个账号有授权？\nNEED_CLARIFY:${issue.id}`));
    await s.engine.tick(); s.clock.advance(360_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id,'clarify_timeout')).toBe(0);
    expect(s.engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(s.engine.store.countEvents(issue.id,'clarify_wait_reminder')).toBe(1);
    s.clock.advance(360_000); await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id,'clarify_wait_reminder')).toBe(1);
    expect(s.engine.store.countEvents(issue.id,'nudged')).toBe(0);
  });
});

describe('创建时澄清：后台分析不占队列不改状态', () => {
  /** 可编程澄清 stub：记录调用、并发峰值，支持 gate 挂起（竞态测试用） */
  function mkClarify() {
    const st = {
      calls: [] as Array<{ project: Project; input: EngineClarifyInput }>,
      inflight: 0,
      maxInflight: 0,
      result: {
        ok: true,
        feedback: '反馈：懂了',
        questions: ['问 1？'],
        questionsText: '1. 问 1？\n   A. 选项一\n   B. 选项二',
      } as EngineClarifyResult,
      gate: null as null | Promise<void>,
      fn: (async () => ({ ok: false, reason: 'unset' })) as (
        project: Project,
        input: EngineClarifyInput,
      ) => Promise<EngineClarifyResult>,
    };
    st.fn = async (project: Project, input: EngineClarifyInput) => {
      st.calls.push({ project, input });
      st.inflight++;
      st.maxInflight = Math.max(st.maxInflight, st.inflight);
      if (st.gate) await st.gate;
      st.inflight--;
      return st.result;
    };
    return st;
  }

  /** 忙等 stub 收到第 n 个调用（chain 是异步微任务，测试需要同步点） */
  async function untilCalls(st: ReturnType<typeof mkClarify>, n: number): Promise<void> {
    const deadline = Date.now() + 2000;
    while (st.calls.length < n) {
      if (Date.now() > deadline) throw new Error(`等不到第 ${n} 个 clarify 调用`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  test('排队中的 issue 触发分析：反馈落库 + clarify_questions 事件 + 通知；状态仍 pending', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    // A 建即开跑占住项目 → 不分析
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    expect(s.engine.store.get(a.id)!.status).toBe('planning');
    // B 排队 pending → 后台分析
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出', category: 'debug' });
    expect(s.engine.store.get(b.id)!.status).toBe('pending');
    await s.engine.waitClarify();

    expect(clar.calls.map((c) => c.input.issueId)).toEqual([b.id]); // A 未分析
    expect(clar.calls[0]!.input.title).toBe('B');
    expect(clar.calls[0]!.input.cwd).toBe(s.repo);
    expect(clar.calls[0]!.input.goal).toBe('演示项目');
    expect(clar.calls[0]!.project.id).toBe(s.projectId);

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('pending'); // 不改状态、不占队列
    expect(fresh.clarifyFeedback).toBe('反馈：懂了');
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_started');
    expect(kinds).toContain('clarify_done');
    expect(kinds).toContain('clarify_questions');
    // 原文留档（#110）：questions.md 原文进事件 text 字段，questions 字段口径不变
    const qEv = s.engine.store.listEvents(b.id).find((e) => e.kind === 'clarify_questions')!;
    expect(JSON.parse(qEv.dataJson!).questions).toEqual(['问 1？']);
    expect(JSON.parse(qEv.dataJson!).text).toBe('1. 问 1？\n   A. 选项一\n   B. 选项二');
    const note = s.notifications.find((n) => n.issueId === b.id &&
      String(n.summaryParams?.questions ?? '').includes('问 1？'));
    expect(note?.summaryParams?.body).toBe('加导出'); // 推送带正文摘要——手机上不用点进来也知道在问什么
    expect(s.engine.store.listEvents(a.id).map((e) => e.kind)).not.toContain('clarify_started');
  });

  test('formatClarifyAppend：有未答问题成对写入，无问题纯补充', () => {
    expect(formatClarifyAppend([], '补充内容')).toBe('【澄清补充】补充内容');
    expect(formatClarifyAppend(['q1？', 'q2？'], '答案')).toBe('【澄清问答】\n1. q1？\n2. q2？\n答：答案');
  });

  test('无澄清问题：只落反馈与 clarify_done，不发通知', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '需求清晰', questions: [] };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('需求清晰');
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_done');
    expect(kinds).not.toContain('clarify_questions');
    expect(s.notifications.some((n) => n.issueId === b.id)).toBe(false);
  });

  test('分析失败：error 事件（where=clarify），不影响排队与后续执行', async () => {
    const clar = mkClarify();
    clar.result = { ok: false, reason: 'timeout' };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('pending');
    expect(fresh.clarifyFeedback).toBeNull();
    const err = s.engine.store.listEvents(b.id).find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect(JSON.parse(err!.dataJson!)).toMatchObject({ where: 'clarify', reason: 'timeout' });
  });

  // #280 / B-06：光记一句 reason=timeout 等于没记；分析超时也必须真的用配置里的那个值
  test('分析超时把现场证据一起落库：耗时、产物数、文件清单、pane 尾部', async () => {
    const clar = mkClarify();
    clar.result = {
      ok: false,
      reason: 'timeout',
      diagnostics: {
        paneTail: '❯ 1. Yes  2. No（等权限确认）',
        files: [{ name: 'task.md', size: 120 }],
        hadArtifacts: 0,
        elapsedMs: 900_000,
      },
    };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    const err = s.engine.store.listEvents(b.id).find((e) => e.kind === 'error')!;
    expect(JSON.parse(err.dataJson!)).toMatchObject({
      where: 'clarify', reason: 'timeout', elapsedMs: 900_000, hadArtifacts: 0,
      files: [{ name: 'task.md', size: 120 }],
    });
    expect(err.dataJson).toContain('等权限确认');
  });

  test('抢救来的结果照常落库，但 clarify_done 标出 salvaged（done 没写出来是待查信号）', async () => {
    const clar = mkClarify();
    clar.result = {
      ok: true,
      feedback: '理解：改导出模块',
      questions: [],
      salvaged: true,
      diagnostics: { paneTail: '仍在跑', files: [], hadArtifacts: 1, elapsedMs: 880_000 },
    };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('理解：改导出模块');
    const done = s.engine.store.listEvents(b.id).find((e) => e.kind === 'clarify_done')!;
    expect(JSON.parse(done.dataJson!)).toMatchObject({ salvaged: true, elapsedMs: 880_000 });
    expect(s.engine.store.listEvents(b.id).some((e) => e.kind === 'error')).toBe(false);
  });

  test('分析超时按 clarifyRunTimeoutMs 下发（默认 15 分钟），不是「等用户答复」那个闸', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn, config: { clarifyRunTimeoutMs: 15 * 60 * 1000 } });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    expect(clar.calls.at(-1)!.input.timeoutMs).toBe(15 * 60 * 1000);
    expect(DEFAULT_ENGINE_CONFIG.clarifyRunTimeoutMs).toBe(15 * 60 * 1000);
    // 两个闸不是一回事：等用户答复仍是 20 分钟
    expect(DEFAULT_ENGINE_CONFIG.clarifyTimeoutMs).toBe(20 * 60 * 1000);
  });

  // #280 / B-06：本周 53 次分析只成了 4 次却无人知晓——这类「一直烧钱、一直没产出」的
  // 故障必须自己喊出来。
  describe('创建时澄清成功率告警', () => {
    /** 直接往事件表里造历史终局，避免为了凑窗口跑十几次分析 */
    const seed = (s: Awaited<ReturnType<typeof setup>>, issueId: number, outcomes: Array<'ok' | 'fail'>) => {
      for (const o of outcomes) {
        if (o === 'ok') s.engine.store.logEvent(issueId, 'clarify_done', { questions: 0 });
        else s.engine.store.logEvent(issueId, 'error', { where: 'clarify', reason: 'timeout' });
      }
    };
    const alertOf = (s: Awaited<ReturnType<typeof setup>>) =>
      s.notifications.filter((n) => n.summaryCode === 'clarify_success_low');

    test('成功率口径：只数 clarify_done 与 error{where:clarify}，skipped/discarded 不稀释', async () => {
      const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
      const issue = await s.engine.createIssue(s.projectId, { title: 'x' }, false);
      seed(s, issue.id, ['ok', 'fail', 'fail']);
      s.engine.store.logEvent(issue.id, 'clarify_skipped', { status: 'planning' });
      s.engine.store.logEvent(issue.id, 'clarify_discarded', { status: 'cancelled' });

      expect(s.engine.store.clarifySuccessRate(s.projectId, 10)).toEqual({ ok: 1, total: 3, rate: 1 / 3 });
      // 窗口只取最近 N 条（按事件 id 倒序）
      expect(s.engine.store.clarifySuccessRate(s.projectId, 2)).toEqual({ ok: 0, total: 2, rate: 0 });
      // 没有任何记录时不当成 0%（否则新项目一上来就告警）
      expect(s.engine.store.clarifySuccessRate(999, 10)).toEqual({ ok: 0, total: 0, rate: 1 });
    });

    test('跌破阈值发通知并落 clarify_success_low 事件', async () => {
      const clar = mkClarify();
      clar.result = { ok: false, reason: 'timeout' };
      const s = await setup({ clarify: clar.fn, config: { clarifyAlertWindow: 4, clarifyAlertRate: 0.5 } });
      const a = await s.engine.createIssue(s.projectId, { title: 'A' });
      seed(s, a.id, ['fail', 'fail', 'ok']); // 加上本次失败正好 4 条、成功率 25%
      const b = await s.engine.createIssue(s.projectId, { title: 'B' });
      await s.engine.waitClarify();

      const alerts = alertOf(s);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.summaryParams).toMatchObject({ ok: 1, total: 4 });
      const ev = s.engine.store.listEvents(b.id).find((e) => e.kind === 'clarify_success_low');
      expect(JSON.parse(ev!.dataJson!)).toMatchObject({ ok: 1, total: 4, rate: 0.25 });
    });

    test('阈值边界：正好等于阈值不告警（低于才告）', async () => {
      const clar = mkClarify();
      clar.result = { ok: false, reason: 'timeout' };
      const s = await setup({ clarify: clar.fn, config: { clarifyAlertWindow: 4, clarifyAlertRate: 0.5 } });
      const a = await s.engine.createIssue(s.projectId, { title: 'A' });
      seed(s, a.id, ['ok', 'ok', 'fail']); // 加上本次失败 = 2/4 = 50%
      await s.engine.createIssue(s.projectId, { title: 'B' });
      await s.engine.waitClarify();
      expect(alertOf(s)).toHaveLength(0);
    });

    test('不足窗口条数不告警：样本太少的比率没有意义', async () => {
      const clar = mkClarify();
      clar.result = { ok: false, reason: 'timeout' };
      const s = await setup({ clarify: clar.fn, config: { clarifyAlertWindow: 10, clarifyAlertRate: 0.5 } });
      await s.engine.createIssue(s.projectId, { title: 'A' });
      await s.engine.createIssue(s.projectId, { title: 'B' });
      await s.engine.waitClarify();
      expect(alertOf(s)).toHaveLength(0);
    });

    test('冷却内不重复告警；关掉窗口/冷却即完全不告警', async () => {
      const clar = mkClarify();
      clar.result = { ok: false, reason: 'timeout' };
      const s = await setup({ clarify: clar.fn, config: { clarifyAlertWindow: 2, clarifyAlertRate: 0.5 } });
      const a = await s.engine.createIssue(s.projectId, { title: 'A' });
      seed(s, a.id, ['fail']);
      const b = await s.engine.createIssue(s.projectId, { title: 'B' });
      await s.engine.waitClarify();
      expect(alertOf(s)).toHaveLength(1);

      // 再失败一次：冷却期内不再发（6 小时默认冷却，测试时钟不推进）
      s.engine.scheduleClarify(b.id);
      await s.engine.waitClarify();
      expect(alertOf(s)).toHaveLength(1);

      const off = await setup({ clarify: mkClarify().fn, config: { clarifyAlertWindow: 0 } });
      const c = await off.engine.createIssue(off.projectId, { title: 'C' });
      seed(off, c.id, ['fail', 'fail']);
      await off.engine.createIssue(off.projectId, { title: 'D' });
      await off.engine.waitClarify();
      expect(alertOf(off)).toHaveLength(0);
    });

    test('默认配置就是发起人拍板的「最近 10 次 < 50%」，且可配置', () => {
      expect(DEFAULT_ENGINE_CONFIG.clarifyAlertWindow).toBe(10);
      expect(DEFAULT_ENGINE_CONFIG.clarifyAlertRate).toBe(0.5);
      expect(DEFAULT_ENGINE_CONFIG.clarifyAlertCooldownMs).toBeGreaterThan(0);
    });
  });

  test('归来竞态：分析期间 issue 被取消 → 丢弃只记 clarify_discarded', async () => {
    const clar = mkClarify();
    let release!: () => void;
    clar.gate = new Promise<void>((r) => (release = r));
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await untilCalls(clar, 1); // 分析已在途
    await s.engine.cancelIssue(b.id);
    release();
    await s.engine.waitClarify();

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('cancelled');
    expect(fresh.clarifyFeedback).toBeNull(); // 结果被丢弃
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_discarded');
    expect(kinds).not.toContain('clarify_done');
  });

  test('每项目串行单飞：并发峰值 1；排到时已非 pending 的直接 clarify_skipped', async () => {
    const clar = mkClarify();
    let release!: () => void;
    clar.gate = new Promise<void>((r) => (release = r));
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    const c = await s.engine.createIssue(s.projectId, { title: 'C' });
    await untilCalls(clar, 1);
    expect(clar.calls.length).toBe(1); // C 在链上排队，没并发起跑
    await s.engine.cancelIssue(c.id); // B 分析期间 C 被取消
    release();
    await s.engine.waitClarify();

    expect(clar.maxInflight).toBe(1);
    expect(clar.calls.map((x) => x.input.issueId)).toEqual([b.id]); // C 没起会话
    expect(s.engine.store.listEvents(c.id).map((e) => e.kind)).toContain('clarify_skipped');
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('反馈：懂了');
  });

  test('合并后 host：旧反馈清空并重新分析（未随即开跑的 host 拿到新反馈）', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '首轮', questions: [] };
    const s = await setup({ clarify: clar.fn });
    const { engine, pm } = s;
    // 同模块 web 两个 (agent) 子组：claude b/c、codex e/f（全 pending）
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    const e = await engine.createIssue(s.projectId, { title: 'E', body: 'ee', module: 'web', agent: 'codex' }, false);
    const f = await engine.createIssue(s.projectId, { title: 'F', body: 'ff', module: 'web', agent: 'codex' }, false);
    await engine.waitClarify(); // 首轮分析落定：4 条都有「首轮」
    expect(engine.store.get(e.id)!.clarifyFeedback).toBe('首轮');

    clar.result = { ok: true, feedback: '合并后再析', questions: [] };
    pm.merges = [
      { members: [b.id, c.id], title: '合并 B+C', body: 'x' },
      { members: [e.id, f.id], title: '合并 E+F', body: 'y' },
    ];
    const callsBefore = clar.calls.length;
    await engine.scheduleNext(s.projectId, 'web');
    await engine.waitClarify();

    // host B 随即开跑：反馈被清空、不再重析（planning 阶段自会对齐）
    expect(engine.store.get(b.id)!.status).toBe('planning');
    expect(engine.store.get(b.id)!.clarifyFeedback).toBeNull();
    // host E 仍排队：清空旧反馈后重新分析拿到新反馈
    expect(engine.store.get(e.id)!.status).toBe('pending');
    expect(engine.store.get(e.id)!.clarifyFeedback).toBe('合并后再析');
    expect(engine.store.get(f.id)!.status).toBe('cancelled');
    // 第二轮只析了 E（B 已开跑不析、被折叠的 C/F 不析）
    expect(clar.calls.slice(callsBefore).map((x) => x.input.issueId)).toEqual([e.id]);
  });

  test('pending 答澄清后重新分析：反馈覆盖 + 可再抛新一轮问题（来回多轮）', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出' });
    await s.engine.waitClarify(); // 首轮：反馈「懂了」+ 问 1
    expect(clar.calls.length).toBe(1);
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(true);

    // 第一轮答复 → 并入正文 + 重新分析（第二轮仍有问题）
    clar.result = { ok: true, feedback: '二轮反馈', questions: ['问 2？'] };
    const r1 = await s.engine.clarify(b.id, 'CSV 就行');
    expect(r1).toEqual({ ok: true, from: 'pending', to: 'pending' });
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(2); // 触发了重分析
    // 答复与所答问题成对写入正文（否则编号答案脱离问题没人读得懂）
    expect(clar.calls[1]!.input.body).toContain('【澄清问答】');
    expect(clar.calls[1]!.input.body).toContain('1. 问 1？');
    expect(clar.calls[1]!.input.body).toContain('答：CSV 就行');
    const fresh1 = s.engine.store.get(b.id)!;
    expect(fresh1.status).toBe('pending');
    expect(fresh1.clarifyFeedback).toBe('二轮反馈'); // 反馈被覆盖
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(true); // 新一轮问题待答

    // 第二轮答复 → 再析（这次无问题 = 理解一致，收敛）
    clar.result = { ok: true, feedback: '三轮：清晰', questions: [] };
    await s.engine.clarify(b.id, '按默认来');
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(3);
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('三轮：清晰');
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(false); // 无新问题 → 面板收起
    // 三轮 clarify_started（每轮答复都触发重析）
    expect(s.engine.store.countEvents(b.id, 'clarify_started')).toBe(3);
  });

  test('轮数上限：两轮提问后仍更新反馈，但问题被压制（不落事件不通知）', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出' });
    await s.engine.waitClarify(); // 第 1 轮：问 1
    expect(clar.calls[0]!.input.allowQuestions).toBe(true);

    clar.result = { ok: true, feedback: '二轮反馈', questions: ['问 2？'] };
    await s.engine.clarify(b.id, '答 1');
    await s.engine.waitClarify(); // 第 2 轮：问 2（到上限）
    expect(clar.calls[1]!.input.allowQuestions).toBe(true);

    // 第 3 轮：runner 被告知不出题；即便 LLM 不听话仍回了问题，引擎也压制
    clar.result = { ok: true, feedback: '三轮反馈', questions: ['问 3？'] };
    await s.engine.clarify(b.id, '答 2');
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(3);
    expect(clar.calls[2]!.input.allowQuestions).toBe(false);
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('三轮反馈'); // 反馈照常更新
    expect(s.engine.store.countEvents(b.id, 'clarify_questions')).toBe(2); // 第三轮没落问题
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(false); // 面板不再挂新问题
    expect(s.notifications.some((n) => n.issueId === b.id && n.summary?.includes('问 3'))).toBe(false);
    expect(s.engine.store.countEvents(b.id, 'clarify_questions_suppressed')).toBe(1);
  });

  test('历轮问答注入：history 成对带问题与答复（多次答复并入同轮）；exec 问题不计轮数', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify(); // 第 1 轮：问 1
    expect(clar.calls[0]!.input.history).toEqual([]);

    // 伪造一条执行中来源的问题：不进创建时轮数、不进 history
    s.engine.store.logEvent(b.id, 'clarify_questions', { questions: ['exec 问'], source: 'exec', stage: 'planning' });

    clar.result = { ok: true, feedback: '二轮', questions: [] };
    await s.engine.clarify(b.id, '答 1');
    await s.engine.waitClarify();
    expect(clar.calls[1]!.input.allowQuestions).toBe(true); // 创建时才 1 轮，exec 不计
    expect(clar.calls[1]!.input.history).toEqual([{ questions: ['问 1？'], answer: '答 1' }]);

    // 无新问题后再补充：答复并入最近一轮（换行连接）
    clar.result = { ok: true, feedback: '三轮', questions: [] };
    await s.engine.clarify(b.id, '补充 2');
    await s.engine.waitClarify();
    expect(clar.calls[2]!.input.history).toEqual([{ questions: ['问 1？'], answer: '答 1\n补充 2' }]);
  });

  test('pending 改正文后重新分析（路由 PATCH 内容变化后同款调用）：分析拿到改后的正文', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '首析', questions: [] };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '原始' });
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(1);

    clar.result = { ok: true, feedback: '改后再析', questions: [] };
    s.engine.store.patchMeta(b.id, { body: '改后' });
    s.engine.scheduleClarify(b.id); // 路由 PATCH 检测到内容变化后即这么调
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(2);
    expect(clar.calls[1]!.input.body).toBe('改后');
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('改后再析');
  });

  test('非 pending 不重复分析：驱动态答澄清只注入不重析；scheduleClarify 对非 pending 静默跳过', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }); // 建即开跑 → planning，不分析
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.get(a.id)!.status).toBe('planning');

    // 驱动态答澄清：注入会话、记 clarified，但不触发重析
    const r = await s.engine.clarify(a.id, '按方案一');
    expect(r.ok).toBe(true);
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarified')).toBe(1);
    expect(s.engine.store.countEvents(a.id, 'clarify_started')).toBe(0);

    // 直接调 scheduleClarify（防未来调用点误用）：非 pending 静默跳过——不起会话、不记事件
    s.engine.scheduleClarify(a.id);
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarify_started')).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarify_skipped')).toBe(0);
  });

  test('未配 clarify 依赖：pending 答澄清照常并入正文，不炸不析', async () => {
    const s = await setup({}); // 无 clarify
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    const r = await s.engine.clarify(b.id, '补充一下');
    expect(r.ok).toBe(true);
    expect(s.engine.store.get(b.id)!.body).toContain('【澄清补充】补充一下');
  });
});

// ---------- 悬空澄清检测（重启恢复扫描的查询基础） ----------

describe('listDanglingClarify：最后一条 clarify_started 后无终态', () => {
  test('悬空命中；done/discarded/error@clarify 终态排除；无关 error 不算终态；不看 issue 状态', async () => {
    const s = await setup();
    const st = s.engine.store;
    const mk = (title: string) => st.create(s.projectId, { title });

    const dangling = mk('悬空：started 后无任何终态');
    st.logEvent(dangling.id, 'clarify_started', { agent: 'claude' });

    const finished = mk('正常完成');
    st.logEvent(finished.id, 'clarify_started', {});
    st.logEvent(finished.id, 'clarify_done', { questions: 0 });

    const discarded = mk('归来时已开跑丢弃');
    st.logEvent(discarded.id, 'clarify_started', {});
    st.logEvent(discarded.id, 'clarify_discarded', { status: 'planning' });

    const failed = mk('分析失败');
    st.logEvent(failed.id, 'clarify_started', {});
    st.logEvent(failed.id, 'error', { where: 'clarify', reason: 'timeout' });

    const otherError = mk('无关 error 不算终态');
    st.logEvent(otherError.id, 'clarify_started', {});
    st.logEvent(otherError.id, 'error', { where: 'scheduleNext', error: 'x' });

    const secondRound = mk('第一轮完整、第二轮悬空');
    st.logEvent(secondRound.id, 'clarify_started', {});
    st.logEvent(secondRound.id, 'clarify_done', { questions: 1 });
    st.logEvent(secondRound.id, 'clarify_questions', { questions: ['q？'] });
    st.logEvent(secondRound.id, 'clarified', { answer: 'a' });
    st.logEvent(secondRound.id, 'clarify_started', {});

    const doneStatus = mk('已完结 issue 的悬空也要列出（引擎侧收口用）');
    st.logEvent(doneStatus.id, 'clarify_started', {});
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(doneStatus.id);

    mk('从未分析过'); // 无 clarify_started → 不列

    const ids = st.listDanglingClarify().map((i) => i.id);
    expect(ids).toEqual([dangling.id, otherError.id, secondRound.id, doneStatus.id]);
  });

  test('归档项目不进扫描', async () => {
    const s = await setup();
    const st = s.engine.store;
    const i = st.create(s.projectId, { title: '归档项目的悬空' });
    st.logEvent(i.id, 'clarify_started', {});
    s.db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(s.projectId);
    expect(st.listDanglingClarify()).toHaveLength(0);
  });
});

// ---------- 重启恢复：悬空澄清分流（pending 重跑 / 非 pending 收口清残留） ----------

describe('start() 恢复扫描：被重启打断的创建时澄清', () => {
  test('pending 悬空自动重跑；已开跑悬空只收口清残留；正常完成不受影响', async () => {
    // 重启前进程：无 clarify 依赖的引擎造现场（createIssue 不会自己起分析）
    const s = await setup();
    const st = s.engine.store;
    const a = await s.engine.createIssue(s.projectId, { title: 'A 已开跑' }); // 建即开跑 → planning
    const b = await s.engine.createIssue(s.projectId, { title: 'B 排队中' }); // pending
    const c = await s.engine.createIssue(s.projectId, { title: 'C 完整轮次' }); // pending
    expect(st.get(a.id)!.status).toBe('planning');
    expect(st.get(b.id)!.status).toBe('pending');
    // 模拟重启打断：A/B 各有一轮有头无尾的分析；C 是正常完整轮次
    st.logEvent(a.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(b.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(c.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(c.id, 'clarify_done', { questions: 0 });
    // A 的中断残留现场：clr 会话还挂着 + scratch 没清（runner finally 没机会跑）
    s.driver.tmuxSessions.add(`clr-${a.id}`);
    const aScratch = path.join(s.repo, '.panda/tmp/clarify', String(a.id));
    await fsp.mkdir(aScratch, { recursive: true });
    await fsp.writeFile(path.join(aScratch, 'task.md'), 'x');

    // 重启后进程：同 DB 新引擎实例，带 clarify 依赖，start() 触发恢复扫描
    const calls: number[] = [];
    const engine2 = new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: { locate: async () => null },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      clarify: async (_p, input) => {
        calls.push(input.issueId);
        return { ok: true, feedback: '恢复后的反馈', questions: [] };
      },
      config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
    });
    engine2.start();
    await engine2.waitClarify();
    await engine2.stop();

    // B（pending 悬空）：重跑 —— 只有 B 被分析，新一轮 started+done，反馈落库
    expect(calls).toEqual([b.id]);
    expect(st.get(b.id)!.clarifyFeedback).toBe('恢复后的反馈');
    expect(st.countEvents(b.id, 'clarify_started')).toBe(2);
    expect(st.countEvents(b.id, 'clarify_done')).toBe(1);
    // A（planning 悬空）：不重跑，补 clarify_discarded 收口 + 残留会话/scratch 清掉
    const disc = st.listEvents(a.id).find((e) => e.kind === 'clarify_discarded');
    expect(disc).toBeTruthy();
    expect(JSON.parse(disc!.dataJson!)).toMatchObject({ status: 'planning', via: 'recover' });
    expect(st.countEvents(a.id, 'clarify_started')).toBe(1);
    expect(s.driver.tmuxSessions.has(`clr-${a.id}`)).toBe(false);
    expect(await fsp.stat(aScratch).catch(() => null)).toBeNull();
    // C（完整轮次）：事件原样不动
    expect(st.countEvents(c.id, 'clarify_started')).toBe(1);
    expect(st.countEvents(c.id, 'clarify_discarded')).toBe(0);
    // 扫描收敛：全库悬空清零
    expect(st.listDanglingClarify()).toHaveLength(0);
  });

  test('未配 clarify 依赖：start() 恢复扫描整体跳过（不收口不清理，等有依赖的进程来恢复）', async () => {
    const s = await setup();
    const st = s.engine.store;
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }); // planning
    st.logEvent(a.id, 'clarify_started', { agent: 'claude' });
    s.engine.start();
    await s.engine.waitClarify();
    await s.engine.stop();
    expect(st.countEvents(a.id, 'clarify_discarded')).toBe(0);
    expect(st.listDanglingClarify()).toHaveLength(1);
  });
});

// ---------- #277 / I-01：模块知识增量 ----------

describe('模块知识增量：segment 结束时由引擎确定性写入（#277 / I-01）', () => {
  const moduleRow: ProjectModule = {
    id: 31, projectId: 1, slug: 'core', displayName: 'core', agent: 'claude',
    source: 'manual', status: 'active', conversationId: null,
    syncStatus: 'ready', syncError: null, createdBy: 1, createdTs: 1, lastUsedTs: null,
  };
  type Entry = { issueId: number; status: string; title: string; note?: string };

  /** 建一条已绑模块、已开 segment 的 issue，返回收到的知识条目数组 */
  const withModule = async (opts: { fail?: boolean } = {}) => {
    const written: Entry[] = [];
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 }, // 收尾摘要另有专测，这里直接预置，只验知识提炼
      modulesFor: () => ({
        resolve: async () => moduleRow,
        recordIssue: async () => {},
        recordModuleKnowledge: async (_m, entry) => {
          if (opts.fail) throw new Error('磁盘满了');
          written.push(entry as Entry);
        },
      }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (31, ?, 'core', 'core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);
    return { s, written };
  };

  /** 让 issue 绑上模块并开出一段 segment（segment_started 由 startIssue 落） */
  const startWithModule = async (s: Awaited<ReturnType<typeof setup>>, title: string) => {
    const issue = await s.engine.createIssue(s.projectId, { title, moduleId: 31 }, false);
    expect((await s.engine.startIssue(issue.id)).ok).toBe(true);
    expect(s.engine.store.countEvents(issue.id, 'conversation_segment_started')).toBe(1);
    return issue;
  };

  test('done 收尾写一条：标题 + 状态 + 摘要首段 + 改动文件数', async () => {
    const { s, written } = await withModule();
    s.setManualReview(false);
    const issue = await startWithModule(s, '加导出');
    s.engine.store.setSubtasks(issue.id, ['做完']);
    s.engine.store.setResultSummary(issue.id, '目标：给导出加 CSV 支持\n子任务：1/1 完成');
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export const x = 1;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ issueId: issue.id, status: 'done', title: '加导出' });
    expect(written[0]!.note).toContain('目标：给导出加 CSV 支持'); // 只取首段，不是整篇
    expect(written[0]!.note).not.toContain('子任务');
    expect(written[0]!.note).toMatch(/改动 \d+ 个文件/); // 文件数取自提交快照
  });

  test('blocked 收尾同样写一条', async () => {
    const { s, written } = await withModule();
    const issue = await startWithModule(s, '卡住的活');
    s.engine.store.setResultSummary(issue.id, '卡在这里：缺少凭据');
    await s.engine.applyEvent(issue.id, 'block', { note: '缺少凭据' });

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ issueId: issue.id, status: 'blocked', title: '卡住的活' });
    expect(written[0]!.note).toContain('缺少凭据');
  });

  test('cancelled 不写：「这版不做了」沉淀进模块知识只会误导下一条', async () => {
    const { s, written } = await withModule();
    const issue = await startWithModule(s, '不做了');
    await s.engine.applyEvent(issue.id, 'cancel');
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');
    expect(s.engine.store.countEvents(issue.id, 'conversation_segment_ended')).toBe(1); // 段照常收
    expect(written).toHaveLength(0); // 但不落知识
  });

  test('写失败只落 error{where:module-knowledge}，绝不阻断收尾', async () => {
    const { s } = await withModule({ fail: true });
    const issue = await startWithModule(s, '写盘会挂');
    await s.engine.applyEvent(issue.id, 'block', { note: '随便' });

    expect(s.engine.store.get(issue.id)!.status).toBe('blocked'); // 收尾照常完成
    const err = s.engine.store.listEvents(issue.id)
      .find((e) => e.kind === 'error' && (e.dataJson ?? '').includes('module-knowledge'));
    expect(err?.dataJson).toContain('磁盘满了');
  });

  test('没有模块 / 老装配没实现该方法：静默跳过，不报错', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } }); // 无 modulesFor
    const issue = await s.engine.createIssue(s.projectId, { title: '无模块' });
    await s.engine.applyEvent(issue.id, 'block', { note: 'x' });
    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    expect(s.engine.store.listEvents(issue.id)
      .some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('module-knowledge'))).toBe(false);
  });
});

// ---------- 执行结果总结（done/blocked 收尾，接力之前） ----------

describe('收尾摘要：确定性拼装（#275 / I-05）', () => {
  /** 最近一次进入 blocked 的 transition note（issues.note 不由 applyEvent 写） */
  const blockedNote = (s: Awaited<ReturnType<typeof setup>>, id: number) => {
    const raw = s.engine.store.listEvents(id)
      .findLast((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('"to":"blocked"'))?.dataJson;
    return raw ? String((JSON.parse(raw) as { note?: string }).note ?? '') : '';
  };
  /** 跑到 blocked 并返回摘要文本 */
  const blockAndRead = async (
    s: Awaited<ReturnType<typeof setup>>,
    issueId: number,
    note: string,
  ) => {
    await s.engine.applyEvent(issueId, 'block', { note });
    return s.engine.store.get(issueId)!.resultSummary;
  };

  test('blocked：用最近一次 block note + 最后一次失败事件 + 当时进度拼，不再注入任何东西', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } }); // >0 = 开
    const issue = await s.engine.createIssue(s.projectId, { title: '拼装受阻' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a', 'b']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    s.engine.store.logEvent(issue.id, 'error', { where: 'auto_commit', error: 'Author identity unknown' });
    const sentBefore = s.driver.sent.length;

    const text = await blockAndRead(s, issue.id, '自动提交失败，工作区改动已保留');

    expect(text).toContain('卡在这里：自动提交失败，工作区改动已保留');
    expect(text).toContain('最后一次失败：自动提交失败——Author identity unknown');
    expect(text).toContain('子任务：0/2 完成');
    // 关键：一次注入都没有（旧实现在这里要发一整轮满窗 prompt）
    expect(s.driver.sent.length).toBe(sentBefore);
    const kinds = s.engine.store.listEvents(issue.id).map((e) => e.kind);
    expect(kinds).not.toContain('summary_requested');
    expect(s.engine.store.listEvents(issue.id).find((e) => e.kind === 'summary_done')?.dataJson)
      .toContain('"via":"assembled"');
  });

  test('done：报告 + 客观数据一起拼，且完成度门禁按报告放行', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    s.setManualReview(false);
    const origin = path.join(s.dir, 'origin-summary.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);

    const issue = await s.engine.createIssue(s.projectId, { title: '拼装完成', module: 'auto' });
    const jl = await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'summary.ts'), 'export const s = 1;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');

    const report = {
      version: 1, outcome: 'complete', objective: '把摘要改成确定性拼装',
      implementation: ['加了 result-summary'], advantages: ['省一轮请求'], disadvantages: [],
      verification: ['跑了单测'], completion: '已完成', unmetGoals: [], remainingWork: [],
    };
    await s.appendOutput(jl, asst(
      `STAGE_DONE:${issue.id}:testing\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`,
    ));
    await s.engine.tick();

    expect(s.engine.store.get(issue.id)!.status).toBe('done'); // 报告 outcome=complete → 放行
    const text = s.engine.store.get(issue.id)!.resultSummary!;
    expect(text).toContain('目标：把摘要改成确定性拼装');
    expect(text).toContain('完成情况：已完成');
    expect(text).toContain('子任务：0/1 完成'); // 走 STAGE_DONE 直进，没有逐条 SUBTASK_DONE
    expect(text).toContain('改动：');
    expect(text).toContain('推送：已推送');
    expect(text).toContain('- 加了 result-summary');
  });

  test('报告说还有遗留 → 完成度门禁照旧把它挡在 done 之外', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '部署并验收', module: 'auto' });
    const jl = await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');

    const report = {
      version: 1, outcome: 'partial', objective: '目标', implementation: ['做了一半'],
      advantages: [], disadvantages: [], verification: [], completion: '还差部署',
      unmetGoals: [], remainingWork: ['需要人工部署后验收'],
    };
    await s.appendOutput(jl, asst(
      `STAGE_DONE:${issue.id}:testing\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`,
    ));
    await s.engine.tick();

    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.store.lastEnterInfo(issue.id,'implementing')?.note).toContain('需要人工部署后验收');
  });

  test('补齐报告后从 testing 正常完成，不要求用户解锁', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '补报', module: 'auto' });
    const jl = await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');
    const report = {
      version: 1, outcome: 'complete', objective: '补报', implementation: ['完成'],
      advantages: [], disadvantages: ['可选：另行部署'], verification: ['定向测试通过'],
      completion: '原始需求已交付', unmetGoals: [], remainingWork: [],
    };
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('done');
  });

  test('缺少报告先自动补报；重复缺失仍不虚报完成', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '没报告', module: 'auto' });
    const jl = await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.engine.store.get(issue.id)!.status).toBe('testing');
    expect(s.engine.store.listEvents(issue.id).filter(e => e.kind === 'completion_report_retry')).toHaveLength(1);
    expect(s.engine.store.listEvents(issue.id).some(e => e.kind === 'validation_started')).toBe(false);
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('paused');
    expect(s.engine.store.lastEnterInfo(issue.id,'paused')?.note).toContain('完成报告补报仍无效');
    expect(s.engine.store.countEvents(issue.id,'validation_started')).toBe(0);
  });

  test('一个字都拼不出来时才降级到 PM；PM 也没有则用确定性兜底文案', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    const bare = await s.engine.createIssue(s.projectId, { title: '光板' }, false);
    // 没有子任务、没有提交、没有失败事件，block 也不给 note → 拼装为空
    await s.engine.applyEvent(bare.id, 'block', { note: '' });
    expect(s.engine.store.get(bare.id)!.resultSummary).toBe('已受阻转人工（没有可展示的结构化信息）');
    expect(s.engine.store.listEvents(bare.id).find((e) => e.kind === 'summary_done')?.dataJson)
      .toContain('"via":"fallback"');

    // 接上 PM 的降级出口后，改走 PM
    const withPm = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    let summaryCalls=0;
    (withPm.pm as unknown as Record<string, unknown>).summarizeOutcome = async () => {summaryCalls++;return '不应调用';};
    const b2 = await withPm.engine.createIssue(withPm.projectId, { title: '光板2' }, false);
    await withPm.engine.applyEvent(b2.id, 'block', { note: '' });
    expect(withPm.engine.store.get(b2.id)!.resultSummary).toBe('已受阻转人工（没有可展示的结构化信息）');
    expect(withPm.engine.store.listEvents(b2.id).find((e) => e.kind === 'summary_done')?.dataJson)
      .toContain('"via":"fallback"');
    expect(summaryCalls).toBe(0);
  });

  test('cancelled 不总结；关掉开关（resultSummaryTimeoutMs: 0）时既不拼也不做完成度门禁', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 1 } });
    const c = await s.engine.createIssue(s.projectId, { title: '取消的' }, false);
    await s.engine.applyEvent(c.id, 'cancel');
    expect(s.engine.store.get(c.id)!.resultSummary).toBeNull();
    expect(s.engine.store.countEvents(c.id, 'summary_done')).toBe(0);

    const off = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const b = await off.engine.createIssue(off.projectId, { title: '关掉的' }, false);
    await off.engine.applyEvent(b.id, 'block', { note: '随便什么原因' });
    expect(off.engine.store.get(b.id)!.resultSummary).toBeNull();
    expect(off.engine.store.countEvents(b.id, 'summary_done')).toBe(0);
  });
});

// ---------- #93：取消后复活重跑 ----------

describe('reopenIssue：取消的 issue 改完需求重新运行', () => {
  test('cancelled → pending，落 reopened 事件并被重新调度开跑', async () => {
    const s = await setup();
    s.setManualReview(false); // 生产默认：全自动流
    const issue = await s.engine.createIssue(s.projectId, { title: '会被取消的任务', module: 'm' });
    await s.engine.cancelIssue(issue.id, s.admin.id);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');

    const r = await s.engine.reopenIssue(issue.id, s.admin.id);
    expect(r.ok).toBe(true);
    expect(r.ok && r.from).toBe('cancelled');
    expect(r.ok && r.to).toBe('pending');

    // reopened 事件带操作人，供审计/失败次数重新计数锚点
    const reopened = s.engine.store.listEvents(issue.id).filter((e) => e.kind === 'reopened');
    expect(reopened).toHaveLength(1);
    expect(JSON.parse(reopened[0]!.dataJson!).actor).toBe(s.admin.id);

    // 落到 pending 就会被接力立刻开跑（项目空闲时），不是停在待办等人点
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');

    // 清理与复活事件必须发生在**开跑之前**：reopened 的事件 id 要早于 pending→planning 的
    // transition。放到 applyEvent 返回之后再清，就会把接力刚生成的新计划一起抹掉。
    const events = s.engine.store.listEvents(issue.id);
    const reopenedId = events.find((e) => e.kind === 'reopened')!.id;
    // 取**复活后**那次进 planning（建 issue 时已经进过一次 planning，别拿第一条比）
    const toPlanningId = events
      .filter((e) => e.kind === 'transition' && JSON.parse(e.dataJson ?? '{}').to === 'planning')
      .at(-1)!.id;
    expect(reopenedId).toBeLessThan(toPlanningId);
  });

  test('清掉上一轮残留运行态，但保留 conv_id / 模块绑定 / 事件历史', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '带计划的任务', module: 'm' });
    s.engine.store.setSubtasks(issue.id, ['步骤一', '步骤二']);
    s.engine.store.advanceSubtask(issue.id); // 做完第一步，sub_index=1
    s.engine.store.setNote(issue.id, '上一轮的备注');
    const before = s.engine.store.get(issue.id)!;
    expect(before.subtasksJson).not.toBeNull();
    expect(before.subIndex).toBe(1);
    const convBefore = before.convId;
    const moduleBefore = before.module;
    const eventsBefore = s.engine.store.listEvents(issue.id).length;
    expect(convBefore).toBeTruthy();

    await s.engine.cancelIssue(issue.id, s.admin.id);
    await s.engine.reopenIssue(issue.id, s.admin.id);

    const after = s.engine.store.get(issue.id)!;
    // 清掉：旧计划与进度不能残留，否则复活后会照着上一版需求的计划继续跑
    expect(after.planJson).toBeNull();
    expect(after.subtasksJson).toBeNull();
    expect(after.subIndex).toBe(0);
    expect(after.note).toBeNull();
    expect(after.doneTs).toBeNull();
    // 保留：模块会话本就该被同模块 issue 顺序复用，清了反而要重建会话
    expect(after.convId).toBe(convBefore);
    expect(after.module).toBe(moduleBefore);
    // 事件历史是审计与「上一轮干到哪」的唯一来源，只增不减
    expect(s.engine.store.listEvents(issue.id).length).toBeGreaterThan(eventsBefore);
  });

  test('复活后测试失败次数重新计数：上一轮攒的失败不再压在头上（真跑引擎）', async () => {
    // 同上：本例考的是复活后的 failCount 重新计数，让开 #274 的同阶段重入闸
    const s = await setup({ config: { stopLossStageReentry: 99 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '屡试屡败', module: 'm' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    // 上一轮：攒满上限次失败 → blocked
    for (let round = 1; round <= MAX_TEST_FAILURES; round++) {
      expect(engine.store.get(issue.id)!.status).toBe('testing');
      await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 第 ${round} 轮挂了`));
      await engine.tick();
      expect(engine.store.get(issue.id)!.status).toBe('implementing');
      await engine.applyEvent(issue.id, 'impl_done');
    }
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(MAX_TEST_FAILURES);

    await engine.cancelIssue(issue.id, s.admin.id);
    await engine.reopenIssue(issue.id, s.admin.id);
    // 复活后重新走到 testing
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    expect(engine.store.get(issue.id)!.status).toBe('testing');

    // 关键：本轮第一次失败应回 implementing 重试。若失败次数仍按终生 COUNT 算（4 > 上限 3），
    // 这里会直接 blocked —— 复活等于白复活。
    await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 复活后第 1 次`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    // 历史不删：终生计数仍在，只是不再作为判据
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(MAX_TEST_FAILURES + 1);
  });

  test('cancelled 可直接复活；done 必须附带继续处理说明', async () => {
    const s = await setup();
    expect((await s.engine.reopenIssue(9999)).ok).toBe(false);

    const a = await s.engine.createIssue(s.projectId, { title: '待办的', module: 'm' });
    // 建完即开跑（全自动流），先断言非 cancelled 一律被拒
    const notCancelled = await s.engine.reopenIssue(a.id, s.admin.id);
    expect(notCancelled.ok).toBe(false);
    expect(!notCancelled.ok && notCancelled.error).toContain('仅已取消或已完成的 issue 可重新运行');

    // 历史误标 done 不能误触退回，明确说明后才能继续处理
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(a.id);
    const doneRes = await s.engine.reopenIssue(a.id, s.admin.id);
    expect(doneRes.ok).toBe(false);
    const corrected = await s.engine.reopenIssue(a.id, s.admin.id, '原目标尚未达成，继续完成部署');
    expect(corrected.ok).toBe(true);
  });

  test('复活是幂等安全的：并发两次只有一次成功，状态不被清成半截', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '并发复活', module: 'm' });
    await s.engine.cancelIssue(issue.id, s.admin.id);

    const [r1, r2] = await Promise.all([
      s.engine.reopenIssue(issue.id, s.admin.id),
      s.engine.reopenIssue(issue.id, s.admin.id),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(s.engine.store.countEvents(issue.id, 'reopened')).toBe(1);
  });
});

// ---------- Task 7.2：设计图原子发布适配器（Issue 域） ----------

describe('Task 7.2 原子 Issue 发布批次', () => {
  const draft = (
    nodeId: string,
    title: string,
    moduleId: number,
    implMode: 'direct' | 'team' = 'direct',
    agent: 'claude' | 'codex' = 'claude',
  ) => ({
    nodeId,
    title,
    body: `完整契约：${title}\n验收、测试、证据与完成报告均不可截断。`,
    moduleId,
    implMode,
    agent,
  });

  function readyModule(
    db: ReturnType<typeof openDb>,
    projectId: number,
    slug: string,
    agent: 'claude' | 'codex' = 'claude',
  ): ProjectModule {
    return new ModuleStore(db).create({
      projectId,
      slug,
      displayName: slug,
      agent,
      source: 'manual',
      createdTs: 10,
    });
  }

  test('第二个 node 插入失败时，整个批次及 created 事件一起回滚', async () => {
    const s = await setup();
    const mod = readyModule(s.db, s.projectId, 'batch-core');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('a', 'A', mod.id),
      draft('b', 'B', mod.id),
    ]);
    s.db.exec(`CREATE TRIGGER fail_second_publication_issue
      BEFORE INSERT ON issues WHEN NEW.title = 'B'
      BEGIN SELECT RAISE(ABORT, 'injected node fault'); END`);

    expect(() => s.engine.commitPreparedDesignBatch(prepared, [], () => {})).toThrow(/injected node fault/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_events').get()?.n).toBe(0);
  });

  test('dependency 或 linkage callback 抛错时，issues/dependencies/linkage 全部回滚', async () => {
    const s = await setup();
    const mod = readyModule(s.db, s.projectId, 'batch-links');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('root', 'Root', mod.id),
      draft('leaf', 'Leaf', mod.id),
    ]);
    s.db.exec('CREATE TABLE test_design_links (node_id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL)');
    s.db.exec(`CREATE TRIGGER fail_dependency_insert
      BEFORE INSERT ON issue_dependencies
      BEGIN SELECT RAISE(ABORT, 'injected dependency fault'); END`);
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [{ fromNodeId: 'root', toNodeId: 'leaf' }],
      () => {},
    )).toThrow(/injected dependency fault/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);

    s.db.exec('DROP TRIGGER fail_dependency_insert');
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [{ fromNodeId: 'root', toNodeId: 'leaf' }],
      (byNode) => {
        expect(byNode.size).toBe(2);
        expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_dependencies').get()?.n).toBe(1);
        s.db.query('INSERT INTO test_design_links (node_id, issue_id) VALUES (?, ?)')
          .run('root', byNode.get('root')!.id);
        throw new Error('injected linkage fault');
      },
    )).toThrow(/injected linkage fault/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_dependencies').get()?.n).toBe(0);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_design_links').get()?.n).toBe(0);
  });

  test('拒绝 async/thenable linkage callback，并回滚 callback 返回前的同步写入', async () => {
    const s = await setup();
    const mod = readyModule(s.db, s.projectId, 'batch-sync-callback');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [draft('a', 'A', mod.id)]);
    s.db.exec('CREATE TABLE test_design_links (node_id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL)');

    let asyncCallbackEntered = false;
    const asyncCallback = (async () => {
      asyncCallbackEntered = true;
      await Promise.resolve();
    }) as unknown as (issuesByNodeId: ReadonlyMap<string, EngineIssue>) => void;
    expect(() => s.engine.commitPreparedDesignBatch(prepared, [], asyncCallback)).toThrow(/synchronous|同步/);
    expect(asyncCallbackEntered).toBe(false);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);

    const thenableCallback = ((byNode: ReadonlyMap<string, EngineIssue>) => {
      s.db.query('INSERT INTO test_design_links (node_id, issue_id) VALUES (?, ?)')
        .run('a', byNode.get('a')!.id);
      return { then() {} };
    }) as unknown as (issuesByNodeId: ReadonlyMap<string, EngineIssue>) => void;
    expect(() => s.engine.commitPreparedDesignBatch(prepared, [], thenableCallback)).toThrow(/synchronous|同步/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_design_links').get()?.n).toBe(0);

    if (false) {
      // @ts-expect-error publication linkage callbacks must not return PromiseLike values
      s.engine.commitPreparedDesignBatch(prepared, [], async () => {});
    }
  });

  test('prepared capability 只允许创建它的 engine commit，callback 位于该 engine 的 DB 事务内', async () => {
    const owner = await setup();
    const other = await setup();
    const mod = readyModule(owner.db, owner.projectId, 'batch-owner');
    const prepared = await owner.engine.prepareDesignBatch(owner.projectId, [draft('a', 'A', mod.id)]);

    const sameDbOtherEngine = new IssueEngine({
      db: owner.db,
      driver: owner.driver,
      convs: owner.convs,
      locator: owner.locator,
      pmFor: () => owner.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      config: { resultSummaryTimeoutMs: 0 },
    });
    let foreignCallbackEntered = false;
    expect(() => sameDbOtherEngine.commitPreparedDesignBatch(prepared, [], () => {
      foreignCallbackEntered = true;
    })).toThrow(/untrusted|different IssueEngine|owner/);
    expect(() => other.engine.commitPreparedDesignBatch(prepared, [], () => {
      foreignCallbackEntered = true;
    })).toThrow(/untrusted|different IssueEngine|owner/);
    expect(foreignCallbackEntered).toBe(false);
    expect(owner.engine.store.listByProject(owner.projectId)).toHaveLength(0);
    expect(other.engine.store.listByProject(other.projectId)).toHaveLength(0);

    owner.db.exec('CREATE TABLE test_design_links (node_id TEXT PRIMARY KEY, issue_id INTEGER NOT NULL)');
    const committed = owner.engine.commitPreparedDesignBatch(prepared, [], (byNode) => {
      expect(owner.db.inTransaction).toBe(true);
      expect(other.db.inTransaction).toBe(false);
      owner.db.query('INSERT INTO test_design_links (node_id, issue_id) VALUES (?, ?)')
        .run('a', byNode.get('a')!.id);
    });
    expect(committed).toHaveLength(1);
    expect(owner.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_design_links').get()?.n).toBe(1);

    if (false) {
      // @ts-expect-error prepared batches carry a module-private capability brand
      const forged: PreparedDesignBatch = { projectId: owner.projectId, drafts: prepared.drafts };
      void forged;
    }
  });

  test('依赖图在首个 INSERT 前拒绝未知边、自环、重复边与环；generic store 拒绝跨项目边', async () => {
    const s = await setup();
    const mod = readyModule(s.db, s.projectId, 'batch-dag');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('a', 'A', mod.id),
      draft('b', 'B', mod.id),
      draft('c', 'C', mod.id),
    ]);
    s.db.exec(`CREATE TRIGGER reject_any_publication_insert
      BEFORE INSERT ON issues
      BEGIN SELECT RAISE(ABORT, 'node insert reached'); END`);
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [
        { fromNodeId: 'a', toNodeId: 'b' },
        { fromNodeId: 'b', toNodeId: 'c' },
        { fromNodeId: 'c', toNodeId: 'a' },
      ],
      () => {},
    )).toThrow(/cycle|环/);
    s.db.exec('DROP TRIGGER reject_any_publication_insert');
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [{ fromNodeId: 'missing', toNodeId: 'a' }],
      () => {},
    )).toThrow(/unknown/);
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [{ fromNodeId: 'a', toNodeId: 'a' }],
      () => {},
    )).toThrow(/itself/);
    expect(() => s.engine.commitPreparedDesignBatch(
      prepared,
      [
        { fromNodeId: 'a', toNodeId: 'b' },
        { fromNodeId: 'a', toNodeId: 'b' },
      ],
      () => {},
    )).toThrow(/duplicate/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);

    const otherProjectId = s.db.query<{ id: number }, [number]>(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
       VALUES ('other', 1, '/other', ?, 'other', 2) RETURNING id`,
    ).get(s.admin.id)!.id;
    const left = s.engine.store.create(s.projectId, { title: 'left' });
    const right = s.engine.store.create(otherProjectId, { title: 'right' });
    expect(() => s.engine.store.addDependency(left.id, right.id)).toThrow(/same project/);
  });

  test('commit 只落 pending：不启动、不绑定会话、不澄清，并精确映射 direct→seq/team→team', async () => {
    let clarifyCalls = 0;
    const s = await setup({
      clarify: async () => {
        clarifyCalls++;
        return { ok: true, feedback: '不应执行', questions: [] };
      },
    });
    const mod = readyModule(s.db, s.projectId, 'batch-modes');
    const exactBody = 'x'.repeat(5_000);
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      { ...draft('direct-node', 'Direct', mod.id, 'direct'), body: exactBody },
      draft('team-node', 'Team', mod.id, 'team'),
    ]);

    const issues = s.engine.commitPreparedDesignBatch(prepared, [], (byNode) => {
      expect([...byNode.values()].every((issue) => issue.status === 'pending')).toBe(true);
      expect([...byNode.values()].every((issue) => issue.convId === null)).toBe(true);
    });

    expect(issues.map((issue) => issue.implMode)).toEqual(['seq', 'team']);
    expect(issues[0]?.body).toBe(exactBody);
    expect(issues.every((issue) => issue.publicationLocked)).toBe(true);
    expect(clarifyCalls).toBe(0);
    expect(s.driver.sent).toHaveLength(0);
    expect(issues.flatMap((issue) => s.engine.store.listEvents(issue.id)).some((event) => event.kind === 'clarify_started'))
      .toBe(false);
  });

  test('prepare/commit 双重校验项目、模块 ready/agent 与执行机能力，失败不写入', async () => {
    const s = await setup();
    const valid = readyModule(s.db, s.projectId, 'batch-valid');
    const wrongAgent = readyModule(s.db, s.projectId, 'batch-codex', 'codex');

    const invalidCategory = { ...draft('x', 'X', valid.id), category: 'design' } as unknown as DesignIssueDraft;
    await expect(s.engine.prepareDesignBatch(s.projectId, [invalidCategory]))
      .rejects.toThrow(/ordinary task|普通 task/);

    const otherProject = s.db.query<{ id: number }, [number]>(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
       VALUES ('other', 1, '/other', ?, 'other', 2) RETURNING id`,
    ).get(s.admin.id)!;
    const foreignModule = readyModule(s.db, otherProject.id, 'batch-foreign');
    await expect(s.engine.prepareDesignBatch(s.projectId, [draft('foreign', 'Foreign', foreignModule.id)]))
      .rejects.toThrow(/outside project scope/);

    await expect(s.engine.prepareDesignBatch(s.projectId, [draft('x', 'X', wrongAgent.id, 'direct', 'claude')]))
      .rejects.toThrow(/module Agent/);
    s.db.query("UPDATE project_modules SET sync_status = 'error' WHERE id = ?").run(valid.id);
    await expect(s.engine.prepareDesignBatch(s.projectId, [draft('x', 'X', valid.id)]))
      .rejects.toThrow(/ready|同步/);
    s.db.query("UPDATE project_modules SET sync_status = 'ready' WHERE id = ?").run(valid.id);
    s.db.query('UPDATE executors SET supports_claude = 0 WHERE id = 1').run();
    await expect(s.engine.prepareDesignBatch(s.projectId, [draft('x', 'X', valid.id)]))
      .rejects.toThrow(/未启用 Claude/);

    s.db.query('UPDATE executors SET supports_claude = 1 WHERE id = 1').run();
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [draft('x', 'X', valid.id)]);
    s.db.query("UPDATE project_modules SET status = 'archived' WHERE id = ?").run(valid.id);
    expect(() => s.engine.commitPreparedDesignBatch(prepared, [], () => {})).toThrow(/active|归档/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);

    s.db.query("UPDATE project_modules SET status = 'active' WHERE id = ?").run(valid.id);
    s.db.query('UPDATE executors SET supports_claude = 0 WHERE id = 1').run();
    expect(() => s.engine.commitPreparedDesignBatch(prepared, [], () => {})).toThrow(/未启用 Claude/);
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);
  });

  test('dependency 是持久 runnable 门禁：置顶不能绕过，前驱 done 后自动解锁', async () => {
    const s = await setup();
    s.setManualReview(false);
    const mod = readyModule(s.db, s.projectId, 'batch-deps');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('root', 'Root', mod.id),
      draft('leaf', 'Leaf', mod.id),
    ]);
    const issues = s.engine.commitPreparedDesignBatch(
      prepared,
      [{ fromNodeId: 'root', toNodeId: 'leaf' }],
      () => {},
    );
    const root = issues[0]!;
    const leaf = issues[1]!;
    s.engine.store.setPinned(leaf.id, 999_999);

    const bypass = await s.engine.startIssue(leaf.id);
    expect(bypass.ok).toBe(false);
    expect(!bypass.ok && bypass.error).toContain('依赖');
    expect(s.engine.store.get(leaf.id)?.status).toBe('pending');

    await s.engine.completeDesignBatch(s.projectId, issues.map((issue) => issue.id));
    expect(s.engine.store.get(root.id)?.status).toBe('planning');
    expect(s.engine.store.get(leaf.id)?.status).toBe('pending');
    expect(s.engine.store.dependencyBlockers(leaf.id)).toEqual([{ issueId: root.id, status: 'planning' }]);

    s.engine.store.setSubtasks(root.id, ['implement']);
    expect((await s.engine.applyEvent(root.id, 'plan_ready')).ok).toBe(true);
    expect((await s.engine.applyEvent(root.id, 'impl_done')).ok).toBe(true);
    expect((await s.engine.applyEvent(root.id, 'tests_passed')).ok).toBe(true);
    expect(s.engine.store.get(root.id)?.status).toBe('done');
    expect(s.engine.store.get(leaf.id)?.status).toBe('planning');
    expect(s.engine.store.dependencyBlockers(leaf.id)).toEqual([]);
  }, 30000);

  test('design-linked pending 不进自动合并，LLM 返回后变成 linked 的竞态也会在落地锁内拒绝', async () => {
    const s = await setup();
    const mod = readyModule(s.db, s.projectId, 'batch-merge');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('a', 'Published A', mod.id),
      draft('b', 'Published B', mod.id),
    ]);
    const published = s.engine.commitPreparedDesignBatch(prepared, [], () => {});
    s.pm.merges = [{ members: published.map((issue) => issue.id), title: '不应合并', body: 'bad' }];
    await s.engine.scheduleNext(s.projectId, `#${mod.id}`);
    expect(s.pm.mergeCalls).toHaveLength(0);
    expect(s.engine.store.get(published[0]!.id)?.title).toBe('Published A');
    expect(s.engine.store.get(published[1]!.id)?.status).toBe('pending');

    await s.engine.cancelIssue(published[0]!.id);
    // A 的终态接力会立即启动 B；先把 B 也收口，下面才是在空闲项目里测真实 LLM 竞态。
    await s.engine.cancelIssue(published[1]!.id);
    const regularA = await s.engine.createIssue(s.projectId, { title: 'Regular A', module: mod.slug, moduleId: mod.id }, false);
    const regularB = await s.engine.createIssue(s.projectId, { title: 'Regular B', module: mod.slug, moduleId: mod.id }, false);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let suggested!: () => void;
    const suggestionStarted = new Promise<void>((resolve) => { suggested = resolve; });
    s.pm.mergeModuleTasks = async () => {
      suggested();
      await hold;
      return [{ members: [regularA.id, regularB.id], title: 'race merge', body: 'bad' }];
    };
    const scheduling = s.engine.scheduleNext(s.projectId, `#${mod.id}`);
    await suggestionStarted;
    s.db.query('UPDATE issues SET publication_locked = 1 WHERE id = ?').run(regularB.id);
    release();
    await scheduling;
    expect(s.engine.store.get(regularA.id)?.title).toBe('Regular A');
    expect(s.engine.store.get(regularB.id)?.status).toBe('pending');
  });

  test('module-doc outbox 按 item 回执：失败重试跳过已完成 item，且不重复创建 issue', async () => {
    const recordCalls = new Map<string, number>();
    let fail = true;
    const s = await setup({
      modulesFor: () => ({
        resolve: async () => { throw new Error('publication must not resolve modules'); },
        recordIssue: async (_module, issue) => {
          recordCalls.set(issue.title, (recordCalls.get(issue.title) ?? 0) + 1);
          if (fail && issue.title === 'B') throw new Error('injected module-doc failure');
        },
      }),
    });
    const mod = readyModule(s.db, s.projectId, 'batch-retry');
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [
      draft('a', 'A', mod.id),
      draft('b', 'B', mod.id),
    ]);
    const issues = s.engine.commitPreparedDesignBatch(prepared, [], () => {});
    const completed = new Set<string>();
    const retries: string[] = [];
    const outbox = {
      isComplete: async (operation: { key: string }) => completed.has(operation.key),
      markComplete: async (operation: { key: string }) => { completed.add(operation.key); },
      markRetry: async (operation: { key: string }, error: string) => { retries.push(`${operation.key}:${error}`); },
    };

    await expect(s.engine.completeDesignBatch(s.projectId, issues.map((issue) => issue.id), outbox))
      .rejects.toThrow(/post-commit|module-doc/);
    expect(recordCalls).toEqual(new Map([['A', 1], ['B', 1]]));
    expect(retries.some((entry) => entry.includes('module-doc') && entry.includes('injected'))).toBe(true);
    fail = false;
    await s.engine.completeDesignBatch(s.projectId, issues.map((issue) => issue.id), outbox);
    expect(recordCalls).toEqual(new Map([['A', 1], ['B', 2]]));
    expect(s.engine.store.listByProject(s.projectId).map((issue) => issue.id)).toEqual(issues.map((issue) => issue.id));
  });
});

describe('Task 7.2 generic execution sync boundary/recovery', () => {
  function restartedEngine(s: Awaited<ReturnType<typeof setup>>): IssueEngine {
    return new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: s.locator,
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      config: { now: s.clock.now, resultSummaryTimeoutMs: 0 },
    });
  }

  test('request 幂等、boundary 持久化、决定后重复恢复只执行一次且不创建 gate/新状态', async () => {
    const s = await setup();
    const mod = new ModuleStore(s.db).create({
      projectId: s.projectId,
      slug: 'sync-boundary',
      displayName: 'sync boundary',
      agent: 'claude',
      source: 'manual',
    });
    const prepared = await s.engine.prepareDesignBatch(s.projectId, [{
      nodeId: 'node-a',
      title: 'Sync target',
      body: 'baseline',
      moduleId: mod.id,
      implMode: 'direct',
      agent: 'claude',
    }]);
    const issue = s.engine.commitPreparedDesignBatch(prepared, [], () => {})[0]!;
    const request = {
      sourceKind: 'design',
      sourceKey: 'design-7/node-a',
      sourceRevision: '5',
      sourceDigest: 'sha256:five',
      diff: { title: { base: 'old', incoming: 'new' } },
    };
    const first = s.engine.requestExecutionSync(issue.id, request);
    const duplicate = s.engine.requestExecutionSync(issue.id, request);
    expect(duplicate.id).toBe(first.id);
    expect(() => s.engine.requestExecutionSync(issue.id, { ...request, sourceDigest: 'sha256:tampered' }))
      .toThrow(/conflict|冲突/);

    const held = s.engine.holdExecutionSyncBoundary(issue.id, 'plan_ready', {
      kind: 'issue-event',
      event: 'plan_ready',
    });
    expect(held).toMatchObject({ id: first.id, state: 'boundary_waiting', boundaryKind: 'plan_ready' });
    const decided = s.engine.decideExecutionSync(first.id, 'ignore', s.admin.id);
    expect(decided).toMatchObject({ state: 'ignored', resumeState: 'pending' });
    expect(decided.resumeKey).toMatch(/^issue-sync:/);
    expect(s.engine.decideExecutionSync(first.id, 'ignore', s.admin.id).id).toBe(first.id);

    let resumes = 0;
    const resume = (action: unknown) => {
      resumes++;
      expect(action).toEqual({ kind: 'issue-event', event: 'plan_ready' });
      return { ok: true };
    };
    expect(s.engine.recoverExecutionSyncs(resume).resumed).toBe(1);
    expect(s.engine.recoverExecutionSyncs(resume)).toEqual({ examined: 0, resumed: 0 });
    expect(s.engine.resumeExecutionSync(first.id, resume)).toEqual({
      resumed: false,
      result: { ok: true },
    });
    expect(resumes).toBe(1);
    expect(s.engine.store.getExecutionSync(first.id)?.resumeState).toBe('complete');
    expect(s.engine.store.get(issue.id)?.status).toBe('pending');
    expect(s.engine.store.listGates(issue.id)).toHaveLength(0);
  });

  test('effect callback 抛错时 effect/receipt/complete 同事务回滚，进程重建后可重试', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'sync retry' }, false);
    const sync = s.engine.requestExecutionSync(issue.id, {
      sourceKind: 'design',
      sourceKey: 'design-7/node-retry',
      sourceRevision: '9',
      sourceDigest: 'sha256:nine',
      diff: { body: 'incoming' },
    });
    s.engine.holdExecutionSyncBoundary(issue.id, 'impl_done', { kind: 'issue-event', event: 'impl_done' });
    s.engine.decideExecutionSync(sync.id, 'apply', s.admin.id);
    const stableResumeKey = s.engine.store.getExecutionSync(sync.id)?.resumeKey ?? null;
    expect(stableResumeKey).toMatch(/^issue-sync:/);
    s.db.exec('CREATE TABLE test_sync_effects (resume_key TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    let attempts = 0;
    expect(() => s.engine.recoverExecutionSyncs((_action, claimed) => {
      attempts++;
      s.db.query('INSERT INTO test_sync_effects (resume_key, calls) VALUES (?, 1)').run(claimed.resumeKey!);
      throw new Error('effect failed');
    })).toThrow(/effect failed/);
    expect(s.engine.store.getExecutionSync(sync.id)?.resumeState).toBe('pending');
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_sync_effects').get()?.n).toBe(0);
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_receipts',
    ).get()?.n).toBe(0);

    const restarted = new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: s.locator,
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      config: { resultSummaryTimeoutMs: 0 },
    });
    const recovered = restarted.recoverExecutionSyncs((action, claimed) => {
      attempts++;
      expect(action).toEqual({ kind: 'issue-event', event: 'impl_done' });
      expect(claimed.resumeKey).toBe(stableResumeKey);
      s.db.query('INSERT INTO test_sync_effects (resume_key, calls) VALUES (?, 1)').run(claimed.resumeKey!);
      return { resumed: true };
    });
    expect(recovered).toEqual({ examined: 1, resumed: 1 });
    expect(attempts).toBe(2);
    expect(restarted.store.getExecutionSync(sync.id)?.resumeState).toBe('complete');
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_sync_effects').get()?.n).toBe(1);
  });

  test('effect 与 receipt 后的 complete 提交失败时三者一起回滚，不留下可重复 crash window', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'atomic sync completion' }, false);
    const sync = s.engine.requestExecutionSync(issue.id, {
      sourceKind: 'design',
      sourceKey: 'design-7/node-atomic',
      sourceRevision: '9b',
      sourceDigest: 'sha256:nine-b',
      diff: { body: 'incoming' },
    });
    s.engine.holdExecutionSyncBoundary(issue.id, 'impl_done', { kind: 'issue-event', event: 'impl_done' });
    s.engine.decideExecutionSync(sync.id, 'apply', s.admin.id);
    s.db.exec('CREATE TABLE test_sync_effects (resume_key TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    s.db.exec(`CREATE TRIGGER fail_sync_effect_complete
      BEFORE UPDATE OF resume_state ON issue_execution_syncs
      WHEN NEW.resume_state = 'complete'
      BEGIN SELECT RAISE(ABORT, 'simulated crash before atomic commit'); END`);

    expect(() => s.engine.resumeExecutionSync(sync.id, (_action, claimed) => {
      s.db.query('INSERT INTO test_sync_effects (resume_key, calls) VALUES (?, 1)').run(claimed.resumeKey!);
      return { committed: true };
    })).toThrow(/simulated crash/);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_sync_effects').get()?.n).toBe(0);
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_receipts',
    ).get()?.n).toBe(0);
    expect(s.engine.store.getExecutionSync(sync.id)?.resumeState).toBe('pending');
  });

  test('effect callback 必须同步；async/thenable 在执行前被拒绝且不领取 claim', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'sync callback shape' }, false);
    const sync = s.engine.requestExecutionSync(issue.id, {
      sourceKind: 'design',
      sourceKey: 'design-7/node-shape',
      sourceRevision: '10',
      sourceDigest: 'sha256:ten',
      diff: { body: 'incoming' },
    });
    s.engine.holdExecutionSyncBoundary(issue.id, 'impl_done', { kind: 'issue-event', event: 'impl_done' });
    s.engine.decideExecutionSync(sync.id, 'apply', s.admin.id);

    let asyncEntered = false;
    const asyncCallback = (async () => {
      asyncEntered = true;
    }) as unknown as (action: unknown, claimed: IssueExecutionSync) => void;
    expect(() => s.engine.resumeExecutionSync(sync.id, asyncCallback)).toThrow(/synchronous|同步/);
    expect(asyncEntered).toBe(false);
    expect(s.engine.store.getExecutionSync(sync.id)?.resumeState).toBe('pending');

    const thenable = (() => ({ then() {} })) as unknown as (action: unknown, claimed: IssueExecutionSync) => void;
    expect(() => s.engine.resumeExecutionSync(sync.id, thenable)).toThrow(/synchronous|同步/);
    expect(s.engine.store.getExecutionSync(sync.id)?.resumeState).toBe('pending');

    if (false) {
      // @ts-expect-error resume effects must not return PromiseLike values
      s.engine.resumeExecutionSync(sync.id, async () => {});
    }
  });

  test('effect 后 complete 前崩溃：receipt 让 reset 直接完成，双 engine/recover 都不重跑 effect', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'crashed sync owner' }, false);
    const sync = s.engine.requestExecutionSync(issue.id, {
      sourceKind: 'design',
      sourceKey: 'design-7/node-crash',
      sourceRevision: '11',
      sourceDigest: 'sha256:eleven',
      diff: { body: 'incoming' },
    });
    s.engine.holdExecutionSyncBoundary(issue.id, 'tests_passed', {
      kind: 'issue-event',
      event: 'tests_passed',
    });
    const decided = s.engine.decideExecutionSync(sync.id, 'ignore', s.admin.id);
    const abandoned = s.engine.store.claimExecutionSyncResume(sync.id, s.clock.now())!;
    expect(abandoned).toMatchObject({ resumeState: 'running', resumeKey: decided.resumeKey });
    const restarted = restartedEngine(s);

    s.db.exec('CREATE TABLE test_sync_effects (resume_key TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    s.db.transaction(() => {
      s.db.query('INSERT INTO test_sync_effects (resume_key, calls) VALUES (?, 1)').run(decided.resumeKey!);
      s.db.query(
        `INSERT INTO issue_execution_sync_effect_receipts
           (resume_key, sync_id, result_json, completed_ts)
         VALUES (?, ?, ?, ?)`,
      ).run(decided.resumeKey!, sync.id, JSON.stringify({ value: { applied: true } }), s.clock.now());
    })();

    s.clock.advance(120_000);
    let actions = 0;
    expect(restarted.recoverExecutionSyncs(() => { actions++; }).resumed).toBe(0);
    expect(restarted.resetAbandonedExecutionSyncResume(sync.id, decided.resumeKey!, 'wrong-token')).toBe(false);
    expect(restarted.resetAbandonedExecutionSyncResume(sync.id, 'wrong-key', abandoned.resumeToken!)).toBe(false);
    expect(restarted.resetAbandonedExecutionSyncResume(
      sync.id,
      decided.resumeKey!,
      abandoned.resumeToken!,
    )).toBe(true);
    expect(restarted.recoverExecutionSyncs(() => { actions++; })).toEqual({ examined: 0, resumed: 0 });
    expect(restarted.resumeExecutionSync(sync.id, () => {
      actions++;
      return { applied: false };
    })).toEqual({
      resumed: false,
      result: { applied: true },
    });
    expect(actions).toBe(0);
    expect(s.db.query<{ calls: number }, []>('SELECT calls FROM test_sync_effects').get()?.calls).toBe(1);
    expect(restarted.store.getExecutionSync(sync.id)).toMatchObject({
      resumeState: 'complete',
      resumeToken: null,
    });
    expect(restarted.resetAbandonedExecutionSyncResume(
      sync.id,
      decided.resumeKey!,
      abandoned.resumeToken!,
    )).toBe(false);
  });

  test('两个 engine 对同一 resumeKey 只提交一次 DB effect，并可事务性写唯一外部 effect intent', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'duplicate resume engines' }, false);
    const sync = s.engine.requestExecutionSync(issue.id, {
      sourceKind: 'design',
      sourceKey: 'design-7/node-dupe',
      sourceRevision: '12',
      sourceDigest: 'sha256:twelve',
      diff: { body: 'incoming' },
    });
    s.engine.holdExecutionSyncBoundary(issue.id, 'tests_passed', { kind: 'issue-event', event: 'tests_passed' });
    s.engine.decideExecutionSync(sync.id, 'apply', s.admin.id);
    const second = restartedEngine(s);
    s.db.exec('CREATE TABLE test_sync_effects (resume_key TEXT PRIMARY KEY, calls INTEGER NOT NULL)');
    let callbacks = 0;
    const effect = (_action: unknown, claimed: IssueExecutionSync, context: IssueExecutionSyncEffectContext) => {
      callbacks++;
      s.db.query('INSERT INTO test_sync_effects (resume_key, calls) VALUES (?, 1)').run(claimed.resumeKey!);
      context.enqueueExternalEffect('dispatch', 'issue-event', { event: 'tests_passed' });
      return { owner: 'first' };
    };
    expect(s.engine.resumeExecutionSync(sync.id, effect)).toEqual({ resumed: true, result: { owner: 'first' } });
    expect(second.resumeExecutionSync(sync.id, effect)).toEqual({ resumed: false, result: { owner: 'first' } });
    expect(callbacks).toBe(1);
    expect(s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM test_sync_effects').get()?.n).toBe(1);
    expect(s.db.query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM issue_execution_sync_effect_outbox',
    ).get()?.n).toBe(1);
    const completed = s.engine.store.getExecutionSync(sync.id)!;
    expect(s.engine.resetAbandonedExecutionSyncResume(sync.id, completed.resumeKey!, completed.resumeToken ?? 'gone'))
      .toBe(false);
  });
});

describe('门禁范围与项目门禁命令的读写（047 / #279）', () => {
  test('setValidationScope 落库并读回；full 不留文件清单；null 清空', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '带门禁' });
    expect(s.engine.store.get(issue.id)!.validationScope).toBeNull(); // 还没算过

    s.engine.store.setValidationScope(issue.id, {
      kind: 'targeted',
      files: ['src/a.test.ts', 'src/b.test.ts'],
      reason: '按改动文件推导',
    });
    expect(s.engine.store.get(issue.id)!.validationScope).toEqual({
      kind: 'targeted',
      files: ['src/a.test.ts', 'src/b.test.ts'],
      reason: '按改动文件推导',
    });
    expect(s.engine.store.validationScope(issue.id)?.kind).toBe('targeted');

    // full 不该留文件清单（跑的是全量，留着只会误导 UI）
    s.engine.store.setValidationScope(issue.id, { kind: 'full', files: ['src/a.test.ts'], reason: '碰了公共文件' });
    expect(s.engine.store.validationScope(issue.id)).toEqual({ kind: 'full', files: [], reason: '碰了公共文件' });

    s.engine.store.setValidationScope(issue.id, null);
    expect(s.engine.store.get(issue.id)!.validationScope).toBeNull();
  });

  test('项目门禁命令：null（未配置）与空数组（显式不跑）是两回事', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const project = () => getProject(s.db, s.projectId)!;
    expect(project().validationCommands).toBeNull();

    s.engine.store.setValidationCommands(s.projectId, [
      { label: 'typecheck', argv: ['bun', 'run', 'typecheck'] },
      { label: '', argv: [] }, // 空命令直接丢
    ]);
    expect(project().validationCommands).toEqual([{ label: 'typecheck', argv: ['bun', 'run', 'typecheck'] }]);

    s.engine.store.setValidationCommands(s.projectId, []);
    expect(project().validationCommands).toEqual([]); // 显式不跑门禁

    s.engine.store.setValidationCommands(s.projectId, null);
    expect(project().validationCommands).toBeNull(); // 回到未配置
  });

  test('坏数据一律当未配置：门禁宁可多跑，不能因为一列脏数据整块报错', () => {
    expect(parseValidationScope('{坏')).toBeNull();
    expect(parseValidationScope('null')).toBeNull();
    expect(parseValidationScope('{"kind":"nope"}')).toBeNull();
    expect(parseValidationScope('{"kind":"targeted","files":["a",2,""],"reason":7}'))
      .toEqual({ kind: 'targeted', files: ['a'], reason: '' });

    expect(parseValidationCommands('{坏')).toBeNull();
    expect(parseValidationCommands('{"argv":[]}')).toBeNull(); // 不是数组
    expect(parseValidationCommands('[{"argv":["bun","test"]},{"argv":[]},7]'))
      .toEqual([{ label: 'bun', argv: ['bun', 'test'] }]); // label 缺省用 argv[0]
  });
});

describe('门禁在会话外跑（#279 / I-03）', () => {
  /** 把一条 issue 推到 testing，并把 package.json 写进仓库（否则探测不到门禁命令）*/
  const atTesting = async (
    s: Awaited<ReturnType<typeof setup>>,
    opts: { scripts?: Record<string, string> } = {},
  ) => {
    const issue = await s.engine.createIssue(s.projectId, { title: '要过门禁' });
    const jl = await s.bindJsonl(issue.id);
    if (opts.scripts !== undefined) {
      await fsp.writeFile(
        path.join(s.repo, 'package.json'),
        JSON.stringify({ name: 'demo', scripts: opts.scripts }),
      );
    }
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    await s.engine.applyEvent(issue.id, 'impl_done');
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');
    return { issue, jl };
  };
  const evt = (s: Awaited<ReturnType<typeof setup>>, id: number, kind: string) =>
    s.engine.store.listEvents(id).find((e) => e.kind === kind);

  test('通过：STAGE_DONE 之后引擎跑门禁，全绿才 tests_passed', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue, jl } = await atTesting(s, { scripts: { typecheck: 'tsc', test: 'bun test' } });
    s.driver.onRunCommand = () => ({ code: 0, out: 'all good' });

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.driver.runCalls.filter(c => c.argv[1] !== '-e').map((c) => c.argv)).toEqual([
      ['bun', 'run', 'typecheck'],
      ['bun', 'run', 'test'],
    ]);
    expect(evt(s, issue.id, 'validation_started')).toBeTruthy();
    expect(evt(s, issue.id, 'validation_passed')).toBeTruthy();
    expect(['merge_review', 'merging', 'done']).toContain(s.engine.store.get(issue.id)!.status);
  });

  test('失败：不放行，落 validation_failed 并把输出尾部当返工意见打回 implementing', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue, jl } = await atTesting(s, { scripts: { typecheck: 'tsc', test: 'bun test' } });
    s.driver.onRunCommand = (argv) =>
      argv.includes('typecheck') ? { code: 2, err: 'TS2345: 类型不匹配' } : { code: 0 };

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.engine.store.get(issue.id)!.status).toBe('implementing'); // 打回返工
    expect(s.driver.runCalls.filter(c => c.argv[1] !== '-e')).toHaveLength(1); // 首个失败即停，test 那条没跑
    const failed = evt(s, issue.id, 'validation_failed');
    expect(failed?.dataJson).toContain('typecheck');
    expect(failed?.dataJson).toContain('TS2345');
    const rework = evt(s, issue.id, 'tests_failed');
    expect(rework?.dataJson).toContain('TS2345'); // 失败输出回灌给代理
    expect(rework?.dataJson).toContain('"source":"validation"');
  });

  test('超时算失败，返工意见里说清是超时而不是用例挂了', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue, jl } = await atTesting(s, { scripts: { test: 'bun test' } });
    s.driver.onRunCommand = () => ({ code: -1, timedOut: true });

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(evt(s, issue.id, 'validation_failed')?.dataJson).toContain('"timedOut":true');
    expect(evt(s, issue.id, 'tests_failed')?.dataJson).toContain('超时');
  });

  test('命令缺失降级：探测不到门禁命令就放行，不把 issue 卡在 testing', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue, jl } = await atTesting(s); // 不写 package.json
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.driver.runCalls).toHaveLength(0);
    expect(evt(s, issue.id, 'validation_skipped')?.dataJson).toContain('no-commands');
    expect(['merge_review', 'merging', 'done']).toContain(s.engine.store.get(issue.id)!.status);
  });

  test('项目显式配置空数组 = 不跑门禁；配了命令则以配置为准（不回退探测）', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue, jl } = await atTesting(s, { scripts: { typecheck: 'tsc', test: 'bun test' } });
    s.engine.store.setValidationCommands(s.projectId, [{ label: 'ci', argv: ['make', 'ci'] }]);
    s.driver.onRunCommand = () => ({ code: 0 });

    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();
    expect(s.driver.runCalls.filter(c => c.argv[1] !== '-e').map((c) => c.argv)).toEqual([['make', 'ci']]);
  });

  test('validationTimeoutMs=0 关掉门禁执行：回到旧口径，一条命令都不跑', async () => {
    const s = await setup({ config: { validationTimeoutMs: 0 } });
    const { issue, jl } = await atTesting(s, { scripts: { test: 'bun test' } });
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await s.engine.tick();

    expect(s.driver.runCalls).toHaveLength(0);
    expect(evt(s, issue.id, 'validation_started')).toBeUndefined();
    expect(['merge_review', 'merging', 'done']).toContain(s.engine.store.get(issue.id)!.status);
  });

  test('进 testing 就把门禁范围算出来落库，供 UI 展示', async () => {
    const s = await setup({ config: { validationTimeoutMs: 60_000 } });
    const { issue } = await atTesting(s, { scripts: { test: 'bun test' } });
    const scope = s.engine.store.get(issue.id)!.validationScope;
    expect(scope).not.toBeNull();
    // 临时仓库里推不出对应测试文件 → 退回全量，理由写清楚
    expect(scope!.kind).toBe('full');
    expect(scope!.reason.length).toBeGreaterThan(0);
  });
});

describe('issue 推理档覆盖（048 / #281）', () => {
  test('未覆盖为 null（继承模块）；写入合法值；null 清回继承', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '高风险迁移' });
    expect(s.engine.store.get(issue.id)!.reasoningEffort).toBeNull();

    s.engine.store.setIssueReasoningEffort(issue.id, 'high'); // 迁移/状态机这类临时提档
    expect(s.engine.store.get(issue.id)!.reasoningEffort).toBe('high');
    s.engine.store.setIssueReasoningEffort(issue.id, null);
    expect(s.engine.store.get(issue.id)!.reasoningEffort).toBeNull();
  });

  test('非法档位拒绝写入', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: 'x' });
    expect(() => s.engine.store.setIssueReasoningEffort(issue.id, 'turbo' as never)).toThrow(/非法推理档位/);
    expect(s.engine.store.get(issue.id)!.reasoningEffort).toBeNull();
  });
});

describe('issue 成本视图数据（#282 / I-08）', () => {
  test('token 用量取 issue_usage，非 token 指标按事件溯源派生', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '贵的那条' });
    const store = s.engine.store;

    // 采集器写进来的用量
    s.db.run(
      `INSERT INTO issue_usage
         (issue_id, project_id, requests, input_tokens, cached_input_tokens, output_tokens,
          reasoning_tokens, compactions, tool_calls, skill_reads, updated_ts)
       VALUES (?, ?, 12, 400000, 380000, 9000, 2500, 2, 47, 3, 1)`,
      [issue.id, s.projectId],
    );
    // 非 token 侧：事件里本来就有
    for (let i = 0; i < 3; i++) store.logEvent(issue.id, 'tests_failed', { note: 'x' });
    for (let i = 0; i < 5; i++) store.logEvent(issue.id, 'nudged', {});
    store.logEvent(issue.id, 'judged', { result: 'not_done' });
    store.logEvent(issue.id, 'clarify_started', { agent: 'claude' });
    store.logEvent(issue.id, 'validation_passed', { durationMs: 70_000 });
    store.logEvent(issue.id, 'validation_failed', { durationMs: 12_500 });

    expect(store.issueCostStats(issue.id)).toEqual({
      issueId: issue.id,
      usage: {
        requests: 12, inputTokens: 400000, cachedInputTokens: 380000, outputTokens: 9000,
        reasoningTokens: 2500, compactions: 2, toolCalls: 47, skillReads: 3,
      },
      testRetries: 3,
      nudges: 5,
      judged: 1,
      clarifies: 1,
      validationMs: 82_500,
      validationRuns: 2,
    });
  });

  test('还没被采集到 → 用量全零而不是缺字段；坏事件只丢那一轮耗时', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '刚建的' });
    const stats = s.engine.store.issueCostStats(issue.id);
    expect(stats.usage).toEqual({
      requests: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
      reasoningTokens: 0, compactions: 0, toolCalls: 0, skillReads: 0,
    });
    expect(stats).toMatchObject({ testRetries: 0, nudges: 0, judged: 0, clarifies: 0, validationMs: 0, validationRuns: 0 });

    s.db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, 'validation_passed', '{坏', 1)`, [issue.id]);
    s.engine.store.logEvent(issue.id, 'validation_passed', { durationMs: 1000 });
    const after = s.engine.store.issueCostStats(issue.id);
    expect(after.validationRuns).toBe(2); // 坏事件仍算一轮
    expect(after.validationMs).toBe(1000); // 但它的耗时算不出来就不算
  });

  test('口径只数本 issue 的事件，不串味', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B' }, false);
    s.engine.store.logEvent(a.id, 'nudged', {});
    s.engine.store.logEvent(b.id, 'nudged', {});
    s.engine.store.logEvent(b.id, 'nudged', {});
    expect(s.engine.store.issueCostStats(a.id).nudges).toBe(1);
    expect(s.engine.store.issueCostStats(b.id).nudges).toBe(2);
  });
});

describe('调度事件降噪与来源标记（#283 / B-10）', () => {
  const eventsOf = (s: Awaited<ReturnType<typeof setup>>, id: number, kind: string) =>
    s.engine.store.listEvents(id).filter((e) => e.kind === kind);

  test('项目忙时踢接力：既不落 error，也不落 deferred（pickNext 早就短路了）', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const running = await s.engine.createIssue(s.projectId, { title: '先跑的' }); // 建即开跑
    expect(s.engine.store.get(running.id)!.status).toBe('planning');
    const queued = await s.engine.createIssue(s.projectId, { title: '排队的' });
    expect(s.engine.store.get(queued.id)!.status).toBe('pending');

    await s.engine.scheduleNext(s.projectId, { source: 'manual' });

    // 生产库里那条 error{where:'scheduleNext',error:'项目忙…'} 正是本条要消灭的噪音
    expect(eventsOf(s, queued.id, 'error')).toEqual([]);
    expect(eventsOf(s, queued.id, 'scheduling_deferred')).toEqual([]);
  });

  test('startIssue 把「正常排队」标成 deferral，调用方据此分级', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    await s.engine.createIssue(s.projectId, { title: '占着的' });
    const queued = await s.engine.createIssue(s.projectId, { title: '排队的' });

    expect(await s.engine.startIssue(queued.id)).toMatchObject({ ok: false, deferral: 'project-busy' });
    expect(await s.engine.startIssue(999999)).toMatchObject({ ok: false, deferral: 'issue-gone' });
    // 已经在跑的再开一次 = 被抢先，同样是正常竞态
    const running = s.engine.store.listByProject(s.projectId).find((i) => i.status === 'planning')!;
    expect(await s.engine.startIssue(running.id)).toMatchObject({ ok: false, deferral: 'not-pending' });
  });

  test('挑中之后被抢先：落 scheduling_deferred{source,reason}，不落 error', async () => {
    // 这一瞬（pickNext 之后、startIssue 读状态之前）没有公开注入点，直接替掉 startIssue
    // 让它返回一次 deferral，验证调度器的分级分支——分类本身另有用例覆盖。
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '被抢走的' }, false);
    const original = s.engine.startIssue.bind(s.engine);
    s.engine.startIssue = async () =>
      ({ ok: false, error: '仅 pending 可开跑（当前 cancelled）', deferral: 'not-pending' as const });
    try {
      await s.engine.scheduleNext(s.projectId, { source: 'manual' });
    } finally {
      s.engine.startIssue = original;
    }

    const deferred = s.engine.store.listEvents(issue.id).filter((e) => e.kind === 'scheduling_deferred');
    expect(deferred).toHaveLength(1);
    expect(JSON.parse(deferred[0]!.dataJson!)).toMatchObject({
      source: 'manual', reason: 'not-pending', issueId: issue.id,
    });
    expect(s.engine.store.listEvents(issue.id).filter((e) => e.kind === 'error')).toEqual([]);
  });

  test('真故障仍落 error{where:scheduleNext} 并带上来源', async () => {
    let explode = false;
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      executionWorkspaces: {
        resolve: () => {
          if (explode) throw new Error('执行工作区不可用');
          return { cwd: '/tmp', kind: 'project' as const, branch: null, runId: null };
        },
        conversationFor: async () => { throw new Error('n/a'); },
      },
    });
    const issue = await s.engine.createIssue(s.projectId, { title: '起不来的' }, false);
    explode = true;

    await s.engine.scheduleNext(s.projectId, { source: 'manual' });

    const errors = eventsOf(s, issue.id, 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(eventsOf(s, issue.id, 'scheduling_deferred')).toEqual([]);
  });

  test('接力链路无回归：前一条收尾后下一条自动开跑；并发踢接力有单飞守卫', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const first = await s.engine.createIssue(s.projectId, { title: 'A' });
    const second = await s.engine.createIssue(s.projectId, { title: 'B' });
    expect(s.engine.store.get(second.id)!.status).toBe('pending');

    await s.engine.applyEvent(first.id, 'cancel');
    expect(s.engine.store.get(second.id)!.status).not.toBe('pending'); // 接力真的把它挑起来了

    const third = await s.engine.createIssue(s.projectId, { title: 'C' }, false);
    await Promise.all([
      s.engine.scheduleNext(s.projectId, { source: 'manual' }),
      s.engine.scheduleNext(s.projectId, { source: 'relay' }),
      s.engine.scheduleNext(s.projectId, { source: 'manual' }),
    ]);
    expect(s.engine.store.get(third.id)!.status).toBe('pending'); // 项目仍忙，照常排队
    expect(eventsOf(s, third.id, 'error')).toEqual([]);
  });

  test('旧签名（第二个参数直接传模块键）仍然可用', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '老调用点' }, false);
    await s.engine.scheduleNext(s.projectId, moduleKeyOf(s.engine.store.get(issue.id)!));
    expect(s.engine.store.get(issue.id)!.status).not.toBe('pending');
  });
});

describe('受阻解除自动排队（#283 / B-10）', () => {
  /** 造一个「A 在跑、B 受阻」的现场 */
  const busyWithBlocked = async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const blocked = await s.engine.createIssue(s.projectId, { title: '受阻的' });
    await s.engine.applyEvent(blocked.id, 'block', { note: '缺依赖' });
    const running = await s.engine.createIssue(s.projectId, { title: '在跑的' });
    expect(s.engine.store.get(running.id)!.status).toBe('planning');
    expect(s.engine.store.get(blocked.id)!.status).toBe('blocked');
    return { s, blocked, running };
  };
  const kinds = (s: Awaited<ReturnType<typeof setup>>, id: number) =>
    s.engine.store.listEvents(id).map((e) => e.kind);

  test('项目忙时不再拒绝：落 unblock_requested 并返回 queued', async () => {
    const { s, blocked } = await busyWithBlocked();
    const r = await s.engine.unblockIssue(blocked.id, '装上依赖再跑', 7);
    expect(r).toMatchObject({ ok: true, queued: true });
    expect(s.engine.store.get(blocked.id)!.status).toBe('blocked'); // 还没恢复，只是排上了
    expect(kinds(s, blocked.id)).toContain('unblock_requested');
    expect(s.engine.store.pendingUnblockRequest(blocked.id)).toMatchObject({
      guidance: '装上依赖再跑', actor: 7,
    });
  });

  test('项目一空闲，接力自动把它恢复起来，留痕与手动解除完全一致', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    await s.engine.unblockIssue(blocked.id, '装上依赖再跑');

    await s.engine.applyEvent(running.id, 'cancel'); // 前一条收尾 → 接力

    const fresh = s.engine.store.get(blocked.id)!;
    expect(fresh.status).not.toBe('blocked'); // 真的恢复了
    expect(kinds(s, blocked.id)).toContain('unblock_guidance'); // 解除方法照常留痕
    expect(kinds(s, blocked.id)).toContain('unblock_request_consumed');
    expect(s.engine.store.pendingUnblockRequest(blocked.id)).toBeNull(); // 意图已消费
  });

  test('手动置顶的 pending 压过待恢复意图（发起人拍板：置顶优先）', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    const pinned = await s.engine.createIssue(s.projectId, { title: '置顶的新活' }, false);
    await s.engine.unblockIssue(blocked.id, '继续');
    s.engine.store.setPinned(pinned.id, Date.now());

    await s.engine.applyEvent(running.id, 'cancel');

    expect(s.engine.store.get(pinned.id)!.status).not.toBe('pending'); // 置顶的先跑
    expect(s.engine.store.get(blocked.id)!.status).toBe('blocked'); // 意图还留着，等下一轮
    expect(s.engine.store.pendingUnblockRequest(blocked.id)).not.toBeNull();
  });

  test('受阻那条自己也被置顶、且置顶更晚 → 它先回来', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    const pinned = await s.engine.createIssue(s.projectId, { title: '先置顶的新活' }, false);
    s.engine.store.setPinned(pinned.id, 1000);
    await s.engine.unblockIssue(blocked.id, '继续');
    s.engine.store.setPinned(blocked.id, 2000); // 后置顶的在前

    await s.engine.applyEvent(running.id, 'cancel');

    expect(s.engine.store.get(blocked.id)!.status).not.toBe('blocked');
    expect(s.engine.store.get(pinned.id)!.status).toBe('pending');
  });

  test('恢复优先于挑新 pending（都没置顶时）：已经花过钱的那条先回来', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    const fresh = await s.engine.createIssue(s.projectId, { title: '全新的' }, false);
    await s.engine.unblockIssue(blocked.id, '继续');

    await s.engine.applyEvent(running.id, 'cancel');

    expect(s.engine.store.get(blocked.id)!.status).not.toBe('blocked');
    expect(s.engine.store.get(fresh.id)!.status).toBe('pending'); // 新的还在排队
  });

  test('重复请求幂等：以最后一次的 guidance 为准', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    await s.engine.unblockIssue(blocked.id, '第一版说明');
    await s.engine.unblockIssue(blocked.id, '第二版说明');
    expect(s.engine.store.pendingUnblockRequest(blocked.id)!.guidance).toBe('第二版说明');

    await s.engine.applyEvent(running.id, 'cancel');
    const guidance = s.engine.store.listEvents(blocked.id)
      .filter((e) => e.kind === 'unblock_guidance');
    expect(guidance).toHaveLength(1); // 只恢复一次
    expect(guidance[0]!.dataJson).toContain('第二版说明');
  });

  test('撤销：撤掉之后接力不再恢复它', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    await s.engine.unblockIssue(blocked.id, '先排上');
    expect(s.engine.cancelUnblockRequest(blocked.id, 7)).toEqual({ ok: true });
    expect(s.engine.store.pendingUnblockRequest(blocked.id)).toBeNull();
    // 没有意图时撤销要明确报错，别静默无操作
    expect(s.engine.cancelUnblockRequest(blocked.id)).toMatchObject({ ok: false });

    await s.engine.applyEvent(running.id, 'cancel');
    expect(s.engine.store.get(blocked.id)!.status).toBe('blocked'); // 没被自动恢复
  });

  test('意图过期作废：issue 已经不是 blocked 就不再自动恢复', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    await s.engine.unblockIssue(blocked.id, '排上了');
    await s.engine.applyEvent(blocked.id, 'cancel'); // 用户改主意，直接取消
    expect(s.engine.store.pendingUnblockRequest(blocked.id)).toBeNull();

    await s.engine.applyEvent(running.id, 'cancel');
    expect(s.engine.store.get(blocked.id)!.status).toBe('cancelled'); // 没被意外拉回来
  });

  test('项目空闲时行为不变：直接恢复，不走排队', async () => {
    const s = await setup({ config: { resultSummaryTimeoutMs: 0 } });
    const issue = await s.engine.createIssue(s.projectId, { title: '独苗' });
    await s.engine.applyEvent(issue.id, 'block', { note: 'x' });

    const r = await s.engine.unblockIssue(issue.id, '接着干');
    expect(r).toMatchObject({ ok: true });
    expect('queued' in r).toBe(false);
    expect(s.engine.store.get(issue.id)!.status).not.toBe('blocked');
    expect(kinds(s, issue.id)).not.toContain('unblock_requested');
  });

  test('入参校验与状态校验不变：空 guidance、非 blocked 一律拒绝', async () => {
    const { s, blocked, running } = await busyWithBlocked();
    expect(await s.engine.unblockIssue(blocked.id, '   ')).toMatchObject({ ok: false });
    expect(await s.engine.unblockIssue(running.id, '在跑的不能解除')).toMatchObject({ ok: false });
    expect(await s.engine.unblockIssue(999999, 'x')).toMatchObject({ ok: false });
  });
});

describe('受阻恢复的阶段降级（无代理阶段不可恢复到原处）', () => {
  test('merging / merge_review 降级到 testing，其余阶段原样返回', () => {
    // merge_review 与 merging 没有代理参与：完成报告在 testing 由哨兵写死后收尾不再重取，
    // 总结是确定性拼装。恢复到原处会在同一个完成度门禁上无限受阻，故降级到 testing。
    expect(demoteAgentlessResume('merging')).toBe('testing');
    expect(demoteAgentlessResume('merge_review')).toBe('testing');

    expect(demoteAgentlessResume('planning')).toBe('planning');
    expect(demoteAgentlessResume('plan_review')).toBe('plan_review');
    expect(demoteAgentlessResume('implementing')).toBe('implementing');
    expect(demoteAgentlessResume('testing')).toBe('testing');
  });
});

describe('direct execution contract', () => {
  const report = { version: 1, outcome: 'complete', objective: '复制按钮', implementation: ['调整按钮'],
    advantages: [], disadvantages: [], verification: ['定向检查通过'], completion: '完成',
    unmetGoals: [], remainingWork: [], optionalFollowUps: ['尚未推送', '尚未部署', '以后可优化动画'] };
  test('default direct route completes without planning, subtasks or a testing model turn', async () => {
    const s = await setup({ config: { directExecution: true, resultSummaryTimeoutMs: 100, validationTimeoutMs: 0 } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '复制按钮' });
    expect(s.engine.store.get(issue.id)?.status).toBe('implementing');
    expect(s.engine.store.subtasksOf(s.engine.store.get(issue.id)!)).toEqual([]);
    expect(s.engine.store.countEvents(issue.id, 'impl_base')).toBe(1);
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    const attempt = s.engine.store.lastEnterEventId(issue.id, 'implementing');
    await s.appendOutput(jl, asst(`ISSUE_READY:${issue.id}:${attempt - 1}\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)?.status).toBe('implementing');
    expect(s.engine.store.get(issue.id)?.completionReport).toBeNull();
    await s.appendOutput(jl, asst(`ISSUE_READY:${issue.id}:${attempt}\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)?.status).toBe('done');
    const injected = s.engine.store.listEvents(issue.id).filter(e => e.kind === 'injected').map(e => JSON.parse(e.dataJson!));
    expect(injected.some(e => e.kind === 'planning' || e.kind === 'testing' || e.kind === 'subtask')).toBe(false);
    expect(s.engine.store.get(issue.id)?.completionReport?.optionalFollowUps).toEqual(report.optionalFollowUps);
  });
  test('complexity escalation is explicit and manual review keeps planning', async () => {
    const s = await setup({ config: { directExecution: true } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '复杂依赖' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst(`NEED_PLAN:${issue.id}:${s.engine.store.lastEnterEventId(issue.id, 'implementing')} 两个独立系统需要迁移协议`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'planning', executionMode: 'planned' });
    s.setManualReview(true);
    const manual = await s.engine.createIssue(s.projectId, { title: '手动评审', executionMode: 'direct' }, false);
    expect(manual.executionMode).toBe('planned');
  });
  test('missing direct report repairs once, then pauses and retains testing recovery', async () => {
    const s = await setup({ config: { directExecution: true, resultSummaryTimeoutMs: 100, validationTimeoutMs: 0 } });
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '报告协议' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    const ready = `ISSUE_READY:${issue.id}:${s.engine.store.lastEnterEventId(issue.id, 'implementing')}`;
    await s.appendOutput(jl, asst(ready)); await s.engine.tick();
    expect(s.engine.store.get(issue.id)?.status).toBe('testing');
    expect(s.engine.store.countEvents(issue.id, 'completion_report_retry')).toBe(1);
    await s.appendOutput(jl, asst(ready)); await s.engine.tick();
    expect(s.engine.store.get(issue.id)?.status).toBe('paused');
    expect(s.engine.store.lastEnterInfo(issue.id, 'paused')?.resumeState).toBe('testing');
    await s.engine.unblockIssue(issue.id, '恢复报告输出');
    expect(s.engine.store.get(issue.id)?.status).toBe('testing');
    await s.appendOutput(jl, asst(`${ready}\nREPORT_BEGIN\n${JSON.stringify(report)}\nREPORT_END`));
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)?.status).toBe('done');
  });
});

describe('validation execution integrity',()=>{
 test('executor failure pauses instead of reporting a successful skip',async()=>{
  const s=await setup({config:{validationTimeoutMs:100}});
  const issue=await s.engine.createIssue(s.projectId,{title:'验证异常'});const jl=await s.bindJsonl(issue.id);
  s.engine.store.setValidationCommands(s.projectId,[{label:'test',argv:['bun','test']}]);
  s.engine.store.setSubtasks(issue.id,['修改']);await s.engine.applyEvent(issue.id,'plan_ready');await s.engine.applyEvent(issue.id,'plan_approved');await s.engine.applyEvent(issue.id,'impl_done');
  s.driver.onRunCommand=()=>{throw Error('executor disconnected');};
  await s.appendOutput(jl,asst(`STAGE_DONE:${issue.id}:testing`));await s.engine.tick();
  expect(s.engine.store.get(issue.id)?.status).toBe('paused');
  expect(s.engine.store.countEvents(issue.id,'validation_passed')).toBe(0);
  expect(s.engine.store.countEvents(issue.id,'validation_skipped')).toBe(0);
 });
 test('passed checks survive recovery and rerun when the working-tree identity changes',async()=>{
  const s=await setup({config:{validationTimeoutMs:100}});
  const issue=await s.engine.createIssue(s.projectId,{title:'复用验证'});const jl=await s.bindJsonl(issue.id);
  await fsp.writeFile(path.join(s.repo,'package.json'),JSON.stringify({scripts:{test:'bun test'}}));
  s.engine.store.setSubtasks(issue.id,['修改']);await s.engine.applyEvent(issue.id,'plan_ready');await s.engine.applyEvent(issue.id,'plan_approved');await s.engine.applyEvent(issue.id,'impl_done');
  let identity='a'.repeat(64),runs=0;
  s.driver.onRunCommand=(argv)=>{
   if(argv[1]==='-e')return {code:0,out:'PANDA_VALIDATION_ID:'+identity,err:'',timedOut:false,durationMs:1};
   runs++;return {code:0,out:'ok',err:'',timedOut:false,durationMs:1};
  };
  await s.appendOutput(jl,asst(`STAGE_DONE:${issue.id}:testing`));await s.engine.tick();expect(runs).toBe(1);
  await s.engine.applyEvent(issue.id,'pause',{note:'暂停审查'});await s.engine.unblockIssue(issue.id,'继续验证');
  await s.appendOutput(jl,asst(`STAGE_DONE:${issue.id}:testing`));await s.engine.tick();expect(runs).toBe(1);
  expect(s.engine.store.countEvents(issue.id,'validation_reused')).toBe(1);
  identity='b'.repeat(64);await s.engine.applyEvent(issue.id,'pause',{note:'改动后再验'});await s.engine.unblockIssue(issue.id,'验证修改');
  await s.appendOutput(jl,asst(`STAGE_DONE:${issue.id}:testing`));await s.engine.tick();expect(runs).toBe(2);
 });
});

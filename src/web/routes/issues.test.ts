import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageCounter } from '../../core/activity';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import type { WorkflowGraphSnapshot } from '../../core/types';
import { UserStore } from '../../core/users';
import { ConversationManager } from '../../core/conversations';
import { LocalDriver } from '../../executor/local';
import {
  IssueEngine,
  migrateIssueEngine,
  type EngineClarifyInput,
  type EngineClarifyResult,
  type EngineDeps,
} from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { ModuleManager, ModuleStore } from '../../issues/modules';
import { validateWorkflowGraph, WorkflowTemplateStore } from '../../issues/workflows';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { issuesRoutes } from './issues';

class FakeDriver extends LocalDriver {
  tmuxSessions = new Set<string>();
  override async findExecutable(agent: 'claude' | 'codex') {
    return `/test/bin/${agent}`;
  }
  override async listSessions() {
    return [...this.tmuxSessions].map((name) => ({ name, createdTs: 0, attached: false }));
  }
  override async createSession(name: string) {
    this.tmuxSessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.tmuxSessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys() {}
  override async capturePane() {
    return '';
  }
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(opts: {
  clarify?: (project: unknown, input: EngineClarifyInput) => Promise<EngineClarifyResult>;
  /** true = 给引擎接上正式模块编排（ModuleManager + noop docs），模块管理路由测试用 */
  modules?: boolean;
  organize?: EngineDeps['organize'];
} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-routes-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );
  // 项目 1 归 alice（cwd 是真 git 仓库，approve → implementing 要建分支）
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  const driver = new FakeDriver();
  const g = (args: string[]) => driver.git(repo, args);
  await g(['init']);
  await g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await g(['config', 'user.email', 't@t']);
  await g(['config', 'user.name', 't']);
  await fsp.writeFile(path.join(repo, 'README.md'), 'x\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, ?, ?, ?)`,
  ).run(repo, alice.user.id, Date.now());
  // 项目 2 也归 alice（跨项目资源核对用）
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p2', 1, ?, ?, ?)`,
  ).run(path.join(dir, 'p2'), alice.user.id, Date.now());
  // 路由测试基线走卡点老流程（生产默认自动流在 engine 测试覆盖）
  db.run('UPDATE projects SET manual_review = 1');

  const locator = { locate: async () => null };
  const convs = new ConversationManager(db, driver, locator);
  const pm = {
    questions: null as string[] | null,
    /** #289 的拆回用例要真的走一次智能合并 */
    merges: [] as Array<{ members: number[]; title: string; body: string }>,
    async judgeDone() {
      return 'not_done' as const;
    },
    async generateClarifyingQuestions() {
      return pm.questions;
    },
    async mergeModuleTasks() {
      return pm.merges;
    },
  };
  const moduleStore = new ModuleStore(db);
  const manager = new ModuleManager(moduleStore, {
    suggest: async () => {
      throw new Error('路由测试不应咨询分类器');
    },
    docs: { async ensureModule() {}, async refreshIndex() {}, async renameDir() {} },
  });
  const engine = new IssueEngine({
    db,
    driver,
    convs,
    locator,
    pmFor: () => pm,
    notify: { dispatch: async () => {} },
    mutex: new KeyedMutex(),
    // 结果总结关掉：路由测试会 block/unblock，开着会对着假会话真轮询到超时
    config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
    ...(opts.clarify ? { clarify: opts.clarify } : {}),
    ...(opts.modules ? { modulesFor: () => manager } : {}),
    ...(opts.organize ? { organize: opts.organize } : {}),
  });
  // waiting_input 派生标记：测试里用集合模拟（生产由审批管道/引擎菜单观测提供）
  const waitingSet = new Set<number>();
  const messages = new MessageCounter(db);
  const dispatch = createDispatcher(
    issuesRoutes({
      db,
      engine,
      modules: moduleStore,
      waitingInput: (i) => waitingSet.has(i.id),
      usernameById: (id) => users.byId(id)?.username ?? null,
      messages,
    }),
    authDepsFromDb(db, users),
  );
  return { db, engine, pm, dispatch, admin, alice, bob, waitingSet, moduleStore, messages };
}

function req(method: string, path: string, token?: string, body?: unknown): Request {
  return new Request(`http://t${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function j(r: Response | Promise<Response> | null): Promise<{ status: number; body: any }> {
  const resp = await r!;
  return { status: resp.status, body: await resp.json() };
}

function workflowGraph(agent: 'claude' | 'codex' = 'codex'): WorkflowGraphSnapshot {
  return {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 5,
    nodes: [
      { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
      { key: 'work', kind: 'agent', title: '实现', instructions: '完成任务', agent, executionMode: 'write', maxVisits: 1, positionX: 100, positionY: 0, config: null },
      { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 200, positionY: 0, config: null },
    ],
    edges: [
      { key: 'issue-work', fromNodeKey: 'issue', toNodeKey: 'work', conditionText: null, priority: 0, isDefault: false },
      { key: 'work-end', fromNodeKey: 'work', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: false },
    ],
  };
}

function createWorkflow(db: ReturnType<typeof openDb>, projectId: number, name: string) {
  const validated = validateWorkflowGraph(workflowGraph(), ['claude', 'codex']);
  if (!validated.ok) throw new Error('测试工作流无效');
  return new WorkflowTemplateStore(db, () => 1_000).create({
    projectId,
    name,
    graph: validated.graph,
    graphJson: validated.graphJson,
    graphHash: validated.graphHash,
  });
}

describe('issues 路由：CRUD + 卡点 + 时间线 + 权限', () => {
  test('创建与编辑均按 8000 字符契约完整保存正文', async () => {
    const s = await setup();
    const body = '长'.repeat(8_000);
    const created = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '长正文', body,
    })));
    expect(created.status).toBe(200);
    expect(created.body.issue.body).toBe(body);

    s.db.query("UPDATE issues SET status = 'cancelled' WHERE id = ?").run(created.body.issue.id);
    const edited = await j(s.dispatch(req(
      'PATCH', `/api/projects/1/issues/${created.body.issue.id}`, s.alice.token, { body },
    )));
    expect(edited.status).toBe(200);
    expect(edited.body.issue.body).toBe(body);
  });

  test('高级工作流选择保存不可变快照和节点共享上下文', async () => {
    const s = await setup({ modules: true });
    s.db.run(
      `UPDATE projects
       SET goal = '交付目标', readme_summary = '项目简介', understanding = '项目知识',
           understanding_agent = 'claude', understanding_ts = 1234
       WHERE id = 1`,
    );
    const module = s.moduleStore.create({
      projectId: 1,
      slug: 'workflow-module',
      displayName: '工作流模块',
      agent: 'claude',
      source: 'manual',
      createdBy: s.alice.user.id,
    });
    const template = createWorkflow(s.db, 1, '标准交付');
    const created = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '共享上下文任务',
      body: '保持用户正文',
      category: 'design',
      moduleId: module.id,
      workflowTemplateId: template.template.id,
    })));
    expect(created.status).toBe(200);
    expect(created.body.workflow).toMatchObject({
      issueId: created.body.issue.id,
      templateId: template.template.id,
      templateVersionId: template.version.id,
      templateName: '标准交付',
      templateVersion: 1,
      context: {
        schemaVersion: 1,
        issue: { title: '共享上下文任务', body: '保持用户正文', category: 'design' },
        project: {
          id: 1,
          name: 'p1',
          goal: '交付目标',
          readmeSummary: '项目简介',
          understanding: '项目知识',
          understandingAgent: 'claude',
          understandingTs: 1234,
        },
        module: { id: module.id, slug: 'workflow-module', displayName: '工作流模块', agent: 'claude' },
        documents: {
          module: '.panda/modules/workflow-module/MODULE.md',
          issueProcess: `.panda/modules/workflow-module/issues/${created.body.issue.id}-issue.md`,
        },
      },
    });

    const originalGraph = created.body.workflow.graph;
    const next = workflowGraph();
    next.nodes.find((node) => node.key === 'work')!.title = '新版本实现';
    const validated = validateWorkflowGraph(next, ['claude', 'codex']);
    if (!validated.ok) throw new Error('测试工作流无效');
    new WorkflowTemplateStore(s.db, () => 2_000).publish(
      1,
      template.template.id,
      validated.graph,
      validated.graphJson,
      validated.graphHash,
    );
    const detail = await j(s.dispatch(req(
      'GET',
      `/api/projects/1/issues/${created.body.issue.id}`,
      s.alice.token,
    )));
    expect(detail.body.workflow.graph).toEqual(originalGraph);
    expect(detail.body.workflow.templateVersion).toBe(1);
    expect(detail.body.workflowRuntime).toMatchObject({
      workflow: { graph: originalGraph, templateVersion: 1 },
      worktrees: [],
    });
    expect(detail.body.workflowRuntime.runs.map((run: { nodeKey: string }) => run.nodeKey)).toEqual(['issue', 'work']);
    expect(detail.body.workflowRuntime.transitions).toMatchObject([{ edgeKey: 'issue-work', toNodeKey: 'work' }]);
  });

  test('拒绝无效或跨项目工作流选择且不留下 issue', async () => {
    const s = await setup();
    const other = createWorkflow(s.db, 2, '其他项目流程');
    const local = createWorkflow(s.db, 1, '当前项目流程');
    const before = s.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issues').get()!.count;
    const invalid = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '非法编号', workflowTemplateId: 'bad',
    })));
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('workflow.selection_invalid');
    const foreign = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '跨项目模板', workflowTemplateId: other.template.id,
    })));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('workflow.not_found');
    s.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    const unavailable = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '不可用 Agent', workflowTemplateId: local.template.id,
    })));
    expect(unavailable.status).toBe(409);
    expect(unavailable.body.error.code).toBe('workflow.agent_unavailable');
    expect(s.db.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM issues').get()!.count).toBe(before);
  });

  test('执行机未启用 Codex 时创建/修改 issue 返回 409，Claude 可用', async () => {
    const s = await setup();
    s.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    expect(
      (await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
        title: 'codex',
        agent: 'codex',
      })))).status,
    ).toBe(409);
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
        title: 'claude',
        agent: 'claude',
      })),
    );
    expect(created.status).toBe(200);
    const id = created.body.issue.id;
    s.db.query("UPDATE issues SET status = 'cancelled' WHERE id = ?").run(id);
    expect(
      (await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${id}`, s.alice.token, {
        agent: 'codex',
      })))).status,
    ).toBe(409);
  });

  test('模块列表按项目返回，供选择器记忆复用', async () => {
    const s = await setup();
    s.db.query(
      `INSERT INTO project_modules
         (project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (1, 'export-tools', 'Export Tools', 'codex', 'manual', ?, 1)`,
    ).run(s.alice.user.id);
    const r = (await s.dispatch(req('GET', '/api/projects/1/modules', s.alice.token)))!;
    expect(r.status).toBe(200);
    const body = await r.json() as { modules: Array<{ slug: string; agent: string }> };
    expect(body.modules).toEqual([expect.objectContaining({ slug: 'export-tools', agent: 'codex' })]);
  });

  test('clarify → 计划卡点 approve/reject 全流程（一律经引擎）', async () => {
    const s = await setup();

    // 未登录 401；非属主 403；admin 恒过
    expect((await j(s.dispatch(req('GET', '/api/projects/1/issues')))).status).toBe(401);
    expect((await j(s.dispatch(req('GET', '/api/projects/1/issues', s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(req('GET', '/api/projects/1/issues', s.admin.token)))).status).toBe(200);

    // 建 issue：澄清已前置到创建时（后台分析），design 也直进 planning（项目空闲建即开跑）
    const created = await j(
      s.dispatch(
        req('POST', '/api/projects/1/issues', s.alice.token, { title: '导出功能', body: '要能导出', category: 'design' }),
      ),
    );
    expect(created.status).toBe(200);
    const iid = created.body.issue.id as number;
    expect(created.body.issue.status).toBe('planning');

    // clarify：缺答案 400；已开跑（planning，驱动态）→ 200，答复注入实时会话、不迁移状态
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/clarify`, s.alice.token, {})))).status).toBe(400);
    const drivingClarify = await j(
      s.dispatch(req('POST', `/api/projects/1/issues/${iid}/clarify`, s.alice.token, { answer: '就用默认方案' })),
    );
    expect(drivingClarify.status).toBe(200);
    expect(drivingClarify.body.issue.status).toBe('planning');

    // 排队中的 pending 可补充澄清：并入 body、状态不动
    const queued = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '排队任务', body: '原始' })),
    );
    expect(queued.body.issue.status).toBe('pending');
    const qid = queued.body.issue.id as number;
    // 创建时澄清提了问题 → 列表/详情下发 clarifyPending=true（澄清待答角标）
    s.engine.store.logEvent(qid, 'clarify_questions', { questions: ['要不要鉴权？'] });
    const withQ = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    expect(withQ.body.find((x: any) => x.id === qid).clarifyPending).toBe(true);
    const cl = await j(
      s.dispatch(req('POST', `/api/projects/1/issues/${qid}/clarify`, s.alice.token, { answer: 'CSV 就行' })),
    );
    expect(cl.status).toBe(200);
    expect(cl.body.issue.status).toBe('pending');
    // 有未答问题时问答成对写入（问题 + 答复同现，编号答案不再脱离上下文）
    expect(cl.body.issue.body).toContain('【澄清问答】');
    expect(cl.body.issue.body).toContain('要不要鉴权？');
    expect(cl.body.issue.body).toContain('答：CSV 就行');
    // 回答后角标熄灭
    const answered = await j(s.dispatch(req('GET', `/api/projects/1/issues/${qid}`, s.alice.token)));
    expect(answered.body.issue.clarifyPending).toBe(false);
    // 澄清答复 = 用户发出的消息（013）：上面两次被引擎收下的答复各计一笔，400 的那次不计
    expect(s.messages.countsFor(s.alice.user.id)).toEqual({ today: 2, total: 2 });

    // start 只认 pending → 409
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/start`, s.alice.token)))).status).toBe(409);

    // 推到卡点①
    s.engine.store.setSubtasks(iid, ['写导出器', '加测试']);
    expect((await s.engine.applyEvent(iid, 'plan_ready')).ok).toBe(true);
    const gates = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}/gates`, s.alice.token)));
    expect(gates.body).toHaveLength(1);
    const gid = gates.body[0].id as number;

    // reject 必须带意见；bob 无权（middleware 403）；跨项目 gate 指鹿为马 404
    expect((await j(s.dispatch(req('POST', `/api/projects/1/gates/${gid}/reject`, s.alice.token, {})))).status).toBe(400);
    expect((await j(s.dispatch(req('POST', `/api/projects/1/gates/${gid}/approve`, s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(req('POST', `/api/projects/2/gates/${gid}/approve`, s.alice.token)))).status).toBe(404);

    // approve → implementing（引擎不建/不切分支，只记下开发者当前所在分支——此仓库在 main 上）
    const ap = await j(s.dispatch(req('POST', `/api/projects/1/gates/${gid}/approve`, s.alice.token)));
    expect(ap.status).toBe(200);
    expect(ap.body.issue.status).toBe('implementing');
    expect(ap.body.issue.branch).toBe('main');

    // 已决定的卡点再点 → 409（防重放）
    expect((await j(s.dispatch(req('POST', `/api/projects/1/gates/${gid}/approve`, s.alice.token)))).status).toBe(409);

    // 时间线全量事件
    const events = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}/events`, s.alice.token)));
    const kinds = (events.body as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds).toContain('created');
    expect(kinds).toContain('transition');
    expect(kinds).toContain('gate_decided');

    // 驱动中不能直接删；cancel 后可删
    expect((await j(s.dispatch(req('DELETE', `/api/projects/1/issues/${iid}`, s.alice.token)))).status).toBe(400);
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/cancel`, s.alice.token)))).status).toBe(200);
    expect((await j(s.dispatch(req('DELETE', `/api/projects/1/issues/${iid}`, s.alice.token)))).status).toBe(200);
  });

  test('缺失的 review gate 可重试生成；已有 gate、跨项目与无权限请求被拒', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(1, { title: '恢复 review', createdBy: s.alice.user.id });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.alice.user.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);
    expect(s.engine.store.casStatus(issue.id, 'testing', 'merge_review')).toBe(true);

    const path = `/api/projects/1/issues/${issue.id}/retry-gate`;
    expect((await j(s.dispatch(req('POST', path, s.bob.token)))).status).toBe(403);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/2/issues/${issue.id}/retry-gate`, s.alice.token)))).status,
    ).toBe(404);

    const recovered = await j(s.dispatch(req('POST', path, s.alice.token)));
    expect(recovered.status).toBe(200);
    expect(recovered.body.gate.kind).toBe('merge_review');
    expect(recovered.body.gate.status).toBe('waiting');
    expect((await j(s.dispatch(req('POST', path, s.alice.token)))).status).toBe(409);
  });

  test('PATCH 元数据 / detail / 带解除方法 unblock / 跨项目 issue 404', async () => {
    const s = await setup();
    s.pm.questions = null;
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A', module: 'web' })),
    );
    const iid = created.body.issue.id as number;
    expect(created.body.issue.status).toBe('planning'); // 空闲 → 自动开跑

    // detail 带 subtasks/gates；跨项目取 → 404
    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)));
    expect(detail.body.issue.id).toBe(iid);
    expect((await j(s.dispatch(req('GET', `/api/projects/2/issues/${iid}`, s.alice.token)))).status).toBe(404);

    // PATCH：已开跑（planning）→ 400 拒绝（只有 pending 可直接改内容）
    expect(
      (await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { module: 'core' })))).status,
    ).toBe(400);

    // 第二条 issue：项目忙（#1 在跑）→ 停在 pending，可直接改内容
    const created2 = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'B', module: 'web' })),
    );
    const iid2 = created2.body.issue.id as number;
    expect(created2.body.issue.status).toBe('pending');
    const patched = await j(
      s.dispatch(
        req('PATCH', `/api/projects/1/issues/${iid2}`, s.alice.token, {
          title: 'B2',
          body: '补充细节',
          module: 'core',
          implMode: 'team',
          agent: 'codex',
        }),
      ),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.issue.title).toBe('B2');
    expect(patched.body.issue.body).toBe('补充细节');
    expect(patched.body.issue.module).toBe('core');
    expect(patched.body.issue.implMode).toBe('team');
    expect(patched.body.issue.agent).toBe('codex'); // pending 未绑对话，可换代理

    // block → 解除方法必填；提交后从受阻前阶段继续（无恢复上下文才经队列回到 planning）
    expect((await s.engine.blockIssue(iid, '手动卡住')).ok).toBe(true);
    // block 会把队列中的 B 接力开跑；先取消它，才能验证 A 在无会话竞争时恢复原 planning 阶段。
    expect((await s.engine.cancelIssue(iid2)).ok).toBe(true);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/unblock`, s.alice.token, {})))).status,
    ).toBe(400);
    const ub = await j(
      s.dispatch(
        req('POST', `/api/projects/1/issues/${iid}/unblock`, s.alice.token, {
          guidance: '先修正执行参数，再继续运行',
        }),
      ),
    );
    expect(ub.status).toBe(200);
    expect(ub.body.issue.status).toBe('planning');
    const unblockEvent = s.engine.store.listEvents(iid).find((event) => event.kind === 'unblock_guidance');
    expect(unblockEvent?.dataJson).toContain('先修正执行参数，再继续运行');
  });

  test('PATCH 子任务只修改未派发项，并返回稳定错误码', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(1, { title: '编辑子任务', implMode: 'seq' });
    s.engine.store.setSubtasks(issue.id, ['当前项', '后续项']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const gate = s.engine.store.listGates(issue.id).find((candidate) => candidate.kind === 'plan')!;
    await s.engine.decideGate(gate.id, s.alice.user.id, 'approve');
    const base = `/api/projects/1/issues/${issue.id}/subtasks`;

    const updated = await j(s.dispatch(req('PATCH', `${base}/1`, s.alice.token, { text: '更新后的后续项' })));
    expect(updated.status).toBe(200);
    expect(updated.body.subtask).toEqual({ text: '更新后的后续项', done: false });

    const current = await j(s.dispatch(req('PATCH', `${base}/0`, s.alice.token, { text: '偷改当前项' })));
    expect(current.status).toBe(409);
    expect(current.body.error.code).toBe('issue.subtask_already_dispatched');

    expect((await s.engine.blockIssue(issue.id, '当前项缺少正确参数')).ok).toBe(true);
    const blockedCurrent = await j(
      s.dispatch(req('PATCH', `${base}/0`, s.alice.token, { text: '带正确参数重跑当前项' })),
    );
    expect(blockedCurrent.status).toBe(200);
    expect(blockedCurrent.body.subtask.text).toBe('带正确参数重跑当前项');
    expect(s.engine.store.get(issue.id)?.status).toBe('blocked');

    const empty = await j(s.dispatch(req('PATCH', `${base}/1`, s.alice.token, { text: '   ' })));
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('issue.subtask_text_required');

    const tooLong = await j(s.dispatch(req('PATCH', `${base}/1`, s.alice.token, { text: '字'.repeat(501) })));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe('issue.subtask_text_too_long');
    expect(tooLong.body.error.params).toEqual({ max: 500 });

    const missing = await j(s.dispatch(req('PATCH', `${base}/9`, s.alice.token, { text: '不存在' })));
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('issue.subtask_not_found');
    expect(
      (await j(s.dispatch(req('PATCH', `/api/projects/2/issues/${issue.id}/subtasks/1`, s.alice.token, {
        text: '跨项目',
      })))).status,
    ).toBe(404);
  });

  test('#93 编辑守卫允许 cancelled 和 blocked：保存不改变状态，done/驱动中仍拒', async () => {
    const s = await setup();
    // #1 建完即开跑（驱动态），#2 留在 pending
    const running = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '占位' })));
    const runId = running.body.issue.id as number;
    expect(running.body.issue.status).toBe('planning');

    // 驱动中：拒
    const drivingRes = await j(
      s.dispatch(req('PATCH', `/api/projects/1/issues/${runId}`, s.alice.token, { title: '偷改' })),
    );
    expect(drivingRes.status).toBe(400);
    expect(String(drivingRes.body.error.details)).toContain('执行中');

    // 取消后：可改内容（本 issue 的核心诉求——取消 → 改需求 → 重新运行）
    expect((await s.engine.cancelIssue(runId, s.alice.user.id)).ok).toBe(true);
    const edited = await j(
      s.dispatch(
        req('PATCH', `/api/projects/1/issues/${runId}`, s.alice.token, {
          title: '改过的标题',
          body: '换了个做法',
          targetBranch: 'feature/redo',
          sourceRef: 'refs/heads/main',
        }),
      ),
    );
    expect(edited.status).toBe(200);
    expect(edited.body.issue.title).toBe('改过的标题');
    expect(edited.body.issue.body).toBe('换了个做法');
    // Git 意图走的是另一条 SQL CAS，必须一起放宽，否则会静默不生效
    expect(edited.body.issue.targetBranch).toBe('feature/redo');
    expect(edited.body.issue.status).toBe('cancelled'); // 改内容不改状态

    // blocked：可先改需求，保存后仍保持受阻，等用户明确解除
    const blocked = await s.engine.createIssue(1, { title: '受阻的' }, false);
    expect((await s.engine.blockIssue(blocked.id, '卡住了')).ok).toBe(true);
    const blockedRes = await j(
      s.dispatch(
        req('PATCH', `/api/projects/1/issues/${blocked.id}`, s.alice.token, {
          title: '修订后的受阻需求',
          body: '补充正确运行方法',
        }),
      ),
    );
    expect(blockedRes.status).toBe(200);
    expect(blockedRes.body.issue.status).toBe('blocked');
    expect(blockedRes.body.issue.title).toBe('修订后的受阻需求');
    expect(blockedRes.body.issue.body).toBe('补充正确运行方法');

    // done：真终态，仍拒
    const finished = await s.engine.createIssue(1, { title: '完成的' }, false);
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(finished.id);
    const doneRes = await j(
      s.dispatch(req('PATCH', `/api/projects/1/issues/${finished.id}`, s.alice.token, { title: 'y' })),
    );
    expect(doneRes.status).toBe(400);
    expect(String(doneRes.body.error.details)).toContain('已完成');
  });

  test('PATCH 需求内容变化触发重新分析：title/body/截图变了才析，仅元数据或未变不析', async () => {
    const calls: EngineClarifyInput[] = [];
    const s = await setup({
      clarify: async (_p, input) => {
        calls.push(input);
        return { ok: true, feedback: '析过', questions: [] };
      },
    });
    // #1 空闲开跑占住项目；#2 pending → 创建即后台分析（第 1 次）
    await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const c2 = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'B', body: '原始' })),
    );
    const iid = c2.body.issue.id as number;
    expect(c2.body.issue.status).toBe('pending');
    await s.engine.waitClarify();
    expect(calls.length).toBe(1);

    // body 变 → 重析（分析拿到的是改后的正文）
    const p1 = await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { body: '改了' })));
    expect(p1.status).toBe(200);
    await s.engine.waitClarify();
    expect(calls.length).toBe(2);
    expect(calls[1]!.body).toBe('改了');

    // title 变 → 重析
    await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { title: 'B2' })));
    await s.engine.waitClarify();
    expect(calls.length).toBe(3);
    expect(calls[2]!.title).toBe('B2');

    // 截图变（加图）→ 重析
    const img = '.panda/uploads/x/shot.png';
    await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { images: [img] })));
    await s.engine.waitClarify();
    expect(calls.length).toBe(4);

    // 仅元数据（module/implMode）→ 不析；内容原样传回（title/body/截图未变）→ 不析
    await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { module: 'core', implMode: 'team' })));
    await j(
      s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { title: 'B2', body: '改了', images: [img] })),
    );
    await s.engine.waitClarify();
    expect(calls.length).toBe(4);
  });

  test('置顶：POST /pin 置顶/取消 pending；非 pending 409；跨项目 404', async () => {
    const s = await setup();
    s.pm.questions = null;
    // #1 空闲开跑 → planning；#2 项目忙 → pending
    const c1 = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const iid1 = c1.body.issue.id as number;
    expect(c1.body.issue.status).toBe('planning');
    const c2 = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'B' })));
    const iid2 = c2.body.issue.id as number;
    expect(c2.body.issue.status).toBe('pending');

    // 置顶 #2（pending）→ 200 + pinnedTs 落值（项目忙，仅调顺序不抢跑）
    const pin = await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid2}/pin`, s.alice.token, { pinned: true })));
    expect(pin.status).toBe(200);
    expect(pin.body.issue.pinnedTs).toBeGreaterThan(0);
    expect(pin.body.issue.status).toBe('pending');

    // 取消置顶 → pinnedTs 清空
    const unpin = await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid2}/pin`, s.alice.token, { pinned: false })));
    expect(unpin.status).toBe(200);
    expect(unpin.body.issue.pinnedTs).toBeNull();

    // 非 pending（#1 planning）置顶 → 409
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/pin`, s.alice.token, { pinned: true })))).status,
    ).toBe(409);

    // 跨项目置顶 → 404
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/2/issues/${iid2}/pin`, s.alice.token, { pinned: true })))).status,
    ).toBe(404);
  });

  test('自动批准档位：POST /auto-approve 改档（默认 medium）；非法值 400；跨项目 404', async () => {
    const s = await setup();
    s.pm.questions = null;
    const c = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const iid = c.body.issue.id as number;
    expect(c.body.issue.autoApprove).toBe('medium'); // issue 默认 = 现有审批行为

    const set = await j(
      s.dispatch(req('POST', `/api/projects/1/issues/${iid}/auto-approve`, s.alice.token, { level: 'cautious' })),
    );
    expect(set.status).toBe(200);
    expect(set.body.issue.autoApprove).toBe('cautious');
    // 详情返回体也带上（前端切换钮初值），且落了审计事件
    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)));
    expect(detail.body.issue.autoApprove).toBe('cautious');
    const events = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}/events`, s.alice.token)));
    const ev = (events.body as Array<{ kind: string; dataJson: string | null }>).find(
      (e) => e.kind === 'auto_approve_changed',
    );
    expect(JSON.parse(ev?.dataJson ?? '{}')).toMatchObject({ from: 'medium', to: 'cautious' });

    // 非法值 400（绝不悄悄兜底成某一档）
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/auto-approve`, s.alice.token, { level: 'x' }))))
        .status,
    ).toBe(400);
    // 跨项目 404
    expect(
      (await j(
        s.dispatch(req('POST', `/api/projects/2/issues/${iid}/auto-approve`, s.alice.token, { level: 'auto' })),
      )).status,
    ).toBe(404);
  });

  test('#115 新建时可带 autoApprove：认识的档位落库，缺省/脏值回 medium', async () => {
    const s = await setup();
    s.pm.questions = null;

    const auto = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '全自动的', autoApprove: 'auto' })),
    );
    expect(auto.status).toBe(200);
    expect(auto.body.issue.autoApprove).toBe('auto');
    expect(s.engine.store.get(auto.body.issue.id as number)!.autoApprove).toBe('auto');

    const cautious = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '谨慎的', autoApprove: 'cautious' })),
    );
    expect(cautious.body.issue.autoApprove).toBe('cautious');

    // 脏值不抛（列上有 CHECK 约束，插进去会把建 issue 整条打挂）——兜底 medium
    const dirty = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '脏值的', autoApprove: 'x' })),
    );
    expect(dirty.status).toBe(200);
    expect(dirty.body.issue.autoApprove).toBe('medium');
    // 不带字段（老前端）仍是 medium
    const plain = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '没带的' })));
    expect(plain.body.issue.autoApprove).toBe('medium');
  });

  test('#111 收尾后锁档：done/cancelled 改档 409；blocked 仍可改', async () => {
    const s = await setup();
    s.pm.questions = null;
    const c = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const iid = c.body.issue.id as number;

    // 受阻仍可改——重试前调档正是它的用法，别顺手锁掉
    expect((await s.engine.blockIssue(iid, '卡住了', s.alice.user.id)).ok).toBe(true);
    const onBlocked = await j(
      s.dispatch(req('POST', `/api/projects/1/issues/${iid}/auto-approve`, s.alice.token, { level: 'auto' })),
    );
    expect(onBlocked.status).toBe(200);
    expect(onBlocked.body.issue.autoApprove).toBe('auto');

    // 已完成 → 409，且档位没被动过
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('done', iid);
    const onDone = await j(
      s.dispatch(req('POST', `/api/projects/1/issues/${iid}/auto-approve`, s.alice.token, { level: 'cautious' })),
    );
    expect(onDone.status).toBe(409);
    expect(String(onDone.body.error.details)).toContain('已完成/已取消');
    expect(s.engine.store.get(iid)!.autoApprove).toBe('auto');
    expect(s.engine.store.countEvents(iid, 'auto_approve_changed')).toBe(1); // 拒改不记审计

    // 已取消 → 409
    const c2 = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'B' })));
    const iid2 = c2.body.issue.id as number;
    expect((await s.engine.cancelIssue(iid2, s.alice.user.id)).ok).toBe(true);
    expect(
      (await j(
        s.dispatch(req('POST', `/api/projects/1/issues/${iid2}/auto-approve`, s.alice.token, { level: 'auto' })),
      )).status,
    ).toBe(409);
  });

  test('#93 复活重跑：POST /reopen 取消的 → pending 并开跑；非 cancelled 409；跨项目 404；无权限 403', async () => {
    const s = await setup();
    const c1 = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const iid1 = c1.body.issue.id as number;
    expect(c1.body.issue.status).toBe('planning');

    // 非 cancelled（驱动中）→ 409 且文案说清为什么
    const notCancelled = await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/reopen`, s.alice.token)));
    expect(notCancelled.status).toBe(409);
    expect(String(notCancelled.body.error.details)).toContain('仅已取消或已完成的 issue 可重新运行');
    expect(String(notCancelled.body.error.details)).toContain('planning'); // 带上当前状态，便于排查

    // 取消 → 改需求 → 复活：完整走一遍本 issue 的目标流程
    expect((await s.engine.cancelIssue(iid1, s.alice.user.id)).ok).toBe(true);
    const edited = await j(
      s.dispatch(req('PATCH', `/api/projects/1/issues/${iid1}`, s.alice.token, { title: '改完再来' })),
    );
    expect(edited.status).toBe(200);

    const reopened = await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/reopen`, s.alice.token)));
    expect(reopened.status).toBe(200);
    expect(reopened.body.issue.title).toBe('改完再来');
    // 项目空闲 → 落 pending 后被接力立刻开跑
    expect(['pending', 'planning']).toContain(reopened.body.issue.status);
    expect(s.engine.store.countEvents(iid1, 'reopened')).toBe(1);

    // 重放：已经复活过，再点一次 → 409（不会复活两回）
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/reopen`, s.alice.token)))).status,
    ).toBe(409);

    // 跨项目 → 404（鉴权与 cancel/unblock 一致）
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/2/issues/${iid1}/reopen`, s.alice.token)))).status,
    ).toBe(404);

    // 非成员 → 403
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/reopen`, s.bob.token)))).status,
    ).toBe(403);

    // 未登录 → 401
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid1}/reopen`)))).status).toBe(401);
  });

  test('POST /reopen 退回历史 done 时必须提供 guidance', async () => {
    const s = await setup();
    const created = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '误标完成' })));
    const iid = created.body.issue.id as number;
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(iid);
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/reopen`, s.alice.token)))).status).toBe(409);
    const reopened = await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/reopen`, s.alice.token, {
      guidance: '仍需完成生产部署',
    })));
    expect(reopened.status).toBe(200);
    expect(['pending', 'planning']).toContain(reopened.body.issue.status);
  });

  test('waiting_input 派生标记：列表/详情随数据源变化，默认 false', async () => {
    const s = await setup();
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '弹窗任务' })),
    );
    const iid = created.body.issue.id as number;

    // 默认不在等人工
    const list0 = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    expect(list0.body.find((i: { id: number }) => i.id === iid).waitingInput).toBe(false);

    // 数据源标记后：列表 + 详情都亮
    s.waitingSet.add(iid);
    const list1 = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    expect(list1.body.find((i: { id: number }) => i.id === iid).waitingInput).toBe(true);
    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)));
    expect(detail.body.issue.waitingInput).toBe(true);

    // 处理完（消费/菜单消失）→ 恢复 false
    s.waitingSet.delete(iid);
    const list2 = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    expect(list2.body.find((i: { id: number }) => i.id === iid).waitingInput).toBe(false);
  });

  // #275 / I-07：把 blocked 这个统一出口按原因拆开，列表与详情都要出这个字段
  test('attentionKind：列表/详情同源派生，弹窗等待优先于受阻', async () => {
    const s = await setup();
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '分层任务' })),
    );
    const iid = created.body.issue.id as number;
    const inList = async () => {
      const r = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
      return r.body.find((i: { id: number }) => i.id === iid).attentionKind;
    };
    const inDetail = async () => {
      const r = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)));
      return r.body.issue.attentionKind;
    };

    expect(await inList()).toBe('none');
    expect(await inDetail()).toBe('none');

    // 受阻 + 本地门禁其实过了、只差人工重启 → verify，而不是笼统的 blocked
    s.engine.store.logEvent(iid, 'auto_commit', { message: 'x' });
    s.engine.store.logEvent(iid, 'auto_push', { branch: 'main' });
    await s.engine.applyEvent(iid, 'block', { note: '需人工在低峰执行 systemctl restart panda 才生效' });
    expect(await inList()).toBe('verify');
    expect(await inDetail()).toBe('verify');

    // 弹窗在等人工选择时优先报 choice（你此刻一步就能解开它）
    s.waitingSet.add(iid);
    expect(await inList()).toBe('choice');
    s.waitingSet.delete(iid);

    // 止损打的那次受阻 → stalled，与 #273 自动重试到顶同一个取值
    await s.engine.unblockIssue(iid, '继续');
    await s.engine.applyEvent(iid, 'block', { note: '止损暂停：累计受阻 3 次', stopLoss: true });
    expect(await inList()).toBe('stalled');
    expect(await inDetail()).toBe('stalled');
  });

  test('派生标记：awaitingClarify（execClarifyWait 非空）+ clarifyPending 跨状态（第 5 点）', async () => {
    const s = await setup();
    // design 直进 planning（驱动态、已绑会话）
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '样式优化', category: 'design' })),
    );
    const iid = created.body.issue.id as number;
    expect(created.body.issue.status).toBe('planning');
    // create 响应是裸 issue（派生字段只在 GET 列表/详情下发）→ 从详情读初始态
    const init = (await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)))).body.issue;
    expect(init.awaitingClarify).toBe(false);
    expect(init.clarifyPending).toBe(false);

    // 执行中澄清（source=exec）→ 列表/详情 awaitingClarify=true & clarifyPending=true
    s.engine.store.logEvent(iid, 'clarify_questions', { source: 'exec', stage: 'planning', questions: ['用哪个库？'] });
    const row = (await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)))).body.find(
      (x: { id: number }) => x.id === iid,
    );
    expect(row.awaitingClarify).toBe(true);
    expect(row.clarifyPending).toBe(true);
    expect((await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)))).body.issue.awaitingClarify).toBe(
      true,
    );

    // 驱动态回答 → 两个标记都熄灭
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/1/issues/${iid}/clarify`, s.alice.token, { answer: '用 axios' }))))
        .status,
    ).toBe(200);
    const after = (await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)))).body.issue;
    expect(after.awaitingClarify).toBe(false);
    expect(after.clarifyPending).toBe(false);

    // 创建时问题（source≠exec）在驱动态：clarifyPending=true（第 5 点跨状态显示），但 awaitingClarify=false（不停催）
    s.engine.store.logEvent(iid, 'clarify_questions', { source: 'create', questions: ['要不要导出 PDF？'] });
    const d2 = (await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)))).body.issue;
    expect(d2.clarifyPending).toBe(true);
    expect(d2.awaitingClarify).toBe(false);
  });

  test('POST 校验：缺 title 400；images 白名单裁剪（isUploadRel：非上传目录/越界路径被丢弃）', async () => {
    const s = await setup();
    expect((await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {})))).status).toBe(400);
    const created = await j(
      s.dispatch(
        req('POST', '/api/projects/1/issues', s.alice.token, {
          title: 'B',
          images: [
            '.panda/uploads/abc/a.png', // 合法：上传目录内
            7, // 非字符串
            '', // 空串
            'b.png', // 不在上传目录
            '.panda/uploads/../secret', // 越界
            '/etc/passwd', // 绝对路径伪造
            './.panda/uploads/def/b.png', // 合法：./ 前缀归一
          ],
        }),
      ),
    );
    expect(JSON.parse(created.body.issue.imagesJson)).toEqual([
      '.panda/uploads/abc/a.png',
      './.panda/uploads/def/b.png',
    ]);
  });

  test('目标分支/源 ref：创建持久化、仅 pending 可编辑、清目标时同步清源、非法输入 400', async () => {
    const s = await setup();
    // #1 开跑占住项目，确保后续 issue 留在 pending 可编辑。
    const active = await j(s.dispatch(req(
      'POST',
      '/api/projects/1/issues',
      s.alice.token,
      { title: '占位' },
    )));
    expect((await j(s.dispatch(req(
      'PATCH',
      `/api/projects/1/issues/${active.body.issue.id}`,
      s.alice.token,
      { targetBranch: 'feature/too-late' },
    )))).status).toBe(400);
    const created = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, {
      title: '分支任务',
      targetBranch: 'feature/issue-85',
      sourceRef: 'refs/remotes/origin/main',
    })));
    expect(created.status).toBe(200);
    expect(created.body.issue).toMatchObject({
      status: 'pending',
      targetBranch: 'feature/issue-85',
      sourceRef: 'refs/remotes/origin/main',
    });
    const iid = created.body.issue.id as number;
    expect(s.engine.store.get(iid)).toMatchObject({
      targetBranch: 'feature/issue-85',
      sourceRef: 'refs/remotes/origin/main',
    });

    const patched = await j(s.dispatch(req(
      'PATCH',
      `/api/projects/1/issues/${iid}`,
      s.alice.token,
      { targetBranch: 'fix/issue-85', sourceRef: 'refs/heads/release' },
    )));
    expect(patched.status).toBe(200);
    expect(patched.body.issue).toMatchObject({
      targetBranch: 'fix/issue-85',
      sourceRef: 'refs/heads/release',
    });

    const cleared = await j(s.dispatch(req(
      'PATCH',
      `/api/projects/1/issues/${iid}`,
      s.alice.token,
      { targetBranch: null, sourceRef: 'refs/heads/release' },
    )));
    expect(cleared.status).toBe(200);
    expect(cleared.body.issue.targetBranch).toBeNull();
    expect(cleared.body.issue.sourceRef).toBeNull();

    for (const body of [
      { title: '源无目标', sourceRef: 'refs/heads/main' },
      { title: '非法目标', targetBranch: '-bad' },
      { title: '目标空格', targetBranch: 'bad branch' },
      { title: '源非完整 ref', targetBranch: 'feature/x', sourceRef: 'main' },
      { title: '源类型错', targetBranch: 'feature/x', sourceRef: 7 },
      { title: '目标类型错', targetBranch: 7 },
    ]) {
      const bad = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, body)));
      expect(bad.status).toBe(400);
    }
    const sourceWithoutTarget = await j(s.dispatch(req(
      'PATCH',
      `/api/projects/1/issues/${iid}`,
      s.alice.token,
      { sourceRef: 'refs/heads/main' },
    )));
    expect(sourceWithoutTarget.status).toBe(400);
  });

  test('目标分支 PATCH 在读 body 期间开跑后不得写入非 pending issue', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(1, { title: '并发编辑分支' }, false);
    expect(issue.status).toBe('pending');

    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    let releaseBody!: () => void;
    const bodyHold = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const slowReq = req(
      'PATCH',
      `/api/projects/1/issues/${issue.id}`,
      s.alice.token,
      { targetBranch: 'feature/race', sourceRef: 'refs/heads/main' },
    );
    Object.defineProperty(slowReq, 'json', {
      value: async () => {
        markBodyRead();
        await bodyHold;
        return { targetBranch: 'feature/race', sourceRef: 'refs/heads/main' };
      },
    });

    const patchPromise = j(s.dispatch(slowReq));
    await bodyRead;
    expect((await s.engine.startIssue(issue.id)).ok).toBe(true);
    releaseBody();

    const patched = await patchPromise;
    expect(patched.status).toBe(400);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      targetBranch: null,
      sourceRef: null,
    });
  });

  test('并发 pending PATCH 基于锁内最新值维持 target/source 不变量', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(1, {
      title: '并发修改分支',
      targetBranch: 'feature/original',
      sourceRef: 'refs/heads/main',
    }, false);

    function heldPatch(body: Record<string, unknown>) {
      let markRead!: () => void;
      const read = new Promise<void>((resolve) => {
        markRead = resolve;
      });
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const request = req('PATCH', `/api/projects/1/issues/${issue.id}`, s.alice.token, body);
      Object.defineProperty(request, 'json', {
        value: async () => {
          markRead();
          await hold;
          return body;
        },
      });
      return { request, read, release };
    }

    const clear = heldPatch({ targetBranch: null });
    const sourceOnly = heldPatch({ sourceRef: 'refs/remotes/origin/main' });
    const clearResult = j(s.dispatch(clear.request));
    const sourceResult = j(s.dispatch(sourceOnly.request));
    await Promise.all([clear.read, sourceOnly.read]);

    clear.release();
    expect((await clearResult).status).toBe(200);
    sourceOnly.release();
    expect((await sourceResult).status).toBe(400);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'pending',
      targetBranch: null,
      sourceRef: null,
    });
  });

  test('模块与 Git 意图组合 PATCH 在开跑竞态下不得部分落库', async () => {
    const s = await setup({ modules: true });
    s.db.query(
      `INSERT INTO project_modules
         (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (101, 1, 'module-one', 'Module One', 'claude', 'manual', ?, 1),
              (102, 1, 'module-two', 'Module Two', 'claude', 'manual', ?, 2)`,
    ).run(s.alice.user.id, s.alice.user.id);
    const issue = await s.engine.createIssue(1, {
      title: '组合编辑',
      moduleId: 101,
      agent: 'claude',
      targetBranch: 'feature/original',
      sourceRef: 'refs/heads/main',
    }, false);

    const originalUpdate = s.engine.updatePendingMeta.bind(s.engine);
    let markUpdateEntered!: () => void;
    const updateEntered = new Promise<void>((resolve) => {
      markUpdateEntered = resolve;
    });
    let releaseUpdate!: () => void;
    const updateHold = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const wrappedUpdate: typeof s.engine.updatePendingMeta = async (...args) => {
      markUpdateEntered();
      await updateHold;
      return originalUpdate(...args);
    };
    s.engine.updatePendingMeta = wrappedUpdate;

    const patchPromise = j(s.dispatch(req(
      'PATCH',
      `/api/projects/1/issues/${issue.id}`,
      s.alice.token,
      {
        moduleId: 102,
        targetBranch: 'feature/changed',
        sourceRef: 'refs/heads/main',
      },
    )));
    await updateEntered;
    expect((await s.engine.startIssue(issue.id)).ok).toBe(true);
    releaseUpdate();

    expect((await patchPromise).status).toBe(400);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      moduleId: 101,
      module: 'module-one',
      targetBranch: 'feature/original',
      sourceRef: 'refs/heads/main',
    });
  });

  test('PATCH images：存图（isUploadRel 裁剪）/ 不带 images 不动旧图 / 清图（[] → null）', async () => {
    const s = await setup();
    s.pm.questions = null;
    // #1 开跑占住项目 → #2 停 pending（可直接改内容）
    await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'A' })));
    const c2 = await j(s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: 'B' })));
    const iid = c2.body.issue.id as number;
    expect(c2.body.issue.status).toBe('pending');

    // 存图：合法 rel 保留，非上传目录 / 越界 / 非字符串被丢弃
    const p1 = await j(
      s.dispatch(
        req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, {
          images: [
            '.panda/uploads/abc/a.png',
            7, // 非字符串
            'x.png', // 不在上传目录
            '.panda/uploads/../secret', // 越界
            './.panda/uploads/def/b.png', // ./ 前缀归一
          ],
        }),
      ),
    );
    expect(p1.status).toBe(200);
    expect(JSON.parse(p1.body.issue.imagesJson)).toEqual([
      '.panda/uploads/abc/a.png',
      './.panda/uploads/def/b.png',
    ]);

    // 不带 images 的 PATCH：旧图原样保留（缺省不碰）
    const p2 = await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { title: 'B2' })));
    expect(p2.status).toBe(200);
    expect(JSON.parse(p2.body.issue.imagesJson)).toEqual([
      '.panda/uploads/abc/a.png',
      './.panda/uploads/def/b.png',
    ]);

    // 清图：images: [] → images_json 置 null
    const p3 = await j(s.dispatch(req('PATCH', `/api/projects/1/issues/${iid}`, s.alice.token, { images: [] })));
    expect(p3.status).toBe(200);
    expect(p3.body.issue.imagesJson).toBeNull();
  });

  test('成员（project-access）可协作 issue：加入 project_members 后可列/建，按项目隔离', async () => {
    const s = await setup();
    // 加入前：bob 与项目 1 无关 → 403
    expect((await j(s.dispatch(req('GET', '/api/projects/1/issues', s.bob.token)))).status).toBe(403);
    // 关联 bob 为项目 1 成员
    s.db
      .query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 0)')
      .run(s.bob.user.id);
    // 加入后：可列出、可创建（createdBy 记为 bob 本人）
    expect((await j(s.dispatch(req('GET', '/api/projects/1/issues', s.bob.token)))).status).toBe(200);
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.bob.token, { title: '成员建的任务', body: 'x' })),
    );
    expect(created.status).toBe(200);
    expect(created.body.issue.createdBy).toBe(s.bob.user.id);
    // 项目 2 未关联 bob → 仍 403（成员权限按项目隔离，不外溢）
    expect((await j(s.dispatch(req('GET', '/api/projects/2/issues', s.bob.token)))).status).toBe(403);
  });

  test('createdByName：新建/列表/详情回显创建者用户名；created_by 为空 → null', async () => {
    const s = await setup();
    // alice 建 issue → POST 回显 createdByName
    const created = await j(
      s.dispatch(req('POST', '/api/projects/1/issues', s.alice.token, { title: '带创建者', body: 'x' })),
    );
    expect(created.status).toBe(200);
    expect(created.body.issue.createdBy).toBe(s.alice.user.id);
    expect(created.body.issue.createdByName).toBe('alice');
    const iid = created.body.issue.id as number;

    // 列表回显
    const list = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    expect(list.body.find((x: any) => x.id === iid).createdByName).toBe('alice');

    // 详情回显
    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${iid}`, s.alice.token)));
    expect(detail.body.issue.createdByName).toBe('alice');

    // created_by 为空的历史 issue（如 v1 迁移导入，不经引擎）→ createdByName null
    s.db.query(`INSERT INTO issues (project_id, title, created_ts) VALUES (1, '无创建者', ?)`).run(Date.now());
    const list2 = await j(s.dispatch(req('GET', '/api/projects/1/issues', s.alice.token)));
    const orphan = list2.body.find((x: any) => x.title === '无创建者');
    expect(orphan.createdBy).toBeNull();
    expect(orphan.createdByName).toBeNull();
  });
});

describe('模块管理路由：智能整理 / 执行合并 / 改名归档', () => {
  test('模块 Agent 与智能整理 Agent 都受执行机能力约束', async () => {
    const s = await setup({ modules: true });
    const module = s.moduleStore.create({
      projectId: 1,
      slug: 'demo-module',
      displayName: 'Demo Module',
      agent: 'claude',
      source: 'manual',
      createdBy: s.alice.user.id,
    });
    s.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    expect(
      (
        await j(
          s.dispatch(
            req(
              'PATCH',
              `/api/projects/1/modules/${module.id}`,
              s.alice.token,
              { agent: 'codex' },
            ),
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await j(
          s.dispatch(
            req('POST', '/api/projects/1/modules/organize', s.alice.token, {
              agent: 'codex',
            }),
          ),
        )
      ).status,
    ).toBe(409);
    s.db.run('UPDATE executors SET supports_codex = 1 WHERE id = 1');
    expect(
      (
        await j(
          s.dispatch(
            req(
              'PATCH',
              `/api/projects/1/modules/${module.id}`,
              s.alice.token,
              { agent: 'codex' },
            ),
          ),
        )
      ).status,
    ).toBe(200);
    expect(s.moduleStore.get(module.id)?.agent).toBe('codex');
  });

  test('organize：触发（权限/单飞 409）→ 状态轮询 → 逐项 apply（防重放）', async () => {
    let plan = '';
    let release: (() => void) | null = null;
    const s = await setup({
      modules: true,
      organize: async () => {
        // 可控归还：先挂起等 release，模拟在途分析
        await new Promise<void>((r) => {
          release = r;
        });
        return { ok: true, planText: plan };
      },
    });
    const m1 = s.moduleStore.create({ projectId: 1, slug: 'legacy-module-01', displayName: 'Git 页面', agent: 'claude', source: 'legacy' });
    await s.engine.createIssue(1, { title: '甲', moduleId: m1.id }, false);
    plan = JSON.stringify({
      actions: [{ kind: 'rename', moduleId: m1.id, slug: 'git-pages', reason: '去序号' }],
    });

    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/organize')))).status).toBe(401);
    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/organize', s.bob.token, {})))).status).toBe(403);

    const kicked = await j(s.dispatch(req('POST', '/api/projects/1/modules/organize', s.alice.token, { agent: 'claude' })));
    expect(kicked.status).toBe(200);
    // 在途重复触发 → 409；状态 running
    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/organize', s.alice.token, {})))).status).toBe(409);
    let st = await j(s.dispatch(req('GET', '/api/projects/1/modules/organize', s.alice.token)));
    expect(st.body).toMatchObject({ ok: true, running: true, suggestion: null });

    release!();
    await s.engine.waitOrganize();
    st = await j(s.dispatch(req('GET', '/api/projects/1/modules/organize', s.alice.token)));
    expect(st.body.running).toBe(false);
    expect(st.body.suggestion.actions).toEqual([
      expect.objectContaining({ kind: 'rename', slug: 'git-pages', applied: false }),
    ]);

    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/organize/apply', s.alice.token, {})))).status).toBe(400);
    const ap = await j(s.dispatch(req('POST', '/api/projects/1/modules/organize/apply', s.alice.token, { index: 0 })));
    expect(ap.status).toBe(200);
    expect(ap.body.result).toEqual({
      kind: 'rename',
      params: { name: 'Git 页面', slug: 'git-pages' },
    });
    expect(s.moduleStore.get(m1.id)!.slug).toBe('git-pages');
    // 防重放 + applied 标记
    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/organize/apply', s.alice.token, { index: 0 })))).status).toBe(400);
    st = await j(s.dispatch(req('GET', '/api/projects/1/modules/organize', s.alice.token)));
    expect(st.body.suggestion.actions[0].applied).toBe(true);
  });

  test('POST merge 执行合并（校验/权限）；PATCH 改名与归档（未完结 issue 挡归档）', async () => {
    const s = await setup({ modules: true });
    const m1 = s.moduleStore.create({ projectId: 1, slug: 'issue-engine', displayName: '目标', agent: 'claude', source: 'legacy' });
    const m2 = s.moduleStore.create({ projectId: 1, slug: 'legacy-two', displayName: '来源二', agent: 'codex', source: 'legacy' });
    const a = await s.engine.createIssue(1, { title: '甲', moduleId: m2.id }, false);

    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/merge', s.bob.token, { targetId: m1.id, sourceIds: [m2.id] })))).status).toBe(403);
    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/merge', s.alice.token, { targetId: m1.id, sourceIds: [] })))).status).toBe(400);
    expect((await j(s.dispatch(req('POST', '/api/projects/1/modules/merge', s.alice.token, { targetId: m1.id })))).status).toBe(400);

    const ok = await j(s.dispatch(req('POST', '/api/projects/1/modules/merge', s.alice.token, { targetId: m1.id, sourceIds: [m2.id] })));
    expect(ok.status).toBe(200);
    expect(ok.body.movedIssueIds).toEqual([a.id]);
    expect(ok.body.target.id).toBe(m1.id);
    expect(s.engine.store.get(a.id)!).toMatchObject({ moduleId: m1.id, agent: 'claude' });
    expect(s.moduleStore.get(m2.id)!.status).toBe('archived');

    const rn = await j(s.dispatch(req('PATCH', `/api/projects/1/modules/${m1.id}`, s.alice.token, { displayName: '合并后' })));
    expect(rn.status).toBe(200);
    expect(rn.body.module.displayName).toBe('合并后');

    // PATCH slug：手动改 slug 的路由入口（文档目录迁移在 manager/引擎测试覆盖，这里核库内同步）
    const rs = await j(s.dispatch(req('PATCH', `/api/projects/1/modules/${m1.id}`, s.alice.token, { slug: 'merged-engine' })));
    expect(rs.status).toBe(200);
    expect(rs.body.module.slug).toBe('merged-engine');
    expect(s.engine.store.get(a.id)!).toMatchObject({ moduleId: m1.id, module: 'merged-engine' });
    // 坏 slug → 400（manager 校验），库内不动
    expect((await j(s.dispatch(req('PATCH', `/api/projects/1/modules/${m1.id}`, s.alice.token, { slug: '##bad##' })))).status).toBe(400);
    expect(s.moduleStore.get(m1.id)!.slug).toBe('merged-engine');

    const ar1 = await j(s.dispatch(req('PATCH', `/api/projects/1/modules/${m1.id}`, s.alice.token, { status: 'archived' })));
    expect(ar1.status).toBe(400);
    expect(ar1.body.error.details).toContain('未完结');
    await s.engine.cancelIssue(a.id, s.alice.user.id);
    const ar2 = await j(s.dispatch(req('PATCH', `/api/projects/1/modules/${m1.id}`, s.alice.token, { status: 'archived' })));
    expect(ar2.status).toBe(200);
    expect(ar2.body.module.status).toBe('archived');
  });

  test('编辑来源标记（#283 / B-11）：只有用户编辑才重新澄清，同步回写不触发', async () => {
    const clarified: number[] = [];
    const s = await setup({ modules: true });
    const original = s.engine.scheduleClarify.bind(s.engine);
    s.engine.scheduleClarify = (id: number) => { clarified.push(id); original(id); };

    const issue = await s.engine.createIssue(1, { title: '原标题', body: '原正文' }, false);
    const url = `/api/projects/1/issues/${issue.id}`;

    // 用户编辑：内容变了 → 重新澄清
    clarified.length = 0;
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, { body: '用户改的正文' })))).status).toBe(200);
    expect(clarified).toContain(issue.id);

    // 同步回写：同样的内容变化，但显式标了来源 → 不再白跑一次澄清
    clarified.length = 0;
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, {
      body: '同步回写的正文', source: 'sync',
    })))).status).toBe(200);
    expect(clarified).toEqual([]);
    expect(s.engine.store.get(issue.id)!.body).toBe('同步回写的正文'); // 内容照常落库
  });

  test('一键拆回（#289 / B-14）：详情出可拆回标记，拆回后各条恢复原文；已开跑拒绝', async () => {
    const s = await setup({ modules: true });
    const b = await s.engine.createIssue(1, { title: 'B', body: 'B 的原文', module: 'web' }, false);
    const c = await s.engine.createIssue(1, { title: 'C', body: 'C 的原文', module: 'web' }, false);
    s.pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];
    // 合并照跑，但别顺势开跑（拆回只允许宿主仍 pending）
    const original = s.engine.startIssue.bind(s.engine);
    s.engine.startIssue = async () => ({ ok: false, error: '暂不开跑', deferral: 'project-busy' as const });
    try {
      await s.engine.scheduleNext(1, 'web');
    } finally {
      s.engine.startIssue = original;
    }

    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${b.id}`, s.alice.token)));
    expect(detail.body.mergedFrom).toMatchObject({ canUnmerge: true });
    expect(detail.body.mergedFrom.members.map((m: { id: number }) => m.id).sort()).toEqual([b.id, c.id].sort());

    const r = await j(s.dispatch(req('POST', `/api/projects/1/issues/${b.id}/unmerge`, s.alice.token, {})));
    expect(r.status).toBe(200);
    expect(r.body.restored).toEqual([c.id]);
    expect(s.engine.store.get(b.id)!.body).toBe('B 的原文');
    expect(s.engine.store.get(c.id)!).toMatchObject({ status: 'pending', body: 'C 的原文' });
    // 拆过就不给再拆
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${b.id}/unmerge`, s.alice.token, {})))).status)
      .toBe(409);
  });

  test('宿主已开跑：详情标记 canUnmerge=false，接口也拒绝', async () => {
    const s = await setup({ modules: true });
    const b = await s.engine.createIssue(1, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await s.engine.createIssue(1, { title: 'C', body: 'cc', module: 'web' }, false);
    s.pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '摘要' }];
    await s.engine.scheduleNext(1, 'web'); // 合并后顺势开跑

    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${b.id}`, s.alice.token)));
    expect(detail.body.mergedFrom).toMatchObject({ canUnmerge: false });
    expect((await j(s.dispatch(req('POST', `/api/projects/1/issues/${b.id}/unmerge`, s.alice.token, {})))).status)
      .toBe(409);
  });

  test('受阻解除自动排队（#283 / B-10）：忙时返回 queued 而不是 409，可撤销', async () => {
    const s = await setup({ modules: true });
    const blocked = await s.engine.createIssue(1, { title: '受阻的' }, false);
    await s.engine.startIssue(blocked.id);
    await s.engine.applyEvent(blocked.id, 'block', { note: '缺依赖' });
    const running = await s.engine.createIssue(1, { title: '在跑的' }, false);
    await s.engine.startIssue(running.id);

    const url = `/api/projects/1/issues/${blocked.id}/unblock`;
    const queued = await j(s.dispatch(req('POST', url, s.alice.token, { guidance: '装上依赖再跑' })));
    expect(queued.status).toBe(200); // 不再是 409
    expect(queued.body).toMatchObject({ ok: true, queued: true });
    expect(queued.body.unblockRequest).toMatchObject({ issueId: blocked.id, guidance: '装上依赖再跑' });

    // 详情接口把意图带出来，前端据此显示「已排队」
    const detail = await j(s.dispatch(req('GET', `/api/projects/1/issues/${blocked.id}`, s.alice.token)));
    expect(detail.body.unblockRequest).toMatchObject({ guidance: '装上依赖再跑' });
    // 已排队 = 不用人再做什么：attentionKind 不再喊「受阻」
    expect(detail.body.issue.attentionKind).toBe('none');

    // 撤销
    const cancelled = await j(s.dispatch(req('POST', `${url}/cancel`, s.alice.token, {})));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.unblockRequest).toBeNull();
    expect((await j(s.dispatch(req('GET', `/api/projects/1/issues/${blocked.id}`, s.alice.token)))).body.unblockRequest)
      .toBeNull();
    // 没有意图时再撤销 → 409，不静默成功
    expect((await j(s.dispatch(req('POST', `${url}/cancel`, s.alice.token, {})))).status).toBe(409);
  });

  test('项目空闲时解除仍是直接恢复（不返回 queued），入参校验不变', async () => {
    const s = await setup({ modules: true });
    const issue = await s.engine.createIssue(1, { title: '独苗' }, false);
    await s.engine.startIssue(issue.id);
    await s.engine.applyEvent(issue.id, 'block', { note: 'x' });
    const url = `/api/projects/1/issues/${issue.id}/unblock`;

    expect((await j(s.dispatch(req('POST', url, s.alice.token, { guidance: '  ' })))).status).toBe(400);
    const ok = await j(s.dispatch(req('POST', url, s.alice.token, { guidance: '接着干' })));
    expect(ok.status).toBe(200);
    expect(ok.body.queued).toBeUndefined();
    expect(ok.body.issue.status).not.toBe('blocked');
  });

  test('推理档（#281 / I-04）：模块默认档 + issue 覆盖，出参带生效档与来源', async () => {
    const s = await setup({ modules: true });
    const m = s.moduleStore.create({
      projectId: 1, slug: 'issue-engine', displayName: '引擎', agent: 'codex', source: 'manual',
    });
    const issue = await s.engine.createIssue(1, { title: '高风险迁移', moduleId: m.id }, false);
    const issueUrl = `/api/projects/1/issues/${issue.id}`;
    const moduleUrl = `/api/projects/1/modules/${m.id}`;

    // 都没配 → 默认档，来源 default
    let detail = await j(s.dispatch(req('GET', issueUrl, s.alice.token)));
    expect(detail.body.reasoning).toEqual({ effort: 'medium', source: 'default', override: null });

    // 模块默认档
    const mod = await j(s.dispatch(req('PATCH', moduleUrl, s.alice.token, { reasoningEffort: 'low' })));
    expect(mod.body.module.reasoningEffort).toBe('low');
    detail = await j(s.dispatch(req('GET', issueUrl, s.alice.token)));
    expect(detail.body.reasoning).toMatchObject({ effort: 'low', source: 'module' });

    // issue 覆盖压过模块（迁移/状态机这类临时提到 high）
    const up = await j(s.dispatch(req('PATCH', issueUrl, s.alice.token, { reasoningEffort: 'high' })));
    expect(up.body.reasoning).toEqual({ effort: 'high', source: 'issue', override: 'high' });

    // null = 继承模块
    const cleared = await j(s.dispatch(req('PATCH', issueUrl, s.alice.token, { reasoningEffort: null })));
    expect(cleared.body.reasoning).toEqual({ effort: 'low', source: 'module', override: null });

    // 非法值 400，库内不动
    expect((await j(s.dispatch(req('PATCH', issueUrl, s.alice.token, { reasoningEffort: 'ultra' })))).status).toBe(400);
    expect((await j(s.dispatch(req('PATCH', moduleUrl, s.alice.token, { reasoningEffort: 'ultra' })))).status).toBe(400);
    expect(s.moduleStore.get(m.id)!.reasoningEffort).toBe('low');
  });

  test('推理档改动不受「可编辑状态」限制：跑到一半也能提档（下次启动生效）', async () => {
    const s = await setup({ modules: true });
    const issue = await s.engine.createIssue(1, { title: '跑着的' }, false);
    await s.engine.startIssue(issue.id);
    const url = `/api/projects/1/issues/${issue.id}`;
    // 改内容照旧被挡
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, { title: '新标题' })))).status).toBe(400);
    // 只改推理档则放行
    const ok = await j(s.dispatch(req('PATCH', url, s.alice.token, { reasoningEffort: 'high' })));
    expect(ok.status).toBe(200);
    expect(ok.body.reasoning).toMatchObject({ effort: 'high', source: 'issue' });
  });

  test('详情接口出 validation：本轮范围 + 最近一次结果（#279 / I-03）', async () => {
    const s = await setup({ modules: true });
    const issue = await s.engine.createIssue(1, { title: '要过门禁' }, false);
    const url = `/api/projects/1/issues/${issue.id}`;

    // 还没跑过：两项都是 null，但字段必须在（前端据此判断「有没有门禁信息」）
    let detail = await j(s.dispatch(req('GET', url, s.alice.token)));
    expect(detail.body.validation).toEqual({ scope: null, last: null });

    s.engine.store.setValidationScope(issue.id, {
      kind: 'targeted', files: ['src/a.test.ts'], reason: '按改动文件推导',
    });
    s.engine.store.logEvent(issue.id, 'validation_failed', {
      scope: 'targeted', label: 'test', code: 1, timedOut: false, durationMs: 4200, tail: '3 fail',
    });

    detail = await j(s.dispatch(req('GET', url, s.alice.token)));
    expect(detail.body.validation.scope).toEqual({
      kind: 'targeted', files: ['src/a.test.ts'], reason: '按改动文件推导',
    });
    expect(detail.body.validation.last).toMatchObject({
      outcome: 'failed', scope: 'targeted', label: 'test', code: 1, timedOut: false, durationMs: 4200,
    });

    // 只认最后一次：后来的通过要覆盖前面的失败
    s.engine.store.logEvent(issue.id, 'validation_passed', { scope: 'full', durationMs: 9000 });
    detail = await j(s.dispatch(req('GET', url, s.alice.token)));
    expect(detail.body.validation.last).toMatchObject({ outcome: 'passed', scope: 'full', durationMs: 9000 });
  });

  test('PATCH skills：未配置 = 沿用项目默认，显式数组落库，null 清回默认（#277 / I-02）', async () => {
    const s = await setup({ modules: true });
    const m = s.moduleStore.create({
      projectId: 1, slug: 'issue-engine', displayName: '引擎', agent: 'claude', source: 'manual',
    });
    const url = `/api/projects/1/modules/${m.id}`;

    // 出：未配置的模块 skills 为 null（前端据此显示「沿用项目默认」）
    const listed = await j(s.dispatch(req('GET', '/api/projects/1/modules', s.alice.token)));
    expect(listed.body.modules[0].skills).toBeNull();

    // 收：显式指定（去重保序），superpowers 这类要显式勾才挂
    const set = await j(s.dispatch(req('PATCH', url, s.alice.token, {
      skills: ['panda-issue', 'superpowers', 'panda-issue'],
    })));
    expect(set.status).toBe(200);
    expect(set.body.module.skills).toEqual(['panda-issue', 'superpowers']);
    expect(s.moduleStore.get(m.id)!.skills).toEqual(['panda-issue', 'superpowers']);

    // 空数组 = 显式一个都不挂，与「未配置」不是一回事
    const none = await j(s.dispatch(req('PATCH', url, s.alice.token, { skills: [] })));
    expect(none.body.module.skills).toEqual([]);

    // null = 清回沿用项目默认
    const cleared = await j(s.dispatch(req('PATCH', url, s.alice.token, { skills: null })));
    expect(cleared.body.module.skills).toBeNull();

    // 非法输入 → 400，库内不动
    await s.dispatch(req('PATCH', url, s.alice.token, { skills: ['ok-skill'] }));
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, { skills: ['../etc/passwd'] })))).status).toBe(400);
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, { skills: 'superpowers' })))).status).toBe(400);
    expect(s.moduleStore.get(m.id)!.skills).toEqual(['ok-skill']);

    // 权限与空请求体照旧
    expect((await j(s.dispatch(req('PATCH', url, s.bob.token, { skills: [] })))).status).toBe(403);
    expect((await j(s.dispatch(req('PATCH', url, s.alice.token, {})))).status).toBe(400);
  });
});

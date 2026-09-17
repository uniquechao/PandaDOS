import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExternalIssueStore } from '../../core/external-issues';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import type { WorkflowGraphSnapshot } from '../../core/types';
import { UserStore } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import { IssueEngine, migrateIssueEngine } from '../../issues/engine';
import type { ExternalIssueFetch } from '../../issues/external-provider';
import { KeyedMutex } from '../../issues/mutex';
import { validateWorkflowGraph, WorkflowTemplateStore } from '../../issues/workflows';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { externalIssuesRoutes } from './external-issues';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-external-issues-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo);
  const driver = new LocalDriver();
  await driver.git(repo, ['init', '-q']);
  await driver.git(repo, ['remote', 'add', 'origin', 'git@github.com:octo/repo.git']);

  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  const member = users.create('member');
  db.query(
    `INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES (1, 'local', '127.0.0.1', 22, '', '', ?, '')`,
  ).run(dir);
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'p', 1, ?, ?, 0)`,
  ).run(repo, alice.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 0)')
    .run(member.user.id);
  // 占住项目，让导入后的正式 issue 保持 pending；本测试不需要启动真实 tmux Agent。
  db.query(
    `INSERT INTO issues (project_id, title, status, created_ts)
     VALUES (1, 'busy', 'implementing', 0)`,
  ).run();

  const engine = new IssueEngine({
    db,
    driver,
    convs: {
      create: () => { throw new Error('不应创建对话'); },
      get: () => undefined,
      listByProject: () => [],
      currentConv: () => undefined,
      tmuxName: (projectId) => `cc-${projectId}`,
      activate: async () => null,
    },
    locator: { locate: async () => null },
    pmFor: () => ({ judgeDone: async () => 'not_done' }),
    notify: { dispatch: async () => {} },
    mutex: new KeyedMutex(),
    config: { resultSummaryTimeoutMs: 0 },
  });
  let remoteIssues: unknown[] = [
    {
      id: 100,
      number: 7,
      title: '远端标题',
      body: '远端正文',
      html_url: 'https://github.com/octo/repo/issues/7',
      user: { login: 'octo' },
      labels: [{ name: 'bug' }],
    },
  ];
  const fetchImpl: ExternalIssueFetch = async () => new Response(JSON.stringify(remoteIssues));
  const dispatch = createDispatcher(
    externalIssuesRoutes({ db, engine, driverForProject: () => driver, fetchImpl }),
    authDepsFromDb(db, users),
  );
  return {
    db,
    driver,
    repo,
    dispatch,
    alice,
    bob,
    member,
    admin,
    setRemoteIssues: (issues: unknown[]) => { remoteIssues = issues; },
  };
}

function req(method: string, route: string, token?: string, body?: unknown): Request {
  return new Request(`http://test${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function call(
  dispatch: ReturnType<typeof createDispatcher>,
  method: string,
  route: string,
  token?: string,
  body?: unknown,
) {
  const response = await dispatch(req(method, route, token, body))!;
  return { status: response.status, body: await response.json() as any };
}

async function configure(s: Awaited<ReturnType<typeof setup>>) {
  return call(
    s.dispatch,
    'PUT',
    '/api/projects/1/external-issues/source',
    s.alice.token,
    { provider: 'github', remoteName: 'origin', apiToken: 'github-token-1234' },
  );
}

function createWorkflow(db: ReturnType<typeof openDb>) {
  const graph: WorkflowGraphSnapshot = {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 5,
    nodes: [
      { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
      { key: 'work', kind: 'agent', title: '实现', instructions: '完成任务', agent: 'claude', executionMode: 'write', maxVisits: 1, positionX: 100, positionY: 0, config: null },
      { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 200, positionY: 0, config: null },
    ],
    edges: [
      { key: 'issue-work', fromNodeKey: 'issue', toNodeKey: 'work', conditionText: null, priority: 0, isDefault: false },
      { key: 'work-end', fromNodeKey: 'work', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: false },
    ],
  };
  const validated = validateWorkflowGraph(graph, ['claude', 'codex']);
  if (!validated.ok) throw new Error('测试工作流无效');
  return new WorkflowTemplateStore(db).create({
    projectId: 1,
    name: '导入流程',
    graph: validated.graph,
    graphJson: validated.graphJson,
    graphHash: validated.graphHash,
  });
}

describe('外部 issue 路由', () => {
  test('来源配置限属主，读取只返回脱敏 token；成员可列 remote', async () => {
    const s = await setup();
    await s.driver.git(s.repo, ['remote', 'add', 'internal', 'ssh://git@gitlab.sunseed.tech:2222/team/repo.git']);
    expect((await call(s.dispatch, 'GET', '/api/projects/1/external-issues/remotes')).status).toBe(401);
    expect((await call(
      s.dispatch,
      'PUT',
      '/api/projects/1/external-issues/source',
      s.member.token,
      { provider: 'github', remoteName: 'origin', apiToken: 'secret' },
    )).status).toBe(403);
    const remotes = await call(
      s.dispatch,
      'GET',
      '/api/projects/1/external-issues/remotes',
      s.member.token,
    );
    expect(remotes.body.remotes).toEqual([
      {
        name: 'internal', url: 'ssh://git@gitlab.sunseed.tech:2222/team/repo.git', host: 'gitlab.sunseed.tech',
        suggestedProvider: 'gitlab', suggestedInstanceUrl: 'https://gitlab.sunseed.tech',
      },
      {
        name: 'origin', url: 'git@github.com:octo/repo.git', host: 'github.com',
        suggestedProvider: 'github', suggestedInstanceUrl: 'https://github.com',
      },
    ]);

    const saved = await configure(s);
    expect(saved.status).toBe(200);
    expect(saved.body.source).toMatchObject({
      provider: 'github',
      remoteName: 'origin',
      tokenConfigured: true,
      tokenMasked: '••••1234',
    });
    expect(JSON.stringify(saved.body)).not.toContain('github-token-1234');
    expect((await call(
      s.dispatch,
      'GET',
      '/api/projects/1/external-issues/source',
      s.member.token,
    )).body.source.tokenMasked).toBe('••••1234');
  });

  test('手动获取过滤已忽略记录，remote 改动后拒绝继续使用旧绑定', async () => {
    const s = await setup();
    await configure(s);
    const first = await call(
      s.dispatch,
      'POST',
      '/api/projects/1/external-issues/fetch',
      s.member.token,
    );
    expect(first.status).toBe(200);
    expect(first.body.issues.map((issue: any) => issue.externalId)).toEqual(['100']);

    expect((await call(
      s.dispatch,
      'POST',
      '/api/projects/1/external-issues/ignore',
      s.member.token,
      {
        externalId: '100',
        externalNumber: '7',
        externalUrl: 'https://github.com/octo/repo/issues/7',
      },
    )).status).toBe(200);
    expect((await call(
      s.dispatch,
      'POST',
      '/api/projects/1/external-issues/fetch',
      s.member.token,
    )).body.issues).toEqual([]);

    const project = s.db.query<{ cwd: string }, []>('SELECT cwd FROM projects WHERE id = 1').get()!;
    const driver = new LocalDriver();
    await driver.git(project.cwd, ['remote', 'set-url', 'origin', 'git@github.com:octo/other.git']);
    expect((await call(
      s.dispatch,
      'POST',
      '/api/projects/1/external-issues/fetch',
      s.member.token,
    )).status).toBe(409);
  });

  test('确认导入原子创建正式 pending issue，并发重复确认只成功一次', async () => {
    const s = await setup();
    await configure(s);
    const workflow = createWorkflow(s.db);
    const payload = {
      externalId: '101',
      externalNumber: '8',
      externalUrl: 'https://github.com/octo/repo/issues/8',
      title: '修改后的标题',
      body: '修改后的正文',
      category: 'debug',
      agent: 'claude',
      autoApprove: 'cautious',
      workflowTemplateId: workflow.template.id,
    };
    const results = await Promise.all([
      call(s.dispatch, 'POST', '/api/projects/1/external-issues/import', s.member.token, payload),
      call(s.dispatch, 'POST', '/api/projects/1/external-issues/import', s.member.token, payload),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const rows = s.db.query<
      { id: number; title: string; body: string; status: string; created_by: number },
      []
    >("SELECT id, title, body, status, created_by FROM issues WHERE title = '修改后的标题'").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: '修改后的标题',
      body: '修改后的正文',
      status: 'pending',
      created_by: s.member.user.id,
    });
    const records = new ExternalIssueStore(s.db)
      .listRecords(1, 'github', 'github:github.com/octo/repo');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ disposition: 'imported', localIssueId: rows[0]!.id });
    const snapshots = s.db.query<
      { issue_id: number; template_version_id: number; context_json: string },
      []
    >('SELECT issue_id, template_version_id, context_json FROM issue_workflows').all();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      issue_id: rows[0]!.id,
      template_version_id: workflow.version.id,
    });
    expect(JSON.parse(snapshots[0]!.context_json)).toMatchObject({
      issue: { id: rows[0]!.id, title: '修改后的标题', body: '修改后的正文' },
      documents: { module: null, issueProcess: null },
    });
  });

  test('非法远端身份在创建 issue 前被拒绝且不泄露 token', async () => {
    const s = await setup();
    await configure(s);
    s.setRemoteIssues([]);
    // 单独路由装配的成功响应已覆盖；非法身份 URL 在发起正式创建前被拒绝。
    const bad = await call(
      s.dispatch,
      'POST',
      '/api/projects/1/external-issues/import',
      s.alice.token,
      {
        externalId: '1',
        externalNumber: '1',
        externalUrl: 'https://evil.example/issues/1',
        title: 'x',
      },
    );
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain('github-token-1234');
  });
});

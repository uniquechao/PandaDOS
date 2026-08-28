import { afterEach, describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import type { WorkflowGraphSnapshot } from '../../core/types';
import { UserStore } from '../../core/users';
import { migrateIssueEngine } from '../../issues/engine';
import { validateWorkflowGraph } from '../../issues/workflows';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { workflowsRoutes } from './workflows';

const close: Array<() => void> = [];
afterEach(() => {
  while (close.length) close.pop()!();
});

function graph(): WorkflowGraphSnapshot {
  return {
    schemaVersion: 1,
    entryNodeKey: 'issue',
    maxLoopIterations: 8,
    nodes: [
      { key: 'issue', kind: 'issue', title: 'Issue', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null },
      { key: 'fork', kind: 'fork', title: '并行', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 100, positionY: 0, config: { joinNodeKey: 'join' } },
      { key: 'code', kind: 'agent', title: '实现', instructions: '完成代码', agent: 'codex', executionMode: 'write', maxVisits: 4, positionX: 200, positionY: -80, config: null },
      { key: 'review', kind: 'agent', title: '评审', instructions: '检查风险', agent: 'claude', executionMode: 'read', maxVisits: 1, positionX: 200, positionY: 80, config: null },
      { key: 'join', kind: 'join', title: '汇合', instructions: null, agent: null, executionMode: 'read', maxVisits: 4, positionX: 300, positionY: 0, config: null },
      { key: 'route', kind: 'agent', title: '判断', instructions: '决定是否修改', agent: 'claude', executionMode: 'read', maxVisits: 4, positionX: 400, positionY: 0, config: null },
      { key: 'end', kind: 'end', title: '完成', instructions: null, agent: null, executionMode: 'read', maxVisits: 1, positionX: 500, positionY: 0, config: null },
    ],
    edges: [
      { key: 'issue-fork', fromNodeKey: 'issue', toNodeKey: 'fork', conditionText: null, priority: 0, isDefault: false },
      { key: 'fork-code', fromNodeKey: 'fork', toNodeKey: 'code', conditionText: null, priority: 0, isDefault: false },
      { key: 'fork-review', fromNodeKey: 'fork', toNodeKey: 'review', conditionText: null, priority: 0, isDefault: false },
      { key: 'code-join', fromNodeKey: 'code', toNodeKey: 'join', conditionText: null, priority: 0, isDefault: false },
      { key: 'review-join', fromNodeKey: 'review', toNodeKey: 'join', conditionText: null, priority: 0, isDefault: false },
      { key: 'join-route', fromNodeKey: 'join', toNodeKey: 'route', conditionText: null, priority: 0, isDefault: false },
      { key: 'changes', fromNodeKey: 'route', toNodeKey: 'code', conditionText: '评审认为仍需修改', priority: 10, isDefault: false },
      { key: 'finished', fromNodeKey: 'route', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: true },
    ],
  };
}

function setup(supportsCodex = true) {
  const db = openDb(':memory:');
  close.push(() => db.close());
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const owner = users.create('owner');
  const stranger = users.create('stranger');
  db.query(
    `INSERT INTO executors
       (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir,
        supports_claude, supports_codex)
     VALUES (1, 'local', '127.0.0.1', 22, '', '', '/tmp', '', 1, ?)`,
  ).run(supportsCodex ? 1 : 0);
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'one', 1, '/tmp/one', ?, 1),
            (2, 'two', 1, '/tmp/two', ?, 1)`,
  ).run(owner.user.id, owner.user.id);
  const dispatch = createDispatcher(workflowsRoutes({ db }), authDepsFromDb(db, users));
  return { db, owner, stranger, dispatch };
}

function request(method: string, path: string, token?: string, body?: unknown): Request {
  return new Request(`http://test${path}`, {
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
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await dispatch(request(method, path, token, body))!;
  return { status: response.status, body: await response.json() };
}

describe('工作流图校验', () => {
  test('接受自然语言分支、循环及成对的并行分叉/汇合', () => {
    const result = validateWorkflowGraph(graph(), ['claude', 'codex']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graphHash).toMatch(/^[0-9a-f]{64}$/);
      expect(result.graph.nodes).toHaveLength(7);
      expect(result.graph.edges).toHaveLength(8);
    }
  });

  test('同时拒绝不可用 Agent、断路节点、不安全循环和未汇合的并行分支', () => {
    const value = graph();
    value.nodes.find((node) => node.key === 'code')!.maxVisits = 1;
    value.nodes.find((node) => node.key === 'fork')!.config = { joinNodeKey: 'missing' };
    value.nodes.push({
      key: 'orphan', kind: 'agent', title: '孤立', instructions: null, agent: 'codex',
      executionMode: 'read', maxVisits: 1, positionX: 0, positionY: 0, config: null,
    });
    const result = validateWorkflowGraph(value, ['claude']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.issues.map((issue) => issue.code);
      expect(codes).toContain('workflow.agent_unavailable');
      expect(codes).toContain('workflow.node_unreachable');
      expect(codes).toContain('workflow.node_cannot_finish');
      expect(codes).toContain('workflow.cycle_node_limit_required');
      expect(codes).toContain('workflow.fork_join_invalid');
    }
  });

  test('条件分支必须有自然语言条件和唯一默认连线', () => {
    const value = graph();
    const changes = value.edges.find((edge) => edge.key === 'changes')!;
    changes.conditionText = null;
    value.edges.find((edge) => edge.key === 'finished')!.isDefault = false;
    const result = validateWorkflowGraph(value, ['claude', 'codex']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
        'workflow.default_edge_required',
        'workflow.condition_required',
      ]));
    }
  });
});

describe('项目工作流模板接口', () => {
  test('创建、查询、重命名、发布新版本、复制和删除保持旧版本及 issue 快照', async () => {
    const s = setup();
    const created = await call(s.dispatch, 'POST', '/api/projects/1/workflows', s.owner.token, {
      name: '交付流程',
      description: '实现、评审与返工',
      graph: graph(),
    });
    expect(created.status).toBe(200);
    expect(created.body.workflow).toMatchObject({
      template: { projectId: 1, name: '交付流程', currentVersion: 1 },
      version: { version: 1 },
      nodeCount: 7,
      edgeCount: 8,
    });
    const workflowId = created.body.workflow.template.id as number;
    const version1Id = created.body.workflow.version.id as number;
    const graph1 = JSON.stringify(created.body.workflow.version.graph);

    expect((await call(s.dispatch, 'GET', '/api/projects/1/workflows', s.owner.token)).body.workflows).toHaveLength(1);
    expect((await call(s.dispatch, 'GET', `/api/projects/1/workflows/${workflowId}`, s.owner.token)).status).toBe(200);

    const renamed = await call(s.dispatch, 'PATCH', `/api/projects/1/workflows/${workflowId}`, s.owner.token, {
      name: '标准交付流程',
      status: 'archived',
    });
    expect(renamed.body.workflow.template).toMatchObject({ name: '标准交付流程', status: 'archived', currentVersion: 1 });

    const nextGraph = graph();
    nextGraph.nodes.find((node) => node.key === 'review')!.title = '严格评审';
    const updated = await call(s.dispatch, 'PUT', `/api/projects/1/workflows/${workflowId}`, s.owner.token, { graph: nextGraph });
    expect(updated.status).toBe(200);
    expect(updated.body.workflow.version).toMatchObject({ version: 2 });
    expect(
      s.db.query<{ graph_json: string }, [number]>('SELECT graph_json FROM project_workflow_versions WHERE id = ?').get(version1Id)!.graph_json,
    ).toBe(graph1);

    const copied = await call(s.dispatch, 'POST', `/api/projects/1/workflows/${workflowId}/copy`, s.owner.token, {
      name: '交付流程副本',
    });
    expect(copied.status).toBe(200);
    expect(copied.body.workflow).toMatchObject({
      template: { name: '交付流程副本', currentVersion: 1 },
      version: { version: 1, graph: nextGraph },
    });

    s.db.query(`INSERT INTO issues (id, project_id, title, created_ts) VALUES (33, 1, 'issue', 10)`).run();
    s.db.query(
      `INSERT INTO issue_workflows
         (issue_id, template_id, template_version_id, template_name, template_version,
          graph_json, graph_hash, context_json, created_ts, updated_ts)
       VALUES (33, ?, ?, '标准交付流程', 1, ?, 'snapshot-hash', '{}', 10, 10)`,
    ).run(workflowId, version1Id, graph1);

    expect((await call(s.dispatch, 'DELETE', `/api/projects/1/workflows/${workflowId}`, s.owner.token)).status).toBe(200);
    expect((await call(s.dispatch, 'GET', `/api/projects/1/workflows/${workflowId}`, s.owner.token)).status).toBe(404);
    expect(
      s.db.query<{ template_id: number | null; template_version_id: number | null; graph_json: string }, []>(
        'SELECT template_id, template_version_id, graph_json FROM issue_workflows WHERE issue_id = 33',
      ).get(),
    ).toEqual({ template_id: null, template_version_id: null, graph_json: graph1 });
  });

  test('校验接口返回结构化问题，重复名称和跨项目访问被拒绝', async () => {
    const s = setup(false);
    const invalid = await call(s.dispatch, 'POST', '/api/projects/1/workflows/validate', s.owner.token, { graph: graph() });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: 'workflow.graph_invalid',
      fallback: 'The workflow graph is invalid. Fix the marked structure issues.',
      details: { issues: expect.arrayContaining([expect.objectContaining({ code: 'workflow.agent_unavailable', nodeKey: 'code' })]) },
    });

    // 临时启用 Codex，验证同名唯一约束和项目资源归属。
    s.db.query('UPDATE executors SET supports_codex = 1 WHERE id = 1').run();
    const first = await call(s.dispatch, 'POST', '/api/projects/1/workflows', s.owner.token, { name: '唯一名称', graph: graph() });
    expect(first.status).toBe(200);
    expect((await call(s.dispatch, 'POST', '/api/projects/1/workflows', s.owner.token, { name: '唯一名称', graph: graph() })).body.error.code).toBe('workflow.name_conflict');
    const workflowId = first.body.workflow.template.id as number;
    expect((await call(s.dispatch, 'GET', `/api/projects/2/workflows/${workflowId}`, s.owner.token)).status).toBe(404);
    expect((await call(s.dispatch, 'GET', '/api/projects/1/workflows', s.stranger.token)).status).toBe(403);
  });
});

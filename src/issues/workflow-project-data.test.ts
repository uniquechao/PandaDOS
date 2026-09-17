import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from './engine';
import { WorkflowTemplateStore, validateWorkflowGraph } from './workflows';
import { createWorkflowProjectDataAdapter, workflowDataProjection } from './workflow-project-data';

const graph = {
  schemaVersion: 1 as const,
  entryNodeKey: 'issue',
  maxLoopIterations: 10,
  nodes: [
    { key: 'issue', kind: 'issue' as const, title: 'Issue', instructions: null, agent: null, executionMode: 'read' as const, maxVisits: 1, positionX: 0, positionY: 0, config: null },
    { key: 'end', kind: 'end' as const, title: 'End', instructions: null, agent: null, executionMode: 'read' as const, maxVisits: 1, positionX: 1, positionY: 0, config: null },
  ],
  edges: [{ key: 'done', fromNodeKey: 'issue', toNodeKey: 'end', conditionText: null, priority: 0, isDefault: true }],
};

function db() {
  const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
  db.run(`INSERT INTO executors (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'e', 'local', '', '', '/ws', '')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'p', 1, '/ws/p', 1, 1)`);
  return db;
}

describe('workflow 文件同步', () => {
  test('投影当前模板版本并导入长期定义，不携带运行记录', async () => {
    const source = db();
    const valid = validateWorkflowGraph(graph, ['claude', 'codex']);
    if (!valid.ok) throw new Error('fixture invalid');
    const detail = new WorkflowTemplateStore(source).create({
      projectId: 1, name: '交付流', description: '共享模板', graph: valid.graph,
      graphJson: valid.graphJson, graphHash: valid.graphHash,
    });
    const projected = workflowDataProjection(source, detail.template.id);
    expect(projected).toMatchObject({ kind: 'workflow', name: '交付流', graph });
    expect(projected).not.toHaveProperty('runs');
    expect(projected).not.toHaveProperty('worktrees');

    const target = db();
    const adapter = createWorkflowProjectDataAdapter(target);
    await adapter.apply(1, {
      path: `.panda/workflows/${projected.uid}.json`, fingerprint: 'a'.repeat(64),
      uid: projected.uid, version: 1, kind: 'workflow', value: projected,
    });
    expect(new WorkflowTemplateStore(target).list(1)[0]).toMatchObject({
      template: { name: '交付流' }, version: { graph },
    });
    expect(target.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM issue_workflows').get()!.n).toBe(0);
    source.close(); target.close();
  });
});

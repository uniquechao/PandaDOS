import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { migrateDesigns } from './store';
import { createDesignProjectDataAdapters, designDataProjection } from './project-data-sync';

function db() {
  const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db); migrateDesigns(db);
  db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
  db.run(`INSERT INTO executors (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'e', 'local', '', '', '/ws', '')`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'p', 1, '/ws/p', 1, 1)`);
  return db;
}

describe('design 文件同步', () => {
  test('投影长期内容并导入，不复制会话、工作树、错误和审批运行态', async () => {
    const source = db();
    source.run(`INSERT INTO design_tasks
      (project_id, title, original_request, agent, stage, status, current_revision,
       document_json, document_markdown, conversation_id, worktree_cwd, worktree_branch,
       worktree_metadata_json, last_error, created_ts, updated_ts)
      VALUES (1, '方案', '设计请求', 'codex', 'approved', 'active', 1,
       '{"summary":"ok"}', '# 方案', NULL, '/tmp/wt', 'run/x', '{}', 'old', 2, 3)`);
    source.run(`INSERT INTO design_revisions
      (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, created_ts)
      VALUES (1, 1, '{"summary":"ok"}', '# 方案', 90, '{"nodes":[],"edges":[]}', 'owner', 3)`);
    source.run(`INSERT INTO design_assets
      (design_task_id, design_revision, prompt, status, path, mime_type, width, height, created_ts, updated_ts)
      VALUES (1, 1, '图', 'ready', 'assets/1-view.png', 'image/png', 100, 80, 3, 3)`);
    const projected = designDataProjection(source, 1);
    expect(projected).toMatchObject({ kind: 'design', title: '方案', documentMarkdown: '# 方案' });
    for (const key of ['conversationId', 'worktreeCwd', 'worktreeBranch', 'lastError', 'approval']) {
      expect(projected).not.toHaveProperty(key);
    }

    const target = db();
    const adapter = createDesignProjectDataAdapters(target)[0]!;
    await adapter.apply(1, {
      path: '.panda/designs/design-1/sync.json', fingerprint: 'b'.repeat(64),
      uid: projected.uid, version: 1, kind: 'design', value: projected,
    });
    expect(target.query<Record<string, unknown>, []>('SELECT * FROM design_tasks').get())
      .toMatchObject({ title: '方案', document_markdown: '# 方案', conversation_id: null, worktree_cwd: null, last_error: null });
    expect(target.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM design_execution_runs').get()!.n).toBe(0);
    source.close(); target.close();
  });
});

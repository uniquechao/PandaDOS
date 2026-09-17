/** Long-lived design projection; execution runs, worktrees, locks and approvals are excluded. */
import type { Database } from 'bun:sqlite';
import { PANDA_PROJECT_DATA, PANDA_PROJECT_DATA_VERSION } from '../core/project-data';
import type { PandaSyncAdapter, VersionedPandaRecord } from '../core/project-sync';

export function designDataProjection(db: Database, designId: number): VersionedPandaRecord {
  const task = db.query<Record<string, unknown>, [number]>('SELECT * FROM design_tasks WHERE id = ?').get(designId);
  if (!task || typeof task.sync_uid !== 'string') throw new Error('design 不存在或缺少 sync_uid');
  const revision = Number(task.current_revision) > 0
    ? db.query<Record<string, unknown>, [number, number]>(
      'SELECT * FROM design_revisions WHERE design_task_id = ? AND revision = ?',
    ).get(designId, Number(task.current_revision))
    : null;
  const assets = db.query<Record<string, unknown>, [number]>(
    `SELECT path, mime_type, width, height, metadata_json, created_ts
     FROM design_assets WHERE design_task_id = ? AND path IS NOT NULL AND status <> 'archived' ORDER BY id`,
  ).all(designId).map((asset) => ({
    path: asset.path,
    mimeType: asset.mime_type,
    width: asset.width,
    height: asset.height,
    metadata: asset.metadata_json ? JSON.parse(String(asset.metadata_json)) : null,
    createdTs: asset.created_ts,
  }));
  const stage = task.stage === 'executing' || task.stage === 'error' ? 'approved' : task.stage;
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'design',
    uid: task.sync_uid,
    updatedTs: Number(task.updated_ts),
    title: task.title,
    originalRequest: task.original_request,
    agent: task.agent,
    stage,
    status: task.status === 'archived' ? 'archived' : 'active',
    readinessThreshold: task.readiness_threshold,
    graphGranularity: task.graph_granularity,
    documentJson: revision ? JSON.parse(String(revision.document_json)) : task.document_json ? JSON.parse(String(task.document_json)) : {},
    documentMarkdown: revision?.document_markdown ?? task.document_markdown ?? '',
    readiness: Number(revision?.readiness ?? 0),
    graph: revision ? JSON.parse(String(revision.graph_json)) : { nodes: [], edges: [] },
    assets,
    createdTs: Number(task.created_ts),
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createDesignProjectDataAdapters(db: Database): PandaSyncAdapter[] {
  return [{
    kind: 'design',
    priority: 40,
    matches: (path) => /^\.panda\/designs\/design-[^/]+\/sync\.json$/.test(path),
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const title = typeof value.title === 'string' ? value.title.trim().slice(0, 200) : '';
      if (!title) throw new Error('design 标题为空');
      const documentJson = object(value.documentJson);
      const documentMarkdown = typeof value.documentMarkdown === 'string' ? value.documentMarkdown : '';
      const graph = object(value.graph);
      const agent = value.agent === 'claude' ? 'claude' : 'codex';
      const allowedStages = new Set(['goal_setting', 'solution_draft', 'review', 'graph_draft', 'approved', 'completed', 'archived']);
      const stage = typeof value.stage === 'string' && allowedStages.has(value.stage) ? value.stage : 'approved';
      const status = value.status === 'archived' ? 'archived' : 'active';
      const ts = Number(value.updatedTs) || Date.now();
      db.transaction(() => {
        let task = db.query<{ id: number; current_revision: number }, [number, string]>(
          'SELECT id, current_revision FROM design_tasks WHERE project_id = ? AND sync_uid = ?',
        ).get(projectId, item.uid);
        if (!task) {
          task = db.query<{ id: number; current_revision: number }, [number, string, string, string, string, string, string, number, string, string, string, number, number]>(
            `INSERT INTO design_tasks
              (project_id, sync_uid, title, original_request, agent, stage, status, current_revision,
               readiness_threshold, document_json, document_markdown, graph_granularity,
               created_ts, updated_ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?) RETURNING id, current_revision`,
          ).get(projectId, item.uid, title, String(value.originalRequest ?? ''), agent, stage, status,
            Number(value.readinessThreshold) || 80, JSON.stringify(documentJson), documentMarkdown,
            typeof value.graphGranularity === 'string' ? value.graphGranularity : 'balanced',
            Number(value.createdTs) || ts, ts)!;
        }
        const nextRevision = task.current_revision + 1;
        db.query(`UPDATE design_tasks SET title = ?, original_request = ?, agent = ?, stage = ?, status = ?,
          current_revision = ?, readiness_threshold = ?, document_json = ?, document_markdown = ?,
          graph_granularity = ?, conversation_id = NULL, worktree_cwd = NULL, worktree_branch = NULL,
          worktree_metadata_json = NULL, last_error = NULL, updated_ts = ? WHERE id = ?`)
          .run(title, String(value.originalRequest ?? ''), agent, stage, status, nextRevision,
            Number(value.readinessThreshold) || 80, JSON.stringify(documentJson), documentMarkdown,
            typeof value.graphGranularity === 'string' ? value.graphGranularity : 'balanced', ts, task.id);
        db.query(`INSERT INTO design_revisions
          (design_task_id, revision, document_json, document_markdown, readiness, graph_json, actor, reason, created_ts)
          VALUES (?, ?, ?, ?, ?, ?, 'project-sync', 'file-authoritative import', ?)`)
          .run(task.id, nextRevision, JSON.stringify(documentJson), documentMarkdown,
            Math.max(0, Math.min(100, Number(value.readiness) || 0)), JSON.stringify(graph), ts);

        const graphNodes = Array.isArray(graph.nodes) ? graph.nodes.map(object) : [];
        const graphEdges = Array.isArray(graph.edges) ? graph.edges.map(object) : [];
        const nodeIds = new Set(graphNodes.map((node) => String(node.nodeId ?? '')));
        if (nodeIds.has('') || nodeIds.size !== graphNodes.length) throw new Error('design graph 节点无效');
        db.query('DELETE FROM design_graph_edges WHERE design_task_id = ?').run(task.id);
        db.query('DELETE FROM design_graph_nodes WHERE design_task_id = ?').run(task.id);
        for (const [index, node] of graphNodes.entries()) {
          const nodeId = String(node.nodeId);
          const nodeTitle = typeof node.title === 'string' && node.title.trim() ? node.title : nodeId;
          const detail = { ...node };
          delete detail.nodeId;
          delete detail.ordinal;
          delete detail.title;
          delete detail.issueId;
          delete detail.lastSyncedRevision;
          delete detail.moduleId;
          db.query(`INSERT INTO design_graph_nodes
            (design_task_id, node_id, ordinal, title, detail_json, issue_id,
             last_synced_revision, created_ts, updated_ts)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`)
            .run(task.id, nodeId, Number.isSafeInteger(node.ordinal) ? Number(node.ordinal) : index,
              nodeTitle, JSON.stringify(detail), ts, ts);
        }
        for (const edge of graphEdges) {
          const from = String(edge.fromNodeId ?? '');
          const to = String(edge.toNodeId ?? '');
          if (!nodeIds.has(from) || !nodeIds.has(to) || from === to) throw new Error('design graph 连线无效');
          db.query(`INSERT INTO design_graph_edges
            (design_task_id, from_node_id, to_node_id, kind, created_ts)
            VALUES (?, ?, ?, ?, ?)`)
            .run(task.id, from, to, typeof edge.kind === 'string' ? edge.kind : 'depends_on', ts);
        }

        const incoming = Array.isArray(value.assets) ? value.assets.map(object) : [];
        const paths = incoming.map((asset) => String(asset.path ?? '')).filter(Boolean);
        if (paths.length) {
          const placeholders = paths.map(() => '?').join(',');
          db.query(`UPDATE design_assets SET status = 'archived', updated_ts = ?
            WHERE design_task_id = ? AND path IS NOT NULL AND path NOT IN (${placeholders})`)
            .run(ts, task.id, ...paths);
        } else {
          db.query(`UPDATE design_assets SET status = 'archived', updated_ts = ? WHERE design_task_id = ?`)
            .run(ts, task.id);
        }
        for (const asset of incoming) {
          const path = String(asset.path ?? '');
          if (!/^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(path)) throw new Error('design asset 路径无效');
          const mimeType = typeof asset.mimeType === 'string' ? asset.mimeType : null;
          const width = Number.isSafeInteger(asset.width) ? Number(asset.width) : null;
          const height = Number.isSafeInteger(asset.height) ? Number(asset.height) : null;
          const metadata = asset.metadata === null || asset.metadata === undefined
            ? null : JSON.stringify(asset.metadata);
          const found = db.query<{ id: number }, [number, string]>(
            'SELECT id FROM design_assets WHERE design_task_id = ? AND path = ?',
          ).get(task.id, path);
          if (found) {
            db.query(`UPDATE design_assets SET status = 'ready', mime_type = ?, width = ?, height = ?,
              metadata_json = ?, updated_ts = ? WHERE id = ?`)
              .run(mimeType, width, height, metadata, ts, found.id);
          } else {
            db.query(`INSERT INTO design_assets
              (design_task_id, design_revision, prompt, status, path, mime_type, width, height,
               metadata_json, created_ts, updated_ts)
              VALUES (?, ?, 'Imported project asset', 'ready', ?, ?, ?, ?, ?, ?, ?)`)
              .run(task.id, nextRevision, path, mimeType, width,
                height, metadata,
                Number(asset.createdTs) || ts, ts);
          }
        }
      })();
    },
    archive(projectId, item) {
      db.query(`UPDATE design_tasks SET status = 'archived', stage = 'archived'
        WHERE project_id = ? AND sync_uid = ?`).run(projectId, item.uid);
    },
  }];
}

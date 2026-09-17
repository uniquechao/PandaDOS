/** Git-shareable workflow template projection; issue workflow executions remain local runtime state. */
import type { Database } from 'bun:sqlite';
import { PANDA_PROJECT_DATA, PANDA_PROJECT_DATA_VERSION } from '../core/project-data';
import type { PandaSyncAdapter, VersionedPandaRecord } from '../core/project-sync';
import { validateWorkflowGraph } from './workflows';

export function workflowDataProjection(db: Database, templateId: number): VersionedPandaRecord {
  const template = db.query<Record<string, unknown>, [number]>(
    'SELECT * FROM project_workflow_templates WHERE id = ?',
  ).get(templateId);
  if (!template || typeof template.sync_uid !== 'string') throw new Error('workflow 模板不存在或缺少 sync_uid');
  const version = db.query<{ graph_json: string; graph_hash: string }, [number, number]>(
    'SELECT graph_json, graph_hash FROM project_workflow_versions WHERE template_id = ? AND version = ?',
  ).get(templateId, Number(template.current_version));
  if (!version) throw new Error('workflow 当前版本不存在');
  return {
    schema: PANDA_PROJECT_DATA.schema,
    version: PANDA_PROJECT_DATA_VERSION,
    kind: 'workflow',
    uid: template.sync_uid,
    updatedTs: Number(template.updated_ts),
    name: template.name,
    description: template.description,
    status: template.status,
    graph: JSON.parse(version.graph_json),
    graphHash: version.graph_hash,
    createdTs: Number(template.created_ts),
  };
}

function persistGraph(db: Database, versionId: number, graph: ReturnType<typeof validGraph>['graph'], ts: number): void {
  for (const node of graph.nodes) {
    db.query(`INSERT INTO project_workflow_nodes
      (version_id, node_key, kind, title, instructions, agent, execution_mode,
       max_visits, position_x, position_y, config_json, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(versionId, node.key, node.kind, node.title, node.instructions, node.agent,
        node.executionMode, node.maxVisits, node.positionX, node.positionY,
        node.config === null ? null : JSON.stringify(node.config), ts);
  }
  for (const edge of graph.edges) {
    db.query(`INSERT INTO project_workflow_edges
      (version_id, edge_key, from_node_key, to_node_key, condition_text, priority, is_default, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(versionId, edge.key, edge.fromNodeKey, edge.toNodeKey, edge.conditionText,
        edge.priority, edge.isDefault ? 1 : 0, ts);
  }
}

function validGraph(value: unknown) {
  const result = validateWorkflowGraph(value, ['claude', 'codex']);
  if (!result.ok) throw new Error(`workflow 图无效：${result.issues.map((issue) => issue.code).join(',')}`);
  return result;
}

export function createWorkflowProjectDataAdapter(db: Database): PandaSyncAdapter {
  return {
    kind: 'workflow',
    priority: 30,
    matches: (path) => /^\.panda\/workflows\/[0-9a-f-]+\.json$/.test(path),
    apply(projectId, item) {
      const value = item.value as Record<string, unknown>;
      const name = typeof value.name === 'string' ? value.name.trim().slice(0, 80) : '';
      if (!name) throw new Error('workflow 名称为空');
      const description = typeof value.description === 'string' ? value.description.slice(0, 500) : null;
      const status = value.status === 'archived' ? 'archived' : 'active';
      const graph = validGraph(value.graph);
      const ts = Number(value.updatedTs) || Date.now();
      db.transaction(() => {
        let template = db.query<{ id: number; current_version: number }, [number, string]>(
          'SELECT id, current_version FROM project_workflow_templates WHERE project_id = ? AND sync_uid = ?',
        ).get(projectId, item.uid);
        if (!template) {
          template = db.query<{ id: number; current_version: number }, [number, string, string, string | null, number, number]>(
            `INSERT INTO project_workflow_templates
              (project_id, sync_uid, name, description, status, current_version, created_ts, updated_ts)
             VALUES (?, ?, ?, ?, '${status}', 1, ?, ?) RETURNING id, current_version`,
          ).get(projectId, item.uid, name, description, Number(value.createdTs) || ts, ts)!;
        } else {
          const current = db.query<{ graph_hash: string }, [number, number]>(
            'SELECT graph_hash FROM project_workflow_versions WHERE template_id = ? AND version = ?',
          ).get(template.id, template.current_version);
          db.query(`UPDATE project_workflow_templates SET name = ?, description = ?, status = ?, updated_ts = ?
            WHERE id = ?`).run(name, description, status, ts, template.id);
          if (current?.graph_hash === graph.graphHash) return;
          template.current_version += 1;
          db.query('UPDATE project_workflow_templates SET current_version = ? WHERE id = ?')
            .run(template.current_version, template.id);
        }
        const version = db.query<{ id: number }, [number, number, string, string, number]>(
          `INSERT INTO project_workflow_versions
            (template_id, version, graph_json, graph_hash, created_ts)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
        ).get(template.id, template.current_version, graph.graphJson, graph.graphHash, ts)!;
        persistGraph(db, version.id, graph.graph, ts);
      })();
    },
    archive(projectId, item) {
      db.query(`UPDATE project_workflow_templates SET status = 'archived'
        WHERE project_id = ? AND sync_uid = ?`).run(projectId, item.uid);
    },
  };
}

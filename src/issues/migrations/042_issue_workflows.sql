-- 042_issue_workflows: 项目级可复用工作流模板 + issue 不可变快照 + 节点运行记录。
--
-- 模板每次保存都新增 project_workflow_versions；已创建 issue 复制完整 graph_json 到
-- issue_workflows，故模板归档、改名或发布新版本都不会改变运行中的工作流。

CREATE TABLE project_workflow_templates (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),
  current_version  INTEGER NOT NULL DEFAULT 1 CHECK (current_version > 0),
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ts       INTEGER NOT NULL,
  updated_ts       INTEGER NOT NULL,
  UNIQUE(project_id, name)
);

CREATE INDEX idx_project_workflow_templates_project_status
  ON project_workflow_templates(project_id, status, updated_ts);

CREATE TABLE project_workflow_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id    INTEGER NOT NULL REFERENCES project_workflow_templates(id) ON DELETE CASCADE,
  version        INTEGER NOT NULL CHECK (version > 0),
  graph_json     TEXT NOT NULL,
  graph_hash     TEXT NOT NULL,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ts     INTEGER NOT NULL,
  UNIQUE(template_id, version)
);

CREATE INDEX idx_project_workflow_versions_template
  ON project_workflow_versions(template_id, version DESC);

CREATE TABLE project_workflow_nodes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id       INTEGER NOT NULL REFERENCES project_workflow_versions(id) ON DELETE CASCADE,
  node_key         TEXT NOT NULL,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('issue', 'agent', 'fork', 'join', 'end')),
  title            TEXT NOT NULL,
  instructions     TEXT,
  agent            TEXT CHECK (agent IS NULL OR agent IN ('claude', 'codex')),
  execution_mode   TEXT NOT NULL DEFAULT 'read'
                     CHECK (execution_mode IN ('read', 'write')),
  max_visits       INTEGER NOT NULL DEFAULT 1 CHECK (max_visits BETWEEN 1 AND 100),
  position_x       REAL NOT NULL DEFAULT 0,
  position_y       REAL NOT NULL DEFAULT 0,
  config_json      TEXT,
  created_ts       INTEGER NOT NULL,
  UNIQUE(version_id, node_key)
);

CREATE INDEX idx_project_workflow_nodes_version
  ON project_workflow_nodes(version_id, id);

CREATE TABLE project_workflow_edges (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id       INTEGER NOT NULL REFERENCES project_workflow_versions(id) ON DELETE CASCADE,
  edge_key         TEXT NOT NULL,
  from_node_key    TEXT NOT NULL,
  to_node_key      TEXT NOT NULL,
  condition_text   TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_ts       INTEGER NOT NULL,
  UNIQUE(version_id, edge_key),
  FOREIGN KEY(version_id, from_node_key)
    REFERENCES project_workflow_nodes(version_id, node_key) ON DELETE CASCADE,
  FOREIGN KEY(version_id, to_node_key)
    REFERENCES project_workflow_nodes(version_id, node_key) ON DELETE CASCADE
);

CREATE INDEX idx_project_workflow_edges_from
  ON project_workflow_edges(version_id, from_node_key, priority DESC, id);
CREATE INDEX idx_project_workflow_edges_to
  ON project_workflow_edges(version_id, to_node_key, id);

CREATE TABLE issue_workflows (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id              INTEGER NOT NULL UNIQUE REFERENCES issues(id) ON DELETE CASCADE,
  template_id           INTEGER REFERENCES project_workflow_templates(id) ON DELETE SET NULL,
  template_version_id   INTEGER REFERENCES project_workflow_versions(id) ON DELETE SET NULL,
  template_name         TEXT NOT NULL,
  template_version      INTEGER NOT NULL CHECK (template_version > 0),
  graph_json            TEXT NOT NULL,
  graph_hash            TEXT NOT NULL,
  context_json          TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN (
                            'pending', 'running', 'paused', 'completed', 'failed', 'cancelled'
                          )),
  pause_reason          TEXT,
  max_loop_iterations   INTEGER NOT NULL DEFAULT 10
                          CHECK (max_loop_iterations BETWEEN 1 AND 100),
  created_ts            INTEGER NOT NULL,
  updated_ts            INTEGER NOT NULL,
  started_ts            INTEGER,
  completed_ts          INTEGER
);

CREATE INDEX idx_issue_workflows_status
  ON issue_workflows(status, updated_ts);
CREATE INDEX idx_issue_workflows_template
  ON issue_workflows(template_id, template_version);

CREATE TABLE issue_workflow_node_runs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_workflow_id     INTEGER NOT NULL REFERENCES issue_workflows(id) ON DELETE CASCADE,
  node_key              TEXT NOT NULL,
  attempt               INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
  iteration             INTEGER NOT NULL DEFAULT 1 CHECK (iteration > 0),
  token_key             TEXT NOT NULL,
  parent_run_id         INTEGER REFERENCES issue_workflow_node_runs(id) ON DELETE SET NULL,
  predecessor_run_ids_json TEXT,
  parallel_group_key    TEXT,
  agent                 TEXT CHECK (agent IS NULL OR agent IN ('claude', 'codex')),
  conversation_id       TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  status                TEXT NOT NULL DEFAULT 'queued'
                          CHECK (status IN (
                            'queued', 'running', 'routing', 'waiting_join', 'succeeded',
                            'failed', 'blocked', 'cancelled', 'skipped'
                          )),
  selected_edge_keys_json TEXT,
  output_text           TEXT,
  route_reason          TEXT,
  error_code            TEXT,
  error_details         TEXT,
  created_ts            INTEGER NOT NULL,
  updated_ts            INTEGER NOT NULL,
  started_ts            INTEGER,
  finished_ts           INTEGER,
  UNIQUE(issue_workflow_id, node_key, attempt)
);

CREATE INDEX idx_issue_workflow_node_runs_state
  ON issue_workflow_node_runs(issue_workflow_id, status, id);
CREATE INDEX idx_issue_workflow_node_runs_token
  ON issue_workflow_node_runs(issue_workflow_id, token_key, id);
CREATE INDEX idx_issue_workflow_node_runs_conversation
  ON issue_workflow_node_runs(conversation_id);

-- 一次节点完成可选择多条边（fork）；循环回边通过 iteration 留下独立遍历记录。
CREATE TABLE issue_workflow_transitions (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_workflow_id     INTEGER NOT NULL REFERENCES issue_workflows(id) ON DELETE CASCADE,
  from_run_id           INTEGER NOT NULL REFERENCES issue_workflow_node_runs(id) ON DELETE CASCADE,
  edge_key              TEXT NOT NULL,
  to_node_key           TEXT NOT NULL,
  decision_text         TEXT,
  iteration             INTEGER NOT NULL DEFAULT 1 CHECK (iteration > 0),
  parallel_group_key    TEXT,
  created_ts            INTEGER NOT NULL,
  UNIQUE(from_run_id, edge_key, iteration)
);

CREATE INDEX idx_issue_workflow_transitions_workflow
  ON issue_workflow_transitions(issue_workflow_id, id);
CREATE INDEX idx_issue_workflow_transitions_target
  ON issue_workflow_transitions(issue_workflow_id, to_node_key, id);

CREATE TABLE issue_workflow_worktrees (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_workflow_id           INTEGER NOT NULL REFERENCES issue_workflows(id) ON DELETE CASCADE,
  node_run_id                 INTEGER NOT NULL UNIQUE
                                REFERENCES issue_workflow_node_runs(id) ON DELETE CASCADE,
  path                        TEXT NOT NULL,
  branch                      TEXT NOT NULL,
  base_ref                    TEXT NOT NULL,
  base_sha                    TEXT,
  head_sha                    TEXT,
  status                      TEXT NOT NULL DEFAULT 'preparing'
                                CHECK (status IN (
                                  'preparing', 'active', 'merging', 'resolving', 'merged',
                                  'paused', 'cleanup_pending', 'cleaned', 'failed'
                                )),
  conflict_details            TEXT,
  resolution_conversation_id  TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  created_ts                  INTEGER NOT NULL,
  updated_ts                  INTEGER NOT NULL,
  merged_ts                   INTEGER,
  cleaned_ts                  INTEGER
);

CREATE INDEX idx_issue_workflow_worktrees_state
  ON issue_workflow_worktrees(issue_workflow_id, status, id);

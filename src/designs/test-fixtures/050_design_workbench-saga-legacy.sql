-- Standalone fixture for a legacy saga-bearing 050 schema; it intentionally avoids private Git-history dependencies.
-- 050_design_workbench: 独立设计工作台域；不改变 issue 状态、分类或执行模式语义。
-- 时间戳统一 epoch 毫秒 INTEGER；JSON 存 TEXT；此迁移由 designs/migrateDesigns 追加到共享迁移链。

CREATE TABLE design_tasks (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id           INTEGER REFERENCES project_modules(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  original_request    TEXT NOT NULL,
  agent               TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  stage               TEXT NOT NULL DEFAULT 'goal_setting' CHECK (stage IN (
                        'goal_setting', 'solution_draft', 'review', 'graph_draft', 'approved',
                        'executing', 'completed', 'archived', 'error')),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('creating', 'active', 'archived', 'error')),
  current_revision    INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  readiness_threshold INTEGER NOT NULL DEFAULT 80 CHECK (readiness_threshold BETWEEN 0 AND 100),
  readiness_override  INTEGER NOT NULL DEFAULT 0 CHECK (readiness_override IN (0, 1)),
  document_json       TEXT,
  document_markdown   TEXT,
  graph_granularity   TEXT NOT NULL DEFAULT 'issue',
  conversation_id     TEXT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
  worktree_cwd        TEXT,
  worktree_branch     TEXT,
  worktree_metadata_json TEXT,
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  last_error          TEXT
);
CREATE INDEX idx_design_tasks_project ON design_tasks(project_id, updated_ts DESC, id DESC);
CREATE INDEX idx_design_tasks_module ON design_tasks(module_id);
CREATE INDEX idx_design_tasks_status ON design_tasks(project_id, status, updated_ts DESC);

CREATE TABLE design_creation_sagas (
  saga_token          TEXT PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,
  request_json        TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  task_id             INTEGER REFERENCES design_tasks(id) ON DELETE SET NULL,
  phase               TEXT NOT NULL CHECK (phase IN (
                        'intent', 'task_created', 'conversation_created', 'bound',
                        'activating', 'activated', 'completed', 'recoverable_error')),
  conversation_owned  INTEGER NOT NULL DEFAULT 0 CHECK (conversation_owned IN (0, 1)),
  error               TEXT,
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (conversation_id)
);
CREATE INDEX idx_design_creation_sagas_incomplete
  ON design_creation_sagas(phase, updated_ts, saga_token)
  WHERE phase <> 'completed';

CREATE TABLE design_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id    INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK (revision > 0),
  document_json     TEXT NOT NULL,
  document_markdown TEXT NOT NULL,
  readiness         INTEGER NOT NULL CHECK (readiness BETWEEN 0 AND 100),
  graph_json        TEXT NOT NULL,
  actor             TEXT NOT NULL,
  reason            TEXT,
  created_ts        INTEGER NOT NULL,
  UNIQUE (design_task_id, revision)
);
CREATE INDEX idx_design_revisions_task_revision ON design_revisions(design_task_id, revision DESC);

CREATE TABLE design_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  data_json      TEXT,
  ts             INTEGER NOT NULL
);
CREATE INDEX idx_design_events_task_id ON design_events(design_task_id, id);

CREATE TABLE design_graph_nodes (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id       INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  node_id              TEXT NOT NULL,
  ordinal              INTEGER NOT NULL,
  title                TEXT NOT NULL,
  detail_json          TEXT,
  issue_id             INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  last_synced_revision INTEGER,
  created_ts           INTEGER NOT NULL,
  updated_ts           INTEGER NOT NULL,
  UNIQUE (design_task_id, node_id),
  UNIQUE (design_task_id, ordinal)
);
CREATE INDEX idx_design_graph_nodes_task_order ON design_graph_nodes(design_task_id, ordinal, id);
CREATE INDEX idx_design_graph_nodes_issue ON design_graph_nodes(issue_id);

CREATE TABLE design_graph_edges (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  from_node_id   TEXT NOT NULL,
  to_node_id     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'depends_on',
  created_ts     INTEGER NOT NULL,
  UNIQUE (design_task_id, from_node_id, to_node_id, kind),
  CHECK (from_node_id <> to_node_id)
);
CREATE INDEX idx_design_graph_edges_task_id ON design_graph_edges(design_task_id, from_node_id, to_node_id);

CREATE TABLE design_persona_sources (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key   TEXT NOT NULL UNIQUE,
  source_url   TEXT,
  content_hash TEXT NOT NULL,
  content      TEXT NOT NULL,
  fetched_ts   INTEGER NOT NULL,
  updated_ts   INTEGER NOT NULL
);
CREATE INDEX idx_design_persona_sources_hash ON design_persona_sources(content_hash);

CREATE TABLE design_personas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    INTEGER REFERENCES design_persona_sources(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_ts   INTEGER NOT NULL,
  updated_ts   INTEGER NOT NULL,
  UNIQUE (source_id, name, content_hash)
);
CREATE INDEX idx_design_personas_source ON design_personas(source_id);

CREATE TABLE design_project_personas (
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  persona_id    INTEGER NOT NULL REFERENCES design_personas(id) ON DELETE CASCADE,
  approved_hash TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  PRIMARY KEY (project_id, persona_id)
);
CREATE INDEX idx_design_project_personas_enabled ON design_project_personas(project_id, enabled);

CREATE TABLE design_assets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id     INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  design_revision    INTEGER,
  prompt             TEXT NOT NULL,
  provider           TEXT,
  status             TEXT NOT NULL,
  path               TEXT,
  mime_type          TEXT,
  width              INTEGER,
  height              INTEGER,
  metadata_json      TEXT,
  error              TEXT,
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  FOREIGN KEY (design_task_id, design_revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE RESTRICT
);
CREATE INDEX idx_design_assets_task_revision ON design_assets(design_task_id, design_revision, id);

ALTER TABLE issues ADD COLUMN design_task_id INTEGER REFERENCES design_tasks(id) ON DELETE SET NULL;
ALTER TABLE issues ADD COLUMN design_node_id TEXT;
ALTER TABLE issues ADD COLUMN design_revision INTEGER;
CREATE INDEX idx_issues_design_task ON issues(design_task_id);
CREATE INDEX idx_issues_design_node ON issues(design_task_id, design_node_id);

ALTER TABLE conversations ADD COLUMN workspace_cwd TEXT;
ALTER TABLE conversations ADD COLUMN design_creation_saga_token TEXT;
CREATE UNIQUE INDEX idx_conversations_design_creation_saga_token
  ON conversations(design_creation_saga_token)
  WHERE design_creation_saga_token IS NOT NULL;

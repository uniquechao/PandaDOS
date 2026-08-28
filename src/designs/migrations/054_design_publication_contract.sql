-- 054_design_publication_contract: canonical graph publication identity and durable Issue links.
-- Recorded 050 migrations stay immutable. Its legacy DEFAULT 'issue' is admitted only long enough
-- for the idempotent Design migration bridge to normalize raw inserts/updates to 'balanced'.

UPDATE design_tasks
SET graph_granularity = 'balanced'
WHERE graph_granularity NOT IN ('milestone', 'module', 'balanced', 'small', 'atomic');

ALTER TABLE design_tasks ADD COLUMN graph_granularity_contract INTEGER
  GENERATED ALWAYS AS (
    graph_granularity IN ('milestone', 'module', 'balanced', 'small', 'atomic', 'issue')
  ) VIRTUAL CHECK (graph_granularity_contract = 1);

CREATE UNIQUE INDEX idx_design_tasks_id_project
  ON design_tasks(id, project_id);
CREATE UNIQUE INDEX idx_issues_id_project
  ON issues(id, project_id);

CREATE TABLE design_publications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  design_task_id  INTEGER NOT NULL,
  project_id      INTEGER NOT NULL,
  revision        INTEGER NOT NULL CHECK (revision > 0),
  graph_digest    TEXT NOT NULL CHECK (
                    length(graph_digest) = 64 AND graph_digest NOT GLOB '*[^0-9a-f]*'
                  ),
  actor_key       TEXT NOT NULL CHECK (length(actor_key) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 256),
  status          TEXT NOT NULL CHECK (status IN (
                    'committed', 'post_commit_pending', 'complete', 'recoverable_error'
                  )),
  error           TEXT CHECK (error IS NULL OR length(error) <= 4000),
  created_ts      INTEGER NOT NULL,
  updated_ts      INTEGER NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (design_task_id, revision, graph_digest),
  UNIQUE (id, design_task_id),
  UNIQUE (id, design_task_id, project_id),
  UNIQUE (id, design_task_id, revision, graph_digest, actor_key),
  FOREIGN KEY (design_task_id, project_id)
    REFERENCES design_tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (design_task_id, revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE RESTRICT
);
CREATE INDEX idx_design_publications_task_revision
  ON design_publications(design_task_id, revision DESC, id DESC);
CREATE INDEX idx_design_publications_recovery
  ON design_publications(status, updated_ts, id);

CREATE TABLE design_publish_confirmations (
  token_hash              TEXT PRIMARY KEY CHECK (
                            length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
                          ),
  design_task_id          INTEGER NOT NULL,
  revision                INTEGER NOT NULL CHECK (revision > 0),
  graph_digest            TEXT NOT NULL CHECK (
                            length(graph_digest) = 64 AND graph_digest NOT GLOB '*[^0-9a-f]*'
                          ),
  actor_key               TEXT NOT NULL CHECK (length(actor_key) BETWEEN 1 AND 256),
  expires_ts              INTEGER NOT NULL,
  consumed_publication_id INTEGER,
  consumed_ts             INTEGER,
  created_ts              INTEGER NOT NULL,
  CHECK ((consumed_publication_id IS NULL) = (consumed_ts IS NULL)),
  FOREIGN KEY (design_task_id, revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE CASCADE,
  FOREIGN KEY (consumed_publication_id, design_task_id, revision, graph_digest, actor_key)
    REFERENCES design_publications(id, design_task_id, revision, graph_digest, actor_key)
    ON DELETE CASCADE
);
CREATE INDEX idx_design_publish_confirmations_expiry
  ON design_publish_confirmations(expires_ts, consumed_ts);
CREATE INDEX idx_design_publish_confirmations_task_revision
  ON design_publish_confirmations(design_task_id, revision, graph_digest);

CREATE TABLE design_issue_links (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id           INTEGER NOT NULL,
  design_task_id           INTEGER NOT NULL,
  project_id               INTEGER NOT NULL,
  node_id                  TEXT NOT NULL CHECK (length(node_id) BETWEEN 1 AND 256),
  issue_id                 INTEGER NOT NULL UNIQUE,
  link_kind                TEXT NOT NULL DEFAULT 'primary' CHECK (link_kind IN ('primary', 'supplement')),
  source_revision          INTEGER NOT NULL CHECK (source_revision > 0),
  last_synced_revision     INTEGER NOT NULL CHECK (last_synced_revision > 0),
  original_impl_mode       TEXT NOT NULL CHECK (original_impl_mode IN ('direct', 'team')),
  baseline_contract_json   TEXT NOT NULL CHECK (json_valid(baseline_contract_json)),
  baseline_contract_digest TEXT NOT NULL CHECK (
                             length(baseline_contract_digest) = 64
                             AND baseline_contract_digest NOT GLOB '*[^0-9a-f]*'
                           ),
  sync_state               TEXT NOT NULL DEFAULT 'current' CHECK (sync_state IN (
                             'current', 'auto_synced', 'confirmation_needed', 'conflict',
                             'supplement_needed', 'stale', 'cancelled', 'recovery_pending'
                           )),
  sync_error               TEXT CHECK (sync_error IS NULL OR length(sync_error) <= 4000),
  next_retry_ts            INTEGER,
  parent_issue_id          INTEGER,
  parent_issue_project_id  INTEGER,
  parent_link_id           INTEGER,
  parent_design_task_id    INTEGER,
  created_ts               INTEGER NOT NULL,
  updated_ts               INTEGER NOT NULL,
  UNIQUE (id, design_task_id),
  CHECK (last_synced_revision >= source_revision),
  CHECK (parent_issue_id IS NULL OR parent_issue_id <> issue_id),
  CHECK ((parent_issue_id IS NULL) = (parent_issue_project_id IS NULL)),
  CHECK (parent_issue_project_id IS NULL OR parent_issue_project_id = project_id),
  CHECK ((parent_link_id IS NULL) = (parent_design_task_id IS NULL)),
  CHECK (parent_design_task_id IS NULL OR parent_design_task_id = design_task_id),
  FOREIGN KEY (publication_id, design_task_id, project_id)
    REFERENCES design_publications(id, design_task_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id, project_id)
    REFERENCES issues(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (design_task_id, source_revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (design_task_id, last_synced_revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (parent_issue_id, parent_issue_project_id)
    REFERENCES issues(id, project_id) ON DELETE SET NULL,
  FOREIGN KEY (parent_link_id, parent_design_task_id)
    REFERENCES design_issue_links(id, design_task_id) ON DELETE SET NULL
);
CREATE INDEX idx_design_issue_links_task_node
  ON design_issue_links(design_task_id, node_id, source_revision DESC, id DESC);
CREATE INDEX idx_design_issue_links_sync
  ON design_issue_links(sync_state, next_retry_ts, updated_ts, id);
CREATE INDEX idx_design_issue_links_publication
  ON design_issue_links(publication_id, id);
CREATE UNIQUE INDEX idx_design_issue_links_primary_node
  ON design_issue_links(publication_id, node_id) WHERE link_kind = 'primary';
CREATE INDEX idx_design_issue_links_parent
  ON design_issue_links(parent_link_id);

CREATE TABLE design_publication_outbox (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES design_publications(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('module_index', 'scheduler')),
  target_key    TEXT NOT NULL CHECK (length(target_key) BETWEEN 1 AND 256),
  payload_json  TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_ts INTEGER NOT NULL,
  completed_ts  INTEGER,
  last_error    TEXT CHECK (last_error IS NULL OR length(last_error) <= 4000),
  created_ts    INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL,
  UNIQUE (publication_id, kind, target_key)
);
CREATE INDEX idx_design_publication_outbox_pending
  ON design_publication_outbox(completed_ts, next_retry_ts, id);

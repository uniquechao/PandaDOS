-- 039_issue_publication_batch: generic atomic publication/dependency/sync primitives.
-- This migration deliberately has no designs foreign key and adds no Issue status or gate kind.

-- Published graph nodes are immutable merge identities. The authoritative cross-domain linkage
-- remains owned by the caller and is inserted through the batch transaction callback.
ALTER TABLE issues ADD COLUMN publication_locked INTEGER NOT NULL DEFAULT 0
  CHECK (publication_locked IN (0, 1));

CREATE INDEX idx_issues_project_publication_locked
  ON issues(project_id, publication_locked, status);

-- Edge direction: depends_on_issue_id (prerequisite) -> issue_id (dependent).
CREATE TABLE issue_dependencies (
  issue_id            INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  depends_on_issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  created_ts          INTEGER NOT NULL,
  PRIMARY KEY (issue_id, depends_on_issue_id),
  CHECK (issue_id <> depends_on_issue_id)
);

CREATE INDEX idx_issue_dependencies_predecessor
  ON issue_dependencies(depends_on_issue_id, issue_id);

CREATE INDEX idx_issue_dependencies_dependent
  ON issue_dependencies(issue_id, depends_on_issue_id);

-- Orthogonal, generic execution synchronization. The existing gates table and Issue state machine
-- are intentionally untouched. deferred_action_json is opaque to storage and interpreted only by
-- the caller that registered the safe boundary.
CREATE TABLE issue_execution_syncs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id             INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  source_kind          TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 40),
  source_key           TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 240),
  source_revision      TEXT NOT NULL CHECK (length(source_revision) BETWEEN 1 AND 120),
  source_digest        TEXT NOT NULL CHECK (length(source_digest) BETWEEN 1 AND 200),
  diff_json            TEXT NOT NULL,
  state                TEXT NOT NULL CHECK (state IN (
                         'requested', 'boundary_waiting', 'applied', 'ignored', 'supplemented', 'stale'
                       )),
  boundary_kind        TEXT,
  deferred_action_json TEXT,
  requested_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  requested_ts         INTEGER NOT NULL,
  acknowledged_ts      INTEGER,
  decided_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_ts           INTEGER,
  resume_state         TEXT NOT NULL DEFAULT 'idle' CHECK (resume_state IN (
                         'idle', 'pending', 'running', 'complete'
                       )),
  -- Stable across explicit abandoned-claim recovery. Deferred handlers use this as their
  -- idempotency/CAS key; running claims never expire automatically.
  resume_key           TEXT UNIQUE,
  resume_token         TEXT,
  resume_claimed_ts    INTEGER,
  resumed_ts           INTEGER,
  UNIQUE (id, resume_key),
  UNIQUE (issue_id, source_kind, source_key, source_revision)
);

CREATE INDEX idx_issue_execution_syncs_actionable
  ON issue_execution_syncs(issue_id, state, requested_ts, id);

CREATE INDEX idx_issue_execution_syncs_resume
  ON issue_execution_syncs(resume_state, id);

-- The durable receipt is the exactly-once boundary for database effects. The effect and this
-- receipt are inserted in the same SQLite transaction; recovery returns the recorded result.
CREATE TABLE issue_execution_sync_effect_receipts (
  resume_key   TEXT PRIMARY KEY,
  sync_id      INTEGER NOT NULL UNIQUE,
  result_json  TEXT NOT NULL CHECK (json_valid(result_json) AND json_type(result_json) = 'object'),
  completed_ts INTEGER NOT NULL,
  FOREIGN KEY (sync_id, resume_key)
    REFERENCES issue_execution_syncs(id, resume_key) ON DELETE CASCADE
);

-- Resume callbacks cannot perform async I/O. They atomically enqueue stable external intents here;
-- a later idempotent delivery worker owns the external side effect.
CREATE TABLE issue_execution_sync_effect_outbox (
  resume_key   TEXT NOT NULL,
  sync_id      INTEGER NOT NULL,
  intent_key   TEXT NOT NULL CHECK (length(intent_key) BETWEEN 1 AND 120),
  kind         TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_ts   INTEGER NOT NULL,
  delivered_ts INTEGER,
  last_error   TEXT CHECK (last_error IS NULL OR length(last_error) <= 4000),
  PRIMARY KEY (resume_key, intent_key),
  FOREIGN KEY (sync_id, resume_key)
    REFERENCES issue_execution_syncs(id, resume_key) ON DELETE CASCADE
);

CREATE INDEX idx_issue_execution_sync_effect_outbox_pending
  ON issue_execution_sync_effect_outbox(delivered_ts, created_ts, sync_id);

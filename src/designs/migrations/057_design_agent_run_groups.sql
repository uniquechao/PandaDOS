CREATE TABLE design_agent_run_groups (
  id                 TEXT PRIMARY KEY,
  design_task_id     INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key    TEXT NOT NULL,
  request_digest     TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('goal', 'solution', 'review', 'graph')),
  source_revision    INTEGER NOT NULL,
  message            TEXT,
  persona_keys_json  TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
  )),
  cancel_requested   INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  failure_code       TEXT,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_ts         INTEGER NOT NULL,
  started_ts         INTEGER,
  finished_ts        INTEGER,
  updated_ts         INTEGER NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (design_task_id, id)
);

CREATE INDEX idx_design_agent_run_groups_recovery
  ON design_agent_run_groups(status, updated_ts, id);

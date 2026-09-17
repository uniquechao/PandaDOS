-- 022_project_data_outbox: durable DB-to-.panda projection work queue.

CREATE TABLE project_data_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_kind     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('upsert', 'archive')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_ts INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_ts      INTEGER NOT NULL,
  updated_ts      INTEGER NOT NULL,
  UNIQUE(project_id, entity_kind, entity_id)
);
CREATE INDEX idx_project_data_outbox_due
  ON project_data_outbox(next_attempt_ts, id);

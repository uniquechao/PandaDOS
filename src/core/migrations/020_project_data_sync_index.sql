-- 020_project_data_sync_index: local cache/index for file-authoritative .panda data.

CREATE TABLE project_data_sync_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  entity_kind   TEXT NOT NULL,
  sync_uid      TEXT,
  path          TEXT NOT NULL,
  fingerprint   TEXT,
  schema_version INTEGER,
  state         TEXT NOT NULL CHECK (state IN ('active', 'archived', 'error')),
  error         TEXT,
  updated_ts    INTEGER NOT NULL,
  UNIQUE(project_id, path)
);
CREATE UNIQUE INDEX idx_project_data_sync_identity
  ON project_data_sync_entries(project_id, entity_kind, sync_uid)
  WHERE sync_uid IS NOT NULL;
CREATE INDEX idx_project_data_sync_state
  ON project_data_sync_entries(project_id, state, entity_kind);

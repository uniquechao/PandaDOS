-- 023_project_data_sync_status: latest per-project pull summary for API/UI visibility.

CREATE TABLE project_data_sync_status (
  project_id       INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  state            TEXT NOT NULL CHECK (state IN ('syncing', 'success', 'warning', 'error')),
  last_attempt_ts  INTEGER NOT NULL,
  last_success_ts  INTEGER,
  detected_updates INTEGER NOT NULL DEFAULT 0,
  imported_count   INTEGER NOT NULL DEFAULT 0,
  archived_count   INTEGER NOT NULL DEFAULT 0,
  unchanged_count  INTEGER NOT NULL DEFAULT 0,
  conflict_count   INTEGER NOT NULL DEFAULT 0,
  parse_error_count INTEGER NOT NULL DEFAULT 0,
  details_json     TEXT NOT NULL DEFAULT '[]'
);

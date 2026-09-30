-- A terminal prompt can be sent but its DB acknowledgement lost on crash.
-- Persist the intent before sending and never auto-repeat an uncertain send.
CREATE TABLE issue_effect_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  executor_id INTEGER NOT NULL REFERENCES executors(id),
  target TEXT NOT NULL,
  input_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'confirmed', 'uncertain')),
  error TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  UNIQUE(issue_id, operation_key)
);
CREATE INDEX idx_issue_effect_journal_status ON issue_effect_journal(status, updated_ts);

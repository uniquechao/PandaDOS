-- 059_design_run_conversations: one server-owned conversation per execution run/module.

CREATE TABLE design_run_conversations (
  run_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  module_id INTEGER,
  module_key TEXT NOT NULL CHECK (
    (substr(module_key, 1, 7) = 'module:'
     AND length(substr(module_key, 8)) BETWEEN 1 AND 16
     AND substr(module_key, 8) NOT GLOB '*[^0-9]*'
     AND CAST(substr(module_key, 8) AS INTEGER) > 0)
    OR module_key IN ('unassigned:claude', 'unassigned:codex')
  ),
  conversation_id TEXT NOT NULL UNIQUE,
  seed_revision INTEGER NOT NULL CHECK (seed_revision > 0),
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^0-9a-f]*'),
  context_path TEXT,
  handoff_summary TEXT CHECK (handoff_summary IS NULL OR length(handoff_summary) <= 65536),
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, module_key),
  FOREIGN KEY (run_id) REFERENCES design_execution_runs(id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id) REFERENCES project_modules(id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE RESTRICT
);

CREATE INDEX idx_design_run_conversations_project
  ON design_run_conversations(project_id, run_id, module_key);

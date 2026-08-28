-- 060_design_run_conversation_scope: every execution conversation binding stays in one project.
-- The table copy is intentionally strict: a database containing a cross-project historical row
-- fails this migration transaction instead of normalizing an ambiguous security boundary.

CREATE UNIQUE INDEX idx_design_execution_runs_id_project
  ON design_execution_runs(id, project_id);
CREATE UNIQUE INDEX idx_project_modules_id_project
  ON project_modules(id, project_id);
CREATE UNIQUE INDEX idx_conversations_id_project
  ON conversations(id, project_id);

ALTER TABLE design_run_conversations RENAME TO design_run_conversations_scope_legacy;

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
  ) CHECK (
    (module_id IS NULL AND module_key LIKE 'unassigned:%')
    OR (module_id IS NOT NULL AND module_key = 'module:' || module_id)
  ),
  conversation_id TEXT NOT NULL UNIQUE,
  seed_revision INTEGER NOT NULL CHECK (seed_revision > 0),
  seed_digest TEXT NOT NULL CHECK (length(seed_digest) = 64 AND seed_digest NOT GLOB '*[^0-9a-f]*'),
  context_path TEXT,
  handoff_summary TEXT CHECK (handoff_summary IS NULL OR length(handoff_summary) <= 65536),
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY (run_id, module_key),
  FOREIGN KEY (run_id, project_id)
    REFERENCES design_execution_runs(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  FOREIGN KEY (module_id, project_id)
    REFERENCES project_modules(id, project_id) ON DELETE RESTRICT,
  FOREIGN KEY (conversation_id, project_id)
    REFERENCES conversations(id, project_id) ON DELETE RESTRICT
);

INSERT INTO design_run_conversations
  (run_id, project_id, module_id, module_key, conversation_id, seed_revision,
   seed_digest, context_path, handoff_summary, created_ts, updated_ts)
SELECT run_id, project_id, module_id, module_key, conversation_id, seed_revision,
       seed_digest, context_path, handoff_summary, created_ts, updated_ts
FROM design_run_conversations_scope_legacy;

DROP TABLE design_run_conversations_scope_legacy;

CREATE INDEX idx_design_run_conversations_project
  ON design_run_conversations(project_id, run_id, module_key);

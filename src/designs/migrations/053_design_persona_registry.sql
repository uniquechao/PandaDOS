ALTER TABLE design_persona_sources
  ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'project'
  CHECK (source_kind IN ('builtin', 'market', 'project'));

ALTER TABLE design_persona_sources ADD COLUMN git_commit TEXT;
ALTER TABLE design_persona_sources ADD COLUMN manifest_json TEXT;

ALTER TABLE design_project_personas
  ADD COLUMN approved_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE design_project_personas ADD COLUMN approved_ts INTEGER;

CREATE INDEX idx_design_persona_sources_kind
  ON design_persona_sources(source_kind, source_key);

CREATE TABLE design_run_intents (
  design_task_id      INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  run_id              TEXT NOT NULL,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  operation_group_id  TEXT NOT NULL,
  persona_key         TEXT NOT NULL,
  persona_content_hash TEXT NOT NULL,
  persona_origin      TEXT NOT NULL CHECK (persona_origin IN ('builtin', 'market', 'project')),
  persona_git_commit  TEXT,
  persona_role        TEXT NOT NULL CHECK (persona_role IN (
    'goal_coach', 'design_steward', 'reviewer', 'issue_planner', 'independent_verifier'
  )),
  resolved_agent      TEXT NOT NULL CHECK (resolved_agent IN ('claude', 'codex')),
  source_revision     INTEGER NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('launching', 'ingested', 'failed', 'interrupted')),
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  PRIMARY KEY (design_task_id, run_id)
);
CREATE INDEX idx_design_run_intents_state ON design_run_intents(state, updated_ts);

CREATE TABLE design_persona_market_snapshots (
  market_name TEXT PRIMARY KEY REFERENCES skill_markets(name) ON DELETE CASCADE,
  repo        TEXT NOT NULL,
  subdir      TEXT NOT NULL,
  git_commit  TEXT NOT NULL,
  source_epoch INTEGER NOT NULL,
  synced_ts   INTEGER NOT NULL
);

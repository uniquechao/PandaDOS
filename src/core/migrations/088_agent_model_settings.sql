CREATE TABLE agent_model_settings (
  target_kind TEXT NOT NULL CHECK(target_kind IN ('issue','conversation')),
  target_id TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
  model TEXT NOT NULL,
  effort TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','applying','applied','failed')),
  actual_model TEXT,
  actual_effort TEXT,
  error TEXT,
  updated_ts INTEGER NOT NULL,
  PRIMARY KEY(target_kind,target_id)
);
CREATE INDEX agent_model_settings_pending ON agent_model_settings(state,updated_ts);

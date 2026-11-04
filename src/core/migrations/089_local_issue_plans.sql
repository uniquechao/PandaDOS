-- Local plans are drafts until an authenticated batch publication commits.
CREATE TABLE local_issue_plan_publications (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  title TEXT NOT NULL,
  source_path TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (project_id, plan_id)
);

CREATE TABLE local_issue_plan_items (
  project_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  issue_id TEXT NOT NULL UNIQUE REFERENCES issues(id) ON DELETE RESTRICT,
  PRIMARY KEY (project_id, plan_id, node_key),
  FOREIGN KEY (project_id, plan_id) REFERENCES local_issue_plan_publications(project_id, plan_id) ON DELETE CASCADE
);

CREATE TABLE local_issue_plan_effects (
  project_id INTEGER NOT NULL,
  plan_id TEXT NOT NULL,
  effect_key TEXT NOT NULL,
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json)),
  completed_ts INTEGER,
  last_error TEXT,
  PRIMARY KEY (project_id, plan_id, effect_key),
  FOREIGN KEY (project_id, plan_id) REFERENCES local_issue_plan_publications(project_id, plan_id) ON DELETE CASCADE
);

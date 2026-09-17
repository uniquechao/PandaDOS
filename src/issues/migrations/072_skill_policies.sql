CREATE TABLE skill_policies (
 project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 module_id INTEGER NOT NULL DEFAULT 0,
 issue_id INTEGER NOT NULL DEFAULT 0,
 policy_json TEXT NOT NULL,
 PRIMARY KEY(project_id,module_id,issue_id),
 CHECK(module_id=0 OR issue_id=0)
);
CREATE TABLE skill_session_policies (
 conv_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 snapshot_json TEXT NOT NULL
);

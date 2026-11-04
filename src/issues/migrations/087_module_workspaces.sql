-- Stable module identity; occupancy never expires merely because a lease timed out.
ALTER TABLE projects ADD COLUMN module_concurrency INTEGER NOT NULL DEFAULT 2 CHECK(module_concurrency BETWEEN 1 AND 32);
ALTER TABLE projects ADD COLUMN integration_branch TEXT;
ALTER TABLE issues ADD COLUMN workspace_mode TEXT NOT NULL DEFAULT 'module' CHECK(workspace_mode IN ('legacy','module'));
UPDATE issues SET workspace_mode = 'legacy' WHERE status <> 'pending' OR conv_id IS NOT NULL;
CREATE TABLE module_workspaces (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 project_id INTEGER NOT NULL REFERENCES projects(id),
 module_key INTEGER NOT NULL,
 executor_id INTEGER NOT NULL,
 cwd TEXT NOT NULL,
 branch TEXT NOT NULL,
 kind TEXT NOT NULL DEFAULT 'module-worktree',
 current_attempt TEXT,
 lifecycle TEXT NOT NULL DEFAULT 'reserved',
 diagnostic TEXT,
 created_ts INTEGER NOT NULL,
 updated_ts INTEGER NOT NULL,
 UNIQUE(project_id,module_key), UNIQUE(executor_id,cwd)
);
CREATE TABLE workspace_attempts (
 id TEXT PRIMARY KEY,
 workspace_id INTEGER NOT NULL REFERENCES module_workspaces(id),
 issue_id TEXT NOT NULL REFERENCES issues(id),
 conversation_id TEXT UNIQUE,
 agent TEXT NOT NULL,
 execution_executor_id INTEGER,
 execution_cwd TEXT,
 execution_branch TEXT,
 execution_kind TEXT,
 execution_run_id TEXT,
 phase TEXT NOT NULL DEFAULT 'reserved',
 executor_start_ts INTEGER,
 launch_generation INTEGER NOT NULL DEFAULT 0,
 launch_state TEXT NOT NULL DEFAULT 'none',
 base_sha TEXT,
 result_sha TEXT,
 integrated_sha TEXT,
 stop_confirmed INTEGER NOT NULL DEFAULT 0,
 compute_held INTEGER NOT NULL DEFAULT 1,
 released_ts INTEGER,
 diagnostic TEXT,
 created_ts INTEGER NOT NULL,
 updated_ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_single_owner ON workspace_attempts(workspace_id) WHERE released_ts IS NULL;
CREATE UNIQUE INDEX physical_workspace_single_owner ON workspace_attempts(execution_executor_id,execution_cwd) WHERE released_ts IS NULL;
CREATE UNIQUE INDEX issue_single_workspace ON workspace_attempts(issue_id) WHERE released_ts IS NULL;
CREATE TABLE workspace_integrations (
 id TEXT PRIMARY KEY,
 attempt_id TEXT NOT NULL REFERENCES workspace_attempts(id),
 target_sha TEXT NOT NULL,
 result_sha TEXT NOT NULL,
 cwd TEXT NOT NULL,
 candidate_sha TEXT,
 phase TEXT NOT NULL DEFAULT 'reserved',
 diagnostic TEXT,
 created_ts INTEGER NOT NULL,
 updated_ts INTEGER NOT NULL,
 UNIQUE(attempt_id,target_sha,result_sha)
);
CREATE TABLE workspace_operations (
 resource TEXT PRIMARY KEY,
 token TEXT NOT NULL,
 operation TEXT NOT NULL,
 owner_pid INTEGER NOT NULL,
 created_ts INTEGER NOT NULL
);
CREATE TABLE workspace_runtime_resources (
 attempt_id TEXT NOT NULL REFERENCES workspace_attempts(id),
 node_run_id INTEGER NOT NULL DEFAULT 0,
 executor_id INTEGER NOT NULL,
 port INTEGER NOT NULL,
 PRIMARY KEY(attempt_id,node_run_id), UNIQUE(executor_id,port)
);

-- Reclamation is an owned operation, never an expiring lease or a model-generated rm.
ALTER TABLE module_workspaces ADD COLUMN environment_state TEXT NOT NULL DEFAULT 'warm'
 CHECK(environment_state IN ('warm','cooling','cold'));
ALTER TABLE module_workspaces ADD COLUMN environment_generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE workspace_reclamation_jobs (
 id TEXT PRIMARY KEY,
 resource_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL CHECK(kind IN ('candidate','environment')),
 project_id INTEGER NOT NULL REFERENCES projects(id),
 workspace_id INTEGER NOT NULL REFERENCES module_workspaces(id),
 attempt_id TEXT NOT NULL REFERENCES workspace_attempts(id),
 integration_id TEXT REFERENCES workspace_integrations(id),
 executor_id INTEGER NOT NULL,
 cwd TEXT NOT NULL,
 generation INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','checking','archiving','archived','deleting','reclaimed','retained','failed','uncertain')),
 reason TEXT,
 details TEXT,
 token TEXT,
 owner_pid INTEGER,
 archive_path TEXT,
 archive_sha256 TEXT,
 archive_bytes INTEGER NOT NULL DEFAULT 0,
 archive_pinned INTEGER NOT NULL DEFAULT 0 CHECK(archive_pinned IN (0,1)),
 archive_purged_ts INTEGER,
 archive_prune_state TEXT NOT NULL DEFAULT 'none' CHECK(archive_prune_state IN ('none','dispatching','uncertain','purged')),
 archive_prune_reason TEXT,
 receipt_json TEXT,
 retry_count INTEGER NOT NULL DEFAULT 0,
 next_check_ts INTEGER NOT NULL DEFAULT 0,
 created_ts INTEGER NOT NULL,
 updated_ts INTEGER NOT NULL
);
CREATE INDEX workspace_reclamation_pending ON workspace_reclamation_jobs(state,next_check_ts);
CREATE INDEX workspace_reclamation_project ON workspace_reclamation_jobs(project_id,created_ts);
CREATE TABLE workspace_capacity (
 executor_id INTEGER PRIMARY KEY REFERENCES executors(id),
 available_bytes INTEGER,
 total_bytes INTEGER,
 cache_bytes INTEGER NOT NULL DEFAULT 0,
 archive_bytes INTEGER NOT NULL DEFAULT 0,
 checked_ts INTEGER NOT NULL,
 reason TEXT
);

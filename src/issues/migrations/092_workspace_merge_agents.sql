-- Each repair is tied to one immutable candidate and one model conversation.
CREATE TABLE workspace_merge_agents (
 id TEXT PRIMARY KEY,
 integration_id TEXT NOT NULL REFERENCES workspace_integrations(id),
 attempt_id TEXT NOT NULL REFERENCES workspace_attempts(id),
 project_id INTEGER NOT NULL REFERENCES projects(id),
 conversation_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('starting','dispatching','running','stopping','uncertain','resolved','clarification','failed','superseded','retry')),
 reason TEXT NOT NULL,
 remaining INTEGER NOT NULL,
 started_ts INTEGER NOT NULL,
 executor_start_ts INTEGER,
 launch_started INTEGER NOT NULL DEFAULT 0,
 stop_confirmed INTEGER NOT NULL DEFAULT 0,
 question TEXT,
 answer TEXT,
 diagnostic TEXT,
 updated_ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_merge_agent_single_active ON workspace_merge_agents(project_id)
 WHERE state IN ('starting','dispatching','running','stopping','uncertain');
CREATE INDEX workspace_merge_agent_candidate ON workspace_merge_agents(integration_id,started_ts);

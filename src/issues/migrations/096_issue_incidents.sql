CREATE TABLE issue_incidents (
 id TEXT PRIMARY KEY,
 issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 project_id INTEGER NOT NULL REFERENCES projects(id),
 stop_event_id INTEGER NOT NULL,
 attempt_id TEXT,
 state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','queued','resumed','stale')),
 run_state TEXT NOT NULL DEFAULT 'idle' CHECK(run_state IN ('idle','queued','running','failed','interrupted')),
 locale TEXT NOT NULL,
 error TEXT,
 evidence TEXT NOT NULL DEFAULT '',
 created_by INTEGER REFERENCES users(id),
 created_ts INTEGER NOT NULL,
 UNIQUE(issue_id,stop_event_id)
);
CREATE INDEX issue_incidents_hold ON issue_incidents(issue_id,state);
CREATE TABLE issue_incident_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 incident_id TEXT NOT NULL REFERENCES issue_incidents(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('user','assistant')),
 content TEXT NOT NULL,
 request_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','running','done','failed','interrupted')),
 actor INTEGER REFERENCES users(id),
 created_ts INTEGER NOT NULL,
 UNIQUE(incident_id,request_key,role)
);
CREATE TABLE issue_incident_receipts (
 incident_id TEXT NOT NULL REFERENCES issue_incidents(id) ON DELETE CASCADE,
 request_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 payload TEXT NOT NULL,
 result TEXT NOT NULL,
 PRIMARY KEY(incident_id,request_key)
);

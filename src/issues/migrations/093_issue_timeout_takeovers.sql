-- A durable takeover is bound to the exact pause, never inferred from free-text errors.
CREATE TABLE issue_timeout_takeovers (
 id TEXT PRIMARY KEY,
 issue_id TEXT NOT NULL REFERENCES issues(id),
 attempt_id TEXT NOT NULL REFERENCES workspace_attempts(id),
 pause_event_id INTEGER NOT NULL UNIQUE REFERENCES issue_events(id),
 source_conversation_id TEXT,
 recovery_conversation_id TEXT UNIQUE,
 reason TEXT NOT NULL,
 resume_state TEXT NOT NULL,
 phase TEXT NOT NULL DEFAULT 'claimed' CHECK(phase IN ('claimed','prepared','resumed','failed')),
 context_path TEXT NOT NULL,
 diagnostic TEXT,
 created_ts INTEGER NOT NULL,
 updated_ts INTEGER NOT NULL
);
CREATE UNIQUE INDEX issue_timeout_single_takeover ON issue_timeout_takeovers(issue_id)
 WHERE phase IN ('claimed','prepared');
CREATE INDEX issue_timeout_takeover_issue ON issue_timeout_takeovers(issue_id,created_ts);

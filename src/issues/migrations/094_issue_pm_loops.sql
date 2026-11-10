-- One durable supervision case per issue; external actions are never replayed from an unknown receipt.
CREATE TABLE issue_pm_loops (
 issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL,
 progress_key TEXT NOT NULL,
 last_progress_ts INTEGER NOT NULL,
 next_check_ts INTEGER NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('watching','deciding','ready','applying','waiting','uncertain','stopped')),
 observation_json TEXT NOT NULL,
 decision_json TEXT,
 operation_id TEXT,
 no_progress_rounds INTEGER NOT NULL DEFAULT 0,
 interventions INTEGER NOT NULL DEFAULT 0,
 errors INTEGER NOT NULL DEFAULT 0,
 deferrals INTEGER NOT NULL DEFAULT 0,
 updated_ts INTEGER NOT NULL
);

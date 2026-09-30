CREATE TABLE room_issue_feedback (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  source_event_id INTEGER NOT NULL REFERENCES issue_events(id),
  kind TEXT NOT NULL CHECK(kind IN ('started','clarification_needed','clarification_answered','blocked','paused','done','cancelled')),
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(room_id,issue_id,source_event_id),
  FOREIGN KEY(project_id,room_id) REFERENCES rooms(project_id,id)
);
CREATE TABLE room_issue_feedback_cursors (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  source_event_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(room_id,issue_id),
  FOREIGN KEY(project_id,room_id) REFERENCES rooms(project_id,id)
);

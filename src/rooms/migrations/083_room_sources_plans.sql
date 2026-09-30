-- Only explicitly authorized, immutable text enters source grants. No URL/path access.
ALTER TABLE room_members ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE room_members ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE room_assignments ADD COLUMN task_key TEXT;
ALTER TABLE room_assignments ADD COLUMN independent INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX room_assignment_task ON room_assignments(round_id,task_key) WHERE task_key IS NOT NULL;
ALTER TABLE room_contributions ADD COLUMN evidence_json TEXT;
ALTER TABLE room_artifact_revisions ADD COLUMN author_user_id INTEGER REFERENCES users(id);
ALTER TABLE room_artifact_revisions ADD COLUMN evidence_json TEXT;
CREATE TABLE room_sources (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  digest TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked')),
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL,
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id),
  FOREIGN KEY(mission_id,goal_revision) REFERENCES room_goal_revisions(mission_id,revision)
);
CREATE INDEX room_source_scope ON room_sources(room_id,mission_id,goal_revision,status);
CREATE TRIGGER room_source_content_immutable BEFORE UPDATE OF id,project_id,room_id,mission_id,goal_revision,version,title,content,digest,audience_json,actor_user_id,created_ts ON room_sources
BEGIN SELECT RAISE(ABORT,'room_source_content_immutable'); END;
CREATE TRIGGER room_source_retained BEFORE DELETE ON room_sources
BEGIN SELECT RAISE(ABORT,'room_source_retained'); END;
CREATE TABLE room_tool_calls (
  attempt_id TEXT NOT NULL REFERENCES room_attempts(id),
  call_id TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  name TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(attempt_id,call_id)
);

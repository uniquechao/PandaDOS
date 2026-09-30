-- Rooms use their own execution and publication records. Never store model transcripts here.
CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  event_seq INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  UNIQUE(project_id,id)
);
CREATE INDEX rooms_project ON rooms(project_id,updated_ts);

CREATE TABLE room_members (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  role_key TEXT NOT NULL CHECK(role_key IN ('coach','planner','writer','reviewer')),
  display_name TEXT NOT NULL,
  model_profile_ref TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  fence_counter INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  UNIQUE(project_id,room_id,id),
  UNIQUE(room_id,role_key),
  FOREIGN KEY(project_id,room_id) REFERENCES rooms(project_id,id)
);
CREATE TRIGGER room_member_scope_immutable BEFORE UPDATE OF id,project_id,room_id ON room_members
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.room_id<>OLD.room_id
BEGIN SELECT RAISE(ABORT,'room_member_scope_immutable'); END;
CREATE TRIGGER room_member_identity_retained BEFORE DELETE ON room_members
BEGIN SELECT RAISE(ABORT,'room_member_identity_retained'); END;

CREATE TABLE room_runtime_bindings (
  runtime_key TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  FOREIGN KEY(project_id,room_id,member_id) REFERENCES room_members(project_id,room_id,id)
);
CREATE TRIGGER room_runtime_scope_immutable BEFORE UPDATE ON room_runtime_bindings
WHEN NEW.runtime_key<>OLD.runtime_key OR NEW.member_id<>OLD.member_id OR NEW.project_id<>OLD.project_id OR NEW.room_id<>OLD.room_id
BEGIN SELECT RAISE(ABORT,'room_runtime_scope_immutable'); END;
CREATE TRIGGER room_runtime_binding_retained BEFORE DELETE ON room_runtime_bindings
BEGIN SELECT RAISE(ABORT,'room_runtime_binding_retained'); END;

CREATE TABLE room_missions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('draft','queued','running','quiescing','waiting_user','paused','exhausted','interrupted','completed','stopped')),
  phase TEXT NOT NULL DEFAULT 'aligning',
  version INTEGER NOT NULL DEFAULT 1,
  control_epoch INTEGER NOT NULL DEFAULT 1,
  current_goal_revision INTEGER NOT NULL DEFAULT 1,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  locale TEXT NOT NULL,
  template_key TEXT NOT NULL DEFAULT 'product' CHECK(template_key IN ('product','writing')),
  budget_json TEXT NOT NULL,
  active_since INTEGER,
  active_ms INTEGER NOT NULL DEFAULT 0,
  round INTEGER NOT NULL DEFAULT 0,
  next_role TEXT NOT NULL DEFAULT 'coach',
  target_state TEXT,
  pending_goal_json TEXT,
  reason_code TEXT,
  question_json TEXT,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  UNIQUE(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id) REFERENCES rooms(project_id,id)
);
CREATE UNIQUE INDEX room_one_open_mission ON room_missions(room_id) WHERE state NOT IN ('completed','stopped');
CREATE TABLE room_goal_revisions (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal_json TEXT NOT NULL,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(mission_id,revision),
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id)
);
CREATE TRIGGER room_goal_revision_immutable BEFORE UPDATE ON room_goal_revisions
BEGIN SELECT RAISE(ABORT,'room_goal_revision_immutable'); END;

CREATE TABLE room_rounds (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  goal_revision INTEGER NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running',
  created_ts INTEGER NOT NULL,
  UNIQUE(mission_id,ordinal),
  UNIQUE(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id)
);
CREATE TABLE room_assignments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  round_id TEXT,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  condition_json TEXT,
  artifact_id TEXT,
  artifact_revision INTEGER,
  retry_limit INTEGER NOT NULL DEFAULT 1,
  failure_code TEXT,
  input_contribution_id TEXT,
  audience_json TEXT NOT NULL DEFAULT '{"kind":"room"}',
  created_ts INTEGER NOT NULL,
  UNIQUE(project_id,room_id,mission_id,id),
  UNIQUE(project_id,room_id,mission_id,id,member_id),
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id,member_id) REFERENCES room_members(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id,mission_id,round_id) REFERENCES room_rounds(project_id,room_id,mission_id,id)
);
CREATE TABLE room_assignment_dependencies (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  depends_on_id TEXT NOT NULL,
  CHECK(assignment_id<>depends_on_id),
  PRIMARY KEY(assignment_id,depends_on_id),
  FOREIGN KEY(project_id,room_id,mission_id,assignment_id) REFERENCES room_assignments(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id,depends_on_id) REFERENCES room_assignments(project_id,room_id,mission_id,id)
);
CREATE TABLE room_attempts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','running','succeeded','failed','cancelled','uncertain')),
  epoch INTEGER NOT NULL,
  fence INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_until INTEGER NOT NULL,
  deadline_ts INTEGER NOT NULL,
  execution_id TEXT NOT NULL UNIQUE,
  result_digest TEXT,
  failure_code TEXT,
  model_requests INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  updated_ts INTEGER NOT NULL,
  UNIQUE(assignment_id,number),
  UNIQUE(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id,assignment_id,member_id) REFERENCES room_assignments(project_id,room_id,mission_id,id,member_id)
);
CREATE UNIQUE INDEX room_one_active_attempt ON room_attempts(assignment_id) WHERE state IN ('reserved','running','uncertain');
CREATE UNIQUE INDEX room_one_active_member_attempt ON room_attempts(member_id) WHERE state IN ('reserved','running','uncertain');

CREATE TABLE room_contributions (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK(author_type IN ('user','member','system')),
  author_id TEXT NOT NULL,
  assignment_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  audience_json TEXT NOT NULL,
  reply_to TEXT,
  artifact_id TEXT,
  artifact_revision INTEGER,
  seq INTEGER NOT NULL,
  goal_revision INTEGER NOT NULL,
  created_ts INTEGER NOT NULL,
  UNIQUE(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id,mission_id,assignment_id) REFERENCES room_assignments(project_id,room_id,mission_id,id)
);
CREATE INDEX room_contribution_scope ON room_contributions(room_id,mission_id,created_ts);
CREATE TABLE room_artifacts (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  owner_member_id TEXT NOT NULL,
  title TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0,
  adopted_revision INTEGER,
  created_ts INTEGER NOT NULL,
  UNIQUE(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id) REFERENCES room_missions(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id,owner_member_id) REFERENCES room_members(project_id,room_id,id)
);
CREATE TABLE room_artifact_revisions (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  goal_revision INTEGER NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  digest TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  source_attempt_id TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(artifact_id,revision),
  FOREIGN KEY(project_id,room_id,mission_id,artifact_id) REFERENCES room_artifacts(project_id,room_id,mission_id,id),
  FOREIGN KEY(project_id,room_id,mission_id,source_attempt_id) REFERENCES room_attempts(project_id,room_id,mission_id,id)
);
CREATE TRIGGER room_artifact_revision_immutable BEFORE UPDATE ON room_artifact_revisions
BEGIN SELECT RAISE(ABORT,'room_artifact_revision_immutable'); END;
CREATE TABLE room_assessments (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  criterion_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL,
  verifier_id TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('passed','failed')),
  evidence TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  FOREIGN KEY(project_id,room_id,mission_id,artifact_id) REFERENCES room_artifacts(project_id,room_id,mission_id,id),
  FOREIGN KEY(artifact_id,artifact_revision) REFERENCES room_artifact_revisions(artifact_id,revision),
  FOREIGN KEY(project_id,room_id,verifier_id) REFERENCES room_members(project_id,room_id,id)
);
CREATE TABLE room_budget_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL REFERENCES room_missions(id),
  dimension TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount>0),
  operation_key TEXT NOT NULL,
  op TEXT NOT NULL CHECK(op IN ('reserve','consume','release','grant')),
  created_ts INTEGER NOT NULL,
  UNIQUE(mission_id,dimension,operation_key,op)
);
CREATE TRIGGER room_budget_entry_immutable BEFORE UPDATE ON room_budget_entries
BEGIN SELECT RAISE(ABORT,'room_budget_entry_immutable'); END;
CREATE TRIGGER room_budget_entry_retained BEFORE DELETE ON room_budget_entries
BEGIN SELECT RAISE(ABORT,'room_budget_entry_retained'); END;
CREATE TABLE room_events (
  room_id TEXT NOT NULL REFERENCES rooms(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_id TEXT,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(room_id,seq)
);
CREATE TABLE room_commands (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(project_id,actor_user_id,operation,idempotency_key)
);
CREATE TABLE room_issue_links (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_revision INTEGER NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  title TEXT NOT NULL,
  publication_key TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  created_ts INTEGER NOT NULL,
  UNIQUE(project_id,publication_key),
  FOREIGN KEY(project_id,room_id,mission_id,artifact_id) REFERENCES room_artifacts(project_id,room_id,mission_id,id),
  FOREIGN KEY(artifact_id,artifact_revision) REFERENCES room_artifact_revisions(artifact_id,revision)
);
CREATE TABLE room_issue_publications (
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  mission_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_version INTEGER NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY(project_id,actor_user_id,idempotency_key),
  FOREIGN KEY(project_id,room_id,mission_id,artifact_id) REFERENCES room_artifacts(project_id,room_id,mission_id,id),
  FOREIGN KEY(artifact_id,artifact_version) REFERENCES room_artifact_revisions(artifact_id,revision)
);

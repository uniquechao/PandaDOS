-- Keep all member identities, runtime bindings, assignments and authored history.
-- Defer existing inbound references while replacing the inline role uniqueness.
-- Reinsert AFTER the replacement has its final name so SQLite settles FK counters.
PRAGMA defer_foreign_keys=ON;
CREATE TEMP TABLE room_members_roster_backup AS SELECT * FROM room_members;
CREATE TABLE room_members_roster_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  room_id TEXT NOT NULL,
  role_key TEXT NOT NULL CHECK(role_key IN ('coach','planner','writer','reviewer')),
  display_name TEXT NOT NULL,
  model_profile_ref TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','retired')),
  fence_counter INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  instructions TEXT NOT NULL DEFAULT '',
  UNIQUE(project_id,room_id,id),
  FOREIGN KEY(project_id,room_id) REFERENCES rooms(project_id,id)
);
DROP TABLE room_members;
ALTER TABLE room_members_roster_new RENAME TO room_members;
INSERT INTO room_members(id,project_id,room_id,role_key,display_name,model_profile_ref,status,fence_counter,created_ts,version,instructions)
SELECT id,project_id,room_id,role_key,display_name,model_profile_ref,status,fence_counter,created_ts,version,instructions FROM room_members_roster_backup;
DROP TABLE room_members_roster_backup;
CREATE UNIQUE INDEX room_one_active_coach ON room_members(room_id) WHERE status='active' AND role_key='coach';
CREATE INDEX room_member_active_roles ON room_members(room_id,status,role_key);
CREATE TRIGGER room_member_scope_immutable BEFORE UPDATE OF id,project_id,room_id ON room_members
WHEN NEW.id<>OLD.id OR NEW.project_id<>OLD.project_id OR NEW.room_id<>OLD.room_id
BEGIN SELECT RAISE(ABORT,'room_member_scope_immutable'); END;
CREATE TRIGGER room_member_identity_retained BEFORE DELETE ON room_members
BEGIN SELECT RAISE(ABORT,'room_member_identity_retained'); END;
CREATE TRIGGER room_member_retirement_permanent BEFORE UPDATE OF status ON room_members
WHEN OLD.status='retired' AND NEW.status<>'retired'
BEGIN SELECT RAISE(ABORT,'room_member_retirement_permanent'); END;
CREATE TRIGGER room_member_active_limit_insert BEFORE INSERT ON room_members
WHEN NEW.status='active' AND (SELECT COUNT(*) FROM room_members WHERE room_id=NEW.room_id AND status='active')>=12
BEGIN SELECT RAISE(ABORT,'room_member_active_limit'); END;
CREATE TRIGGER room_member_active_limit_update BEFORE UPDATE OF status ON room_members
WHEN OLD.status<>'active' AND NEW.status='active' AND (SELECT COUNT(*) FROM room_members WHERE room_id=NEW.room_id AND status='active')>=12
BEGIN SELECT RAISE(ABORT,'room_member_active_limit'); END;

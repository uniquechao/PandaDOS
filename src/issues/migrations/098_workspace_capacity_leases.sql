ALTER TABLE workspace_capacity ADD COLUMN available_inodes INTEGER;
ALTER TABLE workspace_capacity ADD COLUMN admission_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE workspace_capacity_leases (
 token TEXT NOT NULL,
 executor_id INTEGER NOT NULL,
 filesystem_id TEXT NOT NULL,
 project_id INTEGER NOT NULL,
 cwd TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('start','candidate','dependencies','validation')),
 reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0),
 reserved_inodes INTEGER NOT NULL CHECK(reserved_inodes>=0),
 owner_pid INTEGER NOT NULL,
 uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
 created_ts INTEGER NOT NULL,
 PRIMARY KEY (token,filesystem_id)
);
CREATE INDEX workspace_capacity_leases_volume ON workspace_capacity_leases(executor_id,filesystem_id);
CREATE INDEX workspace_capacity_leases_writer ON workspace_capacity_leases(executor_id,cwd);

-- 061_project_data_identity: stable identity for Git-shareable design records.

ALTER TABLE design_tasks ADD COLUMN sync_uid TEXT;
CREATE UNIQUE INDEX idx_design_tasks_sync_uid
  ON design_tasks(sync_uid) WHERE sync_uid IS NOT NULL;

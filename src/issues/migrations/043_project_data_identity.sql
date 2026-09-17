-- 043_project_data_identity: stable identities for Git-shareable issue-domain records.

ALTER TABLE project_modules ADD COLUMN sync_uid TEXT;
CREATE UNIQUE INDEX idx_project_modules_sync_uid
  ON project_modules(sync_uid) WHERE sync_uid IS NOT NULL;

ALTER TABLE issues ADD COLUMN sync_uid TEXT;
CREATE UNIQUE INDEX idx_issues_sync_uid ON issues(sync_uid) WHERE sync_uid IS NOT NULL;

ALTER TABLE project_workflow_templates ADD COLUMN sync_uid TEXT;
CREATE UNIQUE INDEX idx_project_workflow_templates_sync_uid
  ON project_workflow_templates(sync_uid) WHERE sync_uid IS NOT NULL;

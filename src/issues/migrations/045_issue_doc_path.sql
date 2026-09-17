-- Preserve the source Markdown path for Issues imported from project data.
ALTER TABLE issues ADD COLUMN doc_path TEXT;

-- Existing sync entries already know the original path. Backfill it so the
-- first database-to-file write after upgrade does not create an ID-derived
-- duplicate document.
UPDATE issues
SET doc_path = (
  SELECT entry.path
  FROM project_data_sync_entries AS entry
  WHERE entry.project_id = issues.project_id
    AND entry.entity_kind = 'issue'
    AND entry.sync_uid = issues.sync_uid
    AND entry.state = 'active'
  ORDER BY entry.updated_ts DESC, entry.id DESC
  LIMIT 1
)
WHERE issues.sync_uid IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM project_data_sync_entries AS entry
    WHERE entry.project_id = issues.project_id
      AND entry.entity_kind = 'issue'
      AND entry.sync_uid = issues.sync_uid
      AND entry.state = 'active'
  );

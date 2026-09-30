ALTER TABLE projects ADD COLUMN execution_isolation TEXT NOT NULL DEFAULT 'shared'
  CHECK (execution_isolation IN ('shared', 'dedicated-ssh'));

-- A running or historical project cannot switch OS identity under its issues
-- and conversations. A dedicated project is provisioned with this mode at birth.
CREATE TRIGGER project_isolation_mode_immutable_after_use
BEFORE UPDATE OF execution_isolation ON projects
WHEN NEW.execution_isolation IS NOT OLD.execution_isolation
 AND (EXISTS (SELECT 1 FROM issues WHERE project_id = OLD.id)
      OR EXISTS (SELECT 1 FROM conversations WHERE project_id = OLD.id))
BEGIN
  SELECT RAISE(ABORT, 'project execution isolation cannot change after use');
END;

-- A project ID is bound to one executor location. Moving an existing project
-- requires a dedicated migration that reconciles conversations, issues and files.
CREATE TRIGGER projects_executor_identity_immutable
BEFORE UPDATE OF executor_id ON projects
WHEN NEW.executor_id IS NOT OLD.executor_id
BEGIN
  SELECT RAISE(ABORT, 'project executor identity is immutable');
END;

-- Credentials and capability flags may rotate, but an executor with projects
-- cannot silently become another machine, SSH user or workspace root.
CREATE TRIGGER executors_referenced_location_immutable
BEFORE UPDATE OF host, port, ssh_user, workspace_root ON executors
WHEN EXISTS (SELECT 1 FROM projects WHERE executor_id = OLD.id)
  AND (
    NEW.host IS NOT OLD.host OR
    NEW.port IS NOT OLD.port OR
    NEW.ssh_user IS NOT OLD.ssh_user OR
    NEW.workspace_root IS NOT OLD.workspace_root
  )
BEGIN
  SELECT RAISE(ABORT, 'referenced executor location is immutable');
END;

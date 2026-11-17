ALTER TABLE projects ADD COLUMN merge_agent TEXT
  CHECK (merge_agent IN ('claude', 'codex'));

ALTER TABLE workspace_merge_agents ADD COLUMN agent TEXT
  CHECK (agent IN ('claude', 'codex'));

UPDATE workspace_merge_agents
SET agent = (SELECT agent FROM conversations WHERE id = workspace_merge_agents.conversation_id)
WHERE agent IS NULL;

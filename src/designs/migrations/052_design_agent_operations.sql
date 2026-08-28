-- 052_design_agent_operations: durable idempotency for recoverable persona ingestion.

CREATE TABLE design_agent_operations (
  design_task_id INTEGER NOT NULL REFERENCES design_tasks(id) ON DELETE CASCADE,
  operation_id   TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 256),
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('review', 'steward_revision')),
  request_json   TEXT NOT NULL,
  event_id       INTEGER NOT NULL REFERENCES design_events(id) ON DELETE RESTRICT,
  revision_id    INTEGER REFERENCES design_revisions(id) ON DELETE RESTRICT,
  created_ts     INTEGER NOT NULL,
  PRIMARY KEY (design_task_id, operation_id)
);
CREATE UNIQUE INDEX idx_design_agent_operations_event ON design_agent_operations(event_id);
CREATE UNIQUE INDEX idx_design_agent_operations_revision
  ON design_agent_operations(revision_id) WHERE revision_id IS NOT NULL;

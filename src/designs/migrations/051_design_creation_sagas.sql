-- 051_design_creation_sagas: compatible with both original and intermediate saga-bearing 050.

CREATE TABLE IF NOT EXISTS design_creation_sagas (
  saga_token          TEXT PRIMARY KEY,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idempotency_key     TEXT NOT NULL,
  request_json        TEXT NOT NULL,
  conversation_id     TEXT NOT NULL,
  task_id             INTEGER REFERENCES design_tasks(id) ON DELETE SET NULL,
  phase               TEXT NOT NULL CHECK (phase IN (
                        'intent', 'task_created', 'conversation_created', 'bound',
                        'activating', 'activated', 'completed', 'recoverable_error')),
  conversation_owned  INTEGER NOT NULL DEFAULT 0 CHECK (conversation_owned IN (0, 1)),
  error               TEXT,
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (conversation_id)
);
CREATE INDEX IF NOT EXISTS idx_design_creation_sagas_incomplete
  ON design_creation_sagas(phase, updated_ts, saga_token)
  WHERE phase <> 'completed';

CREATE TABLE IF NOT EXISTS design_saga_conversation_owners (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  saga_token      TEXT NOT NULL UNIQUE REFERENCES design_creation_sagas(saga_token) ON DELETE CASCADE,
  created_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_saga_conversation_owners_saga
  ON design_saga_conversation_owners(saga_token);

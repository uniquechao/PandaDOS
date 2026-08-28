-- 041_execution_sync_delivery_claims: fail-closed claims for non-transactional external effects.

ALTER TABLE issue_execution_sync_effect_outbox
  ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (delivery_state IN ('pending', 'dispatching', 'delivered', 'uncertain'));
ALTER TABLE issue_execution_sync_effect_outbox ADD COLUMN delivery_token TEXT;
ALTER TABLE issue_execution_sync_effect_outbox ADD COLUMN dispatch_started_ts INTEGER;

UPDATE issue_execution_sync_effect_outbox
SET delivery_state = 'delivered'
WHERE delivered_ts IS NOT NULL;

CREATE INDEX idx_issue_execution_sync_effect_delivery
  ON issue_execution_sync_effect_outbox(delivery_state, created_ts, sync_id);

CREATE TABLE issue_execution_sync_effect_steps (
  resume_key   TEXT NOT NULL,
  intent_key   TEXT NOT NULL,
  step_key     TEXT NOT NULL CHECK (length(step_key) BETWEEN 1 AND 80),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  completed_ts INTEGER NOT NULL,
  PRIMARY KEY (resume_key, intent_key, step_key),
  FOREIGN KEY (resume_key, intent_key)
    REFERENCES issue_execution_sync_effect_outbox(resume_key, intent_key) ON DELETE CASCADE
);

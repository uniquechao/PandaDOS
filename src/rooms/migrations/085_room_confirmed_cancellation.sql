-- API requests can detach after fencing. External executors must prove they stopped.
ALTER TABLE room_attempts ADD COLUMN cancel_mode TEXT NOT NULL DEFAULT 'detach' CHECK(cancel_mode IN ('detach','confirm'));
CREATE INDEX room_attempts_pending_stop ON room_attempts(cancel_mode,state) WHERE cancel_mode='confirm' AND state IN ('reserved','running','uncertain');

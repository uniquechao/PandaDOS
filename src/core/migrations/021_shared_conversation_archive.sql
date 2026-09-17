-- 021_shared_conversation_archive: portable, read-only chat history and upload metadata state.

ALTER TABLE conversations ADD COLUMN shared_read_only INTEGER NOT NULL DEFAULT 0
  CHECK (shared_read_only IN (0, 1));

ALTER TABLE project_attachments ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'archived'));

CREATE TABLE conversation_shared_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL CHECK (sequence >= 0),
  role            TEXT NOT NULL CHECK (role IN ('assistant', 'thinking', 'tool_use', 'tool_result', 'user')),
  text            TEXT,
  images_json     TEXT,
  created_ts      INTEGER,
  PRIMARY KEY(conversation_id, sequence)
);
CREATE INDEX idx_conversation_shared_messages_created
  ON conversation_shared_messages(conversation_id, created_ts, sequence);

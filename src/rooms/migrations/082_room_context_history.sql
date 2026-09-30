-- Formal clarification payloads remain readable after their live waiting state ends.
ALTER TABLE room_contributions ADD COLUMN question_json TEXT;
ALTER TABLE room_contributions ADD COLUMN answers_question_id TEXT;
CREATE UNIQUE INDEX room_question_identity ON room_contributions(json_extract(question_json,'$.id'))
  WHERE question_json IS NOT NULL;
CREATE INDEX room_question_answers ON room_contributions(room_id,mission_id,answers_question_id)
  WHERE answers_question_id IS NOT NULL;

-- Recover still-open legacy questions. Already answered payloads were never stored
-- by 081 and cannot truthfully be reconstructed from a summary or model guess.
UPDATE room_contributions
SET question_json=(SELECT m.question_json FROM room_missions m WHERE m.id=room_contributions.mission_id)
WHERE id IN (
  SELECT (SELECT c.id FROM room_contributions c WHERE c.mission_id=m.id AND c.kind='question' ORDER BY c.seq DESC LIMIT 1)
  FROM room_missions m WHERE m.question_json IS NOT NULL
);

-- Idempotency keeps a receipt, not an expanding duplicate of all room history.
UPDATE room_commands
SET response_json=json_object('receiptVersion',1,'roomId',json_extract(response_json,'$.room.id'))
WHERE json_valid(response_json) AND json_type(response_json,'$.room.id')='text';

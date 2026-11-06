ALTER TABLE conversations ADD COLUMN first_message_title TEXT;
-- 保留自动模式下已获取的临时摘要；手动名称不能当成首条消息摘要。
UPDATE conversations SET first_message_title = label
WHERE kind = 'chat' AND manual_title IS NULL AND agent_title IS NULL
  AND label IS NOT NULL AND trim(label) != '' AND label NOT IN ('新对话', '会话');

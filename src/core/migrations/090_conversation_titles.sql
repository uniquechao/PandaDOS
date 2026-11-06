ALTER TABLE conversations ADD COLUMN agent_title TEXT;
ALTER TABLE conversations ADD COLUMN manual_title TEXT;
-- 旧名称无法可靠区分来源，保守保留已有自定义名称；可显式恢复自动命名。
UPDATE conversations SET manual_title = label
WHERE kind = 'chat' AND label IS NOT NULL AND trim(label) != ''
  AND label NOT IN ('新对话', '会话');

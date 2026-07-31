-- 038_issue_auto_approve: issue 级「自动批准」档位（issue #108）。
--   issues.auto_approve  同 014 的三档语义（cautious / medium / auto）。
--   默认 'medium' = 现有审批管道行为（安全可逆自动批、危险不可逆转人工），故存量 issue
--   取默认即维持现状；与对话那份互不影响（对话侧见 core 014）。
ALTER TABLE issues ADD COLUMN auto_approve TEXT NOT NULL DEFAULT 'medium'
  CHECK (auto_approve IN ('cautious', 'medium', 'auto'));

-- 014_conversation_auto_approve: 对话级「自动批准」档位（issue #108）。
--   conversations.auto_approve  弹窗自动批复的放行程度，三档：
--     'cautious'（默认）= 只自动点信任目录/CLI 自带「(推荐)」这类零风险项，其余等人工；
--                         存量对话取默认即维持现状（对话侧本来就没有自动批准，全靠人点）；
--     'medium'   = 分级判定：安全可逆自动批，危险不可逆转人工；
--     'auto'     = 危险不可逆仍转人工，其余直接选同意项、不问 LLM。
--   档位按「对话」与「issue」各存一份、互不影响（issue 侧见 038）——对话上的开关只管这条
--   对话，issue 上的开关只管这条 issue，改一处不牵连另一处。
ALTER TABLE conversations ADD COLUMN auto_approve TEXT NOT NULL DEFAULT 'cautious'
  CHECK (auto_approve IN ('cautious', 'medium', 'auto'));

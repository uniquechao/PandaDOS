-- 032_issue_pin: 任务置顶（调度优先级）
-- issues.pinned_ts：置顶时刻（ms epoch）；NULL = 未置顶。
--   调度挑选（queue.pickNext）时，置顶的 pending 排在所有非置顶之前，压过模块聚合/FIFO/preferModule；
--   多个置顶之间按置顶时刻晚→早（后置顶的排最前——重复置顶即「再顶到队首」）。
--   仅影响 pending 排队顺序，不改变忙判定/状态机。存量行默认 NULL（未置顶），向后兼容。
ALTER TABLE issues ADD COLUMN pinned_ts INTEGER;

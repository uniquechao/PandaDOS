-- 008_project_manual_review: 项目「手动确认」开关（默认关闭 = 全自动流）。
--   manual_review = 0（默认）：计划出来不建卡点直接开工；测试通过不建 merge_review 卡点，
--                   引擎自动 commit/push 后直接 done（记 auto_approved 事件可审计）。
--   manual_review = 1：保留老流程——plan_review / merge_review 卡点等人批准。

ALTER TABLE projects ADD COLUMN manual_review INTEGER NOT NULL DEFAULT 0;

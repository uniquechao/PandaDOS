-- 006_project_work_branch: 项目工作分支（覆盖「每 issue 切 issue/<id> 分支」的默认行为）。
--   work_branch  非空 = 本项目所有 issue 都在这条既有共享分支上干活：
--                  不新建 issue/<id> 分支、合并阶段不并回 base（base 由人工管理）；
--                  NULL/'' = 保持默认（每 issue 建 issue/<id> 分支 + review 通过后 --no-ff 并回 base）。

ALTER TABLE projects ADD COLUMN work_branch TEXT;

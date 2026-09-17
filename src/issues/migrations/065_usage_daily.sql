-- 065：用量按天分桶（#295 / 承接 #282）。
--
-- 编号取当前全局最大（064）+1：**迁移编号是全局账本（schema_migrations），只按编号去重**，
-- 撞号的那一条会被当成「已应用」永远不执行（notify 060 被 designs 060 顶掉的坑见 #292）。
--
-- 为什么要这张表：#282 的 `conversation_usage` / `issue_usage` 都只有累计值，没有任何时间维度，
-- 所以 `/api/admin/usage` 的时间窗只能筛 issue 档（`windowAppliesTo: 'issues'`）。
-- 要做周度趋势就必须先有按天分桶的事实表——本表就是那张事实表。
--
-- 口径三条（改这里之前先读完）：
-- 1. **day 是北京时间日键**（`YYYY-MM-DD`，Asia/Shanghai，见 core/daily-greeting.localDay）。
--    发起人拍板：按北京时间算一天、周一起算一周。存字符串而不是 epoch，是因为「哪一天」本身
--    就是个带时区的展示概念，存成毫秒之后每个读取方都得再折算一次，迟早折算不一致。
-- 2. **按 issue 存、不按模块存**：`issue_id` 是这一天这笔用量归属的 issue，模块在读取侧
--    join `issues.module_id` 得到。issue 之后被挪到别的模块时，历史分桶会自动跟着改归属——
--    要是把 module_id 冻结在这里，改归属之后历史就永远是错的，而且没人会记得来修。
-- 3. **`issue_id = 0` = 未归因**（chat 会话、模块空档期、agent 收尾输出）：这块余量必须看得见，
--    不许悄悄摊到某条 issue 上（与 #282 的 unattributed 同一条纪律）。
--    正因为有 0 这个哨兵值，`issue_id` **不能**加外键；issue 被删后残留的分桶行读取侧按
--    「未归模块」显示。project_id 仍走外键 CASCADE，项目删了整块跟着走。
--
-- 本表同样是**派生数据**（真值是执行机上的 jsonl / rollout 原文），删了可以回扫重算；
-- 因此 `UsageStore.resetScan` 必须连它一起清——它是累加写入的，只清游标不清它，
-- 重扫会把同一段用量再加一遍（「重跑一次数字就翻倍」是这类表最难查的坑）。
CREATE TABLE usage_daily (
  -- 北京时间日键 'YYYY-MM-DD'
  day                 TEXT NOT NULL,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 归属 issue；0 = 未归因（无外键，见文件头第 3 条）
  issue_id            INTEGER NOT NULL DEFAULT 0,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  compactions         INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  skill_reads         INTEGER NOT NULL DEFAULT 0,
  updated_ts          INTEGER NOT NULL,
  PRIMARY KEY (day, project_id, issue_id)
);

-- 周度视图按 day 区间扫全表（不限项目），单独给 day 一条索引
CREATE INDEX idx_usage_daily_day ON usage_daily(day);

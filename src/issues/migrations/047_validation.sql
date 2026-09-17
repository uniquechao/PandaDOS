-- 047：门禁执行从 Agent 会话里搬出去（#279 / I-03）。
--
-- 只加两列，不动 CHECK、不重建表：issues / projects 都挂着大量外键与索引，
-- 整表重建会顺带清空子表（034 之后已有一次教训）。
--
-- issues.validation_scope_json：本条 issue 这一轮门禁的执行范围（定向/全量 + 测试文件清单 +
--   推导依据），由引擎在进入 testing 时算出并落库，供 UI 展示与复跑。NULL = 还没算过。
-- projects.validation_commands_json：项目级门禁命令（`[{label, argv[]}]`）。
--   NULL = 未配置，由控制面按 package.json 的 scripts 探测默认命令——**不是**「不跑门禁」。
ALTER TABLE issues ADD COLUMN validation_scope_json TEXT;
ALTER TABLE projects ADD COLUMN validation_commands_json TEXT;

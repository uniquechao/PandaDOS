-- 007_project_understanding: Agent（claude/codex）对项目历史会话+代码库的「认知总结」及其后台任务态。
--   与 005 的 readme_summary（DeepSeek 读 README 的 ≤200 字短简介）互补：本组字段存的是
--   由用户选定的 CLI 代理跑出来的长文认知，异步生成，故额外带任务状态/错误。
--   understanding      Agent 生成的项目认知/总结长文（给用户看；NULL = 尚未生成）
--   understanding_agent 生成该认知的 CLI 代理（'claude' / 'codex'；NULL = 尚未生成）
--   understanding_ts   上次成功生成的时间戳（毫秒；NULL = 尚未生成）
--   summary_status     Agent 总结后台任务态：idle（默认/从未跑）/ running / done / error
--   summary_error      任务失败原因（status='error' 时有值；否则 NULL）

ALTER TABLE projects ADD COLUMN understanding TEXT;
ALTER TABLE projects ADD COLUMN understanding_agent TEXT;
ALTER TABLE projects ADD COLUMN understanding_ts INTEGER;
ALTER TABLE projects ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE projects ADD COLUMN summary_error TEXT;

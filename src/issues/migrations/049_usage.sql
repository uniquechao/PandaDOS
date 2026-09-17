-- 049：成本观测埋点的落库（#282 / I-08、I-09）。
--
-- 只建表、不改任何既有表。两张表都是**派生数据**：真值永远是执行机上的 jsonl / rollout 原文，
-- 这里存的是扫描结果，删了可以重扫（所以外键一律 CASCADE，跟着源实体走）。
--
-- conversation_usage：按 conversation 累计 + `scanned_bytes` 增量游标。
--   游标是「已扫到文件的第几个字节」，重启后从这里续扫，同一段内容绝不重复计数。
-- issue_usage：把 conversation 的用量按 segment 边界归因到具体 issue 之后的累计。
--   归不进任何 segment 的（chat 会话、模块空档期）不写这张表，在读取侧算「非 Issue 会话」。
--
-- 计数列的口径见 src/core/usage.ts 的文件头注释——**离线对齐校验按那里核对**。
CREATE TABLE conversation_usage (
  conv_id             TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- 'issue'（issue/模块会话）| 'chat'（项目对话）：读取侧据此单列「非 Issue 会话」
  kind                TEXT NOT NULL DEFAULT 'issue',
  -- 增量游标：已扫描到的字节位置（文件被换掉/截断时读取侧会重置回 0 重扫）
  scanned_bytes       INTEGER NOT NULL DEFAULT 0,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  compactions         INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  skill_reads         INTEGER NOT NULL DEFAULT 0,
  updated_ts          INTEGER NOT NULL
);

CREATE INDEX idx_conversation_usage_project ON conversation_usage(project_id, kind);

CREATE TABLE issue_usage (
  issue_id            INTEGER PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  requests            INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  compactions         INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  skill_reads         INTEGER NOT NULL DEFAULT 0,
  updated_ts          INTEGER NOT NULL
);

CREATE INDEX idx_issue_usage_project ON issue_usage(project_id);

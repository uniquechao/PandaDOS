-- 015_executor_capabilities: 执行机声明 Claude/Codex 能力，系统本机唯一。

ALTER TABLE executors ADD COLUMN is_system_local INTEGER NOT NULL DEFAULT 0
  CHECK (is_system_local IN (0, 1));
ALTER TABLE executors ADD COLUMN supports_claude INTEGER NOT NULL DEFAULT 1
  CHECK (supports_claude IN (0, 1));
ALTER TABLE executors ADD COLUMN supports_codex INTEGER NOT NULL DEFAULT 1
  CHECK (supports_codex IN (0, 1));
ALTER TABLE executors ADD COLUMN codex_dir TEXT NOT NULL DEFAULT '';
ALTER TABLE executors ADD COLUMN capabilities_checked_ts INTEGER;

CREATE UNIQUE INDEX idx_executors_one_system_local
  ON executors(is_system_local) WHERE is_system_local = 1;

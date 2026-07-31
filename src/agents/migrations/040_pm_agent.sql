-- 040_pm_agent: PM 管家模块补表（严禁改 001/030，本迁移只做增量）。
-- 位置说明：放在 agents/migrations/（模块自带），编号沿用全局 schema_migrations 空间（040）；
-- 由 pm.ts 的 migratePmAgent(db) 在核心迁移（migrate）与引擎迁移（migrateIssueEngine）之后执行，幂等。

-- LLM provider 配置（单行 id=1；环境变量可覆盖——读取顺序见 agents/llm.ts loadLlmConfig）
CREATE TABLE llm_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  base_url       TEXT,
  model          TEXT,
  api_key        TEXT,
  temperature    REAL,
  timeout_ms     INTEGER,
  retries        INTEGER,
  max_concurrent INTEGER,
  updated_ts     INTEGER NOT NULL
);

-- 每项目进度滚动摘要（v1 runningSummary 内存 Map → DB，评审 H4：重启不丢）
CREATE TABLE pm_progress (
  project_id      INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  running_summary TEXT NOT NULL DEFAULT '',
  updated_ts      INTEGER NOT NULL
);

-- 034_project_modules: 项目共享模块实体 + issue 稳定 module_id。
-- legacy issues.module 暂留兼容；新调度逐步切到 module_id。

CREATE TABLE project_modules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  agent            TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  source           TEXT NOT NULL CHECK (source IN ('auto', 'manual', 'legacy')),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  conversation_id  TEXT UNIQUE REFERENCES conversations(id) ON DELETE SET NULL,
  sync_status      TEXT NOT NULL DEFAULT 'ready' CHECK (sync_status IN ('ready', 'error')),
  sync_error       TEXT,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ts       INTEGER NOT NULL,
  last_used_ts     INTEGER,
  UNIQUE(project_id, slug)
);

CREATE INDEX idx_project_modules_project_status
  ON project_modules(project_id, status);

ALTER TABLE issues ADD COLUMN module_id INTEGER REFERENCES project_modules(id) ON DELETE RESTRICT;

CREATE INDEX idx_issues_module_status ON issues(module_id, status);

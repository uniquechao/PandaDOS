-- 017_external_issue_import: 每项目绑定一个外部 issue 来源，并记录远端 issue 的导入/忽略结果。
--
-- project_external_issue_sources 以 project_id 为主键，数据库层保证一个项目只能绑定一个
-- Git remote。remote_url / instance_url 是保存配置时的规范化快照；api_token 只供后端调用远端
-- API，任何面向前端的读取都必须使用脱敏摘要，不能直接序列化本表行。
--
-- external_issue_records 是过滤远端候选的耐久 tombstone。source_key 标识具体实例与仓库，
-- 因此项目以后改绑别的仓库时，相同的远端 issue id 不会被旧记录误过滤。

CREATE TABLE project_external_issue_sources (
  project_id       INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  remote_name      TEXT NOT NULL,
  remote_url       TEXT NOT NULL,
  instance_url     TEXT NOT NULL,
  api_token        TEXT,
  token_updated_ts INTEGER,
  created_ts       INTEGER NOT NULL,
  updated_ts       INTEGER NOT NULL,
  CHECK (length(remote_name) > 0),
  CHECK (length(remote_url) > 0),
  CHECK (length(instance_url) > 0),
  CHECK (api_token IS NOT NULL OR token_updated_ts IS NULL)
);

CREATE TABLE external_issue_records (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github', 'gitlab')),
  source_key       TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  external_number  TEXT NOT NULL,
  external_url     TEXT NOT NULL,
  disposition      TEXT NOT NULL CHECK (disposition IN ('imported', 'ignored')),
  local_issue_id   INTEGER REFERENCES issues(id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_ts       INTEGER NOT NULL,
  updated_ts       INTEGER NOT NULL,
  CHECK (length(source_key) > 0),
  CHECK (length(external_id) > 0),
  CHECK (length(external_number) > 0),
  CHECK (length(external_url) > 0),
  CHECK (disposition = 'imported' OR local_issue_id IS NULL),
  UNIQUE (project_id, provider, source_key, external_id)
);

CREATE INDEX idx_external_issue_records_lookup
  ON external_issue_records(project_id, provider, source_key, disposition);
CREATE INDEX idx_external_issue_records_local_issue
  ON external_issue_records(local_issue_id)
  WHERE local_issue_id IS NOT NULL;

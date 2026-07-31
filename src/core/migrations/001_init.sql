-- 001_init: v2 全量初始 schema（spec §4）
-- 时间戳统一 epoch 毫秒 INTEGER；布尔用 INTEGER 0/1；JSON 存 TEXT。

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL,                -- sha256(token)，不存明文
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  feishu_openid TEXT,
  created_ts    INTEGER NOT NULL,
  last_login_ts INTEGER
);

CREATE TABLE user_settings (
  user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  persona           TEXT,
  memory            TEXT,
  autopilot_default INTEGER NOT NULL DEFAULT 0,
  notify_pref       TEXT                       -- JSON：通知偏好
);

CREATE TABLE executors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  host           TEXT NOT NULL,
  port           INTEGER NOT NULL DEFAULT 22,
  ssh_user       TEXT NOT NULL,
  key_ref        TEXT NOT NULL,                -- ~/.butler2/keys/<key_ref>，私钥不进 DB
  workspace_root TEXT NOT NULL,
  claude_dir     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'offline'))
);

CREATE TABLE projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  executor_id   INTEGER NOT NULL REFERENCES executors(id),
  cwd           TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  pm_persona    TEXT,
  goal          TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_ts    INTEGER NOT NULL
);
CREATE INDEX idx_projects_owner ON projects(owner_user_id);
CREATE INDEX idx_projects_executor ON projects(executor_id);

CREATE TABLE conversations (
  id         TEXT PRIMARY KEY,                 -- = claude session-id
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label      TEXT,
  created_ts INTEGER NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_conversations_project ON conversations(project_id);

CREATE TABLE issues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  body          TEXT,
  category      TEXT NOT NULL DEFAULT 'task' CHECK (category IN ('task', 'design', 'debug')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'clarifying', 'planning', 'plan_review', 'implementing',
                  'testing', 'merge_review', 'merging', 'done', 'blocked', 'cancelled')),
  conv_id       TEXT REFERENCES conversations(id),
  plan_json     TEXT,
  subtasks_json TEXT,
  sub_index     INTEGER NOT NULL DEFAULT 0,
  branch        TEXT,
  note          TEXT,
  images_json   TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_ts    INTEGER NOT NULL,
  done_ts       INTEGER
);
CREATE INDEX idx_issues_project_status ON issues(project_id, status);
CREATE INDEX idx_issues_created ON issues(created_ts);

CREATE TABLE issue_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id  INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  data_json TEXT,
  ts        INTEGER NOT NULL
);
CREATE INDEX idx_issue_events_issue_ts ON issue_events(issue_id, ts);

CREATE TABLE gates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id     INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('plan', 'merge_review')),
  status       TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'approved', 'rejected')),
  payload_json TEXT,
  decided_by   INTEGER REFERENCES users(id),
  decided_ts   INTEGER
);
CREATE INDEX idx_gates_issue ON gates(issue_id);
CREATE INDEX idx_gates_status ON gates(status);

CREATE TABLE subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('project', 'issue')),
  target_id  INTEGER NOT NULL,
  created_ts INTEGER NOT NULL,
  UNIQUE (user_id, scope, target_id)
);
CREATE INDEX idx_subscriptions_target ON subscriptions(scope, target_id);

CREATE TABLE sessions (
  name          TEXT PRIMARY KEY,              -- tmux 会话名（取代 v1 ownership.json）
  executor_id   INTEGER NOT NULL REFERENCES executors(id),
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id)
);
CREATE INDEX idx_sessions_project ON sessions(project_id);
CREATE INDEX idx_sessions_owner ON sessions(owner_user_id);

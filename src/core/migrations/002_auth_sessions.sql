-- 002_auth_sessions: 登录会话表（飞书扫码登录用）。
-- users.token_hash 是长期 API token（明文只在生成瞬间出现一次），扫码登录拿不到明文，
-- 因此另发一次性会话 token 放 cookie——同样只存 sha256 哈希，带过期时间。
CREATE TABLE auth_sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,              -- sha256(session token)，不存明文
  via        TEXT NOT NULL DEFAULT 'feishu',    -- 会话来源（feishu 扫码等）
  created_ts INTEGER NOT NULL,
  expires_ts INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);

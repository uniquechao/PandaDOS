-- 飞书登录配置：空密钥/禁用是显式覆盖，不回退到部署环境。
CREATE TABLE feishu_login_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  allow_registration INTEGER NOT NULL CHECK (allow_registration IN (0, 1)),
  app_id TEXT NOT NULL,
  app_secret TEXT NOT NULL,
  public_url TEXT NOT NULL,
  revision TEXT NOT NULL
);

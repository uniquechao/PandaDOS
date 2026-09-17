-- 消息通道独立开关；复用飞书登录中保存的应用凭据。
CREATE TABLE feishu_messaging_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);

-- 010_daily_greeting: 项目页欢迎卡的「每日欢迎语」缓存（每用户按本地日期各一条）。
--   user_id     所属用户（删用户级联清理）。
--   day         本地日切的日期键 'YYYY-MM-DD'（Asia/Shanghai，避开 bun 按 UTC 解析的坑）。
--   text        DeepSeek 生成的当天欢迎语（≤约20字）。
--   created_ts  生成时刻（epoch 毫秒）。
-- 语义：GET /api/greeting 惰性生成——命中 (user_id, day) 即返回缓存，未命中调 DS 生成并落此表。
--   主键 (user_id, day) 天然去重，每人每天至多一条；旧日期行留存不清理（体量极小）。

CREATE TABLE daily_greeting (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_ts INTEGER NOT NULL,
  PRIMARY KEY (user_id, day)
);

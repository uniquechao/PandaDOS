-- 013_user_message_counts: 用户发出的对话消息计数（issue #102 用户管理统计）。
--   user_id  发消息的用户（删用户级联清理）。
--   day      本地日键 'YYYY-MM-DD'（Asia/Shanghai 日切，见 core/activity.localDay）。
--   count    该用户当天发出的消息条数。
-- 语义：消息正文只存在执行机的 agent jsonl 里，库里没有消息表——「今天/总消息数」靠本表
--   在各发送入口（WS chat 文本帧 / POST act / issue 澄清答复 / 飞书入站）注入成功后 +1 累计，
--   故计数从本迁移上线时刻起算，历史消息不回填（无可回填的用户归属信息）。
-- 按天分桶而不是单用户一个总数：既能答「今天多少条」，总数 = SUM(count)，也便于日后出趋势。

CREATE TABLE user_message_counts (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

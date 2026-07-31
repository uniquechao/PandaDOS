-- 060_notify_gate_requests: 通知模块增量（spec §8/§12：卡点确认卡一次性 requestId 防重放）。
-- 位置说明：放在 notify/migrations/（模块自带），编号沿用全局 schema_migrations 空间（060）；
-- 由 router.ts 的 migrateNotify(db) 在主迁移之后执行（同 030 模式，主目录快照不动）。
-- 落 DB 而非内存表：评审 H4（pendingApprovals 全内存 = 重启后所有待决卡作废）的教训——
-- 卡点是核心流程，重启后已发出的飞书卡必须仍可点。

CREATE TABLE notify_gate_requests (
  request_id  TEXT PRIMARY KEY,                              -- 一次性 id，进卡片按钮 value
  gate_id     INTEGER NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 发卡对象（点击者必须是本人）
  created_ts  INTEGER NOT NULL,
  consumed_ts INTEGER                                        -- 消费即失效（NULL→ts 的 CAS）
);
CREATE INDEX idx_notify_gate_requests_gate ON notify_gate_requests(gate_id);

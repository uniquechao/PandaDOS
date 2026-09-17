-- 063_notify_gate_requests: 通知模块增量（spec §8/§12：卡点确认卡一次性 requestId 防重放）。
-- 位置说明：放在 notify/migrations/（模块自带），编号沿用全局 schema_migrations 空间；
-- 由 router.ts 的 migrateNotify(db) 在主迁移之后执行（同 030 模式，主目录快照不动）。
-- 编号历史：本迁移原为 060，与历史 designs 060（现由 073 兼容替代）撞号。
-- schema_migrations 是全局单一账本、只按编号去重，而迁移链里 designs 先于 notify 执行，
-- 编号 60 被 designs 占掉后本迁移被判定为「已应用」而从未真正执行，notify_gate_requests
-- 表在生产库与测试库中双双缺失。改到未被占用的 063（designs 已占 050–061、issues 占 062），
-- 存量库因账本里没有 63 会在下次启动时补建。
-- 幂等写法：极少数早期库可能已建出本表（那种库反而是 designs 060 被顶掉），IF NOT EXISTS
-- 让本迁移在两种历史下都能安全落地。
-- 落 DB 而非内存表：评审 H4（pendingApprovals 全内存 = 重启后所有待决卡作废）的教训——
-- 卡点是核心流程，重启后已发出的飞书卡必须仍可点。

CREATE TABLE IF NOT EXISTS notify_gate_requests (
  request_id  TEXT PRIMARY KEY,                              -- 一次性 id，进卡片按钮 value
  gate_id     INTEGER NOT NULL REFERENCES gates(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 发卡对象（点击者必须是本人）
  created_ts  INTEGER NOT NULL,
  consumed_ts INTEGER                                        -- 消费即失效（NULL→ts 的 CAS）
);
CREATE INDEX IF NOT EXISTS idx_notify_gate_requests_gate ON notify_gate_requests(gate_id);

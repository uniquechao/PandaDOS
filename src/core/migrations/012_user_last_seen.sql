-- 012_user_last_seen: 用户「最后使用时间」（issue #99 成员页活跃度展示）。
-- last_login_ts 只在登录瞬间记一次；last_seen_ts 由认证解析链每次成功认证时 touch，
-- 写库在 UserStore.touchSeen 内节流（距上次写入 ≥5min 才落一笔）。NULL = 尚未活动过。
ALTER TABLE users ADD COLUMN last_seen_ts INTEGER;

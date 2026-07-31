-- 030_issue_engine: issue 引擎补列/补表（评审 5.2#10：v2 schema 需补 module/implMode 列）
-- 严禁改 001_init.sql，本迁移只做增量。
-- 位置说明：放在 issues/migrations/（模块自带），编号沿用全局 schema_migrations 空间（030）；
-- 由 engine.ts 的 migrateIssueEngine(db) 在主迁移之后执行（core/migrate.test 钉死了主目录
-- latest=1 / 表清单快照，其他模块文件不许动——集成接线见 engine.ts 注释）。

-- issues 补：module（队列同模块优先）+ impl_mode（seq 逐个喂 / team 一次性交付）
ALTER TABLE issues ADD COLUMN module TEXT NOT NULL DEFAULT '未分类';
ALTER TABLE issues ADD COLUMN impl_mode TEXT NOT NULL DEFAULT 'seq' CHECK (impl_mode IN ('seq', 'team'));

-- 项目当前激活对话（v1 current Map 仅内存 = 评审 H4；入库后重启不丢、activate 幂等有据可查）
CREATE TABLE project_active_conv (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  conv_id    TEXT NOT NULL REFERENCES conversations(id),
  updated_ts INTEGER NOT NULL
);

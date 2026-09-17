-- 069_sync_uid_project_scope: 把 module/issue 的 sync_uid 唯一性从「全局」收回「项目内」。
--
-- 043 建的是全局唯一索引（ON project_modules(sync_uid)，不带 project_id），但 .panda 导入侧
-- 所有查找都是项目内的（`WHERE project_id = ? AND sync_uid = ?`）——唯一性口径和查找口径不一致。
--
-- 后果是实打实的：模块 uid 在没有显式 sync_uid 时由 `legacySyncUid(createdTs, 'module:' + path)`
-- 生成，而 path 是项目内相对路径 `.panda/modules/<slug>/MODULE.md`——两个项目只要有同名模块，
-- 算出来的 uid 就一模一样。先同步的那个项目占住全局唯一位，后来的那个**永远**插不进去，
-- 报 `UNIQUE constraint failed: project_modules.sync_uid`；它下面的 issue 页跟着全部报
-- 「Issue 引用的模块不存在」。生产上 PandaDOS 项目的 feishu-integration / project-management
-- 两个模块就是这样被 omni-grid 的同名模块顶掉的，连带 12 条协作文件常年同步失败。
--
-- 两个项目各有一个「飞书」模块本来就是两个不同的东西，全局唯一是错的。收成项目内唯一是
-- **放宽**约束，现有数据必然满足（原来更严），不存在迁移失败或数据丢失。

DROP INDEX IF EXISTS idx_project_modules_sync_uid;
CREATE UNIQUE INDEX idx_project_modules_sync_uid
  ON project_modules(project_id, sync_uid) WHERE sync_uid IS NOT NULL;

DROP INDEX IF EXISTS idx_issues_sync_uid;
CREATE UNIQUE INDEX idx_issues_sync_uid
  ON issues(project_id, sync_uid) WHERE sync_uid IS NOT NULL;

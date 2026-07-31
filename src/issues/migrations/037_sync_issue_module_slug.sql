-- 037_sync_issue_module_slug: 把 issues.module 文本列收敛到所属模块的 slug。
--
-- 035 只回填了 issues.module_id，旧显示名留在 issues.module 里。而调度（queue.pickNext /
-- 智能合并）历史上按这个文本列认模块身份，于是生产上同时出现两种错：
--   · 同一模块被拆成两个桶（旧文本 + 新 slug），模块聚合被 FIFO 打散；
--   · 同名不同代理的两个模块共用一种文本，被并成一桶连着跑。
-- 引擎已改为按 module_id 认身份（queue.moduleKeyOf），这条迁移把冗余文本列一次性对齐，
-- 让文本列重新只是「给人看的 slug 副本」——与 createIssue / renameModuleSlug /
-- mergeModules / moveIssuesToModule 的写入口径一致。
--
-- 只动绑了模块的 issue；module_id 为空的（旧库兼容路径）原样保留。

UPDATE issues
SET module = (SELECT pm.slug FROM project_modules pm WHERE pm.id = issues.module_id)
WHERE module_id IS NOT NULL
  AND module <> (SELECT pm.slug FROM project_modules pm WHERE pm.id = issues.module_id);

-- 035_backfill_legacy_modules: 将旧 issues.module 文本收敛为正式模块实体。
-- 同名但 agent 不同必须拆开，因为正式模块的代理固定且不可混用。

WITH legacy AS (
  SELECT
    project_id,
    COALESCE(NULLIF(TRIM(module), ''), '未分类') AS display_name,
    CASE WHEN agent = 'codex' THEN 'codex' ELSE 'claude' END AS agent,
    -- 历史数据可能残留指向已删用户的 created_by，直插会撞外键；仅保留仍存在的用户
    MIN(CASE WHEN created_by IN (SELECT id FROM users) THEN created_by END) AS created_by,
    MIN(created_ts) AS created_ts
  FROM issues
  WHERE module_id IS NULL
  GROUP BY project_id, COALESCE(NULLIF(TRIM(module), ''), '未分类'),
           CASE WHEN agent = 'codex' THEN 'codex' ELSE 'claude' END
),
numbered AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY project_id
      ORDER BY display_name, agent
    ) AS n
  FROM legacy
)
INSERT INTO project_modules
  (project_id, slug, display_name, agent, source, created_by, created_ts)
SELECT
  project_id,
  'legacy-module-' || printf('%02d', n),
  display_name,
  agent,
  'legacy',
  created_by,
  created_ts
FROM numbered;

UPDATE issues
SET module_id = (
  SELECT pm.id
  FROM project_modules pm
  WHERE pm.project_id = issues.project_id
    AND pm.source = 'legacy'
    AND pm.display_name = COALESCE(NULLIF(TRIM(issues.module), ''), '未分类')
    AND pm.agent = CASE WHEN issues.agent = 'codex' THEN 'codex' ELSE 'claude' END
)
WHERE module_id IS NULL;

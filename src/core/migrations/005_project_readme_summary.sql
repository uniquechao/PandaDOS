-- 005_project_readme_summary: 项目 README 自动简介（core/readme-summary.ts）。
--   readme_md5        上次生成简介时 README 的 md5 指纹（没读到过 = NULL）
--   readme_summary    DeepSeek 生成的项目简介（≤200 字：名字/内容/定位）
--   readme_checked_ts 上次巡检时间（按天节流的锚点；0 = 从未检查，下轮即到期）

ALTER TABLE projects ADD COLUMN readme_md5 TEXT;
ALTER TABLE projects ADD COLUMN readme_summary TEXT;
ALTER TABLE projects ADD COLUMN readme_checked_ts INTEGER NOT NULL DEFAULT 0;

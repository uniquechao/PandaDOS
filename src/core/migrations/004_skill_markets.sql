-- 004_skill_markets: 技能市场（多市场源注册 + DeepSeek 富化缓存）
--
-- skill_markets: 一行 = 一个技能市场（git 仓库，内含若干「目录 + SKILL.md」技能）。
--   控制面浅克隆到 ~/.butler2/skill-markets/<name>，扫描出技能清单供浏览/安装。
--   admin 可增删；内置 4 个源（seed 见文末，claude/codex 通用的 agentskills 格式）。
-- skill_i18n: DeepSeek 富化缓存（中文描述/标签/推荐），键 = <market>/<rel>，
--   desc_hash = 源描述指纹（描述变了才重译，绝不重复烧 token —— v1 market-cache.json 平移进 DB）。

CREATE TABLE skill_markets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL UNIQUE,
  repo         TEXT NOT NULL,
  subdir       TEXT NOT NULL DEFAULT '',
  note         TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sync_ts INTEGER,
  last_error   TEXT,
  created_ts   INTEGER NOT NULL
);

CREATE TABLE skill_i18n (
  skill_key  TEXT PRIMARY KEY,
  desc_hash  TEXT NOT NULL,
  desc_zh    TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',
  recommend  INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  updated_ts INTEGER NOT NULL
);

INSERT INTO skill_markets (name, repo, subdir, note, enabled, created_ts) VALUES
  ('anthropics-skills', 'https://github.com/anthropics/skills.git', '', 'Anthropic 官方技能库（文档/设计/开发）', 1, strftime('%s','now') * 1000),
  ('superpowers', 'https://github.com/obra/superpowers.git', 'skills', 'Superpowers 工程工作流（TDD/调试/计划）', 1, strftime('%s','now') * 1000),
  ('claude-code-skills', 'https://github.com/daymade/claude-code-skills.git', '', '社区精选 Claude Code 技能集', 1, strftime('%s','now') * 1000),
  ('codex-skills', 'https://github.com/ComposioHQ/awesome-codex-skills.git', '', 'Codex 向技能大合集（880+ 与 Claude 通用）', 1, strftime('%s','now') * 1000);

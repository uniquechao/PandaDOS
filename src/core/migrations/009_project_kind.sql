-- 009_project_kind: 项目类型（issue 看板 vs 纯对话模式）+ 对话维度扩展。
--   projects.kind          'issue'（默认，向后兼容存量项目）= issue 看板驱动开发；
--                          'chat' = 对话模式：不建 issue，维护多条独立对话，产物直接落项目 cwd。
--   conversations.kind     'issue'（默认）= issue 引擎绑定的执行会话（共用项目 cc-<pid> 会话、单活跃切换）；
--                          'chat' = 独立聊天会话，用每对话独立 tmux 会话 `chat-<convId>`，
--                          与 issue 的 cc-<pid> 隔离，故多条 chat 对话可并存、来回切换互不 kill。
--   conversations.last_active_ts  对话最近活跃（激活/收发）时刻（毫秒；NULL = 从未激活），供对话列表按最近使用排序。

ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'chat'));
ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'chat'));
ALTER TABLE conversations ADD COLUMN last_active_ts INTEGER;

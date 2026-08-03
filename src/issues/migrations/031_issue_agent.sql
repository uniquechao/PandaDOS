-- 031_issue_agent: issue 维度执行代理切换（claude code / codex）
-- issues.agent：该 issue 由哪个 CLI 代理驱动（默认 claude，向后兼容存量行）
-- conversations.agent：对话所属代理——对话生命周期内不变（resume 语义按代理不同）
-- conversations.agent_session_id：原生 Agent session id。codex 无法预指定，启动后由定位器从
--   rollout 的 session_meta 发现并回填；Claude 常规会话可为 NULL（conv.id 即 session id），
--   导入的本地历史会写入同值作为持久历史路径绑定标记。
-- conversations.agent_jsonl_path：已发现的会话 jsonl 绝对路径缓存（重启不丢；失效则重扫）
-- conversations.agent_launch_ts：最近一次 fresh 启动时刻（codex session 发现的时间锚点）

ALTER TABLE issues ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude' CHECK (agent IN ('claude', 'codex'));
ALTER TABLE conversations ADD COLUMN agent TEXT NOT NULL DEFAULT 'claude' CHECK (agent IN ('claude', 'codex'));
ALTER TABLE conversations ADD COLUMN agent_session_id TEXT;
ALTER TABLE conversations ADD COLUMN agent_jsonl_path TEXT;
ALTER TABLE conversations ADD COLUMN agent_launch_ts INTEGER;

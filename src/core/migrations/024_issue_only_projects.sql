-- 024_issue_only_projects: 项目统一使用 issue 看板；独立对话仍保留 conversations.kind='chat'。

UPDATE projects SET kind = 'issue' WHERE kind <> 'issue';

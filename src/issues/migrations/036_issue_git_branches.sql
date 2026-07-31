-- 036_issue_git_branches: issue 期望目标分支与创建来源引用。
-- branch 仍表示开跑后实际所在分支；这两个 nullable 字段只保存用户在 pending 阶段配置的 Git 意图。
-- source_ref 保存分支清单接口返回的完整引用名（refs/heads/* 或 refs/remotes/*），避免同名歧义。

ALTER TABLE issues ADD COLUMN target_branch TEXT;
ALTER TABLE issues ADD COLUMN source_ref TEXT;

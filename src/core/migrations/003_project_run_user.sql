-- 003_project_run_user: 项目维度 Linux 用户选择（导入现有 tmux 项目配套）
-- run_user：项目归属的执行机 Linux 用户名（'' = 跟随执行机连接用户，现状全部行为不变）。
-- 本期语义：建项目/导入时的归属标记 + 默认 cwd 锚点（落 /home/<user>/…）；
-- 以该用户身份运行 agent 进程（sudo/权限/每用户 claude 安装）留给多用户隔离后续阶段。
ALTER TABLE projects ADD COLUMN run_user TEXT NOT NULL DEFAULT '';

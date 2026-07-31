# Mando AI（曼拓）

Mando AI 是一个由 issue 驱动的多 AI 编程代理编排与远程工作平台。它把需求队列、
Claude Code / Codex CLI、tmux 会话和 Web 工作台连接起来，让团队能够集中提交任务、
观察执行过程，并只在关键决策或高风险操作时介入。

Mando AI 不是代码生成模型。它位于使用者和编程代理之间，负责调度、会话管理、
状态跟踪、权限审批、通知和故障恢复。

## 适用场景

- 在多个代码项目之间统一排队和推进开发任务；
- 通过浏览器查看代理对话、终端、文件和 Git 状态；
- 让 Claude Code 与 Codex 在同一平台内按项目或模块协作；
- 从桌面或移动端提交需求、回答澄清问题和审批高风险操作；
- 通过本机或 SSH 执行机运行已有的编程代理 CLI。

## 核心能力

- **Issue 工作流**：task、design、debug 三类任务通过状态机自动推进，支持置顶、
  模块聚合、澄清、测试失败反馈和完成接力。
- **双代理支持**：按执行机能力选择 Claude Code 或 Codex，并复用各自的持久会话。
- **项目模块**：模块固定使用一种代理，并为连续任务保留逻辑上下文。
- **多种审批模式**：可在谨慎、中等和全自动之间选择；删除数据、改写 Git 历史、
  部署和密钥操作等高风险行为仍需人工确认。
- **Web 工作台**：包含看板、聊天、终端、文件管理、图片预览、Git 操作和执行进度。
- **本机与 SSH 执行机**：通过统一的 `ExecutorDriver` 接口访问 tmux、文件、Git 和 PTY。
- **多用户与通知**：支持项目成员、用户设置、飞书登录、通知和卡片审批。
- **会话恢复**：tmux 进程可重建，Claude Code / Codex 的逻辑会话可以继续恢复。

## 工作方式

```text
用户 / Web / 飞书
        │
        ▼
   Mando AI 控制面
        │
        ├── issue 状态机与队列
        ├── PM 判断与审批
        ├── 会话、文件和 Git 管理
        │
        ▼
 本机或 SSH 执行机
        │
        ▼
 tmux → Claude Code / Codex
```

同一项目一次只推进一条 issue，避免多个代理同时修改共享工作区。不同项目可以独立
运行；项目对话模式还可以创建多条互不干扰的常驻对话。

## 技术架构

后端依赖方向：

```text
core ← executor ← issues ← agents
  ↑
web / notify
```

| 目录 | 职责 |
|---|---|
| `src/core/` | SQLite、迁移、用户、会话、文件、技能和项目摘要 |
| `src/executor/` | 本机与 SSH 执行机抽象 |
| `src/issues/` | issue 状态机、队列、模块、澄清和执行引擎 |
| `src/agents/` | OpenAI-compatible 客户端、PM 判断和审批策略 |
| `src/notify/` | 订阅、聚合与飞书通知 |
| `src/web/` | HTTP API、WebSocket、终端和服务装配 |
| `ui/` | Preact + Vite 前端 |

主要技术栈：Bun、TypeScript、SQLite、Preact、Vite、tmux、xterm.js、ssh2，
以及 Claude Code / Codex CLI。

更详细的运行模型见 [架构说明](docs/architecture.md)。

## 快速开始

### 环境要求

- Bun
- Git
- tmux
- 已安装并登录的 Claude Code 或 Codex CLI

### 安装与启动

```bash
bun install --frozen-lockfile
bun run build-ui
bun run start
```

服务默认监听 `127.0.0.1:8802`。首次启动会创建管理员账号，并把仅显示一次的
管理员 token 写入 `~/.butler2/admin-token`，文件权限为 `0600`。

打开：

```text
http://127.0.0.1:8802
```

如需 PM 判断、总结和问答，可在 Admin 页面配置 OpenAI-compatible API 地址、
模型名称和 API Key。也可以使用环境变量作为部署配置：

```text
BUTLER2_LLM_BASE_URL
BUTLER2_LLM_MODEL
BUTLER2_LLM_API_KEY
```

完整的环境变量和反向代理示例见 [部署指南](DEPLOY.md)。

## 开发

```bash
bun run typecheck
bun test
bun run build-ui
```

贡献代码前请阅读 [AGENTS.md](AGENTS.md) 和 [CLAUDE.md](CLAUDE.md)。两份文件描述
当前架构边界、编码约定和安全要求。

## 安全提醒

Mando AI 的网页终端和文件功能等同于远程 shell：

- 服务应只监听回环地址，并通过可信反向代理提供 TLS 和认证；
- 不要把 `.env`、数据库、管理员 token、SSH 私钥或代理会话数据提交到 Git；
- 执行机应使用专用账号和最小权限；
- 对外部署前应检查反向代理、WebSocket、文件权限和备份策略。

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。

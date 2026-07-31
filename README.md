# Mando AI（曼拓）

Mando AI 是一个由 issue 驱动的多 AI 编程代理编排与远程工作平台。它把需求队列、
Claude Code / Codex CLI、tmux 会话和 Web 工作台连接起来，让团队能够集中提交任务、
观察执行过程，并只在关键决策或高风险操作时介入。

Mando AI 不是代码生成模型。它位于使用者和编程代理之间，负责调度、会话管理、
状态跟踪、权限审批、通知和故障恢复。

![Mando AI 工作台概览](docs/images/mando-workspace-overview.png)

> 演示界面：项目、用户、Issue 和分支信息均为公开示例数据。

## 适用场景

- 在多个代码项目之间统一排队和推进开发任务；
- 通过浏览器查看代理对话、终端、文件和 Git 状态；
- 让 Claude Code 与 Codex 在同一平台内按项目或模块协作；
- 从桌面或移动端提交需求、回答澄清问题和审批高风险操作；
- 通过本机或 SSH 执行机运行已有的编程代理 CLI。

## 特色功能

### 1. Issue 驱动的自动执行闭环

每条需求都是可追踪的 Issue。Mando AI 负责排队、澄清、规划、执行、测试和结果回写，
代理遇到缺失信息时暂停等待，任务通过验证后自动接力下一条。`task`、`design`、
`debug` 三类工作流分别适配功能实现、方案设计和问题排查。

![Issue 自动执行流程](docs/images/mando-issue-workflow.png)

> 任务详情、当前阶段、代理、分支和执行总结集中在同一页面。

### 2. Claude Code 与 Codex 的持久上下文

项目或模块可以固定使用 Claude Code 或 Codex，并持续复用逻辑会话。即使 tmux 进程
重建，代理仍能恢复上下文；连续 Issue 无需每次从零解释代码结构和历史决策。不同项目
可以并行运行，同一共享工作区则一次只推进一条 Issue，降低并发修改冲突。

### 3. 自动化效率与人工控制并存

谨慎、均衡、自动三种批准级别让团队按任务风险决定介入频率。常规读取、编辑和测试
可以连续执行；删除数据、改写 Git 历史、部署、密钥和权限变更等高风险操作始终保留
人工确认。澄清问题和审批结果也会成为任务过程的一部分，便于后续追踪。

### 4. 浏览器就是完整的代理工作台

无需守在执行机前：在浏览器中即可管理项目与队列，查看代理对话、实时终端、文件、
图片和 Git 状态，并处理澄清与审批。执行机既可以是本机，也可以通过 SSH 接入；
多用户、项目成员和通知机制让个人工作流自然扩展到团队协作。

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

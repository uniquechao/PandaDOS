# MandoAI 架构

本文说明 MandoAI 当前的运行模型，以及项目、issue、对话、tmux 和执行代理之间的关系。

## 核心关系

```text
项目
 ├── issue ──┐
 ├── 模块 ───┼── 对话（持久逻辑身份）
 └── 对话模式 ┘          │
                         ▼
                  tmux 会话（运行容器）
                         │
                         ▼
                 Claude Code / Codex
```

最重要的边界是：**进程不等于对话**。

- 对话由数据库中的逻辑 session ID 标识；
- tmux 会话只是承载代理进程的运行容器；
- tmux 被回收后，控制面可以通过 Claude Code 或 Codex 的 resume 能力恢复上下文。

## 分层结构

| 层 | 责任 |
|---|---|
| 项目 | 绑定代码目录、执行机、成员和工作模式 |
| issue | 保存需求、状态、事件、审批和执行结果 |
| 模块 | 为一组连续任务固定代理并复用逻辑对话 |
| 对话 | 保存代理类型、session ID、归档状态和 JSONL 定位信息 |
| tmux | 提供可观察、可重建的运行容器 |
| 执行代理 | Claude Code 或 Codex CLI |

项目同时只推进一条 issue，避免共享工作区产生冲突。不同项目可以分别运行；对话模式
使用独立 tmux 会话，不占用 issue 队列。

## 后端模块

```text
core ← executor ← issues ← agents
  ↑
web / notify
```

### Core

`src/core/` 提供 SQLite、迁移、类型、用户、会话、JSONL、上传、技能和项目摘要。
它是最内层，不依赖执行引擎或 Web。

### Executor

`src/executor/` 定义 `ExecutorDriver`。上层通过它执行文件、Git、tmux、命令和 PTY
操作。主要实现：

- `LocalDriver`：在控制面本机执行；
- `SshDriver`：通过持久 SSH 连接访问远程执行机。

### Issues

`src/issues/` 管理状态机、队列、模块、澄清、协议哨兵和执行节拍。状态变化集中通过
事件处理入口写入，保证数据库状态与事件记录一致。

### Agents

`src/agents/` 提供 OpenAI-compatible 客户端、PM 判断、进度分析和审批策略。LLM
不是状态机的唯一依据；协议哨兵、事件和超时机制仍承担确定性控制。

### Web 与 Notify

`src/web/` 提供 HTTP API、WebSocket、聊天、终端和文件操作。`src/notify/` 将事件
路由到订阅用户与通知通道。

## Issue 生命周期

典型状态：

```text
pending → planning → implementing → testing → done
```

任务可以进入等待澄清、人工审批、阻塞或取消等分支。状态机负责合法转换，事件表负责
审计和恢复。调度顺序综合手动置顶、模块聚合和 FIFO。

执行引擎周期性完成以下工作：

1. 选择正在驱动的 issue；
2. 确认项目当前对话与 tmux 会话；
3. 捕获终端屏幕并识别菜单或升级提示；
4. 增量读取代理 JSONL 输出；
5. 解析完成、澄清和测试失败等协议标记；
6. 在静默时催办、判断或恢复会话；
7. 将状态、进度和通知写入统一事件流。

## 会话与 tmux

不同用途使用不同 tmux 命名空间：

| 形式 | 用途 |
|---|---|
| `cc-<project>` | 项目 issue 主会话 |
| `cc-<project>-m-<module>` | 模块会话 |
| `chat-<conversation>` | 独立项目对话 |
| `cc-<project>-console` | 原生项目终端 |
| 辅助前缀 | 澄清、模块整理和项目摘要等短生命周期任务 |

逻辑对话记录在数据库中，tmux 名称由控制面统一生成。调用方不应猜测会话名称或绕过
`ConversationManager` 直接切换代理。

## 观察与写入

系统通过两条通道观察代理：

- JSONL：结构化的 assistant、thinking、tool 和结果消息；
- tmux/PTY：菜单、终端画面和用户交互。

写入也分两类：

- 受控 prompt 和按键注入，经过控制字符、长度、延迟与按键白名单保护；
- 用户在 Web 终端中的原始 PTY 输入。

自动注入共享同一组互斥锁。项目锁必须先于 tmux 锁获取，避免切换会话与输入注入之间
产生竞态或死锁。

## 数据与安全

默认运行数据位于 `~/.mando/`，包括 SQLite、管理员 token、SSH key 引用和缓存。
这些数据不属于源码仓库。

安全部署应遵循：

- HTTP 服务只绑定回环地址；
- 由可信反向代理提供 TLS、认证和 WebSocket；
- 执行机使用专用低权限账号；
- 密钥保存在仓库外并设置严格文件权限；
- 生产数据库只读诊断，变更通过应用和迁移完成；
- 高风险操作始终保留人工授权边界。

## 源码入口

| 关注点 | 文件 |
|---|---|
| 执行机接口 | `src/executor/driver.ts` |
| 本机与 SSH 实现 | `src/executor/local.ts`、`src/executor/ssh.ts` |
| 对话与 tmux | `src/core/conversations.ts` |
| JSONL 增量读取 | `src/core/jsonl.ts` |
| 会话定位 | `src/core/agent-locator.ts` |
| 状态机与引擎 | `src/issues/machine.ts`、`src/issues/engine.ts` |
| 队列与锁 | `src/issues/queue.ts`、`src/issues/mutex.ts` |
| HTTP 路由 | `src/web/routes/` |
| WebSocket | `src/web/ws/` |
| 前端 | `ui/src/` |

# CLAUDE.md — MandoAI 开发指南

本文件是仓库内开发代理和贡献者的权威工程指南。开始修改前，请先了解相关模块，
保持现有依赖方向，并使用与改动规模相称的验证方式。

## 项目定位

MandoAI 是一个 issue 驱动的多 AI 编程代理编排平台。控制面维护项目、任务、对话、
审批和通知状态；实际代码操作由本机或 SSH 执行机中的 Claude Code / Codex CLI 完成。

## 模块边界

依赖方向必须保持：

```text
core ← executor ← issues ← agents
  ↑
web / notify
```

- `src/core/`：数据、类型、用户、会话、文件、技能等基础能力；
- `src/executor/`：执行机边界及 Local/SSH 实现；
- `src/issues/`：状态机、队列、模块、澄清和执行引擎；
- `src/agents/`：LLM 客户端、PM 判断和审批策略；
- `src/notify/`：订阅和通知通道；
- `src/web/`：HTTP、WebSocket 与应用装配；
- `ui/`：Preact 前端。

内层模块不得反向导入外层模块。跨执行机的文件、tmux、Git 和 PTY 操作必须通过
`ExecutorDriver`，不要在上层直接访问本地文件系统或 shell。

## 开发命令

所有命令从仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build-ui
```

修改代码后至少运行与改动直接相关的测试。合并前应完成 typecheck、全量测试和 UI 构建。

## 编码约定

- TypeScript 使用 strict 模式；避免无依据的 `any` 和非空断言。
- `transition` 保持纯函数；非法状态转换返回 `null`。
- Git 命令封装返回 `{code,out,err}`，调用方必须显式处理失败。
- 修改 `ExecutorDriver` 时同步更新 Local、SSH 实现和测试替身。
- 新增数据库迁移时更新迁移测试和依赖迁移数量的断言。
- issue 引擎测试应将 `resultSummaryTimeoutMs` 设为 `0`，避免等待外部总结。
- 文本注入必须经过长度、控制字符和按键白名单约束。
- 锁顺序保持 project → tmux，不得反向获取。
- UI 保持桌面端与移动端都可操作，并为异步状态提供明确反馈。

## 安全边界

- 不读取、提交或展示真实 `.env`、token、数据库、SSH 私钥和代理会话文件。
- 生产数据库诊断保持只读；测试使用临时数据库和隔离服务。
- 不把服务直接暴露到公网。默认绑定回环地址，由反向代理提供 TLS 和认证。
- 删除数据、强推、重写历史、部署、重启和修改密钥属于高风险操作，必须获得明确授权。
- 测试和文档只使用 `example.com`、`developer`、RFC 私网地址和示例项目。

## 提交要求

- 保持改动聚焦，不混入无关格式化或重构。
- 提交信息说明行为变化，而不是终端操作过程。
- 不提交构建产物、运行数据、项目记忆、备份或本机配置。
- 更新公共行为时同步更新 README、部署说明或架构文档。

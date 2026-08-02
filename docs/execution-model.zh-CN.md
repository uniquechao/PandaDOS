# 执行模型：issue · 对话 · tmux · 执行代理 · 终端

[English](execution-model.md)

> 本文讲清 MandoAI v2 里最容易混淆的一组概念——**issue / 模块 / 对话 / tmux 会话 / 执行代理 / 终端**——各自是什么、谁归谁、以什么节拍互动、出故障怎么自愈。
> 依据代码快照：分支 `feat/screenshot-preview`（`a61c1b9` 之后），2026-07-25 通读 `src/executor` / `src/core/conversations.ts` / `src/issues/engine.ts` / `src/web/ws` 得出。行号会随改动漂移，认函数名。

## 0. 一句话链条

```
issue → (模块) → 对话(session-id，持久)
        → tmux 会话(可再生的运行容器)
        → 里面的 claude / codex 进程 = 执行代理
        → 终端 = 这条 tmux 的一个视窗
```

整套系统的承重点是一句话：**进程 ≠ 对话**。

- 对话是逻辑身份（CLI 的 session-id），入库，重启不丢；
- tmux 会话只是承载它的容器，随时可杀、可重建；
- 重建方式是 `claude --resume <convId>`（codex 是 `codex resume <sid>`），上下文原样接上。

## 1. 五层概念

| 层 | 是什么 | 存在于 | 关键约束 |
| --- | --- | --- | --- |
| 项目 | 一个 cwd + 一台执行机 | `projects` 表 | 控制面不碰本地 fs，一切经 `ExecutorDriver` |
| issue | 需求单 + 状态机 | `issues` / `issue_events` / `gates` | 自己不持有进程，只持有 `conv_id` |
| 模块 | 项目内共享资产，固定一种代理 | `project_modules` | 永久绑定唯一一条对话（`conversation_id`），同模块 issue 顺序复用 |
| 对话 | 逻辑会话 = CLI 的 session-id | `conversations` + `project_active_conv` | claude 用 convId 当 session-id；codex 事后发现回填 |
| tmux 会话 | 运行容器，前台进程即执行代理 | 执行机 | 可随时 kill/重建；名字由控制面算出，不猜 |

补充说明：

1. **项目 ↔ 执行机边界**：对执行机的一切操作（tmux、按字节读文件、写文件、symlink、git、PTY）只走 `ExecutorDriver`（`src/executor/driver.ts`），实现是 `LocalDriver`（本机直跑）和 `SshDriver`（单持久连接多路复用、断线退避自愈）。改这个接口要同步 4 处：`driver.ts` / `local.ts` / `ssh.ts` + 各测试 stub。
2. **issue 状态机**：`pending → planning → implementing → testing → done`，任意态可 `block`。所有迁移收口 `applyEvent`（`machine.transition` 纯函数 + CAS + 落 `issue_events`），非法迁移返回 `null`。驱动态 = `planning / implementing / testing`（`DRIVING_STATES`）。
3. **队列**：每项目同时只有一条 issue 在跑（`queue.isBusy`）；`pickNext` 三层优先级——置顶（`pinned_ts`，后置顶在前）> 模块聚合（同模块不被 FIFO 打散）> FIFO。

## 2. tmux 命名规则（谁归谁）

名字全部由控制面算出来，**永不按名字猜测或兜底连接**。命名函数在 `src/core/conversations.ts`：

| 会话名 | 用途 | 生成处 |
| --- | --- | --- |
| `cc-<pid>` | 项目 issue 主会话，**项目同时只有一条活跃** | `dedTmux()` |
| `cc-<pid>-m-<slug>` | 正式模块的按需运行容器 | `moduleTmux()` |
| `chat-<convId>` | 对话模式，每对话独立常驻、互不 kill | `chatTmux()` |
| `cc-<pid>-console` | 项目原生 Bash 终端（无代理，纯 shell），缺则懒建 | `web/ws/index.ts` |
| `clr-<issueId>` | 创建时澄清的一次性只读分析会话 | `clarify-runner.clarifySessionName()` |
| `org-<pid>` | 模块智能整理的一次性分析会话 | `organize-runner.organizeSessionName()` |
| `sum-<pid>` | README/认知摘要的一次性分析会话 | `core/agent-summary.ts` |

后三类是**一次性辅助会话**：不占队列、不碰驱动会话、用完即弃，所以「代理在分析澄清」不会阻塞 issue 执行。

`cc-<pid>` 当前绑哪条对话记录在 `project_active_conv` 表（v1 放内存里，重启即丢 → 第一次 activate 误杀正在干活的进程，v2 入库修掉）。

建会话统一走 `tmuxNewSessionArgs()`：显式 `-x 220 -y 50`。默认 80×24 会把 CLI 的长选项换行腰斩、打断菜单检测，这是 v1 的地雷，两个 Driver 共用同一个函数防回归。

## 3. 对话生命周期

`ConversationManager`（`src/core/conversations.ts`）：

1. **create** —— 只登记一行，不起进程。`kind` 分 `issue`（共用 `cc-<pid>`）与 `chat`（独立 `chat-<convId>`）。agent（claude/codex）对话生命周期内不变。
2. **activate** —— 起进程。两种语义：
   - `issue`：项目单活跃会话。已是 `currentConv` 且 tmux 活着 → 幂等短路；切对话 = kill 旧起新 + 落 `project_active_conv`。调用方必须用 `projectLockKey(projectId)` 互斥。
   - `chat`：会话活着即幂等短路（不打断在跑的对话），只在不在时启动。codex 例外——tmux 活着 ≠ codex 在跑，走 `ensureCodexChatLive` 抓屏真检测。
3. **buildCommand** —— 组装启动命令：
   - claude：jsonl 已落地 → `claude --resume <convId>`，否则 `claude --session-id <convId>`；顺手清 `agent_jsonl_path` 覆盖，防继续 tail 死文件。
   - codex：已发现 session id → `codex resume <sid>`，否则 fresh 启动；两种情况都重盖 `agent_launch_ts` 并清 path 缓存（issue #48：旧绑定粘连是卡死元凶）。启动带 `-c check_for_update_on_startup=false`（顶层键才有效，`[tui]` 那个只关横幅）+ `--dangerously-bypass-approvals-and-sandbox`（无人守屏时审批弹窗滞留即卡死）。
4. **launchInto** —— 预置 cwd 信任（`~/.claude.json` / `~/.codex/config.toml`，best-effort，兜底是 PM 自动同意弹窗）→ 装兼容层技能与项目桥 → 确保 cwd 存在 → kill 旧 → `createSession` → `sendKeys(cmd)`。
5. **sleepIssue** —— 模块按需休眠：只回收 tmux 进程，保留 conversation 与 session id，下次 resume 接上。
6. **archive / closeChat** —— 归档顺手 kill chat 独立会话；`closeChat` 只 kill 不改 archived（下次 activate 会 `--resume` 复活）。

## 4. issue 怎么拿到一条对话

`IssueEngine.startIssue`（`src/issues/engine.ts`）在 pending→planning 的最小临界区里绑定，优先级：

1. issue 已有 `conv_id` → 直接用；
2. 有 `module_id` → 用模块永久绑定的那条对话，模块还没有就建一条并回写 `project_modules.conversation_id`（带并发复核：回读 bound 不是自己就改用别人建的那条）；
3. `category = 'debug'` → 复用项目里未归档、未被占用、同 agent 的空闲对话；
4. 否则新建一条，label 取 issue 标题前 40 字。

所以同模块的多个 issue 会**顺序复用同一条对话**——这也是终端 `?issue=` 必须额外校验 `currentConv` 的根因（见 §7）。

## 5. 引擎节拍：每 3 秒对一条 issue 做什么

`IssueEngine.tick` → `tickIssue`。顺序即防线顺序：

1. **取活**：`listDriving()` 拿所有驱动态 issue，**每项目单飞**（`tickFlights`，慢项目不拖别的项目）。在途超 `TICK_STUCK_WARN_MS`（5min）只打告警**不重置**——强行重入会造成双驾驶员。
2. **占用门禁**：只驱动项目 `currentConv` 那条对话。被切走（浏览/人工接管）→ 落 `conv_displaced` + 通知一次，然后暂停，不夺占；切回自动复位继续。若项目**完全没有**激活对话（迁移/重启残留）→ 驱动中的 issue 自行 `activateConv`。
3. **抓屏**：`capturePane(session)`。
4. **会话自愈（#88）**：pane 抓空**才**去 `listSessions` 判活（健康路径零额外开销）。确认死会话 → `activateConv` 重建（jsonl 已落地即 `--resume`，内部 `resetWatch` 从新文件末尾起 tail）+ 落 `session_recovered`；带 `SESSION_RECOVER_COOLDOWN_MS`（60s）冷却，冷却带进新 watch 防「重建后立刻又死」的 3s 打转。判活抛错一律按**未知**处理，保守不动。
5. **codex 升级弹窗**：识别到就自动打 `1` 升级（30s 冷却），本 tick 到此为止——弹窗会吃掉 prompt。
6. **菜单检测**：`detectSelection(pane)` → 交审批管道 `onMenu`（外层按菜单签名去重）。滞留超 `menuStuckMs`（5min）落 `menu_stuck` + 通知，界面亮「等你选择」。菜单消失的一次性转沿调 `onMenuGone` 重置签名。
7. **kickoff**：该阶段进入事件之后没有 `injected` 事件就注入首条 prompt。幂等（事件判重）+ 单飞 + 就绪真检测：jsonl 已可定位，或 pane 出现输入框特征（claude 的 `❯`/`╭─`，codex 的 `›`/`OpenAI Codex`）。
8. **tail jsonl → 协议解析**：增量 tail 新输出，任何字节增长刷 `growTs`（文件健康度），只有代理侧消息（assistant/thinking/tool_use/tool_result）刷 `activityTs` 并复位 nudge。消息交 `onConvMessages`（进度管道唯一事件源，外层别再 tail）+ `ingest` 走哨兵解析（`ISSUE_DONE` / `NEED_CLARIFY` / `TESTS_FAILED` / 子任务块 / limit 识别）。
9. **静默三级 + 两种重认领**：
   - 执行中澄清等待：`NEED_CLARIFY` 后停催停判，超 `clarifyTimeoutMs`（20min）注入「按最佳判断继续」+ 落 `clarify_timeout` 复位续跑；
   - 安静 `nudgeSec`（180s）→ nudge 催一次；
   - 安静 `fallbackSec`（360s）→ PM（DeepSeek）保守判 done，每 360s 重判防一次误判卡死；
   - 会话失效重认领（#48）：已 nudge 过、注入后 `sessionStaleMs`（60s）绑定文件零增长、pane 却有输入框特征 → `locator.reclaim` 重新发现活跃会话，重绑后从新文件末尾起 tail（防旧哨兵重放）并立刻催一次。

`WatchState` 是这套节拍的全部内存态（offset / fedTs / activityTs / nudged / waitUntil / bootTs / doneChecked / menuSince / growTs / reclaimAt / codexUpdateAt / recoverAt）。**它随进程重启全部蒸发**——所以长任务要么事件溯源可恢复，要么挂 `start()` 的一次性恢复扫描兜底（澄清分析就是后者）。

## 6. 两条观测通道 + 两条写入通道

### 观测（读）

1. **jsonl tail** —— 结构化对话流。全库只有**一份** tail 实现（`src/core/jsonl.ts`）：字节 offset 推进 + 保留未写完的尾行 + `size < offset` 轮转重置 + 短读循环补满 + 在**字节层**找最后一个 `\n` 再解码（UTF-8 边界安全）。引擎是唯一 tail 源；网页对话流 `/ws/chat/:pid` 读的是同一份文件。
   - jsonl 定位严禁 `cwd.replace(/\//g,'-')` 硬算，一律经 `listDir` 按 `<convId>.jsonl` 匹配（`JsonlLocator`）。
   - codex 侧由 `AgentJsonlLocator` 发现：候选 = 首行 `session_meta` 的 UTC timestamp ≥ `launch_ts - 2min` 的 rollout，核对 `cwd`，排除已被别的对话绑走的 sid，取最早者回填。**文件名里的时间不做判定**——那是执行机本地时区，Bun 无 TZ 时按 UTC 解析，偏移可达 8h+，正是 #48 错绑的成因。
2. **capturePane / PTY** —— 屏幕字节。弹窗检测走 `capturePane`；网页终端走 `openPty("tmux attach -t <session>")`，`/ws/term/:pid` 上 binary 帧双向透传，文本帧只认 `{type:'resize',cols,rows}`，服务端 PTY 退出发 `{type:'exit'}`（`src/web/ws/term.ts`）。

### 写入（注入）

3. **sendKeys / sendKey** —— 受控注入。净化 + 截断 + 回车三件套（`driver.ts`）：控制字符含 `\n` 一律→空格（tmux 里 `\n` 等于回车，保留会把多行文本逐行提前提交）、截断 `MAX_INJECT_CHARS`（2000）、发完停 `INJECT_ENTER_DELAY_MS`（300ms）再回车（codex 的 paste-burst 会把紧跟的 Enter 并进粘贴，消息滞留输入框永不提交）。`sendKey` 只收 22 键白名单。
4. **PTY 直写** —— 网页终端里用户自己敲的键，绕过净化直接进 tmux。

### 互斥纪律

- 四条注入路径（引擎 kickoff/nudge、PM 自动审批、web `/act`、飞书卡片回调）**共用同一把 `KeyedMutex(tmuxLockKey(session))`**；人侧三条的统一原语在 `src/web/ws/inject.ts`。
- 菜单选择 `actOnMenu` 必须锁内「重抓 capturePane → 核对签名 → 相对导航 → Enter」原子完成；签名不符返回 `stale`（409），**绝不盲注入**（菜单已变时的盲导航会把 Enter 打进下一个弹窗）。签名两档：网页用含 `cursorIndex` 的全签名，审批卡用只看选项本体的 `optionsSig`（发卡到点击有分钟级时差，光标可能被动过）。
- **锁序铁律：project → tmux**，全库唯一嵌套方向，反向必死锁。`activate` 的 kill+create+send 三连必须持 tmux 锁，否则别人的注入会落进「新 bash 已起、claude 还没跑」的窗口，被当 shell 命令执行。

## 7. 终端接入的能力边界

`/ws/term/:projectId` 不是「attach 任意 tmux」的别名。鉴权（upgrade 前完成）：无 token → 401；项目不存在 admin 见 404、普通用户统一 403（不泄露存在性）；非属主非成员非 admin → 403。

目标 selector 互斥且强类型（`src/web/ws/index.ts` `resolveTermTarget`）：

| selector | 落到哪 | 校验 |
| --- | --- | --- |
| 无参 | `cc-<pid>-console` | 缺则懒建（唯一允许 create 的目标） |
| `?issue=` | 该 issue 对话的 `cc`/模块会话 | 本项目 + 状态在驱动态 + 绑合法 issue 对话 + **仍是 `currentConv`**，否则 409 |
| `?conv=` | `chat-<convId>` | 必须是本项目 `kind='chat'` 的独立对话，否则 409 |
| `?session=` | 导入会话 | 必须在 `sessions` 表登记且属本项目；显式拒绝 `cc-<pid>` / 模块 / chat 会话 |

`?issue=` 为什么要额外校验 `currentConv`：模块复用让历史 issue 与当前 issue 指向同一条对话，只凭 conv 解析就会把**历史 issue 页误接到正在干活的代理**上。

结论：**网页终端与执行代理是同一条 tmux 的两个观察者**。你在终端里手敲会真的影响 issue 执行；反过来引擎注入的 prompt 你也能在终端里实时看到。前端入口：`ui/src/components/TermPane.tsx`（xterm.js + 按键条，断线不自动重连）、`ui/src/views/Term.tsx`（项目原生 Bash 页）。

## 8. 失效与自愈矩阵

| 场景 | 现象 | 自愈机制 |
| --- | --- | --- |
| 切对话 | 旧进程该让位 | `activate` = kill 旧 + new + resume（持 tmux 锁） |
| 模块休眠 | 省资源 | `sleepIssue` 只回收 tmux，保留 conversation/session id |
| mando 重启 | tmux 被连坐杀、内存态蒸发 | tick 里会话自愈重建；`start()` 一次性恢复扫描（悬空澄清）；事件溯源判断状态 |
| 宿主重启 / 外力 kill tmux | `project_active_conv` 还在，往死会话 send-keys 刷错 | pane 空 → 判活 → `activateConv` 重建 + `session_recovered`（60s 冷却） |
| codex 自更新退回 shell | tmux 活着但代理死了，消息全打进 bash（command not found） | `ensureCodexChatLive` 抓屏识别（`Please restart Codex` / shell 提示符）后重启；启动参数关掉 startup update check |
| codex 升级弹窗 | 新版本一出全员卡死 | tick 里自动选「1. Update now」，30s 冷却 |
| 绑到死 jsonl / 时区错绑 | 注入后文件零增长 | 先 nudge 再 `reclaim` 重新认领，重绑从新文件末尾 tail |
| 弹窗无人管 | 静默黑洞 | 5min 落 `menu_stuck` + 通知 + UI「等你选择」角标 |
| tick 卡死 | 执行机调用挂住 | 5min 打告警，**不重置**（避免双驾驶员）；Driver 层限时：tmux 类 10s、git 类 60s |

运维提醒：改后端要 `systemctl restart mando`，而重启会打断在跑 issue 的注入与分析——**部署重启放低峰，别在 issue 执行中从执行会话里触发**（#76→#77→#78 事故链的根因）。

## 9. 关键常量与默认值

| 名称 | 值 | 位置 |
| --- | --- | --- |
| `tickMs` | 3000 | `DEFAULT_ENGINE_CONFIG` |
| `nudgeSec` | 180 | 同上 |
| `fallbackSec`（PM 保守判） | 360 | 同上 |
| `sessionStaleMs`（重认领） | 60_000 | 同上 |
| `menuStuckMs` | 5min | 同上 |
| `clarifyTimeoutMs` | 20min | 同上 |
| `judgeWindowBytes` | 16000 | 同上 |
| `resultSummaryTimeoutMs` | 3min（引擎单测须传 0） | 同上 |
| `SESSION_RECOVER_COOLDOWN_MS` | 60s | `engine.ts` |
| `TICK_STUCK_WARN_MS` | 5min | `engine.ts` |
| `MAX_INJECT_CHARS` | 2000 | `driver.ts` |
| `INJECT_ENTER_DELAY_MS` | 300 | `driver.ts` |
| tmux 会话尺寸 | 220×50 | `tmuxNewSessionArgs` |
| Driver 超时 | tmux 10s / git 60s | `driver.ts` |

## 10. 三个常见误解

1. **「杀了 tmux 就丢上下文」** —— 不会。上下文在 CLI 的 jsonl 会话文件里，tmux 只是容器，`--resume` 回来照旧。
2. **「一个项目能同时跑多个 issue」** —— 不能。项目级单活跃会话 + `isBusy` 双重限制；并行只发生在「不同项目之间」和「chat 独立对话」。
3. **「终端是只读观察窗」** —— 不是。PTY 是双向的，手敲直接进 tmux，会和引擎注入抢同一个输入框（引擎侧有锁，你手敲没有）。

## 11. 源码索引

| 关注点 | 文件 |
| --- | --- |
| 执行机唯一出口 | `src/executor/driver.ts`（+ `local.ts` / `ssh.ts` / `conn.ts`） |
| 对话与 tmux 命名、启动 | `src/core/conversations.ts` |
| jsonl 增量 tail | `src/core/jsonl.ts` |
| codex 会话发现 / 重认领 | `src/core/agent-locator.ts` |
| 屏幕解析（菜单/弹窗/退回 shell） | `src/core/screen.ts`、`core/agent-summary.ts` |
| 节拍与状态机 | `src/issues/engine.ts`、`machine.ts`、`sentinel.ts`、`prompts.ts` |
| 队列与锁 | `src/issues/queue.ts`、`mutex.ts` |
| 模块身份与文档同步 | `src/issues/modules.ts`、`module-docs.ts` |
| 一次性辅助会话 | `src/issues/clarify-runner.ts`、`organize-runner.ts`、`core/agent-summary.ts` |
| WS 鉴权与分发 | `src/web/ws/index.ts` |
| PTY 终端桥 | `src/web/ws/term.ts` |
| 对话流与注入原语 | `src/web/ws/chat.ts`、`inject.ts` |
| 前端终端 / 执行页 | `ui/src/components/TermPane.tsx`、`ui/src/views/Term.tsx`、`ui/src/views/IssueDetail.tsx` |

延伸阅读：`README.zh-CN.md`（项目结构与运行方式）、`DEPLOY.zh-CN.md`（部署与运维）和
`docs/i18n-contributing.zh-CN.md`（国际化贡献指南）。

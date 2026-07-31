/**
 * web/server —— V2 控制面完整装配。
 *
 * 装配顺序：
 *   1. DB 打开 + 迁移链 migrate → migrateIssueEngine → migrateNotify → migratePmAgent
 *   2. UserStore + ensureAdminUser（明文 token 一次性 stdout + 0600 文件，严禁进日志）
 *   3. executors 表 → Driver 池（127.0.0.1/localhost 且无 keyRef = LocalDriver，否则 SshDriver 懒连接）
 *   4. 单例 KeyedMutex / JsonlLocator / ConversationManager（PM 与引擎共用，锁才有互斥意义）
 *   5. createLlmClient + createPmPool
 *   6. NotifyRouter + FeishuChannel（env 配置齐全才 start；缺配置 = 不注册通道，静默跳过）
 *   7. IssueEngine 装配 + watch 循环
 *   8. createApiDispatcher（routes/index.ts 聚合）+ 静态服务 public/ + /healthz
 *   9. 优雅停机：engine.stop(await 在途 tick) → progress.stopAll → flushAll → router.stop →
 *      feishu.stop → driver.close ×N → server/db（M1：引擎先停，driver/db 最后关）
 *
 * 配置来源统一 env MANDO_*：PORT(8802) / BIND(127.0.0.1) / DB(~/.mando/mando.db) /
 * FEISHU_APP_ID+FEISHU_APP_SECRET / LLM_*（agents/llm.ts）/ PERSONA_FILE（agents/pm.ts）。
 */
import type { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { explainMenuForHuman } from '../agents/approval';
import { createLlmClient } from '../agents/llm';
import { createPmPool, migratePmAgent } from '../agents/pm';
import { MessageCounter } from '../core/activity';
import { ensureArtifactSkill, ensureMandoIssueSkill } from '../core/agent-compat';
import { ConversationManager } from '../core/conversations';
import { defaultDbPath, openDb } from '../core/db';
import {
  discoverLocalExecutorDefaults,
  ensureSystemLocalExecutor,
  listExecutors,
  type LocalExecutorDefaults,
} from '../core/executors';
import { JsonlLocator } from '../core/jsonl';
import { AgentJsonlLocator } from '../core/agent-locator';
import { ModelProbe } from '../core/model-probe';
import { AgentSummaryRunner } from '../core/agent-summary';
import { buildHistoryDigest } from '../core/history-digest';
import { SummaryOrchestrator } from '../core/summary-orchestrator';
import { migrate, type MigrationStatus } from '../core/migrate';
import { SessionStore } from '../core/sessions';
import type { Executor, ExecutorStatus } from '../core/types';
import { ensureAdminUser, UserStore } from '../core/users';
import type { ExecutorDriver } from '../executor/driver';
import { LocalDriver } from '../executor/local';
import { withPaneCache } from '../executor/pane-cache';
import { SshDriver } from '../executor/ssh';
import { runClarify } from '../issues/clarify-runner';
import { runOrganize } from '../issues/organize-runner';
import { DRIVING_STATES, getProject, IssueEngine, migrateIssueEngine, type EngineConfig } from '../issues/engine';
import { ModuleDocs } from '../issues/module-docs';
import { ModuleManager, ModuleStore } from '../issues/modules';
import { KeyedMutex } from '../issues/mutex';
import { FeishuChannel, type FeishuConfig } from '../notify/feishu';
import { migrateNotify, NotifyRouter, userByFeishuOpenid } from '../notify/router';
import type { Project } from '../core/types';
import { FeishuOauthClient, type FeishuOauthPort } from './feishu-oauth';
import { authDepsFromDb, createDispatcher } from './middleware';
import { createApiDispatcher } from './routes';
import { actRoutes } from './routes/act';
import { ApprovalPipeline } from './ws/approvals';
import { ChatApprovalWatcher } from './ws/chat-approvals';
import { ProgressBridge } from './ws/progress';
import { createWsHandlers, handleWsUpgrade, type WsData, type WsDeps } from './ws';

// ---------- 选项 / 返回 ----------

export interface ServerOptions {
  /** 监听端口；缺省 env MANDO_PORT，再缺省 8802。传 0 = 随机端口（测试用） */
  port?: number;
  /** 绑定地址；缺省 env MANDO_BIND，再缺省 127.0.0.1（生产走 nginx 反代） */
  bind?: string;
  /** DB 路径；缺省 env MANDO_DB，再缺省 ~/.mando/mando.db */
  dbPath?: string;
  /** 首启 admin 明文 token 的落盘文件（0600）；缺省 env MANDO_ADMIN_TOKEN_FILE，再缺省 ~/.mando/admin-token */
  adminTokenFile?: string;
  /** 静态目录（build-ui 产物）；缺省根目录 public */
  publicDir?: string;
  /** 测试注入：为执行机构造 Driver（缺省按 host/keyRef 规则选 Local/Ssh） */
  driverFactory?: (executor: Executor) => ExecutorDriver;
  /** executors 表为空时的主 Driver（缺省 LocalDriver，控制面=执行机同机） */
  defaultDriver?: ExecutorDriver;
  /** 测试/嵌入式装配注入；缺省自动探测本机 workspace 与 Claude/Codex 能力 */
  localExecutorDefaults?: LocalExecutorDefaults;
  /** 飞书配置：undefined = 读 env；null = 明确禁用 */
  feishu?: FeishuConfig | null;
  /**
   * 是否启动飞书 WS 长连通道（通知/卡片）；缺省 env MANDO_FEISHU_CHANNEL !== 'off'。
   * false = 只启用扫码登录/绑定（OAuth 纯 HTTP）——同一 app 已被其他服务建长连时
   * 再连会分走事件推送，此开关让扫码与通道解耦。
   */
  feishuChannel?: boolean;
  /** 对外基址（OAuth 回调用，如 https://x.y.z）；缺省 env MANDO_PUBLIC_URL，再缺省按请求推导 */
  publicUrl?: string;
  /** 引擎调参（测试缩短 tick 等） */
  engineConfig?: Partial<EngineConfig>;
  /** driver.status → executors.status 的同步周期；缺省 15s */
  statusIntervalMs?: number;
  /** WS 聊天轮询周期；缺省 1200ms（v1 平移；测试调小） */
  wsChatPollMs?: number;
  /** 对话侧自动批准巡检周期（issue #108）；缺省 3s */
  chatApprovalTickMs?: number;
  /** 进度管道批处理窗口秒数（透传 ProgressReporter；缺省 30s） */
  progressThrottleSeconds?: number;
}

export interface MandoServer {
  port: number;
  db: Database;
  migrations: MigrationStatus;
  users: UserStore;
  engine: IssueEngine;
  notify: NotifyRouter;
  /** executorId → Driver 池（懒创建；退出时统一 close） */
  drivers: Map<number, ExecutorDriver>;
  /** 菜单审批管道（Wave3；观测/测试用） */
  approvals: ApprovalPipeline;
  /** 对话侧自动批准巡检（issue #108；观测/测试用） */
  chatApprovals: ChatApprovalWatcher;
  /** 进度管道（Wave3；观测/测试用） */
  progress: ProgressBridge;
  feishuEnabled: boolean;
  stop(): Promise<void>;
}

// ---------- 小工具 ----------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** driver 运行态 → executors.status（LocalDriver 无 status = 本机恒在线） */
export function executorStatusOf(driver: ExecutorDriver): ExecutorStatus {
  const s = (driver as { status?: unknown }).status;
  if (s === undefined) return 'online';
  if (s === 'connected') return 'online';
  if (s === 'closed') return 'offline';
  return 'unknown'; // disconnected/connecting：懒连接尚未使用或退避重连中
}

/** claude_dir（…/.claude/projects）→ 同一 home 下的 ~/.claude.json（trustDir 预置用）；推不出返回 undefined */
export function trustFileOf(claudeProjectsDir: string): string | undefined {
  const m = claudeProjectsDir.replace(/\/+$/, '').match(/^(.*)\/\.claude\/projects$/);
  return m ? `${m[1]}/.claude.json` : undefined;
}

/** claude_dir → 同一 home 下的 ~/.claude 与 ~/.codex（兼容技能安装 + codex 会话发现用） */
export function agentHomesOf(claudeProjectsDir: string): { claudeHome: string; codexHome: string } | undefined {
  const m = claudeProjectsDir.replace(/\/+$/, '').match(/^(.*)\/\.claude\/projects$/);
  return m ? { claudeHome: `${m[1]}/.claude`, codexHome: `${m[1]}/.codex` } : undefined;
}

/** env 读飞书配置：MANDO_FEISHU_APP_ID + MANDO_FEISHU_APP_SECRET 齐全才启用 */
export function feishuConfigFromEnv(): FeishuConfig | null {
  const appId = process.env.MANDO_FEISHU_APP_ID ?? '';
  const appSecret = process.env.MANDO_FEISHU_APP_SECRET ?? '';
  return appId && appSecret ? { appId, appSecret } : null;
}

// ---------- 装配 ----------

export async function startServer(opts: ServerOptions = {}): Promise<MandoServer> {
  // ---- 1. DB + 迁移链（顺序固定；各自幂等，记入同一 schema_migrations） ----
  const db = openDb(opts.dbPath ?? defaultDbPath());
  migrate(db);
  migrateIssueEngine(db);
  migrateNotify(db);
  const migrations = migratePmAgent(db); // 链尾返回全量迁移状态
  ensureSystemLocalExecutor(
    db,
    opts.localExecutorDefaults ?? discoverLocalExecutorDefaults(),
  );

  // ---- 2. 用户 + 登录会话 + 首启 admin 引导 ----
  const users = new UserStore(db);
  const sessions = new SessionStore(db);
  const boot = ensureAdminUser(users);
  if (boot) {
    const f =
      opts.adminTokenFile ??
      process.env.MANDO_ADMIN_TOKEN_FILE ??
      join(homedir(), '.mando', 'admin-token');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${boot.token}\n`, { mode: 0o600 });
    chmodSync(f, 0o600); // 文件已存在时 writeFileSync 的 mode 不生效，补一刀
    // 明文 token 仅此一次输出 stdout + 0600 文件；严禁进任何日志（v1 前科）
    process.stdout.write(
      `[mando] 首启已创建 admin 用户（username=admin）。token 仅显示这一次（已写入 ${f}，0600）：\n${boot.token}\n`,
    );
  }

  // ---- 3. executors 表 → Driver 池 ----
  const drivers = new Map<number, ExecutorDriver>();
  const keysDir = join(homedir(), '.mando', 'keys');
  const buildDriver = (ex: Executor): ExecutorDriver => {
    if (opts.driverFactory) return opts.driverFactory(ex);
    const isLocal = (ex.host === '127.0.0.1' || ex.host === 'localhost') && !ex.keyRef;
    if (isLocal) return new LocalDriver();
    // SshDriver 懒连接：构造不建 TCP，首次调用才握手；断线指数退避自愈
    return new SshDriver({
      host: ex.host,
      port: ex.port,
      username: ex.sshUser,
      privateKeyPath: isAbsolute(ex.keyRef) ? ex.keyRef : join(keysDir, ex.keyRef),
    });
  };
  const driverForExecutor = (ex: Executor): ExecutorDriver => {
    let d = drivers.get(ex.id);
    if (!d) {
      // M6：池层包 capturePane 的 300ms TTL 合并缓存——引擎 tick / WS chat 轮询 /
      // 审批 actOnMenu / act 路由全部经池取 Driver，缓存点唯一才能真正合并多方抓屏。
      d = withPaneCache(buildDriver(ex));
      drivers.set(ex.id, d);
    }
    return d;
  };
  /**
   * M5：执行机登记变更/删除后失效池内缓存——下次 driverForExecutor 按新配置懒建，
   * 不用重启 server（新登记的执行机本来就是懒建，天然可见）。旧 Driver 尽力 close。
   */
  const invalidateDriver = (id: number): void => {
    const d = drivers.get(id);
    if (!d) return;
    drivers.delete(id);
    void Promise.resolve((d as { close?: () => Promise<void> | void }).close?.()).catch((e) =>
      console.error('[mando] 旧 executor driver 关闭失败:', e),
    );
  };

  // 本期单执行机：最小 id 为主执行机，引擎/对话/上传全走它（多机调度 = 后续 wave）
  const bootExecutors = listExecutors(db);
  const primary = bootExecutors[0];
  if (primary) driverForExecutor(primary); // 启动即入池（懒连接），healthz/状态同步立即可见
  const fallbackDriver = primary ? null : withPaneCache(opts.defaultDriver ?? new LocalDriver());
  /**
   * 主 Driver 解析：每次调用现从池里取（M5 配套）。装配期若直接捕获池内实例，admin
   * PATCH 主执行机后 invalidateDriver 会 close 掉它（SshDriver close 是终态），引擎/
   * 对话/PM 将握着死连接直到重启；经门面现解析，热失效后下一次调用即按新配置懒建。
   * 主执行机行被删（仅无项目挂靠时可能）→ 按启动时配置重建，不悄悄换机。
   */
  const resolvePrimary = (): ExecutorDriver => {
    if (!primary) return fallbackDriver!;
    return (
      drivers.get(primary.id) ??
      driverForExecutor(listExecutors(db).find((e) => e.id === primary.id) ?? primary)
    );
  };
  /** 稳定门面：引擎/convs/locator/PM/上传装配期捕获它，实际调用永远打到池内当前实例 */
  const primaryDriver: ExecutorDriver = {
    findExecutable: (agent) => resolvePrimary().findExecutable(agent),
    listSessions: () => resolvePrimary().listSessions(),
    createSession: (name, cwd) => resolvePrimary().createSession(name, cwd),
    killSession: (name) => resolvePrimary().killSession(name),
    sendKeys: (session, text) => resolvePrimary().sendKeys(session, text),
    sendKey: (session, key) => resolvePrimary().sendKey(session, key),
    capturePane: (session) => resolvePrimary().capturePane(session),
    resizeWindow: (session, size) => resolvePrimary().resizeWindow(session, size),
    readFileRange: (path, offset, limit) => resolvePrimary().readFileRange(path, offset, limit),
    statPath: (path) => resolvePrimary().statPath(path),
    listDir: (path) => resolvePrimary().listDir(path),
    writeFile: (path, data, mode) =>
      mode !== undefined
        ? resolvePrimary().writeFile(path, data, mode)
        : resolvePrimary().writeFile(path, data),
    symlink: (target, linkPath) => resolvePrimary().symlink(target, linkPath),
    readlink: (path) => resolvePrimary().readlink(path),
    removeTree: (path) => resolvePrimary().removeTree(path),
    mkdirp: (path) => resolvePrimary().mkdirp(path),
    movePath: (src, dst) => resolvePrimary().movePath(src, dst),
    git: (cwd, args) => resolvePrimary().git(cwd, args),
    openPty: (cmd, cols, rows) => resolvePrimary().openPty(cmd, cols, rows),
  };
  const claudeProjectsDir = primary?.claudeDir ?? join(homedir(), '.claude', 'projects');
  const trustFile = trustFileOf(claudeProjectsDir);

  // 项目 → 其 executor 的 Driver（WS 终端/act/审批注入用；executor 缺失回退主 Driver）
  const driverForProject = (p: Project): ExecutorDriver => {
    const ex = listExecutors(db).find((e) => e.id === p.executorId);
    return ex ? driverForExecutor(ex) : primaryDriver;
  };

  // ---- 4. 单例互斥/定位/对话（PM 与引擎必须共用同一 mutex 实例，锁才有互斥意义） ----
  const mutex = new KeyedMutex();
  const derivedHomes = agentHomesOf(claudeProjectsDir);
  const homes = derivedHomes ?? {
    claudeHome: join(homedir(), '.claude'),
    codexHome: join(homedir(), '.codex'),
  };
  const claudeLocator = new JsonlLocator(primaryDriver, claudeProjectsDir);
  // 双代理定位器：claude 透传，codex 按 launch_ts+cwd 从 rollout 发现（consumer 全走结构化 {locate}）
  const locator = new AgentJsonlLocator(db, primaryDriver, claudeLocator, `${homes.codexHome}/sessions`);
  // 「这条对话现在用哪个模型」（issue #109）：读会话 jsonl 尾窗，与引擎/WS 同源同定位器
  const modelProbe = new ModelProbe(primaryDriver, locator);
  const convs = new ConversationManager(db, primaryDriver, locator, {
    ...(trustFile ? { trustFile } : {}),
    codexConfigFile: `${homes.codexHome}/config.toml`,
    claudeHome: homes.claudeHome,
    codexHome: homes.codexHome,
  });
  // 内置全局技能：产物一律落当前工作目录（图片/网页等能进项目文件列表被预览）——随服务启动装到
  // 主执行机 ~/.claude 与 ~/.codex 的 skills/（缺失才写，claude+codex 共用；best-effort 不阻塞启动）。
  // 仅在能从执行机 claude_dir 推出真实家目录时装；推不出（退化/测试装配）跳过，免污染兜底 homedir。
  if (derivedHomes) {
    void ensureArtifactSkill(primaryDriver, derivedHomes).catch((e) =>
      console.error('[mando] 内置技能 artifacts-to-cwd 安装失败（best-effort）:', e),
    );
    void ensureMandoIssueSkill(primaryDriver, derivedHomes).catch((e) =>
      console.error('[mando] 内置技能 mando-issue 安装失败（best-effort）:', e),
    );
  }

  // ---- 5. LLM + PM 管家池 ----
  const llm = createLlmClient(db);
  const pmFor = createPmPool({ driver: primaryDriver, llm, users, convs, locator, mutex, db });
  const moduleStore = new ModuleStore(db);
  const modulesFor = (project: Project) =>
    new ModuleManager(moduleStore, {
      suggest: (input) => pmFor(project).suggestModule(input),
      docs: new ModuleDocs(driverForProject(project), project.cwd),
    });

  // 「Agent 认知总结」后台编排：digest 走共享 locator + 主 Driver 读 jsonl（与引擎/WS 同源）；
  // runner 在项目所在执行机的 sum-<id> 会话里跑（driverForProject）。启动即清「卡在 running」的僵尸态。
  const summaryOrchestrator = new SummaryOrchestrator({
    db,
    buildDigest: (project) =>
      buildHistoryDigest({ db, reader: primaryDriver, locator }, project.id),
    runSummary: (project, agent, historyDigest, target) =>
      new AgentSummaryRunner({ driver: driverForProject(project) }).run({
        projectId: project.id,
        cwd: project.cwd,
        agent,
        historyDigest,
        projectName: project.name,
        ...(target ? { target } : {}),
      }),
  });
  summaryOrchestrator.resetStale();

  // 用户消息计数（013）：全站唯一实例，接到所有「用户发出一条消息」的入口
  // （WS chat 文本帧 / POST act / issue 澄清答复 / 飞书入站问答），供 admin 用户表统计。
  const messages = new MessageCounter(db);

  // ---- 6. 通知路由 + 飞书通道（配置齐全才 start；缺配置 = 不注册，dispatch 静默跳过） ----
  const notify = new NotifyRouter(db);
  let engine: IssueEngine; // 先声明：feishu 卡点回调闭包引用（下面 7 再赋值）
  let approvals: ApprovalPipeline; // 先声明：feishu 选择卡回调 + 引擎 onMenu 钩子闭包引用
  let chatApprovals: ChatApprovalWatcher; // 对话侧自动批准巡检（issue #108）
  let progress: ProgressBridge; // 先声明：引擎 onConvMessages 钩子闭包引用
  let feishu: FeishuChannel | null = null;

  const handleFeishuInbound = async (openid: string, text: string): Promise<void> => {
    try {
      // `#<项目id|项目名> 问题…` → 定位项目 → 项目 PM 应答
      const pid = await notify.routeInbound('feishu', openid, text);
      if (!pid || !feishu) return;
      const user = userByFeishuOpenid(db, openid);
      const project = getProject(db, pid);
      if (!user || !project) return;
      const q = text.trim().replace(/^#\S+\s*/, '');
      if (!q) return;
      messages.bump(user.id); // 飞书上问 PM 也是「用户发了一条消息」
      const answer = await pmFor(project).answerQuestion(user.id, q);
      await feishu.sendText({ userId: user.id, address: openid }, answer);
    } catch (e) {
      console.error('[mando] 飞书入站处理失败:', e);
    }
  };

  const feishuCfg = opts.feishu !== undefined ? opts.feishu : feishuConfigFromEnv();
  // 扫码登录/绑定只依赖 app 凭据（纯 HTTP），与 WS 长连通道解耦
  const feishuOauth: FeishuOauthPort | null = feishuCfg ? new FeishuOauthClient(feishuCfg) : null;
  const channelOn = opts.feishuChannel ?? process.env.MANDO_FEISHU_CHANNEL !== 'off';
  if (feishuCfg && channelOn) {
    const ch = new FeishuChannel(feishuCfg, {
      db,
      decideGate: (g, u, a, n) => engine.decideGate(g, u, a, n),
      onInbound: (openid, text) => void handleFeishuInbound(openid, text),
      // 审批升级卡（v1 选择卡协议）回调 → 消费即焚 + 重抓菜单核对 menuSig 再注入
      onSelection: (requestId, idx, openid) =>
        void approvals
          .consumeFromCard(requestId, idx, openid)
          .catch((e) => console.error('[mando] 选择卡回调处理失败:', e)),
    });
    try {
      await ch.start();
      notify.register(ch);
      feishu = ch;
    } catch (e) {
      console.error('[mando] 飞书通道启动失败（本次不注册，通知静默跳过）:', e);
    }
  }

  // ---- 7. issue 引擎 + watch 循环（Wave3：菜单审批 onMenu / 进度 onConvMessages 钩子接线） ----
  engine = new IssueEngine({
    db,
    driver: primaryDriver,
    convs,
    locator,
    pmFor,
    notify,
    mutex,
    modulesFor,
    // 创建时澄清：clr-<issueId> 一次性独立会话（按项目所在执行机取 Driver）
    clarify: (project, input) => runClarify({ driver: driverForProject(project) }, input),
    // 模块智能整理：org-<projectId> 一次性独立会话（手动触发，扫全部 issue + 代码库出方案）
    organize: (project, input) => runOrganize({ driver: driverForProject(project) }, input),
    onMenu: (ctx) => approvals.onMenu(ctx),
    onMenuGone: (session) => approvals.menuGone(session),
    onConvMessages: (issue, project, msgs) => progress.onConvMessages(issue, project, msgs),
    ...(opts.engineConfig ? { config: opts.engineConfig } : {}),
  });

  // ---- 7b. 菜单审批管道 + 进度管道 ----
  approvals = new ApprovalPipeline({
    db,
    llm,
    mutex, // 与引擎/PM 同一把锁（评审 H9 单一驾驶员）
    pmFor,
    driverFor: driverForProject,
    subs: notify.subscriptions,
    notify,
    feishu, // 无飞书通道时升级卡退化为 NotifyRouter 文本
    log: (issueId, kind, data) => engine.store.logEvent(issueId, kind, data),
  });
  // 对话侧自动批准巡检（issue #108）：引擎只看驱动中的 issue 会话，独立聊天对话
  // （chat-<convId>）不在它视野里，档位靠这条服务端巡检才能在没人开网页时生效。
  chatApprovals = new ChatApprovalWatcher({
    db,
    llm,
    mutex, // 与引擎/PM/WS 同一把锁
    driverFor: driverForProject,
    ...(opts.chatApprovalTickMs !== undefined ? { tickMs: opts.chatApprovalTickMs } : {}),
  });
  progress = new ProgressBridge({
    pmFor,
    notify,
    ...(opts.progressThrottleSeconds !== undefined
      ? { throttleSeconds: opts.progressThrottleSeconds }
      : {}),
  });

  engine.start(); // reporter 挂引擎生命周期：引擎起 tick 才产事件，停机时 progress.stopAll()
  chatApprovals.start();
  let engineRunning = true;

  // ---- 8. 路由聚合 + 静态 + healthz ----
  const publicUrl = opts.publicUrl ?? process.env.MANDO_PUBLIC_URL;
  const dispatch = createApiDispatcher({
    db,
    users,
    engine,
    modules: moduleStore,
    driver: primaryDriver,
    driverFor: (ex) => driverForExecutor(ex),
    previewDriverFor: (ex) => buildDriver(ex),
    driverForProject, // files/git 浏览、技能安装按项目所在执行机取 Driver
    llm, // 技能市场 驱动大模型 富化（与 PM 池共享并发闸）
    onExecutorChanged: invalidateDriver, // M5：admin 改/删执行机后热失效 Driver 池
    convs,
    mutex, // 对话模式 conversations 路由 activate/archive 用（与引擎/PM/act/WS 同一把锁）
    models: modelProbe, // 对话/issue 详情页显示「正在用哪个模型」
    subs: notify.subscriptions,
    feishu,
    sessions,
    feishuOauth,
    publicUrl,
    notify,
    summaryOrchestrator,
    messages, // issue 澄清答复计入用户消息数
    // waiting_input 派生标记：弹窗升级人工未处理（审批管道登记未消费）∪ 菜单滞留超时。
    // 只认驱动中的 issue（登记有 30min TTL，issue 已终结/取消的残留不该再亮）。
    waitingInput: (issue) =>
      DRIVING_STATES.includes(issue.status) &&
      (approvals.waitingIssueIds().has(issue.id) || engine.menuStuck(issue)),
    waitingIssueIds: () => {
      const s = approvals.waitingIssueIds();
      for (const id of engine.menuStuckIssueIds()) s.add(id);
      return s;
    },
  });
  // /api/projects/:projectId/act（Wave3；与 WS 帧同语义的可靠 HTTP 版）
  const dispatchAct = createDispatcher(
    actRoutes({ db, convs, mutex, driverForProject, approvals, messages }),
    authDepsFromDb(db, users, sessions),
  );

  // WS 挂载（Wave3 任务 A/B）：/ws/term/:projectId + /ws/chat/:projectId
  const wsDeps: WsDeps = {
    db,
    users,
    sessions,
    convs,
    locator,
    mutex,
    reader: primaryDriver, // jsonl 读取与引擎/locator 同源
    driverForProject,
    approvals,
    messages, // chat 文本帧计入用户消息数
    // 菜单解读（issue #112「解释一下」）：点了才调，issue 执行页与独立对话共用这一条 WS
    explain: async ({ projectId, context, options, multiSelect }) => {
      const project = getProject(db, projectId);
      if (!project) return null;
      return explainMenuForHuman(llm, {
        label: project.name,
        context,
        options,
        multiSelect,
        systemPrefix: pmFor(project).systemPrompt(),
      });
    },
    ...(opts.wsChatPollMs !== undefined ? { chatPollMs: opts.wsChatPollMs } : {}),
  };

  const publicDir = opts.publicDir ?? join(import.meta.dir, '..', '..', 'public');
  const serveStatic = async (pathname: string): Promise<Response | null> => {
    if (pathname.includes('..') || pathname.includes('\0')) return null; // 双保险（Bun 已归一化 URL）
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    // 「像文件」：/assets/ 下、或最后一段带扩展名。这类缺失直接 404，绝不回退 index.html——
    // 否则被删掉的旧 hash chunk（/assets/xxx.js）会拿到 text/html，module import() 触发 MIME 报错。
    const seg = rel.slice(rel.lastIndexOf('/') + 1);
    const fileLike = pathname.startsWith('/assets/') || seg.includes('.');
    // /assets/* 是 Vite 带 hash 的产物、内容不变 → 可长缓存 immutable；
    // 其余（index.html、根图标）走 no-cache，每次校验，发版即时生效、不再拿旧 index。
    const cacheHeader = pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    const f = Bun.file(join(publicDir, rel));
    if (await f.exists()) {
      return new Response(f, {
        headers: { 'content-type': f.type || 'application/octet-stream', 'cache-control': cacheHeader },
      });
    }
    if (fileLike) return null; // 缺失的静态资源 → 外层 404（不回退 index.html）

    // SPA 回退：仅无扩展名的导航路径交给前端路由（hash 路由下极少走到，直链兜底用）
    const index = Bun.file(join(publicDir, 'index.html'));
    if (await index.exists()) {
      return new Response(index, { headers: { 'content-type': index.type || 'text/html', 'cache-control': 'no-cache' } });
    }
    return null;
  };

  // driver.status → executors.status 周期映射（含启动即刻一次）
  const syncExecutorStatus = (): void => {
    try {
      for (const ex of listExecutors(db)) {
        const d = drivers.get(ex.id);
        const status: ExecutorStatus = d ? executorStatusOf(d) : 'unknown';
        if (status !== ex.status) {
          db.query('UPDATE executors SET status = ? WHERE id = ?').run(status, ex.id);
        }
      }
    } catch (e) {
      console.error('[mando] executor status 同步失败:', e);
    }
  };
  syncExecutorStatus();
  const statusTimer = setInterval(syncExecutorStatus, opts.statusIntervalMs ?? 15_000);

  const healthz = (): Response => {
    const executors = listExecutors(db).map((ex) => ({
      id: ex.id,
      name: ex.name,
      status: drivers.has(ex.id) ? executorStatusOf(drivers.get(ex.id)!) : ex.status,
    }));
    // M2：ok 反映主执行能力——引擎在跑 且 执行机没有全体 offline
    // （无登记执行机 = 本机 defaultDriver 模式，视为可用）。HTTP 恒 200，监控读 ok 字段。
    const allOffline = executors.length > 0 && executors.every((e) => e.status === 'offline');
    return json({
      ok: engineRunning && !allOffline,
      db: { applied: migrations.applied.length, latest: migrations.latest },
      executors,
      engine: { running: engineRunning, driving: engine.store.listDriving().length },
      feishu: feishu !== null,
    });
  };

  const server = Bun.serve<WsData>({
    hostname: opts.bind ?? process.env.MANDO_BIND ?? '127.0.0.1',
    port: opts.port ?? Number(process.env.MANDO_PORT ?? 8802),
    async fetch(req, srv): Promise<Response | undefined> {
      const url = new URL(req.url);

      if (url.pathname === '/healthz') return healthz();

      // WS 挂载（Wave3）：upgrade 前 resolveUser + 项目属主/admin 鉴权（ws/index.ts）
      if (url.pathname.startsWith('/ws/')) {
        const w = await handleWsUpgrade(req, url, srv, wsDeps);
        if (w !== null) return w; // Response=拒绝；undefined=已升级
        return json({ ok: false, error: 'not found' }, 404);
      }

      // 对话模式 conversations 路由（列表/新建/激活/归档/重命名）已并入 createApiDispatcher（routes/index.ts）

      const r = dispatch(req);
      if (r) return r;
      const ra = dispatchAct(req);
      if (ra) return ra;

      if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        const s = await serveStatic(url.pathname);
        if (s) return s;
      }
      return json({ ok: false, error: 'not found' }, 404);
    },
    websocket: createWsHandlers(wsDeps),
  });

  // ---- 9. 优雅停机（M1：先停引擎并等在途 tick 归还，driver/db 最后关）----
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(statusTimer);
    await engine.stop(); // M1：await 在途 tick 归还——之后不再有引擎侧执行机/db 调用
    await chatApprovals.stop(); // 同理：等在途巡检归还，之后不再有它侧的执行机/db 调用
    engineRunning = false;
    progress.stopAll(); // 进度 reporter 挂引擎生命周期（引擎停了再清定时器）
    await notify.flushAll(); // 引擎已停，冲掉聚合缓冲里最后一批通知
    notify.stop();
    if (feishu) await feishu.stop();
    for (const d of drivers.values()) {
      await (d as { close?: () => Promise<void> | void }).close?.(); // SshDriver 终态；LocalDriver 无需
    }
    server.stop(true);
    db.close();
  };

  return {
    port: server.port ?? 0,
    db,
    migrations,
    users,
    engine,
    notify,
    drivers,
    approvals,
    chatApprovals,
    progress,
    feishuEnabled: feishu !== null,
    stop,
  };
}

if (import.meta.main) {
  const s = await startServer();
  console.log(
    `mando listening on :${s.port}（迁移 latest=${s.migrations.latest}，执行机 ${s.drivers.size} 台，飞书=${s.feishuEnabled ? 'on' : 'off'}）`,
  );
  const shutdown = async (sig: string): Promise<void> => {
    console.log(`[mando] 收到 ${sig}，优雅停机…`);
    await s.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * web/routes —— 全部路由工厂的聚合点（集成接线，spec §9）。
 * 各域模块只 export 自己的 RouteDef[] 工厂；这里按 createDispatcher 约定统一编排：
 *   auth（登录/登出/me）→ me（我的设定）→ admin（用户/执行机/归属/活跃）→
 *   projects（CRUD+属主自动订阅）→ issues（CRUD/卡点/时间线）→
 *   uploads（截图落执行机）→ files（文件浏览/编辑/上传下载）→ git（提交图概览）→
 *   subscriptions（订阅+飞书绑定）
 * 鉴权在 middleware.runRoute 统一执行（默认 deny），未命中路由返回 null（调用方 404）。
 *
 * Wave3 挂载点（本 wave 不做，见 server.ts fetch 内注释）：
 *   - conversations 视图 / /api/act 注入路由
 *   - WS 终端（Driver.openPty → xterm）与 WS 聊天
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient } from '../../agents/llm';
import type { MessageBumper } from '../../core/activity';
import type { SessionStore } from '../../core/sessions';
import type { SkillsDriver } from '../../core/skills';
import type { AgentKind, Conversation, Executor, Project } from '../../core/types';
import type { UserStore } from '../../core/users';
import type { UploadFs } from '../../core/uploads';
import type { ExecutorDriver } from '../../executor/driver';
import type { SummaryTarget } from '../../core/agent-summary';
import type { EngineIssue, IssueEngine } from '../../issues/engine';
import type { KeyedMutex } from '../../issues/mutex';
import type { ModuleStore } from '../../issues/modules';
import type { SubscriptionStore } from '../../notify/router';
import type { FeishuOauthPort } from '../feishu-oauth';
import { authDepsFromDb, createDispatcher, type RouteDef } from '../middleware';
import { adminRoutes } from './admin';
import { authRoutes } from './auth';
import { conversationsRoutes, type ConvManagerPort, type ConvModelPort } from './conversations';
import { executorsRoutes } from './executors';
import { feishuOauthRoutes } from './feishu-oauth';
import { filesRoutes, type FilesDriver } from './files';
import { gitRoutes, type GitDriver } from './git';
import { greetingRoutes } from './greeting';
import { issuesRoutes } from './issues';
import { llmStatusRoutes } from './llm-status';
import { meRoutes } from './me';
import { projectsRoutes, type CwdMigrateDriver } from './projects';
import { skillsRoutes } from './skills';
import { subscriptionsRoutes, type FeishuBindVerifier } from './subscriptions';
import { uploadsRoutes } from './uploads';

/** 聚合所有路由工厂需要的依赖全集（server.ts 装配后传入） */
export interface ApiDeps {
  db: Database;
  users: UserStore;
  engine: IssueEngine;
  modules?: ModuleStore;
  /** 主执行机 Driver（uploads 落盘用；多执行机路由是后续 wave） */
  driver: UploadFs;
  /**
   * 按执行机取 Driver（admin 建用户 provision workspace / 执行机探查 / tmux 导入 /
   * 技能全局安装用）；无可用连接返回 null。生产传完整 ExecutorDriver，结构接口天然满足。
   */
  driverFor(executor: Executor): ExecutorDriver | null;
  /** 尚未保存的执行机草稿使用的一次性 Driver；不得进入 executor id 连接池。 */
  previewDriverFor?(executor: Executor): ExecutorDriver | null;
  /**
   * 按项目取 Driver（files/git 浏览、技能安装、cwd 迁移用；executor 缺失回退主 Driver，
   * server.ts 同名函数）。生产传完整 ExecutorDriver，结构交集天然满足。
   */
  driverForProject(project: Project): FilesDriver & GitDriver & SkillsDriver & CwdMigrateDriver;
  /** LLM 客户端（技能市场 驱动大模型 富化用；与 PM 池共享并发闸） */
  llm: LlmClient;
  /** M5：执行机登记变更/删除后回调（server 据此失效 Driver 池缓存，热加载不重启） */
  onExecutorChanged?(executorId: number): void;
  /**
   * 对话管理（建项目 withConversation + 对话模式 conversations 路由用；ConversationManager 结构兼容）。
   * 类型放宽到 ConvManagerPort（含 listChats/activate/archive/rename/sessionName），projects 路由
   * 仍只用其中的 create（结构子集，天然满足）。
   */
  convs?: ConvManagerPort;
  /** tmux 注入锁（对话模式 activate/archive 用；与引擎/PM/act/WS 同一实例才有互斥意义） */
  mutex?: KeyedMutex;
  /** 对话当前模型探测（core/model-probe.ModelProbe）；缺省 = model 接口恒 null */
  models?: ConvModelPort;
  /** 订阅存储（NotifyRouter.subscriptions） */
  subs: SubscriptionStore;
  /** 飞书通道（未配置传 null → 绑定接口 503，其余照常） */
  feishu: FeishuBindVerifier | null;
  /** 登录会话存储（飞书扫码登录签发；resolveUser 兜底查找） */
  sessions: SessionStore;
  /** 飞书 OAuth 客户端（未配置 app 凭据传 null → 扫码接口 503/按钮不显示） */
  feishuOauth: FeishuOauthPort | null;
  /** 对外基址（MANDO_PUBLIC_URL；缺省按请求 Host 推导 OAuth 回调地址） */
  publicUrl?: string | undefined;
  /** 通知钩子：建项目自动订阅属主（NotifyRouter 结构兼容） */
  notify?: { ensureOwnerSubscription(projectId: number, ownerUserId: number): unknown };
  /** waiting_input 派生标记（弹窗升级人工未处理/菜单滞留；见 issuesRoutes）；缺省恒 false */
  waitingInput?(issue: EngineIssue): boolean;
  /** 用户消息计数（013 user_message_counts）：目前给 issues 的澄清答复用；缺省不接 = 不统计 */
  messages?: MessageBumper;
  /** 在等人工输入的 issue id 集合（projects summary 把它们补进待确认角标）；缺省不补 */
  waitingIssueIds?(): Set<number>;
  /** 「Agent 认知总结/记忆」后台任务编排（core/summary-orchestrator；缺省 = claude/codex 模式 503） */
  summaryOrchestrator?: {
    start(
      project: Project,
      agent: AgentKind,
      target?: SummaryTarget,
    ): { started: true } | { started: false; reason: 'busy' };
  };
}

/** 全部 RouteDef 平铺（顺序即匹配顺序；路径互不冲突，顺序仅影响查找） */
export function allRoutes(deps: ApiDeps): RouteDef[] {
  return [
    ...authRoutes({ users: deps.users }),
    ...meRoutes({ users: deps.users }),
    ...llmStatusRoutes({ db: deps.db }),
    ...greetingRoutes({ db: deps.db, llm: deps.llm }),
    ...adminRoutes({
      db: deps.db,
      users: deps.users,
      driverFor: deps.driverFor,
      ...(deps.previewDriverFor ? { previewDriverFor: deps.previewDriverFor } : {}),
      ...(deps.onExecutorChanged ? { onExecutorChanged: deps.onExecutorChanged } : {}),
    }),
    ...executorsRoutes({ db: deps.db, driverFor: deps.driverFor }),
    ...projectsRoutes({
      db: deps.db,
      convs: deps.convs,
      notify: deps.notify,
      driverFor: deps.driverFor,
      llm: deps.llm,
      driverForProject: deps.driverForProject,
      fullDriverForProject: deps.driverForProject,
      summaryOrchestrator: deps.summaryOrchestrator,
      ...(deps.waitingIssueIds ? { waitingIssueIds: deps.waitingIssueIds } : {}),
    }),
    ...issuesRoutes({
      db: deps.db,
      engine: deps.engine,
      ...(deps.modules ? { modules: deps.modules } : {}),
      ...(deps.messages ? { messages: deps.messages } : {}),
      usernameById: (id) => deps.users.byId(id)?.username ?? null,
      ...(deps.waitingInput ? { waitingInput: deps.waitingInput } : {}),
    }),
    // 对话模式：chat 对话列表/新建/激活/归档/重命名（convs+mutex 齐全才挂，离线/测试装配可缺）
    ...(deps.convs && deps.mutex
      ? conversationsRoutes({
          db: deps.db,
          convs: deps.convs,
          mutex: deps.mutex,
          ...(deps.models ? { models: deps.models } : {}),
        })
      : []),
    ...uploadsRoutes({ db: deps.db, driver: deps.driver }),
    ...filesRoutes({ db: deps.db, driverForProject: deps.driverForProject }),
    ...gitRoutes({
      db: deps.db,
      driverForProject: deps.driverForProject,
      llm: deps.llm, // AI 助读（总结/解释/风险/生成提交信息），与 PM 池/技能市场共享并发闸
      ...(deps.mutex ? { mutex: deps.mutex } : {}), // Git 写操作与引擎复用同一项目级串行锁实例

      // 本 issue 的 git 现场：分支取 issue.branch（进 implementing 时记下的开发者当前分支）。
      // 引擎不建/不切分支，同一分支上会连续做多个 issue——故靠 impl_base（起点）/impl_tip（终点）
      // 把范围收到本 issue 自己的提交，而不是拿整条分支和 base 对比：
      //  · startSha=impl_base（动手前的分支 tip）；
      //  · endSha=impl_tip，仅当本 issue 已定格（非 implementing/testing）时才给——推进中用分支 tip。
      issueGitRef: (projectId, issueId) => {
        const i = deps.engine.store.get(issueId);
        if (!i || i.projectId !== projectId) return null;
        const startSha = deps.engine.implBaseSha(issueId) ?? undefined;
        const running = i.status === 'implementing' || i.status === 'testing';
        const endSha = !running ? (deps.engine.implTipSha(issueId) ?? undefined) : undefined;
        // 工作树归属：执行中与评审中（merge_review 人工模式下改动未必已 commit）的 issue
        // 持有项目工作树（同项目同时只有一条在跑）——视图据此附带未提交改动。
        const active = running || i.status === 'merge_review';
        return {
          branch: i.branch ?? '', // 未起跑（无分支记录）→ 空，git.ts 判定 exists:false
          base: deps.engine.baseBranch,
          ...(startSha ? { startSha } : {}),
          ...(endSha ? { endSha } : {}),
          ...(active ? { active: true } : {}),
          // 耐久快照兜底：分支被删/范围锚失效时 git.ts 用它回填视图（惰性，命中兜底才读）
          snapshot: () => deps.engine.implCommits(issueId),
        };
      },
    }),
    ...skillsRoutes({
      db: deps.db,
      llm: deps.llm,
      driverForProject: deps.driverForProject,
      driverFor: deps.driverFor,
    }),
    ...subscriptionsRoutes({ db: deps.db, users: deps.users, subs: deps.subs, feishu: deps.feishu }),
    ...feishuOauthRoutes({
      db: deps.db,
      users: deps.users,
      sessions: deps.sessions,
      oauth: deps.feishuOauth,
      publicUrl: deps.publicUrl,
    }),
  ];
}

/** 编好鉴权的 API 调度器：命中 → 鉴权 → handler；未命中 → null（调用方 404/静态兜底） */
export function createApiDispatcher(deps: ApiDeps): (req: Request) => Promise<Response> | null {
  return createDispatcher(allRoutes(deps), authDepsFromDb(deps.db, deps.users, deps.sessions));
}

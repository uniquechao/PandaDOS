/**
 * core/types —— 领域类型（对应 SQLite 数据模型，spec §4）。
 * 依赖方向最内层：不 import 任何其他业务模块。
 */

// ---------- 用户 ----------

export type UserRole = 'admin' | 'user';

export interface User {
  id: number;
  username: string;
  /** sha256(token)，不存明文（v1 安全债在 v2 还掉） */
  tokenHash: string;
  role: UserRole;
  feishuOpenid: string | null;
  createdTs: number;
  lastLoginTs: number | null;
  /** 最后使用时间（012）：认证成功即 touch，store 内节流 ≥5min 写一次；NULL = 尚未活动 */
  lastSeenTs: number | null;
}

export interface UserSettings {
  userId: number;
  persona: string | null;
  memory: string | null;
  autopilotDefault: boolean;
  /** JSON 字符串：通知偏好（渠道/节流等） */
  notifyPref: string | null;
}

// ---------- 执行机 ----------

export type ExecutorStatus = 'unknown' | 'online' | 'offline';

export interface Executor {
  id: number;
  name: string;
  host: string;
  port: number;
  sshUser: string;
  /** 控制面私钥绝对路径，或 ~/.mando/keys/ 下的引用名；私钥内容不进 DB */
  keyRef: string;
  workspaceRoot: string;
  claudeDir: string;
  codexDir: string;
  supportsClaude: boolean;
  supportsCodex: boolean;
  isSystemLocal: boolean;
  capabilitiesCheckedTs: number | null;
  status: ExecutorStatus;
}

// ---------- 执行代理 ----------

/** issue/对话由哪个 CLI 代理驱动（031 迁移）；执行机上需装对应 CLI */
export type AgentKind = 'claude' | 'codex';

/**
 * 弹窗「自动批准」档位（014 = 对话侧 / 038 = issue 侧；两份互不影响）：
 * - 'cautious'：只自动点信任目录弹窗与 CLI 自带「(推荐)」项，其余一律等人工（对话侧默认）；
 * - 'medium'：分级判定——安全可逆自动批，危险不可逆转人工（issue 侧默认 = 现有行为）；
 * - 'auto'：危险不可逆（删数据/强推改历史/部署上线/改生产密钥/关机重启）仍转人工，
 *           其余直接选同意项、不再问 LLM。
 * 多选/交互表单三档都转人工——它驱动不了且会死循环（见 agents/approval-policy）。
 */
export type AutoApproveLevel = 'cautious' | 'medium' | 'auto';

/**
 * 入参归一（HTTP/前端唯一校验点）：认得的三档原样返回，其余一律 null 让调用方回 400。
 * **别在这里兜底成某一档**——档位是安全语义，把打错的字悄悄当成「全自动」是最坏的失败方式。
 */
export function parseAutoApproveLevel(v: unknown): AutoApproveLevel | null {
  return v === 'cautious' || v === 'medium' || v === 'auto' ? v : null;
}

// ---------- 项目 / 对话 ----------

export type ProjectStatus = 'active' | 'archived';

/**
 * 项目类型（009 迁移）：
 * 'issue' = issue 看板驱动开发（默认，向后兼容存量项目）；
 * 'chat'  = 纯对话模式——不建 issue，维护多条独立对话，AI 代理产物直接落项目 cwd。
 * 对话（conversations.kind）复用同一取值：'issue'=引擎绑定执行会话；'chat'=独立聊天会话。
 */
export type ProjectKind = 'issue' | 'chat';

/**
 * 「Agent 认知总结」后台任务态（007 迁移 summary_status）：
 * idle=从未跑/空闲；running=生成中；done=已完成；error=失败（详见 summaryError）。
 */
export type SummaryStatus = 'idle' | 'running' | 'done' | 'error';

export interface Project {
  id: number;
  name: string;
  executorId: number;
  cwd: string;
  ownerUserId: number;
  pmPersona: string | null;
  goal: string | null;
  status: ProjectStatus;
  createdTs: number;
  /** 项目归属的执行机 Linux 用户名（003 迁移；'' = 跟随执行机连接用户） */
  runUser: string;
  /** README 自动简介（005 迁移；core/readme-summary.ts 按天生成，null = 尚未生成） */
  readmeSummary: string | null;
  /**
   * 项目工作分支（006 迁移）。引擎默认就在开发者**当前所在的分支**上干活（不建/不切/不合并分支——
   * 分支与 MR 由开发者在 GitLab 侧管理）；此字段仅作兜底：读不到当前分支（detached HEAD）时用它当分支名。
   */
  workBranch: string | null;
  /** Agent（claude/codex）读历史会话+代码库产出的项目认知长文（007 迁移；null = 尚未生成） */
  understanding: string | null;
  /** 生成上面认知的 CLI 代理（007 迁移；null = 尚未生成） */
  understandingAgent: AgentKind | null;
  /** 上次成功生成认知的时间戳（007 迁移；null = 尚未生成） */
  understandingTs: number | null;
  /** 「Agent 认知总结」后台任务态（007 迁移） */
  summaryStatus: SummaryStatus;
  /** 任务失败原因（007 迁移；summaryStatus='error' 时有值，否则 null） */
  summaryError: string | null;
  /**
   * 手动确认开关（008 迁移；默认 false = 全自动流）：开启才走 plan_review / merge_review
   * 卡点等人批准；关闭时计划自动确认直接开工、测试通过自动 commit/push 后直接 done。
   */
  manualReview: boolean;
  /** 项目类型（009 迁移；默认 'issue'）：'issue'=issue 看板；'chat'=纯对话模式 */
  kind: ProjectKind;
}

export interface Conversation {
  /** claude：= session-id；codex：仅内部 id（真实 session id 启动后发现，见 agent_session_id 列） */
  id: string;
  projectId: number;
  label: string | null;
  createdTs: number;
  archived: boolean;
  /** 驱动本对话的 CLI 代理（031 迁移；对话生命周期内不变） */
  agent: AgentKind;
  /**
   * 对话类型（009 迁移；默认 'issue'）：'issue'=issue 引擎绑定的执行会话（共用 cc-<pid>）；
   * 'chat'=独立聊天会话（每对话独立 tmux 会话 `chat-<convId>`，各自常驻可并存）。
   */
  kind: ProjectKind;
  /** 对话最近活跃（激活/收发）时刻（009 迁移；毫秒；null=从未激活），供对话列表按最近使用排序 */
  lastActiveTs: number | null;
  /** 本对话的弹窗自动批准档位（014 迁移；默认 'cautious' = 现状全部等人点） */
  autoApprove: AutoApproveLevel;
}

// ---------- Project Module ----------

export type ModuleSource = 'auto' | 'manual' | 'legacy';
export type ModuleStatus = 'active' | 'archived';
export type ModuleSyncStatus = 'ready' | 'error';

/** 项目内共享模块：固定一种代理、绑定一条可恢复的逻辑会话。 */
export interface ProjectModule {
  id: number;
  projectId: number;
  slug: string;
  displayName: string;
  agent: AgentKind;
  source: ModuleSource;
  status: ModuleStatus;
  conversationId: string | null;
  syncStatus: ModuleSyncStatus;
  syncError: string | null;
  createdBy: number | null;
  createdTs: number;
  lastUsedTs: number | null;
}

// ---------- Issue ----------

export type IssueCategory = 'task' | 'design' | 'debug';

/** Issue 生命周期状态（spec §5），状态机转换逻辑见 src/issues/machine.ts */
export type IssueState =
  | 'pending'
  | 'clarifying'
  | 'planning'
  | 'plan_review'
  | 'implementing'
  | 'testing'
  | 'merge_review'
  | 'merging'
  | 'done'
  | 'blocked'
  | 'cancelled';

export interface Issue {
  id: number;
  projectId: number;
  title: string;
  body: string | null;
  category: IssueCategory;
  status: IssueState;
  /** 正式模块实体；旧数据迁移完成前允许为空。 */
  moduleId?: number | null;
  convId: string | null;
  planJson: string | null;
  subtasksJson: string | null;
  subIndex: number;
  branch: string | null;
  note: string | null;
  imagesJson: string | null;
  createdBy: number | null;
  createdTs: number;
  doneTs: number | null;
}

export interface IssueEvent {
  id: number;
  issueId: number;
  kind: string;
  dataJson: string | null;
  ts: number;
}

// ---------- 卡点 ----------

export type GateKind = 'plan' | 'merge_review';
export type GateStatus = 'waiting' | 'approved' | 'rejected';

export interface Gate {
  id: number;
  issueId: number;
  kind: GateKind;
  status: GateStatus;
  payloadJson: string | null;
  decidedBy: number | null;
  decidedTs: number | null;
}

// ---------- 订阅 / tmux 会话属主 ----------

export type SubscriptionScope = 'project' | 'issue';

export interface Subscription {
  id: number;
  userId: number;
  scope: SubscriptionScope;
  targetId: number;
  createdTs: number;
}

/** tmux 会话登记（取代 v1 ownership.json） */
export interface SessionRow {
  name: string;
  executorId: number;
  projectId: number;
  ownerUserId: number;
}

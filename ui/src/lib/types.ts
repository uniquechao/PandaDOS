/**
 * ui/lib/types —— 前端侧 API/WS 资源类型镜像。
 * 形状以 src/web/routes/*.ts 与 core/types.ts、issues/engine.ts 为准（以代码为契约）；
 * WS 帧协议按与后端工程师的共同契约（见 Chat/Term 视图头注释）。
 */

// ---------- 用户 ----------

export type Role = 'admin' | 'user';

/** GET /api/me */
export interface Me {
  id: number;
  username: string;
  role: Role;
  feishuOpenid: string | null;
  lastLoginTs: number | null;
}

/** GET/PUT /api/me/settings、GET/PUT /api/admin/users/:id/settings */
export interface UserSettings {
  userId: number;
  persona: string | null;
  memory: string | null;
  autopilotDefault: boolean;
  notifyPref: string | null;
}

/** admin 用户表行（safeUser，不含 token） */
export interface AdminUser {
  id: number;
  username: string;
  role: Role;
  feishuOpenid: string | null;
  createdTs: number;
  lastLoginTs: number | null;
  /** 最近使用时间（每次成功认证 touch，比「上次登录」更能反映活跃）；null = 从未 */
  lastSeenTs: number | null;
  /** 活跃统计（issue #102）：任务按 issue 创建者归属，消息按用户实际发出的条数；今天按东八区日切 */
  todayTasks: number;
  totalTasks: number;
  todayMessages: number;
  totalMessages: number;
}

// ---------- 驱动大模型 ----------

export interface LlmStatus {
  configured: boolean;
}

export interface AdminLlmConfig extends LlmStatus {
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  apiKeyMasked: string | null;
}

// ---------- 执行机 ----------

export type ExecutorStatus = 'unknown' | 'online' | 'offline';

export interface Executor {
  id: number;
  name: string;
  host: string;
  port: number;
  sshUser: string;
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

export interface ExecutorDetection {
  homeDir: string | null;
  current: { workspaceRoot: string; claudeDir: string; codexDir: string };
  workspaceSuggestion: string | null;
  agents: Record<
    AgentKind,
    {
      currentDir: string;
      commandPath: string | null;
      commandFound: boolean;
      stateDirFound: boolean;
      suggestedDir: string | null;
    }
  >;
  warnings: string[];
  checkedTs: number;
}

// ---------- 项目 ----------

/** 「Agent 认知总结」后台任务态（后端 007 迁移 summary_status） */
export type SummaryStatus = 'idle' | 'running' | 'done' | 'error';

/** 项目类型（后端 009 迁移）：'issue'=issue 看板；'chat'=纯对话模式 */
export type ProjectKind = 'issue' | 'chat';

export interface Project {
  id: number;
  name: string;
  executorId: number;
  cwd: string;
  ownerUserId: number;
  pmPersona: string | null;
  goal: string | null;
  status: 'active' | 'archived';
  createdTs: number;
  /** 项目归属的执行机 Linux 用户名（'' = 跟随执行机连接用户） */
  runUser: string;
  /** README 自动简介（按天巡检生成；null = 尚未生成） */
  readmeSummary: string | null;
  /** 项目工作分支（兜底用；引擎默认在开发者当前所在分支上干活，不建/不切/不合并分支） */
  workBranch: string | null;
  /** Agent（claude/codex）读历史+代码库产出的项目认知长文（null = 尚未生成） */
  understanding: string | null;
  /** 生成该认知的 CLI 代理（null = 尚未生成） */
  understandingAgent: AgentKind | null;
  /** 上次成功生成认知的时间戳（null = 尚未生成） */
  understandingTs: number | null;
  /** 「Agent 认知总结」后台任务态 */
  summaryStatus: SummaryStatus;
  /** 任务失败原因（summaryStatus='error' 时有值） */
  summaryError: string | null;
  /** 项目类型（009）：'issue'=issue 看板；'chat'=纯对话模式 */
  kind: ProjectKind;
}

/** GET /api/projects/summary 单项目未完结 issue 聚合（看板列口径；无 issue 的项目不出现） */
export interface ProjectIssueSummary {
  todo: number;
  doing: number;
  review: number;
  blocked: number;
}

/** GET /api/projects/summary */
export interface ProjectsSummary {
  ok: boolean;
  projects: Record<string, ProjectIssueSummary>;
}

/** GET /api/projects/:id/members 行：属主（owner）置顶 + project_members 成员（member） */
export interface ProjectMember {
  userId: number;
  username: string;
  role: 'owner' | 'member';
  /** owner 行取项目创建时间；member 行取加入时间（epoch 毫秒） */
  createdTs: number;
  /** 最近登录 / 最后使用（012 last_seen_ts；null = 从未） */
  lastLoginTs: number | null;
  lastSeenTs: number | null;
  /** 项目内按创建人计的 issue 统计（成员弹窗展示） */
  issueTotal: number;
  issueDone: number;
}

/** GET /api/projects/:id/member-candidates 的行（加成员下拉候选，仅 id/username） */
export interface MemberCandidate {
  id: number;
  username: string;
}

/** GET /api/executors（登录即可见的极简执行机视图） */
export interface ExecutorLite {
  id: number;
  name: string;
  status: ExecutorStatus;
  isSystemLocal: boolean;
  supportedAgents: AgentKind[];
  availableForProjects: boolean;
  capabilitiesCheckedTs: number | null;
}

/** GET /api/executors/:id/os-users（admin；项目 Linux 用户下拉） */
export interface OsUser {
  name: string;
  uid: number;
  home: string;
}

/** GET /api/executors/:id/fs（建项目 cwd 目录浏览） */
export interface DirListing {
  ok: boolean;
  /** 当前浏览的绝对路径 */
  path: string;
  /** 越权面根：admin='/'，普通用户=自己 workspace（不能浏览到它之外） */
  root: string;
  /** 子目录名（已排序，点号目录在后）；path 不存在时为 [] + missing:true */
  dirs: string[];
  missing?: boolean;
  truncated?: boolean;
}

/** GET /api/executors/:id/tmux-sessions 单条（导入现有 tmux 会话视角） */
export interface TmuxSessionInfo {
  name: string;
  createdTs: number;
  attached: boolean;
  cwd: string | null;
  command: string | null;
  managedProjectId: number | null;
  importedProjectId: number | null;
  sameCwdProjectId: number | null;
  allowed: boolean;
}

// ---------- Issue ----------

export type IssueCategory = 'task' | 'design' | 'debug';
export type ImplMode = 'seq' | 'team';
export type AgentKind = 'claude' | 'codex';

/**
 * 弹窗自动批准档位（后端 core/types.AutoApproveLevel 同名同义）：
 * cautious=只自动点信任/推荐这类零风险项，medium=分级判定（危险不可逆转人工），
 * auto=除危险不可逆红线外一律自动同意。issue 与对话各存一份、互不影响。
 */
export type AutoApproveLevel = 'cautious' | 'medium' | 'auto';

/** 对话（后端 conversations 表；对话模式的多对话列表用） */
export interface Conversation {
  id: string;
  projectId: number;
  label: string | null;
  createdTs: number;
  archived: boolean;
  /** 驱动本对话的 CLI 代理（生命周期内不变） */
  agent: AgentKind;
  /** 'issue'=引擎绑定执行会话；'chat'=独立聊天对话 */
  kind: ProjectKind;
  /** 最近活跃时刻（毫秒；null=从未激活），列表按它倒序 */
  lastActiveTs: number | null;
  /** 本对话的弹窗自动批准档位（默认 cautious = 全部等人点） */
  autoApprove: AutoApproveLevel;
}

export type IssueStatus =
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

/** EngineIssue（issues 路由返回的行） */
export interface Issue {
  id: number;
  projectId: number;
  title: string;
  body: string | null;
  category: IssueCategory;
  status: IssueStatus;
  convId: string | null;
  planJson: string | null;
  subtasksJson: string | null;
  subIndex: number;
  /** pending 阶段配置的目标分支；null = 沿用默认 Git 现场。 */
  targetBranch: string | null;
  /** 创建目标分支所基于的完整本地/远程跟踪 ref；null = 沿用默认 Git 现场。 */
  sourceRef: string | null;
  /** 开跑后记录的实际执行分支，与上面的用户配置意图分开。 */
  branch: string | null;
  note: string | null;
  imagesJson: string | null;
  createdBy: number | null;
  /** 创建者用户名（issues 路由 join 回显；created_by 为空/未解析 → null）。前端为空时显示「—」 */
  createdByName?: string | null;
  createdTs: number;
  doneTs: number | null;
  module: string;
  moduleId?: number | null;
  implMode: ImplMode;
  agent: AgentKind;
  /** 置顶时刻（ms）；null = 未置顶。置顶的 pending 排队时优先调度（queue.pickNext 置顶层） */
  pinnedTs: number | null;
  /** 创建时执行代理的分析反馈（理解/思路/风险，033 迁移）；null = 尚未分析或失败 */
  clarifyFeedback: string | null;
  /** 收尾（done/blocked）时执行代理的执行结果总结（033 迁移）；null = 尚未总结或失败 */
  resultSummary: string | null;
  /** waiting_input 派生标记：CC 弹窗在等人工选择（升级卡未处理/菜单滞留）。列表/详情接口下发 */
  waitingInput?: boolean;
  /** 派生标记：澄清问题还没被回答（跨状态——创建时问题开跑后仍为 true 直到回答）。列表/详情接口下发 */
  clarifyPending?: boolean;
  /** 派生标记：执行中代理在等你澄清（NEED_CLARIFY / PM 兜底判 clarify）。issue 详情页覆盖显示「等待用户澄清」 */
  awaitingClarify?: boolean;
  /** 本 issue 执行时的弹窗自动批准档位（默认 medium = 分级判定） */
  autoApprove: AutoApproveLevel;
}

export interface ProjectModule {
  id: number;
  projectId: number;
  slug: string;
  displayName: string;
  agent: AgentKind;
  source: 'auto' | 'manual' | 'legacy';
  status: 'active' | 'archived';
  conversationId: string | null;
  lastUsedTs: number | null;
}

export interface Subtask {
  text: string;
  done: boolean;
}

export interface IssueEvent {
  id: number;
  issueId: number;
  kind: string;
  dataJson: string | null;
  ts: number;
}

/** 同一模块共享 conversation 内的一次 issue 工作片段。 */
export interface ConversationSegment {
  id: string;
  issueId: number;
  title: string;
  status: IssueStatus;
  startTs: number;
  endTs: number | null;
}

export type GateKind = 'plan' | 'merge_review';

export interface Gate {
  id: number;
  issueId: number;
  kind: GateKind;
  status: 'waiting' | 'approved' | 'rejected';
  payloadJson: string | null;
  decidedBy: number | null;
  decidedTs: number | null;
}

/** plan 卡点 payload（engine.ts onEnter plan_review） */
export interface PlanGatePayload {
  subtasks?: string[];
  implMode?: ImplMode;
  decisionNote?: string;
}

/** merge_review 卡点 payload（engine.ts buildMergeReviewPayload） */
export interface MergeGatePayload {
  branch?: string;
  base?: string;
  stat?: string;
  diff?: string;
  diffTruncated?: boolean;
  gitError?: string;
  decisionNote?: string;
}

/** GET /api/projects/:pid/issues/:iid */
export interface IssueDetail {
  issue: Issue;
  subtasks: Subtask[];
  gates: Gate[];
  conversationSegments: ConversationSegment[];
}

// ---------- 订阅 ----------

export type SubscriptionScope = 'project' | 'issue';

export interface Subscription {
  id: number;
  userId: number;
  scope: SubscriptionScope;
  targetId: number;
  createdTs: number;
}

// ---------- 上传 ----------

/** POST /api/projects/:pid/upload 响应（rel 随 issue images 提交） */
export interface UploadResult {
  ok: boolean;
  path: string;
  abs: string;
  name: string;
  size: number;
}

// ---------- 文件浏览（routes/files.ts） ----------

export interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  mtimeMs: number | null;
  mode: number | null;
}

/** GET /api/projects/:pid/fs?path= */
export interface FsList {
  ok: boolean;
  cwd: string;
  /** 归一化相对路径（'' = 项目根） */
  path: string;
  entries: FsEntry[];
  truncated?: boolean;
}

/** GET /api/projects/:pid/fs/file?path= */
export interface FsFile {
  ok: boolean;
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

/** POST /api/projects/:pid/fs/upload?path= */
export interface FsUploadResult {
  ok: boolean;
  name: string;
  path: string;
  size: number;
}

// ---------- git（routes/git.ts；图形化提交图 + 详情 + diff） ----------

/** 提交图节点（log --all --date-order 结构化记录） */
export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  /** 提交时间（ms） */
  ts: number;
  /** %D 装饰（'HEAD -> main' / 'origin/main' / 'tag: v1'…） */
  refs: string[];
  subject: string;
}

/** 工作区改动行（status --porcelain=v1 两列码：X=暂存区 Y=工作区，'??'=未跟踪） */
export interface GitChange {
  status: string;
  path: string;
  oldPath?: string;
}

/** GET /api/projects/:pid/git */
export interface GitInfo {
  ok: boolean;
  cwd: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  commits?: GitCommit[];
  changes?: GitChange[];
  error?: string;
}

/** GET /api/projects/:pid/git/branches 的分支引用；ref 是后端可直接解析的完整引用名。 */
export interface GitBranchRef {
  name: string;
  ref: string;
}

/** 当前、本地与本地已知的远程跟踪分支；detached HEAD 时 current 为空。 */
export interface GitBranches {
  ok: boolean;
  cwd: string;
  current: string;
  local: GitBranchRef[];
  remote: GitBranchRef[];
  error?: string;
}

/** POST /git/stage、/git/unstage */
export interface GitWriteResult {
  ok: boolean;
  error?: string;
}

/** POST /git/commit */
export interface GitCommitResult extends GitWriteResult {
  sha: string;
  short: string;
}

/** POST /git/push */
export interface GitPushResult extends GitWriteResult {
  branch: string;
  upstream: string;
  createdUpstream: boolean;
}

/** 提交内单文件改动（A/M/D/T/R100…；adds/dels null=二进制） */
export interface GitFile {
  status: string;
  path: string;
  oldPath?: string;
  adds?: number | null;
  dels?: number | null;
}

/** GET /api/projects/:pid/git/commits/:sha */
export interface GitCommitDetail {
  ok: boolean;
  sha: string;
  short: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorTs: number;
  committer: string;
  commitTs: number;
  refs: string[];
  message: string;
  files: GitFile[];
}

/** GET …/git/commits/:sha/diff、…/git/worktree/diff、…/issues/:iid/git/diff */
export interface GitDiff {
  ok: boolean;
  diff: string;
  truncated?: boolean;
}

/** GET /api/projects/:pid/issues/:iid/git —— 本 issue 的 git 现场（分支提交 + 改动范围） */
/** 本 issue 推送状态（范围终点相对 origin/<branch>；语义同后端 routes/git） */
export type IssuePushState =
  | { state: 'pushed' }            // 终点已在 origin 分支上
  | { state: 'ahead'; n: number }  // 领先 origin n 条未推送
  | { state: 'unpushed' }          // 有 origin 远程但该分支从未推送
  | { state: 'none' };             // 仓库未配 origin 远程

export interface IssueGitInfo {
  ok: boolean;
  branch: string;
  base: string;
  /** 固定/共享分支模式下本 issue 的起点 sha：有值→commits/files 是本 issue 自己的提交（start..end），非整分支 */
  startSha?: string;
  /** 分支是否已存在（未启动/未落分支的 issue → false） */
  exists: boolean;
  /** 范围内独立提交数（已合并常为 0） */
  ahead: number;
  /** 范围内提交（本 issue 历史，新→旧） */
  commits: GitCommit[];
  /** 范围改动（本 issue 触碰的文件） */
  files: GitFile[];
  /** diff --stat 文本 */
  stat: string;
  /** 工作区未提交改动（仅活跃 issue：正在进行、还没进 commit 范围的部分） */
  worktree?: GitChange[];
  /** 推送状态（exists:true 时给） */
  push?: IssuePushState;
  /** 'snapshot' = 分支已清理/范围失效，数据来自完成时的耐久快照（stat 为空）；缺省 = 实时 git */
  source?: 'snapshot';
  error?: string;
}

/** AI 助读动作（POST /api/projects/:pid/git/ai body.kind） */
export type GitAiKind =
  | 'commit-summary'   // 总结提交
  | 'commit-risk'      // 识别风险
  | 'commit-explain'   // 解释整条提交 diff
  | 'file-explain'     // 解释单文件 diff（提交内 sha+path 或工作区 path[+untracked]）
  | 'commit-message';  // 工作区改动生成提交信息

/** POST /api/projects/:pid/git/ai 请求体 */
export interface GitAiReq {
  kind: GitAiKind;
  /** commit-* / file-explain（提交内文件）需带 */
  sha?: string;
  /** file-explain 需带 */
  path?: string;
  /** 重命名旧路径（可选，narrow diff 用） */
  old?: string;
  /** file-explain 工作区未跟踪文件 */
  untracked?: boolean;
}

/** POST /api/projects/:pid/git/ai 返回 */
export interface GitAiResult {
  ok: boolean;
  /** AI 生成的正文（成功时） */
  text?: string;
  error?: string;
}

// ---------- admin 概览 ----------

export interface OverviewUser {
  id: number;
  username: string;
  role: Role;
  lastLoginTs: number | null;
  projectCount: number;
}

// ---------- WS chat 帧（契约：与后端并行开发的共同约定） ----------

export interface ChatMessage {
  seq: number;
  role: 'assistant' | 'thinking' | 'tool_use' | 'tool_result' | 'user';
  text?: string;
  tool?: string; // 工具名（tool_result 也带：后端按 tool_use_id 回配）
  title?: string; // tool_use 人话标题（如「✏️ 改 Login.tsx」）
  input?: string; // 工具入参（人话正文：路径/±diff/$命令）
  result?: string;
  isError?: boolean;
  ts?: number; // 行级时间戳（毫秒）——执行流据此算工具耗时；无/非法时缺省
  /** 跨连接稳定标识：源行字节 offset(+行内序号)。前端据此去重/排序/合并 baseline+msg+history、重连不丢 */
  off?: number;
  /** 用户消息附图的 cwd 相对路径（对话里上传的截图）：后端 ws/chat.ts 发帧前富化，供缩略图/灯箱预览 */
  images?: string[];
}

/** 菜单选择：sig 是菜单签名，select 帧带回；服务端判过期回 stale */
export interface ChatSelection {
  options: string[];
  /** 与 options 同序的次级说明（AskUserQuestion 的 description，无则 ''）；仅展示，不进 sig */
  details?: string[];
  cursorIndex?: number;
  context?: string;
  /** 多选表单（选项带复选框）：点一项只是勾选/取消，要按 → 进复核页才提交 */
  multiSelect?: boolean;
  sig: string;
}

export type ChatServerFrame =
  | { type: 'baseline'; msgs: ChatMessage[]; selection?: ChatSelection | null }
  | { type: 'msg'; m: ChatMessage }
  | { type: 'selection'; sel: ChatSelection | null }
  | { type: 'mode'; live: boolean }
  | { type: 'stale' }
  // 向上翻页返回：更早的一页消息（前插）+ 是否还有更早
  | { type: 'history'; msgs: ChatMessage[]; hasMore: boolean }
  /**
   * 菜单解读（issue #112）：点了「解释一下」才会来。
   * optionsSig = 菜单本体签名（options.join('|')，不含光标）——前端按它匹配当前菜单，
   * 光标挪一格不算换菜单，解读不该因此被丢掉。
   */
  | { type: 'explanation'; sig: string; optionsSig: string; text: string }
  /** 发送回执（issue #116）：带 id 的文本帧真注入成功了 → 本地乐观气泡标「已送达」 */
  | { type: 'ack'; id: string }
  /** id 存在 = 这条文本消息没发出去（乐观气泡标失败）；「正在重启并自动补发」的 err 不带 id */
  | { type: 'err'; code: string; msg?: string; id?: string };

export type ChatClientFrame =
  // id = 本地乐观气泡的一次性标识（issue #116）：服务端把结局（ack/err）原样带回
  | { type: 'text'; text: string; images?: string[]; id?: string }
  | { type: 'key'; key: string }
  | { type: 'select'; index: number; sig: string }
  // 请求更早历史（向上翻页）
  | { type: 'history' }
  // 请求解读当前菜单（issue #112「解释一下」，点了才生成）
  | { type: 'explain'; sig: string };

// ---------- 展示映射 ----------

export const STATUS_LABEL: Record<IssueStatus, string> = {
  pending: '待办',
  clarifying: '澄清中',
  planning: '规划中',
  plan_review: '计划待确认',
  implementing: '实现中',
  testing: '测试中',
  merge_review: '合并待确认',
  merging: '合并中',
  done: '完成',
  blocked: '受阻',
  cancelled: '已取消',
};

export const CAT_LABEL: Record<IssueCategory, string> = {
  task: '任务',
  design: '设计',
  debug: 'DEBUG',
};

/** 看板四列（spec §9-1：「待确认」= 卡点列，最高视觉优先级） */
export interface BoardColumn {
  key: 'todo' | 'doing' | 'review' | 'finished';
  label: string;
  statuses: IssueStatus[];
}

export const BOARD_COLUMNS: BoardColumn[] = [
  { key: 'todo', label: '待办', statuses: ['pending'] },
  { key: 'doing', label: '进行中', statuses: ['planning', 'implementing', 'testing', 'merging'] },
  // clarifying 在等发起人回答澄清问题——归「待确认」，别装成还没开始
  { key: 'review', label: '待确认', statuses: ['clarifying', 'plan_review', 'merge_review'] },
  { key: 'finished', label: '完成', statuses: ['done', 'blocked', 'cancelled'] },
];

// ---------- 技能 / 技能市场 ----------

/** 一个已安装技能（后端 core/skills.SkillInfo 同构） */
export interface SkillInfo {
  name: string;
  path: string;
  summary: string;
  mtimeMs: number;
  scope: 'global' | 'project';
  source?: string;
}

export interface SkillsList {
  ok: boolean;
  cwd: string;
  global: SkillInfo[];
  project: SkillInfo[];
}

/** 市场里的一条技能（core/skill-market.MarketSkill 同构） */
export interface MarketSkill {
  key: string;
  market: string;
  rel: string;
  name: string;
  title: string;
  category: string;
  description: string;
  descZh?: string;
  tags?: string[];
  recommend?: boolean;
  reason?: string;
}

export interface SkillMarketInfo {
  id: number;
  name: string;
  repo: string;
  subdir: string;
  note: string;
  enabled: boolean;
  lastSyncTs: number | null;
  lastError: string | null;
  count: number;
}

export interface MarketSkillsList {
  ok: boolean;
  markets: SkillMarketInfo[];
  skills: MarketSkill[];
  needSync: boolean;
}

export interface MarketSyncResult {
  ok: boolean;
  results: { name: string; ok: boolean; count: number; error?: string }[];
}

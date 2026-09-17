/**
 * web/routes/projects —— 项目 CRUD（spec §9-1；project 是 v2 第一实体）。
 * - 建项目 = 建 PM 记录（pm_persona/goal 就在 projects 行上）+ 可选建一条 cc 对话；
 * - 普通用户见/操作自己属主或参与（成员）的项目（列表按 owner ∨ project_members 过滤；
 *   协作类单项目路由 auth:'project-access'，项目级管理 PATCH/DELETE 仍 auth:'project-owner'）；
 * - 删除 = 归档（status='archived'），真删太危险（级联删 issues/events）留给 admin 手工。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import path from 'node:path';
import type { LlmClient } from '../../agents/llm';
import { userPromptLocale } from '../../agents/prompts/language';
import type { SummaryTarget } from '../../core/agent-summary';
import { PRODUCT_NAME } from '../../core/branding';
import {
  archiveHistoryConversations,
  findBoundHistoryConversation,
  type HistoryArchiveFs,
  importableHistorySessions,
  importHistoryConversations,
} from '../../core/conversation-history';
import { projectAgentSupport, supportedAgents } from '../../core/executors';
import { buildFallbackIdentity, ensureGitIdentity, type GitIdentity } from '../../core/git-identity';
import { ProjectMemberStore } from '../../core/members';
import { generateProjectReadmeSummary, type ReadmeDriver } from '../../core/readme-summary';
import type { AgentKind, Conversation, Executor, Project, User } from '../../core/types';
import {
  discoverExecutorAgentHistory,
  type AgentHistorySession,
} from '../../executor/agent-history';
import { shq } from '../../executor/shq';
import { getProject, mapProject } from '../../issues/engine';
import { BUSY_STATES } from '../../issues/queue';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';
import { llmErrorResponse } from '../llm-error';
import type { ProjectDataSyncStatus } from '../project-data-sync';
import {
  getExecutorById,
  managedProjectIdOf,
  parsePasswd,
  PASSWD_READ_LIMIT,
  type ExecutorProbe,
} from './executors';

export interface ProjectsRoutesDeps {
  db: Database;
  /** 可选：建项目时顺手建一条 cc 对话（core/conversations.ts ConversationManager 结构兼容） */
  convs?: { create(projectId: number, label: string, agent?: AgentKind): Conversation };
  /**
   * 可选：通知钩子（notify/router.ts NotifyRouter 结构兼容）——
   * 建项目成功后自动给属主订阅该项目（spec §8）。
   * 失败不阻塞建项目，收进响应 warnings。
   */
  notify?: { ensureOwnerSubscription(projectId: number, ownerUserId: number): unknown };
  /**
   * 可选：按执行机取 Driver（server.ts driverForExecutor）——导入现有 tmux 会话时
   * 到执行机上现查会话与 cwd。缺省 = 导入接口 503（测试/离线装配可不接）。
   */
  driverFor?(executor: Executor): (ExecutorProbe & HistoryArchiveFs) | null;
  /**
   * 可选：LLM 客户端（手动「更新简介」调 驱动大模型 用；与 PM 池共享并发闸）。
   * 缺省 = 更新简介接口 503（离线/测试装配可不接）。
   */
  llm?: LlmClient;
  /**
   * 可选：按项目取 Driver（读项目 cwd 下 README；server.ts driverForProject）。
   * 缺省 = 更新简介接口 503。
   */
  driverForProject?(project: Project): ReadmeDriver;
  /**
   * 可选：「Agent 认知总结」后台任务编排（core/summary-orchestrator 结构兼容）。
   * mode=claude/codex 时用它启动后台任务；缺省 = 该两种模式 503（离线/测试装配可不接）。
   */
  /**
   * 可选：waiting_input 数据源（在等人工输入的 issue id 集合：弹窗升级未处理/菜单滞留）。
   * summary 聚合把它们补进「待确认」角标（状态本身还在 doing，等人工这件事必须可见）。
   * 缺省 = 不补（测试/离线装配）。
   */
  waitingIssueIds?(): Set<number>;
  summaryOrchestrator?: {
    start(
      project: Project,
      agent: AgentKind,
      target?: SummaryTarget,
    ): { started: true } | { started: false; reason: 'busy' };
  };
  /**
   * 可选：按项目取执行机 Driver 的迁移最小面（cwd-migrate 用；生产传完整 ExecutorDriver，
   * 结构接口天然满足）。缺省 = 迁移目录接口 503（离线/测试装配可不接）。
   */
  fullDriverForProject?(project: Project): CwdMigrateDriver;
  /** `.panda` 文件主导同步；创建、导入与打开项目时调用。 */
  projectDataSync?: {
    sync(project: Project): Promise<unknown>;
    status(projectId: number): ProjectDataSyncStatus;
  };
}

/** cwd-migrate 需要的执行机能力最小面（ExecutorDriver 结构子集） */
export interface CwdMigrateDriver {
  listSessions(): Promise<{ name: string }[]>;
  killSession(name: string): Promise<void>;
  statPath(path: string): Promise<unknown>;
  mkdirp(path: string): Promise<void>;
  movePath(src: string, dst: string): Promise<void>;
}

interface ProjectRowRaw {
  id: number;
  name: string;
  executor_id: number;
  cwd: string;
  owner_user_id: number;
  pm_persona: string | null;
  goal: string | null;
  status: string;
  created_ts: number;
  run_user: string;
  work_branch: string | null;
  kind: string;
}

function listProjects(db: Database, ownerUserId?: number): Project[] {
  // 普通用户可见 = 自己是属主 ∨ 是 project_members 成员（admin 传 undefined = 全量）
  const rows = ownerUserId
    ? db
        .query<ProjectRowRaw, [number, number]>(
          `SELECT * FROM projects
            WHERE owner_user_id = ?
               OR id IN (SELECT project_id FROM project_members WHERE user_id = ?)
            ORDER BY created_ts DESC`,
        )
        .all(ownerUserId, ownerUserId)
    : db.query<ProjectRowRaw, []>('SELECT * FROM projects ORDER BY created_ts DESC').all();
  return rows.map(mapProject);
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  return typeof o[key] === 'string' && (o[key] as string).length > 0 ? (o[key] as string) : undefined;
}

/** 项目名 → cwd 目录段（保守白名单，避免奇怪字符进路径） */
export function projectSlug(name: string): string {
  const s = name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return s || 'proj';
}

/** Linux 用户名白名单（useradd 约束的宽松版；'' = 跟随执行机连接用户） */
export const RUN_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i;

/**
 * git 工作分支名白名单（保守）：必须以字母/数字开头（挡掉以 `-`/`/` 开头被 git 当参数/非法 ref），
 * 其余允许字母数字与 `._/-`，长度 ≤200。'' = 清空（回默认每-issue 分支流）。
 */
export const WORK_BRANCH_RE = /^[A-Za-z0-9][\w./-]{0,199}$/;

/** 解析 body.workBranch：未给 → undefined（不动）；'' → 清空；非法 → 错误响应 */
function parseWorkBranch(b: Record<string, unknown>): { value?: string | null; error?: Response } {
  if (b.workBranch === undefined) return {};
  if (b.workBranch === null || b.workBranch === '') return { value: null };
  if (typeof b.workBranch !== 'string') {
    return { error: json({ ok: false, error: 'workBranch 必须是字符串' }, 400) };
  }
  const v = b.workBranch.trim();
  if (v === '') return { value: null };
  if (!WORK_BRANCH_RE.test(v)) {
    return { error: json({ ok: false, error: '非法分支名（字母/数字开头，仅含字母数字与 . _ / -）' }, 400) };
  }
  return { value: v };
}

/**
 * 项目统一使用 issue 看板。缺省或显式 issue 均兼容；chat 与其他值明确拒绝，
 * 防止旧客户端继续创建或切换为已经下线的纯对话项目。
 */
function parseProjectKind(b: Record<string, unknown>): { error?: Response } {
  const k = b.kind;
  if (k === undefined || k === null || k === '') return {};
  if (k === 'issue') return {};
  return { error: json({ ok: false, error: '项目类型已固定为 issue' }, 400) };
}

/** 「更新简介」模式：llm=现有同步 README 路径；claude/codex=后台 Agent 认知总结任务 */
export type SummaryMode = 'llm' | 'claude' | 'codex';
const SUMMARY_MODES: readonly SummaryMode[] = ['llm', 'claude', 'codex'];

/** 解析 body.mode：缺省/空 → llm；非法 → null（调用方 400） */
function parseSummaryMode(b: Record<string, unknown>): SummaryMode | null {
  const m = b.mode;
  if (m === undefined || m === null || m === '') return 'llm';
  return typeof m === 'string' && (SUMMARY_MODES as readonly string[]).includes(m)
    ? (m as SummaryMode)
    : null;
}

/**
 * git clone 来源 URL 白名单：仅 http(s)/git/ssh 协议与 scp 风格 git@host:path。
 * 字符集保守收紧——既挡 `ext::`/`file://` 这类危险传输，也挡以 `-` 开头的参数注入
 * （何况 clone 调用处已用 `--` 终止选项解析，双保险）。
 */
export const GIT_URL_RE = /^(?:https?:\/\/|git:\/\/|ssh:\/\/|git@)[A-Za-z0-9._~:/@+-]+$/;

/** 只有 OpenSSH 传输需要首次主机密钥接纳；HTTPS 与 git:// 保持原行为。 */
export function isSshGitUrl(url: string): boolean {
  return url.startsWith('ssh://') || url.startsWith('git@');
}

/**
 * accept-new 是 TOFU：首次连接写入 known_hosts，已有主机密钥变化时仍拒绝。
 * UserKnownHostsFile 使用严格 shell 引用，因为 Git 会再通过 shell 解析 core.sshCommand。
 */
export function gitSshCommand(knownHostsFile: string): string {
  return `ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${shq(knownHostsFile)}`;
}

/** 从 git URL 推导仓库名（basename 去 .git），过 projectSlug 白名单；推不出返回 '' */
export function repoNameFromGitUrl(url: string): string {
  const seg = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '';
  const base = seg.replace(/\.git$/i, '');
  return base ? projectSlug(base) : '';
}

// ---------- 项目状态摘要（侧栏项目列表/项目卡片的状态角标） ----------

/** issue 状态 → 看板列（与 ui/lib/types BOARD_COLUMNS 同口径；done/cancelled 不计）。
 *  clarifying 计入待确认（review）：它在等发起人回答澄清问题，不是「还没开始」。 */
const SUMMARY_COLUMN: Record<string, 'todo' | 'doing' | 'review' | 'blocked'> = {
  pending: 'todo',
  clarifying: 'review',
  planning: 'doing',
  implementing: 'doing',
  testing: 'doing',
  merging: 'doing',
  plan_review: 'review',
  merge_review: 'review',
  blocked: 'blocked',
};

export interface ProjectIssueSummary {
  todo: number;
  doing: number;
  review: number;
  blocked: number;
}

/** 按项目聚合未完结 issue 数（可见性与项目列表同：普通用户聚合自己属主或参与的项目） */
export function summarizeProjects(
  db: Database,
  ownerUserId?: number,
): Record<number, ProjectIssueSummary> {
  interface Row {
    project_id: number;
    status: string;
    n: number;
  }
  const rows = ownerUserId
    ? db
        .query<Row, [number, number]>(
          `SELECT i.project_id, i.status, COUNT(*) AS n FROM issues i
           JOIN projects p ON p.id = i.project_id
           WHERE (p.owner_user_id = ?
                  OR p.id IN (SELECT project_id FROM project_members WHERE user_id = ?))
           GROUP BY i.project_id, i.status`,
        )
        .all(ownerUserId, ownerUserId)
    : db
        .query<Row, []>('SELECT project_id, status, COUNT(*) AS n FROM issues GROUP BY project_id, status')
        .all();
  const out: Record<number, ProjectIssueSummary> = {};
  for (const r of rows) {
    const col = SUMMARY_COLUMN[r.status];
    if (!col) continue;
    (out[r.project_id] ??= { todo: 0, doing: 0, review: 0, blocked: 0 })[col] += r.n;
  }
  return out;
}

/**
 * 解析 body.runUser：未给 → undefined（不动）；给了 → 校验 admin + 格式，返回规范值或错误响应。
 * 指定 Linux 用户即指向他人家目录，属越权面，与「admin 才能任意 cwd」同一纪律。
 */
function parseRunUser(
  b: Record<string, unknown>,
  user: User,
): { value?: string; error?: Response } {
  if (b.runUser === undefined) return {};
  if (b.runUser !== '' && typeof b.runUser !== 'string') {
    return { error: json({ ok: false, error: 'runUser 必须是字符串' }, 400) };
  }
  const v = (b.runUser as string).trim();
  if (v === '') return { value: '' };
  if (user.role !== 'admin') return { error: json({ ok: false, error: '仅 admin 可指定 Linux 用户' }, 403) };
  if (!RUN_USER_RE.test(v)) return { error: json({ ok: false, error: '非法 Linux 用户名' }, 400) };
  return { value: v };
}

/** 读 /etc/passwd 解析 Linux 用户家目录；读不到/没有该用户返回 null（不抛） */
async function homeOfOsUser(driver: ExecutorProbe, username: string): Promise<string | null> {
  try {
    const { data } = await driver.readFileRange('/etc/passwd', 0, PASSWD_READ_LIMIT);
    const hit = parsePasswd(new TextDecoder().decode(data)).find((x) => x.name === username);
    return hit?.home ?? null;
  } catch {
    return null;
  }
}

/** Git 命令实际以 Driver 所属 OS 用户运行，而不是项目的 runUser 标记。 */
async function executorUserHome(driver: ExecutorProbe, executor: Executor): Promise<string | null> {
  const local = (executor.host === '127.0.0.1' || executor.host === 'localhost') && !executor.keyRef;
  const home = local ? homedir() : executor.sshUser ? await homeOfOsUser(driver, executor.sshUser) : null;
  return home?.startsWith('/') ? home.replace(/\/+$/, '') || '/' : null;
}

function cloneFailure(detail: string, ssh: boolean): string {
  const tail = detail.slice(-400);
  if (ssh && /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(detail)) {
    return `git clone 失败：SSH 主机密钥与 known_hosts 不一致，已拒绝连接：${tail}`;
  }
  if (ssh && /Permission denied \(publickey/i.test(detail)) {
    return `git clone 失败：SSH 密钥认证失败，请检查执行机用户的 Git 私钥权限：${tail}`;
  }
  return `git clone 失败：${tail}`;
}

/**
 * 把 gitUrl clone 到执行机上的 target 目录：target 必须不存在或为空目录；
 * 父目录 mkdir -p 后在父目录下 `git clone -- <url> <basename>`（`--` 终止选项解析）。
 * 成功返回 null，失败返回可直接回给客户端的 Response。
 */
async function cloneInto(
  driver: ExecutorProbe,
  gitUrl: string,
  target: string,
  sshHome: string | null,
): Promise<Response | null> {
  try {
    const st = await driver.statPath(target);
    if (st && !st.isDirectory) return json({ ok: false, error: 'clone 目标已存在且不是目录' }, 400);
    if (st && (await driver.listDir(target)).length > 0) {
      return json({ ok: false, error: `clone 目标目录已存在且非空：${target}` }, 400);
    }
    const parent = path.posix.dirname(target);
    await driver.mkdirp(parent);
    const ssh = isSshGitUrl(gitUrl);
    if (ssh && !sshHome) {
      return json({ ok: false, error: '无法解析执行机用户 Home，不能安全持久化 Git SSH 主机密钥' }, 502);
    }
    const cloneArgs = ['clone', '--', gitUrl, path.posix.basename(target)];
    if (ssh) {
      const sshDir = path.posix.join(sshHome!, '.ssh');
      await driver.mkdirp(sshDir);
      cloneArgs.unshift('-c', `core.sshCommand=${gitSshCommand(path.posix.join(sshDir, 'known_hosts'))}`);
    }
    const r = await driver.git(parent, cloneArgs);
    if (r.code !== 0) {
      return json({ ok: false, error: cloneFailure(r.err || r.out, ssh) }, 502);
    }
    return null;
  } catch (e) {
    return json({ ok: false, error: `git clone 失败：${String(e).slice(0, 300)}` }, 502);
  }
}

/**
 * 保证项目目录可直接参与后续 Git 自动提交：已有工作区不重复 init；提交身份仅在有效配置缺失时
 * 写入**仓库本地**配置，避免覆盖执行机已有的 local/global 配置。
 *
 * 身份判定与补齐统一走 core/git-identity（唯一维护点，与引擎侧自愈同源），
 * 但这里必须收窄到 `scopes: ['local']`：这写的是「本项目属主」的身份，
 * 落进 global 就等于让先建项目的那个人变成整台执行机的默认提交人。
 */
async function prepareProjectGit(
  driver: ExecutorProbe,
  cwd: string,
  identity: GitIdentity,
): Promise<Response | null> {
  try {
    const inside = await driver.git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.out.trim() !== 'true') {
      const initialized = await driver.git(cwd, ['init']);
      if (initialized.code !== 0) {
        return json({ ok: false, error: `git init 失败：${(initialized.err || initialized.out).slice(-400)}` }, 502);
      }
    }

    const ensured = await ensureGitIdentity(driver, cwd, identity, { scopes: ['local'] });
    if (!ensured.ok) return json({ ok: false, error: ensured.error ?? 'Git 身份预检失败' }, 502);
    return null;
  } catch (e) {
    return json({ ok: false, error: `Git 仓库初始化失败：${String(e).slice(0, 400)}` }, 502);
  }
}

/**
 * 导入项目的 Git 身份预检（B-01）：导入路径以前完全不写身份，于是 danzhan / robot-train /
 * desktop 这些导入进来的项目第一次自动提交必然 `Author identity unknown`。
 *
 * 与建项目路径的两点不同：
 * - **不 init**：导入的是既有目录，不是 Git 仓库就直接跳过（不该替用户建仓库，也不该报警）；
 * - **失败不阻塞导入**：项目本身已经登记成功，身份补不上只降级成 warning——引擎侧自动提交
 *   前还有一次自愈机会。
 */
async function ensureImportedProjectGitIdentity(
  driver: ExecutorProbe,
  cwd: string,
  identity: GitIdentity,
): Promise<string | null> {
  try {
    const inside = await driver.git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0 || inside.out.trim() !== 'true') return null; // 非 Git 目录：无需身份
    const ensured = await ensureGitIdentity(driver, cwd, identity, { scopes: ['local'] });
    return ensured.ok ? null : (ensured.error ?? 'Git 身份预检失败');
  } catch (e) {
    return `Git 身份预检失败：${String(e).slice(0, 200)}`;
  }
}

type ProjectImportSource = 'tmux' | AgentKind;

function parseImportSource(value: unknown): ProjectImportSource | null {
  if (value === undefined || value === null || value === '') return 'tmux';
  return value === 'tmux' || value === 'claude' || value === 'codex' ? value : null;
}

export function projectsRoutes(deps: ProjectsRoutesDeps): RouteDef[] {
  const { db } = deps;
  const members = new ProjectMemberStore(db);
  return [
    {
      method: 'GET',
      path: '/api/projects',
      auth: 'user',
      handler: ({ user }) => {
        const u = user!;
        return json(listProjects(db, u.role === 'admin' ? undefined : u.id));
      },
    },
    {
      // 注意：必须注册在 GET /api/projects/:projectId 之前（dispatcher 首个命中即胜）
      method: 'GET',
      path: '/api/projects/summary',
      auth: 'user',
      handler: ({ user }) => {
        const u = user!;
        const projects = summarizeProjects(db, u.role === 'admin' ? undefined : u.id);
        // 待确认(review) 还要并入两类「状态本身不在 review 列、但确实在等你」的 issue——
        // 侧栏不亮就会像昨晚那样一等一整夜。两类可能落在同一条上，按 issue id 去重（否则一条数两次）：
        //   1) waiting_input：CC 弹窗等人工选择（内存集合；只认仍在驱动中的 issue）。
        //   2) clarifyPending：创建时/执行中澄清问题未回答（末条 clarify_questions 晚于
        //      clarified/clarify_timeout，事件溯源派生，口径同 engine.clarifyPendingOf）；status 未完结、
        //      且不在 review 列（clarifying/plan_review/merge_review 已由 summarizeProjects 按状态计过）。
        // 方案 B：只并入 review，不从 doing/todo 回扣——三个数字各答一问，同一条可同时在「进行中/待运行」出现。
        // 可见性同项目列表：属主 ∨ project_members 成员（admin 无过滤 = 全量）
        const ownerFilter =
          u.role === 'admin'
            ? ''
            : ' AND (p.owner_user_id = ? OR p.id IN (SELECT project_id FROM project_members WHERE user_id = ?))';
        const ownerArgs: number[] = u.role === 'admin' ? [] : [u.id, u.id];
        const attention = new Map<number, number>(); // issueId → projectId（天然去重）

        const waiting = [...(deps.waitingIssueIds?.() ?? [])].filter((n) => Number.isInteger(n));
        if (waiting.length) {
          const rows = db
            .query<{ id: number; project_id: number }, number[]>(
              `SELECT i.id, i.project_id FROM issues i
               JOIN projects p ON p.id = i.project_id
               WHERE i.id IN (${waiting.map(() => '?').join(',')})
                 AND i.status IN ('planning', 'implementing', 'testing')
                 ${ownerFilter}`,
            )
            .all(...waiting, ...ownerArgs);
          for (const r of rows) attention.set(r.id, r.project_id);
        }

        const clarifyRows = db
          .query<{ id: number; project_id: number }, number[]>(
            `SELECT i.id, i.project_id FROM issues i
             JOIN projects p ON p.id = i.project_id
             WHERE i.status NOT IN ('done', 'cancelled', 'clarifying', 'plan_review', 'merge_review')
               ${ownerFilter}
               AND (SELECT MAX(id) FROM issue_events WHERE issue_id = i.id AND kind = 'clarify_questions')
                 > COALESCE((SELECT MAX(id) FROM issue_events
                             WHERE issue_id = i.id AND kind IN ('clarified', 'clarify_timeout')), 0)`,
          )
          .all(...ownerArgs);
        for (const r of clarifyRows) attention.set(r.id, r.project_id);

        for (const projectId of attention.values()) {
          (projects[projectId] ??= { todo: 0, doing: 0, review: 0, blocked: 0 }).review += 1;
        }
        return json({ ok: true, projects });
      },
    },
    {
      method: 'POST',
      path: '/api/projects',
      auth: 'user',
      handler: async ({ req, user }) => {
        const u = user!;
        const b = await readBody(req);

        // 从 git clone 新建（可选）：URL 白名单校验；缺 name 时从仓库名推导
        const gitUrl = str(b, 'gitUrl');
        if (gitUrl && (gitUrl.length > 500 || !GIT_URL_RE.test(gitUrl))) {
          return json({ ok: false, error: '非法 git 仓库地址（支持 http(s)/ssh/git@）' }, 400);
        }
        const name = str(b, 'name') ?? (gitUrl ? repoNameFromGitUrl(gitUrl) : '');
        const executorId = Number(b.executorId);
        if (!name) return json({ ok: false, error: '缺 name' }, 400);
        if (!Number.isInteger(executorId) || executorId <= 0) {
          return json({ ok: false, error: '缺 executorId' }, 400);
        }
        const ex = getExecutorById(db, executorId);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 400);
        const availableAgents = supportedAgents(ex);
        if (!availableAgents.length) {
          return json({ ok: false, error: '该执行机尚未确认可用 Agent，不能创建项目' }, 409);
        }
        const driver = deps.driverFor ? deps.driverFor(ex) : null;

        // 归属：默认自己；admin 可代建
        let ownerUserId = u.id;
        let ownerUsername = u.username;
        if (b.ownerUserId !== undefined) {
          if (u.role !== 'admin') return json({ ok: false, error: '仅 admin 可指定归属' }, 403);
          const oid = Number(b.ownerUserId);
          const owner = db
            .query<{ id: number; username: string }, [number]>('SELECT id, username FROM users WHERE id = ?')
            .get(oid);
          if (!owner) return json({ ok: false, error: '无此用户' }, 400);
          ownerUserId = oid;
          ownerUsername = owner.username;
        }

        // Linux 用户（可选，admin-only）：本期 = 归属标记 + 默认 cwd 锚点（/home/<user>/…）
        const ru = parseRunUser(b, u);
        if (ru.error) return ru.error;
        const wb = parseWorkBranch(b);
        if (wb.error) return wb.error;
        const pk = parseProjectKind(b);
        if (pk.error) return pk.error;
        const workBranch = wb.value ?? null;

        const warnings: string[] = [];

        // cwd：显式给（admin 任意；普通用户必须落在自己 workspace 下）；
        // 缺省 = 锚点/<slug>——锚点选了 Linux 用户（admin）按 /etc/passwd 落其家目录，否则自己 workspace
        const wsRoot = ex.workspaceRoot.replace(/\/+$/, '');
        const myRoot = `${wsRoot}/u${ownerUserId}`;
        let cwd = str(b, 'cwd');
        if (cwd) {
          if (!cwd.startsWith('/')) return json({ ok: false, error: 'cwd 必须是绝对路径' }, 400);
          if (u.role !== 'admin' && cwd !== myRoot && !cwd.startsWith(myRoot + '/')) {
            return json({ ok: false, error: `cwd 必须在你的 workspace（${myRoot}）内` }, 403);
          }
          cwd = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
        } else {
          let anchor = myRoot;
          if (ru.value) {
            const home = driver ? await homeOfOsUser(driver, ru.value) : null;
            if (home) anchor = home.length > 1 ? home.replace(/\/+$/, '') : home;
            else warnings.push(`未能解析用户 ${ru.value} 的家目录，cwd 落 workspace`);
          }
          cwd = `${anchor === '/' ? '' : anchor}/${projectSlug(name)}`;
        }

        // Git 准备先行：成功才落项目行（失败不留半截项目；目录残留由错误信息指认）。
        // clone 与空项目都必须先确保执行机有 Git；空项目显式建目录。
        if (!driver) return json({ ok: false, error: '未接入执行机驱动，无法初始化 Git 仓库' }, 503);
        if (gitUrl) {
          if (cwd === '/') return json({ ok: false, error: 'clone 目标不能是根目录' }, 400);
          try {
            await driver.ensureGitAvailable();
          } catch (e) {
            return json({ ok: false, error: String(e).slice(0, 500) }, 502);
          }
          const sshHome = isSshGitUrl(gitUrl) ? await executorUserHome(driver, ex) : null;
          if (isSshGitUrl(gitUrl) && !sshHome) {
            return json({ ok: false, error: `无法解析执行机用户 ${ex.sshUser || '(local)'} 的 Home，不能安全持久化 Git SSH 主机密钥` }, 502);
          }
          const failed = await cloneInto(driver, gitUrl, cwd, sshHome);
          if (failed) return failed;
        } else {
          if (cwd === '/') return json({ ok: false, error: '项目目录不能是根目录' }, 400);
          try {
            await driver.mkdirp(cwd);
            await driver.ensureGitAvailable();
          } catch (e) {
            return json({ ok: false, error: `Git 仓库初始化失败：${String(e).slice(0, 400)}` }, 502);
          }
        }
        const gitFailure = await prepareProjectGit(
          driver,
          cwd,
          buildFallbackIdentity({ runUser: ru.value, ownerUsername }),
        );
        if (gitFailure) return gitFailure;

        const row = db
          .query<
            ProjectRowRaw,
            [string, number, string, number, string | null, string | null, number, string, string | null, string]
          >(
            `INSERT INTO projects (name, executor_id, cwd, owner_user_id, pm_persona, goal, created_ts, run_user, work_branch, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
          )
          .get(
            name.slice(0, 100),
            executorId,
            cwd,
            ownerUserId,
            str(b, 'pmPersona')?.slice(0, 8000) ?? null,
            str(b, 'goal')?.slice(0, 2000) ?? null,
            Date.now(),
            ru.value ?? '',
            workBranch,
            'issue',
          );
        if (!row) return json({ ok: false, error: '创建失败' }, 500);
        const project = mapProject(row);

        // 可选：顺手建一条 cc 对话（不启动进程，issue 开跑时才 activate）
        let conversation: Conversation | undefined;

        // 属主自动订阅（幂等）；失败不阻塞建项目、不静默（评审铁律）
        if (deps.notify) {
          try {
            deps.notify.ensureOwnerSubscription(project.id, ownerUserId);
          } catch (e) {
            warnings.push(`属主自动订阅失败：${String(e).slice(0, 200)}`);
          }
        }
        if (b.withConversation === true) {
          if (!deps.convs) warnings.push('未接入对话管理器，未建对话');
          else conversation = deps.convs.create(project.id, name.slice(0, 40), availableAgents[0]);
        }
        if (deps.projectDataSync) {
          try { await deps.projectDataSync.sync(project); }
          catch (e) { warnings.push(`.panda 同步失败，已保留待重试：${String(e).slice(0, 160)}`); }
        }
        const syncedProject = getProject(db, project.id) ?? project;
        return json({
          ok: true,
          project: syncedProject,
          ...(gitUrl ? { cloned: true } : {}),
          ...(conversation ? { conversation } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
      },
    },
    {
      /**
       * 统一项目导入：
       * - tmux：执行机现查 session/cwd 后登记终端 attach 权限；
       * - claude/codex：执行机现扫 Agent 历史，以服务端候选核对 cwd，登记项目并批量绑定
       *   kind=chat 的可恢复 conversations；导入项目统一使用 Issue 看板。
       * 同执行机同 cwd 的活跃项目一律合并；会话标识重复时幂等，不复制历史或覆盖归属。
       */
      method: 'POST',
      path: '/api/projects/import',
      auth: 'user',
      handler: async ({ req, user }) => {
        const u = user!;
        if (!deps.driverFor) {
          return json(apiError(
            'executor.driver_unavailable',
            'Executor operations are unavailable because no driver is configured.',
            503,
          ), 503);
        }
        const b = await readBody(req);
        const pk = parseProjectKind(b);
        if (pk.error) return pk.error;
        const source = parseImportSource(b.source);
        if (!source) {
          return json(apiError(
            'project.import_source_invalid',
            'Choose tmux, Claude, or Codex as the import source.',
            400,
          ), 400);
        }
        const executorId = Number(b.executorId);
        if (!Number.isInteger(executorId) || executorId <= 0) {
          return json(apiError('executor.id_required', 'An executor ID is required.', 400), 400);
        }
        const ex = getExecutorById(db, executorId);
        if (!ex) return json(apiError('executor.not_found', 'The executor does not exist.', 400), 400);
        const driver = deps.driverFor(ex);
        if (!driver) {
          return json(apiError(
            'executor.connection_unavailable',
            'The executor has no available connection.',
            503,
          ), 503);
        }

        let cwd: string;
        let defaultName: string;
        let sessionName: string | null = null;
        let historySessions: AgentHistorySession[] = [];

        if (source === 'tmux') {
          sessionName = str(b, 'session') ?? null;
          // 与 ws/index.ts 终端会话名同一白名单
          if (!sessionName || !/^[\w.-]+$/.test(sessionName)) {
            return json(apiError(
              'project.import_session_invalid',
              'Enter a valid tmux session name.',
              400,
            ), 400);
          }
          const managed = managedProjectIdOf(sessionName);
          if (managed !== null && getProject(db, managed)) {
            return json(
              {
                ...apiError(
                  'project.import_managed_session',
                  `This tmux session is managed by ${PRODUCT_NAME} as project #${managed} and does not need to be imported.`,
                  400,
                  { projectId: managed },
                ),
                projectId: managed,
              },
              400,
            );
          }
          let live;
          try {
            live = await driver.listSessions();
          } catch (e) {
            return json(apiError(
              'project.import_tmux_read_failed',
              'Could not read tmux sessions from the executor.',
              502,
              {},
              String(e).slice(0, 200),
            ), 502);
          }
          const tmux = live.find((item) => item.name === sessionName);
          if (!tmux) {
            return json(apiError(
              'project.import_tmux_not_found',
              'The tmux session does not exist on this executor.',
              404,
            ), 404);
          }
          if (!tmux.cwd || !tmux.cwd.startsWith('/')) {
            return json(apiError(
              'project.import_tmux_cwd_unavailable',
              'Could not determine the tmux session’s working directory. The executor may be using an older tmux version.',
              502,
            ), 502);
          }
          cwd = tmux.cwd.length > 1 ? tmux.cwd.replace(/\/+$/, '') : tmux.cwd;
          defaultName = sessionName;

          // 已登记 → 幂等返回既有项目（他人已导入则拒绝，不改归属）
          const reg = db
            .query<{ project_id: number }, [string]>('SELECT project_id FROM sessions WHERE name = ?')
            .get(sessionName);
          if (reg) {
            const project = getProject(db, reg.project_id);
            if (project) {
              if (u.role !== 'admin' && project.ownerUserId !== u.id) {
                return json(apiError(
                  'project.import_session_assigned',
                  'This session was imported by another user.',
                  403,
                ), 403);
              }
              await deps.projectDataSync?.sync(project).catch(() => {});
              return json({ ok: true, project: getProject(db, project.id) ?? project, created: false });
            }
          }
        } else {
          if (source === 'claude' ? !ex.supportsClaude : !ex.supportsCodex) {
            const agent = source === 'claude' ? 'Claude' : 'Codex';
            return json(apiError(
              'executor.agent_unavailable',
              `${agent} is not enabled on this executor.`,
              409,
              { agent },
            ), 409);
          }
          const requestedCwd = str(b, 'cwd');
          if (!requestedCwd || !requestedCwd.startsWith('/')) {
            return json(apiError(
              'project.import_cwd_invalid',
              'Enter an absolute working directory.',
              400,
            ), 400);
          }
          const normalizedCwd = requestedCwd.length > 1 ? requestedCwd.replace(/\/+$/, '') : requestedCwd;
          let history;
          try {
            history = await discoverExecutorAgentHistory(driver, {
              ...ex,
              supportsClaude: source === 'claude',
              supportsCodex: source === 'codex',
            });
          } catch (e) {
            return json(apiError(
              'history.read_failed',
              'Could not read local agent history.',
              502,
              {},
              String(e).slice(0, 200),
            ), 502);
          }
          const candidate = history.projects.find(
            (project) => project.agent === source && project.cwd === normalizedCwd,
          );
          const importableSessions = candidate
            ? importableHistorySessions(db, candidate.sessions)
            : [];
          if (!candidate || importableSessions.length === 0) {
            return json(apiError(
              'project.import_project_not_found',
              'No matching project was found in the executor’s agent history.',
              404,
            ), 404);
          }
          cwd = candidate.cwd;
          defaultName = candidate.name;
          historySessions = importableSessions;
        }

        // 归属：默认自己；admin 可代建（与建项目同一纪律）
        let ownerUserId = u.id;
        let ownerUsername = u.username;
        if (b.ownerUserId !== undefined) {
          if (u.role !== 'admin') {
            return json(apiError('auth.admin_required', 'Administrator access is required.', 403), 403);
          }
          const oid = Number(b.ownerUserId);
          const owner = db
            .query<{ id: number; username: string }, [number]>('SELECT id, username FROM users WHERE id = ?')
            .get(oid);
          if (!owner) return json(apiError('user.not_found', 'The user does not exist.', 400), 400);
          ownerUserId = oid;
          ownerUsername = owner.username;
        }
        // 越权面与建项目一致：普通用户只能导入自己 workspace 内的会话
        const myRoot = `${ex.workspaceRoot.replace(/\/+$/, '')}/u${ownerUserId}`;
        if (u.role !== 'admin' && cwd !== myRoot && !cwd.startsWith(myRoot + '/')) {
          return json(apiError(
            'project.import_workspace_forbidden',
            `Only sessions in your workspace (${myRoot}) can be imported.`,
            403,
            { root: myRoot },
          ), 403);
        }
        const ru = parseRunUser(b, u);
        if (ru.error) return ru.error;

        const warnings: string[] = [];
        let project: Project;
        let created = false;
        // 同执行机同 cwd 已有活跃项目 → 并入（只登记会话，不重复建项目）
        const same = db
          .query<ProjectRowRaw, [number, string]>(
            `SELECT * FROM projects WHERE executor_id = ? AND cwd = ? AND status = 'active'
             ORDER BY id LIMIT 1`,
          )
          .get(executorId, cwd);
        if (same) {
          project = mapProject(same);
          if (u.role !== 'admin' && project.ownerUserId !== u.id) {
            return json(apiError(
              'project.import_directory_owned',
              'Another user already has a project in this directory.',
              403,
            ), 403);
          }
        } else {
          if (
            source !== 'tmux' &&
            historySessions.every((session) => findBoundHistoryConversation(db, session) !== null)
          ) {
            return json(apiError(
              'project.import_history_assigned',
              'All history sessions for this project already belong to other projects.',
              409,
            ), 409);
          }
          const name = (str(b, 'name') ?? defaultName).slice(0, 100);
          const row = db
            .query<
              ProjectRowRaw,
              [string, number, string, number, string | null, number, string, string]
            >(
              `INSERT INTO projects
                 (name, executor_id, cwd, owner_user_id, goal, created_ts, run_user, kind)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(
              name,
              executorId,
              cwd,
              ownerUserId,
              str(b, 'goal')?.slice(0, 2000) ?? null,
              Date.now(),
              ru.value ?? '',
              'issue',
            );
          if (!row) {
            return json(apiError(
              'project.import_create_failed',
              'Could not create the imported project.',
              500,
            ), 500);
          }
          project = mapProject(row);
          created = true;
        }

        // Git 身份预检（B-01）：并入既有项目时身份早已就位，只对本次新登记的项目做。
        if (created) {
          const identityWarning = await ensureImportedProjectGitIdentity(
            driver,
            project.cwd,
            buildFallbackIdentity({ runUser: project.runUser, ownerUsername }),
          );
          if (identityWarning) warnings.push(identityWarning);
        }

        if (source === 'tmux') {
          // 登记 tmux 会话（name 主键 upsert）——ws 终端据此放行该项目 attach 此会话
          db.query(
            `INSERT INTO sessions (name, executor_id, project_id, owner_user_id) VALUES (?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET
               executor_id = excluded.executor_id,
               project_id = excluded.project_id,
               owner_user_id = excluded.owner_user_id`,
          ).run(sessionName!, executorId, project.id, ownerUserId);
          if (created && deps.notify) {
            try {
              deps.notify.ensureOwnerSubscription(project.id, ownerUserId);
            } catch (e) {
              warnings.push(`属主自动订阅失败：${String(e).slice(0, 200)}`);
            }
          }
          if (deps.projectDataSync) {
            try { await deps.projectDataSync.sync(project); }
            catch (e) { warnings.push(`.panda 同步失败，已保留待重试：${String(e).slice(0, 160)}`); }
          }
          return json({ ok: true, project: getProject(db, project.id) ?? project, created, ...(warnings.length ? { warnings } : {}) });
        }

        let historyResult;
        try {
          const archivableSessions = historySessions.filter((session) => {
            const bound = findBoundHistoryConversation(db, session);
            return !bound || bound.projectId === project.id;
          });
          await archiveHistoryConversations(driver, project.cwd, archivableSessions);
          historyResult = importHistoryConversations(db, project.id, historySessions);
        } catch (e) {
          // 本请求新建的空项目可以安全回滚；合并既有项目时事务已回滚所有会话插入。
          if (created) db.query('DELETE FROM projects WHERE id = ?').run(project.id);
          return json(apiError(
            'project.import_history_failed',
            'Could not register the project’s history sessions.',
            500,
            {},
            String(e).slice(0, 200),
          ), 500);
        }
        if (created && deps.notify) {
          try {
            deps.notify.ensureOwnerSubscription(project.id, ownerUserId);
          } catch (e) {
            warnings.push(`属主自动订阅失败：${String(e).slice(0, 200)}`);
          }
        }
        if (deps.projectDataSync) {
          try { await deps.projectDataSync.sync(project); }
          catch (e) { warnings.push(`.panda 同步失败，已保留待重试：${String(e).slice(0, 160)}`); }
        }
        return json({
          ok: true,
          project: getProject(db, project.id) ?? project,
          created,
          importedConversations: historyResult.importedIds.length,
          existingConversations: historyResult.existingIds.length,
          skippedConversations: historyResult.conflicts.length,
          conversationIds: [...historyResult.importedIds, ...historyResult.existingIds],
          ...(warnings.length ? { warnings } : {}),
        });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/sync',
      auth: 'project-access',
      handler: ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        if (!deps.projectDataSync) return json({ ok: false, error: '未接入项目同步' }, 503);
        return json({ ok: true, status: deps.projectDataSync.status(project.id) });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/sync',
      auth: 'project-access',
      handler: async ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        if (!deps.projectDataSync) return json({ ok: false, error: '未接入项目同步' }, 503);
        await deps.projectDataSync.sync(project).catch(() => {});
        return json({ ok: true, status: deps.projectDataSync.status(project.id) });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId',
      auth: 'project-access',
      handler: async ({ params }) => {
        const p = getProject(db, Number(params.projectId));
        if (!p) return json({ ok: false, error: '无此项目' }, 404);
        await deps.projectDataSync?.sync(p).catch(() => {});
        return json(getProject(db, p.id) ?? p);
      },
    },
    {
      /**
       * 项目成员列表（project-access：属主/成员/admin 皆可看谁在项目里）。
       * 属主置顶（role='owner'，createdTs=项目创建时间）+ project_members 成员（role='member'，按加入时间）。
       * 每行带活跃时间（lastLoginTs/lastSeenTs，012）与项目内 issue 统计
       * （issueTotal/issueDone，按 issues.created_by 计；created_by 为空的旧数据不归任何人）。
       */
      method: 'GET',
      path: '/api/projects/:projectId/members',
      auth: 'project-access',
      handler: ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        const owner = db
          .query<
            { username: string; last_login_ts: number | null; last_seen_ts: number | null },
            [number]
          >('SELECT username, last_login_ts, last_seen_ts FROM users WHERE id = ?')
          .get(project.ownerUserId);
        const stats = new Map<number, { total: number; done: number }>();
        for (const r of db
          .query<{ uid: number; total: number; done: number }, [number]>(
            `SELECT created_by AS uid, COUNT(*) AS total,
                    SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
               FROM issues WHERE project_id = ? AND created_by IS NOT NULL
              GROUP BY created_by`,
          )
          .all(project.id)) {
          stats.set(r.uid, { total: r.total, done: r.done });
        }
        const withStats = (userId: number) => ({
          issueTotal: stats.get(userId)?.total ?? 0,
          issueDone: stats.get(userId)?.done ?? 0,
        });
        const list = [
          {
            userId: project.ownerUserId,
            username: owner?.username ?? `#${project.ownerUserId}`,
            role: 'owner' as const,
            createdTs: project.createdTs,
            lastLoginTs: owner?.last_login_ts ?? null,
            lastSeenTs: owner?.last_seen_ts ?? null,
            ...withStats(project.ownerUserId),
          },
          ...members.list(project.id).map((m) => ({
            userId: m.userId,
            username: m.username,
            role: 'member' as const,
            createdTs: m.createdTs,
            lastLoginTs: m.lastLoginTs,
            lastSeenTs: m.lastSeenTs,
            ...withStats(m.userId),
          })),
        ];
        return json({ ok: true, members: list });
      },
    },
    {
      /**
       * 候选用户列表（成员下拉选择用，auth:'project-owner'——能加成员的人才配看全量用户名单）。
       * 全部用户排除属主与已有成员；只回 id/username（不泄露 role/token/时间），按用户名升序。
       */
      method: 'GET',
      path: '/api/projects/:projectId/member-candidates',
      auth: 'project-owner',
      handler: ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        const candidates = db
          .query<{ id: number; username: string }, [number, number]>(
            `SELECT id, username FROM users
              WHERE id != ?
                AND id NOT IN (SELECT user_id FROM project_members WHERE project_id = ?)
              ORDER BY username`,
          )
          .all(project.ownerUserId, project.id);
        return json({ ok: true, candidates });
      },
    },
    {
      /**
       * 加成员（属主/admin，auth:'project-owner'）：body.username 精确添加。
       * 无此用户→400；目标即属主→400（属主本就全权，不作为成员登记）；已是成员→幂等 200(added:false)。
       * 新增成功后自动订阅该项目通知（复用 notify.ensureOwnerSubscription；失败不阻塞、收 warnings）。
       */
      method: 'POST',
      path: '/api/projects/:projectId/members',
      auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过
        const b = await readBody(req);
        const username = str(b, 'username')?.trim();
        if (!username) return json({ ok: false, error: '缺 username' }, 400);
        const target = db
          .query<{ id: number }, [string]>('SELECT id FROM users WHERE username = ?')
          .get(username);
        if (!target) return json({ ok: false, error: `无此用户：${username}` }, 400);
        if (target.id === project.ownerUserId) {
          return json({ ok: false, error: '该用户是项目属主，无需添加为成员' }, 400);
        }
        const added = members.add(project.id, target.id);
        const warnings: string[] = [];
        if (added && deps.notify) {
          try {
            deps.notify.ensureOwnerSubscription(project.id, target.id);
          } catch (e) {
            warnings.push(`成员自动订阅失败：${String(e).slice(0, 200)}`);
          }
        }
        const m = members.list(project.id).find((x) => x.userId === target.id);
        return json({
          ok: true,
          added,
          member: {
            userId: target.id,
            username: m?.username ?? username,
            role: 'member' as const,
            createdTs: m?.createdTs ?? Date.now(),
          },
          ...(warnings.length ? { warnings } : {}),
        });
      },
    },
    {
      // 移除成员（属主/admin，auth:'project-owner'），幂等：removed=false 表示本就不是成员。
      method: 'DELETE',
      path: '/api/projects/:projectId/members/:userId',
      auth: 'project-owner',
      handler: ({ params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        const uid = Number(params.userId);
        if (!Number.isInteger(uid) || uid <= 0) return json({ ok: false, error: '非法 userId' }, 400);
        const removed = members.remove(project.id, uid);
        return json({ ok: true, removed });
      },
    },
    {
      /**
       * 转让属主（属主/admin，auth:'project-owner'）：body.userId 必须是现有成员。
       * 事务内三步：新属主移出成员表 → 原属主降为成员（保留协作权）→ 改 owner_user_id。
       * 属主本人不在成员表 → 转给自己天然 400；admin 走 /api/admin/projects/:id/owner
       * 仍可硬指派任意用户（那条不做成员置换，本条才是常规转让入口）。
       */
      method: 'POST',
      path: '/api/projects/:projectId/transfer-owner',
      auth: 'project-owner',
      handler: async ({ req, params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        const b = await readBody(req);
        const uid = Number(b.userId);
        if (!Number.isInteger(uid) || uid <= 0) return json({ ok: false, error: '非法 userId' }, 400);
        if (!members.isMember(project.id, uid)) {
          return json({ ok: false, error: '目标必须是项目现有成员' }, 400);
        }
        db.transaction(() => {
          members.remove(project.id, uid);
          members.add(project.id, project.ownerUserId);
          db.query('UPDATE projects SET owner_user_id = ? WHERE id = ?').run(uid, project.id);
        })();
        return json({ ok: true, project: getProject(db, project.id) });
      },
    },
    {
      /**
       * 迁移工程目录（admin 才能）：把项目 cwd 整体挪到 body.dest（issue #99）。
       * 校验：绝对路径、规范化后不与现目录相同/互相嵌套、现目录存在且目标不存在、
       * 项目无执行中 issue（BUSY_STATES 同调度口径）。
       * 执行：杀项目相关 tmux 会话（cc-<pid> / cc-<pid>-m-* / 本项目 chat-<convId>）→
       * mkdirp(目标父目录) → movePath → 事务内更新 projects.cwd + 清 project_active_conv
       * 与模块 conversation_id 绑定。agent 会话存储按 cwd 键控，旧对话迁移后不可 resume
       * ——清绑定后下次使用自动新建会话。
       */
      method: 'POST',
      path: '/api/projects/:projectId/cwd-migrate',
      auth: 'admin',
      handler: async ({ req, params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404);
        if (!deps.fullDriverForProject) {
          return json({ ok: false, error: '未接入执行机驱动，无法迁移目录' }, 503);
        }
        const b = await readBody(req);
        const destRaw = str(b, 'dest')?.trim() ?? '';
        if (!destRaw.startsWith('/')) return json({ ok: false, error: 'dest 必须是绝对路径' }, 400);
        const norm = (p: string): string => path.posix.normalize(p).replace(/\/+$/, '') || '/';
        const dest = norm(destRaw);
        const cur = norm(project.cwd);
        if (dest === '/') return json({ ok: false, error: '不能迁移到根目录' }, 400);
        if (dest === cur) return json({ ok: false, error: '目标与当前目录相同' }, 400);
        if (dest.startsWith(`${cur}/`) || cur.startsWith(`${dest}/`)) {
          return json({ ok: false, error: '目标不能与当前目录互相嵌套' }, 400);
        }
        const busy = db
          .query<{ n: number }, (string | number)[]>(
            `SELECT COUNT(*) AS n FROM issues WHERE project_id = ? AND status IN (${BUSY_STATES.map(() => '?').join(',')})`,
          )
          .get(project.id, ...BUSY_STATES);
        if ((busy?.n ?? 0) > 0) {
          return json({ ok: false, error: `有 ${busy!.n} 个执行中 issue，等它们收尾后再迁移` }, 409);
        }

        const driver = deps.fullDriverForProject(project);
        const killed: string[] = [];
        try {
          if ((await driver.statPath(cur)) == null) {
            return json({ ok: false, error: '当前工程目录在执行机上不存在' }, 400);
          }
          if ((await driver.statPath(dest)) != null) {
            return json({ ok: false, error: '目标路径已存在' }, 400);
          }
          // 杀项目相关 tmux 会话：issue 主会话 + 模块会话 + 本项目 chat 会话（core/conversations 命名约定）
          const chatNames = new Set(
            db
              .query<{ id: string }, [number]>(
                `SELECT id FROM conversations WHERE project_id = ? AND kind = 'chat'`,
              )
              .all(project.id)
              .map((r) => `chat-${r.id}`),
          );
          for (const s of await driver.listSessions()) {
            if (
              s.name === `cc-${project.id}` ||
              s.name.startsWith(`cc-${project.id}-m-`) ||
              chatNames.has(s.name)
            ) {
              await driver.killSession(s.name);
              killed.push(s.name);
            }
          }
          await driver.mkdirp(path.posix.dirname(dest));
          await driver.movePath(cur, dest);
        } catch (e) {
          return json({ ok: false, error: `迁移失败：${String(e).slice(0, 300)}` }, 502);
        }
        db.transaction(() => {
          db.query('UPDATE projects SET cwd = ? WHERE id = ?').run(dest, project.id);
          db.query('DELETE FROM project_active_conv WHERE project_id = ?').run(project.id);
          db.query('UPDATE project_modules SET conversation_id = NULL WHERE project_id = ?').run(
            project.id,
          );
        })();
        return json({ ok: true, project: getProject(db, project.id), killedSessions: killed });
      },
    },
    {
      /**
       * 手动「更新简介」——按 body.mode 分两条路（缺省 llm）：
       * - llm：读项目 cwd 下 README → 驱动大模型 生成 ≤200 字简介，同步落库回显（force，只看 README）。
       *     无 README → 400；LLM 失败 → 502；未接 llm/driver → 503。
       * - claude/codex：启动后台「Agent 认知总结」任务（读历史会话+浏览代码库→更新 README→产出认知），
       *     立即回 202 running（前端轮询项目 GET 的 summaryStatus/understanding）。
       *     已有任务在跑 → 409；未接编排 → 503。
       * 非法 mode → 400。
       */
      method: 'POST',
      path: '/api/projects/:projectId/readme-summary',
      auth: 'project-access',
      handler: async ({ req, params, user }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
        const mode = parseSummaryMode(await readBody(req));
        if (mode === null) {
          return json({ ok: false, error: 'mode 仅支持 llm / claude / codex' }, 400);
        }

        if (mode === 'llm') {
          if (!deps.llm || !deps.driverForProject) {
            return json({ ok: false, error: '未接入 LLM 或执行机驱动，无法生成简介' }, 503);
          }
          try {
            const r = await generateProjectReadmeSummary(
              { db, llm: deps.llm, driver: deps.driverForProject(project) },
              { id: project.id, name: project.name, cwd: project.cwd, locale: userPromptLocale(db, user?.id, project.ownerUserId) },
            );
            if (!r.ok) return json({ ok: false, error: '未找到 README，无法生成简介' }, 400);
            return json({ ok: true, summary: r.summary, project: getProject(db, project.id) });
          } catch (e) {
            const configError = llmErrorResponse(e);
            if (configError) return configError;
            return json({ ok: false, error: `简介生成失败：${String(e).slice(0, 300)}` }, 502);
          }
        }

        // mode === 'claude' | 'codex'：后台 Agent 认知总结任务
        const support = projectAgentSupport(db, project.id, mode);
        if (!support.ok) return json({ ok: false, error: support.error }, 409);
        if (!deps.summaryOrchestrator) {
          return json({ ok: false, error: '未接入 Agent 总结编排，无法用 claude/codex 生成' }, 503);
        }
        const started = deps.summaryOrchestrator.start(project, mode);
        if (!started.started) {
          return json({ ok: false, error: '已有生成任务在进行中，请稍候' }, 409);
        }
        return json(
          { ok: true, status: 'running', mode, project: getProject(db, project.id) },
          202,
        );
      },
    },
    {
      /**
       * 「更新记忆」（对话模式为主）——后台让所选 agent（body.agent=claude|codex，缺省 claude）依据
       * 对话历史 + 代码库刷新项目记忆文件（claude→CLAUDE.md / codex→AGENTS.md）并写回 understanding。
       * 复用「Agent 认知总结」的异步单飞编排（与 readme-summary 的 claude/codex 共用 summary_status，
       * 互斥不并发），立即回 202 running（前端轮询项目 GET 的 summaryStatus/understanding）。
       * 已有任务在跑 → 409；未接编排 → 503。
       */
      method: 'POST',
      path: '/api/projects/:projectId/memory',
      auth: 'project-access',
      handler: async ({ req, params }) => {
        const project = getProject(db, Number(params.projectId));
        if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
        if (!deps.summaryOrchestrator) {
          return json({ ok: false, error: '未接入 Agent 编排，无法更新记忆' }, 503);
        }
        const b = await readBody(req);
        const agent: AgentKind = b.agent === 'codex' ? 'codex' : 'claude';
        const support = projectAgentSupport(db, project.id, agent);
        if (!support.ok) return json({ ok: false, error: support.error }, 409);
        const started = deps.summaryOrchestrator.start(project, agent, 'memory');
        if (!started.started) {
          return json({ ok: false, error: '已有生成任务在进行中，请稍候' }, 409);
        }
        return json(
          { ok: true, status: 'running', agent, project: getProject(db, project.id) },
          202,
        );
      },
    },
    {
      method: 'PATCH',
      path: '/api/projects/:projectId',
      auth: 'project-owner',
      handler: async ({ req, params, user }) => {
        const id = Number(params.projectId);
        if (!getProject(db, id)) return json({ ok: false, error: '无此项目' }, 404);
        const b = await readBody(req);
        const sets: string[] = [];
        const vals: (string | number | null)[] = [];
        const ru = parseRunUser(b, user!);
        if (ru.error) return ru.error;
        if (ru.value !== undefined) {
          sets.push('run_user = ?');
          vals.push(ru.value);
        }
        const wb = parseWorkBranch(b);
        if (wb.error) return wb.error;
        if (wb.value !== undefined) {
          sets.push('work_branch = ?');
          vals.push(wb.value);
        }
        if (str(b, 'name')) {
          sets.push('name = ?');
          vals.push(str(b, 'name')!.slice(0, 100));
        }
        if ('goal' in b && (b.goal === null || typeof b.goal === 'string')) {
          sets.push('goal = ?');
          vals.push(b.goal === null ? null : (b.goal as string).slice(0, 2000));
        }
        if ('pmPersona' in b && (b.pmPersona === null || typeof b.pmPersona === 'string')) {
          sets.push('pm_persona = ?');
          vals.push(b.pmPersona === null ? null : (b.pmPersona as string).slice(0, 8000));
        }
        if (b.status === 'active' || b.status === 'archived') {
          sets.push('status = ?');
          vals.push(b.status);
        }
        // 手动确认开关（008）：true = 走 plan/merge_review 卡点等人批；默认 false 全自动流
        if (typeof b.manualReview === 'boolean') {
          sets.push('manual_review = ?');
          vals.push(b.manualReview ? 1 : 0);
        }
        // 门禁命令（047 / #279）：数组 = 显式配置；null = 清回「未配置」（按 package.json 探测）。
        // 空数组是「显式不跑门禁」，与 null 不同，必须原样落库。
        if ('validationCommands' in b) {
          if (b.validationCommands === null) {
            sets.push('validation_commands_json = ?');
            vals.push(null);
          } else if (Array.isArray(b.validationCommands)) {
            const commands: Array<{ label: string; argv: string[] }> = [];
            for (const raw of b.validationCommands as unknown[]) {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
              const o = raw as Record<string, unknown>;
              const argv = Array.isArray(o.argv)
                ? o.argv.filter((a): a is string => typeof a === 'string' && a.trim().length > 0)
                  .map((a) => a.trim()).slice(0, 20)
                : [];
              if (argv.length === 0) continue; // 空命令没有意义
              const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : argv[0]!;
              commands.push({ label: label.slice(0, 60), argv });
            }
            sets.push('validation_commands_json = ?');
            vals.push(JSON.stringify(commands.slice(0, 10)));
          } else {
            return json({ ok: false, error: 'validationCommands 必须是数组或 null' }, 400);
          }
        }
        // 项目类型固定为 issue；仅保留显式 issue 供旧客户端兼容。
        const pk = parseProjectKind(b);
        if (pk.error) return pk.error;
        if (!sets.length) return json({ ok: false, error: '没有可更新的字段' }, 400);
        db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
        return json({ ok: true, project: getProject(db, id) });
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId',
      auth: 'project-owner',
      handler: ({ params }) => {
        const id = Number(params.projectId);
        if (!getProject(db, id)) return json({ ok: false, error: '无此项目' }, 404);
        // 删除 = 归档（防误删级联清掉 issues/事件史）
        db.query(`UPDATE projects SET status = 'archived' WHERE id = ?`).run(id);
        return json({ ok: true, archived: true });
      },
    },
  ];
}

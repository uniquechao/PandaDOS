/**
 * web/routes/projects —— 项目 CRUD（spec §9-1；project 是 v2 第一实体）。
 * - 建项目 = 建 PM 记录（pm_persona/goal 就在 projects 行上）+ 可选建一条 cc 对话；
 * - 普通用户见/操作自己属主或参与（成员）的项目（列表按 owner ∨ project_members 过滤；
 *   协作类单项目路由 auth:'project-access'，项目级管理 PATCH/DELETE 仍 auth:'project-owner'）；
 * - 删除 = 归档（status='archived'），真删太危险（级联删 issues/events）留给 admin 手工。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import path from 'node:path';
import type { LlmClient } from '../../agents/llm';
import type { SummaryTarget } from '../../core/agent-summary';
import { projectAgentSupport, supportedAgents } from '../../core/executors';
import { ProjectMemberStore } from '../../core/members';
import { generateProjectReadmeSummary, type ReadmeDriver } from '../../core/readme-summary';
import type { AgentKind, Conversation, Executor, Project, ProjectKind, User } from '../../core/types';
import { getProject, mapProject } from '../../issues/engine';
import { BUSY_STATES } from '../../issues/queue';
import { json, type RouteDef } from '../middleware';
import { llmErrorResponse } from '../llm-error';
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
  driverFor?(executor: Executor): ExecutorProbe | null;
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
 * 解析 body.kind（009 迁移，项目类型）：未给/空 → undefined（POST 落默认 'issue'；PATCH 不动）；
 * 'issue'|'chat' → 值；非法 → 错误响应。
 */
function parseProjectKind(b: Record<string, unknown>): { value?: ProjectKind; error?: Response } {
  const k = b.kind;
  if (k === undefined || k === null || k === '') return {};
  if (k === 'issue' || k === 'chat') return { value: k };
  return { error: json({ ok: false, error: 'kind 必须是 issue 或 chat' }, 400) };
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

/**
 * 把 gitUrl clone 到执行机上的 target 目录：target 必须不存在或为空目录；
 * 父目录 mkdir -p 后在父目录下 `git clone -- <url> <basename>`（`--` 终止选项解析）。
 * 成功返回 null，失败返回可直接回给客户端的 Response。
 */
async function cloneInto(
  driver: ExecutorProbe,
  gitUrl: string,
  target: string,
): Promise<Response | null> {
  try {
    const st = await driver.statPath(target);
    if (st && !st.isDirectory) return json({ ok: false, error: 'clone 目标已存在且不是目录' }, 400);
    if (st && (await driver.listDir(target)).length > 0) {
      return json({ ok: false, error: `clone 目标目录已存在且非空：${target}` }, 400);
    }
    const parent = path.posix.dirname(target);
    await driver.mkdirp(parent);
    const r = await driver.git(parent, ['clone', '--', gitUrl, path.posix.basename(target)]);
    if (r.code !== 0) {
      return json({ ok: false, error: `git clone 失败：${(r.err || r.out).slice(-400)}` }, 502);
    }
    return null;
  } catch (e) {
    return json({ ok: false, error: `git clone 失败：${String(e).slice(0, 300)}` }, 502);
  }
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
        if (b.ownerUserId !== undefined) {
          if (u.role !== 'admin') return json({ ok: false, error: '仅 admin 可指定归属' }, 403);
          const oid = Number(b.ownerUserId);
          const owner = db.query<{ id: number }, [number]>('SELECT id FROM users WHERE id = ?').get(oid);
          if (!owner) return json({ ok: false, error: '无此用户' }, 400);
          ownerUserId = oid;
        }

        // Linux 用户（可选，admin-only）：本期 = 归属标记 + 默认 cwd 锚点（/home/<user>/…）
        const ru = parseRunUser(b, u);
        if (ru.error) return ru.error;
        const wb = parseWorkBranch(b);
        if (wb.error) return wb.error;
        const pk = parseProjectKind(b);
        if (pk.error) return pk.error;
        const kind: ProjectKind = pk.value ?? 'issue';
        // chat（对话模式）项目跳过 work_branch 等 issue 专属项（分支/合并对纯对话无意义）
        const workBranch = kind === 'chat' ? null : (wb.value ?? null);

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

        // clone 先行：成功才落项目行（失败不留半截项目；目录残留由错误信息指认）
        if (gitUrl) {
          if (!driver) return json({ ok: false, error: '未接入执行机驱动，无法 clone' }, 503);
          if (cwd === '/') return json({ ok: false, error: 'clone 目标不能是根目录' }, 400);
          const failed = await cloneInto(driver, gitUrl, cwd);
          if (failed) return failed;
        }

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
            kind,
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
        return json({
          ok: true,
          project,
          ...(gitUrl ? { cloned: true } : {}),
          ...(conversation ? { conversation } : {}),
          ...(warnings.length ? { warnings } : {}),
        });
      },
    },
    {
      /**
       * 导入现有 tmux 会话为项目：到执行机现查会话拿 cwd（绝不信客户端报的路径），
       * - 同执行机同 cwd 已有活跃项目 → 并入该项目（只补 sessions 登记，不重复建）；
       * - 会话已登记 → 幂等返回既有项目；
       * - cc-<pid> 托管命名空间 → 拒绝（本来就是 Mando 的会话）。
       * 导入后项目控制台可直接 attach 该会话（ws/index.ts 按 sessions 登记放行）。
       */
      method: 'POST',
      path: '/api/projects/import',
      auth: 'user',
      handler: async ({ req, user }) => {
        const u = user!;
        if (!deps.driverFor) return json({ ok: false, error: '未接入执行机驱动，无法导入' }, 503);
        const b = await readBody(req);
        const executorId = Number(b.executorId);
        const sessionName = str(b, 'session');
        if (!Number.isInteger(executorId) || executorId <= 0) {
          return json({ ok: false, error: '缺 executorId' }, 400);
        }
        // 与 ws/index.ts 终端会话名同一白名单
        if (!sessionName || !/^[\w.-]+$/.test(sessionName)) {
          return json({ ok: false, error: '缺 session 或含非法字符' }, 400);
        }
        const ex = getExecutorById(db, executorId);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 400);

        const managed = managedProjectIdOf(sessionName);
        if (managed !== null && getProject(db, managed)) {
          return json(
            { ok: false, error: `这是 Mando 托管会话（项目 #${managed}），无需导入`, projectId: managed },
            400,
          );
        }

        const driver = deps.driverFor(ex);
        if (!driver) return json({ ok: false, error: '执行机暂无可用连接' }, 503);
        let live;
        try {
          live = await driver.listSessions();
        } catch (e) {
          return json({ ok: false, error: `读取 tmux 会话失败：${String(e).slice(0, 200)}` }, 502);
        }
        const s = live.find((x) => x.name === sessionName);
        if (!s) return json({ ok: false, error: '执行机上无此 tmux 会话' }, 404);
        const cwd = s.cwd;
        if (!cwd || !cwd.startsWith('/')) {
          return json({ ok: false, error: '拿不到会话工作目录（执行机 tmux 版本过旧？）' }, 502);
        }

        // 已登记 → 幂等返回既有项目（他人已导入则拒绝，不改归属）
        const reg = db
          .query<{ project_id: number }, [string]>('SELECT project_id FROM sessions WHERE name = ?')
          .get(sessionName);
        if (reg) {
          const p = getProject(db, reg.project_id);
          if (p) {
            if (u.role !== 'admin' && p.ownerUserId !== u.id) {
              return json({ ok: false, error: '该会话已被其他用户导入' }, 403);
            }
            return json({ ok: true, project: p, created: false });
          }
          // 登记指向的项目已被真删 → 视同未登记，下面重建并覆盖登记
        }

        // 归属：默认自己；admin 可代建（与建项目同一纪律）
        let ownerUserId = u.id;
        if (b.ownerUserId !== undefined) {
          if (u.role !== 'admin') return json({ ok: false, error: '仅 admin 可指定归属' }, 403);
          const oid = Number(b.ownerUserId);
          const owner = db.query<{ id: number }, [number]>('SELECT id FROM users WHERE id = ?').get(oid);
          if (!owner) return json({ ok: false, error: '无此用户' }, 400);
          ownerUserId = oid;
        }
        // 越权面与建项目一致：普通用户只能导入自己 workspace 内的会话
        const myRoot = `${ex.workspaceRoot.replace(/\/+$/, '')}/u${ownerUserId}`;
        if (u.role !== 'admin' && cwd !== myRoot && !cwd.startsWith(myRoot + '/')) {
          return json({ ok: false, error: `只能导入自己 workspace（${myRoot}）内的会话` }, 403);
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
            return json({ ok: false, error: '该目录已有其他用户的项目，无法并入' }, 403);
          }
        } else {
          const name = (str(b, 'name') ?? sessionName).slice(0, 100);
          const row = db
            .query<
              ProjectRowRaw,
              [string, number, string, number, string | null, number, string]
            >(
              `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts, run_user)
               VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            )
            .get(name, executorId, cwd, ownerUserId, str(b, 'goal')?.slice(0, 2000) ?? null, Date.now(), ru.value ?? '');
          if (!row) return json({ ok: false, error: '创建失败' }, 500);
          project = mapProject(row);
          created = true;
          if (deps.notify) {
            try {
              deps.notify.ensureOwnerSubscription(project.id, ownerUserId);
            } catch (e) {
              warnings.push(`属主自动订阅失败：${String(e).slice(0, 200)}`);
            }
          }
        }

        // 登记 tmux 会话（name 主键 upsert）——ws 终端据此放行该项目 attach 此会话
        db.query(
          `INSERT INTO sessions (name, executor_id, project_id, owner_user_id) VALUES (?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             executor_id = excluded.executor_id,
             project_id = excluded.project_id,
             owner_user_id = excluded.owner_user_id`,
        ).run(sessionName, executorId, project.id, ownerUserId);

        return json({ ok: true, project, created, ...(warnings.length ? { warnings } : {}) });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId',
      auth: 'project-access',
      handler: ({ params }) => {
        const p = getProject(db, Number(params.projectId));
        return p ? json(p) : json({ ok: false, error: '无此项目' }, 404);
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
      handler: async ({ req, params }) => {
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
      handler: async ({ req, params }) => {
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
              { id: project.id, name: project.name, cwd: project.cwd },
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
        // 项目类型（009）：issue 看板 ↔ chat 对话模式
        const pk = parseProjectKind(b);
        if (pk.error) return pk.error;
        if (pk.value !== undefined) {
          sets.push('kind = ?');
          vals.push(pk.value);
        }
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

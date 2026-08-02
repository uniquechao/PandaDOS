/**
 * web/middleware —— 声明式鉴权中间件（评审 5.5#2 主线：默认 deny）。
 *
 * 约定（RouteDef）：每条路由必须声明 auth 级别，中间件统一在入口执行，
 * handler 拿到已解析的 user——杜绝 v1 needS/needConv 白名单表的 fail-open 事故
 * （market 三接口漏保护是现实判例）。
 *
 *   auth: 'public'          无需登录（login/logout 等极少数）
 *   auth: 'user'            任何已登录用户
 *   auth: 'admin'           仅 admin
 *   auth: 'project-owner'   从 :projectId 路径参数或 ?projectId= 解析项目，
 *                           校验 project.owner_user_id === user.id；admin 恒过。
 *                           项目级管理面（改设置/增删成员/归档删除/转属主）用它。
 *   auth: 'project-access'  同样解析项目，校验 属主 ∨ 成员（project_members）；admin 恒过。
 *                           协作面（issue/文件/git/技能/对话/终端等）用它——成员亦可操作。
 *
 * 未声明 auth（JS 调用方绕过类型）= 运行时 403；未命中任何路由 = 调用方 404。
 * 路由注册（聚合进 routes/index.ts / server fetch）由集成步骤统一做，本模块只提供
 * createDispatcher 供接线。
 */
import type { Database } from 'bun:sqlite';
import { ProjectMemberStore } from '../core/members';
import { SessionStore } from '../core/sessions';
import type { User } from '../core/types';
import type { UserStore } from '../core/users';
import { resolveUser, type SessionLookup } from './auth';
import { apiError, normalizeErrorPayload } from './errors';

// ---------- 通用 JSON 响应（与 server.ts 同风格） ----------

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(normalizeErrorPayload(body, status)), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// ---------- RouteDef 约定 ----------

export type AuthLevel = 'public' | 'user' | 'admin' | 'project-owner' | 'project-access';

export interface RouteCtx {
  req: Request;
  url: URL;
  /** 路径参数（RouteDef.path 的 :name 段，已 decodeURIComponent） */
  params: Record<string, string>;
  /** 已解析用户；仅 auth:'public' 时可能为 null，其余级别必非空 */
  user: User | null;
}

export type RouteDefHandler = (ctx: RouteCtx) => Response | Promise<Response>;

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** 支持 :param 段，如 /api/admin/users/:id/token */
  path: string;
  auth: AuthLevel;
  handler: RouteDefHandler;
}

// ---------- 路径匹配 ----------

/** 模式匹配：命中返回路径参数（可为空对象），不命中返回 null。 */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const ps = pattern.split('/').filter((s) => s.length > 0);
  const xs = pathname.split('/').filter((s) => s.length > 0);
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i]!;
    const x = xs[i]!;
    if (p.startsWith(':')) {
      try {
        params[p.slice(1)] = decodeURIComponent(x);
      } catch {
        return null;
      }
    } else if (p !== x) {
      return null;
    }
  }
  return params;
}

// ---------- 鉴权依赖 ----------

export interface AuthDeps {
  users: UserStore;
  /** 登录会话查找（飞书扫码签发）；缺省不接 = 只认长期 token */
  sessions?: SessionLookup;
  /** project-owner 级别用：返回项目属主 user id；项目不存在返回 undefined */
  getProjectOwner(projectId: number): number | undefined;
  /**
   * project-access 级别用：该用户对该项目是否有协作访问权（属主 ∨ 成员）。
   * 不判 admin（admin 在中间件里恒过）；项目不存在返回 false。供 middleware 与 WS 鉴权复用。
   */
  hasProjectAccess(projectId: number, userId: number): boolean;
}

/** 从 DB 构造标准依赖（直查 projects/project_members 表——v2 一律显式归属，无推断链） */
export function authDepsFromDb(db: Database, users: UserStore, sessions?: SessionLookup): AuthDeps {
  const members = new ProjectMemberStore(db);
  const ownerOf = (projectId: number): number | undefined => {
    const r = db
      .query<{ owner_user_id: number }, [number]>('SELECT owner_user_id FROM projects WHERE id = ?')
      .get(projectId);
    return r ? r.owner_user_id : undefined;
  };
  return {
    users,
    sessions: sessions ?? new SessionStore(db),
    getProjectOwner: ownerOf,
    hasProjectAccess(projectId: number, userId: number): boolean {
      const owner = ownerOf(projectId);
      if (owner === undefined) return false; // 项目不存在 → 无访问权
      if (owner === userId) return true; // 属主
      return members.isMember(projectId, userId); // 成员
    },
  };
}

// ---------- 中间件本体 ----------

/**
 * 单条路由的鉴权+执行。返回 Response（拒绝或 handler 结果）。
 * 导出以便单测矩阵直接打（4 级 × 命中/未命中）。
 */
export async function runRoute(
  def: RouteDef,
  req: Request,
  url: URL,
  params: Record<string, string>,
  deps: AuthDeps,
): Promise<Response> {
  // 未声明鉴权级别（类型系统被绕过时的运行时兜底）= 默认 deny
  const auth = (def as { auth?: AuthLevel }).auth;
  if (
    auth !== 'public' &&
    auth !== 'user' &&
    auth !== 'admin' &&
    auth !== 'project-owner' &&
    auth !== 'project-access'
  ) {
    return json(apiError('auth.route_undeclared', 'This route is unavailable.', 403), 403);
  }

  const user = resolveUser(req, deps.users, deps.sessions);

  if (auth !== 'public') {
    if (!user) return json(apiError('auth.required', 'Sign in to continue.', 401), 401);

    if (auth === 'admin' && user.role !== 'admin') {
      return json(apiError('auth.admin_required', 'Administrator access is required.', 403), 403);
    }

    if (auth === 'project-owner' || auth === 'project-access') {
      const raw = params.projectId ?? url.searchParams.get('projectId') ?? '';
      const pid = Number(raw);
      if (!raw || !Number.isInteger(pid) || pid <= 0) {
        return json(apiError('project.required', 'A project ID is required.', 400), 400);
      }
      const owner = deps.getProjectOwner(pid);
      if (owner === undefined) {
        // 不存在：admin 见 404，普通用户统一 403（不泄露项目是否存在）
        return user.role === 'admin'
          ? json(apiError('project.not_found', 'The project does not exist.', 404), 404)
          : json(apiError('auth.forbidden', 'You do not have permission to do this.', 403), 403);
      }
      if (user.role !== 'admin') {
        // project-owner 只认属主；project-access 放宽到属主 ∨ 成员
        const allowed =
          auth === 'project-owner' ? owner === user.id : deps.hasProjectAccess(pid, user.id);
        if (!allowed) return json(apiError('auth.forbidden', 'You do not have permission to do this.', 403), 403);
      }
    }
  }

  return def.handler({ req, url, params, user });
}

/**
 * 把一组 RouteDef 编成调度函数：命中 → 鉴权 → handler；未命中 → null（调用方 404）。
 * 集成接线（server.ts fetch 内）：
 *   const dispatch = createDispatcher([...authRoutes(d), ...meRoutes(d), ...adminRoutes(d)], authDeps);
 *   const r = dispatch(req); if (r) return r;
 */
export function createDispatcher(
  defs: RouteDef[],
  deps: AuthDeps,
): (req: Request) => Promise<Response> | null {
  return (req: Request) => {
    const url = new URL(req.url);
    for (const def of defs) {
      if (def.method !== req.method) continue;
      const params = matchPath(def.path, url.pathname);
      if (!params) continue;
      return runRoute(def, req, url, params, deps);
    }
    return null;
  };
}

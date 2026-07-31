/**
 * web/routes/executors —— 面向普通用户的执行机只读视图（建项目/导入现有 tmux 会话配套）。
 * - GET /api/executors                    执行机极简列表（补齐「执行机下拉仅 admin 有 API」的契约缺口）
 * - GET /api/executors/:id/os-users       该执行机上的 Linux 登录用户（读 /etc/passwd；项目 Linux 用户下拉）
 * - GET /api/executors/:id/tmux-sessions  该执行机上的 tmux 会话 + 导入视角标注（托管/已导入/同目录项目/越权）
 * - GET /api/executors/:id/fs?path=       目录浏览（建项目选 cwd；admin 任意，普通用户锁自己 workspace）
 * - POST /api/executors/:id/fs/mkdir      新建目录（同一越权面；mkdir -p 语义）
 * 全量登记信息（ssh_user/key_ref/claude_dir 等）仍只走 /api/admin/executors；这里绝不外泄。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import path from 'node:path';
import { getExecutor, listExecutors, supportedAgents } from '../../core/executors';
import { MAX_LIST_ENTRIES } from '../../core/files';
import type { Executor, User } from '../../core/types';
import type { DirEntry, PathStat, TmuxSession } from '../../executor/driver';
import { json, type RouteDef } from '../middleware';

// ---------- 依赖（与 ExecutorDriver 结构兼容的最小探查接口） ----------

export interface ExecutorProbe {
  listSessions(): Promise<TmuxSession[]>;
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
  statPath(path: string): Promise<PathStat | null>;
  listDir(path: string): Promise<DirEntry[]>;
  mkdirp(path: string): Promise<void>;
  git(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }>;
}

export interface ExecutorsRoutesDeps {
  db: Database;
  /** 为执行机取 Driver（server.ts driverForExecutor）；null = 暂无可用连接 */
  driverFor(executor: Executor): ExecutorProbe | null;
}

/** 按 id 取执行机全量行（projects import 路由也用它拿 workspace_root/driver 入参） */
export function getExecutorById(db: Database, id: number): Executor | undefined {
  return getExecutor(db, id);
}

// ---------- /etc/passwd 解析（纯函数，供单测） ----------

export interface OsUser {
  name: string;
  uid: number;
  home: string;
}

/** 读 /etc/passwd 的上限（正常几 KB；防呆）——projects.ts 解析 runUser 家目录共用 */
export const PASSWD_READ_LIMIT = 512 * 1024;

/**
 * passwd 文本 → 可登录用户列表：排除 nologin/false/sync/halt/shutdown 壳，
 * 只留 root(uid 0) 与常规用户(uid ≥ 1000)，按 uid 升序。
 */
export function parsePasswd(text: string): OsUser[] {
  const out: OsUser[] = [];
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length < 7) continue;
    const name = f[0]!;
    const uid = Number.parseInt(f[2]!, 10);
    const home = f[5]!;
    const shell = f[6]!.trim();
    if (!name || !Number.isInteger(uid)) continue;
    if (/(?:nologin|false|sync|halt|shutdown)$/.test(shell)) continue;
    if (uid !== 0 && uid < 1000) continue;
    out.push({ name, uid, home });
  }
  return out.sort((a, b) => a.uid - b.uid);
}

// ---------- 目录浏览（建项目选 cwd；纯函数供单测） ----------

/** 归一化绝对 POSIX 路径（拒绝非绝对/NUL）；去尾部斜杠（根除外） */
export function normalizeAbsPath(p: string): string | null {
  if (!p.startsWith('/') || p.includes('\0')) return null;
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

/** 浏览/建目录的越权面：admin 全盘；普通用户锁自己 workspace（与建项目 cwd 校验同一纪律） */
export function browseRootFor(user: User, workspaceRoot: string): string {
  if (user.role === 'admin') return '/';
  return `${workspaceRoot.replace(/\/+$/, '')}/u${user.id}`;
}

/** p 是否落在 root 内（root='/' 即全盘） */
function within(root: string, p: string): boolean {
  return root === '/' || p === root || p.startsWith(root + '/');
}

/** 新建目录名净化：去控制字符、拒绝路径分隔与 . / ..、限长 100；非法返回 null */
export function safeDirName(name: string): string | null {
  const n = (name || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  if (!n || n === '.' || n === '..' || /[/\\]/.test(n) || n.length > 100) return null;
  return n;
}

// ---------- tmux 会话导入视角标注 ----------

/** Mando 托管会话名（cc-<projectId> 及其 -console 等子命名空间） */
export function managedProjectIdOf(name: string): number | null {
  const m = /^cc-(\d+)(?:-|$)/.exec(name);
  return m ? Number(m[1]) : null;
}

export interface TmuxSessionInfo {
  name: string;
  createdTs: number;
  attached: boolean;
  cwd: string | null;
  command: string | null;
  /** Mando 托管会话（cc-<pid> 命名空间且项目存在）→ 项目 id */
  managedProjectId: number | null;
  /** 已经由 sessions 登记表导入 → 项目 id */
  importedProjectId: number | null;
  /** 同执行机同 cwd 已有活跃项目 → 项目 id（导入会并入该项目而非新建） */
  sameCwdProjectId: number | null;
  /** 当前用户是否可导入（admin 恒 true；普通用户须 cwd 落在自己 workspace 内） */
  allowed: boolean;
}

export function executorsRoutes(deps: ExecutorsRoutesDeps): RouteDef[] {
  const { db } = deps;

  const execFromParams = (params: Record<string, string>): Executor | null => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) return null;
    return getExecutorById(db, id) ?? null;
  };

  return [
    {
      method: 'GET',
      path: '/api/executors',
      auth: 'user',
      handler: () =>
        json(
          listExecutors(db)
            .sort((a, b) => Number(b.isSystemLocal) - Number(a.isSystemLocal) || a.id - b.id)
            .map((ex) => {
            const agents = supportedAgents(ex);
            return {
              id: ex.id,
              name: ex.name,
              status: ex.status,
              isSystemLocal: ex.isSystemLocal,
              supportedAgents: agents,
              availableForProjects: agents.length > 0,
              capabilitiesCheckedTs: ex.capabilitiesCheckedTs,
            };
            }),
        ),
    },
    {
      method: 'GET',
      path: '/api/executors/:id/os-users',
      auth: 'admin',
      handler: async ({ params }) => {
        const ex = execFromParams(params);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 404);
        const driver = deps.driverFor(ex);
        if (!driver) return json({ ok: false, error: '执行机暂无可用连接' }, 503);
        try {
          const { data } = await driver.readFileRange('/etc/passwd', 0, PASSWD_READ_LIMIT);
          return json({ ok: true, users: parsePasswd(new TextDecoder().decode(data)) });
        } catch (e) {
          return json({ ok: false, error: `读取用户列表失败：${String(e).slice(0, 200)}` }, 502);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/executors/:id/tmux-sessions',
      auth: 'user',
      handler: async ({ params, user }) => {
        const u = user!;
        const ex = execFromParams(params);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 404);
        const driver = deps.driverFor(ex);
        if (!driver) return json({ ok: false, error: '执行机暂无可用连接' }, 503);

        let live: TmuxSession[];
        try {
          live = await driver.listSessions();
        } catch (e) {
          return json({ ok: false, error: `读取 tmux 会话失败：${String(e).slice(0, 200)}` }, 502);
        }

        // 一次性取全该执行机的项目/登记，循环内纯内存联接
        const projects = db
          .query<{ id: number; cwd: string; status: string }, [number]>(
            'SELECT id, cwd, status FROM projects WHERE executor_id = ?',
          )
          .all(ex.id);
        const projectIds = new Set(projects.map((p) => p.id));
        const activeByCwd = new Map(
          projects.filter((p) => p.status === 'active').map((p) => [p.cwd, p.id]),
        );
        const imported = new Map(
          db
            .query<{ name: string; project_id: number }, [number]>(
              'SELECT name, project_id FROM sessions WHERE executor_id = ?',
            )
            .all(ex.id)
            .map((r) => [r.name, r.project_id]),
        );
        const myRoot = `${ex.workspaceRoot.replace(/\/+$/, '')}/u${u.id}`;

        const sessions: TmuxSessionInfo[] = live.map((s) => {
          const managed = managedProjectIdOf(s.name);
          const cwd = s.cwd ?? null;
          return {
            name: s.name,
            createdTs: s.createdTs,
            attached: s.attached,
            cwd,
            command: s.command ?? null,
            managedProjectId: managed !== null && projectIds.has(managed) ? managed : null,
            importedProjectId: imported.get(s.name) ?? null,
            sameCwdProjectId: (cwd ? activeByCwd.get(cwd) : undefined) ?? null,
            allowed:
              u.role === 'admin' ||
              (cwd !== null && (cwd === myRoot || cwd.startsWith(myRoot + '/'))),
          };
        });
        return json({ ok: true, sessions });
      },
    },
    {
      /**
       * 目录浏览（建项目 cwd 选择器）：只回目录名（挑 cwd 用不着文件），点号目录排后。
       * path 缺省 → admin 落 workspace_root、普通用户落自己 workspace；
       * 目录不存在 → ok + missing:true（前端允许「选用后自动创建」，不算错误）。
       */
      method: 'GET',
      path: '/api/executors/:id/fs',
      auth: 'user',
      handler: async ({ url, params, user }) => {
        const u = user!;
        const ex = execFromParams(params);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 404);
        const driver = deps.driverFor(ex);
        if (!driver) return json({ ok: false, error: '执行机暂无可用连接' }, 503);
        const root = browseRootFor(u, ex.workspaceRoot);
        const raw = url.searchParams.get('path') ?? '';
        const p =
          raw === ''
            ? u.role === 'admin'
              ? (normalizeAbsPath(ex.workspaceRoot) ?? '/')
              : root
            : normalizeAbsPath(raw);
        if (!p) return json({ ok: false, error: 'path 必须是绝对路径' }, 400);
        if (!within(root, p)) return json({ ok: false, error: `只能浏览你的 workspace（${root}）` }, 403);
        try {
          const st = await driver.statPath(p);
          if (!st) return json({ ok: true, path: p, root, dirs: [], missing: true });
          if (!st.isDirectory) return json({ ok: false, error: '不是目录' }, 400);
          const all = (await driver.listDir(p)).filter((e) => e.type === 'dir').map((e) => e.name);
          const truncated = all.length > MAX_LIST_ENTRIES;
          const dirs = (truncated ? all.slice(0, MAX_LIST_ENTRIES) : all).sort((a, b) =>
            a.startsWith('.') !== b.startsWith('.') ? (a.startsWith('.') ? 1 : -1) : a.localeCompare(b),
          );
          return json({ ok: true, path: p, root, dirs, ...(truncated ? { truncated: true } : {}) });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 502);
        }
      },
    },
    {
      /** 新建目录（mkdir -p 语义；已存在同名目录幂等成功，同名文件 400） */
      method: 'POST',
      path: '/api/executors/:id/fs/mkdir',
      auth: 'user',
      handler: async ({ req, params, user }) => {
        const u = user!;
        const ex = execFromParams(params);
        if (!ex) return json({ ok: false, error: '无此执行机' }, 404);
        const driver = deps.driverFor(ex);
        if (!driver) return json({ ok: false, error: '执行机暂无可用连接' }, 503);
        const b = (await req.json().catch(() => null)) as { path?: unknown; name?: unknown } | null;
        const parent = normalizeAbsPath(typeof b?.path === 'string' ? b.path : '');
        const name = safeDirName(typeof b?.name === 'string' ? b.name : '');
        if (!parent) return json({ ok: false, error: 'path 必须是绝对路径' }, 400);
        if (!name) return json({ ok: false, error: '非法目录名' }, 400);
        const root = browseRootFor(u, ex.workspaceRoot);
        const target = parent === '/' ? `/${name}` : `${parent}/${name}`;
        if (!within(root, target)) {
          return json({ ok: false, error: `只能在你的 workspace（${root}）内建目录` }, 403);
        }
        try {
          const st = await driver.statPath(target);
          if (st && !st.isDirectory) return json({ ok: false, error: '同名文件已存在' }, 400);
          if (!st) await driver.mkdirp(target);
          return json({ ok: true, path: target });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 502);
        }
      },
    },
  ];
}

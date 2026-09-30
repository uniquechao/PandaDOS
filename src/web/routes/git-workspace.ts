/**
 * web/routes/git-workspace —— 工作区（issue #388）补齐的 Git 写操作、远端同步、分支与多 worktree 管理。
 *
 * 与 routes/git.ts 共享同一把项目级 Git 写锁（gitLockKey），所有写操作在持锁后**重新读取现场**再判断；
 * 不自动 stash / reset / 强制 checkout，遇到不安全现场一律返回具体原因（结构化 code + Git 原始输出）。
 *
 *   POST git/hunk {path, side, index, header, action}  按块暂存/取消暂存/撤销（header 校验防竞态）
 *   POST git/discard {paths}                           撤销未暂存改动（仅已跟踪文件）
 *   POST git/resolve {paths}                           冲突文件标记已解决（git add）
 *   POST git/operation {action: continue|abort}       继续/中止进行中的 merge/rebase/cherry-pick/revert
 *   POST git/fetch                                     获取全部远端（--prune），回上次 fetch 时间
 *   GET  git/pull-preview                              pull 前说明：upstream、ahead/behind、脏工作区、可选方式
 *   POST git/pull {mode: ff-only|merge|rebase}        仅对有 upstream 的当前分支；脏工作区/运行中 issue 拒绝
 *   POST git/branches {name, start?, checkout?}        新建分支（可选随后切换，走同一安全检查）
 *   GET  git/checkout-check?branch=|remote=            切换前的安全检查（改动/占用 worktree/运行中 issue）
 *   POST git/checkout {branch}|{remote, local?}         切换分支；远程分支显式建本地跟踪分支
 *   GET  git/worktrees                                  工作位置列表（主/系统创建/设计托管/外部 + 关联项目）
 *   POST git/worktrees {branch, create, base?, dryRun?} 创建（仓库外受控同级目录）并登记关联项目
 *   POST git/worktrees/remove {path, deleteBranch?}    仅系统创建 + 干净 + 无运行中 issue；默认保留分支
 *   POST git/worktrees/associate {path}                外部 worktree 显式登记为项目
 *
 * 多 worktree = 多个实际 cwd = 多个关联项目；「当前改动」只是一个 cwd 的状态，两者在 API 上始终分开。
 * 任何操作都不修改既有项目的 cwd。
 */
import type { Database } from 'bun:sqlite';
import path from 'node:path';
import type { Project, User } from '../../core/types';
import type { ExecutorDriver } from '../../executor/driver';
import { PandaSyncIndex, sha256Hex } from '../../core/project-sync';
import { getProject } from '../../issues/engine';
import { gitLockKey, KeyedMutex } from '../../issues/mutex';
import { BUSY_STATES } from '../../issues/queue';
import { apiError } from '../errors';
import { json, type RouteCtx, type RouteDef } from '../middleware';
import { gitPath, operationState, readBody, safeRepoPath } from './git';

export type GitWorkspaceDriver = Pick<
  ExecutorDriver,
  'git' | 'statPath' | 'writeFile' | 'removeTree'
> & Partial<Pick<ExecutorDriver, 'readFileNoFollowWithin' | 'removeFileNoFollowWithin'>>;

export interface GitWorkspaceDeps {
  db: Database;
  driverForProject(project: Project): GitWorkspaceDriver;
  /** 必须与 routes/git.ts、引擎共用同一实例（生产由 server 传入） */
  mutex?: KeyedMutex;
  /** 新登记项目后的钩子（属主订阅 / .panda 同步）；失败不影响登记 */
  onProjectRegistered?(project: Project): Promise<void> | void;
  /** 移除 worktree 前把关联项目的 .panda 拉取一轮，让同步索引跟上刚写出的协作文件；失败按未入库处理 */
  syncProjectData?(projectId: number): Promise<unknown>;
}

const WRITE_PATHS_MAX = 500;

function fail(code: string, fallback: string, status: number, params: Record<string, unknown> = {}, details?: unknown): Response {
  return json(apiError(code, fallback, status, params, details), status);
}

function gitError(code: string, fallback: string, r: { out: string; err: string }, status = 409): Response {
  return fail(code, fallback, status, {}, (r.err.trim() || r.out.trim()).slice(0, 1000));
}

/** 分支名：只接受 git check-ref-format --branch 认可的，且不以 - 开头（防被当成选项） */
async function validBranch(driver: GitWorkspaceDriver, cwd: string, name: unknown): Promise<string | null> {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 200 || n.startsWith('-')) return null;
  const r = await driver.git(cwd, ['check-ref-format', '--branch', n]);
  return r.code === 0 ? n : null;
}

function parsePaths(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WRITE_PATHS_MAX) return null;
  const out: string[] = [];
  for (const p of raw) {
    const s = typeof p === 'string' ? safeRepoPath(p) : null;
    if (!s) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

// ---------- hunk ----------

export interface DiffHunks {
  /** diff --git … 到第一个 @@ 之前的文件头 */
  header: string[];
  hunks: string[][];
}

/** 单文件 unified diff → 文件头 + 各块（纯函数） */
export function splitHunks(diff: string): DiffHunks {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const header: string[] = [];
  const hunks: string[][] = [];
  for (const l of lines) {
    if (l.startsWith('@@')) hunks.push([l]);
    else if (hunks.length) hunks[hunks.length - 1]!.push(l);
    else header.push(l);
  }
  return { header, hunks };
}

/** 选中块拼成可 git apply 的补丁（末尾换行必须有） */
export function hunkPatch(d: DiffHunks, index: number): string | null {
  const h = d.hunks[index];
  if (!h || !d.header.some((l) => l.startsWith('--- ')) || !d.header.some((l) => l.startsWith('+++ '))) return null;
  return `${[...d.header, ...h].join('\n')}\n`;
}

// ---------- worktree ----------

export interface WorktreeRec {
  path: string;
  head: string;
  /** 短分支名；detached 为空 */
  branch: string;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/** 解析 `git worktree list --porcelain`（空行分块，路径可含空格） */
export function parseWorktreeList(out: string): WorktreeRec[] {
  const recs: WorktreeRec[] = [];
  for (const block of out.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const first = lines[0];
    if (!first?.startsWith('worktree ')) continue;
    const rec: WorktreeRec = { path: first.slice(9), head: '', branch: '', detached: false, locked: false, prunable: false };
    for (const l of lines.slice(1)) {
      if (l.startsWith('HEAD ')) rec.head = l.slice(5);
      else if (l.startsWith('branch ')) rec.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'detached') rec.detached = true;
      else if (l.startsWith('locked')) rec.locked = true;
      else if (l.startsWith('prunable')) rec.prunable = true;
    }
    recs.push(rec);
  }
  return recs;
}

export type WorktreeKind = 'main' | 'panda' | 'design' | 'external';

/** 系统创建 worktree 的受控目录：仓库父目录下的 .panda-worktrees（与设计托管同一区域，前缀区分） */
export function managedRoot(mainTop: string): string {
  return path.posix.join(path.posix.dirname(path.posix.normalize(mainTop)), '.panda-worktrees');
}

export function worktreeSlug(branch: string): string {
  const s = branch.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  return s || 'branch';
}

export function plannedWorktreePath(mainTop: string, projectId: number, branch: string): string {
  return path.posix.join(managedRoot(mainTop), `ws-${projectId}-${worktreeSlug(branch)}`);
}

export function classifyWorktree(
  rec: WorktreeRec,
  index: number,
  mainTop: string,
  designPaths: Set<string>,
): WorktreeKind {
  if (index === 0) return 'main';
  const root = managedRoot(mainTop);
  const parent = path.posix.dirname(rec.path);
  const base = path.posix.basename(rec.path);
  if (designPaths.has(rec.path) || (parent === root && /^design-\d+-\d+$/.test(base))) return 'design';
  if (parent === root && base.startsWith('ws-')) return 'panda';
  return 'external';
}

// ---------- 路由 ----------

export function gitWorkspaceRoutes(deps: GitWorkspaceDeps): RouteDef[] {
  const { db } = deps;
  const mutex = deps.mutex ?? new KeyedMutex();

  const busyCount = (projectId: number): number => {
    const list = BUSY_STATES.map(() => '?').join(', ');
    const row = db
      .query<{ n: number }, [number, ...string[]]>(`SELECT COUNT(*) AS n FROM issues WHERE project_id = ? AND status IN (${list})`)
      .get(projectId, ...BUSY_STATES);
    return row?.n ?? 0;
  };

  const canAccess = (user: User | null, projectId: number, ownerUserId: number): boolean => {
    if (!user) return false;
    if (user.role === 'admin' || user.id === ownerUserId) return true;
    return !!db
      .query<{ one: number }, [number, number]>('SELECT 1 AS one FROM project_members WHERE project_id = ? AND user_id = ?')
      .get(projectId, user.id);
  };

  interface Repo {
    project: Project;
    driver: GitWorkspaceDriver;
    cwd: string;
  }

  async function repo(ctx: RouteCtx): Promise<Repo | Response> {
    const project = getProject(db, Number(ctx.params.projectId));
    if (!project) return fail('project.not_found', 'Project not found.', 404);
    const driver = deps.driverForProject(project);
    const r = await driver.git(project.cwd, ['rev-parse', '--is-inside-work-tree']);
    if (r.code !== 0 || r.out.trim() !== 'true') {
      return fail('workspace.git.not_repo', 'This folder is not a Git repository.', 409);
    }
    return { project, driver, cwd: project.cwd };
  }

  /** 写操作：项目级 Git 锁内重新确认仓库现场 */
  async function write(ctx: RouteCtx, fn: (r: Repo) => Promise<Response>): Promise<Response> {
    try {
      return await mutex.runExclusive(gitLockKey(Number(ctx.params.projectId)), async () => {
        const r = await repo(ctx);
        if (r instanceof Response) return r;
        return fn(r);
      });
    } catch (e) {
      return fail('workspace.operation_failed', 'The operation failed.', 500, {}, String(e).slice(0, 500));
    }
  }

  async function read(ctx: RouteCtx, fn: (r: Repo) => Promise<Response>): Promise<Response> {
    try {
      const r = await repo(ctx);
      if (r instanceof Response) return r;
      return await fn(r);
    } catch (e) {
      return fail('workspace.operation_failed', 'The operation failed.', 500, {}, String(e).slice(0, 500));
    }
  }

  const currentBranch = async (r: Repo): Promise<string> => {
    const b = await r.driver.git(r.cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return b.code === 0 ? b.out.trim() : '';
  };

  const upstreamOf = async (r: Repo): Promise<string> => {
    const u = await r.driver.git(r.cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    return u.code === 0 ? u.out.trim() : '';
  };

  /**
   * 已跟踪文件的未提交改动数 / 未跟踪数。列表展示用：未跟踪的 `.panda/` 多半是登记项目后的同步产物，
   * 不计入；但**移除前**不能凭目录名放过它，见 pandaLeftovers。
   */
  const dirtyCounts = async (driver: GitWorkspaceDriver, cwd: string): Promise<{ tracked: number; untracked: number }> => {
    const st = await driver.git(cwd, ['status', '--porcelain=v1']);
    let tracked = 0;
    let untracked = 0;
    for (const l of st.out.split('\n')) {
      if (!l || l.startsWith('##')) continue;
      if (l === '?? .panda/' || l.startsWith('?? .panda/')) continue;
      if (l.startsWith('??')) untracked++;
      else tracked++;
    }
    return { tracked, untracked };
  };

  /**
   * 移除 worktree 前逐个盘点未跟踪文件（-uall）。`.panda/` 下的文件只有在「关联项目的同步索引里是 active，
   * 且当前字节指纹与索引一致」时才算可再生——内容已进数据库，删掉可随时重建；其余（用户新写的过程页、
   * 改过没同步的文件、驱动不支持安全读取）一律算用户改动，阻止移除。
   */
  async function pandaLeftovers(
    driver: GitWorkspaceDriver,
    wtPath: string,
    prefix: string,
    projectIds: number[],
  ): Promise<{ regenerable: Array<{ path: string; sha: string }>; userFiles: string[] }> {
    const st = await driver.git(wtPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const base = prefix ? `${prefix}/` : '';
    const index = new PandaSyncIndex(db);
    const regenerable: Array<{ path: string; sha: string }> = [];
    const userFiles: string[] = [];
    for (const rec of st.out.split('\0')) {
      if (!rec.startsWith('?? ')) continue;
      const file = rec.slice(3);
      const rel = file.startsWith(base) ? file.slice(base.length) : '';
      if (!rel.startsWith('.panda/')) {
        userFiles.push(file);
        continue;
      }
      let proven = false;
      if (driver.readFileNoFollowWithin && driver.removeFileNoFollowWithin) {
        const entries = projectIds.map((id) => index.byPath(id, rel)).filter((e) => e?.state === 'active' && e.fingerprint);
        if (entries.length) {
          const data = await driver.readFileNoFollowWithin(cwdFor(wtPath, prefix), rel, 25 * 1024 * 1024).catch(() => null);
          const sha = data ? sha256Hex(data.data) : '';
          if (sha && entries.some((e) => e!.fingerprint === sha)) {
            regenerable.push({ path: rel, sha });
            proven = true;
          }
        }
      }
      if (!proven) userFiles.push(file);
    }
    return { regenerable, userFiles };
  }

  const worktrees = async (r: Repo): Promise<{ list: WorktreeRec[]; top: string; mainTop: string }> => {
    const [wl, topR] = await Promise.all([
      r.driver.git(r.cwd, ['worktree', 'list', '--porcelain']),
      r.driver.git(r.cwd, ['rev-parse', '--show-toplevel']),
    ]);
    const list = wl.code === 0 ? parseWorktreeList(wl.out) : [];
    const top = topR.code === 0 ? topR.out.trim() : r.cwd;
    return { list, top, mainTop: list[0]?.path ?? top };
  };

  const designPaths = (projectIds: number[]): Set<string> => {
    const set = new Set<string>();
    if (!projectIds.length) return set;
    let rows: Array<{ worktree_cwd: string | null }> = [];
    try {
      rows = db
      .query<{ worktree_cwd: string | null }, number[]>(
        `SELECT worktree_cwd FROM design_execution_runs WHERE worktree_cwd IS NOT NULL AND project_id IN (${projectIds.map(() => '?').join(', ')})`,
      )
      .all(...projectIds);
    } catch { /* 设计模块未迁移（离线/精简库）：只按目录命名识别 */ }
    for (const row of rows) if (row.worktree_cwd) set.add(row.worktree_cwd);
    return set;
  };

  /** 同执行机、cwd = worktree 路径 + 仓库前缀 的活跃项目 */
  const projectsAt = (executorId: number, cwd: string): Array<{ id: number; name: string; owner_user_id: number }> =>
    db
      .query<{ id: number; name: string; owner_user_id: number }, [number, string]>(
        `SELECT id, name, owner_user_id FROM projects WHERE executor_id = ? AND cwd = ? AND status = 'active' ORDER BY id`,
      )
      .all(executorId, cwd);

  /**
   * 绑在当前 cwd 上的运行中 issue 数：本项目 + 同执行机同 cwd 的其他活跃项目（它们共用同一份工作树）。
   * checkout / pull 共用这道门禁——会改 HEAD 或工作树文件的操作不能在代理干活时动它的现场。
   */
  const busyAtCwd = (r: Repo): number => {
    const ids = new Set([r.project.id, ...projectsAt(r.project.executorId, r.project.cwd).map((p) => p.id)]);
    let n = 0;
    for (const id of ids) n += busyCount(id);
    return n;
  };

  const prefixOf = async (r: Repo): Promise<string> => {
    const p = await r.driver.git(r.cwd, ['rev-parse', '--show-prefix']);
    return p.code === 0 ? p.out.trim().replace(/\/+$/, '') : '';
  };

  const cwdFor = (wtPath: string, prefix: string): string => (prefix ? path.posix.join(wtPath, prefix) : wtPath);

  /** 为 worktree cwd 登记项目：同执行机同 cwd 已有活跃项目则复用（不重复登记、不改其 cwd） */
  async function registerProject(source: Project, cwd: string, branch: string): Promise<Project> {
    const existing = projectsAt(source.executorId, cwd)[0];
    if (existing) return getProject(db, existing.id)!;
    const name = `${source.name} · ${branch || path.posix.basename(cwd)}`.slice(0, 100);
    const row = db
      .query<{ id: number }, [string, number, string, number, number, string, string]>(
        `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts, run_user, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(name, source.executorId, cwd, source.ownerUserId, Date.now(), source.runUser ?? '', 'issue');
    const id = row!.id;
    // 协作成员随行：能在原项目操作的人，在同仓库的另一工作位置也能操作
    db.query(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, created_ts)
       SELECT ?, user_id, ? FROM project_members WHERE project_id = ?`,
    ).run(id, Date.now(), source.id);
    const project = getProject(db, id)!;
    try {
      await deps.onProjectRegistered?.(project);
    } catch { /* 订阅/同步失败不影响登记，属主可在项目页重试 */ }
    return getProject(db, id) ?? project;
  }

  interface Blocker {
    code: 'dirty' | 'issue_running' | 'branch_in_worktree' | 'operation_in_progress';
    count?: number;
    path?: string;
    projectId?: number | null;
    operation?: string;
  }

  /** 切换分支前的安全检查（持锁前给 UI 预判，持锁后再跑一遍作准） */
  async function checkoutBlockers(r: Repo, branch: string, user: User | null): Promise<Blocker[]> {
    const blockers: Blocker[] = [];
    const dirty = await dirtyCounts(r.driver, r.cwd);
    if (dirty.tracked > 0) blockers.push({ code: 'dirty', count: dirty.tracked });
    const running = busyAtCwd(r);
    if (running > 0) blockers.push({ code: 'issue_running', count: running });
    const op = await operationState(r.driver, r.cwd);
    if (op) blockers.push({ code: 'operation_in_progress', operation: op });
    if (branch) {
      const { list, top } = await worktrees(r);
      const prefix = await prefixOf(r);
      const holder = list.find((w) => w.branch === branch && w.path !== top);
      if (holder) {
        const proj = projectsAt(r.project.executorId, cwdFor(holder.path, prefix))
          .find((p) => canAccess(user, p.id, p.owner_user_id));
        blockers.push({ code: 'branch_in_worktree', path: holder.path, projectId: proj?.id ?? null });
      }
    }
    return blockers;
  }

  const blockedResponse = (blockers: Blocker[]): Response =>
    json({
      ...apiError('workspace.git.checkout_blocked', 'The branch cannot be switched safely right now.', 409, {}, JSON.stringify(blockers)),
      blockers,
    }, 409);

  /** 解析 checkout 请求：本地分支 or 远程跟踪分支（需建本地分支） */
  async function checkoutTarget(r: Repo, body: Record<string, unknown>): Promise<{ branch: string; remote?: string } | Response> {
    if (typeof body.remote === 'string' && body.remote) {
      const remote = body.remote.trim();
      if (remote.startsWith('-') || !safeRepoPath(remote)) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 400);
      const ok = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}`]);
      if (ok.code !== 0) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 404);
      const local = await validBranch(r.driver, r.cwd, body.local ?? remote.slice(remote.indexOf('/') + 1));
      if (!local) return fail('workspace.git.branch_invalid', 'Enter a valid branch name.', 400);
      const exists = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]);
      if (exists.code === 0) return fail('workspace.git.branch_exists', 'A local branch with this name already exists.', 409, { branch: local });
      return { branch: local, remote };
    }
    const branch = await validBranch(r.driver, r.cwd, body.branch);
    if (!branch) return fail('workspace.git.branch_invalid', 'Enter a valid branch name.', 400);
    const exists = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (exists.code !== 0) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 404);
    return { branch };
  }

  async function doCheckout(r: Repo, t: { branch: string; remote?: string }, user: User | null): Promise<Response> {
    const blockers = await checkoutBlockers(r, t.remote ? '' : t.branch, user);
    if (blockers.length) return blockedResponse(blockers);
    const res = await r.driver.git(r.cwd, t.remote
      ? ['checkout', '-b', t.branch, '--track', t.remote]
      : ['checkout', t.branch]);
    if (res.code !== 0) return gitError('workspace.git.checkout_failed', 'Git could not switch branches.', res);
    return json({ ok: true, branch: t.branch, ...(t.remote ? { tracking: t.remote } : {}) });
  }

  return [
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/hunk',
      auth: 'project-access',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        const file = typeof b.path === 'string' ? safeRepoPath(b.path) : null;
        const side = b.side === 'staged' ? 'staged' : b.side === 'unstaged' ? 'unstaged' : null;
        const action = b.action;
        const index = Number(b.index);
        if (!file || !side || !Number.isInteger(index) || index < 0 || typeof b.header !== 'string') {
          return fail('workspace.git.hunk_invalid', 'The selected change block is invalid.', 400);
        }
        const allowed = side === 'staged' ? action === 'unstage' : action === 'stage' || action === 'discard';
        if (!allowed) return fail('workspace.git.hunk_invalid', 'The selected change block is invalid.', 400);
        return write(ctx, async (r) => {
          const d = await r.driver.git(r.cwd, side === 'staged'
            ? ['diff', '--cached', '--', file]
            : ['diff', '--', file]);
          if (d.code !== 0) return gitError('workspace.git.hunk_failed', 'Git could not apply the change block.', d);
          const parsed = splitHunks(d.out);
          // 块头逐字比对：diff 在用户查看后变化（代理还在写）即拒绝，避免暂存到别的块
          if (parsed.hunks[index]?.[0] !== b.header) {
            return fail('workspace.git.hunk_stale', 'The file changed. Refresh the diff and try again.', 409);
          }
          const patch = hunkPatch(parsed, index);
          if (!patch) return fail('workspace.git.hunk_invalid', 'The selected change block is invalid.', 400);
          const tmp = `/tmp/panda-hunk-${crypto.randomUUID()}.patch`;
          try {
            await r.driver.writeFile(tmp, patch);
            const args = action === 'stage'
              ? ['apply', '--cached', '--whitespace=nowarn', tmp]
              : action === 'unstage'
                ? ['apply', '--cached', '-R', '--whitespace=nowarn', tmp]
                : ['apply', '-R', '--whitespace=nowarn', tmp];
            const res = await r.driver.git(r.cwd, args);
            if (res.code !== 0) return gitError('workspace.git.hunk_failed', 'Git could not apply the change block.', res);
            return json({ ok: true });
          } finally {
            await r.driver.removeTree(tmp).catch(() => {});
          }
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/discard',
      auth: 'project-access',
      handler: async (ctx) => {
        const paths = parsePaths((await readBody(ctx.req)).paths);
        if (!paths) return fail('workspace.path_invalid', 'The path must stay inside the project directory.', 400);
        return write(ctx, async (r) => {
          // 未跟踪文件不在这里删：删除走文件删除交互（有名称与影响确认）
          const tracked = await r.driver.git(r.cwd, ['ls-files', '--error-unmatch', '--', ...paths]);
          if (tracked.code !== 0) {
            return fail('workspace.git.discard_untracked', 'Untracked files must be deleted from the file menu.', 409, {}, tracked.err.slice(0, 500));
          }
          const res = await r.driver.git(r.cwd, ['checkout', '--', ...paths]);
          if (res.code !== 0) return gitError('workspace.git.discard_failed', 'Git could not discard the changes.', res);
          return json({ ok: true });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/resolve',
      auth: 'project-access',
      handler: async (ctx) => {
        const paths = parsePaths((await readBody(ctx.req)).paths);
        if (!paths) return fail('workspace.path_invalid', 'The path must stay inside the project directory.', 400);
        return write(ctx, async (r) => {
          const res = await r.driver.git(r.cwd, ['add', '--', ...paths]);
          if (res.code !== 0) return gitError('workspace.git.resolve_failed', 'Git could not mark the conflict as resolved.', res);
          return json({ ok: true });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/operation',
      auth: 'project-access',
      handler: async (ctx) => {
        const action = (await readBody(ctx.req)).action;
        if (action !== 'continue' && action !== 'abort') {
          return fail('workspace.git.operation_invalid', 'Choose continue or abort.', 400);
        }
        return write(ctx, async (r) => {
          const op = await operationState(r.driver, r.cwd);
          if (!op) return fail('workspace.git.no_operation', 'No merge, rebase, cherry-pick, or revert is in progress.', 409);
          const res = await r.driver.git(r.cwd, ['-c', 'core.editor=true', op, `--${action}`]);
          if (res.code !== 0) {
            return gitError(action === 'continue' ? 'workspace.git.continue_failed' : 'workspace.git.abort_failed',
              'Git could not finish the operation.', res);
          }
          return json({ ok: true, operation: op, action });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/fetch',
      auth: 'project-access',
      handler: (ctx) => write(ctx, async (r) => {
        const res = await r.driver.git(r.cwd, ['fetch', '--all', '--prune']);
        if (res.code !== 0) return gitError('workspace.git.fetch_failed', 'Git could not fetch from the remote.', res, 502);
        const fh = await gitPath(r.driver, r.cwd, 'FETCH_HEAD');
        const st = fh ? await r.driver.statPath(fh).catch(() => null) : null;
        return json({ ok: true, lastFetchTs: st?.mtimeMs ?? Date.now() });
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/pull-preview',
      auth: 'project-access',
      handler: (ctx) => read(ctx, async (r) => {
        const branch = await currentBranch(r);
        const upstream = branch ? await upstreamOf(r) : '';
        const dirty = await dirtyCounts(r.driver, r.cwd);
        let ahead = 0;
        let behind = 0;
        if (upstream) {
          const c = await r.driver.git(r.cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
          const [a, b] = c.out.trim().split(/\s+/).map(Number);
          ahead = a ?? 0;
          behind = b ?? 0;
        }
        const operation = await operationState(r.driver, r.cwd);
        const running = busyAtCwd(r);
        const modes = !upstream || behind === 0 ? [] : ahead === 0 ? ['ff-only'] : ['merge', 'rebase'];
        return json({ ok: true, branch, upstream, ahead, behind, dirty: dirty.tracked, untracked: dirty.untracked, operation, running, modes });
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/pull',
      auth: 'project-access',
      handler: async (ctx) => {
        const mode = (await readBody(ctx.req)).mode;
        if (mode !== 'ff-only' && mode !== 'merge' && mode !== 'rebase') {
          return fail('workspace.git.pull_mode_invalid', 'Choose how to integrate remote changes.', 400);
        }
        return write(ctx, async (r) => {
          const branch = await currentBranch(r);
          if (!branch) return fail('workspace.git.detached', 'You are not on a branch.', 409);
          const upstream = await upstreamOf(r);
          if (!upstream) return fail('workspace.git.no_upstream', 'The current branch has no upstream branch.', 409, { branch });
          if (await operationState(r.driver, r.cwd)) {
            return fail('workspace.git.operation_in_progress', 'Finish or abort the operation in progress first.', 409);
          }
          // 持锁后复查：代理正在这份工作树上干活时，即使暂时干净也不能改它的 HEAD / 文件
          const running = busyAtCwd(r);
          if (running > 0) {
            return fail('workspace.git.worktree_busy', 'An issue is still running in this work location.', 409, { count: running });
          }
          const dirty = await dirtyCounts(r.driver, r.cwd);
          if (dirty.tracked > 0) {
            // 不自动 stash：先让用户处理本地改动
            return fail('workspace.git.dirty', 'Commit or discard local changes first.', 409, { count: dirty.tracked });
          }
          const c = await r.driver.git(r.cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
          const [ahead = 0, behind = 0] = c.out.trim().split(/\s+/).map(Number);
          if (behind === 0) return json({ ok: true, upToDate: true, upstream });
          if (mode === 'ff-only' && ahead > 0) {
            return fail('workspace.git.diverged', 'Local and remote branches have diverged. Choose merge or rebase.', 409, { ahead, behind });
          }
          const args = mode === 'ff-only'
            ? ['pull', '--ff-only']
            : mode === 'merge'
              ? ['-c', 'core.editor=true', 'pull', '--no-rebase', '--no-edit']
              : ['-c', 'core.editor=true', 'pull', '--rebase'];
          const res = await r.driver.git(r.cwd, args);
          if (res.code !== 0) {
            const op = await operationState(r.driver, r.cwd);
            return fail(op ? 'workspace.git.pull_conflict' : 'workspace.git.pull_failed',
              'Git could not pull the remote changes.', op ? 409 : 502, { operation: op ?? '' },
              (res.err.trim() || res.out.trim()).slice(0, 1000));
          }
          return json({ ok: true, upstream, mode });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/branches',
      auth: 'project-access',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        return write(ctx, async (r) => {
          const name = await validBranch(r.driver, r.cwd, b.name);
          if (!name) return fail('workspace.git.branch_invalid', 'Enter a valid branch name.', 400);
          const exists = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
          if (exists.code === 0) return fail('workspace.git.branch_exists', 'A local branch with this name already exists.', 409, { branch: name });
          const start = typeof b.start === 'string' && b.start.trim() ? b.start.trim() : 'HEAD';
          if (start.startsWith('-')) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 400);
          const sv = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`]);
          if (sv.code !== 0) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 404);
          if (b.checkout === true) {
            const blockers = await checkoutBlockers(r, '', ctx.user);
            if (blockers.length) return blockedResponse(blockers);
          }
          const res = await r.driver.git(r.cwd, ['branch', name, sv.out.trim()]);
          if (res.code !== 0) return gitError('workspace.git.branch_failed', 'Git could not create the branch.', res);
          if (b.checkout === true) {
            const co = await r.driver.git(r.cwd, ['checkout', name]);
            if (co.code !== 0) return gitError('workspace.git.checkout_failed', 'Git could not switch branches.', co);
          }
          return json({ ok: true, branch: name, checkedOut: b.checkout === true });
        });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/checkout-check',
      auth: 'project-access',
      handler: (ctx) => read(ctx, async (r) => {
        const remote = ctx.url.searchParams.get('remote');
        const t = await checkoutTarget(r, remote ? { remote } : { branch: ctx.url.searchParams.get('branch') ?? '' });
        if (t instanceof Response) return t;
        const blockers = await checkoutBlockers(r, t.remote ? '' : t.branch, ctx.user);
        return json({ ok: true, branch: t.branch, ...(t.remote ? { tracking: t.remote } : {}), blockers });
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/checkout',
      auth: 'project-access',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        return write(ctx, async (r) => {
          const t = await checkoutTarget(r, b);
          if (t instanceof Response) return t;
          return doCheckout(r, t, ctx.user);
        });
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/worktrees',
      auth: 'project-access',
      handler: (ctx) => read(ctx, async (r) => {
        const { list, top, mainTop } = await worktrees(r);
        const prefix = await prefixOf(r);
        const design = designPaths([r.project.id]);
        const items = await Promise.all(list.slice(0, 50).map(async (w, i) => {
          const kind = classifyWorktree(w, i, mainTop, design);
          const exists = w.prunable ? null : await r.driver.statPath(w.path).catch(() => null);
          const dirty = exists ? await dirtyCounts(r.driver, w.path) : null;
          const projects = projectsAt(r.project.executorId, cwdFor(w.path, prefix))
            .filter((p) => canAccess(ctx.user, p.id, p.owner_user_id))
            .map((p) => ({ id: p.id, name: p.name, running: busyCount(p.id) }));
          return {
            path: w.path,
            branch: w.branch,
            head: w.head.slice(0, 12),
            detached: w.detached,
            locked: w.locked,
            prunable: w.prunable || !exists,
            kind,
            current: w.path === top,
            changes: dirty ? dirty.tracked + dirty.untracked : null,
            projects,
          };
        }));
        return json({
          ok: true,
          prefix,
          managedRoot: managedRoot(mainTop),
          suggestedPrefix: `${managedRoot(mainTop)}/ws-${r.project.id}-`,
          worktrees: items,
        });
      }),
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/worktrees',
      auth: 'project-owner',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        return write(ctx, async (r) => {
          const branch = await validBranch(r.driver, r.cwd, b.branch);
          if (!branch) return fail('workspace.git.branch_invalid', 'Enter a valid branch name.', 400);
          const create = b.create === true;
          const exists = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
          let base = '';
          if (create) {
            if (exists.code === 0) return fail('workspace.git.branch_exists', 'A local branch with this name already exists.', 409, { branch });
            const start = typeof b.base === 'string' && b.base.trim() ? b.base.trim() : 'HEAD';
            if (start.startsWith('-')) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 400);
            const sv = await r.driver.git(r.cwd, ['rev-parse', '--verify', '--quiet', `${start}^{commit}`]);
            if (sv.code !== 0) return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 404);
            base = sv.out.trim();
          } else if (exists.code !== 0) {
            return fail('workspace.git.ref_invalid', 'The branch or commit was not found.', 404);
          }
          const { list, mainTop } = await worktrees(r);
          const holder = list.find((w) => w.branch === branch);
          if (holder) return fail('workspace.git.branch_in_worktree', 'This branch is already used by another work location.', 409, { path: holder.path });
          const target = plannedWorktreePath(mainTop, r.project.id, branch);
          if (b.dryRun === true) return json({ ok: true, dryRun: true, path: target, branch });
          if (await r.driver.statPath(target)) {
            return fail('workspace.git.worktree_path_exists', 'The target folder already exists.', 409, { path: target });
          }
          const res = await r.driver.git(r.cwd, create
            ? ['worktree', 'add', '-b', branch, target, base]
            : ['worktree', 'add', target, branch]);
          if (res.code !== 0) return gitError('workspace.git.worktree_add_failed', 'Git could not create the work location.', res);
          const prefix = await prefixOf(r);
          const project = await registerProject(r.project, cwdFor(target, prefix), branch);
          return json({ ok: true, path: target, branch, project: { id: project.id, name: project.name, cwd: project.cwd } });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/worktrees/remove',
      auth: 'project-owner',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        if (typeof b.path !== 'string' || !b.path.startsWith('/')) {
          return fail('workspace.git.worktree_not_found', 'The work location was not found.', 400);
        }
        const wanted = path.posix.normalize(b.path);
        return write(ctx, async (r) => {
          const { list, mainTop, top } = await worktrees(r);
          const idx = list.findIndex((w) => w.path === wanted);
          if (idx < 0) return fail('workspace.git.worktree_not_found', 'The work location was not found.', 404);
          const w = list[idx]!;
          const kind = classifyWorktree(w, idx, mainTop, designPaths([r.project.id]));
          if (kind !== 'panda' || w.path === top) {
            return fail('workspace.git.worktree_protected', 'Only work locations created here can be removed.', 409, { kind });
          }
          const prefix = await prefixOf(r);
          const linked = projectsAt(r.project.executorId, cwdFor(w.path, prefix));
          const running = linked.reduce((n, p) => n + busyCount(p.id), 0);
          if (running > 0) return fail('workspace.git.worktree_busy', 'An issue is still running in this work location.', 409, { count: running });
          // 先把关联项目的 .panda 拉一轮（拉取自己持关联项目的锁），再持住关联项目的 Git 锁做「盘点 → 删产物 →
          // worktree remove → 归档」：否则 .panda 写出（同样走关联项目的锁）可能在盘点后、remove 前插进新文件
          for (const p of linked) await deps.syncProjectData?.(p.id).catch(() => {});
          const lockIds = [...new Set(linked.map((p) => p.id))].filter((id) => id !== r.project.id).sort((a, c) => a - c);
          const holdAll = (ids: number[], fn: () => Promise<Response>): Promise<Response> =>
            ids.length ? mutex.runExclusive(gitLockKey(ids[0]!), () => holdAll(ids.slice(1), fn)) : fn();
          return holdAll(lockIds, async () => {
            if (await r.driver.statPath(w.path)) {
              const dirty = await dirtyCounts(r.driver, w.path);
              const left = await pandaLeftovers(r.driver, w.path, prefix, linked.map((p) => p.id));
              const count = dirty.tracked + left.userFiles.length;
              if (count > 0) {
                return fail('workspace.git.worktree_dirty', 'This work location has uncommitted changes.', 409, { count },
                  left.userFiles.slice(0, 50).join('\n'));
              }
              // 只剩已入库的 .panda 同步产物：逐个按指纹删除（期间被改过就 conflict → 放弃移除），
              // 否则 git worktree remove（不加 --force）会拒绝未跟踪文件
              const cwd = cwdFor(w.path, prefix);
              for (const f of left.regenerable) {
                const res = await r.driver.removeFileNoFollowWithin!(cwd, f.path, f.sha);
                if (res === 'conflict') {
                  return fail('workspace.git.worktree_dirty', 'This work location has uncommitted changes.', 409, { count: 1 }, f.path);
                }
              }
            }
            const res = await r.driver.git(r.cwd, ['worktree', 'remove', w.path]);
            if (res.code !== 0) return gitError('workspace.git.worktree_remove_failed', 'Git could not remove the work location.', res);
            for (const p of linked) db.query(`UPDATE projects SET status = 'archived' WHERE id = ?`).run(p.id);
            let branchDeleted = false;
            let branchError = '';
            if (b.deleteBranch === true && w.branch) {
              // 安全删除（-d）：未合并的分支 Git 会拒绝，保留分支并如实回报
              const del = await r.driver.git(r.cwd, ['branch', '-d', w.branch]);
              branchDeleted = del.code === 0;
              if (!branchDeleted) branchError = (del.err.trim() || del.out.trim()).slice(0, 500);
            }
            return json({ ok: true, path: w.path, branch: w.branch, branchDeleted, ...(branchError ? { branchError } : {}), archivedProjects: linked.map((p) => p.id) });
          });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/worktrees/associate',
      auth: 'project-owner',
      handler: async (ctx) => {
        const b = await readBody(ctx.req);
        if (typeof b.path !== 'string' || !b.path.startsWith('/')) {
          return fail('workspace.git.worktree_not_found', 'The work location was not found.', 400);
        }
        const wanted = path.posix.normalize(b.path);
        return write(ctx, async (r) => {
          const { list, mainTop } = await worktrees(r);
          const idx = list.findIndex((w) => w.path === wanted);
          if (idx < 0) return fail('workspace.git.worktree_not_found', 'The work location was not found.', 404);
          const w = list[idx]!;
          const kind = classifyWorktree(w, idx, mainTop, designPaths([r.project.id]));
          if (kind === 'design') {
            return fail('workspace.git.worktree_protected', 'Only work locations created here can be removed.', 409, { kind });
          }
          if (!(await r.driver.statPath(w.path))) return fail('workspace.git.worktree_not_found', 'The work location was not found.', 404);
          const project = await registerProject(r.project, cwdFor(w.path, await prefixOf(r)), w.branch);
          return json({ ok: true, project: { id: project.id, name: project.name, cwd: project.cwd } });
        });
      },
    },
  ];
}

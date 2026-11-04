import { KeyedMutex } from '../../issues/mutex';
import { issueWorkspaceCwd } from '../../core/workspace-ownership';
/**
 * web/routes/files —— 项目文件浏览（v1 web.ts /api/files|file|download|upload 平移改造）。
 *
 * 五端点，全部 auth:'project-access'（属主/成员/admin），路径一律相对项目 cwd（core/files.resolveProjectPath
 * 词法限定，越界 400）；文件操作经 Driver 落到执行机（Local/SSH 同构，spec §2 边界）：
 *   GET  /api/projects/:projectId/fs?path=          列目录（dir 在前按名排，带 size/mtime/mode）
 *   GET  /api/projects/:projectId/fs/file?path=     读文本（≤1MB，二进制 415）
 *   PUT  /api/projects/:projectId/fs/file?path=     写回已有文本（新文件走上传）
 *   GET  /api/projects/:projectId/fs/download?path= 下载（octet-stream+attachment，≤32MB）
 *   GET  /api/projects/:projectId/fs/raw?path=      内联预览（按扩展名推断 content-type + inline，≤32MB）
 *   POST /api/projects/:projectId/fs/upload?path=   multipart 上传到已有目录（≤20MB）
 *
 * 工作区（issue #388）补齐的写操作与查询，错误一律结构化 code（errors.workspace.*）：
 *   GET    fs?path=&git=1                   同列目录，另附每个条目的 Git 状态标记（gitMarks）
 *   GET    fs/stat?path=&count=1            存在性/类型；目录可带有界递归计数（删除确认展示影响）
 *   POST   fs/file?path=                    新建文件（已存在 409，父目录须存在）
 *   POST   fs/mkdir?path=                   新建目录（已存在 409）
 *   POST   fs/move {from,to}                重命名/移动（目标存在 409，不移入自身）
 *   DELETE fs?path=&recursive=1&expectVersion= 删除；非空目录必须显式 recursive 且目录版本与确认时一致
 *   GET    fs/search?q=&mode=name|content&path= 名称/内容搜索（有界；内容走 git grep --no-index）
 *   GET    fs/download-dir?path=            目录打包下载（tar.gz，≤32MB）
 *   PUT    fs/file 可带 baseMtimeMs：文件在编辑期间被改动则 409，防覆盖别人的写入
 *
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  contentTypeForExt,
  isProbablyBinary,
  isScriptableType,
  MAX_DOWNLOAD_BYTES,
  MAX_FS_UPLOAD_BYTES,
  MAX_LIST_ENTRIES,
  MAX_RAW_BYTES,
  MAX_TEXT_BYTES,
  resolveProjectPath,
  safeFsFileName,
} from '../../core/files';
import type { Project } from '../../core/types';
import type { ExecutorDriver } from '../../executor/driver';
import { getProject } from '../../issues/engine';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

/** 本模块需要的 Driver 子集（结构兼容 ExecutorDriver，测试可传替身） */
export type FilesDriver = Pick<
  ExecutorDriver,
  'statPath' | 'listDir' | 'readFileRange' | 'writeFile' | 'git'
> & Partial<Pick<ExecutorDriver, 'mkdirp' | 'movePath' | 'removeTree' | 'runCommand'>>;

/** 删除确认/目录计数的递归上限（超出只报 truncated，不再继续走） */
const COUNT_LIMIT = 10_000;
/** 搜索结果上限与名称搜索最多访问的目录数 */
const SEARCH_RESULTS = 200;
const SEARCH_DIRS = 3_000;
/** 名称搜索默认跳过的巨型目录（内容搜索由 .gitignore 决定） */
const SEARCH_SKIP = new Set(['.git', 'node_modules']);

function fail(code: string, fallback: string, status: number, params: Record<string, unknown> = {}, details?: unknown): Response {
  return json(apiError(code, fallback, status, params, details), status);
}

/** 条目 Git 状态标记：U 冲突 > M/A/D/R 改动 > ? 未跟踪 > ! 忽略；目录下有改动记 '•' */
export type GitMark = 'U' | 'M' | 'A' | 'D' | 'R' | '?' | '!' | '•';
const MARK_RANK: Record<GitMark, number> = { U: 7, M: 6, A: 6, D: 6, R: 6, '•': 5, '?': 4, '!': 1 };

/** 解析 `status --porcelain=v1 -z`：XY path\0[orig\0] */
export function parsePorcelainZ(out: string): Array<{ xy: string; path: string }> {
  const parts = out.split('\0');
  const res: Array<{ xy: string; path: string }> = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    res.push({ xy, path: p.slice(3) });
    if (xy[0] === 'R' || xy[0] === 'C') i++; // 跳过原路径
  }
  return res;
}

/**
 * 目录 rel 下各直接子项的 Git 标记。paths 为仓库根相对，prefix 为 cwd 相对仓库根的前缀（show-prefix）。
 * 纯函数，便于单测。
 */
export function gitMarksFor(
  entries: Array<{ xy: string; path: string }>,
  prefix: string,
  rel: string,
): Record<string, GitMark> {
  const marks: Record<string, GitMark> = {};
  const base = prefix + (rel ? `${rel}/` : '');
  for (const e of entries) {
    if (!e.path.startsWith(base)) continue;
    const rest = e.path.slice(base.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    const name = slash >= 0 ? rest.slice(0, slash) : rest;
    const deeper = slash >= 0 && slash < rest.length - 1;
    let mark: GitMark;
    if (e.xy === '!!') mark = '!';
    else if (e.xy === '??') mark = deeper ? '•' : '?';
    else if (e.xy.includes('U') || e.xy === 'AA' || e.xy === 'DD') mark = 'U';
    else if (deeper) mark = '•';
    else {
      const c = e.xy[0] !== ' ' ? e.xy[0]! : e.xy[1]!;
      mark = (c === 'A' || c === 'D' || c === 'R' ? c : 'M') as GitMark;
    }
    const prev = marks[name];
    if (!prev || MARK_RANK[mark] > MARK_RANK[prev]) marks[name] = mark;
  }
  return marks;
}

/** 解析 `git grep -n --null` 输出：path\0line\0text（兼容无 --null 的 path:line:text） */
export function parseGrep(out: string, limit: number): Array<{ path: string; line: number; text: string }> {
  const res: Array<{ path: string; line: number; text: string }> = [];
  for (const row of out.split('\n')) {
    if (!row) continue;
    const a = row.indexOf('\0');
    const b = a >= 0 ? row.indexOf('\0', a + 1) : -1;
    if (a < 0 || b < 0) continue;
    const line = Number(row.slice(a + 1, b));
    if (!Number.isFinite(line)) continue;
    res.push({ path: row.slice(0, a), line, text: row.slice(b + 1).slice(0, 300) });
    if (res.length >= limit) break;
  }
  return res;
}

/** multipart 组帧开销余量（同 routes/uploads.ts 的 Content-Length 先行拦截） */
const MULTIPART_OVERHEAD = 64 * 1024;

export interface FilesRoutesDeps {
  mutex?: KeyedMutex;
  db: Database;
  /** 项目所在执行机的 Driver（server.ts driverForProject；executor 缺失即失败） */
  driverForProject(project: Project): FilesDriver;
}

/** 列表条目（stat 失败如坏符号链时三元数据为 null） */
interface FsEntry {
  name: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number | null;
  mtimeMs: number | null;
  mode: number | null;
}

/** 解析 ?path= 到 cwd 内绝对路径；越界返回 null。rel 是归一化后的相对路径（'' = 根） */
function resolveReq(project: Project, url: URL): { full: string; rel: string } | null {
  const raw = url.searchParams.get('path') ?? '';
  const full = resolveProjectPath(project.cwd, raw);
  if (full === null) return null;
  const base = resolveProjectPath(project.cwd, '')!;
  const rel = full === base ? '' : full.slice(base.length + 1);
  return { full, rel };
}

/** Content-Disposition：ASCII 兜底 + RFC 5987 UTF-8 文件名（disposition = attachment/inline） */
function dispositionHeader(disposition: 'attachment' | 'inline', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 目录下各直接子项的 Git 标记；非仓库/命令失败返回 null（文件区照常可用） */
async function dirGitMarks(driver: FilesDriver, cwd: string, rel: string): Promise<Record<string, GitMark> | null> {
  const pre = await driver.git(cwd, ['rev-parse', '--show-prefix']);
  if (pre.code !== 0) return null;
  const st = await driver.git(cwd, [
    'status', '--porcelain=v1', '-z', '--ignored=matching', '--untracked-files=normal', '--', rel || '.',
  ]);
  if (st.code !== 0) return null;
  return gitMarksFor(parsePorcelainZ(st.out), pre.out.trim(), rel);
}

/**
 * 有界递归计数（文件 / 目录）；超出 COUNT_LIMIT 置 truncated。
 * version = 全部条目「类型 + 相对路径」排序后的摘要：删除确认时带回，期间任何增删改名（含空目录）都会让它变化。
 */
async function countTree(
  driver: FilesDriver,
  full: string,
): Promise<{ files: number; dirs: number; truncated: boolean; version: string }> {
  let files = 0;
  let dirs = 0;
  const seen: string[] = [];
  const queue = [''];
  const done = (truncated: boolean) => ({
    files, dirs, truncated,
    version: createHash('sha256').update(seen.sort().join('\0')).digest('hex').slice(0, 32),
  });
  while (queue.length) {
    const rel = queue.shift()!;
    // 盘点失败必须阻止删除，不能把无法读取的目录误当成空目录。
    const list = await driver.listDir(rel ? path.posix.join(full, rel) : full);
    for (const e of list) {
      if (files + dirs >= COUNT_LIMIT) return done(true);
      const child = rel ? `${rel}/${e.name}` : e.name;
      seen.push(`${e.type === 'dir' ? 'd' : 'f'} ${child}`);
      if (e.type === 'dir') {
        dirs++;
        queue.push(child);
      } else {
        files++;
      }
    }
  }
  return done(false);
}

/** 新路径的末段名校验：非空、非 . / ..、无控制字符、≤200 */
function validLeaf(rel: string): boolean {
  const leaf = rel.split('/').pop() ?? '';
  return !!leaf && leaf !== '.' && leaf !== '..' && leaf.length <= 200 && !/[\x00-\x1f\x7f]/.test(leaf);
}

export function filesRoutes(deps: FilesRoutesDeps): RouteDef[] {
  const { db } = deps;

  /** 各 handler 公共前置：取项目 + Driver + 路径限定（失败直接给 Response） */
  function prepare(
    params: Record<string, string>,
    url: URL,
  ): { project: Project; driver: FilesDriver; full: string; rel: string } | Response {
    let project = getProject(db, Number(params.projectId));
    if (project && url.searchParams.has('issue')) {
      const cwd = issueWorkspaceCwd(db,project.id,url.searchParams.get('issue')!);
      if (!cwd) return json({ok:false,error:'工作区不存在'},404);
      project = {...project,cwd};
    }
    if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
    const p = resolveReq(project, url);
    if (!p) return json({ ok: false, error: '路径越界' }, 400);
    return { project, driver: deps.driverForProject(project), ...p };
  }

  /** 新增写操作的前置：结构化错误码版本的 prepare；raw 缺省取 ?path= */
  function prepareW(
    params: Record<string, string>,
    raw: string,
    issueId?: string | null,
  ): { project: Project; driver: FilesDriver; full: string; rel: string } | Response {
    let project = getProject(db, Number(params.projectId));
    if (project && issueId) {
      const cwd = issueWorkspaceCwd(db,project.id,issueId);
      const held = db.query("SELECT 1 FROM workspace_attempts WHERE issue_id=? AND released_ts IS NULL AND result_sha IS NULL").get(issueId);
      if (!cwd || !held) return fail('workspace.path_invalid','工作区不可写',409);
      project = {...project,cwd};
    }
    if (!project) return fail('project.not_found', 'Project not found.', 404);
    const full = resolveProjectPath(project.cwd, raw);
    if (full === null) return fail('workspace.path_invalid', 'The path must stay inside the project directory.', 400);
    const base = resolveProjectPath(project.cwd, '')!;
    const rel = full === base ? '' : full.slice(base.length + 1);
    return { project, driver: deps.driverForProject(project), full, rel };
  }

  const opFailed = (e: unknown): Response =>
    fail('workspace.operation_failed', 'The file operation failed.', 500, {}, String(e).slice(0, 500));

  const routes: RouteDef[] = [
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs/stat',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: true, path: c.rel, exists: false });
          const count = st.isDirectory && url.searchParams.get('count') === '1'
            ? await countTree(c.driver, c.full)
            : undefined;
          return json({
            ok: true,
            path: c.rel,
            exists: true,
            type: st.isDirectory ? 'dir' : st.isFile ? 'file' : 'other',
            size: st.size,
            mtimeMs: st.mtimeMs,
            ...(count ? { count } : {}),
          });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/fs/file',
      auth: 'project-access',
      handler: async ({ req, url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        if (!c.rel || !validLeaf(c.rel)) return fail('workspace.name_invalid', 'Enter a valid name.', 400);
        const body = (await req.json().catch(() => ({}))) as { content?: unknown };
        const content = typeof body?.content === 'string' ? body.content : '';
        const data = new TextEncoder().encode(content);
        if (data.length > MAX_TEXT_BYTES) return fail('workspace.too_large', 'The content is larger than 1 MB.', 413);
        try {
          if (await c.driver.statPath(c.full)) {
            return fail('workspace.exists', 'A file or folder with this name already exists.', 409, { path: c.rel });
          }
          const parent = await c.driver.statPath(path.posix.dirname(c.full));
          if (!parent?.isDirectory) return fail('workspace.parent_missing', 'The target folder no longer exists.', 409);
          await c.driver.writeFile(c.full, data);
          const st = await c.driver.statPath(c.full);
          return json({ ok: true, path: c.rel, mtimeMs: st?.mtimeMs ?? null });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/fs/mkdir',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        if (!c.rel || !validLeaf(c.rel)) return fail('workspace.name_invalid', 'Enter a valid name.', 400);
        if (!c.driver.mkdirp) return fail('workspace.operation_failed', 'The file operation failed.', 501);
        try {
          if (await c.driver.statPath(c.full)) {
            return fail('workspace.exists', 'A file or folder with this name already exists.', 409, { path: c.rel });
          }
          const parent = await c.driver.statPath(path.posix.dirname(c.full));
          if (!parent?.isDirectory) return fail('workspace.parent_missing', 'The target folder no longer exists.', 409);
          await c.driver.mkdirp(c.full);
          return json({ ok: true, path: c.rel });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/fs/move',
      auth: 'project-access',
      handler: async ({ req, params, url }) => {
        const body = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown };
        if (typeof body?.from !== 'string' || typeof body?.to !== 'string') {
          return fail('workspace.path_invalid', 'The path must stay inside the project directory.', 400);
        }
        const src = prepareW(params, body.from, url.searchParams.get('issue'));
        if (src instanceof Response) return src;
        const dst = prepareW(params, body.to, url.searchParams.get('issue'));
        if (dst instanceof Response) return dst;
        if (!src.rel || !dst.rel || !validLeaf(dst.rel)) return fail('workspace.name_invalid', 'Enter a valid name.', 400);
        if (dst.rel === src.rel) return json({ ok: true, path: dst.rel });
        if (dst.rel.startsWith(`${src.rel}/`)) {
          return fail('workspace.move_into_self', 'A folder cannot be moved into itself.', 400);
        }
        if (!src.driver.movePath) return fail('workspace.operation_failed', 'The file operation failed.', 501);
        try {
          if (!(await src.driver.statPath(src.full))) {
            return fail('workspace.not_found', 'The file was moved or no longer exists.', 404, { path: src.rel });
          }
          if (await src.driver.statPath(dst.full)) {
            return fail('workspace.exists', 'A file or folder with this name already exists.', 409, { path: dst.rel });
          }
          const parent = await src.driver.statPath(path.posix.dirname(dst.full));
          if (!parent?.isDirectory) return fail('workspace.parent_missing', 'The target folder no longer exists.', 409);
          await src.driver.movePath(src.full, dst.full);
          return json({ ok: true, from: src.rel, path: dst.rel });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'DELETE',
      path: '/api/projects/:projectId/fs',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        if (!c.rel) return fail('workspace.delete_root', 'The project root cannot be deleted.', 400);
        if (!c.driver.removeTree) return fail('workspace.operation_failed', 'The file operation failed.', 501);
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return fail('workspace.not_found', 'The file was moved or no longer exists.', 404, { path: c.rel });
          if (st.isDirectory) {
            const count = await countTree(c.driver, c.full);
            const total = count.files + count.dirs;
            if (total > 0) {
              // 不做隐式递归删除：必须显式 recursive=1，且确认时看到的目录版本仍然成立
              // （文件数不变但多了空目录/换了文件也算变化 → 409，让用户看最新影响再确认）
              if (url.searchParams.get('recursive') !== '1') {
                return fail('workspace.dir_not_empty', 'The folder is not empty.', 409, { files: count.files, dirs: count.dirs });
              }
              if (count.truncated || url.searchParams.get('expectVersion') !== count.version) {
                return fail('workspace.delete_count_changed', 'The folder contents changed. Review it again before deleting.', 409,
                  { files: count.files, dirs: count.dirs });
              }
            }
          }
          await c.driver.removeTree(c.full);
          return json({ ok: true, path: c.rel });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs/search',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        const q = (url.searchParams.get('q') ?? '').trim();
        if (!q || q.length > 200) return fail('workspace.search_query_required', 'Enter text to search for.', 400);
        const mode = url.searchParams.get('mode') === 'content' ? 'content' : 'name';
        try {
          if (mode === 'content') {
            // --no-index 让非 Git 目录也能搜；--exclude-standard 仍尊重 .gitignore；-I 跳过二进制
            const r = await c.driver.git(c.project.cwd, [
              'grep', '--no-index', '--exclude-standard', '-n', '-I', '-i', '-F', '--null',
              '--max-count=20', '-e', q, '--', c.rel || '.',
            ]);
            if (r.code > 1) {
              return fail('workspace.operation_failed', 'The file operation failed.', 500, {}, r.err.slice(0, 500));
            }
            const results = parseGrep(r.out, SEARCH_RESULTS);
            return json({ ok: true, mode, q, results, truncated: results.length >= SEARCH_RESULTS });
          }
          const needle = q.toLowerCase();
          const results: Array<{ path: string; type: string }> = [];
          const queue = [c.rel];
          let visited = 0;
          let truncated = false;
          while (queue.length && results.length < SEARCH_RESULTS) {
            if (++visited > SEARCH_DIRS) { truncated = true; break; }
            const dir = queue.shift()!;
            const full = resolveProjectPath(c.project.cwd, dir)!;
            const list = await c.driver.listDir(full).catch(() => []);
            for (const e of list) {
              const rel = dir ? `${dir}/${e.name}` : e.name;
              if (e.name.toLowerCase().includes(needle)) {
                results.push({ path: rel, type: e.type });
                if (results.length >= SEARCH_RESULTS) { truncated = true; break; }
              }
              if (e.type === 'dir' && !SEARCH_SKIP.has(e.name)) queue.push(rel);
            }
          }
          return json({ ok: true, mode, q, results, truncated });
        } catch (e) {
          return opFailed(e);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs/download-dir',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepareW(params, url.searchParams.get('path') ?? '', url.searchParams.get('issue'));
        if (c instanceof Response) return c;
        if (!c.driver.runCommand || !c.driver.removeTree) {
          return fail('workspace.operation_failed', 'The file operation failed.', 501);
        }
        const tmp = `/tmp/panda-dl-${crypto.randomUUID()}.tar.gz`;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st?.isDirectory) return fail('workspace.not_directory', 'This is not a folder.', 400);
          const r = await c.driver.runCommand(c.full, ['tar', '-czf', tmp, '-C', c.full, '.'], 60_000);
          if (r.code !== 0 || r.timedOut) {
            return fail('workspace.operation_failed', 'The file operation failed.', 500, {}, (r.err || r.out).slice(-500));
          }
          const ts = await c.driver.statPath(tmp);
          if (!ts) return fail('workspace.operation_failed', 'The file operation failed.', 500);
          if (ts.size > MAX_DOWNLOAD_BYTES) return fail('workspace.too_large', 'The archive is larger than 32 MB.', 413);
          const fr = await c.driver.readFileRange(tmp, 0, Math.max(ts.size, 1));
          const name = `${(c.rel.split('/').pop() || path.posix.basename(c.project.cwd) || 'workspace')}.tar.gz`;
          return new Response(fr.data as BodyInit, {
            headers: {
              'content-type': 'application/gzip',
              'content-disposition': dispositionHeader('attachment', name),
            },
          });
        } catch (e) {
          return opFailed(e);
        } finally {
          await c.driver.removeTree(tmp).catch(() => {});
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '目录不存在' }, 404);
          if (!st.isDirectory) return json({ ok: false, error: '不是目录' }, 400);
          const names = await c.driver.listDir(c.full);
          const truncated = names.length > MAX_LIST_ENTRIES;
          const slice = truncated ? names.slice(0, MAX_LIST_ENTRIES) : names;
          const entries: FsEntry[] = await Promise.all(
            slice.map(async (e) => {
              const es = await c.driver.statPath(path.posix.join(c.full, e.name)).catch(() => null);
              return {
                name: e.name,
                type: e.type,
                size: es?.size ?? null,
                mtimeMs: es?.mtimeMs ?? null,
                mode: es?.mode ?? null,
              };
            }),
          );
          entries.sort((a, b) =>
            (a.type === 'dir') !== (b.type === 'dir')
              ? a.type === 'dir'
                ? -1
                : 1
              : a.name.localeCompare(b.name),
          );
          const marks = url.searchParams.get('git') === '1' ? await dirGitMarks(c.driver, c.project.cwd, c.rel) : null;
          const ex = db
            .query<{ name: string; is_system_local: number }, [number]>('SELECT name, is_system_local FROM executors WHERE id = ?')
            .get(c.project.executorId);
          return json({
            ok: true,
            cwd: c.project.cwd,
            // 复制「执行机绝对路径」时标注是哪台执行机（远程执行机上的路径在本机不可用）
            executor: ex ? { name: ex.name, local: ex.is_system_local === 1 } : null,
            path: c.rel,
            entries: marks ? entries.map((e) => (marks[e.name] ? { ...e, git: marks[e.name] } : e)) : entries,
            ...(truncated ? { truncated: true } : {}),
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs/file',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '文件不存在' }, 404);
          if (!st.isFile) return json({ ok: false, error: '不是文件' }, 400);
          if (st.size > MAX_TEXT_BYTES) return json({ ok: false, error: '文件超过 1MB，请下载查看' }, 413);
          const fr = await c.driver.readFileRange(c.full, 0, MAX_TEXT_BYTES);
          if (isProbablyBinary(fr.data)) return json({ ok: false, error: '二进制文件，请下载查看' }, 415);
          return json({
            ok: true,
            path: c.rel,
            content: new TextDecoder().decode(fr.data),
            size: fr.data.length,
            mtimeMs: st.mtimeMs,
            mode: st.mode,
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'PUT',
      path: '/api/projects/:projectId/fs/file',
      auth: 'project-access',
      handler: async ({ req, url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;
        const body = (await req.json().catch(() => null)) as { content?: unknown; baseMtimeMs?: unknown } | null;
        if (!body || typeof body.content !== 'string') {
          return json({ ok: false, error: '需要 JSON body {content: string}' }, 400);
        }
        const data = new TextEncoder().encode(body.content);
        if (data.length > MAX_TEXT_BYTES) return json({ ok: false, error: '内容超过 1MB' }, 413);
        try {
          // 只允许写回已有文件（v1 语义：新文件走上传，防手滑在任意路径创建）
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '文件不存在（新文件请用上传）' }, 404);
          if (!st.isFile) return json({ ok: false, error: '不是文件' }, 400);
          // 乐观并发：打开时的 mtime 与当前不一致 → 期间被代理/他人改过，拒绝覆盖
          if (typeof body.baseMtimeMs === 'number' && Math.abs(st.mtimeMs - body.baseMtimeMs) > 1) {
            return fail('workspace.file_changed', 'The file changed after you opened it. Reload it before saving.', 409, { path: c.rel });
          }
          await c.driver.writeFile(c.full, data);
          const after = await c.driver.statPath(c.full).catch(() => null);
          return json({ ok: true, size: data.length, mtimeMs: after?.mtimeMs ?? null });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/fs/download',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '文件不存在' }, 404);
          if (!st.isFile) return json({ ok: false, error: '不是文件' }, 400);
          if (st.size > MAX_DOWNLOAD_BYTES) return json({ ok: false, error: '文件超过 32MB' }, 413);
          const fr = await c.driver.readFileRange(c.full, 0, Math.max(st.size, 1));
          const name = c.rel.split('/').pop() || 'download';
          return new Response(fr.data as BodyInit, {
            headers: {
              'content-type': 'application/octet-stream',
              'content-disposition': dispositionHeader('attachment', name),
            },
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      // 内联预览：按扩展名推断 content-type + Content-Disposition: inline（供 <img>/<iframe>/PDF 直读原始字节）。
      // 与 download 的区别：download 恒 octet-stream+attachment（浏览器下载）；raw 让浏览器就地渲染。
      method: 'GET',
      path: '/api/projects/:projectId/fs/raw',
      auth: 'project-access',
      handler: async ({ url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;
        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '文件不存在' }, 404);
          if (!st.isFile) return json({ ok: false, error: '不是文件' }, 400);
          if (st.size > MAX_RAW_BYTES) return json({ ok: false, error: '文件超过 32MB，请下载查看' }, 413);
          const fr = await c.driver.readFileRange(c.full, 0, Math.max(st.size, 1));
          const name = c.rel.split('/').pop() || 'file';
          const ct = contentTypeForExt(name);
          const headers: Record<string, string> = {
            'content-type': ct,
            'content-disposition': dispositionHeader('inline', name),
            // 关掉 MIME 嗅探：服务端声明的 content-type 说了算，防把文本当 HTML 执行
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=0, must-revalidate',
          };
          // html/svg 可执行脚本：加 CSP sandbox 兜底（前端另有 sandbox iframe，双保险防 XSS 读控制面 cookie）
          if (isScriptableType(ct)) headers['content-security-policy'] = 'sandbox';
          return new Response(fr.data as BodyInit, { headers });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/fs/upload',
      auth: 'project-access',
      handler: async ({ req, url, params }) => {
        const c = prepare(params, url);
        if (c instanceof Response) return c;

        // 声明长度先挡一刀——超大 body 不进 formData 全量缓冲（同 routes/uploads.ts）
        const declared = Number(req.headers.get('content-length') ?? Number.NaN);
        if (Number.isFinite(declared) && declared > MAX_FS_UPLOAD_BYTES + MULTIPART_OVERHEAD) {
          return json({ ok: false, error: '文件过大(>20MB)' }, 413);
        }

        try {
          const st = await c.driver.statPath(c.full);
          if (!st) return json({ ok: false, error: '目标目录不存在' }, 404);
          if (!st.isDirectory) return json({ ok: false, error: '目标不是目录' }, 400);

          let fd: FormData;
          try {
            fd = await req.formData();
          } catch {
            return json({ ok: false, error: '需要 multipart/form-data（file 字段）' }, 400);
          }
          const file = fd.get('file');
          if (!file || typeof file === 'string') return json({ ok: false, error: '无文件' }, 400);
          const name = safeFsFileName(file.name || '');
          if (!name) return json({ ok: false, error: '非法文件名' }, 400);
          if (file.size > MAX_FS_UPLOAD_BYTES) return json({ ok: false, error: '文件过大(>20MB)' }, 413);

          const data = new Uint8Array(await file.arrayBuffer());
          await c.driver.writeFile(path.posix.join(c.full, name), data);
          return json({ ok: true, name, path: c.rel ? `${c.rel}/${name}` : name, size: data.length });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
  ];
  const mutex=deps.mutex ?? new KeyedMutex();
  return routes.map(route=>({...route,handler:async ctx=>{
    const id=ctx.url.searchParams.get('issue');
    if(!id || route.method==='GET')return route.handler(ctx);
    const cwd=issueWorkspaceCwd(db,Number(ctx.params.projectId),id);
    const a=cwd ? db.query<{id:string;workspace_id:number},[string]>('SELECT id,workspace_id FROM workspace_attempts WHERE issue_id=? ORDER BY created_ts DESC,rowid DESC LIMIT 1').get(id):null;
    if(!a)return fail('workspace.path_invalid','工作区不可写',409);
    return mutex.runExclusive(`workspace-git:${a.workspace_id}`,()=>{
      if(!db.query('SELECT 1 FROM workspace_attempts a JOIN module_workspaces w ON w.current_attempt=a.id WHERE a.id=? AND a.released_ts IS NULL AND a.result_sha IS NULL AND a.stop_confirmed=0').get(a.id))return fail('workspace.path_invalid','工作区执行轮次不可写',409);
      return route.handler(ctx);
    });
  }}));
}

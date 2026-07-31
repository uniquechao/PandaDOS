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
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
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
import { json, type RouteDef } from '../middleware';

/** 本模块需要的 Driver 子集（结构兼容 ExecutorDriver，测试可传替身） */
export type FilesDriver = Pick<
  ExecutorDriver,
  'statPath' | 'listDir' | 'readFileRange' | 'writeFile'
>;

/** multipart 组帧开销余量（同 routes/uploads.ts 的 Content-Length 先行拦截） */
const MULTIPART_OVERHEAD = 64 * 1024;

export interface FilesRoutesDeps {
  db: Database;
  /** 项目所在执行机的 Driver（server.ts driverForProject；executor 缺失回退主 Driver） */
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

export function filesRoutes(deps: FilesRoutesDeps): RouteDef[] {
  const { db } = deps;

  /** 各 handler 公共前置：取项目 + Driver + 路径限定（失败直接给 Response） */
  function prepare(
    params: Record<string, string>,
    url: URL,
  ): { project: Project; driver: FilesDriver; full: string; rel: string } | Response {
    const project = getProject(db, Number(params.projectId));
    if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
    const p = resolveReq(project, url);
    if (!p) return json({ ok: false, error: '路径越界' }, 400);
    return { project, driver: deps.driverForProject(project), ...p };
  }

  return [
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
          return json({
            ok: true,
            cwd: c.project.cwd,
            path: c.rel,
            entries,
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
        const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
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
          await c.driver.writeFile(c.full, data);
          return json({ ok: true, size: data.length });
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
}

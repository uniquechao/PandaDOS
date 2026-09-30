/**
 * web/preview —— 「完整网页预览」隔离服务（issue #388）。
 *
 * 目标：HTML 连同相对 CSS / 图片 / JS 一起加载执行，但预览网页**拿不到控制面的任何权限**。
 *
 * 机制：
 *  - 入口：`POST /api/projects/:projectId/fs/preview?path=`（project-access）签发短时令牌，返回
 *    `/preview/<令牌>/<入口相对路径>`。令牌 = base64url(JSON{p,c,e,x}) + '.' + HMAC-SHA256，
 *    绑定项目 id、签发时的 cwd、入口文件与过期时间；密钥进程内随机，重启即全部失效。
 *  - 服务：`GET /preview/<令牌>/<相对路径>` **不走登录态**（不读 cookie、不走 dispatcher），只认令牌；
 *    相对路径按浏览器对入口 URL 的标准解析得到，所以资源路径天然「以 HTML 所在目录解析」。
 *  - 隔离：每个响应都带 `Content-Security-Policy: sandbox allow-scripts …`（不含 allow-same-origin），
 *    文档被强制放进 opaque origin——读不到控制面 cookie / localStorage，同源 API 请求按跨站处理
 *    （SameSite=Lax 会话 cookie 不随行，响应也不可读），也无法注册 service worker（另外显式拒绝
 *    带 `Service-Worker` 头的脚本请求）。可选再挂独立端口/域名（PANDA_PREVIEW_PORT / PANDA_PREVIEW_ORIGIN）。
 *  - 令牌只授权「这个网页」而不是整个项目（#388 复核）：入口必须是 HTML；入口所在目录子树内放行网页静态资源
 *    （HTML/CSS/JS/wasm/图片/字体/音视频），目录外只放行被动资源（图片/字体/音视频，覆盖 `../assets/x.png`）；
 *    其余类型（md/json/ts/配置/文本…）一律 404。页面 JS 读得到 URL 里的令牌，所以同时用 CSP 收紧外传通道：
 *    只允许同预览来源与 data:/blob: 资源，connect-src/form-action 为 none，沙箱不给 allow-popups / allow-forms。
 *    残余：脚本仍可把自身导航到外站带走令牌——令牌 30 分钟过期且只能读上述资源，这是可接受上限。
 *  - 边界：只读、只 GET/HEAD；路径词法限定在 cwd 内，且拒绝任何以 `.` 开头的路径段（.git / .env 等）；
 *    cwd 变更（项目迁移）后旧令牌失效。
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import {
  contentTypeForExt,
  MAX_RAW_BYTES,
  resolveProjectPath,
} from '../core/files';
import type { Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { getProject } from '../issues/engine';
import { apiError } from './errors';
import { json, type RouteDef } from './middleware';

export type PreviewDriver = Pick<ExecutorDriver, 'statPath' | 'readFileRange'>;

/** 令牌有效期：足够看完一次预览；过期后前端「重新加载」会重新签发 */
export const PREVIEW_TTL_MS = 30 * 60 * 1000;

/**
 * 预览文档的 CSP：sandbox 允许脚本但不给 allow-same-origin（opaque origin 即隔离的关键），也不给弹窗/表单；
 * 资源只认同预览来源与 data:/blob:，禁 fetch/XHR/WebSocket 与表单提交——堵住页面脚本把令牌带出去的常见通道。
 */
export const PREVIEW_CSP = [
  'sandbox allow-scripts allow-modals allow-downloads allow-pointer-lock',
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
  "style-src 'self' 'unsafe-inline' data: blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
].join('; ');

const DOCUMENT_EXTS = new Set(['html', 'htm', 'xhtml']);
/** 入口目录内才放行的主动资源（可执行 / 决定页面行为） */
const ACTIVE_EXTS = new Set(['css', 'js', 'mjs', 'wasm']);
/** 入口目录外也放行的被动资源（`../assets/logo.png` 一类） */
const PASSIVE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'oga', 'm4a', 'mp4', 'webm', 'ogv',
]);

const extOf = (rel: string): string => {
  const leaf = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = leaf.lastIndexOf('.');
  return dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '';
};

/** 能否作为完整网页预览的入口 */
export function previewEntryAllowed(rel: string): boolean {
  return previewPathAllowed(rel) && DOCUMENT_EXTS.has(extOf(rel));
}

/**
 * 令牌授权范围：入口所在目录子树内放行网页静态资源；目录外只放行被动资源。
 * rel / entry 均为已通过 previewPathAllowed 的项目内相对路径。
 */
export function previewResourceAllowed(entry: string, rel: string): boolean {
  const ext = extOf(rel);
  if (PASSIVE_EXTS.has(ext)) return true;
  if (!DOCUMENT_EXTS.has(ext) && !ACTIVE_EXTS.has(ext)) return false;
  const slash = entry.lastIndexOf('/');
  const dir = slash >= 0 ? entry.slice(0, slash + 1) : '';
  return rel.startsWith(dir);
}

interface TokenBody {
  /** 项目 id */
  p: number;
  /** 签发时的 cwd（项目迁移后旧令牌自动失效） */
  c: string;
  /** 入口文件相对路径 */
  e: string;
  /** 过期时间戳（ms） */
  x: number;
}

export interface PreviewServiceDeps {
  db: Database;
  driverForProject(project: Project): PreviewDriver;
  /** 注入密钥（测试用）；缺省每进程随机 32 字节 */
  secret?: Uint8Array;
  /** 独立预览来源（如 https://preview.example.com）；缺省同主机 /preview/ 路径 */
  origin?: string;
  now?(): number;
}

function b64url(buf: Uint8Array | string): string {
  return Buffer.from(buf).toString('base64url');
}

/** 预览路径是否允许：拒绝空段、`..`、以及任何点号开头的段（隐藏文件/目录，含 .git/.env） */
export function previewPathAllowed(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.startsWith('/')) return false;
  return rel.split('/').every((seg) => seg.length > 0 && !seg.startsWith('.'));
}

export function createPreviewService(deps: PreviewServiceDeps) {
  const secret = deps.secret ?? randomBytes(32);
  const now = deps.now ?? Date.now;
  const origin = (deps.origin ?? '').replace(/\/+$/, '');

  const sign = (payload: string): string =>
    createHmac('sha256', secret).update(payload).digest('base64url');

  function mint(project: Project, entry: string): { token: string; url: string; expiresAt: number } {
    const body: TokenBody = { p: project.id, c: project.cwd, e: entry, x: now() + PREVIEW_TTL_MS };
    const payload = b64url(JSON.stringify(body));
    const token = `${payload}.${sign(payload)}`;
    const path = entry.split('/').map(encodeURIComponent).join('/');
    return { token, url: `${origin}/preview/${token}/${path}`, expiresAt: body.x };
  }

  function verify(token: string): TokenBody | null {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const payload = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(sign(payload), 'base64url');
    if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenBody;
      if (typeof body.p !== 'number' || typeof body.c !== 'string' || typeof body.e !== 'string' || typeof body.x !== 'number') return null;
      if (body.x < now()) return null;
      return body;
    } catch {
      return null;
    }
  }

  const deny = (status: number, text: string): Response =>
    new Response(text, {
      status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': PREVIEW_CSP,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      },
    });

  /** `/preview/<token>/<path>` 处理器；不属于预览的路径返回 null */
  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/preview/')) return null;
    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(405, 'method not allowed');
    // service worker 脚本抓取带这个头；opaque origin 本来就注册不了，这里再显式挡一次
    if (req.headers.get('service-worker')) return deny(403, 'service workers are not allowed in previews');
    const rest = url.pathname.slice('/preview/'.length);
    const slash = rest.indexOf('/');
    const token = slash >= 0 ? rest.slice(0, slash) : rest;
    const body = verify(token);
    if (!body) return deny(403, 'preview link expired or invalid');
    let rel = '';
    try {
      if (slash >= 0) rel = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/');
    } catch {
      return deny(400, 'bad path');
    }
    if (rel === '' || rel.endsWith('/')) rel = `${rel}index.html`;
    if (!previewPathAllowed(rel) || !previewResourceAllowed(body.e, rel)) return deny(404, 'not found');
    const project = getProject(deps.db, body.p);
    if (!project || project.cwd !== body.c) return deny(403, 'preview link expired or invalid');
    const full = resolveProjectPath(project.cwd, rel);
    if (!full) return deny(404, 'not found');
    try {
      const driver = deps.driverForProject(project);
      let target = full;
      let st = await driver.statPath(target);
      if (st?.isDirectory) {
        target = `${full}/index.html`;
        if (!previewResourceAllowed(body.e, `${rel}/index.html`)) return deny(404, 'not found');
        st = await driver.statPath(target);
      }
      if (!st || !st.isFile) return deny(404, 'not found');
      if (st.size > MAX_RAW_BYTES) return deny(413, 'file too large');
      const data = req.method === 'HEAD'
        ? new Uint8Array()
        : (await driver.readFileRange(target, 0, Math.max(st.size, 1))).data;
      return new Response(data as BodyInit, {
        headers: {
          'content-type': contentTypeForExt(target),
          'content-security-policy': PREVIEW_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
          'cross-origin-resource-policy': 'cross-origin',
        },
      });
    } catch {
      return deny(502, 'preview read failed');
    }
  }

  /** 签发端点（与文件 API 同鉴权级别，项目内相对路径约束一致） */
  function routes(): RouteDef[] {
    return [
      {
        method: 'POST',
        path: '/api/projects/:projectId/fs/preview',
        auth: 'project-access',
        handler: async ({ url, params }) => {
          const project = getProject(deps.db, Number(params.projectId));
          if (!project) return json(apiError('project.not_found', 'Project not found.', 404), 404);
          const raw = (url.searchParams.get('path') ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
          const full = resolveProjectPath(project.cwd, raw);
          const base = resolveProjectPath(project.cwd, '')!;
          const rel = full && full !== base ? full.slice(base.length + 1) : '';
          if (!full || !previewEntryAllowed(rel)) {
            return json(apiError('workspace.preview_path_invalid', 'This file cannot be previewed as a web page.', 400), 400);
          }
          const st = await deps.driverForProject(project).statPath(full).catch(() => null);
          if (!st?.isFile) return json(apiError('workspace.not_found', 'The file was moved or no longer exists.', 404), 404);
          return json({ ok: true, ...mint(project, rel) });
        },
      },
    ];
  }

  return { mint, verify, handle, routes };
}

export type PreviewService = ReturnType<typeof createPreviewService>;

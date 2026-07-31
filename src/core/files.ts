/**
 * core/files —— 文件浏览模块的纯函数（v1 web.ts safePath/upload 名净化语义平移）。
 *
 * v2 语义：所有路径都是**执行机侧** POSIX 路径（project.cwd 来自 DB），
 * 这里只做纯字符串运算，副作用（stat/读写）经 Driver 落到执行机（spec §2 边界）。
 *
 * 防穿越是词法限定（normalize 后前缀检查），不做 realpath：Driver 不暴露 realpath，
 * 且项目属主本就有该 cwd 的终端（/ws/term）——符号链逃逸对属主不是提权，
 * 这里挡的是 API 参数层面的误操作与直接注入。
 */
import path from 'node:path';

/** 在线读/写文本文件的大小上限（v1 web.ts readFile 的 1MB 语义平移） */
export const MAX_TEXT_BYTES = 1024 * 1024;

/** 下载大小上限（经 Driver.readFileRange 全量进内存，必须有界） */
export const MAX_DOWNLOAD_BYTES = 32 * 1024 * 1024;

/** 内联预览（fs/raw）大小上限（同下载，全量进内存必须有界；图片/网页/PDF 预览取原始字节） */
export const MAX_RAW_BYTES = 32 * 1024 * 1024;

/** 通用文件上传大小上限（截图另走 uploads 路由的 5MB；这里放宽到 20MB） */
export const MAX_FS_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 单次列目录最多返回的条目数（超出置 truncated，防超大目录拖垮 SSH/前端） */
export const MAX_LIST_ENTRIES = 1000;

/**
 * 把客户端相对路径限定解析到项目 cwd 内的绝对路径；越界/绝对路径/NUL 返回 null。
 * 反斜杠按分隔符对待（防 Windows 风格 `..\\..` 穿越；执行机侧正常文件名不用反斜杠）。
 */
export function resolveProjectPath(cwd: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const r = (rel || '.').replace(/\\/g, '/');
  if (r.startsWith('/')) return null;
  const strip = (p: string): string => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p);
  const base = strip(path.posix.normalize(cwd));
  const full = strip(path.posix.normalize(path.posix.join(base, r)));
  if (full !== base && !full.startsWith(base + '/')) return null;
  return full;
}

/**
 * 净化上传文件名：剥路径分量、去控制字符、限长 200；空/纯点名返回 null。
 * 与 core/uploads.safeImageName 的区别：不限扩展名白名单（通用文件），保留中文/空格。
 */
export function safeFsFileName(name: string): string | null {
  const base = (name || '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, 200);
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

/** 二进制探测（v1 语义：含 NUL 字节即视为二进制，拒绝进文本编辑器） */
export function isProbablyBinary(data: Uint8Array): boolean {
  return data.includes(0);
}

/**
 * 扩展名 → MIME 类型（fs/raw 内联预览用）。未知返回 application/octet-stream。
 * 文本类带 charset=utf-8；覆盖图片/网页/代码/PDF/常见媒体，够对话模式产物预览。
 */
const CONTENT_TYPES: Record<string, string> = {
  // 图片
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  // 网页 / 代码（文本类带 charset）
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  // 文档
  pdf: 'application/pdf',
  // 媒体
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

/** 由文件名扩展名推断 Content-Type（小写；无扩展名/未知 → application/octet-stream） */
export function contentTypeForExt(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * 该 Content-Type 的文档会在浏览器里执行脚本（html/svg）——内联服务时须加 `Content-Security-Policy: sandbox`
 * 兜底：直接导航到 raw URL 时浏览器把它当沙箱文档（无脚本、opaque origin），防越权读控制面 cookie。
 * 前端预览另有 sandbox iframe，双保险。
 */
export function isScriptableType(contentType: string): boolean {
  return contentType.startsWith('text/html') || contentType.startsWith('image/svg');
}

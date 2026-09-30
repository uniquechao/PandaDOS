/**
 * ui/lib/pathlink —— 把对话正文里的「文件路径」认出来，并换算成文件页深链（issue #310）。
 *
 * 纯函数、无 DOM，渲染层（components/Markdown）照着结果建节点即可。两件事：
 *  1. `splitPathChunks(text)`：从一段纯文本里切出「疑似路径」的片段（其余原样留着，一个字不改）；
 *  2. `resolveProjectPath(raw, cwd)`：把绝对/相对路径归到「项目 cwd 内的相对路径」，越界返回 null。
 *
 * 判定刻意保守——正文是 AI 直出的，误伤（把 `62/121`、`and/or`、`example.com/a.html` 认成文件）
 * 比漏认难受得多：
 *  - 路径字符集只收 ASCII `[A-Za-z0-9._@+-]`。中文文件名不识别是有意的：中文正文不带空格，
 *    把 CJK 放进字符集会让 `请看/home/x/a.md的内容` 连同后面的字一起被吞进链接。
 *  - 相对路径必须 ≥2 段，且末段带「含字母的扩展名」（挡住 `2026/07/23`、`1.5/2.0`、`issue/310`）；
 *    首段形如域名（`example.com`）的一律不认。
 *  - 绝对路径不看扩展名，交给 cwd 归属判定兜底：不在项目目录里的一律不给链接。
 *
 * 路由侧只认相对路径：`#/p/:pid/workspace/files/<encodeURIComponent(rel)>`，目录带尾斜杠
 * （#388 起新链接指向工作区；旧 `#/p/:pid/files/<enc>` 仍由 router 映射到同一目标）。
 */

/** 解析出的跳转目标 */
export interface PathTarget {
  /** 项目 cwd 内的相对路径（已归一化，无前后斜杠） */
  rel: string;
  /** 目标是目录（原文以 `/` 结尾） */
  dir: boolean;
}

/** 正文里参与路径识别的字符（见文件头：只收 ASCII） */
const SEG = '[A-Za-z0-9._@+-]+';
/** 绝对路径（`/a/b.md`）或相对路径（`docs/a.md`、`./docs/a.md`），可带尾斜杠表示目录 */
const CANDIDATE = new RegExp(`(?:/${SEG})+/?|(?:\\.{1,2}/)?${SEG}(?:/${SEG})+/?`, 'g');
/** 紧挨在候选前面时说明它是更长串的一部分（url、`k:v/x`、反斜杠路径），不认 */
const GLUED_BEFORE = /[A-Za-z0-9._@+\-:\\/]/;
/** 候选尾巴上常粘着句读，回吐给正文（`见 docs/a.md。` 不该把句号算进路径） */
const TAIL = /[.,]+$/;

/** 首段像域名（`example.com/a.html`）：这是网址不是路径 */
function looksLikeDomain(seg: string): boolean {
  return /^[A-Za-z0-9-]+\.[A-Za-z]{2,}$/.test(seg);
}

/** 候选串是否值得当路径看（绝对路径放宽，归属判定在 resolveProjectPath 里收口） */
export function isLikelyPath(raw: string): boolean {
  const body = raw.replace(/\/+$/, '');
  if (!body.includes('/')) return false;
  const segs = body.split('/');
  if (raw.startsWith('/')) return segs.length >= 2;
  const first = segs.find((s) => s && s !== '.' && s !== '..') ?? '';
  if (looksLikeDomain(first)) return false;
  if (raw.endsWith('/')) return true; // 显式目录，不要求扩展名
  const last = segs[segs.length - 1] ?? '';
  const dot = last.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = last.slice(dot + 1);
  return /^[A-Za-z0-9]{1,8}$/.test(ext) && /[A-Za-z]/.test(ext);
}

/** 一段正文切出来的片段：带 `path` 的是疑似路径，其余原样输出 */
export interface TextChunk {
  text: string;
  path?: string;
}

/**
 * 把一段纯文本按「疑似路径」切片。返回的 `text` 拼起来必然等于入参——
 * 识别只影响「哪一段可点」，绝不改动一个字符。
 */
export function splitPathChunks(text: string): TextChunk[] {
  if (!text || !text.includes('/')) return [{ text }];
  const out: TextChunk[] = [];
  let last = 0;
  CANDIDATE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CANDIDATE.exec(text)) !== null) {
    const start = m.index;
    const before = start > 0 ? text[start - 1]! : '';
    const raw = m[0].replace(TAIL, '');
    if (!raw || (before && GLUED_BEFORE.test(before)) || !isLikelyPath(raw)) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: raw, path: raw });
    last = start + raw.length;
    CANDIDATE.lastIndex = last;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

/** 去掉 cwd 尾斜杠（`/a/b/` 与 `/a/b` 同一目录） */
export function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, '');
}

/**
 * 路径 → 项目内相对路径。绝对路径必须落在 cwd 之内（项目文件接口只认相对路径，
 * 越界的一律不给链接）；相对路径按 cwd 相对解释，`..` 逃逸一律拒绝。
 */
export function resolveProjectPath(raw: string, cwd: string): PathTarget | null {
  const base = normalizeCwd(cwd);
  if (!raw) return null;
  // 带协议头（`https:`、`mailto:`）、锚点、协议相对 url 都不是路径——
  // markdown 链接的 href 直接进这里，少这一道 `https://a.com/b` 会被当成相对路径
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) || raw.startsWith('#') || raw.startsWith('//')) return null;
  let body = raw;
  if (raw.startsWith('/')) {
    if (!base) return null;
    if (raw === base || raw === `${base}/`) return { rel: '', dir: true };
    if (!raw.startsWith(`${base}/`)) return null;
    body = raw.slice(base.length + 1);
  }
  const dir = body.endsWith('/');
  const segs = body.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  const rel = segs.join('/');
  if (!rel) return { rel: '', dir: true };
  return { rel, dir };
}

/** 绝对路径且看着像执行机上的文件系统路径（用于把「项目外的路径」从站内链接上摘下来） */
export function looksLikeFsPath(raw: string): boolean {
  return /^\/(home|root|Users|var|tmp|opt|mnt|srv|data|etc|usr|workspace)\//.test(raw);
}

/** 目标 → 文件页路由参数（目录带尾斜杠，供 Files 页区分「开文件」与「进目录」） */
export function filesRouteParam(target: PathTarget): string {
  if (!target.rel) return '';
  return target.dir ? `${target.rel}/` : target.rel;
}

/** 目标 → 工作区文件深链 hash（`#/p/:pid/workspace/files/<enc>`；根目录不带参数） */
export function filesHref(pid: number, target: PathTarget): string {
  const param = filesRouteParam(target);
  return param ? `#/p/${pid}/workspace/files/${encodeURIComponent(param)}` : `#/p/${pid}/workspace`;
}

/** 文件页路由参数 → 目标（畸形/越界返回 null，页面按「没带路径」处理） */
export function routeTarget(param: string | undefined | null): PathTarget | null {
  if (!param) return null;
  const dir = param.endsWith('/');
  const segs = param.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  const rel = segs.join('/');
  return rel ? { rel, dir } : null;
}

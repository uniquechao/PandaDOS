/**
 * core/uploads —— 任务截图上传（v1 src/uploads.ts 全套平移，评审 5.4 §1.6 / §10-9）。
 *
 * 纯函数（净化白名单 / 路径校验 / 随机子目录 / Read 提示后缀）原样平移；
 * 副作用（落盘 / git exclude）改经 Driver 落到执行机——控制面不碰业务文件（spec §2 边界）。
 * 截图落在项目 cwd 下 .tmux-butler-uploads/<随机子目录>/<文件名>，
 * 这样跑在该项目里的 Claude Code 用 Read 工具读它不会触发越权权限弹窗。
 *
 * 契约备忘：
 * - UPLOAD_DIR 是与 issue 引擎（images_json 存相对路径）和前端的三方契约，改名三处同步（评审 5.4#10）。
 * - absImages 拼出的是**执行机侧**绝对路径，控制面禁止对其做本地 fs 操作（评审 5.4#11）。
 * - imageReadHint 与 issues/prompts.ts 已平移的一份同文（引擎侧消费那份）；文案改动两处同步。
 * - addGitExclude 相对 v1 补了 worktree 分支（v1 遇 .git 是文件直接跳过 → 截图污染
 *   worktree 的 git status，评审 5.4 资产表「addGitExclude 需改造」项）。
 */
import path from 'node:path';

/** 允许上传的图片扩展名（Claude Code 的 Read 工具能识别的常见位图） */
export const ALLOWED_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

/** 截图存放目录（位于项目 cwd 下，点开头不干扰常规文件列表） */
export const UPLOAD_DIR = '.tmux-butler-uploads';

/**
 * 净化上传图片的文件名：去掉路径分量、危险字符、前导点，限长；
 * 不是受支持的图片类型则返回 null。
 */
export function safeImageName(name: string): string | null {
  const base = (name || '').split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\w.\-]+/g, '_') // 仅留字母数字下划线点连字符
    .replace(/^\.+/, '') // 去前导点，防止隐藏文件/“..”
    .slice(0, 100);
  if (!cleaned || !cleaned.includes('.')) return null;
  const ext = cleaned.slice(cleaned.lastIndexOf('.') + 1).toLowerCase();
  if (!ALLOWED_IMAGE_EXT.has(ext)) return null;
  return cleaned;
}

/** 每次上传的随机子目录名（避免同名截图互相覆盖） */
export function uploadId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 给定 cwd 下的相对路径是否落在截图上传目录内（配合越界校验用，挡住引用任意文件） */
export function isUploadRel(rel: string): boolean {
  const norm = (rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (norm.includes('..')) return false;
  return norm.startsWith(UPLOAD_DIR + '/');
}

/**
 * 把若干图片绝对路径拼成给 Claude 的提示后缀：让它先用 Read 工具逐张看图再判断。
 * 注入时 sendKeys 会把换行压成空格，所以这里的换行只是可读性，落到 Claude 仍是一行。
 */
export function imageReadHint(absPaths: string[]): string {
  const list = (absPaths || []).filter(Boolean);
  if (!list.length) return '';
  const lines = list.map((p) => '· ' + p).join('\n');
  return `\n\n（这条任务附了 ${list.length} 张截图，请先用 Read 工具逐张查看，再据此判断和动手）\n${lines}`;
}

// ---------- imageReadHint 的逆运算（把注入回显的用户消息还原成「正文 + 附图 rel」） ----------
// 对话里的附图不落库（见 web/ws/chat.ts）：发送时经 imageReadHint 把 rel→执行机绝对路径拼成
// AI 向提示注入会话，回读 jsonl 时用户消息里就是「提示前言 + `· 路径` 列表 + 正文」。下面两个纯函数
// 是它的逆：一个抠出附图 rel（供前端缩略图预览），一个剥掉 AI 向提示只留用户正文。措辞随 imageReadHint 改动同步。

/** 正则片段：转义后的上传目录名 + 白名单扩展名 alternation（随 UPLOAD_DIR/ALLOWED_IMAGE_EXT 派生） */
const UPLOAD_DIR_RE = UPLOAD_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UPLOAD_EXT_RE = [...ALLOWED_IMAGE_EXT].join('|');
/** 上传路径尾段（rel，从上传目录锚点起）：<UPLOAD_DIR>/<随机子目录>/<名>.<ext>——abs 前缀天然被排除 */
const UPLOAD_REL_RE = new RegExp(`${UPLOAD_DIR_RE}/[\\w.\\-]+/[\\w.\\-]+\\.(?:${UPLOAD_EXT_RE})`, 'gi');
/** imageReadHint 的前言括号块（措辞随 imageReadHint 改动两处同步） */
const IMAGE_HINT_PREAMBLE_RE = /（这条任务附了[^）]*张截图[^）]*）/g;
/** 「· <上传路径>」项：换行/空格分隔均可；bullet 后接非空白路径 token（含可选 abs 前缀，须含上传目录） */
const UPLOAD_BULLET_RE = new RegExp(`·\\s*\\S*${UPLOAD_DIR_RE}\\S*`, 'g');
/** 兜底：任意残留的裸上传路径 token（含可选 abs 前缀） */
const UPLOAD_TOKEN_RE = new RegExp(`\\S*${UPLOAD_DIR_RE}/[\\w.\\-]+/[\\w.\\-]+\\.(?:${UPLOAD_EXT_RE})`, 'gi');

/**
 * 从「注入回显的用户消息文本」里抠出附图的 cwd 相对路径（供前端缩略图/灯箱预览）。
 * 注入时内嵌的是执行机侧绝对路径且换行可能被 sendKeys 压成空格，这里只按上传目录锚点抓尾段还原为 rel，
 * 经 isUploadRel 复核（挡 `..`/越界），顺序去重、上限 6（与注入端 slice(0,6) 同款）。无图 → []。
 */
export function extractUploadRels(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of (text || '').matchAll(UPLOAD_REL_RE)) {
    const rel = m[0];
    if (!isUploadRel(rel) || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * 把「注入回显的用户消息文本」里 AI 向的附图提示（前言 + `· 路径` 列表）剥掉，只留用户真正输入的正文。
 * 纯图消息（无正文、只有提示）→ 空串；无附图提示（无任何匹配）→ 原样返回，绝不改动用户文本。
 */
export function stripImageHint(text: string): string {
  const orig = text || '';
  let s = orig.replace(IMAGE_HINT_PREAMBLE_RE, '');
  s = s.replace(UPLOAD_BULLET_RE, '');
  s = s.replace(UPLOAD_TOKEN_RE, '');
  if (s === orig) return orig; // 无提示/无图：原样返回（含用户自己的空白/换行）
  return s.replace(/\s{2,}/g, ' ').trim(); // 有剥离才收拾留下的空白间隙
}

/**
 * 把 issue 存的相对截图路径解析成 cwd 下的绝对路径（已是绝对路径则原样）。
 * v2 语义：cwd 与结果都是**执行机侧** POSIX 路径（纯字符串运算，posix 语义与平台无关）。
 */
export function absImages(cwd: string, rel?: string[]): string[] {
  return (rel || []).map((r) => (r.startsWith('/') ? r : path.posix.resolve(cwd, r)));
}

// ---------- 副作用（经 Driver 落到执行机） ----------

/**
 * 落盘/exclude 需要的最小接口——与 ExecutorDriver 结构兼容
 * （core 不 import executor，依赖方向铁律；调用方直接传 SshDriver/LocalDriver）。
 */
export interface UploadFs {
  /** 写文件；自动创建父目录（driver.ts 契约） */
  writeFile(path: string, data: Uint8Array | string, mode?: number): Promise<void>;
  /** stat；路径不存在返回 null */
  statPath(path: string): Promise<{ size: number; isDirectory: boolean; isFile: boolean } | null>;
  /** 按字节区间读文件 */
  readFileRange(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; size: number }>;
}

/** 经 Driver 读整个小文本文件；不存在/不是文件返回 null。 */
async function readTextIfExists(fs: UploadFs, p: string, maxBytes = 1 << 20): Promise<string | null> {
  const st = await fs.statPath(p);
  if (!st || !st.isFile) return null;
  const { data } = await fs.readFileRange(p, 0, Math.min(st.size, maxBytes));
  return new TextDecoder().decode(data);
}

/**
 * 解析项目 cwd 对应的 git exclude 文件路径（执行机侧）。
 * - 常规仓库：<cwd>/.git/info/exclude
 * - worktree（.git 是「gitdir: …」文件）：沿 gitdir → commondir 找到主仓，
 *   用 <主仓 .git>/info/exclude（git 对所有 worktree 共享读取该文件）
 * - 非 git 仓库：null
 */
export async function resolveGitExcludePath(fs: UploadFs, cwd: string): Promise<string | null> {
  const base = cwd.replace(/\/+$/, '');
  const dotGit = `${base}/.git`;
  const st = await fs.statPath(dotGit);
  if (!st) return null;
  if (st.isDirectory) return `${dotGit}/info/exclude`;
  if (!st.isFile) return null;
  const content = await readTextIfExists(fs, dotGit, 8192);
  const m = content?.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m?.[1]) return null;
  const gitdir = path.posix.resolve(base, m[1]);
  const commonRel = (await readTextIfExists(fs, `${gitdir}/commondir`, 4096))?.trim();
  const common = commonRel ? path.posix.resolve(gitdir, commonRel) : gitdir;
  return `${common}/info/exclude`;
}

/**
 * 尽力把截图目录加进项目本地的 git 忽略（.git/info/exclude，不改动被跟踪的 .gitignore），
 * 让上传的截图不污染用户的 git status。幂等；非 git 仓库 / 出错都安静跳过。
 */
export async function addGitExclude(fs: UploadFs, cwd: string): Promise<void> {
  try {
    const excludePath = await resolveGitExcludePath(fs, cwd);
    if (!excludePath) return;
    const line = UPLOAD_DIR + '/';
    const cur = (await readTextIfExists(fs, excludePath)) ?? '';
    if (cur.split('\n').some((l) => l.trim() === line)) return; // 已忽略
    await fs.writeFile(excludePath, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + line + '\n');
  } catch {
    /* best-effort */
  }
}

export interface SavedUpload {
  /** 相对项目 cwd 的路径（UPLOAD_DIR/<sub>/<name>），存 issues.images_json 用 */
  rel: string;
  /** 执行机侧绝对路径（喂 prompt 用；控制面禁止对它做本地 fs 操作） */
  abs: string;
  /** 净化后的文件名 */
  name: string;
}

/**
 * 把一张截图经 Driver 落到执行机：<cwd>/.tmux-butler-uploads/<随机子目录>/<净化名>，
 * 并尽力把上传目录加进 git exclude。文件名不过白名单则抛错（路由层先用 safeImageName 拦 415）。
 */
export async function saveUploadImage(
  fs: UploadFs,
  cwd: string,
  name: string,
  data: Uint8Array,
): Promise<SavedUpload> {
  const clean = safeImageName(name);
  if (!clean) throw new Error(`不支持的图片文件名: ${name}`);
  const base = cwd.replace(/\/+$/, '');
  const rel = `${UPLOAD_DIR}/${uploadId()}/${clean}`;
  const abs = `${base}/${rel}`;
  await fs.writeFile(abs, data); // Driver 自动建父目录
  await addGitExclude(fs, base); // 尽力让截图不进 git status
  return { rel, abs, name: clean };
}

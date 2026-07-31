/**
 * web/routes/git —— 项目 git 视图（图形化提交图 + 提交详情 + 单文件 diff + 工作区改动）。
 *
 * GET /api/projects/:projectId/git（auth:'project-access'）→
 *   { ok, cwd, branch, upstream, ahead, behind, dirty, commits, changes }
 *   commits = log --all --date-order -n 200 的结构化记录（sha/short/parents/author/ts/refs/subject），
 *             前端据 parents 拓扑自绘泳道图（不再回 ASCII graph）；空仓库降级 []。
 *   changes = status --porcelain=v1 -b 的工作区改动（status 两列码 + path/oldPath），
 *             upstream/ahead/behind 从 '## main...origin/main [ahead 1]' 头行解析。
 * GET /api/projects/:projectId/git/branches →
 *   { ok, cwd, current, local, remote }；current 在 detached HEAD 时为空，
 *   local/remote 分别来自 refs/heads 与本地已知的 refs/remotes（排除 remote HEAD 别名）。
 * POST /api/projects/:projectId/git/stage|unstage → { ok }；
 *   body 二选一：{ all:true } 或 { paths:string[] }。
 * POST /api/projects/:projectId/git/commit { message } → { ok, sha, short }（只提交 index）。
 * POST /api/projects/:projectId/git/push {} →
 *   { ok, branch, upstream, createdUpstream }（当前分支；无 upstream 时绑定 origin）。
 * GET /api/projects/:projectId/git/commits/:sha →
 *   { ok, sha, short, parents, author, authorEmail, authorTs, committer, commitTs, refs, message, files }
 *   files = diff-tree --name-status ∪ --numstat（status/path/oldPath/adds/dels）；
 *   合并提交按第一父 diff（git 惯例），根提交 --root。sha 非 hex → 400，不存在 → 404。
 * GET /api/projects/:projectId/git/commits/:sha/diff?path=&old= → { ok, diff, truncated }
 * GET /api/projects/:projectId/git/worktree/diff?path=&untracked=1 → { ok, diff, truncated }
 *   工作区 diff 对 HEAD（暂存+未暂存都含）；未跟踪文件用 --no-index /dev/null 呈现全新增。
 * GET /api/projects/:projectId/issues/:issueId/git → IssueGitInfo（本 issue 提交/改动范围；
 *   活跃 issue 另附 worktree = 工作区未提交改动，执行现场的「正在进行」部分）。
 *
 * 非 git 仓库 → 200 + { ok:false, error, cwd }（预期态，前端按 ok 渲染，同 v1）。
 * git 一律经 Driver.git（参数数组无 shell 注入；Local/SSH 同构，60s 限时在实现层）；
 * sha 白名单 hex、path 走 '--' 之后的 pathspec，双保险。
 * 所有 Git 写操作经共享 KeyedMutex(gitLockKey(projectId)) 串行，避免 index/ref 并发竞态。
 * 只 export 路由定义，注册进 routes/index.ts 由集成步骤统一做。
 */
import type { Database } from 'bun:sqlite';
import type { LlmClient, LlmMessage } from '../../agents/llm';
import type { Project } from '../../core/types';
import type { ExecutorDriver } from '../../executor/driver';
import { getProject, type ImplCommitsSnapshot } from '../../issues/engine';
import { gitLockKey, KeyedMutex } from '../../issues/mutex';
import { json, type RouteCtx, type RouteDef } from '../middleware';
import { llmErrorResponse } from '../llm-error';

/** 本模块需要的 Driver 子集（结构兼容 ExecutorDriver，测试可传替身） */
export type GitDriver = Pick<ExecutorDriver, 'git'>;

/**
 * 一条 issue 的 git 锚点——per-issue「提交/改动」视图用。
 * 固定/共享分支（用户在一条既有分支上连续做多个 issue，不每次从 base checkout）时，
 * base 与分支 tip 之间混着**其它 issue** 的历史；此时靠 startSha/endSha 把范围收在本 issue
 * 自己的提交上：视图取 `startSha..endSha`（本 issue 的 commit ids 及其改动），而非 `base...branch`。
 */
export interface IssueGitRef {
  branch: string;
  base: string;
  /** 本 issue 起点 sha（引擎 impl_base）：本 issue 首次实施时的分支 tip。缺省→退回 base。 */
  startSha?: string;
  /** 本 issue 终点 sha（引擎 impl_tip）：工作定格时的分支 tip。缺省→用分支当前 tip（issue 仍在推进）。 */
  endSha?: string;
  /**
   * 该 issue 当前持有项目工作树（implementing/testing/merge_review——同项目同时只有一条在跑）。
   * true → 视图附带 status --porcelain 的未提交改动（正在进行的改动，尚未落进 commit 范围）。
   */
  active?: boolean;
  /**
   * 惰性取引擎的 impl_commits 耐久快照（工作定格时落库的本 issue 净提交 + 逐文件改动）。
   * 分支被删 / 起点锚解析不出（历史重写、对象被 gc）时兜底回填视图——commit id 落了库就永远可显示。
   * 无快照（老 issue / 从未落地改动）→ null。
   */
  snapshot?(): ImplCommitsSnapshot | null;
}

export interface GitRoutesDeps {
  db: Database;
  /** 项目所在执行机的 Driver（server.ts driverForProject） */
  driverForProject(project: Project): GitDriver;
  /**
   * 项目 Git 写操作锁；生产必须传 server 的共享实例，直接构造路由的离线/单测调用可省略，
   * 此时本路由工厂内部仍会创建实例保证自身写操作串行。
   */
  mutex?: KeyedMutex;
  /**
   * 可选：AI 助读（驱动大模型）。接了才启用 POST /git/ai（总结/解释/风险/生成提交信息）；
   * 未接 → 端点回 503。与 PM 池/技能市场共享 agents/llm 的并发闸。
   */
  llm?: LlmClient;
  /**
   * 解析某项目下 issue 的分支/基线（per-issue「提交/改动」视图）。
   * 生产由 server 用 engine 装配（issue.branch ?? `issue/<id>` + engine.baseBranch）；
   * issue 不属于该项目或不存在 → null。不传（旧调用点）则 per-issue 端点回 404，
   * 项目级 git 端点不受影响。
   */
  issueGitRef?(projectId: number, issueId: number): IssueGitRef | null;
}

/** 提交图条数上限（v1 同值；配合 Driver 层 60s git 限时防大仓库拖挂） */
const GRAPH_COMMITS = 200;
/** 单文件 diff 字节上限（超出截断，前端提示） */
const DIFF_MAX = 200_000;
/** 手动提交信息上限；防止异常请求把超大参数传给 git 子进程。 */
const COMMIT_MESSAGE_MAX = 20_000;
/** 单次逐文件 stage/unstage 上限；“全部”应显式使用 all:true。 */
const WRITE_PATHS_MAX = 500;

/** 字段分隔符（提交信息里不会出现的控制符） */
const SEP = '\x1f';

/** 读 JSON body → 对象（解析失败/非对象回 {}，同其它 routes） */
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const b = await req.json().catch(() => null);
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

type WriteSelection = { all: true } | { all: false; paths: string[] };

/**
 * stage/unstage 选择器：只接受 all:true 或非空 paths，两者不可并存。
 * path 始终还会放在 git 的 `--` 后；这里额外拒绝绝对路径、`.`/`..` 分量和 NUL。
 */
function parseWriteSelection(body: Record<string, unknown>): WriteSelection | string {
  const hasAll = Object.prototype.hasOwnProperty.call(body, 'all');
  const hasPaths = Object.prototype.hasOwnProperty.call(body, 'paths');
  if (hasAll === hasPaths) return '必须且只能提供 all:true 或 paths';
  if (hasAll) return body.all === true ? { all: true } : 'all 只能为 true';
  if (!Array.isArray(body.paths) || body.paths.length === 0) return 'paths 必须是非空字符串数组';
  if (body.paths.length > WRITE_PATHS_MAX) return `paths 最多 ${WRITE_PATHS_MAX} 项`;
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of body.paths) {
    if (typeof raw !== 'string' || !raw.trim()) return 'paths 必须是非空字符串数组';
    if (
      raw.length > 1_000
      || raw.includes('\0')
      || raw.startsWith('/')
      || raw.split('/').some((part) => part === '.' || part === '..')
    ) {
      return 'path 必须是仓库内的相对文件路径';
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      paths.push(raw);
    }
  }
  return { all: false, paths };
}

function gitFailure(
  action: string,
  result: { out: string; err: string },
  status = 409,
): Response {
  const detail = (result.err.trim() || result.out.trim()).slice(0, 500);
  return json({ ok: false, error: detail ? `${action}失败：${detail}` : `${action}失败` }, status);
}

// ---------- 响应形状 ----------

export interface GitCommitRec {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  /** 提交时间（ms） */
  ts: number;
  /** %D 装饰引用（'HEAD -> main' / 'origin/main' / 'tag: v1'…） */
  refs: string[];
  subject: string;
}

export interface GitChangeRec {
  /** porcelain v1 两列码（'M ' / ' M' / '??' / 'R '…） */
  status: string;
  path: string;
  oldPath?: string;
}

export interface GitFileRec {
  /** A/M/D/T + R/C（重命名/复制，含相似度，如 R100） */
  status: string;
  path: string;
  oldPath?: string;
  /** numstat 增删行数；二进制文件为 null */
  adds?: number | null;
  dels?: number | null;
}

/** 分支选择用的引用：name 给人看，ref 是无歧义的完整引用名（后续创建 issue 分支时使用）。 */
export interface GitBranchRefRec {
  name: string;
  ref: string;
}

/** GET /api/projects/:projectId/git/branches —— 当前、本地与本地已知的远程跟踪分支。 */
export interface GitBranchesInfo {
  ok: boolean;
  cwd: string;
  /** 当前本地分支短名；detached HEAD 时为空。unborn HEAD 仍保留 symbolic-ref 名。 */
  current: string;
  local: GitBranchRefRec[];
  remote: GitBranchRefRec[];
  error?: string;
}

/**
 * 本 issue 的推送状态：**范围终点**（impl_tip 或分支 tip）相对 origin/<branch>。
 * 按终点而非整条分支算——done 的 issue 只关心自己的提交推没推上去，
 * 共享分支上后续 issue 的未推送提交不算到它头上。
 */
export type IssuePushState =
  | { state: 'pushed' }            // 终点已在 origin 分支上（0 条未推送）
  | { state: 'ahead'; n: number }  // 领先 origin/<branch> n 条未推送
  | { state: 'unpushed' }          // 有 origin 远程但该分支从未推送
  | { state: 'none' };             // 仓库未配 origin 远程（本地库，无推送一说）

/** GET /api/projects/:projectId/issues/:issueId/git —— 本 issue 的 git 现场 */
export interface IssueGitInfo {
  ok: boolean;
  branch: string;
  base: string;
  /**
   * 本 issue 的实际起点 sha（固定/共享分支模式下有效）。有值→commits/files/stat 是
   * `startSha..end` 的本 issue 净改动；无值→退回经典 `base..branch` / `base...branch`。
   */
  startSha?: string;
  /** 分支是否已存在（issue 尚未启动/未落分支 → false，commits/files 为空） */
  exists: boolean;
  /** 范围内独立提交数（已合并的 issue 通常为 0） */
  ahead: number;
  /** 范围内提交（本 issue 的历史，新→旧）——startSha 有效时为本 issue 自己的 commit */
  commits: GitCommitRec[];
  /** 范围改动（本 issue 触碰的文件） */
  files: GitFileRec[];
  /** diff --stat 文本（顶部一览） */
  stat: string;
  /**
   * 工作区未提交改动（仅当该 issue 正持有工作树，即 IssueGitRef.active）：
   * 执行中的改动在 auto commit（merge_review 收尾）前都停留在这里，commits/files 看不到。
   * 非活跃 issue 无此字段（工作树属于当前在跑的 issue，不能张冠李戴）。
   */
  worktree?: GitChangeRec[];
  /** 推送状态（exists:true 时给；rev-list 意外失败则缺省） */
  push?: IssuePushState;
  /**
   * 数据来源标记：'snapshot' = 分支已删 / 范围锚失效，commits/files 来自引擎 impl_commits
   * 耐久快照（stat 为空、commit 无 parents/refs 装饰）。缺省 = 实时 git 计算。
   */
  source?: 'snapshot';
  error?: string;
}

// ---------- 解析工具 ----------

/** porcelain 路径可能是 C 风格带引号转义（含空格/中文等特殊字符时） */
function unquotePath(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  try {
    return JSON.parse(p) as string;
  } catch {
    return p;
  }
}

/** 解析 `status --porcelain=v1 -b` 的 '## …' 头行 → 上游与领先/落后 */
function parseStatusHead(line: string): { upstream: string; ahead: number; behind: number } {
  const up = line.match(/\.\.\.(\S+)/);
  const a = line.match(/ahead (\d+)/);
  const b = line.match(/behind (\d+)/);
  return { upstream: up?.[1] ?? '', ahead: a ? Number(a[1]) : 0, behind: b ? Number(b[1]) : 0 };
}

/** 解析 porcelain v1 改动行（不含 '##' 头） */
function parseChanges(out: string): GitChangeRec[] {
  const changes: GitChangeRec[] = [];
  for (const line of out.split('\n')) {
    if (!line || line.startsWith('##') || line.length < 4) continue;
    const status = line.slice(0, 2);
    const rest = line.slice(3);
    const arrow = rest.indexOf(' -> ');
    if ((status[0] === 'R' || status[0] === 'C') && arrow >= 0) {
      changes.push({
        status,
        oldPath: unquotePath(rest.slice(0, arrow)),
        path: unquotePath(rest.slice(arrow + 4)),
      });
    } else {
      changes.push({ status, path: unquotePath(rest) });
    }
  }
  return changes;
}

/** 解析 `log --pretty=%H␟%h␟%P␟%an␟%at␟%D␟%s`（subject 单行，安全按行 split） */
function parseLog(out: string): GitCommitRec[] {
  const commits: GitCommitRec[] = [];
  for (const line of out.split('\n')) {
    const f = line.split(SEP);
    if (f.length < 7 || !f[0]) continue;
    commits.push({
      sha: f[0]!,
      short: f[1]!,
      parents: f[2] ? f[2].split(' ') : [],
      author: f[3]!,
      ts: Number(f[4]) * 1000,
      refs: f[5] ? f[5].split(', ') : [],
      subject: f.slice(6).join(SEP),
    });
  }
  return commits;
}

/** numstat 的重命名路径归一：'dir/{old => new}/f'、'old => new' → 新路径 */
function normNumstatPath(p: string): string {
  let s = unquotePath(p).replace(/\{([^{}]*) => ([^{}]*)\}/g, '$2').replace(/\/{2,}/g, '/');
  const i = s.indexOf(' => ');
  if (i >= 0) s = s.slice(i + 4);
  return s;
}

/** name-status ∪ numstat → 文件列表（status/path/oldPath + adds/dels） */
function parseFiles(nameStatus: string, numstat: string): GitFileRec[] {
  const stats = new Map<string, { adds: number | null; dels: number | null }>();
  for (const line of numstat.split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    stats.set(normNumstatPath(m[3]!), {
      adds: m[1] === '-' ? null : Number(m[1]),
      dels: m[2] === '-' ? null : Number(m[2]),
    });
  }
  const files: GitFileRec[] = [];
  for (const line of nameStatus.split('\n')) {
    const f = line.split('\t');
    if (f.length < 2 || !f[0]) continue;
    const status = f[0]!;
    const isRename = status[0] === 'R' || status[0] === 'C';
    const path = unquotePath(isRename && f[2] ? f[2] : f[1]!);
    const rec: GitFileRec = { status, path };
    if (isRename && f[2]) rec.oldPath = unquotePath(f[1]!);
    const st = stats.get(path);
    if (st) {
      rec.adds = st.adds;
      rec.dels = st.dels;
    }
    files.push(rec);
  }
  return files;
}

function sliceDiff(out: string): { diff: string; truncated: boolean } {
  if (out.length <= DIFF_MAX) return { diff: out, truncated: false };
  return { diff: out.slice(0, DIFF_MAX), truncated: true };
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;

/** 校验并解析一个候选 sha 为存在的提交对象（不存在/非 hex → null，供固定分支范围锚点降级用） */
async function resolveRev(driver: GitDriver, cwd: string, rev?: string): Promise<string | null> {
  if (!rev || !SHA_RE.test(rev)) return null;
  const r = await driver.git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return r.code === 0 && r.out.trim() ? r.out.trim() : null;
}

/**
 * 本 issue 的提交/改动范围：固定/共享分支带 startSha 时收到 `start..end`（本 issue 自己的
 * 提交，end 缺省用分支 tip），否则退回经典 `base..branch`（log）/`base...branch`（diff）。
 * end = 范围终点（sha 或分支名）——推送状态按它相对 origin 计算。
 */
async function issueRange(
  driver: GitDriver,
  cwd: string,
  ref: IssueGitRef,
): Promise<{ start: string | null; end: string; log: string; diff: string }> {
  const { branch, base } = ref;
  const start = await resolveRev(driver, cwd, ref.startSha);
  if (!start) return { start: null, end: branch, log: `${base}..${branch}`, diff: `${base}...${branch}` };
  const end = (await resolveRev(driver, cwd, ref.endSha)) ?? branch;
  const range = `${start}..${end}`; // start 是分支祖先：两点即本 issue 净提交/净改动
  return { start, end, log: range, diff: range };
}

/**
 * 推送状态：范围终点 end（sha/分支名）相对 refs/remotes/origin/<branch>。
 * 远程分支在 → 数 end 领先几条（0=已推送）；不在 → 有 origin 远程算「未推送」，没配远程算「none」。
 * 意外失败（rev-list 报错等）→ undefined，不挡主体数据。
 */
async function pushState(
  driver: GitDriver,
  cwd: string,
  branch: string,
  end: string,
): Promise<IssuePushState | undefined> {
  const remoteRef = `refs/remotes/origin/${branch}`;
  const hasRemote = await driver.git(cwd, ['rev-parse', '--verify', '--quiet', remoteRef]);
  if (hasRemote.code === 0) {
    const cnt = await driver.git(cwd, ['rev-list', '--count', `${remoteRef}..${end}`]);
    const n = Number(cnt.out.trim());
    if (cnt.code !== 0 || !Number.isFinite(n)) return undefined;
    return n > 0 ? { state: 'ahead', n } : { state: 'pushed' };
  }
  const remotes = await driver.git(cwd, ['remote']);
  const hasOrigin = remotes.code === 0 && remotes.out.split('\n').some((l) => l.trim() === 'origin');
  return hasOrigin ? { state: 'unpushed' } : { state: 'none' };
}

// ---------- AI 助读（驱动大模型） ----------

/** AI 助读动作：总结提交 / 识别风险 / 解释整条 diff / 解释单文件 diff / 生成提交信息 */
export type GitAiKind =
  | 'commit-summary'
  | 'commit-risk'
  | 'commit-explain'
  | 'file-explain'
  | 'commit-message';

export const GIT_AI_KINDS: readonly GitAiKind[] = [
  'commit-summary', 'commit-risk', 'commit-explain', 'file-explain', 'commit-message',
];

/** 喂给 LLM 的 diff/上下文字符上限（远小于展示上限，防超长提示烧钱） */
export const AI_CTX_MAX = 12_000;

/** 拼进提示词的 git 素材（按 kind 只填相关字段；纯函数化便于单测） */
export interface GitAiCtx {
  /** 提交标题（首行）—— commit-* */
  subject?: string;
  /** 完整提交信息（%B）—— commit-summary / commit-risk */
  message?: string;
  /** 单文件路径 —— file-explain */
  path?: string;
  /** 改动文件清单文本（每行 `status\tpath`）—— summary / risk / commit-message */
  files?: string;
  /** diff 文本（已截断到 AI_CTX_MAX）—— explain / risk / summary / commit-message */
  diff?: string;
}

/** 各动作的系统提示（只出正文，不要标题/引号/markdown 代码块） */
const AI_SYSTEM: Record<GitAiKind, string> = {
  'commit-summary':
    '你是资深工程师，用简洁中文向同事概括一次 git 提交做了什么。分点讲清改动要点与意图，'
    + '不要逐行复述 diff。只输出正文，不要标题、引号或 markdown 代码块。',
  'commit-risk':
    '你是严谨的代码评审者。审视这次提交可能引入的风险（bug、破坏性变更、边界/并发/安全、'
    + '缺测试等），按严重程度分点列出并给出理由；若没有明显风险就直说。只输出正文，不要标题或引号。',
  'commit-explain':
    '你是资深工程师，逐段讲清这段 diff 到底改了什么、为什么这样改。用简洁中文分点解释关键改动，'
    + '不要逐行复述。只输出正文，不要标题或引号。',
  'file-explain':
    '你是资深工程师，讲清这个文件这段 diff 改了什么、意图是什么、有没有需要注意的点。'
    + '用简洁中文说明。只输出正文，不要标题或引号。',
  'commit-message':
    '你是资深工程师，为下面这批未提交改动写一条规范的 git 提交信息：首行是不超过 50 字的祈使句摘要'
    + '（可用 Conventional Commits 前缀，如 feat/fix/refactor），需要时空一行后再写简要正文要点。'
    + '只输出提交信息本身，不要任何解释、引号或 markdown。',
};

/** 纯函数：kind + 素材 → chat 消息（无 IO，供单测直接断言） */
export function buildGitAiPrompt(kind: GitAiKind, ctx: GitAiCtx): LlmMessage[] {
  const parts: string[] = [];
  if (ctx.subject) parts.push(`提交标题：${ctx.subject}`);
  if (ctx.message) parts.push(`提交信息：\n${ctx.message}`);
  if (ctx.path) parts.push(`文件：${ctx.path}`);
  if (ctx.files) parts.push(`改动文件：\n${ctx.files}`);
  if (ctx.diff) parts.push(`diff（可能已截断）：\n${ctx.diff}`);
  return [
    { role: 'system', content: AI_SYSTEM[kind] },
    { role: 'user', content: parts.join('\n\n') || '（无可用内容）' },
  ];
}

function clip(s: string, max = AI_CTX_MAX): string {
  return s.length > max ? `${s.slice(0, max)}\n…（diff 过长已截断）` : s;
}

/** 文件清单 → 简洁文本（每行 status\tpath [(+adds/-dels)]，喂 LLM 用） */
function fileSummaryText(files: GitFileRec[]): string {
  return files
    .map((f) => {
      const nums = f.adds != null || f.dels != null ? ` (+${f.adds ?? 0}/-${f.dels ?? 0})` : '';
      const ren = f.oldPath ? ` ← ${f.oldPath}` : '';
      return `${f.status}\t${f.path}${ren}${nums}`;
    })
    .join('\n');
}

/** 取一条提交的父提交（普通/根/合并均可），失败回 null */
async function commitParents(driver: GitDriver, cwd: string, sha: string): Promise<string[] | null> {
  const r = await driver.git(cwd, ['rev-list', '--parents', '-n', '1', sha]);
  if (r.code !== 0) return null;
  return r.out.trim().split(/\s+/).slice(1);
}

/**
 * 一条提交的 diff 文本（合并提交按第一父，根提交 --root）；paths 限定文件（file-explain）。
 * 与单文件 diff 端点同构，只是可不带 pathspec 取整条提交。返回空串表示取不到。
 */
async function commitDiffText(
  driver: GitDriver, cwd: string, sha: string, paths?: string[],
): Promise<string> {
  const parents = await commitParents(driver, cwd, sha);
  if (parents === null) return '';
  const pathArgs = paths && paths.length ? ['--', ...paths] : [];
  const dr = await driver.git(cwd, parents.length > 1
    ? ['diff', '-M', parents[0]!, sha, ...pathArgs]
    : ['diff-tree', '-p', '-M', '--root', '--no-commit-id', sha, ...pathArgs]);
  return dr.code === 0 ? dr.out : '';
}

/** 工作区单文件 diff 文本（对 HEAD；untracked 用 --no-index 呈现全新增）。取不到回空串。 */
async function worktreeFileDiffText(
  driver: GitDriver, cwd: string, path: string, old: string, untracked: boolean,
): Promise<string> {
  if (untracked) {
    const dr = await driver.git(cwd, ['diff', '--no-index', '--', '/dev/null', path]);
    return dr.code <= 1 ? dr.out : '';
  }
  const paths = old && old !== path ? [path, old] : [path];
  let dr = await driver.git(cwd, ['diff', '-M', 'HEAD', '--', ...paths]);
  if (dr.code !== 0) dr = await driver.git(cwd, ['diff', '-M', '--', ...paths]);
  return dr.code === 0 ? dr.out : '';
}

// ---------- 路由 ----------

export function gitRoutes(deps: GitRoutesDeps): RouteDef[] {
  const { db } = deps;
  const mutex = deps.mutex ?? new KeyedMutex();

  /** 公共前置：项目存在性 + 非 git 仓库预期态。失败回 Response，成功回上下文。 */
  async function repoCtx(ctx: RouteCtx): Promise<{ driver: GitDriver; cwd: string } | Response> {
    const project = getProject(db, Number(ctx.params.projectId));
    if (!project) return json({ ok: false, error: '无此项目' }, 404); // owner 校验已过=admin
    const driver = deps.driverForProject(project);
    const cwd = project.cwd;
    const repo = await driver.git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (repo.code !== 0 || repo.out.trim() !== 'true') {
      return json({ ok: false, error: '非 git 仓库', cwd });
    }
    return { driver, cwd };
  }

  /** Git 写操作统一入口：同项目严格串行，并在持锁后重新确认仓库现场。 */
  async function withGitWrite(
    ctx: RouteCtx,
    write: (driver: GitDriver, cwd: string) => Promise<Response>,
  ): Promise<Response> {
    try {
      return await mutex.runExclusive(gitLockKey(Number(ctx.params.projectId)), async () => {
        const r = await repoCtx(ctx);
        if (r instanceof Response) return r;
        return write(r.driver, r.cwd);
      });
    } catch (e) {
      return json({ ok: false, error: String(e).slice(0, 200) }, 500);
    }
  }

  /** per-issue 端点前置：解析 issue 分支/基线。未装配 issueGitRef 或非本项目 issue → 404。 */
  function resolveIssueRef(ctx: RouteCtx): IssueGitRef | Response {
    if (!deps.issueGitRef) return json({ ok: false, error: 'per-issue git 未启用' }, 404);
    const ref = deps.issueGitRef(Number(ctx.params.projectId), Number(ctx.params.issueId));
    if (!ref) return json({ ok: false, error: '无此 issue' }, 404);
    return ref;
  }

  return [
    {
      method: 'GET',
      path: '/api/projects/:projectId/git',
      auth: 'project-access',
      handler: async (ctx) => {
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const logR = await driver.git(cwd, [
            'log', '--all', '--date-order', '-n', String(GRAPH_COMMITS),
            `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%an${SEP}%at${SEP}%D${SEP}%s`,
          ]);
          const branchR = await driver.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
          const statusR = await driver.git(cwd, ['status', '--porcelain=v1', '-b']);
          const branchRaw = branchR.code === 0 ? branchR.out.trim() : '';
          const head = statusR.code === 0
            ? parseStatusHead(statusR.out.split('\n')[0] ?? '')
            : { upstream: '', ahead: 0, behind: 0 };
          const changes = statusR.code === 0 ? parseChanges(statusR.out) : [];
          return json({
            ok: true,
            cwd,
            branch: branchRaw === 'HEAD' ? '' : branchRaw, // detached 时 rev-parse 回 'HEAD'
            upstream: head.upstream,
            ahead: head.ahead,
            behind: head.behind,
            dirty: changes.length,
            commits: logR.code === 0 ? parseLog(logR.out) : [], // 空仓库 log 报错 → 降级空图
            changes,
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/branches',
      auth: 'project-access',
      handler: async (ctx) => {
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const [currentR, refsR] = await Promise.all([
            driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
            driver.git(cwd, [
              'for-each-ref', '--sort=refname', `--format=%(refname)${SEP}%(symref)`,
              'refs/heads', 'refs/remotes',
            ]),
          ]);
          if (refsR.code !== 0) {
            return json({ ok: false, error: refsR.err.slice(0, 200) || '读取分支失败', cwd }, 500);
          }
          const local: GitBranchRefRec[] = [];
          const remote: GitBranchRefRec[] = [];
          for (const line of refsR.out.split('\n').filter(Boolean)) {
            const [ref = '', symref = ''] = line.split(SEP);
            if (ref.startsWith('refs/heads/')) {
              local.push({ name: ref.slice('refs/heads/'.length), ref });
            } else if (ref.startsWith('refs/remotes/') && !symref) {
              remote.push({ name: ref.slice('refs/remotes/'.length), ref });
            }
          }
          return json({
            ok: true,
            cwd,
            current: currentR.code === 0 ? currentR.out.trim() : '',
            local,
            remote,
          } satisfies GitBranchesInfo);
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/stage',
      auth: 'project-access',
      handler: async (ctx) => {
        const selection = parseWriteSelection(await readBody(ctx.req));
        if (typeof selection === 'string') return json({ ok: false, error: selection }, 400);
        return withGitWrite(ctx, async (driver, cwd) => {
          const args = selection.all
            ? ['add', '-A']
            : ['add', '-A', '--', ...selection.paths];
          const result = await driver.git(cwd, args);
          return result.code === 0 ? json({ ok: true }) : gitFailure('暂存', result);
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/unstage',
      auth: 'project-access',
      handler: async (ctx) => {
        const selection = parseWriteSelection(await readBody(ctx.req));
        if (typeof selection === 'string') return json({ ok: false, error: selection }, 400);
        return withGitWrite(ctx, async (driver, cwd) => {
          const head = await driver.git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
          const args = head.code === 0
            ? (selection.all
              ? ['reset', '--mixed', '--quiet', 'HEAD']
              : ['reset', '--quiet', 'HEAD', '--', ...selection.paths])
            : (selection.all
              ? ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', '.']
              : ['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', ...selection.paths]);
          const result = await driver.git(cwd, args);
          return result.code === 0 ? json({ ok: true }) : gitFailure('取消暂存', result);
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/commit',
      auth: 'project-access',
      handler: async (ctx) => {
        const body = await readBody(ctx.req);
        if (typeof body.message !== 'string' || !body.message.trim()) {
          return json({ ok: false, error: 'message 必须是非空字符串' }, 400);
        }
        const message = body.message.trim();
        if (message.length > COMMIT_MESSAGE_MAX) {
          return json({ ok: false, error: `message 最多 ${COMMIT_MESSAGE_MAX} 字符` }, 400);
        }
        return withGitWrite(ctx, async (driver, cwd) => {
          // 只观察 index：工作树即便 dirty，也绝不自动 add。
          const staged = await driver.git(cwd, ['diff', '--cached', '--quiet', '--exit-code']);
          if (staged.code === 0) return json({ ok: false, error: '没有已暂存的改动' }, 409);
          if (staged.code !== 1) return gitFailure('检查暂存区', staged);
          const result = await driver.git(cwd, ['commit', '-m', message]);
          if (result.code !== 0) return gitFailure('提交', result);
          const [shaR, shortR] = await Promise.all([
            driver.git(cwd, ['rev-parse', 'HEAD']),
            driver.git(cwd, ['rev-parse', '--short', 'HEAD']),
          ]);
          if (shaR.code !== 0 || shortR.code !== 0) {
            return json({ ok: false, error: '提交成功，但读取新提交失败' }, 500);
          }
          return json({ ok: true, sha: shaR.out.trim(), short: shortR.out.trim() });
        });
      },
    },
    {
      method: 'POST',
      path: '/api/projects/:projectId/git/push',
      auth: 'project-access',
      handler: async (ctx) => withGitWrite(ctx, async (driver, cwd) => {
        const branchR = await driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        const branch = branchR.code === 0 ? branchR.out.trim() : '';
        if (!branch) return json({ ok: false, error: 'detached HEAD 无法推送当前分支' }, 409);
        const headR = await driver.git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
        if (headR.code !== 0) return json({ ok: false, error: '当前分支尚无提交' }, 409);

        const upstreamR = await driver.git(cwd, [
          'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}',
        ]);
        if (upstreamR.code === 0 && upstreamR.out.trim()) {
          const result = await driver.git(cwd, ['push']);
          if (result.code !== 0) return gitFailure('推送', result, 502);
          return json({
            ok: true,
            branch,
            upstream: upstreamR.out.trim(),
            createdUpstream: false,
          });
        }

        const origin = await driver.git(cwd, ['remote', 'get-url', 'origin']);
        if (origin.code !== 0) {
          return json({ ok: false, error: '当前分支没有 upstream，且未配置 origin 远程仓库' }, 409);
        }
        const result = await driver.git(cwd, [
          'push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`,
        ]);
        if (result.code !== 0) return gitFailure('推送并建立 upstream', result, 502);
        return json({
          ok: true,
          branch,
          upstream: `origin/${branch}`,
          createdUpstream: true,
        });
      }),
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/commits/:sha',
      auth: 'project-access',
      handler: async (ctx) => {
        const sha = ctx.params.sha ?? '';
        if (!SHA_RE.test(sha)) return json({ ok: false, error: 'sha 非法' }, 400);
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const metaR = await driver.git(cwd, [
            'show', '--no-patch',
            `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%D${SEP}%B`,
            sha,
          ]);
          if (metaR.code !== 0) return json({ ok: false, error: '无此提交或引用不明确' }, 404);
          const f = metaR.out.split(SEP);
          if (f.length < 10) return json({ ok: false, error: '解析提交失败' }, 500);
          const parents = f[2] ? f[2]!.split(' ') : [];
          // 文件列表：普通/根提交用 diff-tree（--root 兜根），合并提交按第一父 diff
          const diffArgs = parents.length > 1
            ? ['diff', '-M', '--name-status', parents[0]!, sha]
            : ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '--name-status', sha];
          const nameR = await driver.git(cwd, diffArgs);
          const numR = await driver.git(
            cwd,
            diffArgs.map((a) => (a === '--name-status' ? '--numstat' : a)),
          );
          return json({
            ok: true,
            sha: f[0]!,
            short: f[1]!,
            parents,
            author: f[3]!,
            authorEmail: f[4]!,
            authorTs: Number(f[5]) * 1000,
            committer: f[6]!,
            commitTs: Number(f[7]) * 1000,
            refs: f[8] ? f[8]!.split(', ') : [],
            message: f.slice(9).join(SEP).trim(),
            files: parseFiles(nameR.code === 0 ? nameR.out : '', numR.code === 0 ? numR.out : ''),
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/commits/:sha/diff',
      auth: 'project-access',
      handler: async (ctx) => {
        const sha = ctx.params.sha ?? '';
        if (!SHA_RE.test(sha)) return json({ ok: false, error: 'sha 非法' }, 400);
        const path = ctx.url.searchParams.get('path') ?? '';
        if (!path) return json({ ok: false, error: '缺 path' }, 400);
        const old = ctx.url.searchParams.get('old') ?? '';
        const paths = old && old !== path ? [path, old] : [path];
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const parentsR = await driver.git(cwd, ['rev-list', '--parents', '-n', '1', sha]);
          if (parentsR.code !== 0) return json({ ok: false, error: '无此提交' }, 404);
          const parents = parentsR.out.trim().split(/\s+/).slice(1);
          // 合并提交 diff-tree 默认输出空 → 显式对第一父 diff
          const dr = await driver.git(cwd, parents.length > 1
            ? ['diff', '-M', parents[0]!, sha, '--', ...paths]
            : ['diff-tree', '-p', '-M', '--root', '--no-commit-id', sha, '--', ...paths]);
          if (dr.code !== 0) return json({ ok: false, error: dr.err.slice(0, 200) || 'diff 失败' }, 500);
          return json({ ok: true, ...sliceDiff(dr.out) });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/projects/:projectId/git/worktree/diff',
      auth: 'project-access',
      handler: async (ctx) => {
        const path = ctx.url.searchParams.get('path') ?? '';
        if (!path) return json({ ok: false, error: '缺 path' }, 400);
        const old = ctx.url.searchParams.get('old') ?? '';
        const untracked = ctx.url.searchParams.get('untracked') === '1';
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          if (untracked) {
            // 未跟踪文件没有 diff 基线：--no-index 对 /dev/null 呈现全新增（有差异时 exit 1 属正常）
            const dr = await driver.git(cwd, ['diff', '--no-index', '--', '/dev/null', path]);
            if (dr.code > 1) return json({ ok: false, error: dr.err.slice(0, 200) || 'diff 失败' }, 500);
            return json({ ok: true, ...sliceDiff(dr.out) });
          }
          const paths = old && old !== path ? [path, old] : [path];
          // 对 HEAD diff = 暂存+未暂存合并视角；空仓库无 HEAD → 退化为未暂存 diff
          let dr = await driver.git(cwd, ['diff', '-M', 'HEAD', '--', ...paths]);
          if (dr.code !== 0) dr = await driver.git(cwd, ['diff', '-M', '--', ...paths]);
          if (dr.code !== 0) return json({ ok: false, error: dr.err.slice(0, 200) || 'diff 失败' }, 500);
          return json({ ok: true, ...sliceDiff(dr.out) });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      // 本 issue 的 git 现场：本 issue 自己的提交历史 + 改动范围（程序员视角）。
      // 固定/共享分支带 startSha 时取 start..end（只本 issue 的 commit），否则退回 base..branch。
      method: 'GET',
      path: '/api/projects/:projectId/issues/:issueId/git',
      auth: 'project-access',
      handler: async (ctx) => {
        const ref = resolveIssueRef(ctx);
        if (ref instanceof Response) return ref;
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const { branch, base } = ref;
          // 活跃 issue（持有工作树）附带未提交改动：执行中的改动在 auto commit 前只在这里可见。
          // status 失败则降级不带字段（不挡 commit 范围部分）。
          let worktree: GitChangeRec[] | undefined;
          if (ref.active) {
            const st = await driver.git(cwd, ['status', '--porcelain=v1']);
            if (st.code === 0) worktree = parseChanges(st.out);
          }
          const wtField = worktree ? { worktree } : {};
          /**
           * 快照兜底：分支没了/范围锚失效时用引擎 impl_commits 耐久快照回填（快照存 DB，
           * 永远可显示）。推送状态仍按快照终点算（对象还在就有值，没了降级缺省）。
           */
          const snapInfo = async (): Promise<Response | null> => {
            const snap = ref.snapshot?.();
            if (!snap) return null;
            const push = await pushState(driver, cwd, branch, snap.tip);
            return json({
              ok: true,
              branch,
              base,
              startSha: snap.base,
              exists: true,
              ahead: snap.commits.length,
              commits: snap.commits.map((c) => ({
                sha: c.sha, short: c.short, parents: [], author: c.author, ts: c.ts, refs: [], subject: c.subject,
              })),
              files: snap.files,
              stat: '',
              source: 'snapshot',
              ...wtField,
              ...(push ? { push } : {}),
            });
          };
          // 分支存在性：未启动/未落分支的 issue 回空（前端提示「尚未产生改动」）；
          // 有快照说明当年落过改动（分支后来被清理）→ 快照兜底
          const has = await driver.git(cwd, ['rev-parse', '--verify', '--quiet', branch]);
          if (has.code !== 0) {
            const s = await snapInfo();
            if (s) return s;
            return json({
              ok: true, branch, base, exists: false, ahead: 0, commits: [], files: [], stat: '', ...wtField,
            });
          }
          const { start, end, log: logRange, diff: diffRange } = await issueRange(driver, cwd, ref);
          // 有起点锚却解析不出（历史重写/对象被 gc）→ 快照兜底，
          // 别退回 base...branch 把共享分支上其它 issue 的提交混进来
          if (!start && ref.startSha) {
            const s = await snapInfo();
            if (s) return s;
          }
          const logR = await driver.git(cwd, [
            'log', '--date-order', '-n', String(GRAPH_COMMITS),
            `--pretty=format:%H${SEP}%h${SEP}%P${SEP}%an${SEP}%at${SEP}%D${SEP}%s`,
            logRange,
          ]);
          const nameR = await driver.git(cwd, ['diff', '-M', '--name-status', diffRange]);
          const numR = await driver.git(cwd, ['diff', '-M', '--numstat', diffRange]);
          const statR = await driver.git(cwd, ['diff', '--stat', diffRange]);
          const push = await pushState(driver, cwd, branch, end);
          const commits = logR.code === 0 ? parseLog(logR.out) : [];
          return json({
            ok: true,
            branch,
            base,
            ...(start ? { startSha: start } : {}),
            exists: true,
            ahead: commits.length,
            commits,
            files: parseFiles(nameR.code === 0 ? nameR.out : '', numR.code === 0 ? numR.out : ''),
            stat: statR.code === 0 ? statR.out.trim() : '',
            ...wtField,
            ...(push ? { push } : {}),
          });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      // 本 issue 单文件 diff：start..end（固定分支）或 base...branch（经典）范围内该文件的净改动
      method: 'GET',
      path: '/api/projects/:projectId/issues/:issueId/git/diff',
      auth: 'project-access',
      handler: async (ctx) => {
        const ref = resolveIssueRef(ctx);
        if (ref instanceof Response) return ref;
        const path = ctx.url.searchParams.get('path') ?? '';
        if (!path) return json({ ok: false, error: '缺 path' }, 400);
        const old = ctx.url.searchParams.get('old') ?? '';
        const paths = old && old !== path ? [path, old] : [path];
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;
          const { diff: diffRange } = await issueRange(driver, cwd, ref);
          const dr = await driver.git(cwd, ['diff', '-M', diffRange, '--', ...paths]);
          if (dr.code !== 0) return json({ ok: false, error: dr.err.slice(0, 200) || 'diff 失败' }, 500);
          return json({ ok: true, ...sliceDiff(dr.out) });
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
    {
      // AI 助读：总结提交 / 识别风险 / 解释整条 diff / 解释单文件 diff / 生成提交信息。
      // 复用 commit/diff 构建逻辑拼上下文，调 驱动大模型 返回 { ok, text }。未接 llm → 503。
      method: 'POST',
      path: '/api/projects/:projectId/git/ai',
      auth: 'project-access',
      handler: async (ctx) => {
        const body = await readBody(ctx.req);
        const kind = body.kind as GitAiKind;
        if (!GIT_AI_KINDS.includes(kind)) {
          return json({ ok: false, error: `kind 仅支持 ${GIT_AI_KINDS.join(' / ')}` }, 400);
        }
        if (!deps.llm) return json({ ok: false, error: '未接入 LLM，无法使用 AI 助读' }, 503);
        const llm = deps.llm;
        const sha = typeof body.sha === 'string' ? body.sha : '';
        const path = typeof body.path === 'string' ? body.path : '';
        const old = typeof body.old === 'string' ? body.old : '';
        const untracked = body.untracked === true || body.untracked === '1';
        // 入参校验：commit-* 需合法 sha；file-explain 需 path（工作区文件无 sha）；commit-message 无需。
        const needsSha = kind === 'commit-summary' || kind === 'commit-risk' || kind === 'commit-explain';
        if (needsSha && !SHA_RE.test(sha)) return json({ ok: false, error: 'sha 非法' }, 400);
        if (kind === 'file-explain') {
          if (!path) return json({ ok: false, error: '缺 path' }, 400);
          if (sha && !SHA_RE.test(sha)) return json({ ok: false, error: 'sha 非法' }, 400);
        }
        try {
          const r = await repoCtx(ctx);
          if (r instanceof Response) return r;
          const { driver, cwd } = r;

          const gctx: GitAiCtx = {};
          if (kind === 'commit-summary' || kind === 'commit-risk' || kind === 'commit-explain') {
            // 提交元信息（标题/正文/文件清单）+ 整条提交 diff
            const metaR = await driver.git(cwd, [
              'show', '--no-patch', `--pretty=format:%s${SEP}%B`, sha,
            ]);
            if (metaR.code !== 0) return json({ ok: false, error: '无此提交或引用不明确' }, 404);
            const mf = metaR.out.split(SEP);
            gctx.subject = mf[0] ?? '';
            if (kind !== 'commit-explain') {
              gctx.message = (mf.slice(1).join(SEP)).trim();
              const parents = await commitParents(driver, cwd, sha);
              const diffArgs = parents && parents.length > 1
                ? ['diff', '-M', '--numstat', parents[0]!, sha]
                : ['diff-tree', '-r', '-M', '--root', '--no-commit-id', '--numstat', sha];
              const nsArgs = diffArgs.map((a) => (a === '--numstat' ? '--name-status' : a));
              const nameR = await driver.git(cwd, nsArgs);
              const numR = await driver.git(cwd, diffArgs);
              gctx.files = fileSummaryText(
                parseFiles(nameR.code === 0 ? nameR.out : '', numR.code === 0 ? numR.out : ''),
              );
            }
            gctx.diff = clip(await commitDiffText(driver, cwd, sha));
          } else if (kind === 'file-explain') {
            gctx.path = path;
            gctx.diff = clip(sha
              ? await commitDiffText(driver, cwd, sha, old && old !== path ? [path, old] : [path])
              : await worktreeFileDiffText(driver, cwd, path, old, untracked));
          } else {
            // commit 只消费 index：一旦已有暂存内容，AI 也必须只描述将被提交的部分。
            // --cached 在 unborn HEAD 下同样能给出相对空树的新增 diff。
            const stagedNames = await driver.git(cwd, [
              'diff', '--cached', '--name-status', '-M',
            ]);
            if (stagedNames.code === 0 && stagedNames.out.trim()) {
              gctx.files = stagedNames.out.trim();
              const stagedDiff = await driver.git(cwd, ['diff', '--cached', '-M']);
              gctx.diff = clip(stagedDiff.code === 0 ? stagedDiff.out : '');
            } else {
              // 尚未暂存时仍允许先生成建议，分析当前工作区全部改动。
              const statusR = await driver.git(cwd, ['status', '--porcelain=v1']);
              gctx.files = statusR.code === 0 ? statusR.out.trim() : '';
              let dr = await driver.git(cwd, ['diff', '-M', 'HEAD']);
              if (dr.code !== 0) dr = await driver.git(cwd, ['diff', '-M']);
              gctx.diff = clip(dr.code === 0 ? dr.out : '');
            }
          }

          if (!gctx.diff && !gctx.files) {
            return json({ ok: false, error: '没有可供分析的改动' }, 400);
          }

          try {
            const res = await llm.chat(buildGitAiPrompt(kind, gctx));
            const text = res.content.trim();
            if (!text) return json({ ok: false, error: 'AI 返回空结果' }, 502);
            return json({ ok: true, text });
          } catch (e) {
            const configError = llmErrorResponse(e);
            if (configError) return configError;
            return json({ ok: false, error: `AI 生成失败：${String(e).slice(0, 200)}` }, 502);
          }
        } catch (e) {
          return json({ ok: false, error: String(e).slice(0, 200) }, 500);
        }
      },
    },
  ];
}

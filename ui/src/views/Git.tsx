/**
 * Git 工作区 —— VSCode 式「左侧树 + 提交历史 | 右侧上下文」：
 *   顶栏：分支 / 上游 ↑↓ / 刷新；
 *   左上：完整文件 / 当前未提交 / 指定 commit 三来源统一文件树；
 *   左下：可折叠 lane 提交图，点行切换树，独立「查看详情」打开完整 commit message；
 *   右侧：完整文件用 FileViewer，改动文件用 diff，提交详情复用 CommitPanel；
 *   H5：导航保持上树下历史，点内容后在剩余区域全屏钻入。
 */
import type { ComponentChildren, RefObject } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import { useColSizes, type ColSizes } from '../lib/colsize';
import { fmtTime, timeAgo } from '../lib/fmt';
import {
  aiCommitMessage, aiCommitRisk, aiExplainCommit, aiExplainFile, aiSummarizeCommit,
} from '../lib/gitai';
import { layoutGraph, type GraphEdge } from '../lib/gitgraph';
import {
  createGitOperationCoordinator,
  deriveGitFileOperations,
  requireGitOperationSuccess,
  type GitFileOperation,
  type GitOperationCoordinator,
  type GitOperationKind,
} from '../lib/gitoperations';
import {
  buildGitWorkspaceTree,
  createGitWorkspaceState,
  gitWorkspaceReducer,
  type GitWorkspaceAction,
  type GitWorkspaceFile,
  type GitWorkspaceState,
} from '../lib/gitworkspace';
import {
  beginGitLoad,
  commitPanelLayout,
  completeGitLoad,
  createGitLoadState,
  failGitLoad,
  keyedResult,
  requestKey,
  type KeyedResult,
} from '../lib/gitviewstate';
import { nav } from '../lib/router';
import { toast } from '../lib/toast';
import { useTreeWidth } from '../lib/treewidth';
import { useWide } from '../lib/useWide';
import type {
  GitChange, GitCommit, GitCommitDetail, GitCommitResult, GitDiff, GitFile, GitInfo,
  GitPushResult, GitWriteResult, Project,
} from '../lib/types';
import { Loading } from '../components/Loaders';
import { ChangeTree } from '../components/ChangeTree';
import { FileTree } from '../components/FileTree';
import { FileViewer } from '../components/FileViewer';
import { ListSplitter } from '../components/ListSplitter';
import { Splitter } from '../components/Splitter';

// ---------- 绘图常量 ----------

const ROW_H = 42;
const LANE_W = 14;
const PAD_X = 9;

/** 泳道配色（奶油亮底高辨识，首位用品牌橙黄） */
const LANE_COLORS = [
  '#f59e0b', '#8b5cf6', '#16a34a', '#e8590c', '#db2777',
  '#0891b2', '#2563eb', '#65a30d', '#dc2626', '#b45309',
];
const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!;

const cx = (lane: number): number => PAD_X + lane * LANE_W + LANE_W / 2;
const cy = (row: number): number => row * ROW_H + ROW_H / 2;

/** 两端竖直切线的 S 曲线（换道连接） */
function sCurve(xa: number, ya: number, xb: number, yb: number): string {
  const ym = (ya + yb) / 2;
  return `C ${xa} ${ym}, ${xb} ${ym}, ${xb} ${yb}`;
}

/** 子→父连线路径：出发端/汇入端换道各占一行行高，中段沿泳道竖直 */
function edgePath(e: GraphEdge, rows: number): string {
  const x1 = cx(e.fromLane);
  const xm = cx(e.lane);
  const x2 = cx(e.toLane);
  const y1 = cy(e.fromRow);
  if (e.missing) {
    const yEnd = Math.min(y1 + ROW_H * 0.8, rows * ROW_H - 2);
    return x1 === xm
      ? `M ${x1} ${y1} L ${x1} ${yEnd}`
      : `M ${x1} ${y1} ${sCurve(x1, y1, xm, yEnd)}`;
  }
  const y2 = cy(e.toRow);
  const topEnd = e.fromLane === e.lane ? y1 : y1 + ROW_H;
  const botStart = e.toLane === e.lane ? y2 : y2 - ROW_H;
  if (x1 === xm && xm === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  if (topEnd > botStart) return `M ${x1} ${y1} ${sCurve(x1, y1, x2, y2)}`; // 紧邻行双拐 → 一条曲线直达
  let d = `M ${x1} ${y1}`;
  if (x1 !== xm) d += ` ${sCurve(x1, y1, xm, topEnd)}`;
  d += ` L ${xm} ${botStart}`;
  if (xm !== x2) d += ` ${sCurve(xm, botStart, x2, y2)}`;
  return d;
}

// ---------- 小件 ----------

/** %D 装饰 → 徽章描述（HEAD -> x 拆成 HEAD + 分支两枚） */
function refPills(refs: string[]): Array<{ label: string; cls: string }> {
  const pills: Array<{ label: string; cls: string }> = [];
  for (const r of refs) {
    if (r.startsWith('HEAD -> ')) {
      pills.push({ label: 'HEAD', cls: 'rp-head' }, { label: r.slice(8), cls: 'rp-branch' });
    } else if (r === 'HEAD') {
      pills.push({ label: 'HEAD', cls: 'rp-head' });
    } else if (r.startsWith('tag: ')) {
      pills.push({ label: `⌂ ${r.slice(5)}`, cls: 'rp-tag' });
    } else if (r.includes('/')) {
      pills.push({ label: r, cls: 'rp-remote' });
    } else {
      pills.push({ label: r, cls: 'rp-branch' });
    }
  }
  return pills;
}

export function RefBadges({ refs, max = 3 }: { refs: string[]; max?: number }) {
  const pills = refPills(refs);
  if (pills.length === 0) return null;
  const shown = pills.slice(0, max);
  return (
    <>
      {shown.map((p) => (
        <span class={`rp ${p.cls}`}>{p.label}</span>
      ))}
      {pills.length > max && <span class="rp rp-more">+{pills.length - max}</span>}
    </>
  );
}

const FILE_STATUS: Record<string, { label: string; cls: string }> = {
  A: { label: '新增', cls: 'fs-a' },
  M: { label: '修改', cls: 'fs-m' },
  D: { label: '删除', cls: 'fs-d' },
  R: { label: '重命名', cls: 'fs-r' },
  C: { label: '复制', cls: 'fs-r' },
  T: { label: '类型变更', cls: 'fs-m' },
  U: { label: '冲突', cls: 'fs-d' },
  '?': { label: '未跟踪', cls: 'fs-u' },
};

export function StatusChip({ code }: { code: string }) {
  const st = FILE_STATUS[code[0] ?? ''] ?? { label: code, cls: 'fs-m' };
  return (
    <span class={`fschip ${st.cls}`} title={st.label}>
      {code[0]}
    </span>
  );
}

/** 路径渲染：目录淡、文件名亮，重命名带 ← 旧名 */
export function PathText({ path, oldPath }: { path: string; oldPath?: string }) {
  const i = path.lastIndexOf('/');
  return (
    <span class="gf-path mono" title={oldPath ? `${oldPath} → ${path}` : path}>
      {i >= 0 && <span class="gf-dir">{path.slice(0, i + 1)}</span>}
      {path.slice(i + 1)}
      {oldPath && <span class="gf-dir"> ← {oldPath}</span>}
    </span>
  );
}

export function PlusMinus({ adds, dels }: { adds?: number | null; dels?: number | null }) {
  if (adds === undefined && dels === undefined) return null;
  if (adds === null || dels === null) return <span class="gf-bin">二进制</span>;
  return (
    <span class="gf-pm mono">
      {adds ? <em class="d-add">+{adds}</em> : null}
      {dels ? <em class="d-del">−{dels}</em> : null}
      {!adds && !dels ? <em class="gf-dir">±0</em> : null}
    </span>
  );
}

function copyText(s: string, hint: string): void {
  navigator.clipboard
    ?.writeText(s)
    .then(() => toast.success(`已复制${hint}`))
    .catch(() => toast.error('复制失败'));
}

// ---------- AI 助读交互件（结果仅存组件内存，不落库） ----------

interface AiRun {
  /** 触发的动作标签（总结提交 / 识别风险 / 解释 Diff / 生成 Commit Message） */
  label: string;
  loading: boolean;
  text?: string;
  error?: string;
}

/** 单结果槽：一次只显示最近一次动作；序号护栏丢弃乱序返回（快速连点不同动作） */
function useGitAi(): {
  run: AiRun | null;
  start: (label: string, fn: () => Promise<string>) => void;
  clear: () => void;
} {
  const [run, setRun] = useState<AiRun | null>(null);
  const seq = useRef(0);
  const start = (label: string, fn: () => Promise<string>): void => {
    const my = ++seq.current;
    setRun({ label, loading: true });
    fn()
      .then((text) => {
        if (seq.current === my) setRun({ label, loading: false, text });
      })
      .catch((e: Error) => {
        if (seq.current === my) setRun({ label, loading: false, error: e.message || 'AI 生成失败' });
      });
  };
  const clear = (): void => {
    seq.current++;
    setRun(null);
  };
  return { run, start, clear };
}

/** 内联可折叠 AI 结果面板：loading / 错误 / 文本结果 + 复制。默认展开。 */
function AiPanel({ run, onClose }: { run: AiRun; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div class="ai-panel">
      <div class="ai-panel-hd">
        <button class="gd-collapse" title={open ? '折叠' : '展开'} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'}
        </button>
        <span class="ai-panel-title">🤖 {run.label}</span>
        {run.loading && <span class="ai-panel-status mut">生成中…</span>}
        {!run.loading && run.text && (
          <button class="ai-copy" title="复制结果" onClick={() => copyText(run.text!, ' AI 结果')}>
            复制
          </button>
        )}
        <button class="gs-x" title="关闭" onClick={onClose}>✕</button>
      </div>
      {open && (
        <div class="ai-panel-body">
          {run.loading && <Loading />}
          {run.error && <div class="err">{run.error}</div>}
          {!run.loading && run.text && <pre class="ai-panel-text">{run.text}</pre>}
        </div>
      )}
    </div>
  );
}

/** 提交级 AI 按钮（总结提交 / 识别风险 / 解释整条 Diff），挂提交详情头 */
function CommitAiBtns({ pid, sha, ai }: { pid: number; sha: string; ai: ReturnType<typeof useGitAi> }) {
  const busy = ai.run?.loading ?? false;
  return (
    <div class="ai-btns">
      <button class="ai-btn" disabled={busy} onClick={() => ai.start('总结提交', () => aiSummarizeCommit(pid, sha))}>
        ✨ 总结提交
      </button>
      <button class="ai-btn" disabled={busy} onClick={() => ai.start('识别风险', () => aiCommitRisk(pid, sha))}>
        ⚠ 识别风险
      </button>
      <button class="ai-btn" disabled={busy} onClick={() => ai.start('解释 Diff', () => aiExplainCommit(pid, sha))}>
        🔍 解释整条 Diff
      </button>
    </div>
  );
}

// ---------- diff 视图（着色 unified diff） ----------

const DIFF_MAX_LINES = 4000;

function diffLineCls(l: string): string {
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')
    || l.startsWith('new file') || l.startsWith('deleted file') || l.startsWith('similarity')
    || l.startsWith('rename ') || l.startsWith('\\')) return 'dl dh';
  if (l.startsWith('@@')) return 'dl dhunk';
  if (l.startsWith('+')) return 'dl dadd';
  if (l.startsWith('-')) return 'dl ddel';
  return 'dl';
}

export function DiffBody({ d, error }: { d: GitDiff | null; error?: string }) {
  if (error) return <div class="empty"><span class="err">{error}</span></div>;
  if (d === null) return <Loading />;
  if (!d.diff.trim()) return <div class="empty">没有内容差异</div>;
  const lines = d.diff.split('\n');
  const shown = lines.slice(0, DIFF_MAX_LINES);
  return (
    <pre class="gs-diff mono">
      {shown.map((l) => (
        <div class={diffLineCls(l)}>{l || ' '}</div>
      ))}
      {(lines.length > DIFF_MAX_LINES || d.truncated) && (
        <div class="dl dh">… diff 过长已截断 …</div>
      )}
    </pre>
  );
}

// ---------- 数据 hooks / URL ----------

/** 提交详情拉取（抽屉、右栏与工作区树共用；reloadToken 用于手动刷新当前上下文）。 */
export function useCommitDetail(
  pid: number,
  sha: string | null,
  reloadToken = 0,
): { d: GitCommitDetail | null; err: string } {
  const [d, setD] = useState<GitCommitDetail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let alive = true;
    setD(null);
    setErr('');
    if (!sha) return () => { alive = false; };
    api<GitCommitDetail>(`/api/projects/${pid}/git/commits/${sha}`)
      .then((detail) => {
        if (alive) setD(detail);
      })
      .catch((e: Error) => {
        if (alive) setErr(e.message);
      });
    return () => { alive = false; };
  }, [pid, sha, reloadToken]);
  return { d, err };
}

/**
 * 单文件 diff 状态机：open(f) 记录选中文件并拉取（diff=null 为加载中），
 * close() 收起。序号护栏丢弃乱序返回（快速连点不同文件）。
 */
export function useFileDiff<T>(toUrl: (f: T) => string, reloadToken = 0): {
  file: T | null;
  diff: GitDiff | null;
  err: string;
  open: (f: T) => void;
  close: () => void;
} {
  const [file, setFile] = useState<T | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [err, setErr] = useState('');
  const seq = useRef(0);
  const fetchDiff = (f: T): void => {
    const my = ++seq.current;
    setDiff(null);
    setErr('');
    api<GitDiff>(toUrl(f))
      .then((d) => {
        if (seq.current === my) setDiff(d);
      })
      .catch((e: Error) => {
        if (seq.current !== my) return;
        setDiff(null);
        setErr(e.message);
        toast.error(e.message);
      });
  };
  const open = (f: T): void => {
    setFile(f);
    fetchDiff(f);
  };
  useEffect(() => {
    if (!file || reloadToken === 0) return;
    fetchDiff(file);
    // 刷新信号只重拉当前文件；file/toUrl 变化由 open 或父级 key 重挂载处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);
  const close = (): void => {
    seq.current++;
    setFile(null);
    setDiff(null);
    setErr('');
  };
  return { file, diff, err, open, close };
}

export function commitDiffUrl(pid: number, sha: string, f: GitFile): string {
  const q = new URLSearchParams({ path: f.path });
  if (f.oldPath) q.set('old', f.oldPath);
  return `/api/projects/${pid}/git/commits/${sha}/diff?${q}`;
}

// ---------- 提交详情共用块（抽屉 + 右栏） ----------

/** 提交元信息：subject / 正文 / 作者 / 提交者 / 父提交跳转 */
export function CommitMeta({ d, onJump }: { d: GitCommitDetail; onJump: (sha: string) => void }) {
  const body = d.message.split('\n').slice(1).join('\n').trim();
  return (
    <>
      <div class="gs-subject">{d.message.split('\n')[0]}</div>
      {body && <pre class="gs-msg">{body}</pre>}
      <div class="gs-meta">
        <div>
          <span class="gs-k">作者</span>
          <b>{d.author}</b> <span class="mut">&lt;{d.authorEmail}&gt;</span>
          <span class="mut"> · {fmtTime(d.authorTs)}（{timeAgo(d.authorTs)}）</span>
        </div>
        {(d.committer !== d.author || d.commitTs !== d.authorTs) && (
          <div>
            <span class="gs-k">提交</span>
            <b>{d.committer}</b>
            <span class="mut"> · {fmtTime(d.commitTs)}（{timeAgo(d.commitTs)}）</span>
          </div>
        )}
        {d.parents.length > 0 && (
          <div>
            <span class="gs-k">父提交</span>
            {d.parents.map((p) => (
              <button class="gs-parent mono" onClick={() => onJump(p)}>
                {p.slice(0, 8)}
              </button>
            ))}
            {d.parents.length > 1 && <span class="mut">（合并）</span>}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * 提交详情头（宽屏 col2 / IssueDetail 面板复用）：整块可折叠，默认展开。
 * 展开 = sha + refs + CommitMeta（正文/作者/父提交）；折叠 = 仅一行 sha + subject + 展开钮。
 * 折叠态由本地状态管，key=sha 重挂载即回默认展开。
 */
export function CommitHead({
  pid, d, err, sha, onJump,
}: {
  pid: number;
  d: GitCommitDetail | null;
  err: string;
  sha: string;
  onJump: (sha: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const ai = useGitAi();
  const short = d?.short ?? sha.slice(0, 8);
  const subject = d ? (d.message.split('\n')[0] ?? '') : '';
  return (
    <>
      <div class={`gd-head${open ? '' : ' collapsed'}`}>
        <div class="gd-headrow">
          <button
            class="gd-collapse"
            title={open ? '折叠详情' : '展开详情'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▾' : '▸'}
          </button>
          <span
            class="gs-sha mono"
            title="点击复制完整 sha"
            onClick={() => d && copyText(d.sha, ' sha')}
          >
            {short} ⧉
          </span>
          {open
            ? d && <RefBadges refs={d.refs} max={6} />
            : <span class="gd-collapsed-subj" title={subject}>{subject}</span>}
        </div>
        {err && <div class="err">{err}</div>}
        {open && d && <CommitMeta d={d} onJump={onJump} />}
        {open && d && <CommitAiBtns pid={pid} sha={sha} ai={ai} />}
      </div>
      {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
    </>
  );
}

export function sumFiles(files: GitFile[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.adds ?? 0;
    dels += f.dels ?? 0;
  }
  return { adds, dels };
}

export function FilesHead({ files }: { files: GitFile[] }) {
  const totals = sumFiles(files);
  return (
    <div class="gs-fhead">
      {files.length} 个文件
      {(totals.adds > 0 || totals.dels > 0) && (
        <span class="gf-pm mono">
          <em class="d-add">+{totals.adds}</em>
          <em class="d-del">−{totals.dels}</em>
        </span>
      )}
    </div>
  );
}

export function FileRows({
  files, selPath, onOpen,
}: {
  files: GitFile[];
  selPath?: string;
  onOpen: (f: GitFile) => void;
}) {
  return (
    <div class="gs-files">
      {files.length === 0 && <div class="mut small">（无文件改动）</div>}
      {files.map((f) => (
        <button class={`gf-row${selPath === f.path ? ' on' : ''}`} onClick={() => onOpen(f)}>
          <StatusChip code={f.status} />
          <PathText path={f.path} oldPath={f.oldPath} />
          <PlusMinus adds={f.adds} dels={f.dels} />
        </button>
      ))}
    </div>
  );
}

// ---------- 工作区改动共用块（Git 页 + issue 工作台「改动」tab 复用） ----------

export interface WtEntry {
  change: GitChange;
  group: '已暂存' | '未暂存' | '未跟踪';
  code: string;
}

/** porcelain 两列码 → 按暂存区/工作区拆组（同一文件可同时出现在两组） */
function groupChanges(changes: GitChange[]): WtEntry[] {
  const out: WtEntry[] = [];
  for (const c of changes) {
    const x = c.status[0] ?? ' ';
    const y = c.status[1] ?? ' ';
    if (c.status === '??') {
      out.push({ change: c, group: '未跟踪', code: '?' });
      continue;
    }
    if (x !== ' ') out.push({ change: c, group: '已暂存', code: x });
    if (y !== ' ') out.push({ change: c, group: '未暂存', code: y });
  }
  return out;
}

/** 稳定选中键：entries 每次渲染重建，靠 组+路径 匹配高亮 */
export const wtKey = (e: WtEntry): string => `${e.group}:${e.change.path}`;

export function wtDiffUrl(pid: number, e: WtEntry): string {
  const q = new URLSearchParams({ path: e.change.path });
  if (e.change.oldPath) q.set('old', e.change.oldPath);
  if (e.group === '未跟踪') q.set('untracked', '1');
  return `/api/projects/${pid}/git/worktree/diff?${q}`;
}

export function WtGroups({
  changes, selKey, onOpen,
}: {
  changes: GitChange[];
  selKey?: string;
  onOpen: (e: WtEntry) => void;
}) {
  const entries = groupChanges(changes);
  const groups = (['已暂存', '未暂存', '未跟踪'] as const)
    .map((g) => ({ g, items: entries.filter((e) => e.group === g) }))
    .filter((x) => x.items.length > 0);
  return (
    <>
      {groups.map(({ g, items }) => (
        <div class="gs-group">
          <div class="gs-fhead">{g} · {items.length}</div>
          <div class="gs-files">
            {items.map((e) => (
              <button class={`gf-row${selKey === wtKey(e) ? ' on' : ''}`} onClick={() => onOpen(e)}>
                <StatusChip code={e.code} />
                <PathText path={e.change.path} oldPath={e.change.oldPath} />
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

// ---------- 底部抽屉（H5 窄屏） ----------

function Sheet({ onClose, children }: { onClose: () => void; children: ComponentChildren }) {
  // portal 到 body：躲开容器 filling 动画的层叠上下文（同 Modal/ImageLightbox，issue #79）
  return createPortal(
    <div
      class="gsheet-bg"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div class="gsheet">{children}</div>
    </div>,
    document.body,
  );
}

function CommitSheet({
  pid, sha, onClose, onJump,
}: {
  pid: number;
  sha: string;
  onClose: () => void;
  onJump: (sha: string) => void;
}) {
  const { d, err } = useCommitDetail(pid, sha);
  const fd = useFileDiff<GitFile>((f) => commitDiffUrl(pid, sha, f));
  const commitAi = useGitAi(); // 提交级（总结/风险/解释整条）
  const fileAi = useGitAi(); // 单文件级（解释 Diff）
  const [openMeta, setOpenMeta] = useState(true);

  return (
    <Sheet onClose={onClose}>
      {fd.file ? (
        <>
          <div class="gs-head">
            <button class="back" onClick={fd.close}>‹</button>
            <StatusChip code={fd.file.status} />
            <PathText path={fd.file.path} oldPath={fd.file.oldPath} />
            <button
              class="ai-btn ai-btn-sm"
              disabled={fileAi.run?.loading}
              title="AI 解释此文件改动"
              onClick={() => fileAi.start('解释 Diff', () =>
                aiExplainFile(pid, { sha, path: fd.file!.path, old: fd.file!.oldPath }))}
            >
              ✨ 解释
            </button>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          {fileAi.run && <AiPanel run={fileAi.run} onClose={fileAi.clear} />}
          <DiffBody d={fd.diff} error={fd.err} />
        </>
      ) : (
        <>
          <div class="gs-head">
            <span
              class="gs-sha mono"
              title="点击复制完整 sha"
              onClick={() => d && copyText(d.sha, ' sha')}
            >
              {d?.short ?? sha.slice(0, 8)} ⧉
            </span>
            {d && <RefBadges refs={d.refs} max={4} />}
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          {err && <div class="err">{err}</div>}
          {!d && !err && <Loading />}
          {d && (
            <div class="gs-body">
              <button
                class="gd-collapse gs-detailtoggle"
                aria-expanded={openMeta}
                onClick={() => setOpenMeta((o) => !o)}
              >
                {openMeta ? '▾ 收起详情' : '▸ 展开详情'}
              </button>
              {openMeta && <CommitMeta d={d} onJump={onJump} />}
              <CommitAiBtns pid={pid} sha={sha} ai={commitAi} />
              {commitAi.run && <AiPanel run={commitAi.run} onClose={commitAi.clear} />}
              <FilesHead files={d.files} />
              <FileRows files={d.files} onOpen={fd.open} />
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function WorktreeSheet({
  pid, changes, onClose,
}: {
  pid: number;
  changes: GitChange[];
  onClose: () => void;
}) {
  const fd = useFileDiff<WtEntry>((e) => wtDiffUrl(pid, e));
  const ai = useGitAi(); // 生成 Commit Message（列表层）
  const fileAi = useGitAi(); // 单文件级（解释 Diff）

  return (
    <Sheet onClose={onClose}>
      {fd.file ? (
        <>
          <div class="gs-head">
            <button class="back" onClick={fd.close}>‹</button>
            <StatusChip code={fd.file.code} />
            <PathText path={fd.file.change.path} oldPath={fd.file.change.oldPath} />
            <button
              class="ai-btn ai-btn-sm"
              disabled={fileAi.run?.loading}
              title="AI 解释此文件改动"
              onClick={() => fileAi.start('解释 Diff', () => aiExplainFile(pid, {
                path: fd.file!.change.path,
                old: fd.file!.change.oldPath,
                untracked: fd.file!.group === '未跟踪',
              }))}
            >
              ✨ 解释
            </button>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          {fileAi.run && <AiPanel run={fileAi.run} onClose={fileAi.clear} />}
          <DiffBody d={fd.diff} error={fd.err} />
        </>
      ) : (
        <>
          <div class="gs-head">
            <span class="gs-subject">未提交改动 · {changes.length} 个文件</span>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          <div class="gs-body">
            {changes.length > 0 && (
              <div class="ai-btns">
                <button
                  class="ai-btn"
                  disabled={ai.run?.loading}
                  onClick={() => ai.start('生成 Commit Message', () => aiCommitMessage(pid))}
                >
                  ✨ 生成 Commit Message
                </button>
              </div>
            )}
            {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
            <WtGroups changes={changes} onOpen={fd.open} />
          </div>
        </>
      )}
    </Sheet>
  );
}

// ---------- 右栏详情（宽屏，VS 风格） ----------

/** 右栏 diff 子列：文件头（状态/路径/AI 解释/收起）+ 内联 AI 面板 + 着色 diff */
function DiffCol({
  code, path, oldPath, diff, error, onClose, explain,
}: {
  code: string;
  path: string;
  oldPath?: string;
  diff: GitDiff | null;
  error?: string;
  onClose: () => void;
  /** 传入则显示单文件级「解释 Diff」按钮（AI 结果内联在本列） */
  explain?: () => Promise<string>;
}) {
  const ai = useGitAi();
  return (
    <div class="gd-diffcol">
      <div class="gd-diffhd">
        <StatusChip code={code} />
        <PathText path={path} oldPath={oldPath} />
        {explain && (
          <button
            class="ai-btn ai-btn-sm"
            disabled={ai.run?.loading}
            title="AI 解释此文件改动"
            onClick={() => ai.start('解释 Diff', explain)}
          >
            ✨ 解释
          </button>
        )}
        <button class="gs-x" title="收起 diff" onClick={onClose}>✕</button>
      </div>
      {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
      {error ? (
        <div class="empty"><span class="err">{error}</span></div>
      ) : (
        <DiffBody d={diff} />
      )}
    </div>
  );
}

/** 提交详情右栏：上=元信息；下=文件列表，点文件 → 列表收窄为侧栏、右侧展开 diff */
export function CommitPanel({
  pid, sha, onJump, reloadToken = 0, mobile = false,
}: {
  pid: number;
  sha: string;
  onJump: (sha: string) => void;
  reloadToken?: number;
  mobile?: boolean;
}) {
  const { d, err } = useCommitDetail(pid, sha, reloadToken);
  const fd = useFileDiff<GitFile>((f) => commitDiffUrl(pid, sha, f), reloadToken);

  if (commitPanelLayout(mobile, fd.file !== null) === 'mobile-diff' && fd.file) {
    return (
      <DiffCol
        code={fd.file.status}
        path={fd.file.path}
        oldPath={fd.file.oldPath}
        diff={fd.diff}
        error={fd.err}
        onClose={fd.close}
        explain={() => aiExplainFile(pid, {
          sha,
          path: fd.file!.path,
          old: fd.file!.oldPath,
        })}
      />
    );
  }

  return (
    <>
      <CommitHead pid={pid} d={d} err={err} sha={sha} onJump={onJump} />
      {!d && !err && <Loading />}
      {d && (
        <div class="gd-body">
          <div class={`gd-files${fd.file ? ' aside' : ''}`}>
            <FilesHead files={d.files} />
            <FileRows files={d.files} selPath={fd.file?.path} onOpen={fd.open} />
          </div>
          {fd.file && (
            <DiffCol
              code={fd.file.status}
              path={fd.file.path}
              oldPath={fd.file.oldPath}
              diff={fd.diff}
              error={fd.err}
              onClose={fd.close}
              explain={() => aiExplainFile(pid, { sha, path: fd.file!.path, old: fd.file!.oldPath })}
            />
          )}
        </div>
      )}
    </>
  );
}

// ---------- 宽屏三栏列（提交记录 | 文件 | Diff） ----------

/** 三栏列样式：flexGrow 取自 colsize 比例（basis 0 → 纯比例分配，吸收分隔条固定宽） */
function colStyle(grow: number) {
  return { flexGrow: grow, flexShrink: 1, flexBasis: 0, minWidth: 0 };
}

/**
 * 选中提交的「文件列（col2：详情头 + 文件列表）+ Diff 列（col3：着色 diff）」。
 * 二者共享文件选中态（useFileDiff）；key=sha 重挂载即重置。中间 boundary=1 分隔条随附。
 */
function CommitCols({
  pid, sha, cols, splitRef, onJump,
}: {
  pid: number;
  sha: string;
  cols: ColSizes;
  splitRef: RefObject<HTMLDivElement>;
  onJump: (sha: string) => void;
}) {
  const { d, err } = useCommitDetail(pid, sha);
  const fd = useFileDiff<GitFile>((f) => commitDiffUrl(pid, sha, f));
  return (
    <>
      <div class="git-col git-col-files" style={colStyle(cols.widths[1])}>
        <CommitHead pid={pid} d={d} err={err} sha={sha} onJump={onJump} />
        {!d && !err && <Loading />}
        {d && (
          <div class="gd-files">
            <FilesHead files={d.files} />
            <FileRows files={d.files} selPath={fd.file?.path} onOpen={fd.open} />
          </div>
        )}
      </div>
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label="文件/Diff 列宽" />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        {fd.file ? (
          <DiffCol
            code={fd.file.status}
            path={fd.file.path}
            oldPath={fd.file.oldPath}
            diff={fd.diff}
            error={fd.err}
            onClose={fd.close}
            explain={() => aiExplainFile(pid, { sha, path: fd.file!.path, old: fd.file!.oldPath })}
          />
        ) : (
          <div class="gd-empty">{d ? '← 选择文件查看 diff' : ''}</div>
        )}
      </div>
    </>
  );
}

/** 工作区改动三栏：分组文件列表（col2）+ diff（col3） */
function WorktreeCols({
  pid, changes, cols, splitRef,
}: {
  pid: number;
  changes: GitChange[];
  cols: ColSizes;
  splitRef: RefObject<HTMLDivElement>;
}) {
  const fd = useFileDiff<WtEntry>((e) => wtDiffUrl(pid, e));
  const ai = useGitAi();
  return (
    <>
      <div class="git-col git-col-files" style={colStyle(cols.widths[1])}>
        <div class="gd-head">
          <div class="gd-headrow">
            <span class="gs-subject">未提交改动 · {changes.length} 个文件</span>
          </div>
          {changes.length > 0 && (
            <div class="ai-btns">
              <button
                class="ai-btn"
                disabled={ai.run?.loading}
                onClick={() => ai.start('生成 Commit Message', () => aiCommitMessage(pid))}
              >
                ✨ 生成 Commit Message
              </button>
            </div>
          )}
        </div>
        {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
        <div class="gd-files">
          {changes.length === 0 ? (
            <div class="gd-empty">工作区干净</div>
          ) : (
            <WtGroups changes={changes} selKey={fd.file ? wtKey(fd.file) : undefined} onOpen={fd.open} />
          )}
        </div>
      </div>
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label="文件/Diff 列宽" />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        {fd.file ? (
          <DiffCol
            code={fd.file.code}
            path={fd.file.change.path}
            oldPath={fd.file.change.oldPath}
            diff={fd.diff}
            error={fd.err}
            onClose={fd.close}
            explain={() => aiExplainFile(pid, {
              path: fd.file!.change.path,
              old: fd.file!.change.oldPath,
              untracked: fd.file!.group === '未跟踪',
            })}
          />
        ) : (
          <div class="gd-empty">← 选择文件查看 diff</div>
        )}
      </div>
    </>
  );
}

/** 未选中时的占位两列 + 分隔条：保持三栏骨架稳定，不因选择跳版 */
function EmptyCols({ cols, splitRef }: { cols: ColSizes; splitRef: RefObject<HTMLDivElement> }) {
  return (
    <>
      <div class="git-col git-col-files" style={colStyle(cols.widths[1])}>
        <div class="gd-empty">← 点选提交 / 未提交改动</div>
      </div>
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label="文件/Diff 列宽" />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        <div class="gd-empty">查看文件 diff</div>
      </div>
    </>
  );
}

// ---------- VSCode 式工作区 ----------

type WorkspaceDispatch = (action: GitWorkspaceAction) => void;

function workspaceDiffUrl(pid: number, file: GitWorkspaceFile): string | null {
  if (file.kind === 'all') return null;
  const q = new URLSearchParams({ path: file.leaf.path });
  if (file.leaf.oldPath) q.set('old', file.leaf.oldPath);
  if (file.kind === 'worktree') {
    if (file.leaf.code === '?') q.set('untracked', '1');
    return `/api/projects/${pid}/git/worktree/diff?${q}`;
  }
  return `/api/projects/${pid}/git/commits/${file.sha}/diff?${q}`;
}

/** 当前工作区文件 diff；内容切换/刷新时重拉，并丢弃迟到响应。 */
function useWorkspaceDiff(
  pid: number,
  state: GitWorkspaceState,
): { diff: GitDiff | null; err: string } {
  const file = state.content?.kind === 'file' ? state.content.file : null;
  const url = file ? workspaceDiffUrl(pid, file) : null;
  const diffKey = requestKey(pid, state.refreshToken, url);
  const [result, setResult] = useState<KeyedResult<GitDiff> | null>(null);
  useEffect(() => {
    let alive = true;
    setResult(null);
    if (!file) return () => { alive = false; };
    if (!url) return () => { alive = false; };
    api<GitDiff>(url)
      .then((result) => {
        if (alive) setResult({ key: diffKey, value: result, error: '' });
      })
      .catch((e: Error) => {
        if (alive) setResult({ key: diffKey, value: null, error: e.message });
      });
    return () => { alive = false; };
  }, [pid, file, state.refreshToken, diffKey, url]);
  const visible = keyedResult(result, diffKey);
  return { diff: visible.value, err: visible.error };
}

function selectedTreeKey(state: GitWorkspaceState): string | undefined {
  if (state.content?.kind !== 'file') return undefined;
  const file = state.content.file;
  return file.kind === 'all' ? file.key : file.leaf.key;
}

type GitMutationKind = Exclude<GitOperationKind, 'generate-message'>;
type GitMutationResult = GitWriteResult | GitCommitResult | GitPushResult;

interface GitOperationsController {
  busy: GitOperationKind | null;
  commitMessage: string;
  setCommitMessage: (message: string) => void;
  hasStaged: boolean;
  hasUnstaged: boolean;
  fileOperations: Record<string, GitFileOperation>;
  write: (
    operation: GitMutationKind,
    body: unknown,
    success: (result: GitMutationResult) => string,
  ) => void;
  generateMessage: () => void;
}

function operationError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/**
 * 页面级 Git 写操作协调器：所有按钮共用同步门闩与忙碌态；成功后统一刷新 GitInfo、
 * 文件树 refreshToken 和提交历史，失败只提示且保留输入。
 */
function useGitOperations(
  pid: number,
  changes: GitChange[],
  onRefresh: () => void,
): GitOperationsController {
  const mountedRef = useRef(true);
  const [, setOperationRevision] = useState(0);
  const [commitState, setCommitState] = useState({ pid, message: '' });
  const coordinatorRef = useRef<GitOperationCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createGitOperationCoordinator(() => {
      if (mountedRef.current) setOperationRevision((revision) => revision + 1);
    });
  }
  const coordinator = coordinatorRef.current;
  const operationToken = coordinator.enter(pid);
  const busy = coordinator.active(pid);
  const commitMessage = commitState.pid === pid ? commitState.message : '';
  const setCommitMessage = (message: string): void => setCommitState({ pid, message });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fileOperations = useMemo(() => deriveGitFileOperations(changes), [changes]);
  const operations = Object.values(fileOperations);
  const hasStaged = operations.some((operation) => operation.staged);
  const hasUnstaged = operations.some((operation) => operation.unstaged);

  const write = (
    operation: GitMutationKind,
    body: unknown,
    success: (result: GitMutationResult) => string,
  ): void => {
    const token = operationToken;
    void coordinator.run(token, operation, async () =>
      requireGitOperationSuccess(
        await api<GitMutationResult>(
          `/api/projects/${token.pid}/git/${operation}`,
          'POST',
          body,
        ),
      ))
      .then((run) => {
        if (!run.started || !mountedRef.current || !coordinator.isCurrent(token)) return;
        toast.success(success(run.value));
        onRefresh();
      })
      .catch((error: unknown) => {
        if (mountedRef.current && coordinator.isCurrent(token)) {
          toast.error(operationError(error));
        }
      });
  };

  const generateMessage = (): void => {
    const token = operationToken;
    void coordinator.run(token, 'generate-message', () => aiCommitMessage(token.pid))
      .then((run) => {
        if (!run.started || !mountedRef.current || !coordinator.isCurrent(token)) return;
        const text = run.value.trim();
        if (!text) throw new Error('AI 未生成可用的提交信息');
        setCommitMessage(text.trim());
        toast.success('已生成提交信息');
      })
      .catch((error: unknown) => {
        if (mountedRef.current && coordinator.isCurrent(token)) {
          toast.error(operationError(error));
        }
      });
  };

  return {
    busy,
    commitMessage,
    setCommitMessage,
    hasStaged,
    hasUnstaged,
    fileOperations,
    write,
    generateMessage,
  };
}

const OPERATION_LABEL: Record<GitOperationKind, string> = {
  stage: '正在暂存…',
  unstage: '正在撤销暂存…',
  commit: '正在提交…',
  push: '正在推送…',
  'generate-message': 'AI 正在生成…',
};

function GitOperationsPanel({
  info,
  operations,
}: {
  info: GitInfo;
  operations: GitOperationsController;
}) {
  const {
    busy,
    commitMessage,
    setCommitMessage,
    hasStaged,
    hasUnstaged,
    write,
    generateMessage,
  } = operations;
  const commit = (): void => {
    const message = commitMessage.trim();
    if (!message || !hasStaged) return;
    write('commit', { message }, (result) => {
      const committed = result as GitCommitResult;
      setCommitMessage('');
      return `已提交 ${committed.short}`;
    });
  };
  const push = (): void => {
    write('push', undefined, (result) => {
      const pushed = result as GitPushResult;
      return pushed.createdUpstream
        ? `已推送并建立 ${pushed.upstream}`
        : `已推送到 ${pushed.upstream}`;
    });
  };

  return (
    <div class="git-ops-panel">
      <div class="git-ops-row">
        <button
          class="btn sm"
          disabled={busy !== null || !hasUnstaged}
          onClick={() => write('stage', { all: true }, () => '已暂存全部改动')}
        >
          ＋ 全部暂存
        </button>
        <button
          class="btn sm"
          disabled={busy !== null || !hasStaged}
          onClick={() => write('unstage', { all: true }, () => '已撤销全部暂存')}
        >
          － 全部撤销暂存
        </button>
        <button
          class="btn sm git-push-btn"
          disabled={busy !== null || !info.branch}
          title={!info.branch ? 'detached HEAD 无法推送当前分支' : '推送当前分支'}
          onClick={push}
        >
          ↑ Push
        </button>
      </div>
      <textarea
        class="git-commit-input"
        rows={2}
        maxLength={20_000}
        disabled={busy !== null}
        value={commitMessage}
        placeholder="填写 commit message…"
        aria-label="Commit message"
        onInput={(event) => setCommitMessage(event.currentTarget.value)}
      />
      <div class="git-ops-row git-commit-actions">
        <button
          class="btn sm"
          disabled={busy !== null || !hasUnstaged && !hasStaged}
          onClick={generateMessage}
        >
          ✨ AI 生成
        </button>
        <span class="git-ops-status mut" role="status" aria-live="polite">
          {busy ? OPERATION_LABEL[busy] : hasStaged ? '可提交已暂存内容' : '请先暂存改动'}
        </span>
        <button
          class="btn sm primary"
          disabled={busy !== null || !hasStaged || !commitMessage.trim()}
          onClick={commit}
        >
          提交
        </button>
      </div>
    </div>
  );
}

function WorkspaceTree({
  pid,
  state,
  info,
  commit,
  commitErr,
  dispatch,
  operations,
}: {
  pid: number;
  state: GitWorkspaceState;
  info: GitInfo;
  commit: GitCommitDetail | null;
  commitErr: string;
  dispatch: WorkspaceDispatch;
  operations: GitOperationsController;
}) {
  const changes = info.changes ?? [];
  const tree = buildGitWorkspaceTree(state.source, {
    worktree: changes,
    commit,
  });
  const selKey = selectedTreeKey(state);
  const selectedPath = state.content?.kind === 'file' && state.content.file.kind === 'all'
    ? state.content.file.path
    : null;

  return (
    <section class="git-tree-pane">
      <div class="git-pane-head git-tree-head">
        <span class="git-pane-title">文件</span>
        <div class="git-source-tabs" role="tablist" aria-label="文件树来源">
          <button
            class={tree.kind === 'all' ? 'on' : ''}
            onClick={() => dispatch({ type: 'show-all' })}
          >
            全部
          </button>
          <button
            class={tree.kind === 'worktree' ? 'on' : ''}
            onClick={() => dispatch({ type: 'show-worktree' })}
          >
            只看改动{(info.dirty ?? 0) > 0 ? ` ${info.dirty}` : ''}
          </button>
        </div>
      </div>
      {tree.kind === 'commit' && (
        <div class="git-tree-context" title={tree.sha}>
          <span>提交改动</span>
          <b class="mono">{tree.sha.slice(0, 8)}</b>
        </div>
      )}
      {tree.kind === 'worktree' && (
        <GitOperationsPanel info={info} operations={operations} />
      )}
      <div class="git-tree-body">
        {tree.kind === 'all' ? (
          <FileTree
            pid={pid}
            selectedPath={selectedPath}
            reloadToken={state.refreshToken}
            onSelectFile={(path) => dispatch({
              type: 'select-file',
              file: { kind: 'all', key: `all:${path}`, path },
            })}
          />
        ) : tree.kind === 'commit' && tree.loading ? (
          commitErr ? <div class="empty">{commitErr}</div> : <Loading />
        ) : tree.leaves.length === 0 ? (
          <div class="empty">
            {tree.kind === 'worktree' ? '工作区干净' : '该提交没有文件改动'}
          </div>
        ) : (
          <ChangeTree
            key={tree.kind === 'commit' ? tree.sha : 'worktree'}
            leaves={tree.leaves}
            selKey={selKey}
            onOpen={(leaf) => dispatch({
              type: 'select-file',
              file: tree.kind === 'commit'
                ? { kind: 'commit', sha: tree.sha, leaf }
                : { kind: 'worktree', leaf },
            })}
            renderActions={tree.kind === 'worktree' ? (leaf) => {
              const operation = operations.fileOperations[leaf.path];
              if (!operation) return null;
              return (
                <>
                  {operation.unstaged && (
                    <button
                      class="git-file-op"
                      disabled={operations.busy !== null}
                      title={`暂存 ${leaf.path}`}
                      aria-label={`暂存 ${leaf.path}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        operations.write(
                          'stage',
                          { paths: operation.paths },
                          () => `已暂存 ${leaf.path}`,
                        );
                      }}
                    >
                      ＋
                    </button>
                  )}
                  {operation.staged && (
                    <button
                      class="git-file-op"
                      disabled={operations.busy !== null}
                      title={`撤销暂存 ${leaf.path}`}
                      aria-label={`撤销暂存 ${leaf.path}`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        operations.write(
                          'unstage',
                          { paths: operation.paths },
                          () => `已撤销暂存 ${leaf.path}`,
                        );
                      }}
                    >
                      －
                    </button>
                  )}
                </>
              );
            } : undefined}
          />
        )}
      </div>
    </section>
  );
}

function CommitHistory({
  commits,
  selectedSha,
  open,
  rowsRef,
  onToggle,
  dispatch,
}: {
  commits: GitCommit[];
  selectedSha: string | null;
  open: boolean;
  rowsRef: RefObject<HTMLDivElement>;
  onToggle: () => void;
  dispatch: WorkspaceDispatch;
}) {
  const layout = useMemo(
    () => layoutGraph(commits.map((c) => ({ sha: c.sha, parents: c.parents }))),
    [commits],
  );
  const laneOf = useMemo(
    () => new Map(layout.nodes.map((n) => [n.sha, n.lane])),
    [layout],
  );
  const graphW = PAD_X * 2 + Math.max(1, layout.maxLanes) * LANE_W;
  const svgH = commits.length * ROW_H + 4;
  const headSha = commits.find((c) =>
    c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))?.sha;

  return (
    <section class={`git-history-pane${open ? '' : ' collapsed'}`}>
      <button
        class="git-pane-head git-history-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span class={`ft-arrow${open ? ' open' : ''}`}>▸</span>
        <span class="git-pane-title">提交记录</span>
        <span class="mut small">{commits.length}</span>
      </button>
      {open && (
        <div class="git-history-scroll">
          {commits.length === 0 && <div class="empty">（还没有提交）</div>}
          {commits.length > 0 && (
            <div class="git-rows" ref={rowsRef} style={{ minWidth: graphW + 286 }}>
              <svg class="git-svg" width={graphW} height={svgH}>
                {layout.edges.map((e) => (
                  <path
                    d={edgePath(e, commits.length)}
                    fill="none"
                    stroke={laneColor(e.lane)}
                    strokeWidth={2}
                    strokeLinecap="round"
                    opacity={e.missing ? 0.3 : 0.85}
                  />
                ))}
                {layout.nodes.map((n) => {
                  const isMerge = (commits[n.row]?.parents.length ?? 0) > 1;
                  const color = laneColor(n.lane);
                  return (
                    <>
                      {n.sha === headSha && (
                        <circle
                          cx={cx(n.lane)}
                          cy={cy(n.row)}
                          r={7.5}
                          fill="none"
                          stroke={color}
                          strokeWidth={1.5}
                          opacity={0.55}
                        />
                      )}
                      <circle
                        cx={cx(n.lane)}
                        cy={cy(n.row)}
                        r={isMerge ? 3.6 : 4.4}
                        fill={isMerge ? 'var(--bg)' : color}
                        stroke={color}
                        strokeWidth={isMerge ? 2 : 0}
                      />
                    </>
                  );
                })}
              </svg>
              {commits.map((c) => (
                <div
                  class={`git-row${selectedSha === c.sha ? ' on' : ''}`}
                  data-sha={c.sha}
                  role="button"
                  tabIndex={0}
                  style={{ paddingLeft: graphW + 6 }}
                  onClick={() => dispatch({ type: 'select-commit', sha: c.sha })}
                  onKeyDown={(ev) => {
                    if (ev.target !== ev.currentTarget) return;
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      dispatch({ type: 'select-commit', sha: c.sha });
                    }
                  }}
                >
                  <div class="git-r1">
                    <RefBadges refs={c.refs} />
                    <span class="git-subj">{c.subject}</span>
                    <button
                      class="git-commit-detail"
                      title="查看完整 commit message"
                      onClick={(ev) => {
                        ev.stopPropagation();
                        dispatch({ type: 'open-commit-detail', sha: c.sha });
                      }}
                    >
                      查看详情
                    </button>
                  </div>
                  <div class="git-r2 mut">
                    <span class="mono" style={{ color: laneColor(laneOf.get(c.sha) ?? 0) }}>
                      {c.short}
                    </span>
                    <span>{c.author}</span>
                    <span>{timeAgo(c.ts)}</span>
                  </div>
                </div>
              ))}
              {commits.length >= 200 && (
                <div class="mut small" style={{ padding: '10px 12px 16px' }}>
                  只展示最近 200 条提交
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function WorkspaceContext({
  pid,
  state,
  dispatch,
  onJump,
  mobile = false,
}: {
  pid: number;
  state: GitWorkspaceState;
  dispatch: WorkspaceDispatch;
  onJump: (sha: string) => void;
  mobile?: boolean;
}) {
  const { diff, err } = useWorkspaceDiff(pid, state);
  const content = state.content;
  if (!content) {
    return <div class="gd-empty">← 选择文件查看内容，或查看 commit 详情</div>;
  }
  if (content.kind === 'commit-detail') {
    return (
      <CommitPanel
        key={content.sha}
        pid={pid}
        sha={content.sha}
        reloadToken={state.refreshToken}
        onJump={onJump}
        mobile={mobile}
      />
    );
  }

  const file = content.file;
  if (file.kind === 'all') {
    return (
      <FileViewer
        key={`${file.path}:${state.refreshToken}`}
        pid={pid}
        path={file.path}
      />
    );
  }
  const leaf = file.leaf;
  return (
    <DiffCol
      code={leaf.code}
      path={leaf.path}
      oldPath={leaf.oldPath}
      diff={diff}
      error={err}
      onClose={() => dispatch({ type: 'close-content' })}
      explain={() => aiExplainFile(pid, file.kind === 'commit'
        ? { sha: file.sha, path: leaf.path, old: leaf.oldPath }
        : {
            path: leaf.path,
            old: leaf.oldPath,
            untracked: leaf.code === '?',
          })}
    />
  );
}

function WorkspaceNavigator({
  pid,
  state,
  info,
  commit,
  commitErr,
  commits,
  historyOpen,
  rowsRef,
  dispatch,
  onToggleHistory,
  operations,
}: {
  pid: number;
  state: GitWorkspaceState;
  info: GitInfo;
  commit: GitCommitDetail | null;
  commitErr: string;
  commits: GitCommit[];
  historyOpen: boolean;
  rowsRef: RefObject<HTMLDivElement>;
  dispatch: WorkspaceDispatch;
  onToggleHistory: () => void;
  operations: GitOperationsController;
}) {
  return (
    <div class="git-nav">
      <WorkspaceTree
        pid={pid}
        state={state}
        info={info}
        commit={commit}
        commitErr={commitErr}
        dispatch={dispatch}
        operations={operations}
      />
      <CommitHistory
        commits={commits}
        selectedSha={state.source.kind === 'commit' ? state.source.sha : null}
        open={historyOpen}
        rowsRef={rowsRef}
        onToggle={onToggleHistory}
        dispatch={dispatch}
      />
    </div>
  );
}

// ---------- 主视图 ----------

export function GitView({ pid }: { pid: number }) {
  const [projectResult, setProjectResult] = useState<{
    pid: number;
    value: Project;
  } | null>(null);
  const [gitResult, setGitResult] = useState(() => createGitLoadState<GitInfo>(pid));
  const [workspace, dispatch] = useReducer(gitWorkspaceReducer, createGitWorkspaceState());
  const [historyOpen, setHistoryOpen] = useState(true);
  const wide = useWide();
  const treeW = useTreeWidth();
  const rowsRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const gitLoadSeq = useRef(0);
  const project = projectResult?.pid === pid ? projectResult.value : null;
  const info = gitResult.pid === pid ? gitResult.value : null;
  const err = gitResult.pid === pid ? gitResult.error : '';

  useEffect(() => {
    let alive = true;
    api<Project>(`/api/projects/${pid}`)
      .then((value) => {
        if (alive) setProjectResult({ pid, value });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [pid]);

  const load = (clear = true): void => {
    const request = ++gitLoadSeq.current;
    setGitResult((prev) => beginGitLoad(prev, pid, request, !clear));
    api<GitInfo>(`/api/projects/${pid}/git`)
      .then((result) => {
        setGitResult((prev) => completeGitLoad(prev, pid, request, result));
      })
      .catch((e: Error) => {
        setGitResult((prev) => failGitLoad(prev, pid, request, e.message));
      });
  };

  useEffect(() => {
    dispatch({ type: 'reset' });
    setHistoryOpen(true);
    load();
    return () => { gitLoadSeq.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const commits: GitCommit[] = info?.ok ? (info.commits ?? []) : [];
  const selectedCommitSha = workspace.source.kind === 'commit' ? workspace.source.sha : null;
  const commit = useCommitDetail(pid, selectedCommitSha, workspace.refreshToken);

  const jump = (sha: string): void => {
    if (!commits.some((c) => c.sha === sha)) {
      toast.info('该提交不在最近 200 条窗口内');
      return;
    }
    dispatch({ type: 'open-commit-detail', sha });
    setHistoryOpen(true);
    requestAnimationFrame(() => {
      rowsRef.current
        ?.querySelector(`[data-sha="${sha}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  };

  const refresh = (): void => {
    dispatch({ type: 'refresh' });
    load(false);
  };
  const operations = useGitOperations(
    pid,
    info?.ok ? (info.changes ?? []) : [],
    refresh,
  );
  const behindAhead = info?.ok && info.upstream
    ? `${info.upstream} ↑${info.ahead ?? 0} ↓${info.behind ?? 0}`
    : '';
  const drilling = !wide && workspace.content !== null;

  return (
    <div class="fullcol">
      <div class="bhead">
        <div class="bhead-row">
          <button
            class="back"
            aria-label={drilling ? '返回 Git 工作区' : '返回项目'}
            onClick={() => drilling
              ? dispatch({ type: 'close-content' })
              : nav(`/p/${pid}`)}
          >
            ‹
          </button>
          <span class="btitle">{project?.name ?? `项目 #${pid}`} · Git</span>
          <div class="bacts">
            {info?.ok && (
              <span class="gitstat">
                <span class="badge b-blue">⎇ {info.branch || '(detached)'}</span>
                {behindAhead && (
                  <span class={`badge ${(info.ahead ?? 0) + (info.behind ?? 0) > 0 ? 'b-purple' : 'b-gray'}`}>
                    {behindAhead}
                  </span>
                )}
              </span>
            )}
            <button class="btn sm" onClick={refresh}>↻ 刷新</button>
          </div>
        </div>
        {err && <div class="err">{err}</div>}
      </div>

      {info === null && !err && <Loading />}
      {info !== null && !info.ok && (
        <div class="empty">
          {info.error ?? '加载失败'}
          <div class="mut small">{info.cwd}</div>
        </div>
      )}

      {info?.ok && drilling && (
        <div class="git-mobile-content">
          <WorkspaceContext
            pid={pid}
            state={workspace}
            dispatch={dispatch}
            onJump={jump}
            mobile
          />
        </div>
      )}
      {info?.ok && !drilling && !wide && (
        <WorkspaceNavigator
          pid={pid}
          state={workspace}
          info={info}
          commit={commit.d}
          commitErr={commit.err}
          commits={commits}
          historyOpen={historyOpen}
          rowsRef={rowsRef}
          dispatch={dispatch}
          onToggleHistory={() => setHistoryOpen((open) => !open)}
          operations={operations}
        />
      )}
      {info?.ok && wide && (
        <div class="git-workspace" ref={splitRef}>
          <div
            class="git-nav-wrap"
            style={treeW.width != null ? { width: treeW.width, maxWidth: treeW.width } : undefined}
          >
            <WorkspaceNavigator
              pid={pid}
              state={workspace}
              info={info}
              commit={commit.d}
              commitErr={commit.err}
              commits={commits}
              historyOpen={historyOpen}
              rowsRef={rowsRef}
              dispatch={dispatch}
              onToggleHistory={() => setHistoryOpen((open) => !open)}
              operations={operations}
            />
          </div>
          <ListSplitter containerRef={splitRef} list={treeW} label="Git 导航栏宽" />
          <main class="git-context">
            <WorkspaceContext pid={pid} state={workspace} dispatch={dispatch} onJump={jump} />
          </main>
        </div>
      )}
    </div>
  );
}

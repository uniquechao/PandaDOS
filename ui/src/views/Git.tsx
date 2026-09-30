/**
 * Git 共用视图组件（#388 起页面主体迁到 views/Workspace.tsx 的统一工作区；这里保留
 * diff / 提交详情 / 提交图绘制等被工作区与 issue 详情共用的部件）。原 Git 页说明：
 * VSCode 式「左侧树 + 提交历史 | 右侧上下文」：
 *   顶栏：分支 / 上游 ↑↓ / 刷新；
 *   左上：完整文件 / 当前未提交 / 指定 commit 三来源统一文件树；
 *   左下：可折叠 lane 提交图，点行切换树，独立「查看详情」打开完整 commit message；
 *   右侧：完整文件用 FileViewer，改动文件用 diff，提交详情复用 CommitPanel；
 *   H5：导航保持上树下历史，点内容后在剩余区域全屏钻入。
 */
import type { ComponentChildren, RefObject } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import type { ColSizes } from '../lib/colsize';
import { fmtTime, timeAgo } from '../lib/fmt';
import {
  aiCommitMessage, aiCommitRisk, aiExplainCommit, aiExplainFile, aiSummarizeCommit,
} from '../lib/gitai';
import type { GraphEdge } from '../lib/gitgraph';
import { commitPanelLayout } from '../lib/gitviewstate';
import { toast } from '../lib/toast';
import type { GitChange, GitCommitDetail, GitDiff, GitFile } from '../lib/types';
import { Loading } from '../components/Loaders';
import {
  GitImagePreview,
  gitImageUrls,
  type GitImageUrls,
} from '../components/GitImagePreview';
import { Splitter } from '../components/Splitter';
import { tr } from '../i18n/runtime';
import { isImagePath } from '../lib/preview';

// ---------- 绘图常量 ----------

export const ROW_H = 42;
export const LANE_W = 14;
export const PAD_X = 9;

/** 泳道配色（奶油亮底高辨识，首位用品牌橙黄） */
const LANE_COLORS = [
  '#f59e0b', '#8b5cf6', '#16a34a', '#e8590c', '#db2777',
  '#0891b2', '#2563eb', '#65a30d', '#dc2626', '#b45309',
];
export const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!;

export const cx = (lane: number): number => PAD_X + lane * LANE_W + LANE_W / 2;
export const cy = (row: number): number => row * ROW_H + ROW_H / 2;

/** 两端竖直切线的 S 曲线（换道连接） */
function sCurve(xa: number, ya: number, xb: number, yb: number): string {
  const ym = (ya + yb) / 2;
  return `C ${xa} ${ym}, ${xb} ${ym}, ${xb} ${yb}`;
}

/** 子→父连线路径：出发端/汇入端换道各占一行行高，中段沿泳道竖直 */
export function edgePath(e: GraphEdge, rows: number): string {
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

const FILE_STATUS: Record<string, { key: Parameters<typeof tr>[0]; cls: string }> = {
  A: { key: 'git.added', cls: 'fs-a' },
  M: { key: 'git.modified', cls: 'fs-m' },
  D: { key: 'git.deleted', cls: 'fs-d' },
  R: { key: 'git.renamed', cls: 'fs-r' },
  C: { key: 'git.copied', cls: 'fs-r' },
  T: { key: 'git.typeChanged', cls: 'fs-m' },
  U: { key: 'git.conflict', cls: 'fs-d' },
  '?': { key: 'git.untracked', cls: 'fs-u' },
};

export function StatusChip({ code }: { code: string }) {
  const st = FILE_STATUS[code[0] ?? ''];
  const label = st ? tr(st.key) : code;
  return (
    <span class={`fschip ${st?.cls ?? 'fs-m'}`} title={label}>
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
  if (adds === null || dels === null) return <span class="gf-bin">{tr('git.binary')}</span>;
  return (
    <span class="gf-pm mono">
      {adds ? <em class="d-add">+{adds}</em> : null}
      {dels ? <em class="d-del">−{dels}</em> : null}
      {!adds && !dels ? <em class="gf-dir">±0</em> : null}
    </span>
  );
}

export function copyText(s: string, hint: string): void {
  navigator.clipboard
    ?.writeText(s)
    .then(() => toast.success(tr('git.copiedHint', { hint })))
    .catch(() => toast.error(tr('git.copyFailed')));
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
export function useGitAi(): {
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
        if (seq.current === my) setRun({ label, loading: false, error: e.message || tr('git.aiFailed') });
      });
  };
  const clear = (): void => {
    seq.current++;
    setRun(null);
  };
  return { run, start, clear };
}

/** 内联可折叠 AI 结果面板：loading / 错误 / 文本结果 + 复制。默认展开。 */
export function AiPanel({ run, onClose }: { run: AiRun; onClose: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div class="ai-panel">
      <div class="ai-panel-hd">
        <button class="gd-collapse" title={open ? tr('git.collapse') : tr('git.expand')} onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'}
        </button>
        <span class="ai-panel-title">🤖 {run.label}</span>
        {run.loading && <span class="ai-panel-status mut">{tr('git.generating')}</span>}
        {!run.loading && run.text && (
          <button class="ai-copy" title={tr('git.copyResult')} onClick={() => copyText(run.text!, ' AI result')}>
            {tr('ui.copy')}
          </button>
        )}
        <button class="gs-x" title={tr('git.close')} onClick={onClose}>✕</button>
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
      <button class="ai-btn" disabled={busy} onClick={() => ai.start(tr('git.summarizeCommit'), () => aiSummarizeCommit(pid, sha))}>
        ✨ {tr('git.summarizeCommit')}
      </button>
      <button class="ai-btn" disabled={busy} onClick={() => ai.start(tr('git.identifyRisk'), () => aiCommitRisk(pid, sha))}>
        ⚠ {tr('git.identifyRisk')}
      </button>
      <button class="ai-btn" disabled={busy} onClick={() => ai.start(tr('git.explainDiff'), () => aiExplainCommit(pid, sha))}>
        🔍 {tr('git.explainWholeDiff')}
      </button>
    </div>
  );
}

// ---------- diff 视图（着色 unified diff） ----------

const DIFF_MAX_LINES = 4000;

export function diffLineCls(l: string): string {
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
  if (!d.diff.trim()) return <div class="empty">{tr('git.noDiff')}</div>;
  const lines = d.diff.split('\n');
  const shown = lines.slice(0, DIFF_MAX_LINES);
  return (
    <pre class="gs-diff mono">
      {shown.map((l) => (
        <div class={diffLineCls(l)}>{l || ' '}</div>
      ))}
      {(lines.length > DIFF_MAX_LINES || d.truncated) && (
        <div class="dl dh">{tr('git.diffTooLong')}</div>
      )}
    </pre>
  );
}

/** 图片改动走原图预览，其余文件保持 unified diff；供 Git 页和 issue 改动页共用。 */
export function DiffContent({
  code,
  path,
  oldPath,
  imageUrls,
  d,
  error,
}: {
  code: string;
  path: string;
  oldPath?: string;
  imageUrls: GitImageUrls;
  d: GitDiff | null;
  error?: string;
}) {
  if (isImagePath(path) || (oldPath ? isImagePath(oldPath) : false)) {
    return <GitImagePreview path={path} oldPath={oldPath} urls={imageUrls} />;
  }
  return <DiffBody d={d} error={error} />;
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

export function commitImageUrls(pid: number, sha: string, f: GitFile): GitImageUrls {
  return gitImageUrls(
    `/api/projects/${pid}/git/commits/${sha}/raw`,
    f.path,
    f.oldPath,
    f.status,
  );
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
          <span class="gs-k">{tr('git.author')}</span>
          <b>{d.author}</b> <span class="mut">&lt;{d.authorEmail}&gt;</span>
          <span class="mut"> · {fmtTime(d.authorTs)}（{timeAgo(d.authorTs)}）</span>
        </div>
        {(d.committer !== d.author || d.commitTs !== d.authorTs) && (
          <div>
            <span class="gs-k">{tr('git.committer')}</span>
            <b>{d.committer}</b>
            <span class="mut"> · {fmtTime(d.commitTs)}（{timeAgo(d.commitTs)}）</span>
          </div>
        )}
        {d.parents.length > 0 && (
          <div>
            <span class="gs-k">{tr('git.parentCommit')}</span>
            {d.parents.map((p) => (
              <button class="gs-parent mono" onClick={() => onJump(p)}>
                {p.slice(0, 8)}
              </button>
            ))}
            {d.parents.length > 1 && <span class="mut"> ({tr('git.merge')})</span>}
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
            title={open ? tr('git.collapseDetails') : tr('git.expandDetails')}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▾' : '▸'}
          </button>
          <span
            class="gs-sha mono"
            title={tr('git.copySha')}
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
      {tr('git.fileCount', { count: files.length })}
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
      {files.length === 0 && <div class="mut small">{tr('git.noFileChanges')}</div>}
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
  group: 'staged' | 'unstaged' | 'untracked';
  code: string;
}

const WT_GROUP_KEYS: Record<WtEntry['group'], Parameters<typeof tr>[0]> = {
  staged: 'git.staged',
  unstaged: 'git.unstaged',
  untracked: 'git.untrackedGroup',
};

/** porcelain 两列码 → 按暂存区/工作区拆组（同一文件可同时出现在两组） */
function groupChanges(changes: GitChange[]): WtEntry[] {
  const out: WtEntry[] = [];
  for (const c of changes) {
    const x = c.status[0] ?? ' ';
    const y = c.status[1] ?? ' ';
    if (c.status === '??') {
      out.push({ change: c, group: 'untracked', code: '?' });
      continue;
    }
    if (x !== ' ') out.push({ change: c, group: 'staged', code: x });
    if (y !== ' ') out.push({ change: c, group: 'unstaged', code: y });
  }
  return out;
}

/** 稳定选中键：entries 每次渲染重建，靠 组+路径 匹配高亮 */
export const wtKey = (e: WtEntry): string => `${e.group}:${e.change.path}`;

export function wtDiffUrl(pid: number, e: WtEntry): string {
  const q = new URLSearchParams({ path: e.change.path });
  if (e.change.oldPath) q.set('old', e.change.oldPath);
  if (e.group === 'untracked') q.set('untracked', '1');
  return `/api/projects/${pid}/git/worktree/diff?${q}`;
}

export function wtImageUrls(pid: number, e: WtEntry): GitImageUrls {
  return gitImageUrls(
    `/api/projects/${pid}/git/worktree/raw`,
    e.change.path,
    e.change.oldPath,
    e.code,
  );
}

export function WtGroups({
  changes, selKey, onOpen,
}: {
  changes: GitChange[];
  selKey?: string;
  onOpen: (e: WtEntry) => void;
}) {
  const entries = groupChanges(changes);
  const groups = (['staged', 'unstaged', 'untracked'] as const)
    .map((g) => ({ g, items: entries.filter((e) => e.group === g) }))
    .filter((x) => x.items.length > 0);
  return (
    <>
      {groups.map(({ g, items }) => (
        <div class="gs-group">
          <div class="gs-fhead">{tr(WT_GROUP_KEYS[g])} · {items.length}</div>
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
              title={tr('git.explainFile')}
              onClick={() => fileAi.start(tr('git.explainDiff'), () =>
                aiExplainFile(pid, { sha, path: fd.file!.path, old: fd.file!.oldPath }))}
            >
              ✨ {tr('git.explain')}
            </button>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          {fileAi.run && <AiPanel run={fileAi.run} onClose={fileAi.clear} />}
          <DiffContent
            code={fd.file.status}
            path={fd.file.path}
            oldPath={fd.file.oldPath}
            imageUrls={commitImageUrls(pid, sha, fd.file)}
            d={fd.diff}
            error={fd.err}
          />
        </>
      ) : (
        <>
          <div class="gs-head">
            <span
              class="gs-sha mono"
              title={tr('git.copySha')}
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
                {openMeta ? `▾ ${tr('git.collapseDetails')}` : `▸ ${tr('git.expandDetails')}`}
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
              title={tr('git.explainFile')}
              onClick={() => fileAi.start(tr('git.explainDiff'), () => aiExplainFile(pid, {
                path: fd.file!.change.path,
                old: fd.file!.change.oldPath,
                untracked: fd.file!.group === 'untracked',
              }))}
            >
              ✨ {tr('git.explain')}
            </button>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          {fileAi.run && <AiPanel run={fileAi.run} onClose={fileAi.clear} />}
          <DiffContent
            code={fd.file.code}
            path={fd.file.change.path}
            oldPath={fd.file.change.oldPath}
            imageUrls={wtImageUrls(pid, fd.file)}
            d={fd.diff}
            error={fd.err}
          />
        </>
      ) : (
        <>
          <div class="gs-head">
            <span class="gs-subject">{tr('git.uncommittedCount', { count: changes.length })}</span>
            <button class="gs-x" onClick={onClose}>✕</button>
          </div>
          <div class="gs-body">
            {changes.length > 0 && (
              <div class="ai-btns">
                <button
                  class="ai-btn"
                  disabled={ai.run?.loading}
                  onClick={() => ai.start(tr('git.generateMessage'), () => aiCommitMessage(pid))}
                >
                  ✨ {tr('git.generateMessage')}
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
export function DiffCol({
  code, path, oldPath, imageUrls, diff, error, onClose, explain,
}: {
  code: string;
  path: string;
  oldPath?: string;
  imageUrls: GitImageUrls;
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
            title={tr('git.explainFile')}
            onClick={() => ai.start(tr('git.explainDiff'), explain)}
          >
            ✨ {tr('git.explain')}
          </button>
        )}
        <button class="gs-x" title={tr('git.collapseDiff')} onClick={onClose}>✕</button>
      </div>
      {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
      <DiffContent
        code={code}
        path={path}
        oldPath={oldPath}
        imageUrls={imageUrls}
        d={diff}
        error={error}
      />
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
        imageUrls={commitImageUrls(pid, sha, fd.file)}
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
              imageUrls={commitImageUrls(pid, sha, fd.file)}
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
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label={tr('git.fileDiffWidth')} />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        {fd.file ? (
          <DiffCol
            code={fd.file.status}
            path={fd.file.path}
            oldPath={fd.file.oldPath}
            imageUrls={commitImageUrls(pid, sha, fd.file)}
            diff={fd.diff}
            error={fd.err}
            onClose={fd.close}
            explain={() => aiExplainFile(pid, { sha, path: fd.file!.path, old: fd.file!.oldPath })}
          />
        ) : (
          <div class="gd-empty">{d ? tr('git.chooseFileDiff') : ''}</div>
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
            <span class="gs-subject">{tr('git.uncommittedCount', { count: changes.length })}</span>
          </div>
          {changes.length > 0 && (
            <div class="ai-btns">
              <button
                class="ai-btn"
                disabled={ai.run?.loading}
                onClick={() => ai.start(tr('git.generateMessage'), () => aiCommitMessage(pid))}
              >
                ✨ {tr('git.generateMessage')}
              </button>
            </div>
          )}
        </div>
        {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
        <div class="gd-files">
          {changes.length === 0 ? (
            <div class="gd-empty">{tr('git.clean')}</div>
          ) : (
            <WtGroups changes={changes} selKey={fd.file ? wtKey(fd.file) : undefined} onOpen={fd.open} />
          )}
        </div>
      </div>
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label={tr('git.fileDiffWidth')} />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        {fd.file ? (
          <DiffCol
            code={fd.file.code}
            path={fd.file.change.path}
            oldPath={fd.file.change.oldPath}
            imageUrls={wtImageUrls(pid, fd.file)}
            diff={fd.diff}
            error={fd.err}
            onClose={fd.close}
            explain={() => aiExplainFile(pid, {
              path: fd.file!.change.path,
              old: fd.file!.change.oldPath,
              untracked: fd.file!.group === 'untracked',
            })}
          />
        ) : (
          <div class="gd-empty">{tr('git.chooseFileDiff')}</div>
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
        <div class="gd-empty">{tr('git.chooseCommit')}</div>
      </div>
      <Splitter containerRef={splitRef} cols={cols} boundary={1} label={tr('git.fileDiffWidth')} />
      <div class="git-col git-col-diff" style={colStyle(cols.widths[2])}>
        <div class="gd-empty">{tr('git.viewFileDiff')}</div>
      </div>
    </>
  );
}

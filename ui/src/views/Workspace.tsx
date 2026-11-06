/**
 * 工作区（issue #388）—— 项目「文件」与「Git」合一的单一入口 `#/p/:pid/workspace`。
 *
 * 信息架构（docs/workspace-interaction-design-2026-09-23.md）：
 *   顶栏：项目名 / 工作区 · [工作位置 ▾] [分支 ▾] [同步状态] [获取远端] [拉取] [推送] [⋯]
 *   左侧导航（宽度可拖拽、整栏可收起）：
 *     上：[全部文件][当前改动] + 路径栏/筛选/搜索/新建/上传 + 文件树或改动树（可收起）；
 *     下：提交历史（可筛选、可收起），上下分区高度可拖拽；点提交行 → 上方切成该提交的改动树，
 *         行内「详情」→ 右侧完整提交信息；
 *   内容区：文件内容 / 预览 / 编辑、diff（按块暂存/取消/撤销）、提交详情。
 *   手机：顶部项目名 + 工作位置与分支；下一行「全部文件 / 当前改动 / 历史」；列表逐层钻入，内容全屏，
 *         底部固定「复制路径 / 编辑·预览 / 更多」；Git 同步、分支、worktree 从顶部面板进入。
 *
 * 状态：选择模型沿用 lib/gitworkspace 的 reducer（来源 all/worktree/commit + 右侧内容）；
 * 改动叶子的 key 带分组（`worktree:<group>:<path>`），同一文件的暂存/未暂存可分别查看 diff。
 * 每次选择同步到深链（lib/workspaceRoute，replace 不刷历史）；外部改 hash（对话里的文件链接）再落回状态。
 * 视图以 key=pid 挂载：切项目 / 工作位置即整页重建，旧项目的迟到响应不会落进新页面。
 * 未保存保护：切文件、切来源、切工作位置、返回项目前都经 guard()，全局导航经 router 的离开守卫，给出保存 / 放弃 / 继续编辑。
 * 多 worktree = 多个关联项目：工作位置面板只做页面导航，绝不修改任何项目的 cwd。
 */
import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { api, uploadWithProgress } from '../lib/api';
import { fmtSize, timeAgo } from '../lib/fmt';
import { aiCommitMessage, aiExplainFile } from '../lib/gitai';
import { layoutGraph } from '../lib/gitgraph';
import {
  buildGitWorkspaceTree,
  createGitWorkspaceState,
  gitWorkspaceReducer,
  type GitWorkspaceAction,
  type GitWorkspaceFile,
  type GitWorkspaceState,
} from '../lib/gitworkspace';
import { deriveGitFileOperations, directoryStagePaths, writeGitPathBatches } from '../lib/gitoperations';
import {
  beginGitLoad,
  completeGitLoad,
  createGitLoadState,
  failGitLoad,
  keyedResult,
  requestKey,
  type KeyedResult,
} from '../lib/gitviewstate';
import type { ChangeLeaf } from '../lib/changetree';
import { joinChildPath, treeIcon } from '../lib/filetree';
import { nav, setLeaveGuard } from '../lib/router';
import { toast } from '../lib/toast';
import { useTreeWidth } from '../lib/treewidth';
import { useWide } from '../lib/useWide';
import { normalizeRel, sameLoc, workspacePath, type ChangeGroup, type WorkspaceLoc } from '../lib/workspaceRoute';
import { resolveWorkspacePath } from '../lib/workspacePathLookup';
import type { CopyTarget } from '../lib/pathcopy';
import type {
  CheckoutBlocker, CheckoutCheck, FsEntry, FsList, FsSearchResult, FsStat, FsUploadResult,
  GitBranches, GitChange, GitCommit, GitCommitResult, GitDiff, GitInfo,
  GitPushResult, Project, PullPreview, WorktreeInfo, WorktreeList,
} from '../lib/types';
import { Loading } from '../components/Loaders';
import { ChangeTree } from '../components/ChangeTree';
import { FileTree, GitMark, type TreeRowTarget } from '../components/FileTree';
import { FileViewer, type FileViewerHandle } from '../components/FileViewer';
import { gitImageUrls, type GitImageUrls } from '../components/GitImagePreview';
import { ListSplitter } from '../components/ListSplitter';
import { Modal } from '../components/Modal';
import { ActionMenu, type MenuAnchor, type MenuItem } from '../components/ActionMenu';
import { CopyFallback, CopyPathButton, copyMenuItems, type ExecutorLabel } from '../components/CopyPathButton';
import { tr } from '../i18n/runtime';
import { isImagePath } from '../lib/preview';
import {
  AiPanel, CommitPanel, DiffCol, DiffContent, LANE_W, PAD_X, ROW_H, RefBadges, StatusChip, PathText,
  cx, cy, diffLineCls, edgePath, laneColor, useCommitDetail, useGitAi,
} from './Git';

type Dispatch = (action: GitWorkspaceAction) => void;
type MobileTab = 'files' | 'changes' | 'history';

// ---------- 纯工具 ----------

/** 改动分组：冲突优先，其次暂存/未暂存（同一文件可同时出现在两组），未跟踪单独 */
export function groupWorktree(changes: GitChange[]): Array<{ group: ChangeGroup; leaves: ChangeLeaf[] }> {
  const buckets: Record<ChangeGroup, ChangeLeaf[]> = { conflict: [], staged: [], unstaged: [], untracked: [] };
  for (const c of changes) {
    const x = c.status[0] ?? ' ';
    const y = c.status[1] ?? ' ';
    const leaf = (group: ChangeGroup, code: string): ChangeLeaf => ({
      key: `worktree:${group}:${c.path}`,
      path: c.path,
      code,
      ...(c.oldPath ? { oldPath: c.oldPath } : {}),
    });
    if (c.status === '??') buckets.untracked.push(leaf('untracked', '?'));
    else if (x === 'U' || y === 'U' || c.status === 'AA' || c.status === 'DD') buckets.conflict.push(leaf('conflict', 'U'));
    else {
      if (x !== ' ') buckets.staged.push(leaf('staged', x));
      if (y !== ' ') buckets.unstaged.push(leaf('unstaged', y));
    }
  }
  return (['conflict', 'staged', 'unstaged', 'untracked'] as const)
    .map((group) => ({ group, leaves: buckets[group] }))
    .filter((g) => g.leaves.length > 0);
}

export function leafGroup(leaf: ChangeLeaf): ChangeGroup {
  const g = leaf.key.split(':')[1];
  return g === 'conflict' || g === 'staged' || g === 'untracked' ? g : 'unstaged';
}

function parentOf(p: string): string {
  const s = p.replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : '';
}

/** 路径 a 是否等于 b 或位于目录 b 之内 */
function within(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`);
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const GROUP_LABEL: Record<ChangeGroup, Parameters<typeof tr>[0]> = {
  conflict: 'ws.groupConflict',
  staged: 'git.staged',
  unstaged: 'git.unstaged',
  untracked: 'git.untrackedGroup',
};

// ---------- 上下分区（树 | 历史）高度拖拽，本地记忆 ----------

const VSPLIT_KEY = 'panda.wsTreeRatio';
export function clampRatio(v: number): number {
  return Math.min(0.85, Math.max(0.2, v));
}
function readRatio(): number {
  try {
    const v = Number(localStorage.getItem(VSPLIT_KEY));
    return Number.isFinite(v) && v > 0 ? clampRatio(v) : 0.6;
  } catch {
    return 0.6;
  }
}

function HSplitter({ containerRef, ratio, setRatio }: {
  containerRef: { current: HTMLElement | null };
  ratio: number;
  setRatio: (r: number) => void;
}) {
  const [active, setActive] = useState(false);
  const save = (r: number): void => {
    setRatio(r);
    try { localStorage.setItem(VSPLIT_KEY, String(r)); } catch { /* 隐私模式 */ }
  };
  return (
    <div
      class={`ws-hsplit${active ? ' on' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label={tr('ws.resizeTreeHistory')}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={20}
      aria-valuemax={85}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          save(clampRatio(ratio + (e.key === 'ArrowDown' ? 0.05 : -0.05)));
        }
      }}
      onDblClick={() => save(0.6)}
      onPointerDown={(e) => {
        const el = containerRef.current;
        if (!el) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setActive(true);
        document.body.classList.add('row-resizing');
      }}
      onPointerMove={(e) => {
        if (!active) return;
        const r = containerRef.current?.getBoundingClientRect();
        if (!r || r.height <= 0) return;
        save(clampRatio((e.clientY - r.top) / r.height));
      }}
      onPointerUp={() => {
        setActive(false);
        document.body.classList.remove('row-resizing');
      }}
    />
  );
}

// ---------- 通用确认框 ----------

function Confirm({
  title, children, confirmLabel, danger, busy, onConfirm, onClose, extra,
}: {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  extra?: ComponentChildren;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div class="ws-dialog">
        {children}
        <div class="ws-dialog-acts">
          {extra}
          <button class="btn" onClick={onClose}>{tr('ui.cancel')}</button>
          <button class={`btn ${danger ? 'danger' : 'primary'}`} disabled={busy} onClick={onConfirm}>
            {busy ? tr('ws.working') : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** 未保存保护：保存 / 放弃 / 继续编辑 */
function UnsavedDialog({ name, onSave, onDiscard, onCancel }: {
  name: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={tr('ws.unsavedTitle')} onClose={onCancel}>
      <div class="ws-dialog">
        <p>{tr('ws.unsavedBody', { name })}</p>
        <div class="ws-dialog-acts">
          <button class="btn" onClick={onCancel}>{tr('ws.keepEditing')}</button>
          <button class="btn danger" onClick={onDiscard}>{tr('ws.discardChanges')}</button>
          <button class="btn primary" onClick={onSave}>{tr('ui.save')}</button>
        </div>
      </div>
    </Modal>
  );
}

/** 新建 / 重命名 / 移动：一个输入框 + 目标预览（项目内相对路径） */
function NameDialog({ title, label, initial, hint, onSubmit, onClose }: {
  title: string;
  label: string;
  initial: string;
  hint?: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (): Promise<void> => {
    const v = value.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr('');
    try {
      await onSubmit(v);
      onClose();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <form
        class="ws-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label class="ws-field">
          <span>{label}</span>
          <input
            class="mono"
            value={value}
            ref={(el) => {
              if (el && !el.dataset.focused) {
                el.dataset.focused = '1';
                el.focus();
                const dot = value.lastIndexOf('.');
                const slash = value.lastIndexOf('/');
                el.setSelectionRange(slash + 1, dot > slash + 1 ? dot : value.length);
              }
            }}
            onInput={(e) => setValue(e.currentTarget.value)}
          />
        </label>
        {hint && <p class="mut small">{hint}</p>}
        {err && <div class="err" role="alert">{err}</div>}
        <div class="ws-dialog-acts">
          <button type="button" class="btn" onClick={onClose}>{tr('ui.cancel')}</button>
          <button type="submit" class="btn primary" disabled={busy || !value.trim()}>
            {busy ? tr('ws.working') : tr('ui.confirm')}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 删除确认：展示名称与影响；目录展示包含的文件/目录数量，显式确认后才递归删除 */
function DeleteDialog({ pid, target, onDone, onClose }: {
  pid: number;
  target: TreeRowTarget;
  onDone: () => void;
  onClose: () => void;
}) {
  const [stat, setStat] = useState<FsStat | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<FsStat>(`/api/projects/${pid}/fs/stat?path=${encodeURIComponent(target.path)}&count=1`)
      .then(setStat)
      .catch((e) => setErr(errText(e)));
  }, [pid, target.path]);
  const count = stat?.count;
  const nonEmpty = !!count && count.files + count.dirs > 0;
  const confirm = async (): Promise<void> => {
    setBusy(true);
    setErr('');
    try {
      const q = new URLSearchParams({ path: target.path });
      if (nonEmpty) {
        q.set('recursive', '1');
        q.set('expectVersion', count!.version);
      }
      await api(`/api/projects/${pid}/fs?${q}`, 'DELETE');
      toast.success(tr('ws.deleted', { name: target.name }));
      onDone();
      onClose();
    } catch (e) {
      setErr(errText(e));
      // 计数变化：重新拉取，让用户看到最新影响后再确认
      api<FsStat>(`/api/projects/${pid}/fs/stat?path=${encodeURIComponent(target.path)}&count=1`).then(setStat).catch(() => {});
    } finally {
      setBusy(false);
    }
  };
  return (
    <Confirm
      title={target.dir ? tr('ws.deleteFolderTitle') : tr('ws.deleteFileTitle')}
      confirmLabel={tr('ui.delete')}
      danger
      busy={busy || !stat}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <p class="ws-target mono">{target.path}</p>
      {!stat && !err && <Loading />}
      {stat && !target.dir && <p>{tr('ws.deleteFileImpact', { size: fmtSize(stat.size ?? 0) })}</p>}
      {stat && target.dir && (
        nonEmpty
          ? <p class="warn-text">{tr('ws.deleteFolderImpact', { files: count!.files, dirs: count!.dirs })}{count!.truncated ? ` ${tr('ws.countTruncated')}` : ''}</p>
          : <p>{tr('ws.deleteEmptyFolder')}</p>
      )}
      {err && <div class="err" role="alert">{err}</div>}
    </Confirm>
  );
}

// ---------- 提交历史（带筛选） ----------

function CommitHistory({
  commits, selectedSha, open, onToggle, dispatch, rowsRef, style,
}: {
  commits: GitCommit[];
  selectedSha: string | null;
  open: boolean;
  onToggle: () => void;
  dispatch: Dispatch;
  rowsRef: { current: HTMLDivElement | null };
  style?: JSX.CSSProperties;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? commits.filter((c) => c.subject.toLowerCase().includes(needle) || c.author.toLowerCase().includes(needle) || c.sha.startsWith(needle))
    : commits;
  const layout = useMemo(() => layoutGraph(commits.map((c) => ({ sha: c.sha, parents: c.parents }))), [commits]);
  const laneOf = useMemo(() => new Map(layout.nodes.map((n) => [n.sha, n.lane])), [layout]);
  const graphW = PAD_X * 2 + Math.max(1, layout.maxLanes) * LANE_W;
  const svgH = commits.length * ROW_H + 4;
  const headSha = commits.find((c) => c.refs.some((r) => r === 'HEAD' || r.startsWith('HEAD -> ')))?.sha;
  const graph = !needle; // 筛选后泳道不连续，改成紧凑列表

  return (
    <section class={`git-history-pane${open ? '' : ' collapsed'}`} style={open ? style : undefined}>
      <div class="git-pane-head git-history-head">
        <button class="ws-collapse-btn" aria-expanded={open} onClick={onToggle}>
          <span class={`ft-arrow${open ? ' open' : ''}`}>▸</span>
          <span class="git-pane-title">{tr('git.commitHistory')}</span>
          <span class="mut small">{commits.length}</span>
        </button>
        {open && (
          <input
            class="ws-filter"
            type="search"
            value={filter}
            placeholder={tr('ws.filterCommits')}
            aria-label={tr('ws.filterCommits')}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        )}
      </div>
      {open && (
        <div class="git-history-scroll">
          {shown.length === 0 && <div class="empty">{commits.length ? tr('ws.noMatches') : tr('git.noCommits')}</div>}
          {shown.length > 0 && (
            <div class="git-rows" ref={rowsRef} style={{ minWidth: (graph ? graphW : 0) + 286 }}>
              {graph && (
                <svg class="git-svg" width={graphW} height={svgH}>
                  {layout.edges.map((e) => (
                    <path d={edgePath(e, commits.length)} fill="none" stroke={laneColor(e.lane)} strokeWidth={2}
                      strokeLinecap="round" opacity={e.missing ? 0.3 : 0.85} />
                  ))}
                  {layout.nodes.map((n) => {
                    const isMerge = (commits[n.row]?.parents.length ?? 0) > 1;
                    const color = laneColor(n.lane);
                    return (
                      <>
                        {n.sha === headSha && (
                          <circle cx={cx(n.lane)} cy={cy(n.row)} r={7.5} fill="none" stroke={color} strokeWidth={1.5} opacity={0.55} />
                        )}
                        <circle cx={cx(n.lane)} cy={cy(n.row)} r={isMerge ? 3.6 : 4.4}
                          fill={isMerge ? 'var(--bg)' : color} stroke={color} strokeWidth={isMerge ? 2 : 0} />
                      </>
                    );
                  })}
                </svg>
              )}
              {shown.map((c) => (
                <div
                  class={`git-row${selectedSha === c.sha ? ' on' : ''}`}
                  data-sha={c.sha}
                  role="button"
                  tabIndex={0}
                  style={{ paddingLeft: graph ? graphW + 6 : 10 }}
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
                      title={tr('git.viewFullMessage')}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        dispatch({ type: 'open-commit-detail', sha: c.sha });
                      }}
                    >
                      {tr('git.viewDetails')}
                    </button>
                  </div>
                  <div class="git-r2 mut">
                    <span class="mono" style={{ color: laneColor(laneOf.get(c.sha) ?? 0) }}>{c.short}</span>
                    <span>{c.author}</span>
                    <span>{timeAgo(c.ts)}</span>
                  </div>
                </div>
              ))}
              {commits.length >= 200 && (
                <div class="mut small" style={{ padding: '10px 12px 16px' }}>{tr('git.recentOnly')}</div>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ---------- 按块 diff ----------

interface Hunk {
  header: string;
  lines: string[];
}

export function splitDiffHunks(diff: string): { head: string[]; hunks: Hunk[] } {
  const lines = diff.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const head: string[] = [];
  const hunks: Hunk[] = [];
  for (const l of lines) {
    if (l.startsWith('@@')) hunks.push({ header: l, lines: [l] });
    else if (hunks.length) hunks[hunks.length - 1]!.lines.push(l);
    else head.push(l);
  }
  return { head, hunks };
}

/** 工作区 diff：每块带「暂存 / 取消暂存 / 撤销」；块头随请求发给后端做竞态校验 */
function HunkDiff({ diff, err, group, busy, onHunk }: {
  diff: GitDiff | null;
  err: string;
  group: ChangeGroup;
  busy: boolean;
  onHunk: (index: number, header: string, action: 'stage' | 'unstage' | 'discard') => void;
}) {
  if (err) return <div class="empty"><span class="err">{err}</span></div>;
  if (!diff) return <Loading />;
  if (!diff.diff.trim()) return <div class="empty">{tr('git.noDiff')}</div>;
  const { head, hunks } = splitDiffHunks(diff.diff);
  const actionable = (group === 'staged' || group === 'unstaged') && !diff.truncated;
  return (
    <div class="gs-diff mono ws-hunks">
      {head.map((l) => <div class={diffLineCls(l)}>{l || ' '}</div>)}
      {hunks.map((h, i) => (
        <div class="ws-hunk">
          <div class="ws-hunk-head">
            <span class="dl dhunk">{h.header}</span>
            {actionable && (
              <span class="ws-hunk-acts">
                {group === 'unstaged' && (
                  <>
                    <button class="btn xs" disabled={busy} onClick={() => onHunk(i, h.header, 'stage')}>＋ {tr('ws.stageHunk')}</button>
                    <button class="btn xs danger" disabled={busy} onClick={() => onHunk(i, h.header, 'discard')}>↶ {tr('ws.discardHunk')}</button>
                  </>
                )}
                {group === 'staged' && (
                  <button class="btn xs" disabled={busy} onClick={() => onHunk(i, h.header, 'unstage')}>－ {tr('ws.unstageHunk')}</button>
                )}
              </span>
            )}
          </div>
          {h.lines.slice(1).map((l) => <div class={diffLineCls(l)}>{l || ' '}</div>)}
        </div>
      ))}
      {diff.truncated && <div class="dl dh">{tr('git.diffTooLong')}</div>}
    </div>
  );
}

// ---------- 主视图 ----------

interface PendingAction {
  run: () => void;
}

export function WorkspaceView({ pid, loc }: { pid: number; loc: WorkspaceLoc }) {
  const wide = useWide();
  const treeW = useTreeWidth();
  const splitRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const [project, setProject] = useState<Project | null>(null);
  const [gitResult, setGitResult] = useState(() => createGitLoadState<GitInfo>(pid));
  const gitLoadSeq = useRef(0);
  const [workspace, rawDispatch] = useReducer(gitWorkspaceReducer, createGitWorkspaceState());
  const [historyOpen, setHistoryOpen] = useState(true);
  const [treeOpen, setTreeOpen] = useState(true);
  const [navOpen, setNavOpen] = useState(true);
  const [ratio, setRatio] = useState(readRatio);
  const [mobileTab, setMobileTab] = useState<MobileTab>(loc.view === 'changes' ? 'changes' : loc.view === 'commit' || loc.view === 'detail' ? 'history' : 'files');
  const [curDir, setCurDir] = useState('');
  const [reveal, setReveal] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState<{ mode: 'name' | 'content'; q: string } | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [executor, setExecutor] = useState<ExecutorLabel | null>(null);
  const [cwd, setCwd] = useState('');
  const [busyOp, setBusyOp] = useState<string | null>(null);
  const busyLatch = useRef(false);
  const [syncError, setSyncError] = useState('');
  const [upload, setUpload] = useState<{ pct: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // 对话框 / 菜单
  const [menu, setMenu] = useState<{ target: TreeRowTarget; anchor: MenuAnchor } | null>(null);
  const [moreMenu, setMoreMenu] = useState<MenuAnchor | null>(null);
  const [nameDlg, setNameDlg] = useState<null | { kind: 'file' | 'dir' | 'rename' | 'move'; target?: TreeRowTarget; base: string }>(null);
  const [delDlg, setDelDlg] = useState<TreeRowTarget | null>(null);
  const [discardDlg, setDiscardDlg] = useState<null | { paths: string[]; label: string } | { hunk: { index: number; header: string; path: string } }>(null);
  const [abortDlg, setAbortDlg] = useState(false);
  const [pushDlg, setPushDlg] = useState<string | null>(null);
  const [pullOpen, setPullOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [locOpen, setLocOpen] = useState(false);
  const [copyFail, setCopyFail] = useState<string | null>(null);

  // 未保存保护
  const viewer = useRef<FileViewerHandle | null>(null);
  const [, setDirty] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const guard = (run: () => void): void => {
    if (viewer.current?.dirty()) setPending({ run });
    else run();
  };
  const dispatch: Dispatch = (action) => {
    if (action.type === 'refresh' || action.type === 'reset') rawDispatch(action);
    else guard(() => rawDispatch(action));
  };
  // 全局导航（项目导航、面包屑、任意 hash 链接、前进后退）离开本工作区时同样询问；
  // 本工作区内部的深链变化由下方 loc 同步自行 guard，这里放行
  useEffect(() => setLeaveGuard((to, proceed) => {
    if (to.name === 'workspace' && to.pid === pid) return false;
    if (!viewer.current?.dirty()) return false;
    setPending({ run: proceed });
    return true;
  }), [pid]);

  const info = gitResult.pid === pid ? gitResult.value : null;
  const gitErr = gitResult.pid === pid ? gitResult.error : '';
  const isRepo = !!info?.ok;
  const changes = useMemo(() => (info?.ok ? info.changes ?? [] : []), [info]);
  const commits: GitCommit[] = info?.ok ? info.commits ?? [] : [];
  const groups = useMemo(() => groupWorktree(changes), [changes]);
  const conflicts = groups.find((g) => g.group === 'conflict')?.leaves.length ?? 0;
  const stagedN = groups.find((g) => g.group === 'staged')?.leaves.length ?? 0;
  const selectedSha = workspace.source.kind === 'commit' ? workspace.source.sha : null;
  const commit = useCommitDetail(pid, selectedSha, workspace.refreshToken);

  // ---- 加载 ----
  useEffect(() => {
    api<Project>(`/api/projects/${pid}`).then((p) => { if (alive.current) { setProject(p); setCwd((c) => c || p.cwd); } }).catch(() => {});
    api<FsList>(`/api/projects/${pid}/fs?path=`)
      .then((r) => { if (alive.current) { setExecutor(r.executor ?? null); setCwd(r.cwd); } })
      .catch(() => {});
  }, [pid]);

  const loadGit = (clear = true): void => {
    const request = ++gitLoadSeq.current;
    setGitResult((prev) => beginGitLoad(prev, pid, request, !clear));
    api<GitInfo>(`/api/projects/${pid}/git`)
      .then((result) => { if (alive.current) setGitResult((prev) => completeGitLoad(prev, pid, request, result)); })
      .catch((e: Error) => { if (alive.current) setGitResult((prev) => failGitLoad(prev, pid, request, e.message)); });
  };
  useEffect(() => {
    loadGit();
    return () => { gitLoadSeq.current++; };
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 按影响范围刷新：文件写入 → 树 + 改动；Git 操作 → 状态/分支/历史（同一 GitInfo） */
  const refresh = (): void => {
    rawDispatch({ type: 'refresh' });
    loadGit(false);
  };

  // ---- 深链：状态 → hash（replace），外部 hash → 状态 ----
  const lastWritten = useRef<WorkspaceLoc | null>(null);
  const pendingSel = useRef<WorkspaceLoc | null>(null);

  const applyLoc = (l: WorkspaceLoc): void => {
    setSearch(null);
    if (l.view === 'files') {
      if (!l.path) {
        rawDispatch({ type: 'show-all' });
        return;
      }
      if (l.path.endsWith('/')) {
        rawDispatch({ type: 'show-all' });
        const d = l.path.replace(/\/+$/, '');
        setCurDir(d);
        setReveal(l.path);
        if (!wide) setMobileTab('files');
      } else {
        rawDispatch({ type: 'select-file', file: { kind: 'all', key: `all:${l.path}`, path: l.path } });
        setCurDir(parentOf(l.path));
        setReveal(l.path);
      }
      return;
    }
    if (l.view === 'search') {
      rawDispatch({ type: 'show-all' });
      setSearch({ mode: l.mode, q: l.q });
      setSearchInput(l.q);
      return;
    }
    if (l.view === 'changes') {
      rawDispatch({ type: 'show-worktree' });
      setMobileTab('changes');
      pendingSel.current = l.path ? l : null;
      return;
    }
    if (l.view === 'detail') {
      rawDispatch({ type: 'open-commit-detail', sha: l.sha });
      return;
    }
    rawDispatch({ type: 'select-commit', sha: l.sha });
    pendingSel.current = l.path ? l : null;
  };

  useEffect(() => {
    if (lastWritten.current && sameLoc(lastWritten.current, loc)) return;
    const run = (): void => {
      lastWritten.current = loc;
      applyLoc(loc);
    };
    if (viewer.current?.dirty()) setPending({ run });
    else run();
  }, [loc]); // eslint-disable-line react-hooks/exhaustive-deps

  // 需要数据才能落位的选择（改动 / 提交内文件）：数据到了再选中
  useEffect(() => {
    const l = pendingSel.current;
    if (!l || !('path' in l) || !l.path) return;
    if (l.view === 'changes' && info?.ok) {
      const g = groups.find((x) => x.group === l.group);
      const leaf = g?.leaves.find((x) => x.path === l.path) ?? groups.flatMap((x) => x.leaves).find((x) => x.path === l.path);
      pendingSel.current = null;
      if (leaf) rawDispatch({ type: 'select-file', file: { kind: 'worktree', leaf } });
    } else if (l.view === 'commit' && commit.d?.sha.startsWith(l.sha)) {
      const f = commit.d.files.find((x) => x.path === l.path);
      pendingSel.current = null;
      if (f) {
        rawDispatch({
          type: 'select-file',
          file: { kind: 'commit', sha: l.sha, leaf: { key: `commit:${l.sha}:${f.path}`, path: f.path, code: f.status[0] ?? 'M', ...(f.oldPath ? { oldPath: f.oldPath } : {}) } },
        });
      }
    }
  }, [info, commit.d, groups]);

  const currentLoc = (): WorkspaceLoc => {
    const c = workspace.content;
    if (workspace.source.kind === 'commit') {
      if (c?.kind === 'commit-detail') return { view: 'detail', sha: c.sha };
      if (c?.kind === 'file' && c.file.kind === 'commit') return { view: 'commit', sha: workspace.source.sha, path: c.file.leaf.path };
      return { view: 'commit', sha: workspace.source.sha };
    }
    if (workspace.source.kind === 'worktree') {
      if (c?.kind === 'file' && c.file.kind === 'worktree') return { view: 'changes', group: leafGroup(c.file.leaf), path: c.file.leaf.path };
      return { view: 'changes' };
    }
    if (search) return { view: 'search', mode: search.mode, q: search.q };
    if (c?.kind === 'file' && c.file.kind === 'all') return { view: 'files', path: c.file.path };
    return curDir ? { view: 'files', path: `${curDir}/` } : { view: 'files' };
  };

  useEffect(() => {
    const next = currentLoc();
    if (sameLoc(next, loc)) {
      lastWritten.current = next;
      return;
    }
    if (pendingSel.current) return; // 还在等数据落位，别把深链冲掉
    lastWritten.current = next;
    nav(workspacePath(pid, next), { replace: true });
  }, [workspace.source, workspace.content, search, curDir]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 写操作统一入口：单飞 + 进行中状态 + 完成后刷新；失败保留 Git 具体错误 ----
  const run = async <T,>(op: string, fn: () => Promise<T>, done?: (v: T) => string | void): Promise<T | null> => {
    if (busyLatch.current) return null;
    busyLatch.current = true;
    setBusyOp(op);
    try {
      const v = await fn();
      if (!alive.current) return null;
      const msg = done?.(v);
      if (msg) toast.success(msg);
      refresh();
      return v;
    } catch (e) {
      if (alive.current) toast.error(errText(e));
      throw e;
    } finally {
      busyLatch.current = false;
      if (alive.current) setBusyOp(null);
    }
  };
  const runQuiet = <T,>(op: string, fn: () => Promise<T>, done?: (v: T) => string | void): void => {
    run(op, fn, done).catch(() => {});
  };

  // ---- 文件操作 ----
  const openFile = (path: string): void => {
    dispatch({ type: 'select-file', file: { kind: 'all', key: `all:${path}`, path } });
  };
  const openedPath = workspace.content?.kind === 'file' && workspace.content.file.kind === 'all' ? workspace.content.file.path : null;

  const createEntry = async (kind: 'file' | 'dir', rel: string): Promise<void> => {
    const p = normalizeRel(rel);
    if (!p) throw new Error(tr('ws.nameRequired'));
    const clean = p.replace(/\/+$/, '');
    await api(`/api/projects/${pid}/fs/${kind === 'file' ? 'file' : 'mkdir'}?path=${encodeURIComponent(clean)}`, 'POST', kind === 'file' ? { content: '' } : undefined);
    refresh();
    if (kind === 'file') {
      setReveal(clean);
      rawDispatch({ type: 'select-file', file: { kind: 'all', key: `all:${clean}`, path: clean } });
      toast.success(tr('ws.fileCreated', { path: clean }));
    } else {
      setCurDir(clean);
      setReveal(`${clean}/`);
      toast.success(tr('ws.folderCreated', { path: clean }));
    }
  };

  const moveEntry = async (from: string, to: string): Promise<void> => {
    const dst = normalizeRel(to);
    if (!dst) throw new Error(tr('ws.nameRequired'));
    const clean = dst.replace(/\/+$/, '');
    await api(`/api/projects/${pid}/fs/move`, 'POST', { from, to: clean });
    toast.success(tr('ws.moved', { from, to: clean }));
    // 当前打开的文件在被移动的对象里 → 跟着换路径，深链随之更新
    if (openedPath && within(openedPath, from)) {
      const next = clean + openedPath.slice(from.length);
      rawDispatch({ type: 'select-file', file: { kind: 'all', key: `all:${next}`, path: next } });
      setReveal(next);
    }
    if (within(curDir, from)) setCurDir(clean + curDir.slice(from.length));
    refresh();
  };

  const uploadFile = async (f: File): Promise<void> => {
    setUpload({ pct: 0 });
    try {
      const j = await uploadWithProgress<FsUploadResult>(
        `/api/projects/${pid}/fs/upload?path=${encodeURIComponent(curDir)}`,
        f,
        f.name,
        { onProgress: (p) => setUpload({ pct: Math.round(p.ratio * 100) }) },
      );
      if (!alive.current) return;
      toast.success(tr('ws.uploadedTo', { name: j.name, dir: curDir || '.' }));
      refresh();
      // 保持视口并选中新文件
      setReveal(j.path);
      guard(() => rawDispatch({ type: 'select-file', file: { kind: 'all', key: `all:${j.path}`, path: j.path } }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      if (alive.current) setUpload(null);
    }
  };

  const copyTarget = (path: string, dir: boolean): CopyTarget => ({ pid, cwd: cwd || project?.cwd || '', rel: path, dir });

  const rowMenuItems = (t: TreeRowTarget): MenuItem[] => {
    const items: MenuItem[] = [...copyMenuItems(copyTarget(t.path, t.dir), executor, setCopyFail)];
    if (t.dir) {
      items.push(
        { key: 'new-file', label: tr('ws.newFileHere'), separator: true, onSelect: () => setNameDlg({ kind: 'file', base: t.path }) },
        { key: 'new-dir', label: tr('ws.newFolderHere'), onSelect: () => setNameDlg({ kind: 'dir', base: t.path }) },
      );
    }
    items.push(
      { key: 'rename', label: tr('ui.rename'), separator: !t.dir, onSelect: () => setNameDlg({ kind: 'rename', target: t, base: parentOf(t.path) }) },
      { key: 'move', label: tr('ws.move'), onSelect: () => setNameDlg({ kind: 'move', target: t, base: parentOf(t.path) }) },
      {
        key: 'download',
        label: t.dir ? tr('ws.downloadArchive') : tr('ui.download'),
        onSelect: () => {
          location.href = `/api/projects/${pid}/fs/${t.dir ? 'download-dir' : 'download'}?path=${encodeURIComponent(t.path)}`;
        },
      },
      {
        key: 'delete',
        label: tr('ui.delete'),
        danger: true,
        onSelect: () => {
          // 打开中的文件有未保存改动 → 先处理保存/放弃/取消
          if (openedPath && within(openedPath, t.path) && viewer.current?.dirty()) setPending({ run: () => setDelDlg(t) });
          else setDelDlg(t);
        },
      },
    );
    return items;
  };

  const afterDelete = (t: TreeRowTarget): void => {
    if (openedPath && within(openedPath, t.path)) rawDispatch({ type: 'close-content' });
    if (within(curDir, t.path)) setCurDir(parentOf(t.path));
    refresh();
  };

  // ---- Git 操作 ----
  const stagePaths = (paths: string[], stage: boolean): void =>
    runQuiet(stage ? 'stage' : 'unstage', async () => {
      try {
        await writeGitPathBatches(paths, (batch) => api(`/api/projects/${pid}/git/${stage ? 'stage' : 'unstage'}`, 'POST', { paths: batch }));
      } catch (e) {
        if (alive.current) refresh(); // 前面的批次可能已完成，同步真实暂存状态。
        throw e;
      }
    });

  const fileOps = useMemo(() => deriveGitFileOperations(changes), [changes]);

  const hunkAction = (path: string, group: ChangeGroup, index: number, header: string, action: 'stage' | 'unstage' | 'discard'): void => {
    if (action === 'discard') {
      setDiscardDlg({ hunk: { index, header, path } });
      return;
    }
    runQuiet(action, () => api(`/api/projects/${pid}/git/hunk`, 'POST', { path, side: group, index, header, action }),
      () => (action === 'stage' ? tr('ws.hunkStaged') : tr('ws.hunkUnstaged')));
  };

  const doPush = (): void => {
    setSyncError('');
    run('push', () => api<GitPushResult>(`/api/projects/${pid}/git/push`, 'POST'), (r) =>
      r.createdUpstream ? tr('git.pushedUpstream', { upstream: r.upstream }) : tr('git.pushedTo', { upstream: r.upstream }))
      .catch((e) => setSyncError(errText(e)));
  };
  const doFetch = (): void => {
    setSyncError('');
    run('fetch', () => api(`/api/projects/${pid}/git/fetch`, 'POST'), () => tr('ws.fetched')).catch((e) => setSyncError(errText(e)));
  };

  // ---- 渲染块 ----
  const title = project?.name ?? tr('view.projectFallback', { id: pid });
  const branchLabel = info?.ok ? info.branch || `(${tr('git.detached')})` : '';
  const selKey = workspace.content?.kind === 'file'
    ? (workspace.content.file.kind === 'all' ? workspace.content.file.key : workspace.content.file.leaf.key)
    : undefined;

  const syncBadge = info?.ok && (
    <span class="ws-sync" title={info.upstream ? tr('ws.upstreamTitle', { upstream: info.upstream }) : tr('ws.noUpstream')}>
      {info.upstream
        ? <span class={`badge ${(info.ahead ?? 0) + (info.behind ?? 0) > 0 ? 'b-purple' : 'b-gray'}`}>{info.upstream} ↑{info.ahead ?? 0} ↓{info.behind ?? 0}</span>
        : <span class="badge b-gray">{tr('ws.noUpstream')}</span>}
      {info.upstreamGone && <span class="badge b-red">{tr('ws.upstreamGone')}</span>}
      <span class="mut small">{info.lastFetchTs ? tr('ws.lastFetch', { time: timeAgo(info.lastFetchTs) }) : tr('ws.neverFetched')}</span>
    </span>
  );

  const pushTarget = info?.ok && info.branch && !info.upstream ? `origin/${info.branch}` : '';

  const gitActions = isRepo && (
    <>
      <button class="btn sm" disabled={busyOp !== null} onClick={doFetch}>
        {busyOp === 'fetch' ? tr('ws.fetching') : `⟳ ${tr('ws.fetch')}`}
      </button>
      <button
        class="btn sm"
        disabled={busyOp !== null || !info?.upstream}
        title={info?.upstream ? tr('ws.pullFrom', { upstream: info.upstream }) : tr('ws.pullNeedsUpstream')}
        onClick={() => setPullOpen(true)}
      >
        ↓ {tr('ws.pull')}
      </button>
      <button
        class="btn sm"
        disabled={busyOp !== null || !info?.branch}
        title={!info?.branch ? tr('git.detachedNoPush') : pushTarget ? tr('ws.pushWillCreate', { target: pushTarget }) : tr('git.pushCurrent')}
        onClick={() => (pushTarget ? setPushDlg(pushTarget) : doPush())}
      >
        {busyOp === 'push' ? tr('git.pushing') : `↑ ${tr('ws.push')}`}
      </button>
    </>
  );

  const moreItems = (): MenuItem[] => [
    { key: 'refresh', label: tr('ui.refresh'), onSelect: refresh },
    { key: 'location', label: tr('ws.workLocations'), onSelect: () => setLocOpen(true) },
    ...(isRepo
      ? [
          { key: 'branch', label: tr('ws.branches'), onSelect: () => setBranchOpen(true) },
          { key: 'fetch', label: tr('ws.fetch'), separator: true, onSelect: doFetch, disabled: busyOp !== null },
          { key: 'pull', label: tr('ws.pull'), onSelect: () => setPullOpen(true), disabled: busyOp !== null || !info?.upstream },
          { key: 'push', label: tr('ws.push'), onSelect: () => (pushTarget ? setPushDlg(pushTarget) : doPush()), disabled: busyOp !== null || !info?.branch },
        ]
      : []),
    ...(wide ? [{ key: 'nav', label: navOpen ? tr('ws.hideSidebar') : tr('ws.showSidebar'), separator: true, onSelect: () => setNavOpen((v) => !v) }] : []),
  ];

  // 路径栏（当前目录面包屑，可点击）
  const crumbs = (
    <nav class="fsbar ws-crumbs" aria-label={tr('ws.currentFolder')}>
      <button class="crumb" onClick={() => { setCurDir(''); setReveal(undefined); }} title={cwd}>⌂</button>
      {curDir.split('/').filter(Boolean).map((s, i, arr) => (
        <span key={i} class="crumb-seg">
          <span class="mut">/</span>
          <button class={`crumb${i === arr.length - 1 ? ' cur' : ''}`} onClick={() => setCurDir(arr.slice(0, i + 1).join('/'))}>{s}</button>
        </span>
      ))}
    </nav>
  );

  const fileToolbar = (
    <div class="ws-toolbar">
      <form
        class="ws-search"
        role="search"
        onSubmit={async (e) => {
          e.preventDefault();
          const q = searchInput.trim();
          if (!q) return;
          // 路径直达：当前目录或项目根的相对路径精确命中 → 打开文件 / 进入目录；未命中回退内容搜索
          const hit = await resolveWorkspacePath(q, curDir, async (p) => {
            const st = await api<FsStat>(`/api/projects/${pid}/fs/stat?path=${encodeURIComponent(p)}`);
            return st.exists && (st.type === 'file' || st.type === 'dir') ? st.type : null;
          });
          if (!alive.current) return;
          if (!hit) {
            guard(() => { rawDispatch({ type: 'show-all' }); setSearch({ mode: 'content', q }); });
            return;
          }
          guard(() => {
            setSearch(null);
            setSearchInput('');
            setFilter('');
            if (hit.kind === 'dir') {
              rawDispatch({ type: 'show-all' });
              setCurDir(hit.path);
              setReveal(`${hit.path}/`);
              if (!wide) setMobileTab('files');
            } else {
              rawDispatch({ type: 'select-file', file: { kind: 'all', key: `all:${hit.path}`, path: hit.path } });
              setCurDir(parentOf(hit.path));
              setReveal(hit.path);
            }
          });
        }}
      >
        <input
          type="search"
          class="ws-filter"
          value={searchInput}
          placeholder={tr('ws.filterOrSearch')}
          aria-label={tr('ws.filterOrSearch')}
          onInput={(e) => {
            setSearchInput(e.currentTarget.value);
            setFilter(e.currentTarget.value);
            if (!e.currentTarget.value) setSearch(null);
          }}
        />
        <button type="submit" class="btn sm" disabled={!searchInput.trim()} title={tr('ws.searchContent')}>
          {tr('ws.searchContent')}
        </button>
      </form>
      <div class="ws-toolbar-row">
        <span class="mut small ws-target-dir" title={tr('ws.uploadTarget', { dir: curDir || '.' })}>
          {tr('ws.inFolder', { dir: curDir || '.' })}
        </span>
        <button class="btn sm ws-file-action" title={tr('ws.newFile')} aria-label={tr('ws.newFile')}
          onClick={() => setNameDlg({ kind: 'file', base: curDir })}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z M14 2v6h6 M12 12v6 M9 15h6" />
          </svg>
        </button>
        <button class="btn sm ws-file-action" title={tr('ws.newFolder')} aria-label={tr('ws.newFolder')}
          onClick={() => setNameDlg({ kind: 'dir', base: curDir })}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z M12 10v6 M9 13h6" />
          </svg>
        </button>
        <button class="btn sm fs-up ws-file-action" disabled={upload !== null}
          title={upload ? tr('ui.uploadingPercent', { percent: upload.pct }) : tr('ui.upload')}
          aria-label={upload ? tr('ui.uploadingPercent', { percent: upload.pct }) : tr('ui.upload')}
          aria-busy={upload !== null} onClick={() => fileInput.current?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 16V3 M7 8l5-5 5 5 M3 16v4a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-4" />
          </svg>
          {upload && (
            <span class="up-prog" role="progressbar" aria-valuenow={upload.pct} aria-valuemin={0} aria-valuemax={100}
              aria-label={tr('ui.uploadingPercent', { percent: upload.pct })}>
              <i style={{ width: `${upload.pct}%` }} />
            </span>
          )}
        </button>
      </div>
    </div>
  );

  const searchResults = search && (
    <SearchResults
      pid={pid}
      search={search}
      onMode={(mode) => setSearch({ ...search, mode })}
      onClose={() => { setSearch(null); setSearchInput(''); setFilter(''); }}
      onOpen={(path, dir) => {
        if (dir) { setCurDir(path); setReveal(`${path}/`); setSearch(null); }
        else openFile(path);
      }}
      onMenu={(t, a) => setMenu({ target: t, anchor: a })}
    />
  );

  const filesPane = (
    <>
      {fileToolbar}
      {crumbs}
      <div class="git-tree-body">
        {searchResults ?? (
          <FileTree
            key={`tree:${pid}`}
            pid={pid}
            git
            filter={filter}
            selectedPath={openedPath}
            selectedDir={curDir}
            onSelectDir={setCurDir}
            onSelectFile={(p) => { setCurDir(parentOf(p)); openFile(p); }}
            reloadToken={workspace.refreshToken}
            revealPath={reveal}
            onRowMenu={(target, anchor) => setMenu({ target, anchor })}
          />
        )}
      </div>
    </>
  );

  const changesPane = (
    <ChangesPane
      pid={pid}
      info={info}
      gitErr={gitErr}
      groups={groups}
      conflicts={conflicts}
      stagedN={stagedN}
      busyOp={busyOp}
      selKey={selKey}
      fileOps={fileOps}
      onOpen={(leaf) => dispatch({ type: 'select-file', file: { kind: 'worktree', leaf } })}
      onStage={(paths) => stagePaths(paths, true)}
      onUnstage={(paths) => stagePaths(paths, false)}
      onStageAll={(stage) => runQuiet(stage ? 'stage' : 'unstage', () => api(`/api/projects/${pid}/git/${stage ? 'stage' : 'unstage'}`, 'POST', { all: true }),
        () => (stage ? tr('git.stageAllDone') : tr('git.unstageAllDone')))}
      onDiscard={(paths, label) => setDiscardDlg({ paths, label })}
      onDeleteUntracked={(path) => setDelDlg({ path, name: path.split('/').pop() ?? path, dir: false })}
      onResolve={(paths) => runQuiet('resolve', () => api(`/api/projects/${pid}/git/resolve`, 'POST', { paths }), () => tr('ws.resolved'))}
      onEditConflict={(path) => openFile(path)}
      onContinue={() => runQuiet('continue', () => api(`/api/projects/${pid}/git/operation`, 'POST', { action: 'continue' }), () => tr('ws.operationContinued'))}
      onAbort={() => setAbortDlg(true)}
      onCommit={(message, clear) => runQuiet('commit', () => api<GitCommitResult>(`/api/projects/${pid}/git/commit`, 'POST', { message }), (r) => {
        clear();
        return tr('git.committed', { sha: r.short });
      })}
    />
  );

  const commitTree = (() => {
    if (workspace.source.kind !== 'commit') return null;
    const tree = buildGitWorkspaceTree(workspace.source, { commit: commit.d });
    if (tree.kind !== 'commit') return null;
    return (
      <>
        <div class="git-tree-context" title={tree.sha}>
          <span>{tr('git.commitChanges')}</span>
          <b class="mono">{tree.sha.slice(0, 8)}</b>
          <button class="linkbtn" onClick={() => dispatch({ type: 'open-commit-detail', sha: tree.sha })}>{tr('git.viewDetails')}</button>
          <button class="gs-x" title={tr('ws.backToFiles')} aria-label={tr('ws.backToFiles')} onClick={() => dispatch({ type: 'show-all' })}>✕</button>
        </div>
        <div class="git-tree-body">
          {tree.loading
            ? (commit.err ? <div class="empty">{commit.err}</div> : <Loading />)
            : tree.leaves.length === 0
              ? <div class="empty">{tr('git.commitNoFiles')}</div>
              : (
                <ChangeTree
                  key={tree.sha}
                  leaves={tree.leaves}
                  selKey={selKey}
                  onOpen={(leaf) => dispatch({ type: 'select-file', file: { kind: 'commit', sha: tree.sha, leaf } })}
                />
              )}
        </div>
      </>
    );
  })();

  const sourceTabs = (
    <div class="git-source-tabs" role="tablist" aria-label={tr('git.fileTreeSource')}>
      <button role="tab" aria-selected={workspace.source.kind === 'all'} class={workspace.source.kind === 'all' ? 'on' : ''}
        onClick={() => dispatch({ type: 'show-all' })}>
        {tr('ws.allFiles')}
      </button>
      <button role="tab" aria-selected={workspace.source.kind === 'worktree'} class={workspace.source.kind === 'worktree' ? 'on' : ''}
        onClick={() => dispatch({ type: 'show-worktree' })}>
        {tr('ws.currentChanges')}{(info?.dirty ?? 0) > 0 ? ` ${info!.dirty}` : ''}
      </button>
    </div>
  );

  const treePane = (
    <section class={`git-tree-pane${treeOpen ? '' : ' collapsed'}`} style={treeOpen && historyOpen && isRepo ? { flex: `${ratio} 1 0` } : undefined}>
      <div class="git-pane-head git-tree-head">
        <button class="ws-collapse-btn" aria-expanded={treeOpen} aria-label={treeOpen ? tr('git.collapse') : tr('git.expand')} onClick={() => setTreeOpen((v) => !v)}>
          <span class={`ft-arrow${treeOpen ? ' open' : ''}`}>▸</span>
        </button>
        {sourceTabs}
      </div>
      {treeOpen && (workspace.source.kind === 'all' ? filesPane : workspace.source.kind === 'worktree' ? changesPane : commitTree)}
    </section>
  );

  const historyPane = isRepo && (
    <CommitHistory
      commits={commits}
      selectedSha={selectedSha}
      open={historyOpen}
      onToggle={() => setHistoryOpen((v) => !v)}
      dispatch={dispatch}
      rowsRef={rowsRef}
      style={treeOpen ? { flex: `${1 - ratio} 1 0` } : { flex: '1 1 0' }}
    />
  );

  const jump = (sha: string): void => {
    if (!commits.some((c) => c.sha === sha)) {
      toast.info(tr('git.notRecent'));
      return;
    }
    dispatch({ type: 'open-commit-detail', sha });
    setHistoryOpen(true);
    requestAnimationFrame(() => rowsRef.current?.querySelector(`[data-sha="${sha}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const content = (
    <WorkspaceContent
      pid={pid}
      state={workspace}
      mobile={!wide}
      busy={busyOp !== null}
      viewerRef={viewer}
      onDirty={setDirty}
      onSaved={refresh}
      onJump={jump}
      onClose={() => dispatch({ type: 'close-content' })}
      onOpenParent={(p) => { rawDispatch({ type: 'close-content' }); setCurDir(parentOf(p)); setReveal(`${parentOf(p)}/`); }}
      onHunk={hunkAction}
      copyTarget={copyTarget}
      executor={executor}
      onFileMenu={(t, a) => setMenu({ target: t, anchor: a })}
    />
  );

  const back = (): void => {
    if (!wide && workspace.content) {
      dispatch({ type: 'close-content' });
      return;
    }
    guard(() => nav(`/p/${pid}`));
  };

  const header = (
    <div class="bhead ws-head">
      <div class="bhead-row">
        <button class="back" aria-label={!wide && workspace.content ? tr('git.backWorkspace') : tr('git.backProject')} onClick={back}>‹</button>
        <span class="btitle">
          {title}
          <span class="mut"> / {tr('ws.title')}</span>
        </span>
        <div class="bacts ws-head-acts">
          <button class="btn sm ws-loc-btn" aria-haspopup="dialog" onClick={() => setLocOpen(true)} title={cwd}>
            ⌂ {tr('ws.location')} ▾
          </button>
          {isRepo && (
            <button class="btn sm ws-branch-btn" aria-haspopup="dialog" onClick={() => setBranchOpen(true)}>
              ⎇ {branchLabel} ▾
            </button>
          )}
          {wide && syncBadge}
          {wide && gitActions}
          <button
            class="btn sm"
            aria-haspopup="menu"
            aria-label={tr('ws.more')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMoreMenu({ x: r.right - 240, y: r.bottom + 4 });
            }}
          >
            ⋯
          </button>
        </div>
      </div>
      {!wide && info?.ok && <div class="ws-mobile-sync">{syncBadge}</div>}
      {info && !info.ok && <div class="ws-banner mut small">{tr('ws.notRepo')}</div>}
      {gitErr && <div class="err">{gitErr}</div>}
      {syncError && (
        <div class="ws-banner err" role="alert">
          <span>{syncError}</span>
          <button class="gs-x" aria-label={tr('git.close')} onClick={() => setSyncError('')}>✕</button>
        </div>
      )}
      {busyOp && <div class="ws-busy mut small" role="status" aria-live="polite">{tr('ws.inProgress', { op: busyOp })}</div>}
    </div>
  );

  // 手机：列表页
  const mobileList = (
    <>
      <div class="ws-mtabs" role="tablist">
        {(['files', 'changes', 'history'] as const).map((tab) => (
          <button
            role="tab"
            aria-selected={mobileTab === tab}
            class={mobileTab === tab ? 'on' : ''}
            onClick={() => {
              setMobileTab(tab);
              if (tab === 'files') dispatch({ type: 'show-all' });
              if (tab === 'changes') dispatch({ type: 'show-worktree' });
            }}
          >
            {tab === 'files' ? tr('ws.allFiles') : tab === 'changes' ? `${tr('ws.currentChanges')}${(info?.dirty ?? 0) > 0 ? ` ${info!.dirty}` : ''}` : tr('ws.history')}
          </button>
        ))}
      </div>
      <div class="ws-mlist">
        {mobileTab === 'files' && (
          <>
            {fileToolbar}
            {crumbs}
            {searchResults ?? (
              <MobileDirList
                pid={pid}
                dir={curDir}
                reloadToken={workspace.refreshToken}
                onEnter={(d) => setCurDir(d)}
                onOpen={(p) => openFile(p)}
                onMenu={(t, a) => setMenu({ target: t, anchor: a })}
              />
            )}
          </>
        )}
        {mobileTab === 'changes' && (workspace.source.kind === 'commit' ? commitTree : changesPane)}
        {mobileTab === 'history' && (workspace.source.kind === 'commit' && !workspace.content
          ? commitTree
          : historyPane || <div class="empty">{tr('ws.notRepo')}</div>)}
      </div>
    </>
  );

  return (
    <div class="fullcol ws-page">
      {header}
      {wide ? (
        <div class={`git-workspace ws-body${navOpen ? '' : ' nav-closed'}`} ref={splitRef}>
          {navOpen ? (
            <>
              <div class="git-nav-wrap" style={treeW.width != null ? { width: treeW.width, maxWidth: treeW.width } : undefined}>
                <div class="git-nav" ref={navRef}>
                  {treePane}
                  {isRepo && treeOpen && historyOpen && <HSplitter containerRef={navRef} ratio={ratio} setRatio={setRatio} />}
                  {historyPane}
                </div>
              </div>
              <ListSplitter containerRef={splitRef} list={treeW} label={tr('git.navWidth')} />
            </>
          ) : (
            <button class="ws-rail" aria-label={tr('ws.showSidebar')} title={tr('ws.showSidebar')} onClick={() => setNavOpen(true)}>▸</button>
          )}
          <main class="git-context">{content}</main>
        </div>
      ) : workspace.content ? (
        <div class="git-mobile-content">{content}</div>
      ) : (
        mobileList
      )}

      <input
        ref={fileInput}
        type="file"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          e.currentTarget.value = '';
          if (f) void uploadFile(f);
        }}
      />

      {menu && (
        <ActionMenu
          title={menu.target.path || '.'}
          anchor={menu.anchor}
          sheet={!wide}
          onClose={() => setMenu(null)}
          items={rowMenuItems(menu.target)}
        />
      )}
      {moreMenu && (
        <ActionMenu title={tr('ws.more')} anchor={moreMenu} sheet={!wide} onClose={() => setMoreMenu(null)} items={moreItems()}
          header={!wide && isRepo ? <div class="ws-sheet-sync">⎇ {branchLabel} {syncBadge}</div> : undefined} />
      )}
      {copyFail !== null && <CopyFallback value={copyFail} onClose={() => setCopyFail(null)} />}
      {nameDlg && (
        <NameDialog
          title={
            nameDlg.kind === 'file' ? tr('ws.newFile')
              : nameDlg.kind === 'dir' ? tr('ws.newFolder')
                : nameDlg.kind === 'rename' ? tr('ui.rename') : tr('ws.move')
          }
          label={nameDlg.kind === 'move' ? tr('ws.targetPath') : nameDlg.kind === 'rename' ? tr('ws.newName') : tr('ws.pathInProject')}
          initial={
            nameDlg.kind === 'rename' ? nameDlg.target!.name
              : nameDlg.kind === 'move' ? nameDlg.target!.path
                : nameDlg.base ? `${nameDlg.base}/` : ''
          }
          hint={nameDlg.kind === 'rename' ? tr('ws.renameHint', { dir: nameDlg.base || '.' }) : tr('ws.relativeHint')}
          onClose={() => setNameDlg(null)}
          onSubmit={async (v) => {
            if (nameDlg.kind === 'file' || nameDlg.kind === 'dir') await createEntry(nameDlg.kind, v);
            else if (nameDlg.kind === 'rename') {
              if (v.includes('/')) throw new Error(tr('ws.renameNoSlash'));
              await moveEntry(nameDlg.target!.path, nameDlg.base ? `${nameDlg.base}/${v}` : v);
            } else await moveEntry(nameDlg.target!.path, v);
          }}
        />
      )}
      {delDlg && <DeleteDialog pid={pid} target={delDlg} onClose={() => setDelDlg(null)} onDone={() => afterDelete(delDlg)} />}
      {discardDlg && (
        <Confirm
          title={tr('ws.discardTitle')}
          confirmLabel={tr('ws.discard')}
          danger
          busy={busyOp !== null}
          onClose={() => setDiscardDlg(null)}
          onConfirm={() => {
            const d = discardDlg;
            setDiscardDlg(null);
            if ('hunk' in d) {
              runQuiet('discard', () => api(`/api/projects/${pid}/git/hunk`, 'POST', { path: d.hunk.path, side: 'unstaged', index: d.hunk.index, header: d.hunk.header, action: 'discard' }), () => tr('ws.discarded'));
            } else {
              runQuiet('discard', () => api(`/api/projects/${pid}/git/discard`, 'POST', { paths: d.paths }), () => tr('ws.discarded'));
            }
          }}
        >
          <p>{'hunk' in discardDlg ? tr('ws.discardHunkBody', { path: discardDlg.hunk.path }) : tr('ws.discardFileBody')}</p>
          {'hunk' in discardDlg
            ? <pre class="ws-target mono">{discardDlg.hunk.header}</pre>
            : <p class="ws-target mono">{discardDlg.label}</p>}
        </Confirm>
      )}
      {abortDlg && (
        <Confirm title={tr('ws.abortTitle')} confirmLabel={tr('ws.abortOperation')} danger onClose={() => setAbortDlg(false)}
          onConfirm={() => {
            setAbortDlg(false);
            runQuiet('abort', () => api(`/api/projects/${pid}/git/operation`, 'POST', { action: 'abort' }), () => tr('ws.operationAborted'));
          }}>
          <p>{tr('ws.abortBody', { operation: info?.operation ?? '' })}</p>
        </Confirm>
      )}
      {pushDlg && (
        <Confirm title={tr('ws.push')} confirmLabel={tr('ws.push')} onClose={() => setPushDlg(null)}
          onConfirm={() => { setPushDlg(null); doPush(); }}>
          <p>{tr('ws.pushWillCreate', { target: pushDlg })}</p>
        </Confirm>
      )}
      {pullOpen && (
        <PullDialog pid={pid} onClose={() => setPullOpen(false)}
          onPull={(mode) => run('pull', () => api(`/api/projects/${pid}/git/pull`, 'POST', { mode }), () => tr('ws.pulled'))
            .then(() => setPullOpen(false))} />
      )}
      {branchOpen && (
        <BranchPanel
          pid={pid}
          current={info?.branch ?? ''}
          onClose={() => setBranchOpen(false)}
          onShowChanges={() => { setBranchOpen(false); dispatch({ type: 'show-worktree' }); setMobileTab('changes'); }}
          onDone={(msg) => { setBranchOpen(false); toast.success(msg); refresh(); }}
          guardNav={(fn) => guard(fn)}
        />
      )}
      {locOpen && <LocationPanel pid={pid} onClose={() => setLocOpen(false)} guardNav={(fn) => guard(fn)} />}
      {pending && (
        <UnsavedDialog
          name={openedPath ?? ''}
          onCancel={() => setPending(null)}
          onDiscard={() => {
            const p = pending;
            setPending(null);
            viewer.current = null;
            setDirty(false);
            p.run();
          }}
          onSave={async () => {
            const p = pending;
            const ok = await viewer.current?.save();
            setPending(null);
            if (!ok) return;
            viewer.current = null; // 句柄里的 dirty 是保存前那次渲染的快照，下次渲染会重新挂上
            p.run();
          }}
        />
      )}
    </div>
  );
}

// ---------- 当前改动 ----------

function ChangesPane({
  pid, info, gitErr, groups, conflicts, stagedN, busyOp, selKey, fileOps,
  onOpen, onStage, onUnstage, onStageAll, onDiscard, onDeleteUntracked, onResolve, onEditConflict,
  onContinue, onAbort, onCommit,
}: {
  pid: number;
  info: GitInfo | null;
  gitErr: string;
  groups: Array<{ group: ChangeGroup; leaves: ChangeLeaf[] }>;
  conflicts: number;
  stagedN: number;
  busyOp: string | null;
  selKey?: string;
  fileOps: ReturnType<typeof deriveGitFileOperations>;
  onOpen: (leaf: ChangeLeaf) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onStageAll: (stage: boolean) => void;
  onDiscard: (paths: string[], label: string) => void;
  onDeleteUntracked: (path: string) => void;
  onResolve: (paths: string[]) => void;
  onEditConflict: (path: string) => void;
  onContinue: () => void;
  onAbort: () => void;
  onCommit: (message: string, clear: () => void) => void;
}) {
  const [message, setMessage] = useState('');
  const ai = useGitAi();
  if (!info) return gitErr ? <div class="empty err">{gitErr}</div> : <Loading />;
  if (!info.ok) return <div class="empty">{tr('ws.notRepo')}<div class="mut small">{info.cwd}</div></div>;
  const busy = busyOp !== null;
  const hasUnstaged = groups.some((g) => g.group === 'unstaged' || g.group === 'untracked');
  const commitBlocked = conflicts > 0 ? tr('ws.commitBlockedConflicts', { count: conflicts }) : stagedN === 0 ? tr('git.stageFirst') : '';
  const generate = (): void => {
    ai.start(tr('git.generateMessage'), async () => {
      const text = (await aiCommitMessage(pid)).trim();
      if (text) setMessage(text);
      return text;
    });
  };

  const actions = (leaf: ChangeLeaf, group: ChangeGroup): JSX.Element => {
    const op = fileOps[leaf.path];
    const paths = op?.paths ?? [leaf.path];
    const stop = (fn: () => void) => (ev: MouseEvent) => { ev.stopPropagation(); fn(); };
    return (
      <>
        {group === 'conflict' && (
          <>
            <button class="git-file-op" disabled={busy} title={tr('ws.openConflictEditor')} aria-label={tr('ws.openConflictEditor')} onClick={stop(() => onEditConflict(leaf.path))}>✎</button>
            <button class="git-file-op" disabled={busy} title={tr('ws.markResolved', { path: leaf.path })} aria-label={tr('ws.markResolved', { path: leaf.path })} onClick={stop(() => onResolve([leaf.path]))}>✓</button>
          </>
        )}
        {(group === 'unstaged' || group === 'untracked') && (
          <button class="git-file-op" disabled={busy} title={tr('git.stagePath', { path: leaf.path })} aria-label={tr('git.stagePath', { path: leaf.path })} onClick={stop(() => onStage(paths))}>＋</button>
        )}
        {group === 'staged' && (
          <button class="git-file-op" disabled={busy} title={tr('git.unstagePath', { path: leaf.path })} aria-label={tr('git.unstagePath', { path: leaf.path })} onClick={stop(() => onUnstage(paths))}>－</button>
        )}
        {group === 'unstaged' && (
          <button class="git-file-op danger" disabled={busy} title={tr('ws.discardPath', { path: leaf.path })} aria-label={tr('ws.discardPath', { path: leaf.path })} onClick={stop(() => onDiscard(paths, leaf.path))}>↶</button>
        )}
        {group === 'untracked' && (
          <button class="git-file-op danger" disabled={busy} title={tr('ws.deletePath', { path: leaf.path })} aria-label={tr('ws.deletePath', { path: leaf.path })} onClick={stop(() => onDeleteUntracked(leaf.path))}>🗑</button>
        )}
      </>
    );
  };

  return (
    <div class="ws-changes">
      {info.operation && (
        <div class="ws-banner warn" role="status">
          <span>{tr('ws.operationInProgress', { operation: info.operation })}</span>
          <button class="btn sm" disabled={busy || conflicts > 0} title={conflicts > 0 ? tr('ws.resolveFirst') : ''} onClick={onContinue}>{tr('ws.continueOperation')}</button>
          <button class="btn sm danger" disabled={busy} onClick={onAbort}>{tr('ws.abortOperation')}</button>
        </div>
      )}
      <div class="git-ops-row ws-stage-actions">
        <button class="btn sm" disabled={busy || !hasUnstaged} onClick={() => onStageAll(true)}>＋ {tr('git.stageAll')}</button>
        <button class="btn sm" disabled={busy || stagedN === 0} onClick={() => onStageAll(false)}>－ {tr('git.unstageAll')}</button>
      </div>
      <div class="git-ops-panel">
        <textarea
          class="git-commit-input"
          rows={2}
          maxLength={20_000}
          disabled={busy}
          value={message}
          placeholder={tr('git.commitPlaceholder')}
          aria-label={tr('git.commitPlaceholder')}
          onInput={(e) => setMessage(e.currentTarget.value)}
        />
        <div class="git-ops-row git-commit-actions">
          <button class="btn sm" disabled={busy || ai.run?.loading || groups.length === 0} onClick={generate}>✨ {tr('git.generate')}</button>
          <span class="git-ops-status mut" role="status" aria-live="polite">
            {busyOp ? tr('ws.inProgress', { op: busyOp }) : commitBlocked || tr('ws.willCommit', { count: stagedN })}
          </span>
          <button
            class="btn sm primary"
            disabled={busy || !!commitBlocked || !message.trim()}
            title={commitBlocked || undefined}
            onClick={() => onCommit(message.trim(), () => setMessage(''))}
          >
            {tr('git.commitAction')}
          </button>
        </div>
      </div>
      {ai.run && <AiPanel run={ai.run} onClose={ai.clear} />}
      {groups.length === 0 && <div class="empty">{tr('git.clean')}</div>}
      {groups.map(({ group, leaves }) => (
        <div class={`ws-group ws-group-${group}`}>
          <div class="gs-fhead">
            {tr(GROUP_LABEL[group])} · {leaves.length}
            {group === 'conflict' && <span class="mut small"> {tr('ws.conflictHint')}</span>}
          </div>
          <ChangeTree key={group} leaves={leaves} selKey={selKey} onOpen={onOpen} renderActions={(leaf) => actions(leaf, group)}
            renderDirActions={group === 'unstaged' || group === 'untracked' ? (dir) => (
              <button class="git-file-op" disabled={busy} title={tr('git.stagePath', { path: dir.path })} aria-label={tr('git.stagePath', { path: dir.path })}
                onClick={() => onStage(directoryStagePaths(dir.path, leaves.map((leaf) => leaf.path), fileOps))}>＋</button>
            ) : undefined}
          />
        </div>
      ))}
    </div>
  );
}

// ---------- 搜索结果 ----------

function SearchResults({ pid, search, onMode, onClose, onOpen, onMenu }: {
  pid: number;
  search: { mode: 'name' | 'content'; q: string };
  onMode: (mode: 'name' | 'content') => void;
  onClose: () => void;
  onOpen: (path: string, dir: boolean) => void;
  onMenu: (t: TreeRowTarget, a: MenuAnchor) => void;
}) {
  const [res, setRes] = useState<KeyedResult<FsSearchResult> | null>(null);
  const key = `${search.mode}:${search.q}`;
  useEffect(() => {
    let live = true;
    setRes(null);
    api<FsSearchResult>(`/api/projects/${pid}/fs/search?mode=${search.mode}&q=${encodeURIComponent(search.q)}`)
      .then((r) => { if (live) setRes({ key, value: r, error: '' }); })
      .catch((e) => { if (live) setRes({ key, value: null, error: errText(e) }); });
    return () => { live = false; };
  }, [pid, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = keyedResult(res, key);
  return (
    <div class="ws-search-results">
      <div class="ws-search-head">
        <div class="seg ws-seg" role="group" aria-label={tr('ws.searchMode')}>
          <button class={`seg-btn${search.mode === 'name' ? ' on' : ''}`} aria-pressed={search.mode === 'name'} onClick={() => onMode('name')}>{tr('ws.searchByName')}</button>
          <button class={`seg-btn${search.mode === 'content' ? ' on' : ''}`} aria-pressed={search.mode === 'content'} onClick={() => onMode('content')}>{tr('ws.searchContent')}</button>
        </div>
        <button class="gs-x" aria-label={tr('ws.closeSearch')} title={tr('ws.closeSearch')} onClick={onClose}>✕</button>
      </div>
      {!visible.value && !visible.error && <Loading />}
      {visible.error && <div class="err">{visible.error}</div>}
      {visible.value && visible.value.results.length === 0 && <div class="empty">{tr('ws.noMatches')}</div>}
      {visible.value?.results.map((r) => {
        const dir = r.type === 'dir';
        const name = r.path.split('/').pop() ?? r.path;
        return (
          <div
            class="ft-row ws-result"
            role="button"
            tabIndex={0}
            onClick={() => onOpen(r.path, dir)}
            onKeyDown={(e) => { if (e.key === 'Enter') onOpen(r.path, dir); }}
            onContextMenu={(e) => { e.preventDefault(); onMenu({ path: r.path, name, dir }, { x: e.clientX, y: e.clientY }); }}
          >
            <span class="ft-icon">{dir ? '📁' : '📄'}</span>
            <span class="ws-result-main">
              <PathText path={r.path} />
              {r.line !== undefined && <span class="mut small mono"> :{r.line} {r.text}</span>}
            </span>
            <button class="ft-more" aria-label={tr('ws.moreFor', { name })} onClick={(e) => {
              e.stopPropagation();
              const b = e.currentTarget.getBoundingClientRect();
              onMenu({ path: r.path, name, dir }, { x: b.left, y: b.bottom + 2 });
            }}>⋯</button>
          </div>
        );
      })}
      {visible.value?.truncated && <div class="mut small">{tr('ws.resultsTruncated')}</div>}
    </div>
  );
}

// ---------- 手机目录列表 ----------

function MobileDirList({ pid, dir, reloadToken, onEnter, onOpen, onMenu }: {
  pid: number;
  dir: string;
  reloadToken: number;
  onEnter: (dir: string) => void;
  onOpen: (path: string) => void;
  onMenu: (t: TreeRowTarget, a: MenuAnchor) => void;
}) {
  const [res, setRes] = useState<KeyedResult<FsList> | null>(null);
  const key = `${dir}:${reloadToken}`;
  useEffect(() => {
    let live = true;
    api<FsList>(`/api/projects/${pid}/fs?path=${encodeURIComponent(dir)}&git=1`)
      .then((r) => { if (live) setRes({ key, value: r, error: '' }); })
      .catch((e) => { if (live) setRes({ key, value: null, error: errText(e) }); });
    return () => { live = false; };
  }, [pid, key]); // eslint-disable-line react-hooks/exhaustive-deps
  const visible = keyedResult(res, key);
  const list = visible.value;
  return (
    <div class="fslist">
      {!list && !visible.error && <Loading />}
      {visible.error && (
        <div class="empty">
          <span class="err">{visible.error}</span>
          {dir && <button class="btn sm" onClick={() => onEnter(parentOf(dir))}>{tr('ws.openParent')}</button>}
        </div>
      )}
      {list && list.entries.length === 0 && <div class="empty">{tr('ui.emptyDirectory')}</div>}
      {list?.truncated && <div class="mut small">{tr('view.directoryTooLarge')}</div>}
      {list?.entries.map((e: FsEntry) => {
        const full = joinChildPath(dir, e.name);
        const target = { path: full, name: e.name, dir: e.type === 'dir' };
        return (
          <div key={e.name} class={`fsrow${e.git === '!' ? ' ignored' : ''}`} role="button" tabIndex={0}
            onClick={() => (e.type === 'dir' ? onEnter(full) : onOpen(full))}>
            <span class="fsicon">{treeIcon(e)}</span>
            <span class="fsname">{e.name}</span>
            <GitMark mark={e.git} />
            <span class="fsmeta">{e.type === 'dir' ? '' : fmtSize(e.size)}</span>
            <span class="fsmeta">{e.mtimeMs !== null ? timeAgo(e.mtimeMs) : ''}</span>
            <button class="ft-more ws-row-more" aria-label={tr('ws.moreFor', { name: e.name })}
              onClick={(ev) => {
                ev.stopPropagation();
                const b = ev.currentTarget.getBoundingClientRect();
                onMenu(target, { x: b.left, y: b.bottom });
              }}>⋯</button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 内容区 ----------

function worktreeDiffUrl(pid: number, leaf: ChangeLeaf): string {
  const q = new URLSearchParams({ path: leaf.path });
  if (leaf.oldPath) q.set('old', leaf.oldPath);
  const g = leafGroup(leaf);
  if (g === 'untracked') q.set('untracked', '1');
  else q.set('side', g === 'staged' ? 'staged' : 'unstaged');
  return `/api/projects/${pid}/git/worktree/diff?${q}`;
}

function contentDiffUrl(pid: number, file: GitWorkspaceFile): string | null {
  if (file.kind === 'all') return null;
  if (file.kind === 'worktree') return worktreeDiffUrl(pid, file.leaf);
  const q = new URLSearchParams({ path: file.leaf.path });
  if (file.leaf.oldPath) q.set('old', file.leaf.oldPath);
  return `/api/projects/${pid}/git/commits/${file.sha}/diff?${q}`;
}

function contentImageUrls(pid: number, file: Exclude<GitWorkspaceFile, { kind: 'all' }>): GitImageUrls {
  const endpoint = file.kind === 'worktree'
    ? `/api/projects/${pid}/git/worktree/raw`
    : `/api/projects/${pid}/git/commits/${file.sha}/raw`;
  return gitImageUrls(endpoint, file.leaf.path, file.leaf.oldPath, file.leaf.code);
}

function useContentDiff(pid: number, state: GitWorkspaceState): { diff: GitDiff | null; err: string } {
  const file = state.content?.kind === 'file' ? state.content.file : null;
  const url = file ? contentDiffUrl(pid, file) : null;
  const diffKey = requestKey(pid, state.refreshToken, url);
  const [result, setResult] = useState<KeyedResult<GitDiff> | null>(null);
  useEffect(() => {
    let live = true;
    setResult(null);
    if (!url) return () => { live = false; };
    api<GitDiff>(url)
      .then((r) => { if (live) setResult({ key: diffKey, value: r, error: '' }); })
      .catch((e: Error) => { if (live) setResult({ key: diffKey, value: null, error: e.message }); });
    return () => { live = false; };
  }, [pid, state.refreshToken, diffKey, url]);
  const visible = keyedResult(result, diffKey);
  return { diff: visible.value, err: visible.error };
}

function WorkspaceContent({
  pid, state, mobile, busy, viewerRef, onDirty, onSaved, onJump, onClose, onOpenParent, onHunk,
  copyTarget, executor, onFileMenu,
}: {
  pid: number;
  state: GitWorkspaceState;
  mobile: boolean;
  busy: boolean;
  viewerRef: { current: FileViewerHandle | null };
  onDirty: (d: boolean) => void;
  onSaved: () => void;
  onJump: (sha: string) => void;
  onClose: () => void;
  onOpenParent: (path: string) => void;
  onHunk: (path: string, group: ChangeGroup, index: number, header: string, action: 'stage' | 'unstage' | 'discard') => void;
  copyTarget: (path: string, dir: boolean) => CopyTarget;
  executor: ExecutorLabel | null;
  onFileMenu: (t: TreeRowTarget, a: MenuAnchor) => void;
}) {
  const { diff, err } = useContentDiff(pid, state);
  const c = state.content;
  if (!c) return <div class="gd-empty">{tr('git.chooseContent')}</div>;
  if (c.kind === 'commit-detail') {
    return <CommitPanel key={c.sha} pid={pid} sha={c.sha} reloadToken={state.refreshToken} onJump={onJump} mobile={mobile} />;
  }
  const file = c.file;
  if (file.kind === 'all') {
    const name = file.path.split('/').pop() ?? file.path;
    const more = (
      <button
        class="btn sm"
        aria-haspopup="menu"
        aria-label={tr('ws.moreFor', { name })}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onFileMenu({ path: file.path, name, dir: false }, { x: r.right - 240, y: mobile ? r.top - 8 : r.bottom + 4 });
        }}
      >
        {mobile ? tr('ws.more') : '⋯'}
      </button>
    );
    return (
      <FileViewer
        key={file.path}
        pid={pid}
        path={file.path}
        mobile={mobile}
        handleRef={viewerRef}
        onDirtyChange={onDirty}
        onSaved={onSaved}
        onOpenParent={() => onOpenParent(file.path)}
        toolbar={<><CopyPathButton target={copyTarget(file.path, false)} executor={executor} />{more}</>}
        bottomBar={<><CopyPathButton target={copyTarget(file.path, false)} executor={executor} compact />{more}</>}
      />
    );
  }
  const leaf = file.leaf;
  if (file.kind === 'worktree') {
    const group = leafGroup(leaf);
    const image = isImagePath(leaf.path) || (leaf.oldPath ? isImagePath(leaf.oldPath) : false);
    return (
      <div class="gd-diffcol">
        <div class="gd-diffhd">
          <StatusChip code={leaf.code} />
          <PathText path={leaf.path} oldPath={leaf.oldPath} />
          <span class="badge b-gray">{tr(GROUP_LABEL[group])}</span>
          {!mobile && <CopyPathButton target={copyTarget(leaf.path, false)} executor={executor} compact />}
          <button class="gs-x" title={tr('git.collapseDiff')} aria-label={tr('git.collapseDiff')} onClick={onClose}>✕</button>
        </div>
        {image
          ? <DiffContent code={leaf.code} path={leaf.path} oldPath={leaf.oldPath} imageUrls={contentImageUrls(pid, file)} d={diff} error={err} />
          : <HunkDiff diff={diff} err={err} group={group} busy={busy} onHunk={(i, h, a) => onHunk(leaf.path, group, i, h, a)} />}
        {mobile && (
          <div class="ws-bottom-bar">
            <CopyPathButton target={copyTarget(leaf.path, false)} executor={executor} compact />
          </div>
        )}
      </div>
    );
  }
  return (
    <DiffCol
      code={leaf.code}
      path={leaf.path}
      oldPath={leaf.oldPath}
      imageUrls={contentImageUrls(pid, file)}
      diff={diff}
      error={err}
      onClose={onClose}
      explain={() => aiExplainFile(pid, { sha: file.sha, path: leaf.path, old: leaf.oldPath })}
    />
  );
}

// ---------- 拉取 ----------

function PullDialog({ pid, onClose, onPull }: {
  pid: number;
  onClose: () => void;
  onPull: (mode: 'ff-only' | 'merge' | 'rebase') => Promise<void>;
}) {
  const [pv, setPv] = useState<PullPreview | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<PullPreview>(`/api/projects/${pid}/git/pull-preview`).then(setPv).catch((e) => setErr(errText(e)));
  }, [pid]);
  const go = (mode: 'ff-only' | 'merge' | 'rebase'): void => {
    setBusy(true);
    setErr('');
    onPull(mode).catch((e) => setErr(errText(e))).finally(() => setBusy(false));
  };
  return (
    <Modal title={tr('ws.pull')} onClose={onClose}>
      <div class="ws-dialog">
        {!pv && !err && <Loading />}
        {pv && (
          <>
            <p>{pv.upstream ? tr('ws.pullSummary', { branch: pv.branch, upstream: pv.upstream, ahead: pv.ahead, behind: pv.behind }) : tr('ws.pullNeedsUpstream')}</p>
            {pv.operation && <p class="warn-text">{tr('ws.operationInProgress', { operation: pv.operation })}</p>}
            {pv.dirty > 0 && <p class="warn-text">{tr('ws.pullDirty', { count: pv.dirty })}</p>}
            {pv.running > 0 && <p class="warn-text">{tr('ws.blockIssueRunning', { count: pv.running })}</p>}
            {pv.upstream && pv.behind === 0 && <p class="mut">{tr('ws.upToDate')}</p>}
            {pv.modes.includes('ff-only') && <p class="mut small">{tr('ws.pullFastForward')}</p>}
            {pv.modes.includes('merge') && <p class="mut small">{tr('ws.pullDiverged')}</p>}
          </>
        )}
        {err && <div class="err" role="alert">{err}</div>}
        <div class="ws-dialog-acts">
          <button class="btn" onClick={onClose}>{tr('ui.cancel')}</button>
          {pv && pv.dirty === 0 && !pv.running && !pv.operation && pv.modes.map((m) => (
            <button class={`btn ${m === 'ff-only' ? 'primary' : ''}`} disabled={busy} onClick={() => go(m)}>
              {m === 'ff-only' ? tr('ws.pullFf') : m === 'merge' ? tr('ws.pullMerge') : tr('ws.pullRebase')}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

// ---------- 分支 ----------

function blockerText(b: CheckoutBlocker): string {
  switch (b.code) {
    case 'dirty': return tr('ws.blockDirty', { count: b.count ?? 0 });
    case 'issue_running': return tr('ws.blockIssueRunning', { count: b.count ?? 0 });
    case 'branch_in_worktree': return tr('ws.blockBranchInWorktree', { path: b.path ?? '' });
    case 'operation_in_progress': return tr('ws.operationInProgress', { operation: b.operation ?? '' });
  }
}

function BranchPanel({ pid, current, onClose, onShowChanges, onDone, guardNav }: {
  pid: number;
  current: string;
  onClose: () => void;
  onShowChanges: () => void;
  onDone: (msg: string) => void;
  guardNav: (fn: () => void) => void;
}) {
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [check, setCheck] = useState<null | { label: string; body: { branch?: string; remote?: string }; res: CheckoutCheck }>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState('');
  const [start, setStart] = useState('');
  const [switchNew, setSwitchNew] = useState(true);
  useEffect(() => {
    api<GitBranches>(`/api/projects/${pid}/git/branches`).then(setBranches).catch((e) => setErr(errText(e)));
  }, [pid]);
  const needle = q.trim().toLowerCase();
  const local = (branches?.local ?? []).filter((b) => !needle || b.name.toLowerCase().includes(needle));
  const remote = (branches?.remote ?? []).filter((b) => !needle || b.name.toLowerCase().includes(needle));

  const inspect = (body: { branch?: string; remote?: string }, label: string): void => {
    setErr('');
    setCheck(null);
    const qs = body.remote ? `remote=${encodeURIComponent(body.remote)}` : `branch=${encodeURIComponent(body.branch!)}`;
    api<CheckoutCheck>(`/api/projects/${pid}/git/checkout-check?${qs}`)
      .then((res) => setCheck({ label, body, res }))
      .catch((e) => setErr(errText(e)));
  };
  const doCheckout = (): void => {
    if (!check) return;
    setBusy(true);
    setErr('');
    api(`/api/projects/${pid}/git/checkout`, 'POST', check.body)
      .then(() => onDone(tr('ws.switchedTo', { branch: check.res.branch })))
      .catch((e) => {
        setErr(errText(e));
        inspect(check.body, check.label); // 持锁后现场变了：重新展示具体原因
      })
      .finally(() => setBusy(false));
  };
  const create = (): void => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr('');
    api(`/api/projects/${pid}/git/branches`, 'POST', { name, ...(start.trim() ? { start: start.trim() } : {}), checkout: switchNew })
      .then(() => onDone(switchNew ? tr('ws.switchedTo', { branch: name }) : tr('ws.branchCreated', { branch: name })))
      .catch((e) => setErr(errText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal title={tr('ws.branches')} onClose={onClose} wide>
      <div class="ws-dialog ws-branch-panel">
        <p class="mut small">{tr('ws.currentBranch', { branch: current || tr('git.detached') })}</p>
        <input type="search" class="ws-filter" value={q} placeholder={tr('ws.searchBranches')} aria-label={tr('ws.searchBranches')}
          onInput={(e) => setQ(e.currentTarget.value)} />
        {!branches && !err && <Loading />}
        {branches && (
          <div class="ws-branch-lists">
            <div>
              <div class="gs-fhead">{tr('ui.localBranches')}</div>
              {local.map((b) => (
                <button class={`ws-branch-row${b.name === current ? ' on' : ''}`} disabled={b.name === current}
                  onClick={() => inspect({ branch: b.name }, b.name)}>
                  ⎇ {b.name}{b.name === current ? ` · ${tr('ws.current')}` : ''}
                </button>
              ))}
            </div>
            <div>
              <div class="gs-fhead">{tr('ui.remoteBranches')}</div>
              {remote.length === 0 && <div class="mut small">{tr('ui.noTrackingBranches')}</div>}
              {remote.map((b) => (
                <button class="ws-branch-row" onClick={() => inspect({ remote: b.name }, b.name)}>☁ {b.name}</button>
              ))}
            </div>
          </div>
        )}
        {check && (
          <div class="ws-check">
            {check.res.blockers.length === 0 ? (
              <>
                <p>{check.res.tracking
                  ? tr('ws.checkoutRemoteConfirm', { branch: check.res.branch, remote: check.res.tracking })
                  : tr('ws.checkoutConfirm', { branch: check.res.branch })}</p>
                <button class="btn primary" disabled={busy} onClick={doCheckout}>{busy ? tr('ws.working') : tr('ws.switchBranch')}</button>
              </>
            ) : (
              <>
                <p class="warn-text">{tr('ws.cannotSwitch', { branch: check.label })}</p>
                <ul class="ws-blockers">
                  {check.res.blockers.map((b) => (
                    <li>
                      {blockerText(b)}
                      {b.code === 'dirty' && <button class="btn xs" onClick={onShowChanges}>{tr('ws.goToChanges')}</button>}
                      {b.code === 'branch_in_worktree' && b.projectId && (
                        <button class="btn xs" onClick={() => guardNav(() => nav(`/p/${b.projectId}/workspace`))}>{tr('ws.openHolder')}</button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <details class="ws-new-branch">
          <summary>{tr('ws.newBranch')}</summary>
          <label class="ws-field"><span>{tr('ws.branchName')}</span>
            <input class="mono" value={newName} onInput={(e) => setNewName(e.currentTarget.value)} /></label>
          <label class="ws-field"><span>{tr('ws.startPoint')}</span>
            <input class="mono" value={start} placeholder="HEAD" onInput={(e) => setStart(e.currentTarget.value)} /></label>
          <label class="ws-check-row"><input type="checkbox" checked={switchNew} onChange={(e) => setSwitchNew(e.currentTarget.checked)} /> {tr('ws.switchAfterCreate')}</label>
          <button class="btn primary" disabled={busy || !newName.trim()} onClick={create}>{tr('ui.create')}</button>
        </details>
        {err && <div class="err" role="alert">{err}</div>}
      </div>
    </Modal>
  );
}

// ---------- 工作位置（多 worktree） ----------

const KIND_LABEL: Record<WorktreeInfo['kind'], Parameters<typeof tr>[0]> = {
  main: 'ws.kindMain',
  panda: 'ws.kindPanda',
  design: 'ws.kindDesign',
  external: 'ws.kindExternal',
};

function LocationPanel({ pid, onClose, guardNav }: {
  pid: number;
  onClose: () => void;
  guardNav: (fn: () => void) => void;
}) {
  const [list, setList] = useState<WorktreeList | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [branch, setBranch] = useState('');
  const [createNew, setCreateNew] = useState(true);
  const [base, setBase] = useState('');
  const [planned, setPlanned] = useState('');
  const [remove, setRemove] = useState<WorktreeInfo | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(false);
  const load = (): void => {
    setErr('');
    api<WorktreeList>(`/api/projects/${pid}/git/worktrees`).then(setList).catch((e) => setErr(errText(e)));
  };
  useEffect(load, [pid]);
  // 预览将创建的完整路径（服务端 dryRun 计算，与真正创建同一规则）
  useEffect(() => {
    setPlanned('');
    const b = branch.trim();
    if (!b) return;
    const t = setTimeout(() => {
      api<{ path: string }>(`/api/projects/${pid}/git/worktrees`, 'POST', { branch: b, create: createNew, ...(base.trim() ? { base: base.trim() } : {}), dryRun: true })
        .then((r) => setPlanned(r.path))
        .catch((e) => setPlanned(`— ${errText(e)}`));
    }, 300);
    return () => clearTimeout(t);
  }, [pid, branch, createNew, base]);

  const open = (projectId: number): void => guardNav(() => { onClose(); nav(`/p/${projectId}/workspace`); });
  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setErr('');
    fn().catch((e) => setErr(errText(e))).finally(() => setBusy(false));
  };

  return (
    <Modal title={tr('ws.workLocations')} onClose={onClose} wide>
      <div class="ws-dialog ws-locations">
        <p class="mut small">{tr('ws.locationsHint')}</p>
        {!list && !err && <Loading />}
        {list?.worktrees.map((w) => (
          <div class={`ws-loc-row${w.current ? ' on' : ''}`}>
            <div class="ws-loc-main">
              <b>{w.path.split('/').pop()}</b>
              <span class="badge b-gray">{tr(KIND_LABEL[w.kind])}</span>
              {w.current && <span class="badge b-blue">{tr('ws.current')}</span>}
              <span class="mono small">⎇ {w.branch || `(${tr('git.detached')})`}</span>
              <span class={`badge ${w.changes ? 'b-purple' : 'b-green'}`}>
                {w.changes === null ? tr('ws.locationMissing') : w.changes ? tr('ws.locationDirty', { count: w.changes }) : tr('ws.locationClean')}
              </span>
            </div>
            <div class="mono small mut ws-loc-path" title={w.path}>{w.path}</div>
            <div class="ws-loc-projects small">
              {w.projects.length === 0
                ? <span class="mut">{tr('ws.noLinkedProject')}</span>
                : w.projects.map((p) => (
                  <span>{p.name}{p.running > 0 ? ` · ${tr('ws.runningIssues', { count: p.running })}` : ''}</span>
                ))}
            </div>
            <div class="ws-loc-acts">
              {w.projects[0] && !w.current && <button class="btn sm primary" onClick={() => open(w.projects[0]!.id)}>{tr('ws.open')}</button>}
              {!w.projects.length && w.kind === 'external' && !w.prunable && (
                <button class="btn sm" disabled={busy} onClick={() => act(async () => {
                  const r = await api<{ project: { id: number } }>(`/api/projects/${pid}/git/worktrees/associate`, 'POST', { path: w.path });
                  open(r.project.id);
                })}>{tr('ws.associate')}</button>
              )}
              {w.kind === 'design' && <span class="mut small">{tr('ws.designManaged')}</span>}
              {w.kind === 'panda' && !w.current && (
                <button class="btn sm danger" disabled={busy} onClick={() => { setDeleteBranch(false); setRemove(w); }}>{tr('ws.remove')}</button>
              )}
            </div>
          </div>
        ))}
        <details class="ws-new-branch">
          <summary>{tr('ws.createLocation')}</summary>
          <div class="seg ws-seg" role="group">
            <button class={`seg-btn${createNew ? ' on' : ''}`} aria-pressed={createNew} onClick={() => setCreateNew(true)}>{tr('ws.newBranch')}</button>
            <button class={`seg-btn${!createNew ? ' on' : ''}`} aria-pressed={!createNew} onClick={() => setCreateNew(false)}>{tr('ws.existingBranch')}</button>
          </div>
          <label class="ws-field"><span>{tr('ws.branchName')}</span>
            <input class="mono" value={branch} onInput={(e) => setBranch(e.currentTarget.value)} /></label>
          {createNew && (
            <label class="ws-field"><span>{tr('ws.startPoint')}</span>
              <input class="mono" value={base} placeholder="HEAD" onInput={(e) => setBase(e.currentTarget.value)} /></label>
          )}
          {planned && <p class="small">{tr('ws.willCreateAt')} <span class="mono">{planned}</span></p>}
          <button class="btn primary" disabled={busy || !branch.trim() || !planned || planned.startsWith('—')} onClick={() => act(async () => {
            const r = await api<{ project: { id: number } }>(`/api/projects/${pid}/git/worktrees`, 'POST', { branch: branch.trim(), create: createNew, ...(base.trim() ? { base: base.trim() } : {}) });
            toast.success(tr('ws.locationCreated'));
            open(r.project.id);
          })}>{busy ? tr('ws.working') : tr('ui.create')}</button>
        </details>
        {err && <div class="err" role="alert">{err}</div>}
      </div>
      {remove && (
        <Confirm title={tr('ws.removeTitle')} confirmLabel={tr('ws.remove')} danger busy={busy} onClose={() => setRemove(null)}
          onConfirm={() => act(async () => {
            const r = await api<{ branchDeleted: boolean; branchError?: string }>(`/api/projects/${pid}/git/worktrees/remove`, 'POST', { path: remove.path, deleteBranch });
            setRemove(null);
            toast.success(tr('ws.locationRemoved'));
            if (deleteBranch && !r.branchDeleted) toast.error(tr('ws.branchKept', { details: r.branchError ?? '' }));
            load();
          })}>
          <p class="ws-target mono">{remove.path}</p>
          <p>{tr('ws.removeBody', { branch: remove.branch || '—' })}</p>
          <label class="ws-check-row"><input type="checkbox" checked={deleteBranch} onChange={(e) => setDeleteBranch(e.currentTarget.checked)} /> {tr('ws.alsoDeleteBranch', { branch: remove.branch })}</label>
        </Confirm>
      )}
    </Modal>
  );
}

/**
 * FileTree —— 文件页宽屏左栏「可展开文件树」（VSCode 风格）。
 *
 * 按 `/api/projects/:pid/fs?path=` **逐层懒加载**：仅在展开某目录时才拉它的子项（后端已 dir-first 排序）。
 * 状态集中在本组件：children（目录 → 子项缓存）、status（目录 → loading/error）、expanded（已展开目录集）。
 * 递归渲染，按层级缩进；目录行点箭头/整行展开折叠，文件行点击 onSelectFile；选中文件高亮（.on）。
 * 根目录（path=''）首挂载即加载并视为展开；每层各有 加载/空/错误 态。纯逻辑（拼路径/图标）见 lib/filetree。
 * `revealPath`（issue #310）：深链进来时把目标的各级祖先目录一次性展开并拉子项，
 * 让对话里点过来的文件在树上直接露出来，不用用户自己一层层点开；目标行一挂载就滚进可视区
 * ——大仓库的树很长，展开了却要用户自己翻着找，等于没展开。
 * 工作区（#388）：`git` 开启时每行带 Git 状态标记（含忽略文件）；`filter` 按名称筛选已加载节点；
 * `onRowMenu` 给每行加 `⋯`（右键、Shift+F10、ContextMenu 键打开同一菜单）；行可 Tab 聚焦、Enter 打开。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import type { FsEntry, FsList } from '../lib/types';
import { ancestorDirsOf, isCurrentTreeRequest, joinChildPath, treeIcon } from '../lib/filetree';
import { Spinner } from './Loaders';
import { tr } from '../i18n/runtime';
import { fmtSize } from '../lib/fmt';
import type { MenuAnchor } from './ActionMenu';

/** 行菜单目标（相对路径；dir=目录） */
export interface TreeRowTarget {
  path: string;
  name: string;
  dir: boolean;
}

const GIT_MARK_KEY: Record<NonNullable<FsEntry['git']>, Parameters<typeof tr>[0]> = {
  U: 'git.conflict',
  M: 'git.modified',
  A: 'git.added',
  D: 'git.deleted',
  R: 'git.renamed',
  '?': 'git.untracked',
  '!': 'ws.ignored',
  '•': 'ws.containsChanges',
};

export function GitMark({ mark }: { mark?: FsEntry['git'] }) {
  if (!mark) return null;
  const label = tr(GIT_MARK_KEY[mark]);
  const cls = mark === 'U' || mark === 'D' ? 'fs-d' : mark === '?' || mark === 'A' ? 'fs-u' : mark === '!' ? 'fs-ign' : 'fs-m';
  return (
    <span class={`ft-git ${cls}`} title={label} aria-label={label}>
      {mark === '!' ? '◌' : mark}
    </span>
  );
}

/** 每层缩进像素 */
const INDENT = 14;

export function FileTree({
  pid,
  selectedPath,
  onSelectFile,
  reloadToken,
  revealPath,
  git = false,
  filter = '',
  selectedDir,
  onSelectDir,
  onRowMenu,
}: {
  pid: number;
  /** 当前打开的文件相对路径（用于高亮）；null = 未选 */
  selectedPath: string | null;
  /** 点击文件时回调（传相对路径） */
  onSelectFile: (path: string) => void;
  /** 外部变更信号（如上传成功）：变化时重拉所有已加载目录、保留展开态；0/undefined=初始不触发 */
  reloadToken?: number;
  /** 深链目标（文件相对路径，目录带尾斜杠）：展开到它所在的各级目录；undefined=不动 */
  revealPath?: string;
  /** 附带 Git 状态标记（?git=1） */
  git?: boolean;
  /** 名称筛选（只作用于已加载节点） */
  filter?: string;
  /** 当前目录（上传/新建落点）高亮 */
  selectedDir?: string | null;
  onSelectDir?: (path: string) => void;
  /** 行菜单：传了才显示行末 ⋯ 并响应右键 / Shift+F10 */
  onRowMenu?: (target: TreeRowTarget, anchor: MenuAnchor) => void;
}) {
  // 目录相对路径 → 子项列表（已加载缓存）
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  // 目录相对路径 → 加载态（'loading' | 'error'；已加载成功则删除该键）
  const [status, setStatus] = useState<Record<string, 'loading' | 'error'>>({});
  // 已展开目录集（根 '' 恒展开，不入集）
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 项目切换淘汰上一代全部请求；同目录重拉只接受最后一次请求。
  const generation = useRef(0);
  const requestSeq = useRef(0);
  const latestRequest = useRef<Record<string, number>>({});
  // 还没滚到过的深链目标（去掉尾斜杠，与行的相对路径同形）；滚一次就清空，
  // 免得之后用户自己点别的文件时又被拽回来
  const pendingReveal = useRef<string | null>(null);

  const loadDir = (path: string, expectedGeneration = generation.current): void => {
    const request = ++requestSeq.current;
    latestRequest.current[path] = request;
    const isCurrent = (): boolean => isCurrentTreeRequest(
      expectedGeneration,
      generation.current,
      request,
      latestRequest.current[path],
    );
    setStatus((s) => ({ ...s, [path]: 'loading' }));
    api<FsList>(`/api/projects/${pid}/fs?path=${encodeURIComponent(path)}${git ? '&git=1' : ''}`)
      .then((r) => {
        if (!isCurrent()) return;
        setChildren((c) => ({ ...c, [path]: r.entries }));
        setStatus((s) => {
          const { [path]: _drop, ...rest } = s;
          return rest;
        });
      })
      .catch(() => {
        if (!isCurrent()) return;
        setStatus((s) => ({ ...s, [path]: 'error' }));
      });
  };

  // 首挂载 / 切项目：重置并加载根目录
  useEffect(() => {
    const nextGeneration = ++generation.current;
    latestRequest.current = {};
    setChildren({});
    setStatus({});
    setExpanded({});
    loadDir('', nextGeneration);
    return () => {
      generation.current++;
      latestRequest.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  // 外部变更信号（上传等）：重拉所有已加载目录，保留展开态，让新增/删除反映到树
  useEffect(() => {
    if (!reloadToken) return; // 0/undefined = 初始，根目录已由上面的 pid effect 加载
    Object.keys(children).forEach((p) => loadDir(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  // 深链：把目标的各级祖先目录展开并补拉子项（自身是目录时连它一起展开）
  useEffect(() => {
    pendingReveal.current = revealPath ? revealPath.replace(/\/+$/, '') : null;
    const dirs = ancestorDirsOf(revealPath);
    if (!dirs.length) return;
    setExpanded((e) => {
      const next = { ...e };
      for (const d of dirs) next[d] = true;
      return next;
    });
    for (const d of dirs) {
      if (children[d] === undefined && status[d] !== 'loading') loadDir(d);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, revealPath]);

  const toggleDir = (path: string): void => {
    const isOpen = expanded[path];
    if (isOpen) {
      setExpanded((e) => ({ ...e, [path]: false }));
      return;
    }
    setExpanded((e) => ({ ...e, [path]: true }));
    // 未加载过且非加载中 → 拉子项
    if (children[path] === undefined && status[path] !== 'loading') loadDir(path);
  };

  const retry = (path: string): void => {
    if (status[path] !== 'loading') loadDir(path);
  };

  /** 深链目标行挂载即滚进可视区（`block:'nearest'` 只在确实看不见时才动，不打断用户视线） */
  const revealRow = (el: HTMLDivElement | null, full: string): void => {
    if (!el || pendingReveal.current !== full) return;
    pendingReveal.current = null;
    el.scrollIntoView({ block: 'nearest' });
  };

  const needle = filter.trim().toLowerCase();
  /** 筛选：名称命中，或（目录）已加载的子孙里有命中 */
  const visible = (full: string, e: FsEntry, seen = 0): boolean => {
    if (!needle || e.name.toLowerCase().includes(needle)) return true;
    if (e.type !== 'dir' || seen > 12) return false;
    return (children[full] ?? []).some((c) => visible(joinChildPath(full, c.name), c, seen + 1));
  };

  const openMenu = (target: TreeRowTarget, anchor: MenuAnchor): void => onRowMenu?.(target, anchor);

  /** 行的公共交互：右键 / Shift+F10 / ContextMenu 键开菜单，Enter 激活 */
  const rowProps = (target: TreeRowTarget, activate: () => void) => ({
    tabIndex: 0,
    role: 'treeitem' as const,
    onContextMenu: onRowMenu
      ? (ev: MouseEvent) => {
          ev.preventDefault();
          openMenu(target, { x: ev.clientX, y: ev.clientY });
        }
      : undefined,
    onKeyDown: (ev: KeyboardEvent) => {
      if (ev.target !== ev.currentTarget) return;
      if (onRowMenu && ((ev.shiftKey && ev.key === 'F10') || ev.key === 'ContextMenu')) {
        ev.preventDefault();
        const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(target, { x: r.left + 24, y: r.bottom });
      } else if (ev.key === 'Enter') {
        ev.preventDefault();
        activate();
      }
    },
  });

  const menuBtn = (target: TreeRowTarget) =>
    onRowMenu && (
      <button
        type="button"
        class="ft-more"
        tabIndex={-1}
        aria-label={tr('ws.moreFor', { name: target.name })}
        title={tr('ws.moreFor', { name: target.name })}
        onClick={(ev) => {
          ev.stopPropagation();
          const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(target, { x: r.left, y: r.bottom + 2 });
        }}
      >
        ⋯
      </button>
    );

  /** 递归渲染某目录的子项（depth 决定缩进） */
  const renderLevel = (dirPath: string, depth: number): preact.JSX.Element => {
    const st = status[dirPath];
    const entries = children[dirPath];
    const pad = { paddingLeft: `${depth * INDENT + 8}px` };

    if (st === 'loading' && entries === undefined) {
      return (
        <div class="ft-hint" style={pad}>
          <Spinner size="sm" /> <span>{tr('ui.loading')}</span>
        </div>
      );
    }
    if (st === 'error' && entries === undefined) {
      return (
        <button class="ft-hint ft-err" style={pad} onClick={() => retry(dirPath)}>
          {tr('ui.loadFailed')}
        </button>
      );
    }
    if (entries === undefined) return <></>; // 尚未触发加载（理论上不会走到）
    if (entries.length === 0) {
      return (
        <div class="ft-hint ft-empty" style={pad}>
          {tr('ui.emptyDirectory')}
        </div>
      );
    }

    return (
      <>
        {entries.map((e) => {
          const full = joinChildPath(dirPath, e.name);
          if (!visible(full, e)) return null;
          if (e.type === 'dir') {
            const isOpen = !!expanded[full] || (!!needle && children[full] !== undefined);
            const target = { path: full, name: e.name, dir: true };
            const activate = (): void => {
              toggleDir(full);
              onSelectDir?.(full);
            };
            return (
              <div key={full}>
                <div
                  class={`ft-row${selectedDir === full ? ' cur' : ''}${e.git === '!' ? ' ignored' : ''}`}
                  style={pad}
                  ref={(el) => revealRow(el, full)}
                  aria-expanded={isOpen}
                  onClick={activate}
                  {...rowProps(target, activate)}
                >
                  <span class={`ft-arrow${isOpen ? ' open' : ''}`}>▸</span>
                  <span class="ft-icon">{treeIcon(e)}</span>
                  <span class="ft-name">{e.name}</span>
                  <GitMark mark={e.git} />
                  {menuBtn(target)}
                </div>
                {isOpen && renderLevel(full, depth + 1)}
              </div>
            );
          }
          const on = selectedPath === full;
          const target = { path: full, name: e.name, dir: false };
          return (
            <div
              key={full}
              class={`ft-row ft-file${on ? ' on' : ''}${e.git === '!' ? ' ignored' : ''}`}
              style={pad}
              ref={(el) => revealRow(el, full)}
              aria-selected={on}
              onClick={() => onSelectFile(full)}
              {...rowProps(target, () => onSelectFile(full))}
            >
              <span class="ft-arrow ft-spacer" />
              <span class="ft-icon">{treeIcon(e)}</span>
              <span class="ft-name">{e.name}</span>
              <GitMark mark={e.git} />
              {git && e.size !== null && e.size >= 1024 * 1024 && <span class="ft-size mut">{fmtSize(e.size)}</span>}
              {menuBtn(target)}
            </div>
          );
        })}
      </>
    );
  };

  return <div class="filetree" role="tree">{renderLevel('', 0)}</div>;
}

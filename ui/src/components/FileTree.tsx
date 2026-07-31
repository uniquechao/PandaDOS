/**
 * FileTree —— 文件页宽屏左栏「可展开文件树」（VSCode 风格）。
 *
 * 按 `/api/projects/:pid/fs?path=` **逐层懒加载**：仅在展开某目录时才拉它的子项（后端已 dir-first 排序）。
 * 状态集中在本组件：children（目录 → 子项缓存）、status（目录 → loading/error）、expanded（已展开目录集）。
 * 递归渲染，按层级缩进；目录行点箭头/整行展开折叠，文件行点击 onSelectFile；选中文件高亮（.on）。
 * 根目录（path=''）首挂载即加载并视为展开；每层各有 加载/空/错误 态。纯逻辑（拼路径/图标）见 lib/filetree。
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../lib/api';
import type { FsEntry, FsList } from '../lib/types';
import { isCurrentTreeRequest, joinChildPath, treeIcon } from '../lib/filetree';
import { Spinner } from './Loaders';

/** 每层缩进像素 */
const INDENT = 14;

export function FileTree({
  pid,
  selectedPath,
  onSelectFile,
  reloadToken,
}: {
  pid: number;
  /** 当前打开的文件相对路径（用于高亮）；null = 未选 */
  selectedPath: string | null;
  /** 点击文件时回调（传相对路径） */
  onSelectFile: (path: string) => void;
  /** 外部变更信号（如上传成功）：变化时重拉所有已加载目录、保留展开态；0/undefined=初始不触发 */
  reloadToken?: number;
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
    api<FsList>(`/api/projects/${pid}/fs?path=${encodeURIComponent(path)}`)
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

  /** 递归渲染某目录的子项（depth 决定缩进） */
  const renderLevel = (dirPath: string, depth: number): preact.JSX.Element => {
    const st = status[dirPath];
    const entries = children[dirPath];
    const pad = { paddingLeft: `${depth * INDENT + 8}px` };

    if (st === 'loading' && entries === undefined) {
      return (
        <div class="ft-hint" style={pad}>
          <Spinner size="sm" /> <span>载入中…</span>
        </div>
      );
    }
    if (st === 'error' && entries === undefined) {
      return (
        <button class="ft-hint ft-err" style={pad} onClick={() => retry(dirPath)}>
          加载失败，点此重试
        </button>
      );
    }
    if (entries === undefined) return <></>; // 尚未触发加载（理论上不会走到）
    if (entries.length === 0) {
      return (
        <div class="ft-hint ft-empty" style={pad}>
          （空目录）
        </div>
      );
    }

    return (
      <>
        {entries.map((e) => {
          const full = joinChildPath(dirPath, e.name);
          if (e.type === 'dir') {
            const isOpen = !!expanded[full];
            return (
              <div key={full}>
                <div class="ft-row" style={pad} onClick={() => toggleDir(full)}>
                  <span class={`ft-arrow${isOpen ? ' open' : ''}`}>▸</span>
                  <span class="ft-icon">{treeIcon(e)}</span>
                  <span class="ft-name">{e.name}</span>
                </div>
                {isOpen && renderLevel(full, depth + 1)}
              </div>
            );
          }
          const on = selectedPath === full;
          return (
            <div
              key={full}
              class={`ft-row ft-file${on ? ' on' : ''}`}
              style={pad}
              onClick={() => onSelectFile(full)}
            >
              <span class="ft-arrow ft-spacer" />
              <span class="ft-icon">{treeIcon(e)}</span>
              <span class="ft-name">{e.name}</span>
            </div>
          );
        })}
      </>
    );
  };

  return <div class="filetree">{renderLevel('', 0)}</div>;
}

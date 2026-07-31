/**
 * ui/lib/changetree —— issue「改动」tab 文件树的纯逻辑（脱离 DOM，可单测）。
 *
 * 把改动文件清单（已提交范围 files / 工作区未提交 worktree）组织成 VSCode / GitHub PR
 * 风格目录树：目录优先 + 字典序；单子目录链压缩成一个节点（'src/web/routes'）；
 * 目录聚合叶子文件数与增删行合计。worktree porcelain 两列码在这里按路径去重归一成
 * 单字母展示码（同一文件不再拆「已暂存/未暂存」两行）。展开/选中等有状态逻辑留在渲染组件。
 */
import type { GitChange } from './types';

/** 树叶子（一份改动文件）：调用方从 range 文件 / worktree 改动映射而来 */
export interface ChangeLeaf {
  /** 稳定选中键（调用方生成，如 'range:src/a.ts' / 'wt:src/a.ts'） */
  key: string;
  path: string;
  oldPath?: string;
  /** 单字母状态码（A/M/D/R/C/T/U/?） */
  code: string;
  /** 增删行（range 文件有；null=二进制；worktree 无） */
  adds?: number | null;
  dels?: number | null;
}

export interface ChangeFileNode {
  type: 'file';
  /** 文件名（basename） */
  name: string;
  leaf: ChangeLeaf;
}

export interface ChangeDirNode {
  type: 'dir';
  /** 显示名：单子目录链压缩后的整段（如 'src/web/routes'） */
  name: string;
  /** 完整目录路径（压缩链的最深一级；展开态键用） */
  path: string;
  /** 子节点：目录在前、文件在后，各按名字典序 */
  children: ChangeNode[];
  /** 聚合：子树叶子文件数 */
  files: number;
  /** 聚合：子树增删行合计（二进制 null 不计入） */
  adds: number;
  dels: number;
}

export type ChangeNode = ChangeDirNode | ChangeFileNode;

/** 构树中间态（可变，finalize 后转只读节点） */
interface DirBuilder {
  name: string;
  path: string;
  dirs: Map<string, DirBuilder>;
  files: ChangeFileNode[];
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * 收敛一个目录：单子目录链压缩（自身无文件且仅一个子目录 → 并入，名字拼链）、
 * 递归收敛子目录、目录前文件后各排序、聚合文件数/增删行。
 */
function finalize(b: DirBuilder): ChangeDirNode {
  let cur = b;
  let name = b.name;
  while (cur.files.length === 0 && cur.dirs.size === 1) {
    const child = cur.dirs.values().next().value as DirBuilder;
    name = `${name}/${child.name}`;
    cur = child;
  }
  const dirs = [...cur.dirs.values()].map(finalize).sort(byName);
  const files = [...cur.files].sort(byName);
  let filesN = files.length;
  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.leaf.adds ?? 0;
    dels += f.leaf.dels ?? 0;
  }
  for (const d of dirs) {
    filesN += d.files;
    adds += d.adds;
    dels += d.dels;
  }
  return { type: 'dir', name, path: cur.path, children: [...dirs, ...files], files: filesN, adds, dels };
}

/**
 * 改动文件叶子列表 → 顶层节点列表（目录在前、文件在后，各按名字典序）。
 * 顶层单链目录同样压缩（全部改动集中在 'src/web/routes' 时顶层就一个链节点）。
 */
export function buildChangeTree(leaves: ChangeLeaf[]): ChangeNode[] {
  const root: DirBuilder = { name: '', path: '', dirs: new Map(), files: [] };
  for (const leaf of leaves) {
    const segs = leaf.path.split('/').filter(Boolean);
    const base = segs.pop() ?? leaf.path;
    let cur = root;
    let acc = '';
    for (const s of segs) {
      acc = acc ? `${acc}/${s}` : s;
      let next = cur.dirs.get(s);
      if (!next) {
        next = { name: s, path: acc, dirs: new Map(), files: [] };
        cur.dirs.set(s, next);
      }
      cur = next;
    }
    cur.files.push({ type: 'file', name: base, leaf });
  }
  const dirs = [...root.dirs.values()].map(finalize).sort(byName);
  const files = [...root.files].sort(byName);
  return [...dirs, ...files];
}

// ---------- worktree 两列码归一 ----------

/** 工作区一份改动文件（按路径去重后的展示视角） */
export interface WtFileChange {
  path: string;
  oldPath?: string;
  /** 展示单字母码：'??'→'?'；其余取暂存列，暂存列为空取工作区列 */
  code: string;
  /** 未跟踪文件（diff 需走 untracked=1 的 /dev/null 基线） */
  untracked: boolean;
}

/**
 * porcelain v1 两列码 → 每路径一条展示记录。与 Git 页 WtGroups 的「同一文件拆
 * 已暂存/未暂存两行」不同：issue 改动树是「这个 issue 摸了哪些文件」视角，
 * 暂存与否是执行细节（diff 端点本就回 HEAD 基线的暂存+未暂存合并 diff）。
 */
export function dedupWorktree(changes: GitChange[]): WtFileChange[] {
  const out: WtFileChange[] = [];
  const seen = new Set<string>();
  for (const c of changes) {
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    const rec: WtFileChange = { path: c.path, code: 'M', untracked: c.status === '??' };
    if (c.oldPath) rec.oldPath = c.oldPath;
    if (c.status === '??') {
      rec.code = '?';
    } else {
      const x = c.status[0] ?? ' ';
      const y = c.status[1] ?? ' ';
      rec.code = x !== ' ' ? x : y !== ' ' ? y : 'M';
    }
    out.push(rec);
  }
  return out;
}

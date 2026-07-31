/**
 * Git 工作区视图的纯状态与树数据模型。
 *
 * 视图来源和右侧内容选择分别表达、由 reducer 联动：
 * - all：项目完整文件树（由 FileTree 逐层懒加载）
 * - worktree：当前未提交改动
 * - commit：某条提交的改动
 *
 * 页面刷新通过 refreshToken 驱动数据重拉，不重置用户正在查看的来源或内容。
 * 组件层只负责请求与渲染，来源切换、互斥选择和改动叶子归一都收敛在这里。
 */
import { buildChangeTree, dedupWorktree, type ChangeLeaf, type ChangeNode } from './changetree';
import type { GitChange, GitCommitDetail, GitFile } from './types';

export type GitWorkspaceSource =
  | { kind: 'all' }
  | { kind: 'worktree' }
  | { kind: 'commit'; sha: string };

/** 完整文件树的文件选择；path 可直接交给 FileViewer。 */
export interface GitWorkspaceAllFile {
  kind: 'all';
  key: string;
  path: string;
}

/** 当前工作区改动选择；完整叶子保留 rename/untracked diff 所需元数据。 */
export interface GitWorkspaceWorktreeFile {
  kind: 'worktree';
  leaf: ChangeLeaf;
}

/** commit 改动选择；sha 与叶子共同确定 diff 端点。 */
export interface GitWorkspaceCommitFile {
  kind: 'commit';
  sha: string;
  leaf: ChangeLeaf;
}

export type GitWorkspaceFile =
  | GitWorkspaceAllFile
  | GitWorkspaceWorktreeFile
  | GitWorkspaceCommitFile;

interface GitWorkspaceStateBase {
  refreshToken: number;
}

type FileContent<T extends GitWorkspaceFile> = { kind: 'file'; file: T };

/** 判别联合排除“文件与 commit 详情同时打开”及非 commit 来源打开详情。 */
export type GitWorkspaceState =
  | (GitWorkspaceStateBase & {
      source: { kind: 'all' };
      content: FileContent<GitWorkspaceAllFile> | null;
    })
  | (GitWorkspaceStateBase & {
      source: { kind: 'worktree' };
      content: FileContent<GitWorkspaceWorktreeFile> | null;
    })
  | (GitWorkspaceStateBase & {
      source: { kind: 'commit'; sha: string };
      content:
        | FileContent<GitWorkspaceCommitFile>
        | { kind: 'commit-detail'; sha: string }
        | null;
    });

export type GitWorkspaceAction =
  | { type: 'reset' }
  | { type: 'show-all' }
  | { type: 'show-worktree' }
  | { type: 'select-commit'; sha: string }
  | { type: 'select-file'; file: GitWorkspaceFile }
  | { type: 'open-commit-detail'; sha: string }
  | { type: 'close-content' }
  | { type: 'refresh' };

export function createGitWorkspaceState(): GitWorkspaceState {
  return {
    source: { kind: 'all' },
    content: null,
    refreshToken: 0,
  };
}

function switchSource(state: GitWorkspaceState, source: GitWorkspaceSource): GitWorkspaceState {
  if (
    state.source.kind === source.kind
    && (state.source.kind !== 'commit'
      || (source.kind === 'commit' && state.source.sha === source.sha))
  ) {
    return state;
  }
  if (source.kind === 'all') {
    return { source, content: null, refreshToken: state.refreshToken };
  }
  if (source.kind === 'worktree') {
    return { source, content: null, refreshToken: state.refreshToken };
  }
  return { source, content: null, refreshToken: state.refreshToken };
}

export function gitWorkspaceReducer(
  state: GitWorkspaceState,
  action: GitWorkspaceAction,
): GitWorkspaceState {
  switch (action.type) {
    case 'reset':
      return createGitWorkspaceState();
    case 'show-all':
      return switchSource(state, { kind: 'all' });
    case 'show-worktree':
      return switchSource(state, { kind: 'worktree' });
    case 'select-commit':
      return switchSource(state, { kind: 'commit', sha: action.sha });
    case 'select-file':
      if (action.file.kind === 'all') {
        return {
          source: { kind: 'all' },
          content: { kind: 'file', file: action.file },
          refreshToken: state.refreshToken,
        };
      }
      if (action.file.kind === 'worktree') {
        return {
          source: { kind: 'worktree' },
          content: { kind: 'file', file: action.file },
          refreshToken: state.refreshToken,
        };
      }
      return {
        source: { kind: 'commit', sha: action.file.sha },
        content: { kind: 'file', file: action.file },
        refreshToken: state.refreshToken,
      };
    case 'open-commit-detail':
      return {
        source: { kind: 'commit', sha: action.sha },
        content: { kind: 'commit-detail', sha: action.sha },
        refreshToken: state.refreshToken,
      };
    case 'close-content':
      return {
        ...state,
        content: null,
      };
    case 'refresh':
      return {
        ...state,
        refreshToken: state.refreshToken + 1,
      };
  }
}

/** 完整文件树由现有 FileTree 懒加载，因此这里只声明来源，不复制一棵不完整的树。 */
export interface GitWorkspaceAllTree {
  kind: 'all';
  treeKind: 'filesystem';
}

interface GitWorkspaceChangeTreeBase {
  treeKind: 'changes';
  leaves: ChangeLeaf[];
  nodes: ChangeNode[];
}

export interface GitWorkspaceWorktreeTree extends GitWorkspaceChangeTreeBase {
  kind: 'worktree';
}

export interface GitWorkspaceCommitTree extends GitWorkspaceChangeTreeBase {
  kind: 'commit';
  sha: string;
  /** false 表示对应 sha 的详情已载入；空 leaves 此时表示该提交确实无文件。 */
  loading: boolean;
}

export type GitWorkspaceTree =
  | GitWorkspaceAllTree
  | GitWorkspaceWorktreeTree
  | GitWorkspaceCommitTree;

export interface GitWorkspaceTreeInput {
  worktree?: GitChange[];
  /** 允许直接传 GitCommitDetail，也允许请求层只保留本模型所需字段。 */
  commit?: Pick<GitCommitDetail, 'sha' | 'files'> | null;
}

function worktreeLeaves(changes: GitChange[]): ChangeLeaf[] {
  return dedupWorktree(changes).map((change) => {
    const leaf: ChangeLeaf = {
      key: `worktree:${change.path}`,
      path: change.path,
      code: change.code,
    };
    if (change.oldPath) leaf.oldPath = change.oldPath;
    return leaf;
  });
}

function commitLeaves(sha: string, files: GitFile[]): ChangeLeaf[] {
  return files.map((file) => {
    const leaf: ChangeLeaf = {
      key: `commit:${sha}:${file.path}`,
      path: file.path,
      code: file.status[0] ?? 'M',
      adds: file.adds,
      dels: file.dels,
    };
    if (file.oldPath) leaf.oldPath = file.oldPath;
    return leaf;
  });
}

export function buildGitWorkspaceTree(
  source: GitWorkspaceSource,
  input: GitWorkspaceTreeInput,
): GitWorkspaceTree {
  if (source.kind === 'all') return { kind: 'all', treeKind: 'filesystem' };

  if (source.kind === 'worktree') {
    const leaves = worktreeLeaves(input.worktree ?? []);
    return {
      kind: 'worktree',
      treeKind: 'changes',
      leaves,
      nodes: buildChangeTree(leaves),
    };
  }

  const loaded = input.commit?.sha === source.sha;
  const leaves = loaded ? commitLeaves(source.sha, input.commit?.files ?? []) : [];
  return {
    kind: 'commit',
    treeKind: 'changes',
    sha: source.sha,
    loading: !loaded,
    leaves,
    nodes: buildChangeTree(leaves),
  };
}

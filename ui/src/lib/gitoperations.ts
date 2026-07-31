/**
 * Git 页面手动写操作的纯模型：
 * - 从 porcelain v1 的 XY 状态派生每个文件可用的 stage/unstage 动作；
 * - 重命名同时携带旧、新路径，避免逐文件 pathspec 只处理半边；
 * - 单飞门闩在 React 状态更新前同步占位，拦住同一事件循环内的重复点击。
 */
import type { GitChange } from './types';

export interface GitFileOperation {
  path: string;
  /** 直接传给 stage/unstage 接口；重命名包含 oldPath 与 path。 */
  paths: string[];
  staged: boolean;
  unstaged: boolean;
}

export type GitFileOperations = Record<string, GitFileOperation>;

function addUnique(paths: string[], path: string | undefined): void {
  if (path && !paths.includes(path)) paths.push(path);
}

/** 同一路径若出现多条状态，合并可用动作而不是让后一条覆盖前一条。 */
export function deriveGitFileOperations(changes: GitChange[]): GitFileOperations {
  const operations: GitFileOperations = Object.create(null) as GitFileOperations;
  for (const change of changes) {
    const current = operations[change.path] ?? {
      path: change.path,
      paths: [],
      staged: false,
      unstaged: false,
    };
    // rename 的旧路径已消失，pathspec 必须同时覆盖旧、新路径；copy 的源文件仍存在，
    // 一并传入会把用户没有选择的源文件也 stage/unstage。
    if (change.status.includes('R')) addUnique(current.paths, change.oldPath);
    addUnique(current.paths, change.path);
    if (change.status === '??') {
      current.unstaged = true;
    } else {
      current.staged ||= (change.status[0] ?? ' ') !== ' ';
      current.unstaged ||= (change.status[1] ?? ' ') !== ' ';
    }
    operations[change.path] = current;
  }
  return operations;
}

export type GitOperationKind =
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'push'
  | 'generate-message';

export type GitOperationRun<T> =
  | { started: false }
  | { started: true; value: T };

/** fetch 成功不代表 Git 操作成功：repoCtx 的预期态会以 HTTP 200 + ok:false 返回。 */
export function requireGitOperationSuccess<T extends { ok: boolean; error?: string }>(
  result: T,
): T & { ok: true } {
  if (!result.ok) throw new Error(result.error?.trim() || 'Git 操作失败');
  return result as T & { ok: true };
}

export interface GitOperationGuard {
  active: () => GitOperationKind | null;
  run: <T>(
    operation: GitOperationKind,
    task: () => Promise<T>,
  ) => Promise<GitOperationRun<T>>;
}

/**
 * 一次只允许一个 Git/AI 操作。active 在 task 启动前同步写入，不能只依赖异步 UI state。
 */
export function createGitOperationGuard(
  onChange: (operation: GitOperationKind | null) => void,
): GitOperationGuard {
  let active: GitOperationKind | null = null;
  return {
    active: () => active,
    run: async <T>(
      operation: GitOperationKind,
      task: () => Promise<T>,
    ): Promise<GitOperationRun<T>> => {
      if (active !== null) return { started: false };
      active = operation;
      onChange(operation);
      try {
        return { started: true, value: await task() };
      } finally {
        active = null;
        onChange(null);
      }
    },
  };
}

export interface GitOperationToken {
  pid: number;
  generation: number;
}

export interface GitOperationCoordinator {
  /** 每次真实项目切换都产生新 generation；同项目重渲染复用 token。 */
  enter: (pid: number) => GitOperationToken;
  isCurrent: (token: GitOperationToken) => boolean;
  /** 忙碌态按 pid 保留，所以 A→B→A 不能绕过尚未完成的 A 操作。 */
  active: (pid: number) => GitOperationKind | null;
  run: <T>(
    token: GitOperationToken,
    operation: GitOperationKind,
    task: () => Promise<T>,
  ) => Promise<GitOperationRun<T>>;
}

function sameToken(a: GitOperationToken | null, b: GitOperationToken): boolean {
  return a?.pid === b.pid && a.generation === b.generation;
}

/**
 * 页面跨项目生命周期协调器。
 *
 * guardsByPid 在项目离开期间仍保留；generation 则识别 A→B→A 的 ABA 场景，
 * 让旧 A 请求可以正常收尾但不能覆盖新 A 页面、弹成功提示或触发刷新。
 */
export function createGitOperationCoordinator(onChange: () => void): GitOperationCoordinator {
  let current: GitOperationToken | null = null;
  let nextGeneration = 0;
  const guardsByPid = new Map<number, GitOperationGuard>();

  const isCurrent = (token: GitOperationToken): boolean => sameToken(current, token);
  const guardFor = (pid: number): GitOperationGuard => {
    let guard = guardsByPid.get(pid);
    if (!guard) {
      guard = createGitOperationGuard(() => onChange());
      guardsByPid.set(pid, guard);
    }
    return guard;
  };

  return {
    enter(pid) {
      if (current?.pid !== pid) {
        current = { pid, generation: ++nextGeneration };
      }
      return current;
    },
    isCurrent,
    active(pid) {
      return guardsByPid.get(pid)?.active() ?? null;
    },
    async run<T>(
      token: GitOperationToken,
      operation: GitOperationKind,
      task: () => Promise<T>,
    ): Promise<GitOperationRun<T>> {
      if (!isCurrent(token)) return { started: false };
      return guardFor(token.pid).run(operation, task);
    },
  };
}

import type { GitBranches } from './types';

export interface IssueGitBranchValue {
  targetBranch: string;
  sourceRef: string;
}

function defaultSourceRef(branches: GitBranches): string {
  return branches.local.find((branch) => branch.name === branches.current)?.ref
    ?? branches.local[0]?.ref
    ?? branches.remote[0]?.ref
    ?? '';
}

/** 只有非空目标与当前分支不同时，才需要展示“从哪里创建/切换”的源引用。 */
export function targetNeedsSourceRef(targetBranch: string, currentBranch: string): boolean {
  const target = targetBranch.trim();
  return target !== '' && target !== currentBranch;
}

/**
 * 分支清单迟到时初始化表单：
 * - 未触碰的空目标默认当前分支；
 * - 用户已在加载期间手填新目标时补上默认源；
 * - pending 已持久化的目标/源保持原样。
 */
export function initializeIssueGitBranchValue(
  value: IssueGitBranchValue,
  branches: GitBranches,
  targetTouched: boolean,
): IssueGitBranchValue {
  if (!targetTouched && value.targetBranch.trim() === '') {
    return { targetBranch: branches.current, sourceRef: value.sourceRef };
  }
  if (
    targetTouched
    && targetNeedsSourceRef(value.targetBranch, branches.current)
    && value.sourceRef.trim() === ''
  ) {
    return { ...value, sourceRef: defaultSourceRef(branches) };
  }
  return value;
}

/** 用户改目标时同步维护源：离开当前分支补默认源，回到当前/清空目标则清源。 */
export function changeIssueTargetBranch(
  value: IssueGitBranchValue,
  targetBranch: string,
  branches: GitBranches | null,
): IssueGitBranchValue {
  const current = branches?.current ?? '';
  if (targetBranch.trim() === '' || branches && !targetNeedsSourceRef(targetBranch, current)) {
    return { targetBranch, sourceRef: '' };
  }
  if (value.sourceRef.trim() !== '') return { ...value, targetBranch };
  return {
    targetBranch,
    sourceRef: branches ? defaultSourceRef(branches) : '',
  };
}

/** 创建/PATCH 共用的 API 载荷规范化；无目标时源必须同步清空。 */
export function issueGitBranchPayload(value: IssueGitBranchValue): {
  targetBranch: string | null;
  sourceRef: string | null;
} {
  const targetBranch = value.targetBranch.trim();
  if (!targetBranch) return { targetBranch: null, sourceRef: null };
  return {
    targetBranch,
    sourceRef: value.sourceRef.trim() || null,
  };
}

/** 详情页保留本地/远程来源语义，同时避免向用户暴露冗长 refs 前缀。 */
export function formatIssueSourceRef(sourceRef: string | null): string {
  if (!sourceRef) return '未指定';
  if (sourceRef.startsWith('refs/heads/')) {
    return `${sourceRef.slice('refs/heads/'.length)}（本地）`;
  }
  if (sourceRef.startsWith('refs/remotes/')) {
    return `${sourceRef.slice('refs/remotes/'.length)}（远程）`;
  }
  return sourceRef;
}

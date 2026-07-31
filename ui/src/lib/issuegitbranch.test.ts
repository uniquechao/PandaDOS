import { describe, expect, test } from 'bun:test';
import type { GitBranches } from './types';
import {
  changeIssueTargetBranch,
  formatIssueSourceRef,
  initializeIssueGitBranchValue,
  issueGitBranchPayload,
  targetNeedsSourceRef,
  type IssueGitBranchValue,
} from './issuegitbranch';

const branches: GitBranches = {
  ok: true,
  cwd: '/repo',
  current: 'main',
  local: [
    { name: 'feature/existing', ref: 'refs/heads/feature/existing' },
    { name: 'main', ref: 'refs/heads/main' },
  ],
  remote: [
    { name: 'origin/main', ref: 'refs/remotes/origin/main' },
    { name: 'upstream/release', ref: 'refs/remotes/upstream/release' },
  ],
};

describe('issue Git 分支表单模型', () => {
  test('新建和历史空配置在分支清单返回后默认填充当前分支，不额外设置源', () => {
    expect(initializeIssueGitBranchValue(
      { targetBranch: '', sourceRef: '' },
      branches,
      false,
    )).toEqual({
      targetBranch: 'main',
      sourceRef: '',
    });
  });

  test('目标改成其他分支时默认选当前本地 ref，改回当前分支时清空源', () => {
    const initial: IssueGitBranchValue = { targetBranch: 'main', sourceRef: '' };
    const changed = changeIssueTargetBranch(initial, 'feature/new', branches);
    expect(changed).toEqual({
      targetBranch: 'feature/new',
      sourceRef: 'refs/heads/main',
    });
    expect(targetNeedsSourceRef(changed.targetBranch, branches.current)).toBe(true);

    expect(changeIssueTargetBranch(changed, 'main', branches)).toEqual({
      targetBranch: 'main',
      sourceRef: '',
    });
    expect(targetNeedsSourceRef('main', branches.current)).toBe(false);
  });

  test('用户在清单返回前手填目标，加载完成后补默认源但不覆盖目标', () => {
    expect(initializeIssueGitBranchValue(
      { targetBranch: 'hotfix/manual', sourceRef: '' },
      branches,
      true,
    )).toEqual({
      targetBranch: 'hotfix/manual',
      sourceRef: 'refs/heads/main',
    });
  });

  test('pending 已保存的目标/源保持原值，目标再次变化时保留有效的源选择', () => {
    const saved: IssueGitBranchValue = {
      targetBranch: 'release/next',
      sourceRef: 'refs/remotes/upstream/release',
    };
    expect(initializeIssueGitBranchValue(saved, branches, false)).toEqual(saved);
    expect(changeIssueTargetBranch(saved, 'release/later', branches)).toEqual({
      targetBranch: 'release/later',
      sourceRef: 'refs/remotes/upstream/release',
    });
  });

  test('提交前 trim；空目标同步清空源并映射为 null', () => {
    expect(issueGitBranchPayload({
      targetBranch: '  feature/new  ',
      sourceRef: '  refs/remotes/origin/main  ',
    })).toEqual({
      targetBranch: 'feature/new',
      sourceRef: 'refs/remotes/origin/main',
    });
    expect(issueGitBranchPayload({
      targetBranch: '  ',
      sourceRef: 'refs/heads/main',
    })).toEqual({
      targetBranch: null,
      sourceRef: null,
    });
  });

  test('详情回显把完整 ref 转为带来源类型的可读名称，未知值不丢失', () => {
    expect(formatIssueSourceRef('refs/heads/main')).toBe('main（本地）');
    expect(formatIssueSourceRef('refs/remotes/origin/main')).toBe('origin/main（远程）');
    expect(formatIssueSourceRef('legacy/value')).toBe('legacy/value');
    expect(formatIssueSourceRef(null)).toBe('未指定');
  });
});

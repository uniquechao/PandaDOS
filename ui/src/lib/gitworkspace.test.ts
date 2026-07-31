import { describe, expect, test } from 'bun:test';
import {
  buildGitWorkspaceTree,
  createGitWorkspaceState,
  gitWorkspaceReducer,
} from './gitworkspace';

describe('Git 工作区视图状态', () => {
  test('默认展示全部文件；切换全部/未提交来源会清空旧内容选择', () => {
    const initial = createGitWorkspaceState();
    expect(initial).toEqual({
      source: { kind: 'all' },
      content: null,
      refreshToken: 0,
    });

    const selected = gitWorkspaceReducer(initial, {
      type: 'select-file',
      file: { kind: 'all', key: 'all:README.md', path: 'README.md' },
    });
    const worktree = gitWorkspaceReducer(selected, { type: 'show-worktree' });
    expect(worktree.source).toEqual({ kind: 'worktree' });
    expect(worktree.content).toBeNull();

    expect(gitWorkspaceReducer(worktree, { type: 'show-all' }).source).toEqual({ kind: 'all' });
  });

  test('选择 commit 会把树切到该 commit，并清空上一文件与详情', () => {
    const worktree = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'select-file',
      file: {
        kind: 'worktree',
        leaf: { key: 'worktree:a.ts', path: 'a.ts', code: 'M' },
      },
    });

    expect(gitWorkspaceReducer(worktree, { type: 'select-commit', sha: 'abc123' })).toEqual({
      source: { kind: 'commit', sha: 'abc123' },
      content: null,
      refreshToken: 0,
    });
  });

  test('文件选择保留来源与完整 diff 元数据，并自动对齐树来源', () => {
    const worktree = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'select-file',
      file: {
        kind: 'worktree',
        leaf: {
          key: 'worktree:src/new.ts',
          path: 'src/new.ts',
          oldPath: 'src/old.ts',
          code: 'R',
        },
      },
    });
    expect(worktree).toEqual({
      source: { kind: 'worktree' },
      content: {
        kind: 'file',
        file: {
          kind: 'worktree',
          leaf: {
            key: 'worktree:src/new.ts',
            path: 'src/new.ts',
            oldPath: 'src/old.ts',
            code: 'R',
          },
        },
      },
      refreshToken: 0,
    });

    const commit = gitWorkspaceReducer(worktree, {
      type: 'select-file',
      file: {
        kind: 'commit',
        sha: 'abc123',
        leaf: { key: 'commit:abc123:new.txt', path: 'new.txt', code: '?' },
      },
    });
    expect(commit.source).toEqual({ kind: 'commit', sha: 'abc123' });
    expect(commit.content).toMatchObject({
      kind: 'file',
      file: { kind: 'commit', sha: 'abc123', leaf: { path: 'new.txt', code: '?' } },
    });
  });

  test('选择文件与打开 commit 详情互斥，详情按钮同时对齐 commit 树来源', () => {
    const detail = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'open-commit-detail',
      sha: 'abc123',
    });
    expect(detail.source).toEqual({ kind: 'commit', sha: 'abc123' });
    expect(detail.content).toEqual({ kind: 'commit-detail', sha: 'abc123' });

    const file = gitWorkspaceReducer(detail, {
      type: 'select-file',
      file: {
        kind: 'commit',
        sha: 'abc123',
        leaf: { key: 'commit:abc123:src/a.ts', path: 'src/a.ts', code: 'M' },
      },
    });
    expect(file.content).toEqual({
      kind: 'file',
      file: {
        kind: 'commit',
        sha: 'abc123',
        leaf: { key: 'commit:abc123:src/a.ts', path: 'src/a.ts', code: 'M' },
      },
    });
  });

  test('刷新只更新数据代次，保持来源、文件选择和 commit 详情一致', () => {
    const fileState = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'select-file',
      file: {
        kind: 'commit',
        sha: 'abc123',
        leaf: { key: 'commit:abc123:src/a.ts', path: 'src/a.ts', code: 'M' },
      },
    });
    expect(gitWorkspaceReducer(fileState, { type: 'refresh' })).toEqual({
      ...fileState,
      refreshToken: 1,
    });

    const detailState = gitWorkspaceReducer(fileState, {
      type: 'open-commit-detail',
      sha: 'abc123',
    });
    expect(gitWorkspaceReducer(detailState, { type: 'refresh' })).toEqual({
      ...detailState,
      refreshToken: 1,
    });
  });

  test('关闭右侧内容只清选择，不改变当前树来源', () => {
    const state = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'open-commit-detail',
      sha: 'abc123',
    });
    expect(gitWorkspaceReducer(state, { type: 'close-content' })).toEqual({
      ...state,
      content: null,
    });
  });

  test('重复选择当前来源不关闭正在查看的文件或 commit 详情', () => {
    const file = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'select-file',
      file: {
        kind: 'worktree',
        leaf: { key: 'worktree:a.ts', path: 'a.ts', code: 'M' },
      },
    });
    expect(gitWorkspaceReducer(file, { type: 'show-worktree' })).toBe(file);

    const detail = gitWorkspaceReducer(file, {
      type: 'open-commit-detail',
      sha: 'abc123',
    });
    expect(gitWorkspaceReducer(detail, { type: 'select-commit', sha: 'abc123' })).toBe(detail);
  });

  test('项目切换显式 reset：恢复全部文件并清空内容与刷新代次', () => {
    const detail = gitWorkspaceReducer(createGitWorkspaceState(), {
      type: 'open-commit-detail',
      sha: 'abc123',
    });
    const refreshed = gitWorkspaceReducer(detail, { type: 'refresh' });

    expect(gitWorkspaceReducer(refreshed, { type: 'reset' })).toEqual(
      createGitWorkspaceState(),
    );
  });
});

describe('Git 工作区树数据模型', () => {
  test('全部文件来源由懒加载文件树承载，不伪造改动叶子', () => {
    expect(buildGitWorkspaceTree({ kind: 'all' }, {})).toEqual({
      kind: 'all',
      treeKind: 'filesystem',
    });
  });

  test('未提交来源按路径去重并生成稳定叶子与目录树', () => {
    const tree = buildGitWorkspaceTree(
      { kind: 'worktree' },
      {
        worktree: [
          { status: 'MM', path: 'src/a.ts' },
          { status: ' M', path: 'src/a.ts' },
          { status: '??', path: 'README.md' },
        ],
      },
    );
    expect(tree.kind).toBe('worktree');
    if (tree.kind !== 'worktree') throw new Error('unexpected tree kind');
    expect(tree.treeKind).toBe('changes');
    expect(tree.leaves).toEqual([
      { key: 'worktree:src/a.ts', path: 'src/a.ts', code: 'M' },
      { key: 'worktree:README.md', path: 'README.md', code: '?' },
    ]);
    expect(tree.nodes.map((node) => [node.type, node.name])).toEqual([
      ['dir', 'src'],
      ['file', 'README.md'],
    ]);
  });

  test('commit 来源保留状态、重命名和增删行，并用 sha 隔离选择键', () => {
    const tree = buildGitWorkspaceTree(
      { kind: 'commit', sha: 'abc123' },
      {
        commit: {
          sha: 'abc123',
          files: [
            {
              status: 'R100',
              path: 'src/new.ts',
              oldPath: 'src/old.ts',
              adds: 3,
              dels: 1,
            },
          ],
        },
      },
    );
    expect(tree.kind).toBe('commit');
    if (tree.kind !== 'commit') throw new Error('unexpected tree kind');
    expect(tree.sha).toBe('abc123');
    expect(tree.loading).toBe(false);
    expect(tree.leaves).toEqual([
      {
        key: 'commit:abc123:src/new.ts',
        path: 'src/new.ts',
        oldPath: 'src/old.ts',
        code: 'R',
        adds: 3,
        dels: 1,
      },
    ]);
    expect(tree.nodes).toHaveLength(1);
  });

  test('commit 详情尚未载入或不是当前 sha 时保留来源并标记 loading', () => {
    const missing = buildGitWorkspaceTree({ kind: 'commit', sha: 'abc123' }, {});
    expect(missing).toMatchObject({
      kind: 'commit',
      treeKind: 'changes',
      sha: 'abc123',
      loading: true,
      leaves: [],
      nodes: [],
    });

    const stale = buildGitWorkspaceTree(
      { kind: 'commit', sha: 'abc123' },
      { commit: { sha: 'older', files: [] } },
    );
    expect(stale.kind === 'commit' && stale.loading).toBe(true);
  });
});

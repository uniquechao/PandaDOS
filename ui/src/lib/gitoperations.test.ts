import { describe, expect, test } from 'bun:test';
import {
  createGitOperationCoordinator,
  createGitOperationGuard,
  deriveGitFileOperations,
  requireGitOperationSuccess,
  type GitOperationKind,
} from './gitoperations';

describe('Git 文件写操作模型', () => {
  test('按 porcelain XY 两列区分已暂存与未暂存，同一文件可同时提供两种操作', () => {
    expect(deriveGitFileOperations([
      { status: 'MM', path: 'both.ts' },
      { status: ' M', path: 'worktree.ts' },
      { status: 'A ', path: 'index.ts' },
      { status: '??', path: 'new.ts' },
    ])).toEqual({
      'both.ts': {
        path: 'both.ts',
        paths: ['both.ts'],
        staged: true,
        unstaged: true,
      },
      'worktree.ts': {
        path: 'worktree.ts',
        paths: ['worktree.ts'],
        staged: false,
        unstaged: true,
      },
      'index.ts': {
        path: 'index.ts',
        paths: ['index.ts'],
        staged: true,
        unstaged: false,
      },
      'new.ts': {
        path: 'new.ts',
        paths: ['new.ts'],
        staged: false,
        unstaged: true,
      },
    });
  });

  test('重命名的逐文件操作同时携带旧、新路径，重复状态按路径合并', () => {
    expect(deriveGitFileOperations([
      { status: 'R ', path: 'src/new.ts', oldPath: 'src/old.ts' },
      { status: ' M', path: 'src/new.ts', oldPath: 'src/old.ts' },
    ])).toEqual({
      'src/new.ts': {
        path: 'src/new.ts',
        paths: ['src/old.ts', 'src/new.ts'],
        staged: true,
        unstaged: true,
      },
    });
  });

  test('复制状态只操作当前路径，不能把仍存在的源文件一起加入 pathspec', () => {
    expect(deriveGitFileOperations([
      { status: 'C ', path: 'src/copy.ts', oldPath: 'src/source.ts' },
    ])).toEqual({
      'src/copy.ts': {
        path: 'src/copy.ts',
        paths: ['src/copy.ts'],
        staged: true,
        unstaged: false,
      },
    });
  });

  test('合法文件名 __proto__ 不会命中对象原型或让动作派生崩溃', () => {
    const operations = deriveGitFileOperations([{ status: ' M', path: '__proto__' }]);
    expect(operations.__proto__).toEqual({
      path: '__proto__',
      paths: ['__proto__'],
      staged: false,
      unstaged: true,
    });
  });
});

describe('Git 写操作响应校验', () => {
  test('HTTP 200 内的 ok:false 仍按失败抛出后端错误，不能进入成功提示', () => {
    expect(() => requireGitOperationSuccess({
      ok: false,
      error: '非 git 仓库',
    })).toThrow('非 git 仓库');
    expect(requireGitOperationSuccess({ ok: true, short: 'abc1234' }))
      .toEqual({ ok: true, short: 'abc1234' });
  });
});

describe('Git 写操作防重复门闩', () => {
  test('已有操作未完成时拒绝第二次启动，并向 UI 发布忙碌态', async () => {
    const states: Array<GitOperationKind | null> = [];
    const guard = createGitOperationGuard((operation) => states.push(operation));
    let finish!: (value: string) => void;
    const first = guard.run('commit', () => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    expect(guard.active()).toBe('commit');
    expect(await guard.run('push', async () => 'duplicate')).toEqual({ started: false });

    finish('ok');
    expect(await first).toEqual({ started: true, value: 'ok' });
    expect(guard.active()).toBeNull();
    expect(states).toEqual(['commit', null]);
  });

  test('请求失败也释放门闩，后续操作仍可启动', async () => {
    const guard = createGitOperationGuard(() => {});
    await expect(guard.run('stage', async () => {
      throw new Error('stage failed');
    })).rejects.toThrow('stage failed');

    expect(guard.active()).toBeNull();
    expect(await guard.run('unstage', async () => 1)).toEqual({ started: true, value: 1 });
  });
});

describe('Git 页面项目生命周期协调器', () => {
  test('A→B→A 时保留 A 的在途门闩，并将旧 A 结果标记为过期', async () => {
    const coordinator = createGitOperationCoordinator(() => {});
    const firstA = coordinator.enter(1);
    let finish!: (value: string) => void;
    const first = coordinator.run(firstA, 'commit', () => new Promise<string>((resolve) => {
      finish = resolve;
    }));

    coordinator.enter(2);
    const secondA = coordinator.enter(1);
    expect(secondA.generation).not.toBe(firstA.generation);
    expect(coordinator.active(1)).toBe('commit');
    expect(await coordinator.run(secondA, 'push', async () => 'duplicate'))
      .toEqual({ started: false });

    finish('old result');
    expect(await first).toEqual({ started: true, value: 'old result' });
    expect(coordinator.isCurrent(firstA)).toBe(false);
    expect(coordinator.isCurrent(secondA)).toBe(true);
    expect(coordinator.active(1)).toBeNull();
    expect(await coordinator.run(secondA, 'push', async () => 'new result'))
      .toEqual({ started: true, value: 'new result' });
  });
});

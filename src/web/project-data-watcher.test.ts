/**
 * web/project-data-watcher 单测 —— `.panda` 事件驱动同步。
 *
 * 守两条底线：能改到的文件必须触发同步（不然记忆更新会被静默吞掉），`.panda/tmp` 这类高频
 * 执行产物必须不触发（不然事件比轮询还吵，优化白做）。
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectDataWatcher } from './project-data-watcher';

function fakeWatchDirectory() {
  let emit: ((filename: string | null) => void) | null = null;
  return {
    watchDirectory: (_root: string, onEvent: (filename: string | null) => void) => {
      emit = onEvent;
      return { close() {} };
    },
    change(filename: string) { emit?.(filename); },
  };
}

const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

async function makeProject(): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-watch-'));
  cleanups.push(cwd);
  await fs.mkdir(path.join(cwd, '.panda/modules/demo'), { recursive: true });
  await fs.mkdir(path.join(cwd, '.panda/tmp/result'), { recursive: true });
  return cwd;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('ProjectDataWatcher', () => {
  test('改 MODULE.md 触发同步；一串写只合并成一次', async () => {
    const cwd = await makeProject();
    const fired: number[] = [];
    const fake = fakeWatchDirectory();
    const watcher = new ProjectDataWatcher({
      targets: () => [{ projectId: 7, cwd }],
      onChange: (id) => fired.push(id),
      debounceMs: 40,
      watchDirectory: fake.watchDirectory,
    });
    try {
      watcher.refresh();
      expect(watcher.healthy(7)).toBe(true);
      for (let i = 0; i < 5; i++) fake.change('modules/demo/MODULE.md');
      await waitFor(() => fired.length > 0);
      await new Promise((r) => setTimeout(r, 120));
      expect(fired).toEqual([7]); // 抖动合并：5 次写只换来 1 次同步
    } finally {
      watcher.close();
    }
  });

  test('.panda/tmp 下的执行产物不触发（那里写得最勤，放进来事件比轮询还吵）', async () => {
    const cwd = await makeProject();
    const fired: number[] = [];
    const fake = fakeWatchDirectory();
    const watcher = new ProjectDataWatcher({
      targets: () => [{ projectId: 7, cwd }],
      onChange: (id) => fired.push(id),
      debounceMs: 20,
      watchDirectory: fake.watchDirectory,
    });
    try {
      watcher.refresh();
      fake.change('tmp/result/summary.md');
      await new Promise((r) => setTimeout(r, 200));
      // 同一轮里再改一个共享文件，证明监听本身是活的（不是因为整体没工作才没触发）
      fake.change('modules/demo/MODULE.md');
      await waitFor(() => fired.length > 0);
      expect(fired).toEqual([7]);
    } finally {
      watcher.close();
    }
  });

  test('.panda 不存在 → 记为不健康（调度侧据此继续密集轮询），目录建好后能自愈', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-watch-bare-'));
    cleanups.push(cwd);
    const errors: unknown[] = [];
    const watcher = new ProjectDataWatcher({
      targets: () => [{ projectId: 9, cwd }],
      onChange: () => {},
      onError: (_id, error) => errors.push(error),
    });
    watcher.refresh();
    expect(watcher.healthy(9)).toBe(false);
    // 「还没有 .panda 目录」是全新项目的常态，不该告警——降级回轮询就够了
    expect(errors).toEqual([]);

    await fs.mkdir(path.join(cwd, '.panda/modules'), { recursive: true });
    watcher.refresh(); // 下一拍重试即装上
    expect(watcher.healthy(9)).toBe(true);
    watcher.close();
  });

  test('目标下线 / cwd 变了：撤掉旧监听，close 后不再持有任何监听', async () => {
    const cwd = await makeProject();
    let targets = [{ projectId: 7, cwd }];
    const watcher = new ProjectDataWatcher({
      targets: () => targets,
      onChange: () => {},
    });
    watcher.refresh();
    expect(watcher.size).toBe(1);

    targets = [];
    watcher.refresh();
    expect(watcher.healthy(7)).toBe(false);
    expect(watcher.size).toBe(0);

    targets = [{ projectId: 7, cwd }];
    watcher.refresh();
    expect(watcher.size).toBe(1);
    watcher.close();
    expect(watcher.size).toBe(0);
  });
});

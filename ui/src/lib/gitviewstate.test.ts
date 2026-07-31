import { describe, expect, test } from 'bun:test';
import {
  beginGitLoad,
  commitPanelLayout,
  completeGitLoad,
  createGitLoadState,
  failGitLoad,
  keyedResult,
  requestKey,
} from './gitviewstate';

describe('Git 页面请求生命周期', () => {
  test('同项目手动刷新保留当前数据，初载或跨项目请求清空旧数据', () => {
    const loaded = completeGitLoad(beginGitLoad(
      createGitLoadState<string>(7),
      7,
      1,
      false,
    ), 7, 1, 'old');

    expect(beginGitLoad(loaded, 7, 2, true)).toEqual({
      pid: 7,
      request: 2,
      value: 'old',
      error: '',
    });
    expect(beginGitLoad(loaded, 8, 3, true)).toEqual({
      pid: 8,
      request: 3,
      value: null,
      error: '',
    });
  });

  test('连续刷新只接受最后一个请求的成功或失败结果', () => {
    const first = beginGitLoad(createGitLoadState<string>(7), 7, 1, false);
    const second = beginGitLoad(first, 7, 2, true);

    expect(completeGitLoad(second, 7, 1, 'stale')).toBe(second);
    expect(failGitLoad(second, 7, 1, 'stale error')).toBe(second);
    expect(completeGitLoad(second, 7, 2, 'fresh')).toEqual({
      pid: 7,
      request: 2,
      value: 'fresh',
      error: '',
    });
  });

  test('跨项目迟到响应被拒绝；刷新失败保留刷新前数据并显示错误', () => {
    const old = {
      pid: 7,
      request: 4,
      value: 'project-7',
      error: '',
    };
    const next = beginGitLoad(old, 8, 5, false);

    expect(completeGitLoad(next, 7, 4, 'late project-7')).toBe(next);
    expect(failGitLoad(next, 7, 4, 'late error')).toBe(next);

    const refreshing = beginGitLoad(old, 7, 6, true);
    expect(failGitLoad(refreshing, 7, 6, 'network down')).toEqual({
      pid: 7,
      request: 6,
      value: 'project-7',
      error: 'network down',
    });
  });
});

describe('Git 页面 keyed 内容与手机详情布局', () => {
  test('diff 结果只在请求 key 完全匹配时可见', () => {
    const oldKey = requestKey(7, 1, '/diff?a');
    const newKey = requestKey(7, 1, '/diff?b');
    const result = { key: oldKey, value: 'old diff', error: '' };

    expect(keyedResult(result, oldKey)).toEqual({ value: 'old diff', error: '' });
    expect(keyedResult(result, newKey)).toEqual({ value: null, error: '' });
    expect(keyedResult(result, requestKey(7, 2, '/diff?a'))).toEqual({
      value: null,
      error: '',
    });
  });

  test('手机 commit 内选文件后进入独占 diff，宽屏仍保持详情分栏', () => {
    expect(commitPanelLayout(true, false)).toBe('detail');
    expect(commitPanelLayout(true, true)).toBe('mobile-diff');
    expect(commitPanelLayout(false, true)).toBe('detail');
  });
});

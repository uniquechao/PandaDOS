/**
 * resolveSelIid 单测：深链选中 issue 的校验（加载时序 + 命中/未命中）。
 */
import { describe, expect, test } from 'bun:test';
import { resolveSelIid } from './seliid';

const ISSUES = [{ id: 10 }, { id: 23 }, { id: 25 }];

describe('resolveSelIid', () => {
  test('无 selIid → 原样（不判定、不 stale）', () => {
    expect(resolveSelIid(undefined, ISSUES, true)).toEqual({ effectiveIid: undefined, stale: false });
    // 未加载时同样原样
    expect(resolveSelIid(undefined, null, false)).toEqual({ effectiveIid: undefined, stale: false });
  });

  test('加载中不判定：保留 selIid、不算 stale（避免误杀有效深链）', () => {
    // loaded=false
    expect(resolveSelIid(25, ISSUES, false)).toEqual({ effectiveIid: 25, stale: false });
    // issues 为 null（尚未拉到）
    expect(resolveSelIid(25, null, false)).toEqual({ effectiveIid: 25, stale: false });
    expect(resolveSelIid(999, null, false)).toEqual({ effectiveIid: 999, stale: false });
  });

  test('已加载且命中列表 → 保留、不 stale', () => {
    expect(resolveSelIid(23, ISSUES, true)).toEqual({ effectiveIid: 23, stale: false });
    expect(resolveSelIid(10, ISSUES, true)).toEqual({ effectiveIid: 10, stale: false });
  });

  test('已加载但未命中（跨项目/失效深链）→ effectiveIid 空 + stale', () => {
    expect(resolveSelIid(25, [{ id: 15 }, { id: 18 }], true)).toEqual({ effectiveIid: undefined, stale: true });
    // 本项目一个 issue 都没有（空列表）→ 任何 selIid 都 stale
    expect(resolveSelIid(23, [], true)).toEqual({ effectiveIid: undefined, stale: true });
  });

  test('边界：loaded=true 但 issues 仍为 null → 当作未加载、不判定', () => {
    expect(resolveSelIid(25, null, true)).toEqual({ effectiveIid: 25, stale: false });
  });
});

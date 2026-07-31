/**
 * aggregateSummary 单测：侧栏顶层「项目」聚合角标口径。
 * 只对给定 id（= 当前可见的活跃项目）求和，缺省对全量 sum 求和。
 */
import { describe, expect, test } from 'bun:test';
import { aggregateSummary } from './summary';
import type { ProjectIssueSummary } from './types';

const s = (todo: number, doing: number, review: number, blocked: number): ProjectIssueSummary => ({
  todo,
  doing,
  review,
  blocked,
});

describe('aggregateSummary', () => {
  test('空对象 → 全 0', () => {
    expect(aggregateSummary({})).toEqual(s(0, 0, 0, 0));
  });

  test('多项目按列求和（缺省全量）', () => {
    const sum = { '1': s(1, 2, 3, 0), '7': s(0, 1, 1, 2) };
    expect(aggregateSummary(sum)).toEqual(s(1, 3, 4, 2));
  });

  test('只统计给定 id（归档/越权项目不计入）', () => {
    const sum = { '1': s(1, 2, 3, 0), '7': s(9, 9, 9, 9) };
    // 只有项目 1 是活跃可见 → 项目 7 的数不进聚合
    expect(aggregateSummary(sum, [1])).toEqual(s(1, 2, 3, 0));
  });

  test('给定 id 在 sum 中缺席 → 跳过不报错', () => {
    const sum = { '1': s(1, 1, 1, 1) };
    expect(aggregateSummary(sum, [1, 42])).toEqual(s(1, 1, 1, 1));
  });
});

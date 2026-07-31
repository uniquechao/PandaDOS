/**
 * gitgraph 布局单测：线性/分支合并/窗口截断/泳道复用四种拓扑，
 * 断言泳道号、收敛边与 missing 桩（算法说明见 gitgraph.ts 头注释）。
 */
import { describe, expect, test } from 'bun:test';
import { layoutGraph, type GraphCommitIn } from './gitgraph';

function node(l: ReturnType<typeof layoutGraph>, sha: string) {
  const n = l.nodes.find((x) => x.sha === sha);
  expect(n).toBeDefined();
  return n!;
}

describe('layoutGraph', () => {
  test('空输入', () => {
    const l = layoutGraph([]);
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
    expect(l.maxLanes).toBe(0);
  });

  test('线性历史：全在 0 道，边竖直', () => {
    const l = layoutGraph([
      { sha: 'a', parents: ['b'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: [] },
    ]);
    expect(l.maxLanes).toBe(1);
    expect(l.nodes.map((n) => n.lane)).toEqual([0, 0, 0]);
    expect(l.edges).toEqual([
      { fromRow: 0, fromLane: 0, lane: 0, toRow: 1, toLane: 0 },
      { fromRow: 1, fromLane: 0, lane: 0, toRow: 2, toLane: 0 },
    ]);
  });

  test('分支+合并：M(a,b) → a、b 并行两道，c 处收敛', () => {
    const l = layoutGraph([
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'a', parents: ['c'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: [] },
    ]);
    expect(l.maxLanes).toBe(2);
    expect(node(l, 'm').lane).toBe(0);
    expect(node(l, 'a').lane).toBe(0);
    expect(node(l, 'b').lane).toBe(1);
    expect(node(l, 'c').lane).toBe(0);
    // m→b 的合并边走 1 道；b→c 从 1 道汇入 0 道
    expect(l.edges).toContainEqual({ fromRow: 0, fromLane: 0, lane: 1, toRow: 2, toLane: 1 });
    expect(l.edges).toContainEqual({ fromRow: 2, fromLane: 1, lane: 1, toRow: 3, toLane: 0 });
    expect(l.edges.filter((e) => e.missing).length).toBe(0);
  });

  test('多个子共父：并行下行、父行收敛（不提前并道）', () => {
    const l = layoutGraph([
      { sha: 'a', parents: ['c'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: [] },
    ]);
    expect(node(l, 'a').lane).toBe(0);
    expect(node(l, 'b').lane).toBe(1);
    expect(node(l, 'c').lane).toBe(0);
    expect(l.edges).toContainEqual({ fromRow: 1, fromLane: 1, lane: 1, toRow: 2, toLane: 0 });
  });

  test('窗口截断：父不在列表 → missing 桩', () => {
    const l = layoutGraph([{ sha: 'a', parents: ['zz'] }]);
    expect(l.edges).toEqual([
      { fromRow: 0, fromLane: 0, lane: 0, toRow: 1, toLane: 0, missing: true },
    ]);
  });

  test('泳道复用：分支闭合后空出的道让给后来的 tip', () => {
    const commits: GraphCommitIn[] = [
      { sha: 'm', parents: ['a', 'b'] },
      { sha: 'a', parents: ['c'] },
      { sha: 'b', parents: ['c'] },
      { sha: 'c', parents: ['d'] },
      { sha: 't', parents: ['d'] }, // 游离 tip：c 处 1 道已闭合，应复用
      { sha: 'd', parents: [] },
    ];
    const l = layoutGraph(commits);
    expect(l.maxLanes).toBe(2);
    expect(node(l, 't').lane).toBe(1);
    expect(node(l, 'd').lane).toBe(0);
  });
});

/**
 * colsize 单测：三栏列宽的纯逻辑（默认/归一/夹取）+ 存储层持久化。
 * bun test 无 DOM/localStorage —— 用内存 shim 顶上，只测脱离 Preact 的部分。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  applyBoundary, boundaries, COLSIZE_KEY, COL_DEFAULTS, COL_MIN,
  normalizeCols, readColSizes, writeColSizes, type Cols,
} from './colsize';

/** 内存版 localStorage（够 read/write 用） */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

const sum = (c: Cols): number => c[0] + c[1] + c[2];
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage;
});

describe('normalizeCols', () => {
  test('合法三元组按比例归一到恒和 100', () => {
    expect(normalizeCols([32, 22, 46])).toEqual([32, 22, 46]);
    const n = normalizeCols([16, 11, 23]); // 和 50 → ×2
    expect(near(sum(n), 100)).toBe(true);
    expect(near(n[0], 32)).toBe(true);
  });
  test('非数组/长度不符/含非正数/非有限 → 默认', () => {
    expect(normalizeCols(null)).toEqual([...COL_DEFAULTS]);
    expect(normalizeCols([32, 22])).toEqual([...COL_DEFAULTS]);
    expect(normalizeCols([32, 22, 46, 1])).toEqual([...COL_DEFAULTS]);
    expect(normalizeCols([32, 0, 68])).toEqual([...COL_DEFAULTS]);
    expect(normalizeCols([32, -5, 73])).toEqual([...COL_DEFAULTS]);
    expect(normalizeCols(['a', 'b', 'c'])).toEqual([...COL_DEFAULTS]);
  });
});

describe('boundaries', () => {
  test('累计位置 [w0, w0+w1]', () => {
    expect(boundaries([32, 22, 46])).toEqual([32, 54]);
  });
});

describe('applyBoundary —— 夹取', () => {
  const base: Cols = [32, 22, 46];

  test('boundary 0 正常拖动：改 提交/文件，Diff 不动，恒和 100', () => {
    const r = applyBoundary(base, 0, 40);
    expect(r).toEqual([40, 14, 46]);
    expect(sum(r)).toBe(100);
  });
  test('boundary 0 拖过小 → 夹到 COL_MIN（邻栏吃掉余量）', () => {
    const r = applyBoundary(base, 0, 5);
    expect(r[0]).toBe(COL_MIN);
    expect(r[2]).toBe(46);
    expect(sum(r)).toBe(100);
  });
  test('boundary 0 拖过大 → 文件栏保留 COL_MIN', () => {
    const r = applyBoundary(base, 0, 95);
    expect(r[1]).toBe(COL_MIN); // w0+w1-COL_MIN 处
    expect(r[0]).toBe(32 + 22 - COL_MIN);
    expect(r[2]).toBe(46);
  });
  test('boundary 1 正常拖动：改 文件/Diff，提交 不动', () => {
    const r = applyBoundary(base, 1, 60);
    expect(r).toEqual([32, 28, 40]);
    expect(sum(r)).toBe(100);
  });
  test('boundary 1 拖过小 → 文件栏保留 COL_MIN（不侵占提交栏）', () => {
    const r = applyBoundary(base, 1, 10);
    expect(r[0]).toBe(32);
    expect(r[1]).toBe(COL_MIN); // t 夹到 w0+COL_MIN
    expect(sum(r)).toBe(100);
  });
  test('boundary 1 拖过大 → Diff 栏保留 COL_MIN', () => {
    const r = applyBoundary(base, 1, 99);
    expect(r[2]).toBe(COL_MIN); // 100-COL_MIN 处
    expect(r[0]).toBe(32);
    expect(sum(r)).toBe(100);
  });
});

describe('存储层 read/write 持久化', () => {
  test('空存储 → 默认', () => {
    expect(readColSizes()).toEqual([...COL_DEFAULTS]);
  });
  test('write 后 read 往返一致', () => {
    writeColSizes([40, 18, 42]);
    expect(readColSizes()).toEqual([40, 18, 42]);
    expect(localStorage.getItem(COLSIZE_KEY)).toBe(JSON.stringify([40, 18, 42]));
  });
  test('损坏 JSON → 默认（不抛）', () => {
    localStorage.setItem(COLSIZE_KEY, '{不是数组');
    expect(readColSizes()).toEqual([...COL_DEFAULTS]);
  });
  test('存了走样的和（≠100）→ read 归一回 100', () => {
    writeColSizes([16, 11, 23] as Cols); // 和 50
    const r = readColSizes();
    expect(near(sum(r), 100)).toBe(true);
    expect(near(r[0], 32)).toBe(true);
  });
});

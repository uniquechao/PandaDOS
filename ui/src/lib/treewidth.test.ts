/**
 * treewidth 单测：文件页左侧文件树栏像素宽的纯逻辑（夹取/归一/未设回落）+ 存储层持久化。
 * bun test 无 DOM/localStorage —— 用内存 shim 顶上，只测脱离 Preact 的部分。
 * 另验独立 key（mando.filesTreeW）不与 issuelist 的 mando.wbListW 串台。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clampTreeWidth, clearTreeWidth, normalizeTreeWidth,
  readTreeWidth, TREEWIDTH_KEY, TREEW_MAX, TREEW_MIN, writeTreeWidth,
} from './treewidth';
import { LISTWIDTH_KEY } from './listwidth';

/** 内存版 localStorage（够 read/write/remove 用） */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  removeItem(k: string): void { this.m.delete(k); }
  clear(): void { this.m.clear(); }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage;
});

describe('clampTreeWidth', () => {
  test('区间内不变；过小夹到 MIN；过大夹到 MAX', () => {
    expect(clampTreeWidth(320)).toBe(320);
    expect(clampTreeWidth(TREEW_MIN)).toBe(TREEW_MIN);
    expect(clampTreeWidth(TREEW_MAX)).toBe(TREEW_MAX);
    expect(clampTreeWidth(100)).toBe(TREEW_MIN); // 过小
    expect(clampTreeWidth(999)).toBe(TREEW_MAX); // 过大（不超过 issuelist 宽度上限）
  });
});

describe('normalizeTreeWidth', () => {
  test('有限正数 → 夹取后返回', () => {
    expect(normalizeTreeWidth(320)).toBe(320);
    expect(normalizeTreeWidth(100)).toBe(TREEW_MIN);
    expect(normalizeTreeWidth(999)).toBe(TREEW_MAX);
    expect(normalizeTreeWidth('300')).toBe(300); // 数值字符串（JSON 反序列化容错）
  });
  test('非数值 / 非有限 / ≤0 → null（回落默认）', () => {
    expect(normalizeTreeWidth(null)).toBeNull();
    expect(normalizeTreeWidth(undefined)).toBeNull();
    expect(normalizeTreeWidth('abc')).toBeNull();
    expect(normalizeTreeWidth(0)).toBeNull();
    expect(normalizeTreeWidth(-5)).toBeNull();
    expect(normalizeTreeWidth(Infinity)).toBeNull();
    expect(normalizeTreeWidth(NaN)).toBeNull();
    expect(normalizeTreeWidth({})).toBeNull();
  });
});

describe('存储层 read/write/clear 持久化', () => {
  test('空存储 → null（未设，回落默认响应式宽度）', () => {
    expect(readTreeWidth()).toBeNull();
  });
  test('write 后 read 往返一致（落库为夹取后的值）', () => {
    writeTreeWidth(320);
    expect(readTreeWidth()).toBe(320);
    expect(localStorage.getItem(TREEWIDTH_KEY)).toBe(JSON.stringify(320));
  });
  test('write 越界 → 落库即夹取', () => {
    writeTreeWidth(100);
    expect(readTreeWidth()).toBe(TREEW_MIN);
    writeTreeWidth(999);
    expect(readTreeWidth()).toBe(TREEW_MAX);
  });
  test('损坏 JSON → null（不抛）', () => {
    localStorage.setItem(TREEWIDTH_KEY, '{不是数字');
    expect(readTreeWidth()).toBeNull();
  });
  test('clear 后回 null（双击复位）', () => {
    writeTreeWidth(320);
    expect(readTreeWidth()).toBe(320);
    clearTreeWidth();
    expect(readTreeWidth()).toBeNull();
  });
});

describe('独立 key（不与 issuelist 串台）', () => {
  test('用独立键名，且写文件树宽不污染 issuelist 键', () => {
    expect(TREEWIDTH_KEY).toBe('mando.filesTreeW');
    expect(TREEWIDTH_KEY).not.toBe(LISTWIDTH_KEY);
    writeTreeWidth(300);
    expect(localStorage.getItem(LISTWIDTH_KEY)).toBeNull(); // issuelist 键未被写入
  });
});

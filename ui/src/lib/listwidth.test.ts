/**
 * listwidth 单测：工作台左栏像素宽的纯逻辑（夹取/归一/未设回落）+ 存储层持久化。
 * bun test 无 DOM/localStorage —— 用内存 shim 顶上，只测脱离 Preact 的部分。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  clampListWidth, clearListWidth, LISTWIDTH_KEY, LISTW_MAX, LISTW_MIN,
  normalizeListWidth, readListWidth, writeListWidth,
} from './listwidth';

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

describe('clampListWidth', () => {
  test('区间内不变；过小夹到 MIN；过大夹到 MAX', () => {
    expect(clampListWidth(320)).toBe(320);
    expect(clampListWidth(LISTW_MIN)).toBe(LISTW_MIN);
    expect(clampListWidth(LISTW_MAX)).toBe(LISTW_MAX);
    expect(clampListWidth(100)).toBe(LISTW_MIN); // 过小
    expect(clampListWidth(999)).toBe(LISTW_MAX); // 过大（不超过现宽）
  });
});

describe('normalizeListWidth', () => {
  test('有限正数 → 夹取后返回', () => {
    expect(normalizeListWidth(320)).toBe(320);
    expect(normalizeListWidth(100)).toBe(LISTW_MIN);
    expect(normalizeListWidth(999)).toBe(LISTW_MAX);
    expect(normalizeListWidth('300')).toBe(300); // 数值字符串（JSON 反序列化容错）
  });
  test('非数值 / 非有限 / ≤0 → null（回落默认）', () => {
    expect(normalizeListWidth(null)).toBeNull();
    expect(normalizeListWidth(undefined)).toBeNull();
    expect(normalizeListWidth('abc')).toBeNull();
    expect(normalizeListWidth(0)).toBeNull();
    expect(normalizeListWidth(-5)).toBeNull();
    expect(normalizeListWidth(Infinity)).toBeNull();
    expect(normalizeListWidth(NaN)).toBeNull();
    expect(normalizeListWidth({})).toBeNull();
  });
});

describe('存储层 read/write/clear 持久化', () => {
  test('空存储 → null（未设，回落默认响应式宽度）', () => {
    expect(readListWidth()).toBeNull();
  });
  test('write 后 read 往返一致（落库为夹取后的值）', () => {
    writeListWidth(320);
    expect(readListWidth()).toBe(320);
    expect(localStorage.getItem(LISTWIDTH_KEY)).toBe(JSON.stringify(320));
  });
  test('write 越界 → 落库即夹取', () => {
    writeListWidth(100);
    expect(readListWidth()).toBe(LISTW_MIN);
    writeListWidth(999);
    expect(readListWidth()).toBe(LISTW_MAX);
  });
  test('损坏 JSON → null（不抛）', () => {
    localStorage.setItem(LISTWIDTH_KEY, '{不是数字');
    expect(readListWidth()).toBeNull();
  });
  test('clear 后回 null（双击复位）', () => {
    writeListWidth(320);
    expect(readListWidth()).toBe(320);
    clearListWidth();
    expect(readListWidth()).toBeNull();
  });
});

/**
 * newIssuePrefs 单测：新建 issue 的档位偏好（按设备记）。
 * bun test 无 DOM/localStorage —— 用内存 shim 顶上（同 colsize.test）。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  NEW_ISSUE_AA_DEFAULT,
  NEW_ISSUE_AA_KEY,
  readNewIssueAutoApprove,
  writeNewIssueAutoApprove,
} from './newIssuePrefs';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

const mem = (): MemStorage => (globalThis as unknown as { localStorage: MemStorage }).localStorage;

beforeEach(() => {
  (globalThis as unknown as { localStorage: MemStorage }).localStorage = new MemStorage();
});
afterEach(() => {
  delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage;
});

describe('newIssuePrefs', () => {
  test('没记录 → 默认 medium', () => {
    expect(NEW_ISSUE_AA_DEFAULT).toBe('medium');
    expect(readNewIssueAutoApprove()).toBe('medium');
  });

  test('写了就记住，三档都能回读', () => {
    for (const lv of ['cautious', 'medium', 'auto'] as const) {
      writeNewIssueAutoApprove(lv);
      expect(readNewIssueAutoApprove()).toBe(lv);
    }
  });

  test('脏值不落库、读到脏值退回 medium（不会悄悄变成全自动）', () => {
    writeNewIssueAutoApprove('auto');
    writeNewIssueAutoApprove('x' as never);
    expect(readNewIssueAutoApprove()).toBe('auto'); // 非法写入被丢弃，上一次仍在

    mem().setItem(NEW_ISSUE_AA_KEY, 'YOLO'); // 手改/旧版本残留
    expect(readNewIssueAutoApprove()).toBe('medium');
  });

  test('localStorage 不可用（隐私模式）时读默认、写不抛', () => {
    delete (globalThis as unknown as { localStorage?: MemStorage }).localStorage;
    expect(readNewIssueAutoApprove()).toBe('medium');
    expect(() => writeNewIssueAutoApprove('auto')).not.toThrow();
  });
});

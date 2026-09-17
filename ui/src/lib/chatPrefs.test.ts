import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CHAT_AGENT_KEY, readChatAgent, writeChatAgent, readChatConversation, writeChatConversation, restoreChatConversation } from './chatPrefs';
import { reconcileAgent } from '../components/AgentPicker';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('对话页浏览器偏好', () => {
  test('无记录时沿用 claude 和最近活跃对话，空列表不打开对话', () => {
    expect(readChatAgent()).toBe('claude');
    expect(restoreChatConversation(1, [{ id: 'recent' }])).toBe('recent');
    expect(restoreChatConversation(1, [])).toBeNull();
  });

  test('代理手动选择可回读，非法值不覆盖合法偏好', () => {
    writeChatAgent('codex');
    writeChatAgent('invalid' as never);
    expect(readChatAgent()).toBe('codex');
    writeChatAgent('claude');
    expect(readChatAgent()).toBe('claude');
    values.set(CHAT_AGENT_KEY, 'invalid');
    expect(readChatAgent()).toBe('claude');
  });

  test('执行机只支持另一代理时临时回退，再回双代理项目仍恢复手动偏好', () => {
    writeChatAgent('codex');
    expect(reconcileAgent(readChatAgent(), ['claude'])).toBe('claude');
    expect(readChatAgent()).toBe('codex');
    expect(reconcileAgent(readChatAgent(), ['claude', 'codex'])).toBe('codex');
    expect(reconcileAgent(readChatAgent(), [])).toBeNull();
  });

  test('对话按项目隔离，恢复手动打开的旧对话而非最近活跃项', () => {
    writeChatConversation(1, 'older');
    writeChatConversation(2, 'other');
    expect(restoreChatConversation(1, [{ id: 'recent' }, { id: 'older' }])).toBe('older');
    expect(readChatConversation(2)).toBe('other');
    expect(readChatConversation(3)).toBeNull();
  });

  test('归档或失效记录回退剩余对话，空列表可清除记录且不影响其他项目', () => {
    writeChatConversation(1, 'archived');
    writeChatConversation(2, 'other');
    const fallback = restoreChatConversation(1, [{ id: 'remaining' }]);
    expect(fallback).toBe('remaining');
    writeChatConversation(1, fallback);
    expect(readChatConversation(1)).toBe('remaining');
    writeChatConversation(1, restoreChatConversation(1, []));
    expect(readChatConversation(1)).toBeNull();
    expect(readChatConversation(2)).toBe('other');
  });

  test('浏览器拒绝访问存储时仍能回退并继续操作', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('存储不可用'); } });
    expect(readChatAgent()).toBe('claude');
    expect(restoreChatConversation(1, [{ id: 'recent' }])).toBe('recent');
    expect(() => writeChatAgent('codex')).not.toThrow();
    expect(() => writeChatConversation(1, 'new')).not.toThrow();
    expect(() => writeChatConversation(1, null)).not.toThrow();
  });

  test('写入空间不足不会抛出异常或破坏已有偏好', () => {
    writeChatAgent('codex');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem() { throw new Error('空间不足'); },
      removeItem() { throw new Error('禁止写入'); },
    } });
    expect(() => writeChatAgent('claude')).not.toThrow();
    expect(readChatAgent()).toBe('codex');
    expect(() => writeChatConversation(1, 'new')).not.toThrow();
    expect(() => writeChatConversation(1, null)).not.toThrow();
  });
});

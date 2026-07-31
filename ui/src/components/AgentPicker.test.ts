import { describe, expect, test } from 'bun:test';
import { reconcileAgent, toggleAgent } from './AgentPicker';

describe('AgentPicker', () => {
  test('Claude/Codex 可独立或同时选择，顺序稳定', () => {
    expect(toggleAgent([], 'codex', true)).toEqual(['codex']);
    expect(toggleAgent(['codex'], 'claude', true)).toEqual(['claude', 'codex']);
    expect(toggleAgent(['claude', 'codex'], 'claude', false)).toEqual(['codex']);
  });
  test('按执行机能力保留、自动选择或清空当前 Agent', () => {
    expect(reconcileAgent(null, ['claude'])).toBe('claude');
    expect(reconcileAgent('claude', ['codex'])).toBe('codex');
    expect(reconcileAgent('codex', ['claude', 'codex'])).toBe('codex');
    expect(reconcileAgent(null, ['claude', 'codex'])).toBeNull();
    expect(reconcileAgent('claude', [])).toBeNull();
  });
});

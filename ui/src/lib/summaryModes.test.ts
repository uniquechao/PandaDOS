import { describe, expect, test } from 'bun:test';
import {
  isAsyncMode,
  isSummaryRunning,
  MEMORY_MODELS,
  memoryBtnLabel,
  SUMMARY_MODELS,
  summaryBtnLabel,
  type SummaryMode,
} from './summaryModes';

describe('SUMMARY_MODELS', () => {
  test('三个模型：llm 同步、claude/codex 异步', () => {
    expect(SUMMARY_MODELS.map((m) => m.mode)).toEqual(['llm', 'claude', 'codex']);
    const byMode = Object.fromEntries(SUMMARY_MODELS.map((m) => [m.mode, m.async]));
    expect(byMode.llm).toBe(false);
    expect(byMode.claude).toBe(true);
    expect(byMode.codex).toBe(true);
    // 每个都有 label/hint
    for (const m of SUMMARY_MODELS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('isAsyncMode', () => {
  test('claude/codex 异步，llm 同步', () => {
    expect(isAsyncMode('llm')).toBe(false);
    expect(isAsyncMode('claude')).toBe(true);
    expect(isAsyncMode('codex')).toBe(true);
  });
});

describe('isSummaryRunning', () => {
  test('仅 running 为真', () => {
    expect(isSummaryRunning('running')).toBe(true);
    expect(isSummaryRunning('idle')).toBe(false);
    expect(isSummaryRunning('done')).toBe(false);
    expect(isSummaryRunning('error')).toBe(false);
    expect(isSummaryRunning(undefined)).toBe(false);
  });
});

describe('summaryBtnLabel', () => {
  test('busy 或 running → 生成中…；否则 更新简介', () => {
    expect(summaryBtnLabel('idle', false)).toBe('更新简介');
    expect(summaryBtnLabel('idle', true)).toBe('生成中…');
    expect(summaryBtnLabel('running', false)).toBe('生成中…');
    expect(summaryBtnLabel('done', false)).toBe('更新简介');
    expect(summaryBtnLabel(undefined, false)).toBe('更新简介');
  });
});

describe('MEMORY_MODELS / memoryBtnLabel（更新记忆）', () => {
  test('只含 claude/codex（无 llm），均异步，带 label/hint', () => {
    expect(MEMORY_MODELS.map((m) => m.mode)).toEqual(['claude', 'codex']);
    for (const m of MEMORY_MODELS) {
      expect(m.async).toBe(true);
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.hint.length).toBeGreaterThan(0);
    }
  });

  test('memoryBtnLabel：busy/running → 更新中…；否则 🧠 更新记忆', () => {
    expect(memoryBtnLabel('idle', false)).toBe('🧠 更新记忆');
    expect(memoryBtnLabel('idle', true)).toBe('更新中…');
    expect(memoryBtnLabel('running', false)).toBe('更新中…');
    expect(memoryBtnLabel(undefined, false)).toBe('🧠 更新记忆');
  });
});

// 类型编译面守卫：SummaryMode 联合被正确约束
const _modes: SummaryMode[] = ['llm', 'claude', 'codex'];
void _modes;

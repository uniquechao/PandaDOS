import { describe, expect, test } from 'bun:test';
import { mergeMessages } from './chatMerge';
import type { ChatMessage } from './types';

const m = (off: number, text: string, seq = 0): ChatMessage => ({ seq, role: 'assistant', text, off });

describe('mergeMessages（按 off 去重 + 升序）', () => {
  test('空 + 一批 → 按 off 升序', () => {
    const out = mergeMessages([], [m(20, 'b'), m(0, 'a'), m(10, 'c')]);
    expect(out.map((x) => x.text)).toEqual(['a', 'c', 'b']);
  });

  test('msg 追加：新 off 排到末尾', () => {
    const out = mergeMessages([m(0, 'a'), m(10, 'b')], [m(20, 'c')]);
    expect(out.map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });

  test('history 前插：更早 off 排到最前，既有不丢', () => {
    const out = mergeMessages([m(30, 'c'), m(40, 'd')], [m(10, 'a'), m(20, 'b')]);
    expect(out.map((x) => x.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('去重：相同 off 只留一条，incoming 覆盖（取最新）', () => {
    const out = mergeMessages([m(10, '旧'), m(20, 'x')], [m(10, '新'), m(20, 'x')]);
    expect(out.length).toBe(2);
    expect(out.find((x) => x.off === 10)!.text).toBe('新');
  });

  test('重连不缩：末段 baseline 合并进已加载全量 → 不丢更早（修「缩回 60」）', () => {
    // 已加载 0..149（模拟翻页 + 流式积累）
    const loaded = Array.from({ length: 150 }, (_, i) => m(i, `m${i}`));
    // 重连只发末 60（off 90..149）
    const reconnectBaseline = Array.from({ length: 60 }, (_, i) => m(90 + i, `m${90 + i}`));
    const out = mergeMessages(loaded, reconnectBaseline);
    expect(out.length).toBe(150); // 没缩回 60
    expect(out[0]!.text).toBe('m0');
    expect(out[149]!.text).toBe('m149');
  });

  test('无 off 兜底：保序追加末尾，不炸', () => {
    const noOff: ChatMessage = { seq: 1, role: 'user', text: 'legacy' };
    const out = mergeMessages([m(0, 'a')], [noOff, m(10, 'b')]);
    expect(out.map((x) => x.text)).toEqual(['a', 'b', 'legacy']);
  });
});

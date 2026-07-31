import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./badges.tsx', import.meta.url), 'utf8');

describe('StatusBadge：awaitingClarify 覆盖显示「等待你澄清」', () => {
  test('接受可选 awaitingClarify prop；为真时覆盖状态标签（早返回，先于常规 STATUS_LABEL）', () => {
    expect(source).toContain('awaitingClarify?: boolean');
    expect(source).toContain('等待你澄清');
    // 覆盖分支必须在常规 STATUS_LABEL 渲染之前（早返回），否则覆盖不生效
    const idxOverride = source.indexOf('等待你澄清');
    const idxNormal = source.indexOf('STATUS_LABEL[status]');
    expect(idxOverride).toBeGreaterThan(0);
    expect(idxNormal).toBeGreaterThan(idxOverride);
  });

  test('走实心橙专用样式（#110），与普通 b-amber 状态徽标拉开一档', () => {
    expect(source).toContain('badge b-clarify');
  });
});

describe('ModelBadge：当前使用的模型（issue #109）', () => {
  test('只读展示原始名；未知不渲染（不拿默认模型顶替）', () => {
    expect(source).toContain('export function ModelBadge');
    expect(source).toContain('if (!model) return null');
    expect(source).toContain('badge b-model mono');
    expect(source).toContain('当前使用的模型：');
    expect(source).not.toContain('onClick'); // 本期不做点击切换
  });
});

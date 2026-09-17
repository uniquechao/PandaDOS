import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./badges.tsx', import.meta.url), 'utf8');

describe('StatusBadge：awaitingClarify 覆盖显示「等待你澄清」', () => {
  test('接受可选 awaitingClarify prop；为真时覆盖状态标签（早返回，先于常规 STATUS_LABEL）', () => {
    expect(source).toContain('awaitingClarify?: boolean');
    expect(source).toContain("t('status.awaitingClarify')");
    // 覆盖分支必须在常规 STATUS_LABEL 渲染之前（早返回），否则覆盖不生效
    const idxOverride = source.indexOf("t('status.awaitingClarify')");
    const idxNormal = source.indexOf('issueStatusLabel(status)');
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
    expect(source).toContain("t('status.modelInUse', { model })");
    expect(source).not.toContain('onClick'); // 本期不做点击切换
  });
});

/** #275 / I-07：把散在各处的 waitingInput / clarifyPending / 状态判断收成一个徽标 */
describe('AttentionBadge：统一呈现「在等什么」', () => {
  test('none 与缺省不渲染——正常跑的 issue 不该多一个角标', () => {
    expect(source).toContain("if (!kind || kind === 'none') return null;");
  });

  test('六种取值各有标签，clarify/choice 复用既有文案不另造一套', () => {
    for (const key of [
      'status.awaitingClarify', 'status.waitingChoice', 'status.attentionReview',
      'status.attentionVerify', 'status.attentionStalled', 'status.blocked',
    ]) expect(source).toContain(`t('${key}')`);
  });

  test('verify 不走红档：本地门禁其实过了，那不是故障', () => {
    const style = source.match(/const ATTENTION_STYLE[\s\S]*?\};/)![0];
    expect(style).toContain("verify: { cls: 'b-blue'");
    expect(style).toContain("blocked: { cls: 'b-red'");
    // 「等你处理」的三档统一用琥珀，与红档拉开
    expect(style).toContain("choice: { cls: 'b-amber'");
    expect(style).toContain("review: { cls: 'b-amber'");
    expect(style).toContain("stalled: { cls: 'b-amber'");
    // 澄清仍是实心橙专用档（#110 的醒目档不降级）
    expect(style).toContain("clarify: { cls: 'b-clarify'");
  });

  test('verify / stalled 给出解释性 title：光看两个字不知道该做什么', () => {
    expect(source).toContain("t('status.attentionVerifyHint')");
    expect(source).toContain("t('status.attentionStalledHint')");
  });
});

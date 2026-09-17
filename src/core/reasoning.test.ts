/**
 * core/reasoning 单测（#281 / I-04）——纯函数，入参普通数据。
 */
import { describe, expect, test } from 'bun:test';
import {
  codexReasoningArg,
  supportsReasoningEffort,
  DEFAULT_REASONING_EFFORT,
  ONE_SHOT_REASONING_EFFORT,
  resolveReasoningEffort,
} from './reasoning';

describe('resolveReasoningEffort：issue > 模块 > 默认', () => {
  test('三层各自命中，并带上来源（排查时最想知道的就是它从哪来）', () => {
    expect(resolveReasoningEffort({ issue: 'high', module: 'low' }))
      .toEqual({ effort: 'high', source: 'issue' });
    expect(resolveReasoningEffort({ issue: null, module: 'low' }))
      .toEqual({ effort: 'low', source: 'module' });
    expect(resolveReasoningEffort({}))
      .toEqual({ effort: DEFAULT_REASONING_EFFORT, source: 'default' });
  });

  test('每层的 null/undefined 都是「继承下一层」，不是「关掉」', () => {
    expect(resolveReasoningEffort({ issue: null, module: null }).source).toBe('default');
    expect(resolveReasoningEffort({ issue: undefined, module: 'high' }).effort).toBe('high');
  });

  test('可以显式换默认档（一次性会话就是这么统一到 low 的）', () => {
    expect(resolveReasoningEffort({ fallback: ONE_SHOT_REASONING_EFFORT }))
      .toEqual({ effort: 'low', source: 'default' });
    // 但显式配置永远盖过默认档
    expect(resolveReasoningEffort({ module: 'high', fallback: 'low' }).effort).toBe('high');
  });

  test('默认档不是沿用全局 high：默认值决定绝大多数会话的成本', () => {
    expect(DEFAULT_REASONING_EFFORT).toBe('medium');
    expect(ONE_SHOT_REASONING_EFFORT).toBe('low');
  });
});

describe('codexReasoningArg', () => {
  test('用 -c key=value 形式，值带 TOML 引号', () => {
    expect(codexReasoningArg('low')).toBe('-c model_reasoning_effort="low"');
    expect(codexReasoningArg('high')).toBe('-c model_reasoning_effort="high"');
  });
});

describe('supportsReasoningEffort：能力位，不许各处写死 agent === codex', () => {
  test('只有 codex 支持；claude 没有对应启动参数', () => {
    expect(supportsReasoningEffort('codex')).toBe(true);
    expect(supportsReasoningEffort('claude')).toBe(false);
  });
});

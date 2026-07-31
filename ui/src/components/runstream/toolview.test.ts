import { describe, expect, test } from 'bun:test';
import type { RunToolEvent } from '../../lib/runstream';
import { firstLine } from './textutil';
import { toolHeadView } from './toolview';

function tool(ev: Partial<RunToolEvent>): RunToolEvent {
  return { kind: 'tool', seq: 0, tool: 'Read', status: 'ok', ...ev };
}

describe('toolHeadView', () => {
  test('折叠态：标题 + 耗时 + 结果预览；hasBody 为真', () => {
    const h = toolHeadView(
      tool({ title: '📖 读 a.ts', input: 'a.ts', result: 'hello world', durationMs: 3000 }),
      false,
    );
    expect(h.head).toBe('📖 读 a.ts');
    expect(h.dur).toBe('3.0s');
    expect(h.preview).toBe('hello world');
    expect(h.hasBody).toBe(true);
  });

  test('无 title → 退化「🔧 工具名」', () => {
    const h = toolHeadView(tool({ tool: 'Grep', title: undefined, result: 'x' }), false);
    expect(h.head).toBe('🔧 Grep');
  });

  test('展开态不出预览', () => {
    const h = toolHeadView(tool({ result: 'hello', input: 'a' }), true);
    expect(h.preview).toBe('');
    expect(h.hasBody).toBe(true);
  });

  test('运行中（无结果无耗时）：无预览、无耗时；有入参仍可展开', () => {
    const h = toolHeadView(tool({ status: 'running', input: 'x.ts', result: undefined }), false);
    expect(h.dur).toBe('');
    expect(h.preview).toBe('');
    expect(h.hasBody).toBe(true);
  });

  test('既无入参也无结果 → 不可展开', () => {
    const h = toolHeadView(tool({ input: undefined, result: undefined }), false);
    expect(h.hasBody).toBe(false);
  });

  test('长结果预览压成单行并截断', () => {
    const long = 'line1\nline2\n' + 'x'.repeat(200);
    const h = toolHeadView(tool({ result: long }), false);
    expect(h.preview.length).toBeLessThanOrEqual(81); // 80 + …
    expect(h.preview.endsWith('…')).toBe(true);
    expect(h.preview).not.toContain('\n');
  });
});

describe('firstLine', () => {
  test('短文本原样；多行/超长压单行加省略号', () => {
    expect(firstLine('hi', 80)).toBe('hi');
    expect(firstLine('a\nb\nc', 80)).toBe('a b c');
    expect(firstLine('x'.repeat(100), 80)).toBe('x'.repeat(80) + '…');
  });
});

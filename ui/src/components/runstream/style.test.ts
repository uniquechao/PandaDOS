import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../style.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('runstream 布局约束', () => {
  test('命令卡在可滚动的纵向 flex 消息流中不可被压成边框', () => {
    expect(declarations('.rs-cmd')).toMatch(/(?:^|;)\s*flex-shrink\s*:\s*0\s*(?:;|$)/);
  });
});

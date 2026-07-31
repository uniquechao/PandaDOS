import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('登录页背景光晕', () => {
  test('两枚光晕使用错峰的缓慢漂浮动画', () => {
    expect(css).toMatch(/\.login::before\s*\{[^}]*animation:\s*login-orbit-ring\s+10s[^;}]*infinite/s);
    expect(css).toMatch(/\.login::after\s*\{[^}]*animation:\s*login-orbit-dot\s+8s[^;}]*infinite/s);
    expect(css).toContain('@keyframes login-orbit-ring');
    expect(css).toContain('@keyframes login-orbit-dot');
  });

  test('全局减少动态效果规则覆盖伪元素', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\*, \*::before, \*::after\s*\{/,
    );
  });
});

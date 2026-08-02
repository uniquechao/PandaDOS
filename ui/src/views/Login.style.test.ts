import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('登录页背景装饰', () => {
  test('新设计的光晕、圆环、点阵与星芒使用错峰漂浮动画', () => {
    expect(css).toMatch(/\.login-glow-tl\s*\{[^}]*animation:\s*login-drift-a\s+14s[^;}]*infinite/s);
    expect(css).toMatch(/\.login-glow-br\s*\{[^}]*animation:\s*login-drift-b\s+17s[^;}]*-5s[^;}]*infinite/s);
    expect(css).toMatch(/\.login-ring-left\s*\{[^}]*animation:\s*login-float-ring\s+13s[^;}]*infinite/s);
    expect(css).toMatch(/\.login-dots-br\s*\{[^}]*animation:\s*login-drift-a\s+19s[^;}]*-8s[^;}]*infinite/s);
    expect(css).toMatch(/\.login-spark-side\s*\{[^}]*animation:\s*login-spark-float\s+11s[^;}]*-4s[^;}]*infinite/s);
    expect(css).toContain('@keyframes login-drift-a');
    expect(css).toContain('@keyframes login-drift-b');
    expect(css).toContain('@keyframes login-float-ring');
    expect(css).toContain('@keyframes login-spark-float');
  });

  test('全局减少动态效果规则覆盖伪元素', () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\*, \*::before, \*::after\s*\{/,
    );
  });
});

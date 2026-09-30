/**
 * 技能策略编辑器（SkillPolicyEditor）重设计约束（issue #308，字符串校验法）。
 * 守住：可搜索 + 按策略筛选、每行分段单选（非整行宽下拉）、覆盖行可辨、窄屏分段铺满、hover 只在 hover:hover 内。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./style.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('./components/SkillPolicyEditor.tsx', import.meta.url), 'utf8');

describe('SkillPolicyEditor 重设计', () => {
  test('提供搜索、策略筛选与覆盖计数', () => {
    expect(src).toContain('type="search"');
    expect(src).toContain("const FILTERS: Filter[]=['all','custom','auto','manual','disabled']");
    expect(src).toContain("tr('status.skillOverrideCount'");
    expect(src).toContain("tr('status.skillNoMatch')");
  });

  test('每行用分段单选而不是下拉，继承值单独说明', () => {
    expect(src).not.toContain('<select');
    expect(src).toContain('role="radiogroup"');
    expect(src).toContain('aria-checked={on}');
    expect(src).toContain("tr('status.skillInheritsMode'");
  });

  test('自带保存模式只在有改动时可保存', () => {
    expect(src).toContain('disabled={busy || !dirty}');
  });

  test('样式：覆盖行有强调条，窄屏分段铺满，hover 限定在 hover:hover', () => {
    expect(css).toMatch(/\.skp-row\.custom::before\s*\{[^}]*background:\s*var\(--accent\)/);
    expect(css).toMatch(/@media \(max-width: 560px\)\s*\{\s*\.skp-seg\s*\{\s*flex:\s*1 1 100%/);
    const block = css.slice(css.indexOf('.skp {'));
    for (const m of block.matchAll(/^[^@\n]*:hover[^\n]*$/gm)) expect(m[0]).toContain('@media (hover: hover)');
  });
});

/**
 * 文件页分栏样式约束（读 style.css 校验声明，bun test 无 DOM）：
 * 文件树可滚动 + 展开箭头旋转 + 选中高亮；右栏铺满可滚；左树宽度沿用 issuelist 上限 [.wb-list-col]。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('文件树左栏', () => {
  test('.filetree 独占剩余高度且可纵向滚动', () => {
    expect(declarations('.filetree')).toMatch(/flex\s*:\s*1/);
    expect(declarations('.filetree')).toMatch(/overflow\s*:\s*auto/);
  });
  test('.ft-arrow.open 展开时旋转 90 度', () => {
    expect(declarations('.ft-arrow.open')).toMatch(/rotate\(90deg\)/);
  });
  test('.ft-file.on 选中文件高亮（accent）', () => {
    expect(declarations('.ft-file.on')).toContain('var(--accent');
  });
  test('文件树宽度沿用 issuelist 上限（.wb-list-col max-width 400）', () => {
    expect(declarations('.wb-list-col')).toMatch(/max-width\s*:\s*400px/);
  });
});

describe('右栏 编辑/预览', () => {
  test('.fileviewer 纵向 flex 铺满右栏', () => {
    expect(declarations('.fileviewer')).toMatch(/flex-direction\s*:\s*column/);
    expect(declarations('.fileviewer')).toMatch(/flex\s*:\s*1/);
  });
  test('.fv-body 可压缩且可滚动（min-height:0）', () => {
    expect(declarations('.fv-body')).toMatch(/min-height\s*:\s*0/);
  });
  test('网页预览 iframe 在右栏内铺满（flex:1）', () => {
    expect(declarations('.fv-body > .fp-frame')).toMatch(/flex\s*:\s*1/);
  });
});

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const source = readFileSync(new URL('./Git.tsx', import.meta.url), 'utf8');

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
}

describe('Git VSCode 式工作区样式', () => {
  test('宽屏工作区横向分栏并允许内部区域压缩滚动', () => {
    expect(declarations('.git-workspace')).toMatch(/display\s*:\s*flex/);
    expect(declarations('.git-workspace')).toMatch(/min-height\s*:\s*0/);
    expect(declarations('.git-nav-wrap')).toMatch(/flex\s*:\s*0 0 auto/);
    expect(declarations('.git-nav')).toMatch(/flex-direction\s*:\s*column/);
    expect(declarations('.git-context')).toMatch(/min-height\s*:\s*0/);
  });

  test('左栏上树下历史均可分配高度，历史折叠后只保留标题栏', () => {
    expect(declarations('.git-tree-pane')).toMatch(/min-height\s*:\s*0/);
    expect(declarations('.git-history-pane')).toMatch(/display\s*:\s*flex/);
    expect(declarations('.git-history-pane')).toMatch(/flex-direction\s*:\s*column/);
    expect(declarations('.git-history-pane.collapsed')).toMatch(/flex\s*:\s*0/);
  });

  test('树体和提交历史各自滚动，避免整页互相挤压', () => {
    expect(declarations('.git-tree-body')).toMatch(/overflow\s*:\s*auto/);
    expect(declarations('.git-history-scroll')).toMatch(/overflow\s*:\s*auto/);
  });

  test('提交行与 SVG 使用一致的紧凑行高，双行内容仅保留最小间距', () => {
    expect(source).toContain('const ROW_H = 42;');
    expect(declarations('.git-row')).toMatch(/height\s*:\s*42px/);
    expect(declarations('.git-row')).toMatch(/gap\s*:\s*1px/);
  });

  test('手机钻入内容铺满剩余高度', () => {
    expect(declarations('.git-mobile-content')).toMatch(/flex-direction\s*:\s*column/);
    expect(declarations('.git-mobile-content')).toMatch(/min-height\s*:\s*0/);
  });

  test('版本控制面板固定在树头下方，输入区可收缩且文件操作按钮不挤掉文件名', () => {
    expect(declarations('.git-ops-panel')).toMatch(/flex-shrink\s*:\s*0/);
    expect(declarations('.git-commit-input')).toMatch(/resize\s*:\s*vertical/);
    expect(declarations('.ct-actions')).toMatch(/flex-shrink\s*:\s*0/);
  });
});

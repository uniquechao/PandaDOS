/**
 * ChangeTree 源码断言（bun test 无 DOM，按仓库惯例校验关键不变式）：
 * 构树走 lib/changetree、目录可折叠（默认全展开）、选中高亮、层级缩进、
 * 行内容复用 StatusChip/PlusMinus、样式钩子齐备。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ChangeTree.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../style.css', import.meta.url), 'utf8');

describe('ChangeTree 结构约束', () => {
  test('构树纯逻辑走 lib/changetree（组件内不重复实现）', () => {
    expect(source).toContain("from '../lib/changetree'");
    expect(source).toContain('buildChangeTree(leaves)');
  });

  test('目录可折叠：collapsed 态 + 箭头 open + 点击 toggle；默认全展开', () => {
    expect(source).toContain('collapsed');
    expect(source).toContain('toggle(n.path)');
    expect(source).toContain("ft-arrow${open ? ' open' : ''}");
    expect(source).toContain('!collapsed[n.path]'); // 未记录折叠 = 展开
  });

  test('选中文件高亮（selKey 命中叶子 key 挂 .on，行带 .ft-file 吃既有高亮样式）', () => {
    expect(source).toContain('selKey === n.leaf.key');
    expect(source).toContain("' on'");
    expect(source).toContain('ft-file');
  });

  test('按层级缩进（depth 递增 + INDENT + paddingLeft）', () => {
    expect(source).toContain('depth + 1');
    expect(source).toContain('INDENT');
    expect(source).toContain('paddingLeft');
  });

  test('行内容复用 Git 页小件：状态码 + 增删行；目录行聚合文件数', () => {
    expect(source).toContain("from '../views/Git'");
    expect(source).toContain('<StatusChip code={n.leaf.code} />');
    expect(source).toContain('<PlusMinus adds={n.leaf.adds} dels={n.leaf.dels} />');
    expect(source).toContain('{n.files}');
    // 目录增删聚合仅在非零时渲染（避免满屏 ±0 噪音）
    expect(source).toContain('n.adds > 0 || n.dels > 0');
  });

  test('文件点击回调 onOpen(leaf)，title 带完整路径（重命名带旧名）', () => {
    expect(source).toContain('onOpen(n.leaf)');
    expect(source).toContain('n.leaf.oldPath ? `${n.leaf.oldPath} → ${n.leaf.path}` : n.leaf.path');
  });

  test('调用方可为文件行注入操作按钮，按钮区不会触发文件打开', () => {
    expect(source).toContain('renderActions?:');
    expect(source).toContain('renderActions?.(n.leaf)');
    expect(source).toContain('class="ct-actions"');
    expect(source).toContain('e.stopPropagation()');
  });

  test('样式钩子：.changetree 容器与 .ct-agg 聚合数已进 style.css', () => {
    expect(css).toContain('.changetree');
    expect(css).toContain('.ct-agg');
  });
});

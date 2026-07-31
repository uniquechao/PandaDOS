/**
 * FileTree 源码断言（bun test 无 DOM，按仓库惯例校验关键不变式）：
 * 懒加载走 /fs?path=、目录可展开折叠、选中文件高亮、按层级缩进、加载/空/错误态齐备。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./FileTree.tsx', import.meta.url), 'utf8');

describe('FileTree 结构约束', () => {
  test('按 /fs?path= 逐层懒加载（展开时才拉子项）', () => {
    expect(source).toContain('/fs?path=');
    // toggle 展开时：未加载过才触发 loadDir
    expect(source).toContain('children[path] === undefined');
    expect(source).toContain('loadDir(path)');
  });

  test('目录可展开/折叠（expanded 态 + 箭头 open）', () => {
    expect(source).toContain('toggleDir');
    expect(source).toContain('ft-arrow');
    expect(source).toMatch(/open/);
  });

  test('选中文件高亮（selectedPath 命中挂 .on）', () => {
    expect(source).toContain('selectedPath === full');
    expect(source).toContain("' on'");
  });

  test('按层级缩进（depth 递增 + INDENT）', () => {
    expect(source).toContain('depth + 1');
    expect(source).toContain('INDENT');
    expect(source).toContain('paddingLeft');
  });

  test('加载/空/错误三态齐备', () => {
    expect(source).toContain("'loading'");
    expect(source).toContain("'error'");
    expect(source).toContain('（空目录）');
    expect(source).toContain('加载失败');
  });

  test('文件点击回调、目录不回调', () => {
    expect(source).toContain('onSelectFile(full)');
  });

  test('reloadToken 变化重拉已加载目录（保留展开态）', () => {
    expect(source).toContain('reloadToken');
    expect(source).toContain('Object.keys(children)');
    expect(source).toContain('[reloadToken]');
  });

  test('切项目或同目录重拉时丢弃迟到响应，避免旧项目文件串入新树', () => {
    expect(source).toContain('const generation = useRef(0);');
    expect(source).toContain('const latestRequest = useRef<Record<string, number>>({});');
    expect(source).toContain('isCurrentTreeRequest(');
    expect(source).toContain('latestRequest.current[path]');
  });
});

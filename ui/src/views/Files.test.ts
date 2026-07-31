/**
 * FilesView 组合布局源码断言（bun test 无 DOM，按仓库惯例校验关键不变式）：
 * useWide 分栏、宽屏 wb-split=FileTree|ListSplitter|FileViewer、窄屏进全屏用 FileViewer、
 * 统一 selected 选中路径、上传落 uploadDir、头部显示打开文件路径面包屑、文件树独立宽度。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./Files.tsx', import.meta.url), 'utf8');

describe('FilesView 分栏组合', () => {
  test('按 useWide 分宽/窄两态', () => {
    expect(source).toContain('useWide');
    expect(source).toContain('wide ?');
  });

  test('宽屏三段：文件树 | 分隔条 | 编辑预览（复用 .wb-split/.gsplit）', () => {
    expect(source).toContain('class="wb-split"');
    expect(source).toContain('<FileTree');
    expect(source).toContain('<ListSplitter');
    expect(source).toContain('<FileViewer');
  });

  test('文件树宽度独立持久化（useTreeWidth，不牵动 issuelist）', () => {
    expect(source).toContain('useTreeWidth');
    expect(source).not.toContain('useListWidth');
  });

  test('窄屏保留「点文件进全屏」，全屏改用 FileViewer 渲染', () => {
    expect(source).toContain('wb-list-full');
    // 目录列表仍在窄屏保留（面包屑 + fsrow）
    expect(source).toContain('class="fslist"');
    expect(source).toContain('class="fsrow"');
  });

  test('统一选中路径 selected（宽窄共用），点文件即 setSelected', () => {
    expect(source).toContain('setSelected');
    expect(source).toContain('selectedPath={selected}');
  });

  test('上传落当前所在目录/根（宽=父目录，窄=浏览目录）', () => {
    expect(source).toContain('uploadDir');
    expect(source).toContain('parentDir(selected)');
    expect(source).toContain('/fs/upload?path=');
  });

  test('上传后刷新：宽屏 bump reloadToken、窄屏重载列表', () => {
    expect(source).toContain('setReload');
    expect(source).toContain('reloadToken={reload}');
  });

  test('头部面包屑显示当前打开文件路径', () => {
    expect(source).toContain('fileCrumbs');
    expect(source).toContain('selected.split(');
  });
});

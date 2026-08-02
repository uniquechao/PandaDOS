/**
 * FileViewer 源码断言（bun test 无 DOM，按仓库惯例校验关键不变式）：
 * previewKind 分支、可编辑 textarea + PUT 保存 + 脏标记、415/413 回落下载、复用 lib/preview。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./FileViewer.tsx', import.meta.url), 'utf8');

describe('FileViewer 结构约束', () => {
  test('复用 lib/preview 的 previewKind 分支', () => {
    expect(source).toContain("from '../lib/preview'");
    expect(source).toContain('previewKind(path)');
  });

  test('图片/网页/PDF → /fs/raw 内联预览', () => {
    expect(source).toContain('/fs/raw?path=');
    expect(source).toContain("kind === 'image'");
    expect(source).toContain("kind === 'html'");
    expect(source).toContain("kind === 'pdf'");
    expect(source).toContain('<iframe');
    expect(source).toContain('sandbox=""');
  });

  test('文本 → 可编辑 textarea + PUT 保存 + 脏标记', () => {
    expect(source).toContain('/fs/file?path=');
    expect(source).toContain('<textarea');
    expect(source).toContain("'PUT'");
    expect(source).toContain('edit.content !== edit.orig'); // 脏标记
    expect(source).toContain("t('ui.saved')");
  });

  test('二进制/超大 415/413 → 回落下载提示', () => {
    expect(source).toContain('e.status === 415');
    expect(source).toContain('e.status === 413');
    expect(source).toContain('setDownloadOnly');
  });

  test('提供下载入口（/fs/download）', () => {
    expect(source).toContain('/fs/download?path=');
  });

  test('path 变化重载 + 防竞态守卫', () => {
    expect(source).toContain('[pid, path]');
    expect(source).toContain('reqPath.current');
  });
});

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

  test('HTML 两种打开方式：安全预览 + 完整网页预览（隔离服务、无 allow-same-origin、可重载/新窗口）', () => {
    expect(source).toContain('/fs/preview?path=');
    expect(source).toContain('sandbox={FULL_PREVIEW_SANDBOX}');
    expect(source).not.toMatch(/FULL_PREVIEW_SANDBOX = '[^']*allow-same-origin/);
    expect(source).not.toMatch(/FULL_PREVIEW_SANDBOX = '[^']*allow-popups/);
    expect(source).toContain("t('ws.htmlSafe')");
    expect(source).toContain("t('ws.htmlFull')");
    expect(source).toContain("t('ws.openNewWindow')");
  });

  test('Markdown 渲染/源码切换，PDF 内嵌预览', () => {
    expect(source).toContain('<Markdown text=');
    expect(source).toContain("t('ws.rendered')");
    expect(source).toContain('fp-frame fp-pdf');
  });

  test('保存带 baseMtimeMs 防覆盖；未保存保护与关页兜底；文件不存在给回父目录', () => {
    expect(source).toContain('baseMtimeMs: edit.mtimeMs');
    expect(source).toContain("e.code === 'workspace.file_changed'");
    expect(source).toContain('beforeunload');
    expect(source).toContain('onDirtyChange?.(dirty)');
    expect(source).toContain("t('ws.fileMissing')");
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
    expect(source).toContain("t('ws.fileTypeSize'");
  });

  test('提供下载入口（/fs/download）', () => {
    expect(source).toContain('/fs/download?path=');
  });

  test('path 变化重载 + 防竞态守卫', () => {
    expect(source).toContain('[pid, path]');
    expect(source).toContain('reqPath.current');
  });

  test('代码/配置文件默认只读高亮，显式切到源码编辑才出 textarea；未保存内容在任意视图下都能保存', () => {
    expect(source).toContain("from '../lib/highlight'");
    expect(source).toContain('langOfPath(path)');
    expect(source).toContain('<CodeView text={edit!.content} lang={lang}');
    expect(source).toContain("useState<'view' | 'edit'>('view')");
    expect(source).toContain("setCodeMode('view');"); // 换文件回到高亮视图
    expect(source).toContain("t('ws.codeView')");
    expect(source).toContain('canSave && (inEditor || dirty)');
  });

  test('HTML 保留安全/完整预览，另有「源码」模式（复用代码视图）', () => {
    expect(source).toContain("type HtmlMode = 'safe' | 'full' | 'source'");
    expect(source).toContain("setHtmlMode('source')");
    expect(source).toContain("t('ws.htmlSource')");
    expect(source).toContain("const textShown = kind !== 'html' || htmlMode === 'source'");
  });
});

/**
 * 文件预览类型判定（对话模式文件侧栏用）。按扩展名分：图片内联 / 网页沙箱 iframe /
 * PDF 下载 / 文本代码 / 其它下载。与后端 core/files.contentTypeForExt 口径大体对齐。
 */

/** 取文件名扩展名（小写，无扩展名返回 ''） */
export function extOf(path: string): string {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

const IMG = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const TEXT = new Set([
  'txt', 'md', 'markdown', 'csv', 'log', 'json', 'xml', 'yaml', 'yml',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'py', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cc', 'cpp', 'hpp', 'sh', 'bash',
  'toml', 'ini', 'conf', 'sql', 'rb', 'php', 'swift', 'vue', 'svelte',
]);

export function isImageExt(ext: string): boolean {
  return IMG.has(ext);
}

export function isImagePath(path: string): boolean {
  return IMG.has(extOf(path));
}

export type PreviewKind = 'image' | 'html' | 'pdf' | 'text' | 'download';

/** 文件路径 → 预览方式 */
export function previewKind(path: string): PreviewKind {
  const e = extOf(path);
  if (IMG.has(e)) return 'image';
  if (e === 'html' || e === 'htm') return 'html';
  if (e === 'pdf') return 'pdf';
  if (TEXT.has(e)) return 'text';
  return 'download';
}

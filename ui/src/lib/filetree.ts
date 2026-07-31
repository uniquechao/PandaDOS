/**
 * ui/lib/filetree —— 文件页左侧可展开文件树的纯逻辑（脱离 DOM，可单测）。
 *
 * 只放「拼子路径」「按条目选图标」两个无副作用小函数；懒加载/展开态等有状态逻辑留在
 * components/FileTree.tsx。图标口径与 Chat 文件侧栏一致（复用 lib/preview 的图片判定）。
 */
import type { FsEntry } from './types';

/** 项目代次和同目录请求号都匹配时，异步目录结果才允许落地。 */
export function isCurrentTreeRequest(
  expectedGeneration: number,
  currentGeneration: number,
  request: number,
  latestRequest: number | undefined,
): boolean {
  return expectedGeneration === currentGeneration && latestRequest === request;
}
import { extOf, isImageExt } from './preview';

/** 拼接「当前目录相对路径」+「子项名」→ 子项相对路径（根目录 rel='' 时不带前导斜杠） */
export function joinChildPath(rel: string, name: string): string {
  return rel ? `${rel}/${name}` : name;
}

/** 按条目类型/扩展名选树节点图标：目录 📁 / 符号链接 🔗 / 图片 🖼 / 普通文件 📄 / 其它 ❓ */
export function treeIcon(entry: FsEntry): string {
  if (entry.type === 'dir') return '📁';
  if (entry.type === 'symlink') return '🔗';
  if (entry.type === 'other') return '❓';
  return isImageExt(extOf(entry.name)) ? '🖼' : '📄';
}

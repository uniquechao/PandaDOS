/**
 * ui/lib/pathcopy —— 工作区「复制路径」的四种结果（issue #388，纯函数）。
 *
 * 1. relative：相对当前工作位置的路径；目录带尾斜杠，根目录为 `.`；
 * 2. absolute：执行机上的绝对路径 `<cwd>/<rel>`（远程执行机时 UI 另外标注「执行机路径」）；
 * 3. link：PandaDOS 内打开同一工作位置与文件的深链；
 * 4. name：最后一段（根目录取 cwd 目录名）。
 * 路径一律原样复制，不加引号、反引号或 shell 转义。
 */
import { workspaceFileUrl } from './workspaceRoute';

export type CopyKind = 'relative' | 'absolute' | 'link' | 'name';
export const COPY_KINDS: readonly CopyKind[] = ['relative', 'absolute', 'link', 'name'];

export interface CopyTarget {
  pid: number;
  /** 当前工作位置（项目）cwd */
  cwd: string;
  /** 相对路径（'' = 根） */
  rel: string;
  dir: boolean;
}

export function copyValue(kind: CopyKind, t: CopyTarget, origin: string): string {
  const rel = t.rel.replace(/\/+$/, '');
  const cwd = t.cwd.length > 1 ? t.cwd.replace(/\/+$/, '') : t.cwd;
  switch (kind) {
    case 'relative':
      return rel ? (t.dir ? `${rel}/` : rel) : '.';
    case 'absolute':
      if (!rel) return cwd === '/' ? '/' : `${cwd}/`;
      return `${cwd === '/' ? '' : cwd}/${rel}${t.dir ? '/' : ''}`;
    case 'link':
      return workspaceFileUrl(origin, t.pid, rel, t.dir);
    case 'name':
      return (rel || cwd).split('/').filter(Boolean).pop() ?? cwd;
  }
}

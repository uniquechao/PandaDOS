import { normalizeRel } from './workspaceRoute';

/** 输入框中的路径：`/` 表示项目根；无前缀时先试当前目录，再试项目根。 */
export function workspacePathCandidates(raw: string, currentDir: string): string[] {
  const input = raw.trim();
  if (!input || input.startsWith('//') || input.includes('\\') || input.includes('\0')) return [];
  const rootPath = input.startsWith('/');
  const rel = normalizeRel(rootPath ? input.slice(1) : input);
  if (!rel) return [];
  if (rootPath) return [rel];
  const local = currentDir ? normalizeRel(`${currentDir}/${rel}`) : rel;
  return [...new Set([local, rel].filter((p): p is string => !!p))];
}

export type WorkspacePathHit = { kind: 'file' | 'dir'; path: string };

/**
 * 搜索框回车的路径直达：按候选顺序查询，第一个精确存在的文件/目录即命中；全部未命中返回 null
 * （调用方回退内容搜索）。文件和目录名允许空格，因此空白不会跳过精确路径查询。
 */
export async function resolveWorkspacePath(
  raw: string,
  currentDir: string,
  stat: (path: string) => Promise<'file' | 'dir' | null>,
): Promise<WorkspacePathHit | null> {
  for (const candidate of workspacePathCandidates(raw, currentDir)) {
    const path = candidate.replace(/\/+$/, '');
    if (!path) continue;
    const kind = await stat(path).catch(() => null);
    if (kind) return { kind, path };
  }
  return null;
}

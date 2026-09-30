/**
 * ui/lib/workspaceRoute —— 项目「工作区」的深链状态（issue #388）。
 *
 * 新入口 `#/p/:pid/workspace[/…]`，每一种可分享的状态都有一条链接：
 *   workspace                               全部文件（默认）
 *   workspace/files/<enc(path)>             文件或目录（目录带尾斜杠；整段 encodeURIComponent，斜杠为 %2F）
 *   workspace/changes[/<group>/<enc(path)>] 当前改动（group = conflict|staged|unstaged|untracked）
 *   workspace/commit/<sha>[/<enc(path)>]    某提交的改动树 / 其中某文件的 diff
 *   workspace/detail/<sha>                  提交详情
 *   workspace/search/<name|content>/<enc(q)> 搜索结果
 * 旧链接保持可用：`#/p/:pid/files[/<enc>]` → files；`#/p/:pid/git` → changes（对话里已发出的文件链接不失效）。
 * 纯函数，无 DOM。
 */

export type ChangeGroup = 'conflict' | 'staged' | 'unstaged' | 'untracked';
export const CHANGE_GROUPS: readonly ChangeGroup[] = ['conflict', 'staged', 'unstaged', 'untracked'];

export type WorkspaceLoc =
  | { view: 'files'; path?: string }
  | { view: 'changes'; group?: ChangeGroup; path?: string }
  | { view: 'commit'; sha: string; path?: string }
  | { view: 'detail'; sha: string }
  | { view: 'search'; mode: 'name' | 'content'; q: string };

const SHA_RE = /^[0-9a-f]{4,40}$/i;

function decode(raw: string | undefined): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

/** 相对路径归一：去掉空段/`.`，含 `..` 视为畸形；保留目录尾斜杠 */
export function normalizeRel(raw: string): string | null {
  const dir = raw.endsWith('/');
  const segs = raw.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segs.some((s) => s === '..')) return null;
  const rel = segs.join('/');
  return rel ? (dir ? `${rel}/` : rel) : '';
}

/** `workspace` 之后的路径段 → 位置；认不出的一律回落到全部文件 */
export function parseWorkspaceParts(parts: string[]): WorkspaceLoc {
  const [view, a, b] = parts;
  if (view === 'files') {
    const p = normalizeRel(decode(a));
    return p ? { view: 'files', path: p } : { view: 'files' };
  }
  if (view === 'changes') {
    if (a && (CHANGE_GROUPS as readonly string[]).includes(a)) {
      const p = normalizeRel(decode(b));
      return p ? { view: 'changes', group: a as ChangeGroup, path: p } : { view: 'changes', group: a as ChangeGroup };
    }
    return { view: 'changes' };
  }
  if ((view === 'commit' || view === 'detail') && a && SHA_RE.test(a)) {
    if (view === 'detail') return { view: 'detail', sha: a };
    const p = normalizeRel(decode(b));
    return p ? { view: 'commit', sha: a, path: p } : { view: 'commit', sha: a };
  }
  if (view === 'search' && (a === 'name' || a === 'content')) {
    const q = decode(b).slice(0, 200);
    if (q) return { view: 'search', mode: a, q };
  }
  return { view: 'files' };
}

/** 旧 `#/p/:pid/files/<enc>` → 位置 */
export function legacyFilesLoc(encoded: string | undefined): WorkspaceLoc {
  const p = normalizeRel(decode(encoded));
  return p ? { view: 'files', path: p } : { view: 'files' };
}

/** 位置 → 路由路径（不带 #，可直接交给 nav） */
export function workspacePath(pid: number, loc: WorkspaceLoc): string {
  const base = `/p/${pid}/workspace`;
  switch (loc.view) {
    case 'files':
      return loc.path ? `${base}/files/${encodeURIComponent(loc.path)}` : base;
    case 'changes':
      if (!loc.group) return `${base}/changes`;
      return loc.path
        ? `${base}/changes/${loc.group}/${encodeURIComponent(loc.path)}`
        : `${base}/changes/${loc.group}`;
    case 'commit':
      return loc.path
        ? `${base}/commit/${loc.sha}/${encodeURIComponent(loc.path)}`
        : `${base}/commit/${loc.sha}`;
    case 'detail':
      return `${base}/detail/${loc.sha}`;
    case 'search':
      return `${base}/search/${loc.mode}/${encodeURIComponent(loc.q)}`;
  }
}

/** 文件/目录的可分享工作区链接（绝对 URL，供「复制工作区链接」） */
export function workspaceFileUrl(origin: string, pid: number, rel: string, dir: boolean): string {
  const p = rel ? (dir ? `${rel.replace(/\/+$/, '')}/` : rel) : '';
  return `${origin}#${workspacePath(pid, p ? { view: 'files', path: p } : { view: 'files' })}`;
}

export function sameLoc(a: WorkspaceLoc, b: WorkspaceLoc): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

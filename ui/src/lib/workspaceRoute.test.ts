import { describe, expect, test } from 'bun:test';
import { copyValue } from './pathcopy';
import { parseWorkspaceParts, workspaceFileUrl, workspacePath, type WorkspaceLoc } from './workspaceRoute';

describe('工作区深链往返', () => {
  const locs: WorkspaceLoc[] = [
    { view: 'files' },
    { view: 'files', path: 'src/web/routes/git.ts' },
    { view: 'files', path: 'docs/' },
    { view: 'files', path: '中文 目录/a b.md' },
    { view: 'changes' },
    { view: 'changes', group: 'conflict' },
    { view: 'changes', group: 'unstaged', path: 'a/b.ts' },
    { view: 'commit', sha: 'deadbeef' },
    { view: 'commit', sha: 'deadbeef', path: 'x/y.ts' },
    { view: 'detail', sha: 'deadbeef' },
    { view: 'search', mode: 'name', q: 'a/b c' },
  ];
  for (const loc of locs) {
    test(JSON.stringify(loc), () => {
      const path = workspacePath(7, loc);
      expect(path.startsWith('/p/7/workspace')).toBe(true);
      const parts = path.split('/').filter(Boolean).slice(3);
      expect(parseWorkspaceParts(parts)).toEqual(loc);
    });
  }
  test('文件路径整体编码为一段（斜杠是 %2F）', () => {
    expect(workspacePath(1, { view: 'files', path: 'a/b.md' })).toBe('/p/1/workspace/files/a%2Fb.md');
    expect(workspaceFileUrl('https://x', 1, 'dir', true)).toBe('https://x#/p/1/workspace/files/dir%2F');
    expect(workspaceFileUrl('https://x', 1, '', true)).toBe('https://x#/p/1/workspace');
  });
});

describe('复制路径四种结果', () => {
  const file = { pid: 3, cwd: '/home/u/proj/', rel: 'src/web/routes/git.ts', dir: false };
  const dir = { pid: 3, cwd: '/home/u/proj', rel: 'src/web', dir: true };
  const root = { pid: 3, cwd: '/home/u/proj', rel: '', dir: true };
  test('相对路径：文件原样、目录带尾斜杠、根目录为 .', () => {
    expect(copyValue('relative', file, 'o')).toBe('src/web/routes/git.ts');
    expect(copyValue('relative', dir, 'o')).toBe('src/web/');
    expect(copyValue('relative', root, 'o')).toBe('.');
  });
  test('执行机绝对路径', () => {
    expect(copyValue('absolute', file, 'o')).toBe('/home/u/proj/src/web/routes/git.ts');
    expect(copyValue('absolute', dir, 'o')).toBe('/home/u/proj/src/web/');
    expect(copyValue('absolute', root, 'o')).toBe('/home/u/proj/');
  });
  test('工作区链接与名称；路径含空格也不加引号', () => {
    expect(copyValue('link', file, 'https://p.x/')).toBe('https://p.x/#/p/3/workspace/files/src%2Fweb%2Froutes%2Fgit.ts');
    expect(copyValue('name', file, 'o')).toBe('git.ts');
    expect(copyValue('name', dir, 'o')).toBe('web');
    expect(copyValue('name', root, 'o')).toBe('proj');
    expect(copyValue('relative', { ...file, rel: 'a b/c d.md' }, 'o')).toBe('a b/c d.md');
  });
});

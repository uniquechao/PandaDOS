/**
 * filetree 单测：文件树纯逻辑（拼子路径 / 图标选择）。bun test 无 DOM，只测这部分。
 */
import { describe, expect, test } from 'bun:test';
import { ancestorDirsOf, isCurrentTreeRequest, joinChildPath, treeIcon } from './filetree';
import type { FsEntry } from './types';

function entry(name: string, type: FsEntry['type']): FsEntry {
  return { name, type, size: null, mtimeMs: null, mode: null };
}

describe('joinChildPath', () => {
  test('根目录（rel=空）→ 不带前导斜杠', () => {
    expect(joinChildPath('', 'a.txt')).toBe('a.txt');
  });
  test('子目录 → rel/name 拼接', () => {
    expect(joinChildPath('src', 'a.txt')).toBe('src/a.txt');
    expect(joinChildPath('src/lib', 'x.ts')).toBe('src/lib/x.ts');
  });
});

describe('treeIcon', () => {
  test('目录 → 📁', () => {
    expect(treeIcon(entry('src', 'dir'))).toBe('📁');
  });
  test('符号链接 → 🔗', () => {
    expect(treeIcon(entry('link', 'symlink'))).toBe('🔗');
  });
  test('其它类型 → ❓', () => {
    expect(treeIcon(entry('sock', 'other'))).toBe('❓');
  });
  test('图片文件 → 🖼（按扩展名）', () => {
    expect(treeIcon(entry('a.png', 'file'))).toBe('🖼');
    expect(treeIcon(entry('b.JPEG', 'file'))).toBe('🖼');
    expect(treeIcon(entry('c.svg', 'file'))).toBe('🖼');
  });
  test('普通文件 → 📄', () => {
    expect(treeIcon(entry('a.ts', 'file'))).toBe('📄');
    expect(treeIcon(entry('README', 'file'))).toBe('📄');
  });
});

describe('isCurrentTreeRequest', () => {
  test('只接受当前项目代次下同目录最后一次请求', () => {
    expect(isCurrentTreeRequest(3, 3, 8, 8)).toBe(true);
    expect(isCurrentTreeRequest(2, 3, 8, 8)).toBe(false);
    expect(isCurrentTreeRequest(3, 3, 7, 8)).toBe(false);
  });
});

describe('ancestorDirsOf（深链展开，issue #310）', () => {
  test('文件目标展开到父目录（由外到内）', () => {
    expect(ancestorDirsOf('a/b/c.md')).toEqual(['a', 'a/b']);
  });

  test('目录目标（尾斜杠）连自己一起展开', () => {
    expect(ancestorDirsOf('a/b/')).toEqual(['a', 'a/b']);
  });

  test('根下的文件不需要展开任何目录', () => {
    expect(ancestorDirsOf('a.md')).toEqual([]);
    expect(ancestorDirsOf('')).toEqual([]);
    expect(ancestorDirsOf(undefined)).toEqual([]);
  });

  test('`..` 逃逸不展开任何目录', () => {
    expect(ancestorDirsOf('../x/a.md')).toEqual([]);
  });
});

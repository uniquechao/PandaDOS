import { describe, expect, test } from 'bun:test';
import {
  buildChangeTree,
  dedupWorktree,
  type ChangeDirNode,
  type ChangeFileNode,
  type ChangeLeaf,
  type ChangeNode,
} from './changetree';

const leaf = (path: string, extra: Partial<ChangeLeaf> = {}): ChangeLeaf => ({
  key: `t:${path}`,
  path,
  code: 'M',
  ...extra,
});

const dir = (n: ChangeNode): ChangeDirNode => {
  expect(n.type).toBe('dir');
  return n as ChangeDirNode;
};
const file = (n: ChangeNode): ChangeFileNode => {
  expect(n.type).toBe('file');
  return n as ChangeFileNode;
};

describe('buildChangeTree：构树/排序/压缩/聚合', () => {
  test('空列表 → 空树', () => {
    expect(buildChangeTree([])).toEqual([]);
  });

  test('根文件与目录：目录在前、文件在后，各按名字典序', () => {
    const tree = buildChangeTree([
      leaf('README.md'),
      leaf('zeta.txt'),
      leaf('src/a.ts'),
      leaf('docs/x.md'),
    ]);
    expect(tree.map((n) => [n.type, n.name])).toEqual([
      ['dir', 'docs'],
      ['dir', 'src'],
      ['file', 'README.md'],
      ['file', 'zeta.txt'],
    ]);
  });

  test('单子目录链压缩：全部改动集中在深目录时顶层就一个链节点', () => {
    const tree = buildChangeTree([
      leaf('src/web/routes/git.ts'),
      leaf('src/web/routes/index.ts'),
    ]);
    expect(tree).toHaveLength(1);
    const d = dir(tree[0]!);
    expect(d.name).toBe('src/web/routes');
    expect(d.path).toBe('src/web/routes'); // 压缩链的最深一级完整路径
    expect(d.files).toBe(2);
    expect(d.children.map((c) => c.name)).toEqual(['git.ts', 'index.ts']);
  });

  test('分叉处停止压缩：子目录多于一个时保留本级', () => {
    const tree = buildChangeTree([leaf('src/a/x.ts'), leaf('src/b/y.ts')]);
    expect(tree).toHaveLength(1);
    const src = dir(tree[0]!);
    expect(src.name).toBe('src');
    expect(src.files).toBe(2);
    expect(src.children.map((c) => [c.type, c.name])).toEqual([
      ['dir', 'a'],
      ['dir', 'b'],
    ]);
  });

  test('目录自身带文件不压缩；子目录树内继续压缩', () => {
    const tree = buildChangeTree([leaf('src/x.ts'), leaf('src/web/deep/y.ts')]);
    const src = dir(tree[0]!);
    expect(src.name).toBe('src');
    // 子目录 web 只有一个子目录 deep → 压成 'web/deep'
    expect(src.children.map((c) => [c.type, c.name])).toEqual([
      ['dir', 'web/deep'],
      ['file', 'x.ts'],
    ]);
    expect(dir(src.children[0]!).path).toBe('src/web/deep');
  });

  test('目录聚合：叶子文件数 + 增删行合计（二进制 null 不计入）', () => {
    const tree = buildChangeTree([
      leaf('src/a.ts', { adds: 10, dels: 2 }),
      leaf('src/deep/b.ts', { adds: 3, dels: 1 }),
      leaf('src/img.png', { adds: null, dels: null }),
    ]);
    const src = dir(tree[0]!);
    expect(src.files).toBe(3);
    expect(src.adds).toBe(13);
    expect(src.dels).toBe(3);
    // 子目录自身聚合
    const deep = dir(src.children[0]!);
    expect(deep.files).toBe(1);
    expect(deep.adds).toBe(3);
    expect(deep.dels).toBe(1);
  });

  test('叶子保留原始信息（key/code/oldPath），文件名取 basename', () => {
    const tree = buildChangeTree([
      leaf('src/new.ts', { key: 'range:src/new.ts', code: 'R', oldPath: 'src/old.ts' }),
    ]);
    const f = file(dir(tree[0]!).children[0]!);
    expect(f.name).toBe('new.ts');
    expect(f.leaf.key).toBe('range:src/new.ts');
    expect(f.leaf.code).toBe('R');
    expect(f.leaf.oldPath).toBe('src/old.ts');
  });
});

describe('dedupWorktree：porcelain 两列码按路径归一', () => {
  test('未跟踪 / 暂存+未暂存 / 仅未暂存 / 仅暂存 → 每路径一条单字母码', () => {
    const out = dedupWorktree([
      { status: '??', path: 'new.txt' },
      { status: 'MM', path: 'a.ts' },
      { status: ' M', path: 'b.ts' },
      { status: 'A ', path: 'c.ts' },
    ]);
    expect(out).toEqual([
      { path: 'new.txt', code: '?', untracked: true },
      { path: 'a.ts', code: 'M', untracked: false },
      { path: 'b.ts', code: 'M', untracked: false },
      { path: 'c.ts', code: 'A', untracked: false },
    ]);
  });

  test('重命名保留 oldPath；重复路径只留第一条', () => {
    const out = dedupWorktree([
      { status: 'R ', path: 'n.ts', oldPath: 'o.ts' },
      { status: ' M', path: 'n.ts' },
    ]);
    expect(out).toEqual([{ path: 'n.ts', code: 'R', untracked: false, oldPath: 'o.ts' }]);
  });
});

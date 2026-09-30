import { describe, expect, test } from 'bun:test';
import { resolveWorkspacePath, workspacePathCandidates } from './workspacePathLookup';

describe('工作区相对路径直达候选', () => {
  test('当前目录优先，同时可输入项目根相对路径', () => {
    expect(workspacePathCandidates('views/Workspace.tsx', 'ui/src')).toEqual([
      'ui/src/views/Workspace.tsx', 'views/Workspace.tsx',
    ]);
    expect(workspacePathCandidates('ui/src/views/Workspace.tsx', 'ui/src')).toEqual([
      'ui/src/ui/src/views/Workspace.tsx', 'ui/src/views/Workspace.tsx',
    ]);
    expect(workspacePathCandidates('/src/messages.ts', 'src')).toEqual(['src/messages.ts']);
    expect(workspacePathCandidates('/src/', 'ui')).toEqual(['src/']);
  });

  test('拒绝越界和非工作区路径输入', () => {
    for (const input of ['//etc/passwd', '../secret', '/../../secret', './../../secret', 'a\\b', 'a\0b']) {
      expect(workspacePathCandidates(input, 'src')).toEqual([]);
    }
  });
});

describe('工作区相对路径直达解析', () => {
  const fs: Record<string, 'file' | 'dir'> = {
    'ui/src/views/Workspace.tsx': 'file',
    'ui/src/views': 'dir',
    'src/core': 'dir',
    'src/messages.ts': 'file',
    'README.md': 'file',
    'docs/My Guide.md': 'file',
  };
  const seen: string[] = [];
  const stat = async (p: string) => { seen.push(p); return fs[p] ?? null; };

  test('当前目录相对优先，其次项目根相对；目录命中返回 dir', async () => {
    expect(await resolveWorkspacePath('views/Workspace.tsx', 'ui/src', stat)).toEqual({ kind: 'file', path: 'ui/src/views/Workspace.tsx' });
    expect(await resolveWorkspacePath('ui/src/views/Workspace.tsx', 'ui/src', stat)).toEqual({ kind: 'file', path: 'ui/src/views/Workspace.tsx' });
    expect(await resolveWorkspacePath('views/', 'ui/src', stat)).toEqual({ kind: 'dir', path: 'ui/src/views' });
    expect(await resolveWorkspacePath('./README.md', '', stat)).toEqual({ kind: 'file', path: 'README.md' });
    expect(await resolveWorkspacePath('docs/My Guide.md', '', stat)).toEqual({ kind: 'file', path: 'docs/My Guide.md' });
    expect(await resolveWorkspacePath('/src/messages.ts', 'src', stat)).toEqual({ kind: 'file', path: 'src/messages.ts' });
  });

  test('未命中、越界、含空白的关键词 → null（回退内容搜索），越界输入不发查询', async () => {
    seen.length = 0;
    expect(await resolveWorkspacePath('nope/x.ts', 'src', stat)).toBeNull();
    expect(await resolveWorkspacePath('../secret', 'src', stat)).toBeNull();
    expect(await resolveWorkspacePath('/../../secret', 'src', stat)).toBeNull();
    expect(await resolveWorkspacePath('src core', '', stat)).toBeNull();
    expect(seen).toEqual(['src/nope/x.ts', 'nope/x.ts', 'src core']);
  });

  test('查询失败按未命中处理', async () => {
    expect(await resolveWorkspacePath('a.ts', '', async () => { throw new Error('net'); })).toBeNull();
  });
});

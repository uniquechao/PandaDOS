import { describe, expect, test } from 'bun:test';
import type { Executor } from '../core/types';
import type { DiscoveryDriver } from './discovery';
import { detectExecutorCapabilities } from './discovery';

function executor(patch: Partial<Executor> = {}): Executor {
  return {
    id: 1,
    name: 'remote',
    host: '10.0.0.2',
    port: 22,
    sshUser: 'dev',
    keyRef: 'key',
    workspaceRoot: '/custom/work',
    claudeDir: '/custom/claude',
    codexDir: '/custom/codex',
    supportsClaude: true,
    supportsCodex: true,
    isSystemLocal: false,
    capabilitiesCheckedTs: null,
    status: 'unknown',
    ...patch,
  };
}

function driver(options: {
  commands?: Partial<Record<'claude' | 'codex', string>>;
  dirs?: string[];
  passwd?: string;
}): DiscoveryDriver {
  const dirs = new Set(options.dirs ?? []);
  return {
    findExecutable: async (agent) => options.commands?.[agent] ?? null,
    statPath: async (path) =>
      dirs.has(path)
        ? { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 }
        : null,
    readFileRange: async () => {
      const data = new TextEncoder().encode(options.passwd ?? '');
      return { data, size: data.byteLength };
    },
  };
}

describe('执行机 Agent 受限探测', () => {
  test('远程 Home、workspace 顺序、命令与状态目录证据分开返回', async () => {
    const result = await detectExecutorCapabilities(
      executor(),
      driver({
        passwd: 'root:x:0:0:root:/root:/bin/sh\ndev:x:501:20:Dev:/Users/dev:/bin/zsh\n',
        commands: { claude: '/opt/homebrew/bin/claude' },
        dirs: ['/Users/dev/workspace', '/Users/dev/.codex/sessions'],
      }),
      { now: () => 42 },
    );
    expect(result.homeDir).toBe('/Users/dev');
    expect(result.workspaceSuggestion).toBe('/Users/dev/workspace');
    expect(result.agents.claude).toMatchObject({
      commandFound: true,
      stateDirFound: false,
      suggestedDir: '/Users/dev/.claude/projects',
      currentDir: '/custom/claude',
    });
    expect(result.agents.codex).toMatchObject({
      commandFound: false,
      stateDirFound: true,
      suggestedDir: '/Users/dev/.codex/sessions',
      currentDir: '/custom/codex',
    });
    expect(result.current.workspaceRoot).toBe('/custom/work');
    expect(result.checkedTs).toBe(42);
  });

  test('无法识别 Home 时给 warning，不伪造目录建议', async () => {
    const result = await detectExecutorCapabilities(
      executor(),
      driver({ passwd: 'root:x:0:0:root:/root:/bin/sh\n' }),
    );
    expect(result.homeDir).toBeNull();
    expect(result.workspaceSuggestion).toBeNull();
    expect(result.agents.claude.suggestedDir).toBeNull();
    expect(result.warnings[0]).toContain('dev');
  });

  test('系统本机兼容 macOS Home，并保留人工 current 值', async () => {
    const result = await detectExecutorCapabilities(
      executor({ isSystemLocal: true }),
      driver({ dirs: ['/Users/me/user_space/users'] }),
      { localHomeDir: '/Users/me' },
    );
    expect(result.homeDir).toBe('/Users/me');
    expect(result.workspaceSuggestion).toBe('/Users/me/user_space/users');
    expect(result.current).toEqual({
      workspaceRoot: '/custom/work',
      claudeDir: '/custom/claude',
      codexDir: '/custom/codex',
    });
  });
});

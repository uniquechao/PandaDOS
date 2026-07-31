import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import {
  discoverLocalExecutorDefaults,
  ensureSystemLocalExecutor,
  executorAgentReferences,
  executorSupportsAgent,
  getExecutor,
  listExecutors,
  projectAgentSupport,
  supportedAgents,
} from './executors';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';

describe('Executor store', () => {
  test('统一映射能力列并按 id 读取', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.query(
      `INSERT INTO executors
         (name, host, port, ssh_user, key_ref, workspace_root, claude_dir,
          supports_claude, supports_codex, codex_dir, is_system_local, capabilities_checked_ts)
       VALUES ('local', '127.0.0.1', 22, '', '', '/work', '/home/u/.claude/projects',
               1, 0, '/home/u/.codex/sessions', 1, 123)`,
    ).run();

    const ex = listExecutors(db)[0]!;
    expect(ex).toEqual({
      id: 1,
      name: 'local',
      host: '127.0.0.1',
      port: 22,
      sshUser: '',
      keyRef: '',
      workspaceRoot: '/work',
      claudeDir: '/home/u/.claude/projects',
      codexDir: '/home/u/.codex/sessions',
      supportsClaude: true,
      supportsCodex: false,
      isSystemLocal: true,
      capabilitiesCheckedTs: 123,
      status: 'unknown',
    });
    expect(getExecutor(db, 1)).toEqual(ex);
    expect(getExecutor(db, 999)).toBeUndefined();
    db.close();
  });

  test('supportedAgents 顺序稳定且 executorSupportsAgent 与其一致', () => {
    expect(supportedAgents({ supportsClaude: true, supportsCodex: true })).toEqual([
      'claude',
      'codex',
    ]);
    expect(supportedAgents({ supportsClaude: false, supportsCodex: true })).toEqual(['codex']);
    expect(supportedAgents({ supportsClaude: false, supportsCodex: false })).toEqual([]);
    expect(executorSupportsAgent({ supportsClaude: true, supportsCodex: false }, 'claude')).toBe(true);
    expect(executorSupportsAgent({ supportsClaude: true, supportsCodex: false }, 'codex')).toBe(false);
  });
});

describe('执行机 Agent 集中校验', () => {
  test('项目能力错误统一，并只统计未结束的 Agent 引用', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.query(
      `INSERT INTO users (username, token_hash, role, created_ts)
       VALUES ('u', 'h', 'user', 0)`,
    ).run();
    db.query(
      `INSERT INTO executors
         (name, host, ssh_user, key_ref, workspace_root, claude_dir,
          supports_claude, supports_codex)
       VALUES ('local', '127.0.0.1', '', '', '/w', '/c', 1, 0)`,
    ).run();
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p', 1, '/w/p', 1, 0)`,
    ).run();
    expect(projectAgentSupport(db, 1, 'claude')).toEqual({ ok: true, executorName: 'local' });
    expect(projectAgentSupport(db, 1, 'codex')).toEqual({
      ok: false,
      executorName: 'local',
      error: '执行机 local 未启用 Codex，请在管理后台启用或为项目更换执行机',
    });

    db.query(
      `INSERT INTO issues (project_id, title, agent, status, created_ts)
       VALUES (1, 'active', 'codex', 'pending', 0), (1, 'done', 'codex', 'done', 0)`,
    ).run();
    db.query(
      `INSERT INTO project_modules
         (project_id, slug, display_name, agent, source, status, created_ts)
       VALUES (1, 'a', 'A', 'codex', 'manual', 'active', 0),
              (1, 'b', 'B', 'codex', 'manual', 'archived', 0)`,
    ).run();
    db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind, archived)
       VALUES ('a', 1, 'A', 0, 'codex', 'chat', 0),
              ('b', 1, 'B', 0, 'codex', 'chat', 1)`,
    ).run();
    expect(executorAgentReferences(db, 1, 'codex')).toEqual({
      issues: 1,
      modules: 1,
      conversations: 1,
    });
    db.close();
  });
});

describe('系统本机执行机引导', () => {
  const defaults = {
    workspaceRoot: '/home/me/workspace',
    claudeDir: '/home/me/.claude/projects',
    codexDir: '/home/me/.codex/sessions',
    supportsClaude: true,
    supportsCodex: false,
    checkedTs: 456,
  };

  test('空库创建 local，重复调用保持唯一', () => {
    const db = openDb(':memory:');
    migrate(db);
    const first = ensureSystemLocalExecutor(db, defaults);
    const second = ensureSystemLocalExecutor(db, defaults);
    expect(first.name).toBe('local');
    expect(second.id).toBe(first.id);
    expect(listExecutors(db).filter((x) => x.isSystemLocal)).toHaveLength(1);
    expect(first).toMatchObject({
      host: '127.0.0.1',
      keyRef: '',
      workspaceRoot: '/home/me/workspace',
      supportsClaude: true,
      supportsCodex: false,
    });
    db.close();
  });

  test('优先提升已有本机且保留配置；远程占用 local 时新建 local-system', () => {
    const db = openDb(':memory:');
    migrate(db);
    db.query(
      `INSERT INTO executors
         (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('existing', 'localhost', 22, '', '', '/keep', '/keep/.claude/projects')`,
    ).run();
    expect(ensureSystemLocalExecutor(db, defaults)).toMatchObject({
      name: 'existing',
      workspaceRoot: '/keep',
      isSystemLocal: true,
    });
    db.close();

    const db2 = openDb(':memory:');
    migrate(db2);
    db2.query(
      `INSERT INTO executors
         (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '10.0.0.2', 22, 'root', 'key', '/remote', '/root/.claude/projects')`,
    ).run();
    expect(ensureSystemLocalExecutor(db2, defaults).name).toBe('local-system');
    expect(listExecutors(db2)).toHaveLength(2);
    db2.close();
  });

  test('自动发现按候选顺序选择 workspace，并按命令/状态目录勾选 Agent', () => {
    const existing = new Set([
      '/home/me/workspace',
      '/home/me/projects',
      '/home/me/.codex',
    ]);
    const found = discoverLocalExecutorDefaults({
      homeDir: '/home/me',
      envWorkspaceRoot: '/missing/env',
      pathExists: (p) => existing.has(p),
      commandExists: (agent) => agent === 'claude',
      now: () => 789,
    });
    expect(found).toEqual({
      workspaceRoot: '/home/me/workspace',
      claudeDir: '/home/me/.claude/projects',
      codexDir: '/home/me/.codex/sessions',
      supportsClaude: true,
      supportsCodex: true,
      checkedTs: 789,
    });
  });

  test('未检测到 Agent 时兼容预选 Claude；无候选 workspace 回落 ~/workspace', () => {
    expect(
      discoverLocalExecutorDefaults({
        homeDir: '/Users/me',
        pathExists: () => false,
        commandExists: () => false,
        now: () => 1,
      }),
    ).toMatchObject({
      workspaceRoot: '/Users/me/workspace',
      supportsClaude: true,
      supportsCodex: false,
    });
  });
});

import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import type { Executor } from '../core/types';
import { migrateIssueEngine } from './engine';
import { dedicatedIsolationViolation, probeDedicatedOsBoundary } from './execution-isolation';

const executor: Executor = {
  id: 1, name: 'isolated', host: '127.0.0.1', port: 22, sshUser: 'panda_iso', keyRef: 'isolation-key',
  workspaceRoot: '/home/panda_iso/work', claudeDir: '/home/panda_iso/.claude/projects', codexDir: '/home/panda_iso/.codex',
  supportsClaude: true, supportsCodex: true, isSystemLocal: false, capabilitiesCheckedTs: 1, status: 'online',
};

describe('dedicated SSH OS isolation', () => {
  test('rejects root, shared OS identities, misleading runUser and escaped workspaces', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run("INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'owner', 'x', 'admin', 1)");
    db.run("INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir) VALUES (1, 'isolated', '127.0.0.1', 22, 'panda_iso', 'isolation-key', '/home/panda_iso/work', '/home/panda_iso/.claude/projects')");
    const project = { id: 1, cwd: '/home/panda_iso/work/app', runUser: '', executionIsolation: 'dedicated-ssh' as const };
    expect(dedicatedIsolationViolation(db, project, executor)).toBeNull();
    expect(dedicatedIsolationViolation(db, project, { ...executor, sshUser: 'root' })).toContain('非 root');
    expect(dedicatedIsolationViolation(db, { ...project, runUser: 'someone_else' }, executor)).toContain('不一致');
    expect(dedicatedIsolationViolation(db, { ...project, cwd: '/home/panda_iso/work-other/app' }, executor)).toContain('工作根目录');
    db.run("INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (2, 'other', 1, '/home/panda_iso/work/other', 1, 1)");
    expect(dedicatedIsolationViolation(db, project, executor)).toContain('其他项目');
    db.close();
  });

  test('probes actual non-root account, private root and absence of passwordless sudo', async () => {
    const driver = {
      statPath: async () => ({ isDirectory: true, isFile: false, size: 0, mode: 0o700, mtimeMs: 1 }),
      runCommand: async (_cwd: string, argv: string[]) => ({
        code: argv[0] === 'sudo' ? 1 : 0,
        out: argv[1] === '-u' ? '1009\n' : argv[1] === '-un' ? 'panda_iso\n' : '',
        err: '',
      }),
    };
    expect(await probeDedicatedOsBoundary(driver, executor)).toBeNull();
    expect(await probeDedicatedOsBoundary({ ...driver, statPath: async () => ({ isDirectory: true, isFile: false, size: 0, mode: 0o755, mtimeMs: 1 }) }, executor))
      .toContain('0700');
    expect(await probeDedicatedOsBoundary({ ...driver, runCommand: async () => ({ code: 0, out: '0\n', err: '' }) }, executor))
      .toContain('非 root');
    expect(await probeDedicatedOsBoundary({ ...driver, runCommand: async (_cwd: string, argv: string[]) => ({
      code: 0, out: argv[1] === '-u' ? '1009\n' : 'panda_iso\n', err: '',
    }) }, executor)).toContain('sudo');
  });
});

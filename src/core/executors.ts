import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentKind, Executor, ExecutorStatus } from './types';

export interface ExecutorRow {
  id: number;
  name: string;
  host: string;
  port: number;
  ssh_user: string;
  key_ref: string;
  workspace_root: string;
  claude_dir: string;
  codex_dir: string;
  supports_claude: number;
  supports_codex: number;
  is_system_local: number;
  capabilities_checked_ts: number | null;
  status: string;
}

export function mapExecutor(r: ExecutorRow): Executor {
  return {
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    sshUser: r.ssh_user,
    keyRef: r.key_ref,
    workspaceRoot: r.workspace_root,
    claudeDir: r.claude_dir,
    codexDir: r.codex_dir,
    supportsClaude: r.supports_claude === 1,
    supportsCodex: r.supports_codex === 1,
    isSystemLocal: r.is_system_local === 1,
    capabilitiesCheckedTs: r.capabilities_checked_ts,
    status: r.status as ExecutorStatus,
  };
}

export function listExecutors(db: Database): Executor[] {
  return db.query<ExecutorRow, []>('SELECT * FROM executors ORDER BY id').all().map(mapExecutor);
}

export function getExecutor(db: Database, id: number): Executor | undefined {
  const row = db.query<ExecutorRow, [number]>('SELECT * FROM executors WHERE id = ?').get(id);
  return row ? mapExecutor(row) : undefined;
}

export function supportedAgents(
  executor: Pick<Executor, 'supportsClaude' | 'supportsCodex'>,
): AgentKind[] {
  return [
    ...(executor.supportsClaude ? (['claude'] as const) : []),
    ...(executor.supportsCodex ? (['codex'] as const) : []),
  ];
}

export function executorSupportsAgent(
  executor: Pick<Executor, 'supportsClaude' | 'supportsCodex'>,
  agent: AgentKind,
): boolean {
  return agent === 'claude' ? executor.supportsClaude : executor.supportsCodex;
}

export type AgentSupportResult =
  | { ok: true; executorName: string }
  | { ok: false; executorName: string; error: string };

export interface AgentReferenceCounts {
  issues: number;
  modules: number;
  conversations: number;
}

function agentLabel(agent: AgentKind): string {
  return agent === 'claude' ? 'Claude' : 'Codex';
}

export function projectAgentSupport(
  db: Database,
  projectId: number,
  agent: AgentKind,
): AgentSupportResult {
  const row = db
    .query<{ name: string; supports_claude: number; supports_codex: number }, [number]>(
      `SELECT e.name, e.supports_claude, e.supports_codex
       FROM projects p JOIN executors e ON e.id = p.executor_id
       WHERE p.id = ?`,
    )
    .get(projectId);
  const executorName = row?.name ?? '未知';
  const supported =
    row && (agent === 'claude' ? row.supports_claude === 1 : row.supports_codex === 1);
  return supported
    ? { ok: true, executorName }
    : {
        ok: false,
        executorName,
        error: `执行机 ${executorName} 未启用 ${agentLabel(agent)}，请在管理后台启用或为项目更换执行机`,
      };
}

export function executorAgentReferences(
  db: Database,
  executorId: number,
  agent: AgentKind,
): AgentReferenceCounts {
  const count = (table: 'issues' | 'project_modules' | 'conversations', extra: string): number =>
    db
      .query<{ n: number }, [number, AgentKind]>(
        `SELECT COUNT(*) AS n
         FROM ${table} x JOIN projects p ON p.id = x.project_id
         WHERE p.executor_id = ? AND x.agent = ? AND ${extra}`,
      )
      .get(executorId, agent)!.n;
  return {
    issues: count('issues', "x.status NOT IN ('done', 'cancelled')"),
    modules: count('project_modules', "x.status = 'active'"),
    conversations: count('conversations', "x.kind = 'chat' AND x.archived = 0"),
  };
}

export interface LocalExecutorDefaults {
  workspaceRoot: string;
  claudeDir: string;
  codexDir: string;
  supportsClaude: boolean;
  supportsCodex: boolean;
  checkedTs: number;
}

export interface LocalExecutorDiscoveryOptions {
  homeDir?: string;
  envWorkspaceRoot?: string;
  pathExists?(path: string): boolean;
  commandExists?(agent: AgentKind): boolean;
  now?(): number;
}

export function discoverLocalExecutorDefaults(
  options: LocalExecutorDiscoveryOptions = {},
): LocalExecutorDefaults {
  const home = options.homeDir ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const commandExists = options.commandExists ?? ((agent: AgentKind) => Bun.which(agent) !== null);
  const envRoot = options.envWorkspaceRoot ?? process.env.PANDA_WORKSPACE_ROOT;
  const candidates = [
    ...(envRoot && isAbsolute(envRoot) ? [envRoot] : []),
    join(home, 'user_space', 'users'),
    join(home, 'workspace'),
    join(home, 'projects'),
  ];
  const workspaceRoot = candidates.find(pathExists) ?? join(home, 'workspace');
  const claudeState = join(home, '.claude');
  const codexState = join(home, '.codex');
  const detectedClaude = commandExists('claude');
  const detectedCodex = commandExists('codex');
  return {
    workspaceRoot,
    claudeDir: join(claudeState, 'projects'),
    codexDir: join(codexState, 'sessions'),
    supportsClaude: detectedClaude,
    supportsCodex: detectedCodex,
    checkedTs: (options.now ?? Date.now)(),
  };
}

export function ensureSystemLocalExecutor(
  db: Database,
  defaults: LocalExecutorDefaults,
): Executor {
  const run = db.transaction((): Executor => {
    const system = db
      .query<ExecutorRow, []>('SELECT * FROM executors WHERE is_system_local = 1 LIMIT 1')
      .get();
    if (system) return mapExecutor(system);

    const local = db
      .query<ExecutorRow, []>(
        `SELECT * FROM executors
         WHERE host IN ('127.0.0.1', 'localhost') AND key_ref = ''
         ORDER BY id LIMIT 1`,
      )
      .get();
    if (local) {
      db.query('UPDATE executors SET is_system_local = 1 WHERE id = ?').run(local.id);
      return getExecutor(db, local.id)!;
    }

    const name = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM executors WHERE name = 'local'").get()!
      .n
      ? 'local-system'
      : 'local';
    const row = db
      .query<
        ExecutorRow,
        [string, string, string, string, number, number, number]
      >(
        `INSERT INTO executors
           (name, host, port, ssh_user, key_ref, workspace_root, claude_dir, codex_dir,
            supports_claude, supports_codex, is_system_local, capabilities_checked_ts)
         VALUES (?, '127.0.0.1', 22, '', '', ?, ?, ?, ?, ?, 1, ?)
         RETURNING *`,
      )
      .get(
        name,
        defaults.workspaceRoot,
        defaults.claudeDir,
        defaults.codexDir,
        defaults.supportsClaude ? 1 : 0,
        defaults.supportsCodex ? 1 : 0,
        defaults.checkedTs,
      );
    if (!row) throw new Error('创建系统本机执行机失败');
    return mapExecutor(row);
  });

  try {
    return run();
  } catch (error) {
    const raced = db
      .query<ExecutorRow, []>('SELECT * FROM executors WHERE is_system_local = 1 LIMIT 1')
      .get();
    if (raced) return mapExecutor(raced);
    throw error;
  }
}

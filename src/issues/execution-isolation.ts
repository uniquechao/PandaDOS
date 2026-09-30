import type { Database } from 'bun:sqlite';
import type { Executor, Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';

type ScopedProject = Pick<Project, 'id' | 'cwd' | 'runUser' | 'executionIsolation'>;

/** Dedicated mode binds exactly one project to one unprivileged SSH OS account. */
export function dedicatedIsolationViolation(db: Database, project: ScopedProject, executor: Executor): string | null {
  if (project.executionIsolation !== 'dedicated-ssh') return null;
  if (!executor.keyRef || !executor.sshUser || executor.sshUser === 'root') {
    return '专用隔离要求使用非 root 的 SSH 账号与独立密钥';
  }
  if (project.runUser && project.runUser !== executor.sshUser) {
    return '项目运行用户与 SSH 执行身份不一致';
  }
  const root = executor.workspaceRoot.replace(/\/+$/, '');
  if (!root.startsWith('/') || root === '' || root === '/' || !project.cwd.startsWith(`${root}/`)) {
    return '专用隔离项目必须位于执行账号的专属工作根目录内';
  }
  const shared = db.query<{ id: number }, [string, number]>(
    `SELECT p.id FROM projects p JOIN executors e ON e.id = p.executor_id
     WHERE e.ssh_user = ? AND p.id <> ? LIMIT 1`,
  ).get(executor.sshUser, project.id);
  if (shared) return '同一 SSH 系统账号已经绑定其他项目，不能声明专用隔离';
  return null;
}

/** Verify the actual SSH process identity and private workspace before creating a project. */
export async function probeDedicatedOsBoundary(
  driver: Pick<ExecutorDriver, 'statPath'> & {
    runCommand(cwd: string, argv: string[], timeoutMs: number): Promise<{ code: number; out: string }>;
  },
  executor: Executor,
): Promise<string | null> {
  const root = executor.workspaceRoot.replace(/\/+$/, '');
  try {
    const stat = await driver.statPath(root);
    if (!stat?.isDirectory || stat.mode === undefined || (stat.mode & 0o077) !== 0) {
      return '专用工作根目录必须存在且仅执行账号可访问（0700）';
    }
    const uid = await driver.runCommand(root, ['id', '-u'], 5_000);
    const name = await driver.runCommand(root, ['id', '-un'], 5_000);
    if (uid.code !== 0 || name.code !== 0 || !/^\d+$/.test(uid.out.trim())
      || Number(uid.out.trim()) === 0 || name.out.trim() !== executor.sshUser) {
      return 'SSH 实际进程身份与专用非 root 执行账号不一致';
    }
    const sudo = await driver.runCommand(root, ['sudo', '-n', 'true'], 5_000);
    if (sudo.code === 0) return '专用执行账号拥有无交互 sudo 权限';
    return null;
  } catch (error) {
    return `无法验证专用 SSH 执行边界：${String(error).slice(0, 200)}`;
  }
}

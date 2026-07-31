import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { ExecutorDriver } from './driver';
import type { AgentKind, Executor } from '../core/types';

export type DiscoveryDriver = Pick<
  ExecutorDriver,
  'findExecutable' | 'statPath' | 'readFileRange'
>;

export interface AgentDetection {
  currentDir: string;
  commandPath: string | null;
  commandFound: boolean;
  stateDirFound: boolean;
  suggestedDir: string | null;
}

export interface ExecutorDetection {
  homeDir: string | null;
  current: {
    workspaceRoot: string;
    claudeDir: string;
    codexDir: string;
  };
  workspaceSuggestion: string | null;
  agents: Record<AgentKind, AgentDetection>;
  warnings: string[];
  checkedTs: number;
}

export interface DetectionOptions {
  localHomeDir?: string;
  now?(): number;
}

async function remoteHome(executor: Executor, driver: DiscoveryDriver): Promise<string | null> {
  const file = await driver.readFileRange('/etc/passwd', 0, 1024 * 1024);
  const text = new TextDecoder().decode(file.data);
  for (const line of text.split('\n')) {
    const fields = line.split(':');
    if (fields[0] === executor.sshUser && fields[5]?.startsWith('/')) return fields[5];
  }
  return null;
}

async function isDirectory(driver: DiscoveryDriver, path: string): Promise<boolean> {
  return (await driver.statPath(path))?.isDirectory === true;
}

export async function detectExecutorCapabilities(
  executor: Executor,
  driver: DiscoveryDriver,
  options: DetectionOptions = {},
): Promise<ExecutorDetection> {
  const warnings: string[] = [];
  const homeDir = executor.isSystemLocal
    ? (options.localHomeDir ?? homedir())
    : await remoteHome(executor, driver);
  if (!homeDir) warnings.push(`无法从 /etc/passwd 解析用户 ${executor.sshUser} 的 Home`);

  let workspaceSuggestion: string | null = null;
  if (homeDir) {
    const workspaceCandidates = [
      posix.join(homeDir, 'user_space', 'users'),
      posix.join(homeDir, 'workspace'),
      posix.join(homeDir, 'projects'),
    ];
    for (const candidate of workspaceCandidates) {
      if (await isDirectory(driver, candidate)) {
        workspaceSuggestion = candidate;
        break;
      }
    }
    workspaceSuggestion ??= posix.join(homeDir, 'workspace');
  }

  const detectAgent = async (agent: AgentKind, currentDir: string): Promise<AgentDetection> => {
    const suggestedDir = homeDir
      ? posix.join(homeDir, agent === 'claude' ? '.claude/projects' : '.codex/sessions')
      : null;
    const [commandPath, stateDirFound] = await Promise.all([
      driver.findExecutable(agent),
      suggestedDir ? isDirectory(driver, suggestedDir) : Promise.resolve(false),
    ]);
    return {
      currentDir,
      commandPath,
      commandFound: commandPath !== null,
      stateDirFound,
      suggestedDir,
    };
  };

  const [claude, codex] = await Promise.all([
    detectAgent('claude', executor.claudeDir),
    detectAgent('codex', executor.codexDir),
  ]);

  return {
    homeDir,
    current: {
      workspaceRoot: executor.workspaceRoot,
      claudeDir: executor.claudeDir,
      codexDir: executor.codexDir,
    },
    workspaceSuggestion,
    agents: { claude, codex },
    warnings,
    checkedTs: (options.now ?? Date.now)(),
  };
}

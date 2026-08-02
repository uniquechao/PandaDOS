#!/usr/bin/env bun
import { homedir } from 'node:os';
import { applyMigration, planMigration } from '../src/core/mando-migration';

export interface CliOptions {
  mode: 'dry-run' | 'apply';
  projectRoots: string[];
  homeDir: string;
}

export function parseMigrationArgs(args: string[], homeDir = homedir()): CliOptions {
  let mode: CliOptions['mode'] | null = null;
  const projectRoots: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dry-run' || arg === '--apply') {
      const nextMode = arg === '--dry-run' ? 'dry-run' : 'apply';
      if (mode && mode !== nextMode) throw new Error('choose exactly one of --dry-run or --apply');
      mode = nextMode;
    } else if (arg === '--project-root') {
      const root = args[++i];
      if (!root) throw new Error('--project-root requires a path');
      projectRoots.push(root);
    } else if (arg === '--home') {
      const root = args[++i];
      if (!root) throw new Error('--home requires a path');
      homeDir = root;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!mode) throw new Error('choose exactly one of --dry-run or --apply');
  return { mode, projectRoots, homeDir };
}

async function serviceIsRunning(url = 'http://127.0.0.1:8802/healthz'): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runMigrationCli(args: string[]) {
  const options = parseMigrationArgs(args);
  const plan = planMigration({
    homeDir: options.homeDir,
    projectRoots: options.projectRoots,
    serviceRunning: await serviceIsRunning(),
  });
  if (options.mode === 'dry-run') return { mode: options.mode, plan };
  return { mode: options.mode, plan, report: applyMigration(plan) };
}

if (import.meta.main) {
  try {
    const result = await runMigrationCli(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result.plan.blockers.length) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

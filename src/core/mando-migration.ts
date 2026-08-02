import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LEGACY_RUNTIME_DIR = '.butler2';
const LEGACY_DB_NAME = 'butler.db';
const LEGACY_PROJECT_DIRS = [
  ['.butler/modules', 'modules'],
  ['.tmux-butler-uploads', 'uploads'],
  ['.butler-clarify', 'tmp/clarify'],
  ['.butler-issue-summary', 'tmp/result'],
  ['.butler-summary', 'tmp/summary'],
  ['.butler-organize', 'tmp/organize'],
  ['.butler-reorg', 'tmp/reorg'],
  ['.butler-keep', 'keep'],
] as const;
const ACTIVE_STATUSES = ['clarifying', 'planning', 'plan_review', 'implementing', 'testing', 'merge_review', 'merging'];

export type MigrationAction =
  | { kind: 'runtime'; source: string; target: string }
  | { kind: 'database'; source: string; target: string }
  | { kind: 'project'; source: string; target: string }
  | { kind: 'git-exclude'; projectRoot: string; target: string };

export interface MigrationPlan {
  id: string;
  homeDir: string;
  oldRuntimeRoot: string;
  runtimeRoot: string;
  backupRoot: string;
  projectRoots: string[];
  actions: MigrationAction[];
  blockers: string[];
  alreadyMigrated: boolean;
}

export interface MigrationInput {
  homeDir: string;
  projectRoots?: string[];
  serviceRunning?: boolean;
  migrationId?: string;
}

export interface MigrationReport {
  id: string;
  status: 'migrated' | 'already migrated';
  backupRoot: string;
  actionsApplied: number;
  legacySourcesPreserved: true;
}

function hashTree(path: string): string {
  const hash = createHash('sha256');
  const walk = (entry: string, relative: string) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      for (const name of readdirSync(entry).sort()) walk(join(entry, name), join(relative, name));
      return;
    }
    hash.update(relative);
    hash.update(readFileSync(entry));
  };
  walk(path, '.');
  return hash.digest('hex');
}

function conflict(source: string, target: string): boolean {
  return existsSync(source) && existsSync(target) && hashTree(source) !== hashTree(target);
}

function activeIssueCount(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const marks = ACTIVE_STATUSES.map(() => '?').join(', ');
    const row = db.query(`SELECT count(*) AS count FROM issues WHERE status IN (${marks})`).get(...ACTIVE_STATUSES) as
      | { count: number }
      | null;
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

export function planMigration(input: MigrationInput): MigrationPlan {
  const homeDir = resolve(input.homeDir);
  const oldRuntimeRoot = join(homeDir, LEGACY_RUNTIME_DIR);
  const runtimeRoot = join(homeDir, '.mando');
  const oldDb = join(oldRuntimeRoot, LEGACY_DB_NAME);
  const newDb = join(runtimeRoot, 'mando.db');
  const marker = join(runtimeRoot, '.migration-complete.json');
  const projectRoots = [...new Set((input.projectRoots ?? []).map((root) => resolve(root)))].sort();
  const id = input.migrationId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = join(homeDir, '.mando-migration-backups', id);
  const blockers: string[] = [];
  const actions: MigrationAction[] = [];
  const alreadyMigrated = existsSync(marker);

  if (input.serviceRunning) blockers.push('MandoAI service is still running');
  if (!alreadyMigrated && activeIssueCount(oldDb) > 0) blockers.push('database contains active issues');
  if (existsSync(backupRoot)) blockers.push(`backup root already exists: ${backupRoot}`);

  if (!alreadyMigrated && existsSync(oldRuntimeRoot)) {
    if (existsSync(runtimeRoot)) blockers.push(`runtime target already exists: ${runtimeRoot}`);
    actions.push({ kind: 'runtime', source: oldRuntimeRoot, target: runtimeRoot });
    if (existsSync(oldDb)) actions.push({ kind: 'database', source: oldDb, target: newDb });
  }

  for (const projectRoot of projectRoots) {
    for (const [oldRelative, newRelative] of LEGACY_PROJECT_DIRS) {
      const source = join(projectRoot, oldRelative);
      const target = join(projectRoot, '.mando', newRelative);
      if (!existsSync(source)) continue;
      if (conflict(source, target)) blockers.push(`project target conflicts: ${target}`);
      else if (!existsSync(target)) actions.push({ kind: 'project', source, target });
    }
    const gitExclude = join(projectRoot, '.git', 'info', 'exclude');
    if (existsSync(dirname(gitExclude))) actions.push({ kind: 'git-exclude', projectRoot, target: gitExclude });
  }

  return { id, homeDir, oldRuntimeRoot, runtimeRoot, backupRoot, projectRoots, actions, blockers, alreadyMigrated };
}

function copyRuntime(source: string, target: string) {
  mkdirSync(target, { recursive: false });
  for (const name of readdirSync(source)) {
    if (name === LEGACY_DB_NAME || name === `${LEGACY_DB_NAME}-wal` || name === `${LEGACY_DB_NAME}-shm`) continue;
    cpSync(join(source, name), join(target, name), { recursive: true, preserveTimestamps: true });
  }
}

function backupDatabase(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true });
  const escaped = target.replaceAll("'", "''");
  const db = new Database(source, { readonly: true });
  try {
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
}

function rewriteDatabasePaths(path: string, backupRoot: string) {
  const db = new Database(path);
  try {
    const issueColumns = db.query('PRAGMA table_info(issues)').all() as Array<{ name: string }>;
    if (issueColumns.some((column) => column.name === 'images_json')) {
      db.exec("UPDATE issues SET images_json = replace(images_json, '.tmux-butler-uploads', '.mando/uploads') WHERE images_json LIKE '%.tmux-butler-uploads%'");
    }
    const conversationColumns = db.query('PRAGMA table_info(conversations)').all() as Array<{ name: string }>;
    if (!conversationColumns.some((column) => column.name === 'agent_jsonl_path')) return;
    const rows = db
      .query('SELECT agent_jsonl_path AS path FROM conversations WHERE agent_jsonl_path IS NOT NULL')
      .all() as Array<{ path: string }>;
    for (const row of rows) {
      if (!row.path || !existsSync(row.path)) continue;
      const original = readFileSync(row.path, 'utf8');
      const rewritten = original.replaceAll('.tmux-butler-uploads', '.mando/uploads');
      if (rewritten === original) continue;
      const key = createHash('sha256').update(row.path).digest('hex').slice(0, 16);
      const backup = join(backupRoot, 'jsonl', key, row.path.split('/').at(-1) ?? 'conversation.jsonl');
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, original);
      const temporary = `${row.path}.mando-migration`;
      writeFileSync(temporary, rewritten);
      renameSync(temporary, row.path);
    }
  } finally {
    db.close();
  }
}

function updateGitExclude(path: string) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const legacy = ['.tmux-butler-uploads/', '.butler-clarify/', '.butler-issue-summary/'];
  const lines = existing
    .split(/\r?\n/)
    .filter((line) => line && !legacy.includes(line.trim()));
  for (const line of ['.mando/uploads/', '.mando/tmp/']) if (!lines.includes(line)) lines.push(line);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
}

export function applyMigration(plan: MigrationPlan): MigrationReport {
  if (plan.blockers.length) throw new Error(`migration blocked:\n- ${plan.blockers.join('\n- ')}`);
  if (plan.alreadyMigrated) {
    return { id: plan.id, status: 'already migrated', backupRoot: plan.backupRoot, actionsApplied: 0, legacySourcesPreserved: true };
  }

  mkdirSync(dirname(plan.backupRoot), { recursive: true });
  mkdirSync(plan.backupRoot, { recursive: false });
  if (existsSync(plan.oldRuntimeRoot)) cpSync(plan.oldRuntimeRoot, join(plan.backupRoot, 'runtime'), { recursive: true, preserveTimestamps: true });
  for (const projectRoot of plan.projectRoots) {
    const projectBackup = join(plan.backupRoot, 'projects', createHash('sha256').update(projectRoot).digest('hex').slice(0, 12));
    for (const [oldRelative] of LEGACY_PROJECT_DIRS) {
      const source = join(projectRoot, oldRelative);
      if (existsSync(source)) cpSync(source, join(projectBackup, oldRelative), { recursive: true, preserveTimestamps: true });
    }
  }

  let applied = 0;
  for (const action of plan.actions) {
    if (action.kind === 'runtime') {
      copyRuntime(action.source, action.target);
    } else if (action.kind === 'database') {
      const temp = `${action.target}.migration-${plan.id}`;
      backupDatabase(action.source, temp);
      rewriteDatabasePaths(temp, plan.backupRoot);
      renameSync(temp, action.target);
    } else if (action.kind === 'project') {
      mkdirSync(dirname(action.target), { recursive: true });
      cpSync(action.source, action.target, { recursive: true, preserveTimestamps: true });
    } else {
      updateGitExclude(action.target);
    }
    applied += 1;
  }

  mkdirSync(plan.runtimeRoot, { recursive: true });
  writeFileSync(
    join(plan.runtimeRoot, '.migration-complete.json'),
    `${JSON.stringify({ id: plan.id, backupRoot: plan.backupRoot, projectRoots: plan.projectRoots }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return { id: plan.id, status: 'migrated', backupRoot: plan.backupRoot, actionsApplied: applied, legacySourcesPreserved: true };
}

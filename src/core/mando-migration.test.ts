import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration, planMigration } from './mando-migration';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mando-migration-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.butler2'), { recursive: true });
  mkdirSync(join(project, '.butler', 'modules'), { recursive: true });
  mkdirSync(join(project, '.git', 'info'), { recursive: true });
  writeFileSync(join(project, '.butler', 'modules', 'INDEX.md'), '# memory\n');
  writeFileSync(join(project, '.git', 'info', 'exclude'), '.tmux-butler-uploads/\n');
  const dbPath = join(home, '.butler2', 'butler.db');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE issues (id INTEGER PRIMARY KEY, status TEXT NOT NULL); INSERT INTO issues VALUES (1, \'done\')');
  db.exec('ALTER TABLE issues ADD COLUMN images_json TEXT');
  db.exec("UPDATE issues SET images_json = '[\".tmux-butler-uploads/x/a.png\"]'");
  db.close();
  return { home, project, dbPath };
}

describe('one-time Mando migration', () => {
  test('dry-run plans without writing', () => {
    const f = fixture();
    const plan = planMigration({ homeDir: f.home, projectRoots: [f.project], migrationId: 'dry' });
    expect(plan.blockers).toEqual([]);
    expect(plan.actions.some((action) => action.kind === 'database')).toBe(true);
    expect(Bun.file(join(f.home, '.mando', 'mando.db')).size).toBe(0);
  });

  test('apply backs up, copies data, updates excludes, preserves sources and is idempotent', () => {
    const f = fixture();
    const first = applyMigration(planMigration({ homeDir: f.home, projectRoots: [f.project], migrationId: 'apply' }));
    expect(first.status).toBe('migrated');
    expect(readFileSync(join(f.project, '.mando', 'modules', 'INDEX.md'), 'utf8')).toBe('# memory\n');
    expect(readFileSync(join(f.project, '.git', 'info', 'exclude'), 'utf8')).toContain('.mando/uploads/');
    expect(readFileSync(join(f.project, '.git', 'info', 'exclude'), 'utf8')).not.toContain('.tmux-butler-uploads/');
    const migratedDb = new Database(join(f.home, '.mando', 'mando.db'), { readonly: true });
    expect(migratedDb.query('SELECT count(*) AS n FROM issues').get()).toEqual({ n: 1 });
    expect(migratedDb.query('SELECT images_json FROM issues').get()).toEqual({ images_json: '[".mando/uploads/x/a.png"]' });
    migratedDb.close();
    expect(Bun.file(f.dbPath).size).toBeGreaterThan(0);
    const second = applyMigration(planMigration({ homeDir: f.home, projectRoots: [f.project], migrationId: 'again' }));
    expect(second.status).toBe('already migrated');
  });

  test('active issue and target conflict block before writes', () => {
    const f = fixture();
    const db = new Database(f.dbPath);
    db.exec("UPDATE issues SET status = 'implementing'");
    db.close();
    mkdirSync(join(f.project, '.mando', 'modules'), { recursive: true });
    writeFileSync(join(f.project, '.mando', 'modules', 'INDEX.md'), '# conflict\n');
    const plan = planMigration({ homeDir: f.home, projectRoots: [f.project], migrationId: 'blocked' });
    expect(plan.blockers.join('\n')).toContain('active issues');
    expect(plan.blockers.join('\n')).toContain('conflicts');
    expect(() => applyMigration(plan)).toThrow('migration blocked');
  });
});

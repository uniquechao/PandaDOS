import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { migrateDesigns } from '../../designs/store';
import { DesignPersonaRegistry, renderPersonaDocument, type PersonaManifest } from '../../designs/personas';
import { LocalDriver } from '../../executor/local';
import { migrateIssueEngine } from '../../issues/engine';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { designPersonaRoutes } from './design-personas';

const manifest: PersonaManifest = {
  slug: 'security-reviewer',
  displayName: 'Security Reviewer',
  reviewSpecialty: 'Security boundaries',
  compatibleAgents: ['claude'],
  outputSchemaVersion: 1,
  promptPath: 'PERSONA.md',
  role: 'reviewer',
};

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const owner = users.create('owner');
  const member = users.create('member');
  const outsider = users.create('outsider');
  const cwd = mkdtempSync(join(tmpdir(), 'panda-persona-routes-'));
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', '', '/workspace', '/claude')`);
  db.query(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, ?, ?, 1)`).run(cwd, owner.user.id);
  db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 1)')
    .run(member.user.id);
  const registry = new DesignPersonaRegistry(db);
  const marketBaseDir = join(cwd, 'markets');
  const dispatch = createDispatcher(designPersonaRoutes({
    db,
    registry,
    driverForProject: () => new LocalDriver(),
    marketBaseDir,
  }), authDepsFromDb(db, users));
  const call = async (method: string, path: string, token: string | null, body?: unknown) => {
    const response = await dispatch(new Request(`http://test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))!;
    return { status: response.status, body: await response.json() as any };
  };
  return { db, cwd, marketBaseDir, registry, admin, owner, member, outsider, call };
}

describe('design persona routes', () => {
  test('list is project-access while discovery and governance require owner', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/projects/1/personas', null)).status).toBe(401);
    expect((await s.call('GET', '/api/projects/1/personas', s.outsider.token)).status).toBe(403);
    const memberList = await s.call('GET', '/api/projects/1/personas', s.member.token);
    expect(memberList.status).toBe(200);
    expect(memberList.body.personas).toHaveLength(5);
    expect((await s.call('POST', '/api/projects/1/personas/discover', s.member.token)).status).toBe(403);

    const bundle = join(s.cwd, '.panda/personas/security-reviewer');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(manifest, 'Review access control.'));
    const discovered = await s.call('POST', '/api/projects/1/personas/discover', s.owner.token);
    expect(discovered.status).toBe(200);
    const persona = discovered.body.personas[0];
    expect(persona.prompt).toBeUndefined();
    expect(persona.key).not.toContain(s.cwd);
    expect((await s.call('PATCH', `/api/projects/1/personas/${persona.id}`, s.owner.token, {
      enabled: true,
    })).body.error.code).toBe('design.persona_approval_required');
    const approved = await s.call('PATCH', `/api/projects/1/personas/${persona.id}`, s.owner.token, {
      approveHash: persona.contentHash,
      enabled: true,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.persona).toMatchObject({ approvedByUserId: s.owner.user.id });
    expect(approved.body.persona.approvedTs).toBeGreaterThan(0);
    const adminApproved = await s.call('PATCH', `/api/projects/1/personas/${persona.id}`, s.admin.token, {
      approveHash: persona.contentHash,
    });
    expect(adminApproved.status).toBe(200);
    expect(adminApproved.body.persona.approvedByUserId).toBe(s.admin.user.id);
  });

  test('persona market source CRUD is admin-only and returns structured errors', async () => {
    const s = setup();
    expect((await s.call('GET', '/api/admin/design-persona-markets', s.owner.token)).status).toBe(403);
    const invalid = await s.call('POST', '/api/admin/design-persona-markets', s.admin.token, {
      name: 'bad market', repo: '--upload-pack=x',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('design.persona_source_invalid');
    expect((await s.call('POST', '/api/admin/design-persona-markets', s.admin.token, {
      name: 'personas', repo: 'openai/personas', subdir: 'bundles',
    })).status).toBe(201);
    expect((await s.call('PATCH', '/api/admin/design-persona-markets/personas', s.admin.token, {
      note: 'Reviewed sources', enabled: false,
    })).status).toBe(200);
    expect((await s.call('DELETE', '/api/admin/design-persona-markets/personas', s.admin.token)).status).toBe(200);
  });

  test('publish exports canonical bytes, is idempotent, and redacts differing-file conflicts', async () => {
    const s = setup();
    s.db.run('DELETE FROM skill_markets');
    s.db.query(`INSERT INTO skill_markets
      (name, repo, subdir, note, enabled, created_ts)
      VALUES ('designs', 'https://example.com/designs.git', '', '', 1, 1)`).run();
    const market = join(s.marketBaseDir, 'designs');
    const bundle = join(market, manifest.slug);
    mkdirSync(bundle, { recursive: true });
    const canonical = renderPersonaDocument(manifest, 'Market security review.');
    writeFileSync(join(bundle, 'PERSONA.md'), canonical);
    execFileSync('git', ['-C', market, 'init', '-q']);
    execFileSync('git', ['-C', market, 'remote', 'add', 'origin', 'https://example.com/designs.git']);
    execFileSync('git', ['-C', market, 'add', '.']);
    execFileSync('git', ['-C', market, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'persona']);
    await s.registry.approveMarketSnapshot('designs', s.marketBaseDir);
    const browsed = await s.call('GET', '/api/projects/1/personas/market', s.owner.token);
    expect(browsed.status).toBe(200);
    const selected = browsed.body.personas[0];
    expect((await s.call('POST', '/api/projects/1/personas/publish', s.member.token, {
      key: selected.key, contentHash: selected.contentHash,
    })).status).toBe(403);
    const first = await s.call('POST', '/api/projects/1/personas/publish', s.owner.token, {
      key: selected.key, contentHash: selected.contentHash,
    });
    expect(first.status).toBe(201);
    expect(first.body.persona).toMatchObject({ origin: 'project', gitCommit: selected.gitCommit });
    expect(first.body.persona.prompt).toBeUndefined();
    expect(await Bun.file(join(s.cwd, '.panda/personas/security-reviewer/PERSONA.md')).text()).toBe(canonical);
    expect((await s.call('POST', '/api/projects/1/personas/publish', s.owner.token, {
      key: selected.key, contentHash: selected.contentHash,
    })).status).toBe(201);

    writeFileSync(
      join(s.cwd, '.panda/personas/security-reviewer/PERSONA.md'),
      renderPersonaDocument(manifest, 'Local owner edits.'),
    );
    const conflict = await s.call('POST', '/api/projects/1/personas/publish', s.owner.token, {
      key: selected.key, contentHash: selected.contentHash,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('design.persona_publish_conflict');
    expect(JSON.stringify(conflict.body)).not.toContain(s.cwd);
    expect(JSON.stringify(conflict.body)).not.toContain('Local owner edits');
  });
});

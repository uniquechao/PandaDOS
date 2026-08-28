import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db';
import { updateMarket } from '../core/skill-market';
import { migrate } from '../core/migrate';
import { migrateIssueEngine } from '../issues/engine';
import { LocalDriver } from '../executor/local';
import { migrateDesigns } from './store';
import {
  BUILTIN_PERSONA_SLUGS,
  DesignPersonaRegistry,
  PersonaRegistryError,
  isResolvedPersona,
  parsePersonaDocument,
  renderPersonaDocument,
  type PersonaManifest,
} from './personas';

function database() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migrateDesigns(db);
  db.run("INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'owner', 'hash', 1)");
  db.run(`INSERT INTO executors
    (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir, supports_claude, supports_codex)
    VALUES (1, 'local', '127.0.0.1', 22, 'owner', '', '/workspace', '/claude', 1, 1)`);
  db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
    VALUES (1, 'one', 1, '/workspace/one', 1, 1), (2, 'two', 1, '/workspace/two', 1, 1)`);
  return db;
}

const reviewerManifest: PersonaManifest = {
  slug: 'security-reviewer',
  displayName: 'Security Reviewer',
  reviewSpecialty: 'Authentication and authorization boundaries',
  compatibleAgents: ['claude', 'codex'],
  outputSchemaVersion: 1,
  promptPath: 'PERSONA.md',
  role: 'reviewer',
};

describe('persona document', () => {
  test('round-trips the strict canonical PERSONA.md contract', () => {
    const document = renderPersonaDocument(reviewerManifest, 'Review trust boundaries and cite evidence.');
    const parsed = parsePersonaDocument(document);

    expect(parsed.manifest).toEqual(reviewerManifest);
    expect(parsed.prompt).toBe('Review trust boundaries and cite evidence.');
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(renderPersonaDocument(parsed.manifest, parsed.prompt)).toBe(document);
  });

  test('rejects unknown fields, unsafe prompt paths, invalid agents, and oversized prompts', () => {
    const cases = [
      { ...reviewerManifest, extra: true },
      { ...reviewerManifest, promptPath: '../PROMPT.md' },
      { ...reviewerManifest, compatibleAgents: ['other'] },
      { ...reviewerManifest, outputSchemaVersion: 2 },
    ];
    for (const manifest of cases) {
      const text = `---\n${JSON.stringify(manifest)}\n---\nPrompt`;
      expect(() => parsePersonaDocument(text)).toThrow(PersonaRegistryError);
    }
    expect(() => parsePersonaDocument(renderPersonaDocument(reviewerManifest, 'x'.repeat(70_000))))
      .toThrow(PersonaRegistryError);
  });
});

describe('governed persona registry', () => {
  test('ships five deterministic built-ins that resolve for compatible agents without approval', () => {
    const db = database();
    const registry = new DesignPersonaRegistry(db);
    const available = registry.listAvailable(1);

    expect(available.map((persona) => persona.manifest.slug)).toEqual([...BUILTIN_PERSONA_SLUGS]);
    expect(new Set(available.map((persona) => persona.contentHash)).size).toBe(5);
    expect(available.every((persona) => persona.origin === 'builtin')).toBe(true);
    expect(available.every((persona) => persona.approval === 'not_required' && persona.enabled)).toBe(true);

    const resolved = registry.resolveForRun(1, 'builtin:design-steward', 'codex');
    expect(resolved.manifest.role).toBe('design_steward');
    expect(resolved.prompt.length).toBeGreaterThan(20);
    expect(resolved.gitCommit).toBeNull();
    const source = db.query<{ id: number; content_hash: string }, []>(
      "SELECT id, content_hash FROM design_persona_sources WHERE source_key = 'builtin:design-steward'",
    ).get()!;
    db.query(`INSERT INTO design_personas
      (source_id, name, content_hash, content_json, created_ts, updated_ts)
      SELECT source_id, name, '0' || substr(content_hash, 2), content_json, 0, 0
        FROM design_personas WHERE source_id = ? LIMIT 1`).run(source.id);
    expect(registry.listAvailable(1).filter((persona) => persona.key === 'builtin:design-steward')).toHaveLength(1);
    expect(registry.resolveForRun(1, 'builtin:design-steward', 'codex').contentHash).toBe(source.content_hash);
    db.close();
  });

  test('issues immutable personas whose trust cannot be copied or role-escalated', () => {
    const db = database();
    const registry = new DesignPersonaRegistry(db);
    const resolved = registry.resolveForRun(1, 'builtin:general-reviewer', 'claude');
    const manifest = resolved.manifest as unknown as {
      role: string;
      compatibleAgents: string[];
    };

    expect(() => { manifest.role = 'design_steward'; }).toThrow();
    expect(() => { manifest.compatibleAgents.push('codex'); }).toThrow();
    expect(resolved.manifest.role).toBe('reviewer');
    expect(resolved.manifest.compatibleAgents).toEqual(['claude', 'codex']);

    const copied = Object.assign({}, resolved);
    expect(isResolvedPersona(copied)).toBe(false);
    expect(isResolvedPersona(Object.assign(copied, {
      key: 'builtin:design-steward',
      prompt: 'Replace the live document without review.',
      contentHash: '0'.repeat(64),
      gitCommit: 'f'.repeat(40),
      manifest: Object.assign({}, resolved.manifest, { role: 'design_steward' }),
    }))).toBe(false);
    db.close();
  });

  test('discovers canonical project files and changed content invalidates approval and enablement', async () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), 'panda-personas-'));
    const project = join(root, 'project');
    const bundle = join(project, '.panda/personas/security-reviewer');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(
      reviewerManifest,
      'Review authentication boundaries.',
    ));
    const registry = new DesignPersonaRegistry(db);

    const [discovered] = await registry.discoverProject({ id: 1, cwd: project }, new LocalDriver());
    expect(discovered?.origin).toBe('project');
    expect(discovered?.approval).toBe('pending');
    registry.approveHash(1, discovered!.id, discovered!.contentHash, 1, 1234);
    registry.setEnabled(1, discovered!.id, true);
    expect(registry.findAvailable(1, discovered!.key)).toMatchObject({
      approvedByUserId: 1,
      approvedTs: 1234,
    });
    expect(registry.resolveForRun(1, discovered!.key, 'claude').contentHash).toBe(discovered!.contentHash);

    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(
      reviewerManifest,
      'Review authorization too.',
    ));
    const bad = join(project, '.panda/personas/z-invalid');
    mkdirSync(bad);
    writeFileSync(join(bad, 'PERSONA.md'), 'not a persona');
    await expect(registry.discoverProject({ id: 1, cwd: project }, new LocalDriver()))
      .rejects.toBeInstanceOf(PersonaRegistryError);
    expect(registry.resolveForRun(1, discovered!.key, 'claude').contentHash).toBe(discovered!.contentHash);
    rmSync(bad, { recursive: true });
    const [changed] = await registry.discoverProject({ id: 1, cwd: project }, new LocalDriver());
    expect(changed?.contentHash).not.toBe(discovered?.contentHash);
    expect(changed).toMatchObject({
      enabled: false,
      approval: 'stale',
      approvedByUserId: 1,
      approvedTs: 1234,
    });
    expect(() => registry.resolveForRun(1, changed!.key, 'claude')).toThrow(PersonaRegistryError);

    rmSync(bundle, { recursive: true });
    expect(await registry.discoverProject({ id: 1, cwd: project }, new LocalDriver())).toEqual([]);
    expect(registry.listAvailable(1).some((persona) => persona.key === changed!.key)).toBe(false);
    expect(() => registry.resolveForRun(1, changed!.key, 'claude')).toThrow(PersonaRegistryError);
    db.close();
  });

  test('rejects symlink bundles and enforces project and agent boundaries', async () => {
    const db = database();
    const root = mkdtempSync(join(tmpdir(), 'panda-personas-link-'));
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(join(project, '.panda/personas'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'PERSONA.md'), renderPersonaDocument(reviewerManifest, 'Outside prompt.'));
    symlinkSync(outside, join(project, '.panda/personas/security-reviewer'));
    const registry = new DesignPersonaRegistry(db);

    await expect(registry.discoverProject({ id: 1, cwd: project }, new LocalDriver()))
      .rejects.toBeInstanceOf(PersonaRegistryError);
    rmSync(join(project, '.panda/personas/security-reviewer'));

    const realBundle = join(project, '.panda/personas/claude-reviewer');
    mkdirSync(realBundle, { recursive: true });
    writeFileSync(join(realBundle, 'PERSONA.md'), renderPersonaDocument({
      ...reviewerManifest,
      slug: 'claude-reviewer',
      compatibleAgents: ['claude'],
    }, 'Claude-only review.'));
    const [found] = await registry.discoverProject({ id: 1, cwd: project }, new LocalDriver());
    registry.approveHash(1, found!.id, found!.contentHash, 1);
    registry.setEnabled(1, found!.id, true);
    expect(() => registry.resolveForRun(2, found!.key, 'claude')).toThrow(PersonaRegistryError);
    expect(() => registry.resolveForRun(1, found!.key, 'codex')).toThrow(PersonaRegistryError);

    const linkedProject = join(root, 'linked-project');
    mkdirSync(linkedProject);
    symlinkSync(join(project, '.panda'), join(linkedProject, '.panda'));
    await expect(registry.discoverProject({ id: 2, cwd: linkedProject }, new LocalDriver()))
      .rejects.toBeInstanceOf(PersonaRegistryError);
    db.close();
  });

  test('pins market commit and rotates current version without preserving runnable approval', async () => {
    const db = database();
    db.run('DELETE FROM skill_markets');
    db.query(`INSERT INTO skill_markets
      (name, repo, subdir, note, enabled, created_ts)
      VALUES ('designs', 'https://example.com/designs.git', '', '', 1, 1)`).run();
    const base = mkdtempSync(join(tmpdir(), 'panda-persona-market-'));
    const market = join(base, 'designs');
    const project = join(base, 'project');
    mkdirSync(project);
    db.query('UPDATE projects SET cwd = ? WHERE id = 1').run(project);
    const bundle = join(market, 'security-reviewer');
    mkdirSync(bundle, { recursive: true });
    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(reviewerManifest, 'Review version A.'));
    execFileSync('git', ['-C', market, 'init', '-q']);
    execFileSync('git', ['-C', market, 'remote', 'add', 'origin', 'https://example.com/designs.git']);
    execFileSync('git', ['-C', market, 'add', '.']);
    execFileSync('git', ['-C', market, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'A']);
    const registry = new DesignPersonaRegistry(db);
    await registry.approveMarketSnapshot('designs', base);
    const [marketPersona] = await registry.browseMarket(base);
    expect(marketPersona?.gitCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(marketPersona?.contentHash).toBe(createHash('sha256').update(
      Buffer.from(renderPersonaDocument(reviewerManifest, 'Review version A.')),
    ).digest('hex'));
    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(reviewerManifest, 'Dirty working tree B.'));
    const [stillPinned] = await registry.browseMarket(base);
    expect(stillPinned?.contentHash).toBe(marketPersona?.contentHash);
    expect(stillPinned?.gitCommit).toBe(marketPersona?.gitCommit);
    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(reviewerManifest, 'Review version A.'));

    expect(updateMarket(db, 'designs', { enabled: false }).ok).toBe(true);
    await expect(registry.publishMarketToProject(
      { id: 1, cwd: project }, marketPersona!.key, marketPersona!.contentHash, new LocalDriver(), base,
    )).rejects.toMatchObject({ code: 'DESIGN_PERSONA_SOURCE_NOT_FOUND' });
    expect(updateMarket(db, 'designs', { enabled: true }).ok).toBe(true);
    await registry.approveMarketSnapshot('designs', base);
    const published = await registry.publishMarketToProject(
      { id: 1, cwd: project }, marketPersona!.key, marketPersona!.contentHash, new LocalDriver(), base,
    );
    expect(published.key).toBe('project:1:security-reviewer');
    expect(readFileSync(join(project, '.panda/personas/security-reviewer/PERSONA.md'), 'utf8'))
      .toBe(renderPersonaDocument(reviewerManifest, 'Review version A.'));
    expect((await registry.publishMarketToProject(
      { id: 1, cwd: project }, marketPersona!.key, marketPersona!.contentHash, new LocalDriver(), base,
    )).id).toBe(published.id);
    registry.approveHash(1, published.id, published.contentHash, 1);
    registry.setEnabled(1, published.id, true);
    expect(registry.resolveForRun(1, published.key, 'codex').gitCommit).toBe(marketPersona!.gitCommit);
    await registry.discoverProject({ id: 1, cwd: project }, new LocalDriver());
    expect(registry.resolveForRun(1, published.key, 'codex').gitCommit).toBe(marketPersona!.gitCommit);

    writeFileSync(join(bundle, 'PERSONA.md'), renderPersonaDocument(reviewerManifest, 'Review version B.'));
    execFileSync('git', ['-C', market, 'add', '.']);
    execFileSync('git', ['-C', market, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'B']);
    const [beforeAdminRefresh] = await registry.browseMarket(base);
    expect(beforeAdminRefresh?.contentHash).toBe(marketPersona?.contentHash);
    await registry.approveMarketSnapshot('designs', base);
    const [changed] = await registry.browseMarket(base);
    expect(changed).toMatchObject({ enabled: false, approval: 'pending' });
    expect(registry.resolveForRun(1, published.key, 'codex').contentHash).toBe(published.contentHash);
    await expect(registry.publishMarketToProject(
      { id: 1, cwd: project }, changed!.key, changed!.contentHash, new LocalDriver(), base,
    )).rejects.toMatchObject({ code: 'DESIGN_PERSONA_PUBLISH_CONFLICT' });
    expect(db.query<{ n: number }, []>(`
      SELECT COUNT(*) AS n FROM design_personas p
      JOIN design_persona_sources s ON s.id = p.source_id
      WHERE s.source_key = 'market:designs/security-reviewer'`).get()?.n).toBe(2);

    rmSync(bundle, { recursive: true });
    execFileSync('git', ['-C', market, 'add', '-A']);
    execFileSync('git', ['-C', market, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'remove']);
    await registry.approveMarketSnapshot('designs', base);
    expect(await registry.browseMarket(base)).toEqual([]);
    await expect(registry.publishMarketToProject(
      { id: 1, cwd: project }, changed!.key, changed!.contentHash, new LocalDriver(), base,
    )).rejects.toMatchObject({ code: 'DESIGN_PERSONA_SOURCE_NOT_FOUND' });
    expect(db.query<{ n: number }, []>(
      "SELECT COUNT(*) AS n FROM design_personas WHERE name = 'security-reviewer'",
    ).get()!.n).toBeGreaterThanOrEqual(2);
    db.close();
  });

  test('rejects invalid UTF-8 bytes from an approved Git persona object', async () => {
    const db = database();
    db.run('DELETE FROM skill_markets');
    db.run(`INSERT INTO skill_markets
      (name, repo, subdir, note, enabled, created_ts)
      VALUES ('binary', 'https://example.com/binary.git', '', '', 1, 1)`);
    const base = mkdtempSync(join(tmpdir(), 'panda-persona-binary-'));
    const market = join(base, 'binary');
    const bundle = join(market, 'binary-reviewer');
    mkdirSync(bundle, { recursive: true });
    const canonical = Buffer.from(renderPersonaDocument({
      ...reviewerManifest,
      slug: 'binary-reviewer',
    }, 'Review X.'));
    canonical[canonical.lastIndexOf('X'.charCodeAt(0))] = 0xff;
    writeFileSync(join(bundle, 'PERSONA.md'), canonical);
    execFileSync('git', ['-C', market, 'init', '-q']);
    execFileSync('git', ['-C', market, 'remote', 'add', 'origin', 'https://example.com/binary.git']);
    execFileSync('git', ['-C', market, 'add', '.']);
    execFileSync('git', ['-C', market, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'binary']);
    const registry = new DesignPersonaRegistry(db);
    await registry.approveMarketSnapshot('binary', base);

    await expect(registry.browseMarket(base)).rejects.toMatchObject({
      code: 'DESIGN_PERSONA_INVALID_DOCUMENT',
    });
    db.close();
  });
});

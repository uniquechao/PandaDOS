import type { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { AgentKind } from '../core/types';
import {
  approvePersonaMarketSnapshot,
  approvedPersonaMarketSnapshot,
  listMarkets,
  type SkillMarket,
} from '../core/skill-market';
import type { ExecutorDriver } from '../executor/driver';
import type { DesignActorRole } from './engine';

export const BUILTIN_PERSONA_SLUGS = [
  'goal-coach',
  'design-steward',
  'general-reviewer',
  'issue-planner',
  'independent-verifier',
] as const;

const MAX_DOCUMENT_BYTES = 66 * 1024;
const MAX_PROMPT_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
declare const RESOLVED_PERSONA_TYPE: unique symbol;
const issuedPersonas = new WeakSet<object>();

export type PersonaOrigin = 'builtin' | 'market' | 'project';
export type PersonaRole = Exclude<DesignActorRole, 'owner'>;
export type PersonaApproval = 'not_required' | 'pending' | 'approved' | 'stale';

export interface PersonaManifest {
  slug: string;
  displayName: string;
  reviewSpecialty: string;
  compatibleAgents: AgentKind[];
  outputSchemaVersion: 1;
  promptPath: 'PERSONA.md';
  role: PersonaRole;
}

export interface ParsedPersonaDocument {
  manifest: PersonaManifest;
  prompt: string;
  contentHash: string;
}

export interface PersonaSummary {
  id: number;
  key: string;
  origin: PersonaOrigin;
  manifest: PersonaManifest;
  contentHash: string;
  gitCommit: string | null;
  enabled: boolean;
  approval: PersonaApproval;
  approvedByUserId: number | null;
  approvedTs: number | null;
}

export interface ResolvedPersona extends PersonaSummary {
  prompt: string;
  projectId: number;
  resolvedAgent: AgentKind;
  readonly [RESOLVED_PERSONA_TYPE]: true;
}

export type PersonaProjectDriver = Pick<
  ExecutorDriver,
  'listDir' | 'readFileNoFollowWithin' | 'writeFileNoFollowWithin'
>;

interface StoredPersonaContent {
  manifest: PersonaManifest;
  prompt: string;
  origin: PersonaOrigin;
  gitCommit: string | null;
}

interface PersonaRow {
  id: number;
  source_key: string;
  source_kind: string;
  content_hash: string;
  content_json: string;
  git_commit: string | null;
  source_content: string;
  approved_hash: string | null;
  approved_by_user_id: number | null;
  approved_ts: number | null;
  enabled: number | null;
}

export class PersonaRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersonaRegistryError';
  }
}

function registryError(code: string, message: string): never {
  throw new PersonaRegistryError(code, message);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertShortString(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || utf8Bytes(value) > max) {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', `invalid persona manifest field: ${field}`);
  }
}

function validateManifest(value: unknown): PersonaManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'persona manifest must be an object');
  }
  const record = value as Record<string, unknown>;
  const allowed = [
    'slug',
    'displayName',
    'reviewSpecialty',
    'compatibleAgents',
    'outputSchemaVersion',
    'promptPath',
    'role',
  ];
  if (Object.keys(record).length !== allowed.length || Object.keys(record).some((key) => !allowed.includes(key))) {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'persona manifest has missing or unknown fields');
  }
  assertShortString(record.slug, 'slug', 80);
  if (!SLUG_RE.test(record.slug)) registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'invalid persona slug');
  assertShortString(record.displayName, 'displayName', 160);
  assertShortString(record.reviewSpecialty, 'reviewSpecialty', 500);
  if (!Array.isArray(record.compatibleAgents) || record.compatibleAgents.length === 0
    || record.compatibleAgents.length > 2
    || record.compatibleAgents.some((agent) => agent !== 'claude' && agent !== 'codex')
    || new Set(record.compatibleAgents).size !== record.compatibleAgents.length) {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'invalid compatibleAgents');
  }
  if (record.outputSchemaVersion !== 1) {
    registryError('DESIGN_PERSONA_UNSUPPORTED_SCHEMA', 'unsupported persona output schema');
  }
  if (record.promptPath !== 'PERSONA.md') {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'promptPath must be PERSONA.md');
  }
  const roles: PersonaRole[] = [
    'goal_coach',
    'design_steward',
    'reviewer',
    'issue_planner',
    'independent_verifier',
  ];
  if (!roles.includes(record.role as PersonaRole)) {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'invalid persona role');
  }
  return {
    slug: record.slug,
    displayName: record.displayName,
    reviewSpecialty: record.reviewSpecialty,
    compatibleAgents: [...record.compatibleAgents] as AgentKind[],
    outputSchemaVersion: 1,
    promptPath: 'PERSONA.md',
    role: record.role as PersonaRole,
  };
}

function canonicalDocument(manifest: PersonaManifest, prompt: string): string {
  return `---\n${JSON.stringify(manifest)}\n---\n${prompt}\n`;
}

export function renderPersonaDocument(manifest: PersonaManifest, prompt: string): string {
  const checked = validateManifest(manifest);
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.includes('\0')
    || utf8Bytes(prompt) > MAX_PROMPT_BYTES) {
    registryError('DESIGN_PERSONA_INVALID_PROMPT', 'persona prompt is empty or too large');
  }
  const normalized = prompt.endsWith('\n') ? prompt.slice(0, -1) : prompt;
  const document = canonicalDocument(checked, normalized);
  if (utf8Bytes(document) > MAX_DOCUMENT_BYTES) {
    registryError('DESIGN_PERSONA_TOO_LARGE', 'persona document is too large');
  }
  return document;
}

export function parsePersonaDocument(document: string | Uint8Array): ParsedPersonaDocument {
  let text: string;
  try {
    text = typeof document === 'string'
      ? document
      : new TextDecoder('utf-8', { fatal: true }).decode(document);
  } catch {
    registryError('DESIGN_PERSONA_INVALID_DOCUMENT', 'PERSONA.md is not valid UTF-8');
  }
  if (utf8Bytes(text) > MAX_DOCUMENT_BYTES) registryError('DESIGN_PERSONA_TOO_LARGE', 'persona document is too large');
  const match = /^---\n([^\n]+)\n---\n([\s\S]+)\n$/.exec(text);
  if (!match) registryError('DESIGN_PERSONA_INVALID_DOCUMENT', 'PERSONA.md is not canonical');
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]!);
  } catch {
    registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'persona manifest is not valid JSON');
  }
  const manifest = validateManifest(raw);
  const prompt = match[2]!;
  const canonical = renderPersonaDocument(manifest, prompt);
  if (canonical !== text) registryError('DESIGN_PERSONA_INVALID_DOCUMENT', 'PERSONA.md is not canonical');
  return {
    manifest,
    prompt,
    contentHash: createHash('sha256').update(canonical).digest('hex'),
  };
}

export function isResolvedPersona(value: unknown): value is ResolvedPersona {
  return Boolean(value && typeof value === 'object' && issuedPersonas.has(value));
}

function sourceKind(value: string): PersonaOrigin {
  if (value === 'builtin' || value === 'market' || value === 'project') return value;
  registryError('DESIGN_PERSONA_CORRUPT', 'invalid stored persona origin');
}

function parseStored(row: PersonaRow): StoredPersonaContent {
  let value: unknown;
  try {
    value = JSON.parse(row.content_json);
  } catch {
    registryError('DESIGN_PERSONA_CORRUPT', 'invalid stored persona');
  }
  if (!value || typeof value !== 'object') registryError('DESIGN_PERSONA_CORRUPT', 'invalid stored persona');
  const candidate = value as Partial<StoredPersonaContent>;
  const manifest = validateManifest(candidate.manifest);
  if (typeof candidate.prompt !== 'string') registryError('DESIGN_PERSONA_CORRUPT', 'invalid stored prompt');
  return {
    manifest,
    prompt: candidate.prompt,
    origin: sourceKind(row.source_kind),
    gitCommit: row.git_commit,
  };
}

function mapSummary(row: PersonaRow): PersonaSummary {
  const content = parseStored(row);
  const approval: PersonaApproval = content.origin === 'builtin'
    ? 'not_required'
    : row.approved_hash === null
      ? 'pending'
      : row.approved_hash === row.content_hash
        ? 'approved'
        : 'stale';
  return {
    id: row.id,
    key: row.source_key,
    origin: content.origin,
    manifest: content.manifest,
    contentHash: row.content_hash,
    gitCommit: content.gitCommit,
    enabled: content.origin === 'builtin' || (row.enabled === 1 && approval === 'approved'),
    approval,
    approvedByUserId: content.origin === 'builtin' ? null : row.approved_by_user_id,
    approvedTs: content.origin === 'builtin' ? null : row.approved_ts,
  };
}

const PERSONA_SELECT = `
  SELECT p.id, s.source_key, s.source_kind, p.content_hash, p.content_json, s.git_commit,
         s.content AS source_content,
         pp.approved_hash, pp.approved_by_user_id, pp.approved_ts, pp.enabled
    FROM design_personas p
    JOIN design_persona_sources s ON s.id = p.source_id AND p.content_hash = s.content_hash
    LEFT JOIN design_project_personas pp ON pp.persona_id = p.id AND pp.project_id = ?`;

interface CachedMarketPersona {
  key: string;
  document: string;
  parsed: ParsedPersonaDocument;
  commit: string;
}

function scanCachedMarket(market: SkillMarket, root: string, commit: string): CachedMarketPersona[] {
  let listing: string;
  try {
    const args = ['-C', root, 'ls-tree', '-r', '-z', commit];
    if (market.subdir) args.push('--', market.subdir);
    listing = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  } catch {
    registryError('DESIGN_PERSONA_SOURCE_INVALID', 'approved persona commit is unavailable');
  }
  const files = listing.split('\0').filter(Boolean).flatMap((record) => {
    const match = /^([0-7]{6}) (blob|commit) ([a-f0-9]+)\t(.+)$/.exec(record);
    if (!match) registryError('DESIGN_PERSONA_UNSAFE_PATH', 'market persona tree is invalid');
    const path = match[4]!;
    const parts = path.split('/');
    if (path.startsWith('/') || parts.some((part) => !part || part === '.' || part === '..')) {
      registryError('DESIGN_PERSONA_UNSAFE_PATH', 'market persona tree contains an unsafe path');
    }
    if (parts.some((part) => part.startsWith('.') || part === 'node_modules')) return [];
    return [{ path, mode: match[1]!, type: match[2]! }];
  });
  const found: CachedMarketPersona[] = [];
  for (const candidate of files.filter((entry) => posix.basename(entry.path) === 'PERSONA.md')) {
    const path = candidate.path;
    if (found.length >= 200) registryError('DESIGN_PERSONA_TOO_MANY', 'too many market personas');
    const directory = posix.dirname(path);
    const relativeDirectory = market.subdir
      ? posix.relative(market.subdir, directory)
      : directory;
    const depth = relativeDirectory === '.' ? 0 : relativeDirectory.split('/').length;
    if (relativeDirectory.startsWith('..') || depth > 3) continue;
    const slug = posix.basename(directory);
    const prefix = directory === '.' ? '' : `${directory}/`;
    const bundleEntries = files.filter((entry) => entry.path === path || entry.path.startsWith(prefix));
    if (!SLUG_RE.test(slug) || bundleEntries.length !== 1) {
      registryError('DESIGN_PERSONA_INVALID_BUNDLE', 'invalid market persona bundle');
    }
    if (bundleEntries.some((entry) => entry.mode === '120000' || entry.type !== 'blob')) {
      registryError('DESIGN_PERSONA_UNSAFE_PATH', 'market persona bundle contains a link or non-file entry');
    }
    let bytes: Uint8Array;
    try {
      bytes = execFileSync('git', ['-C', root, 'show', `${commit}:${path}`], {
        maxBuffer: MAX_DOCUMENT_BYTES + 1,
      });
    } catch {
      registryError('DESIGN_PERSONA_INVALID_BUNDLE', 'market persona file could not be read');
    }
    const parsed = parsePersonaDocument(bytes);
    const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (parsed.manifest.slug !== slug) registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'market directory and slug differ');
    found.push({ key: `market:${market.name}/${directory}`, document, parsed, commit });
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

export class DesignPersonaRegistry {
  constructor(private readonly db: Database) {
    this.ensureBuiltins();
  }

  private ensureBuiltins(): void {
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const slug of BUILTIN_PERSONA_SLUGS) {
        const document = readFileSync(join(import.meta.dir, 'personas', slug, 'PERSONA.md'), 'utf8');
        const parsed = parsePersonaDocument(document);
        if (parsed.manifest.slug !== slug) registryError('DESIGN_PERSONA_CORRUPT', 'builtin persona slug mismatch');
        this.upsertCurrent(`builtin:${slug}`, 'builtin', document, parsed, null, now);
      }
    });
    tx();
  }

  private reconcileProjectSources(projectId: number, seenKeys: ReadonlySet<string>): void {
    const sources = this.db.query<{ id: number; source_key: string }, [string]>(
      "SELECT id, source_key FROM design_persona_sources WHERE source_kind = 'project' AND source_key GLOB ?",
    ).all(`project:${projectId}:*`);
    this.db.transaction(() => {
      for (const source of sources) {
        if (seenKeys.has(source.source_key)) continue;
        this.db.query(`DELETE FROM design_project_personas
          WHERE project_id = ? AND persona_id IN (
            SELECT id FROM design_personas WHERE source_id = ?
          )`).run(projectId, source.id);
        this.db.query('DELETE FROM design_persona_sources WHERE id = ?').run(source.id);
      }
    })();
  }

  private reconcileMarketSources(name: string, seenKeys: ReadonlySet<string>): void {
    const sources = this.db.query<{ id: number; source_key: string }, [string]>(
      "SELECT id, source_key FROM design_persona_sources WHERE source_kind = 'market' AND source_key GLOB ?",
    ).all(`market:${name}/*`);
    this.db.transaction(() => {
      for (const source of sources) {
        if (seenKeys.has(source.source_key)) continue;
        this.db.query(`DELETE FROM design_project_personas
          WHERE persona_id IN (SELECT id FROM design_personas WHERE source_id = ?)`
        ).run(source.id);
        this.db.query('DELETE FROM design_persona_sources WHERE id = ?').run(source.id);
      }
    })();
  }

  async approveMarketSnapshot(name: string, baseDir?: string): Promise<void> {
    const snapshot = await approvePersonaMarketSnapshot(this.db, name, baseDir);
    if (!snapshot) registryError('DESIGN_PERSONA_SOURCE_INVALID', 'persona market snapshot could not be approved');
  }

  private upsertCurrent(
    key: string,
    origin: PersonaOrigin,
    document: string,
    parsed: ParsedPersonaDocument,
    gitCommit: string | null,
    now = Date.now(),
  ): number {
    this.db.query(`
      INSERT INTO design_persona_sources
        (source_key, source_url, content_hash, content, fetched_ts, updated_ts,
         source_kind, git_commit, manifest_json)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_key) DO UPDATE SET
        content_hash = excluded.content_hash,
        content = excluded.content,
        fetched_ts = excluded.fetched_ts,
        updated_ts = excluded.updated_ts,
        source_kind = excluded.source_kind,
        git_commit = excluded.git_commit,
        manifest_json = excluded.manifest_json
    `).run(key, parsed.contentHash, document, now, now, origin, gitCommit, JSON.stringify(parsed.manifest));
    const source = this.db.query<{ id: number }, [string]>(
      'SELECT id FROM design_persona_sources WHERE source_key = ?',
    ).get(key);
    if (!source) registryError('DESIGN_PERSONA_CORRUPT', 'persona source upsert failed');
    const content: StoredPersonaContent = {
      manifest: parsed.manifest,
      prompt: parsed.prompt,
      origin,
      gitCommit,
    };
    this.db.query(`
      INSERT INTO design_personas
        (source_id, name, content_hash, content_json, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, name, content_hash) DO UPDATE SET
        content_json = excluded.content_json, updated_ts = excluded.updated_ts
    `).run(source.id, parsed.manifest.slug, parsed.contentHash, JSON.stringify(content), now, now);
    return this.db.query<{ id: number }, [number, string, string]>(
      'SELECT id FROM design_personas WHERE source_id = ? AND name = ? AND content_hash = ?',
    ).get(source.id, parsed.manifest.slug, parsed.contentHash)!.id;
  }

  listAvailable(projectId: number): PersonaSummary[] {
    const rows = this.db.query<PersonaRow, [number, number]>(`${PERSONA_SELECT}
      WHERE s.source_kind = 'builtin' OR pp.project_id = ?
      ORDER BY CASE s.source_kind WHEN 'builtin' THEN 0 WHEN 'market' THEN 1 ELSE 2 END,
               s.source_key`,
    ).all(projectId, projectId);
    const summaries = rows.map(mapSummary);
    const order = new Map(BUILTIN_PERSONA_SLUGS.map((slug, index) => [`builtin:${slug}`, index]));
    return summaries.sort((a, b) => {
      const ai = order.get(a.key);
      const bi = order.get(b.key);
      if (ai !== undefined || bi !== undefined) return (ai ?? 999) - (bi ?? 999);
      return a.key.localeCompare(b.key);
    });
  }

  async browseMarket(baseDir?: string, only?: string): Promise<PersonaSummary[]> {
    const output: PersonaSummary[] = [];
    for (const market of listMarkets(this.db).filter(
      (candidate) => candidate.enabled && (!only || candidate.name === only),
    )) {
      const snapshot = await approvedPersonaMarketSnapshot(this.db, market.name, baseDir);
      if (!snapshot) {
        this.reconcileMarketSources(market.name, new Set());
        continue;
      }
      const scanned = scanCachedMarket(market, snapshot.root, snapshot.commit);
      const seenKeys = new Set(scanned.map((persona) => persona.key));
      for (const persona of scanned) {
        const now = Date.now();
        const tx = this.db.transaction(() => {
          const source = this.db.query<{ id: number }, [string]>(
            'SELECT id FROM design_persona_sources WHERE source_key = ?',
          ).get(persona.key);
          const links = source ? this.db.query<{
            project_id: number;
            approved_hash: string | null;
            approved_by_user_id: number | null;
            approved_ts: number | null;
            enabled: number;
          }, [number]>(`
            SELECT pp.project_id, pp.approved_hash, pp.approved_by_user_id, pp.approved_ts, pp.enabled
              FROM design_project_personas pp
              JOIN design_personas p ON p.id = pp.persona_id
             WHERE p.source_id = ?
          `).all(source.id) : [];
          const id = this.upsertCurrent(
            persona.key, 'market', persona.document, persona.parsed, persona.commit, now,
          );
          if (source) {
            this.db.query(`DELETE FROM design_project_personas
              WHERE persona_id IN (SELECT id FROM design_personas WHERE source_id = ?)`).run(source.id);
          }
          for (const link of links) {
            this.db.query(`INSERT INTO design_project_personas
              (project_id, persona_id, approved_hash, approved_by_user_id, approved_ts,
               enabled, created_ts, updated_ts)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              link.project_id,
              id,
              link.approved_hash,
              link.approved_by_user_id,
              link.approved_ts,
              link.approved_hash === persona.parsed.contentHash ? link.enabled : 0,
              now,
              now,
            );
          }
          return id;
        });
        const id = tx();
        const row = this.db.query<PersonaRow, [number, number]>(`${PERSONA_SELECT} WHERE p.id = ?`)
          .get(-1, id);
        if (row) output.push(mapSummary(row));
      }
      this.reconcileMarketSources(market.name, seenKeys);
    }
    return output;
  }

  async publishMarketToProject(
    project: { id: number; cwd: string },
    key: string,
    contentHash: string | undefined,
    driver: PersonaProjectDriver,
    baseDir?: string,
  ): Promise<PersonaSummary> {
    const marketName = /^market:([^/]+)\//.exec(key)?.[1];
    const snapshot = marketName
      ? await approvedPersonaMarketSnapshot(this.db, marketName, baseDir)
      : null;
    const row = this.db.query<PersonaRow, [number, string]>(`${PERSONA_SELECT}
      WHERE s.source_kind = 'market' AND s.source_key = ?`,
    ).get(project.id, key);
    if (!row || !snapshot || row.git_commit !== snapshot.commit) {
      registryError('DESIGN_PERSONA_SOURCE_NOT_FOUND', 'market persona does not exist');
    }
    if (contentHash !== undefined && !/^[a-f0-9]{64}$/.test(contentHash)) {
      registryError('DESIGN_PERSONA_HASH_MISMATCH', 'invalid persona content hash');
    }
    if (contentHash !== undefined && row.content_hash !== contentHash) {
      registryError('DESIGN_PERSONA_HASH_MISMATCH', 'market persona content hash changed');
    }
    if (typeof driver.writeFileNoFollowWithin !== 'function') {
      registryError('DESIGN_PERSONA_SECURE_WRITE_UNSUPPORTED', 'executor does not support secure persona publishing');
    }
    let result: 'created' | 'unchanged' | 'conflict';
    try {
      result = await driver.writeFileNoFollowWithin(
        project.cwd,
        `.panda/personas/${parseStored(row).manifest.slug}/PERSONA.md`,
        row.source_content,
        0o644,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/capability unavailable/i.test(message)) {
        registryError('DESIGN_PERSONA_SECURE_WRITE_UNSUPPORTED', 'executor does not support secure persona publishing');
      }
      registryError('DESIGN_PERSONA_UNSAFE_PATH', 'persona publish path failed secure validation');
    }
    if (result === 'conflict') {
      registryError('DESIGN_PERSONA_PUBLISH_CONFLICT', 'project persona file already has different content');
    }
    const discovered = await this.discoverProject(project, driver);
    const published = discovered.find((persona) => persona.manifest.slug === parseStored(row).manifest.slug);
    if (!published) registryError('DESIGN_PERSONA_CORRUPT', 'published persona could not be registered');
    const stored = this.db.query<{ content_json: string; source_id: number }, [number]>(
      'SELECT content_json, source_id FROM design_personas WHERE id = ?',
    ).get(published.id)!;
    const content = JSON.parse(stored.content_json) as StoredPersonaContent;
    content.gitCommit = row.git_commit;
    this.db.transaction(() => {
      this.db.query('UPDATE design_persona_sources SET git_commit = ? WHERE id = ?')
        .run(row.git_commit, stored.source_id);
      this.db.query('UPDATE design_personas SET content_json = ? WHERE id = ?')
        .run(JSON.stringify(content), published.id);
    })();
    return this.getForProject(project.id, published.id);
  }

  removeMarketPersonas(name: string): void {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)) return;
    const pattern = `market:${name}/*`;
    this.db.transaction(() => {
      this.db.query(`DELETE FROM design_project_personas
        WHERE persona_id IN (
          SELECT p.id FROM design_personas p
          JOIN design_persona_sources s ON s.id = p.source_id
          WHERE s.source_key GLOB ?
        )`).run(pattern);
      this.db.query('DELETE FROM design_persona_sources WHERE source_key GLOB ?').run(pattern);
    })();
  }

  findAvailable(projectId: number, selector: string): PersonaSummary {
    const available = this.listAvailable(projectId);
    const numeric = Number(selector);
    const matches = available.filter((persona) =>
      (Number.isSafeInteger(numeric) && persona.id === numeric)
      || persona.key === selector
      || persona.manifest.slug === selector);
    if (matches.length === 0) registryError('DESIGN_PERSONA_NOT_FOUND', 'persona is not available to this project');
    if (matches.length > 1) registryError('DESIGN_PERSONA_COLLISION', 'persona slug matches multiple sources');
    return matches[0]!;
  }

  async discoverProject(
    project: { id: number; cwd: string },
    driver: PersonaProjectDriver,
  ): Promise<PersonaSummary[]> {
    if (typeof driver.readFileNoFollowWithin !== 'function') {
      registryError('DESIGN_PERSONA_SECURE_READ_UNSUPPORTED', 'executor does not support secure persona reads');
    }
    const pandaRoot = join(project.cwd, '.panda');
    const root = join(pandaRoot, 'personas');
    const workspace = await driver.listDir(project.cwd);
    const pandaEntry = workspace.find((entry) => entry.name === '.panda');
    if (!pandaEntry) {
      this.reconcileProjectSources(project.id, new Set());
      return [];
    }
    if (pandaEntry.type !== 'dir') registryError('DESIGN_PERSONA_UNSAFE_PATH', '.panda must be a real directory');
    const panda = await driver.listDir(pandaRoot);
    const personaRoot = panda.find((entry) => entry.name === 'personas');
    if (!personaRoot) {
      this.reconcileProjectSources(project.id, new Set());
      return [];
    }
    if (personaRoot.type !== 'dir') registryError('DESIGN_PERSONA_UNSAFE_PATH', 'persona root must be a real directory');
    const entries = await driver.listDir(root);
    if (entries.length > 100) registryError('DESIGN_PERSONA_TOO_MANY', 'too many project personas');
    const candidates: Array<{ key: string; document: string; parsed: ParsedPersonaDocument }> = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.type !== 'dir' || !SLUG_RE.test(entry.name)) {
        registryError('DESIGN_PERSONA_UNSAFE_PATH', 'persona bundle must be a canonical directory');
      }
      const files = await driver.listDir(join(root, entry.name));
      if (files.length !== 1 || files[0]?.name !== 'PERSONA.md' || files[0]?.type !== 'file') {
        registryError('DESIGN_PERSONA_INVALID_BUNDLE', 'persona bundle must contain only a regular PERSONA.md');
      }
      let file;
      try {
        file = await driver.readFileNoFollowWithin(
          project.cwd,
          `.panda/personas/${entry.name}/PERSONA.md`,
          MAX_DOCUMENT_BYTES + 1,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/capability unavailable/i.test(message)) {
          registryError('DESIGN_PERSONA_SECURE_READ_UNSUPPORTED', 'executor does not support secure persona reads');
        }
        registryError('DESIGN_PERSONA_UNSAFE_PATH', 'persona path failed secure validation');
      }
      if (file.size > MAX_DOCUMENT_BYTES) registryError('DESIGN_PERSONA_TOO_LARGE', 'persona document is too large');
      const parsed = parsePersonaDocument(file.data);
      if (parsed.manifest.slug !== entry.name) {
        registryError('DESIGN_PERSONA_INVALID_MANIFEST', 'persona directory and slug differ');
      }
      const key = `project:${project.id}:${entry.name}`;
      candidates.push({ key, document: new TextDecoder().decode(file.data), parsed });
    }
    const seenKeys = new Set(candidates.map((candidate) => candidate.key));
    const ids = this.db.transaction(() => {
      const output: number[] = [];
      for (const candidate of candidates) {
        const now = Date.now();
        const prior = this.db.query<{
          approved_hash: string | null;
          approved_by_user_id: number | null;
          approved_ts: number | null;
          source_hash: string;
          git_commit: string | null;
        }, [number, string]>(`
          SELECT pp.approved_hash, pp.approved_by_user_id, pp.approved_ts,
                 s.content_hash AS source_hash, s.git_commit
            FROM design_project_personas pp
            JOIN design_personas p ON p.id = pp.persona_id
            JOIN design_persona_sources s ON s.id = p.source_id
           WHERE pp.project_id = ? AND s.source_key = ?
           ORDER BY pp.updated_ts DESC LIMIT 1
        `).get(project.id, candidate.key);
        const id = this.upsertCurrent(
          candidate.key,
          'project',
          candidate.document,
          candidate.parsed,
          prior?.source_hash === candidate.parsed.contentHash ? prior.git_commit : null,
          now,
        );
        this.db.query(`
          DELETE FROM design_project_personas
           WHERE project_id = ?
             AND persona_id IN (
               SELECT p.id FROM design_personas p
               JOIN design_persona_sources s ON s.id = p.source_id
               WHERE s.source_key = ? AND p.id <> ?
             )
        `).run(project.id, candidate.key, id);
        this.db.query(`
          INSERT INTO design_project_personas
            (project_id, persona_id, approved_hash, approved_by_user_id, approved_ts,
             enabled, created_ts, updated_ts)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, persona_id) DO UPDATE SET
            approved_hash = COALESCE(design_project_personas.approved_hash, excluded.approved_hash),
            approved_by_user_id = CASE WHEN design_project_personas.approved_hash IS NULL
              THEN excluded.approved_by_user_id ELSE design_project_personas.approved_by_user_id END,
            approved_ts = CASE WHEN design_project_personas.approved_hash IS NULL
              THEN excluded.approved_ts ELSE design_project_personas.approved_ts END,
            enabled = CASE
              WHEN design_project_personas.approved_hash = ? THEN design_project_personas.enabled
              ELSE 0
            END,
            updated_ts = excluded.updated_ts
        `).run(
          project.id,
          id,
          prior?.approved_hash ?? null,
          prior?.approved_by_user_id ?? null,
          prior?.approved_ts ?? null,
          prior?.approved_hash === candidate.parsed.contentHash ? 1 : 0,
          now,
          now,
          candidate.parsed.contentHash,
        );
        output.push(id);
      }
      const sources = this.db.query<{ id: number; source_key: string }, [string]>(
        "SELECT id, source_key FROM design_persona_sources WHERE source_kind = 'project' AND source_key GLOB ?",
      ).all(`project:${project.id}:*`);
      for (const source of sources) {
        if (seenKeys.has(source.source_key)) continue;
        this.db.query(`DELETE FROM design_project_personas
          WHERE project_id = ? AND persona_id IN (
            SELECT id FROM design_personas WHERE source_id = ?
          )`).run(project.id, source.id);
        this.db.query('DELETE FROM design_persona_sources WHERE id = ?').run(source.id);
      }
      return output;
    })();
    return ids.map((id) => this.getForProject(project.id, id));
  }

  approveHash(
    projectId: number,
    personaId: number,
    contentHash: string,
    approvedByUserId: number,
    approvedTs = Date.now(),
  ): void {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      registryError('DESIGN_PERSONA_HASH_MISMATCH', 'invalid persona content hash');
    }
    const row = this.getForProject(projectId, personaId);
    if (row.origin === 'builtin') registryError('DESIGN_PERSONA_APPROVAL_NOT_REQUIRED', 'builtin persona needs no approval');
    if (row.contentHash !== contentHash) registryError('DESIGN_PERSONA_HASH_MISMATCH', 'persona content hash changed');
    const result = this.db.query(`
      UPDATE design_project_personas
         SET approved_hash = ?, approved_by_user_id = ?, approved_ts = ?, enabled = 0, updated_ts = ?
       WHERE project_id = ? AND persona_id = ?
    `).run(contentHash, approvedByUserId, approvedTs, approvedTs, projectId, personaId);
    if (result.changes !== 1) registryError('DESIGN_PERSONA_NOT_FOUND', 'persona is not available to this project');
  }

  setEnabled(projectId: number, personaId: number, enabled: boolean): void {
    const row = this.getForProject(projectId, personaId);
    if (row.origin === 'builtin') registryError('DESIGN_PERSONA_IMMUTABLE', 'builtin persona enablement is immutable');
    if (enabled && row.approval !== 'approved') {
      registryError('DESIGN_PERSONA_NOT_APPROVED', 'persona content hash is not approved');
    }
    this.db.query(`
      UPDATE design_project_personas SET enabled = ?, updated_ts = ?
       WHERE project_id = ? AND persona_id = ?
    `).run(enabled ? 1 : 0, Date.now(), projectId, personaId);
  }

  resolveForRun(projectId: number, key: string, agent: AgentKind): ResolvedPersona {
    const row = this.db.query<PersonaRow, [number, string, number]>(`${PERSONA_SELECT}
      WHERE s.source_key = ? AND (s.source_kind = 'builtin' OR pp.project_id = ?)
      ORDER BY p.updated_ts DESC LIMIT 1`,
    ).get(projectId, key, projectId);
    if (!row) registryError('DESIGN_PERSONA_NOT_FOUND', 'persona is not available to this project');
    const summary = mapSummary(row);
    if (!summary.enabled) registryError('DESIGN_PERSONA_NOT_ENABLED', 'persona is not approved and enabled');
    if (!summary.manifest.compatibleAgents.includes(agent)) {
      registryError('DESIGN_PERSONA_AGENT_INCOMPATIBLE', 'persona does not support this agent');
    }
    const content = parseStored(row);
    const manifest = Object.freeze({
      ...summary.manifest,
      compatibleAgents: Object.freeze([...summary.manifest.compatibleAgents]),
    }) as PersonaManifest;
    const resolved = Object.freeze({
      ...summary,
      manifest,
      prompt: content.prompt,
      projectId,
      resolvedAgent: agent,
    }) as ResolvedPersona;
    issuedPersonas.add(resolved);
    return resolved;
  }

  private getForProject(projectId: number, personaId: number): PersonaSummary {
    const row = this.db.query<PersonaRow, [number, number, number]>(`${PERSONA_SELECT}
      WHERE p.id = ? AND (s.source_kind = 'builtin' OR pp.project_id = ?)`,
    ).get(projectId, personaId, projectId);
    if (!row) registryError('DESIGN_PERSONA_NOT_FOUND', 'persona is not available to this project');
    return mapSummary(row);
  }
}

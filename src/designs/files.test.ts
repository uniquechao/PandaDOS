import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { KeyedMutex } from '../issues/mutex';
import {
  DesignFilesError,
  DesignFilesService,
  canonicalDesignJson,
  classifyDesignFile,
  designFileSlug,
  parseDesignProjectionManifest,
  renderDesignProjectionBundle,
  type DesignFilesDriver,
  type DesignFilesSnapshot,
} from './files';

const sha = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

function u32(value: number): number[] {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function png(width = 1, height = 1): Uint8Array {
  return Uint8Array.from([
    137, 80, 78, 71, 13, 10, 26, 10,
    0, 0, 0, 13, 73, 72, 68, 82,
    ...u32(width), ...u32(height), 8, 6, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0,
    0, 0, 0, 0, 73, 69, 78, 68, 0, 0, 0, 0,
  ]);
}

function snapshot(revision = 1, documentMarkdown = '# Settings\n'): DesignFilesSnapshot {
  const asset = png();
  return {
    projectId: 7,
    designId: 9,
    revision,
    documentMarkdown,
    graph: {
      edges: [{ kind: 'depends_on', toNodeId: 'b', fromNodeId: 'a' }],
      nodes: [
        { nodeId: 'b', ordinal: 2, title: 'B', detail: { z: 2, a: 1 } },
        { title: 'A', ordinal: 1, nodeId: 'a' },
      ],
    },
    assets: [{
      id: 4,
      name: 'overview.png',
      mimeType: 'image/png',
      data: asset,
      sha256: sha(asset),
    }],
    personas: [{
      key: 'builtin:reviewer', source: 'builtin', contentHash: 'b'.repeat(64), gitCommit: 'c'.repeat(40),
    }],
  };
}

type EntryType = 'file' | 'dir' | 'symlink' | 'other';

class MemoryDriver implements DesignFilesDriver {
  readonly files = new Map<string, Uint8Array>();
  readonly special = new Map<string, EntryType>();
  readonly writes: string[] = [];
  readonly gitCalls: string[][] = [];
  failWritePath: string | null = null;
  branch = 'feature/design';
  onGitCall: ((callNumber: number, args: string[]) => void) | null = null;
  onReplace: ((path: string) => void) | null = null;

  private relative(path: string): string {
    return path.replace(/^\/+|\/+$/g, '');
  }

  async listDirectoryNoFollowWithin(_root: string, relativePath: string) {
    const dir = this.relative(relativePath);
    const prefix = dir ? `${dir}/` : '';
    const found = new Map<string, EntryType>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length);
      const [name, ...rest] = tail.split('/');
      if (name) found.set(name, rest.length ? 'dir' : 'file');
    }
    for (const [path, type] of this.special) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length);
      const [name, ...rest] = tail.split('/');
      if (name) found.set(name, rest.length ? 'dir' : type);
    }
    if (dir && found.size === 0 && ![...this.files.keys(), ...this.special.keys()].some((path) => path === dir || path.startsWith(`${dir}/`))) {
      return null;
    }
    return [...found].map(([name, type]) => ({ name, type }));
  }

  async readFileNoFollowWithin(_root: string, relativePath: string, limit: number) {
    const data = this.files.get(this.relative(relativePath));
    if (!data) return null;
    return { data: data.slice(0, limit), size: data.length };
  }

  async replaceFileNoFollowWithin(
    _root: string,
    relativePath: string,
    data: Uint8Array,
    expectedSha256: string | null,
  ) {
    const path = this.relative(relativePath);
    this.onReplace?.(path);
    if (this.failWritePath === path) throw new Error('simulated remote write failure');
    const current = this.files.get(path);
    const currentHash = current ? sha(current) : null;
    if (currentHash !== expectedSha256) return 'conflict' as const;
    if (current && currentHash === sha(data)) return 'unchanged' as const;
    this.files.set(path, data.slice());
    this.writes.push(path);
    return 'written' as const;
  }

  async removeFileNoFollowWithin(_root: string, relativePath: string, expectedSha256: string) {
    const path = this.relative(relativePath);
    const current = this.files.get(path);
    if (!current || sha(current) !== expectedSha256) return 'conflict' as const;
    this.files.delete(path);
    this.writes.push(`remove:${path}`);
    return 'removed' as const;
  }

  async git(_cwd: string, args: string[]) {
    this.gitCalls.push([...args]);
    this.onGitCall?.(this.gitCalls.length, args);
    const key = args.join('\0');
    if (key === 'rev-parse\0--is-inside-work-tree') return { code: 0, out: 'true\n', err: '' };
    if (key === 'symbolic-ref\0--quiet\0--short\0HEAD') return { code: 0, out: `${this.branch}\n`, err: '' };
    if (key === 'rev-parse\0--verify\0--quiet\0HEAD') return { code: 0, out: `${'d'.repeat(40)}\n`, err: '' };
    return { code: 1, out: '', err: 'blocked' };
  }
}

function setup(initial = snapshot(), mutex = new KeyedMutex()) {
  const driver = new MemoryDriver();
  let current = initial;
  const revisions = new Map<number, DesignFilesSnapshot>([[initial.revision, initial]]);
  let now = 1_000;
  const service = new DesignFilesService({
    mutex,
    loadCurrentSnapshot: () => current,
    loadRevisionSnapshot: (_projectId, _designId, revision) => revisions.get(revision) ?? null,
    resolveTarget: () => ({
      driver,
      cwd: '/remote/project',
      kind: 'project',
      stableKey: 'project:7:/remote/project',
    }),
    conflictSecret: 'server-only-conflict-secret',
    now: () => now,
  });
  return {
    driver,
    service,
    setCurrent(next: DesignFilesSnapshot) { current = next; revisions.set(next.revision, next); },
    setNow(value: number) { now = value; },
    mutex,
  };
}

describe('design file projection primitives', () => {
  test('derives only stable ID slugs and canonicalizes graph objects recursively', () => {
    expect(designFileSlug(9)).toBe('design-9');
    for (const id of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => designFileSlug(id)).toThrow(DesignFilesError);
    }
    expect(canonicalDesignJson({ z: 1, a: { y: 2, x: 1 } })).toBe(
      '{\n  "a": {\n    "x": 1,\n    "y": 2\n  },\n  "z": 1\n}\n',
    );
    expect(() => canonicalDesignJson({ unsafe: Number.NaN })).toThrow(DesignFilesError);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalDesignJson(cycle)).toThrow(DesignFilesError);
  });

  test('renders byte-stable document graph assets and provenance without persona content', () => {
    const target = { kind: 'project' as const, branch: 'feature/design', head: 'd'.repeat(40), stableKey: 'project:7' };
    const first = renderDesignProjectionBundle(snapshot(), target, 1_000);
    const reordered = snapshot();
    reordered.graph = {
      nodes: [...(reordered.graph as { nodes: unknown[] }).nodes].reverse(),
      edges: [...(reordered.graph as { edges: unknown[] }).edges].reverse(),
    };
    const second = renderDesignProjectionBundle(reordered, target, 1_000);
    expect([...first.files]).toEqual([...second.files]);
    expect(new TextDecoder().decode(first.files.get('DESIGN.md'))).toBe(
      '<!-- PandaDOS design schema=1 design=9 revision=1 -->\n# Settings\n',
    );
    expect([...first.files.keys()]).toEqual([
      'DESIGN.md', 'issue-graph.json', 'assets/4-overview.png', 'manifest.json',
    ]);
    const manifest = parseDesignProjectionManifest(first.files.get('manifest.json')!);
    expect(manifest).toMatchObject({
      schemaVersion: 1, generatedBy: 'PandaDOS', authoritativeSource: 'database',
      designId: 9, projectId: 7, revision: 1, slug: 'design-9', publishedAt: 1_000,
      target: { kind: 'project', branch: 'feature/design', head: 'd'.repeat(40) },
      assets: [{ id: 4, path: 'assets/4-overview.png', mimeType: 'image/png' }],
      personas: [{ key: 'builtin:reviewer', source: 'builtin', contentHash: 'b'.repeat(64), gitCommit: 'c'.repeat(40) }],
    });
    expect(JSON.stringify(manifest)).not.toContain('secret');
    expect(manifest.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.selfDigest).toMatch(/^[a-f0-9]{64}$/);

    const extra = snapshot();
    extra.personas = [{ ...extra.personas![0]!, prompt: 'secret prompt', token: 'secret token' } as never];
    const exactProvenance = renderDesignProjectionBundle(extra, target, 1_000);
    expect(new TextDecoder().decode(exactProvenance.files.get('manifest.json'))).not.toContain('secret');
  });

  test('rejects truncated image magic that is not a structurally valid raster', () => {
    const invalid = snapshot();
    const truncated = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    invalid.assets = [{ ...invalid.assets[0]!, data: truncated, sha256: sha(truncated) }];
    expect(() => renderDesignProjectionBundle(
      invalid,
      { kind: 'project', branch: 'main', head: 'd'.repeat(40), stableKey: 'project:7' },
      1_000,
    )).toThrow(DesignFilesError);
  });

  test('classifies every three-way hash state without treating deletion as local-only', () => {
    const a = 'a'.repeat(64); const b = 'b'.repeat(64); const c = 'c'.repeat(64);
    expect(classifyDesignFile(a, a, a)).toBe('unchanged');
    expect(classifyDesignFile(a, a, b)).toBe('safe_update');
    expect(classifyDesignFile(b, a, b)).toBe('already_target');
    expect(classifyDesignFile(b, a, a)).toBe('local_only');
    expect(classifyDesignFile(c, a, b)).toBe('conflict');
    expect(classifyDesignFile(null, a, a)).toBe('conflict');
    expect(classifyDesignFile(null, null, a)).toBe('safe_update');
    expect(classifyDesignFile(b, null, a)).toBe('conflict');
  });
});

describe('DesignFilesService', () => {
  test('publishes through the remote no-follow driver with manifest last and read-only Git argv', async () => {
    const { driver, service } = setup();
    const result = await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    expect(result).toMatchObject({ status: 'published', revision: 1, targetKind: 'project' });
    expect(driver.writes).toEqual([
      '.panda/designs/design-9/DESIGN.md',
      '.panda/designs/design-9/assets/4-overview.png',
      '.panda/designs/design-9/issue-graph.json',
      '.panda/designs/design-9/manifest.json',
    ]);
    const technicalTargetRead = [
      ['rev-parse', '--is-inside-work-tree'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
    ];
    expect(driver.gitCalls).toHaveLength(18);
    for (let offset = 0; offset < driver.gitCalls.length; offset += technicalTargetRead.length) {
      expect(driver.gitCalls.slice(offset, offset + technicalTargetRead.length)).toEqual(technicalTargetRead);
    }
    const forbidden = new Set(['add', 'commit', 'push', 'reset', 'stash', 'clean', 'checkout']);
    expect(driver.gitCalls.flat().some((arg) => forbidden.has(arg))).toBe(false);
  });

  test('keeps publishedAt and every byte stable on a same-bundle retry', async () => {
    const { driver, service, setNow } = setup();
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    const before = new Map([...driver.files].map(([path, data]) => [path, Buffer.from(data).toString('hex')]));
    driver.writes.length = 0;
    setNow(9_999);
    const retry = await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    expect(retry.status).toBe('noop');
    expect(driver.writes).toEqual([]);
    expect(new Map([...driver.files].map(([path, data]) => [path, Buffer.from(data).toString('hex')]))).toEqual(before);
    expect(parseDesignProjectionManifest(driver.files.get('.panda/designs/design-9/manifest.json')!).publishedAt).toBe(1_000);
  });

  test('returns a bound conflict token and overwrites only after re-reading unchanged local hashes', async () => {
    const { driver, service, setCurrent, setNow } = setup();
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    driver.files.set('.panda/designs/design-9/DESIGN.md', new TextEncoder().encode('owner edit\n'));
    setCurrent(snapshot(2, '# Changed settings\n'));
    setNow(2_000);
    const diff = await service.diff({ projectId: 7, designId: 9, expectedRevision: 2 });
    expect(diff.files.find((file) => file.path === 'DESIGN.md')?.classification).toBe('conflict');
    expect(diff.files.find((file) => file.path === 'DESIGN.md')).toMatchObject({
      baseText: '<!-- PandaDOS design schema=1 design=9 revision=1 -->\n# Settings\n',
      localText: 'owner edit\n',
      incomingText: '<!-- PandaDOS design schema=1 design=9 revision=2 -->\n# Changed settings\n',
    });
    expect(diff.conflictToken).toBeString();
    await expect(service.publish({ projectId: 7, designId: 9, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    const overwritten = await service.publish({
      projectId: 7, designId: 9, expectedRevision: 2,
      resolution: 'overwrite', conflictToken: diff.conflictToken!,
    });
    expect(overwritten.status).toBe('published');
    expect(new TextDecoder().decode(driver.files.get('.panda/designs/design-9/DESIGN.md')!)).toContain('# Changed settings');
  });

  test('rejects a stale conflict token, unsafe bundle entries, and unsafe asset descriptors', async () => {
    const { driver, service, setCurrent } = setup();
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    driver.files.set('.panda/designs/design-9/DESIGN.md', new TextEncoder().encode('first edit\n'));
    setCurrent(snapshot(2, '# Incoming\n'));
    const diff = await service.diff({ projectId: 7, designId: 9, expectedRevision: 2 });
    driver.files.set('.panda/designs/design-9/DESIGN.md', new TextEncoder().encode('second edit\n'));
    await expect(service.publish({
      projectId: 7, designId: 9, expectedRevision: 2,
      resolution: 'overwrite', conflictToken: diff.conflictToken!,
    })).rejects.toMatchObject({ code: 'CONFLICT_STALE' });

    const unsafe = setup();
    unsafe.driver.special.set('.panda', 'symlink');
    await expect(unsafe.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'UNSAFE_PATH' });

    const badAsset = snapshot();
    badAsset.assets = [{ ...badAsset.assets[0]!, name: '../escape.png' }];
    const invalid = setup(badAsset);
    await expect(invalid.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'ASSET_INVALID' });
  });

  test('retries a partial data-file failure without overwriting unknown files', async () => {
    const { driver, service } = setup();
    driver.files.set('.panda/designs/design-9/notes.txt', new TextEncoder().encode('preserve me'));
    driver.failWritePath = '.panda/designs/design-9/issue-graph.json';
    await expect(service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(driver.files.has('.panda/designs/design-9/manifest.json')).toBe(false);
    driver.failWritePath = null;
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    expect(new TextDecoder().decode(driver.files.get('.panda/designs/design-9/notes.txt')!)).toBe('preserve me');
  });

  test('CAS-removes only a prior-manifest asset before manifest and retries after manifest failure', async () => {
    const { driver, service, setCurrent } = setup();
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    driver.files.set('.panda/designs/design-9/keep.bin', Uint8Array.from([9, 9]));
    const next = snapshot(2, '# Settings v2\n');
    next.assets = [];
    setCurrent(next);
    driver.writes.length = 0;
    driver.failWritePath = '.panda/designs/design-9/manifest.json';
    await expect(service.publish({ projectId: 7, designId: 9, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'WRITE_FAILED' });
    expect(driver.files.has('.panda/designs/design-9/assets/4-overview.png')).toBe(false);
    expect(driver.files.has('.panda/designs/design-9/keep.bin')).toBe(true);
    expect(driver.writes.indexOf('remove:.panda/designs/design-9/assets/4-overview.png'))
      .toBeGreaterThanOrEqual(0);
    expect(driver.files.has('.panda/designs/design-9/manifest.json')).toBe(true);
    driver.failWritePath = null;
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 2 });
    expect(parseDesignProjectionManifest(driver.files.get('.panda/designs/design-9/manifest.json')!).revision).toBe(2);
    expect(driver.files.has('.panda/designs/design-9/keep.bin')).toBe(true);
  });

  test('exposes corrupt manifests as bounded external conflict and overwrites only with its signed token', async () => {
    const corrupt = setup();
    corrupt.driver.files.set('.panda/designs/design-9/notes.txt', new TextEncoder().encode('preserve unknown'));
    const unknownAsset = Uint8Array.from([1, 2, 3, 4]);
    corrupt.driver.files.set('.panda/designs/design-9/assets/99-unknown.png', unknownAsset);
    corrupt.driver.files.set(
      '.panda/designs/design-9/manifest.json',
      new TextEncoder().encode('{"schemaVersion":2}\n'),
    );
    const diff = await corrupt.service.diff({ projectId: 7, designId: 9, expectedRevision: 1 });
    expect(diff.files.find((file) => file.path === 'manifest.json')).toMatchObject({
      classification: 'conflict', localText: '{"schemaVersion":2}\n',
    });
    expect(diff.conflictToken).toBeString();
    await expect(corrupt.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    corrupt.setNow(2_000);
    await expect(corrupt.service.publish({
      projectId: 7, designId: 9, expectedRevision: 1,
      resolution: 'overwrite', conflictToken: diff.conflictToken!,
    })).resolves.toMatchObject({ status: 'published' });
    expect(parseDesignProjectionManifest(corrupt.driver.files.get('.panda/designs/design-9/manifest.json')!).revision).toBe(1);
    expect(new TextDecoder().decode(corrupt.driver.files.get('.panda/designs/design-9/notes.txt')!)).toBe('preserve unknown');
    expect(corrupt.driver.files.get('.panda/designs/design-9/assets/99-unknown.png')).toEqual(unknownAsset);
  });

  test('treats first-publish pre-existing owned files as external state', async () => {
    const preexisting = setup();
    const ownerBytes = new TextEncoder().encode('pre-existing owner document\n');
    preexisting.driver.files.set('.panda/designs/design-9/DESIGN.md', ownerBytes);
    await expect(preexisting.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'EXTERNAL_CHANGE' });
    expect(preexisting.driver.files.get('.panda/designs/design-9/DESIGN.md')).toEqual(ownerBytes);
  });

  test('fails closed when branch identity changes after token validation and before a write', async () => {
    const { driver, service, setCurrent } = setup();
    await service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    driver.files.set('.panda/designs/design-9/DESIGN.md', new TextEncoder().encode('owner edit\n'));
    setCurrent(snapshot(2, '# Incoming\n'));
    const diff = await service.diff({ projectId: 7, designId: 9, expectedRevision: 2 });
    const firstPublishCall = driver.gitCalls.length;
    driver.onGitCall = (callNumber) => {
      if (callNumber === firstPublishCall + 5) driver.branch = 'other/branch';
    };
    const writesBefore = driver.writes.length;
    await expect(service.publish({
      projectId: 7, designId: 9, expectedRevision: 2,
      resolution: 'overwrite', conflictToken: diff.conflictToken!,
    })).rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    expect(driver.writes).toHaveLength(writesBefore);
  });

  test('rechecks target identity after the manifest write', async () => {
    const { driver, service } = setup();
    driver.onReplace = (path) => {
      if (path.endsWith('/manifest.json')) driver.branch = 'other/branch';
    };
    await expect(service.publish({ projectId: 7, designId: 9, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'CONFLICT_STALE' });
    expect(driver.writes.at(-1)).toBe('.panda/designs/design-9/manifest.json');
  });

  test('expires overwrite tokens and resolves fresh target state only after the shared Git lock', async () => {
    const expiring = setup();
    await expiring.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    expiring.driver.files.set('.panda/designs/design-9/DESIGN.md', new TextEncoder().encode('owner edit\n'));
    expiring.setCurrent(snapshot(2, '# Incoming\n'));
    const diff = await expiring.service.diff({ projectId: 7, designId: 9, expectedRevision: 2 });
    expiring.setNow(1_000 + 10 * 60 * 1000 + 1);
    await expect(expiring.service.publish({
      projectId: 7, designId: 9, expectedRevision: 2,
      resolution: 'overwrite', conflictToken: diff.conflictToken!,
    })).rejects.toMatchObject({ code: 'CONFLICT_STALE' });

    const mutex = new KeyedMutex();
    const locked = setup(snapshot(), mutex);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = false;
    const holder = mutex.runExclusive('git:7', async () => { entered = true; await gate; });
    while (!entered) await Promise.resolve();
    const publishing = locked.service.publish({ projectId: 7, designId: 9, expectedRevision: 1 });
    await Promise.resolve();
    expect(locked.driver.gitCalls).toEqual([]);
    release();
    await holder;
    await publishing;
    expect(locked.driver.gitCalls.length).toBe(18);
  });
});

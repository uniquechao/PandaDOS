import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { migrate } from './migrate';
import {
  PandaProjectSync,
  PandaSyncIndex,
  canonicalJson,
  isShareablePandaPath,
  parseVersionedPandaJson,
  sha256Hex,
  type PandaSyncAdapter,
} from './project-sync';
import { LocalDriver } from '../executor/local';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function record(uid: string, value: string, version = 1): string {
  return JSON.stringify({
    schema: 'pandados.project-data', version, kind: 'demo', uid, updatedTs: 10, value,
  });
}

describe('通用 .panda 文件同步', () => {
  test('路径白名单排除 tmp、密钥、权限和运行态', () => {
    expect(isShareablePandaPath('.panda/project.json')).toBe(true);
    expect(isShareablePandaPath('.panda/modules/a/MODULE.md')).toBe(true);
    for (const unsafe of [
      '.panda/tmp/x.json', '.panda/keys/id_rsa', '.panda/secrets/a',
      '.panda/permissions.json', '.panda/runtime/lock', '../.panda/project.json',
    ]) expect(isShareablePandaPath(unsafe)).toBe(false);
  });

  test('安全解析版本化 JSON，拒绝未来版本、错 schema 和超限内容', () => {
    const uid = '018bcfe5-6800-7102-8304-05060708090a';
    expect(parseVersionedPandaJson(new TextEncoder().encode(record(uid, 'ok')), 'x.json'))
      .toMatchObject({ uid, version: 1, kind: 'demo' });
    expect(() => parseVersionedPandaJson(new TextEncoder().encode(record(uid, 'x', 2)), 'x.json'))
      .toThrow(/不支持.*版本/);
    expect(() => parseVersionedPandaJson(new TextEncoder().encode('{}'), 'x.json')).toThrow(/schema/);
    expect(() => parseVersionedPandaJson(new Uint8Array(9), 'x.json', 8)).toThrow(/过大/);
  });

  test('规范 JSON 与内容指纹稳定', () => {
    const a = canonicalJson({ z: 1, nested: { b: 2, a: 1 } });
    const b = canonicalJson({ nested: { a: 1, b: 2 }, z: 1 });
    expect(a).toBe(b);
    expect(sha256Hex(new TextEncoder().encode(a))).toBe(sha256Hex(new TextEncoder().encode(b)));
  });

  test('坏文件被删掉后，索引里的 error 行也要消失（否则状态永远停在 warning）', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-sync-forget-'));
    cleanups.push(cwd);
    await fsp.mkdir(path.join(cwd, '.panda', 'workflows'), { recursive: true });
    const uid = '018bcfe5-6803-7102-8304-05060708090a';
    await fsp.writeFile(path.join(cwd, '.panda', 'project.json'), record(uid, 'ok'));
    await fsp.writeFile(path.join(cwd, '.panda', 'workflows', 'bad.json'), '{bad');

    const db = openDb(':memory:');
    migrate(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'p', 1, ?, 1, 1)`, [cwd]);
    const adapter: PandaSyncAdapter = {
      kind: 'demo',
      matches: (file) => file.endsWith('.json'),
      apply: () => {},
      archive: () => {},
    };
    const sync = new PandaProjectSync(new LocalDriver(), new PandaSyncIndex(db), [adapter]);
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 1 });
    const index = new PandaSyncIndex(db);
    expect(index.list(7).filter((e) => e.state === 'error').map((e) => e.path))
      .toEqual(['.panda/workflows/bad.json']);

    // 删掉坏文件：它没有 sync_uid，走不了归档流程，必须被直接忘掉
    await fsp.rm(path.join(cwd, '.panda', 'workflows', 'bad.json'));
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 0 });
    expect(index.list(7).filter((e) => e.state === 'error')).toEqual([]);
    db.close();
  });

  test('增量导入隔离坏文件、跳过未变内容，并把消失文件归档', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-sync-'));
    cleanups.push(cwd);
    await fsp.mkdir(path.join(cwd, '.panda', 'workflows'), { recursive: true });
    await fsp.mkdir(path.join(cwd, '.panda', 'tmp'), { recursive: true });
    const uid1 = '018bcfe5-6800-7102-8304-05060708090a';
    const uid2 = '018bcfe5-6801-7102-8304-05060708090a';
    await fsp.writeFile(path.join(cwd, '.panda', 'project.json'), record(uid1, 'one'));
    await fsp.writeFile(path.join(cwd, '.panda', 'workflows', 'two.json'), record(uid2, 'two'));
    await fsp.writeFile(path.join(cwd, '.panda', 'workflows', 'bad.json'), '{bad');
    await fsp.writeFile(path.join(cwd, '.panda', 'tmp', 'ignored.json'), record(uid2, 'ignored'));

    const db = openDb(':memory:');
    migrate(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'p', 1, ?, 1, 1)`, [cwd]);
    const applied: string[] = [];
    const archived: string[] = [];
    const adapter: PandaSyncAdapter = {
      kind: 'demo',
      matches: (file) => file.endsWith('.json'),
      apply: (_projectId, item) => { applied.push(item.uid); },
      archive: (_projectId, item) => { archived.push(item.uid); },
    };
    const sync = new PandaProjectSync(new LocalDriver(), new PandaSyncIndex(db), [adapter]);
    const first = await sync.pull(7, cwd);
    expect(first).toMatchObject({ imported: 2, unchanged: 0, archived: 0, errors: 1 });
    expect(applied).toEqual([uid1, uid2]);

    const second = await sync.pull(7, cwd);
    expect(second).toMatchObject({ imported: 0, unchanged: 2, archived: 0, errors: 1 });
    const uid3 = '018bcfe5-6802-7102-8304-05060708090a';
    await fsp.writeFile(path.join(cwd, '.panda', 'workflows', 'bad.json'), record(uid3, 'fixed'));
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 1, unchanged: 2, errors: 0 });
    await fsp.rm(path.join(cwd, '.panda', 'workflows', 'two.json'));
    const third = await sync.pull(7, cwd);
    expect(third.archived).toBe(1);
    expect(archived).toEqual([uid2]);
    expect(new PandaSyncIndex(db).list(7).find((entry) => entry.syncUid === uid2)?.state).toBe('archived');
    db.close();
  });

  test('写入使用 no-follow CAS，冲突不会覆盖外部更新', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-sync-write-'));
    cleanups.push(cwd);
    const sync = new PandaProjectSync(new LocalDriver(), null, []);
    const first = await sync.writeJson(cwd, '.panda/project.json', { b: 2, a: 1 }, null);
    expect(first.status).toBe('written');
    expect(await fsp.readFile(path.join(cwd, '.panda', 'project.json'), 'utf8')).toBe('{"a":1,"b":2}\n');
    expect((await sync.writeJson(cwd, '.panda/project.json', { a: 3 }, '0'.repeat(64))).status)
      .toBe('conflict');
    expect((await sync.writeJson(cwd, '.panda/project.json', { a: 3 }, first.fingerprint)).status)
      .toBe('written');
  });
});

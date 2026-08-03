import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { ExternalIssueStore, maskExternalIssueToken } from './external-issues';
import { migrate } from './migrate';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  db.query(
    `INSERT INTO users (id, username, token_hash, role, created_ts)
     VALUES (1, 'owner', 'h', 'user', 0)`,
  ).run();
  db.query(
    `INSERT INTO executors
       (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES (1, 'local', '127.0.0.1', 22, '', '', '/ws', '')`,
  ).run();
  db.query(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
     VALUES (1, 'p', 1, '/ws/p', 1, 0)`,
  ).run();
  let ts = 100;
  return {
    db,
    store: new ExternalIssueStore(db, () => ts++),
    setTs: (next: number) => {
      ts = next;
    },
  };
}

describe('ExternalIssueStore', () => {
  test('每项目保存一条来源，同凭据范围保留 token，切换 provider 自动清除', () => {
    const { db, store, setTs } = setup();
    const first = store.saveSource({
      projectId: 1,
      provider: 'github',
      remoteName: 'origin',
      remoteUrl: 'git@github.com:o/r.git',
      instanceUrl: 'https://github.com',
      apiToken: 'github-token-1234',
    });
    expect(first.tokenUpdatedTs).toBe(100);
    expect(store.sourceSummary(1)).toMatchObject({
      provider: 'github',
      remoteName: 'origin',
      tokenConfigured: true,
      tokenMasked: '••••1234',
    });

    setTs(150);
    const kept = store.saveSource({
      projectId: 1,
      provider: 'github',
      remoteName: 'mirror',
      remoteUrl: 'git@github.com:o/r.git',
      instanceUrl: 'https://github.com',
    });
    expect(kept.apiToken).toBe('github-token-1234');
    expect(kept.tokenUpdatedTs).toBe(100);
    expect(kept.createdTs).toBe(100);
    expect(kept.updatedTs).toBe(150);

    setTs(200);
    const switched = store.saveSource({
      projectId: 1,
      provider: 'gitlab',
      remoteName: 'upstream',
      remoteUrl: 'git@gitlab.example:o/r.git',
      instanceUrl: 'https://gitlab.example',
    });
    expect(switched.apiToken).toBeNull();
    expect(switched.tokenUpdatedTs).toBeNull();

    setTs(300);
    expect(
      store.saveSource({
        projectId: 1,
        provider: 'gitlab',
        remoteName: 'upstream',
        remoteUrl: 'git@gitlab.example:o/r.git',
        instanceUrl: 'https://gitlab.example',
        apiToken: 'gitlab-token-5678',
      }).tokenUpdatedTs,
    ).toBe(300);
    setTs(400);
    expect(
      store.saveSource({
        projectId: 1,
        provider: 'gitlab',
        remoteName: 'upstream',
        remoteUrl: 'git@gitlab.example:o/r.git',
        instanceUrl: 'https://gitlab.example',
        apiToken: null,
      }).tokenUpdatedTs,
    ).toBeNull();
    expect(store.sourceSummary(1)?.tokenConfigured).toBe(false);
    expect(store.clearSource(1)).toBe(true);
    expect(store.source(1)).toBeNull();
    db.close();
  });

  test('远端记录按稳定来源键去重，并支持 ignored 转 imported', () => {
    const { db, store, setTs } = setup();
    const ignored = store.record({
      projectId: 1,
      provider: 'gitlab',
      sourceKey: 'gitlab.example/group/repo',
      externalId: '500',
      externalNumber: '12',
      externalUrl: 'https://gitlab.example/group/repo/-/issues/12',
      disposition: 'ignored',
      createdBy: 1,
    });
    expect(ignored.disposition).toBe('ignored');
    expect(ignored.localIssueId).toBeNull();

    db.query(
      `INSERT INTO issues (id, project_id, title, created_by, created_ts)
       VALUES (9, 1, 'imported', 1, 0)`,
    ).run();
    setTs(200);
    const imported = store.record({
      projectId: 1,
      provider: 'gitlab',
      sourceKey: 'gitlab.example/group/repo',
      externalId: '500',
      externalNumber: '12',
      externalUrl: 'https://gitlab.example/group/repo/-/issues/12',
      disposition: 'imported',
      localIssueId: 9,
      createdBy: 1,
    });
    expect(imported.id).toBe(ignored.id);
    expect(imported.disposition).toBe('imported');
    expect(imported.localIssueId).toBe(9);
    expect(store.listRecords(1, 'gitlab', 'gitlab.example/group/repo')).toEqual([imported]);
    db.close();
  });

  test('短 token 不泄露，空 token 无脱敏值', () => {
    expect(maskExternalIssueToken('abc')).toBe('••••');
    expect(maskExternalIssueToken('')).toBeNull();
    expect(maskExternalIssueToken(null)).toBeNull();
  });

  test('原子导入不覆盖既有 imported 记录，忽略也不能把它降级', () => {
    const { db, store } = setup();
    db.query(
      `INSERT INTO issues (id, project_id, title, created_by, created_ts)
       VALUES (9, 1, 'first', 1, 0), (10, 1, 'second', 1, 0)`,
    ).run();
    const identity = {
      projectId: 1,
      provider: 'github' as const,
      sourceKey: 'github:github.com/o/r',
      externalId: '500',
      externalNumber: '12',
      externalUrl: 'https://github.com/o/r/issues/12',
      createdBy: 1,
    };
    expect(store.recordImportedOnce(identity, 9)?.localIssueId).toBe(9);
    expect(store.recordImportedOnce(identity, 10)).toBeNull();
    expect(store.recordIgnored(identity)).toBeNull();
    expect(store.listRecords(1, 'github', identity.sourceKey)[0]?.localIssueId).toBe(9);
    db.close();
  });
});

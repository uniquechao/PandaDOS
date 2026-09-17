import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../core/migrate';
import { openDb } from '../core/db';
import { migrateDesigns } from '../designs/store';
import { LocalDriver } from '../executor/local';
import { getProject, migrateIssueEngine } from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import { decidePoll, ProjectDataSyncCoordinator } from './project-data-sync';

const cleanups: string[] = [];
afterEach(async () => Promise.all(cleanups.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))));

function managed(name: string, body: string): string {
  return `<!-- panda:${name}:start -->\n${body}\n<!-- panda:${name}:end -->\n`;
}

describe('项目协作数据触发与指纹轮询', () => {
  test('远程执行机内容变化增量导入，执行中 Issue 不被文件状态或删除改写', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-project-poll-'));
    cleanups.push(cwd);
    const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db); migrateDesigns(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, 'p', 1, ?, 1, 1)`, [cwd]);
    const moduleUid = '018bcfe5-6800-7102-8304-05060708090a';
    const issueUid = '018bcfe5-6801-7102-8304-05060708090a';
    db.run(`INSERT INTO project_modules
      (id, project_id, sync_uid, slug, display_name, agent, source, created_ts)
      VALUES (11, 1, ?, 'sync-core', '同步', 'codex', 'manual', 2)`, [moduleUid]);
    db.run(`INSERT INTO issues
      (id, project_id, sync_uid, module_id, module, title, status, agent, created_ts)
      VALUES (12, 1, ?, 11, 'sync-core', '本机标题', 'implementing', 'codex', 3)`, [issueUid]);
    db.run('DELETE FROM project_data_outbox');
    await fs.mkdir(path.join(cwd, '.panda/modules/sync-core/issues'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.panda/modules/sync-core/MODULE.md'), `# 同步\n\n${managed('module-meta', [
      '---', `sync_uid: ${moduleUid}`, 'slug: sync-core', 'display_name: "同步"',
      'agent: codex', 'source: manual', 'status: active', 'created_ts: 2', '---',
    ].join('\n'))}`);
    const issuePath = path.join(cwd, '.panda/modules/sync-core/issues/12-sync.md');
    await fs.writeFile(issuePath, `# #12 文件标题\n\n## 原始需求\n\n长期内容\n\n${managed('issue-meta', [
      '---', `sync_uid: ${issueUid}`, `module_uid: ${moduleUid}`, 'module: sync-core',
      'agent: codex', 'category: task', 'impl_mode: seq', 'status: done', 'created_ts: 3', '---',
    ].join('\n'))}`);

    const coordinator = new ProjectDataSyncCoordinator(db, () => new LocalDriver(), new KeyedMutex());
    const first = await coordinator.sync(getProject(db, 1)!);
    expect(first).toMatchObject({ imported: 2, errors: 0 });
    expect(coordinator.status(1)).toMatchObject({
      state: 'success', detectedUpdates: 2, imported: 2, archived: 0, parseErrors: 0,
    });
    expect(db.query<{ title: string; body: string; status: string }, []>(
      'SELECT title, body, status FROM issues WHERE id = 12',
    ).get()).toEqual({ title: '文件标题', body: '长期内容', status: 'implementing' });
    expect(await coordinator.sync(getProject(db, 1)!)).toMatchObject({ unchanged: 2, errors: 0 });

    db.run("UPDATE issues SET status = 'blocked' WHERE id = 12");
    await fs.writeFile(issuePath, (await fs.readFile(issuePath, 'utf8'))
      .replace('# #12 文件标题', '# #12 文件标题已更新'));
    expect(await coordinator.sync(getProject(db, 1)!)).toMatchObject({ imported: 1, errors: 0 });
    expect(db.query<{ title: string; status: string }, []>(
      'SELECT title, status FROM issues WHERE id = 12',
    ).get()).toEqual({ title: '文件标题已更新', status: 'blocked' });

    db.run("UPDATE issues SET status = 'implementing' WHERE id = 12");
    await fs.rm(issuePath);
    expect(await coordinator.sync(getProject(db, 1)!)).toMatchObject({ archived: 1, errors: 0 });
    expect(coordinator.status(1)).toMatchObject({ state: 'success', detectedUpdates: 1, archived: 1 });
    expect(db.query<{ status: string }, []>('SELECT status FROM issues WHERE id = 12').get()!.status)
      .toBe('implementing');
    expect(await coordinator.pollActive()).toEqual({ projects: 1, errors: 0 });
    db.close();
  });

  test('成功同步后唤醒项目调度，新导入的 pending Issue 不停在队列里', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'panda-project-schedule-'));
    cleanups.push(cwd);
    const db = openDb(':memory:'); migrate(db); migrateIssueEngine(db); migrateDesigns(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, 'p', 1, ?, 1, 1)`, [cwd]);
    const moduleUid = '018bcfe5-6800-7102-8304-05060708090a';
    const issueUid = '018bcfe5-6801-7102-8304-05060708090a';
    await fs.mkdir(path.join(cwd, '.panda/modules/sync-core/issues'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.panda/modules/sync-core/MODULE.md'), `# 同步\n\n${managed('module-meta', [
      '---', `sync_uid: ${moduleUid}`, 'slug: sync-core', 'display_name: "同步"',
      'agent: codex', 'source: manual', 'status: active', 'created_ts: 2', '---',
    ].join('\n'))}`);
    await fs.writeFile(path.join(cwd, '.panda/modules/sync-core/issues/12-sync.md'),
      `# #12 新导入待办\n\n${managed('issue-meta', [
        '---', `sync_uid: ${issueUid}`, `module_uid: ${moduleUid}`, 'module: sync-core',
        'agent: codex', 'category: task', 'impl_mode: seq', 'status: pending', 'created_ts: 3', '---',
      ].join('\n'))}`);

    const scheduled: number[] = [];
    const coordinator = new ProjectDataSyncCoordinator(
      db,
      () => new LocalDriver(),
      new KeyedMutex(),
      async (projectId) => { scheduled.push(projectId); },
    );
    expect(await coordinator.sync(getProject(db, 1)!)).toMatchObject({ imported: 2, errors: 0 });
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()?.status).toBe('pending');
    expect(scheduled).toEqual([1]);
    db.close();
  });
});

describe('decidePoll：单飞不能吞掉安全网', () => {
  test('空闲时快拍就跑快拍，安全拍就跑全量', () => {
    expect(decidePoll({ inFlight: false, fullDue: false }, 'fast'))
      .toEqual({ run: true, full: false, fullDue: false });
    expect(decidePoll({ inFlight: false, fullDue: false }, 'full'))
      .toEqual({ run: true, full: true, fullDue: false });
  });

  test('安全拍撞上在途 → 不跑但欠着，下一拍（哪怕是快拍）补成全量', () => {
    const blocked = decidePoll({ inFlight: true, fullDue: false }, 'full');
    expect(blocked).toEqual({ run: false, full: false, fullDue: true });
    // 生产实测的回归点：这里若把 fullDue 丢掉，安全网间隔会从 60s 变成 120s
    expect(decidePoll({ inFlight: false, fullDue: blocked.fullDue }, 'fast'))
      .toEqual({ run: true, full: true, fullDue: false });
  });

  test('快拍撞上在途 → 直接丢弃（5 秒后还有一拍，不必记账）', () => {
    expect(decidePoll({ inFlight: true, fullDue: false }, 'fast'))
      .toEqual({ run: false, full: false, fullDue: false });
  });

  test('连续多个安全拍被挡 → 只欠一次，不会攒出一串全量轮询', () => {
    let state = { inFlight: true, fullDue: false };
    for (let i = 0; i < 5; i++) {
      const d = decidePoll(state, 'full');
      state = { inFlight: true, fullDue: d.fullDue };
    }
    expect(state.fullDue).toBe(true);
    const done = decidePoll({ inFlight: false, fullDue: state.fullDue }, 'fast');
    expect(done).toEqual({ run: true, full: true, fullDue: false });
    expect(decidePoll({ inFlight: false, fullDue: done.fullDue }, 'fast'))
      .toEqual({ run: true, full: false, fullDue: false });
  });
});

import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { PandaProjectSync, PandaSyncIndex } from '../core/project-sync';
import { LocalDriver } from '../executor/local';
import { migrateIssueEngine } from './engine';
import { ModuleDocs } from './module-docs';
import {
  createIssueProjectDataAdapters,
  issueMetaProjection,
  moduleMetaProjection,
  projectDataProjection,
} from './project-data-sync';

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function managed(name: string, body: string): string {
  return `<!-- panda:${name}:start -->\n---\n${body}\n---\n<!-- panda:${name}:end -->\n`;
}

describe('项目、模块与 Issue 文件主导同步', () => {
  test('新建过程页的多段正文经文件同步回读后保持完整', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-domain-sync-body-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, '协作项目', 1, ?, 1, 1)`, [cwd]);

    const module = {
      id: 5,
      syncUid: '018bcfe5-6800-7102-8304-05060708090b',
      projectId: 7,
      slug: 'sync-core',
      displayName: '同步核心',
      agent: 'codex' as const,
      source: 'manual' as const,
      status: 'active' as const,
      conversationId: null,
      syncStatus: 'ready' as const,
      syncError: null,
      createdBy: 1,
      createdTs: 10,
      lastUsedTs: null,
    };
    const exactBody = [
      '第一段：复现说明。',
      '',
      '## 验收标准',
      '',
      '- 多行和空行不能丢',
      '',
      '```md',
      '## 设计与实施',
      '代码块中的保留章节名也属于正文',
      '```',
      '',
      '详'.repeat(3_000),
      '',
      '最后一段。',
    ].join('\n');
    const docs = new ModuleDocs(new LocalDriver(), cwd);
    await docs.ensureModule(module);
    await docs.createIssuePage(module, {
      id: '270',
      title: '正文完整往返',
      body: exactBody,
      status: 'pending',
      agent: 'codex',
      createdTs: 11,
    });

    const sync = new PandaProjectSync(
      new LocalDriver(), new PandaSyncIndex(db), createIssueProjectDataAdapters(db),
    );
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 2, errors: 0 });
    expect(db.query<{ body: string | null }, []>('SELECT body FROM issues').get()!.body).toBe(exactBody);
    db.close();
  });

  test('导入长期字段、按 UUID 去重并在文件删除后归档', async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-domain-sync-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, '旧项目', 1, ?, 1, 1)`, [cwd]);

    const projectUid = db.query<{ sync_uid: string }, []>('SELECT sync_uid FROM projects WHERE id = 7').get()!.sync_uid;
    const moduleUid = '018bcfe5-6800-7102-8304-05060708090a';
    const issueUid = '018bcfe5-6801-7102-8304-05060708090a';
    await fsp.mkdir(path.join(cwd, '.panda', 'modules', 'sync-core', 'issues'), { recursive: true });
    await fsp.writeFile(path.join(cwd, '.panda', 'project.json'), JSON.stringify({
      schema: 'pandados.project-data', version: 1, kind: 'project', uid: projectUid,
      updatedTs: 20, name: '协作项目', goal: '团队一致', pmPersona: null,
      workBranch: 'panda/up', manualReview: true, projectKind: 'chat', status: 'active',
    }));
    await fsp.writeFile(path.join(cwd, '.panda', 'modules', 'sync-core', 'MODULE.md'),
      `# 同步核心\n\n${managed('module-meta', [
        `sync_uid: ${moduleUid}`, 'module_id: 999', 'project_id: 999', 'slug: sync-core',
        'display_name: "同步核心"', 'agent: codex', 'source: manual', 'status: active',
        'created_ts: 1700000000000', 'last_used_ts: null',
      ].join('\n'))}`);
    const issuePath = path.join(cwd, '.panda', 'modules', 'sync-core', 'issues', '99-sync.md');
    await fsp.writeFile(issuePath, `# #99 跨机同步\n\n## 原始需求\n\n从文件导入\n\n${managed('issue-meta', [
      `sync_uid: ${issueUid}`, 'issue_id: 99', `module_uid: ${moduleUid}`, 'module: sync-core',
      'agent: codex', 'category: task', 'impl_mode: seq', 'status: done',
      'created_ts: 1700000000001',
    ].join('\n'))}`);

    const sync = new PandaProjectSync(
      new LocalDriver(), new PandaSyncIndex(db), createIssueProjectDataAdapters(db),
    );
    const pulled = await sync.pull(7, cwd);
    expect(pulled).toMatchObject({ imported: 3, errors: 0 });
    expect(db.query<{ name: string; goal: string; manual_review: number; kind: string }, []>(
      'SELECT name, goal, manual_review, kind FROM projects WHERE id = 7',
    ).get()).toEqual({ name: '协作项目', goal: '团队一致', manual_review: 1, kind: 'issue' });
    const module = db.query<{ id: number; sync_uid: string; slug: string }, []>(
      'SELECT id, sync_uid, slug FROM project_modules',
    ).get()!;
    expect(module).toMatchObject({ sync_uid: moduleUid, slug: 'sync-core' });
    expect(db.query<{ sync_uid: string; module_id: number; title: string; status: string; doc_path: string }, []>(
      'SELECT sync_uid, module_id, title, status, doc_path FROM issues',
    ).get()).toEqual({
      sync_uid: issueUid,
      module_id: module.id,
      title: '跨机同步',
      status: 'done',
      doc_path: '.panda/modules/sync-core/issues/99-sync.md',
    });

    // 服务启动时 outbox 可能尚未把终态写回文件：旧 pending 不能把历史终态复活进待办。
    await fsp.writeFile(issuePath, (await fsp.readFile(issuePath, 'utf8'))
      .replace('status: done', 'status: pending'));
    await sync.pull(7, cwd);
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()!.status).toBe('done');

    db.run("UPDATE issues SET status = 'cancelled' WHERE sync_uid = ?", [issueUid]);
    await fsp.writeFile(issuePath, (await fsp.readFile(issuePath, 'utf8'))
      .replace('# #99 跨机同步', '# #99 跨机同步（旧副本）'));
    await sync.pull(7, cwd);
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()!.status).toBe('cancelled');

    db.run("UPDATE issues SET status = 'implementing' WHERE sync_uid = ?", [issueUid]);
    await fsp.writeFile(issuePath, (await fsp.readFile(issuePath, 'utf8'))
      .replace('跨机同步（旧副本）', '跨机同步（更旧副本）'));
    await sync.pull(7, cwd);
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()!.status).toBe('implementing');

    db.run("UPDATE issues SET status = 'done' WHERE sync_uid = ?", [issueUid]);
    await fsp.rm(issuePath);
    expect((await sync.pull(7, cwd)).archived).toBe(1);
    expect(db.query<{ status: string }, []>('SELECT status FROM issues').get()!.status).toBe('cancelled');
    db.close();
  });

  test('投影包含版本头与 UUID，旧 Markdown 可确定性补身份', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, 'p', 1, '/ws/p', 1, 1)`);
    db.run(`INSERT INTO project_modules
      (project_id, slug, display_name, agent, source, created_ts)
      VALUES (1, 'sync-core', '同步', 'codex', 'manual', 2)`);
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, agent, created_ts)
      VALUES ('1', 1, '任务', 'sync-core', 1, 'codex', 3)`);
    const project = projectDataProjection(db, 1);
    expect(project).toMatchObject({ version: 1, kind: 'project' });
    expect(project).not.toHaveProperty('projectKind');
    expect(moduleMetaProjection(db, 1)).toContain('sync_uid:');
    expect(issueMetaProjection(db, '1')).toContain('module_uid:');
    db.close();
  });
});

describe('sync_uid 项目内唯一（069）', () => {
  test('两个项目可以各有一个同 uid 的同名模块，互不顶替', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    for (const id of [1, 2]) {
      db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
        VALUES (?, ?, 1, ?, 1, 1)`, [id, `p${id}`, `/ws/p${id}`]);
    }
    // legacySyncUid 的种子是项目内相对路径，同名模块跨项目必然算出同一个 uid
    const uid = '00000000-0000-7f45-bfe5-18393ecdc27d';
    const ins = (projectId: number): void => {
      db.run(`INSERT INTO project_modules
        (project_id, slug, display_name, agent, source, status, created_ts, sync_uid)
        VALUES (?, 'feishu-integration', '飞书', 'claude', 'manual', 'active', 1, ?)`, [projectId, uid]);
    };
    ins(1);
    expect(() => ins(2)).not.toThrow(); // 069 之前这里是 UNIQUE constraint failed，后一个项目永远建不出模块
    expect(db.query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM project_modules WHERE sync_uid = ?').get(uid)!.n).toBe(2);
    // 项目内仍然唯一：同一个项目里重复的 uid 照样要被挡住
    expect(() => ins(1)).toThrow();
  });
});

describe('#307 跨实例同步沿用 issue 编号', () => {
  const moduleUid = '018bcfe5-6800-7102-8304-0506070809aa';
  const localUid = '018bcfe5-6801-7102-8304-0506070809aa';
  const remoteUid = '018bcfe5-6801-7102-8304-0506070809bb';
  const SHARED_ID = '20260917-a3f9e4f';

  async function setupRepo() {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-issue-id-sync-'));
    cleanups.push(cwd);
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db);
    db.run(`INSERT INTO users (id, username, token_hash, created_ts) VALUES (1, 'u', 'h', 1)`);
    db.run(`INSERT INTO executors
      (id, name, host, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'e', 'local', '', '', '/ws', '')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (7, 'p', 1, ?, 1, 1)`, [cwd]);
    await fsp.mkdir(path.join(cwd, '.panda', 'modules', 'sync-core', 'issues'), { recursive: true });
    await fsp.writeFile(path.join(cwd, '.panda', 'modules', 'sync-core', 'MODULE.md'),
      `# 同步核心\n\n${managed('module-meta', [
        `sync_uid: ${moduleUid}`, 'slug: sync-core', 'display_name: "同步核心"', 'agent: codex',
        'source: manual', 'status: active', 'created_ts: 1', 'last_used_ts: null',
      ].join('\n'))}`);
    const sync = new PandaProjectSync(new LocalDriver(), new PandaSyncIndex(db), createIssueProjectDataAdapters(db));
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 1, errors: 0 });
    const moduleId = db.query<{ id: number }, []>('SELECT id FROM project_modules').get()!.id;
    return { cwd, db, sync, moduleId };
  }

  async function writeIssue(cwd: string, id: string, uid: string, title: string, fileName = `${id}-sync.md`) {
    const rel = `.panda/modules/sync-core/issues/${fileName}`;
    await fsp.writeFile(path.join(cwd, rel), `# #${id} ${title}\n\n## 原始需求\n\n${title}\n\n${managed('issue-meta', [
      `sync_uid: ${uid}`, `issue_id: ${id}`, `module_uid: ${moduleUid}`, 'module: sync-core',
      'agent: codex', 'category: task', 'impl_mode: seq', 'status: pending', 'created_ts: 5',
    ].join('\n'))}`);
    return rel;
  }

  test('导入时沿用文件里的编号；无冲突直接落同号', async () => {
    const { cwd, db, sync } = await setupRepo();
    await writeIssue(cwd, SHARED_ID, remoteUid, '远端任务');
    expect(await sync.pull(7, cwd)).toMatchObject({ imported: 1, errors: 0 });
    expect(db.query<{ id: string; sync_uid: string }, []>('SELECT id, sync_uid FROM issues').all())
      .toEqual([{ id: SHARED_ID, sync_uid: remoteUid }]);
    db.close();
  });

  test('本地同号不同 sync_uid：本地这条换新号，引用、过程页路径、分支记录随之更新；远端按原号落库', async () => {
    const { cwd, db, sync, moduleId } = await setupRepo();
    const localDoc = `.panda/modules/sync-core/issues/${SHARED_ID}-local.md`;
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, agent, status, sync_uid, doc_path, created_ts)
      VALUES (?, 7, '本地任务', 'sync-core', ?, 'codex', 'done', ?, ?, 2)`, [SHARED_ID, moduleId, localUid, localDoc]);
    db.run(`INSERT INTO issue_events (issue_id, kind, ts) VALUES (?, 'created', 2)`, [SHARED_ID]);
    db.run(`INSERT INTO gates (issue_id, kind, payload_json) VALUES (?, 'plan', '{}')`, [SHARED_ID]);
    db.run(`INSERT INTO subscriptions (user_id, scope, target_id, created_ts) VALUES (1, 'issue', ?, 2)`, [SHARED_ID]);
    db.run(`INSERT INTO issue_usage (issue_id, project_id, updated_ts) VALUES (?, 7, 2)`, [SHARED_ID]);

    await writeIssue(cwd, SHARED_ID, remoteUid, '远端任务');
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 0 });

    const remote = db.query<{ id: string }, [string]>('SELECT id FROM issues WHERE sync_uid = ?').get(remoteUid)!;
    expect(remote.id).toBe(SHARED_ID);
    const local = db.query<{ id: string; doc_path: string; branch: string | null; status: string }, [string]>(
      'SELECT id, doc_path, branch, status FROM issues WHERE sync_uid = ?',
    ).get(localUid)!;
    expect(local.id).toMatch(/^\d{8}-[0-9a-f]{7}$/);
    expect(local.id).not.toBe(SHARED_ID);
    expect(local.status).toBe('done');
    expect(local.doc_path).toBe(`.panda/modules/sync-core/issues/${local.id}-local.md`);
    expect(local.branch).toBe(`issue/${SHARED_ID}`); // 已开跑过：指向真实存在的旧分支
    const count = (sql: string, id: string) => db.query<{ n: number }, [string]>(sql).get(id)!.n;
    expect(count("SELECT COUNT(*) AS n FROM issue_events WHERE issue_id = ? AND kind = 'created'", local.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM gates WHERE issue_id = ?', local.id)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM subscriptions WHERE scope = 'issue' AND target_id = ?", local.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM issue_usage WHERE issue_id = ?', local.id)).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM gates WHERE issue_id = ?', SHARED_ID)).toBe(0);
    const renumbered = db.query<{ data_json: string }, [string]>(
      "SELECT data_json FROM issue_events WHERE issue_id = ? AND kind = 'issue_renumbered'",
    ).get(local.id)!;
    expect(JSON.parse(renumbered.data_json)).toMatchObject({ from: SHARED_ID, to: local.id, reason: 'sync_collision', fromDocPath: localDoc });
    expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);

    // 本地旧过程页尚未被持久化搬走：这份过时文件不能把 doc_path/编号拉回去，也不能触发归档
    await writeIssue(cwd, SHARED_ID, localUid, '本地任务', `${SHARED_ID}-local.md`);
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 0 });
    expect(db.query<{ id: string; doc_path: string }, [string]>('SELECT id, doc_path FROM issues WHERE sync_uid = ?').get(localUid))
      .toEqual({ id: local.id, doc_path: local.doc_path });
    await fsp.rm(path.join(cwd, localDoc));
    await sync.pull(7, cwd);
    expect(db.query<{ status: string }, [string]>('SELECT status FROM issues WHERE sync_uid = ?').get(localUid)!.status).toBe('done');
    db.close();
  });

  test('本地同号 issue 执行中：本次导入报错不换号，下次拉取再试', async () => {
    const { cwd, db, sync, moduleId } = await setupRepo();
    db.run(`INSERT INTO issues (id, project_id, title, module, module_id, agent, status, sync_uid, created_ts)
      VALUES (?, 7, '本地执行中', 'sync-core', ?, 'codex', 'implementing', ?, 2)`, [SHARED_ID, moduleId, localUid]);
    await writeIssue(cwd, SHARED_ID, remoteUid, '远端任务');
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 1 });
    expect(db.query<{ id: string; sync_uid: string }, []>('SELECT id, sync_uid FROM issues').all())
      .toEqual([{ id: SHARED_ID, sync_uid: localUid }]);

    db.run(`UPDATE issues SET status = 'blocked' WHERE id = ?`, [SHARED_ID]);
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 0 });
    expect(db.query<{ id: string }, [string]>('SELECT id FROM issues WHERE sync_uid = ?').get(remoteUid)!.id).toBe(SHARED_ID);
    expect(db.query<{ id: string }, [string]>('SELECT id FROM issues WHERE sync_uid = ?').get(localUid)!.id).not.toBe(SHARED_ID);
    db.close();
  });

  test('远端给已同步的 issue 换过号：本地同一条（同 sync_uid）沿用远端新编号', async () => {
    const { cwd, db, sync } = await setupRepo();
    const oldRel = await writeIssue(cwd, SHARED_ID, remoteUid, '远端任务');
    await sync.pull(7, cwd);
    await fsp.rm(path.join(cwd, oldRel));
    const newId = '20260918-bbbb111';
    const newRel = await writeIssue(cwd, newId, remoteUid, '远端任务');
    expect(await sync.pull(7, cwd)).toMatchObject({ errors: 0, archived: 0 });
    expect(db.query<{ id: string; doc_path: string; status: string }, []>('SELECT id, doc_path, status FROM issues').all())
      .toEqual([{ id: newId, doc_path: newRel, status: 'pending' }]);
    db.close();
  });
});

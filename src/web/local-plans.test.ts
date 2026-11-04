import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { LocalDriver } from '../executor/local';
import { IssueEngine, migrateIssueEngine } from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import { LocalPlanService } from './local-plans';
import { localPlansRoutes } from './routes/local-plans';
import { issuesRoutes } from './routes/issues';
import { authDepsFromDb, createDispatcher } from './middleware';
import { ensurePandaIssuePlanSkill } from '../core/issue-plan-skill';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });
const task = { title: '用户标题', body: '用户正文\n## 完整标题', acceptance: ['可独立验收'] };
const markdown = (issues: unknown[] = [task, { ...task, category: 'debug', dependsOn: [1] }], planId = 'test-plan') =>
  `# 计划说明\n\n\`\`\`pandados-plan\n${JSON.stringify({ schemaVersion: 1, planId, title: '本地计划', issues })}\n\`\`\`\n`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function setup() {
  const base = path.resolve('.private/local-issue-plans');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'test-'));
  const repo = path.join(dir, 'repo');
  await fs.mkdir(path.join(repo, '.panda/plans'), { recursive: true });
  const db = openDb(':memory:');
  migrate(db); migrateIssueEngine(db);
  const users = new UserStore(db);
  const owner = users.create('owner');
  const stranger = users.create('stranger');
  const member = users.create('member');
  db.query(`INSERT INTO executors(id,name,host,port,ssh_user,key_ref,workspace_root,claude_dir,supports_claude,supports_codex)
    VALUES(1,'local','127.0.0.1',22,'','',?,'',1,1)`).run(dir);
  db.query(`INSERT INTO projects(id,name,executor_id,cwd,owner_user_id,created_ts) VALUES(1,'local-plans',1,?,?,0)`)
    .run(repo, owner.user.id);
  db.query('INSERT INTO project_members(project_id,user_id,created_ts) VALUES(1,?,0)').run(member.user.id);
  const driver = new LocalDriver();
  const engine = new IssueEngine({ db, driver,
    convs: { create: () => { throw new Error('unexpected conversation'); }, get: () => undefined,
      listByProject: () => [], currentConv: () => undefined, tmuxName: id => `cc-${id}`, activate: async () => null },
    locator: { locate: async () => null }, pmFor: () => ({ judgeDone: async () => 'not_done' }),
    notify: { dispatch: async () => {} }, mutex: new KeyedMutex(), config: { resultSummaryTimeoutMs: 0 },
  });
  let scheduleCount = 0;
  let failSchedule = false;
  engine.scheduleNext = async () => { scheduleCount++; if (failSchedule) throw new Error('scheduler temporarily unavailable'); };
  const service = new LocalPlanService({ db, engine, driverForProject: () => driver });
  const dispatch = createDispatcher([...localPlansRoutes(service), ...issuesRoutes({ db, engine })], authDepsFromDb(db, users));
  const write = async (content = markdown(), filename = 'plan.md') => {
    await fs.writeFile(path.join(repo, '.panda/plans', filename), content);
    return { path: `.panda/plans/${filename}`, planId: 'test-plan', digest: hash(content) };
  };
  cleanups.push(async () => { const drain = await service.stop(); await drain.done; db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { db, engine, service, driver, dispatch, owner, stranger, member, dir, repo, write,
    schedules: () => scheduleCount, failSchedule: (fail: boolean) => { failSchedule = fail; } };
}

describe('local plan discovery and atomic publication', () => {
  test('删除已导入任务保留计划幂等账本，重放和恢复不重建已删除任务', async () => {
    const s = await setup(); const input = await s.write();
    const original = await s.service.execute(1, s.owner.user.id, input);
    for (let i = 0; i < 100 && s.service.store.get(1, input.planId)!.effectsPending; i++) await Bun.sleep(5);
    expect(s.service.store.get(1, input.planId)!.effectsPending).toBe(false);
    const complete = s.engine.completeDesignBatch.bind(s.engine);
    let completions = 0;
    s.engine.completeDesignBatch = async (...args) => { completions++; return complete(...args); };
    const remove = (id: string, token = s.owner.token) => s.dispatch(new Request(
      `http://test/api/projects/1/issues/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    ));
    expect((await remove(original.issues[0].issueId, s.stranger.token))!.status).toBe(403);
    for (const item of original.issues) {
      expect((await remove(item.issueId))!.status).toBe(200);
      expect(s.engine.store.get(item.issueId)).toBeUndefined();
      const replay = await s.service.execute(1, s.owner.user.id, input);
      expect(replay.issues.map(i => i.issueId)).toEqual(original.issues.filter(i => s.engine.store.get(i.issueId)).map(i => i.issueId));
      expect(replay.effectsPending).toBe(false);
      expect(replay.plan.issues).toHaveLength(2);
      await s.service.recover();
    }
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
    expect(completions).toBe(0);
    expect(s.db.query('SELECT * FROM local_issue_plan_publications').all()).toHaveLength(1);
  });

  test('计划导入副作用未完成时删除返回可操作提示，完成后可以重试', async () => {
    const s = await setup(); const input = await s.write(); s.failSchedule(true);
    const original = await s.service.execute(1, s.owner.user.id, input);
    const id = original.issues[0].issueId;
    expect(await s.engine.removeIssue(id)).toEqual({ ok: false, error: '本地 issue 计划仍在完成导入，请稍后再删除' });
    expect(s.engine.store.get(id)).toBeDefined();
    expect(s.service.store.get(1, input.planId)!.issues).toHaveLength(2);
    s.failSchedule(false);
    for (let i = 0; i < 100 && s.service.store.get(1, input.planId)!.effectsPending; i++) { await s.service.recover(); await Bun.sleep(5); }
    expect(await s.engine.removeIssue(id)).toEqual({ ok: true });
  });

  test('其他外键仍保留历史，删除失败不会先拆掉计划关联', async () => {
    const s = await setup(); const input = await s.write();
    const original = await s.service.execute(1, s.owner.user.id, input);
    for (let i = 0; i < 100 && s.service.store.get(1, input.planId)!.effectsPending; i++) await Bun.sleep(5);
    const id = original.issues[0].issueId;
    s.db.run('CREATE TABLE retained_issue_history(issue_id TEXT REFERENCES issues(id) ON DELETE RESTRICT)');
    s.db.query('INSERT INTO retained_issue_history VALUES(?)').run(id);
    const result = await s.engine.removeIssue(id);
    expect(result).toEqual({ ok: false, error: '该 issue 仍关联执行现场或发布记录，不能直接删除；请先取消并保留历史记录' });
    expect(s.service.store.get(1, input.planId)!.issues).toHaveLength(2);
    expect(s.engine.store.get(id)).toBeDefined();
    expect(s.db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  test('preview does not create anything; import allocates keys and persists numbered dependencies', async () => {
    const s = await setup(); const input = await s.write();
    const preview = await s.service.view(1, s.owner.user.id);
    expect(preview.candidates[0]).toMatchObject({ error: null, execution: null });
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
    expect(s.schedules()).toBe(0);
    const result = await s.service.execute(1, s.owner.user.id, input);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.map(item => item.key)).toEqual(['1', '2']);
    expect(result.issues.every(item => item.issueId !== item.key)).toBe(true);
    const first = s.engine.store.get(result.issues[0].issueId)!;
    const second = s.engine.store.get(result.issues[1].issueId)!;
    expect(first).toMatchObject({ title: task.title, category: 'task', executionMode: 'direct', publicationLocked: true });
    expect(second).toMatchObject({ category: 'debug', executionMode: 'direct' });
    expect(first.body).toContain(task.body);
    expect(s.engine.store.listRunnableByProject(1).map(item => item.id)).toEqual([first.id]);
    s.db.query("UPDATE issues SET status='done' WHERE id=?").run(first.id);
    expect(s.engine.store.listRunnableByProject(1).map(item => item.id)).toContain(second.id);
    const drain = await s.service.stop(); await drain.done;
    expect(s.schedules()).toBe(1);
    expect(s.service.store.get(1, input.planId)!.effectsPending).toBe(false);
  });

  test('concurrent clicks and retry after the file disappears return the exact original batch', async () => {
    const s = await setup(); const input = await s.write();
    const results = await Promise.all(Array.from({ length: 3 }, () => s.service.execute(1, s.owner.user.id, input)));
    expect(new Set(results.map(result => result.issues[0].issueId)).size).toBe(1);
    expect(s.engine.store.listByProject(1)).toHaveLength(2);
    await fs.unlink(path.join(s.repo, input.path));
    const replay = await s.service.execute(1, s.owner.user.id, input);
    expect(replay.issues).toEqual(results[0].issues);
    const view = await s.service.view(1, s.owner.user.id);
    expect(view.executions[0].plan.issues).toHaveLength(2);
  });

  test('file changes and already-published edits cannot recreate or overwrite issues', async () => {
    const s = await setup(); const input = await s.write();
    await s.write(markdown([{ ...task, title: '变更后的标题' }]));
    await expect(s.service.execute(1, s.owner.user.id, input)).rejects.toMatchObject({ code: 'changed' });
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
    const fresh = await s.write(); const original = await s.service.execute(1, s.owner.user.id, fresh);
    const edited = await s.write(markdown([{ ...task, title: '发布后修改' }]));
    await expect(s.service.execute(1, s.owner.user.id, edited)).rejects.toMatchObject({ code: 'published' });
    expect(s.engine.store.get(original.issues[0].issueId)!.title).toBe(task.title);
  });

  test('explicit refresh bypasses a recent preview cache without allocating issue keys', async () => {
    const s = await setup(); await s.write();
    const before = await s.service.view(1, s.owner.user.id);
    await s.write(markdown([{ ...task, title: 'Updated draft' }]));
    const fresh = await s.service.view(1, s.owner.user.id, true);
    expect(fresh.candidates[0].digest).not.toBe(before.candidates[0].digest);
    expect(fresh.candidates[0].plan!.issues[0].title).toBe('Updated draft');
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
  });

  test('a draft deleted before execution is a definitive not-found result with no allocation', async () => {
    const s = await setup(); const input = await s.write();
    await fs.unlink(path.join(s.repo, input.path));
    await expect(s.service.execute(1, s.owner.user.id, input)).rejects.toMatchObject({ code: 'not_found' });
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
    expect(s.service.store.list(1)).toHaveLength(0);
  });

  test('linkage failures roll back the entire issue batch, events, dependencies and outbox', async () => {
    const s = await setup(); const input = await s.write();
    const record = s.service.store.record.bind(s.service.store);
    s.service.store.record = data => { record(data); throw new Error('storage rollback'); };
    await expect(s.service.execute(1, s.owner.user.id, input)).rejects.toThrow('storage rollback');
    for (const table of ['issues', 'issue_events', 'issue_dependencies', 'local_issue_plan_publications', 'local_issue_plan_items', 'local_issue_plan_effects']) {
      expect(s.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
    }
    expect(s.schedules()).toBe(0);
  });

  test('restart recovery retries a persisted scheduler intent without creating another batch', async () => {
    const s = await setup(); const input = await s.write(); s.failSchedule(true);
    await s.service.execute(1, s.owner.user.id, input);
    const drain = await s.service.stop(); await drain.done;
    expect(s.service.store.get(1, input.planId)!.effectsPending).toBe(true);
    const recovered = new LocalPlanService({ db: s.db, engine: s.engine, driverForProject: () => s.driver });
    s.failSchedule(false); await recovered.recover();
    const recoveredDrain = await recovered.stop(); await recoveredDrain.done;
    expect(recovered.store.get(1, input.planId)!.effectsPending).toBe(false);
    expect(s.engine.store.listByProject(1)).toHaveLength(2);
  });

  test('invalid and duplicate plans remain visible; symlinks and path traversal cannot be imported', async () => {
    const s = await setup(); const input = await s.write();
    await s.write(markdown(), 'duplicate.md');
    await s.write('# malformed', 'invalid.md');
    await s.write(markdown([{ ...task, module: 'missing-module' }]), 'missing.md');
    const view = await s.service.view(1, s.owner.user.id);
    expect(view.candidates.every(item => item.error !== null)).toBe(true);
    await expect(s.service.execute(1, s.owner.user.id, input)).rejects.toMatchObject({ code: 'invalid' });
    await expect(s.service.execute(1, s.owner.user.id, { ...input, path: '.panda/plans/../escape.md' })).rejects.toMatchObject({ code: 'invalid' });
    await fs.writeFile(path.join(s.dir, 'outside.md'), markdown());
    await fs.symlink(path.join(s.dir, 'outside.md'), path.join(s.repo, '.panda/plans/link.md'));
    await expect(s.service.execute(1, s.owner.user.id, { ...input, path: '.panda/plans/link.md' })).rejects.toThrow();
    expect(s.engine.store.listByProject(1)).toHaveLength(0);
  });

  test('HTTP routes deny strangers, allow members, and validate the exact preview digest', async () => {
    const s = await setup(); const input = await s.write();
    const call = async (method: string, token: string, body?: unknown) => s.dispatch(new Request(
      `http://test/api/projects/1/local-plans${method === 'POST' ? '/execute' : ''}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    ));
    expect((await call('GET', s.stranger.token))!.status).toBe(403);
    expect((await call('POST', s.stranger.token, input))!.status).toBe(403);
    expect((await call('GET', s.member.token))!.status).toBe(200);
    expect((await call('POST', s.member.token, { ...input, digest: 'bad' }))!.status).toBe(400);
    expect((await call('POST', s.member.token, input))!.status).toBe(200);
    expect(s.engine.store.listByProject(1)).toHaveLength(2);
  });

  test('manual review and design tasks stay planned; imported tasks respect module agents', async () => {
    const s = await setup();
    s.db.query(`INSERT INTO project_modules(project_id,slug,display_name,agent,source,status,sync_status,created_ts)
      VALUES(1,'existing','Existing','codex','manual','active','ready',0)`).run();
    s.db.query('UPDATE projects SET manual_review=1 WHERE id=1').run();
    const input = await s.write(markdown([{ ...task, module: 'existing' }, { ...task, category: 'design' }]));
    const result = await s.service.execute(1, s.owner.user.id, input);
    expect(s.engine.store.get(result.issues[0].issueId)).toMatchObject({ agent: 'codex', executionMode: 'planned' });
    expect(s.engine.store.get(result.issues[1].issueId)).toMatchObject({ category: 'design', executionMode: 'planned' });
  });

  test('built-in skill installs to both agents and offline validator shares actual parser behavior', async () => {
    const s = await setup();
    const homes = { claudeHome: path.join(s.dir, '.claude'), codexHome: path.join(s.dir, '.codex') };
    expect(await ensurePandaIssuePlanSkill(s.driver, homes)).toHaveLength(6);
    expect(await ensurePandaIssuePlanSkill(s.driver, homes)).toHaveLength(0);
    const input = await s.write();
    const validator = path.join(homes.codexHome, 'skills/panda-issue-plan/validate.mjs');
    const valid = Bun.spawnSync({ cmd: ['node', validator, path.join(s.repo, input.path)] });
    expect(valid.exitCode).toBe(0);
    expect(JSON.parse(valid.stdout.toString())).toMatchObject({ valid: true, tasks: 2 });
    await s.write(markdown([{ ...task, key: 'preallocated' }]));
    expect(Bun.spawnSync({ cmd: ['node', validator, path.join(s.repo, input.path)] }).exitCode).toBe(1);
    const skill = path.join(homes.claudeHome, 'skills/panda-issue-plan/SKILL.md');
    await fs.writeFile(skill, '# Manual instructions');
    expect(await ensurePandaIssuePlanSkill(s.driver, homes)).toHaveLength(0);
    expect(await fs.readFile(skill, 'utf8')).toBe('# Manual instructions');
  });
});

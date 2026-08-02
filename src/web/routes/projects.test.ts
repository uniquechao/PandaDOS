import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import { migrateIssueEngine } from '../../issues/engine';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { projectsRoutes, projectSlug } from './projects';

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const convs = {
    create: (projectId: number, label: string) => ({
      id: `conv-${projectId}`,
      projectId,
      label,
      createdTs: Date.now(),
      archived: false,
      agent: 'claude' as const,
      kind: 'issue' as const,
      lastActiveTs: null,
      autoApprove: 'cautious' as const,
    }),
  };
  // waiting_input 数据源：测试用集合模拟（生产 = 审批管道登记 ∪ 菜单滞留）
  const waitingSet = new Set<number>();
  const dispatch = createDispatcher(
    projectsRoutes({ db, convs, waitingIssueIds: () => waitingSet }),
    authDepsFromDb(db, users),
  );
  return { db, users, admin, alice, bob, dispatch, waitingSet };
}

function req(method: string, path: string, token?: string, body?: unknown): Request {
  return new Request(`http://t${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function j(r: Response | Promise<Response> | null): Promise<{ status: number; body: any }> {
  const resp = await r!;
  return { status: resp.status, body: await resp.json() };
}

describe('projects 路由', () => {
  test('未登录 401；建项目默认 cwd 落自己 workspace；属主隔离', async () => {
    const s = setup();
    expect((await j(s.dispatch(req('GET', '/api/projects')))).status).toBe(401);

    const created = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'My App', executorId: 1, goal: '目标' })),
    );
    expect(created.status).toBe(200);
    expect(created.body.project.ownerUserId).toBe(s.alice.user.id);
    expect(created.body.project.cwd).toBe(`/ws/u${s.alice.user.id}/My-App`);

    // 列表隔离：alice 见 1，bob 见 0，admin 全见
    expect((await j(s.dispatch(req('GET', '/api/projects', s.alice.token)))).body).toHaveLength(1);
    expect((await j(s.dispatch(req('GET', '/api/projects', s.bob.token)))).body).toHaveLength(0);
    expect((await j(s.dispatch(req('GET', '/api/projects', s.admin.token)))).body).toHaveLength(1);

    // 单项目：bob 403（不泄露存在性），alice/admin 200
    const pid = created.body.project.id;
    expect((await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.bob.token)))).status).toBe(403);
    expect((await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.alice.token)))).status).toBe(200);
    expect((await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.admin.token)))).status).toBe(200);
  });

  test('cwd 越界防护：普通用户锁自己 workspace；admin 任意；仅 admin 可代建归属', async () => {
    const s = setup();
    const out = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'x', executorId: 1, cwd: '/etc/evil' })),
    );
    expect(out.status).toBe(403);

    const rel = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'x', executorId: 1, cwd: 'rel/path' })),
    );
    expect(rel.status).toBe(400);

    const adm = await j(
      s.dispatch(
        req('POST', '/api/projects', s.admin.token, {
          name: 'ops',
          executorId: 1,
          cwd: '/opt/anywhere',
          ownerUserId: s.alice.user.id,
        }),
      ),
    );
    expect(adm.status).toBe(200);
    expect(adm.body.project.ownerUserId).toBe(s.alice.user.id);

    const notAdmin = await j(
      s.dispatch(
        req('POST', '/api/projects', s.alice.token, { name: 'y', executorId: 1, ownerUserId: s.bob.user.id }),
      ),
    );
    expect(notAdmin.status).toBe(403);

    const badExec = await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'z', executorId: 99 })));
    expect(badExec.status).toBe(400);
  });

  test('建项目可选带 cc 对话；PATCH 改 goal/pmPersona；DELETE=归档', async () => {
    const s = setup();
    const created = await j(
      s.dispatch(
        req('POST', '/api/projects', s.alice.token, { name: 'app', executorId: 1, withConversation: true }),
      ),
    );
    expect(created.body.conversation).toBeTruthy();
    const pid = created.body.project.id;

    const patched = await j(
      s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { goal: '新目标', pmPersona: '严谨' })),
    );
    expect(patched.status).toBe(200);
    expect(patched.body.project.goal).toBe('新目标');

    // manualReview 开关（008）：默认关闭（全自动流）；PATCH 布尔开/关
    expect(patched.body.project.manualReview).toBe(false);
    const mrOn = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { manualReview: true })));
    expect(mrOn.status).toBe(200);
    expect(mrOn.body.project.manualReview).toBe(true);
    const mrOff = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { manualReview: false })));
    expect(mrOff.body.project.manualReview).toBe(false);

    const del = await j(s.dispatch(req('DELETE', `/api/projects/${pid}`, s.alice.token)));
    expect(del.body.archived).toBe(true);
    const got = await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.alice.token)));
    expect(got.body.status).toBe('archived');
  });

  test('成员可读项目详情（project-access），但项目级管理（PATCH/DELETE）仍属主专属', async () => {
    const s = setup();
    const created = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'Shared', executorId: 1 })),
    );
    const pid = created.body.project.id as number;
    // 加入前 bob 无关 → 详情 403
    expect((await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.bob.token)))).status).toBe(403);
    // 关联 bob 为成员
    s.db
      .query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)')
      .run(pid, s.bob.user.id);
    // 成员可读详情（project-access）
    expect((await j(s.dispatch(req('GET', `/api/projects/${pid}`, s.bob.token)))).status).toBe(200);
    // 但项目级管理仍限属主/admin：成员 PATCH/DELETE → 403
    expect(
      (await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.bob.token, { goal: 'x' })))).status,
    ).toBe(403);
    expect((await j(s.dispatch(req('DELETE', `/api/projects/${pid}`, s.bob.token)))).status).toBe(403);
    // 属主仍可管理
    expect(
      (await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { goal: 'y' })))).status,
    ).toBe(200);
  });

  test('projectSlug 白名单', () => {
    expect(projectSlug('My App!')).toBe('My-App');
    expect(projectSlug('../..')).toBe('proj');
    expect(projectSlug('a b/c')).toBe('a-b-c');
  });

  test('runUser：admin 可设（建/改），普通用户 403，非法名 400', async () => {
    const s = setup();
    const adm = await j(
      s.dispatch(
        req('POST', '/api/projects', s.admin.token, { name: 'ops', executorId: 1, cwd: '/home/developer/ops', runUser: 'developer' }),
      ),
    );
    expect(adm.status).toBe(200);
    expect(adm.body.project.runUser).toBe('developer');

    const denied = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'x', executorId: 1, runUser: 'developer' })),
    );
    expect(denied.status).toBe(403);

    const bad = await j(
      s.dispatch(req('POST', '/api/projects', s.admin.token, { name: 'y', executorId: 1, runUser: 'a b;rm' })),
    );
    expect(bad.status).toBe(400);

    // PATCH 改/清
    const pid = adm.body.project.id;
    const patched = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.admin.token, { runUser: '' })));
    expect(patched.status).toBe(200);
    expect(patched.body.project.runUser).toBe('');
  });

  test('workBranch：建/改可设合法分支名，非法 400，空字符串清空', async () => {
    const s = setup();
    // 建项目带 workBranch
    const created = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'wb', executorId: 1, workBranch: 'developer/dev-20260709' })),
    );
    expect(created.status).toBe(200);
    expect(created.body.project.workBranch).toBe('developer/dev-20260709');
    const pid = created.body.project.id;

    // 非法分支名（以 - 开头，防被 git 当参数）→ 400
    const bad = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'bad', executorId: 1, workBranch: '-rf' })),
    );
    expect(bad.status).toBe(400);

    // PATCH 改
    const patched = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { workBranch: 'feature/x' })));
    expect(patched.status).toBe(200);
    expect(patched.body.project.workBranch).toBe('feature/x');

    // PATCH 空串清空 → 回默认（null）
    const cleared = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { workBranch: '' })));
    expect(cleared.status).toBe(200);
    expect(cleared.body.project.workBranch).toBeNull();
  });

  test('kind（009）：默认 issue；建可设 chat 且忽略 workBranch；非法 400；PATCH 可改', async () => {
    const s = setup();
    // 默认 issue
    const def = await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'k0', executorId: 1 })));
    expect(def.body.project.kind).toBe('issue');

    // 建 chat 项目：kind=chat，且 chat 忽略 work_branch（issue 专属项）
    const chat = await j(
      s.dispatch(
        req('POST', '/api/projects', s.alice.token, { name: 'k1', executorId: 1, kind: 'chat', workBranch: 'feature/x' }),
      ),
    );
    expect(chat.status).toBe(200);
    expect(chat.body.project.kind).toBe('chat');
    expect(chat.body.project.workBranch).toBeNull();

    // 非法 kind → 400
    const bad = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'k2', executorId: 1, kind: 'foo' })),
    );
    expect(bad.status).toBe(400);

    // PATCH 改回 issue
    const pid = chat.body.project.id;
    const patched = await j(s.dispatch(req('PATCH', `/api/projects/${pid}`, s.alice.token, { kind: 'issue' })));
    expect(patched.status).toBe(200);
    expect(patched.body.project.kind).toBe('issue');
  });
});

// ---------- 导入现有 tmux 会话 ----------

import type { TmuxSession } from '../../executor/driver';

function setupImport(sessions: TmuxSession[]) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const dispatch = createDispatcher(
    projectsRoutes({
      db,
      driverFor: () => ({
        listSessions: async () => sessions,
        readFileRange: async () => ({ data: new Uint8Array(), size: 0 }),
        statPath: async () => null,
        listDir: async () => [],
        mkdirp: async () => {},
        git: async () => ({ code: 0, out: '', err: '' }),
      }),
    }),
    authDepsFromDb(db, users),
  );
  return { db, admin, alice, dispatch };
}

describe('POST /api/projects/import', () => {
  const live: TmuxSession[] = [
    { name: 'sample-app', createdTs: 1, attached: false, command: 'claude', cwd: '/home/developer/sample-app' },
    { name: 'mine', createdTs: 2, attached: false, command: 'bash', cwd: '/ws/u2/mine' },
    { name: 'cc-1', createdTs: 3, attached: false, cwd: '/ws/u9/x' },
    { name: 'nocwd', createdTs: 4, attached: false },
  ];

  test('admin 导入任意会话：建项目 + sessions 登记；重复导入幂等返回既有项目', async () => {
    const s = setupImport(live);
    const r = await j(
      s.dispatch(req('POST', '/api/projects/import', s.admin.token, { executorId: 1, session: 'sample-app', runUser: 'developer' })),
    );
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(true);
    expect(r.body.project.name).toBe('sample-app');
    expect(r.body.project.cwd).toBe('/home/developer/sample-app');
    expect(r.body.project.runUser).toBe('developer');
    const reg = s.db
      .query<{ project_id: number; owner_user_id: number }, [string]>(
        'SELECT project_id, owner_user_id FROM sessions WHERE name = ?',
      )
      .get('sample-app');
    expect(reg?.project_id).toBe(r.body.project.id);

    // 幂等：再导一次 → created:false，同一项目
    const again = await j(
      s.dispatch(req('POST', '/api/projects/import', s.admin.token, { executorId: 1, session: 'sample-app' })),
    );
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.project.id).toBe(r.body.project.id);
  });

  test('同 cwd 已有活跃项目 → 并入不重建；普通用户只能导自己 workspace；托管/不存在会话拒绝', async () => {
    const s = setupImport(live);
    // 预置同 cwd 项目（alice 的）
    s.db.run(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('已有', 1, '/ws/u2/mine', 2, 0)`,
    );
    const merged = await j(
      s.dispatch(req('POST', '/api/projects/import', s.alice.token, { executorId: 1, session: 'mine' })),
    );
    expect(merged.status).toBe(200);
    expect(merged.body.created).toBe(false);
    expect(merged.body.project.name).toBe('已有');

    // 普通用户导 workspace 外 → 403
    const out = await j(
      s.dispatch(req('POST', '/api/projects/import', s.alice.token, { executorId: 1, session: 'sample-app' })),
    );
    expect(out.status).toBe(403);

    // 托管命名空间：项目 1 存在（上面 INSERT 的 id=1）→ 拒绝
    const managed = await j(
      s.dispatch(req('POST', '/api/projects/import', s.admin.token, { executorId: 1, session: 'cc-1' })),
    );
    expect(managed.status).toBe(400);

    // 执行机上没有的会话 → 404；拿不到 cwd → 502
    expect(
      (await j(s.dispatch(req('POST', '/api/projects/import', s.admin.token, { executorId: 1, session: 'ghost' })))).status,
    ).toBe(404);
    expect(
      (await j(s.dispatch(req('POST', '/api/projects/import', s.admin.token, { executorId: 1, session: 'nocwd' })))).status,
    ).toBe(502);
  });

  test('summary：按看板列聚合未完结 issue；属主隔离；不被 :projectId 路由吞掉', async () => {
    const s = setup();
    const pa = (
      await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'a-proj', executorId: 1 })))
    ).body.project;
    const pb = (
      await j(s.dispatch(req('POST', '/api/projects', s.bob.token, { name: 'b-proj', executorId: 1 })))
    ).body.project;
    const ins = s.db.prepare(
      `INSERT INTO issues (project_id, title, status, created_ts) VALUES (?, ?, ?, ?)`,
    );
    for (const st of ['pending', 'clarifying', 'implementing', 'testing', 'plan_review', 'blocked', 'done', 'cancelled']) {
      ins.run(pa.id, `i-${st}`, st, Date.now());
    }
    ins.run(pb.id, 'b-doing', 'merging', Date.now());

    // 未登录 401
    expect((await j(s.dispatch(req('GET', '/api/projects/summary')))).status).toBe(401);

    // alice：只见自己项目；done/cancelled 不计；clarifying 计入待确认（在等发起人回答）
    const a = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a.status).toBe(200);
    expect(a.body.projects[pa.id]).toEqual({ todo: 1, doing: 2, review: 2, blocked: 1 });
    expect(a.body.projects[pb.id]).toBeUndefined();

    // admin 全量可见
    const adm = await j(s.dispatch(req('GET', '/api/projects/summary', s.admin.token)));
    expect(adm.body.projects[pa.id].todo).toBe(1);
    expect(adm.body.projects[pb.id]).toEqual({ todo: 0, doing: 1, review: 0, blocked: 0 });

    // 没有 issue 的项目不出现在摘要里（前端按缺省 0 处理）
    const pc = (
      await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'c-empty', executorId: 1 })))
    ).body.project;
    const a2 = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a2.body.projects[pc.id]).toBeUndefined();

    // waiting_input（弹窗等人工）补进待确认角标：只认驱动中的 issue，pending 的残留不计
    const implId = (s.db.query(`SELECT id FROM issues WHERE title = 'i-implementing'`).get() as { id: number }).id;
    const pendId = (s.db.query(`SELECT id FROM issues WHERE title = 'i-pending'`).get() as { id: number }).id;
    s.waitingSet.add(implId);
    s.waitingSet.add(pendId);
    const a3 = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a3.body.projects[pa.id].review).toBe(3); // 2 + implementing 的 waiting；pending 不计
    s.waitingSet.clear();
    const a4 = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a4.body.projects[pa.id].review).toBe(2);
  });

  test('成员项目纳入可见性：list 与 summary 都把「作为成员参与」的项目算进来', async () => {
    const s = setup();
    const pa = (
      await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'shared', executorId: 1 })))
    ).body.project;
    s.db
      .query(`INSERT INTO issues (project_id, title, status, created_ts) VALUES (?, 'i1', 'pending', ?)`)
      .run(pa.id, Date.now());

    // 加入前：bob 列表 0、摘要不含该项目
    expect((await j(s.dispatch(req('GET', '/api/projects', s.bob.token)))).body).toHaveLength(0);
    const before = await j(s.dispatch(req('GET', '/api/projects/summary', s.bob.token)));
    expect(before.body.projects[pa.id]).toBeUndefined();

    // 关联 bob 为成员
    s.db
      .query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (?, ?, 0)')
      .run(pa.id, s.bob.user.id);

    // 加入后：bob 列表见该项目（且不重复），摘要含其未完结数
    const list = (await j(s.dispatch(req('GET', '/api/projects', s.bob.token)))).body;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(pa.id);
    const after = await j(s.dispatch(req('GET', '/api/projects/summary', s.bob.token)));
    expect(after.body.projects[pa.id]).toEqual({ todo: 1, doing: 0, review: 0, blocked: 0 });

    // 属主视角无回归：alice 仍恰好见 1 条（并集不产生重复行）
    expect((await j(s.dispatch(req('GET', '/api/projects', s.alice.token)))).body).toHaveLength(1);
  });

  test('summary：澄清待答(创建时/执行中)并入待确认，答复/超时后收起，去重且属主隔离', async () => {
    const s = setup();
    const pa = (
      await j(s.dispatch(req('POST', '/api/projects', s.alice.token, { name: 'a-clr', executorId: 1 })))
    ).body.project;
    const pb = (
      await j(s.dispatch(req('POST', '/api/projects', s.bob.token, { name: 'b-clr', executorId: 1 })))
    ).body.project;
    const ins = s.db.prepare(
      `INSERT INTO issues (project_id, title, status, created_ts) VALUES (?, ?, ?, ?)`,
    );
    // alice：pending 的「创建时澄清待答」；implementing 既 waiting 又澄清待答（验去重）；
    //        plan_review 且澄清待答（状态已计 review，不该再加）；done 且澄清待答（完结不计）。
    ins.run(pa.id, 'a-pend-clarify', 'pending', Date.now());
    ins.run(pa.id, 'a-impl-both', 'implementing', Date.now());
    ins.run(pa.id, 'a-planrev-clarify', 'plan_review', Date.now());
    ins.run(pa.id, 'a-done-clarify', 'done', Date.now());
    // bob：pending 澄清待答（alice 不可见、admin 可见）。
    ins.run(pb.id, 'b-pend-clarify', 'pending', Date.now());

    const idOf = (t: string): number =>
      (s.db.query(`SELECT id FROM issues WHERE title = ?`).get(t) as { id: number }).id;
    const ev = s.db.prepare(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)`);
    const ask = (id: number): void => {
      ev.run(id, 'clarify_questions', JSON.stringify({ questions: ['q?'], source: 'exec' }), Date.now());
    };
    for (const t of ['a-pend-clarify', 'a-impl-both', 'a-planrev-clarify', 'a-done-clarify', 'b-pend-clarify']) {
      ask(idOf(t));
    }

    // 基线（按状态）：todo=1(pending), doing=1(implementing), review=1(plan_review)。
    // 叠加：pending澄清 +1、impl(waiting∪澄清去重) +1 → review=3；todo/doing 不回扣（方案B）。
    s.waitingSet.add(idOf('a-impl-both'));
    const a = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a.body.projects[pa.id]).toEqual({ todo: 1, doing: 1, review: 3, blocked: 0 });
    // bob 的澄清 issue 对 alice 不可见
    expect(a.body.projects[pb.id]).toBeUndefined();

    // admin 可见 bob：pending 澄清 → review+1（todo 也 1）
    const adm = await j(s.dispatch(req('GET', '/api/projects/summary', s.admin.token)));
    expect(adm.body.projects[pb.id]).toEqual({ todo: 1, doing: 0, review: 1, blocked: 0 });

    // 回答 pending 那条 → 不再计入 review（todo 仍 1）；impl 仍在 waitingSet 故仍 +1
    ev.run(idOf('a-pend-clarify'), 'clarified', null, Date.now());
    const a2 = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a2.body.projects[pa.id]).toEqual({ todo: 1, doing: 1, review: 2, blocked: 0 });

    // 移出 waitingSet 再对 impl 打 clarify_timeout → 该条澄清也收起，只剩 plan_review 的状态 review
    s.waitingSet.clear();
    ev.run(idOf('a-impl-both'), 'clarify_timeout', null, Date.now());
    const a3 = await j(s.dispatch(req('GET', '/api/projects/summary', s.alice.token)));
    expect(a3.body.projects[pa.id]).toEqual({ todo: 1, doing: 1, review: 1, blocked: 0 });
  });

  test('未接 driverFor 的装配 → 503（离线/测试装配不炸）', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const admin = users.create('admin', 'admin');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
    );
    const dispatch = createDispatcher(projectsRoutes({ db }), authDepsFromDb(db, users));
    const r = await j(dispatch(req('POST', '/api/projects/import', admin.token, { executorId: 1, session: 'x' })));
    expect(r.status).toBe(503);
  });
});

// ---------- 从 git clone 新建 + runUser 家目录默认 cwd ----------

import { repoNameFromGitUrl } from './projects';

const CLONE_PASSWD = ['root:x:0:0::/root:/bin/bash', 'developer:x:1002:1002::/home/developer:/bin/bash'].join('\n');

/** 可控 driver：记录 git clone 调用；existingDirs 决定 statPath/listDir（模拟目标目录已存在/非空） */
function setupClone(opts: { existingDirs?: Record<string, string[]> } = {}) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const dirs = new Map<string, string[]>(Object.entries(opts.existingDirs ?? {}));
  const gitCalls: Array<{ cwd: string; args: string[] }> = [];
  const dispatch = createDispatcher(
    projectsRoutes({
      db,
      driverFor: () => ({
        listSessions: async () => [],
        readFileRange: async () => {
          const data = new TextEncoder().encode(CLONE_PASSWD);
          return { data, size: data.length };
        },
        statPath: async (p: string) =>
          dirs.has(p) ? { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 } : null,
        listDir: async (p: string) => (dirs.get(p) ?? []).map((n) => ({ name: n, type: 'dir' as const })),
        mkdirp: async () => {},
        git: async (cwd: string, args: string[]) => {
          gitCalls.push({ cwd, args });
          return { code: 0, out: '', err: '' };
        },
      }),
    }),
    authDepsFromDb(db, users),
  );
  return { db, admin, alice, dispatch, gitCalls };
}

describe('repoNameFromGitUrl', () => {
  test('从各种 URL 推导仓库名（去 .git，过 slug）', () => {
    expect(repoNameFromGitUrl('https://github.com/foo/bar.git')).toBe('bar');
    expect(repoNameFromGitUrl('git@github.com:foo/my-repo.git')).toBe('my-repo');
    expect(repoNameFromGitUrl('https://gitlab.com/a/b/c')).toBe('c');
    expect(repoNameFromGitUrl('ssh://git@h/x/y.git/')).toBe('y');
  });
});

describe('POST /api/projects：从 git clone 新建', () => {
  test('普通用户 clone 到默认 workspace：name 从 URL 推导；git clone 参数正确；cloned:true', async () => {
    const s = setupClone();
    const r = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { executorId: 1, gitUrl: 'https://github.com/foo/bar.git' })),
    );
    expect(r.status).toBe(200);
    expect(r.body.cloned).toBe(true);
    expect(r.body.project.name).toBe('bar');
    expect(r.body.project.cwd).toBe(`/ws/u${s.alice.user.id}/bar`);
    // git clone -- <url> <basename> 在父目录执行
    expect(s.gitCalls).toHaveLength(1);
    expect(s.gitCalls[0]!.cwd).toBe(`/ws/u${s.alice.user.id}`);
    expect(s.gitCalls[0]!.args).toEqual(['clone', '--', 'https://github.com/foo/bar.git', 'bar']);
  });

  test('非法 gitUrl → 400；目标目录已存在且非空 → 400；未接 driver → 503', async () => {
    const s = setupClone({ existingDirs: { [`/ws/u2/bar`]: ['README.md'] } });
    const bad = await j(
      s.dispatch(req('POST', '/api/projects', s.alice.token, { executorId: 1, gitUrl: 'file:///etc/passwd' })),
    );
    expect(bad.status).toBe(400);

    const nonEmpty = await j(
      s.dispatch(
        req('POST', '/api/projects', s.alice.token, {
          executorId: 1,
          gitUrl: 'https://github.com/foo/bar.git',
          cwd: '/ws/u2/bar',
        }),
      ),
    );
    expect(nonEmpty.status).toBe(400);
    expect(s.gitCalls).toHaveLength(0);

    // 未接 driverFor：clone 无法进行 → 503
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const alice = users.create('alice');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
    );
    const dispatch = createDispatcher(projectsRoutes({ db }), authDepsFromDb(db, users));
    const noDrv = await j(
      dispatch(req('POST', '/api/projects', alice.token, { executorId: 1, gitUrl: 'https://github.com/foo/bar.git' })),
    );
    expect(noDrv.status).toBe(503);
  });

  test('admin 选 runUser 且不填 cwd → cwd 落该用户家目录（读 /etc/passwd）', async () => {
    const s = setupClone();
    const r = await j(
      s.dispatch(
        req('POST', '/api/projects', s.admin.token, { name: 'ops', executorId: 1, runUser: 'developer' }),
      ),
    );
    expect(r.status).toBe(200);
    expect(r.body.project.cwd).toBe('/home/developer/ops');
    expect(r.body.project.runUser).toBe('developer');
  });
});

// ---------- 手动更新 README 简介 ----------

import { LlmNotConfiguredError, type LlmClient, type LlmResult } from '../../agents/llm';
import type { SummaryTarget } from '../../core/agent-summary';
import type { ReadmeDriver } from '../../core/readme-summary';
import type { AgentKind, Project } from '../../core/types';

/** 假编排：记录 start 调用；behavior='busy' 时回 busy（模拟已有任务在跑） */
function fakeOrch(behavior: 'ok' | 'busy' = 'ok') {
  const calls: Array<{ projectId: number; agent: AgentKind; target?: SummaryTarget }> = [];
  return {
    calls,
    start(project: Project, agent: AgentKind, target?: SummaryTarget) {
      calls.push({ projectId: project.id, agent, ...(target !== undefined ? { target } : {}) });
      return behavior === 'busy'
        ? ({ started: false, reason: 'busy' } as const)
        : ({ started: true } as const);
    },
  };
}

/** 只读 Driver 替身：readme=null 表示 cwd 下没有 README（listDir 空） */
function readmeDriver(readme: string | null): ReadmeDriver {
  const enc = new TextEncoder();
  const has = (p: string) => readme !== null && p.endsWith('/README.md');
  return {
    async listDir() {
      return readme === null ? [] : [{ name: 'README.md', type: 'file' as const }];
    },
    async statPath(p: string) {
      if (!has(p)) return null;
      return { size: enc.encode(readme!).length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
    },
    async readFileRange(p: string, offset: number, limit: number) {
      const d = enc.encode(has(p) ? readme! : '');
      return { data: d.slice(offset, offset + limit), size: d.length };
    },
  };
}

/** LLM 替身：按脚本回答或报错 */
function fakeLlm(reply: string | Error): LlmClient {
  return {
    async chat(): Promise<LlmResult> {
      if (reply instanceof Error) throw reply;
      return { content: reply, toolCalls: [], raw: { role: 'assistant', content: reply } };
    },
  };
}

function setupSummary(
  readme: string | null,
  llmReply: string | Error = '这是简介',
  summaryOrchestrator?: ReturnType<typeof fakeOrch>,
) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  const bob = users.create('bob');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const dispatch = createDispatcher(
    projectsRoutes({
      db,
      llm: fakeLlm(llmReply),
      driverForProject: () => readmeDriver(readme),
      ...(summaryOrchestrator ? { summaryOrchestrator } : {}),
    }),
    authDepsFromDb(db, users),
  );
  return { db, admin, alice, bob, dispatch };
}

describe('POST /api/projects/:projectId/readme-summary', () => {
  async function newProject(s: ReturnType<typeof setupSummary>, token: string): Promise<any> {
    return (await j(s.dispatch(req('POST', '/api/projects', token, { name: 'demo', executorId: 1 })))).body
      .project;
  }

  test('属主触发：读 README → 调 LLM 生成简介，落库并回显', async () => {
    const s = setupSummary('# Demo\n一个示例项目', 'LLM：这是 Demo 项目的简介。');
    const p = await newProject(s, s.alice.token);
    const r = await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.summary).toBe('LLM：这是 Demo 项目的简介。');
    expect(r.body.project.readmeSummary).toBe('LLM：这是 Demo 项目的简介。');
    // 落库
    const row = s.db
      .query<{ readme_summary: string | null }, [number]>(
        'SELECT readme_summary FROM projects WHERE id = ?',
      )
      .get(p.id);
    expect(row?.readme_summary).toBe('LLM：这是 Demo 项目的简介。');
  });

  test('无 README → 400（不动旧简介）', async () => {
    const s = setupSummary(null);
    const p = await newProject(s, s.alice.token);
    const r = await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token)));
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    const row = s.db
      .query<{ readme_summary: string | null }, [number]>(
        'SELECT readme_summary FROM projects WHERE id = ?',
      )
      .get(p.id);
    expect(row?.readme_summary).toBeNull();
  });

  test('权限：未登录 401，非属主 403，admin 可代触发 200', async () => {
    const s = setupSummary('# x');
    const p = await newProject(s, s.alice.token);
    expect((await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`)))).status).toBe(401);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.bob.token)))).status,
    ).toBe(403);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.admin.token)))).status,
    ).toBe(200);
  });

  test('LLM 失败 → 502（旧简介不动）', async () => {
    const s = setupSummary('# x', new Error('llm down'));
    const p = await newProject(s, s.alice.token);
    const r = await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token)));
    expect(r.status).toBe(502);
    expect(r.body.ok).toBe(false);
  });

  test('驱动大模型未配置 → 统一 503，不包装成普通生成失败', async () => {
    const s = setupSummary('# x', new LlmNotConfiguredError());
    const p = await newProject(s, s.alice.token);
    const r = await j(s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token)));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({
      ok: false,
      code: 'llm_not_configured',
      error: { code: 'legacy.error', details: '请联系管理员配置驱动大模型' },
    });
  });

  test('未接 llm/driver 的装配 → 503（离线/测试装配不炸）', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const alice = users.create('alice');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
    );
    const dispatch = createDispatcher(projectsRoutes({ db }), authDepsFromDb(db, users));
    const p = (await j(dispatch(req('POST', '/api/projects', alice.token, { name: 'demo', executorId: 1 }))))
      .body.project;
    const r = await j(dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, alice.token)));
    expect(r.status).toBe(503);
  });

  test('mode=llm 显式：等同默认（走驱动大模型同步路径）', async () => {
    const s = setupSummary('# Demo', '模型简介');
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'llm' })),
    );
    expect(r.status).toBe(200);
    expect(r.body.summary).toBe('模型简介');
  });

  test('非法 mode → 400', async () => {
    const s = setupSummary('# x');
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'gpt' })),
    );
    expect(r.status).toBe(400);
  });
});

describe('POST /api/projects/:projectId/readme-summary（claude/codex 后台任务）', () => {
  async function newProject(s: ReturnType<typeof setupSummary>, token: string): Promise<any> {
    return (await j(s.dispatch(req('POST', '/api/projects', token, { name: 'demo', executorId: 1 }))))
      .body.project;
  }

  test('mode=claude：启动后台任务，202 running，编排收到 (project, claude)', async () => {
    const orch = fakeOrch('ok');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'claude' })),
    );
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, status: 'running', mode: 'claude' });
    expect(orch.calls).toEqual([{ projectId: p.id, agent: 'claude' }]);
  });

  test('mode=codex：编排收到 codex', async () => {
    const orch = fakeOrch('ok');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'codex' })),
    );
    expect(r.status).toBe(202);
    expect(orch.calls[0]!.agent).toBe('codex');
  });

  test('执行机未启用 Codex 时总结与更新记忆均返回 409', async () => {
    const orch = fakeOrch('ok');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    s.db.run('UPDATE executors SET supports_codex = 0 WHERE id = 1');
    expect(
      (
        await j(
          s.dispatch(
            req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, {
              mode: 'codex',
            }),
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await j(
          s.dispatch(
            req('POST', `/api/projects/${p.id}/memory`, s.alice.token, { agent: 'codex' }),
          ),
        )
      ).status,
    ).toBe(409);
    expect(orch.calls).toEqual([]);
  });

  test('已有任务在跑 → 409', async () => {
    const orch = fakeOrch('busy');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'claude' })),
    );
    expect(r.status).toBe(409);
    expect(r.body.ok).toBe(false);
  });

  test('未接编排 + mode=claude → 503', async () => {
    const s = setupSummary('# x'); // 无 summaryOrchestrator
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/readme-summary`, s.alice.token, { mode: 'claude' })),
    );
    expect(r.status).toBe(503);
  });

  test('项目 GET 带 summaryStatus/understanding/understandingAgent 供轮询', async () => {
    const s = setupSummary('# x', '简介', fakeOrch('ok'));
    const p = await newProject(s, s.alice.token);
    const got = await j(s.dispatch(req('GET', `/api/projects/${p.id}`, s.alice.token)));
    expect(got.status).toBe(200);
    expect(got.body.summaryStatus).toBe('idle');
    expect(got.body).toHaveProperty('understanding', null);
    expect(got.body).toHaveProperty('understandingAgent', null);
  });
});

describe('POST /api/projects/:projectId/memory（更新记忆，异步单飞）', () => {
  async function newProject(s: ReturnType<typeof setupSummary>, token: string): Promise<any> {
    return (await j(s.dispatch(req('POST', '/api/projects', token, { name: 'demo', executorId: 1 }))))
      .body.project;
  }

  test('默认 agent=claude，target=memory，202 running；编排收到 (project, claude, memory)', async () => {
    const orch = fakeOrch('ok');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    const r = await j(s.dispatch(req('POST', `/api/projects/${p.id}/memory`, s.alice.token)));
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ ok: true, status: 'running', agent: 'claude' });
    expect(orch.calls).toEqual([{ projectId: p.id, agent: 'claude', target: 'memory' }]);
  });

  test('agent=codex 透传', async () => {
    const orch = fakeOrch('ok');
    const s = setupSummary('# x', '简介', orch);
    const p = await newProject(s, s.alice.token);
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${p.id}/memory`, s.alice.token, { agent: 'codex' })),
    );
    expect(r.status).toBe(202);
    expect(orch.calls[0]).toEqual({ projectId: p.id, agent: 'codex', target: 'memory' });
  });

  test('已有任务在跑 → 409；未接编排 → 503', async () => {
    const busy = setupSummary('# x', '简介', fakeOrch('busy'));
    const pb = await newProject(busy, busy.alice.token);
    expect((await j(busy.dispatch(req('POST', `/api/projects/${pb.id}/memory`, busy.alice.token)))).status).toBe(409);

    const noOrch = setupSummary('# x'); // 无 summaryOrchestrator
    const pn = await newProject(noOrch, noOrch.alice.token);
    expect((await j(noOrch.dispatch(req('POST', `/api/projects/${pn.id}/memory`, noOrch.alice.token)))).status).toBe(503);
  });

  test('鉴权：未登录 401 / 非属主 403', async () => {
    const s = setupSummary('# x', '简介', fakeOrch('ok'));
    const p = await newProject(s, s.alice.token);
    expect((await j(s.dispatch(req('POST', `/api/projects/${p.id}/memory`)))).status).toBe(401);
    expect((await j(s.dispatch(req('POST', `/api/projects/${p.id}/memory`, s.bob.token)))).status).toBe(403);
  });
});

// ---------- 成员管理 API（GET/POST/DELETE /api/projects/:projectId/members） ----------

describe('项目成员管理 API', () => {
  function setupMembers() {
    const db = openDb(':memory:');
    migrate(db);
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
    );
    const users = new UserStore(db);
    const admin = users.create('admin', 'admin');
    const alice = users.create('alice');
    const bob = users.create('bob');
    const carol = users.create('carol');
    // 项目 1 归 alice（created_ts=1000 便于断言属主行的 createdTs）
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, '/ws/p1', ?, 1000)`,
    ).run(alice.user.id);
    // notify 探针：记录自动订阅调用
    const subCalls: Array<{ projectId: number; userId: number }> = [];
    const notify = {
      ensureOwnerSubscription(projectId: number, userId: number) {
        subCalls.push({ projectId, userId });
        return {};
      },
    };
    const dispatch = createDispatcher(projectsRoutes({ db, notify }), authDepsFromDb(db, users));
    return { db, users, admin, alice, bob, carol, dispatch, subCalls, pid: 1 };
  }

  test('GET members：属主置顶 + 成员列表；project-access（成员可看，无关用户 403）', async () => {
    const s = setupMembers();
    // 初始只有属主
    const only = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.alice.token)));
    expect(only.status).toBe(200);
    expect(only.body.members).toHaveLength(1);
    expect(only.body.members[0]).toMatchObject({
      userId: s.alice.user.id,
      username: 'alice',
      role: 'owner',
      createdTs: 1000,
      lastLoginTs: null,
      issueTotal: 0,
      issueDone: 0,
    });
    // 发起本次请求即被认证链记「最后使用」（resolveUser→touchSeen），故非 null
    expect(only.body.members[0].lastSeenTs).toBeGreaterThan(0);
    // 未登录 401；无关 bob 403
    expect((await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`)))).status).toBe(401);
    expect((await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.bob.token)))).status).toBe(403);

    // 加 bob 后：bob 可看列表（project-access），列表 = 属主 + 成员
    await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));
    const withBob = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.bob.token)));
    expect(withBob.status).toBe(200);
    expect(withBob.body.members.map((m: any) => [m.username, m.role])).toEqual([
      ['alice', 'owner'],
      ['bob', 'member'],
    ]);
  });

  test('POST members：精确添加 + 自动订阅 + 幂等 + 错误分支 + 仅属主/admin', async () => {
    const s = setupMembers();
    // 缺 username 400；无此用户 400；加属主本人 400
    expect((await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, {})))).status).toBe(400);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'ghost' })))).status,
    ).toBe(400);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'alice' })))).status,
    ).toBe(400);

    // 加 bob → added:true + 自动订阅一次
    const add1 = await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));
    expect(add1.status).toBe(200);
    expect(add1.body.added).toBe(true);
    expect(add1.body.member).toMatchObject({ userId: s.bob.user.id, username: 'bob', role: 'member' });
    expect(s.subCalls).toEqual([{ projectId: s.pid, userId: s.bob.user.id }]);

    // 再加 bob → 幂等 added:false，不重复订阅
    const add2 = await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));
    expect(add2.body.added).toBe(false);
    expect(s.subCalls).toHaveLength(1);

    // 权限：非属主（carol）403；admin 可代管
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.carol.token, { username: 'carol' })))).status,
    ).toBe(403);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.admin.token, { username: 'carol' })))).status,
    ).toBe(200);
  });

  test('DELETE members：幂等移除 + 仅属主/admin + 非法 id', async () => {
    const s = setupMembers();
    await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));
    // 非法 userId → 400
    expect((await j(s.dispatch(req('DELETE', `/api/projects/${s.pid}/members/abc`, s.alice.token)))).status).toBe(400);
    // 权限：bob 虽是成员但非属主 → 403（DELETE 属项目级管理）
    expect(
      (await j(s.dispatch(req('DELETE', `/api/projects/${s.pid}/members/${s.bob.user.id}`, s.bob.token)))).status,
    ).toBe(403);
    // 属主移除 → removed:true；再删幂等 removed:false
    const d1 = await j(s.dispatch(req('DELETE', `/api/projects/${s.pid}/members/${s.bob.user.id}`, s.alice.token)));
    expect(d1.body).toEqual({ ok: true, removed: true });
    const d2 = await j(s.dispatch(req('DELETE', `/api/projects/${s.pid}/members/${s.bob.user.id}`, s.alice.token)));
    expect(d2.body.removed).toBe(false);
    // 移除后列表回到只有属主
    const list = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.alice.token)));
    expect(list.body.members).toHaveLength(1);
  });

  test('GET members：活跃时间与项目内 issue 统计（按 created_by 计总数/done 数）', async () => {
    const s = setupMembers();
    await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));
    // 项目内：alice 建 2 个（1 done），bob 建 1 个（pending），另有 created_by 为空的旧数据
    const ins = s.db.query(
      `INSERT INTO issues (project_id, title, status, created_by, created_ts) VALUES (?, ?, ?, ?, 0)`,
    );
    ins.run(s.pid, 'a1', 'done', s.alice.user.id);
    ins.run(s.pid, 'a2', 'pending', s.alice.user.id);
    ins.run(s.pid, 'b1', 'pending', s.bob.user.id);
    ins.run(s.pid, 'legacy', 'done', null);
    s.users.touchLogin(s.bob.user.id);

    const r = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.alice.token)));
    expect(r.status).toBe(200);
    const byName = new Map<string, any>(r.body.members.map((m: any) => [m.username, m]));
    expect(byName.get('alice')).toMatchObject({ issueTotal: 2, issueDone: 1 });
    expect(byName.get('bob')).toMatchObject({ issueTotal: 1, issueDone: 0, role: 'member' });
    expect(byName.get('bob').lastLoginTs).toBeGreaterThan(0);
    // bob 从没发过请求 → lastSeenTs 仍空；alice 发起本请求 → 已记
    expect(byName.get('bob').lastSeenTs).toBeNull();
    expect(byName.get('alice').lastSeenTs).toBeGreaterThan(0);
  });

  test('GET member-candidates：排除属主与已有成员，只回 id/username；仅属主/admin', async () => {
    const s = setupMembers();
    await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));

    const r = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/member-candidates`, s.alice.token)));
    expect(r.status).toBe(200);
    // 全部用户 - 属主 alice - 成员 bob = admin + carol（用户名升序），且只有 id/username 两个字段
    expect(r.body.candidates).toEqual([
      { id: s.admin.user.id, username: 'admin' },
      { id: s.carol.user.id, username: 'carol' },
    ]);

    // 成员 bob 是 project-access 不是 owner → 403；admin 恒过
    expect(
      (await j(s.dispatch(req('GET', `/api/projects/${s.pid}/member-candidates`, s.bob.token)))).status,
    ).toBe(403);
    expect(
      (await j(s.dispatch(req('GET', `/api/projects/${s.pid}/member-candidates`, s.admin.token)))).status,
    ).toBe(200);
  });

  test('POST transfer-owner：成员置换 + 目标须为成员 + 权限矩阵', async () => {
    const s = setupMembers();
    await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'bob' })));

    // 非法/缺 userId → 400；目标非成员（carol）→ 400；转给自己（属主不在成员表）→ 400
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.alice.token, {})))).status,
    ).toBe(400);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.alice.token, { userId: s.carol.user.id })))).status,
    ).toBe(400);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.alice.token, { userId: s.alice.user.id })))).status,
    ).toBe(400);
    // 成员 bob 自己无权转（project-owner 级）→ 403
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.bob.token, { userId: s.bob.user.id })))).status,
    ).toBe(403);

    // 属主 alice 转给成员 bob → 200；owner 换人、alice 降为成员、bob 移出成员表
    const r = await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.alice.token, { userId: s.bob.user.id })));
    expect(r.status).toBe(200);
    expect(r.body.project.ownerUserId).toBe(s.bob.user.id);
    const list = await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.bob.token)));
    expect(list.body.members.map((m: any) => [m.username, m.role])).toEqual([
      ['bob', 'owner'],
      ['alice', 'member'],
    ]);

    // 原属主 alice 只剩协作权：看得了列表（project-access）、管不了成员（project-owner）
    expect((await j(s.dispatch(req('GET', `/api/projects/${s.pid}/members`, s.alice.token)))).status).toBe(200);
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/members`, s.alice.token, { username: 'carol' })))).status,
    ).toBe(403);

    // admin 可代转：把项目再转回 alice（alice 已是成员）
    const back = await j(s.dispatch(req('POST', `/api/projects/${s.pid}/transfer-owner`, s.admin.token, { userId: s.alice.user.id })));
    expect(back.status).toBe(200);
    expect(back.body.project.ownerUserId).toBe(s.alice.user.id);
  });
});

// ---------- 迁移工程目录（POST /api/projects/:projectId/cwd-migrate，admin） ----------

describe('迁移工程目录 API', () => {
  function setupMigrate() {
    const db = openDb(':memory:');
    migrate(db);
    migrateIssueEngine(db); // project_active_conv(030) / project_modules(034)
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
    );
    const users = new UserStore(db);
    const admin = users.create('admin', 'admin');
    const alice = users.create('alice');
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p1', 1, '/ws/p1', ?, 0)`,
    ).run(alice.user.id);
    // 会话绑定现场：issue 会话（挂 active_conv）+ 模块会话绑定 + 本项目 chat 会话
    const insConv = db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, kind) VALUES (?, 1, 'c', 0, ?)`,
    );
    insConv.run('def', 'issue');
    insConv.run('mod1', 'issue');
    insConv.run('abc', 'chat');
    db.query(`INSERT INTO project_active_conv (project_id, conv_id, updated_ts) VALUES (1, 'def', 0)`).run();
    db.query(
      `INSERT INTO project_modules (project_id, slug, display_name, agent, source, conversation_id, created_ts)
       VALUES (1, 'core', '核心', 'claude', 'manual', 'mod1', 0)`,
    ).run();
    // 假执行机：existing 记录磁盘现状；killed/moved/mkdirs 记录动作
    const existing = new Set<string>(['/ws/p1']);
    const killed: string[] = [];
    const moved: Array<[string, string]> = [];
    const mkdirs: string[] = [];
    const driver = {
      listSessions: async () => ['cc-1', 'cc-1-m-core', 'cc-2', 'chat-abc', 'chat-zzz', 'other'].map((name) => ({ name })),
      killSession: async (name: string) => {
        killed.push(name);
      },
      statPath: async (p: string) => (existing.has(p) ? { size: 0 } : null),
      mkdirp: async (p: string) => {
        mkdirs.push(p);
      },
      movePath: async (src: string, dst: string) => {
        moved.push([src, dst]);
        existing.delete(src);
        existing.add(dst);
      },
    };
    const dispatch = createDispatcher(
      projectsRoutes({ db, fullDriverForProject: () => driver }),
      authDepsFromDb(db, users),
    );
    return { db, users, admin, alice, dispatch, existing, killed, moved, mkdirs, pid: 1 };
  }

  test('鉴权与校验矩阵：非 admin 403、相对/同址/嵌套/已存在 400、执行中 issue 409', async () => {
    const s = setupMigrate();
    const post = (token?: string, dest?: unknown) =>
      j(s.dispatch(req('POST', `/api/projects/${s.pid}/cwd-migrate`, token, { dest })));

    expect((await post(undefined, '/x')).status).toBe(401);
    expect((await post(s.alice.token, '/x')).status).toBe(403); // 属主也不行，admin 才能
    expect((await post(s.admin.token, 'rel/path')).status).toBe(400);
    expect((await post(s.admin.token, '/')).status).toBe(400);
    expect((await post(s.admin.token, '/ws/p1/')).status).toBe(400); // 规范化后同址
    expect((await post(s.admin.token, '/ws/p1/inner')).status).toBe(400); // 迁进自己
    expect((await post(s.admin.token, '/ws')).status).toBe(400); // 迁到自己的父目录
    s.existing.add('/data/taken');
    expect((await post(s.admin.token, '/data/taken')).status).toBe(400); // 目标已存在

    // 执行中 issue → 409；收尾后放行
    s.db.query(`INSERT INTO issues (project_id, title, status, created_ts) VALUES (1, 'busy', 'implementing', 0)`).run();
    expect((await post(s.admin.token, '/data/p1')).status).toBe(409);
    s.db.query(`UPDATE issues SET status = 'done'`).run();
    expect((await post(s.admin.token, '/data/p1')).status).toBe(200);
  });

  test('成功迁移：只杀本项目会话，mv 前建父目录，落库 cwd 并清空会话绑定', async () => {
    const s = setupMigrate();
    const r = await j(
      s.dispatch(req('POST', `/api/projects/${s.pid}/cwd-migrate`, s.admin.token, { dest: '/data/p1-new' })),
    );
    expect(r.status).toBe(200);
    expect(r.body.project.cwd).toBe('/data/p1-new');
    // cc-2（别的项目）/ chat-zzz（非本项目 chat）/ other 不动
    expect(r.body.killedSessions).toEqual(['cc-1', 'cc-1-m-core', 'chat-abc']);
    expect(s.killed).toEqual(['cc-1', 'cc-1-m-core', 'chat-abc']);
    expect(s.mkdirs).toEqual(['/data']);
    expect(s.moved).toEqual([['/ws/p1', '/data/p1-new']]);
    // 会话绑定清空：active_conv 行删除、模块 conversation_id 置空（对话记录本身保留）
    expect(s.db.query(`SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = 1`).get()).toEqual({ n: 0 });
    expect(s.db.query(`SELECT conversation_id FROM project_modules WHERE project_id = 1`).get()).toEqual({
      conversation_id: null,
    });
    expect(s.db.query(`SELECT COUNT(*) AS n FROM conversations`).get()).toEqual({ n: 3 });
  });

  test('当前目录不存在 → 400；未接 driver → 503', async () => {
    const s = setupMigrate();
    s.existing.delete('/ws/p1');
    expect(
      (await j(s.dispatch(req('POST', `/api/projects/${s.pid}/cwd-migrate`, s.admin.token, { dest: '/data/p1' })))).status,
    ).toBe(400);

    const bare = createDispatcher(projectsRoutes({ db: s.db }), authDepsFromDb(s.db, s.users));
    expect(
      (await j(bare(req('POST', `/api/projects/${s.pid}/cwd-migrate`, s.admin.token, { dest: '/data/p1' }))!)).status,
    ).toBe(503);
  });
});

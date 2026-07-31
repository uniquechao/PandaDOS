import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { COOKIE } from './auth';
import {
  authDepsFromDb,
  createDispatcher,
  matchPath,
  type AuthDeps,
  type RouteDef,
} from './middleware';

// ---------- 测试脚手架 ----------

function makeWorld() {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('root', 'admin');
  const alice = users.create('alice', 'user');
  const bob = users.create('bob', 'user');
  const carol = users.create('carol', 'user');
  // 项目归属：alice 拥有 project 1；carol 是其协作成员；bob 与该项目无关
  db.query(
    `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('e1', 'h', 'root', 'k', '/ws', '/c')`,
  ).run();
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
     VALUES ('p1', 1, '/ws/p1', ?, 0)`,
  ).run(alice.user.id);
  db.query(`INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 0)`).run(
    carol.user.id,
  );
  const deps = authDepsFromDb(db, users);
  return { db, users, deps, admin, alice, bob, carol };
}

function okHandler(tag: string): RouteDef['handler'] {
  return ({ user, params }) =>
    new Response(JSON.stringify({ tag, username: user?.username ?? null, params }), {
      status: 200,
    });
}

function get(dispatch: ReturnType<typeof createDispatcher>, path: string, token?: string) {
  const headers: Record<string, string> = token ? { cookie: `${COOKIE}=${token}` } : {};
  return dispatch(new Request(`http://x${path}`, { headers }));
}

// ---------- matchPath ----------

describe('matchPath', () => {
  test('静态段精确匹配；:param 捕获并解码', () => {
    expect(matchPath('/api/me', '/api/me')).toEqual({});
    expect(matchPath('/api/me', '/api/other')).toBeNull();
    expect(matchPath('/api/admin/users/:id/token', '/api/admin/users/12/token')).toEqual({ id: '12' });
    expect(matchPath('/api/x/:name', '/api/x/a%20b')).toEqual({ name: 'a b' });
    expect(matchPath('/api/x/:name', '/api/x')).toBeNull();
    expect(matchPath('/api/x', '/api/x/extra')).toBeNull();
  });
});

// ---------- 鉴权矩阵：4 级 × 命中/未命中 ----------

describe('鉴权中间件矩阵', () => {
  const { deps, admin, alice, bob, carol } = makeWorld();
  const defs: RouteDef[] = [
    { method: 'GET', path: '/t/public', auth: 'public', handler: okHandler('public') },
    { method: 'GET', path: '/t/user', auth: 'user', handler: okHandler('user') },
    { method: 'GET', path: '/t/admin', auth: 'admin', handler: okHandler('admin') },
    { method: 'GET', path: '/t/proj/:projectId', auth: 'project-owner', handler: okHandler('proj') },
    { method: 'GET', path: '/t/proj-q', auth: 'project-owner', handler: okHandler('proj-q') },
    { method: 'GET', path: '/t/acc/:projectId', auth: 'project-access', handler: okHandler('acc') },
    { method: 'GET', path: '/t/acc-q', auth: 'project-access', handler: okHandler('acc-q') },
  ];
  const dispatch = createDispatcher(defs, deps);

  test('public：匿名/登录都放行', async () => {
    expect((await get(dispatch, '/t/public'))!.status).toBe(200);
    expect((await get(dispatch, '/t/public', alice.token))!.status).toBe(200);
  });

  test('user：匿名 401、假 token 401、登录放行且 handler 拿到已解析 user', async () => {
    expect((await get(dispatch, '/t/user'))!.status).toBe(401);
    expect((await get(dispatch, '/t/user', 'ffff'))!.status).toBe(401);
    const r = await get(dispatch, '/t/user', alice.token);
    expect(r!.status).toBe(200);
    expect(((await r!.json()) as { username: string }).username).toBe('alice');
  });

  test('admin：普通用户 403、匿名 401、admin 放行', async () => {
    expect((await get(dispatch, '/t/admin', alice.token))!.status).toBe(403);
    expect((await get(dispatch, '/t/admin'))!.status).toBe(401);
    expect((await get(dispatch, '/t/admin', admin.token))!.status).toBe(200);
  });

  test('project-owner：属主放行、非属主 403、admin 恒过', async () => {
    expect((await get(dispatch, '/t/proj/1', alice.token))!.status).toBe(200);
    expect((await get(dispatch, '/t/proj/1', bob.token))!.status).toBe(403);
    expect((await get(dispatch, '/t/proj/1', admin.token))!.status).toBe(200);
  });

  test('project-owner：projectId 也可来自 query 参数', async () => {
    expect((await get(dispatch, '/t/proj-q?projectId=1', alice.token))!.status).toBe(200);
    expect((await get(dispatch, '/t/proj-q?projectId=1', bob.token))!.status).toBe(403);
  });

  test('project-owner：缺 projectId=400；未知项目普通用户 403（不泄露存在性）、admin 404', async () => {
    expect((await get(dispatch, '/t/proj-q', alice.token))!.status).toBe(400);
    expect((await get(dispatch, '/t/proj/abc', alice.token))!.status).toBe(400);
    expect((await get(dispatch, '/t/proj/999', bob.token))!.status).toBe(403);
    expect((await get(dispatch, '/t/proj/999', admin.token))!.status).toBe(404);
  });

  test('project-access：属主放行、成员放行、无关用户 403、admin 恒过', async () => {
    expect((await get(dispatch, '/t/acc/1', alice.token))!.status).toBe(200); // 属主
    expect((await get(dispatch, '/t/acc/1', carol.token))!.status).toBe(200); // 成员
    expect((await get(dispatch, '/t/acc/1', bob.token))!.status).toBe(403); // 无关用户
    expect((await get(dispatch, '/t/acc/1', admin.token))!.status).toBe(200); // admin 恒过
  });

  test('project-access：成员非属主也可（区别于 project-owner，属主专属面挡住成员）', async () => {
    // 同一 carol：协作面(project-access) 200，属主面(project-owner) 403
    expect((await get(dispatch, '/t/acc/1', carol.token))!.status).toBe(200);
    expect((await get(dispatch, '/t/proj/1', carol.token))!.status).toBe(403);
  });

  test('project-access：projectId 可来自 query；缺失 400；未知项目普通用户 403、admin 404', async () => {
    expect((await get(dispatch, '/t/acc-q?projectId=1', carol.token))!.status).toBe(200);
    expect((await get(dispatch, '/t/acc-q', carol.token))!.status).toBe(400);
    expect((await get(dispatch, '/t/acc/abc', carol.token))!.status).toBe(400);
    expect((await get(dispatch, '/t/acc/999', bob.token))!.status).toBe(403);
    expect((await get(dispatch, '/t/acc/999', admin.token))!.status).toBe(404);
  });

  test('默认 deny：未命中路由返回 null（调用方 404）；方法不匹配同理', async () => {
    expect(get(dispatch, '/t/nowhere', admin.token)).toBeNull();
    const post = dispatch(new Request('http://x/t/user', { method: 'POST' }));
    expect(post).toBeNull();
  });

  test('默认 deny：路由未声明 auth（JS 绕过类型）运行时 403', async () => {
    const bad = { method: 'GET', path: '/t/bad', handler: okHandler('bad') } as unknown as RouteDef;
    const d2 = createDispatcher([bad], deps);
    const r = await get(d2, '/t/bad', admin.token);
    expect(r!.status).toBe(403);
  });
});

// ---------- Bearer 也走同一鉴权 ----------

describe('Bearer 兼容', () => {
  test('Authorization: Bearer 与 cookie 等效', async () => {
    const { deps, alice } = makeWorld();
    const defs: RouteDef[] = [
      { method: 'GET', path: '/t/user', auth: 'user', handler: okHandler('user') },
    ];
    const dispatch = createDispatcher(defs, deps);
    const r = await dispatch(
      new Request('http://x/t/user', { headers: { authorization: `Bearer ${alice.token}` } }),
    );
    expect(r!.status).toBe(200);
  });
});

// ---------- 自定义 AuthDeps（无 DB 也能测） ----------

describe('AuthDeps 可注入', () => {
  test('getProjectOwner / hasProjectAccess 可替身', async () => {
    const { users, alice, bob } = makeWorld();
    const deps: AuthDeps = {
      users,
      getProjectOwner: (id) => (id === 5 ? alice.user.id : undefined),
      // 替身：项目 5 上，bob 视作成员放行（属主 alice 由 getProjectOwner 覆盖）
      hasProjectAccess: (id, uid) => id === 5 && (uid === alice.user.id || uid === bob.user.id),
    };
    const dispatch = createDispatcher(
      [
        { method: 'GET', path: '/t/proj/:projectId', auth: 'project-owner', handler: okHandler('p') },
        { method: 'GET', path: '/t/acc/:projectId', auth: 'project-access', handler: okHandler('a') },
      ],
      deps,
    );
    expect((await get(dispatch, '/t/proj/5', alice.token))!.status).toBe(200);
    expect((await get(dispatch, '/t/proj/5', bob.token))!.status).toBe(403); // 属主面挡住替身成员
    expect((await get(dispatch, '/t/acc/5', bob.token))!.status).toBe(200); // 协作面放行替身成员
  });
});

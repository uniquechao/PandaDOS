import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageCounter } from '../../core/activity';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { hashToken, UserStore, PERSONA_MAX_CHARS } from '../../core/users';
import { LocalDriver } from '../../executor/local';
import type { ExecutorDriver } from '../../executor/driver';
import { migrateIssueEngine } from '../../issues/engine';
import { migratePmAgent } from '../../agents/pm';
import { COOKIE } from '../auth';
import { authDepsFromDb, createDispatcher } from '../middleware';
import { adminRoutes } from './admin';
import { dayStartMs, weekWindowOf } from '../../core/usage-weekly';
import type { Executor } from '../../core/types';

function makeApp(driver: ExecutorDriver = new LocalDriver()) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  migratePmAgent(db);
  const users = new UserStore(db);
  const admin = users.create('root', 'admin');
  const executorChanges: number[] = []; // M5：PATCH/DELETE 执行机后的热失效回调记录
  const dispatch = createDispatcher(
    adminRoutes({
      db,
      users,
      driverFor: () => driver,
      onExecutorChanged: (id) => executorChanges.push(id),
    }),
    authDepsFromDb(db, users),
  );
  return { db, users, dispatch, admin, executorChanges };
}

function call(
  dispatch: ReturnType<typeof createDispatcher>,
  method: string,
  path: string,
  token: string,
  body?: unknown,
) {
  return dispatch(
    new Request(`http://x${path}`, {
      method,
      headers: {
        cookie: `${COOKIE}=${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const EXEC_BODY = {
  name: 'e1',
  host: '10.0.0.2',
  sshUser: 'root',
  keyRef: 'id_ed25519',
  workspaceRoot: '/root/user_space/users',
  claudeDir: '/root/.claude',
};

describe('admin 门槛', () => {
  test('普通用户 403、匿名 401（整个 /api/admin/* 面）', async () => {
    const { dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    expect((await call(dispatch, 'GET', '/api/admin/users', alice.token))!.status).toBe(403);
    expect((await dispatch(new Request('http://x/api/admin/users')))!.status).toBe(401);
    expect((await call(dispatch, 'GET', '/api/admin/users', admin.token))!.status).toBe(200);
  });
});

describe('驱动大模型配置', () => {
  test('GET/PUT 仅 admin；响应只含掩码，绝不回传 Key 明文', async () => {
    const { dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    expect((await call(dispatch, 'GET', '/api/admin/llm-config', alice.token))!.status).toBe(403);

    const put = await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
      baseUrl: ' https://llm.example/v1/ ',
      model: ' driver-model ',
      apiKey: 'secret-1234',
    });
    expect(put!.status).toBe(200);
    const saved = await put!.json();
    expect(saved).toEqual({
      ok: true,
      config: {
        baseUrl: 'https://llm.example/v1',
        model: 'driver-model',
        configured: true,
        apiKeyConfigured: true,
        apiKeyMasked: '••••1234',
      },
    });
    expect(JSON.stringify(saved)).not.toContain('secret-1234');

    const get = await call(dispatch, 'GET', '/api/admin/llm-config', admin.token);
    expect(await get!.json()).toEqual(saved.config);
  });

  test('Key 留空保留原值；clearApiKey 明确清除；冲突与非法地址拒绝', async () => {
    const { dispatch, admin } = makeApp();
    await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
      baseUrl: 'https://llm.example/v1',
      model: 'model-a',
      apiKey: 'keep-5678',
    });
    const retained = await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
      baseUrl: 'https://llm-2.example/v1',
      model: 'model-b',
      apiKey: '',
    });
    expect((await retained!.json()).config).toMatchObject({
      configured: true,
      apiKeyMasked: '••••5678',
    });

    expect(
      (
        await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
          baseUrl: 'ftp://bad.example',
          model: 'x',
        })
      )!.status,
    ).toBe(400);
    expect(
      (
        await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
          baseUrl: 'https://ok.example',
          model: 'x',
          apiKey: 'new-key',
          clearApiKey: true,
        })
      )!.status,
    ).toBe(400);

    const cleared = await call(dispatch, 'PUT', '/api/admin/llm-config', admin.token, {
      baseUrl: 'https://llm-2.example/v1',
      model: 'model-b',
      clearApiKey: true,
    });
    expect((await cleared!.json()).config).toMatchObject({
      configured: false,
      apiKeyConfigured: false,
      apiKeyMasked: null,
    });
  });
});

describe('用户 CRUD', () => {
  test('POST 建用户：回明文 token 一次，列表不含任何哈希/明文', async () => {
    const { dispatch, admin } = makeApp();
    const r = await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'alice' });
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as { user: { id: number; role: string }; token: string };
    expect(body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(body.user.role).toBe('user');

    const list = await call(dispatch, 'GET', '/api/admin/users', admin.token);
    const arr = (await list!.json()) as Record<string, unknown>[];
    expect(arr.length).toBe(2);
    for (const u of arr) {
      expect('tokenHash' in u).toBe(false);
      expect('token_hash' in u).toBe(false);
      expect('token' in u).toBe(false);
    }
  });

  test('非法用户名 / 重名 400', async () => {
    const { dispatch, admin } = makeApp();
    expect(
      (await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'a b!' }))!.status,
    ).toBe(400);
    await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'dup' });
    expect(
      (await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'dup' }))!.status,
    ).toBe(400);
  });

  test('建用户经 Driver 在执行机 workspace_root 下建出 u<id> 目录', async () => {
    const { db, dispatch, admin } = makeApp();
    const root = mkdtempSync(join(tmpdir(), 'panda-admin-ws-'));
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('e1', 'h', 'root', 'k', ?, '/c')`,
    ).run(root);

    const r = await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'ws1' });
    const body = (await r!.json()) as {
      user: { id: number };
      workspace: { provisioned: string[]; warnings: string[] };
    };
    expect(body.workspace.warnings).toEqual([]);
    expect(body.workspace.provisioned.length).toBe(1);
    expect(existsSync(join(root, `u${body.user.id}`))).toBe(true);
  });

  test('driver 不可用时不静默：warnings 可见、用户照建', async () => {
    const { db, users } = makeApp();
    const admin2 = users.byUsername('root')!;
    const adminTok = users.resetToken(admin2.id)!;
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('down', 'h', 'root', 'k', '/nope', '/c')`,
    ).run();
    const dispatch = createDispatcher(
      adminRoutes({ db, users, driverFor: () => null }),
      authDepsFromDb(db, users),
    );
    const r = await call(dispatch, 'POST', '/api/admin/users', adminTok, { username: 'w2' });
    const body = (await r!.json()) as { ok: boolean; workspace: { warnings: string[] } };
    expect(body.ok).toBe(true);
    expect(body.workspace.warnings.length).toBe(1);
    expect(body.workspace.warnings[0]).toContain('down');
  });

  test('PATCH 改名/改角色；最后一个 admin 不可降级；DELETE 不可删最后 admin', async () => {
    const { dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');

    const rn = await call(dispatch, 'PATCH', `/api/admin/users/${alice.user.id}`, admin.token, {
      username: 'alice2',
      role: 'admin',
    });
    expect(rn!.status).toBe(200);
    expect(users.byId(alice.user.id)?.username).toBe('alice2');
    expect(users.byId(alice.user.id)?.role).toBe('admin');

    // 降回去，root 再变最后一个 admin
    await call(dispatch, 'PATCH', `/api/admin/users/${alice.user.id}`, admin.token, { role: 'user' });
    const demote = await call(dispatch, 'PATCH', `/api/admin/users/${admin.user.id}`, admin.token, {
      role: 'user',
    });
    expect(demote!.status).toBe(400);
    const del = await call(dispatch, 'DELETE', `/api/admin/users/${admin.user.id}`, admin.token);
    expect(del!.status).toBe(400);

    // 普通用户可删
    const del2 = await call(dispatch, 'DELETE', `/api/admin/users/${alice.user.id}`, admin.token);
    expect(del2!.status).toBe(200);
    expect(users.byId(alice.user.id)).toBeUndefined();

    // 不存在 404
    expect((await call(dispatch, 'DELETE', '/api/admin/users/999', admin.token))!.status).toBe(404);
  });

  test('DELETE：名下有项目 → 400（先转移归属）', async () => {
    const { db, dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('e1', 'h', 'root', 'k', '/ws', '/c')`,
    ).run();
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p1', 1, '/ws/p1', ?, 0)`,
    ).run(alice.user.id);
    const r = await call(dispatch, 'DELETE', `/api/admin/users/${alice.user.id}`, admin.token);
    expect(r!.status).toBe(400);
    expect(users.byId(alice.user.id)).toBeDefined();
  });

  test('POST token 重置：回新明文一次、旧 token 作废、DB 只有新哈希', async () => {
    const { dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    const r = await call(dispatch, 'POST', `/api/admin/users/${alice.user.id}/token`, admin.token);
    expect(r!.status).toBe(200);
    const { token: fresh } = (await r!.json()) as { token: string };
    expect(fresh).toMatch(/^[0-9a-f]{48}$/);
    expect(users.byTokenHash(hashToken(alice.token))).toBeUndefined();
    expect(users.byTokenHash(hashToken(fresh))?.id).toBe(alice.user.id);
    expect(
      (await call(dispatch, 'POST', '/api/admin/users/999/token', admin.token))!.status,
    ).toBe(404);
  });
});

describe('用户列表活跃统计（issue #102）', () => {
  /** 建一条 issue（任务数按 created_by 归属；module 列有默认值） */
  function addIssue(db: ReturnType<typeof makeApp>['db'], createdBy: number | null, ts: number) {
    db.query('INSERT INTO issues (project_id, title, created_by, created_ts) VALUES (1, ?, ?, ?)').run(
      `i-${ts}-${createdBy ?? 0}`,
      createdBy,
      ts,
    );
  }

  test('lastSeenTs + 今天/总 任务数与消息数，按人归属；新用户全 0', async () => {
    const { db, dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/c')`,
    );
    db.query(
      "INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p', 1, '/ws/p', ?, ?)",
    ).run(alice.user.id, Date.now());

    const now = Date.now();
    const longAgo = now - 40 * 86_400_000; // 40 天前，铁定不是今天
    addIssue(db, alice.user.id, now);
    addIssue(db, alice.user.id, now);
    addIssue(db, alice.user.id, longAgo);
    addIssue(db, admin.user.id, now); // 别人的任务不算到 alice 头上
    addIssue(db, null, now); // 无归属的历史 issue 谁都不算

    const messages = new MessageCounter(db);
    messages.bump(alice.user.id);
    messages.bump(alice.user.id, longAgo);
    users.touchSeen(alice.user.id);

    const arr = (await (await call(dispatch, 'GET', '/api/admin/users', admin.token))!.json()) as Array<
      Record<string, unknown>
    >;
    const a = arr.find((u) => u.username === 'alice')!;
    expect(a.todayTasks).toBe(2);
    expect(a.totalTasks).toBe(3);
    expect(a.todayMessages).toBe(1);
    expect(a.totalMessages).toBe(2);
    expect(typeof a.lastSeenTs).toBe('number'); // 012 列已暴露给 UI
    const rootRow = arr.find((u) => u.username === 'root')!;
    expect(rootRow.todayTasks).toBe(1);
    expect(rootRow.totalMessages).toBe(0);

    // 新建用户：统计全 0、从未使用过
    await call(dispatch, 'POST', '/api/admin/users', admin.token, { username: 'bob' });
    const arr2 = (await (await call(dispatch, 'GET', '/api/admin/users', admin.token))!.json()) as Array<
      Record<string, unknown>
    >;
    const bob = arr2.find((u) => u.username === 'bob')!;
    expect(bob.todayTasks).toBe(0);
    expect(bob.totalTasks).toBe(0);
    expect(bob.todayMessages).toBe(0);
    expect(bob.totalMessages).toBe(0);
    expect(bob.lastSeenTs).toBeNull();
    expect(bob.lastLoginTs).toBeNull();
  });
});

describe('admin 代编每用户设定', () => {
  test('GET/PUT settings + 截断护栏走同一条路', async () => {
    const { dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    const put = await call(
      dispatch,
      'PUT',
      `/api/admin/users/${alice.user.id}/settings`,
      admin.token,
      { persona: 'x'.repeat(PERSONA_MAX_CHARS + 10), autopilotDefault: true },
    );
    expect(put!.status).toBe(200);
    const g = await call(dispatch, 'GET', `/api/admin/users/${alice.user.id}/settings`, admin.token);
    const s = (await g!.json()) as { persona: string; autopilotDefault: boolean };
    expect(s.persona.length).toBe(PERSONA_MAX_CHARS);
    expect(s.autopilotDefault).toBe(true);
    expect(
      (await call(dispatch, 'GET', '/api/admin/users/999/settings', admin.token))!.status,
    ).toBe(404);
  });
});

describe('执行机 CRUD', () => {
  test('未保存的远程执行机可用草稿连接检测能力和浏览目录，且不写入 executors', async () => {
    class PreviewDriver extends LocalDriver {
      override async readFileRange(path: string): Promise<{ data: Uint8Array; size: number }> {
        const text =
          path === '/etc/passwd'
            ? 'developer:x:1000:1000::/Users/developer:/bin/zsh\n'
            : '';
        const data = new TextEncoder().encode(text);
        return { data, size: data.length };
      }
      override async findExecutable(agent: 'claude' | 'codex'): Promise<string | null> {
        return `/opt/homebrew/bin/${agent}`;
      }
      override async statPath(path: string) {
        return [
          '/Users/developer/workspace',
          '/Users/developer/.claude/projects',
          '/Users/developer/.codex/sessions',
        ].includes(path)
          ? { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 }
          : null;
      }
      override async listDir() {
        return [
          { name: 'beta', type: 'dir' as const },
          { name: 'alpha', type: 'dir' as const },
          { name: 'note.txt', type: 'file' as const },
        ];
      }
    }

    const app = makeApp();
    const seen: Executor[] = [];
    const preview = new PreviewDriver();
    const dispatch = createDispatcher(
      adminRoutes({
        db: app.db,
        users: app.users,
        driverFor: () => preview,
        previewDriverFor: (draft: Executor) => {
          seen.push(draft);
          return preview;
        },
      } as any),
      authDepsFromDb(app.db, app.users),
    );
    const connection = {
      name: 'build-host',
      host: 'build.example.com',
      port: 22,
      sshUser: 'developer',
      keyRef: '/Users/example/.ssh/id_ed25519',
    };

    const detected = await call(
      dispatch,
      'POST',
      '/api/admin/executors/preview/detect',
      app.admin.token,
      connection,
    );
    expect(detected?.status).toBe(200);
    expect(((await detected!.json()) as any).detection.workspaceSuggestion).toBe(
      '/Users/developer/workspace',
    );

    const browsed = await call(
      dispatch,
      'POST',
      '/api/admin/executors/preview/fs',
      app.admin.token,
      { ...connection, path: '/Users/developer/workspace' },
    );
    expect(browsed?.status).toBe(200);
    expect(((await browsed!.json()) as any).dirs).toEqual(['alpha', 'beta']);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject(connection);
    expect(app.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM executors').get()?.n).toBe(0);
  });

  test('能力保存要求至少一个 Agent 与绝对目录；取消能力受活跃引用保护', async () => {
    const { dispatch, admin, db, users } = makeApp();
    expect(
      (
        await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
          name: 'codex-only',
          workspaceRoot: '/Users/me/workspace',
          supportsClaude: false,
          supportsCodex: true,
          codexDir: '/Users/me/.codex/sessions',
          capabilitiesCheckedTs: 99,
        })
      )!.status,
    ).toBe(200);
    expect(
      (
        await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
          name: 'none',
          workspaceRoot: '/Users/me/workspace',
          supportsClaude: false,
          supportsCodex: false,
        })
      )!.status,
    ).toBe(400);

    const owner = users.create('owner', 'user');
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p', 1, '/Users/me/workspace/p', ?, 0)`,
    ).run(owner.user.id);
    db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES ('c', 1, 'C', 0, 'codex', 'chat')`,
    ).run();
    const blocked = await call(dispatch, 'PATCH', '/api/admin/executors/1', admin.token, {
      supportsCodex: false,
      claudeDir: '/Users/me/.claude/projects',
      supportsClaude: true,
    });
    expect(blocked!.status).toBe(409);
    expect((await blocked!.json()).references.conversations).toBe(1);
    db.query('UPDATE conversations SET archived = 1 WHERE id = ?').run('c');
    expect(
      (
        await call(dispatch, 'PATCH', '/api/admin/executors/1', admin.token, {
          supportsCodex: false,
          claudeDir: '/Users/me/.claude/projects',
          supportsClaude: true,
        })
      )!.status,
    ).toBe(200);
  });

  test('detect 只读返回 macOS/远程 Home 与 Agent 建议，连接失败 502', async () => {
    class DetectDriver extends LocalDriver {
      override async findExecutable(agent: 'claude' | 'codex') {
        return agent === 'codex' ? '/opt/homebrew/bin/codex' : null;
      }
      override async readFileRange() {
        const data = new TextEncoder().encode('root:x:0:0:root:/root:/bin/sh\n');
        return { data, size: data.length };
      }
      override async statPath(p: string) {
        if (p === '/root/.claude/projects') {
          return { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 };
        }
        return null;
      }
    }
    const { dispatch, admin, db } = makeApp(new DetectDriver());
    db.query(
      `INSERT INTO executors
         (name, host, ssh_user, key_ref, workspace_root, claude_dir, codex_dir)
       VALUES ('remote', '10.0.0.2', 'root', 'k', '/custom/ws', '/custom/c', '/custom/x')`,
    ).run();
    const r = await call(dispatch, 'POST', '/api/admin/executors/1/detect', admin.token, {
      workspaceRoot: '/form/ws',
      claudeDir: '/form/claude',
      codexDir: '/form/codex',
    });
    expect(r!.status).toBe(200);
    const body = (await r!.json()) as any;
    expect(body.detection.homeDir).toBe('/root');
    expect(body.detection.current).toEqual({
      workspaceRoot: '/form/ws',
      claudeDir: '/form/claude',
      codexDir: '/form/codex',
    });
    expect(body.detection.agents.codex.commandFound).toBe(true);
    expect(body.detection.agents.claude.stateDirFound).toBe(true);
    expect(
      (await call(dispatch, 'POST', '/api/admin/executors/1/detect', admin.token, {
        codexDir: 'relative',
      }))!.status,
    ).toBe(400);

    const unavailable = makeApp();
    unavailable.db.query(
      `INSERT INTO executors
         (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('remote', '10.0.0.2', 'root', 'k', '/w', '/c')`,
    ).run();
    const noDriverRoutes = createDispatcher(
      adminRoutes({ db: unavailable.db, users: unavailable.users, driverFor: () => null }),
      authDepsFromDb(unavailable.db, unavailable.users),
    );
    expect(
      (await call(noDriverRoutes, 'POST', '/api/admin/executors/1/detect', unavailable.admin.token))!
        .status,
    ).toBe(502);
  });

  test('系统本机执行机不能删除或改成远程连接', async () => {
    const { dispatch, admin, db } = makeApp();
    db.query(
      `INSERT INTO executors
         (name, host, ssh_user, key_ref, workspace_root, claude_dir, is_system_local)
       VALUES ('local', '127.0.0.1', '', '', '/w', '/c', 1)`,
    ).run();
    expect(
      (await call(dispatch, 'PATCH', '/api/admin/executors/1', admin.token, { host: '10.0.0.2' }))!
        .status,
    ).toBe(409);
    expect((await call(dispatch, 'DELETE', '/api/admin/executors/1', admin.token))!.status).toBe(409);
  });

  test('POST/GET/PATCH/DELETE 全链；PATCH/DELETE 触发 onExecutorChanged（M5 热失效）', async () => {
    const { dispatch, admin, executorChanges } = makeApp();
    const c = await call(dispatch, 'POST', '/api/admin/executors', admin.token, EXEC_BODY);
    expect(c!.status).toBe(200);
    const { executor } = (await c!.json()) as { executor: { id: number; port: number } };
    expect(executor.port).toBe(22); // 缺省 22
    expect(executorChanges).toEqual([]); // 新建懒建即可见，无需失效回调

    const list = await call(dispatch, 'GET', '/api/admin/executors', admin.token);
    expect(((await list!.json()) as unknown[]).length).toBe(1);

    const up = await call(dispatch, 'PATCH', `/api/admin/executors/${executor.id}`, admin.token, {
      host: '10.0.0.9',
      port: 2222,
    });
    expect(up!.status).toBe(200);
    const upd = (await up!.json()) as { executor: { host: string; port: number } };
    expect(upd.executor.host).toBe('10.0.0.9');
    expect(upd.executor.port).toBe(2222);
    expect(executorChanges).toEqual([executor.id]); // M5：连接参数变更 → 失效池内旧 Driver

    const del = await call(dispatch, 'DELETE', `/api/admin/executors/${executor.id}`, admin.token);
    expect(del!.status).toBe(200);
    const list2 = await call(dispatch, 'GET', '/api/admin/executors', admin.token);
    expect(((await list2!.json()) as unknown[]).length).toBe(0);
    expect(executorChanges).toEqual([executor.id, executor.id]); // 删除同样逐出
  });

  test('本机执行机：host 不填默认本机；host=127.0.0.1/localhost 时 sshUser/keyRef 可省', async () => {
    const { dispatch, admin } = makeApp();
    // host 省略 → 默认 127.0.0.1（本机），sshUser/keyRef 同步可省
    const c0 = await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
      name: 'local-0',
      workspaceRoot: '/root/user_space/users',
      claudeDir: '/root/.claude/projects',
    });
    expect(c0!.status).toBe(200);
    const d0 = (await c0!.json()) as { executor: { host: string; sshUser: string; keyRef: string } };
    expect(d0.executor.host).toBe('127.0.0.1');
    expect(d0.executor.keyRef).toBe('');
    const c = await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
      name: 'local-1',
      host: '127.0.0.1',
      workspaceRoot: '/root/user_space/users',
      claudeDir: '/root/.claude/projects',
    });
    expect(c!.status).toBe(200);
    const { executor } = (await c!.json()) as { executor: { sshUser: string; keyRef: string } };
    expect(executor.keyRef).toBe(''); // 空 keyRef → server buildDriver 判 LocalDriver
    expect(executor.sshUser).toBe('');
    // 非本机 host 仍必须给 sshUser/keyRef
    const bad = await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
      name: 'remote-1',
      host: '10.0.0.2',
      workspaceRoot: '/root/user_space/users',
      claudeDir: '/root/.claude/projects',
    });
    expect(bad!.status).toBe(400);
  });

  test('缺字段 / 非法 port 400；不存在 404', async () => {
    const { dispatch, admin } = makeApp();
    expect(
      (await call(dispatch, 'POST', '/api/admin/executors', admin.token, { name: 'x' }))!.status,
    ).toBe(400);
    expect(
      (
        await call(dispatch, 'POST', '/api/admin/executors', admin.token, {
          ...EXEC_BODY,
          port: 99999,
        })
      )!.status,
    ).toBe(400);
    expect(
      (await call(dispatch, 'PATCH', '/api/admin/executors/9', admin.token, { host: 'h' }))!.status,
    ).toBe(404);
    expect((await call(dispatch, 'DELETE', '/api/admin/executors/9', admin.token))!.status).toBe(404);
  });

  test('有项目引用时 DELETE → 400', async () => {
    const { db, dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    const c = await call(dispatch, 'POST', '/api/admin/executors', admin.token, EXEC_BODY);
    const { executor } = (await c!.json()) as { executor: { id: number } };
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p1', ?, '/ws/p1', ?, 0)`,
    ).run(executor.id, alice.user.id);
    const del = await call(dispatch, 'DELETE', `/api/admin/executors/${executor.id}`, admin.token);
    expect(del!.status).toBe(400);
  });
});

describe('项目归属调整 + 活跃概览', () => {
  test('PUT /api/admin/projects/:id/owner 改属主；概览统计 last_login + 项目数', async () => {
    const { db, dispatch, users, admin } = makeApp();
    const alice = users.create('alice', 'user');
    const bob = users.create('bob', 'user');
    users.touchLogin(alice.user.id);
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('e1', 'h', 'root', 'k', '/ws', '/c')`,
    ).run();
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('p1', 1, '/ws/p1', ?, 0)`,
    ).run(alice.user.id);

    // 归属 alice → bob
    const put = await call(dispatch, 'PUT', '/api/admin/projects/1/owner', admin.token, {
      userId: bob.user.id,
    });
    expect(put!.status).toBe(200);
    const owner = db
      .query<{ owner_user_id: number }, []>('SELECT owner_user_id FROM projects WHERE id = 1')
      .get();
    expect(owner?.owner_user_id).toBe(bob.user.id);

    // 无此项目 404 / 无此用户 400
    expect(
      (await call(dispatch, 'PUT', '/api/admin/projects/99/owner', admin.token, { userId: 1 }))!
        .status,
    ).toBe(404);
    expect(
      (await call(dispatch, 'PUT', '/api/admin/projects/1/owner', admin.token, { userId: 999 }))!
        .status,
    ).toBe(400);

    // 概览
    const ov = await call(dispatch, 'GET', '/api/admin/overview', admin.token);
    const { users: rows } = (await ov!.json()) as {
      users: { username: string; lastLoginTs: number | null; projectCount: number }[];
    };
    const byName = Object.fromEntries(rows.map((r) => [r.username, r]));
    expect(byName.alice!.lastLoginTs).toBeGreaterThan(0);
    expect(byName.alice!.projectCount).toBe(0);
    expect(byName.bob!.projectCount).toBe(1);
    expect(byName.root!.projectCount).toBe(0);
  });
});

describe('用量周度视图（#295）', () => {
  /** 2026-09-07 是周一 */
  const MON = '2026-09-07';
  const at = (day: string, hour = 10): number => dayStartMs(day) + hour * 3_600_000;

  /**
   * 造一周的现场：两个模块 + 一条未归模块的 issue + 未归因用量 + 各类结局事件。
   * 钱都用整百万 token，方便按默认单价（input 1.25 / output 10 每 M）心算。
   */
  function seedWeek(db: ReturnType<typeof openDb>) {
    db.run(`INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/ws', '/c')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, '项目甲', 1, '/ws/a', 1, 1), (2, '项目乙', 1, '/ws/b', 1, 1)`);
    db.run(`INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_ts)
      VALUES (5, 1, 'issue-engine', 'issue 引擎与调度', 'claude', 'manual', 1),
             (6, 1, 'web-ui', '前端', 'codex', 'manual', 1)`);
    db.run(`INSERT INTO issues (id, project_id, title, module_id, status, created_ts)
      VALUES (10, 1, '引擎甲', 5, 'done', 1), (11, 1, '引擎乙', 5, 'blocked', 1),
             (12, 1, '前端甲', 6, 'done', 1), (13, 1, '没归模块', NULL, 'done', 1),
             (20, 2, '别的项目', NULL, 'done', 1)`);
    const daily = (day: string, projectId: number, issueId: number, out: number, input = 0) =>
      db.run(`INSERT INTO usage_daily (day, project_id, issue_id, output_tokens, input_tokens, updated_ts)
        VALUES (?, ?, ?, ?, ?, 1)`, [day, projectId, issueId, out, input]);
    daily(MON, 1, 10, 1_000_000);            // 引擎模块：$10
    daily('2026-09-09', 1, 11, 0, 2_000_000); // 引擎模块：$2.5
    daily('2026-09-09', 1, 12, 100_000);      // 前端模块：$1
    daily('2026-09-09', 1, 13, 50_000);       // 未归模块：$0.5
    daily('2026-09-09', 1, 0, 20_000);        // 未归因：$0.2
    daily('2026-09-09', 2, 20, 10_000);       // 别的项目：$0.1
    daily('2026-09-21', 1, 10, 9_000_000);    // 下下周，不该进本周
    const trans = (issueId: number, to: string, ts: number) =>
      db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, 'transition', ?, ?)`,
        [issueId, JSON.stringify({ event: 'x', from: 'implementing', to }), ts]);
    trans(10, 'done', at(MON));                 // 引擎：完成 1
    trans(11, 'blocked', at('2026-09-09'));     // 引擎：受阻 1，没救回来
    trans(12, 'blocked', at('2026-09-08'));     // 前端：受阻后本周救回
    trans(12, 'done', at('2026-09-10'));
    trans(13, 'cancelled', at('2026-09-09'));   // 未归模块：取消
    trans(20, 'done', at('2026-09-09'));        // 别的项目
  }

  interface WeeklyBody {
    week: { start: string; end: string; days: string[]; fromMs: number; toMs: number };
    pricing: { outputPerMTok: number };
    days: Array<{ day: string; costUsd: number; usage: { outputTokens: number } }>;
    modules: Array<{
      projectId: number; projectName: string; moduleId: number; moduleSlug: string; moduleName: string;
      costUsd: number; usage: { outputTokens: number };
      outcomes: null | {
        doneCount: number; blockedCount: number; cancelledCount: number; failedCount: number;
        outcomeCount: number; failureRate: number; recoveredCount: number; recoveryRate: number;
      };
    }>;
    totals: { costUsd: number; doneCount: number; failedCount: number; failureRate: number; recoveryRate: number };
  }

  const money = (n: number): number => Number(n.toFixed(2));

  test('按模块并排给钱与四项可靠性指标；未归模块与未归因各自成桶', async () => {
    const { db, dispatch, admin } = makeApp();
    seedWeek(db);
    const r = (await call(dispatch, 'GET', `/api/admin/usage/weekly?weekStart=${MON}`, admin.token))!;
    expect(r.status).toBe(200);
    const body = await r.json() as WeeklyBody;

    expect(body.week).toMatchObject({ start: MON, end: '2026-09-13' });
    expect(body.week.days).toHaveLength(7);

    // 按天分桶：周一 $10、周三 2.5+1+0.5+0.2+0.1、其余为 0（缺的天补零，空着才看得出没干活）
    expect(body.days.map((d) => money(d.costUsd))).toEqual([10, 0, 4.3, 0, 0, 0, 0]);

    // 哨兵桶（0 未归模块 / -1 未归因）按项目分开，所以键要带上 projectId
    const byModule = new Map(body.modules.map((m) => [`${m.projectId}:${m.moduleId}`, m]));
    // 引擎模块：$12.5，完成 1 / 受阻 1 → 失败率 0.5、恢复率 0
    expect(byModule.get('1:5')).toMatchObject({
      projectName: '项目甲', moduleSlug: 'issue-engine', moduleName: 'issue 引擎与调度',
    });
    expect(money(byModule.get('1:5')!.costUsd)).toBe(12.5);
    expect(byModule.get('1:5')!.outcomes).toMatchObject({
      doneCount: 1, blockedCount: 1, failedCount: 1, outcomeCount: 2, failureRate: 0.5, recoveredCount: 0,
    });
    // 前端模块：本周受阻又救回 → 失败率 1（同一条只算一次）、恢复率 1
    expect(byModule.get('1:6')!.outcomes).toMatchObject({
      doneCount: 1, blockedCount: 1, outcomeCount: 1, failureRate: 1, recoveredCount: 1, recoveryRate: 1,
    });
    // 未归模块（0 桶）：取消算失败
    expect(byModule.get('1:0')!.outcomes).toMatchObject({ cancelledCount: 1, failedCount: 1, failureRate: 1 });
    // 未归因（-1 桶）：只有钱，没有结局指标——不许编一个 0/0 冒充健康
    expect(byModule.get('1:-1')).toMatchObject({ outcomes: null });
    expect(money(byModule.get('1:-1')!.costUsd)).toBe(0.2);
    // 按成本降序
    expect(body.modules.map((m) => m.moduleId)[0]).toBe(5);

    expect(money(body.totals.costUsd)).toBe(14.3);
    expect(body.totals).toMatchObject({ doneCount: 3, failedCount: 3 });
    expect(body.totals.failureRate).toBeCloseTo(3 / 5, 10);
  });

  test('weekStart 收周内任意一天并归一到周一；不传 = 现在所在那一周', async () => {
    const { db, dispatch, admin } = makeApp();
    seedWeek(db);
    const thu = await (await call(dispatch, 'GET', '/api/admin/usage/weekly?weekStart=2026-09-10', admin.token))!
      .json() as WeeklyBody;
    expect(thu.week.start).toBe(MON);
    expect(money(thu.totals.costUsd)).toBe(14.3);

    const now = await (await call(dispatch, 'GET', '/api/admin/usage/weekly', admin.token))!.json() as WeeklyBody;
    expect(now.week.start).toBe(weekWindowOf(Date.now()).start);
    expect(now.days).toHaveLength(7);
  });

  test('按项目筛选：别的项目的钱与结局都不串进来', async () => {
    const { db, dispatch, admin } = makeApp();
    seedWeek(db);
    const body = await (await call(dispatch, 'GET', `/api/admin/usage/weekly?weekStart=${MON}&projectId=2`, admin.token))!
      .json() as WeeklyBody;
    expect(body.modules.map((m) => [m.projectId, m.moduleId])).toEqual([[2, 0]]);
    expect(money(body.totals.costUsd)).toBe(0.1);
    expect(body.totals).toMatchObject({ doneCount: 1, failedCount: 0 });
  });

  test('参数不合法直接 400（静默回退到本周会让人对着错的一周做决策）', async () => {
    const { dispatch, admin } = makeApp();
    expect((await call(dispatch, 'GET', '/api/admin/usage/weekly?weekStart=2026-9-7', admin.token))!.status).toBe(400);
    expect((await call(dispatch, 'GET', '/api/admin/usage/weekly?weekStart=上周', admin.token))!.status).toBe(400);
    expect((await call(dispatch, 'GET', '/api/admin/usage/weekly?projectId=abc', admin.token))!.status).toBe(400);
  });

  test('普通用户 403（周度视图同样仅管理员可见）', async () => {
    const { db, dispatch, users } = makeApp();
    seedWeek(db);
    const alice = users.create('alice', 'user');
    expect((await call(dispatch, 'GET', '/api/admin/usage/weekly', alice.token))!.status).toBe(403);
  });

  test('空库不报错：7 天全零、无模块行、单价给初值', async () => {
    const { dispatch, admin } = makeApp();
    const body = await (await call(dispatch, 'GET', `/api/admin/usage/weekly?weekStart=${MON}`, admin.token))!
      .json() as WeeklyBody;
    expect(body.days).toHaveLength(7);
    expect(body.days.every((d) => d.costUsd === 0)).toBe(true);
    expect(body.modules).toEqual([]);
    expect(body.totals).toMatchObject({ costUsd: 0, doneCount: 0, failureRate: 0, recoveryRate: 0 });
    expect(body.pricing.outputPerMTok).toBe(10);
  });
});

describe('成本视图（#282 / I-08、I-09）', () => {
  /** 造一份跨两个项目的用量现场：issue 用量 + chat 会话 + 未归因余量 */
  function seed(db: ReturnType<typeof openDb>) {
    db.run(`INSERT INTO executors (id, name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
      VALUES (1, 'local', '127.0.0.1', 22, 'root', 'k', '/ws', '/c')`);
    db.run(`INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
      VALUES (1, '项目甲', 1, '/ws/a', 1, 1), (2, '项目乙', 1, '/ws/b', 1, 1)`);
    db.run(`INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
      VALUES ('c1', 1, 'x', 1, 'claude', 'issue'), ('chat1', 1, 'y', 1, 'claude', 'chat'),
             ('c2', 2, 'z', 1, 'codex', 'issue')`);
    db.run(`INSERT INTO issues (id, project_id, title, status, created_ts)
      VALUES (10, 1, '贵的那条', 'done', 1000), (11, 2, '别的项目', 'done', 9000)`);
    db.run(`INSERT INTO conversation_usage
      (conv_id, project_id, kind, scanned_bytes, requests, input_tokens, cached_input_tokens,
       output_tokens, reasoning_tokens, compactions, tool_calls, skill_reads, updated_ts)
      VALUES ('c1', 1, 'issue', 10, 20, 500000, 400000, 20000, 5000, 2, 60, 4, 1),
             ('chat1', 1, 'chat', 10, 5, 30000, 10000, 2000, 0, 0, 3, 0, 1),
             ('c2', 2, 'issue', 10, 1, 100, 0, 10, 0, 0, 1, 0, 1)`);
    db.run(`INSERT INTO issue_usage
      (issue_id, project_id, requests, input_tokens, cached_input_tokens, output_tokens,
       reasoning_tokens, compactions, tool_calls, skill_reads, updated_ts)
      VALUES (10, 1, 12, 400000, 380000, 9000, 2500, 2, 47, 3, 1),
             (11, 2, 1, 100, 0, 10, 0, 0, 1, 0, 1)`);
    db.run(`INSERT INTO issue_events (issue_id, kind, data_json, ts)
      VALUES (10, 'tests_failed', '{}', 1), (10, 'nudged', '{}', 2), (10, 'judged', '{}', 3),
             (10, 'validation_passed', '{"durationMs":70000}', 4)`);
  }

  test('三档聚合 + 引擎指标；跨所有项目一起看', async () => {
    const { db, dispatch, admin } = makeApp();
    seed(db);
    const r = (await call(dispatch, 'GET', '/api/admin/usage', admin.token))!;
    expect(r.status).toBe(200);
    const body = await r.json() as {
      grand: { outputTokens: number; requests: number };
      projects: Array<{ projectId: number; projectName: string; outputTokens: number }>;
      chat: Array<{ projectId: number; outputTokens: number }>;
      unattributed: Array<{ projectId: number; outputTokens: number }>;
      issues: Array<{ issueId: number; title: string; usage: { outputTokens: number }; testRetries: number;
        nudges: number; judged: number; validationMs: number; validationRuns: number }>;
    };

    // 项目档取会话总量（issue 会话 + chat 会话）
    expect(body.projects.find((p) => p.projectId === 1)).toMatchObject({ projectName: '项目甲', outputTokens: 22000 });
    expect(body.grand).toMatchObject({ outputTokens: 22010, requests: 26 }); // 含项目乙那条会话
    // 非 Issue 会话单列
    expect(body.chat).toEqual([expect.objectContaining({ projectId: 1, outputTokens: 2000 })]);
    // 未归因余量 = 会话总量 − 已归因（项目甲 22000 − 9000；项目乙 10 − 10 = 0）
    expect(body.unattributed.find((u) => u.projectId === 1)).toMatchObject({ outputTokens: 13000 });
    expect(body.unattributed.find((u) => u.projectId === 2)).toMatchObject({ outputTokens: 0 });
    // issue 档带上引擎侧的非 token 指标
    const issue10 = body.issues.find((i) => i.issueId === 10)!;
    expect(issue10).toMatchObject({
      title: '贵的那条', testRetries: 1, nudges: 1, judged: 1, validationMs: 70000, validationRuns: 1,
    });
    expect(issue10.usage.outputTokens).toBe(9000);
  });

  test('按项目与时间窗筛选；时间窗只作用于 issue 档并在响应里说明', async () => {
    const { db, dispatch, admin } = makeApp();
    seed(db);

    const byProject = await (await call(dispatch, 'GET', '/api/admin/usage?projectId=2', admin.token))!.json() as {
      projects: Array<{ projectId: number }>; issues: Array<{ issueId: number }>;
    };
    expect(byProject.projects.map((p) => p.projectId)).toEqual([2]);
    expect(byProject.issues.map((i) => i.issueId)).toEqual([11]);

    const windowed = await (await call(dispatch, 'GET', '/api/admin/usage?from=5000', admin.token))!.json() as {
      window: { from: number; windowAppliesTo: string }; issues: Array<{ issueId: number }>;
      projects: Array<{ projectId: number }>;
    };
    expect(windowed.issues.map((i) => i.issueId)).toEqual([11]); // issue 10 建于 1000，被窗口挡掉
    expect(windowed.window).toEqual({ from: 5000, windowAppliesTo: 'issues' });
    expect(windowed.projects.length).toBeGreaterThan(0); // 项目档是累计值，不随窗口变
  });

  test('金额折算走后台单价表（#282 / Q2）：可读可改，改完成本跟着变', async () => {
    const { db, dispatch, admin } = makeApp();
    seed(db);

    const got = await (await call(dispatch, 'GET', '/api/admin/usage/pricing', admin.token))!.json() as {
      pricing: { inputPerMTok: number; cachedInputPerMTok: number; outputPerMTok: number };
    };
    expect(got.pricing).toMatchObject({ inputPerMTok: 1.25, cachedInputPerMTok: 0.125, outputPerMTok: 10 });

    const before = await (await call(dispatch, 'GET', '/api/admin/usage', admin.token))!.json() as {
      grandCostUsd: number; issues: Array<{ issueId: number; costUsd: number }>;
    };
    // 项目甲会话：input 50w + cached 40w + output 2w  →  0.625 + 0.05 + 0.2 ≈ 0.875（另加项目乙那条）
    expect(before.grandCostUsd).toBeGreaterThan(0.8);
    expect(before.issues.find((i) => i.issueId === 10)!.costUsd).toBeGreaterThan(0);

    const put = await call(dispatch, 'PUT', '/api/admin/usage/pricing', admin.token, { outputPerMTok: 20 });
    expect(put!.status).toBe(200);
    const after = await (await call(dispatch, 'GET', '/api/admin/usage', admin.token))!.json() as {
      grandCostUsd: number; pricing: { outputPerMTok: number };
    };
    expect(after.pricing.outputPerMTok).toBe(20);
    expect(after.grandCostUsd).toBeGreaterThan(before.grandCostUsd);

    // 负数拒绝，库内不动
    expect((await call(dispatch, 'PUT', '/api/admin/usage/pricing', admin.token, { inputPerMTok: -1 }))!.status).toBe(400);
  });

  test('回扫入口（#282 / Q3）：游标与两张表一起清，下一轮从头重算', async () => {
    const { db, dispatch, admin } = makeApp();
    seed(db);
    const r = (await call(dispatch, 'POST', '/api/admin/usage/rescan', admin.token, {}))!;
    expect(r.status).toBe(200);
    expect((await r.json() as { reset: number }).reset).toBe(3);

    const after = await (await call(dispatch, 'GET', '/api/admin/usage', admin.token))!.json() as {
      grand: { outputTokens: number }; issues: unknown[];
    };
    expect(after.grand.outputTokens).toBe(0);
    expect(after.issues).toEqual([]); // issue_usage 一并清掉，重扫才不会翻倍
  });

  test('普通用户 403（成本视图仅管理员可见）', async () => {
    const { db, dispatch, users } = makeApp();
    seed(db);
    const alice = users.create('alice', 'user');
    expect((await call(dispatch, 'GET', '/api/admin/usage', alice.token))!.status).toBe(403);
    expect((await call(dispatch, 'GET', '/api/admin/usage/pricing', alice.token))!.status).toBe(403);
    expect((await call(dispatch, 'POST', '/api/admin/usage/rescan', alice.token, {}))!.status).toBe(403);
  });

  test('空库不报错：三档都空、总量全零', async () => {
    const { dispatch, admin } = makeApp();
    const body = await (await call(dispatch, 'GET', '/api/admin/usage', admin.token))!.json() as {
      grand: { requests: number }; projects: unknown[]; chat: unknown[]; issues: unknown[];
    };
    expect(body).toMatchObject({ projects: [], chat: [], issues: [] });
    expect(body.grand.requests).toBe(0);
  });
});

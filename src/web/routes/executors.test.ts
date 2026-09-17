import { describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { UserStore } from '../../core/users';
import type { DirEntry, PathStat, TmuxSession } from '../../executor/driver';
import { LocalDriver } from '../../executor/local';
import { authDepsFromDb, createDispatcher } from '../middleware';
import {
  executorsRoutes,
  managedProjectIdOf,
  normalizeAbsPath,
  parsePasswd,
  safeDirName,
  type ExecutorProbe,
} from './executors';

const DIR_STAT: PathStat = { size: 0, mtimeMs: 0, isDirectory: true, isFile: false, mode: 0o755 };

const PASSWD = [
  'root:x:0:0:root:/root:/bin/bash',
  'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
  'sync:x:4:65534:sync:/bin:/bin/sync',
  'shutdown:x:6:0:shutdown:/sbin:/sbin/shutdown',
  'halt:x:7:0:halt:/sbin:/sbin/halt',
  'games:x:5:60:games:/usr/games:/usr/sbin/nologin',
  'svc:x:999:999::/var/svc:/bin/false',
  'developer:x:1002:1002::/home/developer:/bin/bash',
  'lighthouse:x:1000:1000::/home/lighthouse:/bin/bash',
  '坏行',
].join('\n');

function setup(
  sessions: TmuxSession[] = [],
  opts: { noDriver?: boolean; dirs?: Record<string, string[]> } = {},
) {
  const db = openDb(':memory:');
  migrate(db);
  const users = new UserStore(db);
  const admin = users.create('admin', 'admin');
  const alice = users.create('alice');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  const fsDirs = new Map<string, DirEntry[]>(
    Object.entries(opts.dirs ?? {}).map(([p, names]) => [
      p,
      names.map((n) => ({ name: n, type: 'dir' as const })),
    ]),
  );
  const probe: ExecutorProbe = {
    listSessions: async () => sessions,
    readFileRange: async () => {
      const data = new TextEncoder().encode(PASSWD);
      return { data, size: data.length };
    },
    statPath: async (p) => (fsDirs.has(p) ? DIR_STAT : null),
    listDir: async (p) => (fsDirs.get(p) ?? []),
    mkdirp: async (p) => {
      fsDirs.set(p, fsDirs.get(p) ?? []);
    },
    ensureGitAvailable: async () => {},
    git: async () => ({ code: 0, out: '', err: '' }),
  };
  const dispatch = createDispatcher(
    executorsRoutes({ db, driverFor: () => (opts.noDriver ? null : probe) }),
    authDepsFromDb(db, users),
  );
  return { db, admin, alice, dispatch };
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

describe('parsePasswd', () => {
  test('排除 nologin/false/sync/halt/shutdown 与系统 uid；按 uid 升序', () => {
    expect(parsePasswd(PASSWD)).toEqual([
      { name: 'root', uid: 0, home: '/root' },
      { name: 'lighthouse', uid: 1000, home: '/home/lighthouse' },
      { name: 'developer', uid: 1002, home: '/home/developer' },
    ]);
  });
});

describe('managedProjectIdOf', () => {
  test('cc-<pid> 命名空间识别', () => {
    expect(managedProjectIdOf('cc-3')).toBe(3);
    expect(managedProjectIdOf('cc-3-console')).toBe(3);
    expect(managedProjectIdOf('cc-abc')).toBeNull();
    expect(managedProjectIdOf('ontology')).toBeNull();
  });
});

describe('executors 路由', () => {
  test('GET /api/executors：登录即可见，仅极简字段（不泄露 ssh_user/key_ref）', async () => {
    const s = setup();
    expect((await j(s.dispatch(req('GET', '/api/executors')))).status).toBe(401);
    const r = await j(s.dispatch(req('GET', '/api/executors', s.alice.token)));
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        id: 1,
        name: 'local',
        status: 'unknown',
        isSystemLocal: false,
        supportedAgents: ['claude', 'codex'],
        availableForProjects: true,
        capabilitiesCheckedTs: null,
      },
    ]);
    expect(JSON.stringify(r.body)).not.toContain('keyRef');
    expect(JSON.stringify(r.body)).not.toContain('sshUser');
  });

  test('os-users：仅 admin；驱动缺失 503；解析 passwd', async () => {
    const s = setup();
    expect((await j(s.dispatch(req('GET', '/api/executors/1/os-users', s.alice.token)))).status).toBe(403);
    const r = await j(s.dispatch(req('GET', '/api/executors/1/os-users', s.admin.token)));
    expect(r.status).toBe(200);
    expect(r.body.users.map((u: any) => u.name)).toEqual(['root', 'lighthouse', 'developer']);

    const s2 = setup([], { noDriver: true });
    expect((await j(s2.dispatch(req('GET', '/api/executors/1/os-users', s2.admin.token)))).status).toBe(503);
    expect((await j(s.dispatch(req('GET', '/api/executors/99/os-users', s.admin.token)))).status).toBe(404);
  });

  test('tmux-sessions：托管/已导入/同目录项目标注 + 普通用户 workspace 越权标 false', async () => {
    const s = setup([
      { name: 'cc-1', createdTs: 10, attached: false, command: 'claude', cwd: '/ws/u9/x' },
      { name: 'ontology', createdTs: 20, attached: true, command: 'claude', cwd: '/home/developer/onto' },
      { name: 'mine', createdTs: 30, attached: false, command: 'bash', cwd: `/ws/u2/mine` },
      { name: 'imported-one', createdTs: 40, attached: false, cwd: '/opt/x' },
      { name: 'nocwd', createdTs: 50, attached: false },
    ]);
    // 项目 1（cc-1 的托管项目）+ 项目 2（cwd=/home/developer/onto 同目录）+ 登记 imported-one → 项目 2
    s.db.run(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES
       ('a', 1, '/ws/u9/x', 1, 0), ('b', 1, '/home/developer/onto', 1, 0)`,
    );
    s.db.run(`INSERT INTO sessions (name, executor_id, project_id, owner_user_id) VALUES ('imported-one', 1, 2, 1)`);

    const r = await j(s.dispatch(req('GET', '/api/executors/1/tmux-sessions', s.admin.token)));
    expect(r.status).toBe(200);
    const by = new Map(r.body.sessions.map((x: any) => [x.name, x]));
    expect((by.get('cc-1') as any).managedProjectId).toBe(1);
    expect((by.get('ontology') as any).sameCwdProjectId).toBe(2);
    expect((by.get('imported-one') as any).importedProjectId).toBe(2);
    expect((by.get('nocwd') as any).cwd).toBeNull();
    // admin 全 allowed
    expect(r.body.sessions.every((x: any) => x.allowed)).toBe(true);

    // 普通用户（alice id=2）：只有 /ws/u2/** 的会话 allowed
    const ra = await j(s.dispatch(req('GET', '/api/executors/1/tmux-sessions', s.alice.token)));
    const bya = new Map(ra.body.sessions.map((x: any) => [x.name, x]));
    expect((bya.get('mine') as any).allowed).toBe(true);
    expect((bya.get('ontology') as any).allowed).toBe(false);
    expect((bya.get('nocwd') as any).allowed).toBe(false);
  });

  test('agent-projects：按 Agent 返回历史项目摘要，并对普通用户隐藏 workspace 外候选', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-agent-projects-'));
    try {
      const claudeDir = path.join(root, '.claude', 'projects', '-history');
      await fsp.mkdir(claudeDir, { recursive: true });
      const write = async (sid: string, cwd: string, prompt: string) => {
        await fsp.writeFile(
          path.join(claudeDir, `${sid}.jsonl`),
          JSON.stringify({
            type: 'user', cwd, sessionId: sid, timestamp: '2026-08-02T00:00:00Z',
            message: { role: 'user', content: prompt },
          }) + '\n',
        );
      };
      await write('mine', '/ws/u2/app', '我的历史');
      await write('private', '/srv/private', '不可泄露的历史');

      const db = openDb(':memory:');
      migrate(db);
      const users = new UserStore(db);
      const admin = users.create('admin', 'admin');
      const alice = users.create('alice');
      db.query(
        `INSERT INTO executors
           (name, host, port, ssh_user, key_ref, workspace_root, claude_dir, codex_dir)
         VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', ?, ?)`,
      ).run(path.dirname(claudeDir), path.join(root, '.codex', 'sessions'));
      db.run(
        `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
         VALUES ('existing', 1, '/ws/u2/app', 2, 0)`,
      );
      const dispatch = createDispatcher(
        executorsRoutes({ db, driverFor: () => new LocalDriver() }),
        authDepsFromDb(db, users),
      );

      const mine = await j(dispatch(req('GET', '/api/executors/1/agent-projects?agent=claude', alice.token)));
      expect(mine.status).toBe(200);
      expect(mine.body.projects).toEqual([
        expect.objectContaining({
          agent: 'claude', cwd: '/ws/u2/app', name: 'app', sessionCount: 1, sameCwdProjectId: 1,
        }),
      ]);
      expect(JSON.stringify(mine.body)).not.toContain('不可泄露的历史');
      expect(JSON.stringify(mine.body)).not.toContain('jsonlPath');

      const all = await j(dispatch(req('GET', '/api/executors/1/agent-projects?agent=claude', admin.token)));
      expect(all.body.projects).toHaveLength(2);
      const invalidAgent = await j(
        dispatch(req('GET', '/api/executors/1/agent-projects?agent=other', admin.token)),
      );
      expect(invalidAgent.status).toBe(400);
      expect(invalidAgent.body.error.code).toBe('executor.agent_invalid');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('normalizeAbsPath / safeDirName（纯函数）', () => {
  test('normalizeAbsPath：非绝对/NUL → null；折叠 .. 与尾斜杠', () => {
    expect(normalizeAbsPath('rel/x')).toBeNull();
    expect(normalizeAbsPath('/a\0b')).toBeNull();
    expect(normalizeAbsPath('/a/b/../c/')).toBe('/a/c');
    expect(normalizeAbsPath('/')).toBe('/');
    expect(normalizeAbsPath('/ws/u2/')).toBe('/ws/u2');
  });
  test('safeDirName：拒绝分隔符/点名/超长；保留中文', () => {
    expect(safeDirName('proj')).toBe('proj');
    expect(safeDirName('我的项目')).toBe('我的项目');
    expect(safeDirName('a/b')).toBeNull();
    expect(safeDirName('..')).toBeNull();
    expect(safeDirName('   ')).toBeNull();
    expect(safeDirName('x'.repeat(101))).toBeNull();
  });
});

describe('GET /api/executors/:id/fs（目录浏览）', () => {
  test('缺省 path：admin 落 workspace_root，普通用户落自己 workspace；仅回目录、点号目录排后', async () => {
    const s = setup([], {
      dirs: {
        '/ws': ['u2', 'other'],
        '/ws/u2': ['.hidden', 'beta', 'alpha'],
      },
    });
    const adm = await j(s.dispatch(req('GET', '/api/executors/1/fs', s.admin.token)));
    expect(adm.status).toBe(200);
    expect(adm.body.path).toBe('/ws');
    expect(adm.body.dirs).toEqual(['other', 'u2']);

    const al = await j(s.dispatch(req('GET', '/api/executors/1/fs', s.alice.token)));
    expect(al.status).toBe(200);
    expect(al.body.path).toBe('/ws/u2');
    expect(al.body.root).toBe('/ws/u2');
    expect(al.body.dirs).toEqual(['alpha', 'beta', '.hidden']);
  });

  test('普通用户越界 403；不存在目录 → missing:true；未登录 401；无连接 503', async () => {
    const s = setup([], { dirs: { '/ws/u2': ['x'] } });
    expect((await j(s.dispatch(req('GET', '/api/executors/1/fs')))).status).toBe(401);
    expect(
      (await j(s.dispatch(req('GET', '/api/executors/1/fs?path=/etc', s.alice.token)))).status,
    ).toBe(403);
    // admin 浏览不存在目录 → ok + missing
    const miss = await j(s.dispatch(req('GET', '/api/executors/1/fs?path=/ws/u2/none', s.admin.token)));
    expect(miss.status).toBe(200);
    expect(miss.body.missing).toBe(true);
    const s2 = setup([], { noDriver: true });
    expect((await j(s2.dispatch(req('GET', '/api/executors/1/fs', s2.admin.token)))).status).toBe(503);
  });
});

describe('POST /api/executors/:id/fs/mkdir（新建目录）', () => {
  test('普通用户在自己 workspace 建目录成功；越界 403；非法名 400', async () => {
    const s = setup([], { dirs: { '/ws/u2': [] } });
    const ok = await j(
      s.dispatch(req('POST', '/api/executors/1/fs/mkdir', s.alice.token, { path: '/ws/u2', name: 'newdir' })),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.path).toBe('/ws/u2/newdir');

    const out = await j(
      s.dispatch(req('POST', '/api/executors/1/fs/mkdir', s.alice.token, { path: '/etc', name: 'x' })),
    );
    expect(out.status).toBe(403);

    const bad = await j(
      s.dispatch(req('POST', '/api/executors/1/fs/mkdir', s.alice.token, { path: '/ws/u2', name: '../evil' })),
    );
    expect(bad.status).toBe(400);
  });

  test('同名文件已存在 → 400；admin 任意路径', async () => {
    const s = setup([], { dirs: { '/opt': [] } });
    const ok = await j(
      s.dispatch(req('POST', '/api/executors/1/fs/mkdir', s.admin.token, { path: '/opt', name: 'proj' })),
    );
    expect(ok.status).toBe(200);
    expect(ok.body.path).toBe('/opt/proj');
  });
});

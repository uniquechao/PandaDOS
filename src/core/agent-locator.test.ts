import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine } from '../issues/engine';
import { UserStore } from './users';
import { LocalDriver } from '../executor/local';
import { JsonlLocator } from './jsonl';
import { AgentJsonlLocator, rolloutSessionId } from './agent-locator';
import { migrateDesigns } from '../designs/store';

let dir: string;
const driver = new LocalDriver();

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'panda-agentloc-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

function fmtRollout(ts: number, sid: string): string {
  const d = new Date(ts);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `rollout-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${sid}.jsonl`;
}

/**
 * 造 rollout：meta 时间取 ts（真实格式：payload.timestamp / 顶层 timestamp 均为 UTC ISO）；
 * nameTs 单独控制文件名时间与所在日目录（模拟执行机本地时区与进程时区不一致），缺省同 ts。
 */
async function writeRollout(root: string, ts: number, sid: string, cwd: string, nameTs?: number): Promise<string> {
  const d = new Date(nameTs ?? ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = path.join(root, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  await fsp.mkdir(day, { recursive: true });
  const f = path.join(day, fmtRollout(nameTs ?? ts, sid));
  const iso = new Date(ts).toISOString();
  await fsp.writeFile(
    f,
    JSON.stringify({
      timestamp: iso,
      type: 'session_meta',
      payload: { id: sid, session_id: sid, timestamp: iso, cwd },
    }) + '\n',
  );
  return f;
}

function setup(cwd: string) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const { user } = users.create('admin', 'admin');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  db.query(`INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES (?, 1, ?, ?, ?)`)
    .run('a', cwd, user.id, Date.now());
  return db;
}

function insConv(
  db: ReturnType<typeof setup>,
  id: string,
  agent: string,
  launchTs?: number,
  sid?: string,
  createdTs?: number,
): void {
  db.query(
    `INSERT INTO conversations (id, project_id, label, created_ts, agent, agent_launch_ts, agent_session_id)
     VALUES (?, 1, 'x', ?, ?, ?, ?)`,
  ).run(id, createdTs ?? Date.now(), agent, launchTs ?? null, sid ?? null);
}

/**
 * 造子代理 rollout（codex multi-agent）：文件名后缀是自己的 id，而 `payload.session_id`
 * 记的是**父线程**——发现/重认领都必须跳过它，否则会绑出「sid 是主线程、path 是子代理」。
 */
async function writeSubagentRollout(
  root: string,
  ts: number,
  sid: string,
  parentSid: string,
  cwd: string,
): Promise<string> {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  const day = path.join(root, String(d.getFullYear()), p(d.getMonth() + 1), p(d.getDate()));
  await fsp.mkdir(day, { recursive: true });
  const f = path.join(day, fmtRollout(ts, sid));
  const iso = new Date(ts).toISOString();
  await fsp.writeFile(
    f,
    JSON.stringify({
      timestamp: iso,
      type: 'session_meta',
      payload: {
        id: sid,
        session_id: parentSid,
        parent_thread_id: parentSid,
        thread_source: 'subagent',
        timestamp: iso,
        cwd,
      },
    }) + '\n',
  );
  return f;
}

/** 给会话文件追加一条带时间戳的行（reclaim 活跃度判据吃文件尾时间戳） */
async function appendTsLine(f: string, ts: number): Promise<void> {
  await fsp.appendFile(f, JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg' }) + '\n');
}

describe('rolloutSessionId', () => {
  test('提取 session id；非 rollout 返回 null（文件名时间不解析——时区不可靠）', () => {
    expect(rolloutSessionId('rollout-2026-07-14T09-30-05-abc-def.jsonl')).toBe('abc-def');
    expect(rolloutSessionId('whatever.jsonl')).toBeNull();
  });
});

describe('AgentJsonlLocator', () => {
  test('claude 对话透传原定位器', async () => {
    const cwd = path.join(dir, 'p1');
    const db = setup(cwd);
    insConv(db, 'conv-claude', 'claude');
    const claudeRoot = path.join(dir, 'claude-projects');
    await fsp.mkdir(path.join(claudeRoot, '-p'), { recursive: true });
    const f = path.join(claudeRoot, '-p', 'conv-claude.jsonl');
    await fsp.writeFile(f, '');
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, claudeRoot), path.join(dir, 'nope'));
    expect(await loc.locate('conv-claude')).toBe(f);
  });

  test('codex fresh 发现：launch_ts 锚点 + cwd 核对 + 回填两列', async () => {
    const cwd = path.join(dir, 'p2');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-1');
    const t0 = Date.now();
    insConv(db, 'conv-cx', 'codex', t0);
    // 干扰项：launch 前 1 小时的旧会话（meta 时间早于锚点 → 排除）
    await writeRollout(root, t0 - 3600_000, 'old-session', cwd);
    // 干扰项：同窗口但别的项目 cwd
    await writeRollout(root, t0 + 1000, 'other-cwd', '/elsewhere');
    // 目标
    const f = await writeRollout(root, t0 + 2000, 'real-sid', cwd);

    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.locate('conv-cx')).toBe(f);
    const row = db
      .query<{ agent_session_id: string; agent_jsonl_path: string }, [string]>(
        'SELECT agent_session_id, agent_jsonl_path FROM conversations WHERE id = ?',
      )
      .get('conv-cx');
    expect(row!.agent_session_id).toBe('real-sid');
    expect(row!.agent_jsonl_path).toBe(f);
  });

  test('managed conversation discovers only its persisted workspace cwd', async () => {
    const projectCwd = path.join(dir, 'locator-main');
    const worktreeCwd = path.join(dir, 'locator-worktree');
    const db = setup(projectCwd);
    migrateDesigns(db);
    const root = path.join(dir, 'codex-managed-workspace');
    const t0 = Date.now();
    insConv(db, 'conv-managed', 'codex', t0);
    db.query('UPDATE conversations SET workspace_cwd = ? WHERE id = ?')
      .run(worktreeCwd, 'conv-managed');
    await writeRollout(root, t0 + 1000, 'main-session', projectCwd);
    const managed = await writeRollout(root, t0 + 2000, 'managed-session', worktreeCwd);
    const loc = new AgentJsonlLocator(
      db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root,
    );
    expect(await loc.locate('conv-managed')).toBe(managed);
    expect(db.query<{ sid: string }, []>(
      "SELECT agent_session_id AS sid FROM conversations WHERE id = 'conv-managed'",
    ).get()?.sid).toBe('managed-session');

    await writeRollout(root, t0 + 3000, 'main-reclaim', projectCwd);
    const managedReclaim = await writeRollout(root, t0 + 4000, 'managed-reclaim', worktreeCwd);
    await appendTsLine(managedReclaim, Date.now());
    expect(await loc.reclaim('conv-managed')).toBe(managedReclaim);
  });

  test('codex fresh 发现：容差窗内旧 rollout 不得抢占启动后创建的当前会话', async () => {
    const cwd = path.join(dir, 'p2-collision');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-collision');
    const launchTs = Date.now();
    insConv(db, 'conv-collision', 'codex', launchTs);
    const stale = await writeRollout(root, launchTs - 111_000, 'stale-nearby', cwd);
    const current = await writeRollout(root, launchTs + 5_000, 'current-sid', cwd);

    const loc = new AgentJsonlLocator(
      db,
      driver,
      new JsonlLocator(driver, path.join(dir, 'nope')),
      root,
      () => launchTs + 6_000,
    );
    expect(await loc.locate('conv-collision')).toBe(current);
    expect(await loc.locate('conv-collision')).not.toBe(stale);
  });

  test('codex fresh 发现：确认期内不提前绑定仅有的锚点前候选，超时后仍兼容时钟偏差', async () => {
    const cwd = path.join(dir, 'p2-clock-skew');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-clock-skew');
    const launchTs = Date.now();
    let now = launchTs + 1_000;
    insConv(db, 'conv-clock-skew', 'codex', launchTs);
    const skewed = await writeRollout(root, launchTs - 15_000, 'skewed-sid', cwd);

    const loc = new AgentJsonlLocator(
      db,
      driver,
      new JsonlLocator(driver, path.join(dir, 'nope')),
      root,
      () => now,
    );
    expect(await loc.locate('conv-clock-skew')).toBeNull();

    now = launchTs + 11_000;
    expect(await loc.locate('conv-clock-skew')).toBe(skewed);
  });

  test('已绑他人 session id 排除；无锚点不猜', async () => {
    const cwd = path.join(dir, 'p3');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-2');
    const t0 = Date.now();
    // conv-a 已绑 sid-a；conv-b 同窗口发现时必须跳过 sid-a 拿 sid-b
    insConv(db, 'conv-a', 'codex', t0, 'sid-a');
    insConv(db, 'conv-b', 'codex', t0);
    await writeRollout(root, t0 + 1000, 'sid-a', cwd);
    const fb = await writeRollout(root, t0 + 2000, 'sid-b', cwd);
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.locate('conv-b')).toBe(fb);

    // 无 launch_ts 的 codex 对话：不扫不猜
    insConv(db, 'conv-c', 'codex');
    expect(await loc.locate('conv-c')).toBeNull();
  });

  test('已知 session id：路径缓存失效后按文件名后缀回扫恢复', async () => {
    const cwd = path.join(dir, 'p4');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-3');
    const t0 = Date.now();
    const f = await writeRollout(root, t0, 'sid-x', cwd);
    insConv(db, 'conv-x', 'codex', t0, 'sid-x');
    // 缓存列填个已失效的假路径 → 清缓存 → 回扫命中
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run('/gone.jsonl', 'conv-x');
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.locate('conv-x')).toBe(f);
  });

  test('时区偏移回归（issue #48）：文件名时间不可信，按 meta UTC 时间锚定', async () => {
    const cwd = path.join(dir, 'p5');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-4');
    const t0 = Date.now();
    insConv(db, 'conv-tz', 'codex', t0);
    // 复现生产错绑：7 小时前创建的旧会话，但文件名按执行机本地时区（快 8h）写——
    // 旧实现把文件名时间当进程本地时区解析 → 视为「launch 后 1 小时」的最早候选而错绑
    const stale = await writeRollout(root, t0 - 7 * 3600_000, 'stale-sid', cwd, t0 + 3600_000);
    // 真正 launch 后新起的会话（文件名同样偏快 8h）
    const fresh = await writeRollout(root, t0 + 2000, 'fresh-sid', cwd, t0 + 8 * 3600_000 + 2000);
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.locate('conv-tz')).toBe(fresh);
    expect(stale).not.toBe(fresh);
    const row = db
      .query<{ agent_session_id: string }, [string]>(
        'SELECT agent_session_id FROM conversations WHERE id = ?',
      )
      .get('conv-tz');
    expect(row!.agent_session_id).toBe('fresh-sid');
  });

  test('日目录外扩：文件名落在进程本地「明天」的目录也能扫到', async () => {
    const cwd = path.join(dir, 'p6');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-5');
    const t0 = Date.now();
    insConv(db, 'conv-fut', 'codex', t0);
    // 执行机时区超前进程时区时，刚创建的 rollout 可能落在进程本地日期 +1 天的目录
    const f = await writeRollout(root, t0 + 2000, 'fut-sid', cwd, t0 + 24 * 3600_000);
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root, () => t0);
    expect(await loc.locate('conv-fut')).toBe(f);
  });

  test('codex reclaim：跳过死绑定/不活跃/他项目/已绑走，认领最新活跃会话并重盖三列', async () => {
    const cwd = path.join(dir, 'p7');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-6');
    const t0 = Date.now();
    // conv 2 小时前创建，绑着已死的 dead-sid
    insConv(db, 'conv-rc', 'codex', t0 - 7200_000, 'dead-sid', t0 - 7200_000);
    const dead = await writeRollout(root, t0 - 7200_000, 'dead-sid', cwd);
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run(dead, 'conv-rc');
    // 弃会话：meta 比 live 新（20 分钟前）但尾巴停在过去 → 不活跃，跳过
    await writeRollout(root, t0 - 1200_000, 'aband-sid', cwd);
    // 他项目 cwd（尾巴活跃也不行）
    const other = await writeRollout(root, t0 - 600_000, 'other-cwd-sid', '/elsewhere');
    await appendTsLine(other, t0 - 5000);
    // 已被别的对话绑走
    insConv(db, 'conv-taken', 'codex', t0 - 300_000, 'taken-sid');
    const taken = await writeRollout(root, t0 - 300_000, 'taken-sid', cwd);
    await appendTsLine(taken, t0 - 5000);
    // 目标：30 分钟前人工重启的会话，尾巴刚写过 → 活跃
    const live = await writeRollout(root, t0 - 1800_000, 'live-sid', cwd);
    await appendTsLine(live, t0 - 5000);

    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.reclaim('conv-rc')).toBe(live);
    const row = db
      .query<{ agent_session_id: string; agent_jsonl_path: string; agent_launch_ts: number }, [string]>(
        'SELECT agent_session_id, agent_jsonl_path, agent_launch_ts FROM conversations WHERE id = ?',
      )
      .get('conv-rc');
    expect(row!.agent_session_id).toBe('live-sid');
    expect(row!.agent_jsonl_path).toBe(live);
    expect(row!.agent_launch_ts).toBe(t0 - 1800_000);
    expect(await loc.locate('conv-rc')).toBe(live);
  });

  test('codex reclaim：跳过子代理线程，认领主线程（#302：否则会绑出子代理的流水）', async () => {
    const cwd = path.join(dir, 'p7b');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-6b');
    const t0 = Date.now();
    insConv(db, 'conv-sub', 'codex', t0 - 7200_000, 'dead-sid', t0 - 7200_000);
    const dead = await writeRollout(root, t0 - 7200_000, 'dead-sid', cwd);
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run(dead, 'conv-sub');
    // 人工重启后的主线程（30 分钟前），以及它随后派生的两个子代理（更新、也在写）
    const main = await writeRollout(root, t0 - 1800_000, 'main-sid', cwd);
    await appendTsLine(main, t0 - 5000);
    const sub1 = await writeSubagentRollout(root, t0 - 900_000, 'sub1-sid', 'main-sid', cwd);
    await appendTsLine(sub1, t0 - 3000);
    const sub2 = await writeSubagentRollout(root, t0 - 600_000, 'sub2-sid', 'main-sid', cwd);
    await appendTsLine(sub2, t0 - 1000);

    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    // 「取 meta 最新」本会挑到 sub2，子代理过滤把它挡回主线程
    expect(await loc.reclaim('conv-sub')).toBe(main);
    const row = db
      .query<{ agent_session_id: string; agent_jsonl_path: string }, [string]>(
        'SELECT agent_session_id, agent_jsonl_path FROM conversations WHERE id = ?',
      )
      .get('conv-sub');
    expect(row!.agent_session_id).toBe('main-sid');
    expect(row!.agent_jsonl_path).toBe(main);
  });

  test('codex reclaim：无活跃候选返回 null 且不动原绑定', async () => {
    const cwd = path.join(dir, 'p8');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-7');
    const t0 = Date.now();
    insConv(db, 'conv-rc2', 'codex', t0 - 7200_000, 'dead-sid', t0 - 7200_000);
    const dead = await writeRollout(root, t0 - 7200_000, 'dead-sid', cwd);
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run(dead, 'conv-rc2');
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.reclaim('conv-rc2')).toBeNull();
    const row = db
      .query<{ agent_session_id: string; agent_jsonl_path: string }, [string]>(
        'SELECT agent_session_id, agent_jsonl_path FROM conversations WHERE id = ?',
      )
      .get('conv-rc2');
    expect(row!.agent_session_id).toBe('dead-sid');
    expect(row!.agent_jsonl_path).toBe(dead);
  });

  test('readMeta 正则兜底：首行非法 JSON 但可抽 session_id/cwd/timestamp → 仍可发现', async () => {
    const cwd = path.join(dir, 'p10');
    const db = setup(cwd);
    const root = path.join(dir, 'codex-sessions-8');
    const t0 = Date.now();
    insConv(db, 'conv-rgx', 'codex', t0);
    const iso = new Date(t0 + 1500).toISOString();
    const d = new Date(t0 + 1500);
    const p2 = (n: number) => String(n).padStart(2, '0');
    const day = path.join(root, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
    await fsp.mkdir(day, { recursive: true });
    const f = path.join(day, fmtRollout(t0 + 1500, 'abc-123-def'));
    // 结尾少个 }：JSON.parse 失败 → 走正则兜底（sid/cwd/timestamp 都从原文抽）
    await fsp.writeFile(
      f,
      `{"timestamp":"${iso}","type":"session_meta","payload":{"session_id":"abc-123-def","cwd":"${cwd}"}\n`,
    );
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, path.join(dir, 'nope')), root);
    expect(await loc.locate('conv-rgx')).toBe(f);
  });

  test('claude 覆盖失效（文件被删）→ 清列回退常规定位', async () => {
    const cwd = path.join(dir, 'p11');
    const db = setup(cwd);
    insConv(db, 'conv-gone', 'claude');
    const claudeRoot = path.join(dir, 'claude-projects-gone');
    const pdir = path.join(claudeRoot, '-p11');
    await fsp.mkdir(pdir, { recursive: true });
    const orig = path.join(pdir, 'conv-gone.jsonl');
    await fsp.writeFile(orig, '');
    db.query('UPDATE conversations SET agent_jsonl_path = ? WHERE id = ?').run('/deleted/manual.jsonl', 'conv-gone');
    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, claudeRoot), path.join(dir, 'nope'));
    expect(await loc.locate('conv-gone')).toBe(orig); // 覆盖 stat 失败 → 回退
    const row = db
      .query<{ agent_jsonl_path: string | null }, [string]>(
        'SELECT agent_jsonl_path FROM conversations WHERE id = ?',
      )
      .get('conv-gone');
    expect(row!.agent_jsonl_path).toBeNull(); // 失效列已清
  });

  test('claude reclaim（best-effort）：绑同目录手动重启的新会话，locate 走覆盖', async () => {
    const cwd = path.join(dir, 'p9');
    const db = setup(cwd);
    const t0 = Date.now();
    insConv(db, 'conv-cl', 'claude', undefined, undefined, t0 - 3600_000);
    insConv(db, 'conv-cl2', 'claude'); // 同目录另一条对话（其文件不可被认领）
    const claudeRoot = path.join(dir, 'claude-projects-rc');
    const pdir = path.join(claudeRoot, '-p9');
    await fsp.mkdir(pdir, { recursive: true });
    const orig = path.join(pdir, 'conv-cl.jsonl');
    await fsp.writeFile(orig, '');
    await appendTsLine(orig, t0 - 3600_000);
    // 他对话的文件（尾巴活跃也不行）
    const sibling = path.join(pdir, 'conv-cl2.jsonl');
    await fsp.writeFile(sibling, '');
    await appendTsLine(sibling, t0 - 1000);
    // conv 创建之前就存在的旧会话 → 排除
    const old = path.join(pdir, 'old-manual.jsonl');
    await fsp.writeFile(old, '');
    await appendTsLine(old, t0 - 7200_000);
    await appendTsLine(old, t0 - 2000);
    // 目标：conv 创建后人工起的会话，首条时间戳在 conv 之后、尾巴活跃
    const manual = path.join(pdir, 'manual-restart.jsonl');
    await fsp.writeFile(manual, '');
    await appendTsLine(manual, t0 - 600_000);
    await appendTsLine(manual, t0 - 3000);

    const loc = new AgentJsonlLocator(db, driver, new JsonlLocator(driver, claudeRoot), path.join(dir, 'nope'));
    expect(await loc.reclaim('conv-cl')).toBe(manual);
    expect(await loc.locate('conv-cl')).toBe(manual); // 覆盖优先
    loc.invalidate('conv-cl'); // 清覆盖 → 回退常规定位
    expect(await loc.locate('conv-cl')).toBe(orig);
  });
});

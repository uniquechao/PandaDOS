import { describe, expect, test } from 'bun:test';
import { openDb } from './db';
import { migrate } from './migrate';
import { migrateIssueEngine, getProject } from '../issues/engine';
import type { RunSummaryResult } from './agent-summary';
import type { AgentKind, Project } from './types';
import { deriveShortSummary, SummaryOrchestrator } from './summary-orchestrator';

// ---------- db 装配 ----------

function setup() {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  db.run(
    `INSERT INTO users (id, username, token_hash, role, created_ts) VALUES (1, 'admin', 'x', 'admin', 0)`,
  );
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '/ws', '/claude')`,
  );
  db.run(
    `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts) VALUES (1, 'p', 1, '/repo', 1, 0)`,
  );
  return db;
}

function statusRow(db: ReturnType<typeof setup>) {
  return db
    .query<
      {
        understanding: string | null;
        understanding_agent: string | null;
        understanding_ts: number | null;
        readme_summary: string | null;
        summary_status: string;
        summary_error: string | null;
      },
      []
    >(
      `SELECT understanding, understanding_agent, understanding_ts, readme_summary, summary_status, summary_error
         FROM projects WHERE id = 1`,
    )
    .get()!;
}

const proj = (db: ReturnType<typeof setup>): Project => getProject(db, 1)!;

// ---------- deriveShortSummary ----------

describe('deriveShortSummary', () => {
  test('去 markdown 装饰、并行空白，短文原样', () => {
    const s = deriveShortSummary('# 标题\n\n- 列表项\n> 引用\n这是 **重点** 与 `代码`。');
    expect(s).toBe('标题 列表项 引用 这是 重点 与 代码。');
    expect(s).not.toContain('#');
    expect(s).not.toContain('*');
  });
  test('保留连字符（项目名不被切）', () => {
    expect(deriveShortSummary('PandaDOS 是一个工具')).toBe('PandaDOS 是一个工具');
  });
  test('超 max 截断补省略号，长度不超 max', () => {
    const long = '很长的内容'.repeat(100);
    const s = deriveShortSummary(long, 200);
    expect([...s].length).toBeLessThanOrEqual(200);
    expect(s.endsWith('…')).toBe(true);
  });
});

// ---------- SummaryOrchestrator ----------

describe('SummaryOrchestrator', () => {
  test('成功：running → done，落 understanding/agent/ts + 派生短简介', async () => {
    const db = setup();
    const got = { digest: '', agent: '' as AgentKind | '' };
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => '历史摘要',
      runSummary: async (_p, agent, digest): Promise<RunSummaryResult> => {
        got.digest = digest;
        got.agent = agent;
        return { ok: true, understanding: '# 项目认知\n本项目做 A、B、C，现状良好。' };
      },
      now: () => 999,
    });

    const r = orch.start(proj(db), 'codex');
    expect(r).toEqual({ started: true });
    // 同步即 running
    expect(statusRow(db).summary_status).toBe('running');
    expect(orch.isRunning(1)).toBe(true);

    await orch.wait(1);

    // 回调拿到 digest 与 agent
    expect(got.digest).toBe('历史摘要');
    expect(got.agent).toBe('codex');

    const row = statusRow(db);
    expect(row.summary_status).toBe('done');
    expect(row.understanding).toBe('# 项目认知\n本项目做 A、B、C，现状良好。');
    expect(row.understanding_agent).toBe('codex');
    expect(row.understanding_ts).toBe(999);
    expect(row.summary_error).toBeNull();
    // 派生短简介：去了井号、并了空白
    expect(row.readme_summary).toBe('项目认知 本项目做 A、B、C，现状良好。');
    // 跑完解锁
    expect(orch.isRunning(1)).toBe(false);
  });

  test('target 透传：start(project, agent, "memory") → runSummary 收到 memory；缺省 readme', async () => {
    const db = setup();
    const seen: (string | undefined)[] = [];
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => 'd',
      runSummary: async (_p, _a, _d, target): Promise<RunSummaryResult> => {
        seen.push(target);
        return { ok: true, understanding: 'x' };
      },
    });
    orch.start(proj(db), 'claude', 'memory');
    await orch.wait(1);
    orch.start(proj(db), 'claude'); // 缺省
    await orch.wait(1);
    expect(seen).toEqual(['memory', 'readme']);
  });

  test('失败（timeout）：status=error + summary_error，understanding 不动', async () => {
    const db = setup();
    // 先塞一条旧的成功结果，验证失败不覆盖
    db.run(
      `UPDATE projects SET understanding='旧认知', understanding_agent='claude', readme_summary='旧简介' WHERE id=1`,
    );
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => 'h',
      runSummary: async (): Promise<RunSummaryResult> => ({ ok: false, reason: 'timeout' }),
    });
    orch.start(proj(db), 'claude');
    await orch.wait(1);

    const row = statusRow(db);
    expect(row.summary_status).toBe('error');
    expect(row.summary_error).toContain('超时');
    // 旧的好结果保留
    expect(row.understanding).toBe('旧认知');
    expect(row.readme_summary).toBe('旧简介');
  });

  test('buildDigest 抛错 → status=error', async () => {
    const db = setup();
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => {
        throw new Error('locate 炸了');
      },
      runSummary: async (): Promise<RunSummaryResult> => ({ ok: true, understanding: 'x' }),
    });
    orch.start(proj(db), 'claude');
    await orch.wait(1);
    const row = statusRow(db);
    expect(row.summary_status).toBe('error');
    expect(row.summary_error).toContain('locate 炸了');
  });

  test('单飞防重入：进行中再 start 返回 busy，不重复落库', async () => {
    const db = setup();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => 'h',
      runSummary: async (): Promise<RunSummaryResult> => {
        runs++;
        await gate; // 挂起，模拟长任务
        return { ok: true, understanding: 'done' };
      },
    });

    const first = orch.start(proj(db), 'claude');
    const second = orch.start(proj(db), 'codex');
    expect(first).toEqual({ started: true });
    expect(second).toEqual({ started: false, reason: 'busy' });

    release();
    await orch.wait(1);
    expect(runs).toBe(1); // 第二次没触发
    expect(statusRow(db).summary_status).toBe('done');

    // 解锁后可再次启动
    expect(orch.start(proj(db), 'claude')).toEqual({ started: true });
    await orch.wait(1);
  });

  test('resetStale：把卡在 running 的翻成 error', async () => {
    const db = setup();
    db.run(`UPDATE projects SET summary_status='running' WHERE id=1`);
    const orch = new SummaryOrchestrator({
      db,
      buildDigest: async () => 'h',
      runSummary: async (): Promise<RunSummaryResult> => ({ ok: true, understanding: 'x' }),
    });
    const n = orch.resetStale();
    expect(n).toBe(1);
    const row = statusRow(db);
    expect(row.summary_status).toBe('error');
    expect(row.summary_error).toContain('重启');
  });
});

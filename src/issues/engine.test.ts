import { afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { UserStore } from '../core/users';
import { ConversationManager } from '../core/conversations';
import { LocalDriver } from '../executor/local';
import { gitLockKey, KeyedMutex, tmuxLockKey } from './mutex';
import { ModuleManager, ModuleStore } from './modules';
import { MAX_TEST_FAILURES, transition } from './machine';
import { BUSY_STATES } from './queue';
import type { Project, ProjectModule } from '../core/types';
import {
  buildResultSummaryPrompt,
  DEFAULT_ENGINE_CONFIG,
  formatClarifyAppend,
  IssueEngine,
  MAX_AGENT_RESTARTS,
  migrateIssueEngine,
  resultSummaryPaths,
  RESULT_SUMMARY_SCRATCH_BASE,
  type EngineClarifyInput,
  type EngineClarifyResult,
  type EngineConfig,
  type EngineNotifyEvent,
  type EngineDoneJudgement,
  type EngineMergeCandidate,
  type EngineMergeGroup,
  type EngineDeps,
} from './engine';

// ---------- 假 Driver：文件/git 走真 fs（LocalDriver），tmux 进内存录制 ----------

class FakeDriver extends LocalDriver {
  tmuxSessions = new Set<string>();
  sent: Array<{ session: string; text: string }> = [];
  keys: Array<{ session: string; key: string }> = [];
  executables = new Map([
    ['claude', 'claude'],
    ['codex', 'codex'],
  ]);
  pane = '';
  /** 每会话的 #{pane_current_command}（不设 = 老实现/解析失败，判活退化成只看屏） */
  paneCommands = new Map<string, string>();
  /** listSessions 调用次数（issue #97：健康路径必须零额外 tmux 调用） */
  listCalls = 0;
  override async findExecutable(agent: 'claude' | 'codex') {
    return this.executables.get(agent) ?? null;
  }
  override async listSessions() {
    this.listCalls++;
    return [...this.tmuxSessions].map((name) => {
      const command = this.paneCommands.get(name);
      return { name, createdTs: 0, attached: false, ...(command ? { command } : {}) };
    });
  }
  override async createSession(name: string, _cwd: string) {
    this.tmuxSessions.add(name);
  }
  override async killSession(name: string) {
    if (!this.tmuxSessions.delete(name)) throw new Error('no session');
  }
  override async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  override async sendKey(session: string, key: string) {
    this.keys.push({ session, key });
  }
  override async capturePane(_session: string) {
    return this.pane;
  }
  prompts(): string[] {
    return this.sent.map((s) => s.text).filter((t) => !t.startsWith('claude '));
  }
}

// ---------- jsonl 帮手 ----------

function asst(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}
function toolResult(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: text }] } });
}
function userText(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
}

async function flushMicrotasks(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ---------- 环境 ----------

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('issue 引擎迁移', () => {
  test('036 为存量 issue 增加 nullable 目标分支/源 ref，重复迁移幂等', () => {
    const db = openDb(':memory:');
    migrate(db);
    const users = new UserStore(db);
    const owner = users.create('migration-owner');
    db.run(
      `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('local', '127.0.0.1', 22, 'root', '', '/workspace', '/claude')`,
    );
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts)
       VALUES ('demo', 1, '/workspace/demo', ?, 1)`,
    ).run(owner.user.id);
    db.run(`INSERT INTO issues (project_id, title, created_ts) VALUES (1, 'legacy', 1)`);

    const first = migrateIssueEngine(db);
    const second = migrateIssueEngine(db);
    expect(first.applied.filter((id) => id >= 30 && id < 40)).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
    expect(second).toEqual(first);
    const columns = db
      .query<{ name: string }, []>('PRAGMA table_info(issues)')
      .all()
      .map((c) => c.name);
    expect(columns).toContain('target_branch');
    expect(columns).toContain('source_ref');
    expect(
      db.query<{ target_branch: string | null; source_ref: string | null }, []>(
        `SELECT target_branch, source_ref FROM issues WHERE title = 'legacy'`,
      ).get(),
    ).toEqual({ target_branch: null, source_ref: null });
    db.close();
  });
});

async function setup(opts: {
  clarify?: (project: Project, input: EngineClarifyInput) => Promise<EngineClarifyResult>;
  organize?: EngineDeps['organize'];
  config?: Partial<EngineConfig>;
  modulesFor?: EngineDeps['modulesFor'];
  onNotify?: (event: EngineNotifyEvent) => void | Promise<void>;
} = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'butler2-engine-'));
  cleanups.push(() => fsp.rm(dir, { recursive: true, force: true }));

  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db); // 030：module/impl_mode 列 + project_active_conv
  const users = new UserStore(db);
  const { user: admin } = users.create('admin', 'admin');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', 'k', '${dir}/ws', '${dir}/claude')`,
  );

  // 真 git 仓库（分支流要真验证）
  const repo = path.join(dir, 'repo');
  await fsp.mkdir(repo, { recursive: true });
  const driver = new FakeDriver();
  const g = (args: string[]) => driver.git(repo, args);
  await g(['init']);
  await g(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await g(['config', 'user.email', 't@t']);
  await g(['config', 'user.name', 't']);
  await fsp.writeFile(path.join(repo, 'README.md'), 'hello\n');
  await g(['add', '.']);
  await g(['commit', '-m', 'init']);

  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
     VALUES (?, 1, ?, ?, ?, ?)`,
  ).run('demo', repo, admin.id, '演示项目', Date.now());
  const projectId = 1;
  // 测试基线用「手动确认」模式（保留卡点老流程的既有用例）；自动流单测用 setManualReview(false)
  const setManualReview = (on: boolean) =>
    db.query('UPDATE projects SET manual_review = ? WHERE id = ?').run(on ? 1 : 0, projectId);
  setManualReview(true);

  const jsonl = new Map<string, string>();
  const locator = {
    /** 测试钩子：reclaim 命中的新 jsonl 路径（null = 无候选，reclaim 落空） */
    reclaimTo: null as string | null,
    reclaimCalls: 0,
    async locate(id: string) {
      const p = jsonl.get(id);
      if (!p) return null;
      try {
        await fsp.stat(p);
        return p;
      } catch {
        return null;
      }
    },
    async reclaim(id: string) {
      locator.reclaimCalls++;
      if (!locator.reclaimTo) return null;
      jsonl.set(id, locator.reclaimTo); // 模拟真 locator 的重绑回填
      return locator.reclaimTo;
    },
  };
  const convs = new ConversationManager(db, driver, locator);

  const pm = {
    questions: null as string[] | null,
    judgement: 'not_done' as EngineDoneJudgement,
    judgeCalls: 0,
    /** 测试注入的合并计划：id 组 → 合并后 title/body（默认不合并） */
    merges: [] as EngineMergeGroup[],
    mergeCalls: [] as Array<{ module: string; ids: number[] }>,
    async judgeDone() {
      pm.judgeCalls++;
      return pm.judgement;
    },
    async generateClarifyingQuestions() {
      return pm.questions;
    },
    async mergeModuleTasks(module: string, candidates: EngineMergeCandidate[]): Promise<EngineMergeGroup[]> {
      pm.mergeCalls.push({ module, ids: candidates.map((c) => c.id) });
      // 只回给定候选里都存在的合并组（模拟 LLM 保守）
      const ids = new Set(candidates.map((c) => c.id));
      return pm.merges.filter((g) => g.members.every((m) => ids.has(m)));
    },
  };

  const notifications: EngineNotifyEvent[] = [];
  const notify = {
    async dispatch(e: EngineNotifyEvent) {
      notifications.push(e);
      await opts.onNotify?.(e);
    },
  };

  let fakeNow = Date.now();
  const clock = {
    now: () => fakeNow,
    advance(ms: number) {
      fakeNow += ms;
    },
  };

  const mutex = new KeyedMutex();
  const engine = new IssueEngine({
    db,
    driver,
    convs,
    locator,
    pmFor: () => pm,
    notify,
    mutex,
    ...(opts.modulesFor ? { modulesFor: opts.modulesFor } : {}),
    ...(opts.clarify ? { clarify: opts.clarify } : {}),
    ...(opts.organize ? { organize: opts.organize } : {}),
    // 结果总结默认关（假时钟 + 真轮询会死等；专项测试经 opts.config 显式开）
    config: { kickoffMinBootMs: 0, now: clock.now, resultSummaryTimeoutMs: 0, ...(opts.config ?? {}) },
  });

  /** 给 issue 的 conv 建 jsonl 并登记 */
  async function bindJsonl(issueId: number): Promise<string> {
    const convId = engine.store.get(issueId)!.convId!;
    const p = path.join(dir, `${convId}.jsonl`);
    await fsp.writeFile(p, '');
    jsonl.set(convId, p);
    return p;
  }
  async function appendOutput(jsonlPath: string, ...lines: string[]) {
    await fsp.appendFile(jsonlPath, lines.map((l) => l + '\n').join(''));
  }

  return { dir, db, users, admin, repo, driver, convs, jsonl, locator, pm, notifications, clock, engine, mutex, projectId, setManualReview, bindJsonl, appendOutput, g };
}

// ---------- chat 项目守卫（009） ----------

describe('对话模式项目守卫', () => {
  test('kind=chat 的项目不允许 createIssue（引擎抛错）', async () => {
    const s = await setup();
    s.db.query('UPDATE projects SET kind = ? WHERE id = ?').run('chat', s.projectId);
    await expect(s.engine.createIssue(s.projectId, { title: '本不该建的 issue' })).rejects.toThrow(
      /对话模式/,
    );
    // 且没有 issue 落库
    expect(s.engine.store.listByProject(s.projectId)).toHaveLength(0);
  });
});

// ---------- 全链路 ----------

describe('引擎全链路：pending→planning→卡点①→implementing→testing→卡点②→merging→done', () => {
  test('主干快乐路径（含 git 分支流 / gate / 队列接力 / kickoff 幂等）', async () => {
    const s = await setup();
    const { engine, driver, notifications } = s;

    // 建 issue（task，PM 判不含糊 → 跳过 clarifying 直进 planning）
    const issue = await engine.createIssue(s.projectId, {
      title: '加导出功能',
      body: '支持 CSV',
      module: 'export',
      createdBy: s.admin.id,
    });
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.get(issue.id)!.convId).toBeTruthy();
    // 对话被激活：claude --session-id 已注入
    expect(driver.sent.some((x) => x.text.startsWith('claude --session-id'))).toBe(true);

    const jl = await s.bindJsonl(issue.id);

    // tick → kickoff planning prompt（幂等：第二次 tick 不重发）
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
    const sentAfterKick = driver.sent.length;
    await engine.tick();
    expect(driver.sent.length).toBe(sentAfterKick);

    // 引擎重启（同 DB 新实例）也不重发 —— 判据在 issue_events
    const engine2 = new IssueEngine({
      db: s.db,
      driver,
      convs: s.convs,
      locator: { locate: (id) => s.jsonl.get(id) ? Promise.resolve(s.jsonl.get(id)!) : Promise.resolve(null) },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
    });
    await engine2.tick();
    expect(driver.sent.length).toBe(sentAfterKick);

    // CC 输出计划块 → plan_review + 卡点①
    await s.appendOutput(jl, asst('拆解：\nSUBTASKS_BEGIN\n1. 写导出器\n2. 加测试\nSUBTASKS_END'));
    await engine.tick();
    let cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('plan_review');
    expect(engine.store.subtasksOf(cur).map((x) => x.text)).toEqual(['写导出器', '加测试']);
    const gates = engine.store.listGates(issue.id);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.kind).toBe('plan');
    expect(gates[0]!.status).toBe('waiting');
    expect(notifications.some((n) => n.kind === 'gate_waiting')).toBe(true);

    // 卡点① approve → implementing。引擎不建/不切分支：只记下开发者当前所在分支（此仓库在 main）
    const r1 = await engine.decideGate(gates[0]!.id, s.admin.id, 'approve');
    expect(r1.ok).toBe(true);
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('implementing');
    expect(cur.branch).toBe('main');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe(''); // 绝不建 issue/<id>

    // 同一卡点不能二次决定（waiting→decided CAS 防重放）
    expect((await engine.decideGate(gates[0]!.id, s.admin.id, 'approve')).ok).toBe(false);

    // tick → 喂子任务 1
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes('【实施 子任务 1/2】') && t.includes(`SUBTASK_DONE:${issue.id}`))).toBe(true);

    // 分支上做点真实改动（merge 才有内容）
    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: export']);

    // 同一批两个 SUBTASK_DONE（v1 布尔丢 DONE 的修复验证）→ 全部完成 → testing
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}\n继续\nSUBTASK_DONE:${issue.id}`));
    await engine.tick();
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('testing');
    expect(cur.subIndex).toBe(2);

    // tick → testing prompt
    await engine.tick();
    expect(driver.prompts().some((t) => t.includes(`STAGE_DONE:${issue.id}:testing`))).toBe(true);

    // 错 id / 错 stage / tool_result 里的哨兵全都不推进
    await s.appendOutput(
      jl,
      asst(`STAGE_DONE:999:testing`),
      asst(`STAGE_DONE:${issue.id}:implementing`),
      toolResult(`STAGE_DONE:${issue.id}:testing`),
      asst(`我完成后会输出 STAGE_DONE:${issue.id}:testing 这行`),
    );
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');

    // 排队第二条 issue：项目忙 → 保持 pending
    const issue2 = await engine.createIssue(s.projectId, { title: '修样式', module: 'export' });
    expect(engine.store.get(issue2.id)!.status).toBe('pending');

    // 正确哨兵 → merge_review + 卡点②（payload 带 diff / 本 issue 的 commit ids）
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('merge_review');
    const gate2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(gate2.payloadJson!) as {
      diff: string; branch: string; base: string; commits?: Array<{ subject: string }>;
    };
    expect(payload.branch).toBe('main'); // 改动就落在开发者的分支上（此处 main）
    expect(payload.diff).toContain('export.ts');
    expect(payload.commits!.some((c) => c.subject.includes('feat: export'))).toBe(true);

    // 卡点② approve → merging（引擎不做本地合并，直接放行）→ done + done_ts + 通知 + 接力 issue2
    const r2 = await engine.decideGate(gate2.id, s.admin.id, 'approve');
    expect(r2.ok).toBe(true);
    cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('done');
    expect(cur.doneTs).toBeGreaterThan(0);
    expect(notifications.some((n) => n.kind === 'issue_done' && n.issueId === issue.id)).toBe(true);
    // 改动就在 main 上（直接提交，无本地 merge 提交）；仍停在 main，不建 issue 分支
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.stat(path.join(s.repo, 'export.ts')).then(() => true, () => false)).toBe(true);
    expect((await s.g(['log', '--oneline', '-1'])).out).toContain('feat: export');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
    // 队列接力：issue2 自动开跑
    expect(engine.store.get(issue2.id)!.status).toBe('planning');

    // 全量时间线落了关键事件
    const kinds = engine.store.listEvents(issue.id).map((e) => e.kind);
    for (const k of ['created', 'transition', 'injected', 'sentinel', 'subtask_done', 'gate_created', 'gate_decided']) {
      expect(kinds).toContain(k);
    }
  }, 30000);
});

describe('卡点 reject 回退', () => {
  test('卡点① reject（带意见）→ 回 planning，重排 prompt 带意见', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 A' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    expect((await engine.applyEvent(issue.id, 'plan_ready')).ok).toBe(true);
    const gate = engine.store.listGates(issue.id)[0]!;

    // reject 必须带意见
    expect((await engine.decideGate(gate.id, s.admin.id, 'reject')).ok).toBe(false);
    const r = await engine.decideGate(gate.id, s.admin.id, 'reject', '第 2 步拆太粗');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 回炉 kickoff：planning prompt 带驳回意见
    await engine.tick();
    const rework = s.driver.prompts().filter((t) => t.includes('驳回'));
    expect(rework.length).toBe(1);
    expect(rework[0]).toContain('第 2 步拆太粗');
  });

  test('卡点② reject → 回 implementing，返工 prompt 带 review 意见', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 B' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    await engine.applyEvent(issue.id, 'tests_passed');
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');
    const gate = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const r = await engine.decideGate(gate.id, s.admin.id, 'reject', '命名不符合规范');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    await engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('【返工】') && t.includes('命名不符合规范'))).toBe(true);
  });
});

describe('testing 失败回退计数（≤3 回 implementing，超限 blocked）', () => {
  test('TESTS_FAILED ×4 → 第 4 次 blocked（failCount 从 issue_events 数）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 C' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    for (let round = 1; round <= 4; round++) {
      expect(engine.store.get(issue.id)!.status).toBe('testing');
      await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 第 ${round} 轮挂了`));
      await engine.tick();
      const st = engine.store.get(issue.id)!.status;
      if (round <= 3) {
        expect(st).toBe('implementing');
        await engine.applyEvent(issue.id, 'impl_done'); // 回到 testing 再来一轮
      } else {
        expect(st).toBe('blocked');
      }
    }
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(4);
    expect(s.notifications.some((n) => n.kind === 'issue_blocked' && n.issueId === issue.id)).toBe(true);
    // blocked 后 unblock 重新入队
    const r = await engine.unblockIssue(issue.id, s.admin.id);
    expect(r.ok).toBe(true);
  });
});

describe('默认自动流：manual_review 关闭时计划卡点自动放行', () => {
  test('plan_ready 不建卡点：auto_approved 事件 + 直接 implementing + 通知', async () => {
    const s = await setup();
    s.setManualReview(false); // 生产默认：全自动流
    const issue = await s.engine.createIssue(s.projectId, { title: '自动流任务', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['步骤一', '步骤二']);

    const r = await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(r.ok).toBe(true);
    // 不停在 plan_review：直接进 implementing，无卡点
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.store.listGates(issue.id)).toHaveLength(0);
    // 审计事件 + 自动确认通知
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_approved' && (e.dataJson ?? '').includes('"plan"'))).toBe(true);
    expect(s.notifications.some((n) => n.summary?.includes('计划自动确认'))).toBe(true);
    expect(s.notifications.some((n) => n.kind === 'gate_waiting')).toBe(false);
    // 起点 commit 照记（impl_base）
    expect(evs.some((e) => e.kind === 'impl_base')).toBe(true);
  });

  test('manual_review 开启：保留 plan_review 卡点等人批', async () => {
    const s = await setup(); // setup 基线即手动模式
    const issue = await s.engine.createIssue(s.projectId, { title: '手动流任务' });
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(s.engine.store.get(issue.id)!.status).toBe('plan_review');
    expect(s.engine.store.listGates(issue.id)).toHaveLength(1);
  });

  test('tests_passed 自动收尾：add+commit「<标题> (#id)」，push 失败只记事件不挡 done', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '导出功能', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready'); // 自动 → implementing（记 impl_base）
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');

    // 工作树留下未提交改动 → 自动收尾要替我们 commit
    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export const x = 1;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    const cur = s.engine.store.get(issue.id)!;
    expect(cur.status).toBe('done'); // 无 origin：push 失败也不挡完成
    expect(s.engine.store.listGates(issue.id)).toHaveLength(0); // 不建 merge_review 卡点
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_approved' && (e.dataJson ?? '').includes('merge_review'))).toBe(true);
    expect(evs.some((e) => e.kind === 'auto_commit' && (e.dataJson ?? '').includes(`(#${issue.id})`))).toBe(true);
    expect(evs.some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('auto_push'))).toBe(true);
    expect(s.notifications.some((n) => n.summary?.includes('自动 push 失败'))).toBe(true);
    // commit 真实落库且在本 issue 范围内（impl_commits 快照含自动提交）
    const log = await s.g(['log', '-1', '--pretty=%s']);
    expect(log.out.trim()).toBe(`导出功能 (#${issue.id})`);
    const snap = s.engine.implCommits(issue.id)!;
    expect(snap.commits.some((c) => c.subject.includes(`(#${issue.id})`))).toBe(true);
    expect(snap.files.some((f) => f.path === 'export.ts')).toBe(true);
  });

  test('tests_passed 自动收尾：有 origin 时 push 成功（auto_push 事件 + 远端可见）', async () => {
    const s = await setup();
    s.setManualReview(false);
    // 造 bare 远端并接为 origin
    const origin = path.join(s.dir, 'origin.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);

    const issue = await s.engine.createIssue(s.projectId, { title: '推远端', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'push.ts'), 'export const y = 2;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(true);
    expect(evs.some((e) => e.kind === 'error')).toBe(false);
    // 远端 main 与本地 HEAD 一致
    const localHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    const remoteHead = (await s.driver.git(origin, ['rev-parse', 'main'])).out.trim();
    expect(remoteHead).toBe(localHead);
  });

  test('无业务改动但启动生成 agent 指引：提交项目级指引并推送', async () => {
    const s = await setup();
    s.setManualReview(false);
    const origin = path.join(s.dir, 'origin2.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);

    const issue = await s.engine.createIssue(s.projectId, { title: '干净收尾', module: 'auto' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['做完']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed'); // 工作树干净

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    const evs = s.engine.store.listEvents(issue.id);
    expect(evs.some((e) => e.kind === 'auto_commit')).toBe(true); // AGENTS.md / CLAUDE.md 是项目约束
    expect(evs.some((e) => e.kind === 'auto_push')).toBe(true); // 但照样推
  });
});

describe('正式模块绑定', () => {
  const mod = (id: number, slug: string, agent: 'claude' | 'codex'): ProjectModule => ({
    id,
    projectId: 1,
    slug,
    displayName: slug,
    agent,
    source: 'manual',
    status: 'active',
    conversationId: null,
    syncStatus: 'ready',
    syncError: null,
    createdBy: 1,
    createdTs: 1,
    lastUsedTs: null,
  });

  test('创建写 module_id 且采用模块固定代理；只有 pending 能换模块', async () => {
    const recorded: Array<{ moduleId: number; issueId: number }> = [];
    let selected = mod(11, 'export-tools', 'codex');
    const s = await setup({
      modulesFor: () => ({
        resolve: async () => selected,
        recordIssue: async (module, issue) => {
          recorded.push({ moduleId: module.id, issueId: issue.id });
        },
      }),
    });
    s.db.query(
      `INSERT INTO project_modules
         (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (11, ?, 'export-tools', 'export-tools', 'codex', 'manual', ?, 1),
              (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id, s.projectId, s.admin.id);
    const issue = await s.engine.createIssue(
      s.projectId,
      { title: '导出', moduleName: '数据导出', agent: 'claude' },
      false,
    );
    expect(issue.moduleId).toBe(11);
    expect(issue.module).toBe('export-tools');
    expect(issue.agent).toBe('codex');

    selected = mod(12, 'billing-core', 'claude');
    const moved = await s.engine.changePendingModule(issue.id, { moduleId: 12 });
    expect(moved.moduleId).toBe(12);
    expect(moved.agent).toBe('claude');
    expect(recorded).toEqual([
      { moduleId: 11, issueId: issue.id },
      { moduleId: 12, issueId: issue.id },
    ]);

    await s.engine.startIssue(issue.id);
    const running = s.engine.store.get(issue.id)!;
    const moduleConv = s.db
      .query<{ conversation_id: string }, [number]>(
        'SELECT conversation_id FROM project_modules WHERE id = ?',
      )
      .get(12)!.conversation_id;
    expect(running.convId).toBe(moduleConv);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(true);
    // 已开跑的仍然不许换模块（#93 只放宽到 cancelled，驱动中一律拒）
    await expect(s.engine.changePendingModule(issue.id, { moduleId: 11 })).rejects.toThrow(
      /只有待办或已取消/,
    );

    const next = await s.engine.createIssue(s.projectId, { title: '同模块后续', moduleId: 12 }, false);
    await s.engine.cancelIssue(issue.id, s.admin.id);
    expect(s.engine.store.get(next.id)!.convId).toBe(moduleConv);
    await s.engine.cancelIssue(next.id, s.admin.id);
    expect(s.driver.tmuxSessions.has('cc-1-m-billing-core')).toBe(false);
    expect(s.engine.store.listEvents(next.id).some((e) => e.kind === 'module_sleep')).toBe(true);
  });

  test('blocked 的 issue 占着模块会话时，同模块下一条仍能开跑并复用同一条会话', async () => {
    // 模块会话按设计被同模块 issue 顺序复用；blocked 既不在 BUSY_STATES 里（项目不算忙、
    // 下一条会被挑起来）、进 blocked 也不清 conv_id ——setConv 的「一 conv 一 issue」守卫
    // 若不为模块会话开洞，一条 blocked 就把整个模块永久卡死。
    const selected = mod(12, 'billing-core', 'claude');
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => selected, recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const first = await s.engine.createIssue(s.projectId, { title: '先跑这条', moduleId: 12 }, false);
    await s.engine.startIssue(first.id);
    const moduleConv = s.db
      .query<{ conversation_id: string }, [number]>('SELECT conversation_id FROM project_modules WHERE id = ?')
      .get(12)!.conversation_id;
    expect(s.engine.store.get(first.id)!.convId).toBe(moduleConv);

    const next = await s.engine.createIssue(s.projectId, { title: '同模块后续', moduleId: 12 }, false);
    // 第一条卡住进 blocked（例：tests_failed 累计超限）——它仍持有模块会话
    await s.engine.applyEvent(first.id, 'block');
    expect(s.engine.store.get(first.id)!.status).toBe('blocked');
    expect(s.engine.store.get(first.id)!.convId).toBe(moduleConv);

    // blocked 的 onEnter 会接力 scheduleNext：下一条必须已开跑且绑在同一条模块会话上
    expect(s.engine.store.get(next.id)!.convId).toBe(moduleConv);
    expect(s.engine.store.get(next.id)!.status).not.toBe('pending');
    // 且不能留下「对话已绑定未关闭 issue」这类接力失败记录
    expect(
      s.engine.store.listEvents(next.id).filter((e) => e.kind === 'error'),
    ).toEqual([]);

    const firstEvents = s.engine.store.listEvents(first.id);
    const nextEvents = s.engine.store.listEvents(next.id);
    expect(firstEvents.some((e) => e.kind === 'conversation_segment_started')).toBe(true);
    expect(firstEvents.some((e) => e.kind === 'conversation_segment_ended')).toBe(true);
    expect(nextEvents.some((e) => e.kind === 'conversation_segment_started')).toBe(true);

    const segments = s.engine.store.listConversationSegments(moduleConv);
    expect(segments.map((x) => ({ issueId: x.issueId, title: x.title, endTs: x.endTs }))).toEqual([
      { issueId: first.id, title: '先跑这条', endTs: expect.any(Number) },
      { issueId: next.id, title: '同模块后续', endTs: null },
    ]);
  });

  test('模块会话的复用豁免不扩散：非模块会话仍独占，占用者在驱动中也照样拒绝', async () => {
    // setConv 的独占守卫只对「模块会话 + 占用者已停驱动」开洞，其余一律维持原样，
    // 否则 debug/项目对话会被两条 issue 同时抢。
    const s = await setup({ modulesFor: () => ({ resolve: async () => mod(12, 'billing-core', 'claude'), recordIssue: async () => {} }) });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    const a = await s.engine.createIssue(s.projectId, { title: 'A', moduleId: 12 }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', moduleId: 12 }, false);

    // ① 非模块会话（未登记在 project_modules 上）：blocked 占用者也不放行
    const loose = s.convs.create(s.projectId, 'debug-conv', 'claude');
    s.engine.store.setConv(a.id, loose.id);
    s.db.query(`UPDATE issues SET status = 'blocked' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, loose.id)).toThrow(/对话已绑定未关闭/);

    // ② 模块会话但占用者仍在驱动中：拒绝（同时只能有一条在跑）
    const modConv = s.convs.create(s.projectId, 'module:billing-core', 'claude');
    s.db.query('UPDATE project_modules SET conversation_id = ? WHERE id = 12').run(modConv.id);
    s.engine.store.setConv(a.id, modConv.id);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, modConv.id)).toThrow(/对话已绑定未关闭/);

    // ③ 同一条模块会话，占用者停驱动后放行
    s.db.query(`UPDATE issues SET status = 'blocked' WHERE id = ?`).run(a.id);
    expect(() => s.engine.store.setConv(b.id, modConv.id)).not.toThrow();
  });

  test('绑会话失败落回 {ok:false} 而不是抛穿 applyEvent——接力记错继续，队列不冻', async () => {
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({ resolve: async () => mod(12, 'billing-core', 'claude'), recordIssue: async () => {} }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (12, ?, 'billing-core', 'billing-core', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id);

    // 造一条「模块会话被另一个项目里仍在驱动的 issue 攥着」的坏现场（跨项目 setConv 守卫是全局的）
    const conv = s.convs.create(s.projectId, 'module:billing-core', 'claude');
    s.db.query('UPDATE project_modules SET conversation_id = ? WHERE id = 12').run(conv.id);
    s.db.query(
      `INSERT INTO projects (id, name, executor_id, cwd, owner_user_id, created_ts)
       VALUES (99, 'other', 1, ?, ?, 1)`,
    ).run(s.repo, s.admin.id);
    s.db.run(
      `INSERT INTO issues (id, project_id, title, category, module, impl_mode, agent, status, conv_id, created_by, created_ts)
       VALUES (900, 99, '别项目占着', 'task', 'x', 'seq', 'claude', 'implementing', ?, ?, 1)`,
      [conv.id, s.admin.id],
    );

    const issue = await s.engine.createIssue(s.projectId, { title: '起不来的一条', moduleId: 12 }, false);
    const r = await s.engine.startIssue(issue.id);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/绑定会话失败/);
    expect(s.engine.store.get(issue.id)!.status).toBe('pending'); // 没被半开跑卡住

    // 关键：done/blocked 接力路径上也不能把 applyEvent 打挂
    const trigger = await s.engine.createIssue(s.projectId, { title: '触发接力', moduleId: 12 }, false);
    await s.engine.applyEvent(trigger.id, 'cancel'); // cancel 的 onEnter 同样走 scheduleNext
    expect(s.engine.store.get(trigger.id)!.status).toBe('cancelled');
    expect(
      s.engine.store.listEvents(issue.id).some((e) => e.kind === 'error'),
    ).toBe(true); // 接力失败有留痕
  });

  test('接力优先同模块按 module_id 判定——module 文本列与 slug 不同步也不影响', async () => {
    // 035 回填留下的旧文本会让「同模块连着跑」失效：接力优先必须按模块键（module_id）命中。
    const mods = new Map([
      [11, mod(11, 'alpha', 'claude')],
      [12, mod(12, 'beta', 'claude')],
    ]);
    const s = await setup({
      config: { resultSummaryTimeoutMs: 0 },
      modulesFor: () => ({
        resolve: async (input) => mods.get(input.moduleId!)!,
        recordIssue: async () => {},
      }),
    });
    s.db.query(
      `INSERT INTO project_modules (id, project_id, slug, display_name, agent, source, created_by, created_ts)
       VALUES (11, ?, 'alpha', 'alpha', 'claude', 'manual', ?, 1),
              (12, ?, 'beta', 'beta', 'claude', 'manual', ?, 1)`,
    ).run(s.projectId, s.admin.id, s.projectId, s.admin.id);

    // 模块 12 有一条最早的 pending（不接力时它会被 FIFO/模块排位挑走）
    const other = await s.engine.createIssue(s.projectId, { title: '别的模块更早', moduleId: 12 }, false);
    const running = await s.engine.createIssue(s.projectId, { title: '模块 11 第一条', moduleId: 11 }, false);
    const sibling = await s.engine.createIssue(s.projectId, { title: '模块 11 第二条', moduleId: 11 }, false);
    // 模拟 035 遗留：模块 11 的 issue 文本列还是旧显示名，与 slug 不同步
    s.db.query(`UPDATE issues SET module = '需求' WHERE module_id = 11`).run();

    await s.engine.startIssue(running.id);
    await s.engine.applyEvent(running.id, 'block'); // done/blocked 都走同一条接力

    // 接力必须留在模块 11 → 挑中 sibling，而不是更早的 other
    expect(s.engine.store.get(sibling.id)!.status).not.toBe('pending');
    expect(s.engine.store.get(other.id)!.status).toBe('pending');
  });

  test('mergeModules：issues 两列重指、pending 未绑会话换代理、来源归档留会话、拒绝执行中来源', async () => {
    let manager: ModuleManager;
    const pages: string[] = [];
    const indexRefreshes: string[][] = [];
    const s = await setup({ modulesFor: () => manager });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('显式 moduleId 不应咨询分类器');
      },
      docs: {
        async ensureModule() {},
        async refreshIndex(list) {
          indexRefreshes.push(list.map((m) => m.slug));
        },
        async createIssuePage(module, issue) {
          pages.push(`${module.slug}#${issue.id}`);
          return `.butler/modules/${module.slug}/issues/${issue.id}-x.md`;
        },
        async refreshIssueIndex() {},
      },
    });
    const target = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: 'Issue 引擎',
      agent: 'claude',
      source: 'legacy',
    });
    const source = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-two',
      displayName: '旧模块二',
      agent: 'codex',
      source: 'legacy',
    });
    s.db.run(
      `INSERT INTO conversations (id, project_id, label, created_ts, agent, kind)
       VALUES ('conv-src', 1, 'src', 1, 'codex', 'issue'), ('conv-d', 1, 'd', 1, 'codex', 'issue')`,
    );
    moduleStore.setConversation(source.id, 'conv-src');

    const mk = (title: string) =>
      s.engine.createIssue(s.projectId, { title, moduleId: source.id }, false);
    const a = await mk('甲');
    const b = await mk('乙');
    const c = await mk('丙');
    const d = await mk('丁');
    const setStatus = (id: number, st: string) =>
      s.db.query('UPDATE issues SET status = ? WHERE id = ?').run(st, id);
    setStatus(b.id, 'done');
    setStatus(c.id, 'implementing');
    s.engine.store.setConv(d.id, 'conv-d');

    // 来源有执行中 issue → 整体拒绝，一切未动
    await expect(s.engine.mergeModules(s.projectId, [source.id], target.id)).rejects.toThrow(/执行中/);
    expect(moduleStore.get(source.id)!.status).toBe('active');
    expect(s.engine.store.get(a.id)!.moduleId).toBe(source.id);

    setStatus(c.id, 'done');
    const r = await s.engine.mergeModules(s.projectId, [source.id], target.id);
    expect([...r.movedIssueIds].sort((x, y) => x - y)).toEqual([a.id, b.id, c.id, d.id]);
    expect(r.target.id).toBe(target.id);

    // pending 未绑会话：两列重指 + 代理翻成目标模块代理
    expect(s.engine.store.get(a.id)!).toMatchObject({
      module: 'issue-engine',
      moduleId: target.id,
      agent: 'claude',
    });
    // 非 pending：重指但不翻代理
    expect(s.engine.store.get(b.id)!).toMatchObject({ moduleId: target.id, agent: 'codex' });
    // pending 已绑会话：保持原代理与会话（在途上下文不脚下换）
    expect(s.engine.store.get(d.id)!).toMatchObject({
      moduleId: target.id,
      agent: 'codex',
      convId: 'conv-d',
    });
    // 来源归档、会话留档不迁移
    expect(moduleStore.get(source.id)!).toMatchObject({ status: 'archived', conversationId: 'conv-src' });
    // 每条被移 issue 记 module_changed(via merge)
    const ev = s.engine.store.listEvents(a.id).find((e) => e.kind === 'module_changed');
    expect(ev?.dataJson).toContain('"via":"merge"');
    expect(ev?.dataJson).toContain(`"fromModuleId":${source.id}`);
    // 目标目录补建全部过程页；INDEX 刷新后只剩目标
    expect(pages.filter((p) => p.startsWith('issue-engine#')).length).toBe(4);
    expect(indexRefreshes.at(-1)).toEqual(['issue-engine']);
  });

  test('智能整理：触发→方案清洗落事件→逐项执行 create/rename/merge/move + 防重放 + 单飞', async () => {
    let manager: ModuleManager;
    const renameDirs: Array<{ from: string; to: string }> = [];
    let plan = '';
    const organizeCalls: Array<{ agent: string; issues: number }> = [];
    const s = await setup({
      modulesFor: () => manager,
      organize: async (_p, input) => {
        organizeCalls.push({ agent: input.agent, issues: input.issues.length });
        return { ok: true, planText: plan };
      },
    });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('显式 moduleId 不应咨询分类器');
      },
      docs: {
        async ensureModule() {},
        async refreshIndex() {},
        async createIssuePage(module, issue) {
          return `.butler/modules/${module.slug}/issues/${issue.id}-x.md`;
        },
        async refreshIssueIndex() {},
        async renameDir(module, newSlug) {
          renameDirs.push({ from: module.slug, to: newSlug });
        },
      },
    });
    const m1 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-01',
      displayName: 'Git 页面',
      agent: 'claude',
      source: 'legacy',
    });
    const m2 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-02',
      displayName: '执行',
      agent: 'claude',
      source: 'legacy',
    });
    const m3 = moduleStore.create({
      projectId: s.projectId,
      slug: 'legacy-module-03',
      displayName: '执行页面',
      agent: 'codex',
      source: 'legacy',
    });
    const a = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m1.id }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '乙', moduleId: m2.id }, false);
    const c = await s.engine.createIssue(s.projectId, { title: '丙', moduleId: m3.id }, false);
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('done', b.id);

    plan = JSON.stringify({
      actions: [
        { kind: 'rename', moduleId: m1.id, slug: 'git-pages', displayName: 'Git 页面', reason: '去序号' },
        { kind: 'merge', targetId: m2.id, sourceIds: [m3.id], reason: '同为执行域' },
        { kind: 'create', slug: 'file-preview', displayName: '文件预览', agent: 'claude', reason: '独立职责' },
        { kind: 'move', issueIds: [b.id], to: 'file-preview', reason: '归错类' },
        { kind: 'merge', targetId: 999, sourceIds: [m1.id], reason: '幻觉目标' }, // 清洗丢弃
      ],
    });
    const kicked = s.engine.organizeModules(s.projectId, 'claude');
    expect(kicked.ok).toBe(true);
    // 单飞：在途重复触发被拒
    expect(s.engine.organizeModules(s.projectId)).toMatchObject({ ok: false });
    expect(s.engine.organizeStatus(s.projectId).running).toBe(true);
    await s.engine.waitOrganize();
    expect(organizeCalls).toEqual([{ agent: 'claude', issues: 3 }]);

    const st = s.engine.organizeStatus(s.projectId);
    expect(st.running).toBe(false);
    expect(st.failed).toBeNull();
    expect(st.suggestion!.actions.length).toBe(4); // 幻觉 merge 被清洗
    expect(st.suggestion!.actions.map((x) => x.kind)).toEqual(['rename', 'merge', 'create', 'move']);
    expect(st.suggestion!.actions[1]).toMatchObject({ targetName: '执行', sourceNames: ['执行页面'] });
    expect(s.notifications.some((n) => n.summary?.includes('整理分析完成'))).toBe(true);

    // 逐项执行：rename → slug 三处同步（模块行 / 文档目录 / issues.module 文本列）
    expect((await s.engine.applyOrganizeAction(s.projectId, 0)).ok).toBe(true);
    expect(renameDirs).toEqual([{ from: 'legacy-module-01', to: 'git-pages' }]);
    expect(moduleStore.get(m1.id)!.slug).toBe('git-pages');
    expect(s.engine.store.get(a.id)!).toMatchObject({ module: 'git-pages', moduleId: m1.id });
    // 防重放
    expect(await s.engine.applyOrganizeAction(s.projectId, 0)).toMatchObject({
      ok: false,
      error: expect.stringContaining('已执行'),
    });

    // merge：沿用 mergeModules 全套语义（来源归档、issue 重指）
    expect((await s.engine.applyOrganizeAction(s.projectId, 1)).ok).toBe(true);
    expect(moduleStore.get(m3.id)!.status).toBe('archived');
    expect(s.engine.store.get(c.id)!.moduleId).toBe(m2.id);

    // move 依赖新模块：先跳过 create 直接 move → 明确报错；create 后 move 成功（done 也能挪）
    expect(await s.engine.applyOrganizeAction(s.projectId, 3)).toMatchObject({
      ok: false,
      error: expect.stringContaining('file-preview'),
    });
    expect((await s.engine.applyOrganizeAction(s.projectId, 2)).ok).toBe(true);
    const created = moduleStore.listByProject(s.projectId).find((m) => m.slug === 'file-preview')!;
    expect(created).toMatchObject({ displayName: '文件预览', agent: 'claude', source: 'manual' });
    expect((await s.engine.applyOrganizeAction(s.projectId, 3)).ok).toBe(true);
    expect(s.engine.store.get(b.id)!).toMatchObject({
      module: 'file-preview',
      moduleId: created.id,
      status: 'done',
      agent: 'claude', // 非 pending：挪模块不翻代理
    });
    const mv = s.engine.store.listEvents(b.id).find((e) => e.kind === 'module_changed');
    expect(mv?.dataJson).toContain('"via":"organize"');
    // applied 标记全量回放
    expect(s.engine.organizeStatus(s.projectId).suggestion!.actions.map((x) => x.applied)).toEqual([
      true, true, true, true,
    ]);
  });

  test('智能整理：分析失败落 module_organize_failed；驱动中 issue 拒绝挪模块', async () => {
    let manager: ModuleManager;
    const s = await setup({
      modulesFor: () => manager,
      organize: async () => ({ ok: false, reason: 'timeout' }),
    });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('不应咨询');
      },
      docs: { async ensureModule() {}, async refreshIndex() {} },
    });
    const m1 = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: 'Issue 引擎',
      agent: 'claude',
      source: 'legacy',
    });
    const m2 = moduleStore.create({
      projectId: s.projectId,
      slug: 'file-preview',
      displayName: '文件预览',
      agent: 'claude',
      source: 'manual',
    });
    const a = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m1.id }, false);
    expect(s.engine.organizeModules(s.projectId).ok).toBe(true);
    await s.engine.waitOrganize();
    const st = s.engine.organizeStatus(s.projectId);
    expect(st.suggestion).toBeNull();
    expect(st.failed).toMatchObject({ reason: 'timeout' });

    // 驱动中 issue 拒绝挪（全批不动）
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('implementing', a.id);
    await expect(s.engine.moveIssuesToModule(s.projectId, [a.id], m2.id)).rejects.toThrow(/执行中/);
    expect(s.engine.store.get(a.id)!.moduleId).toBe(m1.id);

    // pending 未绑会话跨代理挪 → 代理随目标模块翻
    s.db.query('UPDATE issues SET status = ? WHERE id = ?').run('pending', a.id);
    const codexM = moduleStore.create({
      projectId: s.projectId,
      slug: 'codex-side',
      displayName: 'Codex 侧',
      agent: 'codex',
      source: 'manual',
    });
    const r = await s.engine.moveIssuesToModule(s.projectId, [a.id], codexM.id);
    expect(r.movedIssueIds).toEqual([a.id]);
    expect(s.engine.store.get(a.id)!).toMatchObject({ moduleId: codexM.id, agent: 'codex' });
  });

  test('renameModule 透传；archiveModule 有未完结 issue 时拒绝、清空后放行', async () => {
    let manager: ModuleManager;
    const s = await setup({ modulesFor: () => manager });
    const moduleStore = new ModuleStore(s.db);
    manager = new ModuleManager(moduleStore, {
      suggest: async () => {
        throw new Error('不应咨询');
      },
      docs: { async ensureModule() {}, async refreshIndex() {} },
    });
    const m = moduleStore.create({
      projectId: s.projectId,
      slug: 'issue-engine',
      displayName: '旧名',
      agent: 'claude',
      source: 'legacy',
    });
    const renamed = await s.engine.renameModule(s.projectId, m.id, '新名字');
    expect(renamed.displayName).toBe('新名字');

    const issue = await s.engine.createIssue(s.projectId, { title: '甲', moduleId: m.id }, false);
    await expect(s.engine.archiveModule(s.projectId, m.id)).rejects.toThrow(/未完结/);
    await s.engine.cancelIssue(issue.id, s.admin.id);
    const archived = await s.engine.archiveModule(s.projectId, m.id);
    expect(archived.status).toBe('archived');
  });

});

describe('ISSUE_BLOCKED 哨兵 / clarifying / 手动旁路封死', () => {
  test('ISSUE_BLOCKED（核 id）任何驱动阶段都认，带原因转 blocked', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 D' });
    const jl = await s.bindJsonl(issue.id);
    await s.appendOutput(jl, asst(`ISSUE_BLOCKED:999 别人的`), asst(`ISSUE_BLOCKED:${issue.id} 缺少 API key`));
    await engine.tick();
    const cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('blocked');
    const ev = engine.store.listEvents(issue.id).find((e) => e.kind === 'sentinel');
    expect(ev!.dataJson).toContain('缺少 API key');
  });

  test('澄清前置到创建时：design 也直进 planning；pending 补充不迁移；clarifying 存量兼容', async () => {
    const s = await setup();
    s.pm.questions = ['要支持哪些格式？', '要不要鉴权？']; // 旧开跑时路径已删：不再被咨询
    const issue = await s.engine.createIssue(s.projectId, { title: '模糊需求', category: 'design' });
    expect(s.engine.store.get(issue.id)!.status).toBe('planning'); // 不再进 clarifying
    expect(s.notifications.some((n) => n.summary?.includes('要支持哪些格式'))).toBe(false);

    // 排队中的 pending 补充澄清：并入 body、记事件、不做状态迁移
    const b = await s.engine.createIssue(s.projectId, { title: '排队任务', body: '原始需求' });
    expect(s.engine.store.get(b.id)!.status).toBe('pending');
    const r = await s.engine.clarify(b.id, 'CSV 就行，不用鉴权');
    expect(r.ok).toBe(true);
    let cur = s.engine.store.get(b.id)!;
    expect(cur.status).toBe('pending');
    expect(cur.body).toContain('原始需求');
    expect(cur.body).toContain('【澄清补充】CSV 就行');
    expect(s.engine.store.listEvents(b.id).some((e) => e.kind === 'clarified')).toBe(true);

    // 已开跑（planning，驱动态）：澄清答复直达会话、不迁移状态（详见「执行中澄清」专门用例）
    const rd = await s.engine.clarify(issue.id, '晚了但仍有效');
    expect(rd.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】晚了但仍有效'))).toBe(true);

    // clarifying 存量兼容：老数据（已绑对话、卡在 clarifying）答复 → 并入 body → planning
    const conv = s.convs.create(s.projectId, 'legacy', 'claude');
    s.engine.store.setConv(b.id, conv.id);
    expect((await s.engine.applyEvent(b.id, 'start_clarifying')).ok).toBe(true);
    const r2 = await s.engine.clarify(b.id, '补充完毕');
    expect(r2.ok).toBe(true);
    cur = s.engine.store.get(b.id)!;
    expect(cur.status).toBe('planning');
    expect(cur.body).toContain('【澄清补充】补充完毕');
  });

  test('patchMeta 写 images_json：存图 / 覆盖 / 清空(null)', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(
      s.projectId,
      { title: '带图任务', imagesJson: JSON.stringify(['.tmux-butler-uploads/a/1.png']) },
      false,
    );
    expect(JSON.parse(s.engine.store.get(issue.id)!.imagesJson!)).toEqual(['.tmux-butler-uploads/a/1.png']);

    // 覆盖为新的一组
    s.engine.store.patchMeta(issue.id, {
      imagesJson: JSON.stringify(['.tmux-butler-uploads/b/2.png', '.tmux-butler-uploads/b/3.png']),
    });
    expect(JSON.parse(s.engine.store.get(issue.id)!.imagesJson!)).toEqual([
      '.tmux-butler-uploads/b/2.png',
      '.tmux-butler-uploads/b/3.png',
    ]);

    // 清空：null → images_json 置空
    s.engine.store.patchMeta(issue.id, { imagesJson: null });
    expect(s.engine.store.get(issue.id)!.imagesJson).toBeNull();
  });

  test('033 澄清反馈/结果总结列：读写往返 + 超长截断 + null 清空', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '普通任务' }, false);
    // 新建默认 null（存量行向后兼容同语义）
    expect(s.engine.store.get(issue.id)!.clarifyFeedback).toBeNull();
    expect(s.engine.store.get(issue.id)!.resultSummary).toBeNull();

    s.engine.store.setClarifyFeedback(issue.id, '理解：做 X；思路：改 Y；风险：Z');
    s.engine.store.setResultSummary(issue.id, '完成 X，改动 a.ts/b.ts，测试通过，无遗留');
    let cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback).toBe('理解：做 X；思路：改 Y；风险：Z');
    expect(cur.resultSummary).toBe('完成 X，改动 a.ts/b.ts，测试通过，无遗留');

    // 超长截断（feedback 8000 / summary 16000）
    s.engine.store.setClarifyFeedback(issue.id, 'x'.repeat(9000));
    s.engine.store.setResultSummary(issue.id, 'y'.repeat(20000));
    cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback!.length).toBe(8000);
    expect(cur.resultSummary!.length).toBe(16000);

    // null 清空
    s.engine.store.setClarifyFeedback(issue.id, null);
    s.engine.store.setResultSummary(issue.id, null);
    cur = s.engine.store.get(issue.id)!;
    expect(cur.clarifyFeedback).toBeNull();
    expect(cur.resultSummary).toBeNull();
  });

  test('全类别开跑直进 planning；startIssue 只认 pending；非法转换被拒', async () => {
    const s = await setup();
    s.pm.questions = ['会被跳过吗']; // 旧路径已删，任何类别都不再咨询
    const issue = await s.engine.createIssue(s.projectId, { title: '修 bug', category: 'debug' });
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');

    expect((await s.engine.startIssue(issue.id)).ok).toBe(false); // 已不在 pending
    expect((await s.engine.applyEvent(issue.id, 'merged')).ok).toBe(false); // 非法转换
    expect((await s.engine.applyEvent(issue.id, 'tests_failed')).ok).toBe(false);

    // task 同样直进（执行中不清楚走 ISSUE_BLOCKED；创建时澄清是后台分析，不改状态）
    await s.engine.cancelIssue(issue.id); // 腾出项目队列，否则新 task 只会排队
    const task = await s.engine.createIssue(s.projectId, { title: '很模糊的任务' });
    expect(s.engine.store.get(task.id)!.status).toBe('planning');
  });

  test('同项目并发 startIssue 只能一条赢：单 busy、单激活对话，败者保持纯 pending', async () => {
    const s = await setup();
    const a = await s.engine.createIssue(s.projectId, { title: '并发开跑 A' }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '并发开跑 B' }, false);
    expect(s.engine.store.get(a.id)!.status).toBe('pending');
    expect(s.engine.store.get(b.id)!.status).toBe('pending');

    const results = await Promise.all([s.engine.startIssue(a.id), s.engine.startIssue(b.id)]);
    const fresh = [s.engine.store.get(a.id)!, s.engine.store.get(b.id)!];
    const winners = fresh.filter((issue) => issue.status === 'planning');
    const losers = fresh.filter((issue) => issue.status === 'pending');
    const busy = fresh.filter((issue) => BUSY_STATES.includes(issue.status));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(winners[0]!.convId).toBeTruthy();
    expect(losers[0]!.convId).toBeNull();
    expect(s.convs.currentConv(s.projectId)).toBe(winners[0]!.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });

  test('队首激活失败转 blocked 后立即接力下一条，项目不因 scheduling guard 冻结', async () => {
    const s = await setup();
    const a = await s.engine.createIssue(s.projectId, { title: '激活会失败的 A' }, false);
    const b = await s.engine.createIssue(s.projectId, { title: '应接力的 B' }, false);
    const createSession = s.driver.createSession.bind(s.driver);
    let failFirstActivation = true;
    s.driver.createSession = async (name: string, cwd: string) => {
      if (failFirstActivation) {
        failFirstActivation = false;
        throw new Error('测试注入：首次激活失败');
      }
      await createSession(name, cwd);
    };

    await s.engine.scheduleNext(s.projectId);

    const freshA = s.engine.store.get(a.id)!;
    const freshB = s.engine.store.get(b.id)!;
    const busy = [freshA, freshB].filter((issue) => BUSY_STATES.includes(issue.status));
    expect(freshA.status).toBe('blocked');
    expect(freshB.status).toBe('planning');
    expect(busy).toHaveLength(1);
    expect(busy[0]!.id).toBe(b.id);
    expect(freshB.convId).toBeTruthy();
    expect(s.convs.currentConv(s.projectId)).toBe(freshB.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });

  test('unblock 的 pending 通知窗口也占项目启动权：并发 start 后仍只能单 active', async () => {
    let deferredIssueId = 0;
    let releaseUnblockNotify!: () => void;
    let markUnblockNotifyEntered!: () => void;
    const unblockNotifyEntered = new Promise<void>((resolve) => {
      markUnblockNotifyEntered = resolve;
    });
    const unblockNotifyHold = new Promise<void>((resolve) => {
      releaseUnblockNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (
          event.issueId === deferredIssueId &&
          event.kind === 'status_change' &&
          event.from === 'blocked' &&
          event.to === 'pending'
        ) {
          markUnblockNotifyEntered();
          await unblockNotifyHold;
        }
      },
    });
    const a = await s.engine.createIssue(s.projectId, { title: '解除受阻 A' }, false);
    expect((await s.engine.blockIssue(a.id, '先受阻')).ok).toBe(true);
    const b = await s.engine.createIssue(s.projectId, { title: '排队 B' }, false);
    expect(s.engine.store.get(a.id)!.convId).toBeNull();
    expect(s.engine.store.get(b.id)!.convId).toBeNull();
    deferredIssueId = a.id;

    const unblock = s.engine.unblockIssue(a.id, s.admin.id);
    await unblockNotifyEntered;
    expect(s.engine.store.get(a.id)!.status).toBe('pending'); // CAS 已落，A transition tail 仍被通知占用

    let bSettled = false;
    let starts!: Promise<[Awaited<ReturnType<typeof s.engine.startIssue>>, Awaited<ReturnType<typeof s.engine.startIssue>>]>;
    let bSettledBeforeRelease = false;
    let bPlannedBeforeRelease = false;
    try {
      const startA = s.engine.startIssue(a.id);
      const startB = s.engine.startIssue(b.id).then((result) => {
        bSettled = true;
        return result;
      });
      starts = Promise.all([startA, startB]);
      await flushMicrotasks();
      bSettledBeforeRelease = bSettled;
      bPlannedBeforeRelease = s.engine.store.get(b.id)!.status === 'planning';
    } finally {
      releaseUnblockNotify();
    }
    await Promise.all([unblock, starts]);

    const fresh = [s.engine.store.get(a.id)!, s.engine.store.get(b.id)!];
    const winners = fresh.filter((issue) => issue.status === 'planning');
    const losers = fresh.filter((issue) => issue.status === 'pending');
    const busy = fresh.filter((issue) => BUSY_STATES.includes(issue.status));
    expect(bSettledBeforeRelease).toBe(false);
    expect(bPlannedBeforeRelease).toBe(false);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(busy).toHaveLength(1);
    expect(winners[0]!.convId).toBeTruthy();
    expect(losers[0]!.convId).toBeNull();
    expect(s.convs.currentConv(s.projectId)).toBe(winners[0]!.convId!);
    const activeRows = s.db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM project_active_conv WHERE project_id = ?')
      .get(s.projectId)!.n;
    expect(activeRows).toBe(1);
  });
});

describe('三级完成判定：nudge(180s) → PM 保守判(360s)；limit 与解析解耦', () => {
  test('完整 JSONL 增长重置 fallback：nudge 后只有 thinking/tool_use 也不误判且可重新计时催促', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '长工具调用' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff，建立旧 activity/fed 基线
    await s.appendOutput(jl, asst('先读取现有实现')); // 给 fallback 留一段可判定的 assistant 尾巴
    await s.engine.tick();

    s.clock.advance(181_000);
    await s.engine.tick(); // 先触发一次 nudge，nudged=true
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    s.clock.advance(361_000); // 已超过 fallback 窗口，此刻新增非 assistant/tool_result 进度
    await s.appendOutput(
      jl,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: '仍在分析大型代码库' },
            { type: 'tool_use', name: 'Bash', input: { command: 'bun test' } },
          ],
        },
      }),
    );
    await s.engine.tick();

    expect(s.pm.judgeCalls).toBe(0);
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    s.clock.advance(181_000);
    await s.engine.tick(); // 增长已清 nudged，并从增长时刻重新计时，允许新一轮催促
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(2);
  });

  test('完整 JSONL 增长即刷新判活：有效但不产出消息的记录也不误催、误判', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '持续写进度元数据' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick(); // kickoff，建立旧 activity/fed 基线

    s.clock.advance(181_000);
    await s.appendOutput(jl, JSON.stringify({ type: 'progress', completed: 42 }));
    await s.engine.tick();

    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(0);
    expect(s.pm.judgeCalls).toBe(0);
  });

  test('nudge 的 plain user 回显不算代理进展：越过 fallback 后应 judge 而不是重新 nudge', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '回显不能续命' });
    const jl = await s.bindJsonl(issue.id);
    await s.engine.tick();
    await s.appendOutput(jl, asst('正在处理任务'));
    await s.engine.tick(); // 给 judge recent 留 assistant 内容

    s.clock.advance(181_000);
    await s.engine.tick();
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    await s.appendOutput(jl, userText('请继续；完成后按格式输出哨兵'));
    await s.engine.tick(); // 模拟 CLI 把刚注入的 nudge 原样记为 user
    s.clock.advance(361_000);
    await s.engine.tick();

    expect(s.pm.judgeCalls).toBe(1);
    expect(s.engine.store.countEvents(issue.id, 'nudged')).toBe(1);
  });

  test('安静 180s nudge 一次；360s 后 PM 判 done 推进（CAS 竞态防护路径）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 E' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff 子任务 1
    // 有点动静（judge 窗口要有内容），随后彻底安静
    await s.appendOutput(jl, asst('我先看看现有代码结构'));
    await engine.tick();

    // 安静 181s → nudge（只发一次）
    clock.advance(181_000);
    await engine.tick();
    const nudges = s.driver.prompts().filter((t) => t.includes(`SUBTASK_DONE:${issue.id}`) && t.includes('没完成请继续'));
    expect(nudges.length).toBe(1);
    await engine.tick();
    expect(
      s.driver.prompts().filter((t) => t.includes('没完成请继续')).length,
    ).toBe(1);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    // 再安静 361s → PM 判 done → implementing 收尾进 testing
    s.pm.judgement = 'done';
    clock.advance(361_000);
    await engine.tick();
    expect(s.pm.judgeCalls).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    expect(engine.store.countEvents(issue.id, 'judged')).toBe(1);
  });

  test('会话失效自动重新认领：nudge 后仍零增长 → 重绑新 jsonl，末尾起 tail + 立即再催', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC' });
    await s.bindJsonl(issue.id); // 绑定的「死」jsonl：之后永远零增长
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ '; // pane 有 CC 输入框特征（真会话活着，只是绑定错了）
    await engine.tick(); // kickoff 子任务 1（fedTs 起点）

    // pane 里真正活着的会话写的是另一个 jsonl；其中换绑前就存在的哨兵不得被重放
    const jl2 = path.join(s.dir, 'reclaimed.jsonl');
    await fsp.writeFile(jl2, asst(`SUBTASK_DONE:${issue.id}`) + '\n');
    s.locator.reclaimTo = jl2;

    // 181s 静默 → 先 nudge（还不 reclaim：先催后认领）
    clock.advance(181_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(0);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);

    // nudge 后 61s 仍零增长 → reclaim：重绑 + 记事件 + 立即再催
    clock.advance(61_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_reclaimed')).toBe(1);
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(2);
    // 换绑前已存在的 SUBTASK_DONE 不重放（新文件末尾起 tail）
    expect(engine.store.get(issue.id)!.subIndex).toBe(0);

    // 新会话的新输出正常消费 → 子任务推进
    await s.appendOutput(jl2, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.subIndex).toBe(1);
  });

  test('会话失效但 pane 无输入框特征：不 reclaim（走 kickoff 超时/人工路径）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC3' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    // pane 保持空（无 ❯/╭─）：即使注入后零增长也不该 reclaim——真会话可能根本没起来
    await engine.tick(); // kickoff（ccReady 靠 jsonl 存在）
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(61_000);
    await engine.tick();
    expect(s.locator.reclaimCalls).toBe(0);
  });

  test('consecutiveJudgedDone：连续 done 计数、非 done 断连、锚点截断', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '计数器' });
    const st = engine.store;
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(2);
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'not_done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(0); // 非 done 断连
    st.logEvent(issue.id, 'judged', { stage: 'planning', result: 'done' });
    expect(st.consecutiveJudgedDone(issue.id, 0)).toBe(1);
    // 锚点在最后一条 done 之后 → 不计更早的
    const maxId = (s.db.query<{ m: number }, [number]>(
      'SELECT MAX(id) m FROM issue_events WHERE issue_id = ?',
    ).get(issue.id))!.m;
    expect(st.consecutiveJudgedDone(issue.id, maxId)).toBe(0);
  });

  test('会话失效但无可认领候选：不动原绑定，落错误事件且按冷却重试', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 RC2' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ ';
    await engine.tick(); // kickoff
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(61_000);
    await engine.tick(); // reclaim 落空
    expect(s.locator.reclaimCalls).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_reclaimed')).toBe(0);
    await engine.tick(); // 冷却期内不重试
    expect(s.locator.reclaimCalls).toBe(1);
    clock.advance(61_000);
    await engine.tick(); // 冷却过后再试
    expect(s.locator.reclaimCalls).toBe(2);
  });

  test('会话自愈：tmux 会话消失 → 自动重建 --resume + 恢复事件一次，接续催办驱动（issue #88）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '自愈' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff 子任务 1
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);
    expect(s.driver.tmuxSessions.has(session)).toBe(true);

    // 模拟 systemd 重启连坐：tmux 会话没了（capturePane 抓不到 → pane 空）
    s.driver.tmuxSessions.clear();
    const sentBefore = s.driver.sent.length;
    await engine.tick();
    // 会话被重建，且 jsonl 已落地 → --resume 续上下文
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
    expect(
      s.driver.sent.slice(sentBefore).some((x) => x.session === session && x.text === `claude --resume ${convId}`),
    ).toBe(true);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
    // kickoff 幂等：implementing 阶段已注入过，不重发子任务 prompt
    expect(s.driver.prompts().filter((t) => t.includes('【实施 子任务 1/1】')).length).toBe(1);

    // 接续驱动：静默 181s → 既有催办机制在新会话上催活；不再重复恢复
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
  });

  test('会话自愈失败进冷却：不向死会话注入、错误只落一次，冷却过后重试成功', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '自愈冷却' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick(); // kickoff
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);

    // 会话没了，且 tmux 起不来（createSession 一直失败）
    s.driver.tmuxSessions.clear();
    const orig = s.driver.createSession.bind(s.driver);
    let broken = true;
    s.driver.createSession = async (name: string, cwd: string) => {
      if (broken) throw new Error('tmux 挂了');
      return orig(name, cwd);
    };
    const sentBefore = s.driver.sent.length;
    await engine.tick(); // 尝试重建 → 失败落一次错误
    await engine.tick(); // 冷却期：静默跳过，不重试
    await engine.tick();
    const recoverErrors = () =>
      engine.store
        .listEvents(issue.id)
        .filter((e) => e.kind === 'error' && (e.dataJson ?? '').includes('recover')).length;
    expect(recoverErrors()).toBe(1);
    expect(s.driver.sent.length).toBe(sentBefore); // 冷却期对死会话零注入

    // 冷却过后 tmux 修好了 → 重试重建成功
    broken = false;
    clock.advance(61_000);
    await engine.tick();
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
    expect(engine.store.countEvents(issue.id, 'session_recovered')).toBe(1);
    expect(recoverErrors()).toBe(1);
  });

  test('会话已消失且 Agent CLI 不存在：立即 blocked，不留在 driving 态反复恢复', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '缺会话且 Claude 未安装' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.tick();

    s.driver.tmuxSessions.clear();
    s.driver.executables.delete('claude');
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.get(issue.id)!.status).toBe('blocked');
    expect(s.driver.sent.length).toBe(sentBefore);
    expect(
      engine.store
        .listEvents(issue.id)
        .some((event) => event.kind === 'transition' && (event.dataJson ?? '').includes('找不到 Claude 可执行文件')),
    ).toBe(true);
  });

  test('激活绑定丢失且 Agent CLI 不存在：立即 blocked，不静默冻结', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '激活绑定丢失且 Claude 未安装' });
    await s.bindJsonl(issue.id);
    s.driver.tmuxSessions.clear();
    s.driver.executables.delete('claude');
    s.db.query('DELETE FROM project_active_conv WHERE project_id = ?').run(s.projectId);
    const sentBefore = s.driver.sent.length;

    await engine.tick();

    expect(engine.store.get(issue.id)!.status).toBe('blocked');
    expect(s.driver.sent.length).toBe(sentBefore);
  });

  // ---- issue #97：注入前的代理存活门禁 ----

  /** 驱动中的 issue：kickoff 已发，静默到该催办的时刻——此后每 tick 都会想注入点什么 */
  async function drivingIssue(title: string): Promise<{
    s: Awaited<ReturnType<typeof setup>>;
    issueId: number;
    convId: string;
    session: string;
  }> {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['a']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'plan_approved');
    s.driver.pane = '❯ ';
    await s.engine.tick(); // kickoff
    const convId = s.engine.store.get(issue.id)!.convId!;
    return { s, issueId: issue.id, convId, session: s.convs.tmuxName(s.projectId, convId) };
  }

  test('代理退回 bash：本 tick 零注入 + 强制重启 --resume + agent_down/agent_restarted（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('退回 bash');
    const { engine, clock } = s;
    expect(s.driver.tmuxSessions.has(session)).toBe(true);

    // 代理退出：tmux 会话还在（#88 的自愈不会触发），窗格只剩 shell
    s.driver.pane = `[root@VM p]# claude --resume ${convId}\n[root@VM p]#`;
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(181_000); // 早就该催办了：不设门禁的话这一 tick 会把催办打进 bash
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.countEvents(issueId, 'nudged')).toBe(0); // 一个字都没往 shell 里注
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
    // 唯一的新 send 是重启命令本身，且 --resume 续上下文（不新开会话）
    const after = s.driver.sent.slice(sentBefore);
    expect(after).toEqual([{ session, text: `claude --resume ${convId}` }]);
    expect(s.driver.tmuxSessions.has(session)).toBe(true);
  });

  // 2026-07-27 生产误杀事故：#99 的代理 10:29:28 发起 tool_use:Bash（前台变 bash、屏幕被命令
  // 输出刷掉），10:29:52 就被判死 kill 掉，24 秒的沉默足够触发。会话文件是独立第三方证据——
  // 死代理永远不会再写，所以「最近写过」必须一票否决屏幕与前台命令。
  test('代理正在跑前台命令（jsonl 刚写过）→ 屏幕和前台命令双双像 shell 也绝不重启（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('别误杀在跑的代理');
    const { engine, clock } = s;
    s.driver.pane = '  PASS  src/foo.test.ts\n[root@VM repo]#'; // 命令输出把代理 UI 刷没了
    s.driver.paneCommands.set(session, 'bash'); // 前台确实是 bash

    clock.advance(24_000); // 只沉默了 24s——正是事故里的时长
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);

    // 真死了（久久不写）才允许判死
    clock.advance(61_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
  });

  test('重启冷却：冷却期内不重复 kill，过后才再重启一次（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('重启冷却');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸（jsonl 静默 ≥60s）

    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);
    // 重启后代理仍没起来（窗格还是 bash）：冷却期内只是静默跳过，绝不连环 kill
    await engine.tick();
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);

    clock.advance(61_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(2);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(2);
    expect(s.driver.sent.filter((x) => x.text === `claude --resume ${convId}`).length).toBe(2);
  });

  test('健康路径零额外 tmux 调用：屏面是代理 UI 就不查 listSessions（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('健康路径');
    const { engine, clock } = s;
    s.driver.pane = '❯ ';
    s.driver.listCalls = 0;
    clock.advance(181_000);
    await engine.tick(); // 正常催办
    expect(s.driver.listCalls).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
  });

  test('前台命令是 claude → 不重启（屏上出现 shell 提示符也不误杀在跑的代理，issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('别误杀');
    const { engine, clock } = s;
    // 代理正在跑 Bash 工具，屏面末行像提示符——只有前台命令能证明它还活着
    s.driver.pane = '⏺ Bash(ls -la)\n  ⎿ [root@VM p]#';
    s.driver.paneCommands.set(session, 'claude');
    clock.advance(181_000);
    await engine.tick();
    expect(s.driver.listCalls).toBeGreaterThan(0); // 可疑 → 花了一次核对
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1); // 照常催办
  });

  test('拿不到前台命令且屏面说不清 → unknown，保守不动（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('说不清');
    const { engine, clock } = s;
    s.driver.pane = '正在编译…'; // 无 UI 特征、无提示符，listSessions 也没给 command
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(1);
  });

  test('重启必须无条件：换成 activate 那种「会话还在就短路」修不好这种壳（issue #97）', async () => {
    const { s, issueId, convId, session } = await drivingIssue('无条件重启');
    const { engine } = s;
    // 引擎抓到的是 shell；等 ConversationManager 自己再抓一次时屏面已经变了（残影/翻页）。
    // 走 activate 的话它会判 unknown 而短路 → 壳永远修不好；relaunch 不看这些，直接重起。
    let n = 0;
    const shellPane = `[root@VM p]# claude --resume ${convId}\n[root@VM p]#`;
    s.driver.capturePane = async () => (n++ === 0 ? shellPane : '❯ ');
    s.driver.paneCommands.set(session, 'bash');
    s.clock.advance(61_000); // 过判死硬闸

    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(s.driver.sent.filter((x) => x.text === `claude --resume ${convId}`).length).toBe(1);
  });

  test('listSessions 抛错 → unknown，绝不当死会话杀（issue #97）', async () => {
    const { s, issueId } = await drivingIssue('判活失败');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#'; // 可疑 → 要核对，但核对本身失败了
    s.driver.listSessions = async () => {
      throw new Error('执行机不可达');
    };
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(0);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);
  });

  test('重启后接着跑：等代理真就绪才补催办，启动中不盲注（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('重启接续');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸
    await engine.tick(); // 判死 → 重启
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(1);

    // 新进程还在启动：没有输入框特征（jsonl 早就在，ccReady 骗不了人）→ 先不注入
    s.driver.pane = 'Starting…';
    s.driver.paneCommands.set(session, 'node');
    const sentAfterRestart = s.driver.sent.length;
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(0);
    expect(s.driver.sent.length).toBe(sentAfterRestart);

    // 输入框画出来了 → 补一次催办接着干
    s.driver.pane = '❯ ';
    s.driver.paneCommands.set(session, 'claude');
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(1);
    expect(s.driver.prompts().at(-1)).toContain('子任务');

    // 只补一次，不会每 tick 都催
    clock.advance(1000);
    await engine.tick();
    expect(engine.store.countEvents(issueId, 'agent_resumed')).toBe(1);
  });

  test('连续重启到上限仍是 shell → block 并通知（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('起不来');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#'; // 重启多少次都只剩 shell（模拟登录过期）
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸

    for (let i = 0; i < MAX_AGENT_RESTARTS; i++) {
      await engine.tick();
      clock.advance(61_000); // 过冷却
    }
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS);
    expect(engine.store.get(issueId)!.status).not.toBe('blocked');

    await engine.tick(); // 第 4 次判死：不再重启，交人工
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS);
    expect(engine.store.get(issueId)!.status).toBe('blocked');
    // 原因写进 transition 事件 + issue_blocked 通知（人得知道是「代理起不来」而不是任务本身失败）
    expect(
      engine.store
        .listEvents(issueId)
        .some((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('代理起不来')),
    ).toBe(true);
    expect(
      s.notifications.some(
        (n) => n.kind === 'issue_blocked' && n.issueId === issueId && !!n.summary?.includes('代理起不来'),
      ),
    ).toBe(true);
  });

  test('重启计数跨 resetWatch 传递，确认代理活着后清零（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('计数不丢');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    clock.advance(61_000); // 过判死硬闸
    await engine.tick(); // 重启 1（内部 resetWatch，计数不能被抹掉）
    clock.advance(61_000);
    await engine.tick(); // 重启 2

    // 代理真起来了 → 计数清零：之后再坏一次也是从头数，不会因为历史欠账提前 block
    s.driver.pane = '❯ ';
    s.driver.paneCommands.set(session, 'claude');
    await engine.tick();

    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    for (let i = 0; i < MAX_AGENT_RESTARTS; i++) {
      clock.advance(61_000);
      await engine.tick();
    }
    expect(engine.store.get(issueId)!.status).not.toBe('blocked'); // 清零过 → 还没到上限
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(MAX_AGENT_RESTARTS + 2);
  });

  test('重启失败：落一次 error 且仍然零注入（issue #97）', async () => {
    const { s, issueId, session } = await drivingIssue('重启失败');
    const { engine, clock } = s;
    s.driver.pane = '[root@VM p]#';
    s.driver.paneCommands.set(session, 'bash');
    s.driver.createSession = async () => {
      throw new Error('tmux 挂了');
    };
    clock.advance(181_000);
    const sentBefore = s.driver.sent.length;
    await engine.tick();

    expect(engine.store.countEvents(issueId, 'agent_down')).toBe(1);
    expect(engine.store.countEvents(issueId, 'agent_restarted')).toBe(0);
    expect(
      engine.store.listEvents(issueId).filter((e) => e.kind === 'error' && (e.dataJson ?? '').includes('agentRestart'))
        .length,
    ).toBe(1);
    expect(s.driver.sent.length).toBe(sentBefore); // 死会话零注入
    expect(engine.store.countEvents(issueId, 'nudged')).toBe(0);
  });

  test('Agent CLI 已不存在时重启立即 blocked，不在 shell 中循环注入或空等三轮', async () => {
    const { s, issueId, session } = await drivingIssue('Claude 未安装');
    const { engine, clock } = s;
    s.driver.executables.delete('claude');
    s.driver.pane = 'zsh: command not found: claude\n~/repo ❯';
    s.driver.paneCommands.set(session, 'zsh');
    clock.advance(181_000);
    const sentBefore = s.driver.sent.length;

    await engine.tick();

    expect(engine.store.get(issueId)!.status).toBe('blocked');
    expect(s.driver.sent.length).toBe(sentBefore);
    expect(
      engine.store
        .listEvents(issueId)
        .some((event) => event.kind === 'transition' && (event.dataJson ?? '').includes('找不到 Claude 可执行文件')),
    ).toBe(true);
  });

  test('planning 判 done 死循环出口：前两次注入重输出指令并允许再催，第三次转 blocked', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '规划死循环' });
    const jl = await s.bindJsonl(issue.id);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    await engine.tick(); // kickoff planning
    await s.appendOutput(jl, asst('规划完了（但没按格式输出块）'));
    await engine.tick(); // 消费活动，judge 窗口有内容
    s.pm.judgement = 'done';

    const replans = () => s.driver.prompts().filter((t) => t.includes('重新完整输出')).length;
    // planning nudge 新文案（去掉了无条件「别停下来等我」，附 NEED_CLARIFY 逃生口）
    const nudges = () => s.driver.prompts().filter((t) => t.includes('子任务规划好了就')).length;

    // 第 1 轮：180s 静默先 nudge，360s 判 done → 重输出指令（不推进不 block）
    clock.advance(181_000);
    await engine.tick();
    expect(nudges()).toBe(1);
    clock.advance(361_000);
    await engine.tick();
    expect(replans()).toBe(1);
    expect(engine.store.countEvents(issue.id, 'replan_requested')).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 重输出指令重置了 nudge 状态 → 第 2 轮还能再催、再判、再指令
    clock.advance(181_000);
    await engine.tick();
    expect(nudges()).toBe(2);
    clock.advance(361_000);
    await engine.tick();
    expect(replans()).toBe(2);
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 第 3 轮：连续第 3 次判 done 仍无子任务块 → 转 blocked + issue_blocked 通知
    clock.advance(181_000);
    await engine.tick();
    expect(nudges()).toBe(3);
    clock.advance(361_000);
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('blocked');
    expect(replans()).toBe(2); // 第三次不再指令，直接兜底
    expect(
      s.notifications.some((n) => n.kind === 'issue_blocked' && (n.summary ?? '').includes('SUBTASKS')),
    ).toBe(true);
  });

  test('planning 判 done 后补上子任务块 → 正常推进且不再累计 strikes', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '规划迟到' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff
    await s.appendOutput(jl, asst('先想想'));
    await engine.tick();
    s.pm.judgement = 'done';
    clock.advance(181_000);
    await engine.tick(); // nudge
    clock.advance(361_000);
    await engine.tick(); // 判 done → 重输出指令
    expect(engine.store.countEvents(issue.id, 'replan_requested')).toBe(1);
    // 代理响应指令补发块 → 正常走 plan_review
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 子任务甲\nSUBTASKS_END'));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('plan_review');
  });

  test('limit 命中不吞同批哨兵（解析在前，退避在后）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 F' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a', 'b']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    // 同一批：一个 SUBTASK_DONE + 一句 limit 文案
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`), asst('You have hit your usage limit, try later'));
    await engine.tick();
    const cur = engine.store.get(issue.id)!;
    expect(cur.subIndex).toBe(1); // 哨兵没丢
    expect(engine.store.countEvents(issue.id, 'limit')).toBe(1); // 退避也记了
  });

  test('弹窗滞留超时 → 通知 + 事件（v1 黑洞 H16 防线）；有弹窗不 kickoff', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '功能 G' });
    await s.bindJsonl(issue.id);
    s.driver.pane = '│ Do you want to proceed?\n ❯ 1. Yes\n   2. No\n';
    const before = s.driver.prompts().length;
    await engine.tick(); // 菜单挂着 → 不 kickoff，记 menuSince
    expect(s.driver.prompts().length).toBe(before);
    clock.advance(6 * 60 * 1000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'menu_stuck')).toBe(1);
    expect(s.notifications.some((n) => n.summary?.includes('弹窗滞留'))).toBe(true);
    // 菜单消失后恢复 kickoff
    s.driver.pane = '';
    await engine.tick();
    expect(s.driver.prompts().length).toBeGreaterThan(before);
  });

  test('codex 升级弹窗：自动选升级（冷却防重复），弹窗消失后恢复 kickoff', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '升级弹窗', agent: 'codex' });
    await s.bindJsonl(issue.id);
    const ones = () => s.driver.sent.filter((x) => x.text === '1').length;
    s.driver.pane = 'Update available! 0.144.6 -> 0.145.0\n› 1. Update now\n  2. Skip\nPress enter to continue\n';
    await engine.tick();
    expect(ones()).toBe(1); // 自动选「Update now」
    expect(engine.store.countEvents(issue.id, 'codex_update')).toBe(1);
    // 弹窗未消失：冷却期内不重复打 1，也不往弹窗里灌 kickoff prompt
    await engine.tick();
    expect(ones()).toBe(1);
    expect(s.driver.prompts().filter((t) => t.includes('SUBTASKS_BEGIN')).length).toBe(0);
    // 30s 冷却过后弹窗仍在 → 再点一次
    clock.advance(31_000);
    await engine.tick();
    expect(ones()).toBe(2);
    // 弹窗消失（升级完回到 composer）→ 恢复 kickoff planning
    s.driver.pane = '› ';
    await engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('codex › 菜单纳入滞留告警（menu_stuck 对 codex 生效）', async () => {
    const s = await setup();
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: 'codex 弹窗滞留', agent: 'codex' });
    await s.bindJsonl(issue.id);
    s.driver.pane = '  Allow command?\n› 1. Yes, run it\n  2. No, tell me what to do\n';
    const before = s.driver.prompts().length;
    await engine.tick(); // 菜单挂着 → 不 kickoff，记 menuSince
    expect(s.driver.prompts().length).toBe(before);
    clock.advance(6 * 60 * 1000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'menu_stuck')).toBe(1);
    expect(s.notifications.some((n) => n.summary?.includes('弹窗滞留'))).toBe(true);
  });

  test('blocked 接力：不建/不切分支，靠 impl_base 起点把 B 的范围与 A 的残留提交隔开', async () => {
    const s = await setup();
    const { engine } = s;

    // issue A → implementing，在当前分支（main）上留一个提交（引擎不建 issue 分支）
    const a = await engine.createIssue(s.projectId, { title: '功能 A', module: 'm' });
    const jlA = await s.bindJsonl(a.id);
    await engine.tick(); // kickoff planning
    await s.appendOutput(jlA, asst('SUBTASKS_BEGIN\n1. 写 A\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const gA = engine.store.listGates(a.id)[0]!;
    expect((await engine.decideGate(gA.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(a.id)!.status).toBe('implementing');
    expect(engine.store.get(a.id)!.branch).toBe('main');
    await fsp.writeFile(path.join(s.repo, 'a.ts'), 'a\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'wip-A-残留']);
    const wipASha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // 排队 issue B（项目忙 → pending）
    const b = await engine.createIssue(s.projectId, { title: '功能 B', module: 'm' });
    expect(engine.store.get(b.id)!.status).toBe('pending');

    // A 被哨兵 blocked → 不切分支（仍在 main，A 的提交留在原地）→ 接力 B
    await s.appendOutput(jlA, asst(`ISSUE_BLOCKED:${a.id} 卡住了`));
    await engine.tick();
    expect(engine.store.get(a.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.get(b.id)!.status).toBe('planning');

    // B 推进到 implementing → 起点 impl_base = 当前 HEAD（含 A 的残留），据此 B 的净范围不含 A 的提交
    const jlB = await s.bindJsonl(b.id);
    await engine.tick(); // kickoff B planning
    await s.appendOutput(jlB, asst('SUBTASKS_BEGIN\n1. 写 B\nSUBTASKS_END'));
    await engine.tick();
    const gB = engine.store.listGates(b.id)[0]!;
    expect((await engine.decideGate(gB.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(b.id)!.status).toBe('implementing');
    expect(engine.store.get(b.id)!.branch).toBe('main');
    // 隔离靠 commit 范围而非分支：B 的起点就是 A 残留那条，故 B 的净提交范围排除 wip-A-残留
    expect(engine.implBaseSha(b.id)).toBe(wipASha);
    // A 的残留提交仍安全保留在 main 上（未被回滚，可人工处理）
    expect((await s.g(['log', '--oneline', 'main'])).out).toContain('wip-A-残留');
  });
});

describe('I1 迁移/失忆恢复：无激活对话的驱动中 issue 自行激活', () => {
  test('DB 直插 implementing（conv 登记但无 project_active_conv 行）→ tick 激活对话 + kickoff', async () => {
    const s = await setup();
    const { engine, convs, driver } = s;
    // 模拟迁移产物：conversations 有行、issue 卡在 implementing、无激活行
    const conv = convs.create(s.projectId, '迁移来的对话');
    const issue = await engine.createIssue(s.projectId, { title: '迁移任务' }, false);
    engine.store.setConv(issue.id, conv.id);
    engine.store.setSubtasks(issue.id, ['继续实现导出']);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(issue.id);
    // 迁移对话有历史 jsonl（--resume 路径）
    const p = path.join(s.dir, `${conv.id}.jsonl`);
    await fsp.writeFile(p, '');
    s.jsonl.set(conv.id, p);

    expect(convs.currentConv(s.projectId)).toBeUndefined();
    await engine.tick();
    // 对话被激活（--resume：jsonl 已存在），且 kickoff 已注入子任务 prompt
    expect(convs.currentConv(s.projectId)).toBe(conv.id);
    expect(driver.sent.some((x) => x.text.startsWith('claude --resume'))).toBe(true);
    expect(driver.prompts().some((t) => t.includes(`SUBTASK_DONE:${issue.id}`))).toBe(true);
  });

  test('plan_review approve 且项目无激活对话 → 进 implementing 时同样激活', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const conv = convs.create(s.projectId, '迁移对话');
    const issue = await engine.createIssue(s.projectId, { title: '待批计划' }, false);
    engine.store.setConv(issue.id, conv.id);
    engine.store.setSubtasks(issue.id, ['a']);
    s.db.query(`UPDATE issues SET status = 'plan_review' WHERE id = ?`).run(issue.id);
    const gate = engine.store.createGate(issue.id, 'plan', {});

    expect(convs.currentConv(s.projectId)).toBeUndefined();
    const r = await engine.decideGate(gate.id, s.admin.id, 'approve');
    expect(r.ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(convs.currentConv(s.projectId)).toBe(conv.id); // onEnter(implementing) 补激活
  });

  test('已有别的激活对话时不夺占（浏览优先语义不回归）', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const browsing = convs.create(s.projectId, '用户在看的');
    await convs.activate(browsing.id);
    const conv = convs.create(s.projectId, 'issue 的');
    const issue = await engine.createIssue(s.projectId, { title: 'T' }, false);
    engine.store.setConv(issue.id, conv.id);
    s.db.query(`UPDATE issues SET status = 'implementing' WHERE id = ?`).run(issue.id);
    await engine.tick();
    expect(convs.currentConv(s.projectId)).toBe(browsing.id); // 没被抢
  });
});

describe('I2 门禁跳过可观测：conv_displaced 事件+通知一次，恢复后重置', () => {
  test('对话被切走 → 首次记事件+通知；重复 tick 不刷屏；切回再切走重新计一次', async () => {
    const s = await setup();
    const { engine, convs } = s;
    const issue = await engine.createIssue(s.projectId, { title: '被让位' });
    await s.bindJsonl(issue.id);
    await engine.tick(); // 正常驱动一轮（kickoff）

    // 用户浏览：激活另一条对话 → 引擎让位
    const other = convs.create(s.projectId, '浏览');
    await convs.activate(other.id);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(1);
    expect(s.notifications.filter((n) => n.summary?.includes('切走')).length).toBe(1);
    await engine.tick(); // 去重：不重复
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(1);
    expect(s.notifications.filter((n) => n.summary?.includes('切走')).length).toBe(1);

    // 切回 issue 对话 → 标志复位；再切走 → 第二次事件
    await convs.activate(engine.store.get(issue.id)!.convId!);
    await engine.tick();
    await convs.activate(other.id);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'conv_displaced')).toBe(2);
    expect(s.notifications.filter((n) => n.summary?.includes('切走')).length).toBe(2);
  });
});

describe('I3 activate 与注入互斥（project→tmux 嵌套锁）', () => {
  test('activate 的 kill+create+send 三连不被并发注入交错', async () => {
    const s = await setup();
    const { engine, driver, mutex } = s;
    const issue = await engine.createIssue(s.projectId, { title: '并发注入' }, false);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const seq: string[] = [];
    driver.killSession = async (name: string) => {
      seq.push('kill');
      driver.tmuxSessions.delete(name);
    };
    driver.createSession = async (name: string) => {
      seq.push('create');
      await sleep(30); // 拉开窗口：无 tmux 锁时注入会插进 create 与 send 之间
      driver.tmuxSessions.add(name);
    };
    driver.sendKeys = async (session: string, text: string) => {
      seq.push(text.startsWith('claude') ? 'send:claude' : `send:${text}`);
      driver.sent.push({ session, text });
    };

    // 模拟 PM/WS 注入者：与引擎同一把 mutex 的 tmuxLockKey，在三连中途尝试注入
    const injector = (async () => {
      while (!seq.includes('create')) await sleep(1);
      await mutex.runExclusive(tmuxLockKey('cc-1'), () => driver.sendKeys('cc-1', 'INJECT'));
    })();
    const [r] = await Promise.all([engine.startIssue(issue.id), injector]);
    expect(r.ok).toBe(true);

    const kill = seq.indexOf('kill');
    const create = seq.indexOf('create');
    const claude = seq.indexOf('send:claude');
    const inject = seq.indexOf('send:INJECT');
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(kill);
    expect(claude).toBeGreaterThan(create);
    // 修复前：inject 落在 create 与 send:claude 之间（文本会打进新起的 bash 被当 shell 命令）
    expect(inject).toBeGreaterThan(claude);
  });
});

describe('I4 kickoff 就绪真检测', () => {
  test('jsonl 未落地且无输入框特征 → 不 kickoff；jsonl 落地后 kickoff', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '等就绪' });
    await s.engine.tick(); // 未就绪（locate=null，pane 空）
    expect(s.driver.prompts().length).toBe(0);

    await s.bindJsonl(issue.id); // jsonl 落地 = CC 已启动
    await s.engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('pane 出现 CC 输入框特征（❯/╭─）即视为就绪（jsonl 尚未定位到也 kickoff）', async () => {
    const s = await setup();
    await s.engine.createIssue(s.projectId, { title: '看屏就绪' });
    s.driver.pane = '╭───────────────╮\n│ ❯ 试试 "fix lint errors" │\n╰───────────────╯';
    await s.engine.tick();
    expect(s.driver.prompts().some((t) => t.includes('SUBTASKS_BEGIN'))).toBe(true);
  });

  test('超时（默认 120s）仍未就绪 → block（note: CC 启动超时）', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '起不来' });
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('planning'); // 未超时先等
    s.clock.advance(121_000);
    await s.engine.tick();
    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    expect(
      s.notifications.some((n) => n.kind === 'issue_blocked' && n.summary?.includes('CC 启动超时')),
    ).toBe(true);
    expect(s.driver.prompts().length).toBe(0); // 全程没盲注入过
  });
});

describe('I5/M1 引擎防冻结与优雅停机', () => {
  test('项目 A 卡住不阻塞项目 B；重复 tick 不重入 A；stop 等 A 归还', async () => {
    const s = await setup();
    const inserted = s.db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
       VALUES (?, 1, ?, ?, ?, ?)`,
    ).run('demo-2', s.repo, s.admin.id, '第二个演示项目', Date.now());
    const projectB = Number(inserted.lastInsertRowid);

    const a = await s.engine.createIssue(s.projectId, { title: 'A 卡住' });
    const b = await s.engine.createIssue(projectB, { title: 'B 应继续' });
    await s.bindJsonl(a.id);
    await s.bindJsonl(b.id);
    const sessionA = s.convs.tmuxName(a.projectId, s.engine.store.get(a.id)!.convId!);
    const sessionB = s.convs.tmuxName(b.projectId, s.engine.store.get(b.id)!.convId!);

    let releaseA!: (pane: string) => void;
    const hungPane = new Promise<string>((resolve) => {
      releaseA = resolve;
    });
    const captures: string[] = [];
    let markBCaptured!: () => void;
    let bCaptured = false;
    const bCaptureLatch = new Promise<void>((resolve) => {
      markBCaptured = () => {
        bCaptured = true;
        resolve();
      };
    });
    s.driver.capturePane = async (session: string) => {
      captures.push(session);
      if (session === sessionB) markBCaptured();
      return session === sessionA ? hungPane : '';
    };

    const firstTick = s.engine.tick();
    // 新实现把 A/B flight 同步登记后用微任务启动；让已排队的 capture 回调各跑一轮。
    await Promise.resolve();
    await Promise.resolve();
    const bDroveBeforeRelease = bCaptured;

    await s.engine.tick(); // A 已在 flight：本次必须直接返回，且不能重入 A
    const aCapturesBeforeRelease = captures.filter((session) => session === sessionA).length;

    let stopped = false;
    const stopP = s.engine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    const stoppedBeforeRelease = stopped;
    const capturesAtStop = captures.length;
    await s.engine.tick(); // stop 已关闭入口，不得再 capture 任一项目
    const capturesAfterStoppedTick = captures.length;

    releaseA('');
    await Promise.all([firstTick, stopP]);
    await bCaptureLatch;

    expect(bDroveBeforeRelease).toBe(true);
    expect(aCapturesBeforeRelease).toBe(1);
    expect(stoppedBeforeRelease).toBe(false);
    expect(capturesAfterStoppedTick).toBe(capturesAtStop);
    expect(stopped).toBe(true);
  });

  test('tick 在途超 5 分钟 → console.error 告警一次，单飞标志不重置', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '卡死盘' });
    await s.bindJsonl(issue.id);
    let release!: (v: string) => void;
    const hang = new Promise<string>((r) => {
      release = r;
    });
    s.driver.capturePane = () => hang; // 模拟执行机调用永不归还
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    };
    try {
      const inflight = s.engine.tick(); // 卡在 capturePane
      s.clock.advance(6 * 60 * 1000);
      await s.engine.tick(); // 立即返回并告警
      await s.engine.tick(); // 不重复告警
      const warnings = errs.filter((m) => m.includes('未归还'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`项目 ${s.projectId}`);
      expect(warnings[0]).toContain(`issue #${issue.id}`);
      release('');
      await inflight;
    } finally {
      console.error = orig;
    }
  });

  test('M1 stop() 等待在途 tick 归还后才返回', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '停机等待' });
    await s.bindJsonl(issue.id);
    let release!: (v: string) => void;
    const hang = new Promise<string>((r) => {
      release = r;
    });
    s.driver.capturePane = () => hang;
    const inflight = s.engine.tick();
    let stopped = false;
    const stopP = s.engine.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // 在途 tick 未归还 → stop 等待
    release('');
    await stopP;
    expect(stopped).toBe(true);
    await inflight;
  });
});

describe('M3 通知时序 / M4 归档项目', () => {
  test('同 issue 串行：plan_ready 通知等待期间的 cancel 排队，最终 cancelled 且无 waiting gate', async () => {
    let releasePlanNotify!: () => void;
    let markPlanNotifyEntered!: () => void;
    const planNotifyEntered = new Promise<void>((resolve) => {
      markPlanNotifyEntered = resolve;
    });
    const planNotifyHold = new Promise<void>((resolve) => {
      releasePlanNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.to === 'plan_review') {
          markPlanNotifyEntered();
          await planNotifyHold;
        }
      },
    });
    const issue = await s.engine.createIssue(s.projectId, { title: '通知窗口取消' });
    s.engine.store.setSubtasks(issue.id, ['实现']);

    const planReady = s.engine.applyEvent(issue.id, 'plan_ready');
    await planNotifyEntered;
    expect(s.engine.store.get(issue.id)!.status).toBe('plan_review');
    let cancelSettled = false;
    const cancel = s.engine.cancelIssue(issue.id, s.admin.id).then((result) => {
      cancelSettled = true;
      return result;
    });
    await flushMicrotasks();
    const cancelSettledBeforeRelease = cancelSettled;

    releasePlanNotify();
    const [, cancelResult] = await Promise.all([planReady, cancel]);

    expect(cancelSettledBeforeRelease).toBe(false);
    expect(cancelResult.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
  });

  test('同 issue 串行：merge_review 内部 git await 期间 cancel 排队，不能遗留 waiting gate', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'review 定格窗口取消' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');

    let releaseHead!: () => void;
    let markHeadEntered!: () => void;
    const headEntered = new Promise<void>((resolve) => {
      markHeadEntered = resolve;
    });
    const headHold = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let headCalls = 0;
    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD' && headCalls++ === 0) {
        markHeadEntered();
        await headHold;
      }
      return rawGit(cwd, args);
    };

    const testsPassed = s.engine.applyEvent(issue.id, 'tests_passed');
    await headEntered;
    let cancelSettled = false;
    const cancel = s.engine.cancelIssue(issue.id, s.admin.id).then((result) => {
      cancelSettled = true;
      return result;
    });
    await flushMicrotasks();
    const cancelSettledBeforeRelease = cancelSettled;

    releaseHead();
    const [, cancelResult] = await Promise.all([testsPassed, cancel]);

    expect(cancelSettledBeforeRelease).toBe(false);
    expect(cancelResult.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
  });

  test('merge_review 生成卡点时 Git 抛错 → 安全 blocked，不遗留无 gate 的 review 半状态', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'review Git 异常' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);

    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      if (args[0] === 'symbolic-ref') throw new Error('模拟 Git 命令超时');
      return rawGit(cwd, args);
    };

    expect((await s.engine.applyEvent(issue.id, 'tests_passed')).ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('blocked');
    expect(s.engine.store.listGates(issue.id).filter((gate) => gate.status === 'waiting')).toHaveLength(0);
    expect(
      s.engine.store
        .listEvents(issue.id)
        .some((event) => event.kind === 'error' && (event.dataJson ?? '').includes('模拟 Git 命令超时')),
    ).toBe(true);
  });

  test('人工重试可为历史遗留的 merge_review 无 gate 状态重新生成卡点', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '恢复 review 卡点' });
    await s.bindJsonl(issue.id);
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const planGate = s.engine.store.listGates(issue.id).find((gate) => gate.kind === 'plan')!;
    expect((await s.engine.decideGate(planGate.id, s.admin.id, 'approve')).ok).toBe(true);
    expect((await s.engine.applyEvent(issue.id, 'impl_done')).ok).toBe(true);
    expect(s.engine.store.casStatus(issue.id, 'testing', 'merge_review')).toBe(true);

    const recovered = await s.engine.retryMissingGate(issue.id, s.admin.id);

    expect(recovered.ok).toBe(true);
    expect(s.engine.store.get(issue.id)!.status).toBe('merge_review');
    expect(
      s.engine.store
        .listGates(issue.id)
        .filter((gate) => gate.kind === 'merge_review' && gate.status === 'waiting'),
    ).toHaveLength(1);
    expect(s.engine.store.listEvents(issue.id).some((event) => event.kind === 'gate_retry')).toBe(true);
    expect((await s.engine.retryMissingGate(issue.id, s.admin.id)).ok).toBe(false);
  });

  test('M3：merge 链通知按发生顺序（merge_review→merging 先于 merging→done 与 issue_done）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '顺序' });
    await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    await engine.applyEvent(issue.id, 'tests_passed');
    const gate = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    s.notifications.length = 0;
    expect((await engine.decideGate(gate.id, s.admin.id, 'approve')).ok).toBe(true);

    const iMerging = s.notifications.findIndex((n) => n.kind === 'status_change' && n.to === 'merging');
    const iDone = s.notifications.findIndex((n) => n.kind === 'status_change' && n.to === 'done');
    const iIssueDone = s.notifications.findIndex((n) => n.kind === 'issue_done');
    expect(iMerging).toBeGreaterThanOrEqual(0);
    expect(iDone).toBeGreaterThan(iMerging); // 外层迁移先通知，嵌套 merged 在后
    expect(iIssueDone).toBeGreaterThan(iDone);
  });

  test('M4：项目归档后 listDriving 不含其 issue，tick 不再驱动', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '归档前在跑' });
    await s.bindJsonl(issue.id);
    expect(s.engine.store.listDriving().map((i) => i.id)).toEqual([issue.id]);

    s.db.query(`UPDATE projects SET status = 'archived' WHERE id = ?`).run(s.projectId);
    expect(s.engine.store.listDriving()).toEqual([]);
    await s.engine.tick();
    expect(s.driver.prompts().length).toBe(0); // 没有任何 kickoff/nudge 注入
  });
});

describe('debug 复用对话（busy 集合含 pending 已绑——v1 漏排修复）', () => {
  test('debug 复用空闲对话；pending 已绑的 conv 不算空闲；一 conv 一未关闭 issue 有约束', async () => {
    const s = await setup();
    const { engine, convs } = s;
    // 一条 pending issue 手动绑上 convA（没开跑也算占用——v1 漏了这半截）
    const t1 = await engine.createIssue(s.projectId, { title: '待办' }, false);
    const convA = convs.create(s.projectId, 'A');
    engine.store.setConv(t1.id, convA.id);
    // 一条空闲历史对话
    const freeConv = convs.create(s.projectId, '历史对话');

    const dbg = await engine.createIssue(s.projectId, { title: '修个报错', category: 'debug' }, false);
    const r = await engine.startIssue(dbg.id);
    expect(r.ok).toBe(true);
    const cur = engine.store.get(dbg.id)!;
    expect(cur.status).toBe('planning');
    expect(cur.convId).toBe(freeConv.id); // 复用空闲对话
    expect(cur.convId).not.toBe(convA.id); // pending 已绑的不抢

    // DB 层约束：把别人的 conv 绑给新 issue 直接抛错
    const t3 = await engine.createIssue(s.projectId, { title: '又一条' }, false);
    expect(() => engine.store.setConv(t3.id, convA.id)).toThrow();
  });
});

describe('issue 目标/源分支准备', () => {
  test('规划前切换已有目标分支并记录实际分支', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/existing']);

    const issue = await s.engine.createIssue(s.projectId, {
      title: '复用已有分支',
      targetBranch: 'feature/existing',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/existing',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/existing');
    expect(s.engine.store.countEvents(issue.id, 'git_branch_prepared')).toBe(1);
  });

  test('分支准备等待 Git 锁期间仍保持 pending，watcher 不得激活或注入规划会话', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/waiting']);

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const creating = s.engine.createIssue(s.projectId, {
      title: '等待分支准备',
      targetBranch: 'feature/waiting',
    });
    await flushMicrotasks();
    const during = s.engine.store.listByProject(s.projectId).find((i) => i.title === '等待分支准备')!;
    const statusWhileLocked = during.status;
    await s.engine.tick();
    const activeWhileLocked = s.convs.currentConv(s.projectId);
    const promptsWhileLocked = s.driver.prompts().length;

    release();
    const [, issue] = await Promise.all([holder, creating]);
    expect(statusWhileLocked).toBe('pending');
    expect(activeWhileLocked).toBeUndefined();
    expect(promptsWhileLocked).toBe(0);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/waiting',
    });
  });

  test('分支准备期间 pending 删除与 start 串行，不能删掉 issue 却遗留 checkout 副作用', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/delete-race']);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '删除竞态',
      targetBranch: 'feature/delete-race',
    }, false);

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const starting = s.engine.startIssue(issue.id);
    await flushMicrotasks();
    let removeSettled = false;
    const removing = s.engine.removeIssue(issue.id).then((result) => {
      removeSettled = true;
      return result;
    });
    await flushMicrotasks();
    const removeSettledWhilePreparing = removeSettled;

    release();
    const [, startResult, removeResult] = await Promise.all([holder, starting, removing]);
    expect(removeSettledWhilePreparing).toBe(false);
    expect(startResult.ok).toBe(true);
    expect(removeResult.ok).toBe(false);
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/delete-race',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/delete-race');
  });

  test('进入 implementing 前在 Git 锁内记录 impl_base，状态发布时锚点已经就绪', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, {
      title: '锁内记录实施起点',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    const gate = s.engine.store.listGates(issue.id).find((g) => g.kind === 'plan')!;

    let release!: () => void;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markLocked();
      await hold;
    });
    await locked;

    const approving = s.engine.decideGate(gate.id, s.admin.id, 'approve');
    await flushMicrotasks();
    const statusWhileLocked = s.engine.store.get(issue.id)!.status;
    const baseWhileLocked = s.engine.implBaseSha(issue.id);

    release();
    await Promise.all([holder, approving]);
    expect(statusWhileLocked).toBe('plan_review');
    expect(baseWhileLocked).toBeNull();
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.implBaseSha(issue.id)).toBe((await s.g(['rev-parse', 'HEAD'])).out.trim());
  });

  test('目标就是当前分支时允许脏工作区，保持原现场', async () => {
    const s = await setup();
    await s.g(['checkout', '-b', 'feature/current']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'dirty but same branch\n');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '留在当前分支',
      targetBranch: 'feature/current',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/current',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feature/current');
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('dirty but same branch\n');
  });

  test('目标不存在时可分别从本地分支和本地已知远程跟踪 ref 创建', async () => {
    const local = await setup();
    await local.g(['checkout', '-b', 'source/local']);
    await fsp.writeFile(path.join(local.repo, 'local-source.txt'), 'local\n');
    await local.g(['add', '.']);
    await local.g(['commit', '-m', 'local source']);
    const localSourceSha = (await local.g(['rev-parse', 'HEAD'])).out.trim();
    await local.g(['checkout', 'main']);

    const localIssue = await local.engine.createIssue(local.projectId, {
      title: '从本地源创建',
      targetBranch: 'feature/from-local',
      sourceRef: 'refs/heads/source/local',
    });
    expect(local.engine.store.get(localIssue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/from-local',
    });
    expect((await local.g(['rev-parse', 'HEAD'])).out.trim()).toBe(localSourceSha);

    const remote = await setup();
    const remoteSourceSha = (await remote.g(['rev-parse', 'HEAD'])).out.trim();
    await remote.g(['update-ref', 'refs/remotes/origin/release', remoteSourceSha]);
    const remoteIssue = await remote.engine.createIssue(remote.projectId, {
      title: '从远程源创建',
      targetBranch: 'feature/from-remote',
      sourceRef: 'refs/remotes/origin/release',
    });
    expect(remote.engine.store.get(remoteIssue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/from-remote',
    });
    expect((await remote.g(['rev-parse', 'HEAD'])).out.trim()).toBe(remoteSourceSha);
    expect((await remote.g(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).code).not.toBe(0);
  });

  test('跨分支遇到脏工作区时安全 blocked，不切分支也不丢改动', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/clean-target']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'unsaved\n');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '脏现场不能切',
      targetBranch: 'feature/clean-target',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'blocked', branch: null });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf8')).toBe('unsaved\n');
    expect(
      s.engine.store.listEvents(issue.id).some(
        (e) => e.kind === 'error' && (e.dataJson ?? '').includes('git-branch'),
      ),
    ).toBe(true);
  });

  test('跨分支 checkout 不覆盖 ignored 本地文件，冲突时保留原内容并转 blocked', async () => {
    const s = await setup();
    const ignoredPath = path.join(s.repo, 'local-cache.txt');
    await fsp.writeFile(path.join(s.repo, '.gitignore'), 'local-cache.txt\n');
    await s.g(['add', '.gitignore']);
    await s.g(['commit', '-m', 'ignore local cache']);
    await s.g(['checkout', '-b', 'feature/tracked-cache']);
    await fsp.writeFile(ignoredPath, 'tracked target content\n');
    await s.g(['add', '-f', 'local-cache.txt']);
    await s.g(['commit', '-m', 'track cache on target']);
    await s.g(['checkout', 'main']);
    await fsp.writeFile(ignoredPath, 'local ignored content\n');
    expect((await s.g(['status', '--porcelain'])).out.trim()).toBe('');

    const issue = await s.engine.createIssue(s.projectId, {
      title: '不要覆盖 ignored 文件',
      targetBranch: 'feature/tracked-cache',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({ status: 'blocked', branch: null });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect(await fsp.readFile(ignoredPath, 'utf8')).toBe('local ignored content\n');
  });

  test('自动收尾前发现实际分支漂移时转 blocked，不 commit/push 或污染 impl_tip', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '分支漂移保护',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await s.engine.applyEvent(issue.id, 'impl_done');
    expect(s.engine.store.get(issue.id)!.status).toBe('testing');

    await s.g(['checkout', '-b', 'accidental']);
    await fsp.writeFile(path.join(s.repo, 'accidental.ts'), 'do not commit\n');
    const before = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'blocked',
      branch: 'main',
    });
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('accidental');
    expect((await s.g(['rev-parse', 'HEAD'])).out.trim()).toBe(before);
    expect((await s.g(['status', '--porcelain'])).out).toContain('?? accidental.ts');
    expect(s.engine.store.countEvents(issue.id, 'auto_commit')).toBe(0);
    expect(s.engine.implTipSha(issue.id)).toBeNull();
  });

  test('自动 Git 失败通知在释放项目 Git 锁后发送，不阻塞手动写操作', async () => {
    let mutex: KeyedMutex | undefined;
    let lockedDuringFailureNotice: boolean | undefined;
    const s = await setup({
      onNotify(event) {
        if (event.summary?.includes('自动 push 失败')) {
          lockedDuringFailureNotice = mutex?.isLocked(gitLockKey(1));
        }
      },
    });
    mutex = s.mutex;
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, {
      title: '失败通知释放 Git 锁',
      targetBranch: 'main',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    await fsp.writeFile(path.join(s.repo, 'notify.ts'), 'export {}\n');
    await s.engine.applyEvent(issue.id, 'impl_done');
    await s.engine.applyEvent(issue.id, 'tests_passed');

    expect(s.engine.store.get(issue.id)!.status).toBe('done');
    expect(lockedDuringFailureNotice).toBe(false);
  });

  test('目标不存在且源缺失或无效时安全 blocked，不创建半成品分支', async () => {
    const s = await setup();
    const invalid = await s.engine.createIssue(s.projectId, {
      title: '无效源',
      targetBranch: 'feature/invalid-source',
      sourceRef: 'refs/remotes/origin/missing',
    });
    expect(s.engine.store.get(invalid.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--list', 'feature/invalid-source'])).out.trim()).toBe('');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');

    const missing = await s.engine.createIssue(s.projectId, {
      title: '未选源',
      targetBranch: 'feature/no-source',
    });
    expect(s.engine.store.get(missing.id)!.status).toBe('blocked');
    expect((await s.g(['branch', '--list', 'feature/no-source'])).out.trim()).toBe('');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
  });

  test('checkout 返回成功但最终分支异常时 blocked，并把观测到的实际分支同步到 issue', async () => {
    const s = await setup();
    await s.g(['branch', 'feature/post-check']);
    const rawGit = s.driver.git.bind(s.driver);
    s.driver.git = async (cwd: string, args: string[]) => {
      const result = await rawGit(cwd, args);
      if (
        result.code === 0
        && args[0] === 'checkout'
        && args.includes('feature/post-check')
      ) {
        await rawGit(cwd, ['checkout', 'main']);
      }
      return result;
    };

    const issue = await s.engine.createIssue(s.projectId, {
      title: '切换后现场异常',
      targetBranch: 'feature/post-check',
    });

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'blocked',
      branch: 'main',
    });
    expect((await rawGit(s.repo, ['branch', '--show-current'])).out.trim()).toBe('main');
  });

  test('分支准备与自动 commit/push 复用项目 Git 锁，impl_base/tip 锚定目标分支', async () => {
    const s = await setup();
    s.setManualReview(false);
    const origin = path.join(s.dir, 'target-origin.git');
    await s.driver.git(s.dir, ['init', '--bare', origin]);
    await s.g(['remote', 'add', 'origin', origin]);
    const sourceSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    await s.g(['update-ref', 'refs/remotes/origin/release', sourceSha]);
    const rawGit = s.driver.git.bind(s.driver);
    let phase: 'prepare' | 'work' | 'finish' = 'prepare';
    let prepareReleased = false;
    let finishReleased = false;
    let prepareGitBeforeRelease = false;
    let finishGitBeforeRelease = false;
    s.driver.git = async (cwd: string, args: string[]) => {
      if (phase === 'prepare' && !prepareReleased) prepareGitBeforeRelease = true;
      if (phase === 'finish' && !finishReleased && args[0] === 'add') finishGitBeforeRelease = true;
      return rawGit(cwd, args);
    };

    let releasePrepare!: () => void;
    let markPrepareLock!: () => void;
    const prepareLocked = new Promise<void>((resolve) => {
      markPrepareLock = resolve;
    });
    const prepareHold = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const heldPrepare = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markPrepareLock();
      await prepareHold;
    });
    await prepareLocked;
    let createSettled = false;
    const creating = s.engine.createIssue(s.projectId, {
      title: '目标分支自动收尾',
      targetBranch: 'feature/auto-target',
      sourceRef: 'refs/remotes/origin/release',
    }).then((created) => {
      createSettled = true;
      return created;
    });
    await flushMicrotasks();
    const createWaitedForLock = !createSettled;
    prepareReleased = true;
    releasePrepare();
    const [, issue] = await Promise.all([heldPrepare, creating]);
    expect(createWaitedForLock).toBe(true);
    expect(prepareGitBeforeRelease).toBe(false);
    phase = 'work';

    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'planning',
      branch: 'feature/auto-target',
    });
    s.engine.store.setSubtasks(issue.id, ['实现']);
    await s.engine.applyEvent(issue.id, 'plan_ready');
    expect(s.engine.store.get(issue.id)!.status).toBe('implementing');
    expect(s.engine.implBaseSha(issue.id)).toBe(sourceSha);

    await fsp.writeFile(path.join(s.repo, 'auto-target.ts'), 'export const target = true;\n');
    await s.engine.applyEvent(issue.id, 'impl_done');

    let releaseFinish!: () => void;
    let markFinishLock!: () => void;
    const finishLocked = new Promise<void>((resolve) => {
      markFinishLock = resolve;
    });
    const finishHold = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    const heldFinish = s.mutex.runExclusive(gitLockKey(s.projectId), async () => {
      markFinishLock();
      await finishHold;
    });
    await finishLocked;
    phase = 'finish';
    let finishSettled = false;
    const finishing = s.engine.applyEvent(issue.id, 'tests_passed').then((result) => {
      finishSettled = true;
      return result;
    });
    await flushMicrotasks();
    const finishWaitedForLock = !finishSettled;
    finishReleased = true;
    releaseFinish();
    await Promise.all([heldFinish, finishing]);
    expect(finishWaitedForLock).toBe(true);
    expect(finishGitBeforeRelease).toBe(false);

    const localHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    const remoteHead = (await s.driver.git(origin, ['rev-parse', 'refs/heads/feature/auto-target'])).out.trim();
    expect(s.engine.store.get(issue.id)).toMatchObject({
      status: 'done',
      branch: 'feature/auto-target',
    });
    expect(remoteHead).toBe(localHead);
    expect(s.engine.implTipSha(issue.id)).toBe(localHead);
    const snap = s.engine.implCommits(issue.id)!;
    expect(snap.base).toBe(sourceSha);
    expect(snap.tip).toBe(localHead);
    expect(snap.files.map((f) => f.path)).toContain('auto-target.ts');
  }, 30000);
});

describe('历史 issue 未配置目标分支（沿用开发者分支且不做本地合并）', () => {
  test('开发者停在自己的分支 dev 上连续干活：prompt 报 dev、不建额外分支、approve 后不产生本地 merge、仍留在 dev', async () => {
    const s = await setup();
    const { engine } = s;
    // 开发者自己从 develop/main checkout 出分支 dev 并切过去（这是 GitLab MR 流的常态）
    await s.g(['checkout', '-b', 'dev']);

    const issue = await engine.createIssue(s.projectId, { title: '在 dev 上加功能', module: 'x' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // planning kickoff
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写点东西\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);

    // 未配置 targetBranch：implementing 留在 dev，不创建额外的 issue/<id>
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(engine.store.get(issue.id)!.branch).toBe('dev');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('dev');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    // 起点 sha 已记录（供 merge_review 只 diff 本 issue）
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);

    // 子任务 prompt 报的是 dev，绝不出现 issue/<id>
    await engine.tick();
    const subPrompt = s.driver.prompts().find((t) => t.includes('【实施 子任务'))!;
    expect(subPrompt).toContain('当前工作分支 dev');
    expect(subPrompt).not.toContain(`issue/${issue.id}`);

    // 在 dev 上做真实改动并提交
    await fsp.writeFile(path.join(s.repo, 'feat.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat on dev']);

    // SUBTASK_DONE → testing → STAGE_DONE → merge_review
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');

    // 起点/终点锚点：merge_review 定格 impl_tip=本 issue 最后一条提交（feat on dev），
    // 起点 impl_base=动手前的 dev tip（≠终点）——per-issue git 视图据此取 start..tip 只含本 issue。
    const devHead = (await s.g(['rev-parse', 'HEAD'])).out.trim();
    expect(engine.implTipSha(issue.id)).toBe(devHead);
    expect(engine.implBaseSha(issue.id)).not.toBe(devHead);
    expect(engine.implBaseSha(issue.id)).not.toBeNull();

    // merge_review payload：只 diff 本 issue 的改动（含 feat.ts），分支 dev
    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(g2.payloadJson!) as { branch: string; diff: string };
    expect(payload.branch).toBe('dev');
    expect(payload.diff).toContain('feat.ts');

    // approve → merging（不做本地合并）→ done
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    // base(main) 未被动过：main 仍只有初始提交，没有 merge 提交、没有 feat.ts
    expect((await s.g(['log', '--oneline', 'main'])).out.trim().split('\n').length).toBe(1);
    // 收尾没切分支：仍停在 dev
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('dev');
    // 合并被显式跳过留痕
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
  }, 30000);

  test('工作区有未提交改动、且不在 base 分支：进 implementing 不再因 checkout 失败而 blocked（zd885k 回归）', async () => {
    const s = await setup();
    const { engine } = s;
    // 复现线上场景：项目 cwd 停在非 main 分支上、且有未提交改动（该文件与 main 版本不同）。
    // 老引擎会 `checkout -b issue/<id> main`，git 报「Your local changes would be overwritten by
    // checkout」→ 分支失败 → blocked → 反复 unblock 重来 → 一直堵塞。新引擎不 checkout，天然免疫。
    await s.g(['checkout', '-b', 'work']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'work committed\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'work 分支改了 README（与 main 不同）']);
    await fsp.writeFile(path.join(s.repo, 'README.md'), 'dirty 未提交改动\n'); // 未提交本地改动

    const issue = await engine.createIssue(s.projectId, { title: 'v2mando 首页按图例改', module: 'ui' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 改首页\nSUBTASKS_END'));
    await engine.tick();
    const g = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g.id, s.admin.id, 'approve')).ok).toBe(true);

    // 关键：直接进 implementing，没有 git-branch 失败事件、没有被 blocked
    const cur = engine.store.get(issue.id)!;
    expect(cur.status).toBe('implementing');
    expect(cur.branch).toBe('work'); // 就在开发者当前分支上，不切走
    expect(
      engine.store.listEvents(issue.id).some((e) => e.kind === 'error' && (e.dataJson ?? '').includes('git-branch')),
    ).toBe(false);
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'transition' && (e.dataJson ?? '').includes('"to":"blocked"'))).toBe(false);
    // 未提交改动原样保留（引擎没动工作树）
    expect(await fsp.readFile(path.join(s.repo, 'README.md'), 'utf-8')).toContain('dirty 未提交改动');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
  }, 30000);
});

describe('固定分支默认（沿用当前分支）+ 本 issue commit ids/文件改动耐久快照', () => {
  test('当前停在非 base 分支：沿用它、不切 main、不建 issue 分支；范围收本 issue 净提交（不比 main）', async () => {
    const s = await setup();
    const { engine } = s;

    // 用户切到自己的固定/长期分支 feat/x，并先落一条**别的**历史改动（用来证明范围不含它）
    await s.g(['checkout', '-b', 'feat/x']);
    await fsp.writeFile(path.join(s.repo, 'preexisting.ts'), 'pre\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', '别的历史改动 on feat/x']);
    const preSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // 没有配置 work_branch —— 引擎应默认沿用当前分支 feat/x，绝不从 main 切 issue/<id>
    const issue = await engine.createIssue(s.projectId, { title: '在 feat/x 上加功能', module: 'x' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写点东西\nSUBTASKS_END'));
    await engine.tick(); // → plan_review
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);

    // implementing：留在 feat/x（不是 main、不是 issue/<id>），没有新建 issue 分支
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    expect(engine.store.get(issue.id)!.branch).toBe('feat/x');
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feat/x');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    // 起点 sha = 动手前的 feat/x tip（那条历史改动），供范围只取本 issue
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);
    expect(engine.implBaseSha(issue.id)).toBe(preSha);

    // 子任务 prompt 报 feat/x，绝不出现 issue/<id>
    await engine.tick();
    const subPrompt = s.driver.prompts().find((t) => t.includes('【实施 子任务'))!;
    expect(subPrompt).toContain('当前工作分支 feat/x');
    expect(subPrompt).not.toContain(`issue/${issue.id}`);

    // 本 issue 的真实改动落在 feat/x 上
    await fsp.writeFile(path.join(s.repo, 'feature.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: 本 issue 的改动']);
    const featSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    // SUBTASK_DONE → testing → STAGE_DONE → merge_review
    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('testing');
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');

    // 终点定格 = 本 issue 最后一条提交
    expect(engine.implTipSha(issue.id)).toBe(featSha);

    // 耐久快照：本 issue 涉及的 commit ids + 文件改动（不含那条历史改动）
    const snap = engine.implCommits(issue.id)!;
    expect(snap).not.toBeNull();
    expect(snap.base).toBe(preSha);
    expect(snap.tip).toBe(featSha);
    expect(snap.commits.map((c) => c.sha)).toEqual([featSha]);
    expect(snap.commits[0]!.subject).toContain('feat: 本 issue');
    expect(snap.files.map((f) => f.path)).toContain('feature.ts');
    expect(snap.files.map((f) => f.path)).not.toContain('preexisting.ts');

    // merge_review payload：只 diff 本 issue（start..tip），带 commit ids/文件；不含历史改动、不比 main
    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    const payload = JSON.parse(g2.payloadJson!) as {
      branch: string; base: string; range?: string; diff: string;
      commits?: Array<{ sha: string }>; files?: Array<{ path: string }>;
    };
    expect(payload.branch).toBe('feat/x');
    expect(payload.range).toBe(`${preSha}..${featSha}`);
    expect(payload.commits!.map((c) => c.sha)).toEqual([featSha]);
    expect(payload.files!.map((f) => f.path)).toContain('feature.ts');
    expect(payload.diff).toContain('feature.ts');
    expect(payload.diff).not.toContain('preexisting.ts'); // 关键：没和 main 对比

    // approve → done：base(main) 未被动、仍留在 feat/x、合并被显式跳过
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    expect((await s.g(['log', '--oneline', 'main'])).out.trim().split('\n').length).toBe(1);
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('feat/x');
    expect(engine.store.listEvents(issue.id).some((e) => e.kind === 'merge_skipped')).toBe(true);
    // done 兜底没有把 impl_tip 覆写成别的（仍是本 issue 提交），也没重复落快照
    expect(engine.implTipSha(issue.id)).toBe(featSha);
    expect(engine.store.countEvents(issue.id, 'impl_commits')).toBe(1);
  }, 30000);

  test('停在 main：也在 main 上直接干活并记录 impl_base + 提交快照，approve 后不产生本地 merge 提交', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '加导出', body: 'CSV', module: 'export' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick();
    await s.appendOutput(jl, asst('SUBTASKS_BEGIN\n1. 写导出器\nSUBTASKS_END'));
    await engine.tick();
    const g1 = engine.store.listGates(issue.id)[0]!;
    expect((await engine.decideGate(g1.id, s.admin.id, 'approve')).ok).toBe(true);
    // 不建/不切分支：就在 main 上干活；起点 sha 照记
    expect(engine.store.get(issue.id)!.branch).toBe('main');
    expect((await s.g(['branch', '--list', 'issue/*'])).out.trim()).toBe('');
    expect(engine.store.countEvents(issue.id, 'impl_base')).toBe(1);

    await fsp.writeFile(path.join(s.repo, 'export.ts'), 'export {}\n');
    await s.g(['add', '.']);
    await s.g(['commit', '-m', 'feat: export']);
    const exportSha = (await s.g(['rev-parse', 'HEAD'])).out.trim();

    await s.appendOutput(jl, asst(`SUBTASK_DONE:${issue.id}`));
    await engine.tick();
    await s.appendOutput(jl, asst(`STAGE_DONE:${issue.id}:testing`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('merge_review');
    // 定格在本 issue 的提交，快照含该 commit id
    expect(engine.implTipSha(issue.id)).toBe(exportSha);
    const snap = engine.implCommits(issue.id)!;
    expect(snap.commits.map((c) => c.sha)).toEqual([exportSha]);
    expect(snap.files.map((f) => f.path)).toContain('export.ts');

    const g2 = engine.store.listGates(issue.id).find((x) => x.kind === 'merge_review')!;
    expect((await engine.decideGate(g2.id, s.admin.id, 'approve')).ok).toBe(true);
    expect(engine.store.get(issue.id)!.status).toBe('done');
    // 改动直接在 main 上，无本地 merge 提交；HEAD 就是本 issue 的提交
    expect((await s.g(['branch', '--show-current'])).out.trim()).toBe('main');
    expect((await s.g(['log', '--oneline', '-1'])).out).toContain('feat: export');
    // impl_tip 未被覆写，快照仍只一份（done 兜底不重复）
    expect(engine.implTipSha(issue.id)).toBe(exportSha);
    expect(engine.store.countEvents(issue.id, 'impl_commits')).toBe(1);
  }, 30000);
});

describe('同模块智能合并（调度前 LLM 归并）', () => {
  test('scheduleNext 前合并同模块 pending：host 换合并内容并开跑，被并入的 cancelled', async () => {
    const s = await setup();
    const { engine, pm } = s;
    // 同模块 web 三条 pending（未起跑）
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    const d = await engine.createIssue(s.projectId, { title: 'D', body: 'dd', module: 'web' }, false);
    // 另一模块的 pending 不受影响、不进 web 的候选
    const other = await engine.createIssue(s.projectId, { title: 'X', module: 'api' }, false);

    // LLM 判：B、C 可并（D 独立）
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: '1) bb\n2) cc' }];

    await engine.scheduleNext(s.projectId, 'web');

    // LLM 只拿到 web 模块候选（含 b/c/d，不含 api 的 other）
    expect(pm.mergeCalls.length).toBe(1);
    expect(pm.mergeCalls[0]!.module).toBe('web');
    expect(pm.mergeCalls[0]!.ids.sort()).toEqual([b.id, c.id, d.id].sort());

    // host = 最早的 B：换成合并后 title/body，并已开跑
    const host = engine.store.get(b.id)!;
    expect(host.title).toBe('合并 B+C');
    expect(host.body).toBe('1) bb\n2) cc');
    expect(host.status).toBe('planning');
    // C 被折叠 → cancelled；D 仍 pending；other 不动
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
    expect(engine.store.get(d.id)!.status).toBe('pending');
    expect(engine.store.get(other.id)!.status).toBe('pending');
    // 事件留痕
    expect(engine.store.listEvents(b.id).some((e) => e.kind === 'tasks_merged')).toBe(true);
    expect(engine.store.listEvents(c.id).some((e) => e.kind === 'merged_into')).toBe(true);
  });

  test('autoMerge=false → 不问 LLM，直接按模块聚合挑选开跑', async () => {
    const s = await setup();
    // 关掉合并的引擎实例（复用同 DB/依赖）
    const engine = new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: { locate: (id) => (s.jsonl.get(id) ? Promise.resolve(s.jsonl.get(id)!) : Promise.resolve(null)) },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: s.mutex,
      config: { kickoffMinBootMs: 0, now: s.clock.now, autoMerge: false, resultSummaryTimeoutMs: 0 },
    });
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'web' }, false);
    s.pm.merges = [{ members: [b.id, c.id], title: '不该发生', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(s.pm.mergeCalls.length).toBe(0);
    expect(engine.store.get(b.id)!.title).toBe('B'); // 未被改写
    expect(engine.store.get(b.id)!.status).toBe('planning'); // 正常开跑
    expect(engine.store.get(c.id)!.status).toBe('pending'); // 未被折叠
  });

  test('不同 agent 的同模块任务不并（跨 agent 会改实施语义）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'web', agent: 'claude' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'web', agent: 'codex' }, false);
    // 即便 LLM「想」合并，引擎按 (agent,category,implMode) 分桶后两条各自单飞、不会送进同一次调用
    pm.merges = [{ members: [b.id, c.id], title: '跨 agent', body: 'x' }];

    await engine.scheduleNext(s.projectId, 'web');

    // 两个桶各 1 条 → 都 <2，根本不问 LLM
    expect(pm.mergeCalls.length).toBe(0);
    expect(engine.store.get(c.id)!.status).toBe('pending');
    expect(engine.store.get(b.id)!.title).toBe('B');
  });

  test('目标分支或源 ref 不同的 pending 不自动合并，只向 LLM 提交 Git 意图相同的子组', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const sameA = await engine.createIssue(s.projectId, {
      title: 'same A',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    }, false);
    const sameB = await engine.createIssue(s.projectId, {
      title: 'same B',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    }, false);
    const otherTarget = await engine.createIssue(s.projectId, {
      title: 'other target',
      module: 'web',
      targetBranch: 'feature/other',
      sourceRef: 'refs/heads/main',
    }, false);
    const otherSource = await engine.createIssue(s.projectId, {
      title: 'other source',
      module: 'web',
      targetBranch: 'feature/85',
      sourceRef: 'refs/remotes/origin/main',
    }, false);
    pm.merges = [{
      members: [sameA.id, sameB.id],
      title: 'same pair merged',
      body: 'merged',
    }];

    await engine.scheduleNext(s.projectId, 'web');

    expect(pm.mergeCalls).toEqual([{
      module: 'web',
      ids: [sameA.id, sameB.id],
    }]);
    expect(engine.store.get(sameA.id)!.title).toBe('same pair merged');
    expect(engine.store.get(sameB.id)!.status).toBe('cancelled');
    expect(engine.store.get(otherTarget.id)!.status).toBe('pending');
    expect(engine.store.get(otherSource.id)!.status).toBe('pending');
  });

  test('自动合并落地期间串行 pending Git 编辑，不能在重验后改出跨分支合并', async () => {
    let foldedId = 0;
    let markFoldNotify!: () => void;
    const foldNotify = new Promise<void>((resolve) => {
      markFoldNotify = resolve;
    });
    let releaseFoldNotify!: () => void;
    const foldNotifyHold = new Promise<void>((resolve) => {
      releaseFoldNotify = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.issueId === foldedId && event.to === 'cancelled') {
          markFoldNotify();
          await foldNotifyHold;
        }
      },
    });
    const intent = { targetBranch: 'feature/85', sourceRef: 'refs/heads/main' };
    const a = await s.engine.createIssue(s.projectId, { title: 'A', module: 'web', ...intent }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', module: 'web', ...intent }, false);
    const c = await s.engine.createIssue(s.projectId, { title: 'C', module: 'web', ...intent }, false);
    foldedId = b.id;
    s.pm.merges = [{ members: [a.id, b.id, c.id], title: 'ABC', body: 'merged' }];

    const scheduled = s.engine.scheduleNext(s.projectId, 'web');
    await foldNotify;
    let editSettled = false;
    const edit = s.engine
      .updatePendingMeta(c.id, {
        targetBranch: 'feature/other',
        sourceRef: 'refs/heads/main',
      })
      .then(
        (updated) => {
          editSettled = true;
          return { ok: true as const, updated };
        },
        (error: Error) => {
          editSettled = true;
          return { ok: false as const, error };
        },
      );
    await flushMicrotasks();
    expect(editSettled).toBe(false);

    releaseFoldNotify();
    await scheduled;
    const editResult = await edit;
    // #93 起 cancelled 可编辑，所以这条编辑会成功——但它只落在**已被折叠的 C 自己**身上：
    // 折叠已经完成，C 是死的，改它的分支意图影响不到宿主 issue 的合并结果。
    // 本用例真正守的是**串行性**（上面 editSettled 必须为 false，编辑不能插进落地过程中间）。
    expect(editResult.ok).toBe(true);
    expect(s.engine.store.get(c.id)).toMatchObject({ status: 'cancelled', targetBranch: 'feature/other' });
    // 宿主 issue 的分支意图不受这条迟到编辑影响，跨分支合并仍不可能发生
    expect(s.engine.store.get(a.id)).toMatchObject({
      targetBranch: 'feature/85',
      sourceRef: 'refs/heads/main',
    });
  });

  test('三成员自动合并取消途中并发 start 不形成 issue-meta/transition 锁反转', async () => {
    let pausedId = 0;
    let markPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    let releasePause!: () => void;
    const pauseHold = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const s = await setup({
      onNotify: async (event) => {
        if (event.kind === 'status_change' && event.issueId === pausedId && event.to === 'cancelled') {
          markPaused();
          await pauseHold;
        }
      },
    });
    const intent = { targetBranch: 'feature/merge-lock', sourceRef: 'refs/heads/main' };
    const a = await s.engine.createIssue(s.projectId, { title: 'A', module: 'web', ...intent }, false);
    const b = await s.engine.createIssue(s.projectId, { title: 'B', module: 'web', ...intent }, false);
    const c = await s.engine.createIssue(s.projectId, { title: 'C', module: 'web', ...intent }, false);
    pausedId = b.id;
    s.pm.merges = [{ members: [a.id, b.id, c.id], title: 'ABC', body: 'merged' }];

    const scheduled = s.engine.scheduleNext(s.projectId, 'web');
    await paused;
    let startSettled = false;
    const starting = s.engine.startIssue(c.id).then((result) => {
      startSettled = true;
      return result;
    });
    await flushMicrotasks();
    expect(startSettled).toBe(false);

    releasePause();
    const completed = await Promise.race([
      Promise.all([scheduled, starting]).then(([, result]) => ({ completed: true as const, result })),
      new Promise<{ completed: false }>((resolve) => setTimeout(() => resolve({ completed: false }), 250)),
    ]);
    expect(completed.completed).toBe(true);
    if (!completed.completed) return;
    expect(completed.result.ok).toBe(false);
    expect(s.engine.store.get(a.id)!.status).toBe('planning');
    expect(s.engine.store.get(b.id)!.status).toBe('cancelled');
    expect(s.engine.store.get(c.id)!.status).toBe('cancelled');
  });
});

describe('置顶调整优先级（setPinned）', () => {
  test('置顶一条 pending：项目空闲时被优先开跑（压过同模块更早的 FIFO），留痕 pinned 事件', async () => {
    const s = await setup();
    const { engine } = s;
    // 三条 pending（未起跑）：A、C 同模块 a（A 更早），B 模块 b
    const a = await engine.createIssue(s.projectId, { title: 'A', module: 'a' }, false);
    const b = await engine.createIssue(s.projectId, { title: 'B', module: 'b' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', module: 'a' }, false);

    const r = await engine.setPinned(c.id, true, s.admin.id);
    expect(r.ok).toBe(true);

    // C 被置顶并优先开跑；A（同模块更早）、B 仍排队
    const cur = engine.store.get(c.id)!;
    expect(cur.pinnedTs).toBeGreaterThan(0);
    expect(cur.status).toBe('planning');
    expect(engine.store.get(a.id)!.status).toBe('pending');
    expect(engine.store.get(b.id)!.status).toBe('pending');
    expect(engine.store.listEvents(c.id).some((e) => e.kind === 'pinned')).toBe(true);
  });

  test('非 pending 不可置顶（已开跑无意义）', async () => {
    const s = await setup();
    const { engine } = s;
    const a = await engine.createIssue(s.projectId, { title: 'A' }, false);
    await engine.setPinned(a.id, true); // 置顶后立即被开跑 → planning
    expect(engine.store.get(a.id)!.status).toBe('planning');
    const r = await engine.setPinned(a.id, true); // 再置顶：已 planning → 拒绝
    expect(r.ok).toBe(false);
  });

  test('取消置顶：pinned_ts 清空、留痕 unpinned', async () => {
    const s = await setup();
    const { engine } = s;
    // 先占位一条在跑，避免置顶目标被立即开跑（便于验证 pin/unpin 的纯存取）
    const host = await engine.createIssue(s.projectId, { title: '占位', module: 'busy' }, false);
    await engine.setPinned(host.id, true); // host → planning，项目变忙
    const q = await engine.createIssue(s.projectId, { title: '排队', module: 'q' }, false);
    expect(engine.store.get(q.id)!.status).toBe('pending');

    await engine.setPinned(q.id, true);
    expect(engine.store.get(q.id)!.pinnedTs).toBeGreaterThan(0);
    expect(engine.store.get(q.id)!.status).toBe('pending'); // 项目忙 → 不抢跑，只调顺序

    const r = await engine.setPinned(q.id, false);
    expect(r.ok).toBe(true);
    expect(engine.store.get(q.id)!.pinnedTs).toBeNull();
    expect(engine.store.listEvents(q.id).some((e) => e.kind === 'unpinned')).toBe(true);
  });

  test('置顶被同模块合并吞并时：置顶带到 host（意图不丢）', async () => {
    const s = await setup();
    const { engine, pm } = s;
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    // LLM 判 B、C 可并（host 会是更早的 B，未置顶）
    pm.merges = [{ members: [b.id, c.id], title: '合并 B+C', body: 'x' }];

    // 置顶较晚的 C → 触发调度：先合并（C 折叠入 host B）→ B 继承置顶 → B 开跑
    await engine.setPinned(c.id, true);

    const host = engine.store.get(b.id)!;
    expect(host.pinnedTs).toBeGreaterThan(0); // 置顶随合并带到 host
    expect(host.status).toBe('planning');
    expect(engine.store.get(c.id)!.status).toBe('cancelled');
  });
});

// ---------- 创建时澄清（后台执行代理分析） ----------

describe('澄清派生：execClarifyWait / clarifyPendingOf（事件溯源、跨状态、免迁移）', () => {
  test('execClarifyWait：exec 问题无 clarified/timeout → 等待中；创建时问题不算；回答后 null', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'X' });
    expect(st.execClarifyWait(iss.id)).toBeNull(); // 没问题

    // 创建时问题（source≠exec）不算执行中等待
    st.logEvent(iss.id, 'clarify_questions', { questions: ['创建时问？'], source: 'create' });
    expect(st.execClarifyWait(iss.id)).toBeNull();

    // 执行中问题（source=exec）→ 等待中，带 since/questions/stage
    st.logEvent(iss.id, 'clarify_questions', {
      questions: ['用哪个库？', '下线钮蓝色？'],
      source: 'exec',
      stage: 'planning',
    });
    const w = st.execClarifyWait(iss.id);
    expect(w).not.toBeNull();
    expect(w!.questions).toEqual(['用哪个库？', '下线钮蓝色？']);
    expect(w!.stage).toBe('planning');
    expect(w!.since).toBeGreaterThan(0);

    // 回答后不再等待
    st.logEvent(iss.id, 'clarified', { answer: '用 A' });
    expect(st.execClarifyWait(iss.id)).toBeNull();
  });

  test('execClarifyWait：超时自动继续（clarify_timeout）后不再等待；下一轮 exec 又等待（最新一条为准）', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'Y' });
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q1'], source: 'exec', stage: 'implementing' });
    expect(st.execClarifyWait(iss.id)).not.toBeNull();
    st.logEvent(iss.id, 'clarify_timeout', {});
    expect(st.execClarifyWait(iss.id)).toBeNull();
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q2'], source: 'exec', stage: 'implementing' });
    expect(st.execClarifyWait(iss.id)!.questions).toEqual(['q2']);
  });

  test('clarifyPendingOf 跨状态：创建时问题（不限 pending）待答，回答后收起；执行中超时也收起', async () => {
    const s = await setup();
    const st = s.engine.store;
    const iss = st.create(s.projectId, { title: 'Z' });
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
    st.logEvent(iss.id, 'clarify_questions', { questions: ['创建时问？'], source: 'create' });
    expect(st.clarifyPendingOf(iss.id)).toBe(true); // 第 5 点：不受状态限制
    st.logEvent(iss.id, 'clarified', { answer: 'ok' });
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
    // 执行中问题 → 待答；20 分钟超时自动继续后收起
    st.logEvent(iss.id, 'clarify_questions', { questions: ['q'], source: 'exec', stage: 'planning' });
    expect(st.clarifyPendingOf(iss.id)).toBe(true);
    st.logEvent(iss.id, 'clarify_timeout', {});
    expect(st.clarifyPendingOf(iss.id)).toBe(false);
  });

  test('EngineConfig.clarifyTimeoutMs 默认 20 分钟', () => {
    expect(DEFAULT_ENGINE_CONFIG.clarifyTimeoutMs).toBe(20 * 60 * 1000);
  });
});

describe('执行中澄清：NEED_CLARIFY 检测 + 停催停判 + 超时自动继续', () => {
  test('检测：记 clarify_questions(exec)+通知+不推进；幂等；等待期停催停判', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '技能中心样式', body: '样式要跟首页一致' });
    const jl = await s.bindJsonl(issue.id);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    await engine.tick(); // kickoff planning

    // 代理按编号提问 + NEED_CLARIFY 哨兵（散文行/哨兵行都不当问题）
    await s.appendOutput(
      jl,
      asst(`需要先确认几点：\n1. 用哪个库 axios 还是 fetch？\n2. 下线钮改蓝色吗？\nNEED_CLARIFY:${issue.id}`),
    );
    await engine.tick();

    const qEv = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions');
    expect(qEv.length).toBe(1);
    expect(JSON.parse(qEv[0]!.dataJson!)).toMatchObject({ source: 'exec', stage: 'planning' });
    expect(JSON.parse(qEv[0]!.dataJson!).questions).toEqual([
      '用哪个库 axios 还是 fetch？',
      '下线钮改蓝色吗？',
    ]);
    // 原文留档（#110）：散文前提保留、哨兵行剔除——UI 靠它完整展示代理原话
    expect(JSON.parse(qEv[0]!.dataJson!).text).toBe(
      '需要先确认几点：\n1. 用哪个库 axios 还是 fetch？\n2. 下线钮改蓝色吗？',
    );
    expect(engine.store.get(issue.id)!.status).toBe('planning'); // 不推进
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(
      s.notifications.some((n) => n.issueId === issue.id && (n.summary ?? '').includes('执行中需要你澄清')),
    ).toBe(true);
    expect(s.notifications.some((n) => (n.summary ?? '').includes('下线钮改蓝色'))).toBe(true);
    // 推送带需求正文摘要：手机上收到就知道这条 issue 原来在做什么
    expect(s.notifications.some((n) => (n.summary ?? '').includes('需求：样式要跟首页一致'))).toBe(true);
    const notifN = s.notifications.filter((n) => (n.summary ?? '').includes('执行中需要你澄清')).length;

    // 幂等：再输出一遍 NEED_CLARIFY，不重复记事件/不重复推送
    await s.appendOutput(jl, asst(`还是那几个问题\nNEED_CLARIFY:${issue.id}`));
    await engine.tick();
    expect(engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions').length).toBe(1);
    expect(s.notifications.filter((n) => (n.summary ?? '').includes('执行中需要你澄清')).length).toBe(notifN);

    // 等待期停催停判：静默超过 nudge(180s)/fallback(360s) 但未到 clarifyTimeout(600s)
    s.pm.judgement = 'done';
    clock.advance(400_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(0);
    expect(s.pm.judgeCalls).toBe(0);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
  });

  test('第二层保险：PM 空闲判 clarify（代理忘输出 NEED_CLARIFY）→ 标记等待，不 block/不 nudge', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 2_000_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '忘了哨兵' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff planning
    // 代理在提问但没输出 NEED_CLARIFY 哨兵（散文式提问）→ 哨兵路径不触发，靠 PM 兜底判 clarify
    await s.appendOutput(jl, asst('我需要你先确认：\n1. 用哪个库 axios 还是 fetch？\n等你回复'));
    await engine.tick(); // 消费活动
    s.pm.judgement = 'clarify';

    clock.advance(181_000);
    await engine.tick(); // 还没进入等待 → 先常规 nudge
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
    clock.advance(361_000);
    await engine.tick(); // 静默兜底判 clarify → 进入等待
    expect(s.pm.judgeCalls).toBe(1);

    const qEv = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarify_questions');
    expect(qEv.length).toBe(1);
    expect(JSON.parse(qEv[0]!.dataJson!)).toMatchObject({ source: 'exec', via: 'judge' });
    // 块级抽取（#110）：清单项后紧跟的续行并入同一条；原文另落 text 字段供 UI 完整展示
    expect(JSON.parse(qEv[0]!.dataJson!).questions).toEqual(['用哪个库 axios 还是 fetch？\n等你回复']);
    expect(JSON.parse(qEv[0]!.dataJson!).text).toContain('我需要你先确认：');
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(engine.store.get(issue.id)!.status).toBe('planning'); // 不 block
    expect(
      s.notifications.some((n) => n.issueId === issue.id && (n.summary ?? '').includes('执行中需要你澄清')),
    ).toBe(true);

    // 进入等待后停判：execClarifyWait 非空 → 不再 judge（clarifyTimeout 2000s 内不触发超时）
    clock.advance(400_000);
    await engine.tick();
    expect(s.pm.judgeCalls).toBe(1);
    expect(engine.store.get(issue.id)!.status).toBe('planning');
  });

  test('答复直达会话：驱动态注入【澄清答复】+ 记 clarified(exec) + 解除等待 + 复位续跑', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '执行中澄清答复' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff planning
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick(); // 进入等待
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();

    const r = await engine.clarify(issue.id, '用 axios');
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ from: 'planning', to: 'planning' }); // 不迁移状态
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】用 axios'))).toBe(true);
    const clr = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarified');
    expect(clr.length).toBe(1);
    expect(JSON.parse(clr[0]!.dataJson!)).toMatchObject({ source: 'exec' });
    expect(engine.store.execClarifyWait(issue.id)).toBeNull(); // 解除等待
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(false);

    // 复位续跑：静默 181s 后常规 nudge 恢复（不再停催）
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
  });

  test('代理退回 shell 时答复不盲发：回明确错误 + 自动重启，答复不算已答（issue #97）', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 600_000 } });
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '答复不能丢' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick(); // 进入等待
    const convId = engine.store.get(issue.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);

    s.driver.pane = '[root@VM p]#'; // 代理没了，窗格只剩 bash
    s.driver.paneCommands.set(session, 'bash');
    s.clock.advance(61_000); // 过判死硬闸
    const sentBefore = s.driver.sent.length;
    const r = await engine.clarify(issue.id, '用 axios');

    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ error: expect.stringContaining('已自动重启') });
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】'))).toBe(false); // 一个字都没进 bash
    expect(engine.store.countEvents(issue.id, 'clarified')).toBe(0); // 不算已答，等待状态保留
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();
    expect(engine.store.countEvents(issue.id, 'agent_down')).toBe(1);
    // 已经把代理重起来了，用户重发就能落地
    expect(s.driver.sent.slice(sentBefore).some((x) => x.text === `claude --resume ${convId}`)).toBe(true);
  });

  test('第 5 点：创建时问题开跑后回答 → 注入会话 + clarified(post_start)；答前一直待答', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '开跑后补答' });
    // 模拟创建时澄清留下的问题（source≠exec）：开跑后仍应显示待答（clarifyPendingOf 跨状态）
    engine.store.logEvent(issue.id, 'clarify_questions', { source: 'create', questions: ['要支持哪些格式？'] });
    await s.bindJsonl(issue.id);
    await engine.tick(); // 已在 planning
    expect(engine.store.get(issue.id)!.status).toBe('planning');
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(true); // 第 5 点：开跑后仍待答
    expect(engine.store.execClarifyWait(issue.id)).toBeNull(); // 但非「执行中等待」（不停催）

    const r = await engine.clarify(issue.id, 'CSV 和 JSON 都要');
    expect(r.ok).toBe(true);
    expect(s.driver.prompts().some((t) => t.includes('【澄清答复】CSV 和 JSON 都要'))).toBe(true);
    const clr = engine.store.listEvents(issue.id).filter((e) => e.kind === 'clarified');
    expect(JSON.parse(clr[0]!.dataJson!)).toMatchObject({ source: 'post_start' });
    expect(engine.store.clarifyPendingOf(issue.id)).toBe(false); // 答后收起
  });

  test('超时自动继续：到点注入「按最佳判断继续」+ 记 clarify_timeout + 复位续跑', async () => {
    const s = await setup({ config: { clarifyTimeoutMs: 300_000 } });
    const { engine, clock } = s;
    const issue = await engine.createIssue(s.projectId, { title: '超时用例' });
    const jl = await s.bindJsonl(issue.id);
    await engine.tick(); // kickoff planning
    await s.appendOutput(jl, asst(`1. 用哪个库？\nNEED_CLARIFY:${issue.id}`));
    await engine.tick();
    expect(engine.store.execClarifyWait(issue.id)).not.toBeNull();

    // 到点（> clarifyTimeoutMs，留足实钟偏移缓冲）→ 自动继续
    clock.advance(360_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'clarify_timeout')).toBe(1);
    expect(s.driver.prompts().some((t) => t.includes('未收到你对刚才澄清'))).toBe(true);
    expect(engine.store.execClarifyWait(issue.id)).toBeNull(); // 不再等待
    expect(engine.store.get(issue.id)!.status).toBe('planning');

    // 复位续跑：再静默 181s → 常规 nudge 恢复
    clock.advance(181_000);
    await engine.tick();
    expect(engine.store.countEvents(issue.id, 'nudged')).toBe(1);
  });
});

describe('创建时澄清：后台分析不占队列不改状态', () => {
  /** 可编程澄清 stub：记录调用、并发峰值，支持 gate 挂起（竞态测试用） */
  function mkClarify() {
    const st = {
      calls: [] as Array<{ project: Project; input: EngineClarifyInput }>,
      inflight: 0,
      maxInflight: 0,
      result: {
        ok: true,
        feedback: '反馈：懂了',
        questions: ['问 1？'],
        questionsText: '1. 问 1？\n   A. 选项一\n   B. 选项二',
      } as EngineClarifyResult,
      gate: null as null | Promise<void>,
      fn: (async () => ({ ok: false, reason: 'unset' })) as (
        project: Project,
        input: EngineClarifyInput,
      ) => Promise<EngineClarifyResult>,
    };
    st.fn = async (project: Project, input: EngineClarifyInput) => {
      st.calls.push({ project, input });
      st.inflight++;
      st.maxInflight = Math.max(st.maxInflight, st.inflight);
      if (st.gate) await st.gate;
      st.inflight--;
      return st.result;
    };
    return st;
  }

  /** 忙等 stub 收到第 n 个调用（chain 是异步微任务，测试需要同步点） */
  async function untilCalls(st: ReturnType<typeof mkClarify>, n: number): Promise<void> {
    const deadline = Date.now() + 2000;
    while (st.calls.length < n) {
      if (Date.now() > deadline) throw new Error(`等不到第 ${n} 个 clarify 调用`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  test('排队中的 issue 触发分析：反馈落库 + clarify_questions 事件 + 通知；状态仍 pending', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    // A 建即开跑占住项目 → 不分析
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    expect(s.engine.store.get(a.id)!.status).toBe('planning');
    // B 排队 pending → 后台分析
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出', category: 'debug' });
    expect(s.engine.store.get(b.id)!.status).toBe('pending');
    await s.engine.waitClarify();

    expect(clar.calls.map((c) => c.input.issueId)).toEqual([b.id]); // A 未分析
    expect(clar.calls[0]!.input.title).toBe('B');
    expect(clar.calls[0]!.input.cwd).toBe(s.repo);
    expect(clar.calls[0]!.input.goal).toBe('演示项目');
    expect(clar.calls[0]!.project.id).toBe(s.projectId);

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('pending'); // 不改状态、不占队列
    expect(fresh.clarifyFeedback).toBe('反馈：懂了');
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_started');
    expect(kinds).toContain('clarify_done');
    expect(kinds).toContain('clarify_questions');
    // 原文留档（#110）：questions.md 原文进事件 text 字段，questions 字段口径不变
    const qEv = s.engine.store.listEvents(b.id).find((e) => e.kind === 'clarify_questions')!;
    expect(JSON.parse(qEv.dataJson!).questions).toEqual(['问 1？']);
    expect(JSON.parse(qEv.dataJson!).text).toBe('1. 问 1？\n   A. 选项一\n   B. 选项二');
    const note = s.notifications.find((n) => n.issueId === b.id && n.summary?.includes('问 1？'));
    expect(note?.summary).toContain('需求：加导出'); // 推送带正文摘要——手机上不用点进来也知道在问什么
    expect(s.engine.store.listEvents(a.id).map((e) => e.kind)).not.toContain('clarify_started');
  });

  test('formatClarifyAppend：有未答问题成对写入，无问题纯补充', () => {
    expect(formatClarifyAppend([], '补充内容')).toBe('【澄清补充】补充内容');
    expect(formatClarifyAppend(['q1？', 'q2？'], '答案')).toBe('【澄清问答】\n1. q1？\n2. q2？\n答：答案');
  });

  test('无澄清问题：只落反馈与 clarify_done，不发通知', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '需求清晰', questions: [] };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('需求清晰');
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_done');
    expect(kinds).not.toContain('clarify_questions');
    expect(s.notifications.some((n) => n.issueId === b.id)).toBe(false);
  });

  test('分析失败：error 事件（where=clarify），不影响排队与后续执行', async () => {
    const clar = mkClarify();
    clar.result = { ok: false, reason: 'timeout' };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify();

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('pending');
    expect(fresh.clarifyFeedback).toBeNull();
    const err = s.engine.store.listEvents(b.id).find((e) => e.kind === 'error');
    expect(err).toBeDefined();
    expect(JSON.parse(err!.dataJson!)).toMatchObject({ where: 'clarify', reason: 'timeout' });
  });

  test('归来竞态：分析期间 issue 被取消 → 丢弃只记 clarify_discarded', async () => {
    const clar = mkClarify();
    let release!: () => void;
    clar.gate = new Promise<void>((r) => (release = r));
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await untilCalls(clar, 1); // 分析已在途
    await s.engine.cancelIssue(b.id);
    release();
    await s.engine.waitClarify();

    const fresh = s.engine.store.get(b.id)!;
    expect(fresh.status).toBe('cancelled');
    expect(fresh.clarifyFeedback).toBeNull(); // 结果被丢弃
    const kinds = s.engine.store.listEvents(b.id).map((e) => e.kind);
    expect(kinds).toContain('clarify_discarded');
    expect(kinds).not.toContain('clarify_done');
  });

  test('每项目串行单飞：并发峰值 1；排到时已非 pending 的直接 clarify_skipped', async () => {
    const clar = mkClarify();
    let release!: () => void;
    clar.gate = new Promise<void>((r) => (release = r));
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    const c = await s.engine.createIssue(s.projectId, { title: 'C' });
    await untilCalls(clar, 1);
    expect(clar.calls.length).toBe(1); // C 在链上排队，没并发起跑
    await s.engine.cancelIssue(c.id); // B 分析期间 C 被取消
    release();
    await s.engine.waitClarify();

    expect(clar.maxInflight).toBe(1);
    expect(clar.calls.map((x) => x.input.issueId)).toEqual([b.id]); // C 没起会话
    expect(s.engine.store.listEvents(c.id).map((e) => e.kind)).toContain('clarify_skipped');
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('反馈：懂了');
  });

  test('合并后 host：旧反馈清空并重新分析（未随即开跑的 host 拿到新反馈）', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '首轮', questions: [] };
    const s = await setup({ clarify: clar.fn });
    const { engine, pm } = s;
    // 同模块 web 两个 (agent) 子组：claude b/c、codex e/f（全 pending）
    const b = await engine.createIssue(s.projectId, { title: 'B', body: 'bb', module: 'web' }, false);
    const c = await engine.createIssue(s.projectId, { title: 'C', body: 'cc', module: 'web' }, false);
    const e = await engine.createIssue(s.projectId, { title: 'E', body: 'ee', module: 'web', agent: 'codex' }, false);
    const f = await engine.createIssue(s.projectId, { title: 'F', body: 'ff', module: 'web', agent: 'codex' }, false);
    await engine.waitClarify(); // 首轮分析落定：4 条都有「首轮」
    expect(engine.store.get(e.id)!.clarifyFeedback).toBe('首轮');

    clar.result = { ok: true, feedback: '合并后再析', questions: [] };
    pm.merges = [
      { members: [b.id, c.id], title: '合并 B+C', body: 'x' },
      { members: [e.id, f.id], title: '合并 E+F', body: 'y' },
    ];
    const callsBefore = clar.calls.length;
    await engine.scheduleNext(s.projectId, 'web');
    await engine.waitClarify();

    // host B 随即开跑：反馈被清空、不再重析（planning 阶段自会对齐）
    expect(engine.store.get(b.id)!.status).toBe('planning');
    expect(engine.store.get(b.id)!.clarifyFeedback).toBeNull();
    // host E 仍排队：清空旧反馈后重新分析拿到新反馈
    expect(engine.store.get(e.id)!.status).toBe('pending');
    expect(engine.store.get(e.id)!.clarifyFeedback).toBe('合并后再析');
    expect(engine.store.get(f.id)!.status).toBe('cancelled');
    // 第二轮只析了 E（B 已开跑不析、被折叠的 C/F 不析）
    expect(clar.calls.slice(callsBefore).map((x) => x.input.issueId)).toEqual([e.id]);
  });

  test('pending 答澄清后重新分析：反馈覆盖 + 可再抛新一轮问题（来回多轮）', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出' });
    await s.engine.waitClarify(); // 首轮：反馈「懂了」+ 问 1
    expect(clar.calls.length).toBe(1);
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(true);

    // 第一轮答复 → 并入正文 + 重新分析（第二轮仍有问题）
    clar.result = { ok: true, feedback: '二轮反馈', questions: ['问 2？'] };
    const r1 = await s.engine.clarify(b.id, 'CSV 就行');
    expect(r1).toEqual({ ok: true, from: 'pending', to: 'pending' });
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(2); // 触发了重分析
    // 答复与所答问题成对写入正文（否则编号答案脱离问题没人读得懂）
    expect(clar.calls[1]!.input.body).toContain('【澄清问答】');
    expect(clar.calls[1]!.input.body).toContain('1. 问 1？');
    expect(clar.calls[1]!.input.body).toContain('答：CSV 就行');
    const fresh1 = s.engine.store.get(b.id)!;
    expect(fresh1.status).toBe('pending');
    expect(fresh1.clarifyFeedback).toBe('二轮反馈'); // 反馈被覆盖
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(true); // 新一轮问题待答

    // 第二轮答复 → 再析（这次无问题 = 理解一致，收敛）
    clar.result = { ok: true, feedback: '三轮：清晰', questions: [] };
    await s.engine.clarify(b.id, '按默认来');
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(3);
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('三轮：清晰');
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(false); // 无新问题 → 面板收起
    // 三轮 clarify_started（每轮答复都触发重析）
    expect(s.engine.store.countEvents(b.id, 'clarify_started')).toBe(3);
  });

  test('轮数上限：两轮提问后仍更新反馈，但问题被压制（不落事件不通知）', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '加导出' });
    await s.engine.waitClarify(); // 第 1 轮：问 1
    expect(clar.calls[0]!.input.allowQuestions).toBe(true);

    clar.result = { ok: true, feedback: '二轮反馈', questions: ['问 2？'] };
    await s.engine.clarify(b.id, '答 1');
    await s.engine.waitClarify(); // 第 2 轮：问 2（到上限）
    expect(clar.calls[1]!.input.allowQuestions).toBe(true);

    // 第 3 轮：runner 被告知不出题；即便 LLM 不听话仍回了问题，引擎也压制
    clar.result = { ok: true, feedback: '三轮反馈', questions: ['问 3？'] };
    await s.engine.clarify(b.id, '答 2');
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(3);
    expect(clar.calls[2]!.input.allowQuestions).toBe(false);
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('三轮反馈'); // 反馈照常更新
    expect(s.engine.store.countEvents(b.id, 'clarify_questions')).toBe(2); // 第三轮没落问题
    expect(s.engine.store.clarifyPendingOf(b.id)).toBe(false); // 面板不再挂新问题
    expect(s.notifications.some((n) => n.issueId === b.id && n.summary?.includes('问 3'))).toBe(false);
    expect(s.engine.store.countEvents(b.id, 'clarify_questions_suppressed')).toBe(1);
  });

  test('历轮问答注入：history 成对带问题与答复（多次答复并入同轮）；exec 问题不计轮数', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.waitClarify(); // 第 1 轮：问 1
    expect(clar.calls[0]!.input.history).toEqual([]);

    // 伪造一条执行中来源的问题：不进创建时轮数、不进 history
    s.engine.store.logEvent(b.id, 'clarify_questions', { questions: ['exec 问'], source: 'exec', stage: 'planning' });

    clar.result = { ok: true, feedback: '二轮', questions: [] };
    await s.engine.clarify(b.id, '答 1');
    await s.engine.waitClarify();
    expect(clar.calls[1]!.input.allowQuestions).toBe(true); // 创建时才 1 轮，exec 不计
    expect(clar.calls[1]!.input.history).toEqual([{ questions: ['问 1？'], answer: '答 1' }]);

    // 无新问题后再补充：答复并入最近一轮（换行连接）
    clar.result = { ok: true, feedback: '三轮', questions: [] };
    await s.engine.clarify(b.id, '补充 2');
    await s.engine.waitClarify();
    expect(clar.calls[2]!.input.history).toEqual([{ questions: ['问 1？'], answer: '答 1\n补充 2' }]);
  });

  test('pending 改正文后重新分析（路由 PATCH 内容变化后同款调用）：分析拿到改后的正文', async () => {
    const clar = mkClarify();
    clar.result = { ok: true, feedback: '首析', questions: [] };
    const s = await setup({ clarify: clar.fn });
    await s.engine.createIssue(s.projectId, { title: 'A' }); // 占住项目
    const b = await s.engine.createIssue(s.projectId, { title: 'B', body: '原始' });
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(1);

    clar.result = { ok: true, feedback: '改后再析', questions: [] };
    s.engine.store.patchMeta(b.id, { body: '改后' });
    s.engine.scheduleClarify(b.id); // 路由 PATCH 检测到内容变化后即这么调
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(2);
    expect(clar.calls[1]!.input.body).toBe('改后');
    expect(s.engine.store.get(b.id)!.clarifyFeedback).toBe('改后再析');
  });

  test('非 pending 不重复分析：驱动态答澄清只注入不重析；scheduleClarify 对非 pending 静默跳过', async () => {
    const clar = mkClarify();
    const s = await setup({ clarify: clar.fn });
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }); // 建即开跑 → planning，不分析
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.get(a.id)!.status).toBe('planning');

    // 驱动态答澄清：注入会话、记 clarified，但不触发重析
    const r = await s.engine.clarify(a.id, '按方案一');
    expect(r.ok).toBe(true);
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarified')).toBe(1);
    expect(s.engine.store.countEvents(a.id, 'clarify_started')).toBe(0);

    // 直接调 scheduleClarify（防未来调用点误用）：非 pending 静默跳过——不起会话、不记事件
    s.engine.scheduleClarify(a.id);
    await s.engine.waitClarify();
    expect(clar.calls.length).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarify_started')).toBe(0);
    expect(s.engine.store.countEvents(a.id, 'clarify_skipped')).toBe(0);
  });

  test('未配 clarify 依赖：pending 答澄清照常并入正文，不炸不析', async () => {
    const s = await setup({}); // 无 clarify
    await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    const r = await s.engine.clarify(b.id, '补充一下');
    expect(r.ok).toBe(true);
    expect(s.engine.store.get(b.id)!.body).toContain('【澄清补充】补充一下');
  });
});

// ---------- 悬空澄清检测（重启恢复扫描的查询基础） ----------

describe('listDanglingClarify：最后一条 clarify_started 后无终态', () => {
  test('悬空命中；done/discarded/error@clarify 终态排除；无关 error 不算终态；不看 issue 状态', async () => {
    const s = await setup();
    const st = s.engine.store;
    const mk = (title: string) => st.create(s.projectId, { title });

    const dangling = mk('悬空：started 后无任何终态');
    st.logEvent(dangling.id, 'clarify_started', { agent: 'claude' });

    const finished = mk('正常完成');
    st.logEvent(finished.id, 'clarify_started', {});
    st.logEvent(finished.id, 'clarify_done', { questions: 0 });

    const discarded = mk('归来时已开跑丢弃');
    st.logEvent(discarded.id, 'clarify_started', {});
    st.logEvent(discarded.id, 'clarify_discarded', { status: 'planning' });

    const failed = mk('分析失败');
    st.logEvent(failed.id, 'clarify_started', {});
    st.logEvent(failed.id, 'error', { where: 'clarify', reason: 'timeout' });

    const otherError = mk('无关 error 不算终态');
    st.logEvent(otherError.id, 'clarify_started', {});
    st.logEvent(otherError.id, 'error', { where: 'scheduleNext', error: 'x' });

    const secondRound = mk('第一轮完整、第二轮悬空');
    st.logEvent(secondRound.id, 'clarify_started', {});
    st.logEvent(secondRound.id, 'clarify_done', { questions: 1 });
    st.logEvent(secondRound.id, 'clarify_questions', { questions: ['q？'] });
    st.logEvent(secondRound.id, 'clarified', { answer: 'a' });
    st.logEvent(secondRound.id, 'clarify_started', {});

    const doneStatus = mk('已完结 issue 的悬空也要列出（引擎侧收口用）');
    st.logEvent(doneStatus.id, 'clarify_started', {});
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(doneStatus.id);

    mk('从未分析过'); // 无 clarify_started → 不列

    const ids = st.listDanglingClarify().map((i) => i.id);
    expect(ids).toEqual([dangling.id, otherError.id, secondRound.id, doneStatus.id]);
  });

  test('归档项目不进扫描', async () => {
    const s = await setup();
    const st = s.engine.store;
    const i = st.create(s.projectId, { title: '归档项目的悬空' });
    st.logEvent(i.id, 'clarify_started', {});
    s.db.query("UPDATE projects SET status = 'archived' WHERE id = ?").run(s.projectId);
    expect(st.listDanglingClarify()).toHaveLength(0);
  });
});

// ---------- 重启恢复：悬空澄清分流（pending 重跑 / 非 pending 收口清残留） ----------

describe('start() 恢复扫描：被重启打断的创建时澄清', () => {
  test('pending 悬空自动重跑；已开跑悬空只收口清残留；正常完成不受影响', async () => {
    // 重启前进程：无 clarify 依赖的引擎造现场（createIssue 不会自己起分析）
    const s = await setup();
    const st = s.engine.store;
    const a = await s.engine.createIssue(s.projectId, { title: 'A 已开跑' }); // 建即开跑 → planning
    const b = await s.engine.createIssue(s.projectId, { title: 'B 排队中' }); // pending
    const c = await s.engine.createIssue(s.projectId, { title: 'C 完整轮次' }); // pending
    expect(st.get(a.id)!.status).toBe('planning');
    expect(st.get(b.id)!.status).toBe('pending');
    // 模拟重启打断：A/B 各有一轮有头无尾的分析；C 是正常完整轮次
    st.logEvent(a.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(b.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(c.id, 'clarify_started', { agent: 'claude' });
    st.logEvent(c.id, 'clarify_done', { questions: 0 });
    // A 的中断残留现场：clr 会话还挂着 + scratch 没清（runner finally 没机会跑）
    s.driver.tmuxSessions.add(`clr-${a.id}`);
    const aScratch = path.join(s.repo, '.butler-clarify', String(a.id));
    await fsp.mkdir(aScratch, { recursive: true });
    await fsp.writeFile(path.join(aScratch, 'task.md'), 'x');

    // 重启后进程：同 DB 新引擎实例，带 clarify 依赖，start() 触发恢复扫描
    const calls: number[] = [];
    const engine2 = new IssueEngine({
      db: s.db,
      driver: s.driver,
      convs: s.convs,
      locator: { locate: async () => null },
      pmFor: () => s.pm,
      notify: { dispatch: async () => {} },
      mutex: new KeyedMutex(),
      clarify: async (_p, input) => {
        calls.push(input.issueId);
        return { ok: true, feedback: '恢复后的反馈', questions: [] };
      },
      config: { kickoffMinBootMs: 0, resultSummaryTimeoutMs: 0 },
    });
    engine2.start();
    await engine2.waitClarify();
    await engine2.stop();

    // B（pending 悬空）：重跑 —— 只有 B 被分析，新一轮 started+done，反馈落库
    expect(calls).toEqual([b.id]);
    expect(st.get(b.id)!.clarifyFeedback).toBe('恢复后的反馈');
    expect(st.countEvents(b.id, 'clarify_started')).toBe(2);
    expect(st.countEvents(b.id, 'clarify_done')).toBe(1);
    // A（planning 悬空）：不重跑，补 clarify_discarded 收口 + 残留会话/scratch 清掉
    const disc = st.listEvents(a.id).find((e) => e.kind === 'clarify_discarded');
    expect(disc).toBeTruthy();
    expect(JSON.parse(disc!.dataJson!)).toMatchObject({ status: 'planning', via: 'recover' });
    expect(st.countEvents(a.id, 'clarify_started')).toBe(1);
    expect(s.driver.tmuxSessions.has(`clr-${a.id}`)).toBe(false);
    expect(await fsp.stat(aScratch).catch(() => null)).toBeNull();
    // C（完整轮次）：事件原样不动
    expect(st.countEvents(c.id, 'clarify_started')).toBe(1);
    expect(st.countEvents(c.id, 'clarify_discarded')).toBe(0);
    // 扫描收敛：全库悬空清零
    expect(st.listDanglingClarify()).toHaveLength(0);
  });

  test('未配 clarify 依赖：start() 恢复扫描整体跳过（不收口不清理，等有依赖的进程来恢复）', async () => {
    const s = await setup();
    const st = s.engine.store;
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }); // planning
    st.logEvent(a.id, 'clarify_started', { agent: 'claude' });
    s.engine.start();
    await s.engine.waitClarify();
    await s.engine.stop();
    expect(st.countEvents(a.id, 'clarify_discarded')).toBe(0);
    expect(st.listDanglingClarify()).toHaveLength(1);
  });
});

// ---------- 执行结果总结（done/blocked 收尾，接力之前） ----------

describe('执行结果总结：done/blocked 收尾注入 + 文件哨兵读回', () => {
  /** 带虚拟 sleep 的 setup：sleep 推进假时钟并触发钩子（模拟 CC 写产物文件） */
  async function summarySetup(timeoutMs = 500) {
    const ref: { hook: (() => Promise<void>) | null; adv: ((ms: number) => void) | null } = {
      hook: null,
      adv: null,
    };
    const s = await setup({
      config: {
        resultSummaryTimeoutMs: timeoutMs,
        resultSummaryPollMs: 10,
        sleep: async (ms: number) => {
          ref.adv?.(ms);
          await ref.hook?.();
        },
      },
    });
    ref.adv = (ms) => s.clock.advance(ms);
    return { s, ref };
  }

  test('blocked：注入受阻变体 prompt，读回落库 + 事件留痕 + scratch 清理', async () => {
    const { s, ref } = await summarySetup();
    const issue = await s.engine.createIssue(s.projectId, { title: '任务A' });
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');
    const p = resultSummaryPaths(s.repo, issue.id);
    ref.hook = async () => {
      await fsp.mkdir(p.scratch, { recursive: true });
      await fsp.writeFile(p.summary, '做到一半，改了 a.ts，卡在权限弹窗');
      await fsp.writeFile(p.done, 'ok');
    };
    await s.engine.blockIssue(issue.id, '卡住了');

    const fresh = s.engine.store.get(issue.id)!;
    expect(fresh.status).toBe('blocked');
    expect(fresh.resultSummary).toBe('做到一半，改了 a.ts，卡在权限弹窗');
    const prompt = s.driver.sent.find((x) => x.text.includes('【执行总结】'));
    expect(prompt).toBeDefined();
    expect(prompt!.text).toContain(`${RESULT_SUMMARY_SCRATCH_BASE}/${issue.id}/summary.md`);
    expect(prompt!.text).toContain('受阻');
    const kinds = s.engine.store.listEvents(issue.id).map((e) => e.kind);
    expect(kinds).toContain('summary_requested');
    expect(kinds).toContain('summary_done');
    expect(await fsp.stat(p.scratch).catch(() => null)).toBeNull(); // scratch 已清
  });

  test('done：自动流收尾先总结（完成变体）再接力下一条', async () => {
    const { s, ref } = await summarySetup();
    s.setManualReview(false);
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    expect(s.engine.store.get(b.id)!.status).toBe('pending');
    const p = resultSummaryPaths(s.repo, a.id);
    ref.hook = async () => {
      await fsp.mkdir(p.scratch, { recursive: true });
      await fsp.writeFile(p.summary, '完成 A：改 x.ts，测试通过，无遗留');
      await fsp.writeFile(p.done, 'ok');
    };
    s.engine.store.setSubtasks(a.id, ['做事']);
    await s.engine.applyEvent(a.id, 'plan_ready'); // 自动批 → implementing
    await s.engine.applyEvent(a.id, 'impl_done'); // → testing
    await s.engine.applyEvent(a.id, 'tests_passed'); // 自动收尾 → done（先总结）→ 接力 B

    const fa = s.engine.store.get(a.id)!;
    expect(fa.status).toBe('done');
    expect(fa.resultSummary).toBe('完成 A：改 x.ts，测试通过，无遗留');
    expect(s.engine.store.get(b.id)!.status).toBe('planning'); // 接力照常

    // 顺序：总结注入发生在 B 接管会话（claude 启动）之前
    const sumIdx = s.driver.sent.findIndex((x) => x.text.includes('【执行总结】'));
    expect(sumIdx).toBeGreaterThan(-1);
    expect(s.driver.sent[sumIdx]!.text).toContain('已完成');
    const lastLaunch = s.driver.sent.reduce((acc, x, i) => (x.text.startsWith('claude ') ? i : acc), -1);
    expect(lastLaunch).toBeGreaterThan(sumIdx);
  });

  test('超时无产出：error 事件降级（where=resultSummary），不阻断接力', async () => {
    const { s } = await summarySetup(50);
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    const b = await s.engine.createIssue(s.projectId, { title: 'B' });
    await s.engine.blockIssue(a.id, '卡');

    expect(s.engine.store.get(a.id)!.status).toBe('blocked');
    expect(s.engine.store.get(a.id)!.resultSummary).toBeNull();
    const err = s.engine.store
      .listEvents(a.id)
      .find((e) => e.kind === 'error' && (e.dataJson ?? '').includes('resultSummary'));
    expect(err).toBeDefined();
    expect(JSON.parse(err!.dataJson!)).toMatchObject({ where: 'resultSummary', reason: 'timeout' });
    expect(s.engine.store.get(b.id)!.status).toBe('planning'); // 接力照常
  });

  test('cancelled 不总结；从未起跑（无 conv）的 blocked → summary_skipped', async () => {
    const { s } = await summarySetup();
    const a = await s.engine.createIssue(s.projectId, { title: 'A' }); // planning（有会话）
    const c = await s.engine.createIssue(s.projectId, { title: 'C' }, false); // pending 无 conv
    await s.engine.blockIssue(c.id, '手动卡');
    expect(s.engine.store.listEvents(c.id).some((e) => e.kind === 'summary_requested')).toBe(false);
    const skip = s.engine.store.listEvents(c.id).find((e) => e.kind === 'summary_skipped');
    expect(skip).toBeDefined();
    expect(JSON.parse(skip!.dataJson!)).toMatchObject({ reason: 'no-conv' });

    await s.engine.cancelIssue(a.id);
    expect(s.engine.store.get(a.id)!.status).toBe('cancelled');
    expect(s.driver.sent.some((x) => x.text.includes('【执行总结】'))).toBe(false);
    expect(s.engine.store.listEvents(a.id).some((e) => e.kind === 'summary_requested')).toBe(false);
  });

  test('会话已不在 / 激活对话被切走 → summary_skipped，不注入', async () => {
    const { s } = await summarySetup();
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    // 模拟 tmux 会话被人杀了
    s.driver.tmuxSessions.clear();
    await s.engine.blockIssue(a.id, '卡');
    const skip = s.engine.store.listEvents(a.id).find((e) => e.kind === 'summary_skipped');
    expect(skip).toBeDefined();
    expect(JSON.parse(skip!.dataJson!)).toMatchObject({ reason: 'no-session' });
    expect(s.driver.sent.some((x) => x.text.includes('【执行总结】'))).toBe(false);
  });

  test('代理已退回 shell → summary_skipped(agent-down)，不把总结 prompt 打进 bash（issue #97）', async () => {
    const { s } = await summarySetup();
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    const convId = s.engine.store.get(a.id)!.convId!;
    const session = s.convs.tmuxName(s.projectId, convId);
    s.driver.pane = '[root@VM p]#'; // 会话还在，但里面只剩 bash
    s.driver.paneCommands.set(session, 'bash');

    await s.engine.blockIssue(a.id, '卡');
    const skip = s.engine.store.listEvents(a.id).find((e) => e.kind === 'summary_skipped');
    expect(JSON.parse(skip!.dataJson!)).toMatchObject({ reason: 'agent-down' });
    expect(s.driver.sent.some((x) => x.text.includes('【执行总结】'))).toBe(false);
    expect(s.engine.store.get(a.id)!.status).toBe('blocked'); // 跳过总结不影响收尾
  });

  test('拿不到前台命令时靠抓屏兜底：屏面是 shell 提示符照样跳过（issue #97）', async () => {
    const { s } = await summarySetup();
    const a = await s.engine.createIssue(s.projectId, { title: 'A' });
    s.driver.pane = '[root@VM p]#'; // 只有屏面证据，listSessions 没给 command
    await s.engine.blockIssue(a.id, '卡');
    const skip = s.engine.store.listEvents(a.id).find((e) => e.kind === 'summary_skipped');
    expect(JSON.parse(skip!.dataJson!)).toMatchObject({ reason: 'agent-down' });
    expect(s.driver.sent.some((x) => x.text.includes('【执行总结】'))).toBe(false);
  });

  test('总结轮询期间自动过权限弹窗（收尾后无人盯菜单，实测坑）', async () => {
    const { s, ref } = await summarySetup();
    const issue = await s.engine.createIssue(s.projectId, { title: 'A' });
    const p = resultSummaryPaths(s.repo, issue.id);
    // 注入后抓屏是「写文件权限弹窗」（肯定项在第 2 项）；清一轮后代理产出文件
    s.driver.pane = ['Allow write to summary.md?', '❯ 1. No', '  2. Yes, allow'].join('\n');
    ref.hook = async () => {
      s.driver.pane = '';
      await fsp.mkdir(p.scratch, { recursive: true });
      await fsp.writeFile(p.summary, '总结产出');
      await fsp.writeFile(p.done, 'ok');
    };
    await s.engine.blockIssue(issue.id, '卡');
    expect(s.engine.store.get(issue.id)!.resultSummary).toBe('总结产出');
    // 弹窗被自动过：Down 到肯定项 + Enter
    expect(s.driver.keys.some((k) => k.key === 'Down')).toBe(true);
    expect(s.driver.keys.some((k) => k.key === 'Enter')).toBe(true);
  });

  test('buildResultSummaryPrompt：单段、含 scratch 路径与 done 标记指令', () => {
    for (const kind of ['done', 'blocked'] as const) {
      const t = buildResultSummaryPrompt(7, kind);
      expect(t).not.toContain('\n');
      expect(t).toContain(`${RESULT_SUMMARY_SCRATCH_BASE}/7/summary.md`);
      expect(t).toContain(`${RESULT_SUMMARY_SCRATCH_BASE}/7/done`);
    }
    expect(buildResultSummaryPrompt(7, 'done')).toContain('已完成');
    expect(buildResultSummaryPrompt(7, 'blocked')).toContain('受阻');
  });
});

// ---------- #93：取消后复活重跑 ----------

describe('reopenIssue：取消的 issue 改完需求重新运行', () => {
  test('cancelled → pending，落 reopened 事件并被重新调度开跑', async () => {
    const s = await setup();
    s.setManualReview(false); // 生产默认：全自动流
    const issue = await s.engine.createIssue(s.projectId, { title: '会被取消的任务', module: 'm' });
    await s.engine.cancelIssue(issue.id, s.admin.id);
    expect(s.engine.store.get(issue.id)!.status).toBe('cancelled');

    const r = await s.engine.reopenIssue(issue.id, s.admin.id);
    expect(r.ok).toBe(true);
    expect(r.ok && r.from).toBe('cancelled');
    expect(r.ok && r.to).toBe('pending');

    // reopened 事件带操作人，供审计/失败次数重新计数锚点
    const reopened = s.engine.store.listEvents(issue.id).filter((e) => e.kind === 'reopened');
    expect(reopened).toHaveLength(1);
    expect(JSON.parse(reopened[0]!.dataJson!).actor).toBe(s.admin.id);

    // 落到 pending 就会被接力立刻开跑（项目空闲时），不是停在待办等人点
    expect(s.engine.store.get(issue.id)!.status).toBe('planning');

    // 清理与复活事件必须发生在**开跑之前**：reopened 的事件 id 要早于 pending→planning 的
    // transition。放到 applyEvent 返回之后再清，就会把接力刚生成的新计划一起抹掉。
    const events = s.engine.store.listEvents(issue.id);
    const reopenedId = events.find((e) => e.kind === 'reopened')!.id;
    // 取**复活后**那次进 planning（建 issue 时已经进过一次 planning，别拿第一条比）
    const toPlanningId = events
      .filter((e) => e.kind === 'transition' && JSON.parse(e.dataJson ?? '{}').to === 'planning')
      .at(-1)!.id;
    expect(reopenedId).toBeLessThan(toPlanningId);
  });

  test('清掉上一轮残留运行态，但保留 conv_id / 模块绑定 / 事件历史', async () => {
    const s = await setup();
    const issue = await s.engine.createIssue(s.projectId, { title: '带计划的任务', module: 'm' });
    s.engine.store.setSubtasks(issue.id, ['步骤一', '步骤二']);
    s.engine.store.advanceSubtask(issue.id); // 做完第一步，sub_index=1
    s.engine.store.setNote(issue.id, '上一轮的备注');
    const before = s.engine.store.get(issue.id)!;
    expect(before.subtasksJson).not.toBeNull();
    expect(before.subIndex).toBe(1);
    const convBefore = before.convId;
    const moduleBefore = before.module;
    const eventsBefore = s.engine.store.listEvents(issue.id).length;
    expect(convBefore).toBeTruthy();

    await s.engine.cancelIssue(issue.id, s.admin.id);
    await s.engine.reopenIssue(issue.id, s.admin.id);

    const after = s.engine.store.get(issue.id)!;
    // 清掉：旧计划与进度不能残留，否则复活后会照着上一版需求的计划继续跑
    expect(after.planJson).toBeNull();
    expect(after.subtasksJson).toBeNull();
    expect(after.subIndex).toBe(0);
    expect(after.note).toBeNull();
    expect(after.doneTs).toBeNull();
    // 保留：模块会话本就该被同模块 issue 顺序复用，清了反而要重建会话
    expect(after.convId).toBe(convBefore);
    expect(after.module).toBe(moduleBefore);
    // 事件历史是审计与「上一轮干到哪」的唯一来源，只增不减
    expect(s.engine.store.listEvents(issue.id).length).toBeGreaterThan(eventsBefore);
  });

  test('复活后测试失败次数重新计数：上一轮攒的失败不再压在头上（真跑引擎）', async () => {
    const s = await setup();
    const { engine } = s;
    const issue = await engine.createIssue(s.projectId, { title: '屡试屡败', module: 'm' });
    const jl = await s.bindJsonl(issue.id);
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');

    // 上一轮：攒满上限次失败 → blocked
    for (let round = 1; round <= MAX_TEST_FAILURES; round++) {
      expect(engine.store.get(issue.id)!.status).toBe('testing');
      await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 第 ${round} 轮挂了`));
      await engine.tick();
      expect(engine.store.get(issue.id)!.status).toBe('implementing');
      await engine.applyEvent(issue.id, 'impl_done');
    }
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(MAX_TEST_FAILURES);

    await engine.cancelIssue(issue.id, s.admin.id);
    await engine.reopenIssue(issue.id, s.admin.id);
    // 复活后重新走到 testing
    engine.store.setSubtasks(issue.id, ['a']);
    await engine.applyEvent(issue.id, 'plan_ready');
    await engine.applyEvent(issue.id, 'plan_approved');
    await engine.applyEvent(issue.id, 'impl_done');
    expect(engine.store.get(issue.id)!.status).toBe('testing');

    // 关键：本轮第一次失败应回 implementing 重试。若失败次数仍按终生 COUNT 算（4 > 上限 3），
    // 这里会直接 blocked —— 复活等于白复活。
    await s.appendOutput(jl, asst(`TESTS_FAILED:${issue.id} 复活后第 1 次`));
    await engine.tick();
    expect(engine.store.get(issue.id)!.status).toBe('implementing');
    // 历史不删：终生计数仍在，只是不再作为判据
    expect(engine.store.countEvents(issue.id, 'tests_failed')).toBe(MAX_TEST_FAILURES + 1);
  });

  test('只有 cancelled 可复活：无此 issue / pending / 驱动中 / done 全部拒绝', async () => {
    const s = await setup();
    expect((await s.engine.reopenIssue(9999)).ok).toBe(false);

    const a = await s.engine.createIssue(s.projectId, { title: '待办的', module: 'm' });
    // 建完即开跑（全自动流），先断言非 cancelled 一律被拒
    const notCancelled = await s.engine.reopenIssue(a.id, s.admin.id);
    expect(notCancelled.ok).toBe(false);
    expect(!notCancelled.ok && notCancelled.error).toContain('仅已取消的 issue 可重新运行');

    // done 是真终态，复活不了
    s.db.query("UPDATE issues SET status = 'done' WHERE id = ?").run(a.id);
    const doneRes = await s.engine.reopenIssue(a.id, s.admin.id);
    expect(doneRes.ok).toBe(false);
  });

  test('复活是幂等安全的：并发两次只有一次成功，状态不被清成半截', async () => {
    const s = await setup();
    s.setManualReview(false);
    const issue = await s.engine.createIssue(s.projectId, { title: '并发复活', module: 'm' });
    await s.engine.cancelIssue(issue.id, s.admin.id);

    const [r1, r2] = await Promise.all([
      s.engine.reopenIssue(issue.id, s.admin.id),
      s.engine.reopenIssue(issue.id, s.admin.id),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    expect(s.engine.store.countEvents(issue.id, 'reopened')).toBe(1);
  });
});

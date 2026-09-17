import { describe, expect, test } from 'bun:test';
import {
  buildOrganizePrompt,
  buildOrganizeTaskMd,
  MAX_ORGANIZE_ACTIONS,
  ORGANIZE_SCRATCH_BASE,
  organizePaths,
  organizeSessionName,
  parseOrganizePlan,
  runOrganize,
  type OrganizeDriver,
  type OrganizePlanContext,
} from './organize-runner';

// ---------- 可编程假 Driver（clarify-runner.test 同款：tmux 进内存、文件进 Map） ----------

class FakeDriver implements OrganizeDriver {
  sessions = new Set<string>();
  created: Array<{ name: string; cwd: string }> = [];
  killed: string[] = [];
  sent: Array<{ session: string; text: string }> = [];
  keys: Array<{ session: string; key: string }> = [];
  wrote: Array<{ path: string; data: string }> = [];
  removed: string[] = [];
  files = new Map<string, string>();
  captureCount = 0;
  failCreate = false;
  onCapture?: (n: number, files: Map<string, string>) => void;

  async findExecutable(agent: 'claude' | 'codex') {
    return agent;
  }

  async listSessions() {
    return [...this.sessions].map((name) => ({ name, createdTs: 0, attached: false }));
  }
  async createSession(name: string, cwd: string) {
    if (this.failCreate) throw new Error('createSession failed');
    if (this.sessions.has(name)) throw new Error('exists');
    this.sessions.add(name);
    this.created.push({ name, cwd });
  }
  async killSession(name: string) {
    if (!this.sessions.delete(name)) throw new Error('no session');
    this.killed.push(name);
  }
  async sendKeys(session: string, text: string) {
    this.sent.push({ session, text });
  }
  async sendKey(session: string, key: string) {
    this.keys.push({ session, key });
  }
  async capturePane(_session: string) {
    const n = this.captureCount++;
    this.onCapture?.(n, this.files);
    return '';
  }
  async writeFile(path: string, data: Uint8Array | string) {
    const s = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.files.set(path, s);
    this.wrote.push({ path, data: s });
  }
  async statPath(path: string) {
    if (!this.files.has(path)) return null;
    const bytes = new TextEncoder().encode(this.files.get(path)!);
    return { size: bytes.length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
  }
  async readFileRange(path: string, offset: number, limit: number) {
    const bytes = new TextEncoder().encode(this.files.get(path) ?? '');
    return { data: bytes.subarray(offset, offset + limit), size: bytes.length };
  }
  /** 诊断用：列 scratch 目录（#280）——按 files 里的路径前缀推出直接子项 */
  async listDir(path: string) {
    const prefix = `${path}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const [head] = rest.split('/');
      if (head) names.add(rest.includes('/') ? `${head}/` : head);
    }
    return [...names].map((name) => name.endsWith('/')
      ? { name: name.slice(0, -1), type: 'dir' as const }
      : { name, type: 'file' as const });
  }
  async removeTree(path: string) {
    this.removed.push(path);
    for (const k of [...this.files.keys()]) {
      if (k === path || k.startsWith(path + '/')) this.files.delete(k);
    }
  }
}

function mkClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
}

const FAST = { pollIntervalMs: 10, readyDelayMs: 20, timeoutMs: 400 };

// ---------- 纯函数 ----------

describe('纯函数', () => {
  test('organizeSessionName / organizePaths：org- 前缀 + 按项目隔离 scratch', () => {
    expect(organizeSessionName(7)).toBe('org-7');
    const p = organizePaths('/repo/proj/', 7);
    expect(p.scratch).toBe(`/repo/proj/${ORGANIZE_SCRATCH_BASE}/7`);
    expect(p.task).toBe(`/repo/proj/${ORGANIZE_SCRATCH_BASE}/7/task.md`);
    expect(p.plan).toBe(`/repo/proj/${ORGANIZE_SCRATCH_BASE}/7/plan.json`);
    expect(p.done).toBe(`/repo/proj/${ORGANIZE_SCRATCH_BASE}/7/done`);
  });

  test('buildOrganizeTaskMd：按模块分节列 issue（状态/代理/正文摘要）；无主 issue 单独一节', () => {
    const md = buildOrganizeTaskMd({
      projectName: 'Demo',
      goal: '演示',
      modules: [
        { id: 1, slug: 'legacy-module-01', displayName: 'Git 页面', agent: 'claude', source: 'legacy', issueCount: 1 },
        { id: 2, slug: 'exec', displayName: '执行', agent: 'codex', source: 'auto', issueCount: 0 },
      ],
      issues: [
        { id: 11, title: '修分支列表', body: '下拉里看不到远程分支\n补上', status: 'done', agent: 'claude', moduleId: 1 },
        { id: 12, title: '无主任务', body: null, status: 'pending', agent: 'claude', moduleId: null },
      ],
    });
    expect(md).toContain('项目：Demo');
    expect(md).toContain('演示');
    expect(md).toContain('模块 id=1「Git 页面」');
    expect(md).toContain('slug=legacy-module-01');
    expect(md).toContain('#11 [done/claude] 修分支列表 —— 下拉里看不到远程分支 补上'); // 正文压平
    expect(md).toContain('（无 issue）');
    expect(md).toContain('未归入正式模块的 issue');
    expect(md).toContain('#12 [pending/claude] 无主任务');
  });

  test('buildOrganizePrompt：单段无换行，覆盖四种动作、语义化 slug 要求与产物路径', () => {
    const p = buildOrganizePrompt('claude', 7);
    expect(p).not.toContain('\n');
    expect(p).toContain(`${ORGANIZE_SCRATCH_BASE}/7/task.md`);
    expect(p).toContain(`${ORGANIZE_SCRATCH_BASE}/7/plan.json`);
    expect(p).toContain(`${ORGANIZE_SCRATCH_BASE}/7/done`);
    for (const k of ['merge', 'rename', 'create', 'move']) expect(p).toContain(`"${k}"`);
    expect(p).toContain('严禁无意义编号');
    expect(p).toContain('不要改动任何文件');
    expect(buildOrganizePrompt('codex', 1)).toContain('无需请求审批');
  });
});

// ---------- parseOrganizePlan 清洗 ----------

describe('parseOrganizePlan', () => {
  const ctx: OrganizePlanContext = {
    modules: [
      { id: 1, slug: 'legacy-module-01', agent: 'claude', active: true },
      { id: 2, slug: 'legacy-module-02', agent: 'claude', active: true },
      { id: 3, slug: 'legacy-module-03', agent: 'codex', active: true },
      { id: 9, slug: 'old-archived', agent: 'claude', active: false },
    ],
    issues: [
      { id: 11, status: 'pending', moduleId: 1 },
      { id: 12, status: 'done', moduleId: 2 },
      { id: 13, status: 'implementing', moduleId: 2 },
      { id: 14, status: 'blocked', moduleId: 3 },
    ],
  };
  const plan = (actions: unknown[]): string => JSON.stringify({ actions });

  test('非法 JSON / 缺 actions / 空 → []', () => {
    expect(parseOrganizePlan(null, ctx)).toEqual([]);
    expect(parseOrganizePlan('not json', ctx)).toEqual([]);
    expect(parseOrganizePlan('{}', ctx)).toEqual([]);
    expect(parseOrganizePlan(plan([]), ctx)).toEqual([]);
  });

  test('create：slug 规范化；与现存（含归档）/本方案先前 slug 冲突丢弃；缺 reason 丢弃', () => {
    const got = parseOrganizePlan(
      plan([
        { kind: 'create', slug: 'Git Pages', displayName: 'Git 页面', agent: 'claude', reason: 'r' },
        { kind: 'create', slug: 'git-pages', displayName: '重复', agent: 'codex', reason: 'r' }, // 与上一条冲突
        { kind: 'create', slug: 'old-archived', displayName: '撞归档', agent: 'claude', reason: 'r' },
        { kind: 'create', slug: 'no-reason-mod', displayName: 'x', agent: 'claude' },
        { kind: 'create', slug: '###', displayName: '坏 slug', agent: 'claude', reason: 'r' },
      ]),
      ctx,
    );
    expect(got).toEqual([
      { kind: 'create', slug: 'git-pages', displayName: 'Git 页面', agent: 'claude', reason: 'r' },
    ]);
  });

  test('rename：只认 active 模块；新 slug 不得与现存/本方案冲突；同 slug 不算改', () => {
    const got = parseOrganizePlan(
      plan([
        { kind: 'rename', moduleId: 1, slug: 'git-pages', displayName: 'Git 页面', reason: 'r1' },
        { kind: 'rename', moduleId: 1, slug: 'other-name', reason: '同模块二次 rename' }, // 模块级互斥
        { kind: 'rename', moduleId: 2, slug: 'git-pages', reason: '撞前一条新 slug' },
        { kind: 'rename', moduleId: 2, slug: 'legacy-module-02', reason: '没改' },
        { kind: 'rename', moduleId: 9, slug: 'zombie-mod', reason: '归档模块' },
        { kind: 'rename', moduleId: 3, slug: 'exec-pages', reason: 'r2' },
      ]),
      ctx,
    );
    expect(got).toEqual([
      { kind: 'rename', moduleId: 1, slug: 'git-pages', displayName: 'Git 页面', reason: 'r1' },
      { kind: 'rename', moduleId: 3, slug: 'exec-pages', reason: 'r2' },
    ]);
  });

  test('merge：幻觉 id 剔除、来源去重、与 rename/其他 merge 模块级互斥', () => {
    const got = parseOrganizePlan(
      plan([
        { kind: 'rename', moduleId: 1, slug: 'git-pages', reason: 'r' },
        { kind: 'merge', targetId: 2, sourceIds: [3, 3, 1, 999], reason: 'm' }, // 1 已被 rename 占用
        { kind: 'merge', targetId: 3, sourceIds: [2], reason: '3 已作来源' },
        { kind: 'merge', targetId: 2, sourceIds: [999], reason: '来源清洗后为空' },
      ]),
      ctx,
    );
    expect(got).toEqual([
      { kind: 'rename', moduleId: 1, slug: 'git-pages', reason: 'r' },
      { kind: 'merge', targetId: 2, sourceIds: [3], reason: 'm' },
    ]);
  });

  test('move：驱动中 issue 剔除、已在目标模块剔除；目标可为 active id 或本方案新建 slug', () => {
    const got = parseOrganizePlan(
      plan([
        { kind: 'create', slug: 'file-preview', displayName: '文件预览', agent: 'claude', reason: 'r' },
        { kind: 'move', issueIds: [11, 12, 13, 999, 12], to: 'file-preview', reason: 'mv1' },
        { kind: 'move', issueIds: [14, 12], to: 3, reason: 'mv2' }, // 14 已在模块 3 → 剔；12 可挪
        { kind: 'move', issueIds: [11], to: 'not-created', reason: '目标不存在' },
        { kind: 'move', issueIds: [13], to: 1, reason: '全是驱动中' },
      ]),
      ctx,
    );
    expect(got).toEqual([
      { kind: 'create', slug: 'file-preview', displayName: '文件预览', agent: 'claude', reason: 'r' },
      { kind: 'move', issueIds: [11, 12], to: { slug: 'file-preview' }, reason: 'mv1' },
      { kind: 'move', issueIds: [12], to: { moduleId: 3 }, reason: 'mv2' },
    ]);
  });

  test('动作总量截断 MAX_ORGANIZE_ACTIONS', () => {
    const many = Array.from({ length: MAX_ORGANIZE_ACTIONS + 10 }, (_, i) => ({
      kind: 'create',
      slug: `mod-${i}-x`,
      displayName: `M${i}`,
      agent: 'claude',
      reason: 'r',
    }));
    expect(parseOrganizePlan(plan(many), ctx)).toHaveLength(MAX_ORGANIZE_ACTIONS);
  });
});

// ---------- run ----------

describe('OrganizeRunner.run', () => {
  const input = {
    projectId: 7,
    cwd: '/repo/proj',
    agent: 'claude' as const,
    projectName: 'Demo',
    modules: [
      { id: 1, slug: 'legacy-module-01', displayName: 'Git 页面', agent: 'claude' as const, source: 'legacy', issueCount: 1 },
    ],
    issues: [
      { id: 11, title: '修分支列表', body: null, status: 'done', agent: 'claude' as const, moduleId: 1 },
    ],
  };

  test('成功：起 org-<pid> 会话、写 task.md、注入提示、读回 plan.json 原文、清理', async () => {
    const driver = new FakeDriver();
    const p = organizePaths(input.cwd, 7);
    driver.onCapture = (n, files) => {
      if (n >= 5) {
        files.set(p.plan, '{"actions":[{"kind":"rename","moduleId":1,"slug":"git-pages","reason":"去序号"}]}');
        files.set(p.done, 'ok');
      }
    };
    const r = await runOrganize({ driver, ...mkClock() }, input, FAST);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.planText).toContain('git-pages');
    expect(driver.created.map((c) => c.name)).toEqual(['org-7']);
    expect(driver.wrote.some((w) => w.path === p.task && w.data.includes('修分支列表'))).toBe(true);
    expect(driver.sent[0]!.text).toBe('claude --permission-mode acceptEdits');
    expect(driver.sent.some((s) => s.text.includes(`${ORGANIZE_SCRATCH_BASE}/7/plan.json`))).toBe(true);
    expect(driver.killed).toContain('org-7');
    expect(driver.removed).toContain(p.scratch);
  });

  test('codex：bypass 参数起会话', async () => {
    const driver = new FakeDriver();
    const p = organizePaths(input.cwd, 7);
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(p.plan, '{"actions":[]}');
        files.set(p.done, 'ok');
      }
    };
    const r = await runOrganize({ driver, ...mkClock() }, { ...input, agent: 'codex' }, FAST);
    expect(r.ok).toBe(true);
    expect(driver.sent[0]!.text).toContain('codex');
    expect(driver.sent[0]!.text).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('超时 → timeout；done 出现但 plan.json 缺失/为空 → no-output；createSession 抛错 → error', async () => {
    const t = await runOrganize({ driver: new FakeDriver(), ...mkClock() }, input, FAST);
    expect(t).toMatchObject({ ok: false, reason: 'timeout' });

    const d2 = new FakeDriver();
    const p = organizePaths(input.cwd, 7);
    d2.onCapture = (n, files) => {
      if (n >= 3) files.set(p.done, 'ok');
    };
    const noOut = await runOrganize({ driver: d2, ...mkClock() }, input, FAST);
    expect(noOut).toMatchObject({ ok: false, reason: 'no-output' });

    const d3 = new FakeDriver();
    d3.failCreate = true;
    const err = await runOrganize({ driver: d3, ...mkClock() }, input, FAST);
    expect(err).toMatchObject({ ok: false, reason: 'error' });
    expect(d3.removed).toContain(p.scratch);
  });

  test('残留会话/旧 scratch 起步先清；收尾杀会话删 scratch', async () => {
    const driver = new FakeDriver();
    const p = organizePaths(input.cwd, 7);
    driver.sessions.add('org-7');
    driver.files.set(p.plan, '{"actions":[]}');
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(p.plan, '{"actions":[{"kind":"create","slug":"fresh-mod","displayName":"新","agent":"claude","reason":"r"}]}');
        files.set(p.done, 'ok');
      }
    };
    const r = await runOrganize({ driver, ...mkClock() }, input, FAST);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.planText).toContain('fresh-mod');
    expect(driver.killed.filter((k) => k === 'org-7').length).toBeGreaterThanOrEqual(1);
    expect(driver.files.has(p.plan)).toBe(false);
  });
});

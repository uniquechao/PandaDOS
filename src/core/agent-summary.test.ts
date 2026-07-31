import { describe, expect, test } from 'bun:test';
import {
  AgentSummaryRunner,
  buildSummaryPrompt,
  isCodexUpdatePrompt,
  pickAffirmative,
  runAgentSummary,
  SCRATCH_DIR,
  summaryPaths,
  summarySessionName,
  type SummaryDriver,
} from './agent-summary';

// ---------- 可编程假 Driver（tmux 进内存、文件进 Map） ----------

class FakeDriver implements SummaryDriver {
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
  /** 每次 capturePane 的返回内容（按调用序号） */
  paneAt: (n: number) => string = () => '';
  /** 每次 capturePane 前的副作用钩子（模拟代理产出文件） */
  onCapture?: (n: number, files: Map<string, string>) => void;

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
    return this.paneAt(n);
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
  async removeTree(path: string) {
    this.removed.push(path);
    for (const k of [...this.files.keys()]) {
      if (k === path || k.startsWith(path + '/')) this.files.delete(k);
    }
  }
}

/** 虚拟时钟：sleep 推进，now 读取（轮询/超时确定性） */
function mkClock() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms) };
}

const FAST = { pollIntervalMs: 10, readyDelayMs: 20, timeoutMs: 400 };

// ---------- 纯函数 ----------

describe('纯函数', () => {
  test('summarySessionName / summaryPaths 用 sum- 前缀且不碰 cc-', () => {
    expect(summarySessionName(7)).toBe('sum-7');
    expect(summarySessionName(7)).not.toBe('cc-7');
    const p = summaryPaths('/repo/proj/');
    expect(p.scratch).toBe(`/repo/proj/${SCRATCH_DIR}`);
    expect(p.history).toBe(`/repo/proj/${SCRATCH_DIR}/history.md`);
    expect(p.understanding).toBe(`/repo/proj/${SCRATCH_DIR}/understanding.md`);
    expect(p.done).toBe(`/repo/proj/${SCRATCH_DIR}/done`);
  });

  test('pickAffirmative 选肯定项，无匹配退化到 0', () => {
    expect(pickAffirmative(['Yes, proceed', 'No, exit'])).toBe(0);
    expect(pickAffirmative(['No, exit', 'Yes, I accept'])).toBe(1);
    expect(pickAffirmative(['信任此目录', '退出'])).toBe(0);
    expect(pickAffirmative(['选项甲', '选项乙'])).toBe(0);
  });

  test('issue #94/#95 回归：AskUserQuestion 选项解析变全后，清菜单仍退化到第 0 项', () => {
    // 旁路会话（总结/澄清/整理）的 clearMenusOnce 只求「把挡路的菜单点掉」。
    // 修好解析后这类业务问句会从 1 项变成 5 项，pickAffirmative 必须仍然
    // 认不出肯定项 → 落回第 0 项（光标本就在第 0 项 → delta 0 → 只多一个空 Enter），
    // 不能因为多出来的 CC 自带项（Type something. / Chat about this）而改选别处。
    expect(
      pickAffirmative([
        '朝向基本固定',
        '每个盒子朝向都会变',
        '不确定，先按固定做',
        'Type something.',
        'Chat about this',
      ]),
    ).toBe(0);
  });

  test('buildSummaryPrompt 覆盖读历史/更新 README/写认知/最后 done', () => {
    const p = buildSummaryPrompt('claude', '导出模块');
    expect(p).toContain('导出模块');
    expect(p).toContain(`${SCRATCH_DIR}/history.md`);
    expect(p).toContain('README.md');
    expect(p).toContain(`${SCRATCH_DIR}/understanding.md`);
    expect(p).toContain(`${SCRATCH_DIR}/done`);
    // 单段（sendKeys 会把换行转空格，这里就不该带换行）
    expect(p).not.toContain('\n');
    expect(buildSummaryPrompt('codex')).toContain('无需请求审批');
  });

  test('buildSummaryPrompt target=memory：更新记忆文件（claude→CLAUDE.md / codex→AGENTS.md），不提 README', () => {
    const cl = buildSummaryPrompt('claude', '导出模块', 'memory');
    expect(cl).toContain('项目记忆');
    expect(cl).toContain('CLAUDE.md');
    expect(cl).not.toContain('README.md');
    expect(cl).toContain(`${SCRATCH_DIR}/understanding.md`);
    expect(cl).toContain(`${SCRATCH_DIR}/done`);
    expect(cl).not.toContain('\n');
    const cx = buildSummaryPrompt('codex', '导出模块', 'memory');
    expect(cx).toContain('AGENTS.md');
    expect(cx).not.toContain('CLAUDE.md');
  });

  test('isCodexUpdatePrompt 识别 codex 更新弹窗', () => {
    const pane = [
      '  ✨ Update available! 0.144.1 -> 0.144.6',
      '› 1. Update now',
      '  2. Skip',
      '  Press enter to continue',
    ].join('\n');
    expect(isCodexUpdatePrompt(pane)).toBe(true);
    expect(isCodexUpdatePrompt('❯ 1. Yes\n  2. No')).toBe(false);
    expect(isCodexUpdatePrompt('')).toBe(false);
  });
});

// ---------- run：happy path ----------

describe('AgentSummaryRunner.run', () => {
  test('成功：起 sum-<id> 会话、写历史、注入提示、读回认知、清理', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = summaryPaths(cwd);
    // 第 5 次抓屏起，模拟代理已产出 understanding + done
    driver.onCapture = (n, files) => {
      if (n >= 5) {
        files.set(p.understanding, '本项目是 XXX，主要做 YYY，现状 ZZZ。');
        files.set(p.done, 'ok');
      }
    };
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 1, cwd, agent: 'claude', historyDigest: '历史摘要正文', projectName: 'Demo' },
      FAST,
    );

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.understanding).toBe('本项目是 XXX，主要做 YYY，现状 ZZZ。');

    // 独立会话，绝不碰 cc-1
    expect(driver.created.map((c) => c.name)).toEqual(['sum-1']);
    expect(driver.created.some((c) => c.name === 'cc-1')).toBe(false);
    // 历史摘要写到 scratch
    expect(driver.wrote.some((w) => w.path === p.history && w.data === '历史摘要正文')).toBe(true);
    // 起了 claude --permission-mode acceptEdits（root 可用，自动放行写文件）并注入了任务提示
    expect(driver.sent[0]!.text).toBe('claude --permission-mode acceptEdits');
    expect(driver.sent.some((s) => s.text.includes(`${SCRATCH_DIR}/understanding.md`))).toBe(true);
    // 收尾：杀会话 + 删 scratch
    expect(driver.killed).toContain('sum-1');
    expect(driver.removed).toContain(p.scratch);
    // scratch 被清空
    expect(driver.files.has(p.understanding)).toBe(false);
    expect(driver.files.has(p.done)).toBe(false);
  });

  test('codex：起 codex 并带 bypass 参数', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = summaryPaths(cwd);
    driver.onCapture = (n, files) => {
      if (n >= 5) {
        files.set(p.understanding, '认知');
        files.set(p.done, 'ok');
      }
    };
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 2, cwd, agent: 'codex', historyDigest: 'h' },
      FAST,
    );
    expect(r.ok).toBe(true);
    expect(driver.created.map((c) => c.name)).toEqual(['sum-2']);
    expect(driver.sent[0]!.text).toContain('codex');
    expect(driver.sent[0]!.text).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('超时：done 标记始终不出现 → reason=timeout，仍清理', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = summaryPaths(cwd);
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 3, cwd, agent: 'claude', historyDigest: 'h' },
      FAST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
    expect(driver.killed).toContain('sum-3');
    expect(driver.removed).toContain(p.scratch);
  });

  test('done 出现但 understanding 空 → reason=no-output', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = summaryPaths(cwd);
    driver.onCapture = (n, files) => {
      if (n >= 3) files.set(p.done, 'ok'); // 只有 done，无 understanding
    };
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 4, cwd, agent: 'claude', historyDigest: 'h' },
      FAST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-output');
  });

  test('菜单自动过：光标在否定项、肯定项在下 → Down 后 Enter', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    // 只有第 0 次抓屏是信任弹窗，之后无菜单
    driver.paneAt = (n) =>
      n === 0
        ? ['Do you trust the files in this folder?', '❯ 1. No, exit', '  2. Yes, I accept'].join('\n')
        : '';
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 5, cwd, agent: 'claude', historyDigest: 'h' },
      { pollIntervalMs: 10, readyDelayMs: 10, timeoutMs: 30 },
    );
    // 该项没产出 done → 超时；重点是菜单被自动处理
    expect(r.ok).toBe(false);
    expect(driver.keys).toEqual([
      { session: 'sum-5', key: 'Down' },
      { session: 'sum-5', key: 'Enter' },
    ]);
  });

  test('codex 更新弹窗自动选 Skip（发送 "2"，不误触 Update now）', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    driver.paneAt = (n) =>
      n === 0
        ? ['✨ Update available! 0.144.1 -> 0.144.6', '› 1. Update now', '  2. Skip', '  Press enter to continue'].join('\n')
        : '';
    await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 9, cwd, agent: 'codex', historyDigest: 'h' },
      { pollIntervalMs: 10, readyDelayMs: 10, timeoutMs: 20 },
    );
    // 起了 codex，且更新弹窗被「2」跳过（sendKeys 记在 sent 里）
    expect(driver.sent[0]!.text).toContain('codex');
    expect(driver.sent.some((s) => s.text === '2')).toBe(true);
  });

  test('异常：createSession 抛错 → reason=error，收尾不炸', async () => {
    const driver = new FakeDriver();
    driver.failCreate = true;
    const cwd = '/repo/proj';
    const p = summaryPaths(cwd);
    const r = await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 6, cwd, agent: 'claude', historyDigest: 'h' },
      FAST,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
    // 收尾仍尝试删 scratch（不因失败中断）
    expect(driver.removed).toContain(p.scratch);
  });

  test('持续弹窗每轮都自动确认（不因签名相同而漏过，防 done 卡死）', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    // 连续多次抓屏都是同款权限弹窗（选项文字完全一样 = 签名相同）
    driver.paneAt = () => ['写入 done？', '❯ 1. 允许并继续', '  2. 拒绝'].join('\n');
    await runAgentSummary(
      { driver, ...mkClock() },
      { projectId: 7, cwd, agent: 'claude', historyDigest: 'h' },
      { pollIntervalMs: 10, readyDelayMs: 30, timeoutMs: 30 },
    );
    // 每次见到菜单都点 → 多轮多次 Enter（不再去重漏过后续同款弹窗）
    const enters = driver.keys.filter((k) => k.key === 'Enter');
    expect(enters.length).toBeGreaterThan(1);
  });
});

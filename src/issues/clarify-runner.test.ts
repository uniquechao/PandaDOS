import { describe, expect, test } from 'bun:test';
import {
  buildClarifyPrompt,
  buildClarifyTaskMd,
  CLARIFY_SCRATCH_BASE,
  ClarifyRunner,
  clarifyPaths,
  clarifySessionName,
  MAX_QUESTIONS,
  parseQuestions,
  runClarify,
  type ClarifyDriver,
} from './clarify-runner';

// ---------- 可编程假 Driver（agent-summary.test 同款：tmux 进内存、文件进 Map） ----------

class FakeDriver implements ClarifyDriver {
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
  test('clarifySessionName / clarifyPaths：clr- 前缀 + 按 issue 隔离的 scratch 子目录', () => {
    expect(clarifySessionName(42)).toBe('clr-42');
    const p = clarifyPaths('/repo/proj/', 42);
    expect(p.scratch).toBe(`/repo/proj/${CLARIFY_SCRATCH_BASE}/42`);
    expect(p.task).toBe(`/repo/proj/${CLARIFY_SCRATCH_BASE}/42/task.md`);
    expect(p.feedback).toBe(`/repo/proj/${CLARIFY_SCRATCH_BASE}/42/feedback.md`);
    expect(p.questions).toBe(`/repo/proj/${CLARIFY_SCRATCH_BASE}/42/questions.md`);
    expect(p.done).toBe(`/repo/proj/${CLARIFY_SCRATCH_BASE}/42/done`);
    // 兄弟 issue 子目录互不重叠
    expect(clarifyPaths('/repo/proj', 7).scratch).not.toBe(p.scratch);
  });

  test('buildClarifyTaskMd：标题/类型/目标/正文齐全；无正文有占位', () => {
    const md = buildClarifyTaskMd({
      title: '加导出',
      body: '支持 CSV 导出',
      category: 'task',
      goal: '做个报表系统',
      projectName: 'Demo',
    });
    expect(md).toContain('加导出');
    expect(md).toContain('task');
    expect(md).toContain('做个报表系统');
    expect(md).toContain('支持 CSV 导出');
    expect(md).toContain('Demo');
    expect(buildClarifyTaskMd({ title: '只有标题' })).toContain('（无正文，仅标题）');
  });

  test('buildClarifyPrompt：单段无换行，覆盖 task/feedback/questions/done 与只读约束', () => {
    const p = buildClarifyPrompt('claude', 42);
    expect(p).not.toContain('\n');
    expect(p).toContain(`${CLARIFY_SCRATCH_BASE}/42/task.md`);
    expect(p).toContain(`${CLARIFY_SCRATCH_BASE}/42/feedback.md`);
    expect(p).toContain(`${CLARIFY_SCRATCH_BASE}/42/questions.md`);
    expect(p).toContain(`${CLARIFY_SCRATCH_BASE}/42/done`);
    expect(p).toContain('不要改动任何文件');
    expect(buildClarifyPrompt('codex', 1)).toContain('无需请求审批');
  });

  test('buildClarifyTaskMd：历轮问答成对渲染（问题编号 + 答复/未答占位）；无历史无该节', () => {
    const md = buildClarifyTaskMd({
      title: '加导出',
      body: '正文',
      history: [
        { questions: ['要支持哪些格式？', '要不要鉴权？'], answer: 'CSV 就行，不用鉴权' },
        { questions: ['数据量多大？'], answer: null },
      ],
    });
    expect(md).toContain('历轮澄清问答');
    expect(md).toContain('第 1 轮');
    expect(md).toContain('1. 要支持哪些格式？');
    expect(md).toContain('2. 要不要鉴权？');
    expect(md).toContain('CSV 就行，不用鉴权');
    expect(md).toContain('第 2 轮');
    expect(md).toContain('数据量多大？');
    expect(md).toContain('（未答复）');
    expect(buildClarifyTaskMd({ title: '无历史' })).not.toContain('历轮澄清问答');
    expect(buildClarifyTaskMd({ title: '空历史', history: [] })).not.toContain('历轮澄清问答');
  });

  test('buildClarifyPrompt：默认明示已答过的不重复问；allowQuestions=false 时不许创建 questions.md', () => {
    const p = buildClarifyPrompt('claude', 42);
    expect(p).toContain('不要重复问');
    const noQ = buildClarifyPrompt('claude', 42, { allowQuestions: false });
    expect(noQ).not.toContain('\n');
    expect(noQ).toContain('不要创建');
    expect(noQ).toContain('questions.md');
    expect(noQ).toContain(`${CLARIFY_SCRATCH_BASE}/42/feedback.md`);
    expect(noQ).toContain(`${CLARIFY_SCRATCH_BASE}/42/done`);
  });

  test('parseQuestions：剥编号/列表符、去空行与「无」占位、截条数与长度', () => {
    expect(parseQuestions(null)).toEqual([]);
    expect(parseQuestions('')).toEqual([]);
    expect(parseQuestions('无')).toEqual([]);
    expect(parseQuestions('（无）\nNone\nn/a')).toEqual([]);
    expect(
      parseQuestions('1. 要支持哪些格式？\n2) 要不要鉴权？\n- 数据量多大？\n• 谁用？\n(5) 上线时间？'),
    ).toEqual(['要支持哪些格式？', '要不要鉴权？', '数据量多大？', '谁用？', '上线时间？']);
    // 超过 5 条截断
    const many = Array.from({ length: 8 }, (_, i) => `${i + 1}. 问题${i + 1}`).join('\n');
    expect(parseQuestions(many)).toHaveLength(MAX_QUESTIONS);
    // 单条超长截 300
    expect(parseQuestions('x'.repeat(500))[0]!.length).toBe(300);
  });
});

// ---------- run ----------

describe('ClarifyRunner.run', () => {
  test('成功：起 clr-<id> 会话、写 task.md、注入提示、读回反馈+问题、清理', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 42);
    driver.onCapture = (n, files) => {
      if (n >= 5) {
        files.set(p.feedback, '理解：加 CSV 导出；思路：改 export.ts；风险：大数据量内存。');
        files.set(p.questions, '1. 要不要鉴权？\n2. 最大导出多少行？');
        files.set(p.done, 'ok');
      }
    };
    const r = await runClarify(
      { driver, ...mkClock() },
      { issueId: 42, cwd, agent: 'claude', title: '加导出', body: '支持 CSV', goal: 'G', projectName: 'Demo' },
      FAST,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback).toContain('加 CSV 导出');
      expect(r.questions).toEqual(['要不要鉴权？', '最大导出多少行？']);
      // 原文留档（#110）：questions.md 原样返回（含编号），不受 parseQuestions 裁剪
      expect(r.questionsText).toBe('1. 要不要鉴权？\n2. 最大导出多少行？');
    }
    // 独立会话，绝不碰 cc-*/sum-*
    expect(driver.created.map((c) => c.name)).toEqual(['clr-42']);
    // 任务文件写到 scratch
    expect(driver.wrote.some((w) => w.path === p.task && w.data.includes('支持 CSV'))).toBe(true);
    // 起了 claude acceptEdits 并注入了任务提示
    expect(driver.sent[0]!.text).toBe('claude --permission-mode acceptEdits');
    expect(driver.sent.some((s) => s.text.includes(`${CLARIFY_SCRATCH_BASE}/42/feedback.md`))).toBe(true);
    // 收尾：杀会话 + 删本 issue scratch 子目录
    expect(driver.killed).toContain('clr-42');
    expect(driver.removed).toContain(p.scratch);
    expect(driver.files.has(p.feedback)).toBe(false);
  });

  test('codex：起 codex bypass 参数；questions.md 缺失 → 视为需求清晰（questions=[]）', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 7);
    driver.onCapture = (n, files) => {
      if (n >= 5) {
        files.set(p.feedback, '需求清晰，直接做。');
        files.set(p.done, 'ok');
      }
    };
    const r = await runClarify(
      { driver, ...mkClock() },
      { issueId: 7, cwd, agent: 'codex', title: 't' },
      FAST,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback).toBe('需求清晰，直接做。');
      expect(r.questions).toEqual([]);
    }
    expect(driver.sent[0]!.text).toContain('codex');
    expect(driver.sent[0]!.text).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  test('只有问题没有反馈 → 仍算成功（feedback 为空串）', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 8);
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(p.questions, '目标环境是什么？');
        files.set(p.done, 'ok');
      }
    };
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 8, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.feedback).toBe('');
      expect(r.questions).toEqual(['目标环境是什么？']);
    }
  });

  test('超时：done 标记始终不出现 → reason=timeout，仍清理', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 3);
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 3, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('timeout');
    expect(driver.killed).toContain('clr-3');
    expect(driver.removed).toContain(p.scratch);
  });

  test('done 出现但反馈/问题都空 → reason=no-output', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 4);
    driver.onCapture = (n, files) => {
      if (n >= 3) files.set(p.done, 'ok'); // 只有 done
    };
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 4, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-output');
  });

  test('异常：createSession 抛错 → reason=error，收尾不炸', async () => {
    const driver = new FakeDriver();
    driver.failCreate = true;
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 6);
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 6, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('error');
    expect(driver.removed).toContain(p.scratch);
  });

  test('菜单自动过：光标在否定项、肯定项在下 → Down 后 Enter；codex 更新弹窗发 2 跳过', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    driver.paneAt = (n) =>
      n === 0
        ? ['Do you trust the files in this folder?', '❯ 1. No, exit', '  2. Yes, I accept'].join('\n')
        : n === 1
          ? ['✨ Update available!', '› 1. Update now', '  2. Skip', '  Press enter to continue'].join('\n')
          : '';
    await runClarify(
      { driver, ...mkClock() },
      { issueId: 5, cwd, agent: 'claude', title: 't' },
      { pollIntervalMs: 10, readyDelayMs: 20, timeoutMs: 30 },
    );
    expect(driver.keys).toEqual([
      { session: 'clr-5', key: 'Down' },
      { session: 'clr-5', key: 'Enter' },
    ]);
    expect(driver.sent.some((s) => s.text === '2')).toBe(true);
  });

  test('并发隔离：清理只删本 issue 子目录，不动同项目兄弟 scratch', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const mine = clarifyPaths(cwd, 10);
    const sibling = clarifyPaths(cwd, 11);
    driver.files.set(sibling.task, '兄弟 issue 的任务文件');
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(mine.feedback, 'fb');
        files.set(mine.done, 'ok');
      }
    };
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 10, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(true);
    expect(driver.removed).toContain(mine.scratch);
    expect(driver.removed).not.toContain(sibling.scratch);
    expect(driver.files.get(sibling.task)).toBe('兄弟 issue 的任务文件');
  });

  test('残留会话/旧 scratch：起步先清（kill 失败静默），不影响本轮', async () => {
    const driver = new FakeDriver();
    const cwd = '/repo/proj';
    const p = clarifyPaths(cwd, 12);
    driver.sessions.add('clr-12'); // 上轮残留
    driver.files.set(p.feedback, '旧反馈（应被清掉重来）');
    driver.onCapture = (n, files) => {
      if (n >= 3) {
        files.set(p.feedback, '新反馈');
        files.set(p.done, 'ok');
      }
    };
    const r = await runClarify({ driver, ...mkClock() }, { issueId: 12, cwd, agent: 'claude', title: 't' }, FAST);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.feedback).toBe('新反馈');
    // 残留会话先被杀，收尾又杀一次（第二次静默失败不炸）
    expect(driver.killed.filter((k) => k === 'clr-12').length).toBeGreaterThanOrEqual(1);
  });
});

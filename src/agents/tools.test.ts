/**
 * agents/tools 测试 —— 四件套走 mock Driver + mock 对话表，不碰真 tmux/fs。
 * 覆盖：项目作用域寻址、归属硬校验（不信 LLM 传参）、ANSI 清洗尾 25 行、
 * send_command 必经 KeyedMutex（与引擎同一把 tmuxLockKey）、未知工具。
 */
import { describe, expect, test } from 'bun:test';
import type { Conversation } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import { KeyedMutex, tmuxLockKey } from '../issues/mutex';
import {
  CAPTURE_TAIL_LINES,
  executeTool,
  TOOL_SCHEMAS,
  type PmToolsDeps,
  type ToolConvOps,
} from './tools';

// ---------- mock 件 ----------

interface MockDriverState {
  sessions: string[];
  pane: string | Error;
  files: Map<string, Uint8Array>;
  sent: Array<{ session: string; text: string }>;
  sendDelayMs?: number;
  /** 每会话的 #{pane_current_command}（issue #97 判活主证据） */
  commands?: Record<string, string>;
}

function mockDriver(st: MockDriverState): ExecutorDriver {
  const enc = new TextEncoder();
  void enc;
  return {
    async findExecutable() {
      return null;
    },
    async listSessions() {
      return st.sessions.map((name) => {
        const command = st.commands?.[name];
        return { name, createdTs: 0, attached: false, ...(command ? { command } : {}) };
      });
    },
    async createSession() {},
    async killSession() {},
    async sendKeys(session, text) {
      if (st.sendDelayMs) await new Promise((r) => setTimeout(r, st.sendDelayMs));
      st.sent.push({ session, text });
    },
    async sendKey() {},
    async resizeWindow() {},
    async capturePane() {
      if (st.pane instanceof Error) throw st.pane;
      return st.pane;
    },
    async readFileRange(path, offset, limit) {
      const f = st.files.get(path);
      if (!f) throw new Error('no such file');
      return { data: f.subarray(offset, offset + limit), size: f.length };
    },
    async statPath(path) {
      const f = st.files.get(path);
      if (!f) return null;
      return { size: f.length, mtimeMs: 0, isDirectory: false, isFile: true, mode: 0o644 };
    },
    async listDir() {
      return [];
    },
    async writeFile() {},
    async symlink() {},
    async readlink() {
      return null;
    },
    async removeTree() {},
    async mkdirp() {},
    async movePath() {},
    async git() {
      return { code: 0, out: '', err: '' };
    },
    async openPty() {
      throw new Error('not implemented');
    },
  };
}

function conv(id: string, label: string, archived = false): Conversation {
  return { id, projectId: 7, label, createdTs: 1, archived, agent: 'claude', kind: 'issue', lastActiveTs: null, autoApprove: 'cautious' };
}

function mockConvs(
  convs: Conversation[],
  current?: string,
  over: Partial<ToolConvOps> = {},
): ToolConvOps & { relaunched: string[] } {
  const relaunched: string[] = [];
  return {
    relaunched,
    listByProject: (pid) => (pid === 7 ? convs : []),
    currentConv: () => current,
    tmuxName: (pid) => `cc-${pid}`,
    async relaunch(id: string) {
      relaunched.push(id);
      return null;
    },
    ...over,
  };
}

function makeDeps(over: Partial<PmToolsDeps> & { state?: MockDriverState } = {}): {
  deps: PmToolsDeps;
  state: MockDriverState;
} {
  const state: MockDriverState = over.state ?? {
    sessions: ['cc-7'],
    pane: '',
    files: new Map(),
    sent: [],
  };
  const deps: PmToolsDeps = {
    projectId: 7,
    driver: mockDriver(state),
    convs: mockConvs([conv('conv-a', '导出功能'), conv('conv-b', '老对话', true)], 'conv-a'),
    locator: { locate: async (id) => (id === 'conv-a' ? '/claude/p/conv-a.jsonl' : null) },
    mutex: new KeyedMutex(),
    ...over,
  };
  return { deps, state };
}

/** 构造一段合法 jsonl（assistant 文本 + 工具调用 + 报错结果） */
function jsonlBytes(): Uint8Array {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '开始跑测试' }] } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { cmd: 'bun test' } }] },
    }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '全部通过' }] } }),
  ];
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// ---------- 用例 ----------

describe('TOOL_SCHEMAS（OpenAI function-calling 形状 + 项目作用域 description）', () => {
  test('四件套齐全，send_command 必填 text', () => {
    const names = TOOL_SCHEMAS.map((t) => t.function.name);
    expect(names).toEqual(['list_sessions', 'read_progress', 'capture_pane', 'send_command']);
    for (const t of TOOL_SCHEMAS) expect(t.type).toBe('function');
    const send = TOOL_SCHEMAS.find((t) => t.function.name === 'send_command')!;
    expect((send.function.parameters as { required?: string[] }).required).toEqual(['text']);
    // 描述已改项目作用域（评审 §2B：不再是「本机所有 tmux 会话」）
    const list = TOOL_SCHEMAS.find((t) => t.function.name === 'list_sessions')!;
    expect(list.function.description).toContain('本项目');
    expect(list.function.description).not.toContain('本机');
  });
});

describe('list_sessions', () => {
  test('列出项目对话 + 专用会话状态，标注当前激活/归档', async () => {
    const { deps } = makeDeps();
    const out = await executeTool('list_sessions', {}, deps);
    expect(out).toContain('@cc-7：运行中');
    expect(out).toContain('导出功能');
    expect(out).toContain('当前激活');
    expect(out).toContain('已归档');
  });

  test('无对话 / tmux 未启动的降级文案', async () => {
    const { deps } = makeDeps({
      convs: mockConvs([]),
      state: { sessions: [], pane: '', files: new Map(), sent: [] },
    });
    const out = await executeTool('list_sessions', {}, deps);
    expect(out).toContain('未启动');
    expect(out).toContain('还没有对话');
  });
});

describe('read_progress', () => {
  test('缺省读当前激活对话，渲染活动行', async () => {
    const { deps, state } = makeDeps();
    state.files.set('/claude/p/conv-a.jsonl', jsonlBytes());
    const out = await executeTool('read_progress', {}, deps);
    expect(out).toContain('助手说：开始跑测试');
    expect(out).toContain('调用工具 Bash');
    expect(out).toContain('助手说：全部通过');
  });

  test('conv_id 归属硬校验：别的项目的对话拒读（评审 5.3：不信 prompt）', async () => {
    const { deps } = makeDeps();
    const out = await executeTool('read_progress', { conv_id: 'other-project-conv' }, deps);
    expect(out).toContain('不属于本项目');
  });

  test('无激活对话 / jsonl 未落地的降级文案', async () => {
    const { deps } = makeDeps({ convs: mockConvs([conv('conv-b', 'x')], undefined) });
    expect(await executeTool('read_progress', {}, deps)).toContain('没有激活的对话');
    const { deps: d2 } = makeDeps();
    // conv-a 归属合法但 locator 找不到文件
    d2.locator = { locate: async () => null };
    expect(await executeTool('read_progress', {}, d2)).toContain('还没有输出记录');
  });
});

describe('capture_pane', () => {
  test('ANSI 清洗 + 只留非空尾行（v1 平移）', async () => {
    const noise = Array.from({ length: 40 }, (_, i) => `line-${i}`).join('\n');
    const { deps } = makeDeps({
      state: {
        sessions: ['cc-7'],
        pane: `\x1b[31m${noise}\n\x1b[0m❯ 1. Yes\n\n  2. No\x1b[2K`,
        files: new Map(),
        sent: [],
      },
    });
    const out = await executeTool('capture_pane', {}, deps);
    expect(out).not.toContain('\x1b');
    expect(out).toContain('❯ 1. Yes');
    expect(out).toContain('2. No');
    expect(out.split('\n').length).toBeLessThanOrEqual(CAPTURE_TAIL_LINES);
    expect(out).not.toContain('line-0'); // 头部被裁掉
  });

  test('抓屏失败 → 人话降级', async () => {
    const { deps } = makeDeps({
      state: { sessions: ['cc-7'], pane: new Error('no session'), files: new Map(), sent: [] },
    });
    expect(await executeTool('capture_pane', {}, deps)).toContain('抓不到会话 cc-7');
  });
});

describe('send_command', () => {
  test('会话存在 → 经 Driver.sendKeys 注入', async () => {
    const { deps, state } = makeDeps();
    const out = await executeTool('send_command', { text: '继续' }, deps);
    expect(out).toContain('已向 @cc-7 发送：继续');
    expect(state.sent).toEqual([{ session: 'cc-7', text: '继续' }]);
  });

  test('会话不存在 / 空文本 → 拒发', async () => {
    const { deps, state } = makeDeps({
      state: { sessions: [], pane: '', files: new Map(), sent: [] },
    });
    expect(await executeTool('send_command', { text: 'x' }, deps)).toContain('未启动');
    expect(state.sent.length).toBe(0);
    const { deps: d2 } = makeDeps();
    expect(await executeTool('send_command', { text: '   ' }, d2)).toContain('不能发送空消息');
  });

  // issue #97：会话在 ≠ 代理在跑
  test('代理已退回 bash → 不盲发 + 自动重启 + 给 PM 明确文案', async () => {
    const convs = mockConvs([conv('conv-a', '导出功能')], 'conv-a');
    const { deps, state } = makeDeps({
      state: {
        sessions: ['cc-7'],
        pane: '[root@VM p]# claude --resume conv-a\n[root@VM p]#',
        files: new Map(),
        sent: [],
        commands: { 'cc-7': 'bash' },
      },
      convs,
    });

    const out = await executeTool('send_command', { text: '进展如何？' }, deps);
    expect(state.sent.length).toBe(0); // 一个字都没进 shell
    expect(out).toContain('没有发送');
    expect(out).toContain('已自动重启');
    expect(convs.relaunched).toEqual(['conv-a']);
  });

  test('前台是 claude → 照常发（屏面末行像提示符也不误判）', async () => {
    const { deps, state } = makeDeps({
      state: {
        sessions: ['cc-7'],
        pane: '⏺ Bash(ls)\n  ⎿ [root@VM p]#',
        files: new Map(),
        sent: [],
        commands: { 'cc-7': 'claude' },
      },
    });
    expect(await executeTool('send_command', { text: '继续' }, deps)).toContain('已向 @cc-7 发送');
    expect(state.sent.length).toBe(1);
  });

  test('装配没提供 relaunch → 只拒发，不假装重启过', async () => {
    const convs = mockConvs([conv('conv-a', 'x')], 'conv-a', { relaunch: undefined });
    const { deps, state } = makeDeps({
      state: {
        sessions: ['cc-7'],
        pane: '[root@VM p]#',
        files: new Map(),
        sent: [],
        commands: { 'cc-7': 'bash' },
      },
      convs,
    });
    const out = await executeTool('send_command', { text: 'x' }, deps);
    expect(out).toContain('没有发送');
    expect(out).not.toContain('已自动重启');
    expect(state.sent.length).toBe(0);
  });

  test('当前对话挂在别的会话（模块会话）→ 拒发但不乱重启无关会话', async () => {
    const convs = mockConvs([conv('conv-a', 'x')], 'conv-a', {
      tmuxName: (pid, convId) => (convId ? `cc-${pid}-m-billing` : `cc-${pid}`),
    });
    const { deps, state } = makeDeps({
      state: {
        sessions: ['cc-7'],
        pane: '[root@VM p]#',
        files: new Map(),
        sent: [],
        commands: { 'cc-7': 'bash' },
      },
      convs,
    });
    const out = await executeTool('send_command', { text: 'x' }, deps);
    expect(out).toContain('没有发送');
    expect(convs.relaunched).toEqual([]);
    expect(state.sent.length).toBe(0);
  });

  test('注入必经 KeyedMutex：锁被引擎持有时排队，释放后才 sendKeys（评审 H9）', async () => {
    const { deps, state } = makeDeps();
    const mutex = deps.mutex;
    let releaseEngine!: () => void;
    const engineHolds = new Promise<void>((r) => (releaseEngine = r));
    // 模拟引擎持锁（同一把 tmuxLockKey）
    const engineTask = mutex.runExclusive(tmuxLockKey('cc-7'), () => engineHolds);
    const sendTask = executeTool('send_command', { text: '排队消息' }, deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(state.sent.length).toBe(0); // 锁未释放，注入必须还没发生
    releaseEngine();
    await engineTask;
    await sendTask;
    expect(state.sent).toEqual([{ session: 'cc-7', text: '排队消息' }]);
  });
});

describe('未知工具', () => {
  test('回落提示（v1 语义）', async () => {
    const { deps } = makeDeps();
    expect(await executeTool('nope', {}, deps)).toContain('未知工具 nope');
  });
});

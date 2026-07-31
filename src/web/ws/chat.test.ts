/**
 * web/ws/chat 单测 —— 注入自愈门禁（issue #88）。
 *
 * 全链路（升级/鉴权/baseline/tail）在 ws.test.ts；这里只针对 handleFrame 的
 * 死会话判活门禁：text/key/select 注入前发现目标 tmux 会话不存在 →
 * 回 agent_not_ready 明确文案 + 触发 activate 重建，绝不盲注入 / 裸报 inject_failed。
 */
import { describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import type { JsonlReader } from '../../core/jsonl';
import { KeyedMutex } from '../../issues/mutex';
import { chatClose, chatMessage, type ChatDriver, type ChatWsData, type ChatWsDeps } from './chat';

// ---------- 假件 ----------

interface FakeChatDriver extends ChatDriver {
  sessions: Set<string>;
  sent: Array<{ session: string; text: string }>;
  keys: Array<{ session: string; key: string }>;
  pane: string;
  listFails: boolean;
  /** 每会话的 #{pane_current_command}（issue #97 判活主证据） */
  commands: Map<string, string>;
}

function fakeDriver(): FakeChatDriver {
  const d: FakeChatDriver = {
    sessions: new Set<string>(),
    sent: [],
    keys: [],
    pane: '',
    listFails: false,
    commands: new Map<string, string>(),
    async listSessions() {
      if (d.listFails) throw new Error('driver down');
      return [...d.sessions].map((name) => {
        const command = d.commands.get(name);
        return { name, ...(command ? { command } : {}) };
      });
    },
    async capturePane() {
      return d.pane;
    },
    async sendKeys(session, text) {
      d.sent.push({ session, text });
    },
    async sendKey(session, key) {
      d.keys.push({ session, key });
    },
  };
  return d;
}

function fakeWs(
  driver: FakeChatDriver,
  over: Partial<ChatWsData> & { session: string },
): { ws: ServerWebSocket<ChatWsData>; frames: Array<Record<string, unknown>> } {
  const frames: Array<Record<string, unknown>> = [];
  const data: ChatWsData = {
    kind: 'chat',
    projectId: 1,
    userId: 7,
    cwd: '/repo',
    driver,
    pinnedConv: null,
    chatMode: false,
    live: true,
    convId: null,
    jsonl: null,
    offset: 0,
    nextSeq: 0,
    historyHead: 0,
    lastSelSig: '',
    timer: null,
    ...over,
  };
  const ws = {
    data,
    send(s: string) {
      frames.push(JSON.parse(s) as Record<string, unknown>);
    },
  } as unknown as ServerWebSocket<ChatWsData>;
  return { ws, frames };
}

function fakeDeps(
  over: Partial<ChatWsDeps> = {},
  onRelaunch?: (id: string) => void,
): ChatWsDeps & { activated: string[]; relaunched: string[] } {
  const activated: string[] = [];
  const relaunched: string[] = [];
  return {
    activated,
    relaunched,
    reader: {} as unknown as JsonlReader,
    locator: { locate: async () => null },
    convs: {
      currentConv: () => undefined,
      async activate(id: string) {
        activated.push(id);
        return null;
      },
      async relaunch(id: string) {
        relaunched.push(id);
        onRelaunch?.(id);
        return null;
      },
    },
    mutex: new KeyedMutex(),
    retryDelayMs: 1,
    resendPollMs: 5,
    resendWaitMs: 300,
    ...over,
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- 用例 ----------

describe('WS chat 注入自愈门禁（issue #88）', () => {
  test('issue 现场：死会话 text → agent_not_ready + 触发 activate 重建，零注入', async () => {
    const driver = fakeDriver(); // sessions 为空 = 会话已被重启连坐杀掉
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续修' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.type).toBe('err');
    expect(frames[0]!.code).toBe('agent_not_ready');
    expect(String(frames[0]!.msg)).toContain('重建'); // 明确文案，不是笼统 inject_failed
    await waitFor(() => deps.activated.length === 1); // 自愈：activate 拉起激活对话
    expect(deps.activated[0]).toBe('conv-a');
    expect(driver.sent.length).toBe(0); // 用户文本绝不打进死会话
  });

  test('chat 独立会话：死会话 key/select 同样拦截（codex 文案带 agent 名）', async () => {
    const driver = fakeDriver();
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, {
      session: 'chat-conv-c',
      convId: 'conv-c',
      pinnedConv: 'conv-c',
      chatMode: true,
      agent: 'codex',
    });

    chatMessage(ws, JSON.stringify({ type: 'key', key: 'Escape' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.code).toBe('agent_not_ready');
    expect(String(frames[0]!.msg)).toContain('codex');

    chatMessage(ws, JSON.stringify({ type: 'select', index: 0, sig: 'Yes|No@0' }), deps);
    await waitFor(() => frames.length === 2);
    expect(frames[1]!.code).toBe('agent_not_ready');
    expect(driver.keys.length).toBe(0); // 不导航不 Enter
    await waitFor(() => deps.activated.length >= 1);
    expect(deps.activated[0]).toBe('conv-c');
  });

  test('会话活着：text 正常注入，门禁不误伤', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续修' }), deps);
    await waitFor(() => driver.sent.length === 1);
    expect(driver.sent[0]).toEqual({ session: 'cc-1', text: '继续修' });
    expect(frames.length).toBe(0);
    expect(deps.activated.length).toBe(0);
  });

  test('会话活着但前台是 claude：末行像提示符也不误判（issue #97）', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.commands.set('cc-1', 'claude');
    driver.pane = '⏺ Bash(ls)\n  ⎿ [root@VM p]#'; // 代理正在跑命令
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续' }), deps);
    await waitFor(() => driver.sent.length === 1);
    expect(frames.length).toBe(0);
    expect(deps.relaunched.length).toBe(0);
  });

  test('listSessions 失败（判活未知）：保守放行走原注入路径', async () => {
    const driver = fakeDriver();
    driver.listFails = true;
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: 'x' }), deps);
    await waitFor(() => driver.sent.length === 1);
    expect(frames.length).toBe(0);
    expect(deps.activated.length).toBe(0);
  });
});

// ---------- issue #97：代理退回 shell → 重启 + 自动补发 ----------

describe('WS chat 代理存活门禁（issue #97）', () => {
  /** 会话活着、但窗格里只剩 bash（代理崩了/登录过期/被 Ctrl-C） */
  function downDriver(session: string): FakeChatDriver {
    const driver = fakeDriver();
    driver.sessions.add(session);
    driver.commands.set(session, 'bash');
    driver.pane = '[root@VM p]# claude --resume conv-a\n[root@VM p]#';
    return driver;
  }

  test('issue 现场（claude）：不盲注 → 强制重启 → 就绪后自动补发原文', async () => {
    const driver = downDriver('cc-1');
    // 重启成功 = 窗格重新出现 claude 输入框
    const deps = fakeDeps({}, () => {
      driver.commands.set('cc-1', 'claude');
      driver.pane = '❯ ';
    });
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续修 a.ts' }), deps);
    await waitFor(() => frames.length >= 1);
    expect(frames[0]!.code).toBe('agent_not_ready');
    expect(String(frames[0]!.msg)).toContain('自动补发'); // 明说不用手动重发
    expect(driver.sent.length).toBe(0); // 这一刻一个字都没进 bash

    await waitFor(() => deps.relaunched.length === 1); // 走 relaunch（activate 会因会话还在而短路）
    expect(deps.relaunched[0]).toBe('conv-a');
    await waitFor(() => driver.sent.length === 1); // 就绪后自动补发
    expect(driver.sent[0]).toEqual({ session: 'cc-1', text: '继续修 a.ts' });
    expect(frames.length).toBe(1); // 补发成功就不再打扰
  });

  test('chat 独立会话（codex）同样受保护，附图提示一并补发', async () => {
    const driver = downDriver('chat-conv-c');
    const deps = fakeDeps({}, () => {
      driver.commands.set('chat-conv-c', 'codex');
      driver.pane = '› ';
    });
    const { ws, frames } = fakeWs(driver, {
      session: 'chat-conv-c',
      convId: 'conv-c',
      pinnedConv: 'conv-c',
      chatMode: true,
      agent: 'codex',
    });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '看这张图' }), deps);
    await waitFor(() => driver.sent.length === 1);
    expect(String(frames[0]!.msg)).toContain('codex');
    expect(driver.sent[0]!.text).toBe('看这张图');
    expect(deps.relaunched[0]).toBe('conv-c');
  });

  test('重启后仍起不来：等到上限就把这条还给用户，绝不硬发', async () => {
    const driver = downDriver('cc-1'); // relaunch 后屏面还是 bash
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '这条不能丢' }), deps);
    await waitFor(() => frames.length === 2, 3000);
    expect(frames[1]!.code).toBe('agent_not_ready');
    expect(String(frames[1]!.msg)).toContain('没发出去');
    expect(driver.sent.length).toBe(0);
  });

  test('单条在途：等待期间再发一条只提示稍候，不排队堆消息', async () => {
    const driver = downDriver('cc-1');
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '第一条' }), deps);
    await waitFor(() => frames.length === 1);
    chatMessage(ws, JSON.stringify({ type: 'text', text: '第二条' }), deps);
    await waitFor(() => frames.length === 2);
    expect(String(frames[1]!.msg)).toContain('稍候');
    expect(deps.relaunched.length).toBe(1); // 没有第二次 kill
    expect(driver.sent.length).toBe(0);
  });

  test('key/select 只重启不补发（按键是对旧屏幕说的，补发只会乱点）', async () => {
    const driver = downDriver('cc-1');
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'key', key: 'Escape' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.code).toBe('agent_not_ready');
    expect(String(frames[0]!.msg)).toContain('重启');
    await waitFor(() => deps.relaunched.length === 1);
    expect(driver.keys.length).toBe(0);
    expect(driver.sent.length).toBe(0);
  });

  test('连接关掉后不再补发（不对着已关的页面注入）', async () => {
    const driver = downDriver('cc-1');
    let relaunchedAt = 0;
    const deps = fakeDeps({}, () => {
      relaunchedAt = Date.now();
      driver.commands.set('cc-1', 'claude');
      driver.pane = '❯ ';
    });
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '关页面前发的' }), deps);
    await waitFor(() => relaunchedAt > 0);
    chatClose(ws); // 用户把页面关了
    await new Promise((r) => setTimeout(r, 60));
    expect(driver.sent.length).toBe(0);
    expect(frames.length).toBe(1);
  });
});

// ---------- issue #102：用户消息计数 ----------

describe('WS chat 用户消息计数（013）', () => {
  /** bump 调用记录（MessageCounter 的最小结构 stub） */
  function fakeMessages(): { bumps: number[]; bump(userId: number): void } {
    const bumps: number[] = [];
    return { bumps, bump: (userId: number) => void bumps.push(userId) };
  }

  test('text 注入成功记一笔（归属连接所属用户）；按键/选项不是消息不计', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.pane = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No';
    const messages = fakeMessages();
    const deps = fakeDeps({ messages });
    const { ws } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', userId: 42 });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续修' }), deps);
    await waitFor(() => driver.sent.length === 1);
    expect(messages.bumps).toEqual([42]);

    chatMessage(ws, JSON.stringify({ type: 'key', key: 'Escape' }), deps);
    await waitFor(() => driver.keys.length === 1);
    chatMessage(ws, JSON.stringify({ type: 'select', index: 0, sig: 'Yes|No@0' }), deps);
    await new Promise((r) => setTimeout(r, 30));
    expect(messages.bumps).toEqual([42]); // 仍然只有那一条文本
  });

  test('注入失败不计（inject_failed 不该算用户发出去了）', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.sendKeys = async () => {
      throw new Error('tmux 挂了');
    };
    const messages = fakeMessages();
    const deps = fakeDeps({ messages });
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', userId: 42 });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '发不出去' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.code).toBe('inject_failed');
    expect(messages.bumps).toEqual([]);
  });

  test('重启自动补发：真正注入那一刻才计，一条消息只计一次', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.commands.set('cc-1', 'bash');
    driver.pane = '[root@VM p]# claude --resume conv-a\n[root@VM p]#';
    const messages = fakeMessages();
    const deps = fakeDeps({ messages }, () => {
      driver.commands.set('cc-1', 'claude');
      driver.pane = '❯ ';
    });
    const { ws, frames } = fakeWs(driver, {
      session: 'cc-1',
      convId: 'conv-a',
      agent: 'claude',
      userId: 42,
    });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '重启后补发' }), deps);
    await waitFor(() => frames.length >= 1);
    expect(messages.bumps).toEqual([]); // 这一刻还没注入
    await waitFor(() => driver.sent.length === 1);
    expect(messages.bumps).toEqual([42]);
  });
});

// ---------- issue #112：菜单解读「解释一下」 ----------

describe('WS chat 菜单解读（issue #112，点了才生成）', () => {
  const MENU = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No';

  /** 记录调用的 explain 假件 */
  function fakeExplain(reply: string | null = '这一步只是跑测试，安全可逆，建议选 1。') {
    const calls: Array<{ projectId: number; context: string; options: string[]; multiSelect: boolean }> = [];
    return {
      calls,
      fn: async (input: { projectId: number; context: string; options: string[]; multiSelect: boolean }) => {
        calls.push(input);
        return reply;
      },
    };
  }

  function menuWs(driver: FakeChatDriver, over: Partial<ChatWsData> = {}) {
    driver.sessions.add('cc-1');
    driver.pane = MENU;
    return fakeWs(driver, { session: 'cc-1', convId: 'conv-a', ...over });
  }

  test('生成并回 explanation 帧（带菜单本体签名），上下文/选项照实传给解读', async () => {
    const driver = fakeDriver();
    const ex = fakeExplain();
    const deps = fakeDeps({ explain: ex.fn });
    const { ws, frames } = menuWs(driver);

    chatMessage(ws, JSON.stringify({ type: 'explain', sig: 'Yes|No@0' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({
      type: 'explanation',
      sig: 'Yes|No@0',
      optionsSig: 'Yes|No',
      text: '这一步只是跑测试，安全可逆，建议选 1。',
    });
    expect(ex.calls).toEqual([
      { projectId: 1, context: 'Do you want to proceed?', options: ['Yes', 'No'], multiSelect: false },
    ]);
  });

  test('同一菜单再点 → 走缓存，不再烧 LLM 额度', async () => {
    const driver = fakeDriver();
    const ex = fakeExplain();
    const deps = fakeDeps({ explain: ex.fn });
    const { ws, frames } = menuWs(driver);

    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => frames.length === 1);
    // 光标挪一格：菜单本体没变，仍算同一个问题
    driver.pane = ' Do you want to proceed?\n   1. Yes\n ❯ 2. No';
    chatMessage(ws, JSON.stringify({ type: 'explain', sig: 'Yes|No@1' }), deps);
    await waitFor(() => frames.length === 2);
    expect(frames[1]).toMatchObject({ type: 'explanation', sig: 'Yes|No@1', optionsSig: 'Yes|No' });
    expect(ex.calls.length).toBe(1); // 只调过一次
  });

  test('菜单已变/已消失 → stale，绝不解释上一个问题', async () => {
    const driver = fakeDriver();
    const ex = fakeExplain();
    const deps = fakeDeps({ explain: ex.fn });
    const { ws, frames } = menuWs(driver);

    // 客户端拿的是旧菜单签名
    chatMessage(ws, JSON.stringify({ type: 'explain', sig: 'Old|Menu@0' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.type).toBe('stale');

    // 菜单整个没了
    driver.pane = '❯ ';
    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => frames.length === 2);
    expect(frames[1]!.type).toBe('stale');
    expect(ex.calls.length).toBe(0);
  });

  test('换了菜单 → 旧解读作废，重新生成', async () => {
    const driver = fakeDriver();
    const calls: string[] = [];
    const deps = fakeDeps({
      explain: async (input) => {
        calls.push(input.options.join('|'));
        return `解读：${input.options.join('/')}`;
      },
    });
    const { ws, frames } = menuWs(driver);

    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => frames.length === 1);
    driver.pane = ' Delete all logs?\n ❯ 1. 确认删除\n   2. 取消';
    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => frames.length === 2);
    expect(frames[1]).toMatchObject({ optionsSig: '确认删除|取消', text: '解读：确认删除/取消' });
    expect(calls).toEqual(['Yes|No', '确认删除|取消']);
  });

  test('连点单飞：在途只跑一次，只回一帧', async () => {
    const driver = fakeDriver();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const deps = fakeDeps({
      explain: async () => {
        calls++;
        await gate;
        return '慢慢解读完了';
      },
    });
    const { ws, frames } = menuWs(driver);

    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => calls === 1);
    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps); // 用户连点第二下
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(1);
    release!();
    await waitFor(() => frames.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.length).toBe(1);
  });

  test('未装配解读 / 生成失败（null）→ explain_failed，且失败不落缓存', async () => {
    const driver = fakeDriver();
    const { ws: ws1, frames: f1 } = menuWs(driver);
    chatMessage(ws1, JSON.stringify({ type: 'explain' }), fakeDeps());
    await waitFor(() => f1.length === 1);
    expect(f1[0]).toMatchObject({ type: 'err', code: 'explain_failed' });

    const ex = fakeExplain(null);
    const deps = fakeDeps({ explain: ex.fn });
    const { ws: ws2, frames: f2 } = menuWs(fakeDriver());
    chatMessage(ws2, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => f2.length === 1);
    expect(f2[0]).toMatchObject({ type: 'err', code: 'explain_failed' });
    chatMessage(ws2, JSON.stringify({ type: 'explain' }), deps); // 再点还能重试
    await waitFor(() => f2.length === 2);
    expect(ex.calls.length).toBe(2);
  });

  test('只读（非 live）→ forbidden：屏幕上的菜单属于别的对话', async () => {
    const driver = fakeDriver();
    const ex = fakeExplain();
    const deps = fakeDeps({ explain: ex.fn });
    const { ws, frames } = menuWs(driver, { live: false, pinnedConv: 'conv-b' });

    chatMessage(ws, JSON.stringify({ type: 'explain' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({ type: 'err', code: 'forbidden' });
    expect(ex.calls.length).toBe(0);
  });
});

// ---------- issue #116：发送回执（本地乐观气泡的结局） ----------

describe('WS chat 发送回执（issue #116）', () => {
  test('带 id 注入成功 → 恰好一帧 ack；不带 id 保持零帧（老前端不受影响）', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '继续修', id: 'p1' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toEqual({ type: 'ack', id: 'p1' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '再来一条' }), deps);
    await waitFor(() => driver.sent.length === 2);
    await new Promise((r) => setTimeout(r, 20));
    expect(frames.length).toBe(1); // 无 id 不回执
  });

  test('发不出去的都带 id 回错（空帧/注入失败/只读/会话不在）', async () => {
    const alive = fakeDriver();
    alive.sessions.add('cc-1');
    const deps = fakeDeps();

    const { ws: w1, frames: f1 } = fakeWs(alive, { session: 'cc-1', convId: 'conv-a' });
    chatMessage(w1, JSON.stringify({ type: 'text', text: '   ', id: 'p-empty' }), deps);
    await waitFor(() => f1.length === 1);
    expect(f1[0]).toMatchObject({ type: 'err', code: 'bad_frame', id: 'p-empty' });

    const broken = fakeDriver();
    broken.sessions.add('cc-1');
    broken.sendKeys = async () => {
      throw new Error('tmux 挂了');
    };
    const { ws: w2, frames: f2 } = fakeWs(broken, { session: 'cc-1', convId: 'conv-a' });
    chatMessage(w2, JSON.stringify({ type: 'text', text: '发不出去', id: 'p-fail' }), deps);
    await waitFor(() => f2.length === 1);
    expect(f2[0]).toMatchObject({ type: 'err', code: 'inject_failed', id: 'p-fail' });

    const { ws: w3, frames: f3 } = fakeWs(alive, {
      session: 'cc-1',
      convId: 'conv-b',
      pinnedConv: 'conv-b',
      live: false,
    });
    chatMessage(w3, JSON.stringify({ type: 'text', text: '只读', id: 'p-ro' }), deps);
    await waitFor(() => f3.length === 1);
    expect(f3[0]).toMatchObject({ type: 'err', code: 'forbidden', id: 'p-ro' });

    const { ws: w4, frames: f4 } = fakeWs(fakeDriver(), { session: 'cc-1', convId: 'conv-a' });
    chatMessage(w4, JSON.stringify({ type: 'text', text: '会话没了', id: 'p-dead' }), deps);
    await waitFor(() => f4.length === 1);
    expect(f4[0]).toMatchObject({ type: 'err', code: 'agent_not_ready', id: 'p-dead' });
  });

  test('「正在重启并自动补发」不带 id（气泡保持发送中），补发注入成功才回 ack', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.commands.set('cc-1', 'bash');
    driver.pane = '[root@VM p]# claude --resume conv-a\n[root@VM p]#';
    const deps = fakeDeps({}, () => {
      driver.commands.set('cc-1', 'claude');
      driver.pane = '❯ ';
    });
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '这条会补发', id: 'p9' }), deps);
    await waitFor(() => frames.length === 1);
    expect(frames[0]!.code).toBe('agent_not_ready');
    expect(frames[0]!.id).toBeUndefined(); // 还没死心：前端保持「发送中」
    await waitFor(() => frames.length === 2, 3000);
    expect(frames[1]).toEqual({ type: 'ack', id: 'p9' });
    expect(driver.sent[0]!.text).toBe('这条会补发');
  });

  test('重启后仍未就绪 → 带 id 的 err，让气泡标失败而不是永远转圈', async () => {
    const driver = fakeDriver();
    driver.sessions.add('cc-1');
    driver.commands.set('cc-1', 'bash');
    driver.pane = '[root@VM p]# claude --resume conv-a\n[root@VM p]#';
    const deps = fakeDeps();
    const { ws, frames } = fakeWs(driver, { session: 'cc-1', convId: 'conv-a', agent: 'claude' });

    chatMessage(ws, JSON.stringify({ type: 'text', text: '起不来', id: 'p10' }), deps);
    await waitFor(() => frames.length === 2, 3000);
    expect(frames[1]).toMatchObject({ type: 'err', code: 'agent_not_ready', id: 'p10' });
    expect(String(frames[1]!.msg)).toContain('没发出去');
    expect(driver.sent.length).toBe(0);
  });
});

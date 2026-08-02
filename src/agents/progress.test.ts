/**
 * agents/progress 测试 —— 批量 flush 管道全 mock LLM。
 * 覆盖：analyze prompt 快照与 JSON 解析降级、push 过滤、needsReply→waiting 覆写、
 * LLM 失败回插（评审 H14）、截断保尾（评审 M18）、flush 单飞（评审 M6）、
 * 报错即时旁路、runningSummary 内存/DB 双实现（评审 H4）。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from '../core/db';
import { migrate } from '../core/migrate';
import { migratePmAgent } from './pm';
import type { LlmChatOpts, LlmClient, LlmMessage, LlmResult } from './llm';
import {
  ANALYZE_SYS,
  analyzeProgress,
  DbSummaryStore,
  fmtChatEvent,
  isEventStatus,
  MemorySummaryStore,
  ProgressReporter,
  type ProgressAnalysis,
} from './progress';

class MockLlm implements LlmClient {
  calls: Array<{ messages: LlmMessage[]; opts?: LlmChatOpts }> = [];
  constructor(private script: Array<string | Error> = []) {}
  push(...items: Array<string | Error>): void {
    this.script.push(...items);
  }
  async chat(messages: LlmMessage[], opts?: LlmChatOpts): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    const content = next ?? '';
    return { content, toolCalls: [], raw: { role: 'assistant', content } };
  }
}

const PUSH_OK = '{"push":true,"status":"milestone","needsReply":false,"headline":"测试全过"}';
const PUSH_NO = '{"push":false,"status":"working","needsReply":false,"headline":""}';

describe('fmtChatEvent（v1 fmtEvent 平移）', () => {
  test('四分支渲染 + thinking 过滤', () => {
    expect(fmtChatEvent({ role: 'assistant', text: '好了' })).toBe('助手说：好了');
    expect(fmtChatEvent({ role: 'tool_use', tool: 'Bash', input: 'ls' })).toBe('调用工具 Bash（ls）');
    expect(fmtChatEvent({ role: 'tool_result', result: 'ok' })).toBe('工具结果：ok');
    expect(fmtChatEvent({ role: 'tool_result', result: 'boom', isError: true })).toBe('工具结果(报错)：boom');
    expect(fmtChatEvent({ role: 'user', text: 'hi' })).toBe('用户输入：hi');
    expect(fmtChatEvent({ role: 'thinking', text: 'hmm' })).toBe('');
  });
});

describe('analyzeProgress（v1 analyze 平移）', () => {
  test('system = 前缀 + ANALYZE_SYS；user 模板含此前进度；jsonMode', async () => {
    const llm = new MockLlm([PUSH_OK]);
    const a = await analyzeProgress(llm, { label: 'proj', prev: '', activity: '助手说：done', systemPrefix: 'P' });
    expect(a).toEqual({ push: true, status: 'milestone', needsReply: false, headline: '测试全过' });
    const call = llm.calls[0]!;
    expect(call.messages[0]!.content).toStartWith(`P\n\n${ANALYZE_SYS}`);
    expect(call.messages[0]!.content).toContain('zh-Hans');
    expect(call.messages[1]!.content).toContain('会话 @proj');
    expect(call.messages[1]!.content).toContain('此前进度：(无)');
    expect(call.opts?.jsonMode).toBe(true);
  });

  test('JSON 解析失败降级 push=false（v1 兜底）；未知 status 归 working', async () => {
    const bad = await analyzeProgress(new MockLlm(['not json']), { label: 'p', prev: '', activity: 'x' });
    expect(bad).toEqual({ push: false, status: 'working', headline: '', needsReply: false });
    const odd = await analyzeProgress(
      new MockLlm(['{"push":true,"status":"weird","headline":"h"}']),
      { label: 'p', prev: '', activity: 'x' },
    );
    expect(odd.status).toBe('working');
  });

  test('isEventStatus 与 schema 配套', () => {
    for (const s of ['milestone', 'waiting', 'error', 'done', 'working']) expect(isEventStatus(s)).toBe(true);
    expect(isEventStatus('nope')).toBe(false);
    expect(isEventStatus(1)).toBe(false);
  });

  test('ANALYZE_SYS 快照逐字（v1 agent.ts:90-95）', () => {
    expect(ANALYZE_SYS).toBe(`# 任务：判断要不要打扰主人，并分类
分析这个 Claude Code 会话的最新活动，只输出 JSON：
{"push": bool, "status": "milestone|waiting|error|done|working", "needsReply": bool, "headline": "≤40字中文一句话进度，口语，不要带会话名"}
规则（宁可漏推也别刷屏，拿不准就 push=false）：
· push=false（进行中的单步动作）：'正在读/查看/分析 X'、'调用了某工具'、'正在写/改代码'、'正在跑测试'。
· push=true（值得打扰）：阶段/任务完成、测试通过或失败、报错、被卡住、**需要主人决策或回话**。
needsReply=true 当 CC 在问主人或在等主人输入/批准。只输出 JSON。`);
  });
});

describe('ProgressReporter 批量 flush', () => {
  function make(llm: MockLlm, opts: ConstructorParameters<typeof ProgressReporter>[4] = {}) {
    const pushed: ProgressAnalysis[] = [];
    const rep = new ProgressReporter('proj', llm, (a) => void pushed.push(a), new MemorySummaryStore(), opts);
    return { rep, pushed };
  }

  test('空缓冲 flush → null，不调 LLM', async () => {
    const llm = new MockLlm();
    const { rep } = make(llm);
    expect(await rep.flush()).toBeNull();
    expect(llm.calls.length).toBe(0);
  });

  test('push=false → 静默丢弃（缓冲已消费）', async () => {
    const llm = new MockLlm([PUSH_NO]);
    const { rep, pushed } = make(llm);
    rep.add({ role: 'assistant', text: '正在读文件' });
    expect(await rep.flush()).toBeNull();
    expect(pushed.length).toBe(0);
    expect(rep.pendingCount).toBe(0);
  });

  test('push=true → onPush 收到分析结果；runningSummary 滚动进下一轮 prev', async () => {
    const llm = new MockLlm([PUSH_OK, PUSH_OK]);
    const { rep, pushed } = make(llm);
    rep.add({ role: 'assistant', text: '跑完测试了' });
    const a = await rep.flush();
    expect(a?.headline).toBe('测试全过');
    expect(pushed.length).toBe(1);
    expect(rep.runningSummary).toBe('测试全过');

    rep.add({ role: 'assistant', text: '又干了点' });
    await rep.flush();
    expect(llm.calls[1]!.messages[1]!.content).toContain('此前进度：测试全过');
  });

  test('needsReply=true → status 覆写为 waiting（v1 橙色置顶语义）', async () => {
    const llm = new MockLlm(['{"push":true,"status":"milestone","needsReply":true,"headline":"在等你回话"}']);
    const { rep, pushed } = make(llm);
    rep.add({ role: 'assistant', text: '请确认' });
    await rep.flush();
    expect(pushed[0]!.status).toBe('waiting');
    expect(pushed[0]!.needsReply).toBe(true);
  });

  test('LLM 调用失败 → 事件回插缓冲，下轮重试成功（评审 H14：不再整批蒸发）', async () => {
    const llm = new MockLlm([new Error('llm 抖动'), PUSH_OK]);
    const { rep, pushed } = make(llm);
    rep.add({ role: 'assistant', text: 'A' });
    rep.add({ role: 'assistant', text: 'B' });
    expect(await rep.flush()).toBeNull();
    expect(rep.pendingCount).toBe(2); // 回插
    const a = await rep.flush();
    expect(a?.headline).toBe('测试全过');
    expect(pushed.length).toBe(1);
    // 重试时活动内容完整保留
    expect(llm.calls[1]!.messages[1]!.content).toContain('助手说：A');
    expect(llm.calls[1]!.messages[1]!.content).toContain('助手说：B');
  });

  test('JSON 解析失败 ≠ 调用失败：降级 push=false，事件视为已消费（v1 语义）', async () => {
    const llm = new MockLlm(['not json']);
    const { rep } = make(llm);
    rep.add({ role: 'assistant', text: 'x' });
    expect(await rep.flush()).toBeNull();
    expect(rep.pendingCount).toBe(0);
  });

  test('超长活动截断保尾（评审 M18：最新动作不能丢）', async () => {
    const llm = new MockLlm([PUSH_OK]);
    const { rep } = make(llm, { maxChars: 60 });
    rep.add({ role: 'assistant', text: '旧'.repeat(80) });
    rep.add({ role: 'assistant', text: '最新的关键动作' });
    await rep.flush();
    const user = llm.calls[0]!.messages[1]!.content!;
    expect(user).toContain('最新的关键动作'); // 尾部保留
    expect(user).not.toContain('助手说：旧'); // 头部被截
  });

  test('tool_result 报错 → 即时旁路 flush（v1 agent.ts:60）', async () => {
    const llm = new MockLlm(['{"push":true,"status":"error","needsReply":false,"headline":"编译炸了"}']);
    let resolvePush!: () => void;
    const gotPush = new Promise<void>((r) => (resolvePush = r));
    const pushed: ProgressAnalysis[] = [];
    const rep = new ProgressReporter('p', llm, (a) => {
      pushed.push(a);
      resolvePush();
    });
    rep.add({ role: 'tool_result', result: 'error: boom', isError: true }); // 触发 void flush()
    await gotPush;
    expect(pushed[0]!.status).toBe('error');
  });

  test('flush 单飞：in-flight 时并发调用直接 null，事件不丢（评审 M6）', async () => {
    const llm = new MockLlm();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: LlmClient = {
      async chat(messages, opts) {
        await gate;
        return llm.chat(messages, opts);
      },
    };
    llm.push(PUSH_OK);
    const pushed: ProgressAnalysis[] = [];
    const rep = new ProgressReporter('p', slow, (a) => void pushed.push(a));
    rep.add({ role: 'assistant', text: 'x' });
    const p1 = rep.flush();
    rep.add({ role: 'assistant', text: 'y' }); // 第二批进缓冲
    const p2 = await rep.flush(); // 重入 → null
    expect(p2).toBeNull();
    release();
    expect((await p1)?.headline).toBe('测试全过');
    expect(rep.pendingCount).toBe(1); // y 还在缓冲等下轮
  });
});

describe('runningSummary 存储（评审 H4）', () => {
  test('DbSummaryStore：入库 upsert + 重开可读（重启不丢）', () => {
    const db = openDb(':memory:');
    migrate(db); // 001（projects 外键需要）
    migratePmAgent(db); // 040（pm_progress）
    db.query(
      `INSERT INTO executors (name, host, ssh_user, key_ref, workspace_root, claude_dir)
       VALUES ('e', 'h', 'root', 'k', '/w', '/c')`,
    ).run();
    db.query(`INSERT INTO users (username, token_hash, role, created_ts) VALUES ('u', 'x', 'admin', 1)`).run();
    db.query(
      `INSERT INTO projects (name, executor_id, cwd, owner_user_id, created_ts) VALUES ('p', 1, '/p', 1, 1)`,
    ).run();

    const s = new DbSummaryStore(db, 1);
    expect(s.get()).toBe(''); // 无记录兜底
    s.set('第一版摘要');
    expect(s.get()).toBe('第一版摘要');
    s.set('第二版摘要'); // upsert
    expect(new DbSummaryStore(db, 1).get()).toBe('第二版摘要'); // 新实例（模拟重启）仍可读
    db.close();
  });

  test('MemorySummaryStore 读写', () => {
    const s = new MemorySummaryStore();
    expect(s.get()).toBe('');
    s.set('x');
    expect(s.get()).toBe('x');
  });
});

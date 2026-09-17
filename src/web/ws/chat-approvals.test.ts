/**
 * 对话侧自动批准巡检测试（issue #108）：
 * - 扫描面：只扫 kind='chat'、未归档、项目 active、档位非 cautious 的对话；
 * - approve → 经 actOnMenu 相对导航注入；escalate → 一个键都不发（菜单留给网页人工点）；
 * - 同一菜单签名只分级一次；菜单消失后重置（同菜单再现视为新实例）；
 * - 会话不在（capturePane 抓不到）→ 跳过，不起会话；
 * - start/stop 生命周期：stop 后不再有新一轮巡检。
 * LLM 全 mock（铁律）。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { chatTmux } from '../../core/conversations';
import type { AutoApproveLevel } from '../../core/types';
import { UserStore } from '../../core/users';
import { migrateIssueEngine } from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { ChatApprovalWatcher, type ChatApprovalDecision } from './chat-approvals';

const MENU_YES_NO = [' Bash command\n bun test', ' ❯ 1. Yes', '   2. No'].join('\n');
const MENU_DANGER = [' Bash command\n rm -rf node_modules', ' ❯ 1. Yes', '   2. No'].join('\n');

/** 每会话一块屏；未登记的会话 = 不存在（capturePane 抛错，与 tmux 行为一致） */
class FakeDriver {
  panes = new Map<string, string>();
  keys: Array<{ session: string; key: string }> = [];
  texts: Array<{ session: string; text: string }> = [];
  async capturePane(session: string): Promise<string> {
    const p = this.panes.get(session);
    if (p === undefined) throw new Error(`can't find session: ${session}`);
    return p;
  }
  async sendKey(session: string, key: string): Promise<void> {
    this.keys.push({ session, key });
  }
  async sendKeys(session: string, text: string): Promise<void> {
    this.texts.push({ session, text });
  }
}

/** LLM 只在 medium 档被调用；这里恒 approve 第 1 项，好和本地规则区分开 */
function fakeLlm(reply = '{"action":"approve","option":1,"reason":"安全"}') {
  const calls: unknown[][] = [];
  return {
    calls,
    async chat(messages: unknown[]) {
      calls.push(messages);
      return { content: reply, toolCalls: [], raw: { role: 'assistant' as const, content: reply } };
    },
  };
}

function setup(
  convs: Array<{ id: string; level: AutoApproveLevel; kind?: 'chat' | 'issue'; archived?: boolean }>,
  llmReply?: string,
) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const { user } = new UserStore(db).create('alice');
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', '/tmp/ws', '/tmp/claude')`,
  );
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
     VALUES ('demo', 1, '/tmp/repo', ?, '目标', 1)`,
  ).run(user.id);
  for (const c of convs) {
    db.query(
      `INSERT INTO conversations (id, project_id, label, created_ts, archived, agent, kind, auto_approve)
       VALUES (?, 1, ?, 1, ?, 'claude', ?, ?)`,
    ).run(c.id, c.id, c.archived ? 1 : 0, c.kind ?? 'chat', c.level);
  }
  const driver = new FakeDriver();
  const llm = fakeLlm(llmReply);
  const decisions: ChatApprovalDecision[] = [];
  const textDecisions: Array<{ outcome: { action: string }; result?: string }> = [];
  const watcher = new ChatApprovalWatcher({
    db,
    llm,
    mutex: new KeyedMutex(),
    driverFor: () => driver,
    retryDelayMs: 1,
    tickMs: 10,
    onDecision: (d) => decisions.push(d),
    onTextDecision: (d) => textDecisions.push(d),
  });
  return { db, driver, llm, watcher, decisions, textDecisions };
}

describe('对话自动批准巡检：扫描面', () => {
  test('只扫 chat + 未归档 + 非 cautious 档的对话', () => {
    const t = setup([
      { id: 'c-medium', level: 'medium' },
      { id: 'c-auto', level: 'auto' },
      { id: 'c-cautious', level: 'cautious' },
      { id: 'c-archived', level: 'auto', archived: true },
      { id: 'c-issue-kind', level: 'auto', kind: 'issue' },
    ]);
    expect(t.watcher.listTargets().map((x) => x.convId)).toEqual(['c-auto', 'c-medium']);
    expect(t.watcher.listTargets().find((x) => x.convId === 'c-auto')?.level).toBe('auto');
  });

  test('归档项目的对话不进扫描', () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    t.db.run(`UPDATE projects SET status = 'archived' WHERE id = 1`);
    expect(t.watcher.listTargets()).toEqual([]);
  });
});

describe('对话自动批准巡检：分级与注入', () => {
  test('全自动档 + 普通弹窗 → 管家放行并注入', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    t.driver.panes.set(chatTmux('c-1'), MENU_YES_NO);

    await t.watcher.tick();

    expect(t.driver.keys.map((k) => k.key)).toEqual(['Enter']); // cursor 已在 0，直接回车
    expect(t.llm.calls.length).toBe(1);
    expect(t.decisions[0]?.outcome.rule).toBe('auto_affirm');
    expect(t.decisions[0]?.result).toBe('Yes');
  });

  test('全自动档 + 危险不可逆 → 判需人工：一个键都不发，菜单留给网页', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }], '{"action":"escalate","reason":"不可逆删除"}');
    t.driver.panes.set(chatTmux('c-1'), MENU_DANGER);

    await t.watcher.tick();

    expect(t.driver.keys).toEqual([]);
    expect(t.decisions[0]?.outcome.action).toBe('escalate');
    expect(t.decisions[0]?.outcome.rule).toBe('auto_danger');
  });

  test('中等档 → 走 LLM 分级，按它给的选项注入', async () => {
    const t = setup([{ id: 'c-1', level: 'medium' }]);
    t.driver.panes.set(chatTmux('c-1'), MENU_YES_NO);

    await t.watcher.tick();

    expect(t.llm.calls.length).toBe(1);
    expect(t.decisions[0]?.outcome.rule).toBe('llm');
    expect(t.driver.keys.map((k) => k.key)).toEqual(['Enter']); // option 1（1-based）→ 下标 0
  });

  test('同一菜单只分级一次；菜单消失后重置，再现视为新实例', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    const session = chatTmux('c-1');
    t.driver.panes.set(session, MENU_YES_NO);

    await t.watcher.tick();
    await t.watcher.tick();
    expect(t.decisions.length).toBe(1); // 第二轮同签名跳过

    t.driver.panes.set(session, '（菜单已消失，普通输出）');
    await t.watcher.tick();
    expect(t.watcher.handledSigOf(session)).toBe('');

    t.driver.panes.set(session, MENU_YES_NO);
    await t.watcher.tick();
    expect(t.decisions.length).toBe(2);
  });

  test('会话不在 → 跳过，不注入也不报错（巡检不负责起会话）', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    await t.watcher.tick();
    expect(t.decisions).toEqual([]);
    expect(t.driver.keys).toEqual([]);
  });

  test('档位调回谨慎后不再巡检，去重状态一并清掉', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    const session = chatTmux('c-1');
    t.driver.panes.set(session, MENU_YES_NO);
    await t.watcher.tick();
    expect(t.watcher.handledSigOf(session)).toBe('Yes|No');

    t.db.run(`UPDATE conversations SET auto_approve = 'cautious' WHERE id = 'c-1'`);
    await t.watcher.tick();
    expect(t.watcher.handledSigOf(session)).toBe('');
    expect(t.decisions.length).toBe(1);
  });
});

describe('对话自动批准巡检：生命周期', () => {
  test('start 定时跑、stop 后不再产生新决策（在途 tick 归还）', async () => {
    const t = setup([{ id: 'c-1', level: 'auto' }]);
    t.driver.panes.set(chatTmux('c-1'), MENU_YES_NO);

    t.watcher.start();
    t.watcher.start(); // 幂等：不叠加定时器
    await Bun.sleep(160); // 巡检周期下限 50ms（tickMs=10 被抬到 50）
    await t.watcher.stop();
    const n = t.decisions.length;
    expect(n).toBeGreaterThanOrEqual(1);

    await Bun.sleep(160);
    expect(t.decisions.length).toBe(n);
  });
});

describe('对话自动批准巡检：纯文本执行确认', () => {
  const prompt = [
    '请选择执行方式：',
    '1. 子代理分任务实施',
    '2. 当前会话直接实施',
    '回复 `2` 我就立即开始。',
  ].join('\n');

  test('全自动档经管家判定后锁内复核并发送短回复，同一提示只处理一次', async () => {
    const t = setup(
      [{ id: 'c-1', level: 'auto' }],
      '{"action":"reply","reply":"2","reason":"继续既定计划"}',
    );
    const session = chatTmux('c-1');
    t.driver.panes.set(session, prompt);
    await t.watcher.tick();
    await t.watcher.tick();
    expect(t.driver.texts).toEqual([{ session, text: '2' }]);
    expect(t.textDecisions).toHaveLength(1);
    expect(t.textDecisions[0]?.result).toBe('2');
  });

  test('管家判为需人工或档位不是全自动时不发送文本', async () => {
    const hold = setup(
      [{ id: 'c-auto', level: 'auto' }],
      '{"action":"hold","reason":"业务取舍"}',
    );
    hold.driver.panes.set(chatTmux('c-auto'), prompt);
    await hold.watcher.tick();
    expect(hold.driver.texts).toEqual([]);
    expect(hold.textDecisions[0]?.outcome.action).toBe('hold');

    const medium = setup([{ id: 'c-medium', level: 'medium' }]);
    medium.driver.panes.set(chatTmux('c-medium'), prompt);
    await medium.watcher.tick();
    expect(medium.driver.texts).toEqual([]);
    expect(medium.llm.calls).toHaveLength(0);
  });
});

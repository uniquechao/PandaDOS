/**
 * 菜单审批管道测试（V2 审批接线约定）：
 * - approve → 经 mutex 的 actOnMenu 注入（重抓核对 optionsSig）+ 审计事件；
 * - 同一菜单签名去重（decideApproval 只调一次）；
 * - escalate → explainSelection 文案 + registry 登记 + 订阅者飞书选择卡；
 * - consume：消费即焚（重放拒绝）、菜单已变 → stale 不注入；
 * - 无飞书/无绑定 → NotifyRouter 文本兜底；
 * - consumeFromCard 操作者校验（未绑定 forbidden / 订阅者放行）。
 * PM/LLM 全 mock（铁律）。
 */
import { describe, expect, test } from 'bun:test';
import { openDb } from '../../core/db';
import { migrate } from '../../core/migrate';
import { detectSelection, selectionSig } from '../../core/screen';
import type { AutoApproveLevel, Project } from '../../core/types';
import { UserStore } from '../../core/users';
import type { EngineIssue, EngineMenuCtx } from '../../issues/engine';
import { migrateIssueEngine } from '../../issues/engine';
import { KeyedMutex } from '../../issues/mutex';
import { SubscriptionStore } from '../../notify/router';
import { decideApproval, type ApprovalOutcome } from '../../agents/approval';
import type { MenuSnapshot } from '../../agents/pm';
import { ApprovalPipeline, type ApprovalPm } from './approvals';
import { actOnMenu, optionsSigOf } from './inject';

// ---------- 假件 ----------

class FakeMenuDriver {
  pane = '';
  keys: string[] = [];
  sent: string[] = [];
  async capturePane(): Promise<string> {
    return this.pane;
  }
  async sendKey(_s: string, key: string): Promise<void> {
    this.keys.push(key);
  }
  async sendKeys(_s: string, text: string): Promise<void> {
    this.sent.push(text);
  }
}

const MENU_YES_NO = [
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
].join('\n');

const MENU_OTHER = [
  ' Pick a color',
  ' ❯ 1. Red',
  '   2. Blue',
  '   3. Green',
].join('\n');

/**
 * issue #94/#95：CC 的 AskUserQuestion 菜单——每项带多行说明，末尾两项之间还夹分隔线。
 * 解析修好前只认得第 1 项：网页/卡片点第 2~5 项一律 out_of_range（等于点不到），
 * 且光标一动「唯一选项」就换一项，签名跟着变、去重失效。
 */
const ASK_MENU_PANE = [
  ' ☐ 盒子朝向',
  '',
  '盒子上到皮带、被视觉识别时，它的朝向是基本固定，还是每个盒子都会变？',
  '',
  '❯ 1. 朝向基本固定',
  '     轴对齐皮带，偏移是加在世界系 X/Y 上的常量向量，改动最小。',
  '  2. 每个盒子朝向都会变',
  '     偏移要随盒姿态旋转，得先补一层坐标变换再落地。',
  '  3. 不确定，先按固定做',
  '     先落地常量偏移，后续再按需扩展成随盒旋转。',
  '  4. Type something.',
  '──────────────────────────────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const ASK_MENU_SIG = '朝向基本固定|每个盒子朝向都会变|不确定，先按固定做|Type something.|Chat about this';

function fakeLlm(reply = '（解读）这是一个确认弹窗') {
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
  opts: { feishu?: boolean; decide?: ApprovalPm['decideApproval']; autoApprove?: AutoApproveLevel } = {},
) {
  const db = openDb(':memory:');
  migrate(db);
  migrateIssueEngine(db);
  const users = new UserStore(db);
  const { user: alice } = users.create('alice');
  db.query('UPDATE users SET feishu_openid = ? WHERE id = ?').run('ou_alice', alice.id);
  db.run(
    `INSERT INTO executors (name, host, port, ssh_user, key_ref, workspace_root, claude_dir)
     VALUES ('local', '127.0.0.1', 22, 'root', '', '/tmp/ws', '/tmp/claude')`,
  );
  db.query(
    `INSERT INTO projects (name, executor_id, cwd, owner_user_id, goal, created_ts)
     VALUES ('demo', 1, '/tmp/repo', ?, '目标', ?)`,
  ).run(alice.id, Date.now());
  const subs = new SubscriptionStore(db);
  subs.add(alice.id, 'project', 1);

  const project: Project = {
    id: 1,
    name: 'demo',
    executorId: 1,
    cwd: '/tmp/repo',
    ownerUserId: alice.id,
    pmPersona: null,
    goal: '目标',
    status: 'active',
    createdTs: 0,
    runUser: '',
    readmeSummary: null,
    workBranch: null,
    understanding: null,
    understandingAgent: null,
    understandingTs: null,
    summaryStatus: 'idle',
    summaryError: null,
    manualReview: false,
    kind: 'issue',
  };
  const issue: EngineIssue = {
    id: 7,
    projectId: 1,
    title: '装依赖',
    body: null,
    category: 'task',
    status: 'implementing',
    moduleId: null,
    convId: 'c-1',
    planJson: null,
    subtasksJson: null,
    subIndex: 0,
    targetBranch: null,
    sourceRef: null,
    branch: null,
    note: null,
    imagesJson: null,
    createdBy: null,
    createdTs: 0,
    doneTs: null,
    module: 'm',
    implMode: 'seq',
    agent: 'claude',
    pinnedTs: null,
    clarifyFeedback: null,
    resultSummary: null,
    autoApprove: opts.autoApprove ?? 'medium',
  };

  const driver = new FakeMenuDriver();
  const pm = {
    outcome: null as ApprovalOutcome | null,
    decideCalls: 0,
    /** 每次分级收到的档位（issue #108 透传断言用） */
    levels: [] as Array<AutoApproveLevel | undefined>,
    async decideApproval(
      menu: MenuSnapshot,
      task: { taskText?: string | null },
      level?: AutoApproveLevel,
    ): Promise<ApprovalOutcome> {
      pm.decideCalls++;
      pm.levels.push(level);
      // opts.decide 传真 decideApproval 时，走的是完整策略瀑布（issue #91 端到端用例）
      if (opts.decide) return opts.decide(menu, task, level);
      if (!pm.outcome) throw new Error('outcome 未设置');
      return pm.outcome;
    },
    systemPrompt: () => 'SYS',
  };
  const llm = fakeLlm();
  const cards: Array<{ openid: string; card: unknown }> = [];
  const feishu =
    opts.feishu === false
      ? null
      : {
          async sendCard(openid: string, card: unknown) {
            cards.push({ openid, card });
          },
        };
  const dispatched: Array<Record<string, unknown>> = [];
  const notify = {
    async dispatch(e: {
      kind: 'status_change'; projectId: number; issueId: number;
      summaryCode: 'approval_selection'; summaryParams: Record<string, string | number>;
    }) {
      dispatched.push(e);
    },
  };
  const logs: Array<{ issueId: number; kind: string; data?: Record<string, unknown> }> = [];

  const pipeline = new ApprovalPipeline({
    db,
    llm,
    mutex: new KeyedMutex(),
    pmFor: () => pm,
    driverFor: () => driver,
    subs,
    notify,
    feishu,
    log: (issueId, kind, data) => logs.push({ issueId, kind, ...(data ? { data } : {}) }),
    retryDelayMs: 1,
  });

  const ctx = (pane: string): EngineMenuCtx => {
    const sel = detectSelection(pane);
    if (!sel) throw new Error('测试 pane 未构成菜单');
    return { issue, project, session: 'cc-1', sel, pane };
  };

  return { db, alice, driver, pm, llm, cards, dispatched, logs, pipeline, ctx, project, issue };
}

// ---------- approve 路径 ----------

describe('审批管道：approve', () => {
  test('分级 approve → 锁内重抓核对 optionsSig → 相对导航注入 + menu_auto 审计', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'r1', action: 'approve', optionIndex: 1, reason: '安全', rule: 'llm' };

    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(t.driver.keys).toEqual(['Down', 'Enter']); // cursor 0 → 选项 1
    const log = t.logs.find((l) => l.kind === 'menu_auto');
    expect(log?.issueId).toBe(7);
    expect(log?.data?.result).toBe('injected');
    expect(log?.data?.rule).toBe('llm');
    expect(t.pipeline.handledSigOf('cc-1')).toBe(optionsSigOf(['Yes', 'No']));
  });

  test('同一菜单签名去重：第二次 onMenu 不再分级；菜单消失后重置（v1 语义）', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'r1', action: 'approve', optionIndex: 0, reason: 'ok', rule: 'trust' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));
    await t.pipeline.process(t.ctx(MENU_YES_NO));
    expect(t.pm.decideCalls).toBe(1);
    // 新菜单（签名不同）→ 重新分级
    t.driver.pane = MENU_OTHER;
    await t.pipeline.process(t.ctx(MENU_OTHER));
    expect(t.pm.decideCalls).toBe(2);
    // 菜单消失（引擎 onMenuGone）→ 同签名菜单再现视为新实例
    t.pipeline.menuGone('cc-1');
    await t.pipeline.process(t.ctx(MENU_OTHER));
    expect(t.pm.decideCalls).toBe(3);
  });

  test('issue #94/#95：AskUserQuestion 菜单里光标上下移不算新菜单（optionsSig 不含 cursorIndex）', async () => {
    // 旧解析下光标每动一格，解析出的「唯一选项」就换一项 → optionsSig 跟着变，
    // 管道会把同一个菜单反复当新菜单分级、反复给飞书发卡。选项收全后签名恒定，去重才成立。
    const first = ASK_MENU_PANE;
    const moved = ASK_MENU_PANE.replace('❯ 1. 朝向基本固定', '  1. 朝向基本固定').replace(
      '  3. 不确定，先按固定做',
      '❯ 3. 不确定，先按固定做',
    );
    expect(optionsSigOf(detectSelection(first)!.options)).toBe(optionsSigOf(detectSelection(moved)!.options));

    const t = setup();
    t.driver.pane = first;
    t.pm.outcome = { requestId: 'r-ask', action: 'escalate', reason: '业务问句交人工', rule: 'llm' };
    await t.pipeline.process(t.ctx(first));
    t.driver.pane = moved;
    await t.pipeline.process(t.ctx(moved));
    expect(t.pm.decideCalls).toBe(1); // 光标移动不触发第二次分级/第二张卡
    expect(t.cards).toHaveLength(1);
  });

  test('决定期间菜单已变（optionsSig 不符）→ 不注入、不记已处理', async () => {
    const t = setup();
    t.pm.outcome = { requestId: 'r1', action: 'approve', optionIndex: 0, reason: 'ok', rule: 'llm' };
    const ctx = t.ctx(MENU_YES_NO); // 决定基于 Yes/No
    t.driver.pane = MENU_OTHER; // 注入前重抓时菜单已变
    await t.pipeline.process(ctx);
    expect(t.driver.keys).toEqual([]); // 绝不盲注入（评审 H9）
    expect(t.pipeline.handledSigOf('cc-1')).toBe(''); // 留待新签名重走
    expect(t.logs.find((l) => l.kind === 'menu_auto')?.data?.result).toBe('stale');
  });
});

// ---------- issue #108：档位从 issue 取、透传分级、落进审计 ----------

describe('审批管道：自动批准档位（issue #108）', () => {
  test('approve 路径：issue 档位透传给分级，menu_auto 带 level', async () => {
    const t = setup({ autoApprove: 'auto' });
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'r1', action: 'approve', optionIndex: 0, reason: '本地放行', rule: 'auto_affirm' };

    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(t.pm.levels).toEqual(['auto']);
    const log = t.logs.find((l) => l.kind === 'menu_auto');
    expect(log?.data?.level).toBe('auto');
    expect(log?.data?.rule).toBe('auto_affirm');
  });

  test('escalate 路径：谨慎档透传，menu_escalated 带 level', async () => {
    const t = setup({ autoApprove: 'cautious' });
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'r2', action: 'escalate', reason: '谨慎档等人工', rule: 'cautious_hold' };

    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(t.pm.levels).toEqual(['cautious']);
    const log = t.logs.find((l) => l.kind === 'menu_escalated');
    expect(log?.data?.level).toBe('cautious');
    expect(log?.data?.rule).toBe('cautious_hold');
    expect(t.pipeline.registry.has('r2')).toBe(true); // 照常登记等人工消费
  });

  test('未改过档位的 issue 取默认 medium（历史行为不变）', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'r3', action: 'approve', optionIndex: 0, reason: '安全', rule: 'llm' };

    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(t.pm.levels).toEqual(['medium']);
    expect(t.logs.find((l) => l.kind === 'menu_auto')?.data?.level).toBe('medium');
  });
});

// ---------- issue #91：新规则端到端（真 decideApproval + 真策略，只把 LLM 假死） ----------

describe('审批管道：推荐项 / 本地兜底（issue #91）', () => {
  /** LLM 假死：模拟 llm-chat 下线那种 400（不可重试，直接抛） */
  const downLlm = {
    async chat(): Promise<never> {
      throw new Error('llm 400: model not exist');
    },
  };
  /** 真分级：菜单从 pane 解析出来，规则瀑布一层不跳 */
  const realDecide: ApprovalPm['decideApproval'] = (menu, task) =>
    decideApproval(
      downLlm as never,
      { context: menu.title || menu.raw, options: menu.options, multiSelect: menu.multiSelect },
      task,
    );

  const MENU_RESUME = [
    ' This session is 5h 36m old and 221.6k tokens.',
    ' ❯ 1. Resume from summary (recommended)',
    '   2. Resume full session as-is',
    "   3. Don't ask me again",
  ].join('\n');

  const MENU_SAFE_CMD = [
    ' Bash command',
    ' bun test src/agents',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again",
    '   3. No, tell Claude what to do differently',
  ].join('\n');

  const MENU_DANGER_CMD = [
    ' Bash command',
    ' rm -rf node_modules',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again",
    '   3. No, tell Claude what to do differently',
  ].join('\n');

  test('推荐项 → 注入推荐项 + menu_auto 落 rule=recommended（LLM 挂着也照跑）', async () => {
    const t = setup({ decide: realDecide });
    t.driver.pane = MENU_RESUME;

    await t.pipeline.process(t.ctx(MENU_RESUME));

    expect(t.driver.keys).toEqual(['Enter']); // 推荐项就是光标所在的第 0 项
    const log = t.logs.find((l) => l.kind === 'menu_auto');
    expect(log?.data?.rule).toBe('recommended');
    expect(log?.data?.option).toBe(0);
    expect(log?.data?.result).toBe('injected');
    expect(t.logs.some((l) => l.kind === 'menu_escalated')).toBe(false);
  });

  test('普通权限弹窗 + LLM 挂 → 注入「Yes」+ menu_auto 落 rule=local_fallback', async () => {
    const t = setup({ decide: realDecide });
    t.driver.pane = MENU_SAFE_CMD;

    await t.pipeline.process(t.ctx(MENU_SAFE_CMD));

    expect(t.driver.keys).toEqual(['Enter']); // 第 0 项「Yes」，不是「don't ask again」
    const log = t.logs.find((l) => l.kind === 'menu_auto');
    expect(log?.data?.rule).toBe('local_fallback');
    expect(log?.data?.option).toBe(0);
    expect(log?.data?.result).toBe('injected');
    expect(t.cards.length).toBe(0); // 不发升级卡，不打扰主人
  });

  test('危险弹窗 + LLM 挂 → 不注入任何键，仍发卡升级，menu_escalated 落 rule=llm_error', async () => {
    const t = setup({ decide: realDecide });
    t.driver.pane = MENU_DANGER_CMD;

    await t.pipeline.process(t.ctx(MENU_DANGER_CMD));

    expect(t.driver.keys).toEqual([]); // 危险操作一个键都不点
    expect(t.logs.some((l) => l.kind === 'menu_auto')).toBe(false);
    const log = t.logs.find((l) => l.kind === 'menu_escalated');
    expect(log?.data?.rule).toBe('llm_error');
    expect(t.cards.length).toBe(1); // 照常发飞书选择卡
  });
});

// ---------- escalate 路径 ----------

describe('审批管道：escalate + consume', () => {
  test('escalate → 登记 registry + 给订阅者发选择卡（explainSelection 文案）', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-x', action: 'escalate', reason: '危险', rule: 'llm' };

    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(t.pipeline.registry.size).toBe(1);
    expect(t.cards.length).toBe(1);
    expect(t.cards[0]!.openid).toBe('ou_alice');
    const cardJson = JSON.stringify(t.cards[0]!.card);
    expect(cardJson).toContain('req-x'); // 一次性 requestId 进按钮 value
    expect(cardJson).toContain('（解读）'); // explainSelection 文案
    expect(t.llm.calls.length).toBe(1); // 解读走 LLM（systemPrefix=pm.systemPrompt）
    expect(t.logs.some((l) => l.kind === 'menu_escalated')).toBe(true);
    expect(t.dispatched.length).toBe(0); // 已发卡，不再文本兜底
  });

  test('waitingIssueIds：升级后亮、consume 后灭、menuGone 清登记也灭（waiting_input 数据源）', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-w', action: 'escalate', reason: '需人工', rule: 'llm' };
    expect(t.pipeline.waitingIssueIds().size).toBe(0);

    await t.pipeline.process(t.ctx(MENU_YES_NO));
    expect([...t.pipeline.waitingIssueIds()]).toEqual([t.issue.id]);

    // consume 消费即焚 → 不再等人工
    await t.pipeline.consume('req-w', 0);
    expect(t.pipeline.waitingIssueIds().size).toBe(0);

    // 再升级一次，这回菜单自己消失（人工在终端处理了）→ menuGone 清空登记
    t.pm.outcome = { requestId: 'req-w2', action: 'escalate', reason: '需人工', rule: 'llm' };
    t.pipeline.menuGone('cc-1'); // 先重置签名，让同一菜单能再走一遍
    await t.pipeline.process(t.ctx(MENU_YES_NO));
    expect(t.pipeline.waitingIssueIds().size).toBe(1);
    t.pipeline.menuGone('cc-1');
    expect(t.pipeline.waitingIssueIds().size).toBe(0);
    expect(t.pipeline.registry.size).toBe(0); // 登记同步清掉，旧卡作废
  });

  test('consume：核对 menuSig 后注入；重放/过期拒绝', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-y', action: 'escalate', reason: '需人工', rule: 'multi_select' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));

    const r1 = await t.pipeline.consume('req-y', 1);
    expect(r1).toEqual({ ok: true, session: 'cc-1', option: 'No' });
    expect(t.driver.keys).toEqual(['Down', 'Enter']);
    expect(t.logs.find((l) => l.kind === 'menu_card_selected')?.data?.result).toBe('injected');

    const r2 = await t.pipeline.consume('req-y', 1); // 消费即焚：重放被拒
    expect(r2).toEqual({ ok: false, reason: 'expired' });
  });

  test('consume：发卡后菜单已变 → stale 不注入', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-z', action: 'escalate', reason: '需人工', rule: 'llm' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));

    t.driver.pane = MENU_OTHER; // 点击时菜单已经不是发卡时那个
    const r = await t.pipeline.consume('req-z', 0);
    expect(r).toEqual({ ok: false, reason: 'stale' });
    expect(t.driver.keys).toEqual([]);
  });

  test('consume：expectSession 不符拒绝（act/WS 传本项目会话名核对）', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-s', action: 'escalate', reason: 'x', rule: 'llm' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));
    const r = await t.pipeline.consume('req-s', 0, { expectSession: 'cc-999' });
    expect(r).toEqual({ ok: false, reason: 'stale' });
  });

  test('无飞书通道 → NotifyRouter 文本兜底', async () => {
    const t = setup({ feishu: false });
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-n', action: 'escalate', reason: 'x', rule: 'llm_error' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));
    expect(t.cards.length).toBe(0);
    expect(t.dispatched.length).toBe(1);
    expect(t.dispatched[0]).toMatchObject({
      summaryCode: 'approval_selection',
      summaryParams: { context: expect.stringContaining('proceed?') },
    });
    expect(t.pipeline.registry.size).toBe(1); // 网页仍可 consume
  });

  test('consumeFromCard：未绑定 openid → forbidden；订阅者本人放行', async () => {
    const t = setup();
    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-c', action: 'escalate', reason: 'x', rule: 'llm' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));

    expect(await t.pipeline.consumeFromCard('req-c', 0, 'ou_nobody')).toEqual({
      ok: false,
      reason: 'forbidden',
    });
    expect(t.driver.keys).toEqual([]);
    const ok = await t.pipeline.consumeFromCard('req-c', 0, 'ou_alice');
    expect(ok.ok).toBe(true);
    expect(t.driver.keys).toEqual(['Enter']); // cursor 0 → 选项 0
  });

  test('consumeFromCard：项目成员（非属主非订阅者）本人放行', async () => {
    const t = setup();
    // 新增 carol：非属主、未订阅，但绑定 openid 且是项目 1 的成员
    const carol = new UserStore(t.db).create('carol').user;
    t.db.query('UPDATE users SET feishu_openid = ? WHERE id = ?').run('ou_carol', carol.id);
    t.db.query('INSERT INTO project_members (project_id, user_id, created_ts) VALUES (1, ?, 0)').run(carol.id);

    t.driver.pane = MENU_YES_NO;
    t.pm.outcome = { requestId: 'req-m', action: 'escalate', reason: 'x', rule: 'llm' };
    await t.pipeline.process(t.ctx(MENU_YES_NO));

    const ok = await t.pipeline.consumeFromCard('req-m', 0, 'ou_carol');
    expect(ok.ok).toBe(true);
    expect(t.driver.keys).toEqual(['Enter']); // 成员放行 → 注入选项 0
  });
});

/**
 * issue #94/#95：CC 的 AskUserQuestion 菜单每项带多行说明、末尾两项之间还夹分隔线。
 * 解析修好前只认得第 1 项——网页/卡片点第 2~5 项一律 out_of_range，等于点不到。
 * 这里守住修好之后的两条：相对导航步数正确、签名口径是全量选项。
 */
describe('多行说明菜单的相对导航（actOnMenu，issue #94/#95）', () => {
  const ASK_MENU = ASK_MENU_PANE;
  const ALL_SIG = ASK_MENU_SIG;

  test('第 3 项可选中：Down×2 + Enter', async () => {
    const driver = new FakeMenuDriver();
    driver.pane = ASK_MENU;
    const sel = detectSelection(ASK_MENU)!;
    expect(sel.options).toHaveLength(5);

    const r = await actOnMenu({ driver, mutex: new KeyedMutex() }, 'cc-1', 2, { sig: selectionSig(sel) });
    expect(r).toEqual({ ok: true, option: '不确定，先按固定做' });
    expect(driver.keys).toEqual(['Down', 'Down', 'Enter']);
  });

  test('末项（分隔线之后的 Chat about this）也可选中：Down×4 + Enter', async () => {
    const driver = new FakeMenuDriver();
    driver.pane = ASK_MENU;
    const r = await actOnMenu({ driver, mutex: new KeyedMutex() }, 'cc-1', 4, { optionsSig: ALL_SIG });
    expect(r).toEqual({ ok: true, option: 'Chat about this' });
    expect(driver.keys).toEqual(['Down', 'Down', 'Down', 'Down', 'Enter']);
  });

  test('签名口径 = 全量选项：拿旧的单项签名来核对判 stale，不盲注入', async () => {
    const driver = new FakeMenuDriver();
    driver.pane = ASK_MENU;
    expect(optionsSigOf(detectSelection(ASK_MENU)!.options)).toBe(ALL_SIG);

    const r = await actOnMenu({ driver, mutex: new KeyedMutex() }, 'cc-1', 0, { optionsSig: '朝向基本固定' });
    expect(r).toEqual({ ok: false, reason: 'stale' });
    expect(driver.keys).toEqual([]);
  });
});

/**
 * agents/approval 测试 —— 审批分级矩阵（多选/trust/安全/危险四类）全 mock LLM。
 * 另覆盖：三层瀑布保序（多选/trust 不进 LLM）、裸 system（评审 M17）、
 * requestId 防重放注册表、prompt 快照（逐字，改一个字 diff 可见）。
 */
import { describe, expect, test } from 'bun:test';
import type { LlmChatOpts, LlmClient, LlmMessage, LlmResult } from './llm';
import {
  ApprovalRegistry,
  AUTOPILOT_APPROVAL_SYS,
  decideApproval,
  decideTextApproval,
  EXPLAIN_MENU_WEB_SYS,
  EXPLAIN_SELECTION_SYS,
  explainMenuForHuman,
  explainSelection,
  genRequestId,
  isMultiSelectMenu,
  MULTI_SELECT_RE,
  TRUST_RE,
  TRUST_YES_RE,
  textApprovalCandidate,
} from './approval';
import { isDangerousMenu, isNeverPick, pickRecommended, pickSafeAffirmative } from './approval-policy';

/** mock LLM：记录调用、按脚本吐回复 */
class MockLlm implements LlmClient {
  calls: Array<{ messages: LlmMessage[]; opts?: LlmChatOpts }> = [];
  constructor(private script: Array<string | Error> = []) {}
  async chat(messages: LlmMessage[], opts?: LlmChatOpts): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    const content = next ?? '';
    return { content, toolCalls: [], raw: { role: 'assistant', content } };
  }
}

const plainMenu = { context: 'Bash command: bun test — Do you want to proceed?', options: ['Yes', 'No'] };

describe('纯文本执行确认分级', () => {
  const pane = [
    '请选择执行方式：',
    '1. 子代理分任务实施',
    '2. 当前会话直接实施',
    '回复 `2` 我就立即开始。',
  ].join('\n');

  test('候选门禁只接明确要求回复的尾部提问', () => {
    expect(textApprovalCandidate(pane)).toContain('当前会话直接实施');
    expect(textApprovalCandidate('正在读取代码并运行测试')).toBeNull();
  });

  test('管家明确判为安全继续时返回短回复', async () => {
    const llm = new MockLlm(['{"action":"reply","reply":"2","reason":"继续既定计划"}']);
    await expect(decideTextApproval(llm, { pane, goal: '尽快更新服务' })).resolves.toEqual({
      action: 'reply', reply: '2', reason: '继续既定计划',
    });
  });

  test('业务取舍、模型失败或多行回复一律保留给人工', async () => {
    const hold = await decideTextApproval(
      new MockLlm(['{"action":"hold","reason":"属于架构选择"}']),
      { pane },
    );
    expect(hold).toEqual({ action: 'hold', reason: '属于架构选择' });
    expect((await decideTextApproval(new MockLlm([new Error('down')]), { pane })).action).toBe('hold');
    expect((await decideTextApproval(
      new MockLlm(['{"action":"reply","reply":"2\\nrm -rf /","reason":"坏回复"}']),
      { pane },
    )).action).toBe('hold');
  });
});

describe('审批分级矩阵', () => {
  test('① 多选表单 → 无条件升级人工，LLM 不被调用', async () => {
    const llm = new MockLlm();
    const cases = [
      { context: 'Select files [x] a.ts [ ] b.ts', options: ['a', 'b'] },
      { context: 'Press space to toggle selection', options: ['x', 'y'] },
      { context: 'choose', options: ['[ ] 选项一', '继续'] }, // 选项以 [ 开头
    ];
    for (const menu of cases) {
      const r = await decideApproval(llm, menu);
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('multi_select');
    }
    // 上游已判 multiSelect 的直传也生效
    const r = await decideApproval(llm, { ...plainMenu, multiSelect: true });
    expect(r.rule).toBe('multi_select');
    expect(llm.calls.length).toBe(0); // 三层瀑布保序：多选永不进 LLM（评审 5.3#4）
  });

  test('② trust 弹窗 → 直接同意（选中 yes 项），LLM 不被调用', async () => {
    const llm = new MockLlm();
    const r = await decideApproval(llm, {
      context: 'Do you trust the files in this folder?',
      options: ['Yes, proceed', 'No, exit'],
    });
    expect(r.action).toBe('approve');
    expect(r.action === 'approve' && r.optionIndex).toBe(0);
    expect(r.rule).toBe('trust');
    expect(llm.calls.length).toBe(0);
  });

  test('② trust 但无 yes 项 → 落回 LLM 分级（v1 无 return 语义）', async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"看不懂"}']);
    const r = await decideApproval(llm, {
      context: '是否信任此目录',
      options: ['继续', '退出'], // 无 yes/trust/信任/是
    });
    expect(llm.calls.length).toBe(1);
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('llm');
  });

  test('③ 安全操作 → LLM approve + 选项编号（1 起）转 0-based', async () => {
    const llm = new MockLlm(['{"action":"approve","option":2,"reason":"跑测试安全"}']);
    const r = await decideApproval(llm, plainMenu, { goal: '做导出', taskText: '加 CSV 导出' });
    expect(r.action).toBe('approve');
    expect(r.action === 'approve' && r.optionIndex).toBe(1);
    expect(r.rule).toBe('llm');
    expect(r.reason).toBe('跑测试安全');
    // 裸 system（评审 M17：不拼 persona/memory）+ jsonMode + user 模板（v1 agent.ts:643）
    const call = llm.calls[0]!;
    expect(call.messages[0]!.content).toStartWith(AUTOPILOT_APPROVAL_SYS);
    expect(call.messages[0]!.content).toContain('zh-Hans');
    expect(call.opts?.jsonMode).toBe(true);
    expect(call.messages[1]!.content).toContain('总目标：做导出');
    expect(call.messages[1]!.content).toContain('当前任务：加 CSV 导出');
    expect(call.messages[1]!.content).toContain('1. Yes\n2. No');
  });

  test('④ 危险操作 → LLM escalate 带理由', async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"要 force push"}']);
    const r = await decideApproval(llm, plainMenu);
    expect(r.action).toBe('escalate');
    expect(r.reason).toBe('要 force push');
    expect(r.rule).toBe('llm');
  });

  test('LLM 越界/非整数选项 → escalate（不盲点）', async () => {
    for (const raw of [
      '{"action":"approve","option":5}',
      '{"action":"approve","option":0}',
      '{"action":"approve","option":1.5}',
      '{"action":"approve"}',
    ]) {
      const llm = new MockLlm([raw]);
      const r = await decideApproval(llm, plainMenu);
      expect(r.action).toBe('escalate');
    }
  });

  test('jsonMode 解析失败 / LLM 抛错 → 本地兜底：普通弹窗放行（local_fallback）', async () => {
    // issue #91：原先无条件升级人工，驱动大模型 一挂全自动流就瘫。现在普通操作本地放行。
    const bad = new MockLlm(['这不是 JSON']);
    const r1 = await decideApproval(bad, plainMenu);
    expect(r1.action).toBe('approve');
    expect(r1.action === 'approve' && r1.optionIndex).toBe(0);
    expect(r1.rule).toBe('local_fallback');

    const boom = new MockLlm([new Error('llm 500')]);
    const r2 = await decideApproval(boom, plainMenu);
    expect(r2.action).toBe('approve');
    expect(r2.rule).toBe('local_fallback');
  });

  test('LLM 抛错 + 危险操作 → 仍升级人工，保留 rule llm_error', async () => {
    const boom = () => new MockLlm([new Error('llm 500')]);
    const r = await decideApproval(boom(), {
      context: 'Bash command: rm -rf node_modules — Do you want to proceed?',
      options: ['Yes', 'No'],
    });
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('llm_error');

    // 不是权限弹窗（没有明确同意项）→ 也交人工，不瞎点第 0 项
    const r2 = await decideApproval(boom(), {
      context: '选一个实现方案',
      options: ['方案 A', '方案 B'],
    });
    expect(r2.action).toBe('escalate');
    expect(r2.rule).toBe('llm_error');
  });

  test('goal/taskText 缺省渲染为 (未设)', async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"x"}']);
    await decideApproval(llm, plainMenu);
    expect(llm.calls[0]!.messages[1]!.content).toContain('总目标：(未设)');
    expect(llm.calls[0]!.messages[1]!.content).toContain('当前任务：(未设)');
  });
});

describe('requestId 防重放', () => {
  test('每次分级产出唯一 requestId', async () => {
    const llm = new MockLlm(['{"action":"escalate"}', '{"action":"escalate"}']);
    const a = await decideApproval(llm, plainMenu);
    const b = await decideApproval(llm, plainMenu);
    expect(a.requestId).toBeTruthy();
    expect(a.requestId).not.toBe(b.requestId);
    expect(new Set([genRequestId(), genRequestId(), genRequestId()]).size).toBe(3);
  });

  test('ApprovalRegistry 消费即焚：第二次同 id 拿不到（防重放）', async () => {
    const reg = new ApprovalRegistry();
    const llm = new MockLlm(['{"action":"escalate","reason":"x"}']);
    const out = await decideApproval(llm, plainMenu);
    reg.register(out, 'cc-7', 'Yes|No@0');
    const hit = reg.consume(out.requestId);
    expect(hit?.outcome.requestId).toBe(out.requestId);
    expect(hit?.session).toBe('cc-7');
    expect(hit?.menuSig).toBe('Yes|No@0');
    expect(reg.consume(out.requestId)).toBeNull(); // 一次性
    expect(reg.consume('不存在')).toBeNull();
  });

  test('过期条目自动清（TTL，时钟注入）', () => {
    let now = 1000;
    const reg = new ApprovalRegistry(100, () => now);
    const out = { requestId: 'r1', action: 'escalate' as const, reason: 'x', rule: 'llm' as const };
    reg.register(out, 's', 'sig');
    now += 200; // 超 TTL
    expect(reg.consume('r1')).toBeNull();
    expect(reg.size).toBe(0);
  });
});

describe('选项解读（升级人工时的通知卡摘要）', () => {
  test('LLM 成功 → trim 后的内容；systemPrefix 拼在解读 prompt 前', async () => {
    const llm = new MockLlm(['  CC 在问要不要跑测试，建议选 1。\n1. Yes\n2. No  ']);
    const r = await explainSelection(llm, {
      label: 'proj',
      context: 'run tests?',
      options: ['Yes', 'No'],
      progress: '正在写导出',
      systemPrefix: 'PERSONA',
    });
    expect(r).toContain('建议选 1');
    const sys = llm.calls[0]!.messages[0]!.content!;
    expect(sys.startsWith('PERSONA\n\n')).toBe(true);
    expect(sys).toContain(EXPLAIN_SELECTION_SYS);
    expect(llm.calls[0]!.messages[1]!.content).toContain('会话进度：正在写导出');
  });

  test('LLM 失败/空回复 → 回落裸 context+options（v1 fallback）', async () => {
    for (const llm of [new MockLlm([new Error('down')]), new MockLlm([' '])]) {
      const r = await explainSelection(llm, { label: 'p', context: 'ctx', options: ['A', 'B'] });
      expect(r).toContain('ctx');
      expect(r).toContain('**选项：**');
      expect(r).toContain('1. A\n2. B');
    }
  });
});

describe('网页菜单解读（issue #112「解释一下」）', () => {
  test('LLM 成功 → trim 后的文案；systemPrefix 拼在网页版 prompt 前；上下文与选项进 user', async () => {
    const llm = new MockLlm(['  这一步要跑 build-ui 并看 git 状态，只读不动数据，建议选 1。  ']);
    const r = await explainMenuForHuman(llm, {
      label: 'panda',
      context: 'Bash command: bun run build-ui — Do you want to proceed?',
      options: ['Yes', "Yes, and don't ask again", 'No'],
      systemPrefix: 'PERSONA',
    });
    expect(r).toBe('这一步要跑 build-ui 并看 git 状态，只读不动数据，建议选 1。');

    const sys = llm.calls[0]!.messages[0]!.content!;
    expect(sys.startsWith('PERSONA\n\n')).toBe(true);
    expect(sys).toContain(EXPLAIN_MENU_WEB_SYS);
    const user = llm.calls[0]!.messages[1]!.content!;
    expect(user).toContain('会话 @panda');
    expect(user).toContain('build-ui');
    expect(user).toContain("1. Yes\n2. Yes, and don't ask again\n3. No");
    expect(user).not.toContain('多选表单'); // 单选不提多选语义
  });

  test('多选表单：user 里点明「勾选≠提交」', async () => {
    const llm = new MockLlm(['ok']);
    await explainMenuForHuman(llm, {
      label: 'p',
      context: 'Select files',
      options: ['a', 'b'],
      multiSelect: true,
    });
    expect(llm.calls[0]!.messages[1]!.content).toContain('多选表单');
  });

  test('LLM 抛错/空回复 → null（绝不回落成 context+选项原文：网页上那等于没解释）', async () => {
    for (const llm of [new MockLlm([new Error('down')]), new MockLlm([' \n ']), new MockLlm([])]) {
      const r = await explainMenuForHuman(llm, { label: 'p', context: 'ctx', options: ['A', 'B'] });
      expect(r).toBeNull();
    }
  });

  test('网页版 prompt 与飞书卡那份不是同一份：不重列选项、不用 lark_md', () => {
    expect(EXPLAIN_MENU_WEB_SYS).not.toBe(EXPLAIN_SELECTION_SYS);
    expect(EXPLAIN_MENU_WEB_SYS).toContain('不要重复罗列选项');
    expect(EXPLAIN_MENU_WEB_SYS).toContain('不要飞书 lark_md 语法');
    expect(EXPLAIN_MENU_WEB_SYS).toContain('不可逆');
    expect(EXPLAIN_MENU_WEB_SYS).toContain('建议选第几项');
  });
});

describe('推荐项层（issue #91，第 3 层：排在多选/trust 之后、LLM 之前）', () => {
  /** 截图原样：claude 的长会话恢复弹窗 */
  const RESUME = ['Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again"];

  test('英文 (recommended) → 自动选推荐项，LLM 不被调用', async () => {
    const llm = new MockLlm();
    const r = await decideApproval(llm, {
      context: 'This session is 5h 36m old and 221.6k tokens.',
      options: RESUME,
    });
    expect(r.action).toBe('approve');
    expect(r.action === 'approve' && r.optionIndex).toBe(0);
    expect(r.rule).toBe('recommended');
    expect(llm.calls.length).toBe(0);
  });

  test('中文（推荐）/方括号 [recommended] 同样识别；推荐项不在首位也能选中', async () => {
    const llm = new MockLlm();
    const zh = await decideApproval(llm, { context: '如何处理已有配置', options: ['全部覆盖', '保留现有配置（推荐）'] });
    expect(zh.action === 'approve' && zh.optionIndex).toBe(1);
    expect(zh.rule).toBe('recommended');

    const br = await decideApproval(llm, { context: 'continue?', options: ['Stop', 'Keep going [recommended]'] });
    expect(br.action === 'approve' && br.optionIndex).toBe(1);
    expect(br.rule).toBe('recommended');
    expect(llm.calls.length).toBe(0);
  });

  test('裸「推荐」二字不算标记 → 落回 LLM（否则「不推荐这么做」会被点中）', async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"拿不准"}']);
    const r = await decideApproval(llm, { context: '选择做法', options: ['这样做不推荐', '换个做法'] });
    expect(llm.calls.length).toBe(1);
    expect(r.rule).toBe('llm');
  });

  test('多选表单里的推荐标记不生效（多选永远人工，保序）', async () => {
    const llm = new MockLlm();
    const r = await decideApproval(llm, {
      context: 'Select files [x] a.ts [ ] b.ts',
      options: ['Keep both (recommended)', 'Drop one'],
    });
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('multi_select');
    expect(llm.calls.length).toBe(0);
  });

  test('trust 层优先于推荐层：两者都命中时按 trust 选同意项', async () => {
    const llm = new MockLlm();
    const r = await decideApproval(llm, {
      context: 'Do you trust the files in this folder?',
      options: ['Continue (recommended)', 'Yes, trust this folder'],
    });
    expect(r.rule).toBe('trust');
    expect(r.action === 'approve' && r.optionIndex).toBe(1); // trust 的 yes 项，不是推荐项
    expect(llm.calls.length).toBe(0);
  });

  test("推荐项恰是 don't ask again → 不自动点，落回 LLM（横切禁令压过推荐）", async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"交人工"}']);
    const r = await decideApproval(llm, {
      context: 'session too long',
      options: ["Don't ask me again (recommended)", 'Resume'],
    });
    expect(llm.calls.length).toBe(1);
    expect(r.rule).toBe('llm');
  });
});

describe('本地兜底分级（issue #91，LLM 不可用时）', () => {
  const boom = () => new MockLlm([new Error('llm 400: model not exist')]);
  /** claude 权限弹窗的真实三选项 */
  const CC = ['Yes', "Yes, and don't ask again", 'No, tell Claude what to do differently'];

  test('安全样本（跑测试/改文件/git commit/普通 push/装依赖）→ local_fallback 选「Yes」', async () => {
    const safe = [
      'Bash command\nbun test src/agents\nRun agents test suite',
      'Edit file\nsrc/agents/approval.ts\nDo you want to make this edit?',
      'Write file\ndocs/notes.md\nDo you want to create this file?',
      'Bash command\ngit commit -m "fix: 修复分级"',
      'Bash command\ngit push origin feat/screenshot-preview',
      'Bash command\nbun add zod',
    ];
    for (const context of safe) {
      const r = await decideApproval(boom(), { context, options: CC });
      expect(r.action).toBe('approve');
      expect(r.rule).toBe('local_fallback');
      expect(r.action === 'approve' && r.optionIndex).toBe(0); // 「Yes」，不是「Yes, and don't ask again」
    }
  });

  test('危险样本 → 仍升级人工，rule 保持 llm_error', async () => {
    const danger = [
      'Bash command\nrm -rf node_modules',
      'Bash command\ngit push --force origin main',
      'Bash command\ngit reset --hard HEAD~3',
      'Bash command\nsqlite3 panda.db "DROP TABLE issues;"',
      'Bash command\nsystemctl restart panda',
      'Bash command\nsudo chown -R root /etc',
      'Edit file\n/root/.panda/env\nUpdate PANDA_LLM_API_KEY',
      'Bash command\n./deploy.sh prod',
    ];
    for (const context of danger) {
      const r = await decideApproval(boom(), { context, options: CC });
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('llm_error');
    }
  });

  test('绝不选 don\'t ask again / Allow always：同意项被排除时宁可升级', async () => {
    // 「Yes」在后面也照样跳过前面的 don't-ask-again，证明靠的是禁令而非「取第 0 项」
    const r1 = await decideApproval(boom(), {
      context: 'Bash command\nbun test',
      options: ["Yes, and don't ask again", 'Yes', 'No'],
    });
    expect(r1.action === 'approve' && r1.optionIndex).toBe(1);
    expect(r1.rule).toBe('local_fallback');

    for (const options of [["Yes, and don't ask again", 'No'], ['Allow always', 'Deny']]) {
      const r = await decideApproval(boom(), { context: 'Bash command\nbun test', options });
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('llm_error');
    }
  });

  test('不是权限弹窗（无明确同意项）→ 升级，绝不退化到第 0 项', async () => {
    const r = await decideApproval(boom(), { context: '选一个实现方案', options: ['方案 A', '方案 B'] });
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('llm_error');
  });

  test('兜底只在 LLM 不可用时生效：LLM 正常判 escalate 时不接管（rule 仍是 llm）', async () => {
    const llm = new MockLlm(['{"action":"escalate","reason":"超出任务范围"}']);
    const r = await decideApproval(llm, { context: 'Bash command\nbun test', options: CC });
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('llm');
  });
});

describe('自动批准档位（issue #108）', () => {
  /** claude 权限弹窗的真实三选项 */
  const CC = ['Yes', "Yes, and don't ask again", 'No, tell Claude what to do differently'];
  const bash = (cmd: string): { context: string; options: string[] } => ({
    context: `Bash command\n${cmd}`,
    options: CC,
  });

  test('缺省档 = medium：不传 level 时行为与加档位之前一致（走 LLM 分级）', async () => {
    const llm = new MockLlm(['{"action":"approve","option":1,"reason":"只读命令"}']);
    const r = await decideApproval(llm, bash('bun test'));
    expect(r.rule).toBe('llm');
    expect(llm.calls.length).toBe(1);
  });

  test('谨慎档：普通权限弹窗一律转人工，LLM 不被调用', async () => {
    const llm = new MockLlm(['{"action":"approve","option":1,"reason":"安全"}']);
    for (const menu of [bash('bun test'), bash('git commit -m "x"'), bash('rm -rf node_modules')]) {
      const r = await decideApproval(llm, menu, {}, 'cautious');
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('cautious_hold');
    }
    expect(llm.calls.length).toBe(0);
  });

  test('谨慎档仍自动点零风险两层：trust 弹窗与 CLI 推荐项', async () => {
    const llm = new MockLlm();
    const t = await decideApproval(
      llm,
      { context: 'Do you trust the files in this folder?', options: ['Yes, proceed', 'No, exit'] },
      {},
      'cautious',
    );
    expect(t.action).toBe('approve');
    expect(t.rule).toBe('trust');

    const rec = await decideApproval(
      llm,
      { context: 'Continue this session?', options: ['Start fresh', 'Resume from summary (recommended)'] },
      {},
      'cautious',
    );
    expect(rec.action === 'approve' && rec.optionIndex).toBe(1);
    expect(rec.rule).toBe('recommended');
    expect(llm.calls.length).toBe(0);
  });

  test('全自动档：普通弹窗由管家按语义放行（选「Yes」而非 don\'t ask again）', async () => {
    const llm = new MockLlm(Array(4).fill('{"action":"approve","option":1,"reason":"安全可推进"}'));
    for (const cmd of ['bun test', 'git commit -m "fix"', 'git push origin feat/x', 'bun add zod']) {
      const r = await decideApproval(llm, bash(cmd), {}, 'auto');
      expect(r.action).toBe('approve');
      expect(r.rule).toBe('auto_affirm');
      expect(r.action === 'approve' && r.optionIndex).toBe(0);
    }
    expect(llm.calls.length).toBe(4);
  });

  test('全自动档：管家识别危险不可逆并转人工（rule auto_danger）', async () => {
    const danger = [
      'rm -rf node_modules',
      'git push --force origin main',
      'git reset --hard HEAD~3',
      'sqlite3 panda.db "DROP TABLE issues;"',
      'systemctl restart panda',
      './deploy.sh prod',
    ];
    const llm = new MockLlm(Array(danger.length + 1).fill('{"action":"escalate","reason":"不可逆操作"}'));
    for (const cmd of danger) {
      const r = await decideApproval(llm, bash(cmd), {}, 'auto');
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('auto_danger');
    }
    // 改生产密钥这类非 Bash 弹窗同样拦住
    const env = await decideApproval(
      llm,
      { context: 'Edit file\n/root/.panda/env\nUpdate PANDA_LLM_API_KEY', options: CC },
      {},
      'auto',
    );
    expect(env.rule).toBe('auto_danger');
    expect(llm.calls.length).toBe(danger.length + 1);
  });

  test('全自动档：临时目录清理、production build 与正文 submit 不再被关键词拦截', async () => {
    const llm = new MockLlm(Array(4).fill('{"action":"approve","option":1,"reason":"安全且在范围内"}'));
    for (const cmd of [
      'rm -rf /tmp/panda-build',
      'rm -f .panda/tmp/result/34/stale',
      'bun run production build',
      'bun test submit-handler.test.ts',
    ]) {
      const r = await decideApproval(llm, bash(cmd), {}, 'auto');
      expect(r.action).toBe('approve');
      expect(r.rule).toBe('auto_affirm');
    }
  });

  test('全自动档：管家不可用时只豁免简单临时目录清理，其他删除继续转人工', async () => {
    const down = () => new MockLlm([new Error('down')]);
    for (const cmd of ['rm -rf /tmp/panda-build', 'rm -f .panda/tmp/cache/file']) {
      const r = await decideApproval(down(), bash(cmd), {}, 'auto');
      expect(r.action).toBe('approve');
      expect(r.rule).toBe('auto_affirm');
    }
    for (const cmd of ['rm -rf src', 'rm -rf /tmp/cache /etc/panda', 'rm -rf /tmp/cache && deploy']) {
      const r = await decideApproval(down(), bash(cmd), {}, 'auto');
      expect(r.action).toBe('escalate');
      expect(r.rule).toBe('auto_danger');
    }
  });

  test('全自动档：无明确同意项（选择题）→ 交人工，绝不退化到第 0 项', async () => {
    const r = await decideApproval(new MockLlm(), { context: '选一个实现方案', options: ['方案 A', '方案 B'] }, {}, 'auto');
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('auto_danger');
  });

  test('全自动档：即使管家误选永久授权项也拒绝注入', async () => {
    const r = await decideApproval(
      new MockLlm(['{"action":"approve","option":2,"reason":"误选"}']),
      bash('bun test'),
      {},
      'auto',
    );
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('auto_danger');
  });

  test('多选表单：三档都在第 1 层转人工（档位不越过铁律）', async () => {
    const menu = { context: 'Select files [x] a.ts [ ] b.ts', options: ['a', 'b'] };
    for (const level of ['cautious', 'medium', 'auto'] as const) {
      const r = await decideApproval(new MockLlm(), menu, {}, level);
      expect(r.rule).toBe('multi_select');
    }
  });
});

describe('prompt/正则快照（v1 逐字平移，改一个字都要 diff 可见）', () => {
  test('AUTOPILOT_APPROVAL_SYS 明确按完整语义分级及临时目录例外', () => {
    expect(AUTOPILOT_APPROVAL_SYS).toBe(`# 任务：autopilot 智能分级批复
Claude Code 弹出了一个选择/审批菜单。替主人判断：自动批准并选某项，还是升级给主人人工决定。只输出 JSON：
{"action":"approve"|"escalate","option":选项编号(从1起,approve时必填),"reason":"≤20字中文理由"}

# 规则（拿不准一律 escalate）
- approve（安全·可逆·在任务范围内）：读文件/浏览、跑测试或 production build、普通代码编辑、新建文件/目录、清理 /tmp 或项目 .panda/tmp 内临时文件、git add/commit/普通 push（非 force、不改历史）、装任务明确需要的依赖、确认计划继续。按完整语义判断，不得因命令正文恰含 submit、production 等单词升级。选最能推进【当前任务】的那项。
- escalate（危险·不可逆·超范围）：删除非临时文件或数据(drop/truncate)、git reset --hard / force push / 改历史、实际部署/发布/上线、改生产配置或密钥、对外改外部状态（普通 git push 除外）、关机/重启、与当前任务无关的操作、任何看不懂或拿不准的。
- 宁可 escalate，也别误批。`);

    // 管家语义契约：明确临时目录例外，同时保留不可逆操作边界
    expect(AUTOPILOT_APPROVAL_SYS).toContain('git add/commit/普通 push');
    for (const kw of ['.panda/tmp', 'force push', '实际部署/发布/上线', '改生产配置或密钥']) {
      expect(AUTOPILOT_APPROVAL_SYS).toContain(kw);
    }
  });

  test('EXPLAIN_SELECTION_SYS 逐字（v1 agent.ts:124-125）', () => {
    expect(EXPLAIN_SELECTION_SYS).toBe(
      `# 任务：说清 CC 在让主人选什么\n2-3 行中文说清在问什么、各选项含义、你的建议（结合会话进度）。飞书 lark_md，结尾原样列出全部编号选项。`,
    );
  });

  test('硬性正则逐字（v1 agent.ts:627/632-633）', () => {
    expect(MULTI_SELECT_RE.source).toBe(/\[[ x✔✓]\]|[☒☐]|space to (toggle|select)/i.source);
    expect(MULTI_SELECT_RE.flags).toBe('i');
    expect(TRUST_RE.source).toBe(/trust|信任/.source);
    expect(TRUST_YES_RE.source).toBe(/yes|trust|信任|是/i.source);
    expect(TRUST_YES_RE.flags).toBe('i');
  });

  test('isMultiSelectMenu 双条件（正则 + 选项以 [ 开头）', () => {
    expect(isMultiSelectMenu('normal question', ['Yes', 'No'])).toBe(false);
    expect(isMultiSelectMenu('has [x] checkbox', ['a'])).toBe(true);
    expect(isMultiSelectMenu('q', ['[ ] item'])).toBe(true);
    expect(isMultiSelectMenu('command: submit release notes', ['Yes', 'No'])).toBe(false);
  });

  test('issue #94/#95 回归：AskUserQuestion（☐ 表头）选项变全后仍判为交互表单 → 升级人工', () => {
    // 解析修好后，CC 问业务问题的菜单会带全 5 个选项进审批管道。安全底线不能变：
    // context 里的 ☐ 表头命中 multiSelect → 永远升级给人，绝不代主人自动点。
    const context = '☐ 盒子朝向\n盒子上到皮带、被视觉识别时，它的朝向是基本固定还是会变？';
    const options = ['朝向基本固定', '每个盒子朝向都会变', '不确定，先按固定做', 'Type something.', 'Chat about this'];
    expect(isMultiSelectMenu(context, options)).toBe(true);
  });

  test('issue #94/#95 回归：业务问句选项变全后，本地兜底层仍认不出可自动选的项 → 交人工', () => {
    // 关键安全性质：解析修好后这类菜单会带 5 个选项进策略层，但既没有 (recommended)
    // 标记、也没有以肯定词开头的项 → recommended/affirm 都必须返回 -1，落回人工。
    const options = ['朝向基本固定', '每个盒子朝向都会变', '不确定，先按固定做', 'Type something.', 'Chat about this'];
    expect(pickRecommended(options)).toBe(-1);
    expect(pickSafeAffirmative(options)).toBe(-1);
    // 危险大类照旧命中即交人工（选项多寡不影响判据）
    expect(isDangerousMenu('☐ 要不要顺手清空生产库？', options)).toBe(true);
  });

  test('issue #94/#95 回归：Resume 菜单全量选项下 recommended 命中首项、neverPick 挡住「不再询问」', () => {
    const options = ['Resume from summary (recommended)', 'Resume full session as-is', "Don't ask me again"];
    expect(pickRecommended(options)).toBe(0);
    expect(isNeverPick(options[2]!)).toBe(true);
    expect(isNeverPick(options[0]!)).toBe(false);
  });
});

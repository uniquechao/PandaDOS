/**
 * agents/pm 测试 —— PM 管家全 mock LLM/Driver。
 * 覆盖：systemPrompt 组装顺序（钦定四段）、judgeDone 保守判定（裸 system + 解析降级）、
 * clarifying 提问生成、审批委托、阶段 prompt 编排、进度摘要、问答工具循环（5 轮上限）、
 * 管家池工厂（Map<projectId> 复用 + project 快照刷新）、040 迁移幂等、EnginePm 结构兼容。
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db';
import type { EnginePm } from '../issues/engine';
import { KeyedMutex } from '../issues/mutex';
import type { Issue, IssueEvent, Project, ProjectModule } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import type { LlmChatOpts, LlmClient, LlmMessage, LlmResult, LlmToolCall } from './llm';
import {
  CLARIFYING_SYS,
  createPmPool,
  DEFAULT_GLOBAL_PERSONA,
  JUDGE_DONE_SYS,
  loadGlobalPersona,
  MERGE_SYS,
  MODULE_SUGGEST_SYS,
  menuFromSelection,
  migratePmAgent,
  PmAgent,
  type PmAgentDeps,
} from './pm';

// ---------- mock 件 ----------

type Scripted = string | Error | { content: string; toolCalls: LlmToolCall[] };

class MockLlm implements LlmClient {
  calls: Array<{ messages: LlmMessage[]; opts?: LlmChatOpts }> = [];
  constructor(private script: Scripted[] = []) {}
  push(...items: Scripted[]): void {
    this.script.push(...items);
  }
  async chat(messages: LlmMessage[], opts?: LlmChatOpts): Promise<LlmResult> {
    this.calls.push({ messages, opts });
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object') {
      return {
        content: next.content,
        toolCalls: next.toolCalls,
        raw: { role: 'assistant', content: next.content, tool_calls: next.toolCalls },
      };
    }
    const content = next ?? '';
    return { content, toolCalls: [], raw: { role: 'assistant', content } };
  }
}

const noopDriver = {
  findExecutable: async () => null,
  listSessions: async () => [{ name: 'cc-7', createdTs: 0, attached: false }],
  createSession: async () => {},
  killSession: async () => {},
  sendKeys: async () => {},
  sendKey: async () => {},
  capturePane: async () => '',
  resizeWindow: async () => {},
  readFileRange: async () => ({ data: new Uint8Array(), size: 0 }),
  statPath: async () => null,
  listDir: async () => [],
  writeFile: async () => {},
  symlink: async () => {},
  readlink: async () => null,
  removeTree: async () => {},
  mkdirp: async () => {},
  movePath: async () => {},
  git: async () => ({ code: 0, out: '', err: '' }),
  openPty: async () => {
    throw new Error('nope');
  },
} satisfies ExecutorDriver;

function project(over: Partial<Project> = {}): Project {
  return {
    id: 7,
    name: '导出模块',
    executorId: 1,
    cwd: '/repo/export',
    ownerUserId: 3,
    pmPersona: null,
    goal: null,
    status: 'active',
    createdTs: 1,
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
    ...over,
  };
}

function issue(over: Partial<Issue> = {}): Issue {
  return {
    id: 42,
    projectId: 7,
    title: '加导出功能',
    body: '支持 CSV',
    category: 'task',
    status: 'pending',
    moduleId: null,
    convId: null,
    planJson: null,
    subtasksJson: null,
    subIndex: 0,
    branch: null,
    note: null,
    imagesJson: null,
    createdBy: 3,
    createdTs: 1,
    doneTs: null,
    ...over,
  };
}

function module(over: Partial<ProjectModule> = {}): ProjectModule {
  return {
    id: 9,
    projectId: 7,
    slug: 'export-tools',
    displayName: 'Export Tools',
    agent: 'claude',
    source: 'auto',
    status: 'active',
    conversationId: null,
    syncStatus: 'ready',
    syncError: null,
    createdBy: 3,
    createdTs: 1,
    lastUsedTs: null,
    ...over,
  };
}

function makeDeps(
  llm: MockLlm,
  over: Partial<PmAgentDeps> = {},
): PmAgentDeps {
  return {
    driver: noopDriver,
    llm,
    users: {
      getSettings: (uid) =>
        uid === 3 ? { persona: '爱用 emoji', memory: '主人喜欢简短回复' } : { persona: null, memory: null
},
      byId: (id) => (id === 3 ? { username: 'alice' } : undefined),
    },
    convs: {
      listByProject: () => [
        { id: 'conv-a', projectId: 7, label: '导出功能', createdTs: 1, archived: false, agent: 'claude' as const, kind: 'issue' as const, lastActiveTs: null, autoApprove: 'cautious' as const },
      ],
      currentConv: () => 'conv-a',
      tmuxName: (pid) => `cc-${pid}`,
    },
    locator: { locate: async () => null },
    mutex: new KeyedMutex(),
    globalPersona: 'GLOBAL-PERSONA',
    ...over,
  };
}

// ---------- systemPrompt ----------

describe('systemPrompt 组装（顺序钦定：全局 → pm_persona → 属主 persona → 属主 memory）', () => {
  test('四段齐全时顺序正确，标题沿用 v1（# 用户附加设定 / # 记忆）', () => {
    const pm = new PmAgent(project({ pmPersona: '盯紧测试覆盖率' }), makeDeps(new MockLlm()));
    const s = pm.systemPrompt();
    const iGlobal = s.indexOf('GLOBAL-PERSONA');
    const iPm = s.indexOf('# 项目 PM 设定\n盯紧测试覆盖率');
    const iPersona = s.indexOf('# 用户附加设定\n爱用 emoji');
    const iMem = s.indexOf('# 记忆\n主人喜欢简短回复');
    expect(iGlobal).toBe(0);
    expect(iPm).toBeGreaterThan(iGlobal);
    expect(iPersona).toBeGreaterThan(iPm);
    expect(iMem).toBeGreaterThan(iPersona);
  });

  test('属主按 project.owner_user_id 取（不再 pane cwd 反推）；空段省略', () => {
    const deps = makeDeps(new MockLlm(), {
      users: { getSettings: () => ({ persona: null, memory: null }), byId: () => undefined },
    });
    const s = new PmAgent(project(), deps).systemPrompt();
    expect(s).toBe('GLOBAL-PERSONA');
    expect(s).not.toContain('# 用户附加设定');
    expect(s).not.toContain('# 记忆');
  });
});

describe('全局 persona 加载（v1 persona/管家.md 平移 + 可配路径）', () => {
  test('缺省内置默认（v1 全文平移）', () => {
    expect(loadGlobalPersona()).toBe(DEFAULT_GLOBAL_PERSONA);
    expect(DEFAULT_GLOBAL_PERSONA).toContain('tmux 远程操作管家');
    expect(DEFAULT_GLOBAL_PERSONA).toContain('不泄露密钥');
  });

  test('显式路径可整体替换；读失败回默认', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-persona-'));
    const f = join(dir, 'p.md');
    writeFileSync(f, '# 自定义人设\n你是海盗。');
    expect(loadGlobalPersona(f)).toBe('# 自定义人设\n你是海盗。');
    expect(loadGlobalPersona(join(dir, '不存在.md'))).toBe(DEFAULT_GLOBAL_PERSONA);
  });
});

// ---------- judgeDone ----------

describe('judgeDone（v1 fallbackDoneCheck 保守判定平移）', () => {
  test('done=true → done；裸 system（不带 persona）+ jsonMode + 子任务清单入 user', async () => {
    const llm = new MockLlm(['{"done":true,"reason":"测试全过"}']);
    const pm = new PmAgent(project(), makeDeps(llm));
    const i = issue({ subtasksJson: JSON.stringify([{ text: '写解析', done: true }, { text: '写测试', done: false }]) });
    expect(await pm.judgeDone(i, '……全部测试通过')).toBe('done');
    const call = llm.calls[0]!;
    expect(call.messages[0]!.content).toBe(JUDGE_DONE_SYS); // 裸 system（v1 唯一裸 system 语义保留）
    expect(call.opts?.jsonMode).toBe(true);
    expect(call.messages[1]!.content).toContain('任务：加导出功能：支持 CSV');
    expect(call.messages[1]!.content).toContain('1. 写解析');
    expect(call.messages[1]!.content).toContain('会话最近输出：\n……全部测试通过');
  });

  test('done=false / 解析失败 → not_done（保守）；LLM 错误上抛（引擎落事件）', async () => {
    const pm1 = new PmAgent(project(), makeDeps(new MockLlm(['{"done":false,"reason":"还在跑"}'])));
    expect(await pm1.judgeDone(issue(), 'x')).toBe('not_done');
    const pm2 = new PmAgent(project(), makeDeps(new MockLlm(['not json'])));
    expect(await pm2.judgeDone(issue(), 'x')).toBe('not_done');
    const pm3 = new PmAgent(project(), makeDeps(new MockLlm([new Error('down')])));
    await expect(pm3.judgeDone(issue(), 'x')).rejects.toThrow('down');
  });

  test('clarify=true → clarify（第二层保险）；clarify 优先于 done', async () => {
    const pm1 = new PmAgent(project(), makeDeps(new MockLlm(['{"done":false,"clarify":true,"reason":"在问用户"}'])));
    expect(await pm1.judgeDone(issue(), '1. 用哪个库？')).toBe('clarify');
    // clarify 优先：即使模型自相矛盾地同时给 done=true，也判 clarify（宁可停下等，不擅自收尾）
    const pm2 = new PmAgent(project(), makeDeps(new MockLlm(['{"done":true,"clarify":true}'])));
    expect(await pm2.judgeDone(issue(), 'x')).toBe('clarify');
  });

  test('JUDGE_DONE_SYS 快照逐字（含 v2 clarify 档）', () => {
    expect(JUDGE_DONE_SYS).toBe(
      `你在判断一个 Claude Code 任务/调试的当前状态。只看证据，宁可保守。只输出 JSON：{"done": bool, "clarify": bool, "reason": "≤30字中文"}。\n` +
        `- done=true 仅当：最近输出显示工作已收尾、改动已落地且(若涉及)测试/自测已通过、没有在问用户或等用户输入、没有报错或卡住、没有明显未完的后续步骤。\n` +
        `- clarify=true 当：最近输出显示它在**向用户提问 / 等用户回答或拍板后才能继续**（例如列出待确认的问题、征求你决策）；此时 done 必为 false。\n` +
        `- done 与 clarify 都为 false：还在进行中、报错、被卡住、或证据不足以确认完成。`,
    );
  });
});

// ---------- clarifying ----------

describe('generateClarifyingQuestions', () => {
  test('清晰 → null；含糊 → 提问列表（trim、上限 5 条）', async () => {
    const clear = new PmAgent(project(), makeDeps(new MockLlm(['{"clear":true,"questions":[]}'])));
    expect(await clear.generateClarifyingQuestions(issue())).toBeNull();

    const qs = Array.from({ length: 7 }, (_, i) => ` 问题${i + 1}？ `);
    const vague = new PmAgent(
      project(),
      makeDeps(new MockLlm([JSON.stringify({ clear: false, questions: qs })])),
    );
    const got = await vague.generateClarifyingQuestions(issue());
    expect(got).toEqual(['问题1？', '问题2？', '问题3？', '问题4？', '问题5？']);
  });

  test('说含糊却没给问题 / 解析失败 → null（不卡流程）；goal 入上下文', async () => {
    const empty = new PmAgent(project(), makeDeps(new MockLlm(['{"clear":false,"questions":[]}'])));
    expect(await empty.generateClarifyingQuestions(issue())).toBeNull();
    const bad = new PmAgent(project(), makeDeps(new MockLlm(['not json'])));
    expect(await bad.generateClarifyingQuestions(issue())).toBeNull();

    const llm = new MockLlm(['{"clear":true}']);
    const pm = new PmAgent(project({ goal: '做个导出模块' }), makeDeps(llm));
    await pm.generateClarifyingQuestions(issue());
    expect(llm.calls[0]!.messages[0]!.content).toBe(CLARIFYING_SYS);
    expect(llm.calls[0]!.messages[1]!.content).toContain('项目目标：做个导出模块');
    expect(llm.calls[0]!.messages[1]!.content).toContain('issue（task）：加导出功能：支持 CSV');
  });
});

// ---------- 同模块智能合并 ----------

describe('mergeModuleTasks（同模块 pending 交 LLM 归并）', () => {
  const cand = (id: number, title: string, body: string | null = null) => ({ id, title, body });

  test('候选 <2 → 不问 LLM，返回 []', async () => {
    const llm = new MockLlm();
    const pm = new PmAgent(project(), makeDeps(llm));
    expect(await pm.mergeModuleTasks('web', [cand(1, 'a')])).toEqual([]);
    expect(llm.calls.length).toBe(0);
  });

  test('返回合并组：只认给定 id、去重、成员 ≥2、title/body 齐全；module 入上下文', async () => {
    const llm = new MockLlm([
      JSON.stringify({
        groups: [
          { members: [1, 2, 2, 999], title: '合并A+B', body: '1) A\n2) B' }, // 999 非候选被剔、2 去重
          { members: [3], title: '只有一条', body: 'x' }, // 不足 2 条丢弃
        ],
      }),
    ]);
    const pm = new PmAgent(project(), makeDeps(llm));
    const got = await pm.mergeModuleTasks('web', [cand(1, 'A', 'aa'), cand(2, 'B'), cand(3, 'C')]);
    expect(got).toEqual([{ members: [1, 2], title: '合并A+B', body: '1) A\n2) B' }]);
    expect(llm.calls[0]!.messages[0]!.content).toBe(MERGE_SYS);
    expect(llm.calls[0]!.opts?.jsonMode).toBe(true);
    expect(llm.calls[0]!.messages[1]!.content).toContain('模块「web」');
    expect(llm.calls[0]!.messages[1]!.content).toContain('#1 A：aa');
  });

  test('同一 id 被划进多组 → 只归第一组（不重复折叠）', async () => {
    const llm = new MockLlm([
      JSON.stringify({
        groups: [
          { members: [1, 2], title: 'g1', body: 'b1' },
          { members: [2, 3], title: 'g2', body: 'b2' }, // 2 已被 g1 用掉 → 整组丢
        ],
      }),
    ]);
    const pm = new PmAgent(project(), makeDeps(llm));
    const got = await pm.mergeModuleTasks('web', [cand(1, 'A'), cand(2, 'B'), cand(3, 'C')]);
    expect(got).toEqual([{ members: [1, 2], title: 'g1', body: 'b1' }]);
  });

  test('缺 title/body、非法 JSON、空 groups → []（保守，不卡调度）', async () => {
    const noBody = new PmAgent(project(), makeDeps(new MockLlm([JSON.stringify({ groups: [{ members: [1, 2], title: 'x' }] })])));
    expect(await noBody.mergeModuleTasks('web', [cand(1, 'A'), cand(2, 'B')])).toEqual([]);
    const bad = new PmAgent(project(), makeDeps(new MockLlm(['not json'])));
    expect(await bad.mergeModuleTasks('web', [cand(1, 'A'), cand(2, 'B')])).toEqual([]);
    const empty = new PmAgent(project(), makeDeps(new MockLlm(['{"groups":[]}'])));
    expect(await empty.mergeModuleTasks('web', [cand(1, 'A'), cand(2, 'B')])).toEqual([]);
  });
});

describe('suggestModule（issue 保守归入项目模块）', () => {
  test('有效 existing 只接受同 agent 的活跃候选', async () => {
    const llm = new MockLlm(['{"kind":"existing","moduleId":9}']);
    const pm = new PmAgent(project(), makeDeps(llm));
    const got = await pm.suggestModule({
      title: '增加 CSV 导出',
      agent: 'claude',
      modules: [module(), module({ id: 10, slug: 'api-server', agent: 'codex' })],
      allowNew: true,
    });
    expect(got).toEqual({ kind: 'existing', moduleId: 9 });
    expect(llm.calls[0]!.messages[0]!.content).toBe(MODULE_SUGGEST_SYS);
    expect(llm.calls[0]!.messages[1]!.content).toContain('id=9 slug=export-tools');
    expect(llm.calls[0]!.messages[1]!.content).not.toContain('id=10');
    expect(llm.calls[0]!.opts?.jsonMode).toBe(true);
  });

  test('允许新增时接受 2–4 个英文词的 slug', async () => {
    const pm = new PmAgent(
      project(),
      makeDeps(new MockLlm(['{"kind":"new","slug":"data-export-tools","displayName":"数据导出","purpose":"集中维护导出能力"}'])),
    );
    expect(
      await pm.suggestModule({
        title: '导出账单',
        body: 'CSV',
        agent: 'codex',
        modules: [],
        allowNew: true,
        manualName: '数据导出',
      }),
    ).toEqual({
      kind: 'new',
      slug: 'data-export-tools',
      displayName: '数据导出',
      purpose: '集中维护导出能力',
    });
  });

  test('禁止新增或响应非法时稳定回退已有模块', async () => {
    const llm = new MockLlm([
      '{"kind":"new","slug":"new-module","displayName":"New","purpose":"x"}',
      '{"kind":"new","slug":"单词","displayName":"坏","purpose":"x"}',
    ]);
    const pm = new PmAgent(project(), makeDeps(llm));
    const input = {
      title: '小修',
      agent: 'claude' as const,
      modules: [module()],
      allowNew: false,
    };
    expect(await pm.suggestModule(input)).toEqual({ kind: 'existing', moduleId: 9 });
    expect(llm.calls[0]!.messages[1]!.content).toContain('Creation is disallowed');
    expect(await pm.suggestModule({ ...input, allowNew: true })).toEqual({ kind: 'existing', moduleId: 9 });
  });

  test('无候选且模型失约时回退 general-work', async () => {
    const pm = new PmAgent(project(), makeDeps(new MockLlm(['not json'])));
    expect(await pm.suggestModule({ title: '未知工作', agent: 'claude', modules: [], allowNew: true })).toEqual({
      kind: 'new',
      slug: 'general-work',
      displayName: 'General Work',
      purpose: 'General project work that does not yet belong to a stable module.',
    });
  });
});

// ---------- 审批委托 ----------

describe('decideApproval（委托 approval.ts 三层瀑布，带项目上下文）', () => {
  test('多选菜单 → escalate（不进 LLM）；menuFromSelection 自动判多选', async () => {
    const llm = new MockLlm();
    const pm = new PmAgent(project(), makeDeps(llm));
    const menu = menuFromSelection({ context: 'space to toggle', options: ['a', 'b'] }, 'raw');
    expect(menu.multiSelect).toBe(true);
    const r = await pm.decideApproval(menu);
    expect(r.action).toBe('escalate');
    expect(r.rule).toBe('multi_select');
    expect(r.requestId).toBeTruthy(); // 防重放句柄
    expect(llm.calls.length).toBe(0);
  });

  test('LLM 分级路径带 project.goal + 当前任务文本', async () => {
    const llm = new MockLlm(['{"action":"approve","option":1,"reason":"只读"}']);
    const pm = new PmAgent(project({ goal: '导出模块' }), makeDeps(llm));
    const r = await pm.decideApproval(
      menuFromSelection({ context: 'Read file?', options: ['Yes', 'No'] }),
      { taskText: '加 CSV 导出' },
    );
    expect(r.action).toBe('approve');
    expect(r.action === 'approve' && r.optionIndex).toBe(0);
    expect(llm.calls[0]!.messages[1]!.content).toContain('总目标：导出模块');
    expect(llm.calls[0]!.messages[1]!.content).toContain('当前任务：加 CSV 导出');
  });
});

// ---------- 阶段 prompt ----------

describe('buildStagePrompt（issues/prompts 模板编排）', () => {
  const deps = () => makeDeps(new MockLlm());

  test('planning：SUBTASKS 协议 + goal + 截图提示', async () => {
    const pm = new PmAgent(project({ goal: '导出模块' }), deps());
    const p = await pm.buildStagePrompt(issue({ imagesJson: JSON.stringify(['shot.png']) }), 'planning');
    expect(p).toContain('SUBTASKS_BEGIN');
    expect(p).toContain('项目目标：导出模块');
    expect(p).toContain('/repo/export/shot.png'); // 相对图转项目 cwd 绝对路径
  });

  test('implementing/seq → 按 subIndex 喂子任务；无子任务抛错', async () => {
    const pm = new PmAgent(project(), deps());
    const i = issue({
      status: 'implementing',
      subIndex: 1,
      subtasksJson: JSON.stringify([{ text: '写解析', done: true }, { text: '写测试', done: false }]),
    });
    const p = await pm.buildStagePrompt(i, 'implementing');
    expect(p).toContain('【实施 子任务 2/2】写测试');
    expect(p).toContain('issue/42'); // branch 缺省 issue/<id>
    await expect(pm.buildStagePrompt(issue(), 'implementing')).rejects.toThrow('无可喂子任务');
  });

  test('implementing/team → 一次性清单 + STAGE_DONE 哨兵', async () => {
    const pm = new PmAgent(project(), deps());
    const i = issue({
      subtasksJson: JSON.stringify(['a', 'b']), // 字符串数组形态也接受
      branch: 'issue/42',
    }) as Issue & { implMode: 'team' };
    i.implMode = 'team';
    const p = await pm.buildStagePrompt(i, 'implementing');
    expect(p).toContain('Agent team');
    expect(p).toContain('STAGE_DONE:42:implementing');
  });

  test('implementing 返工：显式传 feedback + source', async () => {
    const pm = new PmAgent(project(), deps());
    const p = await pm.buildStagePrompt(issue(), 'implementing', {
      feedback: '挂了 3 个用例',
      reworkSource: 'tests_failed',
    });
    expect(p).toContain('测试未通过');
    expect(p).toContain('挂了 3 个用例');
  });

  test('testing → STAGE_DONE:testing；无 CC prompt 的阶段抛错', async () => {
    const pm = new PmAgent(project(), deps());
    expect(await pm.buildStagePrompt(issue({ branch: 'issue/42' }), 'testing')).toContain('STAGE_DONE:42:testing');
    await expect(pm.buildStagePrompt(issue(), 'clarifying')).rejects.toThrow('没有 CC 注入 prompt');
    await expect(pm.buildStagePrompt(issue(), 'plan_review')).rejects.toThrow('没有 CC 注入 prompt');
  });
});

// ---------- 进度摘要 ----------

describe('summarizeProgress（issue_events 批次 → 值不值得推）', () => {
  const events: IssueEvent[] = [
    { id: 1, issueId: 42, kind: 'injected', dataJson: '{"stage":"implementing"}', ts: 1 },
    { id: 2, issueId: 42, kind: 'done', dataJson: '{"note":"子任务 1 完成"}', ts: 2 },
  ];

  test('push=true → headline；带 PM systemPrompt 前缀；滚动摘要进下一轮 prev', async () => {
    const llm = new MockLlm([
      '{"push":true,"status":"milestone","needsReply":false,"headline":"子任务 1 搞定"}',
      '{"push":false,"status":"working","needsReply":false,"headline":""}',
    ]);
    const pm = new PmAgent(project(), makeDeps(llm));
    expect(await pm.summarizeProgress(events)).toBe('子任务 1 搞定');
    const sys = llm.calls[0]!.messages[0]!.content!;
    expect(sys).toContain('GLOBAL-PERSONA'); // analyze 带人设（v1 语义；审批才裸 system）
    expect(llm.calls[0]!.messages[1]!.content).toContain('[injected]');

    expect(await pm.summarizeProgress(events)).toBeNull(); // push=false
    expect(llm.calls[1]!.messages[1]!.content).toContain('此前进度：子任务 1 搞定');
  });

  test('空批次 → null 不调 LLM', async () => {
    const llm = new MockLlm();
    const pm = new PmAgent(project(), makeDeps(llm));
    expect(await pm.summarizeProgress([])).toBeNull();
    expect(llm.calls.length).toBe(0);
  });

  test('createProgressReporter：flush 产出 {push,status,needsReply,headline} 给 NotifyRouter 适配层', async () => {
    const llm = new MockLlm(['{"push":true,"status":"error","needsReply":true,"headline":"编译炸了"}']);
    const pm = new PmAgent(project(), makeDeps(llm));
    const pushed: unknown[] = [];
    const rep = pm.createProgressReporter((a) => void pushed.push(a));
    rep.add({ role: 'assistant', text: 'error TS2345' });
    const a = await rep.flush();
    expect(a).toEqual({ push: true, status: 'waiting', needsReply: true, headline: '编译炸了' }); // needsReply 覆写
    expect(pushed.length).toBe(1);
  });
});

// ---------- 问答工具循环 ----------

describe('answerQuestion（v1 chatWithTools 平移，项目作用域）', () => {
  test('工具轮：tool_calls → executeTool → 结果回灌 → 最终答复', async () => {
    const llm = new MockLlm([
      {
        content: '',
        toolCalls: [{ id: 't1', type: 'function', function: { name: 'list_sessions', arguments: '{}' } }],
      },
      '项目里有 1 条对话，正在跑导出功能。',
    ]);
    const pm = new PmAgent(project({ goal: '导出模块' }), makeDeps(llm));
    const answer = await pm.answerQuestion(3, '现在在干嘛？');
    expect(answer).toBe('项目里有 1 条对话，正在跑导出功能。');
    expect(llm.calls.length).toBe(2);
    // 第一轮：带 TOOL_SCHEMAS + 项目作用域 system + 对话快照 + 提问者
    const sys = llm.calls[0]!.messages[0]!.content!;
    expect(llm.calls[0]!.opts?.tools).toBeTruthy();
    expect(sys).toContain('GLOBAL-PERSONA');
    expect(sys).toContain('项目「导出模块」的 PM 管家');
    expect(sys).toContain('导出功能'); // 对话快照
    expect(sys).toContain('alice'); // 提问者
    // 第二轮历史：assistant(tool_calls) + tool 结果
    const hist = llm.calls[1]!.messages;
    expect(hist.some((m) => m.role === 'tool' && m.tool_call_id === 't1' && m.content!.includes('@cc-7'))).toBe(true);
  });

  test('工具异常转字符串继续（不炸循环）；5 轮上限兜底文案', async () => {
    const badCall = {
      content: '',
      toolCalls: [{ id: 'tx', type: 'function', function: { name: 'read_progress', arguments: '{{{' } }],
    };
    const llm = new MockLlm([badCall, '修好了']);
    const pm = new PmAgent(project(), makeDeps(llm));
    expect(await pm.answerQuestion(3, 'x')).toBe('修好了');
    const hist = llm.calls[1]!.messages;
    expect(hist.some((m) => m.role === 'tool' && m.content!.includes('工具出错'))).toBe(true);

    const loop = new MockLlm();
    for (let i = 0; i < 6; i++) loop.push(badCall);
    const pm2 = new PmAgent(project(), makeDeps(loop));
    expect(await pm2.answerQuestion(3, 'x')).toContain('工具调用轮数过多');
    expect(loop.calls.length).toBe(5); // v1 5 轮上限
  });
});

// ---------- 管家池 / 迁移 / 引擎兼容 ----------

describe('管家池与集成契约', () => {
  test('createPmPool：同项目复用实例，取用时刷新 project 快照', () => {
    const pmFor = createPmPool(makeDeps(new MockLlm()));
    const a = pmFor(project());
    const b = pmFor(project({ goal: '新目标' }));
    expect(b).toBe(a); // 同 projectId 复用
    expect(a.project.goal).toBe('新目标'); // 快照已刷新
    const other = pmFor(project({ id: 8 }));
    expect(other).not.toBe(a);
  });

  test('PmAgent 结构兼容 EnginePm（EngineDeps.pmFor 直接接线）', () => {
    const pm = new PmAgent(project(), makeDeps(new MockLlm()));
    const enginePm: EnginePm = pm; // 编译期结构校验
    expect(typeof enginePm.judgeDone).toBe('function');
    expect(typeof enginePm.mergeModuleTasks).toBe('function');
  });

  test('migratePmAgent：040 应用且幂等（llm_config/pm_progress 建表）', () => {
    const db = openDb(':memory:');
    const s1 = migratePmAgent(db);
    expect(s1.applied).toContain(40);
    const s2 = migratePmAgent(db); // 重复执行不炸
    expect(s2.applied).toEqual(s1.applied);
    const tables = db
      .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => r.name);
    expect(tables).toContain('llm_config');
    expect(tables).toContain('pm_progress');
    db.close();
  });
});

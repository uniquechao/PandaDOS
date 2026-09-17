import { describe, expect, test } from 'bun:test';
import { MAX_INJECT_CHARS } from '../executor/driver';
import {
  buildNudge,
  buildDirectPrompt,
  buildPlanningPrompt,
  buildRecoveryResumePrompt,
  buildReworkPrompt,
  buildSubtaskPrompt,
  buildTeamPrompt,
  buildTestingPrompt,
  imageReadHint,
  midTruncate,
  moduleDocsRule,
  sentinelBoundary,
} from './prompts';

const issue = { id: 42, title: '加导出功能', body: '支持 CSV 和 JSON' };

describe('prompt 模板与哨兵协议配套', () => {
  test('Issue #149 执行冒烟：需求不足时保留规划与纯文字澄清协议', () => {
    const p = buildPlanningPrompt({
      issue: { id: 149, title: '测试issue执行能力', body: '测试issue执行能力' },
    });
    expect(p).toContain('SUBTASKS_BEGIN');
    expect(p).toContain('SUBTASKS_END');
    expect(p).toContain('按编号列出');
    expect(p).toContain('用纯文字提问');
    expect(p).toContain('不要用交互式多选菜单/AskUserQuestion');
    expect(p).toContain('NEED_CLARIFY:149');
  });

  test('planning：要求 SUBTASKS_BEGIN/END + 手机纯文字提问约束 + NEED_CLARIFY 协议', () => {
    const p = buildPlanningPrompt({ issue, goal: '做个导出模块' });
    expect(p).toContain('SUBTASKS_BEGIN');
    expect(p).toContain('SUBTASKS_END');
    expect(p).toContain('不要用交互式多选菜单/AskUserQuestion');
    expect(p).toContain('NEED_CLARIFY:42'); // 澄清协议带 issue id
    expect(p).toContain('项目目标：做个导出模块');
  });

  test('planning：禁止把验证/提交写成子任务 + 按规模给条数 + 流程裁剪（2026-07-27 提速）', () => {
    // 生产统计：549 条子任务里 197 条是「跑测试/构建/浏览器自测/提交推送」这类流程活，
    // 而引擎本身有 testing 阶段与 auto_commit/auto_push——同一件事做两三遍，每条还各占一个回合。
    const p = buildPlanningPrompt({ issue });
    expect(p).toContain('子任务只写代码改动本身');
    expect(p).toContain('别写进子任务');
    expect(p).toContain('小改动就只出 1 条');
    expect(p).toContain('流程按改动规模裁剪');
  });

  test('模块共享会话切换 issue 时：明确保留模块上下文、切换当前目标', () => {
    const p = buildPlanningPrompt({ issue, moduleName: '导出模块' });
    expect(p).toContain('模块共享会话');
    expect(p).toContain('导出模块');
    expect(p).toContain('当前切换到 Issue #42');
    expect(p).toContain('保留此前模块技术上下文');
    expect(p).toContain('当前目标和验收范围只以 Issue #42 为准');
    expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
  });

  test('subtask/team：单条实施也不走全套流程（小改动直接改）', () => {
    const sub = buildSubtaskPrompt({ issue, subtasks: ['a'], idx: 0, branch: 'issue/42' });
    expect(sub).toContain('流程按改动规模裁剪');
    const team = buildTeamPrompt({ issue, subtasks: ['a', 'b'], branch: 'issue/42' });
    expect(team).toContain('流程按改动规模裁剪');
  });

  test('planning 回炉带 reject 意见', () => {
    const p = buildPlanningPrompt({ issue, feedback: '第 2 步拆太粗' });
    expect(p).toContain('驳回');
    expect(p).toContain('第 2 步拆太粗');
  });

  test('受阻恢复规划带解除方法和修订后的子任务', () => {
    const p = buildPlanningPrompt({
      issue: { ...issue, body: '改用离线缓存并保留失败记录' },
      recovery: {
        guidance: '先检查缓存目录权限，再从失败步骤继续',
        subtasks: ['准备缓存目录', '恢复失败步骤'],
      },
    });
    expect(p).toContain('改用离线缓存并保留失败记录');
    expect(p).toContain('先检查缓存目录权限，再从失败步骤继续');
    expect(p).toContain('1. 准备缓存目录');
    expect(p).toContain('2. 恢复失败步骤');
  });

  test('受阻恢复续行按当前阶段给协议，不要求重新规划或重做已完成项', () => {
    const p = buildRecoveryResumePrompt({
      issue,
      stage: 'implementing',
      guidance: '修好权限后从第二步继续',
      branch: 'issue/42',
      currentSubtask: '写入导出文件',
      subtaskIndex: 1,
      subtaskTotal: 3,
      team: false,
    });
    expect(p).toContain('修好权限后从第二步继续');
    expect(p).toContain('当前子任务 2/3');
    expect(p).toContain('写入导出文件');
    expect(p).toContain('SUBTASK_DONE:42');
    expect(p).toContain('不要重新规划');
    expect(p).toContain('不要重做已完成');
    expect(p).not.toContain('【实施 子任务 1/3】');
  });

  test('subtask：SUBTASK_DONE 带 id + 分支上下文 + NEED_CLARIFY + 越界防护措辞', () => {
    const p = buildSubtaskPrompt({ issue, subtasks: ['a', 'b'], idx: 0, branch: 'issue/42' });
    expect(p).toContain('【实施 子任务 1/2】');
    expect(p).toContain('SUBTASK_DONE:42');
    expect(p).toContain('NEED_CLARIFY:42');
    expect(p).toContain('ISSUE_BLOCKED:42');
    expect(p).toContain('issue/42');
    expect(p).toContain('完成本子任务前别做清单外的事');
  });

  test('team：STAGE_DONE:implementing + NEED_CLARIFY + 补 imgHint（v1 疏漏修复）', () => {
    const p = buildTeamPrompt({
      issue,
      subtasks: ['a', 'b'],
      branch: 'issue/42',
      imgHint: imageReadHint(['/abs/1.png']),
    });
    expect(p).toContain('STAGE_DONE:42:implementing');
    expect(p).toContain('NEED_CLARIFY:42');
    expect(p).toContain('Agent team');
    expect(p).toContain('/abs/1.png');
  });

  test('rework/testing：哨兵按新格式 + NEED_CLARIFY', () => {
    const rw = buildReworkPrompt({ issue, feedback: '挂了 3 个用例', branch: 'issue/42', source: 'tests_failed' });
    expect(rw).toContain('STAGE_DONE:42:implementing');
    expect(rw).toContain('NEED_CLARIFY:42');
    const t = buildTestingPrompt({ issue, branch: 'issue/42' });
    expect(t).toContain('STAGE_DONE:42:testing');
    expect(t).toContain('TESTS_FAILED:42');
    expect(t).toContain('NEED_CLARIFY:42');
    expect(t).toContain('原始目标');
    expect(t).toContain('亲自操作'); // #301：只有「必须用户动手」才算受阻，可选后续不算
  });

  test('nudge 三条（改哨兵名）+ 附 NEED_CLARIFY 逃生口 + 去掉无条件「别停下来等我」', () => {
    const impl = buildNudge({ issue, stage: 'implementing', seqPending: true });
    expect(impl).toContain('SUBTASK_DONE:42');
    expect(impl).toContain('NEED_CLARIFY:42');
    expect(buildNudge({ issue, stage: 'implementing', seqPending: false })).toContain('STAGE_DONE:42:implementing');
    expect(buildNudge({ issue, stage: 'testing' })).toContain('STAGE_DONE:42:testing');
    const plan = buildNudge({ issue, stage: 'planning' });
    expect(plan).toContain('SUBTASKS_BEGIN');
    expect(plan).toContain('NEED_CLARIFY:42');
    // 旧的无条件「别停下来等我」已移除（会把真在等澄清的代理推着做错方向）
    for (const s of ['planning', 'implementing', 'testing'] as const) {
      expect(buildNudge({ issue, stage: s })).not.toContain('别停下来等我');
    }
  });
});

describe('NEED_CLARIFY / ISSUE_BLOCKED 边界说明（#275 / B-08）', () => {

  test('三件事都要讲到：互斥、怎么选、混发会怎样', () => {
    const zh = sentinelBoundary(42, 'zh-Hans');
    expect(zh).toContain('互斥');
    expect(zh).toContain('我回答就能解开');   // 怎么选：判据是「我答了能不能解开」
    expect(zh).toContain('必须我亲自动手才算受阻');
    expect(zh).toContain('按澄清处理');       // 混发的实际后果，与引擎行为一致
    expect(zh).toContain('NEED_CLARIFY:42');
    expect(zh).toContain('ISSUE_BLOCKED:42');

    const en = sentinelBoundary(42, 'en');
    expect(en).toContain('at most one of these two markers');
    expect(en).toContain('NEED_CLARIFY:42');
    expect(en).toContain('ISSUE_BLOCKED:42');
    expect(en).toContain('clarification');
  });

  // #301：受阻只有一句话时用户看不出「要不要我动手」，边界说明再多担两件事
  test('三分（告知不发标记）与受阻原因三段格式，中英都写进同一段措辞', () => {
    const zh = sentinelBoundary(42, 'zh-Hans');
    expect(zh).toContain('一个标记都别发');     // 纯告知：别占队列，也别要人工解锁
    expect(zh).toContain('在做什么｜卡在哪｜要我做什么');

    const en = sentinelBoundary(42, 'en');
    expect(en).toContain('emit no marker and keep going');
    expect(en).toContain('what you were doing | where you are stuck | what I must do');
  });

  test('凡是同时提到两个标记的 prompt 都用同一段措辞，不各写各的', () => {
    const branch = 'issue/42';
    const prompts = [
      buildSubtaskPrompt({ issue, subtasks: ['做一点事'], idx: 0, branch, locale: 'zh-Hans' }),
      buildTeamPrompt({ issue, subtasks: ['做一点事'], branch, locale: 'zh-Hans' }),
      buildReworkPrompt({ issue, feedback: '挂了', branch, source: 'tests_failed', locale: 'zh-Hans' }),
      buildTestingPrompt({ issue, branch, locale: 'zh-Hans' }),
    ];
    for (const p of prompts) {
      expect(p).toContain(sentinelBoundary(42, 'zh-Hans'));
      expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    }
  });

  test('措辞变长后预算仍然联动：最长的 team prompt 两种语言都不破上限', () => {
    const fat = { ...issue, body: 'B'.repeat(4000) };
    for (const locale of ['zh-Hans', 'en'] as const) {
      const p = buildTeamPrompt({
        issue: fat,
        goal: 'g'.repeat(500),
        subtasks: Array.from({ length: 40 }, (_, i) => `${i}-${'z'.repeat(490)}`),
        branch: 'b'.repeat(40),
        locale,
      });
      expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
      expect(p).toContain('STAGE_DONE:42:implementing'); // 哨兵仍在，没被截掉
    }
  });
});

describe('注入预算联动（评审 H7：哨兵指令绝不被截）', () => {
  test('超长 issue 正文居中截断，哨兵指令保住，总长不破 MAX_INJECT_CHARS', () => {
    const long = { id: 7, title: 'x'.repeat(3000), body: 'y'.repeat(5000) };
    const p = buildPlanningPrompt({ issue: long, goal: 'g'.repeat(3000) });
    expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(p).toContain('SUBTASKS_END');
  });

  test('team 40 条×500 字子任务清单也不破预算', () => {
    const subs = Array.from({ length: 40 }, (_, i) => `${i}-${'z'.repeat(490)}`);
    const p = buildTeamPrompt({ issue, subtasks: subs, branch: 'issue/42' });
    expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(p).toContain('STAGE_DONE:42:implementing');
  });

  test('midTruncate 保头保尾', () => {
    const s = 'A'.repeat(100) + 'B'.repeat(100);
    const t = midTruncate(s, 50);
    expect(t.length).toBeLessThanOrEqual(50 + 10);
    expect(t.startsWith('A')).toBe(true);
    expect(t.endsWith('B')).toBe(true);
  });
});

describe('模块文档规则内联（#277 / I-02）', () => {
  const fat = { id: 42, title: 'T'.repeat(3000), body: 'B'.repeat(5000) };

  test('五条规则中英各覆盖一遍：定位入口、读什么、记什么、回写什么、不许干什么', () => {
    const zh = moduleDocsRule('zh-Hans');
    expect(zh).toContain('.panda/modules/INDEX.md'); // ①入口
    expect(zh).toContain('MODULE.md');               // ②本模块文档
    expect(zh).toContain('过程页');                   // ②③④过程页
    expect(zh).toContain('不记逐条终端流水');          // ③记什么
    expect(zh).toContain('长期仍有效');                // ④只回写长期知识
    expect(zh).toContain('不要自行批量新建模块');       // ⑤
    expect(zh).toContain('停止写入并明确报告');         // ⑤冲突处置

    const en = moduleDocsRule('en');
    expect(en).toContain('.panda/modules/INDEX.md');
    expect(en).toContain('MODULE.md');
    expect(en).toContain('process page');
    expect(en).toContain('not a terminal log');
    expect(en).toContain('durable');
    expect(en).toContain('bulk-create');
    expect(en).toContain('stop and report');
    expect(en).not.toBe(moduleDocsRule('zh-Hans')); // 英文 locale 不落回中文
  });

  test('只进 planning 与受阻恢复续跑，别的阶段不占预算', () => {
    const branch = 'issue/42';
    for (const locale of ['zh-Hans', 'en'] as const) {
      const rule = moduleDocsRule(locale);
      expect(buildPlanningPrompt({ issue, locale })).toContain(rule);
      for (const stage of ['planning', 'implementing', 'testing'] as const) {
        expect(buildRecoveryResumePrompt({ issue, stage, guidance: '接着干', branch, locale })).toContain(rule);
      }
      // 逐条子任务 / 返工 / 测试 / team：用不上模块文档规则，不许塞
      expect(buildSubtaskPrompt({ issue, subtasks: ['做事'], idx: 0, branch, locale })).not.toContain(rule);
      expect(buildReworkPrompt({ issue, feedback: '挂了', branch, source: 'tests_failed', locale })).not.toContain(rule);
      expect(buildTestingPrompt({ issue, branch, locale })).not.toContain(rule);
      expect(buildTeamPrompt({ issue, subtasks: ['做事'], branch, locale })).not.toContain(rule);
    }
  });

  test('worst case 不破 2000：planning 的「恢复 + 驳回意见 + 模块名」三件套两种语言都装得下', () => {
    for (const locale of ['zh-Hans', 'en'] as const) {
      const p = buildPlanningPrompt({
        issue: fat,
        goal: 'g'.repeat(3000),
        feedback: 'f'.repeat(3000),
        moduleName: 'M'.repeat(200),
        recovery: {
          guidance: 'r'.repeat(3000),
          subtasks: Array.from({ length: 20 }, (_, i) => `${i}-${'s'.repeat(300)}`),
        },
        locale,
      });
      expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
      // 压的只能是可变文本：哨兵协议与规则原样都在
      expect(p).toContain('SUBTASKS_END');
      expect(p).toContain(`NEED_CLARIFY:${fat.id}`);
      expect(p).toContain(moduleDocsRule(locale));
    }
  });

  test('worst case 不破 2000：受阻恢复续跑四种分支两种语言都装得下', () => {
    for (const locale of ['zh-Hans', 'en'] as const) {
      const cases = [
        { stage: 'planning' as const },
        { stage: 'testing' as const },
        { stage: 'implementing' as const, team: true },
        { stage: 'implementing' as const, subtaskIndex: 3, subtaskTotal: 9 },
      ];
      for (const c of cases) {
        const p = buildRecoveryResumePrompt({
          issue: fat,
          guidance: 'g'.repeat(3000),
          branch: 'b'.repeat(60),
          currentSubtask: 'c'.repeat(3000),
          locale,
          ...c,
        });
        expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
        expect(p).toContain(moduleDocsRule(locale));
      }
    }
  });

  test('压缩顺序：先砍项目目标，issue 正文垫底不会被先牺牲', () => {
    const p = buildPlanningPrompt({
      issue: { id: 42, title: '标题'.repeat(50), body: '正文'.repeat(200) },
      goal: 'G'.repeat(3000),
      feedback: 'F'.repeat(3000),
      moduleName: '模块'.repeat(30),
      locale: 'en',
    });
    expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(p).toContain('标题'); // 任务本体还在
  });
});


describe('收尾协议一致性', () => {
  for (const locale of ['zh-Hans', 'en'] as const) {
    test(`${locale}: 自检、催办、恢复均保留报告与系统验证职责`, () => {
      const prompts = [
        buildTestingPrompt({ issue, branch: 'main', locale }),
        buildNudge({ issue, stage: 'testing', locale }),
        buildRecoveryResumePrompt({ issue, stage: 'testing', branch: 'main', guidance: '继续', locale }),
      ];
      for (const prompt of prompts) {
        expect(prompt).toContain('REPORT_BEGIN');
        expect(prompt).toContain('remainingWork');
        expect(prompt).toContain('STAGE_DONE:42:testing');
        expect(prompt).not.toContain('前后别带其它内容');
        expect(prompt).not.toContain('When all tests pass');
        expect(prompt.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
      }
      expect(prompts[0]).toContain(locale === 'en' ? 'deployment is in scope only when requested' : '部署仅在需求明确包含上线时验收');
    });
  }
});


describe('按交付组织工作，避免人为拆轮次', () => {
  for (const locale of ['zh-Hans', 'en'] as const) {
    test(`${locale}: 默认单条交付，自动模式不要求开工审批`, () => {
      const prompt = buildPlanningPrompt({ issue, locale });
      expect(prompt).toContain(locale === 'en' ? 'ONE end-to-end deliverable' : '1 条端到端交付');
      expect(prompt).toContain(locale === 'en' ? 'never split by file' : '不按文件或技术层拆轮次');
      expect(prompt).toContain(locale === 'en' ? 'do not ask the user for permission to start' : '不要向用户索要开工确认');
      expect(prompt).not.toContain('Wait for plan approval');
      expect(prompt).not.toContain('等待计划审批');
      const reviewed = buildPlanningPrompt({ issue, locale, manualReview: true });
      expect(reviewed).toContain(locale === 'en' ? 'Wait for plan approval' : '等待计划审批');
      expect(reviewed).not.toContain(locale === 'en' ? 'continues automatically' : '系统自动接续');
      const team = buildTeamPrompt({ issue, subtasks: ['修复复制按钮'], branch: 'main', locale });
      expect(team).toContain(locale === 'en' ? 'do a single or tightly coupled deliverable yourself' : '单条或紧密关联的工作自己连续完成');
      const nudge = buildNudge({ issue, stage: 'planning', locale });
      expect(nudge).toContain(locale === 'en' ? 'Default to one complete deliverable' : '默认 1 条完整交付');
    });
  }
});


test('direct prompt preserves the bound report protocol within the injection budget', () => {
  for (const locale of ['en','zh-Hans','ru'] as const) {
    const p=buildDirectPrompt({issue:{id:9007199254740991,title:'x'.repeat(500),body:'x'.repeat(8000)},
      branch:'b'.repeat(250),docPath:'d'.repeat(160),feedback:'f'.repeat(5000),attempt:9007199254740991,locale});
    expect(p.length).toBeLessThanOrEqual(MAX_INJECT_CHARS);
    expect(p).toContain('ISSUE_READY:9007199254740991:9007199254740991');
    expect(p).toContain('optionalFollowUps');
  }
});

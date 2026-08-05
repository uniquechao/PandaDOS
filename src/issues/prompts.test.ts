import { describe, expect, test } from 'bun:test';
import { MAX_INJECT_CHARS } from '../executor/driver';
import {
  buildNudge,
  buildPlanningPrompt,
  buildReworkPrompt,
  buildSubtaskPrompt,
  buildTeamPrompt,
  buildTestingPrompt,
  imageReadHint,
  midTruncate,
} from './prompts';

const issue = { id: 42, title: '加导出功能', body: '支持 CSV 和 JSON' };

describe('prompt 模板与哨兵协议配套', () => {
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

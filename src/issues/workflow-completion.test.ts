import { expect, test } from 'bun:test';
import { workflowCompletionReport } from './workflow-completion';

test('workflow completion evidence distinguishes a passed gate from a policy skip', () => {
  const passed = workflowCompletionReport('objective', [], { outcome: 'passed', note: '' }, 'zh-Hans').report;
  const skipped = workflowCompletionReport('objective', [], { outcome: 'skipped', note: '' }, 'zh-Hans').report;
  expect(passed.completion).toContain('已通过');
  expect(skipped.completion).toContain('跳过');
  expect(skipped.verification).toContain('最终集成工作区门禁：已跳过');
  expect(workflowCompletionReport('objective', [], { outcome: 'skipped', note: '' }, 'en').report.completion)
    .toContain('skipped');
});

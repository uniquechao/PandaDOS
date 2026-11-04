import { describe, expect, test } from 'bun:test';
import { parseLocalPlan, MAX_PLAN_ISSUES } from './local-plan-format.mjs';

const task = { title: '任务', body: '## 原文\n```ts\nconst x = 1;\n```', acceptance: ['保留原文'] };
const file = (issues: unknown[], extra: object = {}) => `# 原文\n\n\`\`\`pandados-plan\n${JSON.stringify({ schemaVersion: 1, planId: 'test-plan', title: '计划', issues, ...extra }, null, 2)}\n\`\`\`\n`;

describe('offline local plan format', () => {
  test('tasks have only array positions, preserving user body and numbered prerequisites', () => {
    const plan = parseLocalPlan(file([task, { ...task, dependsOn: [1] }]));
    expect(plan.issues[0].body).toBe(task.body);
    expect(plan.issues.map(item => item.position)).toEqual([1, 2]);
    expect(plan.issues[1].dependsOn).toEqual([1]);
    expect(plan.issues[0]).not.toHaveProperty('key');
    expect(plan.issues[0].issueBody).toContain('- [ ] 保留原文');
    expect(parseLocalPlan(file([task]).replaceAll('\n', '\r\n')).issues).toHaveLength(1);
  });
  test('rejects preallocated keys, status, future schemas and duplicate machine blocks', () => {
    for (const item of [{ ...task, key: 'user-key' }, { ...task, id: '123' }, { ...task, status: 'pending' }]) {
      expect(() => parseLocalPlan(file([item]))).toThrow('unknown field');
    }
    expect(() => parseLocalPlan(file([task], { schemaVersion: 2 }))).toThrow('version');
    expect(() => parseLocalPlan(file([task]) + file([task]))).toThrow('exactly one');
  });
  test('rejects cycles, self edges, out-of-range references and string issue keys', () => {
    for (const issues of [[{ ...task, dependsOn: [1] }], [{ ...task, dependsOn: [2] }],
      [{ ...task, dependsOn: ['issue-id'] }], [{ ...task, dependsOn: [2] }, { ...task, dependsOn: [1] }],
      [task, { ...task, dependsOn: [1, 1] }]]) expect(() => parseLocalPlan(file(issues))).toThrow();
  });
  test('limits published body including criteria, issue count and unsafe identifiers', () => {
    expect(() => parseLocalPlan(file([{ ...task, body: 'x'.repeat(7999) }]))).toThrow('8000');
    expect(() => parseLocalPlan(file(Array.from({ length: MAX_PLAN_ISSUES + 1 }, () => task)))).toThrow('issues');
    expect(() => parseLocalPlan(file([task], { planId: '../escape' }))).toThrow('identifier');
    expect(() => parseLocalPlan(file([{ ...task, acceptance: [] }]))).toThrow('criteria');
  });
});

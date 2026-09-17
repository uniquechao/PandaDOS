import { describe, expect, test } from 'bun:test';
import {
  parseCompletionReportJson,
  serializeCompletionReport,
  type CompletionReport,
} from './completion-report';

const COMPLETE_REPORT: CompletionReport = {
  version: 1,
  outcome: 'complete',
  objective: '让测试开发服务可以通过独立域名访问',
  implementation: ['新增独立 systemd 服务', '配置 Nginx 与 TLS'],
  advantages: ['与正式服务隔离'],
  disadvantages: ['需要额外维护一套服务配置'],
  verification: ['健康检查返回 ok'],
  completion: '原始目标已经实现并验证。',
  unmetGoals: [],
  remainingWork: [],
  optionalFollowUps: [],
};

describe('结构化完成报告契约', () => {
  test('合法 v1 报告规范化后可稳定序列化并往返', () => {
    const raw = JSON.stringify({
      ...COMPLETE_REPORT,
      objective: `  ${COMPLETE_REPORT.objective}  `,
      implementation: [' 新增独立 systemd 服务 ', '配置 Nginx 与 TLS'],
    });

    const parsed = parseCompletionReportJson(raw);
    expect(parsed).toEqual(COMPLETE_REPORT);
    expect(parseCompletionReportJson(serializeCompletionReport(parsed!))).toEqual(COMPLETE_REPORT);
  });

  test('拒绝未知版本、缺失必填字段、未知完成程度及非字符串数组', () => {
    for (const value of [
      { ...COMPLETE_REPORT, version: 2 },
      { ...COMPLETE_REPORT, objective: '' },
      { ...COMPLETE_REPORT, outcome: 'mostly-complete' },
      { ...COMPLETE_REPORT, verification: [42] },
    ]) {
      expect(parseCompletionReportJson(JSON.stringify(value))).toBeNull();
    }
    expect(parseCompletionReportJson('{bad json')).toBeNull();
  });

  test('限制字段数量和长度，避免不受控报告进入 API 与数据库', () => {
    expect(parseCompletionReportJson(JSON.stringify({
      ...COMPLETE_REPORT,
      objective: 'x'.repeat(4001),
    }))).toBeNull();
    expect(parseCompletionReportJson(JSON.stringify({
      ...COMPLETE_REPORT,
      implementation: Array.from({ length: 51 }, () => 'x'),
    }))).toBeNull();
  });
});

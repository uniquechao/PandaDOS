import { describe, expect, test } from 'bun:test';
import { diagnosticData, issueStopState, redactDiagnostic, redactDiagnosticValue, type DiagnosticEvent } from './issue-diagnostics';

function events(...entries: Array<[string, Record<string, unknown>]>): DiagnosticEvent[] {
  return entries.map(([kind, data], i) => ({ id: i + 1, kind, dataJson: JSON.stringify(data), ts: 1000 + i }));
}

describe('停止事实与诊断', () => {
  test('实际长日志故障：验收失败触发系统暂停，保留检查、次数与失败名称', () => {
    const state = issueStopState('paused', false, events(
      ['validation_failed', { label: 'test', tail: '(fail) 真实失败名称\nError: expected 1' }],
      ['tests_failed', { failCount: 4 }],
      ['transition', { from: 'testing', to: 'paused', event: 'tests_failed' }],
    ));
    expect(state).toMatchObject({ kind: 'validation', stage: 'testing', failures: 4, stopLoss: true, label: 'test' });
    expect(state?.tail).toContain('(fail) 真实失败名称');
  });
  test('环境失败、止损、执行异常、澄清和外部受阻分别派生；不猜授权', () => {
    expect(issueStopState('paused', false, events(
      ['environment_preparation_failed', { note: 'bun install failed' }],
      ['transition', { from: 'testing', to: 'paused', event: 'pause' }],
    ))?.kind).toBe('environment');
    expect(issueStopState('paused', false, events(['transition', { from: 'implementing', to: 'paused', stopLoss: true }]))?.kind).toBe('budget');
    expect(issueStopState('paused', false, events(['transition', { from: 'implementing', to: 'paused', note: 'executor offline' }]))?.kind).toBe('paused');
    expect(issueStopState('implementing', true, [])?.kind).toBe('clarify');
    expect(issueStopState('blocked', false, [])?.kind).toBe('blocked');
  });
  test('正常返工显示修代码，恢复或完成后不拿旧失败解释新暂停', () => {
    const history = events(
      ['validation_failed', { label: 'typecheck' }],
      ['transition', { from: 'testing', to: 'implementing', event: 'tests_failed' }],
    );
    expect(issueStopState('implementing', false, history)?.kind).toBe('validation');
    expect(issueStopState('paused', false, [...history, ...events(['transition', { from: 'implementing', to: 'paused', event: 'pause' }]).map(e => ({ ...e, id: 3 }))])?.kind).toBe('paused');
    const resumed = [...history, { id: 3, kind: 'transition', dataJson: JSON.stringify({ event: 'unblock', to: 'testing' }), ts: 3 }];
    expect(issueStopState('testing', false, resumed)).toBeNull();
    expect(issueStopState('done', false, history)).toBeNull();
    expect(issueStopState('done', true, history)).toBeNull();
    expect(diagnosticData({ id: 1, ts: 1, kind: 'error', dataJson: '[]' })).toEqual({});
  });
  test('凭据脱敏保留错误和省略标记，结构化诊断仍可解析', () => {
    const raw = 'Error: expected 1\nAuthorization: Bearer abc123\nAPI_KEY=secret123\nhttps://user:pass@example.test\n…[前 100 字省略]…\n(fail) failure';
    const clean = redactDiagnostic(raw);
    for (const secret of ['abc123', 'secret123', 'user:pass']) expect(clean).not.toContain(secret);
    expect(clean).toContain('Error: expected 1');
    expect(clean).toContain('…[前 100 字省略]…');
    expect(clean).toContain('(fail) failure');
    const value = redactDiagnosticValue({ out: raw, argv: ['test', '--token', 'hidden'], password: 'hidden' });
    expect(JSON.stringify(value)).not.toContain('hidden');
    expect(diagnosticData({ id: 1, ts: 1, kind: 'x', dataJson: JSON.stringify(value) }).out).toContain('(fail) failure');
  });
});

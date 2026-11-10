import { describe, expect, test } from 'bun:test';
import { diagnosticData, issueStopState, redactDiagnostic, redactDiagnosticValue, type DiagnosticEvent } from './issue-diagnostics';

function events(...entries: Array<[string, Record<string, unknown>]>): DiagnosticEvent[] {
  return entries.map(([kind, data], i) => ({ id: i + 1, kind, dataJson: JSON.stringify(data), ts: 1000 + i }));
}

describe('停止事实与诊断', () => {
  test('实际分支错误不能被泛化暂停备注掩盖；重试仍保留已知的两个分支事实', () => {
    const state = issueStopState('paused', false, events(
      ['error', { where: 'validation-workspace', error: 'Error: 工作区分支发生变化，需恢复原分支' }],
      ['environment_preparation_failed', { note: 'Error: 工作区分支发生变化，需恢复原分支' }],
      ['transition', { from: 'testing', to: 'paused', event: 'pause', note: '执行工作区不可用，恢复后重试验证' }],
      ['error', { where: 'git-tip', error: '当前分支为 codex/prototype-baseline，issue 工作分支应为 panda/module-2-1' }],
      ['environment_recovery_failed', { note: 'Error: 工作区分支发生变化，需恢复原分支' }],
    ));
    expect(state?.cause).toMatchObject({ kind: 'branch', actualBranch: 'codex/prototype-baseline', expectedBranch: 'panda/module-2-1', eventId: 4 });
    expect(state?.stage).toBe('testing');
    expect(issueStopState('paused', false, events(['error', { code: 'workspace_branch_mismatch', actualBranch: 'actual', expectedBranch: 'expected' }]))?.cause)
      .toMatchObject({ kind: 'branch', actualBranch: 'actual', expectedBranch: 'expected' });
  });
  test('未知故障保留当前具体错误并脱敏，不猜授权；恢复或新错误不沿用旧分支原因', () => {
    const history = events(['error', { where: 'git-tip', error: '当前分支为 old，issue 工作分支应为 expected' }]);
    const current = [...history, ...events(
      ['environment_ready', {}],
      ['environment_preparation_failed', { note: 'install failed\nTOKEN=hidden' }],
      ['transition', { from: 'testing', to: 'paused', event: 'pause' }],
    ).map(e => ({ ...e, id: e.id + 1 }))];
    expect(issueStopState('paused', false, current)?.cause).toMatchObject({ kind: 'technical' });
    expect(issueStopState('paused', false, current)?.cause?.raw).not.toContain('hidden');
    expect(issueStopState('paused', false, [...history, { id: 2, kind: 'transition', dataJson: JSON.stringify({ event: 'unblock' }), ts: 2 }])?.cause).toBeNull();
    expect(issueStopState('paused', false, events(['error', { where: 'other', error: '当前分支为 old，issue 工作分支应为 expected' }]))?.cause?.kind).toBe('technical');
  });
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

test('超时接管停止后展示具体失败或预算原因，恢复后不沿用旧原因',()=>{
 for(const kind of ['timeout_takeover_failed','timeout_takeover_exhausted']) {
  const history=events(['transition',{event:'pause',to:'paused',from:'implementing',timeoutReason:'runtime'}],[kind,{note:'无法确认原进程停止，保留现场'}]);
  expect(issueStopState('paused',false,history)?.cause?.raw).toContain('无法确认原进程停止');
  expect(issueStopState('implementing',false,[...history,{id:3,kind:'transition',ts:3,dataJson:'{"event":"unblock"}'}])).toBeNull();
 }
 expect(issueStopState('paused',false,events(['validation_failed',{label:'test',tail:'命令超时'}],['transition',{event:'pause',to:'paused',timeoutReason:'validation'}]))).toMatchObject({kind:'validation',label:'test',tail:'命令超时'});
});

import { describe, expect, test } from 'bun:test';
import type { CompletionReport } from './completion-report';
import { decideCompletionReport, decideValidationGate } from './completion-policy';

const complete: CompletionReport = {
  version: 1, outcome: 'complete', objective: 'task', implementation: [], advantages: [],
  disadvantages: [], verification: [], completion: 'done', unmetGoals: [], remainingWork: [],
};

describe('completion policy', () => {
  test('missing report gets one repair chance, then pauses while preserving testing context', () => {
    expect(decideCompletionReport(null, true, true)).toEqual({ kind: 'retry' });
    expect(decideCompletionReport(null, true, false).kind).toBe('pause');
    expect(decideCompletionReport(null, false, false)).toEqual({ kind: 'validate' });
  });

  test('unmet goals cannot certify completion', () => {
    expect(decideCompletionReport(complete, true, false)).toEqual({ kind: 'validate' });
    expect(decideCompletionReport({ ...complete, remainingWork: ['repair'] }, true, false))
      .toEqual({ kind: 'work_remaining', note: 'repair；done' });
    expect(decideCompletionReport({ ...complete, outcome: 'blocked' }, true, false).kind).toBe('block');
  });

  test('gate execution error pauses, optional skip and pass advance, failure retries', () => {
    expect(decideValidationGate({ outcome: 'error', note: 'executor offline' }, 'sentinel')).toEqual({ event: 'pause', note: 'executor offline' });
    expect(decideValidationGate({ outcome: 'failed', note: 'tests failed' }, 'sentinel')).toEqual({ event: 'tests_failed', note: 'tests failed' });
    expect(decideValidationGate({ outcome: 'skipped', note: '' }, 'sentinel')).toEqual({ event: 'tests_passed' });
    expect(decideValidationGate({ outcome: 'passed', note: '' }, 'judge')).toEqual({ event: 'tests_passed', note: '空闲兜底：PM 判定已完成' });
  });
});

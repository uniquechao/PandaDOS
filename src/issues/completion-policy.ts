import type { CompletionReport } from './completion-report';

export type CompletionReportDecision =
  | { kind: 'retry' }
  | { kind: 'pause'; note: string }
  | { kind: 'block' | 'work_remaining'; note: string }
  | { kind: 'validate' };

/** Decide whether testing may enter final validation using persisted report facts only. */
export function decideCompletionReport(
  report: CompletionReport | null,
  requireReport: boolean,
  canRetry: boolean,
): CompletionReportDecision {
  if (!report) {
    if (!requireReport) return { kind: 'validate' };
    return canRetry ? { kind: 'retry' } : {
      kind: 'pause', note: '完成报告补报仍无效；保留现场，修复报告协议后继续验证',
    };
  }
  if (report.outcome === 'complete' && report.unmetGoals.length === 0 && report.remainingWork.length === 0) {
    return { kind: 'validate' };
  }
  return {
    kind: report.outcome === 'blocked' ? 'block' : 'work_remaining',
    note: [...report.unmetGoals, ...report.remainingWork, report.completion].join('；').slice(0, 1400),
  };
}

export type ValidationGateDecision =
  | { event: 'pause' | 'tests_failed'; note: string }
  | { event: 'tests_passed'; note?: string };

/** A skipped optional gate is permitted; an execution error is never a passing gate. */
export function decideValidationGate(
  gate: { outcome: 'passed' | 'failed' | 'skipped' | 'error'; note: string },
  source: 'sentinel' | 'judge',
): ValidationGateDecision {
  if (gate.outcome === 'error') return { event: 'pause', note: gate.note };
  if (gate.outcome === 'failed') return { event: 'tests_failed', note: gate.note };
  return { event: 'tests_passed', ...(source === 'judge' ? { note: '空闲兜底：PM 判定已完成' } : {}) };
}

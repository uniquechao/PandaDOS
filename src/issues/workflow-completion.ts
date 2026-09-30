import type { IssueWorkflowNodeRun } from '../core/types';
import type { CompletionReport } from './completion-report';
import { promptLanguage } from '../agents/prompts/language';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';

/** Build a factual report from durable node output and the final integrated-workspace gate. */
export function workflowCompletionReport(
  objective: string,
  runs: readonly IssueWorkflowNodeRun[],
  gate: { outcome: 'passed' | 'skipped' | 'failed' | 'error'; note: string },
  locale: SupportedLocale = DEFAULT_LOCALE,
): { report: CompletionReport; nodeRunIds: number[] } {
  const completed = runs.filter((run) => run.status === 'succeeded' && run.outputText?.trim());
  const incomplete = gate.outcome === 'failed' || gate.outcome === 'error';
  const english = promptLanguage(locale) === 'en';
  const gateLabel = english ? {
    passed: 'passed', skipped: 'skipped', failed: 'failed', error: 'unavailable',
  }[gate.outcome] : {
    passed: '已通过', skipped: '已跳过', failed: '未通过', error: '不可用',
  }[gate.outcome];
  let completion: string;
  if (incomplete) {
    completion = english
      ? 'Workflow nodes finished; final integrated workspace checks are not yet passing'
      : '工作流节点完成，最终集成工作区尚未通过门禁';
  } else if (gate.outcome === 'skipped') {
    completion = english
      ? 'Workflow nodes finished; final checks were skipped under the project policy'
      : '工作流节点完成，按项目策略跳过最终门禁';
  } else {
    completion = english
      ? 'Workflow nodes finished; final integrated workspace checks passed'
      : '工作流节点完成，最终集成工作区门禁已通过';
  }
  return {
    nodeRunIds: completed.map((run) => run.id),
    report: {
      version: 1,
      outcome: incomplete ? 'partial' : 'complete',
      objective: objective.slice(0, 4000),
      implementation: completed.slice(0, 50).map((run) =>
        `${run.nodeKey}: ${run.outputText!.trim()}`.slice(0, 1000)),
      advantages: [],
      disadvantages: [],
      verification: [`${english ? 'Final integrated workspace checks' : '最终集成工作区门禁'}：${gateLabel}${gate.note ? `；${gate.note}` : ''}`.slice(0, 1000)],
      completion,
      unmetGoals: [],
      remainingWork: incomplete ? [(gate.note || (english ? 'Final checks did not pass' : '最终门禁未通过')).slice(0, 1000)] : [],
    },
  };
}

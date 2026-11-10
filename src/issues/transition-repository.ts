import type { Database } from 'bun:sqlite';
import type { IssueState } from '../core/types';
import type { IssueId } from '../../shared/issue-id';
import type { IssueMachineEvent } from './machine';
import type { EngineIssue } from './engine';
import { isDeclaredAsyncFunction, isThenable } from './synchronous-callback';

export interface TransitionOptions {
  note?: string;
  failCount?: number;
  actor?: number;
  resumeState?: IssueState;
  stopLoss?: boolean;
  timeoutReason?: 'runtime'|'idle'|'validation'|'merge-agent'|'startup';
  /** Typed automatic incident; absence keeps manual pauses untouched. */
  supervisionReason?: 'merge-agent';
}

/** Only synchronous persistence operations belong in the SQLite transaction. */
export interface TransitionStorePort {
  casStatus(id: IssueId, from: IssueState, to: IssueState): boolean;
  logEvent(id: IssueId, kind: string, data: Record<string, unknown>): unknown;
  setCompletionReport(id: IssueId, report: null): void;
}

/** Atomic state, event and transition metadata persistence; no remote I/O or entry actions. */
export class IssueTransitionRepository {
  constructor(private readonly db: Database, private readonly store: TransitionStorePort) {}

  commit(input: {
    issueId: IssueId;
    from: IssueState;
    to: IssueState;
    event: IssueMachineEvent;
    options: TransitionOptions;
    fresh: EngineIssue;
    workflowStatus: () => string | null;
    finalizeDb?: () => void;
    finalize?: () => void;
  }): boolean {
    const { issueId, from, to, event, options, fresh, workflowStatus, finalizeDb, finalize } = input;
    for (const callback of [finalizeDb, finalize]) {
      if (callback && isDeclaredAsyncFunction(callback)) {
        throw new TypeError('transition finalizer must be synchronous');
      }
    }
    const runFinalizer = (callback?: () => void): void => {
      if (callback && isThenable(callback())) {
        throw new TypeError('transition finalizer must be synchronous');
      }
    };
    return this.db.transaction(() => {
      if (!this.store.casStatus(issueId, from, to)) return false;
      this.store.logEvent(issueId, 'transition', {
        event,
        from,
        to,
        ...(options.note ? { note: options.note.slice(0, 500) } : {}),
        ...(options.actor !== undefined ? { actor: options.actor } : {}),
        ...(options.stopLoss ? { stopLoss: true } : {}),
        ...(to==='paused'&&options.timeoutReason?{timeoutReason:options.timeoutReason}:{}),
        ...(to==='paused'&&options.supervisionReason?{supervisionReason:options.supervisionReason}:{}),
        ...((to === 'blocked' || to === 'paused') ? {
          resumeState: from,
          resumeContext: {
            subIndex: fresh.subIndex,
            convId: fresh.convId,
            branch: fresh.branch,
            targetBranch: fresh.targetBranch,
            sourceRef: fresh.sourceRef,
            workflowStatus: workflowStatus(),
          },
        } : {}),
        ...(event === 'unblock' && options.resumeState !== undefined ? { resumeState: options.resumeState } : {}),
      });
      if (event === 'request_plan' || (event === 'skip_clarifying' && fresh.executionMode === 'direct')) {
        this.db.run("UPDATE issues SET execution_mode = 'planned' WHERE id = ?", [issueId]);
      }
      if (event === 'start_direct' || event === 'request_plan' || event === 'skip_clarifying') {
        this.store.logEvent(issueId, 'execution_route', {
          mode: event === 'start_direct' ? 'direct' : 'planned', reason: options.note ?? event,
        });
      }
      if (to === 'implementing') {
        this.db.run('UPDATE issues SET completion_report_json = NULL WHERE id = ?', [issueId]);
      }
      if (event === 'unblock' && to === 'testing' && fresh.completionReport
        && (fresh.completionReport.outcome !== 'complete'
          || fresh.completionReport.unmetGoals.length > 0 || fresh.completionReport.remainingWork.length > 0)) {
        this.store.setCompletionReport(issueId, null);
      }
      runFinalizer(finalizeDb);
      runFinalizer(finalize);
      return true;
    })();
  }
}

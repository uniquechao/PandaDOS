import type { IssueId } from '../../shared/issue-id';
import type { EngineIssue, IssueStore } from './engine';
import { isBusy, pickNext } from './queue';

type SchedulingStore = Pick<IssueStore, 'listByProject' | 'listRunnableByProject' | 'lastEnterInfo'>;

/** Project queue eligibility and user pin precedence; no transitions or external effects. */
export class IssueSchedulingPolicy {
  constructor(
    private readonly store: SchedulingStore,
    private readonly isTransitionActive: (issueId: IssueId) => boolean,
  ) {}

  inputSubmitHeldBy(issue: EngineIssue, siblings: EngineIssue[]): boolean {
    return siblings.some((other) =>
      other.id !== issue.id && other.status === 'paused'
      && this.store.lastEnterInfo(other.id, 'paused')?.note?.startsWith('PANDA_INPUT_SUBMIT_UNCONFIRMED')
      && other.moduleId === issue.moduleId,
    );
  }

  runnable(projectId: number): EngineIssue[] {
    const siblings = this.store.listByProject(projectId);
    return this.store.listRunnableByProject(projectId).filter((issue) =>
      !this.isTransitionActive(issue.id) && !this.inputSubmitHeldBy(issue, siblings));
  }

  canConsumeUnblock(
    projectId: number,
    requestIssueId: IssueId,
    requestPinnedTs: number | null,
    preferModuleKey?: string,
  ): boolean {
    if (isBusy(this.store.listByProject(projectId)) || this.isTransitionActive(requestIssueId)) return false;
    const topPending = pickNext(this.runnable(projectId), preferModuleKey);
    return topPending?.pinnedTs == null
      || (requestPinnedTs !== null && requestPinnedTs >= topPending.pinnedTs);
  }
}

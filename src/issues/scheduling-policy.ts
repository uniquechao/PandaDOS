import type { IssueId } from '../../shared/issue-id';
import type { EngineIssue, IssueStore } from './engine';
import { isBusy, pickNext } from './queue';

type SchedulingStore = Pick<IssueStore, 'listByProject' | 'listRunnableByProject' | 'lastEnterInfo'>;

export interface ModuleSchedulingPorts {
  pick(candidates: EngineIssue[], siblings: EngineIssue[], preferred?: string): EngineIssue | undefined;
  canStart(issue: EngineIssue, siblings: EngineIssue[]): boolean;
}

/** Project queue eligibility and user pin precedence; no transitions or external effects. */
export class IssueSchedulingPolicy {
  constructor(
    private readonly store: SchedulingStore,
    private readonly isTransitionActive: (issueId: IssueId) => boolean,
    private readonly modules?: ModuleSchedulingPorts,
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

  pick(projectId: number, preferred?: string, deferred = new Set<IssueId>()): EngineIssue | undefined {
    const candidates = this.runnable(projectId).filter(issue => !deferred.has(issue.id));
    return this.modules
      ? this.modules.pick(candidates, this.store.listByProject(projectId), preferred)
      : pickNext(candidates, preferred);
  }

  canConsumeUnblock(
    projectId: number,
    requestIssueId: IssueId,
    requestPinnedTs: number | null,
    preferModuleKey?: string,
  ): boolean {
    if (this.isTransitionActive(requestIssueId)) return false;
    const siblings = this.store.listByProject(projectId);
    const request = siblings.find(issue => issue.id === requestIssueId);
    if (this.modules ? Boolean(request && !this.modules.canStart(request, siblings)) : isBusy(siblings)) return false;
    const topPending = this.pick(projectId, preferModuleKey);
    return topPending?.pinnedTs == null
      || (requestPinnedTs !== null && requestPinnedTs >= topPending.pinnedTs);
  }
}

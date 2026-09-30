import type { IssueId } from '../../shared/issue-id';
import type { ApplyResult, IssueStore, ScheduleNextOptions, ScheduleSource } from './engine';
import type { IssueSchedulingPolicy } from './scheduling-policy';
import { isBusy, moduleKeyOf, pickNext } from './queue';

type ScheduleStore = Pick<IssueStore,
  'get' | 'listByProject' | 'listPendingUnblockRequests' | 'logEvent'>;

export interface IssueSchedulerPorts {
  store: ScheduleStore;
  policy: IssueSchedulingPolicy;
  canSchedule: (projectId: number) => boolean;
  /** Implementations retain their existing issue-meta → transition → git lock order. */
  startIssue: (issueId: IssueId) => Promise<ApplyResult>;
  applyUnblock: (issueId: IssueId, guidance: string, actor?: number) => Promise<ApplyResult>;
  mergeModule: (projectId: number, moduleKey: string) => Promise<IssueId[]>;
  scheduleClarify: (issueId: IssueId) => void;
}

/**
 * Project-level scheduling flight. It decides which persisted intent wins and when to retry,
 * while state transitions, LLM merge and session/Git operations stay behind explicit ports.
 */
export class IssueScheduler {
  private readonly scheduling = new Set<number>();

  constructor(private readonly ports: IssueSchedulerPorts) {}

  async scheduleNext(projectId: number, opts: ScheduleNextOptions | string = {}): Promise<void> {
    if (!this.ports.canSchedule(projectId)) return;
    const options: ScheduleNextOptions = typeof opts === 'string' ? { preferModuleKey: opts } : opts;
    const source: ScheduleSource = options.source ?? 'relay';
    if (this.scheduling.has(projectId)) return;
    this.scheduling.add(projectId);
    const mergedHosts: IssueId[] = [];
    try {
      let preferred = options.preferModuleKey;
      for (;;) {
        if (!this.ports.canSchedule(projectId)) return;
        if (await this.consumeUnblockRequest(projectId, source, preferred)) return;
        if (!this.ports.canSchedule(projectId)) return;

        let next = pickNext(this.ports.policy.runnable(projectId), preferred);
        if (!next) return;
        const pickedModule = moduleKeyOf(next);
        mergedHosts.push(...(await this.ports.mergeModule(projectId, pickedModule)));
        if (!this.ports.canSchedule(projectId)) return;
        next = pickNext(this.ports.policy.runnable(projectId), pickedModule);
        if (!next) return;

        const beforeStatus = next.status;
        const result = await this.ports.startIssue(next.id);
        if (!result.ok) {
          if (result.deferral) {
            this.ports.store.logEvent(next.id, 'scheduling_deferred', {
              source, reason: result.deferral, issueId: next.id,
            });
          } else {
            this.ports.store.logEvent(next.id, 'error', {
              where: 'scheduleNext', source, error: result.error,
            });
          }
          return;
        }

        const projectIssues = this.ports.store.listByProject(projectId);
        if (isBusy(projectIssues)) return;
        const fresh = projectIssues.find((issue) => issue.id === next.id);
        if (!fresh || fresh.status === beforeStatus) {
          this.ports.store.logEvent(next.id, 'error', {
            where: 'scheduleNext', source,
            error: fresh ? `开跑后状态无进展（仍为 ${fresh.status}）` : '开跑后 issue 不存在',
          });
          return;
        }
        // startIssue can synchronously enter blocked and reenter scheduleNext. The outer flight
        // must keep going because its nested call was deliberately suppressed by the guard.
        preferred = pickedModule;
      }
    } finally {
      this.scheduling.delete(projectId);
      if (this.ports.canSchedule(projectId)) {
        for (const issueId of mergedHosts) this.ports.scheduleClarify(issueId);
      }
    }
  }

  private async consumeUnblockRequest(
    projectId: number, source: ScheduleSource, preferModuleKey?: string,
  ): Promise<boolean> {
    const [request] = this.ports.store.listPendingUnblockRequests(projectId);
    if (!request) return false;
    if (!this.ports.policy.canConsumeUnblock(
      projectId, request.issueId, this.ports.store.get(request.issueId)?.pinnedTs ?? null,
      preferModuleKey,
    )) return false;

    const result = await this.ports.applyUnblock(
      request.issueId, request.guidance, request.actor ?? undefined,
    );
    if (!result.ok) {
      this.ports.store.logEvent(request.issueId, 'scheduling_deferred', {
        source, reason: 'unblock-failed', issueId: request.issueId,
        error: result.error.slice(0, 200),
      });
      return false;
    }
    this.ports.store.logEvent(request.issueId, 'unblock_request_consumed', {
      source, requestedTs: request.ts,
    });
    return true;
  }
}

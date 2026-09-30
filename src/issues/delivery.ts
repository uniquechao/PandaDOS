import type { IssueEvent, IssueState } from '../core/types';

export interface IssueDelivery {
  /** `done` means local goal completion; remote delivery is tracked separately. */
  implementation: 'complete' | 'incomplete';
  commit: 'recorded' | 'unrecorded';
  commitSha: string | null;
  push: 'pushed' | 'failed' | 'skipped' | 'not_attempted';
  /** No general merge/deploy automation exists in this execution model. */
  merge: 'not_managed';
  deploy: 'not_managed';
}

/** Project delivery from durable events in the current execution attempt only. */
export function issueDelivery(status: IssueState, events: readonly IssueEvent[]): IssueDelivery {
  const reopened = events.reduce((last, event) => event.kind === 'reopened' ? Math.max(last, event.id) : last, 0);
  let commit: IssueDelivery['commit'] = 'unrecorded';
  let commitSha: string | null = null;
  let push: IssueDelivery['push'] = 'not_attempted';
  for (const event of events) {
    if (event.id <= reopened) continue;
    if (event.kind === 'auto_commit') commit = 'recorded';
    if (event.kind === 'impl_tip') {
      try {
        const sha = (JSON.parse(event.dataJson ?? '{}') as { sha?: unknown }).sha;
        if (typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)) commitSha = sha;
      } catch { /* A corrupt event cannot invent a commit reference. */ }
    }
    if (event.kind === 'auto_push') push = 'pushed';
    if (event.kind === 'auto_push_failed') push = 'failed';
    if (event.kind === 'push_skipped') push = 'skipped';
  }
  return {
    implementation: status === 'done' ? 'complete' : 'incomplete',
    commit,
    commitSha: commit === 'recorded' ? commitSha : null,
    push,
    merge: 'not_managed',
    deploy: 'not_managed',
  };
}

import type { IssueId } from '../../shared/issue-id';

/**
 * Serializes transition entry actions for one issue without serializing independent issues.
 * The first task starts in the caller's stack, before competing project-busy checks can run.
 */
export class IssueTransitionCoordinator {
  private readonly tails = new Map<IssueId, Promise<void>>();

  isActive(issueId: IssueId): boolean {
    // A queued transition still reserves this issue. There is a microtask gap between
    // one task's finally and the next task starting; `active` alone would miss it.
    return this.tails.has(issueId);
  }

  run<T>(issueId: IssueId, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(issueId);
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(issueId, tail);

    const execute = async (): Promise<T> => {
      return fn();
    };
    let result: Promise<T>;
    if (previous) result = previous.then(execute);
    else {
      try { result = execute(); }
      catch (error) { result = Promise.reject(error); }
    }
    void result.then(release, release);
    void tail.then(() => {
      if (this.tails.get(issueId) === tail) this.tails.delete(issueId);
    });
    return result;
  }
}

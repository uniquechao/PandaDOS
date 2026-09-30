import type { Project } from '../core/types';
import type { ExecutorDriver } from '../executor/driver';
import type { EngineIssue, IssueStore } from './engine';
import { clarifyPaths, clarifySessionName } from './clarify-runner';

type RecoveryStore = Pick<IssueStore, 'listDanglingClarify' | 'logEvent'>;

export interface ClarifyRecoveryPorts {
  store: RecoveryStore;
  project: (projectId: number) => Project | undefined;
  driverForProject: (project: Project) => ExecutorDriver;
  scheduleClarify: (issueId: EngineIssue['id']) => void;
}

/** Reconcile persisted dangling clarification attempts after in-memory analysis chains disappear. */
export class ClarifyRecoveryCoordinator {
  constructor(private readonly ports: ClarifyRecoveryPorts) {}

  async recover(): Promise<void> {
    for (const issue of this.ports.store.listDanglingClarify()) {
      if (issue.status === 'pending') {
        this.ports.scheduleClarify(issue.id);
        continue;
      }
      this.ports.store.logEvent(issue.id, 'clarify_discarded', { status: issue.status, via: 'recover' });
      const project = this.ports.project(issue.projectId);
      if (!project) continue;
      let driver: ExecutorDriver;
      try { driver = this.ports.driverForProject(project); }
      catch (error) {
        this.ports.store.logEvent(issue.id, 'error', { where: 'clarify-recovery-executor', error: String(error).slice(0, 200) });
        continue;
      }
      await driver.killSession(clarifySessionName(issue.id)).catch(() => {});
      await driver.removeTree(clarifyPaths(project.cwd, issue.id).scratch).catch(() => {});
    }
  }
}

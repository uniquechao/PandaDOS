/** An intentional domain prerequisite, not a failed environment preparation. */
export class WorkspaceExecutionDeferred extends Error {
  constructor() {
    super('workspace_execution_deferred');
    this.name = 'WorkspaceExecutionDeferred';
  }
}

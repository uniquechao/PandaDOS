import { parseIssueId } from '../../../shared/issue-id';
import { redactDiagnostic } from '../../../shared/issue-diagnostics';
import { InputSubmitUnconfirmedError } from '../../executor/driver';
import { WorktreeRequestError, type IssueWorktreeService, type WorktreeAction } from '../issue-worktree';
import { apiError } from '../errors';
import { json, type RouteDef } from '../middleware';

const fallback: Record<string, string> = {
  'worktree.not_found': 'This issue was not found.',
  'worktree.forbidden': 'Only a project owner or administrator can control this worktree.',
  'worktree.invalid_request': 'Check the message or worktree action and try again.',
  'worktree.stale': 'The active worktree or merge run changed. Refresh before taking action.',
  'worktree.agent_not_ready': 'The merge agent is not ready to receive input. Check its current state.',
  'worktree.operation_unconfirmed': 'The operation could not be confirmed. Check the evidence before retrying.',
};

export function issueWorktreeRoutes(service: IssueWorktreeService): RouteDef[] {
  const path = '/api/projects/:projectId/issues/:issueId/worktree';
  const handler = (kind: 'view' | 'chat' | 'action'): RouteDef['handler'] => async ({ req, params, user }) => {
    try {
      const issueId = parseIssueId(params.issueId);
      const projectId = Number(params.projectId);
      if (!issueId || !user || !Number.isSafeInteger(projectId) || projectId <= 0) throw new WorktreeRequestError('worktree.not_found', 404);
      if (kind === 'view') return json(await service.view(projectId, issueId, user));
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== 'object' || typeof body.requestId !== 'string')
        throw new WorktreeRequestError('worktree.invalid_request', 400);
      if (kind === 'chat') {
        if (typeof body.runId !== 'string' || typeof body.text !== 'string' || !body.text.trim() ||
            body.text.length > 1400 || !/^[\w-]{1,100}$/.test(body.requestId))
          throw new WorktreeRequestError('worktree.invalid_request', 400);
        await service.send(projectId, issueId, user, body.runId, body.requestId, body.text);
      } else {
        if (typeof body.attemptId !== 'string' || typeof body.action !== 'string')
          throw new WorktreeRequestError('worktree.invalid_request', 400);
        await service.action(projectId, issueId, user, body.attemptId, body.requestId, body.action as WorktreeAction);
      }
      return json({ ok: true });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const known = 'worktree.' + detail.replace(/^worktree_/, '');
      const code = error instanceof WorktreeRequestError ? error.code :
        error instanceof InputSubmitUnconfirmedError ? 'worktree.operation_unconfirmed' :
        known in fallback ? known : 'worktree.operation_unconfirmed';
      const status = error instanceof WorktreeRequestError ? error.status : 409;
      const cause = error instanceof WorktreeRequestError ? error.detail : detail;
      return json(apiError(code, fallback[code]!, status, {}, cause ? redactDiagnostic(cause).slice(0, 500) : undefined), status);
    }
  };
  return [
    { method: 'GET', path, auth: 'project-access', handler: handler('view') },
    { method: 'POST', path: path + '/merge-chat', auth: 'project-access', handler: handler('chat') },
    { method: 'POST', path: path + '/action', auth: 'project-access', handler: handler('action') },
  ];
}

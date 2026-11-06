import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { ISSUE_LIST_GROUPS, PAGED_ISSUE_GROUPS, type IssueListGroup, type IssueListPage, type IssueSummary } from '../../shared/issue-list';
import { BUSY_STATES, moduleKeyOf, orderPending } from './queue';
import { issueWorkspaceView } from '../core/workspace-ownership';

const COLUMNS = `i.id, i.project_id AS projectId, i.title, i.status, i.module,
  i.module_id AS moduleId, i.agent, i.created_ts AS createdTs, i.done_ts AS doneTs,
  i.pinned_ts AS pinnedTs, i.created_by AS createdBy, u.username AS createdByName, i.conv_id AS convId`;
export type IssueListObservation = Pick<IssueSummary, 'id' | 'status'> & { convId: string | null };
type ListRecord = IssueSummary & IssueListObservation;

/** Filters, counts and history LIMIT/OFFSET execute in SQLite, before reading task content. */
export function readIssueList(db: Database, projectId: number, group: IssueListGroup,
  requestedPage: number, pageSize: number, query: string,
  observe?: (issue: IssueListObservation) => Pick<IssueSummary, 'waitingInput' | 'awaitingClarify' | 'attentionKind'>,
): IssueListPage {
  return db.transaction(() => {
    const statuses = ISSUE_LIST_GROUPS[group];
    const clauses = [`i.project_id = ?`, `i.status IN (${statuses.map(() => '?').join(',')})`];
    const args: SQLQueryBindings[] = [projectId, ...statuses];
    const q = query.trim().toLowerCase();
    if (q) {
      // SQLite lower() is ASCII-only. Read only searchable metadata to preserve JS Unicode
      // folding and literal %, _, # semantics; counts and page extraction still happen in SQL.
      const idQuery = q.startsWith('#') ? q.slice(1) : q;
      const candidates = db.query<Pick<IssueSummary, 'id' | 'title' | 'module'>, SQLQueryBindings[]>(
        `SELECT i.id, i.title, i.module FROM issues i WHERE ${clauses.join(' AND ')}`,
      ).all(...args);
      const matches = candidates.filter(i => i.title.toLowerCase().includes(q) ||
        i.module.toLowerCase().includes(q) || (!!idQuery && i.id.includes(idQuery))).map(i => i.id);
      // A single JSON binding avoids SQLite's parameter-count limit on large result sets.
      clauses.push('i.id IN (SELECT value FROM json_each(?))');
      args.push(JSON.stringify(matches));
    }
    const where = clauses.join(' AND ');
    const total = db.query<{ n: number }, SQLQueryBindings[]>(`SELECT count(*) AS n FROM issues i WHERE ${where}`).get(...args)!.n;
    const paged = PAGED_ISSUE_GROUPS.includes(group);
    const page = paged ? Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize))) : 1;
    const naturalId = "CASE WHEN i.id NOT GLOB '*[^0-9]*' THEN 0 ELSE 1 END";
    const numericId = "CASE WHEN i.id NOT GLOB '*[^0-9]*' THEN CAST(i.id AS INTEGER) END";
    const order = paged
      ? `i.done_ts DESC, CASE WHEN i.done_ts IS NULL THEN i.created_ts END DESC, ${naturalId} DESC, ${numericId} DESC, i.id DESC`
      : `i.created_ts, ${naturalId}, ${numericId}, i.id`;
    const items = db.query<ListRecord, SQLQueryBindings[]>(
      `SELECT ${COLUMNS} FROM issues i LEFT JOIN users u ON u.id = i.created_by
       WHERE ${where} ORDER BY ${order}${paged ? ' LIMIT ? OFFSET ?' : ''}`,
    ).all(...args, ...(paged ? [pageSize, (page - 1) * pageSize] : []));
    if (group === 'todo') {
      const active = db.query<Pick<IssueSummary, 'module' | 'moduleId'>, SQLQueryBindings[]>(
        `SELECT module, module_id AS moduleId FROM issues WHERE project_id = ?
         AND status IN (${BUSY_STATES.map(() => '?').join(',')}) ORDER BY created_ts, id LIMIT 1`,
      ).get(projectId, ...BUSY_STATES);
      // Queue ranking must use all pending candidates, even while searching.
      const candidates = q ? db.query<IssueSummary, [number]>(
        `SELECT ${COLUMNS} FROM issues i LEFT JOIN users u ON u.id = i.created_by
         WHERE i.project_id = ? AND i.status = 'pending' ORDER BY i.created_ts, i.id`,
      ).all(projectId) : items;
      const orderIds = new Map(orderPending(candidates, active ? moduleKeyOf(active) : undefined).map((item, index) => [item.id, index]));
      items.sort((a, b) => orderIds.get(a.id)! - orderIds.get(b.id)!);
    }
    for (const item of items) {
      const w = issueWorkspaceView(db, item.id);
      item.workspace = w ? { cwd: w.cwd, branch: w.branch, computeHeld: w.computeHeld,
        retained: w.retained, integratedSha: w.integratedSha, reason: w.reason } : null;
    }
    const summaries = items.map(({ convId, ...item }) => ({
      ...item,
      ...(item.status === 'done' || item.status === 'cancelled'
        ? { attentionKind: 'none' as const }
        : observe?.({ id: item.id, status: item.status, convId })),
    }));
    return { items: summaries, total, page, pageSize: paged ? pageSize : null };
  })();
}

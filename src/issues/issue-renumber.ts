/**
 * issues/issue-renumber —— 给一条本地 issue 换编号（#307 跨实例同步撞号）。
 *
 * 场景：同步导入远端 issue 时沿用它的编号，但本地已有同编号、不同 sync_uid 的 issue——
 * 按约定由导入端给**本地这条**换号，再按原编号落远端那条。
 *
 * 换号在一个事务里完成：`defer_foreign_keys` 推迟外键检查到提交，主键与所有引用列同批改写。
 * - 引用列：外键指向 `issues(id)` 的列（按 schema 动态发现，新增表自动覆盖）+ 无外键的
 *   `ISSUE_ID_EXTRA_COLUMNS`（subscriptions 只改 scope='issue' 的行）。
 * - 过程页：`doc_path` 文件名前缀 `<旧号>-` 改成 `<新号>-`；磁盘上的旧文件由持久化 outbox
 *   按 `issue_renumbered.fromDocPath` 搬到新路径（见 web/project-data-persistence）。
 * - 分支：`branch` 列记的是真实存在的 git 分支，不改名；已开跑过却没记分支的，把隐含的
 *   `issue/<旧号>` 写进记录，免得默认分支名跟着新编号漂走、找不到原分支。未开跑的沿用新编号默认值。
 * - 执行中的 issue 不换号：代理上下文里的协议标记带着旧编号，换了会让哨兵永远对不上。
 */
import type { Database } from 'bun:sqlite';
import { ISSUE_ID_EXTRA_COLUMNS } from '../core/migrate';
import { newIssueId } from '../core/issue-id';
import type { IssueId } from '../../shared/issue-id';
import { BUSY_STATES } from './queue';

export class IssueRenumberBusyError extends Error {
  constructor(readonly issueId: IssueId) {
    super(`本地 issue #${issueId} 执行中，暂不能换编号，稍后同步重试`);
  }
}

function quoteIdent(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

/** 所有存放 issue 编号的 (表, 列)。 */
function issueIdColumns(db: Database): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const tables = db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'issues'",
  ).all().map((r) => r.name);
  for (const table of tables) {
    const fkColumns = db.query<{ table: string; from: string }, []>(`PRAGMA foreign_key_list(${quoteIdent(table)})`)
      .all().filter((fk) => fk.table === 'issues' && !/project_id$/.test(fk.from)).map((fk) => fk.from);
    for (const column of new Set([...fkColumns, ...(ISSUE_ID_EXTRA_COLUMNS[table] ?? [])])) {
      out.push({ table, column });
    }
  }
  return out;
}

/** `<dir>/<旧号>-slug.md` → `<dir>/<新号>-slug.md`；不是按编号命名的路径原样返回。 */
export function renumberedDocPath(docPath: string, from: IssueId, to: IssueId): string {
  const slash = docPath.lastIndexOf('/');
  const base = docPath.slice(slash + 1);
  return base.startsWith(`${from}-`) ? `${docPath.slice(0, slash + 1)}${to}-${base.slice(from.length + 1)}` : docPath;
}

/**
 * 把本地 issue `from` 换成 `to`（缺省生成新编号）。返回新编号。
 * 执行中抛 `IssueRenumberBusyError`；`to` 已被占用抛错（调用方负责先腾位）。
 */
export function renumberIssue(
  db: Database,
  from: IssueId,
  options: { to?: IssueId; reason: string; gen?: () => IssueId },
): IssueId {
  const run = db.transaction((): IssueId => {
    const row = db.query<{ status: string; doc_path: string | null; branch: string | null }, [IssueId]>(
      'SELECT status, doc_path, branch FROM issues WHERE id = ?',
    ).get(from);
    if (!row) throw new Error(`issue #${from} 不存在`);
    if (BUSY_STATES.includes(row.status as never)) throw new IssueRenumberBusyError(from);
    const taken = (id: IssueId) => !!db.query('SELECT 1 FROM issues WHERE id = ?').get(id);
    let to = options.to;
    if (to !== undefined) {
      if (taken(to)) throw new Error(`issue 编号 ${to} 已被占用`);
    } else {
      const gen = options.gen ?? newIssueId;
      for (let attempt = 0; attempt < 8 && (to === undefined || taken(to)); attempt++) to = gen();
      if (to === undefined || taken(to)) throw new Error('无法生成未占用的 issue 编号');
    }
    if (to === from) return to;

    db.run('PRAGMA defer_foreign_keys = ON');
    const docPath = row.doc_path ? renumberedDocPath(row.doc_path, from, to) : null;
    // 开跑过（非 pending）却没记分支：分支按旧编号默认名已建出，记下来防漂移
    const branch = row.branch ?? (row.status === 'pending' ? null : `issue/${from}`);
    db.query('UPDATE issues SET id = ?, doc_path = ?, branch = ? WHERE id = ?').run(to, docPath, branch, from);
    for (const { table, column } of issueIdColumns(db)) {
      const scope = table === 'subscriptions' ? " AND scope = 'issue'" : '';
      db.query(`UPDATE ${quoteIdent(table)} SET ${quoteIdent(column)} = ? WHERE ${quoteIdent(column)} = ?${scope}`)
        .run(to, from);
    }
    db.query('INSERT INTO issue_events (issue_id, kind, data_json, ts) VALUES (?, ?, ?, ?)').run(
      to,
      'issue_renumbered',
      JSON.stringify({ from, to, reason: options.reason, fromDocPath: row.doc_path, toDocPath: docPath }),
      Date.now(),
    );
    return to;
  });
  return run();
}

/** 该 issue 是否由 `from` 换号而来（用于识别协作目录里尚未搬走的旧过程页）。 */
export function wasRenumberedFrom(db: Database, issueId: IssueId, from: IssueId): boolean {
  return db.query<{ data_json: string | null }, [IssueId]>(
    "SELECT data_json FROM issue_events WHERE issue_id = ? AND kind = 'issue_renumbered'",
  ).all(issueId).some((e) => {
    try { return (JSON.parse(e.data_json ?? '{}') as { from?: unknown }).from === from; } catch { return false; }
  });
}

/** 最近一次换号前的过程页路径（持久化搬文件用）。 */
export function lastRenumberFromDocPath(db: Database, issueId: IssueId): { from: IssueId; fromDocPath: string } | null {
  const e = db.query<{ data_json: string | null }, [IssueId]>(
    "SELECT data_json FROM issue_events WHERE issue_id = ? AND kind = 'issue_renumbered' ORDER BY id DESC LIMIT 1",
  ).get(issueId);
  if (!e) return null;
  try {
    const d = JSON.parse(e.data_json ?? '{}') as { from?: unknown; fromDocPath?: unknown };
    return typeof d.from === 'string' && typeof d.fromDocPath === 'string' ? { from: d.from, fromDocPath: d.fromDocPath } : null;
  } catch {
    return null;
  }
}

/** Project-open and remote-executor polling coordinator for file-authoritative `.panda` data. */
import type { Database } from 'bun:sqlite';
import { createConversationProjectDataAdapters } from '../core/conversation-project-data';
import { PandaProjectSync, PandaSyncIndex, type PandaPullResult } from '../core/project-sync';
import type { Project } from '../core/types';
import { createDesignProjectDataAdapters } from '../designs/project-data-sync';
import type { ExecutorDriver } from '../executor/driver';
import { getProject } from '../issues/engine';
import { gitLockKey, type KeyedMutex } from '../issues/mutex';
import { createIssueProjectDataAdapters } from '../issues/project-data-sync';
import { createWorkflowProjectDataAdapter } from '../issues/workflow-project-data';

/**
 * `.panda` 轮询的单飞调度决策（纯函数，便于单测）。
 *
 * 两种拍子共用一个在途槽：快拍（每 5s，只轮没被 inotify 覆盖的项目）与安全网（每 60s，全量轮一遍，
 * 防 inotify 漏事件）。单飞守卫只能让一拍**推迟**，绝不能把安全网整个吞掉——生产实测过：
 * 安全网撞上在途的快轮询就被丢弃，间隔从 60s 变成 120s，兜底的意义也就没了。
 *
 * 所以安全网的诉求先记进 `fullDue`，等在途那次结束、下一拍（最多 5s）补上；快拍则可以安全丢弃，
 * 反正 5s 后还有一拍。
 */
export function decidePoll(
  state: { inFlight: boolean; fullDue: boolean },
  tick: 'fast' | 'full',
): { run: boolean; full: boolean; fullDue: boolean } {
  const fullDue = state.fullDue || tick === 'full';
  if (state.inFlight) return { run: false, full: false, fullDue };
  return { run: true, full: fullDue, fullDue: false };
}

export interface ProjectDataSyncStatus {
  state: 'never' | 'syncing' | 'success' | 'warning' | 'error';
  lastAttemptTs: number | null;
  lastSuccessTs: number | null;
  detectedUpdates: number;
  imported: number;
  archived: number;
  unchanged: number;
  conflicts: number;
  parseErrors: number;
  details: string[];
}

interface SyncStatusRow {
  state: ProjectDataSyncStatus['state']; last_attempt_ts: number; last_success_ts: number | null;
  detected_updates: number; imported_count: number; archived_count: number; unchanged_count: number;
  conflict_count: number; parse_error_count: number; details_json: string;
}

export class ProjectDataSyncCoordinator {
  private readonly active = new Map<number, Promise<PandaPullResult>>();

  constructor(
    private readonly db: Database,
    private readonly driverForProject: (project: Project) => ExecutorDriver,
    private readonly mutex: KeyedMutex,
    private readonly afterSync?: (projectId: number) => void | Promise<void>,
  ) {}

  sync(project: Project): Promise<PandaPullResult> {
    const running = this.active.get(project.id);
    if (running) return running;
    const started = Date.now();
    this.db.query(`INSERT INTO project_data_sync_status (project_id, state, last_attempt_ts)
      VALUES (?, 'syncing', ?) ON CONFLICT(project_id) DO UPDATE SET state = 'syncing', last_attempt_ts = excluded.last_attempt_ts`)
      .run(project.id, started);
    const task = this.mutex.runExclusive(gitLockKey(project.id), () => new PandaProjectSync(
        this.driverForProject(project),
        new PandaSyncIndex(this.db),
        [
          ...createIssueProjectDataAdapters(this.db),
          createWorkflowProjectDataAdapter(this.db),
          ...createDesignProjectDataAdapters(this.db),
          ...createConversationProjectDataAdapters(this.db),
        ],
      ).pull(project.id, project.cwd)).then(async (result) => {
      this.recordResult(project.id, result);
      await this.afterSync?.(project.id);
      return result;
    }).catch((error) => {
      this.recordFailure(project.id, error);
      throw error;
    }).finally(() => this.active.delete(project.id));
    this.active.set(project.id, task);
    return task;
  }

  status(projectId: number): ProjectDataSyncStatus {
    const row = this.db.query<SyncStatusRow, [number]>(
      'SELECT * FROM project_data_sync_status WHERE project_id = ?',
    ).get(projectId);
    if (!row) return { state: 'never', lastAttemptTs: null, lastSuccessTs: null, detectedUpdates: 0,
      imported: 0, archived: 0, unchanged: 0, conflicts: 0, parseErrors: 0, details: [] };
    let details: string[] = [];
    try { details = JSON.parse(row.details_json) as string[]; } catch { details = []; }
    return { state: row.state, lastAttemptTs: row.last_attempt_ts, lastSuccessTs: row.last_success_ts,
      detectedUpdates: row.detected_updates, imported: row.imported_count, archived: row.archived_count,
      unchanged: row.unchanged_count, conflicts: row.conflict_count, parseErrors: row.parse_error_count, details };
  }

  private errors(projectId: number): string[] {
    const fromPull = this.db.query<{ error: string | null }, [number]>(
      `SELECT error FROM project_data_sync_entries WHERE project_id = ? AND state = 'error' AND error IS NOT NULL ORDER BY updated_ts DESC LIMIT 20`,
    ).all(projectId).flatMap((row) => row.error ? [row.error] : []);
    const fromWrites = this.db.query<{ last_error: string | null }, [number]>(
      `SELECT last_error FROM project_data_outbox WHERE project_id = ? AND last_error IS NOT NULL ORDER BY updated_ts DESC LIMIT 20`,
    ).all(projectId).flatMap((row) => row.last_error ? [row.last_error] : []);
    return [...new Set([...fromPull, ...fromWrites])].slice(0, 20);
  }

  private recordResult(projectId: number, result: PandaPullResult): void {
    const now = Date.now();
    const details = this.errors(projectId);
    const conflicts = details.filter((detail) => /conflict|冲突/i.test(detail)).length;
    const parseErrors = Math.max(result.errors, details.length - conflicts);
    const state = conflicts || parseErrors ? 'warning' : 'success';
    this.db.query(`UPDATE project_data_sync_status SET state = ?, last_attempt_ts = ?,
      last_success_ts = CASE WHEN ? = 'success' THEN ? ELSE last_success_ts END,
      detected_updates = ?, imported_count = ?, archived_count = ?, unchanged_count = ?,
      conflict_count = ?, parse_error_count = ?, details_json = ? WHERE project_id = ?`)
      .run(state, now, state, now, result.imported + result.archived + result.errors,
        result.imported, result.archived, result.unchanged, conflicts, parseErrors,
        JSON.stringify(details), projectId);
  }

  private recordFailure(projectId: number, error: unknown): void {
    const detail = String(error).slice(0, 1000);
    this.db.query(`UPDATE project_data_sync_status SET state = 'error', last_attempt_ts = ?,
      detected_updates = 0, imported_count = 0, archived_count = 0, unchanged_count = 0,
      conflict_count = ?, parse_error_count = ?, details_json = ? WHERE project_id = ?`)
      .run(Date.now(), /conflict|冲突/i.test(detail) ? 1 : 0, /conflict|冲突/i.test(detail) ? 0 : 1,
        JSON.stringify([detail]), projectId);
  }

  async syncById(projectId: number): Promise<PandaPullResult | null> {
    const project = getProject(this.db, projectId);
    return project ? this.sync(project) : null;
  }

  /**
   * 轮询所有 active 项目。`include` 用来把已被 inotify 覆盖的项目排除在密集轮询之外
   * （见 `ProjectDataWatcher`）——事件驱动负责及时性，慢轮询负责兜底，两者节奏不同。
   * 不传 = 全都轮，行为与以前一致。
   */
  async pollActive(include?: (projectId: number) => boolean): Promise<{ projects: number; errors: number }> {
    const projects = this.db.query<{ id: number }, []>(
      "SELECT id FROM projects WHERE status = 'active' ORDER BY id",
    ).all().filter(({ id }) => include?.(id) ?? true);
    let errors = 0;
    await Promise.all(projects.map(async ({ id }) => {
      try { errors += (await this.syncById(id))?.errors ?? 0; } catch { errors += 1; }
    }));
    return { projects: projects.length, errors };
  }
}

/** Transactional outbox for reliable SQLite-to-`.panda` projections. */
import type { Database } from 'bun:sqlite';
import type { PandaProjectSync } from './project-sync';

export type ProjectDataAction = 'upsert' | 'archive';

export interface ProjectDataOutboxJob {
  id: number;
  projectId: number;
  entityKind: string;
  entityId: string;
  action: ProjectDataAction;
  attemptCount: number;
  nextAttemptTs: number;
  lastError: string | null;
}

interface JobRow {
  id: number;
  project_id: number;
  entity_kind: string;
  entity_id: string;
  action: string;
  attempt_count: number;
  next_attempt_ts: number;
  last_error: string | null;
}

export interface ProjectDataOutboxHandler {
  persist(job: ProjectDataOutboxJob): void | Promise<void>;
}

export interface JsonProjectionTarget {
  sync: PandaProjectSync;
  cwd: string;
  path: string;
  value: unknown;
  expectedFingerprint: string | null;
}

/** Concrete JSON projection outlet; CAS conflicts are failures and therefore stay queued for retry. */
export class JsonProjectDataOutboxHandler implements ProjectDataOutboxHandler {
  constructor(
    private readonly resolve: (job: ProjectDataOutboxJob) => JsonProjectionTarget | Promise<JsonProjectionTarget>,
  ) {}

  async persist(job: ProjectDataOutboxJob): Promise<void> {
    const target = await this.resolve(job);
    const result = await target.sync.writeJson(
      target.cwd, target.path, target.value, target.expectedFingerprint,
    );
    if (result.status === 'conflict') throw new Error(`协作文件并发冲突：${target.path}`);
  }
}

export interface ProjectDataTriggerSpec {
  table: string;
  kind: string;
  idColumn?: string;
  projectColumn?: string;
  /** SQL expression evaluated against NEW; true means the durable projection is archived. */
  archivedWhen?: string;
}

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * Install domain triggers after their migration chain has created the referenced tables.
 * Trigger writes participate in the caller's transaction, so rollback cannot leave a phantom job.
 */
export function ensureProjectDataOutboxTriggers(
  db: Database,
  specs: readonly ProjectDataTriggerSpec[],
): void {
  const exists = db.query<{ n: number }, []>(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'project_data_outbox'",
  ).get()!.n > 0;
  if (!exists) return;
  for (const spec of specs) {
    const id = spec.idColumn ?? 'id';
    const project = spec.projectColumn ?? 'project_id';
    if (![spec.table, id, project].every((value) => IDENTIFIER.test(value)) || !IDENTIFIER.test(spec.kind)) {
      throw new Error('非法协作持久化触发器配置');
    }
    const action = spec.archivedWhen ? `CASE WHEN ${spec.archivedWhen} THEN 'archive' ELSE 'upsert' END` : "'upsert'";
    for (const event of ['INSERT', 'UPDATE'] as const) {
      const name = `trg_${spec.table}_project_data_${event.toLowerCase()}`;
      db.run(`CREATE TRIGGER IF NOT EXISTS ${name} AFTER ${event} ON ${spec.table} BEGIN
        INSERT INTO project_data_outbox
          (project_id, entity_kind, entity_id, action, attempt_count, next_attempt_ts,
           last_error, created_ts, updated_ts)
        VALUES (NEW.${project}, '${spec.kind}', CAST(NEW.${id} AS TEXT), ${action}, 0, 0,
                NULL, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000)
        ON CONFLICT(project_id, entity_kind, entity_id) DO UPDATE SET
          action = excluded.action, attempt_count = 0, next_attempt_ts = 0,
          last_error = NULL, updated_ts = excluded.updated_ts;
      END`);
    }
  }
}

function mapJob(row: JobRow): ProjectDataOutboxJob {
  return {
    id: row.id,
    projectId: row.project_id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    action: row.action === 'archive' ? 'archive' : 'upsert',
    attemptCount: row.attempt_count,
    nextAttemptTs: row.next_attempt_ts,
    lastError: row.last_error,
  };
}

export class ProjectDataPersistenceOutbox {
  constructor(
    private readonly db: Database,
    private readonly handlers: ReadonlyMap<string, ProjectDataOutboxHandler>,
    private readonly now: () => number = Date.now,
  ) {}

  enqueue(projectId: number, entityKind: string, entityId: string | number, action: ProjectDataAction): void {
    const now = this.now();
    this.db.query(`INSERT INTO project_data_outbox
      (project_id, entity_kind, entity_id, action, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, entity_kind, entity_id) DO UPDATE SET
        action = excluded.action, attempt_count = 0, next_attempt_ts = 0,
        last_error = NULL, updated_ts = excluded.updated_ts`)
      .run(projectId, entityKind, String(entityId), action, now, now);
  }

  pending(projectId?: number): ProjectDataOutboxJob[] {
    const rows = projectId === undefined
      ? this.db.query<JobRow, []>('SELECT * FROM project_data_outbox ORDER BY id').all()
      : this.db.query<JobRow, [number]>('SELECT * FROM project_data_outbox WHERE project_id = ? ORDER BY id').all(projectId);
    return rows.map(mapJob);
  }

  /** Drain committed jobs. Failures remain durable and are retried with bounded exponential backoff. */
  async drain(limit = 100): Promise<{ persisted: number; failed: number; remaining: number }> {
    const now = this.now();
    const jobs = this.db.query<JobRow, [number, number]>(
      'SELECT * FROM project_data_outbox WHERE next_attempt_ts <= ? ORDER BY id LIMIT ?',
    ).all(now, Math.max(1, Math.min(limit, 1000))).map(mapJob);
    let persisted = 0;
    let failed = 0;
    for (const job of jobs) {
      const handler = this.handlers.get(job.entityKind);
      try {
        if (!handler) throw new Error(`未注册协作持久化处理器：${job.entityKind}`);
        await handler.persist(job);
        this.db.query('DELETE FROM project_data_outbox WHERE id = ?').run(job.id);
        persisted += 1;
      } catch (error) {
        const attempts = job.attemptCount + 1;
        const delay = Math.min(60 * 60_000, 1_000 * 2 ** Math.min(attempts - 1, 12));
        this.db.query(`UPDATE project_data_outbox
          SET attempt_count = ?, next_attempt_ts = ?, last_error = ?, updated_ts = ? WHERE id = ?`)
          .run(attempts, now + delay, String(error).slice(0, 1000), now, job.id);
        failed += 1;
      }
    }
    const remaining = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM project_data_outbox').get()!.n;
    return { persisted, failed, remaining };
  }
}

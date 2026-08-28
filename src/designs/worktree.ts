import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { GitResult } from '../executor/driver';
import { gitLockKey, type KeyedMutex } from '../issues/mutex';

export type DesignExecutionMode = 'current' | 'worktree';
export type DesignExecutionLifecycle =
  | 'intent'
  | 'creating'
  | 'ready'
  | 'executing'
  | 'archived'
  | 'cleanup_blocked'
  | 'cleaning'
  | 'cleaned'
  | 'recoverable_error';

export interface DesignExecutionRun {
  id: string;
  projectId: number;
  designId: number;
  publicationId: number | null;
  revision: number;
  graphDigest: string;
  idempotencyKey: string;
  executionMode: DesignExecutionMode;
  lifecycleState: DesignExecutionLifecycle;
  assignmentActive: boolean;
  baseRef: string | null;
  baseSha: string | null;
  worktreeBranch: string | null;
  worktreeCwd: string | null;
  observedHeadSha: string | null;
  observedUpstream: string | null;
  observedAhead: number | null;
  observedBehind: number | null;
  errorCode: string | null;
  errorDetail: string | null;
  createdTs: number;
  updatedTs: number;
  archivedTs: number | null;
  cleanedTs: number | null;
}

export interface DesignWorktreeProject {
  id: number;
  cwd: string;
}

export interface DesignWorktreePublication {
  id: number;
  projectId: number;
  designId: number;
  revision: number;
  graphDigest: string;
  status: 'committed' | 'post_commit_pending' | 'complete' | 'recoverable_error';
}

export interface DesignWorktreeApprovedDesign {
  projectId: number;
  designId: number;
  revision: number;
  graphDigest: string;
}

export interface DesignWorktreeActor {
  userId: number;
  actorKey: string;
}

export interface DesignWorktreeDriver {
  git(cwd: string, args: string[]): Promise<GitResult>;
  mkdirp(path: string): Promise<void>;
  statPath(path: string): Promise<{
    size: number;
    mtimeMs: number;
    isDirectory: boolean;
    isFile: boolean;
    mode: number;
  } | null>;
  readlink(path: string): Promise<string | null>;
}

type MaybePromise<T> = T | Promise<T>;

export interface DesignWorktreeServiceDeps {
  store: DesignWorktreeStore;
  mutex: KeyedMutex;
  projectLookup(projectId: number): MaybePromise<DesignWorktreeProject | null>;
  approvedDesignLookup(
    projectId: number,
    designId: number,
    revision: number,
    graphDigest: string,
  ): MaybePromise<DesignWorktreeApprovedDesign | null>;
  publicationLookup(publicationId: number): MaybePromise<DesignWorktreePublication | null>;
  authorizeOwner(actor: DesignWorktreeActor, project: DesignWorktreeProject): MaybePromise<boolean>;
  driverForProject(project: DesignWorktreeProject): DesignWorktreeDriver;
  publicationHasBusyIssues(publicationId: number): MaybePromise<boolean>;
  idFactory?: () => string;
  now?: () => number;
  checkpoint?: (point: DesignWorktreeCheckpoint) => MaybePromise<void>;
}

export type DesignWorktreeCheckpoint =
  | 'after_reserve'
  | 'after_creating'
  | 'after_mkdir'
  | 'before_add'
  | 'after_add'
  | 'before_ready'
  | 'after_cleanup_intent'
  | 'after_remove'
  | 'before_cleanup_finalize';

export interface CreateDesignWorktreeInput {
  projectId: number;
  designId: number;
  revision: number;
  graphDigest: string;
  idempotencyKey: string;
  executionMode?: DesignExecutionMode;
  baseRef?: string;
}

export interface DesignWorktreeMutationInput {
  projectId: number;
  designId: number;
  publicationId: number;
}

export type DesignWorktreeErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'PROJECT_NOT_FOUND'
  | 'PUBLICATION_MISMATCH'
  | 'RUN_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'BASE_INVALID'
  | 'REPOSITORY_INVALID'
  | 'WORKTREE_COLLISION'
  | 'WORKTREE_MISSING'
  | 'WORKTREE_MISMATCH'
  | 'WORKTREE_LOCKED'
  | 'RUN_NOT_READY'
  | 'RUN_BUSY'
  | 'WORKTREE_DIRTY'
  | 'UPSTREAM_MISSING'
  | 'WORKTREE_UNPUSHED'
  | 'CLEANUP_FAILED'
  | 'RECOVERY_REQUIRED';

export class DesignWorktreeError extends Error {
  constructor(readonly code: DesignWorktreeErrorCode, message: string) {
    super(message);
    this.name = 'DesignWorktreeError';
  }

  toJSON(): Record<string, string> {
    return { name: this.name, code: this.code };
  }
}

interface DesignExecutionRunRow {
  id: string;
  project_id: number;
  design_task_id: number;
  publication_id: number | null;
  approved_revision: number;
  graph_digest: string;
  idempotency_key: string;
  execution_mode: DesignExecutionMode;
  lifecycle_state: DesignExecutionLifecycle;
  assignment_active: number;
  base_ref: string | null;
  base_sha: string | null;
  worktree_branch: string | null;
  worktree_cwd: string | null;
  observed_head_sha: string | null;
  observed_upstream: string | null;
  observed_ahead: number | null;
  observed_behind: number | null;
  error_code: string | null;
  error_detail: string | null;
  created_ts: number;
  updated_ts: number;
  archived_ts: number | null;
  cleaned_ts: number | null;
}

function mapRun(row: DesignExecutionRunRow): DesignExecutionRun {
  return {
    id: row.id,
    projectId: row.project_id,
    designId: row.design_task_id,
    publicationId: row.publication_id,
    revision: row.approved_revision,
    graphDigest: row.graph_digest,
    idempotencyKey: row.idempotency_key,
    executionMode: row.execution_mode,
    lifecycleState: row.lifecycle_state,
    assignmentActive: row.assignment_active === 1,
    baseRef: row.base_ref,
    baseSha: row.base_sha,
    worktreeBranch: row.worktree_branch,
    worktreeCwd: row.worktree_cwd,
    observedHeadSha: row.observed_head_sha,
    observedUpstream: row.observed_upstream,
    observedAhead: row.observed_ahead,
    observedBehind: row.observed_behind,
    errorCode: row.error_code,
    errorDetail: row.error_detail,
    createdTs: row.created_ts,
    updatedTs: row.updated_ts,
    archivedTs: row.archived_ts,
    cleanedTs: row.cleaned_ts,
  };
}

export interface ReserveDesignExecutionRun {
  id: string;
  projectId: number;
  designId: number;
  publicationId: number | null;
  revision: number;
  graphDigest: string;
  idempotencyKey: string;
  executionMode: DesignExecutionMode;
  lifecycleState: DesignExecutionLifecycle;
  assignmentActive: boolean;
  baseRef: string | null;
  baseSha: string | null;
  worktreeBranch: string | null;
  worktreeCwd: string | null;
  createdTs: number;
  updatedTs: number;
}

/** Normalized SQLite boundary for publication-bound execution runs. */
export class DesignWorktreeStore {
  constructor(private readonly db: Database) {}

  reserve(input: ReserveDesignExecutionRun): DesignExecutionRun {
    const row = this.db.query<DesignExecutionRunRow, [
      string, number, number, number | null, number, string, string, DesignExecutionMode,
      DesignExecutionLifecycle, number, string | null, string | null, string | null,
      string | null, number, number,
    ]>(`INSERT INTO design_execution_runs
      (id, project_id, design_task_id, publication_id, approved_revision, graph_digest,
       idempotency_key, execution_mode, lifecycle_state, assignment_active, base_ref, base_sha,
       worktree_branch, worktree_cwd, created_ts, updated_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *`).get(
      input.id,
      input.projectId,
      input.designId,
      input.publicationId,
      input.revision,
      input.graphDigest,
      input.idempotencyKey,
      input.executionMode,
      input.lifecycleState,
      input.assignmentActive ? 1 : 0,
      input.baseRef,
      input.baseSha,
      input.worktreeBranch,
      input.worktreeCwd,
      input.createdTs,
      input.updatedTs,
    );
    if (!row) throw new DesignWorktreeError('RUN_CONFLICT', 'Execution run could not be reserved.');
    return mapRun(row);
  }

  reserveOrRead(input: ReserveDesignExecutionRun): { run: DesignExecutionRun; created: boolean } {
    try {
      return { run: this.reserve(input), created: true };
    } catch {
      const candidate = this.getByBatch(input.designId, input.revision, input.graphDigest)
        ?? this.getByIdempotencyKey(input.projectId, input.idempotencyKey);
      if (candidate && sameReservation(candidate, input)) return { run: candidate, created: false };
      throw new DesignWorktreeError('RUN_CONFLICT', 'The immutable design tuple already has a different execution decision.');
    }
  }

  getByIdempotencyKey(projectId: number, idempotencyKey: string): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, string]>(
      'SELECT * FROM design_execution_runs WHERE project_id = ? AND idempotency_key = ?',
    ).get(projectId, idempotencyKey);
    return row ? mapRun(row) : null;
  }

  getById(id: string): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [string]>(
      'SELECT * FROM design_execution_runs WHERE id = ?',
    ).get(id);
    return row ? mapRun(row) : null;
  }

  getByPublication(publicationId: number): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number]>(
      'SELECT * FROM design_execution_runs WHERE publication_id = ?',
    ).get(publicationId);
    return row ? mapRun(row) : null;
  }

  getByBatch(designId: number, revision: number, graphDigest: string): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, number, string]>(
      `SELECT * FROM design_execution_runs
       WHERE design_task_id = ? AND approved_revision = ? AND graph_digest = ?`,
    ).get(designId, revision, graphDigest);
    return row ? mapRun(row) : null;
  }

  /** Publisher guard: it must run inside the same synchronous Issue/publication transaction. */
  requirePublishableIntentInTransaction(
    designId: number,
    revision: number,
    graphDigest: string,
  ): DesignExecutionRun {
    if (!this.db.inTransaction) throw new Error('design execution intent check requires the shared active transaction');
    const run = this.getByBatch(designId, revision, graphDigest);
    if (!run
      || run.publicationId !== null
      || run.lifecycleState !== 'ready'
      || run.errorCode !== null
      || (run.executionMode === 'worktree' && (!run.worktreeCwd || !run.worktreeBranch || !run.observedHeadSha))) {
      throw new DesignWorktreeError('RUN_NOT_READY', 'The approved execution workspace is not ready for publication.');
    }
    return run;
  }

  /** Atomically binds the already-created publication to its exact immutable ready intent. */
  bindPublicationInTransaction(input: {
    projectId: number;
    designId: number;
    publicationId: number;
    revision: number;
    graphDigest: string;
    updatedTs: number;
  }): DesignExecutionRun {
    if (!this.db.inTransaction) throw new Error('design execution publication binding requires the shared active transaction');
    this.requirePublishableIntentInTransaction(input.designId, input.revision, input.graphDigest);
    const row = this.db.query<DesignExecutionRunRow, [number, number, number, number, string, number, number]>(
      `UPDATE design_execution_runs
       SET publication_id = ?, updated_ts = ?
       WHERE design_task_id = ? AND approved_revision = ? AND graph_digest = ?
         AND publication_id IS NULL AND lifecycle_state = 'ready'
         AND EXISTS (
           SELECT 1 FROM design_publications publication
           WHERE publication.id = ?
             AND publication.project_id = ?
             AND publication.design_task_id = design_execution_runs.design_task_id
             AND publication.revision = design_execution_runs.approved_revision
             AND publication.graph_digest = design_execution_runs.graph_digest
         )
       RETURNING *`,
    ).get(
      input.publicationId,
      input.updatedTs,
      input.designId,
      input.revision,
      input.graphDigest,
      input.publicationId,
      input.projectId,
    );
    if (!row) throw new DesignWorktreeError('PUBLICATION_MISMATCH', 'Publication does not match the ready execution intent.');
    return mapRun(row);
  }

  getByDesign(projectId: number, designId: number): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, number]>(
      `SELECT * FROM design_execution_runs
       WHERE project_id = ? AND design_task_id = ?
       ORDER BY created_ts DESC, id DESC LIMIT 1`,
    ).get(projectId, designId);
    return row ? mapRun(row) : null;
  }

  /** Publication projection target: the one live assignment, never merely the newest historical run. */
  getActiveByDesign(projectId: number, designId: number): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, number]>(
      `SELECT * FROM design_execution_runs
       WHERE project_id = ? AND design_task_id = ? AND assignment_active = 1
       LIMIT 1`,
    ).get(projectId, designId);
    return row ? mapRun(row) : null;
  }

  listRecoverable(limit = 100): DesignExecutionRun[] {
    const bounded = Math.max(1, Math.min(500, Math.trunc(limit)));
    return this.db.query<DesignExecutionRunRow, [number]>(
      `SELECT * FROM design_execution_runs
       WHERE execution_mode = 'worktree'
         AND (
           lifecycle_state IN ('intent', 'creating', 'cleaning')
           OR assignment_active = 1
         )
       ORDER BY project_id, created_ts, id LIMIT ?`,
    ).all(bounded).map(mapRun);
  }

  transition(
    id: string,
    from: readonly DesignExecutionLifecycle[],
    to: DesignExecutionLifecycle,
    input: {
      assignmentActive?: boolean;
      updatedTs: number;
      archivedTs?: number | null;
      cleanedTs?: number | null;
      errorCode?: string | null;
      errorDetail?: string | null;
    },
  ): DesignExecutionRun | null {
    if (from.length === 0) return null;
    const placeholders = from.map(() => '?').join(', ');
    const row = this.db.query<DesignExecutionRunRow, Array<string | number | null>>(
      `UPDATE design_execution_runs
       SET lifecycle_state = ?,
           assignment_active = COALESCE(?, assignment_active),
           archived_ts = COALESCE(?, archived_ts),
           cleaned_ts = COALESCE(?, cleaned_ts),
           error_code = ?, error_detail = ?, updated_ts = ?
       WHERE id = ? AND lifecycle_state IN (${placeholders})
       RETURNING *`,
    ).get(
      to,
      input.assignmentActive === undefined ? null : input.assignmentActive ? 1 : 0,
      input.archivedTs ?? null,
      input.cleanedTs ?? null,
      input.errorCode ?? null,
      input.errorDetail ?? null,
      input.updatedTs,
      id,
      ...from,
    );
    return row ? mapRun(row) : null;
  }

  observe(id: string, input: {
    headSha: string;
    upstream?: string | null;
    ahead?: number | null;
    behind?: number | null;
    updatedTs: number;
  }): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [
      string, string | null, number | null, number | null, number, string,
    ]>(`UPDATE design_execution_runs
      SET observed_head_sha = ?, observed_upstream = ?, observed_ahead = ?, observed_behind = ?,
          error_code = NULL, error_detail = NULL, updated_ts = ?
      WHERE id = ? RETURNING *`).get(
      input.headSha,
      input.upstream ?? null,
      input.ahead ?? null,
      input.behind ?? null,
      input.updatedTs,
      id,
    );
    return row ? mapRun(row) : null;
  }

  markRecoveryFailure(id: string, input: {
    code: DesignWorktreeErrorCode;
    detail: string;
    updatedTs: number;
  }): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [string, string, number, string]>(
      `UPDATE design_execution_runs
       SET lifecycle_state = CASE WHEN assignment_active = 1 THEN lifecycle_state ELSE 'recoverable_error' END,
           cleaned_ts = NULL, error_code = ?, error_detail = ?, updated_ts = ?
       WHERE id = ? RETURNING *`,
    ).get(input.code, input.detail, input.updatedTs, id);
    return row ? mapRun(row) : null;
  }

  markActiveRecoveryPending(id: string, updatedTs: number): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, string]>(
      `UPDATE design_execution_runs
       SET error_code = 'RECOVERY_REQUIRED',
           error_detail = 'Active execution workspace is awaiting startup verification.',
           updated_ts = ?
       WHERE id = ? AND execution_mode = 'worktree' AND assignment_active = 1
         AND lifecycle_state = 'executing'
       RETURNING *`,
    ).get(updatedTs, id);
    return row ? mapRun(row) : null;
  }

  markAllActiveRecoveryPending(updatedTs: number): number {
    return this.db.query(
      `UPDATE design_execution_runs
       SET error_code = 'RECOVERY_REQUIRED',
           error_detail = 'Active execution workspace is awaiting startup verification.',
           updated_ts = ?
       WHERE execution_mode = 'worktree' AND assignment_active = 1
         AND lifecycle_state = 'executing'`,
    ).run(updatedTs).changes;
  }

  clearActiveRecoveryPending(id: string, updatedTs: number): DesignExecutionRun | null {
    const row = this.db.query<DesignExecutionRunRow, [number, string]>(
      `UPDATE design_execution_runs
       SET error_code = NULL, error_detail = NULL, updated_ts = ?
       WHERE id = ? AND execution_mode = 'worktree' AND assignment_active = 1
         AND lifecycle_state = 'executing' AND error_code = 'RECOVERY_REQUIRED'
       RETURNING *`,
    ).get(updatedTs, id);
    return row ? mapRun(row) : null;
  }
}

export interface WorktreeObservation {
  path: string;
  head: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

const HEX_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_PORCELAIN_BYTES = 2 * 1024 * 1024;

/** Strict parser for `git worktree list --porcelain`; paths may contain spaces. */
export function parseWorktreePorcelain(output: string): WorktreeObservation[] {
  if (Buffer.byteLength(output, 'utf8') > MAX_PORCELAIN_BYTES || output.includes('\0') || output.includes('\r')) {
    throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
  }
  const observations: WorktreeObservation[] = [];
  const blocks = output.trim().length === 0 ? [] : output.trimEnd().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n');
    if (!lines[0]?.startsWith('worktree ')) {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
    }
    const path = lines[0].slice('worktree '.length);
    let head: string | null = null;
    let branch: string | null = null;
    let detached = false;
    let locked = false;
    let prunable = false;
    for (const line of lines.slice(1)) {
      if (line.startsWith('HEAD ')) {
        if (head !== null || !HEX_OBJECT_ID.test(line.slice(5))) {
          throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
        }
        head = line.slice(5);
      } else if (line.startsWith('branch ')) {
        if (branch !== null || !line.slice(7).startsWith('refs/heads/')) {
          throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
        }
        branch = line.slice(7);
      } else if (line === 'detached') detached = true;
      else if (line === 'locked' || line.startsWith('locked ')) locked = true;
      else if (line === 'prunable' || line.startsWith('prunable ')) prunable = true;
      else throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
    }
    if (!path || !posix.isAbsolute(path) || head === null || (branch === null) === !detached) {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Git worktree metadata is invalid.');
    }
    observations.push({ path: posix.normalize(path), head, branch, detached, locked, prunable });
  }
  return observations;
}

function validPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validStableKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function validBaseRef(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 255
    && (value.startsWith('refs/heads/') || value.startsWith('refs/remotes/'))
    && !/[\u0000-\u0020\u007f~^:?*[\\]/.test(value)
    && !value.includes('..')
    && !value.endsWith('.')
    && !value.endsWith('/');
}

function branchFor(projectId: number, designId: number): string {
  return `codex/design-${projectId}-${designId}`;
}

function pathFor(repoTop: string, projectId: number, designId: number): string {
  const top = posix.normalize(repoTop);
  if (!posix.isAbsolute(top) || top === '/') {
    throw new DesignWorktreeError('REPOSITORY_INVALID', 'Repository root is invalid.');
  }
  const path = posix.join(posix.dirname(top), '.panda-worktrees', `design-${projectId}-${designId}`);
  const relative = posix.relative(top, path);
  if (!posix.isAbsolute(path) || path === top || (!relative.startsWith('..') && !posix.isAbsolute(relative))) {
    throw new DesignWorktreeError('REPOSITORY_INVALID', 'Managed worktree path must be outside the repository.');
  }
  return path;
}

function requireOk(result: GitResult, code: DesignWorktreeErrorCode, message: string): string {
  if (result.code !== 0) throw new DesignWorktreeError(code, message);
  return result.out.trim();
}

function exactRunMatch(run: DesignExecutionRun, input: CreateDesignWorktreeInput, mode: DesignExecutionMode): boolean {
  return run.projectId === input.projectId
    && run.designId === input.designId
    && run.revision === input.revision
    && run.graphDigest === input.graphDigest
    && run.idempotencyKey === input.idempotencyKey
    && run.executionMode === mode
    && (mode === 'current' || run.baseRef === input.baseRef);
}

function sameReservation(run: DesignExecutionRun, input: ReserveDesignExecutionRun): boolean {
  return run.projectId === input.projectId
    && run.designId === input.designId
    && run.publicationId === input.publicationId
    && run.revision === input.revision
    && run.graphDigest === input.graphDigest
    && run.idempotencyKey === input.idempotencyKey
    && run.executionMode === input.executionMode
    && run.baseRef === input.baseRef
    && run.baseSha === input.baseSha
    && run.worktreeBranch === input.worktreeBranch
    && run.worktreeCwd === input.worktreeCwd;
}

export class DesignWorktreeService {
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(private readonly deps: DesignWorktreeServiceDeps) {
    this.idFactory = deps.idFactory ?? randomUUID;
    this.now = deps.now ?? Date.now;
  }

  getRun(projectId: number, designId: number): DesignExecutionRun | null {
    return this.deps.store.getByDesign(projectId, designId);
  }

  async create(input: CreateDesignWorktreeInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun> {
    this.validateCreate(input, actor);
    const { project, approved } = await this.authorize(input, actor);
    const mode = input.executionMode ?? 'current';
    const existing = this.deps.store.getByBatch(input.designId, input.revision, input.graphDigest);
    if (existing) {
      if (!exactRunMatch(existing, input, mode)) {
        throw new DesignWorktreeError('RUN_CONFLICT', 'The publication already has a different execution run.');
      }
      if (mode === 'current') return this.requireReplayable(existing);
      return await this.deps.mutex.runExclusive(gitLockKey(project.id), async () =>
        await this.continueCreationLocked(existing, project, this.deps.driverForProject(project), false));
    }
    if (mode === 'current') {
      const ts = this.now();
      const reservation = this.deps.store.reserveOrRead({
          id: this.idFactory(), projectId: project.id, designId: approved.designId,
          publicationId: null, revision: approved.revision,
          graphDigest: approved.graphDigest, idempotencyKey: input.idempotencyKey,
          executionMode: 'current', lifecycleState: 'ready', assignmentActive: false,
          baseRef: null, baseSha: null, worktreeBranch: null, worktreeCwd: null,
          createdTs: ts, updatedTs: ts,
        });
      return this.requireReplayable(reservation.run);
    }
    return await this.deps.mutex.runExclusive(gitLockKey(project.id), async () => {
      const raced = this.deps.store.getByBatch(input.designId, input.revision, input.graphDigest);
      if (raced) {
        if (!exactRunMatch(raced, input, mode)) throw new DesignWorktreeError('RUN_CONFLICT', 'Execution run conflict.');
        return await this.continueCreationLocked(raced, project, this.deps.driverForProject(project), false);
      }
      const driver = this.deps.driverForProject(project);
      const repoTop = requireOk(
        await driver.git(project.cwd, ['rev-parse', '--show-toplevel']),
        'REPOSITORY_INVALID',
        'Project is not a valid Git worktree.',
      );
      // Git may canonicalize a symlinked system prefix (/var -> /private/var on macOS), so string
      // equality with the persisted cwd is not a reliable top-level proof.  --show-prefix is
      // evaluated by Git in that cwd and is empty only at the repository root.
      const repoPrefix = requireOk(
        await driver.git(project.cwd, ['rev-parse', '--show-prefix']),
        'REPOSITORY_INVALID',
        'Project is not a valid Git worktree.',
      );
      if (!posix.isAbsolute(repoTop) || repoPrefix !== '') {
        throw new DesignWorktreeError('REPOSITORY_INVALID', 'Project cwd must be the repository top-level.');
      }
      if (!input.baseRef || !validBaseRef(input.baseRef)) {
        throw new DesignWorktreeError('BASE_INVALID', 'Base ref is invalid.');
      }
      requireOk(
        await driver.git(project.cwd, ['check-ref-format', input.baseRef]),
        'BASE_INVALID',
        'Base ref is invalid.',
      );
      const baseSha = requireOk(
        await driver.git(project.cwd, ['rev-parse', '--verify', '--quiet', `${input.baseRef}^{commit}`]),
        'BASE_INVALID',
        'Base ref does not resolve to a commit.',
      );
      if (!HEX_OBJECT_ID.test(baseSha)) throw new DesignWorktreeError('BASE_INVALID', 'Resolved base is invalid.');
      const worktreeBranch = branchFor(project.id, input.designId);
      const worktreeCwd = pathFor(repoTop, project.id, input.designId);
      const managedParent = posix.dirname(worktreeCwd);
      const repoParent = posix.dirname(repoTop);
      const [repoStat, repoLink, repoParentStat, repoParentLink, managedLink, occupied] = await Promise.all([
        driver.statPath(repoTop),
        driver.readlink(repoTop),
        driver.statPath(repoParent),
        driver.readlink(repoParent),
        driver.readlink(managedParent),
        driver.statPath(worktreeCwd),
      ]);
      if (!repoStat?.isDirectory
        || repoLink !== null
        || !repoParentStat?.isDirectory
        || repoParentLink !== null
        || managedLink !== null
        || occupied !== null) {
        throw new DesignWorktreeError('WORKTREE_COLLISION', 'Managed worktree path is not safe to create.');
      }
      const ts = this.now();
      const reservation = this.deps.store.reserveOrRead({
        id: this.idFactory(), projectId: project.id, designId: input.designId,
        publicationId: null, revision: approved.revision,
        graphDigest: approved.graphDigest, idempotencyKey: input.idempotencyKey,
        executionMode: 'worktree', lifecycleState: 'intent', assignmentActive: false,
        baseRef: input.baseRef, baseSha, worktreeBranch, worktreeCwd,
        createdTs: ts, updatedTs: ts,
      });
      if (reservation.created) await this.checkpoint('after_reserve');
      if (!reservation.created) return this.requireReplayable(reservation.run);
      return await this.continueCreationLocked(reservation.run, project, driver, false);
    });
  }

  async inspect(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun> {
    const { project } = await this.authorizeMutation(input, actor);
    const run = this.requireRun(input);
    if (run.executionMode === 'current') return run;
    return await this.deps.mutex.runExclusive(gitLockKey(project.id), async () =>
      await this.reconcileLocked(run, project, this.deps.driverForProject(project), false));
  }

  async execute(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun> {
    const { project, publication } = await this.authorizeMutation(input, actor);
    if (publication.status !== 'complete') throw new DesignWorktreeError('RUN_NOT_READY', 'Publication is not complete.');
    let run = this.requireRun(input);
    if (run.errorCode !== null) {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution workspace health must be recovered before execution can continue.');
    }
    if (run.lifecycleState === 'executing') return run;
    if (run.lifecycleState !== 'ready') throw new DesignWorktreeError('RUN_NOT_READY', 'Execution run is not ready.');
    if (run.executionMode === 'worktree') {
      run = await this.deps.mutex.runExclusive(gitLockKey(project.id), async () =>
        await this.reconcileLocked(run, project, this.deps.driverForProject(project), false));
    }
    const transitioned = this.deps.store.transition(run.id, ['ready'], 'executing', {
      assignmentActive: run.executionMode === 'worktree', updatedTs: this.now(),
    });
    if (!transitioned) throw new DesignWorktreeError('RUN_NOT_READY', 'Execution run changed concurrently.');
    return transitioned;
  }

  async archive(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun> {
    await this.authorizeMutation(input, actor);
    const run = this.requireRun(input);
    if (run.lifecycleState === 'archived' || run.lifecycleState === 'cleaned') return run;
    if (await this.deps.publicationHasBusyIssues(input.publicationId)) {
      throw new DesignWorktreeError('RUN_BUSY', 'Linked issues are still active.');
    }
    const transitioned = this.deps.store.transition(
      run.id,
      ['ready', 'executing', 'cleanup_blocked', 'recoverable_error'],
      'archived',
      { assignmentActive: false, archivedTs: this.now(), updatedTs: this.now() },
    );
    if (!transitioned) throw new DesignWorktreeError('RUN_BUSY', 'Execution run cannot be archived.');
    return transitioned;
  }

  async clean(input: DesignWorktreeMutationInput, actor: DesignWorktreeActor): Promise<DesignExecutionRun> {
    const { project } = await this.authorizeMutation(input, actor);
    let run = this.requireRun(input);
    if (run.lifecycleState === 'cleaned') return run;
    if (run.lifecycleState !== 'archived'
      && run.lifecycleState !== 'cleanup_blocked'
      && run.lifecycleState !== 'cleaning') {
      throw new DesignWorktreeError('RUN_NOT_READY', 'Execution run must be archived before cleanup.');
    }
    if (await this.deps.publicationHasBusyIssues(input.publicationId)) {
      throw new DesignWorktreeError('RUN_BUSY', 'Linked issues are still active.');
    }
    if (run.executionMode === 'current') {
      const cleaned = this.deps.store.transition(run.id, ['archived', 'cleanup_blocked'], 'cleaned', {
        assignmentActive: false, cleanedTs: this.now(), updatedTs: this.now(),
      });
      if (!cleaned) throw new DesignWorktreeError('CLEANUP_FAILED', 'Cleanup state changed concurrently.');
      return cleaned;
    }
    return await this.deps.mutex.runExclusive(gitLockKey(project.id), async () =>
      run.lifecycleState === 'cleaning'
        ? await this.recoverCleaningLocked(run, project, this.deps.driverForProject(project))
        : await this.cleanLocked(run, project, this.deps.driverForProject(project)));
  }

  async recoverAll(options: {
    limit?: number;
    overallTimeoutMs?: number;
    signal?: AbortSignal;
  } = {}): Promise<{ inspected: number; recovered: number; failed: number }> {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
    const timeoutMs = Math.max(1, Math.min(60_000, Math.trunc(options.overallTimeoutMs ?? 5_000)));
    const controller = new AbortController();
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) controller.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', abort, { once: true });
    const deadline = setTimeout(() => controller.abort(new DOMException('worktree recovery deadline', 'TimeoutError')), timeoutMs);
    const signal = controller.signal;
    const wait = async <T>(operation: Promise<T>): Promise<T> => {
      if (signal.aborted) throw signal.reason;
      let onAbort!: () => void;
      const stopped = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const value = await Promise.race([operation, stopped]);
        if (signal.aborted) throw signal.reason;
        return value;
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    };
    const guardedDriver = (driver: DesignWorktreeDriver): DesignWorktreeDriver => ({
      git: (cwd, args) => wait(driver.git(cwd, args)),
      mkdirp: (path) => wait(driver.mkdirp(path)),
      statPath: (path) => wait(driver.statPath(path)),
      readlink: (path) => wait(driver.readlink(path)),
    });
    const summary = { inspected: 0, recovered: 0, failed: 0 };
    // The scan limit must never make a later active assignment look healthy without inspection.
    // Mark all active worktrees fail-closed in one bounded DB statement, then clear only rows
    // proven healthy inside this recovery budget.
    this.deps.store.markAllActiveRecoveryPending(this.now());
    for (const candidate of this.deps.store.listRecoverable(limit)) {
      if (signal.aborted) break;
      const run = candidate.lifecycleState === 'executing' && candidate.assignmentActive
        ? this.deps.store.markActiveRecoveryPending(candidate.id, this.now()) ?? candidate
        : candidate;
      summary.inspected++;
      try {
        const project = await wait(Promise.resolve(this.deps.projectLookup(run.projectId)));
        if (!project || project.id !== run.projectId) throw new DesignWorktreeError('PROJECT_NOT_FOUND', 'Project is unavailable.');
        const reconciled = await wait(this.deps.mutex.runExclusive(gitLockKey(project.id), async () => {
          if (signal.aborted) throw signal.reason;
          const driver = guardedDriver(this.deps.driverForProject(project));
          if (run.lifecycleState === 'intent' || run.lifecycleState === 'creating') {
            return await this.continueCreationLocked(run, project, driver, true);
          }
          if (run.lifecycleState === 'cleaning') return await this.recoverCleaningLocked(run, project, driver);
          if (run.lifecycleState === 'cleaned') {
            const observations = parseWorktreePorcelain(requireOk(
              await driver.git(project.cwd, ['worktree', 'list', '--porcelain']),
              'RECOVERY_REQUIRED', 'Unable to inspect Git worktrees.',
            ));
            if (observations.some((item) => item.path === run.worktreeCwd)) {
              return this.recoveryFailure(run, 'CLEANUP_FAILED');
            }
            return run;
          }
          return await this.reconcileLocked(run, project, driver, false);
        }));
        if ((run.lifecycleState === 'intent' || run.lifecycleState === 'creating') && reconciled.lifecycleState === 'ready') summary.recovered++;
        if (run.lifecycleState === 'cleaning' && reconciled.lifecycleState === 'cleaned') summary.recovered++;
        if (run.lifecycleState === 'executing' && run.assignmentActive
          && reconciled.lifecycleState === 'executing' && reconciled.errorCode === 'RECOVERY_REQUIRED') {
          this.deps.store.clearActiveRecoveryPending(run.id, this.now());
          summary.recovered++;
        }
      } catch {
        if (signal.aborted) break;
        summary.failed++;
      }
    }
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', abort);
    return summary;
  }

  private async checkpoint(point: DesignWorktreeCheckpoint): Promise<void> {
    await this.deps.checkpoint?.(point);
  }

  private requireReplayable(run: DesignExecutionRun): DesignExecutionRun {
    if (run.errorCode !== null || !['ready', 'executing'].includes(run.lifecycleState)) {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution run requires recovery before replay.');
    }
    return run;
  }

  private async continueCreationLocked(
    initial: DesignExecutionRun,
    project: DesignWorktreeProject,
    driver: DesignWorktreeDriver,
    allowRecoverCreating: boolean,
  ): Promise<DesignExecutionRun> {
    if (initial.errorCode !== null || initial.lifecycleState === 'recoverable_error') {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution run requires owner recovery.');
    }
    if (initial.lifecycleState === 'ready' || initial.lifecycleState === 'executing') return initial;
    if (initial.lifecycleState !== 'intent' && initial.lifecycleState !== 'creating') {
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution run cannot continue creation.');
    }
    if (initial.lifecycleState === 'creating' && !allowRecoverCreating) {
      const inspected = await this.inspectCreatingLocked(initial, project, driver);
      if (inspected) return inspected;
      throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution run creation is still in progress or requires startup recovery.');
    }
    if (!initial.worktreeCwd || !initial.worktreeBranch || !initial.baseSha) {
      return this.recoveryFailure(initial, 'RECOVERY_REQUIRED');
    }
    const worktreeCwd = initial.worktreeCwd;
    const worktreeBranch = initial.worktreeBranch;
    const baseSha = initial.baseSha;
    let run = initial;
    if (run.lifecycleState === 'intent') {
      const claimed = this.deps.store.transition(run.id, ['intent'], 'creating', { updatedTs: this.now() });
      if (!claimed) return this.requireReplayable(this.deps.store.getById(run.id) ?? run);
      run = claimed;
      await this.checkpoint('after_creating');
    }
    const managedParent = posix.dirname(worktreeCwd);
    await driver.mkdirp(managedParent);
    await this.checkpoint('after_mkdir');
    const [parentStat, parentLink] = await Promise.all([
      driver.statPath(managedParent), driver.readlink(managedParent),
    ]);
    if (!parentStat?.isDirectory || parentLink !== null) {
      this.failRun(run.id, 'WORKTREE_COLLISION');
      throw new DesignWorktreeError('WORKTREE_COLLISION', 'Managed worktree parent is not safe.');
    }
    const before = parseWorktreePorcelain(requireOk(
      await driver.git(project.cwd, ['worktree', 'list', '--porcelain']),
      'RECOVERY_REQUIRED', 'Unable to inspect Git worktrees.',
    ));
    const exact = before.find((item) => item.path === worktreeCwd);
    if (exact) return await this.reconcileLocked(run, project, driver, true);
    if (before.some((item) => item.branch === `refs/heads/${worktreeBranch}`)) {
      this.failRun(run.id, 'WORKTREE_COLLISION');
      throw new DesignWorktreeError('WORKTREE_COLLISION', 'The managed branch is already registered elsewhere.');
    }
    await this.checkpoint('before_add');
    const add = await driver.git(project.cwd, [
      'worktree', 'add', '--no-track', '-b', worktreeBranch, worktreeCwd, baseSha,
    ]);
    if (add.code !== 0) {
      this.failRun(run.id, 'WORKTREE_COLLISION');
      throw new DesignWorktreeError('WORKTREE_COLLISION', 'Git refused to create the managed worktree.');
    }
    await this.checkpoint('after_add');
    return await this.reconcileLocked(run, project, driver, true);
  }

  private async inspectCreatingLocked(
    run: DesignExecutionRun,
    project: DesignWorktreeProject,
    driver: DesignWorktreeDriver,
  ): Promise<DesignExecutionRun | null> {
    const observations = parseWorktreePorcelain(requireOk(
      await driver.git(project.cwd, ['worktree', 'list', '--porcelain']),
      'RECOVERY_REQUIRED', 'Unable to inspect Git worktrees.',
    ));
    return observations.some((item) => item.path === run.worktreeCwd)
      ? await this.reconcileLocked(run, project, driver, true)
      : null;
  }

  private async recoverCleaningLocked(
    run: DesignExecutionRun,
    project: DesignWorktreeProject,
    driver: DesignWorktreeDriver,
  ): Promise<DesignExecutionRun> {
    const observations = parseWorktreePorcelain(requireOk(
      await driver.git(project.cwd, ['worktree', 'list', '--porcelain']),
      'RECOVERY_REQUIRED', 'Unable to inspect Git worktrees.',
    ));
    if (!observations.some((item) => item.path === run.worktreeCwd)) {
      return this.finalizeCleanup(run);
    }
    return await this.cleanLocked(run, project, driver);
  }

  private async cleanLocked(
    initial: DesignExecutionRun,
    project: DesignWorktreeProject,
    driver: DesignWorktreeDriver,
  ): Promise<DesignExecutionRun> {
    let run = initial.lifecycleState === 'cleaning'
      ? initial
      : await this.reconcileLocked(initial, project, driver, false);
    if (run.lifecycleState === 'recoverable_error') {
      throw new DesignWorktreeError('WORKTREE_MISMATCH', 'Managed worktree is not healthy.');
    }
    const cwd = run.worktreeCwd!;
    const status = await driver.git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal']);
    if (status.code !== 0 || status.out.length !== 0) return this.cleanupFailure(run, 'WORKTREE_DIRTY');
    const upstream = await driver.git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
    const upstreamRef = upstream.out.trim();
    if (upstream.code !== 0
      || upstreamRef.length > 512
      || !upstreamRef.startsWith('refs/remotes/')
      || /[\u0000-\u001f\u007f]/.test(upstreamRef)) return this.cleanupFailure(run, 'UPSTREAM_MISSING');
    const ahead = await driver.git(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
    const aheadCount = /^\d+$/.test(ahead.out.trim()) ? Number(ahead.out.trim()) : Number.NaN;
    if (ahead.code !== 0 || !Number.isSafeInteger(aheadCount) || aheadCount !== 0) {
      return this.cleanupFailure(run, 'WORKTREE_UNPUSHED');
    }
    const behind = await driver.git(cwd, ['rev-list', '--count', 'HEAD..@{upstream}']);
    const behindCount = /^\d+$/.test(behind.out.trim()) ? Number(behind.out.trim()) : Number.NaN;
    if (behind.code !== 0 || !Number.isSafeInteger(behindCount)) return this.cleanupFailure(run, 'CLEANUP_FAILED');
    const branch = requireOk(
      await driver.git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
      'WORKTREE_MISMATCH', 'Managed worktree branch is invalid.',
    );
    const head = requireOk(
      await driver.git(cwd, ['rev-parse', '--verify', 'HEAD']),
      'WORKTREE_MISMATCH', 'Managed worktree HEAD is invalid.',
    );
    if (branch !== run.worktreeBranch
      || !HEX_OBJECT_ID.test(head)
      || head !== run.observedHeadSha) return this.cleanupFailure(run, 'WORKTREE_MISMATCH');
    const observed = this.deps.store.observe(run.id, {
      headSha: head, upstream: upstreamRef, ahead: aheadCount, behind: behindCount,
      updatedTs: this.now(),
    });
    if (!observed) return this.cleanupFailure(run, 'CLEANUP_FAILED');
    run = observed;
    if (run.lifecycleState !== 'cleaning') {
      run = this.deps.store.transition(run.id, ['archived', 'cleanup_blocked'], 'cleaning', {
        assignmentActive: false, updatedTs: this.now(), errorCode: null, errorDetail: null,
      }) ?? this.cleanupFailure(run, 'CLEANUP_FAILED');
      await this.checkpoint('after_cleanup_intent');
    }
    const remove = await driver.git(project.cwd, ['worktree', 'remove', cwd]);
    if (remove.code !== 0) return this.cleanupFailure(run, 'CLEANUP_FAILED');
    await this.checkpoint('after_remove');
    const after = parseWorktreePorcelain(requireOk(
      await driver.git(project.cwd, ['worktree', 'list', '--porcelain']),
      'CLEANUP_FAILED', 'Unable to verify managed worktree removal.',
    ));
    if (after.some((item) => item.path === cwd)) return this.cleanupFailure(run, 'CLEANUP_FAILED');
    await this.checkpoint('before_cleanup_finalize');
    return this.finalizeCleanup(run);
  }

  private finalizeCleanup(run: DesignExecutionRun): DesignExecutionRun {
    const cleaned = this.deps.store.transition(run.id, ['cleaning'], 'cleaned', {
      assignmentActive: false, cleanedTs: this.now(), updatedTs: this.now(),
      errorCode: null, errorDetail: null,
    });
    if (!cleaned) throw new DesignWorktreeError('CLEANUP_FAILED', 'Cleanup state changed concurrently.');
    return cleaned;
  }

  private validateCreate(input: CreateDesignWorktreeInput, actor: DesignWorktreeActor): void {
    const mode = input.executionMode ?? 'current';
    if (!validPositiveId(input.projectId)
      || !validPositiveId(input.designId)
      || !validPositiveId(input.revision)
      || !validPositiveId(actor.userId)
      || !validDigest(input.graphDigest)
      || !validStableKey(input.idempotencyKey)
      || !validStableKey(actor.actorKey)
      || (mode !== 'current' && mode !== 'worktree')
      || (mode === 'current' && input.baseRef !== undefined)
      || (mode === 'worktree' && !validBaseRef(input.baseRef))) {
      throw new DesignWorktreeError(mode === 'worktree' && !validBaseRef(input.baseRef) ? 'BASE_INVALID' : 'INVALID_REQUEST', 'Worktree request is invalid.');
    }
  }

  private async authorize(
    input: CreateDesignWorktreeInput,
    actor: DesignWorktreeActor,
  ): Promise<{ project: DesignWorktreeProject; approved: DesignWorktreeApprovedDesign }> {
    const project = await this.deps.projectLookup(input.projectId);
    if (!project || project.id !== input.projectId) throw new DesignWorktreeError('PROJECT_NOT_FOUND', 'Project was not found.');
    if (!await this.deps.authorizeOwner(actor, project)) throw new DesignWorktreeError('FORBIDDEN', 'Project owner access is required.');
    const approved = await this.deps.approvedDesignLookup(
      input.projectId,
      input.designId,
      input.revision,
      input.graphDigest,
    );
    if (!approved
      || approved.projectId !== input.projectId
      || approved.designId !== input.designId
      || approved.revision !== input.revision
      || approved.graphDigest !== input.graphDigest) {
      throw new DesignWorktreeError('PUBLICATION_MISMATCH', 'Approved design does not match this immutable revision.');
    }
    return { project, approved };
  }

  private async authorizeMutation(
    input: DesignWorktreeMutationInput,
    actor: DesignWorktreeActor,
  ): Promise<{ project: DesignWorktreeProject; publication: DesignWorktreePublication }> {
    if (!validPositiveId(input.projectId) || !validPositiveId(input.designId) || !validPositiveId(input.publicationId)) {
      throw new DesignWorktreeError('INVALID_REQUEST', 'Worktree request is invalid.');
    }
    const project = await this.deps.projectLookup(input.projectId);
    if (!project || project.id !== input.projectId) throw new DesignWorktreeError('PROJECT_NOT_FOUND', 'Project was not found.');
    if (!await this.deps.authorizeOwner(actor, project)) throw new DesignWorktreeError('FORBIDDEN', 'Project owner access is required.');
    const publication = await this.deps.publicationLookup(input.publicationId);
    if (!publication
      || publication.projectId !== input.projectId
      || publication.designId !== input.designId) {
      throw new DesignWorktreeError('PUBLICATION_MISMATCH', 'Publication does not match this design.');
    }
    return { project, publication };
  }

  private requireRun(input: DesignWorktreeMutationInput): DesignExecutionRun {
    const run = this.deps.store.getByPublication(input.publicationId);
    if (!run || run.projectId !== input.projectId || run.designId !== input.designId) {
      throw new DesignWorktreeError('RUN_NOT_FOUND', 'Execution run was not found.');
    }
    return run;
  }

  private async reconcileLocked(
    run: DesignExecutionRun,
    project: DesignWorktreeProject,
    driver: DesignWorktreeDriver,
    recoverCreating: boolean,
  ): Promise<DesignExecutionRun> {
    if (run.executionMode !== 'worktree' || !run.worktreeCwd || !run.worktreeBranch || !run.baseSha) return run;
    const result = await driver.git(project.cwd, ['worktree', 'list', '--porcelain']);
    if (result.code !== 0) return this.recoveryFailure(run, 'RECOVERY_REQUIRED');
    let observations: WorktreeObservation[];
    try { observations = parseWorktreePorcelain(result.out); } catch { return this.recoveryFailure(run, 'RECOVERY_REQUIRED'); }
    const exact = observations.find((item) => item.path === run.worktreeCwd);
    if (!exact) return this.recoveryFailure(run, 'WORKTREE_MISSING');
    if (exact.locked) return this.recoveryFailure(run, 'WORKTREE_LOCKED');
    if (exact.prunable
      || exact.detached
      || exact.branch !== `refs/heads/${run.worktreeBranch}`
      || exact.head !== run.baseSha && run.lifecycleState === 'creating') {
      return this.recoveryFailure(run, 'WORKTREE_MISMATCH');
    }
    let observed = this.deps.store.observe(run.id, { headSha: exact.head, updatedTs: this.now() });
    if (!observed) throw new DesignWorktreeError('RECOVERY_REQUIRED', 'Execution run disappeared during inspection.');
    if (recoverCreating && observed.lifecycleState === 'creating') {
      await this.checkpoint('before_ready');
      observed = this.deps.store.transition(observed.id, ['creating'], 'ready', {
        assignmentActive: false, updatedTs: this.now(), errorCode: null, errorDetail: null,
      }) ?? observed;
    }
    return observed;
  }

  private cleanupFailure(run: DesignExecutionRun, code: DesignWorktreeErrorCode): never {
    this.deps.store.transition(run.id, ['archived', 'cleanup_blocked', 'cleaning'], 'cleanup_blocked', {
      assignmentActive: false,
      updatedTs: this.now(),
      errorCode: code,
      errorDetail: 'Managed worktree cleanup requires owner recovery.',
    });
    throw new DesignWorktreeError(code, 'Managed worktree was preserved for recovery.');
  }

  private recoveryFailure(run: DesignExecutionRun, code: DesignWorktreeErrorCode): never {
    this.deps.store.markRecoveryFailure(run.id, {
      code, updatedTs: this.now(), detail: 'Managed worktree requires reconciliation.',
    });
    throw new DesignWorktreeError(code, 'Managed worktree requires recovery.');
  }

  private failRun(id: string, code: DesignWorktreeErrorCode): void {
    this.deps.store.transition(id, ['intent', 'creating'], 'recoverable_error', {
      assignmentActive: false,
      updatedTs: this.now(),
      errorCode: code,
      errorDetail: 'Managed worktree creation requires owner recovery.',
    });
  }
}

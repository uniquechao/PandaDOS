-- 055_design_execution_worktrees: one publication-bound execution workspace per design batch.
-- The normalized row is authoritative; legacy design_tasks.worktree_* columns remain projection-only.

CREATE TABLE design_execution_runs (
  id                  TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  project_id          INTEGER NOT NULL,
  design_task_id      INTEGER NOT NULL,
  publication_id      INTEGER UNIQUE,
  approved_revision   INTEGER NOT NULL CHECK (approved_revision > 0),
  graph_digest        TEXT NOT NULL CHECK (
                        length(graph_digest) = 64 AND graph_digest NOT GLOB '*[^0-9a-f]*'
                      ),
  idempotency_key     TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 128),
  execution_mode      TEXT NOT NULL DEFAULT 'current' CHECK (execution_mode IN ('current', 'worktree')),
  lifecycle_state     TEXT NOT NULL CHECK (lifecycle_state IN (
                        'intent', 'creating', 'ready', 'executing', 'archived',
                        'cleanup_blocked', 'cleaning', 'cleaned', 'recoverable_error'
                      )),
  assignment_active   INTEGER NOT NULL DEFAULT 0 CHECK (assignment_active IN (0, 1)),
  base_ref            TEXT,
  base_sha            TEXT CHECK (
                        base_sha IS NULL OR (
                          length(base_sha) IN (40, 64)
                          AND base_sha NOT GLOB '*[^0-9a-f]*'
                        )
                      ),
  worktree_branch     TEXT,
  worktree_cwd        TEXT,
  observed_head_sha   TEXT CHECK (
                        observed_head_sha IS NULL OR (
                          length(observed_head_sha) IN (40, 64)
                          AND observed_head_sha NOT GLOB '*[^0-9a-f]*'
                        )
                      ),
  observed_upstream   TEXT,
  observed_ahead      INTEGER CHECK (observed_ahead IS NULL OR observed_ahead >= 0),
  observed_behind     INTEGER CHECK (observed_behind IS NULL OR observed_behind >= 0),
  error_code          TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  error_detail        TEXT CHECK (error_detail IS NULL OR length(error_detail) <= 1000),
  created_ts          INTEGER NOT NULL,
  updated_ts          INTEGER NOT NULL,
  archived_ts         INTEGER,
  cleaned_ts          INTEGER,
  UNIQUE (project_id, idempotency_key),
  UNIQUE (design_task_id, approved_revision, graph_digest),
  CHECK (
    (execution_mode = 'current'
      AND base_ref IS NULL AND base_sha IS NULL
      AND worktree_branch IS NULL AND worktree_cwd IS NULL)
    OR
    (execution_mode = 'worktree'
      AND base_ref IS NOT NULL AND base_sha IS NOT NULL
      AND worktree_branch IS NOT NULL AND worktree_cwd IS NOT NULL)
  ),
  CHECK (assignment_active = 0 OR (execution_mode = 'worktree' AND lifecycle_state IN ('executing', 'recoverable_error'))),
  CHECK (archived_ts IS NULL OR lifecycle_state IN ('archived', 'cleanup_blocked', 'cleaning', 'cleaned', 'recoverable_error')),
  CHECK (cleaned_ts IS NULL OR lifecycle_state = 'cleaned'),
  FOREIGN KEY (design_task_id, project_id)
    REFERENCES design_tasks(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (design_task_id, approved_revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE RESTRICT,
  FOREIGN KEY (publication_id, design_task_id, project_id, approved_revision, graph_digest)
    REFERENCES design_publications(id, design_task_id, project_id, revision, graph_digest)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_design_publications_execution_identity
  ON design_publications(id, design_task_id, project_id, revision, graph_digest);

CREATE INDEX idx_design_execution_runs_recovery
  ON design_execution_runs(lifecycle_state, updated_ts, id);
CREATE UNIQUE INDEX idx_design_execution_runs_one_live_worktree
  ON design_execution_runs(design_task_id)
  WHERE execution_mode = 'worktree' AND lifecycle_state <> 'cleaned';
CREATE UNIQUE INDEX idx_design_execution_runs_live_cwd
  ON design_execution_runs(worktree_cwd)
  WHERE worktree_cwd IS NOT NULL AND lifecycle_state <> 'cleaned';
CREATE UNIQUE INDEX idx_design_execution_runs_live_branch
  ON design_execution_runs(project_id, worktree_branch)
  WHERE worktree_branch IS NOT NULL AND lifecycle_state <> 'cleaned';

-- 056_design_issue_sync_jobs: durable, independently retryable work for each published Issue link.

CREATE TABLE design_issue_sync_jobs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id           INTEGER NOT NULL,
  design_task_id    INTEGER NOT NULL,
  target_revision   INTEGER NOT NULL CHECK (target_revision > 0),
  state             TEXT NOT NULL DEFAULT 'pending' CHECK (state IN (
                      'pending', 'running', 'retry', 'complete', 'stale'
                    )),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_ts     INTEGER NOT NULL,
  claim_token       TEXT,
  claimed_ts        INTEGER,
  completed_ts      INTEGER,
  last_error        TEXT CHECK (last_error IS NULL OR length(last_error) <= 4000),
  created_ts        INTEGER NOT NULL,
  updated_ts        INTEGER NOT NULL,
  UNIQUE (link_id, target_revision),
  CHECK ((claim_token IS NULL) = (claimed_ts IS NULL)),
  CHECK (state = 'running' OR claim_token IS NULL),
  CHECK ((state = 'complete') = (completed_ts IS NOT NULL)),
  FOREIGN KEY (link_id, design_task_id)
    REFERENCES design_issue_links(id, design_task_id) ON DELETE CASCADE,
  FOREIGN KEY (design_task_id, target_revision)
    REFERENCES design_revisions(design_task_id, revision) ON DELETE CASCADE
);

CREATE INDEX idx_design_issue_sync_jobs_recovery
  ON design_issue_sync_jobs(state, next_retry_ts, updated_ts, id);
CREATE INDEX idx_design_issue_sync_jobs_task_revision
  ON design_issue_sync_jobs(design_task_id, target_revision, id);

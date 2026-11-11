# Workspace storage lifecycle

[简体中文](workspace-storage.zh-CN.md)

The server runs a durable collector on the executor assigned to each project. PM can inspect it using `workspace_resources` and request a recheck of a project-owned job. The tool accepts job IDs and fixed actions, never shell commands or filesystem paths.

Completed integration candidates become eligible only after the result is integrated, the Issue is done, and execution has stopped and released its workspace. The collector checks repository identity, registration, HEAD, conflicts, pending operations and process references. It archives unique diagnostics and runtime data, verifies the archive, and removes the candidate with ordinary [`git worktree remove`](https://git-scm.com/docs/git-worktree). Changes, unknown writers or uncertain results retain the scene and a reason. It never force-removes a worktree.

Idle module worktrees retain source, commits, progress and runtime databases. The collector can evict ignored dependency installations, build outputs and caches from confirmed-ended executions. A cold environment rebuilds through the existing lockfile-based dependency preparation before the next Issue starts. Held or paused executions remain protected. Runtime transcripts, temporary state and root dependency installations are excluded from automatic commits; untracking an old runtime file preserves its disk contents and Git history.

Archives and durable executor receipts live under `<executor.workspace_root>/.panda-archives/`, outside candidate directories. Ignored resources are detached into job-owned trash using same-filesystem renames. Large archive verification and trash deletion run outside the shared repository Git lock. Different filesystems, altered resources or incomplete deletion retain an auditable job rather than falling back to an unsafe deletion.

The controller records job ownership, reasons and outcomes in SQLite. Release and candidate reclamation intent commit together. Startup and periodic reconciliation repair missed intents and compare executor receipts with actual paths and Git registration. An operation of unknown outcome keeps its reservation; a timeout or controller exit does not authorize a second writer. Shutdown joins active collector work before closing its executor or database.

## Limits

| Setting | Default |
| --- | --- |
| `PANDA_WORKSPACE_MIN_FREE_BYTES` | 2147483648 (2 GiB) |
| `PANDA_WORKSPACE_CACHE_MAX_BYTES` | 2147483648 (2 GiB) |
| `PANDA_WORKSPACE_ARCHIVE_MAX_BYTES` | 4294967296 (4 GiB) |
| `PANDA_WORKSPACE_IDLE_MS` | 21600000 (6 hours) |
| `PANDA_WORKSPACE_ARCHIVE_RETENTION_MS` | 604800000 (7 days) |

Settings are nonnegative integers in bytes or milliseconds. Embedders may override the same policy through `ServerOptions.workspaceReclamationPolicy`.

The cache budget is a soft eviction watermark: exceeding it immediately queues eligible idle environments for the background collector, even before the normal idle age. It does not block unrelated new Issues when the executor has sufficient real free space. Caches belonging to held, dirty or uninspectable executions are retained; their protected state cannot veto all starts on the executor. Disk checks inspect the executor's actual workspace, candidate/install and archive filesystems. Low space delays new tasks, candidate creation and dependency installation without consuming environment repair attempts. Reclamation has a separate small write reserve so it can still free stopped caches below the task-start threshold.

Expired completed archives rotate automatically; quota pressure can rotate older completed archives sooner. `workspace_resources` actions `pin` and `unpin` control retention of a project's archive. Pinned, incomplete or unknown archives are not purged. Pins cannot be acknowledged during an unconfirmed deletion. An oversized archive retains its original scene. Archive limits count storage on the executor, including other projects using that executor; unknown archive payloads are counted but never deleted by the collector.

PM lists show unfinished jobs before completed history, including machine-readable retention reasons. `recheck` requests a fresh check; it does not bypass preservation, capacity or ownership guards.

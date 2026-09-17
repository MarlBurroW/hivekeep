# Queue recovery, reservations and shutdown

The September 2026 reliability changes are additive for existing SQLite databases.

## Inbound messages

Migration `0119_durable_queue_payload` stores uploaded file IDs, channel metadata
and the browser reconciliation token on `queue_items`. The complete envelope is
written before publishing the pending item. Dequeuing no longer consumes an
in-memory side channel: a restart before or after dequeue retains the payload.

The incoming message and `created_message_id` receipt commit in one transaction.
Both the main conversation and quick-session workers use that receipt on replay.
Attachments are linked again safely if the worker stopped before linking them.
Old rows remain readable with null payload columns; files/metadata already lost
by an old process cannot be reconstructed by the migration.

This deduplicates the incoming message. It does **not** make LLM calls, tool
effects, channel delivery or other external operations exactly once.

The revealed-secret recovery sweep is awaited before plugins, workers and
scheduled inference producers start. A failed sweep stops startup.

## Task reservations

Counting execution slots/group slots/queue capacity and reserving a task now
share a short SQLite write transaction. Prompt snapshots and asynchronous work
run outside it. Global and group promotion use the same admission rules.
An explicit force promotion still overrides limits, with a single atomic winner.
Retried history commits with the new task, before a queued retry can be promoted.

## Numeric configuration and upload limits

Numeric environment values reject empty strings, NaN, infinity, negatives and
invalid integer counts. Errors name the variable without echoing its value.
Ports, percentages, concurrency and polling intervals have additional bounds.

| Variable | Default | Notes |
| --- | ---: | --- |
| `MAX_REQUEST_BODY_MB` | 256 | HTTP envelope, including multipart overhead; maximum 1024 |
| `FILE_STORAGE_MAX_SIZE` | 128 | One stored file; maximum 1024 |
| `WORKSPACE_FILES_MAX_UPLOAD_SIZE` | 100 | One workspace upload; maximum 1024 |
| `SHUTDOWN_DRAIN_TIMEOUT_MS` | 20000 | Grace period for current HTTP handlers and conversation/task executions |
| `SHUTDOWN_CLEANUP_TIMEOUT_MS` | 5000 | Abort settling and resource cleanup deadline |

For the first three variables, legacy `0` now selects the finite default and
emits a startup warning. Negative values are invalid. Increase both the file and
HTTP envelope caps when permitting larger uploads; allow multipart overhead.

## SIGTERM / SIGINT

1. Stop HTTP admission, close SSE connections and stop workers, promotions,
   scheduled jobs, maintenance timers and plugin watching.
2. Allow tracked work to finish within the drain period. Inputs produced by an
   active turn remain durable; newly spawned tasks remain queued.
3. Abort active LLM streams if the drain expires, then allow a bounded settling
   period before resource cleanup.
4. Disconnect channel adapters without disabling saved channels; stop plugins,
   browsers and app backends; persist terminal descriptors/scrollback; close HTTP
   connections and SQLite. Tmux sessions remain available on restart.

Repeated signals share one shutdown. A cleanup timeout yields exit code 1.
Pending queue items survive; tasks already executing retain the existing
interruption policy (stale task rows become failed at the next boot). An aborted
conversation turn is not automatically replayed by graceful shutdown. A hard
crash can still replay a processing queue item; external effects need their own
idempotency protections. In-process code which blocks the JavaScript event loop
cannot be interrupted by a timer; the service manager's stop timeout remains
the final termination mechanism.

Regression coverage includes real subprocess queue restarts and rollback of a
failed message receipt, concurrent task reservations/promotions, populated-DB
migrations, numeric configuration, and SIGTERM drain/abort/hung-cleanup cases.

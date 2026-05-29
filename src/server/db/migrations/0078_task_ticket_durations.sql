-- Live + persisted durations for tasks and tickets.
--
-- tasks.started_at  : when the task first entered 'in_progress' (actual
--                     execution start, distinct from created_at which is the
--                     spawn/queue time). Set once via COALESCE so re-entries
--                     (resume, request_input replies, inter-Kin replies) never
--                     reset it. Null while queued/pending.
-- tasks.ended_at    : when the task reached a terminal status
--                     (completed/failed/cancelled). Together with started_at
--                     this freezes the final run duration. Null while active.
-- tickets.in_progress_at : when the ticket last entered the 'in_progress'
--                     column. Drives the "in progress since" duration on the
--                     kanban card.
--
-- Backfill: existing terminal tasks get a best-effort started_at = created_at
-- and ended_at = updated_at so historical rows still show a (approximate)
-- duration. In-progress tasks get started_at = created_at. Tickets already in
-- the in_progress column get in_progress_at = updated_at.
ALTER TABLE tasks ADD COLUMN started_at integer;--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN ended_at integer;--> statement-breakpoint
ALTER TABLE tickets ADD COLUMN in_progress_at integer;--> statement-breakpoint
UPDATE tasks SET started_at = created_at WHERE status IN ('in_progress', 'paused', 'awaiting_human_input', 'awaiting_kin_response', 'completed', 'failed', 'cancelled');--> statement-breakpoint
UPDATE tasks SET ended_at = updated_at WHERE status IN ('completed', 'failed', 'cancelled');--> statement-breakpoint
UPDATE tickets SET in_progress_at = updated_at WHERE status = 'in_progress';

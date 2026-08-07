DROP TRIGGER IF EXISTS `project_knowledge_fts_insert`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `project_knowledge_fts_update`;--> statement-breakpoint
DROP TRIGGER IF EXISTS `project_knowledge_fts_delete`;--> statement-breakpoint
DROP TABLE IF EXISTS `project_knowledge_fts`;--> statement-breakpoint
DROP TABLE IF EXISTS `project_knowledge_vec`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`avatar_path` text,
	`character` text NOT NULL,
	`expertise` text NOT NULL,
	`kind` text DEFAULT 'regular' NOT NULL,
	`model` text NOT NULL,
	`provider_id` text,
	`scout_model` text,
	`scout_provider_id` text,
	`scout_thinking_config` text,
	`workspace_path` text NOT NULL,
	`toolbox_ids` text,
	`extra_tool_names` text,
	`compacting_config` text,
	`thinking_config` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`scout_provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_agents`("id", "slug", "name", "role", "avatar_path", "character", "expertise", "kind", "model", "provider_id", "scout_model", "scout_provider_id", "scout_thinking_config", "workspace_path", "toolbox_ids", "extra_tool_names", "compacting_config", "thinking_config", "created_by", "created_at", "updated_at") SELECT "id", "slug", "name", "role", "avatar_path", "character", "expertise", "kind", "model", "provider_id", "scout_model", "scout_provider_id", "scout_thinking_config", "workspace_path", "toolbox_ids", "extra_tool_names", "compacting_config", "thinking_config", "created_by", "created_at", "updated_at" FROM `agents`;--> statement-breakpoint
DROP TABLE `agents`;--> statement-breakpoint
ALTER TABLE `__new_agents` RENAME TO `agents`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_slug_unique` ON `agents` (`slug`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_agent_id` text NOT NULL,
	`source_agent_id` text,
	`spawn_type` text NOT NULL,
	`mode` text DEFAULT 'await' NOT NULL,
	`model` text,
	`provider_id` text,
	`title` text,
	`description` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`depth` integer DEFAULT 1 NOT NULL,
	`parent_task_id` text,
	`cron_id` text,
	`request_input_count` integer DEFAULT 0 NOT NULL,
	`inter_agent_request_count` integer DEFAULT 0 NOT NULL,
	`pending_request_id` text,
	`pending_child_task_id` text,
	`channel_origin_id` text,
	`webhook_id` text,
	`prompt_context_snapshot` text,
	`allow_human_prompt` integer DEFAULT true NOT NULL,
	`thinking_config` text,
	`tool_preset` text,
	`toolbox_ids` text,
	`concurrency_group` text,
	`concurrency_max` integer,
	`last_api_context_tokens` integer,
	`queued_at` integer,
	`started_at` integer,
	`ended_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cron_id`) REFERENCES `crons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "parent_agent_id", "source_agent_id", "spawn_type", "mode", "model", "provider_id", "title", "description", "status", "result", "error", "depth", "parent_task_id", "cron_id", "request_input_count", "inter_agent_request_count", "pending_request_id", "pending_child_task_id", "channel_origin_id", "webhook_id", "prompt_context_snapshot", "allow_human_prompt", "thinking_config", "tool_preset", "toolbox_ids", "concurrency_group", "concurrency_max", "last_api_context_tokens", "queued_at", "started_at", "ended_at", "created_at", "updated_at") SELECT "id", "parent_agent_id", "source_agent_id", "spawn_type", "mode", "model", "provider_id", "title", "description", "status", "result", "error", "depth", "parent_task_id", "cron_id", "request_input_count", "inter_agent_request_count", "pending_request_id", "pending_child_task_id", "channel_origin_id", "webhook_id", "prompt_context_snapshot", "allow_human_prompt", "thinking_config", "tool_preset", "toolbox_ids", "concurrency_group", "concurrency_max", "last_api_context_tokens", "queued_at", "started_at", "ended_at", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `idx_tasks_parent_agent` ON `tasks` (`parent_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_cron` ON `tasks` (`cron_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_concurrency` ON `tasks` (`concurrency_group`,`status`,`queued_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_webhook` ON `tasks` (`webhook_id`);--> statement-breakpoint
DROP TABLE `ticket_attachments`;--> statement-breakpoint
DROP TABLE `ticket_comments`;--> statement-breakpoint
DROP TABLE `ticket_tags`;--> statement-breakpoint
DROP TABLE `tickets`;--> statement-breakpoint
DROP TABLE `project_knowledge`;--> statement-breakpoint
DROP TABLE `project_tags`;--> statement-breakpoint
DROP TABLE `projects`;

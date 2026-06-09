CREATE TABLE `account_sync_state` (
	`account_id` text NOT NULL,
	`folder` text NOT NULL,
	`last_seen_date` integer NOT NULL,
	`seen_ids` text DEFAULT '[]' NOT NULL,
	`last_polled_at` integer,
	`last_error` text,
	PRIMARY KEY(`account_id`, `folder`),
	FOREIGN KEY (`account_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `account_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`folder` text DEFAULT 'INBOX' NOT NULL,
	`conditions` text NOT NULL,
	`prompt` text NOT NULL,
	`target_agent_id` text NOT NULL,
	`dispatch_mode` text DEFAULT 'conversation' NOT NULL,
	`max_concurrent_tasks` integer DEFAULT 1 NOT NULL,
	`needs_body` integer DEFAULT false NOT NULL,
	`last_triggered_at` integer,
	`trigger_count` integer DEFAULT 0 NOT NULL,
	`created_by` text DEFAULT 'user' NOT NULL,
	`requires_approval` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_account_triggers_account` ON `account_triggers` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_account_triggers_target_agent` ON `account_triggers` (`target_agent_id`);--> statement-breakpoint
CREATE TABLE `trigger_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`trigger_id` text NOT NULL,
	`summary` text,
	`matched` integer NOT NULL,
	`action` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `account_triggers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_trigger_logs_trigger_created` ON `trigger_logs` (`trigger_id`,`created_at`);

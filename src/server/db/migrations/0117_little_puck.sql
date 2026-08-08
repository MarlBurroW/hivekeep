CREATE TABLE `agent_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`token_estimate` integer DEFAULT 0 NOT NULL,
	`last_rewrite_at` integer,
	`manually_edited_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_profiles_agent_id_unique` ON `agent_profiles` (`agent_id`);
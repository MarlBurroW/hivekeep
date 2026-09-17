CREATE TABLE `channel_origins` (
	`origin_id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`platform_chat_id` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`platform_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_channel_origins_created_at` ON `channel_origins` (`created_at`);
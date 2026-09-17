ALTER TABLE `queue_items` ADD `file_ids` text;
--> statement-breakpoint
ALTER TABLE `queue_items` ADD `client_message_id` text;
--> statement-breakpoint
ALTER TABLE `queue_items` ADD `message_metadata` text;

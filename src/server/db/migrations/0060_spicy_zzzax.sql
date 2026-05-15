ALTER TABLE `projects` ADD `slug` text;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
ALTER TABLE `tickets` ADD `number` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tickets_project_number` ON `tickets` (`project_id`,`number`);
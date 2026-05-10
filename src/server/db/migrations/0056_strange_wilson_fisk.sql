CREATE TABLE `contact_nicknames` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`nickname` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_contact_nicknames_contact` ON `contact_nicknames` (`contact_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`first_name` text,
	`last_name` text,
	`linked_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`linked_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_contacts`("id", "first_name", "last_name", "linked_user_id", "created_at", "updated_at")
SELECT
  "id",
  CASE WHEN instr("name", ' ') > 0 THEN substr("name", 1, instr("name", ' ') - 1) ELSE "name" END,
  CASE WHEN instr("name", ' ') > 0 THEN substr("name", instr("name", ' ') + 1) ELSE NULL END,
  "linked_user_id",
  "created_at",
  "updated_at"
FROM `contacts`;--> statement-breakpoint
DROP TABLE `contacts`;--> statement-breakpoint
ALTER TABLE `__new_contacts` RENAME TO `contacts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
-- Agent groups: an optional, named folder an Agent can belong to.
--
-- `agents.group_id` is nullable on purpose: an Agent with no group is the
-- default and renders exactly like it does today. ON DELETE SET NULL means
-- deleting a group ungroups its Agents instead of deleting them.
CREATE TABLE `agent_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_agent_groups_name` ON `agent_groups` (`name`);
--> statement-breakpoint
ALTER TABLE `agents` ADD `group_id` text REFERENCES `agent_groups`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `idx_agents_group` ON `agents` (`group_id`);

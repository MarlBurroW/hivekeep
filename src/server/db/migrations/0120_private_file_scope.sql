ALTER TABLE `files` ADD `session_id` text;
--> statement-breakpoint
CREATE INDEX `idx_files_session` ON `files` (`session_id`);
--> statement-breakpoint
UPDATE `files` SET `session_id` = (
  SELECT `session_id` FROM `messages` WHERE `messages`.`id` = `files`.`message_id`
) WHERE `message_id` IS NOT NULL;
--> statement-breakpoint
-- Recover generated image/audio ownership where a persisted tool result kept it.
WITH private_generated AS MATERIALIZED (
  SELECT result.`value` AS file_id, m.`session_id` AS session_id
  FROM `messages` m, json_tree(CASE WHEN json_valid(m.`tool_calls`) THEN m.`tool_calls` ELSE '[]' END) result
  WHERE m.`session_id` IS NOT NULL AND result.`key` IN ('fileId', 'file_id')
)
UPDATE `files` SET `session_id` = (
  SELECT session_id FROM private_generated WHERE file_id = `files`.`id` LIMIT 1
) WHERE `session_id` IS NULL AND `id` IN (SELECT file_id FROM private_generated);

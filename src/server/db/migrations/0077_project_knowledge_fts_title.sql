-- Make project_knowledge_fts cover the title in addition to the body.
--
-- IMPORTANT: this migration must NOT reference project_knowledge_fts itself.
-- That virtual table is created by initVirtualTables() at boot, which runs
-- AFTER Drizzle migrations — so on a fresh prod DB the table does not exist
-- yet when this migration runs. (An earlier version of this file did
-- `DELETE FROM project_knowledge_fts` here and crashed boot with
-- "no such table: project_knowledge_fts".)
--
-- We only drop the FTS triggers here. They are recreated at boot by
-- initVirtualTables() with the new `title || char(10) || content` expression,
-- and the FTS index is rebuilt there too (where the table is guaranteed to
-- exist). DROP TRIGGER IF EXISTS is safe whether or not the trigger exists.
DROP TRIGGER IF EXISTS project_knowledge_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_knowledge_fts_update;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_knowledge_fts_delete;

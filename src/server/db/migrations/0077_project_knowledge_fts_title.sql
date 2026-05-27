-- Reindex project_knowledge_fts to include the title alongside the content.
--
-- The original 0075 indexed only the markdown body, which made FTS5 search
-- miss any query that matched a title word but not a body word. With the
-- 0076 title field landing in every Kin's prompt, users are now searching
-- by title concepts more than by body keywords — they need title hits too.
--
-- The fts5 column is still called `content`, but it now stores
-- `title || char(10) || body`. Renaming would require recreating the
-- virtual table, which isn't worth the migration risk.
--
-- Triggers are dropped here; init-time code re-creates them with the new
-- expression (and fires on UPDATE of *any* column instead of only content,
-- so a title-only edit re-indexes too).
DROP TRIGGER IF EXISTS project_knowledge_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_knowledge_fts_update;--> statement-breakpoint
DROP TRIGGER IF EXISTS project_knowledge_fts_delete;--> statement-breakpoint
-- Wipe existing FTS rows and rebuild from scratch with title + content.
DELETE FROM project_knowledge_fts;--> statement-breakpoint
INSERT INTO project_knowledge_fts(rowid, content)
  SELECT rowid, title || char(10) || content FROM project_knowledge;

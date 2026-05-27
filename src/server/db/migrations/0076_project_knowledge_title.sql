-- Add `title` to project_knowledge.
--
-- The original 0075 design pinned a small curated subset (max 10) into the
-- system prompt. With a title field we can do better: the prompt now ships
-- ALL titles as a lightweight index, and only PINNED entries also embed
-- their full markdown content inline. Unpinned entries are reachable via
-- get_project_knowledge(id) without an extra search.
--
-- NOT NULL with DEFAULT '' so the migration is safe on existing rows
-- (dev data only — feature shipped on the same branch). Empty titles are
-- rejected at the service layer.
ALTER TABLE project_knowledge ADD COLUMN title text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Backfill any pre-existing rows: use the first 80 chars of content. Newline
-- collapsed to space so the title stays single-line.
UPDATE project_knowledge SET title = trim(substr(replace(content, char(10), ' '), 1, 80)) WHERE title = '';

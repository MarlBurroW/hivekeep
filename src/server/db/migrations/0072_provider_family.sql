-- Each provider row now serves a single family (llm / embedding / image).
-- Default to 'llm' for every existing row; the startup service
-- `split-multi-capability-providers` then splits any row whose
-- capabilities array contains more than one family into N rows, one per
-- family, sharing the same encrypted config.
ALTER TABLE providers ADD COLUMN family TEXT NOT NULL DEFAULT 'llm';

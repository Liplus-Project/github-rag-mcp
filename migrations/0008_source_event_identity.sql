-- Add canonical event identities for sparse/fetch memory provenance.
-- Legacy comment/review rows must be reingested from GitHub before feedback is available.
ALTER TABLE search_docs ADD COLUMN comment_id INTEGER NOT NULL DEFAULT 0;
ALTER TABLE search_docs ADD COLUMN review_id INTEGER NOT NULL DEFAULT 0;

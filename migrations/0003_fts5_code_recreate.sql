-- D1 FTS5 code_fts virtual table fresh recreate — recurring SQLITE_CORRUPT_VTAB
--
-- Layer = L4 Operations (sparse retrieval surface recovery)
--
-- Context:
--   2026-04-24: migration 0002 applied FTS5 'rebuild' to both nat_fts and code_fts
--   to recover from SQLITE_CORRUPT_VTAB.
--   2026-04-28: corruption recurred on code_fts only (trigram tokenizer side).
--   Enriched logs from PR #137 confirmed errorName=Error /
--   D1_ERROR: database disk image is malformed: SQLITE_CORRUPT_VTAB on every diff
--   upsert across all 5 polled repos.
--
-- Recovery (more aggressive than 0002):
--   DROP the corrupted virtual table and recreate it from scratch with the
--   same definition as 0001, then repopulate via FTS5 'rebuild' which reads
--   from the content-owner table (search_docs).
--
--   Triggers from 0001 (trg_search_docs_ai/ad/au) reference search_docs_code_fts
--   by name; they resume working as soon as the new table exists, so they do
--   not need to be redefined.
--
-- Scope:
--   Affects code_fts only. nat_fts is untouched (no recurring corruption observed there).
--
-- Idempotency:
--   IF EXISTS / IF NOT EXISTS clauses keep the migration safe to re-run.

DROP TABLE IF EXISTS search_docs_code_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_code_fts USING fts5 (
  content,
  tokenize = 'trigram case_sensitive 0',
  content = 'search_docs',
  content_rowid = 'rowid'
);

INSERT INTO search_docs_code_fts(search_docs_code_fts) VALUES('rebuild');

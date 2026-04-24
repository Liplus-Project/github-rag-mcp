-- FTS5 virtual table rebuild — recover from SQLITE_CORRUPT_VTAB
--
-- Layer = L4 Operations (sparse retrieval surface recovery)
--
-- Context:
--   Observed on 2026-04-24: `search_issues` sparse path and FTS upserts both
--   failed with `D1_ERROR: database disk image is malformed: SQLITE_CORRUPT
--   (extended: SQLITE_CORRUPT_VTAB)`. The content-owner table `search_docs`
--   was intact (1109 rows, direct bm25 queries via `wrangler d1 execute`
--   succeeded), so only the FTS5 virtual tables were corrupt.
--
-- Recovery:
--   FTS5's built-in `'rebuild'` command re-populates the virtual table from
--   the content-owner table (`search_docs`). The operation is idempotent and
--   non-destructive — it reads every row of `search_docs` and re-indexes it
--   through each tokenizer. On a healthy or empty FTS table it is effectively
--   a no-op, so this migration is safe to re-run.
--
-- Scope:
--   Covers both FTS5 tables (nat + code). Triggers from 0001 keep subsequent
--   upserts in sync automatically.

INSERT INTO search_docs_nat_fts(search_docs_nat_fts) VALUES('rebuild');
INSERT INTO search_docs_code_fts(search_docs_code_fts) VALUES('rebuild');

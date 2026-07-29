-- Repair FTS5 tokenizer isolation without touching the corrupted v1 indexes.
--
-- Layer = L4 Operations (sparse retrieval surface)
--
-- Every search_docs row belongs to exactly one tokenizer index. The original
-- DELETE and UPDATE triggers sent an FTS5 'delete' command to both indexes,
-- including the index that had never received the row. FTS5 requires a delete
-- command to match an existing indexed row exactly; deleting a nonexistent row
-- leaves the virtual table in an unpredictable state and later bm25() queries
-- fail with SQLITE_CORRUPT_VTAB.
--
-- The existing v1 indexes may already be corrupt in production. Do not rebuild,
-- drop, or query them here. Create filtered external-content views and new indexes
-- under fresh shadow-table names, backfill each one from only its tokenizer_kind,
-- then move the sync triggers to the new generation with the same tokenizer guard
-- on insert, update, and delete. The views keep each FTS index's declared external
-- content relation identical to the rows actually present in that index.
--
-- The sequence number intentionally skips to 0005. Production retains historical
-- migration records for removed recovery migrations 0002-0004, so reusing either
-- number would make Wrangler treat this repair as already applied.

CREATE VIEW IF NOT EXISTS search_docs_nat_content_v2 AS
  SELECT rowid, content
    FROM search_docs
   WHERE tokenizer_kind = 'nat';

CREATE VIEW IF NOT EXISTS search_docs_code_content_v2 AS
  SELECT rowid, content
    FROM search_docs
   WHERE tokenizer_kind = 'code';

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_nat_fts_v2 USING fts5 (
  content,
  tokenize = 'porter unicode61 remove_diacritics 2',
  content = 'search_docs_nat_content_v2',
  content_rowid = 'rowid'
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_code_fts_v2 USING fts5 (
  content,
  tokenize = 'trigram case_sensitive 0',
  content = 'search_docs_code_content_v2',
  content_rowid = 'rowid'
);

INSERT INTO search_docs_nat_fts_v2(rowid, content)
  SELECT rowid, content
    FROM search_docs
   WHERE tokenizer_kind = 'nat';

INSERT INTO search_docs_code_fts_v2(rowid, content)
  SELECT rowid, content
    FROM search_docs
   WHERE tokenizer_kind = 'code';

DROP TRIGGER IF EXISTS trg_search_docs_ai;
DROP TRIGGER IF EXISTS trg_search_docs_ad;
DROP TRIGGER IF EXISTS trg_search_docs_au;

CREATE TRIGGER trg_search_docs_ai AFTER INSERT ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

CREATE TRIGGER trg_search_docs_ad AFTER DELETE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v2(search_docs_nat_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(search_docs_code_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'code';
END;

CREATE TRIGGER trg_search_docs_au AFTER UPDATE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v2(search_docs_nat_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(search_docs_code_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'code';
  INSERT INTO search_docs_nat_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

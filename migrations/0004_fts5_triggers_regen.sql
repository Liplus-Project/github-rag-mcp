-- Force re-declaration of FTS5 sync triggers (axis 2 attempt for issue #135)
--
-- Layer = L4 Operations (sparse retrieval surface recovery)
--
-- Context:
--   2026-04-28: migration 0003 dropped+recreated search_docs_code_fts to
--   recover from recurring SQLITE_CORRUPT_VTAB. After 0003 was merged AND
--   applied via D1 console, production Worker continues to hit
--   D1_ERROR: SQLITE_CORRUPT_VTAB on every diff upsert (tokenizer_kind=code).
--   nat_fts surface is clean; code_fts surface persists corrupt across
--   :30 pollDiffs cron iterations.
--
-- Hypothesis:
--   The AFTER INSERT/UPDATE/DELETE triggers from 0001 were compiled with
--   references that may need re-resolution after the underlying virtual
--   table was DROP+CREATEd. Re-declaring the triggers (DROP + CREATE)
--   forces re-binding to the new search_docs_code_fts.
--
-- Scope:
--   Triggers carry no data (declarative), so this is non-destructive.
--   Body is byte-for-byte identical to 0001; only the declaration
--   timing changes.
--
-- Idempotency:
--   DROP IF EXISTS keeps the migration safe to re-run.

DROP TRIGGER IF EXISTS trg_search_docs_ai;
DROP TRIGGER IF EXISTS trg_search_docs_ad;
DROP TRIGGER IF EXISTS trg_search_docs_au;

CREATE TRIGGER trg_search_docs_ai AFTER INSERT ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

CREATE TRIGGER trg_search_docs_ad AFTER DELETE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts(search_docs_nat_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO search_docs_code_fts(search_docs_code_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER trg_search_docs_au AFTER UPDATE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts(search_docs_nat_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO search_docs_code_fts(search_docs_code_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO search_docs_nat_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

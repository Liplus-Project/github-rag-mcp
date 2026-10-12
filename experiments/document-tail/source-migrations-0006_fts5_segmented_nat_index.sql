-- Give the natural-language FTS5 index a pre-segmented content column so Japanese
-- phrase queries produce BM25 candidates (issue #180 fact 1 / #182).
--
-- Layer = L4 Operations (sparse retrieval surface)
--
-- Problem: `unicode61` only breaks on non-alphanumeric characters, so a run of
-- kana/kanji is indexed as a single token and a Japanese phrase query matches
-- nothing. D1 cannot load a custom tokenizer (`CREATE VIRTUAL TABLE ... tokenize =
-- 'icu'` fails with `no such tokenizer: icu`), so the word boundaries have to be
-- inserted before the text reaches SQLite. The Worker does that with
-- `Intl.Segmenter` (src/segment.ts) on both the ingest and the query side.
--
-- Shape of the fix:
--   - `search_docs.content` keeps the RAW text. It feeds the reranker and stays the
--     external content of the code (trigram) index, which already matches Japanese
--     substrings and is not part of this change.
--   - `search_docs.content_fts` holds the segmented text, and a new v3 generation of
--     the nat index takes that column as its external content.
--
-- Why a new generation instead of editing v2: an external-content FTS5 index must be
-- able to reproduce, at delete time, the exact text it indexed. Repointing the live
-- v2 index at a different column would make every pre-existing shadow row
-- unreproducible and end in SQLITE_CORRUPT_VTAB (the #117 / #135 / migration 0005
-- failure mode). v2 is therefore left byte-for-byte as it is and simply stops being
-- written to and queried, exactly as 0005 did with v1.
--
-- The code side stays on `search_docs_code_fts_v2` with the raw `content` column;
-- only the nat branch advances a generation.
--
-- `content_fts` is initialized here with a copy of the raw content, so the v3 index
-- is never empty and English rows are already correct (segmentation is a no-op for
-- text with no CJK). Japanese rows are re-segmented afterwards by
-- `POST /admin/backfill-fts-segments`, which cannot run in SQL because the
-- segmentation only exists in JS.

ALTER TABLE search_docs ADD COLUMN content_fts TEXT NOT NULL DEFAULT '';

-- Drop the v2 sync triggers BEFORE the bulk UPDATE below. The UPDATE does not touch
-- `content`, so both v2 indexes stay consistent with their views without the
-- delete/insert churn a fired trigger would cause on every row.
DROP TRIGGER IF EXISTS trg_search_docs_ai;
DROP TRIGGER IF EXISTS trg_search_docs_ad;
DROP TRIGGER IF EXISTS trg_search_docs_au;

UPDATE search_docs SET content_fts = content;

CREATE VIEW IF NOT EXISTS search_docs_nat_content_v3 AS
  SELECT rowid, content_fts AS content
    FROM search_docs
   WHERE tokenizer_kind = 'nat';

-- Same tokenizer string as v2 on purpose. The Japanese fix is upstream of the
-- tokenizer (the text arrives pre-split), and keeping `porter unicode61` identical is
-- what guarantees English matching does not regress.
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_nat_fts_v3 USING fts5 (
  content,
  tokenize = 'porter unicode61 remove_diacritics 2',
  content = 'search_docs_nat_content_v3',
  content_rowid = 'rowid'
);

INSERT INTO search_docs_nat_fts_v3(rowid, content)
  SELECT rowid, content_fts
    FROM search_docs
   WHERE tokenizer_kind = 'nat';

-- v3 generation triggers. Every branch stays guarded by `tokenizer_kind` so a row is
-- inserted into and deleted from exactly one index, and each delete command replays
-- the exact column that index holds: `content_fts` for nat, `content` for code.
CREATE TRIGGER trg_search_docs_ai AFTER INSERT ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v3(rowid, content)
    SELECT new.rowid, new.content_fts WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

CREATE TRIGGER trg_search_docs_ad AFTER DELETE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3, rowid, content)
    SELECT 'delete', old.rowid, old.content_fts WHERE old.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(search_docs_code_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'code';
END;

CREATE TRIGGER trg_search_docs_au AFTER UPDATE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts_v3(search_docs_nat_fts_v3, rowid, content)
    SELECT 'delete', old.rowid, old.content_fts WHERE old.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(search_docs_code_fts_v2, rowid, content)
    SELECT 'delete', old.rowid, old.content WHERE old.tokenizer_kind = 'code';
  INSERT INTO search_docs_nat_fts_v3(rowid, content)
    SELECT new.rowid, new.content_fts WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts_v2(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

-- D1 FTS5 migration — hybrid retrieval sparse side (BM25)
--
-- Layer = L4 Operations (sparse retrieval surface)
--
-- Schema overview:
--
--   search_docs            — external content table (source of truth for FTS5)
--   search_docs_nat_fts    — FTS5 virtual table with porter tokenizer (natural language: issue/PR/release/doc)
--   search_docs_code_fts   — FTS5 virtual table with trigram tokenizer (code / SHA / identifiers: diff)
--
-- Notes:
-- - Cloudflare D1 is pre-compiled with SQLite FTS5, so the `fts5` module name MUST be lowercase.
-- - Two FTS5 tables are used instead of one to keep tokenizer choice aligned with embed input type.
--   The caller writes each row to exactly one of the two FTS tables based on `tokenizer_kind`.
-- - Content is stored externally (in `search_docs`) to allow arbitrary metadata columns for filtering
--   and to make delete fan-out straightforward. FTS5 rows carry only the tokenizable text.
-- - `vector_id` mirrors the Vectorize vector ID so the sparse hit can be reconciled with the dense hit
--   during RRF fusion without an extra round-trip to Vectorize.

CREATE TABLE IF NOT EXISTS search_docs (
  -- Deterministic Vectorize vector ID ("{prefix}:{base64url(sha256(parts))}").
  -- Used as the join key between the Vectorize dense hit and the FTS5 sparse hit during RRF fusion.
  vector_id       TEXT NOT NULL PRIMARY KEY,

  -- Repository ("owner/repo"), carried verbatim for filter and enrichment.
  repo            TEXT NOT NULL,

  -- Item type: 'issue' | 'pull_request' | 'release' | 'doc' | 'diff'.
  type            TEXT NOT NULL,

  -- Lifecycle state: 'open' | 'closed' | 'published' | 'active'.
  state           TEXT NOT NULL DEFAULT '',

  -- Comma-separated label / milestone / assignee fields, mirroring VectorMetadata.
  -- Kept as raw strings so hybrid filter behavior mirrors the dense path.
  labels          TEXT NOT NULL DEFAULT '',
  milestone       TEXT NOT NULL DEFAULT '',
  assignees       TEXT NOT NULL DEFAULT '',

  -- ISO 8601 timestamp for recency bias and downstream sorting.
  updated_at      TEXT NOT NULL DEFAULT '',

  -- Surface-specific columns (null/empty when not applicable).
  number          INTEGER NOT NULL DEFAULT 0,   -- issue/PR number
  tag_name        TEXT NOT NULL DEFAULT '',      -- release tag
  doc_path        TEXT NOT NULL DEFAULT '',      -- doc path
  commit_sha      TEXT NOT NULL DEFAULT '',      -- diff commit sha
  file_path       TEXT NOT NULL DEFAULT '',      -- diff file path
  file_status     TEXT NOT NULL DEFAULT '',      -- diff file status
  commit_date     TEXT NOT NULL DEFAULT '',      -- diff commit date
  commit_author   TEXT NOT NULL DEFAULT '',      -- diff commit author

  -- Which FTS5 table this row is indexed in: 'nat' (natural language) or 'code' (trigram).
  tokenizer_kind  TEXT NOT NULL CHECK (tokenizer_kind IN ('nat', 'code')),

  -- Raw tokenizable content (title + body, or commit msg + path + patch) truncated to the
  -- same limit as the embedding input. Kept here so FTS5 rebuild or re-index stays cheap.
  content         TEXT NOT NULL,

  indexed_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_search_docs_repo      ON search_docs (repo, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_docs_type      ON search_docs (type);
CREATE INDEX IF NOT EXISTS idx_search_docs_tokenizer ON search_docs (tokenizer_kind);

-- FTS5 virtual table for natural-language surfaces (issue / PR / release / doc).
-- `porter` stemmer on `unicode61` base tokenizer is a reasonable default for English + Unicode text.
-- `content=search_docs` + `content_rowid=rowid` binds FTS5 to the external content table so
-- INSERT/DELETE on `search_docs` does not require a separate FTS row payload.
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_nat_fts USING fts5 (
  content,
  tokenize = 'porter unicode61 remove_diacritics 2',
  content = 'search_docs',
  content_rowid = 'rowid'
);

-- FTS5 virtual table for code/identifier surfaces (diff).
-- `trigram` tokenizer is the only built-in tokenizer that gives sensible substring/identifier
-- matching behavior (SHA prefixes, camelCase tokens, file paths).
-- case_sensitive=0 so queries match regardless of caller casing.
CREATE VIRTUAL TABLE IF NOT EXISTS search_docs_code_fts USING fts5 (
  content,
  tokenize = 'trigram case_sensitive 0',
  content = 'search_docs',
  content_rowid = 'rowid'
);

-- Triggers keep the two FTS5 virtual tables in sync with `search_docs` automatically.
-- Each trigger writes only to the FTS table that matches `tokenizer_kind`.

CREATE TRIGGER IF NOT EXISTS trg_search_docs_ai AFTER INSERT ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'nat';
  INSERT INTO search_docs_code_fts(rowid, content)
    SELECT new.rowid, new.content WHERE new.tokenizer_kind = 'code';
END;

CREATE TRIGGER IF NOT EXISTS trg_search_docs_ad AFTER DELETE ON search_docs
BEGIN
  INSERT INTO search_docs_nat_fts(search_docs_nat_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
  INSERT INTO search_docs_code_fts(search_docs_code_fts, rowid, content)
    VALUES('delete', old.rowid, old.content);
END;

-- UPDATE is handled as delete-then-insert in application code via ON CONFLICT ... DO UPDATE.
-- The trigger chain below covers row-level UPDATE for completeness (content edits that keep
-- the same vector_id, e.g., a search-surface re-index without a new Vectorize vector).
CREATE TRIGGER IF NOT EXISTS trg_search_docs_au AFTER UPDATE ON search_docs
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

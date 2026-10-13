-- Independent doc/wiki owner. Prefix FTS tables and their corpus stay unchanged.
ALTER TABLE search_docs ADD COLUMN source_version TEXT NOT NULL DEFAULT '';

CREATE TABLE doc_sparse_sources (
  vector_id TEXT NOT NULL UNIQUE,
  source_type TEXT NOT NULL CHECK(source_type IN ('doc', 'wiki_doc')),
  source_version TEXT NOT NULL,
  prefix_indexed_at TEXT NOT NULL,
  index_version TEXT NOT NULL,
  source_hash TEXT,
  body_hash TEXT,
  raw_hash TEXT,
  raw TEXT,
  segmented TEXT,
  raw_bytes INTEGER,
  segmented_bytes INTEGER,
  row_bytes INTEGER NOT NULL CHECK(row_bytes BETWEEN 0 AND 1048576),
  coverage TEXT NOT NULL CHECK(coverage IN ('full', 'out_of_range')),
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK(coverage <> 'full' OR (raw IS NOT NULL AND segmented IS NOT NULL
    AND source_hash IS NOT NULL AND body_hash IS NOT NULL AND raw_hash IS NOT NULL
    AND raw_bytes BETWEEN 0 AND 262144 AND segmented_bytes BETWEEN 0 AND 524288))
);

CREATE VIEW doc_sparse_content_v1 AS
 SELECT rowid, segmented AS content FROM doc_sparse_sources WHERE coverage = 'full';
CREATE VIRTUAL TABLE doc_sparse_fts_v1 USING fts5(
 content, tokenize = 'porter unicode61 remove_diacritics 2',
 content = 'doc_sparse_content_v1', content_rowid = 'rowid'
);
CREATE TRIGGER doc_sparse_ai AFTER INSERT ON doc_sparse_sources BEGIN
 INSERT INTO doc_sparse_fts_v1(rowid, content)
 SELECT new.rowid, new.segmented WHERE new.coverage = 'full';
END;
CREATE TRIGGER doc_sparse_ad AFTER DELETE ON doc_sparse_sources BEGIN
 INSERT INTO doc_sparse_fts_v1(doc_sparse_fts_v1, rowid, content)
 SELECT 'delete', old.rowid, old.segmented WHERE old.coverage = 'full';
END;
CREATE TRIGGER doc_sparse_au AFTER UPDATE ON doc_sparse_sources BEGIN
 INSERT INTO doc_sparse_fts_v1(doc_sparse_fts_v1, rowid, content)
 SELECT 'delete', old.rowid, old.segmented WHERE old.coverage = 'full';
 INSERT INTO doc_sparse_fts_v1(rowid, content)
 SELECT new.rowid, new.segmented WHERE new.coverage = 'full';
END;
CREATE TRIGGER doc_sparse_prefix_delete AFTER DELETE ON search_docs BEGIN
 DELETE FROM doc_sparse_sources WHERE vector_id = old.vector_id;
END;
-- Even a default-off prefix update invalidates an old full snapshot.
CREATE TRIGGER doc_sparse_prefix_update AFTER UPDATE ON search_docs BEGIN
 DELETE FROM doc_sparse_sources WHERE vector_id = old.vector_id
 AND (old.source_version <> new.source_version OR old.content <> new.content
   OR old.indexed_at <> new.indexed_at OR old.updated_at <> new.updated_at
   OR old.repo <> new.repo OR old.type <> new.type OR old.doc_path <> new.doc_path);
END;

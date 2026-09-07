-- Search-mode path_prefix probes and sparse filtering use this range together:
-- exact repo + doc type + half-open doc_path prefix.
CREATE INDEX IF NOT EXISTS idx_search_docs_repo_type_doc_path
  ON search_docs (repo, type, doc_path);

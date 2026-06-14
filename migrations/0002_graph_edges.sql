-- D1 graph edges migration — opt-in GraphRAG layer (additive).
--
-- Layer = L4 Operations (graph retrieval surface, sibling of the FTS5 sparse side)
--
-- Overview:
--
--   doc_edges — directed "mention" references between wiki pages (Decision Structure
--               entries). src/dst are deterministic Vectorize vector IDs computed by
--               wikiDocVectorId() in src/pipeline/vector-id.ts, so an edge can be
--               recorded without a lookup and may point at a not-yet-indexed page
--               (dangling allowed). Traversal (recursive CTE in src/graph.ts) treats
--               edges as undirected.
--
-- Notes:
-- - Fully additive: no existing table or query depends on doc_edges. The default
--   retrieval path (dense + sparse RRF) never reads it. It is consulted only when
--   the `search` tool is called with `graph_expand=true`.
-- - Cloudflare D1 ships standard SQLite, so recursive CTE traversal needs no extension
--   (same as the pre-compiled FTS5 used by 0001).
-- - PRIMARY KEY (src_vector_id, dst_vector_id) gives the src-prefix index for free;
--   the extra dst index supports the undirected reverse hop.

CREATE TABLE IF NOT EXISTS doc_edges (
  -- Deterministic Vectorize vector ID of the referencing page ("w:..." for wiki).
  src_vector_id TEXT NOT NULL,

  -- Deterministic Vectorize vector ID of the referenced page (wikiDocVectorId(repo, dst_slug)).
  dst_vector_id TEXT NOT NULL,

  -- Repository ("owner/repo"); edges only form within one repo's wiki.
  repo          TEXT NOT NULL DEFAULT '',

  -- Human-readable slugs (wiki page names), kept for debugging / backfill clarity.
  src_slug      TEXT NOT NULL DEFAULT '',
  dst_slug      TEXT NOT NULL DEFAULT '',

  -- Relationship kind. Currently only 'mention' (generic related-to). Typed
  -- supersede/depend/conflict edges are a follow-up.
  edge_kind     TEXT NOT NULL DEFAULT 'mention',

  updated_at    TEXT NOT NULL DEFAULT '',

  PRIMARY KEY (src_vector_id, dst_vector_id)
);

-- Reverse-direction lookups for undirected traversal.
CREATE INDEX IF NOT EXISTS idx_doc_edges_dst  ON doc_edges (dst_vector_id);
-- Per-repo scoping of traversal.
CREATE INDEX IF NOT EXISTS idx_doc_edges_repo ON doc_edges (repo);

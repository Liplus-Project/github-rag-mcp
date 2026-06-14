/**
 * D1 graph layer — opt-in GraphRAG over wiki Decision Structure entries.
 *
 * Layer = L4 Operations (graph retrieval surface)
 *
 * Additive sibling of fts.ts (sparse / BM25) and Vectorize (dense). The default
 * retrieval path never touches this layer; it is consulted only when the `search`
 * tool is called with `graph_expand=true`.
 *
 * Edges are deterministic slug-mention references between wiki pages: when page A's
 * content mentions page B's slug, an A→B "mention" edge is recorded. The dst vector
 * ID is computed with wikiDocVectorId() (no lookup, dangling allowed). Extraction is
 * exact string matching — no LLM, no lossy relation extraction.
 *
 * Traversal uses a recursive CTE (standard SQLite, no extension) and treats edges
 * as undirected so a query can reach both referencing and referenced neighbors.
 */

import { wikiDocVectorId } from "./pipeline/vector-id.js";

/** One outbound edge from a source page. */
export interface DocEdge {
  dstVectorId: string;
  dstSlug: string;
  edgeKind: string; // "mention" for now
}

/** A neighbor produced by graph traversal. */
export interface GraphNeighbor {
  vectorId: string;
  hop: number;
  fromVectorId: string;
}

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `content` references the kebab-case `slug` as a standalone token.
 * Requires the slug not to be flanked by [a-z0-9-] so that a slug which is a
 * substring of a longer slug (e.g. "decision-structure" inside
 * "decision-structure-rename-rationale") does not produce a false edge.
 */
export function mentionsSlug(content: string, slug: string): boolean {
  if (slug.length === 0 || !content.includes(slug)) return false;
  const re = new RegExp(`(^|[^a-z0-9-])${escapeRegExp(slug)}([^a-z0-9-]|$)`);
  return re.test(content);
}

/**
 * Extract mention edges from a wiki page's content. For each known slug in the
 * same repo (other than the source) that the content references, emit an edge to
 * its deterministically-computed wiki vector ID.
 */
export async function extractMentionEdges(
  repo: string,
  srcSlug: string,
  content: string,
  knownSlugs: string[],
): Promise<DocEdge[]> {
  const edges: DocEdge[] = [];
  const seen = new Set<string>();
  for (const slug of knownSlugs) {
    if (slug === srcSlug || seen.has(slug)) continue;
    if (mentionsSlug(content, slug)) {
      seen.add(slug);
      edges.push({
        dstVectorId: await wikiDocVectorId(repo, slug),
        dstSlug: slug,
        edgeKind: "mention",
      });
    }
  }
  return edges;
}

/** Fetch the known wiki page slugs for a repo from the FTS content table. */
export async function knownWikiSlugs(
  db: D1Database,
  repo: string,
): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT doc_path FROM search_docs WHERE type = 'wiki_doc' AND repo = ?`,
    )
    .bind(repo)
    .all<{ doc_path: string }>();
  return (res.results ?? [])
    .map((r) => String(r.doc_path ?? ""))
    .filter((s) => s.length > 0);
}

/**
 * Replace all outbound edges for a source node (delete-then-insert) so a re-index
 * of the same page does not accumulate stale edges.
 */
export async function upsertEdges(
  db: D1Database,
  srcVectorId: string,
  repo: string,
  srcSlug: string,
  edges: DocEdge[],
): Promise<void> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM doc_edges WHERE src_vector_id = ?`).bind(srcVectorId),
  ];
  for (const e of edges) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO doc_edges
             (src_vector_id, dst_vector_id, repo, src_slug, dst_slug, edge_kind, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(srcVectorId, e.dstVectorId, repo, srcSlug, e.dstSlug, e.edgeKind, now),
    );
  }
  await db.batch(stmts);
}

/**
 * Convenience: extract + upsert mention edges for one wiki page. Called from the
 * ingest pipeline right after the page is written to Vectorize + FTS5.
 */
export async function indexWikiEdges(
  db: D1Database,
  repo: string,
  srcSlug: string,
  srcVectorId: string,
  content: string,
): Promise<number> {
  const known = await knownWikiSlugs(db, repo);
  const edges = await extractMentionEdges(repo, srcSlug, content, known);
  await upsertEdges(db, srcVectorId, repo, srcSlug, edges);
  return edges.length;
}

/** Remove every edge touching a vector ID (as src or dst). For delete fan-out. */
export async function deleteEdgesForVector(
  db: D1Database,
  vectorId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM doc_edges WHERE src_vector_id = ? OR dst_vector_id = ?`)
    .bind(vectorId, vectorId)
    .run();
}

/**
 * Traverse up to `hops` (1–2) neighbors of the seed vector IDs via a recursive CTE.
 * Edges are followed in both directions. Returns neighbors NOT in the seed set,
 * each with its shortest hop distance and one originating seed.
 */
export async function queryNeighbors(
  db: D1Database,
  seedVectorIds: string[],
  opts: { hops?: number; repo?: string; limit?: number } = {},
): Promise<GraphNeighbor[]> {
  const seeds = [...new Set(seedVectorIds)].filter((s) => s.length > 0);
  if (seeds.length === 0) return [];
  const hops = Math.max(1, Math.min(2, opts.hops ?? 1));
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  // Anchor: each seed at depth 0 with itself as origin.
  const seedValues = seeds.map(() => "(?, 0, ?)").join(", ");
  const repoFilter = opts.repo ? "AND e.repo = ?" : "";

  const sql = `
    WITH RECURSIVE reach(id, depth, origin) AS (
      SELECT * FROM (VALUES ${seedValues})
      UNION
      SELECT CASE WHEN e.src_vector_id = r.id THEN e.dst_vector_id
                  ELSE e.src_vector_id END,
             r.depth + 1,
             r.origin
        FROM doc_edges e
        JOIN reach r
          ON (e.src_vector_id = r.id OR e.dst_vector_id = r.id)
       WHERE r.depth < ? ${repoFilter}
    )
    SELECT id, MIN(depth) AS hop, origin
      FROM reach
     WHERE depth > 0
     GROUP BY id
     ORDER BY hop ASC
     LIMIT ?
  `;

  const binds: (string | number)[] = [];
  for (const s of seeds) binds.push(s, s); // (id, origin) per seed VALUES row
  binds.push(hops);
  if (opts.repo) binds.push(opts.repo);
  binds.push(limit);

  const res = await db
    .prepare(sql)
    .bind(...binds)
    .all<{ id: string; hop: number; origin: string }>();

  const seedSet = new Set(seeds);
  return (res.results ?? [])
    .map((r) => ({
      vectorId: String(r.id ?? ""),
      hop: Number(r.hop ?? 0),
      fromVectorId: String(r.origin ?? ""),
    }))
    .filter((n) => n.vectorId.length > 0 && !seedSet.has(n.vectorId));
}

/**
 * Fetch search_docs rows by vector ID, keyed by vector_id. Used to enrich graph
 * neighbors that did not appear in the dense/sparse result sets.
 */
export async function getDocsByVectorIds(
  db: D1Database,
  vectorIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const ids = [...new Set(vectorIds)].filter((s) => s.length > 0);
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => "?").join(", ");
  const res = await db
    .prepare(`SELECT * FROM search_docs WHERE vector_id IN (${placeholders})`)
    .bind(...ids)
    .all<Record<string, unknown>>();
  for (const r of res.results ?? []) {
    out.set(String(r.vector_id ?? ""), r);
  }
  return out;
}

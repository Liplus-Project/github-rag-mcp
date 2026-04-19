/**
 * D1 FTS5 sparse retrieval layer — BM25 side of hybrid search.
 *
 * Layer = L4 Operations (sparse retrieval surface)
 *
 * Responsibilities:
 * - Index tokenizable content into the D1 FTS5 virtual tables (`search_docs_nat_fts`,
 *   `search_docs_code_fts`) via the `search_docs` content-owner table.
 * - Query FTS5 by a natural language or code-oriented query using BM25 ranking.
 * - Delete rows when the canonical surface is removed (issue/PR/release/doc).
 *
 * Notes:
 * - FTS5 is SQLite's built-in full-text search extension. Cloudflare D1 is pre-compiled
 *   with FTS5, so no extension loading is required; the `fts5` module name must be lowercase.
 * - We keep two FTS5 virtual tables with different tokenizers:
 *     - `search_docs_nat_fts`  — porter + unicode61 for natural-language surfaces
 *     - `search_docs_code_fts` — trigram for code / SHA / identifier surfaces (diffs)
 *   Rows are written to exactly one based on `tokenizer_kind`.
 * - BM25 is invoked via the `bm25(<fts_table>)` auxiliary function. Smaller value = better.
 *   We convert to a rank (1..N) for RRF fusion in the retrieval path.
 */

import type { DiffFileStatus, VectorMetadata } from "./types.js";

/** Which FTS5 virtual table a row is indexed in. */
export type TokenizerKind = "nat" | "code";

/** Return the appropriate tokenizer kind for a given surface type. */
export function tokenizerKindForType(
  type: VectorMetadata["type"],
): TokenizerKind {
  return type === "diff" ? "code" : "nat";
}

/**
 * Row payload for upserting a tokenizable document into D1 FTS5.
 * vector_id mirrors the deterministic Vectorize vector ID so RRF fusion
 * can join sparse and dense hits without an extra round-trip.
 */
export interface FtsUpsertRow {
  vectorId: string;
  repo: string;
  type: VectorMetadata["type"];
  state: string;
  labels: string;      // comma-separated, mirrors VectorMetadata.labels
  milestone: string;
  assignees: string;   // comma-separated, mirrors VectorMetadata.assignees
  updatedAt: string;
  number?: number;
  tagName?: string;
  docPath?: string;
  commitSha?: string;
  filePath?: string;
  fileStatus?: DiffFileStatus | "";
  commitDate?: string;
  commitAuthor?: string;
  content: string;     // tokenizable text (title+body or commit msg + path + patch)
}

/** Escape a query term for FTS5 MATCH syntax (wrap each token in double quotes). */
export function escapeFtsQuery(raw: string): string {
  // Split on whitespace, drop empties, quote each token.
  // Double quotes inside are escaped by doubling them per FTS5 syntax.
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ");
}

/**
 * Upsert a single row into D1 search_docs. Triggers on the table mirror the content
 * into the matching FTS5 virtual table. Safe to call repeatedly for the same vector_id.
 */
export async function upsertFtsRow(
  db: D1Database,
  row: FtsUpsertRow,
): Promise<void> {
  const tokenizerKind: TokenizerKind = tokenizerKindForType(row.type);
  const now = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO search_docs (
         vector_id, repo, type, state, labels, milestone, assignees, updated_at,
         number, tag_name, doc_path, commit_sha, file_path, file_status,
         commit_date, commit_author, tokenizer_kind, content, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (vector_id) DO UPDATE SET
         repo            = excluded.repo,
         type            = excluded.type,
         state           = excluded.state,
         labels          = excluded.labels,
         milestone       = excluded.milestone,
         assignees       = excluded.assignees,
         updated_at      = excluded.updated_at,
         number          = excluded.number,
         tag_name        = excluded.tag_name,
         doc_path        = excluded.doc_path,
         commit_sha      = excluded.commit_sha,
         file_path       = excluded.file_path,
         file_status     = excluded.file_status,
         commit_date     = excluded.commit_date,
         commit_author   = excluded.commit_author,
         tokenizer_kind  = excluded.tokenizer_kind,
         content         = excluded.content,
         indexed_at      = excluded.indexed_at`,
    )
    .bind(
      row.vectorId,
      row.repo,
      row.type,
      row.state,
      row.labels,
      row.milestone,
      row.assignees,
      row.updatedAt,
      row.number ?? 0,
      row.tagName ?? "",
      row.docPath ?? "",
      row.commitSha ?? "",
      row.filePath ?? "",
      row.fileStatus ?? "",
      row.commitDate ?? "",
      row.commitAuthor ?? "",
      tokenizerKind,
      row.content,
      now,
    )
    .run();
}

/** Delete a single row by its vector_id. FTS5 rows are removed via the delete trigger. */
export async function deleteFtsRow(
  db: D1Database,
  vectorId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM search_docs WHERE vector_id = ?`)
    .bind(vectorId)
    .run();
}

/** Hit returned by FTS5 BM25 query. `score` is the raw bm25() value (lower = better). */
export interface FtsHit {
  vectorId: string;
  repo: string;
  type: string;
  state: string;
  labels: string;
  milestone: string;
  assignees: string;
  updatedAt: string;
  number: number;
  tagName: string;
  docPath: string;
  commitSha: string;
  filePath: string;
  fileStatus: string;
  commitDate: string;
  commitAuthor: string;
  content: string;
  score: number;
}

/** Filter parameters accepted by the sparse retrieval path. Mirrors the dense side. */
export interface FtsFilter {
  repo?: string;
  type?: VectorMetadata["type"];
  state?: "open" | "closed" | "published" | "active";
  milestone?: string;
}

/**
 * Query both FTS5 virtual tables and return the top-N hits by BM25 score.
 *
 * The query is escaped and run against both tokenizers (`nat`, `code`). The two
 * result sets are combined and sorted by BM25 score (lower = better) before the
 * caller applies RRF.
 *
 * Additional filters (`repo`, `type`, `state`, `milestone`) are expressed as
 * SQL WHERE predicates on the joined `search_docs` table, matching the
 * pre-filter capability of the Vectorize side.
 */
export async function queryFts(
  db: D1Database,
  query: string,
  topK: number,
  filter?: FtsFilter,
): Promise<FtsHit[]> {
  const match = escapeFtsQuery(query);
  if (match === "") return [];

  // Build dynamic WHERE clause for metadata filters.
  const whereClauses: string[] = [];
  const params: (string | number)[] = [match];
  if (filter?.repo) {
    whereClauses.push("d.repo = ?");
    params.push(filter.repo);
  }
  if (filter?.type) {
    whereClauses.push("d.type = ?");
    params.push(filter.type);
  }
  if (filter?.state) {
    whereClauses.push("d.state = ?");
    params.push(filter.state);
  }
  if (filter?.milestone) {
    whereClauses.push("d.milestone = ?");
    params.push(filter.milestone);
  }
  const whereSql =
    whereClauses.length > 0 ? ` AND ${whereClauses.join(" AND ")}` : "";

  // Two UNION ALL branches so each tokenizer contributes hits. The outer ORDER BY
  // then picks the best BM25 score across both. `bm25()` returns negative values
  // in D1's FTS5 (larger-magnitude negative = better match), so ASC orders
  // best-first regardless of sign.
  const sql = `
    SELECT * FROM (
      SELECT d.vector_id AS vector_id, d.repo, d.type, d.state, d.labels,
             d.milestone, d.assignees, d.updated_at,
             d.number, d.tag_name, d.doc_path, d.commit_sha, d.file_path, d.file_status,
             d.commit_date, d.commit_author, d.content,
             bm25(search_docs_nat_fts) AS score
        FROM search_docs_nat_fts f
        JOIN search_docs d ON d.rowid = f.rowid
       WHERE search_docs_nat_fts MATCH ?${whereSql}
       LIMIT ?
      UNION ALL
      SELECT d.vector_id AS vector_id, d.repo, d.type, d.state, d.labels,
             d.milestone, d.assignees, d.updated_at,
             d.number, d.tag_name, d.doc_path, d.commit_sha, d.file_path, d.file_status,
             d.commit_date, d.commit_author, d.content,
             bm25(search_docs_code_fts) AS score
        FROM search_docs_code_fts f
        JOIN search_docs d ON d.rowid = f.rowid
       WHERE search_docs_code_fts MATCH ?${whereSql}
       LIMIT ?
    )
    ORDER BY score ASC
    LIMIT ?
  `;

  // The two UNION branches bind the same filter params; concatenate params twice + add topK caps.
  const bindArgs: (string | number)[] = [
    ...params,
    topK,
    ...params,
    topK,
    topK,
  ];

  const stmt = db.prepare(sql).bind(...bindArgs);
  const result = await stmt.all<Record<string, unknown>>();
  const rows = result.results ?? [];

  return rows.map((r) => ({
    vectorId: String(r.vector_id ?? ""),
    repo: String(r.repo ?? ""),
    type: String(r.type ?? ""),
    state: String(r.state ?? ""),
    labels: String(r.labels ?? ""),
    milestone: String(r.milestone ?? ""),
    assignees: String(r.assignees ?? ""),
    updatedAt: String(r.updated_at ?? ""),
    number: Number(r.number ?? 0),
    tagName: String(r.tag_name ?? ""),
    docPath: String(r.doc_path ?? ""),
    commitSha: String(r.commit_sha ?? ""),
    filePath: String(r.file_path ?? ""),
    fileStatus: String(r.file_status ?? ""),
    commitDate: String(r.commit_date ?? ""),
    commitAuthor: String(r.commit_author ?? ""),
    content: String(r.content ?? ""),
    score: Number(r.score ?? 0),
  }));
}

/**
 * Convert a list of hits (already ordered best-first) to a rank map keyed by vector_id.
 * Used by RRF fusion — rank 1 is the best hit.
 */
export function toRankMap<T extends { vectorId?: string }>(
  hits: Array<T & { vectorId: string }>,
): Map<string, number> {
  const ranks = new Map<string, number>();
  for (let i = 0; i < hits.length; i++) {
    const id = hits[i].vectorId;
    if (!ranks.has(id)) {
      ranks.set(id, i + 1);
    }
  }
  return ranks;
}

/**
 * Reciprocal Rank Fusion.
 *
 * Standard RRF formula:
 *   score(d) = sum_over_rankers ( 1 / (k + rank(d)) )
 *
 * k = 60 is the canonical value from Cormack et al. (2009) and is the de-facto
 * default in production hybrid retrieval systems (Elasticsearch, Vespa, Milvus).
 *
 * Higher fused score = better hit. Hits that appear in only one ranker still get
 * partial credit from that ranker's contribution.
 */
export interface RrfInput {
  /** ranker name → rank map (vectorId → 1-based rank). */
  rankers: Map<string, Map<string, number>>;
  /** RRF constant, default 60. */
  k?: number;
}

export function reciprocalRankFusion(
  input: RrfInput,
): Array<{ vectorId: string; fusedScore: number; contributions: Record<string, number | null> }> {
  const k = input.k ?? 60;
  const totals = new Map<string, number>();
  const contributions = new Map<string, Record<string, number | null>>();

  // Collect the union of ids across rankers.
  const allIds = new Set<string>();
  for (const [, ranks] of input.rankers) {
    for (const id of ranks.keys()) {
      allIds.add(id);
    }
  }

  for (const id of allIds) {
    let total = 0;
    const perRanker: Record<string, number | null> = {};
    for (const [name, ranks] of input.rankers) {
      const r = ranks.get(id);
      if (r !== undefined) {
        total += 1 / (k + r);
        perRanker[name] = r;
      } else {
        perRanker[name] = null;
      }
    }
    totals.set(id, total);
    contributions.set(id, perRanker);
  }

  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([vectorId, fusedScore]) => ({
      vectorId,
      fusedScore,
      contributions: contributions.get(vectorId) ?? {},
    }));
}

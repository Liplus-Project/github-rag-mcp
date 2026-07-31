/**
 * D1 FTS5 sparse retrieval layer — BM25 side of hybrid search.
 *
 * Layer = L4 Operations (sparse retrieval surface)
 *
 * Responsibilities:
 * - Index tokenizable content into the D1 FTS5 virtual tables (`search_docs_nat_fts_v2`,
 *   `search_docs_code_fts_v2`) via the `search_docs` content-owner table.
 * - Query FTS5 by a natural language or code-oriented query using BM25 ranking.
 * - Delete rows when the canonical surface is removed (issue/PR/release/doc).
 *
 * Notes:
 * - FTS5 is SQLite's built-in full-text search extension. Cloudflare D1 is pre-compiled
 *   with FTS5, so no extension loading is required; the `fts5` module name must be lowercase.
 * - We keep two FTS5 virtual tables with different tokenizers:
 *     - `search_docs_nat_fts_v3`  — porter + unicode61 for natural-language surfaces
 *     - `search_docs_code_fts_v2` — trigram for code / SHA / identifier surfaces (diffs)
 *   Rows are written to exactly one based on `tokenizer_kind`.
 * - The nat index takes its text from `search_docs.content_fts`, which holds the
 *   `Intl.Segmenter`-segmented form of the content (see ./segment.ts). `unicode61`
 *   cannot split Japanese on its own, so the word boundaries are inserted before the
 *   text reaches SQLite — on the ingest side AND on the query side, symmetrically
 *   (issue #180 fact 1 / #182). The code index keeps using the raw `content`: trigram
 *   already substring-matches Japanese.
 * - BM25 is invoked via the `bm25(<fts_table>)` auxiliary function. Smaller value = better.
 *   We convert to a rank (1..N) for RRF fusion in the retrieval path.
 */

import { segmentForFts } from "./segment.js";
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
 * Text to index in / match against the natural-language FTS5 index for a given
 * tokenizer kind. Single source for the ingest side (`content_fts`) and the query
 * side (nat MATCH string) so the two can never drift apart — an asymmetric
 * segmentation silently loses recall instead of failing.
 *
 * `code` rows are indexed raw: the trigram tokenizer needs the original characters.
 */
export function ftsIndexText(text: string, kind: TokenizerKind): string {
  return kind === "nat" ? segmentForFts(text) : text;
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
         commit_date, commit_author, tokenizer_kind, content, content_fts, indexed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         content_fts     = excluded.content_fts,
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
      ftsIndexText(row.content, tokenizerKind),
      now,
    )
    .run();
}

/** Outcome of one `backfillNatSegments` batch. */
export interface SegmentBackfillResult {
  /** Rows examined in this batch. */
  scanned: number;
  /** Rows whose `content_fts` actually changed (and were rewritten). */
  updated: number;
  /** Pass back as `cursor` to continue; `null` once the scan is exhausted. */
  nextCursor: number | null;
}

/**
 * Re-segment one batch of natural-language rows into `content_fts`.
 *
 * Migration 0006 seeds `content_fts` with a copy of the raw content because the
 * segmentation only exists in JS. This walks the nat rows and rewrites the ones whose
 * stored form differs from the current segmentation; the UPDATE trigger re-syncs the
 * v3 FTS index per row.
 *
 * Batched on purpose: one bulk UPDATE would fire the trigger for every row in a single
 * statement and blow both the D1 statement budget and the Worker subrequest budget.
 * Each call issues at most two D1 operations (one SELECT, one batched UPDATE).
 *
 * Resumable and idempotent: progress is a plain `rowid` cursor, and a row whose
 * `content_fts` already matches is skipped, so re-running an interrupted backfill from
 * the beginning converges without rewriting the work that already landed.
 */
export async function backfillNatSegments(
  db: D1Database,
  opts: { limit: number; cursor?: number; repo?: string },
): Promise<SegmentBackfillResult> {
  const cursor = opts.cursor ?? 0;
  const selectParams: (string | number)[] = [cursor];
  let repoSql = "";
  if (opts.repo) {
    repoSql = " AND repo = ?";
    selectParams.push(opts.repo);
  }
  selectParams.push(opts.limit);

  const res = await db
    .prepare(
      `SELECT rowid AS rid, content, content_fts
         FROM search_docs
        WHERE tokenizer_kind = 'nat' AND rowid > ?${repoSql}
        ORDER BY rowid
        LIMIT ?`,
    )
    .bind(...selectParams)
    .all<{ rid: number; content: string; content_fts: string }>();

  const rows = res.results ?? [];
  if (rows.length === 0) return { scanned: 0, updated: 0, nextCursor: null };

  const update = db.prepare(`UPDATE search_docs SET content_fts = ? WHERE rowid = ?`);
  const pending: D1PreparedStatement[] = [];
  for (const r of rows) {
    const segmented = ftsIndexText(String(r.content ?? ""), "nat");
    if (segmented !== String(r.content_fts ?? "")) {
      pending.push(update.bind(segmented, Number(r.rid)));
    }
  }
  if (pending.length > 0) await db.batch(pending);

  return {
    scanned: rows.length,
    updated: pending.length,
    // A short page means the scan reached the end of the table.
    nextCursor: rows.length < opts.limit ? null : Number(rows[rows.length - 1].rid),
  };
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
  // Each branch gets its own MATCH string. The nat index stores segmented text
  // (`content_fts`), so the query must be segmented the same way or a Japanese phrase
  // matches nothing; the code index stores raw text, so it must NOT be segmented or
  // the inserted spaces would break the trigram substring match.
  const matchNat = escapeFtsQuery(ftsIndexText(query, "nat"));
  const matchCode = escapeFtsQuery(ftsIndexText(query, "code"));
  // Segmentation only inserts/removes whitespace, so the two are empty together —
  // an empty or whitespace-only query. Never bind "" as a MATCH argument.
  if (matchNat === "" || matchCode === "") return [];

  // Build dynamic WHERE clause for metadata filters. Shared by both branches; only
  // the leading MATCH parameter differs, so it is bound per branch below.
  const whereClauses: string[] = [];
  const params: (string | number)[] = [];
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

  // Two UNION ALL branches so each tokenizer contributes hits. The nat branch reads
  // the v3 index created by migration 0006 (external content = the segmented
  // `content_fts` column); the code branch stays on the v2 trigram index created by
  // migration 0005 (external content = the raw `content` column). Superseded
  // generations (nat v2, and both v1 tables) are intentionally left untouched — they
  // may hold invalid delete entries, and rewriting them is what corrupts an
  // external-content index.
  //
  // The outer ORDER BY then picks the best BM25 score across both. `bm25()` returns
  // negative values in D1's FTS5 (larger-magnitude negative = better match), so ASC
  // orders best-first regardless of sign.
  //
  // Per-branch `ORDER BY score ASC LIMIT ?` must live inside a subquery because
  // SQLite's compound SELECT (UNION ALL) forbids LIMIT directly on its arms —
  // D1 rejects such queries with `D1_ERROR: LIMIT clause should come after
  // UNION ALL not before` (observed via Workers Observability, 2026-04-24).
  const sql = `
    SELECT * FROM (
      SELECT * FROM (
        SELECT d.vector_id AS vector_id, d.repo, d.type, d.state, d.labels,
               d.milestone, d.assignees, d.updated_at,
               d.number, d.tag_name, d.doc_path, d.commit_sha, d.file_path, d.file_status,
               d.commit_date, d.commit_author, d.content,
               bm25(search_docs_nat_fts_v3) AS score
          FROM search_docs_nat_fts_v3 f
          JOIN search_docs d ON d.rowid = f.rowid
         WHERE search_docs_nat_fts_v3 MATCH ?${whereSql}
         ORDER BY score ASC
         LIMIT ?
      )
      UNION ALL
      SELECT * FROM (
        SELECT d.vector_id AS vector_id, d.repo, d.type, d.state, d.labels,
               d.milestone, d.assignees, d.updated_at,
               d.number, d.tag_name, d.doc_path, d.commit_sha, d.file_path, d.file_status,
               d.commit_date, d.commit_author, d.content,
               bm25(search_docs_code_fts_v2) AS score
          FROM search_docs_code_fts_v2 f
          JOIN search_docs d ON d.rowid = f.rowid
         WHERE search_docs_code_fts_v2 MATCH ?${whereSql}
         ORDER BY score ASC
         LIMIT ?
      )
    )
    ORDER BY score ASC
    LIMIT ?
  `;

  // Each UNION branch binds its own MATCH string first, then the shared filter
  // params, then its topK cap; the outer LIMIT takes the final topK.
  const bindArgs: (string | number)[] = [
    matchNat,
    ...params,
    topK,
    matchCode,
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

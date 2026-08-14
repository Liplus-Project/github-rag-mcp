/**
 * Fetch mode — the `vector_ids` branch of the `search` tool.
 *
 * Hands back the body text the index already holds for rows the caller names.
 * The search path reads that text on every query — the reranker is fed from it,
 * and dense-only candidates have it backfilled from D1 (`getDocsByVectorIds`) —
 * and then drops it on the way out for every type except `doc` / `wiki_doc`. So
 * locating something with `search` and then reading it took a second round trip
 * through `gh` or grep. This branch closes that trip without touching GitHub.
 *
 * What comes back is NOT the source body. It is the index's copy: the embedding
 * input, truncated at `MAX_EMBEDDING_INPUT_CHARS` by the ingest pipeline. Once
 * inlined the two are indistinguishable, so the shape states which it is —
 * `content_source: "index"` and `content_max_chars` on the response,
 * `content_truncated` per item.
 *
 * A separate axis from `include_content`, not a widening of it. That flag reads
 * the GitHub contents API because a doc needs the *whole* file, and its cap
 * (`INCLUDE_CONTENT_MAX_DOCS`) exists to bound API fan-out. This one reads D1
 * and is bounded by the ids the caller listed. Same word ("content"), different
 * source and different bound — one flag over both would be one guarantee over
 * two behaviors.
 *
 * No `url` field: identity columns are echoed so a caller can correlate rows,
 * but the URL was already carried by the search result the `vector_id` came
 * from, and rebuilding it here would be a second copy of `buildResultUrl` to
 * drift against.
 *
 * Lives outside `mcp.ts` — like `scan.ts` — so the assembly can be exercised
 * against a real D1 in the workers pool without standing up the MCP server.
 */

import { getDocsByVectorIds } from "./graph.js";
import { MAX_EMBEDDING_INPUT_CHARS } from "./pipeline/embedding.js";

/**
 * Upper bound on ids accepted per call. Mirrors the `top_k` ceiling (and
 * `RERANK_MAX_CANDIDATES`) so one page of search results can be fetched in one
 * call, and keeps the `vector_id IN (...)` placeholder list bounded.
 *
 * Not a content-size cap: the caller names its rows, so nothing here has to
 * guess how many bytes are safe to return.
 */
export const FETCH_MAX_VECTOR_IDS = 50;

/** Where the returned text came from. Constant, and stated in every response. */
export const FETCH_CONTENT_SOURCE = "index" as const;

/** Character ceiling the ingest pipeline applied to the stored text. */
export const FETCH_CONTENT_MAX_CHARS = MAX_EMBEDDING_INPUT_CHARS;

/** One fetched row: identity columns plus the stored text and its provenance. */
export interface FetchItem {
  vector_id: string;
  repo: string;
  type: string;
  state: string;
  number: number;
  updated_at: string;
  content: string;
  content_chars: number;
  /**
   * True when the stored text sits at the ingest ceiling, i.e. the tail of the
   * source body is not in the index and this content is a prefix of it.
   *
   * Read off the length rather than recorded at ingest, so a body whose natural
   * length is exactly the ceiling reports as truncated. That is the safer error:
   * the caller re-reads a complete body it did not have to, instead of treating
   * a prefix as whole.
   */
  content_truncated: boolean;
  tag_name?: string;
  doc_path?: string;
  wiki_path?: string;
  commit_sha?: string;
  file_path?: string;
  file_status?: string;
  commit_date?: string;
  commit_author?: string;
}

/** Fetch-mode response payload, serialized as-is by the tool handler. */
export interface FetchResponse {
  count: number;
  mode: "fetch";
  /** Distinct ids actually looked up (after de-duplication). */
  requested: number;
  content_source: typeof FETCH_CONTENT_SOURCE;
  content_max_chars: number;
  /**
   * Ids that matched no row. Partial success is the contract: one stale id
   * never empties the response, because `vector_id` is explicitly a handle
   * rather than a durable identifier and a caller replaying an old one must
   * still get the rows that are live.
   */
  not_found: string[];
  results: FetchItem[];
}

/**
 * Assemble one item from a `search_docs` row.
 *
 * Type-conditional fields follow the same rule the search path uses: only the
 * columns that carry meaning for that type are attached, so a consumer cannot
 * read an empty-string default as a real value. `wiki_doc` reuses the
 * `doc_path` column for its page slug (schema-level unification, see
 * `resolveRow` in `mcp.ts`), which is why it maps to `wiki_path` here.
 */
export function buildFetchItem(
  vectorId: string,
  row: Record<string, unknown>,
): FetchItem {
  const type = String(row.type ?? "");
  const content = String(row.content ?? "");
  const path = String(row.doc_path ?? "");
  const item: FetchItem = {
    vector_id: vectorId,
    repo: String(row.repo ?? ""),
    type,
    state: String(row.state ?? ""),
    number: Number(row.number ?? 0),
    updated_at: String(row.updated_at ?? ""),
    content,
    content_chars: content.length,
    content_truncated: content.length >= MAX_EMBEDDING_INPUT_CHARS,
  };
  if (type === "release") item.tag_name = String(row.tag_name ?? "");
  if (type === "doc") item.doc_path = path;
  if (type === "wiki_doc") item.wiki_path = path;
  if (type === "diff") {
    item.commit_sha = String(row.commit_sha ?? "");
    item.file_path = String(row.file_path ?? "");
    item.file_status = String(row.file_status ?? "");
    item.commit_date = String(row.commit_date ?? "");
    item.commit_author = String(row.commit_author ?? "");
  }
  if (type === "pr_review_comment") {
    // The inline-comment ingest is the other writer of these two columns: they
    // locate the comment in the diff it was left on.
    item.file_path = String(row.file_path ?? "");
    item.commit_sha = String(row.commit_sha ?? "");
  }
  return item;
}

/**
 * Read the stored content of the named rows in ONE batched D1 query.
 *
 * Ids are de-duplicated and the response preserves the caller's order, so a
 * result can be lined up against the list that produced it. Blank ids are
 * dropped before the query rather than reported as missing — they name nothing.
 *
 * A D1 failure is NOT swallowed into an all-missing response: "these rows do
 * not exist" is a claim this function must not make on a read it never
 * completed. The caller turns a throw into an explicit error.
 */
export async function fetchStoredContent(
  db: D1Database,
  vectorIds: string[],
): Promise<FetchResponse> {
  const ids = [...new Set(vectorIds.map((v) => v.trim()))].filter(
    (v) => v.length > 0,
  );
  const rows =
    ids.length > 0
      ? await getDocsByVectorIds(db, ids)
      : new Map<string, Record<string, unknown>>();

  const results: FetchItem[] = [];
  const notFound: string[] = [];
  for (const id of ids) {
    const row = rows.get(id);
    if (!row) {
      notFound.push(id);
      continue;
    }
    results.push(buildFetchItem(id, row));
  }

  return {
    count: results.length,
    mode: "fetch",
    requested: ids.length,
    content_source: FETCH_CONTENT_SOURCE,
    content_max_chars: FETCH_CONTENT_MAX_CHARS,
    not_found: notFound,
    results,
  };
}

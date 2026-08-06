/**
 * MCP server factory exposing a single consolidated semantic search tool.
 *
 * Tools:
 *   search — hybrid search + time-ordered activity scan + inline doc
 *                    content fetch. Single entry point for GitHub issue / PR /
 *                    release / doc / commit-diff retrieval.
 *
 * Protocol revision 2026-07-28 (stateless core, issue #224). The server is
 * built fresh per HTTP request by `createMcpHandler` in `index.ts` — there is
 * no session, no `initialize`, and no Durable Object in the serving path. What
 * `McpAgent` used to provide in two roles is now split: instance resolution
 * from a session ID is gone outright, and user identity comes from the OAuth
 * props of the request being served, read through `getMcpAuthContext()`.
 *
 * The Durable Objects that hold real data (`IssueStore`) are untouched; only
 * the MCP-serving DO left the path. Its retired class stubs live in
 * `retired-do.ts` so this module imports nothing from `cloudflare:workers`.
 */

import { getMcpAuthContext } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  Env,
  IssueRecord,
  ReleaseRecord,
  VectorMetadata,
} from "./types.js";
import type { McpProps } from "./oauth.js";
import {
  queryFts,
  detectUnmatchedFilters,
  toRankMap,
  reciprocalRankFusion,
  type FtsHit,
  type FtsFilter,
} from "./fts.js";
import { rerankCandidates, rerankWasApplied, RERANK_MAX_CANDIDATES } from "./rerank.js";
import { queryNeighbors, getDocsByVectorIds } from "./graph.js";
import { runScan, type ScanRow } from "./scan.js";
import { entityKey, groupByEntity } from "./aggregate.js";

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "github-rag-mcp/0.1.0";

/** Get a stub to the global IssueStore DO */
function getStore(env: Env): DurableObjectStub {
  const id = env.ISSUE_STORE.idFromName("global");
  return env.ISSUE_STORE.get(id);
}

/**
 * The authenticated user's GitHub access token for the request being served.
 *
 * The props are the ones `index.ts` wrote onto `ctx` before handing the
 * request to the MCP handler; the handler republishes them per request through
 * an AsyncLocalStorage store, which is what `getMcpAuthContext()` reads. There
 * is no instance field to hold them any more — the server object itself lives
 * only for the duration of one request.
 */
function getGitHubToken(): string {
  const props = getMcpAuthContext()?.props as McpProps | undefined;
  const token = props?.accessToken;
  if (!token) {
    throw new Error("No GitHub access token available");
  }
  return token;
}

/** Build GitHub API request headers using the authenticated user's token */
function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
}

/**
 * Upper bound on how many top-ranked doc rows get their raw content inlined
 * when include_content=true. Separate (and smaller) from top_k to keep
 * GitHub contents API fan-out bounded even when the caller requests a large
 * top_k for generic scanning. Callers that need more should page via
 * additional queries rather than lifting this cap.
 */
const INCLUDE_CONTENT_MAX_DOCS = 5;

/**
 * Per-candidate payload assembled after fusion: the dense metadata, the sparse
 * FTS row, and each ranker's raw score. Either side may be missing — a hit can
 * come from one ranker only.
 */
interface RowPayload {
  meta: VectorMetadata | undefined;
  ftsRow: FtsHit | undefined;
  denseScore: number | undefined;
  sparseScore: number | undefined;
}

/**
 * A candidate's fields resolved from whichever side saw it. Single resolution
 * site for the three consumers that need them: the entity key (aggregation),
 * the result item, and the `same_entity.others` references.
 */
interface ResolvedRow {
  repo: string;
  number: number;
  type: string;
  state: string;
  labelsCsv: string;
  milestone: string;
  assigneesCsv: string;
  updatedAt: string;
  tagName: string;
  docPath: string;
  wikiPath: string;
  wikiExtension: string;
  commitSha: string;
  filePath: string;
  fileStatus: string;
  commitDate: string;
  commitAuthor: string;
  author: string;
  commentId: number;
  reviewId: number;
  line: number;
}

/**
 * Resolve one candidate's fields. Dense metadata wins when present (it carries
 * the dedicated fields), the FTS row fills the gaps for sparse-only hits.
 */
function resolveRow(p: RowPayload | undefined): ResolvedRow {
  const meta = p?.meta;
  const ftsRow = p?.ftsRow;
  const type = meta?.type ?? (ftsRow?.type as VectorMetadata["type"] | undefined) ?? "";
  return {
    repo: meta?.repo ?? ftsRow?.repo ?? "",
    number: meta?.number ?? ftsRow?.number ?? 0,
    type,
    state: meta?.state ?? ftsRow?.state ?? "",
    labelsCsv: meta?.labels ?? ftsRow?.labels ?? "",
    milestone: meta?.milestone ?? ftsRow?.milestone ?? "",
    assigneesCsv: meta?.assignees ?? ftsRow?.assignees ?? "",
    updatedAt: meta?.updated_at ?? ftsRow?.updatedAt ?? "",
    tagName: meta?.tag_name ?? ftsRow?.tagName ?? "",
    docPath: meta?.doc_path ?? ftsRow?.docPath ?? "",
    // wiki_doc rows reuse the FTS5 `doc_path` column for the page slug — the
    // schema-level field is unified across "where did this come from",
    // distinguished by the row's `type`. Vectorize metadata carries the
    // dedicated `wiki_path` / `wiki_extension` fields so we prefer them when
    // present and fall back to the FTS row when the dense hit lost.
    wikiPath: meta?.wiki_path ?? (type === "wiki_doc" ? ftsRow?.docPath ?? "" : ""),
    wikiExtension: meta?.wiki_extension ?? "",
    commitSha: meta?.commit_sha ?? ftsRow?.commitSha ?? "",
    filePath: meta?.file_path ?? ftsRow?.filePath ?? "",
    fileStatus: meta?.file_status ?? ftsRow?.fileStatus ?? "",
    commitDate: meta?.commit_date ?? ftsRow?.commitDate ?? "",
    commitAuthor: meta?.commit_author ?? ftsRow?.commitAuthor ?? "",
    author: meta?.author ?? "",
    commentId: meta?.comment_id ?? 0,
    reviewId: meta?.review_id ?? 0,
    line: meta?.line ?? 0,
  };
}

/** Canonical GitHub URL for a resolved row, by type. */
function buildResultUrl(r: ResolvedRow): string {
  if (r.type === "release" && r.tagName) {
    return `https://github.com/${r.repo}/releases/tag/${r.tagName}`;
  }
  if (r.type === "doc" && r.docPath) {
    return `https://github.com/${r.repo}/blob/main/${r.docPath}`;
  }
  if (r.type === "wiki_doc" && r.wikiPath) {
    return `https://github.com/${r.repo}/wiki/${encodeURIComponent(r.wikiPath)}`;
  }
  if (r.type === "diff" && r.commitSha) {
    return `https://github.com/${r.repo}/commit/${r.commitSha}`;
  }
  if (r.type === "issue_comment" && r.commentId) {
    return `https://github.com/${r.repo}/issues/${r.number}#issuecomment-${r.commentId}`;
  }
  if (r.type === "pr_review" && r.reviewId) {
    return `https://github.com/${r.repo}/pull/${r.number}#pullrequestreview-${r.reviewId}`;
  }
  if (r.type === "pr_review_comment" && r.commentId) {
    return `https://github.com/${r.repo}/pull/${r.number}#discussion_r${r.commentId}`;
  }
  return `https://github.com/${r.repo}/issues/${r.number}`;
}

/**
 * Build the MCP server for one request.
 *
 * Called by `createMcpHandler` once per HTTP request. `env` is captured from
 * the Worker fetch closure; the per-user identity is NOT captured here — it is
 * read at call time from `getMcpAuthContext()`, so one captured `env` serves
 * every user.
 */
export function createRagMcpServer(env: Env): McpServer {
  const server = new McpServer({
    name: "github-rag-mcp",
    version: "0.1.0",
  });

  // ── search ──────────────────────────────────────────
  server.registerTool(
    "search",
    {
      description:
        "Unified search across GitHub issues, PRs, releases, repository documentation, GitHub Wiki pages, " +
        "commit diffs, issue/PR top-level comments, PR reviews, and PR inline review comments. " +
        "Three modes via the query / sort axes:\n" +
        "  1. Hybrid semantic search (default): dense BGE-M3 over Vectorize + sparse BM25 over D1 FTS5, " +
        "fused via Reciprocal Rank Fusion (RRF, k=60), then re-scored with a cross-encoder " +
        "(@cf/baai/bge-reranker-base; set rerank: false to skip).\n" +
        "  2. Time-ordered activity scan: pass an empty (or omitted) query with sort=\"updated_desc\" or \"created_desc\"; " +
        "optionally narrow via since / until to list recent activity across every type.\n" +
        "  3. Doc content fetch: pass include_content: true to inline the raw file content of top doc and wiki_doc results " +
        "(docs via GitHub Contents API, wiki_docs via raw.githubusercontent.com/wiki; capped at the first few rows of each).\n" +
        "Optional metadata filters (repo, state, labels, milestone, assignee, type) apply across all modes; " +
        "repo takes the full slug (owner/repo) and matches exactly, so a bare repository name selects nothing. " +
        "In search mode the response carries filters_unmatched: any filter listed there matched no row in the " +
        "index at all, which separates a mis-specified filter from a genuine zero-hit result. " +
        "Use type: \"doc\" for repository docs (files in /docs/ etc.) and type: \"wiki_doc\" for GitHub Wiki pages — " +
        "both surfaces co-exist and a same-name page in both is returned as two separate hits. " +
        "Use type: \"diff\" to retrieve judgment history preserved in commit diffs — including changes to deleted files " +
        "and non-.md files that are not present in the live document index. " +
        "Use type: \"issue_comment\" / \"pr_review\" / \"pr_review_comment\" to retrieve comment-level judgment history " +
        "(Master's feedback, AI responses, self-review now/later/accepted classifications).\n" +
        "Results are aggregated per underlying entity: a file's doc row and its commit diffs are one result, " +
        "an issue or PR and its comments / reviews are one result. top_k therefore counts distinct entities, " +
        "and a result that absorbed others carries same_entity { count, others[] } with links to them.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe(
            "Natural language search query. When omitted or empty, the tool " +
              "switches to metadata-only scan mode and results are ordered " +
              "by the timestamp implied by sort (default sort=\"updated_desc\" for empty query).",
          ),
        repo: z
          .string()
          .optional()
          .describe(
            "Filter by repository — full slug (owner/repo), exact match. " +
              "A bare repository name (\"my-repo\") matches nothing and yields an empty result set; " +
              "search mode flags that case as \"repo\" in the response's filters_unmatched.",
          ),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .default("all")
          .describe("Filter by state"),
        labels: z
          .array(z.string())
          .optional()
          .describe("Filter by label names (AND logic)"),
        milestone: z
          .string()
          .optional()
          .describe("Filter by milestone title"),
        assignee: z
          .string()
          .optional()
          .describe("Filter by assignee login"),
        type: z
          .enum([
            "issue",
            "pull_request",
            "release",
            "doc",
            "wiki_doc",
            "diff",
            "issue_comment",
            "pr_review",
            "pr_review_comment",
            "all",
          ])
          .optional()
          .default("all")
          .describe(
            "Filter by type (default: all). " +
              "\"doc\" = repository docs (files in /docs/ etc.). " +
              "\"wiki_doc\" = GitHub Wiki pages (separate from repo docs; both surfaces co-exist). " +
              "\"diff\" = per-file commit diffs. " +
              "\"issue_comment\" = top-level comments on issues and PRs. " +
              "\"pr_review\" = PR review bodies (approve / request_changes / comment). " +
              "\"pr_review_comment\" = inline per-line review comments on PR diffs.",
          ),
        top_k: z
          .number()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Max results (default: 10, max: 50)"),
        fusion: z
          .enum(["rrf", "dense_only", "sparse_only"])
          .optional()
          .default("rrf")
          .describe(
            "Fusion strategy. Default: rrf (Reciprocal Rank Fusion over dense + sparse). " +
              "dense_only = Vectorize only. sparse_only = D1 FTS5 BM25 only. " +
              "Use rrf unless debugging a specific ranker. Ignored in metadata-only scan mode (empty query).",
          ),
        rerank: z
          .boolean()
          .optional()
          .default(true)
          .describe(
            "Cross-encoder reranking with @cf/baai/bge-reranker-base. Default: true. " +
              "When enabled, the fused (or single-ranker) candidates are overfetched (top_k × 5, max 50), " +
              "post-filtered, then re-scored by the cross-encoder before being trimmed to top_k. " +
              "Set false to disable (faster, no Workers AI rerank cost; recommended for debugging or " +
              "when query is a short identifier where lexical match is already decisive). " +
              "Ignored in metadata-only scan mode (empty query).",
          ),
        sort: z
          .enum(["relevance", "updated_desc", "created_desc"])
          .optional()
          .describe(
            "Result ordering. Default: \"relevance\" when query is non-empty, \"updated_desc\" when query is empty. " +
              "\"updated_desc\" / \"created_desc\" force time-ordered output and override ranker scores.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp (inclusive) — keep only results whose updated_at >= since. " +
              "Pair with sort=\"updated_desc\" + empty query for an activity scan. " +
              "Default in scan mode: 7 days back from until (or from now when until is omitted).",
          ),
        until: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp (exclusive) — keep only results whose updated_at < until. " +
              "In scan mode the [since, until) window is applied inside the index, so any window " +
              "holding rows returns rows however far back it sits; the response carries " +
              "truncated: true when the window holds more than one page.",
          ),
        include_content: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "When true and a result row is type=\"doc\", fetch the file content from the GitHub " +
              "contents API and inline it as a \"content\" field on that row. Capped at the first " +
              `${INCLUDE_CONTENT_MAX_DOCS} doc rows in the result set to bound API fan-out. ` +
              "Non-doc rows are unaffected.",
          ),
        graph_expand: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Opt-in GraphRAG expansion (search mode only). When true, after fusion the top " +
              "results seed a traversal of the Decision-Structure mention graph (D1 doc_edges); " +
              "related wiki pages are appended as extra results marked with graph_hop / graph_from. " +
              "Default false = byte-identical to standard hybrid retrieval (no graph read).",
          ),
        graph_hops: z
          .number()
          .min(1)
          .max(2)
          .optional()
          .default(1)
          .describe(
            "Graph traversal depth for graph_expand (1 or 2). Default 1. Ignored when graph_expand is false.",
          ),
      }),
    },
    async ({
      query,
      repo,
      state,
      labels,
      milestone,
      assignee,
      type,
      top_k,
      fusion,
      rerank,
      sort,
      since,
      until,
      include_content,
      graph_expand,
      graph_hops,
    }) => {
      const requestedTopK = top_k ?? 10;
      const fusionMode = fusion ?? "rrf";
      const rerankEnabled = rerank ?? true;
      const trimmedQuery = (query ?? "").trim();
      const graphExpand = graph_expand ?? false;
      const graphHops = graph_hops ?? 1;
      const isScanMode = trimmedQuery.length === 0;
      const effectiveSort =
        sort ?? (isScanMode ? "updated_desc" : "relevance");
      const includeContent = include_content ?? false;

      // ── Scan mode (empty query): pull time-ordered metadata ─────
      // Aggregated in `scan.ts`; both window bounds are pushed down to the
      // store so the per-endpoint row cap applies inside [since, until).
      if (isScanMode) {
        const scan = await runScan(getStore(env), {
          repo,
          state,
          labels,
          milestone,
          assignee,
          type,
          topK: requestedTopK,
          sort: effectiveSort,
          since,
          until,
        });

        // Optional doc content inlining (scan mode).
        type ScanResultRow = ScanRow & { content?: string };
        const items: ScanResultRow[] = scan.rows;
        if (includeContent) {
          await inlineDocContent(items, repo);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  count: items.length,
                  mode: "scan",
                  sort: effectiveSort,
                  since: scan.since,
                  until: until ?? null,
                  truncated: scan.truncated,
                  results: items,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      // ── Search mode (non-empty query): existing hybrid pipeline ─
      // Overfetch on both sides (issue #91 default: top_k × 5, capped at 50).
      // RERANK_MAX_CANDIDATES is the AI-side upper bound; we mirror it here
      // so dense and sparse fetch enough rows to feed the reranker.
      //
      // The overfetch used to be conditional (label / assignee post-filter,
      // time window, or reranker enabled). Entity aggregation (#189) removes
      // that condition: every search-mode query now collapses several rows of
      // one referent into a single result, so the candidate pool must exceed
      // top_k on every path — including `rerank: false` — or the caller gets
      // fewer than the top_k it asked for.
      const internalTopK = Math.min(requestedTopK * 5, RERANK_MAX_CANDIDATES);

      // ── Dense path: Vectorize embedding query ────────────────
      const densePromise: Promise<{
        hits: Array<{
          vectorId: string;
          score: number;
          meta: VectorMetadata | undefined;
        }>;
        error?: string;
      }> =
        fusionMode === "sparse_only"
          ? Promise.resolve({ hits: [] })
          : (async () => {
              const aiResult = await env.AI.run("@cf/baai/bge-m3", {
                text: [trimmedQuery],
              });
              const vectors = (aiResult as { data: Array<number[]> }).data;
              if (!vectors || vectors.length === 0) {
                return { hits: [], error: "embedding_failed" };
              }
              const embedding = vectors[0];

              const filter: VectorizeVectorMetadataFilter = {};
              if (repo) filter["repo"] = { $eq: repo };
              if (state && state !== "all") filter["state"] = { $eq: state };
              if (type && type !== "all") filter["type"] = { $eq: type };
              if (milestone) filter["milestone"] = { $eq: milestone };

              const vectorizeFilter: VectorizeVectorMetadataFilter | undefined =
                Object.keys(filter).length > 0 ? filter : undefined;

              const results = await env.VECTORIZE.query(embedding, {
                topK: internalTopK,
                filter: vectorizeFilter,
                returnMetadata: "all",
              });

              return {
                hits: results.matches.map((m) => ({
                  vectorId: m.id,
                  score: m.score,
                  meta: m.metadata as unknown as VectorMetadata | undefined,
                })),
              };
            })();

      // ── Sparse path: D1 FTS5 BM25 query ──────────────────────
      const sparsePromise: Promise<FtsHit[]> =
        fusionMode === "dense_only"
          ? Promise.resolve([])
          : (async () => {
              const ftsFilter: FtsFilter = {};
              if (repo) ftsFilter.repo = repo;
              if (state && state !== "all") {
                ftsFilter.state = state as FtsFilter["state"];
              }
              if (type && type !== "all") {
                ftsFilter.type = type as FtsFilter["type"];
              }
              if (milestone) ftsFilter.milestone = milestone;
              try {
                return await queryFts(env.DB_FTS, trimmedQuery, internalTopK, ftsFilter);
              } catch (err) {
                console.error(
                  "search: D1 FTS5 query failed:",
                  err instanceof Error ? err.message : String(err),
                );
                return [];
              }
            })();

      const [denseResult, sparseHits] = await Promise.all([
        densePromise,
        sparsePromise,
      ]);

      if (denseResult.error === "embedding_failed" && fusionMode !== "sparse_only") {
        return {
          content: [
            { type: "text" as const, text: "Failed to generate embedding for query" },
          ],
          isError: true,
        };
      }

      // ── Filter-match observability (issue #219) ──────────────
      // `repo` filters on both sides by exact match on the full slug —
      // Vectorize metadata `$eq` on the dense side, `d.repo = ?` on the sparse
      // side — so a bare repository name empties BOTH candidate sets at once.
      // The combined count is therefore the right probe condition; the check
      // itself (and why it never asserts on a failed probe) lives in
      // `detectUnmatchedFilters`.
      //
      // Deliberately observability only: the short slug is NOT resolved to a
      // full one. Doing that needs an ambiguity design for a prefix matching
      // several repositories, which is a heavier change (issue #219 non-scope).
      const filtersUnmatched = await detectUnmatchedFilters(
        env.DB_FTS,
        { repo },
        denseResult.hits.length + sparseHits.length,
      );

      // ── Fusion: build rank maps and combine via RRF ──────────
      // Both hit arrays are already ordered best-first by their respective ranker.
      // For dense_only / sparse_only, RRF degenerates to a single-ranker sort,
      // which preserves the original ordering without additional logic.
      const denseRanks = toRankMap(
        denseResult.hits.map((h) => ({ vectorId: h.vectorId })),
      );
      const sparseRanks = toRankMap(
        sparseHits.map((h) => ({ vectorId: h.vectorId })),
      );

      const rankers = new Map<string, Map<string, number>>();
      if (fusionMode !== "sparse_only") rankers.set("dense", denseRanks);
      if (fusionMode !== "dense_only") rankers.set("sparse", sparseRanks);

      const fused = reciprocalRankFusion({ rankers });

      // Build a vector_id → payload lookup combining dense metadata and sparse rows.
      // Dense metadata wins when both sides see a vector; sparse hits fill in the gaps
      // (e.g., when BM25 surfaces a row that dense missed entirely).
      const payload = new Map<string, RowPayload>();
      for (const h of denseResult.hits) {
        payload.set(h.vectorId, {
          meta: h.meta,
          ftsRow: undefined,
          denseScore: h.score,
          sparseScore: undefined,
        });
      }
      for (const h of sparseHits) {
        const existing = payload.get(h.vectorId);
        if (existing) {
          existing.ftsRow = h;
          existing.sparseScore = h.score;
        } else {
          payload.set(h.vectorId, {
            meta: undefined,
            ftsRow: h,
            denseScore: undefined,
            sparseScore: h.score,
          });
        }
      }

      // ── Post-filter: labels (AND), assignee, and time window ─
      // Applied after fusion on the combined view so both dense-only and sparse-only
      // hits are filtered consistently. Prefers dense metadata when available
      // (has expanded label_0..3 / assignee_0..1 slots), falls back to sparse row
      // (comma-separated labels / assignees) otherwise.
      const resolveLabels = (vectorId: string): Set<string> => {
        const p = payload.get(vectorId);
        if (!p) return new Set();
        const out = new Set<string>();
        if (p.meta) {
          for (const l of [p.meta.label_0, p.meta.label_1, p.meta.label_2, p.meta.label_3]) {
            if (l) out.add(l);
          }
          if (p.meta.labels) {
            for (const l of p.meta.labels.split(",")) {
              const t = l.trim();
              if (t) out.add(t);
            }
          }
        }
        if (p.ftsRow?.labels) {
          for (const l of p.ftsRow.labels.split(",")) {
            const t = l.trim();
            if (t) out.add(t);
          }
        }
        return out;
      };

      const resolveAssignees = (vectorId: string): Set<string> => {
        const p = payload.get(vectorId);
        if (!p) return new Set();
        const out = new Set<string>();
        if (p.meta) {
          if (p.meta.assignee_0) out.add(p.meta.assignee_0);
          if (p.meta.assignee_1) out.add(p.meta.assignee_1);
          if (p.meta.assignees) {
            for (const a of p.meta.assignees.split(",")) {
              const t = a.trim();
              if (t) out.add(t);
            }
          }
        }
        if (p.ftsRow?.assignees) {
          for (const a of p.ftsRow.assignees.split(",")) {
            const t = a.trim();
            if (t) out.add(t);
          }
        }
        return out;
      };

      const resolveUpdatedAt = (vectorId: string): string => {
        const p = payload.get(vectorId);
        return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
      };

      let filtered = fused;
      if (labels && labels.length > 0) {
        filtered = filtered.filter((f) => {
          const all = resolveLabels(f.vectorId);
          return labels.every((l) => all.has(l));
        });
      }
      if (assignee) {
        filtered = filtered.filter((f) => {
          const all = resolveAssignees(f.vectorId);
          return all.has(assignee);
        });
      }
      if (since) {
        filtered = filtered.filter((f) => resolveUpdatedAt(f.vectorId) >= since);
      }
      if (until) {
        filtered = filtered.filter((f) => resolveUpdatedAt(f.vectorId) < until);
      }

      // ── Reranker (3rd tier): cross-encoder re-scoring ────────
      // Only invoked when:
      //   - rerank is enabled (default true),
      //   - sort is "relevance" (time-sorted callers do not need ranker score),
      //   - more than one candidate survived post-filter (single-element
      //     reranking would not change order).
      // Content supply: sparse FtsRow carries content inline. Dense-only
      // candidates (no sparse hit) have no FtsRow, so we backfill their
      // content from D1 `search_docs` in ONE batched
      // `vector_id IN (...)` query. Without this backfill every candidate
      // reaches the reranker with an empty string, `rerankCandidates` drops
      // them all, and the cross-encoder never runs (issue #172).
      // The reranker re-orders `filtered` in place. On error or unexpected
      // shape it returns null, in which case we keep the post-filter order.
      const rerankScores = new Map<string, number>();
      let rerankApplied = false;
      if (
        rerankEnabled &&
        effectiveSort === "relevance" &&
        filtered.length > 1
      ) {
        // Backfill content for candidates with no usable sparse content.
        // Bounded by `filtered.length` (already capped by the overfetch
        // budget) and issued as a single batched D1 query — never a
        // per-candidate fan-out. The emptiness test is `trim()`-based to match
        // the filter `rerankCandidates` applies, so a whitespace-only FTS row
        // is treated as missing here rather than silently dropped there.
        const missingContentIds = filtered
          .filter((f) => (payload.get(f.vectorId)?.ftsRow?.content ?? "").trim() === "")
          .map((f) => f.vectorId);
        let backfilled: Map<string, string> = new Map();
        if (missingContentIds.length > 0) {
          try {
            const rows = await getDocsByVectorIds(env.DB_FTS, missingContentIds);
            backfilled = new Map(
              [...rows].map(([vid, row]) => [vid, String(row.content ?? "")]),
            );
          } catch (err) {
            // Backfill is best-effort: a D1 failure must not take the search
            // down. We fall through with whatever content we already have.
            console.error(
              "search: rerank content backfill failed:",
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        const rerankInput = filtered.map((f) => {
          const sparseContent = payload.get(f.vectorId)?.ftsRow?.content ?? "";
          // Prefer sparse content, fall back to the D1 backfill for
          // dense-only hits (and for whitespace-only sparse rows).
          const content =
            sparseContent.trim() !== "" ? sparseContent : backfilled.get(f.vectorId) ?? "";
          return { id: f.vectorId, content };
        });

        const reranked = await rerankCandidates(
          env,
          trimmedQuery,
          rerankInput,
          // Ask the reranker to return all rows so we can attach scores even
          // to candidates that drop below requestedTopK; we trim ourselves.
          rerankInput.length,
        );

        // `reranked` is null on reranker error / malformed response, and an
        // empty array when every candidate had empty content (nothing to
        // score). Both mean "fusion order stands"; only a non-empty result
        // set counts as applied, so `rerank_applied: true` always implies at
        // least one non-null `rerank_score` in the response (issue #172).
        if (rerankWasApplied(reranked)) {
          for (const r of reranked) {
            rerankScores.set(r.id, r.score);
          }
          // Re-order `filtered` by reranker score descending. Candidates
          // missing from the reranker response (defensive: model may drop
          // rows) are appended in their original relative order.
          const rerankedIds = new Set(reranked.map((r) => r.id));
          const byId = new Map(filtered.map((f) => [f.vectorId, f]));
          const reorderedHits: typeof filtered = [];
          for (const r of reranked) {
            const hit = byId.get(r.id);
            if (hit) reorderedHits.push(hit);
          }
          for (const f of filtered) {
            if (!rerankedIds.has(f.vectorId)) reorderedHits.push(f);
          }
          filtered = reorderedHits;
          rerankApplied = true;
        }
      }

      // ── Time sort (override ranker order) ─────────────────────
      // When the caller asked for time-ordered output even on a semantic
      // query, re-sort `filtered` by the requested timestamp column.
      // Rows missing the column fall to the tail (empty string sorts low
      // under localeCompare-desc semantics).
      if (effectiveSort === "updated_desc" || effectiveSort === "created_desc") {
        const resolveTimeKey = (vectorId: string): string => {
          const p = payload.get(vectorId);
          if (effectiveSort === "updated_desc") {
            return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
          }
          // created_desc: VectorMetadata has no created_at; FTS hit has no
          // createdAt either, so both collapse to updated_at as the best
          // available proxy. Documented in the schema description.
          return p?.meta?.updated_at ?? p?.ftsRow?.updatedAt ?? "";
        };
        filtered = [...filtered].sort((a, b) => {
          const av = resolveTimeKey(a.vectorId);
          const bv = resolveTimeKey(b.vectorId);
          return bv.localeCompare(av);
        });
      }

      // ── Entity aggregation (issue #189) ──────────────────────
      // Several rows can point at one referent: a file is a `doc` row plus a
      // `diff` row per commit, an issue or PR is its own row plus its
      // comments / reviews. They crowd out independent results in the same
      // top_k pool. Collapse them here — after every reordering stage, before
      // the trim — so `top_k` counts referents and the representative is
      // whichever row the final order ranked highest (see aggregate.ts for
      // why the newest version is deliberately NOT pinned).
      const groups = groupByEntity(filtered, (f) => {
        const r = resolveRow(payload.get(f.vectorId));
        return entityKey({
          vectorId: f.vectorId,
          repo: r.repo,
          type: r.type,
          number: r.number,
          docPath: r.docPath,
          filePath: r.filePath,
        });
      });

      // vector_id of a representative → the rows folded into it, in rank order.
      const collapsedInto = new Map<string, typeof filtered>();
      for (const g of groups.slice(0, requestedTopK)) {
        if (g.others.length > 0) {
          collapsedInto.set(g.representative.vectorId, g.others);
        }
      }

      // Trim to requested top-K after fusion + post-filter (+ rerank / time
      // sort / entity aggregation).
      filtered = groups.slice(0, requestedTopK).map((g) => g.representative);

      // ── Format results ───────────────────────────────────────
      type ResultItem = {
        number: number;
        title: string;
        state: string;
        type: string;
        labels: string[];
        milestone: string;
        assignees: string[];
        score: number;
        dense_score: number | null;
        sparse_score: number | null;
        dense_rank: number | null;
        sparse_rank: number | null;
        rerank_score: number | null;
        url: string;
        updated_at: string;
        repo: string;
        tag_name?: string;
        doc_path?: string;
        wiki_path?: string;
        wiki_extension?: string;
        commit_sha?: string;
        file_path?: string;
        file_status?: string;
        commit_date?: string;
        commit_author?: string;
        author?: string;
        comment_id?: number;
        review_id?: number;
        line?: number;
        content?: string;
        graph_hop?: number;
        graph_from?: string;
        /**
         * Present only when this item is the representative of an entity that
         * had other rows in the candidate pool (issue #189). `count` includes
         * the representative, so it is always ≥ 2 when the field is present.
         * Additive: a client that ignores it sees the pre-#189 shape.
         */
        same_entity?: {
          count: number;
          others: Array<{
            type: string;
            url: string;
            updated_at: string;
            score: number;
            commit_sha?: string;
          }>;
        };
      };

      const items: ResultItem[] = filtered.map((f) => {
        const p = payload.get(f.vectorId);
        const r = resolveRow(p);

        // Rows folded into this representative. Kept as references (never
        // dropped) so the caller can still reach every version / comment.
        const folded = collapsedInto.get(f.vectorId) ?? [];
        const sameEntity =
          folded.length > 0
            ? {
                count: folded.length + 1,
                others: folded.map((o) => {
                  const or = resolveRow(payload.get(o.vectorId));
                  return {
                    type: or.type,
                    url: buildResultUrl(or),
                    updated_at: or.updatedAt,
                    score: o.fusedScore,
                    ...(or.type === "diff" ? { commit_sha: or.commitSha } : {}),
                  };
                }),
              }
            : undefined;

        return {
          number: r.number,
          title: "", // Enriched below
          state: r.state,
          type: r.type,
          labels: r.labelsCsv ? r.labelsCsv.split(",").filter(Boolean) : [],
          milestone: r.milestone,
          assignees: r.assigneesCsv ? r.assigneesCsv.split(",").filter(Boolean) : [],
          score: f.fusedScore,
          dense_score: p?.denseScore ?? null,
          sparse_score: p?.sparseScore ?? null,
          dense_rank: f.contributions["dense"] ?? null,
          sparse_rank: f.contributions["sparse"] ?? null,
          // null when reranker was disabled, skipped (≤1 candidate), failed
          // gracefully, or when this row had no content to score; populated
          // otherwise. `rerank_applied: true` guarantees at least one row in
          // the response carries a non-null score.
          rerank_score: rerankScores.get(f.vectorId) ?? null,
          url: buildResultUrl(r),
          updated_at: r.updatedAt,
          repo: r.repo,
          ...(r.type === "release" ? { tag_name: r.tagName } : {}),
          ...(r.type === "doc" ? { doc_path: r.docPath } : {}),
          ...(r.type === "wiki_doc"
            ? {
                wiki_path: r.wikiPath,
                ...(r.wikiExtension ? { wiki_extension: r.wikiExtension } : {}),
              }
            : {}),
          ...(r.type === "diff"
            ? {
                commit_sha: r.commitSha,
                file_path: r.filePath,
                file_status: r.fileStatus,
                commit_date: r.commitDate,
                commit_author: r.commitAuthor,
              }
            : {}),
          ...(r.type === "issue_comment"
            ? {
                author: r.author,
                comment_id: r.commentId,
              }
            : {}),
          ...(r.type === "pr_review"
            ? {
                author: r.author,
                review_id: r.reviewId,
              }
            : {}),
          ...(r.type === "pr_review_comment"
            ? {
                author: r.author,
                comment_id: r.commentId,
                file_path: r.filePath,
                line: r.line,
                commit_sha: r.commitSha,
              }
            : {}),
          ...(sameEntity ? { same_entity: sameEntity } : {}),
        };
      });

      // Enrich with titles from IssueStore / release store / doc store
      const store = getStore(env);
      for (const item of items) {
        if (item.type === "release" && item.repo && item.tag_name) {
          try {
            const res = await store.fetch(
              new Request(
                `http://store/release?repo=${encodeURIComponent(item.repo)}&tag_name=${encodeURIComponent(item.tag_name)}`,
              ),
            );
            if (res.ok) {
              const record = (await res.json()) as ReleaseRecord;
              item.title = record.name || record.tagName;
            }
          } catch {
            // Best-effort enrichment
          }
        } else if (item.type === "doc" && item.repo && item.doc_path) {
          // Use the file path as the title for docs
          item.title = item.doc_path;
        } else if (item.type === "wiki_doc" && item.repo && item.wiki_path) {
          // Wiki page slug serves as the title; the row's url already points
          // at the rendered wiki page so the slug is sufficient context.
          item.title = item.wiki_path;
        } else if (item.type === "diff") {
          // Title = "{short-sha} {file_path}" so the result list remains
          // scannable without making an additional API call.
          const fp = item.file_path ?? "";
          const sha = item.commit_sha ?? "";
          const shortSha = sha ? sha.slice(0, 7) : "";
          item.title = [shortSha, fp].filter(Boolean).join(" ");
        } else if (item.type === "issue_comment") {
          // Title = "{author} on #{number}" — enough context to skim results.
          const author = item.author ?? "";
          item.title = author ? `${author} on #${item.number}` : `comment on #${item.number}`;
        } else if (item.type === "pr_review") {
          // Title = "{author} {state} on #{number}" — review state gives
          // the classification at a glance (APPROVED / CHANGES_REQUESTED / COMMENTED).
          const author = item.author ?? "";
          const state = item.state || "";
          item.title = author ? `${author} ${state} on #${item.number}` : `review on #${item.number}`;
        } else if (item.type === "pr_review_comment") {
          // Title = "{author} @ {file_path}:{line}" — inline comment location.
          const author = item.author ?? "";
          const fp = item.file_path ?? "";
          const line = item.line ?? 0;
          item.title = author ? `${author} @ ${fp}:${line}` : `inline on #${item.number}`;
        } else if (item.repo && item.number) {
          try {
            const res = await store.fetch(
              new Request(
                `http://store/issue?repo=${encodeURIComponent(item.repo)}&number=${item.number}`,
              ),
            );
            if (res.ok) {
              const record = (await res.json()) as IssueRecord;
              item.title = record.title;
            }
          } catch {
            // Best-effort enrichment; continue without title
          }
        }
      }

      // Optional doc content inlining (search mode).
      if (includeContent) {
        await inlineDocContent(items);
      }

      // ── Optional graph expansion (opt-in; default off leaves everything
      // above byte-identical). Seeds from the final result set, traverses the
      // Decision-Structure mention graph, and appends related wiki pages as
      // extra results marked with graph_hop / graph_from. Best-effort: any
      // failure returns the organic results unchanged.
      let graphNeighborsAdded = 0;
      if (graphExpand && filtered.length > 0) {
        try {
          const seedIds = filtered.map((f) => f.vectorId);
          const seedSet = new Set(seedIds);
          const neighbors = await queryNeighbors(env.DB_FTS, seedIds, {
            hops: graphHops,
            repo,
            limit: Math.min(requestedTopK * 2, 30),
          });
          const fresh = neighbors.filter((n) => !seedSet.has(n.vectorId));
          if (fresh.length > 0) {
            const enrich = await getDocsByVectorIds(
              env.DB_FTS,
              fresh.map((n) => n.vectorId),
            );
            const slugOf = (vid: string): string => {
              const p = payload.get(vid);
              return p?.meta?.wiki_path ?? p?.ftsRow?.docPath ?? vid;
            };
            for (const n of fresh) {
              const row = enrich.get(n.vectorId);
              if (!row) continue; // dangling edge (target not indexed) — skip
              const nRepo = String(row.repo ?? "");
              const nType = String(row.type ?? "");
              const nPath = String(row.doc_path ?? "");
              const url =
                nType === "wiki_doc" && nRepo && nPath
                  ? `https://github.com/${nRepo}/wiki/${nPath}`
                  : nType === "doc" && nRepo && nPath
                    ? `https://github.com/${nRepo}/blob/HEAD/${nPath}`
                    : "";
              const item: ResultItem = {
                number: Number(row.number ?? 0),
                title: nPath || n.vectorId,
                state: String(row.state ?? ""),
                type: nType,
                labels: [],
                milestone: String(row.milestone ?? ""),
                assignees: [],
                score: 0,
                dense_score: null,
                sparse_score: null,
                dense_rank: null,
                sparse_rank: null,
                rerank_score: null,
                url,
                updated_at: String(row.updated_at ?? ""),
                repo: nRepo,
                graph_hop: n.hop,
                graph_from: slugOf(n.fromVectorId),
              };
              if (nType === "wiki_doc") item.wiki_path = nPath;
              if (nType === "doc") item.doc_path = nPath;
              if (includeContent && typeof row.content === "string") {
                item.content = row.content;
              }
              items.push(item);
              graphNeighborsAdded++;
            }
          }
        } catch (graphErr) {
          console.error(
            "graph_expand failed (returning organic results):",
            graphErr instanceof Error ? graphErr.message : String(graphErr),
          );
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                count: items.length,
                mode: "search",
                fusion: fusionMode,
                sort: effectiveSort,
                dense_candidates: denseResult.hits.length,
                sparse_candidates: sparseHits.length,
                // Filters that matched no row in the index at all (issue #219).
                // Always present; `[]` means every applied filter matched
                // something, so `count: 0` is a genuine zero-hit result. A
                // listed filter means the population it selects is empty —
                // the value is wrong (for `repo`, typically a bare repository
                // name where the full `owner/repo` slug is required), not the
                // query. Only checked when the candidate set is empty.
                filters_unmatched: filtersUnmatched,
                // rerank metadata:
                //   - rerank_requested: caller-facing flag (default true)
                //   - rerank_applied: whether the cross-encoder actually
                //     ran and re-scored. False when disabled, when there
                //     was ≤1 candidate to rerank, when sort != "relevance",
                //     when the AI call errored / returned an unexpected
                //     shape, or when no candidate had content to score
                //     (graceful fallback to fusion order). True implies at
                //     least one item carries a non-null `rerank_score`.
                rerank_requested: rerankEnabled,
                rerank_applied: rerankApplied,
                since: since ?? null,
                until: until ?? null,
                graph_expanded: graphExpand,
                graph_neighbors: graphNeighborsAdded,
                results: items,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Inline raw file content on up to INCLUDE_CONTENT_MAX_DOCS doc / wiki_doc rows.
 * Mutates the rows in place (adds a `content` field). Non-doc rows and rows
 * beyond the cap are left untouched.
 *
 * Doc rows are fetched via the GitHub Contents REST API (authenticated).
 * Wiki_doc rows are fetched from `raw.githubusercontent.com/wiki/...` —
 * GitHub does not expose wiki content through REST, so the public raw URL
 * is the only path. Both branches share the same INCLUDE_CONTENT_MAX_DOCS
 * cap since they target the same surface (rendered documentation) from the
 * caller's perspective.
 *
 * Scope note: top-N doc fetch is a fan-out bound. Callers needing more
 * bodies should page by repeating the search.
 */
async function inlineDocContent<
  T extends {
    type: string;
    repo?: string;
    doc_path?: string;
    wiki_path?: string;
    wiki_extension?: string;
    content?: string;
  },
>(rows: T[], fallbackRepo?: string): Promise<void> {
  const docRows = rows.filter((r) => r.type === "doc");
  const wikiRows = rows.filter((r) => r.type === "wiki_doc");
  if (docRows.length === 0 && wikiRows.length === 0) return;

  const docToFetch = docRows.slice(0, INCLUDE_CONTENT_MAX_DOCS);
  const wikiToFetch = wikiRows.slice(0, INCLUDE_CONTENT_MAX_DOCS);

  const token = getGitHubToken();
  const headers = githubHeaders(token);

  await Promise.all([
    ...docToFetch.map(async (row) => {
      const docPath = row.doc_path;
      const itemRepo = row.repo ?? fallbackRepo ?? "";
      if (!docPath || !itemRepo) return;
      const url = new URL(`${GITHUB_API}/repos/${itemRepo}/contents/${docPath}`);
      try {
        const res = await fetch(url.toString(), { headers });
        if (!res.ok) return;
        const data = (await res.json()) as {
          content?: string;
          encoding?: string;
        };
        if (!data.content) return;
        const binary = atob(data.content.replace(/\n/g, ""));
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        row.content = new TextDecoder().decode(bytes);
      } catch {
        // Best-effort inline; a failed fetch leaves `content` unset.
      }
    }),
    ...wikiToFetch.map(async (row) => {
      const pageName = row.wiki_path;
      const itemRepo = row.repo ?? fallbackRepo ?? "";
      const ext = row.wiki_extension || "md";
      if (!pageName || !itemRepo) return;
      const url = `https://raw.githubusercontent.com/wiki/${itemRepo}/${encodeURIComponent(pageName)}.${ext}`;
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "github-rag-mcp/0.1.0" },
        });
        if (!res.ok) return;
        row.content = await res.text();
      } catch {
        // Best-effort inline; a failed fetch leaves `content` unset.
      }
    }),
  ]);
}

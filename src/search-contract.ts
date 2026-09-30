import { z } from "zod";
export const INCLUDE_CONTENT_MAX_DOCS = 5;
export const searchInputSchema = z.object({
        query: z
          .string().max(4096)
          .optional()
          .describe(
            "Natural language search query. When omitted or empty, the tool " +
              "switches to metadata-only scan mode and results are ordered " +
              "by the timestamp implied by sort (default sort=\"updated_desc\" for empty query).",
          ),
        repo: z
          .string().max(256)
          .optional()
          .describe(
            "Filter by repository — full slug (owner/repo), exact match. " +
              "A bare repository name (\"my-repo\") matches nothing and yields an empty result set; " +
              "search mode flags that case as \"repo\" in the response's filters_unmatched.",
          ),
        path_prefix: z
          .string().max(256)
          .optional()
          .describe(
            "Filter repository docs by a repository-relative directory prefix before ranking. " +
              "Requires type=\"doc\", a trailing /, no leading /, backslash, NUL, empty, . or .. path segments, " +
              "and at most 64 UTF-8 bytes. Search mode reports an unmatched value as \"path_prefix\" in filters_unmatched.",
          ),
        state: z
          .enum(["open", "closed", "all"])
          .optional()
          .default("all")
          .describe("Filter by state"),
        labels: z
          .array(z.string().max(256)).max(50)
          .optional()
          .describe("Filter by label names (AND logic)"),
        milestone: z
          .string().max(256)
          .optional()
          .describe("Filter by milestone title"),
        assignee: z
          .string().max(256)
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
          .number().int()
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
          .string().max(256)
          .optional()
          .describe(
            "ISO 8601 timestamp (inclusive) — keep only results whose updated_at >= since. " +
              "Pair with sort=\"updated_desc\" + empty query for an activity scan. " +
              "Default in scan mode: 7 days back from until (or from now when until is omitted).",
          ),
        until: z
          .string().max(256)
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
        vector_ids: z
          .array(z.string().max(256)).max(50)
          .max(50)
          .optional()
          .describe(
            "Stored-content fetch. Pass the vector_id values carried by earlier search-mode results " +
              "(scan-mode rows come from the structured store and carry none) to read back the " +
              "body text the index holds for those exact rows, for every type — issue, pull_request, " +
              "issue_comment, pr_review, pr_review_comment, release, diff, doc, wiki_doc. " +
              "Served from D1: no GitHub API call is made. Takes precedence over the other modes — query, " +
              "sort, and every metadata filter are ignored when this is present, because the rows are named " +
              "rather than selected. " +
              "The text is the INDEXED copy of the body (the embedding input), truncated at " +
              `${8000} characters — not the live source. Each row carries content_truncated ` +
              "so a prefix is never mistaken for a whole body, and the response carries content_source: \"index\". " +
              "Unknown or stale ids are listed in not_found and the remaining rows still return. " +
              `Max ${50} ids per call. ` +
              "Treat vector_id as a handle for a row you just found, not a durable identifier: the id scheme " +
              "has been migrated before and may be again, so do not store one for later use.",
          ),
        graph_expand: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Opt-in GraphRAG expansion (search mode only). When true, after fusion the top " +
              "results seed a traversal of the Decision-Structure mention graph (D1 doc_edges); " +
              "related wiki pages are returned in a separate graph_results array marked with " +
              "graph_hop / graph_from — never mixed into results, and carrying no score. " +
              "Default false preserves standard hybrid ranking (no graph read, " +
              "no graph_results field).",
          ),
        use_memory: z.boolean().optional().default(false).describe("Order graph candidates within equal hops by your learned strength; keyword ranks and scores unchanged."),
        graph_hops: z
          .number().int()
          .min(1)
          .max(2)
          .optional()
          .default(1)
          .describe(
            "Graph traversal depth for graph_expand (1 or 2). Default 1. Ignored when graph_expand is false.",
          ),
      });
export const searchOutputSchema = z.object({ count: z.number().int().nonnegative(), mode: z.enum(['search','scan','fetch']), results: z.array(z.record(z.string(), z.unknown())).max(50), graph_results: z.array(z.record(z.string(), z.unknown())).max(30).optional(), trace_id: z.string().optional(), timestamp: z.string().optional(), memory_policy: z.record(z.string(), z.unknown()).optional(), memory_unavailable: z.boolean().optional(), feedback_available: z.boolean() }).passthrough();

/**
 * Static mirror of the Worker `search` tool schema.
 *
 * The proxy answers `tools/list` from this mirror instead of forwarding the
 * request to the Worker, keeping startup auth-free and network-free. The Worker
 * definition in `src/mcp.ts` is the source of truth; `scripts/check-schema-drift.mjs`
 * fails CI when this file drifts from it (param names AND enum values).
 *
 * Kept in its own module so the schema can be asserted in tests without
 * importing `index.js`, which connects the stdio transport on import.
 */

export const TOOLS = [
  {
    name: "search",
    title: "Search GitHub",
    description:
      "Unified search across GitHub issues, PRs, releases, repository documentation, " +
      "GitHub Wiki pages, commit diffs, issue/PR top-level comments, PR reviews, and " +
      "PR inline review comments. Three modes: " +
      "(1) hybrid semantic search — dense BGE-M3 + sparse BM25 over D1 FTS5 fused via RRF, then re-scored " +
      "by @cf/baai/bge-reranker-base (toggle with rerank: false); " +
      "(2) time-ordered activity scan — omit or empty query with sort=\"updated_desc\" / \"created_desc\", " +
      "optionally narrow via since / until; " +
      "(3) doc content fetch — include_content: true inlines raw content on top doc and wiki_doc results. " +
      "Structured filters (repo, state, labels, milestone, assignee, type) apply across all modes; " +
      "type: \"wiki_doc\" narrows to GitHub Wiki pages only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Natural language search query. Omit or leave empty to switch to metadata-only scan mode " +
            "(results ordered by the timestamp implied by sort; default sort=\"updated_desc\" when empty).",
        },
        repo: {
          type: "string",
          description: "Filter by repository (owner/repo)",
        },
        state: {
          type: "string",
          enum: ["open", "closed", "all"],
          description: "Filter by state (default: all)",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Filter by label names (AND logic)",
        },
        milestone: {
          type: "string",
          description: "Filter by milestone title",
        },
        assignee: {
          type: "string",
          description: "Filter by assignee login",
        },
        type: {
          type: "string",
          enum: [
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
          ],
          description:
            "Filter by type (default: all). " +
            "\"doc\" = repository docs (files in /docs/ etc.). " +
            "\"wiki_doc\" = GitHub Wiki pages (separate from repo docs; both surfaces co-exist). " +
            "\"diff\" = per-file commit diffs. " +
            "\"issue_comment\" = top-level comments on issues and PRs. " +
            "\"pr_review\" = PR review bodies (approve / request_changes / comment). " +
            "\"pr_review_comment\" = inline per-line review comments on PR diffs.",
        },
        top_k: {
          type: "number",
          description: "Max results (default: 10, max: 50)",
        },
        fusion: {
          type: "string",
          enum: ["rrf", "dense_only", "sparse_only"],
          description:
            "Fusion strategy (default: rrf). dense_only / sparse_only for debugging or single-ranker queries. " +
            "Ignored in scan mode (empty query).",
        },
        rerank: {
          type: "boolean",
          description:
            "Cross-encoder reranking with @cf/baai/bge-reranker-base (default: true). " +
            "Set false to skip — faster, no rerank cost; recommended for short identifier queries or debugging. " +
            "Ignored in scan mode (empty query).",
        },
        sort: {
          type: "string",
          enum: ["relevance", "updated_desc", "created_desc"],
          description:
            "Result ordering. Default: \"relevance\" when query is non-empty, \"updated_desc\" when query is empty. " +
            "Setting \"updated_desc\" / \"created_desc\" forces time-ordered output and overrides ranker scores.",
        },
        since: {
          type: "string",
          description:
            "ISO 8601 timestamp (inclusive) — keep only results whose updated_at >= since. " +
            "Pair with sort=\"updated_desc\" + empty query for an activity scan. " +
            "Default in scan mode: 7 days back from until (or from now when until is omitted).",
        },
        until: {
          type: "string",
          description:
            "ISO 8601 timestamp (exclusive) — keep only results whose updated_at < until. " +
            "In scan mode the [since, until) window is applied inside the index, so any window " +
            "holding rows returns rows however far back it sits; the response carries " +
            "truncated: true when the window holds more than one page.",
        },
        include_content: {
          type: "boolean",
          description:
            "When true, inline the raw content of top doc and wiki_doc rows (docs via the GitHub " +
            "contents API, wiki pages via raw.githubusercontent.com/wiki) on those rows. Capped at " +
            "the first few rows of each surface to bound API fan-out. Other rows are unaffected. " +
            "Default: false.",
        },
        graph_expand: {
          type: "boolean",
          description:
            "Opt-in GraphRAG expansion (search mode only). When true, after fusion the top " +
            "results seed a traversal of the Decision-Structure mention graph (D1 doc_edges); " +
            "related wiki pages are appended as extra results marked with graph_hop / graph_from. " +
            "Default false = byte-identical to standard hybrid retrieval (no graph read).",
        },
        graph_hops: {
          type: "number",
          minimum: 1,
          maximum: 2,
          description:
            "Graph traversal depth for graph_expand (1 or 2). Default 1. " +
            "Ignored when graph_expand is false.",
        },
      },
    },
    annotations: {
      title: "Search GitHub",
      readOnlyHint: true,
    },
  },
];

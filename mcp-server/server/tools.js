import { readFileSync } from "node:fs";
const SEARCH_CONTRACT = JSON.parse(readFileSync(new URL("./search-schema.json", import.meta.url), "utf8"));
export const MEMORY_CONTRACT = JSON.parse(readFileSync(new URL("./memory-tools.json", import.meta.url), "utf8"));
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
      MEMORY_CONTRACT.instructions + "\n" + "Unified search across GitHub issues, PRs, releases, repository documentation, " +
      "GitHub Wiki pages, commit diffs, issue/PR top-level comments, PR reviews, and " +
      "PR inline review comments. Four modes, all derived from the parameter set: " +
      "(1) hybrid semantic search — dense BGE-M3 + sparse BM25 over D1 FTS5 fused via RRF, then re-scored " +
      "by @cf/baai/bge-reranker-base (toggle with rerank: false); " +
      "(2) time-ordered activity scan — omit or empty query with sort=\"updated_desc\" / \"created_desc\", " +
      "optionally narrow via since / until; " +
      "(3) doc content fetch — include_content: true inlines raw content on top doc and wiki_doc results; " +
      "(4) stored-content fetch — vector_ids reads back the body text the index holds for the named rows, " +
      "for every type and with no GitHub API call, truncated at the 8000-character ingest ceiling. " +
      "Structured filters (repo, path_prefix, state, labels, milestone, assignee, type) apply across modes 1-3 " +
      "(mode 4 names its rows, so nothing is filtered there); " +
      "type: \"wiki_doc\" narrows to GitHub Wiki pages only; repo takes the full slug (owner/repo) and matches " +
      "exactly, so a bare repository name selects nothing. In search mode the response carries " +
      "filters_unmatched: any filter listed there matched no row in the index at all, which separates a " +
      "mis-specified filter from a genuine zero-hit result. " +
      "Results are aggregated per underlying entity: a file's doc row and its commit diffs are one result, " +
      "an issue or PR and its comments / reviews are one result. top_k therefore counts distinct entities, " +
      "and a result that absorbed others carries same_entity { count, others[] } with links to them. " +
      "Every result row — and every same_entity.others entry — carries vector_id, the handle mode 4 takes. " +
      "It is a handle for reaching a row you just found, not a durable identifier: the id scheme has been " +
      "migrated before and may be again, so do not store one for later use. " +
      "Two retrieval axes are reported separately, never fused into one ranking. results is the keyword axis " +
      "(dense + sparse, scored and ranked; count counts these). graph_results is the relationship axis, " +
      "present only with graph_expand: true — candidates reached through the Decision-Structure mention graph, " +
      "ordered by graph_hop ascending and carrying no score (the graph has no relevance value to report; " +
      "absence of a score is not a score of zero). Triage: appearing on BOTH axes is the strongest signal — " +
      "two independent paths agreed. Keyword axis only = the words matched. Relationship axis only = the " +
      "vocabulary did not match but the entry is structurally adjacent to what did.",
    inputSchema: SEARCH_CONTRACT.inputSchema,
    outputSchema: SEARCH_CONTRACT.outputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  ...MEMORY_CONTRACT.tools,
];

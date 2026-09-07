# github-rag-mcp

Language: English | [Japanese](README.ja.md)

GitHub issue, pull request, release, and documentation search for MCP clients on Cloudflare Workers.

`github-rag-mcp` is designed as a shared working memory over GitHub. It does not try to remember every conversation. Instead, it helps agents recover the current project state from durable artifacts that humans can also inspect: issues, pull requests, docs, and releases.

It is the search-oriented counterpart to [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp). Together they provide both:

- push-based awareness of what just happened
- hybrid retrieval (dense + sparse) of the state that matters for the next step

## Breaking change: MCP protocol revision 2026-07-28

From this release the Worker serves **MCP protocol revision 2026-07-28 only**. It keeps no compatibility lane for the previous revision.

- **Bridge versions older than this release stop working.** They open a session with `initialize`, which the Worker no longer answers. The failure is quiet: the bridge does not crash, it returns the protocol error as tool output text.
- **Restart Claude Desktop to pick up the new bridge.** The bridge is launched with `npx`, and `@latest` is resolved at process start — an already-running Claude Desktop keeps the copy it started with, however new the published version is. Quit it fully and reopen.
- **Pinning the bridge version leaves you stuck.** If your MCP client config pins a version older than this release, restarting does not help; remove the pin (or move it forward) first.

The Worker and the bridge ship together, so a bridge from this release or later needs no configuration change.

## Memory Model

The project treats GitHub as a visible state store for AI work.

- Do not aim for complete memory.
- Do not add unnecessary material.
- Do not omit information required for the next correct action.
- Preserve state in human-readable, reviewable artifacts.
- Recover context by search instead of replaying full chat history.

For a fuller explanation, see:

- [docs/1-memory-philosophy.md](docs/1-memory-philosophy.md)
- [docs/1-memory-philosophy.ja.md](docs/1-memory-philosophy.ja.md)

## Architecture

```text
GitHub webhooks + GitHub API
            |
            v
     Cloudflare Worker
     + MCP HTTP surface
     + webhook receiver
     + cron poller (fallback)
     + embedding pipeline
     + hybrid retrieval (dense + sparse + RRF fusion + cross-encoder rerank)
            |
            +--> Vectorize (dense semantic index)
            +--> D1 FTS5 (BM25 sparse index)
            +--> Durable Object / SQLite (structured state store)
            +--> Workers AI BGE-M3 (embeddings)
            +--> Workers AI bge-reranker-base (cross-encoder rerank)
```

- The MCP surface exposes hybrid retrieval and context tools to AI clients.
- The webhook receiver updates memory in near real time when GitHub changes.
- The cron poller repairs missed updates and supports backfill.
- Vectorize stores semantic embeddings for the dense side of retrieval.
- D1 FTS5 stores the BM25 sparse index for exact-term and identifier queries.
- The cross-encoder reranker re-scores fused candidates as the 3rd tier (toggleable per query).
- Durable Object keeps structured state for fast lookups and activity views.

## Why GitHub

GitHub already contains the artifacts that matter for software work:

- issues for requirements and open decisions
- pull requests for implementation history and review state
- documentation for stabilized understanding
- releases for shipped checkpoints

Using those artifacts as memory makes handoff and auditing easier than keeping state inside a private chat transcript.

## Installation

See:

- [docs/installation.md](docs/installation.md)
- [docs/installation.ja.md](docs/installation.ja.md)

## Versioning

Published versions come from the GitHub Release tag. The `version` fields committed in this repository are placeholders that CD rewrites from the tag at publish time, so they are expected to differ from the published version — see [Versioning and published artifacts](docs/installation.md#versioning-and-published-artifacts).

## Requirements

See:

- [docs/0-requirements.md](docs/0-requirements.md)
- [docs/0-requirements.ja.md](docs/0-requirements.ja.md)

## MCP Tools

This MCP server exposes a single consolidated tool. All retrieval modes — semantic search, time-ordered activity scan, inline doc content fetch, and stored-content fetch by `vector_id` — are reached through `search` via its parameter set. Earlier builds split these across `get_issue_context`, `get_doc_content`, and `list_recent_activity`; those tools have been removed and their use cases now fold into the parameters below.

### `search`

Unified search across GitHub issues, pull requests, releases, repository documentation, GitHub Wiki pages, commit diffs, and comment / review surfaces (top-level comments on issues and PRs, PR review bodies, and PR inline review comments).

Four modes are selected by the parameter set:

1. **Hybrid semantic search (default)** — dense BGE-M3 over Vectorize + sparse BM25 over D1 FTS5, fused via Reciprocal Rank Fusion (RRF, k=60), then re-scored with the `@cf/baai/bge-reranker-base` cross-encoder. Pass a natural-language `query`.
2. **Time-ordered activity scan** — omit or leave `query` empty and set `sort` to `"updated_desc"` or `"created_desc"`. Optionally narrow with `since` / `until` to list recent activity across every type. This subsumes the previous `list_recent_activity` tool. The `[since, until)` window is applied inside the index, so any window holding rows returns rows however far back it sits; the response carries `truncated: true` when the window holds more than one page, which is what separates "no such rows" from "the read stopped short". Walk backwards by re-issuing the scan with `until` set to the oldest row returned.
3. **Doc / wiki content fetch** — set `include_content: true`. For result rows whose `type` is `"doc"`, the raw file content is fetched from the GitHub contents API; for `type: "wiki_doc"` rows, the raw markup is fetched from `raw.githubusercontent.com/wiki/`. Both are inlined as a `content` field. Capped at the first few rows of each type to bound API fan-out. This subsumes the previous `get_doc_content` tool.
4. **Stored-content fetch** — pass `vector_ids` (the `vector_id` values carried by earlier results). Every indexed type returns the body text the index already holds for that exact row — issues, PRs, comments, reviews, releases and diffs included, not just docs — so locating something with `search` and then reading it no longer costs a round trip through `gh` or grep. Served from D1: no GitHub API call is made. See [Stored-content fetch](#stored-content-fetch) below for what the returned text is and is not.

Structured filters (`repo`, `path_prefix`, `state`, `labels`, `milestone`, `assignee`, `type`) apply in every mode except stored-content fetch, where the rows are named rather than selected. `path_prefix` is intentionally narrower: it is valid only with `type: "doc"` and selects one repository-relative directory before ranking.

Search mode reports filters that matched nothing at all in `filters_unmatched` (always present, `[]` when every filter matched something). `repo` is an exact match on the full `owner/repo` slug, so a bare repository name selects an empty population and returns a response shaped exactly like a genuine zero-hit search — this field is what separates the two. It matters most in multi-step agentic search, where a zero reads as a normal intermediate result and the mis-specified filter would otherwise never surface.

Bot-authored comments (`sender.login` ending in `[bot]`) and comments shorter than 10 characters (trimmed) are filtered out at ingest time so noise such as `LGTM`, `+1`, or CI chatter does not dilute the retrieval surface.

#### Parameters

| Name | Type | Description |
|------|------|-------------|
| `query` | string (optional) | Natural-language query. Omit or empty = scan mode. |
| `repo` | string | Filter by repository — full slug (`owner/repo`), exact match. A bare repository name matches nothing; search mode reports that as `"repo"` in the response's `filters_unmatched`. |
| `path_prefix` | string | Filter docs by repository-relative directory prefix. Requires `type: "doc"`, a trailing `/`, and at most 64 UTF-8 bytes. |
| `state` | `"open"` \| `"closed"` \| `"all"` | Filter by state (default `all`). |
| `labels` | string[] | Filter by label names (AND). |
| `milestone` | string | Filter by milestone title. |
| `assignee` | string | Filter by assignee login. |
| `type` | see below | Filter by type (default `all`). |
| `top_k` | number | Max results (default 10, max 50). Counts distinct entities, not index rows — see Entity aggregation below. |
| `fusion` | `"rrf"` \| `"dense_only"` \| `"sparse_only"` | Fusion strategy (default `rrf`). Ignored in scan mode. |
| `rerank` | boolean | Cross-encoder rerank (default `true`). Ignored in scan mode. |
| `sort` | `"relevance"` \| `"updated_desc"` \| `"created_desc"` | Result ordering. Default `relevance` with a query, `updated_desc` without. Time sorts override ranker score. |
| `since` | ISO 8601 string | Keep only results with `updated_at >= since`. In scan mode, defaults to 7 days before `until` (before now when `until` is omitted). |
| `until` | ISO 8601 string | Keep only results with `updated_at < until`. |
| `include_content` | boolean | Inline raw content on top doc results (default `false`). |
| `vector_ids` | string[] | Stored-content fetch. The `vector_id` values of the rows to read back, max 50 per call. Takes precedence over the other modes: `query`, `sort` and every filter are ignored when present. See [Stored-content fetch](#stored-content-fetch). |
| `graph_expand` | boolean | Opt-in GraphRAG expansion (search mode only). When `true`, after fusion the top results seed a traversal of the Decision-Structure mention graph (D1 `doc_edges`); related wiki pages come back in a separate `graph_results` array tagged `graph_hop` / `graph_from` — see Retrieval axes below. Default `false` = byte-identical to standard hybrid retrieval (no graph read). |
| `graph_hops` | number | Graph traversal depth for `graph_expand` (1 or 2, default 1). Ignored when `graph_expand` is `false`. |

#### `type` values

| Value | Surface |
|-------|---------|
| `"issue"` | GitHub issues (title + body). |
| `"pull_request"` | Pull request descriptions (title + body). |
| `"release"` | Release notes (name + body). |
| `"doc"` | Markdown documentation files. |
| `"wiki_doc"` | GitHub Wiki pages (separate surface from repo docs; both co-exist). |
| `"diff"` | Per-file commit diffs (commit message + file path + patch). |
| `"issue_comment"` | Top-level comments on issues and PRs. |
| `"pr_review"` | PR review bodies (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`). |
| `"pr_review_comment"` | PR inline review comments (per-line diff comments). |
| `"all"` | Union of every type above (default). |

#### Entity aggregation

One thing is indexed as several rows: a file is a `doc` row plus one `diff` row per commit that touched it, an issue or PR is its own row plus its comments and reviews. Those rows are collapsed into one result before the response is trimmed, so `top_k` returns that many distinct entities. Rows are grouped by what they point at, not by the work that produced them — different files touched by one commit stay separate results, and so do an issue and the PR that closes it.

The representative is the highest-ranked row of the group, so a query about when something changed still returns the relevant old commit diff rather than the current version. A result that absorbed other rows carries a `same_entity` field (`count` including itself, plus `others[]` with the type, URL, timestamp and score of each collapsed row) so nothing is lost. See [docs/0-requirements.md](docs/0-requirements.md) for the full rule.

#### Stored-content fetch

Every result row — and every `same_entity.others` entry — carries a `vector_id`. Passing those ids back as `vector_ids` returns the body text the index holds for exactly those rows.

What comes back is the **index's copy** of the body, not the live source: it is the embedding input, truncated by the ingest pipeline at 8000 characters. Inlined text carries no mark of which it is, so the response says so — `content_source: "index"` and `content_max_chars` at the top level, `content_chars` and `content_truncated` on each row. A row flagged `content_truncated: true` is a prefix; read the rest from GitHub if the tail matters.

Unknown or stale ids come back in `not_found` and the remaining rows still return. That partial success is deliberate: `vector_id` is a handle for reaching a row in the result set it arrived in, **not a durable identifier**. The id scheme has been migrated once already, so do not store one for later use — take it from a fresh result.

This is a different axis from `include_content`, which is unchanged: that flag re-reads whole files from GitHub because a doc needs its full text, and it is capped to bound API fan-out. Fetch mode reads D1 and is bounded by the ids you listed.

Ids come from search-mode results only; scan-mode rows are read from the structured store and carry none. They are opaque (`{type prefix}:{base64url sha256}`) — copy them from a result, never build one by hand:

```json
{
  "vector_ids": [
    "i:d0qhtOi9Lxc4yuMbgbDD1BvcpptqrMWpphGMGw4t79I",
    "ic:kPjVFYzpd5y9Y2RWQ1KstYDZYsSDzmxhqQphaHKHHRU"
  ]
}
```

```json
{
  "count": 2,
  "mode": "fetch",
  "requested": 2,
  "content_source": "index",
  "content_max_chars": 8000,
  "not_found": [],
  "results": [
    {
      "vector_id": "i:d0qhtOi9Lxc4yuMbgbDD1BvcpptqrMWpphGMGw4t79I",
      "repo": "Liplus-Project/github-rag-mcp",
      "type": "issue",
      "state": "open",
      "number": 239,
      "updated_at": "2026-08-14T00:00:00Z",
      "content": "feat(mcp): add vector_ids to search ...",
      "content_chars": 4213,
      "content_truncated": false
    }
  ]
}
```

#### Retrieval axes

Search mode reports two axes separately and never fuses them into one ranking.

| Axis | Field | Ordering | Score |
|------|-------|----------|-------|
| Keyword | `results` (counted by `count`) | ranker order (RRF / rerank / time sort) | `score`, `dense_score`, `sparse_score`, `rerank_score` |
| Relationship | `graph_results` (counted by `graph_neighbors`) | `graph_hop` ascending | none — the graph carries no relevance value |

`graph_results` is present only when `graph_expand: true`; the default response does not carry the field at all. Its items hold identity plus `graph_hop` (distance from the seed) and `graph_from` (which seed reached them), and deliberately carry no score field: the mention graph has no weights, so absence of a score is not a score of zero. Graph-derived candidates used to arrive as `score: 0` rows inside `results`, indistinguishable from candidates the rankers scored at zero.

Triage for the consumer: appearing on **both** axes is the strongest signal — two independent paths agreed. Keyword axis only = the words matched. Relationship axis only = the vocabulary did not match, but the entry is structurally adjacent to what did.

#### Examples

Semantic search for a specific topic:

```json
{
  "query": "rerank latency budget",
  "repo": "Liplus-Project/github-rag-mcp",
  "top_k": 5
}
```

Time-ordered activity scan across the last 24 hours:

```json
{
  "sort": "updated_desc",
  "since": "2026-04-22T00:00:00Z",
  "top_k": 20
}
```

Semantic search with inline doc content on the top doc hits:

```json
{
  "query": "memory philosophy",
  "type": "doc",
  "include_content": true,
  "top_k": 3
}
```

Search past PR review judgments about a specific topic:

```json
{
  "query": "rerank threshold tuning",
  "type": "pr_review",
  "top_k": 5
}
```

## Repository Structure

```text
src/
  index.ts
  mcp.ts
  oauth.ts
  webhook.ts
  pipeline.ts
  github-ip.ts
  poller.ts
  store.ts
  types.ts
docs/
  0-requirements.md
  0-requirements.ja.md
  1-memory-philosophy.md
  1-memory-philosophy.ja.md
  installation.md
  installation.ja.md
mcp-server/
wrangler.toml
```

## Related

- [Liplus-Project/github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp)
- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language)

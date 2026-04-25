# github-rag-mcp

Language: English | [Japanese](README.ja.md)

GitHub issue, pull request, release, and documentation search for MCP clients on Cloudflare Workers.

`github-rag-mcp` is designed as a shared working memory over GitHub. It does not try to remember every conversation. Instead, it helps agents recover the current project state from durable artifacts that humans can also inspect: issues, pull requests, docs, and releases.

It is the search-oriented counterpart to [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp). Together they provide both:

- push-based awareness of what just happened
- hybrid retrieval (dense + sparse) of the state that matters for the next step

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

## Requirements

See:

- [docs/0-requirements.md](docs/0-requirements.md)
- [docs/0-requirements.ja.md](docs/0-requirements.ja.md)

## MCP Tools

This MCP server exposes a single consolidated tool. All retrieval modes — semantic search, time-ordered activity scan, and inline doc content fetch — are reached through `search` via its parameter set. Earlier builds split these across `get_issue_context`, `get_doc_content`, and `list_recent_activity`; those tools have been removed and their use cases now fold into the parameters below.

### `search`

Unified search across GitHub issues, pull requests, releases, repository documentation, commit diffs, and comment / review surfaces (top-level comments on issues and PRs, PR review bodies, and PR inline review comments).

Three modes are selected by the combination of `query` and `sort`:

1. **Hybrid semantic search (default)** — dense BGE-M3 over Vectorize + sparse BM25 over D1 FTS5, fused via Reciprocal Rank Fusion (RRF, k=60), then re-scored with the `@cf/baai/bge-reranker-base` cross-encoder. Pass a natural-language `query`.
2. **Time-ordered activity scan** — omit or leave `query` empty and set `sort` to `"updated_desc"` or `"created_desc"`. Optionally narrow with `since` / `until` to list recent activity across every type. This subsumes the previous `list_recent_activity` tool.
3. **Doc content fetch** — set `include_content: true`. For result rows whose `type` is `"doc"`, the raw file content is fetched from the GitHub contents API and inlined as a `content` field. Capped at the first few doc rows to bound API fan-out. This subsumes the previous `get_doc_content` tool.

Structured filters (`repo`, `state`, `labels`, `milestone`, `assignee`, `type`) apply in every mode.

Bot-authored comments (`sender.login` ending in `[bot]`) and comments shorter than 10 characters (trimmed) are filtered out at ingest time so noise such as `LGTM`, `+1`, or CI chatter does not dilute the retrieval surface.

#### Parameters

| Name | Type | Description |
|------|------|-------------|
| `query` | string (optional) | Natural-language query. Omit or empty = scan mode. |
| `repo` | string | Filter by repository (`owner/repo`). |
| `state` | `"open"` \| `"closed"` \| `"all"` | Filter by state (default `all`). |
| `labels` | string[] | Filter by label names (AND). |
| `milestone` | string | Filter by milestone title. |
| `assignee` | string | Filter by assignee login. |
| `type` | see below | Filter by type (default `all`). |
| `top_k` | number | Max results (default 10, max 50). |
| `fusion` | `"rrf"` \| `"dense_only"` \| `"sparse_only"` | Fusion strategy (default `rrf`). Ignored in scan mode. |
| `rerank` | boolean | Cross-encoder rerank (default `true`). Ignored in scan mode. |
| `sort` | `"relevance"` \| `"updated_desc"` \| `"created_desc"` | Result ordering. Default `relevance` with a query, `updated_desc` without. Time sorts override ranker score. |
| `since` | ISO 8601 string | Keep only results with `updated_at >= since`. |
| `until` | ISO 8601 string | Keep only results with `updated_at < until`. |
| `include_content` | boolean | Inline raw content on top doc results (default `false`). |

#### `type` values

| Value | Surface |
|-------|---------|
| `"issue"` | GitHub issues (title + body). |
| `"pull_request"` | Pull request descriptions (title + body). |
| `"release"` | Release notes (name + body). |
| `"doc"` | Markdown documentation files. |
| `"diff"` | Per-file commit diffs (commit message + file path + patch). |
| `"issue_comment"` | Top-level comments on issues and PRs. |
| `"pr_review"` | PR review bodies (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`). |
| `"pr_review_comment"` | PR inline review comments (per-line diff comments). |
| `"all"` | Union of every type above (default). |

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

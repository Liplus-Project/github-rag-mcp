# github-rag-mcp

Language: English | [Japanese](README.ja.md)

GitHub issue, pull request, release, and documentation search for MCP clients on Cloudflare Workers.

`github-rag-mcp` is designed as a shared working memory over GitHub. It does not try to remember every conversation. Instead, it helps agents recover the current project state from durable artifacts that humans can also inspect: issues, pull requests, docs, and releases.

It is the search-oriented counterpart to [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp). Together they provide both:

- push-based awareness of what just happened
- retrieval of the state that matters for the next step

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
            |
            +--> Vectorize (semantic search index)
            +--> Durable Object / SQLite (structured state store)
            +--> Workers AI BGE-M3 (embeddings)
```

- The MCP surface exposes semantic search and context tools to AI clients.
- The webhook receiver updates memory in near real time when GitHub changes.
- The cron poller repairs missed updates and supports backfill.
- Vectorize stores semantic embeddings.
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

| Tool | Description |
|------|-------------|
| `search_issues` | Semantic search across issues, pull requests, releases, and documentation with structured filters. |
| `get_issue_context` | Aggregated state for one issue or pull request, including linked PRs, branch information, CI state, sub-issues, and related releases. |
| `list_recent_activity` | Recent activity across tracked repositories, including issue, PR, release, and documentation updates. |

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

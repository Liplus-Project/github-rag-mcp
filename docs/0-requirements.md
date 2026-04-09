# github-rag-mcp Requirements Specification

Language: English | [Japanese](0-requirements.ja.md)

## Overview

`github-rag-mcp` is an MCP server that gives AI agents retrieval over GitHub project state.

The system indexes:

- issues
- pull requests
- releases
- repository documentation

The design goal is not transcript memory. The goal is recoverable project state.

This project treats GitHub as a shared working memory:

- Issues preserve requirements, open decisions, and task state.
- Pull requests preserve implementation, review, and CI state.
- Docs preserve stabilized understanding.
- Releases preserve shipped checkpoints.

Search is used to recover the relevant slice of that state when an agent needs to act.

Counterpart:

- [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) provides push-based awareness.
- `github-rag-mcp` provides retrieval over durable state.

## Principles

### State over complete memory

The project does not aim to store every conversation or every reasoning trace.

Instead it preserves the state required for the next correct action.

### No unnecessary additions

The memory layer should not add speculative or decorative information that changes the meaning of the original GitHub artifacts.

### No loss of required information

The memory layer should not remove the constraints, decisions, and current status that another agent or session needs to continue the work safely.

### Human-visible memory

The source artifacts remain human-readable and reviewable. Retrieval is an index over those artifacts, not a hidden replacement for them.

## Architecture

```text
GitHub webhooks + GitHub API
            |
            v
     Cloudflare Worker
     + MCP surface
     + webhook receiver
     + cron poller
     + embedding pipeline
            |
            +--> Vectorize
            +--> Durable Object / SQLite
            +--> Workers AI BGE-M3
```

## Components

### 1. MCP Surface

The worker exposes MCP tools over HTTP.

Responsibilities:

- accept authenticated MCP requests
- expose semantic and structured retrieval tools
- return state in a format that downstream agents can consume directly

### 2. Webhook Receiver

The webhook receiver ingests GitHub events in near real time.

Supported event families:

- `issues`
- `pull_request`
- `release`
- `push`

Responsibilities:

- verify webhook signatures with `GITHUB_WEBHOOK_SECRET`
- validate GitHub source IPs
- route events to the embedding pipeline
- update both semantic and structured stores

`push` is used to detect documentation changes such as `docs/**/*.md` and `README.md`.

### 3. Cron Poller

The cron poller is the fallback path.

Responsibilities:

- repair missed webhook deliveries
- backfill new repositories
- refresh changed issues, pull requests, releases, and docs
- keep the stores converged even after transient failures

The poller runs hourly in the current deployment.

### 4. Embedding Pipeline

Embedding model:

- `@cf/baai/bge-m3`

Current implementation:

- 1024 dimensions
- cosine similarity
- body hash comparison for issue and release change detection
- blob SHA comparison for documentation change detection

Responsibilities:

- prepare embedding input from title + body or path + content
- skip unchanged records when safe
- upsert vectors with metadata into Vectorize
- keep retryable failures detectable on the next run

### 5. Vector Store

Vectorize stores semantic embeddings and metadata for:

- repository
- item type
- state
- labels (individual slots label_0..3 + CSV fallback)
- milestone
- assignees (individual slots assignee_0..1 + CSV fallback)
- update timestamp
- release tag name
- documentation path

Metadata indexes (10/10 slots used):

- Pre-filter capable: repo, type, state, milestone
- Stored for future pre-filter: label_0, label_1, label_2, label_3, assignee_0, assignee_1

Vectorize metadata filters support AND between fields only, not OR. A query like `label_0 = "bug" OR label_1 = "bug"` cannot be expressed. Labels and assignees therefore remain post-filtered via overfetch strategy. When Vectorize adds OR or `$in`-across-fields support, the expanded fields are immediately usable for pre-filtering.

The vector store is the semantic retrieval layer, not the canonical state store.

### 6. Structured State Store

Durable Object with SQLite stores structured records for:

- issues and pull requests
- releases
- documentation file state
- polling watermarks

This store supports:

- `get_issue_context`
- `list_recent_activity`
- enrichment of semantic search hits

## Retrieval Model

The retrieval layer must support both semantic search and structured filtering.

Expected retrieval behavior:

1. Generate an embedding for the query.
2. Build Vectorize metadata filter from structured params (repo, state, type, milestone are pre-filtered).
3. When labels or assignee filters are present, overfetch internally (requestedTopK * 5, max 50).
4. Query Vectorize with embedding + filter.
5. Post-filter labels (AND logic, expanded fields + CSV) and assignee.
6. Trim to requestedTopK and return results with structured context.

The retrieval layer is intended to recover working state, not merely keyword matches.

## MCP Tools

### `search_issues`

Purpose:

- semantic search over issues, pull requests, releases, and documentation

Parameters:

- `query` required
- `repo` optional
- `state` optional
- `labels` optional
- `milestone` optional
- `assignee` optional
- `type` optional
- `top_k` optional

Returns:

- ranked matches with repository, type, state, labels, milestone, assignees, URL, and score

### `get_issue_context`

Purpose:

- aggregate the state around one issue or pull request

Returns:

- issue or PR details
- linked PRs
- branch information
- CI status
- sub-issues when available
- related releases when inferable

### `list_recent_activity`

Purpose:

- provide a recent activity feed across tracked repositories

Returns:

- created, updated, and closed issue or PR activity
- release publication activity
- documentation update activity

## Authentication

Authentication uses a GitHub App with OAuth 2.1.

Requirements:

- authenticate the MCP client user
- access repositories through the installed app
- use GitHub tokens for API reads

## Storage Rules

### Canonical memory surfaces

The canonical project memory remains in GitHub artifacts:

- issue bodies and labels
- pull requests and review state
- docs in the repository
- releases

The retrieval system indexes those surfaces. It does not replace them as source of truth.

### Update behavior

- webhook updates should be applied as soon as practical
- cron should reconcile any drift
- failed embeddings must remain retryable
- deleted releases or docs must be removable from the semantic index

## Current Deployment Assumptions

- TypeScript codebase
- Cloudflare Workers runtime
- Vectorize for semantic search
- Workers AI for embedding generation
- Durable Object / SQLite for structured state
- one deployment may track multiple repositories via `POLL_REPOS`

## Operational Constraints

### Worker invocation pressure

Workers AI calls per invocation are limited, so embedding work must be batched conservatively.

### Cron CPU pressure

Large initial syncs can exceed CPU limits, so pagination and resumable watermarks are required.

### Durable Object resets

Deployments may reset Durable Object state, so the system must recover by replaying from GitHub through webhook and cron paths.

### Retry safety

If an embedding attempt fails, the state must remain detectable as incomplete so the next run can retry.

## Future Scope

- stronger ranking and filtering behavior
- better multi-agent handoff retrieval
- better cross-repository state recovery

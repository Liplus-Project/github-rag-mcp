# github-rag-mcp Requirements Specification

Language: English | [Japanese](0-requirements.ja.md)

## Overview

`github-rag-mcp` is an MCP server that gives AI agents retrieval over GitHub project state.

The system indexes:

- issues
- pull requests
- releases
- repository documentation
- commit diffs (judgment history, including changes to deleted files)

The design goal is not transcript memory. The goal is recoverable project state.

This project treats GitHub as a shared working memory:

- Issues preserve requirements, open decisions, and task state.
- Pull requests preserve implementation, review, and CI state.
- Docs preserve stabilized understanding.
- Releases preserve shipped checkpoints.
- Commit diffs preserve the judgment history of what changed and why (including deleted files and non-`.md` extensions).

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
     + hybrid retrieval (dense + sparse + RRF fusion + cross-encoder rerank)
            |
            +--> Vectorize             (dense: BGE-M3 1024d, cosine)
            +--> D1 FTS5               (sparse: BM25, porter + trigram)
            +--> Durable Object/SQLite (structured state, watermarks)
            +--> Workers AI BGE-M3     (embedding generation)
            +--> Workers AI bge-reranker-base (cross-encoder rerank)
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

`push` is used to detect changes in all `.md` files across the repository. The same `push` events also drive per-commit diff indexing: each commit produces N vectors (one per file with a textual patch), with embedding input being `commit message + file path + patch`. This surface makes deleted files and non-`.md` extensions searchable as judgment history.

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
- commit diffs are append-only: once `(commit_sha, file_path)` is indexed it is not recomputed

Responsibilities:

- prepare embedding input from title + body or path + content
- skip unchanged records when safe
- upsert vectors with metadata into Vectorize
- mirror the same content into the D1 FTS5 `search_docs` table for the sparse (BM25) side, choosing tokenizer_kind `nat` or `code` by surface type
- keep retryable failures detectable on the next run
- D1 FTS5 upsert failures do not invalidate a successful Vectorize upsert; the next reindex reconciles the sparse side
- for commit diffs: batch-embed a commit's file list in a single Workers AI call (`text: string[]`) and upsert the resulting N vectors in one `VECTORIZE.upsert` call
- batch size is capped by `MAX_EMBEDDING_BATCH_SIZE` (default 20); commits exceeding it are split across multiple batch calls

### 5. Vector Store (Dense)

Vectorize is the dense side of hybrid retrieval. It stores semantic embeddings and metadata for:

- repository
- item type (`issue` / `pull_request` / `release` / `doc` / `diff`)
- state
- labels (individual slots label_0..3 + CSV fallback)
- milestone
- assignees (individual slots assignee_0..1 + CSV fallback)
- update timestamp
- release tag name
- documentation path
- commit SHA, file path, file status, commit date, commit author, blob SHA (diff only)

Metadata indexes (10/10 slots used):

- Pre-filter capable: repo, type, state, milestone
- Stored for future pre-filter: label_0, label_1, label_2, label_3, assignee_0, assignee_1

Vectorize metadata filters support AND between fields only, not OR. A query like `label_0 = "bug" OR label_1 = "bug"` cannot be expressed. Labels and assignees therefore remain post-filtered via overfetch strategy. When Vectorize adds OR or `$in`-across-fields support, the expanded fields are immediately usable for pre-filtering.

The vector store is the semantic retrieval layer, not the canonical state store.

### 6. Full-Text Index (Sparse, D1 FTS5 / BM25)

D1's FTS5 virtual tables provide the sparse side of hybrid retrieval.

Rationale:

- Dense-only retrieval has known recall weakness on sparse-information queries (code identifiers, proper nouns, SHA prefixes, exact terms).
- As of 2026, hybrid search is the production baseline in the industry; rerankers are a further optional layer on top.
- Cloudflare D1 is pre-compiled with SQLite FTS5 including the BM25 ranking function, and the `fts5` virtual table module is usable directly from Workers.

Schema overview:

- `search_docs` — external content table (source of truth, `vector_id` primary key).
- `search_docs_nat_fts` — FTS5 virtual table with porter + unicode61 tokenizer for natural-language surfaces (issue / PR / release / doc).
- `search_docs_code_fts` — FTS5 virtual table with trigram tokenizer for code / SHA / identifier surfaces (diff).

Tokenizer selection:

- `porter` — stem-based matching appropriate for natural language.
- `trigram` — substring matching appropriate for SHA prefixes, CamelCase tokens, and file paths.
- A `tokenizer_kind` column on `search_docs` decides which virtual table a row is indexed in.
- `content=search_docs` + triggers cascade inserts / updates / deletes automatically, so `DELETE FROM search_docs` fans out to both FTS5 tables in a single statement.

The `vector_id` mirrors the Vectorize vector ID (deterministic SHA-256 based) so RRF fusion can join dense and sparse hits without an extra round-trip.

Metadata filters (`repo`, `type`, `state`, `milestone`) are applied as SQL WHERE predicates, matching the pre-filter capability of the Vectorize side.

BM25 ranking is obtained via the `bm25(<fts_table>)` auxiliary function (lower score = better); scores are converted to ranks for RRF fusion.

### 7. Structured State Store

Durable Object with SQLite stores structured records for:

- issues and pull requests
- releases
- documentation file state
- commit diff file state (one row per file-in-commit)
- polling watermarks

This store supports:

- `get_issue_context`
- `list_recent_activity`
- enrichment of semantic search hits

## Retrieval Model

The retrieval layer supports a 3-tier pipeline: hybrid search (dense + sparse), RRF fusion, and cross-encoder reranking, with structured filtering applied along the way (the 2026 production baseline).

### 3-tier Hybrid Retrieval (default)

Expected retrieval behavior:

1. Generate an embedding for the query via Workers AI BGE-M3.
2. Build Vectorize metadata filter (dense side) and D1 SQL WHERE clause (sparse side) from the same structured params (repo, state, type, milestone are pre-filtered on both sides).
3. When labels or assignee filters are present, OR when the reranker is enabled, overfetch internally on both sides (requestedTopK × 5, max 50). The reranker processes at most 50 candidates per call.
4. Query Vectorize (dense) and D1 FTS5 (sparse, BM25) in parallel.
5. Combine the two rankers via Reciprocal Rank Fusion (RRF, k=60).
6. Post-filter labels (AND logic, expanded fields + CSV fallback) and assignee over the fused view.
7. When the reranker is enabled (default ON), re-score the post-filtered candidates with `@cf/baai/bge-reranker-base` and reorder by reranker score, descending.
8. Trim to requestedTopK and return results with structured context.

#### Reciprocal Rank Fusion (RRF)

RRF formula:

```
score(d) = sum_over_rankers ( 1 / (k + rank_r(d)) )
```

- k = 60 is the canonical value from Cormack et al. (2009) and the de-facto default in production hybrid search (Elasticsearch, Vespa, Milvus).
- `rank_r(d)` is the 1-based rank of document d under ranker r; documents missed by a ranker contribute 0 from that ranker.
- Dense and sparse scores have non-comparable scales; normalizing to rank is what makes fusion valid.
- Documents that appear in only one ranker still get partial credit, which boosts recall.

### Cross-encoder Reranker

The 3rd tier reranker uses `@cf/baai/bge-reranker-base` (Workers AI).

Rationale:

- As of 2026, the cross-encoder reranker is treated as a baseline production layer (hybrid + reranker), not an optional add-on. Cloudflare's AI Search primitive (2026-04-16) ships `@cf/baai/bge-reranker-base` as the rerank stage.
- Bi-encoders (BGE-M3) and sparse BM25 are strong on recall but weaker on precision@k than cross-encoders. Re-scoring the top RRF-fused candidates with a cross-encoder lifts precision without re-architecting the recall layer.
- Reranking uses the same `env.AI` primitive as BGE-M3 embedding, so no additional binding is required.

Implementation constraints and known limitations:

- bge-reranker-base inherits BAAI's 512-token context window. Each `(query, candidate content)` pair is truncated by character budget (query: 200 chars max, pair total: 1700 chars max) since no tokenizer is available in Workers.
- Workers AI requires every `contexts[].text` to be at least one character long (error 5006: "Length of '/contexts/N/text' must be >= 1 not met"). Dense-only candidates that lack an FTS row have empty content, so they are filtered out of the rerank input before the call; if 0 or 1 non-empty candidates remain the call is skipped entirely.
- The reranker processes at most 50 candidates per call — chosen as the join point between the Workers AI Free tier neuron budget (10,000/day) and industry median (50–75 candidates).
- bge-reranker-base is English-centric and not multilingual. Japanese issue/PR content may see degraded quality. This is observed at runtime; switching to `bge-reranker-v2-m3` or an external reranker (Voyage / Cohere) is tracked as a separate issue when needed.
- On reranker call failure or unexpected response shape, the system falls back gracefully to the post-filter (RRF) order and reports `rerank_applied: false`.

Cost estimate:

- Workers AI public pricing: bge-reranker-base = 283 neurons/M tokens.
- Per-search estimate: ~7.5 neurons (query 30 tokens + 50 candidates × 500 avg tokens, embedding included).
- Free tier (10,000 neurons/day) supports ~1,300 searches/day at this rate.
- Actual neuron usage is read from a `usage` field on the response when present and reconciled against the estimate. The field is not officially documented as of 2026-04, so absence is tolerated silently.

### Fusion mode toggle

`search_issues` accepts a `fusion` parameter:

- `rrf` (default) — combine dense and sparse via RRF.
- `dense_only` — query Vectorize only (debugging, semantic-heavy queries).
- `sparse_only` — query D1 FTS5 BM25 only (debugging, exact-term / identifier queries).

`search_issues` also accepts a `rerank` parameter:

- `true` (default) — re-score the RRF-fused candidates with bge-reranker-base.
- `false` — skip rerank (faster, no Workers AI rerank cost; recommended for short-identifier queries where lexical match is already decisive, or for debugging).

The retrieval layer is intended to recover working state, not merely keyword matches. The 3-tier design lets sparse cover BGE-M3's weak regime (short identifiers, SHA prefixes, proper nouns), RRF maintains recall across both rankers, and the cross-encoder lifts precision on the surviving candidates.

## MCP Tools

### `search_issues`

Purpose:

- **3-tier hybrid search** (dense + sparse BM25 → RRF fusion → cross-encoder rerank) over issues, pull requests, releases, documentation, and commit diffs
- use `type: "diff"` to retrieve judgment history (including deleted files and non-`.md` extensions)

Parameters:

- `query` required
- `repo` optional
- `state` optional
- `labels` optional
- `milestone` optional
- `assignee` optional
- `type` optional
- `top_k` optional
- `fusion` optional — `rrf` (default) / `dense_only` / `sparse_only`
- `rerank` optional — `true` (default) / `false`

Returns:

- ranked matches with repository, type, state, labels, milestone, assignees, URL, and RRF fused `score`
- additional debug fields per result: `dense_score`, `sparse_score`, `dense_rank`, `sparse_rank`, `rerank_score` (null when rerank disabled or when graceful fallback engaged)
- top-level metadata: `fusion`, `dense_candidates`, `sparse_candidates`, `rerank_requested`, `rerank_applied`

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
- commit diff indexing activity

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
- commit history (diffs)

The retrieval system indexes those surfaces. It does not replace them as source of truth.

### Update behavior

- webhook updates should be applied as soon as practical
- cron should reconcile any drift
- failed embeddings must remain retryable
- deleted issues / PRs / releases / docs must be removable from both the semantic index (Vectorize) and the sparse index (D1 FTS5)
- commit diffs are append-only and are not part of the delete path

## Current Deployment Assumptions

- TypeScript codebase
- Cloudflare Workers runtime
- Vectorize for dense semantic search (dense side of hybrid retrieval)
- Cloudflare D1 for FTS5 BM25 sparse search (sparse side of hybrid retrieval; schema managed via migrations)
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

### Free-tier hard stop (D1 / Vectorize / Workers AI)

Workers AI Free (10,000 Neurons/day), D1 Free, and Vectorize Free all specify that exceeding the free quota causes `operations will fail with an error` (hard stop). Overage billing only applies when the account is on a paid Workers plan. Because the managed AI Search product is not used, AI-Search-specific hard-stop uncertainty is out of scope here.

### Retry safety

If an embedding attempt fails, the state must remain detectable as incomplete so the next run can retry.

## Future Scope

- stronger ranking and filtering behavior
- better multi-agent handoff retrieval
- better cross-repository state recovery

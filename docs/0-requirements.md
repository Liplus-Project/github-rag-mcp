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

Schema source of truth: the Worker tool definitions are authoritative. The client
proxy (`mcp-server/server/tools.js`) answers `tools/list` from a static mirror of
the `search` params — it does not forward `tools/list` to the Worker, keeping
startup auth-free and network-free. Because that mirror is hand-maintained, a param
added to the Worker but forgotten in the proxy is silently dropped by MCP clients
(`additionalProperties: false`) and never reaches the Worker (gh#157).
`scripts/check-schema-drift.mjs` runs in CI and fails the build when the proxy
`search` schema drifts from the Worker, so the two cannot ship out of sync.
The check compares two axes: param names and, for enum params, their values —
a name-only comparison let the proxy `type` enum omit `wiki_doc` while the Worker
accepted it, so clients rejected the value before any request was sent (gh#181).

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
- refresh changed issues, pull requests, releases, docs, GitHub Wiki pages, issue/PR comments, and commit diffs
- keep the stores converged even after transient failures

The poller runs hourly in the current deployment, split across four cron triggers so each invocation gets its own Cloudflare Workers subrequest budget. Each upsert fans out to Store DO + Vectorize + D1 FTS + AI embed (up to four internal subrequests), so even the comments + diffs combination overshoots the per-Worker ceiling on busy repositories; the heavy surfaces run one-per-cron, staggered by 15 minutes:

- **`0 * * * *` (light)** — issues, pull requests, releases, docs
- **`15 * * * *` (comments)** — issue / PR comments only
- **`30 * * * *` (diffs)** — commit diffs only
- **`45 * * * *` (wiki)** — GitHub Wiki pages only

Dispatch is performed inside `handleScheduled` by inspecting `controller.cron`. Unknown cron expressions fall through to a no-op log to prevent silent regressions when triggers are added later.

The commit-diff poller runs in two phases:

- **forward phase** — enumerates the window `(lastPolledAt, pollStartTime]` and ingests its **oldest** commits first, acting as redundancy when webhook delivery has stalled. Watermark namespace: `diffs:${repo}`.
- **backward phase** — walks backward through history using `until=oldestUnprocessedDate`, backfilling commits that predate the webhook or a fresh deployment. Watermark namespace: `diffs_backfill:${repo}`.

Each phase ingests at most 5 commits per repo per run. Upserts through `processAndUpsertCommitDiff` are idempotent on `(repo, commit_sha, file_path)`, so overlap between webhook and either phase is safe.

Both phases obey one watermark invariant: **a watermark never moves past a commit that has not been successfully ingested.** A commit counts as ingested only when its detail fetch succeeded and `processAndUpsertCommitDiff` reported zero failed files — embedding and Vectorize failures are reported by return value rather than by throwing, so the return value is part of the check. The criterion is the dense side only: a D1 FTS mirror or store-row failure is logged by the pipeline and deliberately not counted, since the vector has already landed and the sparse index reconciles on reindex; gating the watermark on the mirror would let an FTS-side outage stall the whole diff surface. Consequences:

- a failed commit, and every commit the per-run cap deferred, stay inside the next run's window
- a failed commit list leaves the watermark untouched, so the whole period stays retryable
- the forward phase must know the oldest end of its window before advancing, so the window is enumerated with a 100-entry page; a full page means "not enumerable" and the window end is halved (at most 8 times) until one page covers it. If even then the window overflows, the run holds the watermark and logs — a visible stall is preferred over a silent gap.

The tradeoff is liveness: a commit that fails on every attempt blocks its phase's watermark. The run log names the boundary commit, and `POST /admin/diff-watermark` (see the installation guide) moves the watermark manually — the same endpoint used to replay a period whose commits were lost by an earlier version of the poller.

The wiki poller runs in the `:45` cron and is the only ingestion path for GitHub Wiki content. Wiki pages live in a separate git repo (`{repo}.wiki.git`) that GitHub does not expose through the REST API or webhook events; the poller therefore performs three lightweight HTTP calls per repo:

1. Probe `https://github.com/{repo}.wiki.git/info/refs?service=git-upload-pack` to detect whether the wiki exists (200 = present, 404 = disabled or absent — skip the rest).
2. Scrape the public `/{repo}/wiki/_pages` HTML index for page slugs (the link href shape `/{repo}/wiki/{slug}` is stable enough for a tolerant regex; underscore-prefixed pseudo-pages like `_pages` / `_history` / `_new` are filtered out). Two details of the index are load-bearing (issue #184): `Home` is never listed even though it exists, so it is unioned into the enumeration unconditionally; and the slug is a *lossy* rendering of the page title (`E. Li+language` routes to `E.-Li-language` while the file is `E.-Li+language.md`), so the link text is kept as a second filename candidate.
3. For each page, fetch the raw markup body from `https://raw.githubusercontent.com/wiki/{repo}/{name}.{ext}`, where `name` is the title-derived filename first and the slug second. Markup extension is detected via probe order (`md` → `markdown`); subsequent polls reuse the previously found extension to skip the probe. The narrowed probe set is deliberate — every miss spends one of the invocation's 1000 subrequests (issue #130).

Change detection uses a content SHA-256 hash (no git blob SHA is available without invoking the wiki git smart-HTTP protocol). Pages whose hash differs from the stored value are re-embedded.

**Coverage.** The page walk is bounded by `MAX_WIKI_FETCHES_PER_REPO_PER_RUN` (default 20), counted per *HTTP attempt* rather than per page so a page needing several candidates cannot exceed the ceiling by fanning out. Because the budget is smaller than a deep wiki, the walk is **circular and resumes from a stored cursor** — the last slug probed, held in the `wiki:{repo}` watermark row's `etag` column, so no schema change was needed. Every page is therefore reached within ceil(pages / budget) runs. Restarting at the head of the enumeration each run is what made pages past position ~20 structurally unreachable and left most of a 77-page wiki unindexed (issue #184). `MAX_WIKI_EMBEDDINGS_PER_RUN` (default 30) remains a separate axis: it caps the Workers AI embed budget, not the walk.

**The budget yields to the first page.** A probe the budget cuts short is not an observed 404, so the walk breaks *before* the cursor moves and retries the page next pass (issue #185). That self-heals only when the next pass can afford the page's whole candidate list; a budget below it re-probes the same page forever and the walk never advances (issue #192). So while the pass has visited nothing, the candidate list outranks the budget: the first page always runs its probes to the end, and a miss there is a real all-candidate 404 that counts as a failure and moves the cursor. Every page after the first keeps the strict check. The overrun is bounded by one page's candidate count minus one — at most 3 subrequests, once per pass, against an invocation budget of 1000 — and it is the only case where a pass's `fetches` may exceed its budget.

**Lap completion.** A second watermark row, `wiki-lap:{repo}`, holds the *lap anchor* — the slug the current sweep started after. The pass reports `wrapped: true` when it reaches the page immediately before the anchor, i.e. when the cursor has come all the way back around, and the anchor then moves to that page so the next lap starts after it. This is what makes the admin endpoint's `done` reachable: reporting "this one pass saw every page" can never be true for a wiki with more pages than one pass may fetch, so the documented "call until `done`" loop had no terminating condition (issue #188). The anchor is resolved by slug order rather than by a stored index, so a page added or deleted mid-lap cannot desync it. An explicit `cursor=` override opens a fresh lap at that point.

**Orphan reap.** Pages absent from the current `_pages` index are removed from Vectorize, D1 FTS5, the graph edge table, and the structured state store. The candidate set is the union of the structured store *and* the live `search_docs` rows: a page missing from the store but still present in the index is invisible to a store-only diff, which is how eight renamed-away pages stayed resolvable in search for months (issue #184). Four guards bound the blast radius — reaping is skipped entirely when the `_pages` index could not be read (an empty slug set means "we are blind", not "everything was deleted"), every remaining candidate is probed for existence before it is deleted (below), the reap is capped at `MAX_WIKI_DELETIONS_PER_REPO_PER_RUN` (default 5) per repo per run, and each surface is torn down independently so a Vectorize failure cannot strand the D1 rows users actually retrieve.

**Pre-reap existence probe.** The index-unreadable guard covers a *total* enumeration failure. A **partial** one — `_pages` returning fewer pages than the wiki holds — is indistinguishable from a real deletion at the set level, and pushes live pages into the reap set; the per-run cap slows that but does not stop it, because the cron repeats. So the check leaves the set and addresses the page: each candidate's raw content is fetched, and only an observed 404 on every candidate extension authorizes the delete (issue #187). A 200, a network error, or any other status withholds it and is reported as `orphansWithheld`; withholding cannot deadlock, since a page that really was deleted keeps answering 404 and drains on a later run. The verdict is per page, so a legitimate bulk deletion still drains at the normal rate. The probe addresses `raw.githubusercontent`, not the rendered `github.com/{repo}/wiki/{slug}` URL: measured 2026-08-01, a nonexistent page there 302-redirects to the wiki root and lands on 200, so it can never report absence. Cost is at most one subrequest per candidate per extension (`md`, `markdown`), spent outside the walk's fetch budget. Residual gap, unchanged from before the guard: a page stored under a title-derived filename (`E.-Li-language` → `E.-Li+language.md`) answers 404 to its own slug, and the link text that carries the filename only exists in the enumeration the page is missing from. A separate warn-only log fires when the candidate set reaches half the indexed page set — a ratio cannot separate a bulk cleanup from a short enumeration, so it decides nothing and only leaves the shape of the run readable.

**Immediate recovery.** `POST /admin/backfill-wiki?repo=owner/repo[&limit=N][&cursor=SLUG]` runs the same pass on demand with an explicit fetch budget (1..40, default 20), sharing the cron's cursor so the two advance one another. Call it repeatedly until the response reports `done: true` — one lap takes ceil(pages / limit) calls, not one; pass an empty `cursor=` to restart the walk (and the lap) from the head. Each call is its own Worker invocation and therefore gets its own subrequest budget.

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
- item type (`issue` / `pull_request` / `release` / `doc` / `wiki_doc` / `diff` / `issue_comment` / `pr_review` / `pr_review_comment`)
- state
- labels (individual slots label_0..3 + CSV fallback)
- milestone
- assignees (individual slots assignee_0..1 + CSV fallback)
- update timestamp
- release tag name
- documentation path (doc rows)
- wiki page slug + extension (wiki_doc rows)
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

- `search_docs` — external content table (source of truth, `vector_id` primary key). It carries the tokenizable text twice: `content` is the raw text, `content_fts` is the word-segmented form.
- `search_docs_nat_fts_v3` — active FTS5 virtual table with porter + unicode61 tokenizer for natural-language surfaces (issue / PR / release / doc / wiki_doc / comment / review surfaces). Its external content is `content_fts`.
- `search_docs_code_fts_v2` — active FTS5 virtual table with trigram tokenizer for code / SHA / identifier surfaces (diff). Its external content is the raw `content`. Superseded generations (nat v2, and both v1 tables) are retained but never queried or updated so a previously corrupt index is not touched during recovery.

Tokenizer selection:

- `porter` — stem-based matching appropriate for natural language.
- `trigram` — substring matching appropriate for SHA prefixes, CamelCase tokens, and file paths.
- A `tokenizer_kind` column on `search_docs` decides which virtual table a row is indexed in.
- Each active FTS table declares a tokenizer-filtered view of `search_docs` as its external-content relation, so the declared content rows and indexed rows are the same set. Triggers cascade inserts / updates / deletes automatically, and every branch is guarded by `tokenizer_kind`: a row is inserted into and deleted from exactly one FTS5 table. Sending an FTS5 `delete` command to the opposite tokenizer for a row it never indexed is forbidden because it corrupts the external-content index.
- Recovery creates a fresh FTS generation and backfills each table with a `WHERE tokenizer_kind = ...` filter. It does not use FTS5 `rebuild`, because `rebuild` would copy every `search_docs` row into each tokenizer and violate the same isolation invariant.

Word segmentation (natural-language side):

- `unicode61` breaks tokens on non-alphanumeric characters only. Japanese has no such separators, so an entire run of kana/kanji is indexed as one token and a Japanese phrase query matches nothing — hybrid retrieval silently degraded to dense-only for the majority of this corpus.
- D1 cannot load a custom tokenizer: `tokenize = 'icu'` fails with `no such tokenizer: icu`. The word boundaries therefore have to be inserted before the text reaches SQLite.
- `Intl.Segmenter` (available in workerd, no dependency) does that split. It runs on both sides of the index: the ingest path stores the segmented text in `content_fts`, and the query path builds the nat `MATCH` string from the segmented query. Symmetry is the correctness condition — the segmenter over-splits some katakana words, which costs precision but not recall, because the query is split the same wrong way.
- Text containing no CJK is passed through verbatim, so English behavior is byte-identical to the previous generation.
- The nat and code branches build **separate** `MATCH` strings from the same query: segmented for nat, raw for code (inserted spaces would break trigram substring matching).
- `content` stays raw because the reranker consumes it and the trigram index indexes it.
- Migration 0006 can only seed `content_fts` with a copy of `content` (the segmentation exists only in JS). `POST /admin/backfill-fts-segments` re-segments the existing rows in batches, driven by a `rowid` cursor; it is idempotent (a row already segmented is skipped without a write), so an interrupted run can simply be restarted.

Query length tiering (nat side):

- A conjunctive `MATCH` (every token required) gets monotonically harder to satisfy as the query grows. Measured on production against one indexed document: 3 tokens returned 3 candidates, ~12 returned 2, ~17 returned 0. Natural-language questions live in exactly that band, so the sparse half of hybrid retrieval was effective for short keyword strings only.
- The cliff is language-independent. Japanese reaches it sooner because segmentation turns particles into standalone tokens, but a long English question falls off it too — so the fix is language-independent as well: no stopword or particle list is maintained.
- The nat side therefore issues **two** `MATCH` strings, strict (all tokens) and relaxed (any token), as separate arms of the same UNION with a `tier` column, ordered by tier before BM25 score. Strict hits keep exactly the ranks they had; the relaxed arm can only append below them, so short-query precision does not regress, and it becomes visible only insofar as the strict arm under-fills `topK` — which is the failure mode itself. No query-length threshold is needed.
- Relaxed-tier precision is carried by BM25: IDF weighting ranks documents covering more (and rarer) query terms above the rest and drives high-frequency function words (`の` / `は` / `the` / `of`) toward zero contribution. That is the ranker doing what a stopword list would have done, without one.
- Both tiers ship in a single statement rather than "retry with OR when AND returns nothing": the retry shape costs a second D1 round-trip per query and would leave the measured mid-band (~12 tokens, 2 weak hits) unimproved. Cost accepted: the relaxed arm walks the posting lists of every query token, so a long query reads more rows than before. The next lever, if that ever bites, is IDF-aware term pruning via an `fts5vocab` table.
- Because a document can be returned by both tiers, results are deduplicated by `vector_id` (best tier, then best score wins) before the `topK` cap.
- The code (trigram) arm stays strict. Substring matching over identifiers does not have the same cliff.

The `vector_id` mirrors the Vectorize vector ID (deterministic SHA-256 based) so RRF fusion can join dense and sparse hits without an extra round-trip.

Metadata filters (`repo`, `type`, `state`, `milestone`) are applied as SQL WHERE predicates, matching the pre-filter capability of the Vectorize side.

BM25 ranking is obtained via the `bm25(<fts_table>)` auxiliary function (lower score = better); scores are converted to ranks for RRF fusion.

### 7. Structured State Store

Durable Object with SQLite stores structured records for:

- issues and pull requests
- releases
- documentation file state (repo `docs/` and other tracked `.md`)
- GitHub Wiki page state (page slug, extension, content hash)
- commit diff file state (one row per file-in-commit)
- polling watermarks

This store supports:

- `get_issue_context`
- `list_recent_activity`
- enrichment of semantic search hits

**Recency window.** Every `/recent*` endpoint reads a half-open window `[since, until)` over the surface's own timestamp column (`updated_at`, `published_at`, `commit_date`), newest first, capped at `limit` rows. Both bounds are part of the SQL. Applying `until` to the returned rows instead is what made old windows unreachable: the cap takes the newest rows first and the filter then drops all of them, so a window holding thousands of rows still read as zero (issue #194). The per-endpoint cap stays — it bounds the subrequest / D1 read budget — but it now truncates the window rather than replacing it.

### 8. Graph Index (opt-in, D1 `doc_edges`)

An additive graph layer that indexes relationships between Decision-Structure wiki entries (kebab-case wiki pages). A third surface alongside dense (Vectorize) and sparse (FTS5), but **never read by retrieval unless explicitly requested**.

- **Schema**: `doc_edges(src_vector_id, dst_vector_id, repo, src_slug, dst_slug, edge_kind, updated_at)` (`migrations/0002_graph_edges.sql`). src/dst are deterministic wiki vector IDs (`wikiDocVectorId`).
- **Edge extraction**: at wiki index time (`processAndUpsertWikiDoc`), when another known wiki slug in the same repo appears in the content, an A→B "mention" edge is written (`indexWikiEdges` in `src/graph.ts`). **Deterministic slug-match (no LLM, no lossy extraction)**; the dst ID is computed, so dangling edges to not-yet-indexed pages are allowed. Typed edges (supersede/depend/conflict) are future scope.
- **Traversal**: `queryNeighbors` walks 1–2 hop undirected neighbors of the seeds via `WITH RECURSIVE` (standard SQLite, no extension).
- **Retrieval integration**: `search` gains `graph_expand` (default false) / `graph_hops` (default 1). Only when true, the final result set seeds a traversal and related wiki pages are appended (tagged `graph_hop` / `graph_from`). **When false the behavior is byte-identical to before (no regression).**
- **Delete fan-out**: on wiki page deletion, `deleteEdgesForVector` removes edges touching that vector.
- **Backfill**: `POST /admin/backfill-edges?repo=owner/repo` (GITHUB_TOKEN header) re-extracts edges from the stored content of already-indexed wiki pages (no GitHub refetch).
- **Evaluation**: real-use observation after ship (does judgment-learning surface related decisions), not an offline eval harness.

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
- Workers AI requires every `contexts[].text` to be at least one character long (error 5006: "Length of '/contexts/N/text' must be >= 1 not met"). Candidates whose content is still empty at call time are filtered out of the rerank input; if 0 or 1 non-empty candidates remain the call is skipped entirely.
- Reranker input content is supplied from two sources. Candidates with a sparse (FTS5) hit carry their content inline. Dense-only candidates have no FTS row, so their content is backfilled from D1 `search_docs` in a single batched `vector_id IN (...)` query issued once per search — never a per-candidate fan-out. The acute case was a Japanese query before the nat index was segmented: FTS5 tokenization yielded zero BM25 hits, every candidate was therefore dense-only, and without this backfill the whole candidate set reached the reranker empty and the cross-encoder never ran. Segmentation removed that specific cause, but any candidate the sparse ranker misses still arrives without content, so the backfill remains required. A D1 failure during backfill is non-fatal: the search proceeds with whatever content is already available.
- `rerank_applied: true` is reported only when at least one candidate actually received a reranker score. An empty reranker result (no scorable content) is treated the same as a failure — fusion order stands and `rerank_applied` is `false`. The invariant is that `rerank_applied: true` always implies at least one non-null `rerank_score` in the response.
- The reranker processes at most 50 candidates per call — chosen as the join point between the Workers AI Free tier neuron budget (10,000/day) and industry median (50–75 candidates).
- bge-reranker-base is English-centric and not multilingual. Japanese issue/PR content may see degraded quality. This is observed at runtime; switching to `bge-reranker-v2-m3` or an external reranker (Voyage / Cohere) is tracked as a separate issue when needed. Note that the dense-only content backfill above makes the cross-encoder *run* on Japanese queries; it does not make the model multilingual, so ranking quality remains a separate axis.
- On reranker call failure or unexpected response shape, the system falls back gracefully to the post-filter (RRF) order and reports `rerank_applied: false`.

Cost estimate:

- Workers AI public pricing: bge-reranker-base = 283 neurons/M tokens.
- Per-search estimate: ~7.5 neurons (query 30 tokens + 50 candidates × 500 avg tokens, embedding included).
- Free tier (10,000 neurons/day) supports ~1,300 searches/day at this rate.
- Actual neuron usage is read from a `usage` field on the response when present and reconciled against the estimate. The field is not officially documented as of 2026-04, so absence is tolerated silently.

### Fusion mode toggle

`search` accepts a `fusion` parameter:

- `rrf` (default) — combine dense and sparse via RRF.
- `dense_only` — query Vectorize only (debugging, semantic-heavy queries).
- `sparse_only` — query D1 FTS5 BM25 only (debugging, exact-term / identifier queries).

`search` also accepts a `rerank` parameter:

- `true` (default) — re-score the RRF-fused candidates with bge-reranker-base.
- `false` — skip rerank (faster, no Workers AI rerank cost; recommended for short-identifier queries where lexical match is already decisive, or for debugging).

The retrieval layer is intended to recover working state, not merely keyword matches. The 3-tier design lets sparse cover BGE-M3's weak regime (short identifiers, SHA prefixes, proper nouns), RRF maintains recall across both rankers, and the cross-encoder lifts precision on the surviving candidates.

## MCP Tools

### `search`

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
- `since` / `until` optional — half-open time window `[since, until)`

Returns:

- ranked matches with repository, type, state, labels, milestone, assignees, URL, and RRF fused `score`
- additional debug fields per result: `dense_score`, `sparse_score`, `dense_rank`, `sparse_rank`, `rerank_score` (null when rerank disabled or when graceful fallback engaged)
- top-level metadata: `fusion`, `dense_candidates`, `sparse_candidates`, `rerank_requested`, `rerank_applied`

**Scan mode (empty query).** Vectorize / FTS5 / reranker are skipped and the result set is aggregated from the structured store's recency endpoints. `since` / `until` are pushed down to the store, so a window returns rows whenever it holds rows, however far back it sits. `since` defaults to 7 days before `until` (before now when `until` is omitted), so an `until`-only query does not degenerate into an empty window above its own ceiling.

Scan mode adds one top-level field, `truncated`, which is true when the window holds more rows than the response carries — either an endpoint filled its row cap, or the merged set was longer than `top_k`. This is what tells a caller that zero results means "no such rows" rather than "the read stopped short": walk backwards by re-issuing the scan with `until` set to the oldest row returned. A gap-hunting tool that cannot separate those two answers reports absent rows that exist and misses rows that do not, which is how #178 was mis-diagnosed twice in one day.

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
- reuse a cached Dynamic Client Registration only when its registered redirect
  URI set covers every localhost callback URI requested for the current OAuth
  flow; otherwise register a replacement client before authorization

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

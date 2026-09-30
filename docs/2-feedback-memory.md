# Private retrieval feedback memory

Language: English | [Japanese](2-feedback-memory.ja.md)

This specification completes Issue #259's four connected functions: retrieval history, explicit source usage, decaying activation, and reversible graph feedback. It stores the query, retrieval settings, returned source provenance and explicit decisions. It does not archive conversations or duplicate document bodies, titles, access credentials, or authentication props.

## Identity and traces

Every successful `search` call (search, scan, stored-content fetch, and zero hits) commits a UTC trace before returning `trace_id`, `timestamp`, `feedback_available: true`, `source_id`, `provenance`, and current `activation` on returned rows, including folded `same_entity.others`. The request records filters and controls; settings record mode, effective scan window, fusion/rerank outcomes and both retrieval axes. Source provenance is `{repo,type,identity,version,content_source}`. Identity is issue/PR number, release tag, doc/wiki path, `[commit_sha,file_path]` for diffs, or canonical GitHub comment/review ID. `content_source:"index"` uses captured `updated_at` as `version` (the indexed snapshot timestamp for doc/wiki pages). Live inline doc/wiki bodies carry `content_source:"github_live"` and `content_version:"sha256:<returned UTF-8 text hash>"`; that hash is their provenance version and enters the source ID. `index_updated_at` preserves the indexed timestamp as supplemental audit metadata without defining the live version. The same live body stays the same source version when the index timestamp changes; a changed returned body changes its source ID even when the index timestamp is unchanged. Stored-content fetch and graph-axis bodies refer to the indexed copy and keep separate index provenance. Memory stores only the hash/provenance, never the live body. Arbitrary supplemental fields, vector handles and mode do not enter the ID hash.

`source_id` identifies a particular source version, not the unversioned entity. Same entity and captured version have the same ID after a vector-handle migration; an updated version has a different ID. Activation belongs to that version. Mention strength belongs to canonical `[repo,src_slug,dst_slug,edge_kind]`, independently of vector IDs and document versions. Reindexing mention topology neither resets nor rewrites private learned state. Removed mentions cannot be traversed; a saved historical path remains auditable and reversible.

The server derives `github:<numeric GitHub user ID>` from verified MCP OAuth props. Caller identity fields are not trusted. Same-user clients share private traces and receipts; other users get `unknown_trace`/`unknown_confirmation` rather than someone else's data. The internal DO interface is not publicly routed.

`memory_history {limit:10}` returns newest trace summaries and `next_cursor`; pass that cursor for the next page. `memory_history {trace_id,limit:10}` returns sources, current stages/activation, settings and oldest-first receipt audit. Its `next_cursor` pages **receipts within that trace**, not trace summaries. Cursors belong to the authenticated principal and, for details, the trace. Limits are 1..50; source snapshots cap at 300 per trace, saved trace input at 300,000 characters, queries at 4096 characters, metadata strings at 256, usage batches at 100 entries, and reason/idempotency handles at 1000/128 characters. SQL reads use owner/cursor indexes and bounded pages; no full-history fetch is used.

A failed retrieval is not recorded as successful. If retrieval is partial (a scan surface, sparse retrieval, or graph expansion failed), identity cannot be resolved, or the atomic memory write fails, retrieval can still return with `memory_unavailable: true`, `feedback_available: false` and **no `trace_id`**. It cannot accept feedback. Memory rejection codes describe ownership, stage, key conflict and confirmation errors without echoing the submitted query or handles. Retrieval error logging emits fixed messages.

## Usage and idempotency

`record_source_use {trace_id,idempotency_key,uses:[{source_id,stage}]}` records:

| Stage | Meaning | Activation addition |
|---|---|---:|
| selected | Chosen for investigation | 0.2 |
| validated | Exact source checked and judged usable | 0.5 |
| used | Actually used in an answer or decision | 1.0 |

Stages advance one step at a time. A batch can contain all three steps for the same source after the caller has performed them. Trace membership, stage order, owner and every batch entry are checked in one SQLite `transactionSync`; any rejection rolls back usage, activation and receipt. Resending an already completed stage is a no-op. Retrieval alone is not usage or confirmation.

Idempotency keys are principal-wide across mutation tools and traces. A retry with the same parsed payload returns the original receipt. Another payload with that key returns `idempotency_conflict`. JSON object field order does not affect equivalence; array order does. Concurrent requests serialize through the DO and transaction. A new operation needs a new key.

## Activation and learned strength

`MEMORY_POLICY` fixes half-life at 3600 seconds. On reads/updates, value decays as `value * 0.5^(max(0,elapsed_ms)/3600000)`. Backwards time contributes zero elapsed, and updates keep timestamps monotonic. No cron is needed. `retrieved` adds 0.1 per distinct returned source per successful trace; `usage` adds the explicit stage amounts above. Each channel caps at 10, total at 20; values are finite and nonnegative. Readback includes both channels, their total, and UTC `updated_at`. Reversal removes relation credit; it does not erase a historical usage or its activation.

Search writes history by default and has `readOnlyHint:false`. Keyword fusion, scores, ranks and rerank behavior are unchanged. `graph_expand:false` remains the graph default. `use_memory:false` preserves the existing graph output order/limit. `use_memory:true` in search mode orders a bounded pool of up to 200 current graph candidates by hop ascending, then summed decayed path strength descending, preserving original order on ties; it then returns at most `min(top_k*2,30)`. This can admit a learned candidate outside the previous output cap. Initial zero strength yields the existing order. Learning never mixes the axes or adds a relevance score; only opt-in graph rows carry `learned_strength` (sum of relation credit, not relevance). Scan/fetch ignore this ordering switch.

## Confirmations and causal reversal

`record_outcome {trace_id,idempotency_key,outcome:"confirmed",source_ids,reason}` requires used sources from that trace. It credits only the actual one/two directional mention edges saved by the graph traversal. No origin-to-terminal shortcut, lexical edge or zero-hop edge is created. Usage alone never strengthens a relation.

Each independent trace can add 0.25 per saved edge, with a decayed edge-strength cap of 5. A trace contributes to an edge only once, even when multiple returned sources share it, confirmation is repeated, or its old contribution was reversed. The applied delta is the remaining cap headroom (possibly zero). Receipt and ledger save path, delta, timestamp, reason and active/reversed status. Duplicate, cap, lexical, and already-reversed operations expose non-application reasons.

`corrected`/`rolled_back` requires **one explicit `confirmation_id` from the same trace** and omits `source_ids`. Reversal deactivates precisely that receipt's contributions and subtracts their present decayed deltas. Later independent contributions remain; no scalar reset or inverse guess is used. Unknown/ambiguous confirmations reject atomically. Audit preserves the original receipt and a separate reversal receipt. Reversed traces cannot reacquire credit for the same edge.

## Deployment and schema preparation

No version, tag or public release is created by this change. No new Worker binding or DO class migration is needed: independent `memory_*` tables are created additively inside existing SQLite `IssueStore`. Existing issue tables and watermarks are retained.

Apply D1 migration **0008 before deploying or merging into a branch that automatically deploys**. It adds `comment_id`/`review_id`, with zero as the unresolved legacy sentinel. Deployment preparation (operator action; do not publish credentials):

```powershell
# Read-only preflight
npx wrangler d1 migrations list github-rag-fts --remote
npx wrangler d1 execute github-rag-fts --remote --command "PRAGMA table_info(search_docs)"
# After the operator authorizes production mutation, before Worker deployment
npx wrangler d1 migrations apply github-rag-fts --remote
# Verify both new columns; then deploy the reviewed Worker commit
npx wrangler d1 execute github-rag-fts --remote --command "PRAGMA table_info(search_docs)"
# Read-only unresolved-row count (after 0008)
npx wrangler d1 execute github-rag-fts --remote --command "SELECT type,COUNT(*) AS unresolved FROM search_docs WHERE (type IN ('issue_comment','pr_review_comment') AND comment_id=0) OR (type='pr_review' AND review_id=0) GROUP BY type"
```

After deployment, authorized `POST /admin/backfill-source-identities?repo=owner/repo&limit=50[&cursor=TYPE:ID]` repairs historical unchanged rows from existing canonical DO events. Supply the existing administrative credential through a private header; no token belongs in a URL, artifact or shell history. Follow `next_cursor` until `done:true`. Limit 1..100, at most three bounded DO reads and one atomic D1 batch per page. Restarting is safe; no embeddings, GitHub body refetch or index reset is needed. Normal unchanged comment/review ingest also repairs IDs before its hash-skip return. Rows whose canonical event is absent from the DO remain unresolved; inspect that gap before any separate reingest. A trace containing unresolved source identity fails memory closed. Backfill does not rewrite private traces/credits.

The bridge includes `server/search-schema.json` and `server/memory-tools.json`. `node scripts/generate-tool-contracts.mjs` regenerates them from Worker Zod schemas; `node scripts/check-schema-drift.mjs` compares all shipped tools' exact nested input/output contracts, bounds, defaults and annotations against the actual protocol. Package both JSON files in npm/mcpb artifacts. Worker deployment enables direct-client tools; the published bridge must include the new artifacts for stdio clients to discover them. Public version selection and publication are subsequent operations.

## Verification and synthetic example

Run `npx vitest run --config vitest.workers.config.ts src/memory-e2e.workers.test.ts src/memory.workers.test.ts`. These fixtures use synthetic principals and local in-process SQLite/D1. The observed lifecycle is search of `syntheticneedle` -> graph path `a->b->c` -> selected/validated/used for `c` -> confirmation with two 0.25 deltas -> corrected with both credits inactive. The independent-trace test confirms again one half-life later: path strength 0.75 -> reversing the first trace leaves 0.50 from the second. The real MCP live-body regression changes only doc/wiki inline text while holding the index timestamp and keyword ranks fixed: retry keeps the same ID, changed live text gets another ID, stored fetch retains the index ID, and usage of the old live version does not mark the new version used. This is correctness evidence, not an evaluation that retrieval quality improved.

Cost: each successful retrieval adds one DO request and bounded source hash/activation work. Opt-in learning additionally reads up to 200 saved paths (up to two edges each). Storage grows with private traces and receipts; no automatic retention deletion is included. This global DO serializes writes. No Python process, model distribution, embedding step, or extra graph topology write is added by feedback.

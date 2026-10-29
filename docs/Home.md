# github-rag-mcp

Cloudflare Workers + Vectorize + D1 FTS5 + Workers AI による、GitHub issue / pull request / release / docs / commit diff の **3-tier hybrid retrieval** MCP サーバー。

[github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp)（プッシュ型通知）の対となるプロジェクト。両者を組み合わせることで、AI に GitHub プロジェクトの完全な状態を提供する。

## アーキテクチャ

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

retrieval layer は **3-tier hybrid search**:

1. **Dense** — Vectorize に格納した BGE-M3 embedding (1024d, cosine) を semantic 検索
2. **Sparse** — D1 FTS5 (BM25) を porter / trigram tokenizer で語彙検索（コード識別子 / SHA / 固有名詞に強い）。自然文側は索引時・検索時の両方で `Intl.Segmenter` により分かち書きするため、日本語の句クエリでも BM25 候補が立つ
3. **Fusion + Rerank** — Reciprocal Rank Fusion (RRF, k=60) で dense / sparse を合成 → `@cf/baai/bge-reranker-base` で precision を底上げ

`push` event からは per-commit diff も index される（1 commit × N files → N vector）。これにより削除済みファイルや非 `.md` 拡張子の判断履歴も semantic 検索可能。

詳細: [[要件仕様|0-requirements.ja]]

## MCP ツール

検索用の entry point は `search`。旧 `list_recent_activity` と `get_doc_content` の用途は、以下の activity scan と文書本文の inline 取得に統合した。これらの旧 tool は現在公開していない。

旧 `get_issue_context` の live issue / PR 集約は廃止した。`search` は索引済み snapshot を扱い、linked PR、branch、CI、sub-issue、related release の live 集約は保証しない。最新の GitHub state が必要な場合は `gh` または [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) で補う。

### `search`

issue / pull request / release / repository documentation / GitHub Wiki / commit diff / issue・PR comment / PR review / inline review comment を取得する。パラメータに応じて次の用途を切り替える。

- **Hybrid search** — 非空の `query` で 3-tier hybrid search を行う。
- **Activity scan** — `query` が空または省略された場合は時系列に走査する。`sort`（`updated_desc` / `created_desc`）と `since` / `until` で順序と時間窓を指定できる。
- **文書本文の inline 取得** — `include_content: true` で doc / wiki_doc 結果に GitHub から取得した live 本文を添える。
- **保存済み本文の取得** — 先行する search 結果の `vector_id` を `vector_ids` に渡し、D1 に保存された索引済み本文（最大 8000 文字）を取得する。live 本文ではなく、GitHub API 呼び出しは行わない。

`vector_ids` に ID を渡すと保存済み本文の取得が優先され、`query` / `sort` / metadata filter は適用しない。

主なパラメータ（すべて optional）:

- `query` — 自然文クエリ。`vector_ids` 未指定で空または省略すると activity scan
- `repo` / `state` / `labels` / `milestone` / `assignee` / `top_k` — 絞り込みと件数。`repo` は `owner/repo` の完全一致
- `type` — `issue` / `pull_request` / `release` / `doc` / `wiki_doc` / `diff` / `issue_comment` / `pr_review` / `pr_review_comment` / `all`（既定）
- `path_prefix` — `type: "doc"` 用の repository-relative directory prefix（末尾 `/` が必須）
- `fusion` — `rrf`（既定）/ `dense_only` / `sparse_only`。exact な文字列（`#N`、数字、SHA 断片）を探すときは `sparse_only`。省略時に literal トークン1個の query には応答の `hint` がそれを案内する
- `rerank` — `true`（既定）/ `false`
- `sort` — `relevance` / `updated_desc` / `created_desc`（既定は search で `relevance`、scan で `updated_desc`）
- `since` / `until` — 半開区間 `[since, until)` の時間窓
- `include_content` — doc / wiki_doc の live 本文を inline（既定 false）
- `vector_ids` — 保存済み本文を取得する行の ID（最大 50 件）

Hybrid search の戻り値には RRF fused score、dense / sparse rank、reranker score などの debug フィールドも含まれる。詳細な検索契約は [[要件仕様|0-requirements.ja]] を参照。

### Feedback memory 用ツール

検索用の `search` に加え、次のツールを公開している。検索で取得したことと、資料を検証・使用したことは区別する。

- `memory_history` — 自分の検索 trace 履歴、資料の使用段階、outcome の記録を読む。
- `record_source_use` — trace 内の資料について `selected` → `validated` → `used` の段階を記録する。
- `record_outcome` — `used` 済み資料の `confirmed` で保存済み graph path を強化し、`corrected` / `rolled_back` で指定した confirmation receipt の寄与を取り消す。

契約と上限は [[検索 feedback memory|2-feedback-memory.ja]] を参照。

## インストール

完全なセットアップガイドは [[インストールガイド|installation.ja]] を参照。

## サポートドキュメント

- [[要件仕様|0-requirements.ja]] — Architecture / Retrieval Model / MCP Tools の詳細
- [[Memory Philosophy|1-memory-philosophy.ja]] — `state over complete memory` の設計思想

## Pages

- Home: [[EN|Home]]（現状 ja のみ）
- Installation: [[EN|installation]] / [[JA|installation.ja]]
- Requirements: [[EN|0-requirements]] / [[JA|0-requirements.ja]]
- Memory Philosophy: [[EN|1-memory-philosophy]] / [[JA|1-memory-philosophy.ja]]

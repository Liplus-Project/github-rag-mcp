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
2. **Sparse** — D1 FTS5 (BM25) を porter / trigram tokenizer で語彙検索（コード識別子 / SHA / 固有名詞に強い）
3. **Fusion + Rerank** — Reciprocal Rank Fusion (RRF, k=60) で dense / sparse を合成 → `@cf/baai/bge-reranker-base` で precision を底上げ

`push` event からは per-commit diff も index される（1 commit × N files → N vector）。これにより削除済みファイルや非 `.md` 拡張子の判断履歴も semantic 検索可能。

詳細: [[要件仕様|0-requirements.ja]]

## MCP ツール

### `search`

issue / pull request / release / documentation / **commit diff** を 3-tier hybrid search で引く。

主なパラメータ:

- `query` (required)
- `repo` / `state` / `labels` / `milestone` / `assignee` / `top_k` (optional)
- `type` (optional) — `issue` / `pull_request` / `release` / `doc` / `diff`
- `fusion` (optional) — `rrf` (default) / `dense_only` / `sparse_only`
- `rerank` (optional) — `true` (default) / `false`

戻り値には RRF fused score、dense / sparse rank、reranker score などの debug フィールドも含まれる。

### `get_issue_context`

単一 issue / pull request の周辺 state（linked PRs、branch、CI status、sub-issues、related releases）を集約して返す。

### `list_recent_activity`

tracked repository 群の recent activity feed（issue / PR / release / docs / commit diff の更新）を返す。

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

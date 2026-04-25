# github-rag-mcp

言語: [English](README.md) | 日本語

Cloudflare Workers 上で動く、GitHub の issue / pull request / release / documentation / Wiki page / commit diff / comment 系 検索向け MCP サーバーです。

`github-rag-mcp` は GitHub を AI の shared working memory として扱うために設計されています。会話を丸ごと保存して完全記憶を目指すのではなく、人間にも見える durable artifact から現在の状態を復元しやすくすることを重視します。

[github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) の検索側カウンターパートとして位置づけています。両者を組み合わせると、AI は次の二つを扱えます。

- いま何が起きたかを push で受け取ること
- 次に必要な状態を hybrid retrieval (dense + sparse) で引き戻すこと

## Memory Model

このプロジェクトは GitHub を AI 作業の visible state store として扱います。

- 完全記憶は目標にしない
- 余計なものを足さない
- 次の正しい行動に必要なものを引かない
- 状態は人間が読める artifact に保存する
- 会話全文の再生ではなく検索で文脈を復元する

詳しくは次を参照してください。

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

- MCP surface は AI クライアント向けの hybrid retrieval と文脈取得ツールを提供します。
- webhook receiver は GitHub 更新をほぼリアルタイムで memory に反映します。
- cron poller は取りこぼし補償と backfill を担います。
- Vectorize は dense 側の semantic embedding を保持します。
- D1 FTS5 は sparse 側の BM25 index を保持し、exact term や識別子クエリを担います。
- cross-encoder reranker は fusion 後の候補を 3 段目として re-score します（クエリごとに切替可能）。
- Durable Object は activity と structured lookup のための状態を保持します。

## Why GitHub

ソフトウェア開発に必要な artifact は、すでに GitHub 上にあります。

- issue は要件と未解決事項
- pull request は実装履歴と review 状態
- docs は固定化された理解
- release は出荷済みの節目

これらを memory surface として使うことで、AI の内部記憶だけに依存せず、引継ぎと監査をしやすくします。

## Installation

次を参照してください。

- [docs/installation.md](docs/installation.md)
- [docs/installation.ja.md](docs/installation.ja.md)

## Requirements

次を参照してください。

- [docs/0-requirements.md](docs/0-requirements.md)
- [docs/0-requirements.ja.md](docs/0-requirements.ja.md)

## MCP Tools

この MCP サーバーが公開するツールは 1 つに統合されています。意味検索、時系列 activity scan、doc 本文取得のいずれも `search` のパラメータ経由で扱えます。以前の build で分かれていた `get_issue_context` / `get_doc_content` / `list_recent_activity` は削除され、用途は下記パラメータに吸収されました。

### `search`

GitHub の issue / pull request / release / documentation / **GitHub Wiki page** / commit diff / comment 系 (issue と PR の top-level comment、PR review 本文、PR インラインレビューコメント) を対象にした統合検索ツールです。

`query` と `sort` の組み合わせで、以下の 3 モードを切り替えます。

1. **ハイブリッド意味検索 (既定)** — dense BGE-M3 (Vectorize) + sparse BM25 (D1 FTS5) を Reciprocal Rank Fusion (RRF, k=60) で合成し、`@cf/baai/bge-reranker-base` cross-encoder で rerank。自然言語 `query` を渡します。
2. **時系列 activity scan** — `query` を省略または空にし、`sort` を `"updated_desc"` / `"created_desc"` に設定します。`since` / `until` を併用して窓を絞れます。従来の `list_recent_activity` を置き換えます。
3. **doc 本文取得** — `include_content: true` を指定すると、`type="doc"` 結果の本文が GitHub contents API 経由で取得され、該当行の `content` フィールドに inline されます。API fan-out を抑えるため先頭の数件に絞られます。従来の `get_doc_content` を置き換えます。

structured filter (`repo` / `state` / `labels` / `milestone` / `assignee` / `type`) はすべてのモードで有効です。

bot (`sender.login` が `[bot]` で終わる) と trim 後 10 文字未満の body は ingest 時点で除外されます。`LGTM` / `+1` / CI ノイズなどは retrieval 面に残りません。

#### パラメータ

| 名前 | 型 | 説明 |
|------|----|------|
| `query` | string (省略可) | 自然言語クエリ。省略または空文字で scan モード。 |
| `repo` | string | repository (`owner/repo`) で絞り込み。 |
| `state` | `"open"` / `"closed"` / `"all"` | state で絞り込み (既定 `all`)。 |
| `labels` | string[] | label 名で AND 絞り込み。 |
| `milestone` | string | milestone title で絞り込み。 |
| `assignee` | string | assignee login で絞り込み。 |
| `type` | 下記参照 | type で絞り込み (既定 `all`)。 |
| `top_k` | number | 最大件数 (既定 10、上限 50)。 |
| `fusion` | `"rrf"` / `"dense_only"` / `"sparse_only"` | fusion 戦略 (既定 `rrf`)。scan モードでは無視。 |
| `rerank` | boolean | cross-encoder rerank (既定 `true`)。scan モードでは無視。 |
| `sort` | `"relevance"` / `"updated_desc"` / `"created_desc"` | 並び順。query ありの既定は `relevance`、query なしの既定は `updated_desc`。時系列指定は ranker score を上書きします。 |
| `since` | ISO 8601 文字列 | `updated_at >= since` の結果だけを残します。 |
| `until` | ISO 8601 文字列 | `updated_at < until` の結果だけを残します。 |
| `include_content` | boolean | 上位 doc 結果に本文を inline する (既定 `false`)。 |

#### `type` 値

| 値 | 対象 |
|----|------|
| `"issue"` | GitHub issue (title + body)。 |
| `"pull_request"` | pull request 本文 (title + body)。 |
| `"release"` | release notes (name + body)。 |
| `"doc"` | repo の Markdown documentation。 |
| `"wiki_doc"` | GitHub Wiki page。`doc` とは別 surface で同名 page があれば両方検索結果に出る。 |
| `"diff"` | commit の per-file diff (commit message + file path + patch)。 |
| `"issue_comment"` | issue と PR の top-level コメント。 |
| `"pr_review"` | PR レビュー本文 (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED`)。 |
| `"pr_review_comment"` | PR の per-line インラインレビューコメント。 |
| `"all"` | 上記すべての union (既定)。 |

#### 使用例

特定トピックの意味検索:

```json
{
  "query": "rerank latency budget",
  "repo": "Liplus-Project/github-rag-mcp",
  "top_k": 5
}
```

直近 24 時間の時系列 activity scan:

```json
{
  "sort": "updated_desc",
  "since": "2026-04-22T00:00:00Z",
  "top_k": 20
}
```

意味検索しつつ doc 上位の本文を inline 取得:

```json
{
  "query": "memory philosophy",
  "type": "doc",
  "include_content": true,
  "top_k": 3
}
```

特定トピックに関する過去の PR review 判断を検索:

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

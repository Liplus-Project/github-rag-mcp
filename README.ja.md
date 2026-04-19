# github-rag-mcp

言語: [English](README.md) | 日本語

Cloudflare Workers 上で動く、GitHub の issue / pull request / release / documentation 検索向け MCP サーバーです。

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
     + hybrid retrieval (dense + sparse + RRF fusion)
            |
            +--> Vectorize (dense semantic index)
            +--> D1 FTS5 (BM25 sparse index)
            +--> Durable Object / SQLite (structured state store)
            +--> Workers AI BGE-M3 (embeddings)
```

- MCP surface は AI クライアント向けの hybrid retrieval と文脈取得ツールを提供します。
- webhook receiver は GitHub 更新をほぼリアルタイムで memory に反映します。
- cron poller は取りこぼし補償と backfill を担います。
- Vectorize は dense 側の semantic embedding を保持します。
- D1 FTS5 は sparse 側の BM25 index を保持し、exact term や識別子クエリを担います。
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

| Tool | Description |
|------|-------------|
| `search_issues` | issue / pull request / release / documentation を hybrid retrieval (dense + sparse) と structured filter で検索する |
| `get_issue_context` | 単一 issue / pull request の集約状態を返す。linked PR、branch、CI、sub-issue、related release を含む |
| `list_recent_activity` | 追跡対象 repository の recent activity を返す。issue、PR、release、documentation 更新を含む |

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

# github-rag-mcp 要求仕様

言語: [English](0-requirements.md) | 日本語

## Overview

`github-rag-mcp` は GitHub 上の project state を AI agent が検索・取得できるようにする MCP サーバーです。

対象にする artifact:

- issue
- pull request
- release
- repository documentation
- commit diff（削除済みファイルを含む判断履歴）

このシステムの目標は transcript memory ではなく recoverable project state です。

本プロジェクトは GitHub を shared working memory として扱います。

- issue は要件、未解決事項、タスク状態を保持する
- pull request は実装、review、CI 状態を保持する
- docs は固定化された理解を保持する
- release は出荷済みの節目を保持する
- commit diff は「その時点でどう判断して何を変えたか」の履歴を保持する（削除済みファイル・非 .md 拡張子を含む）

agent が行動するときは、必要な状態の断面を search で引き戻します。

カウンターパート:

- [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) は push ベースの awareness を担う
- `github-rag-mcp` は durable state 上の retrieval を担う

## Principles

### State over complete memory

会話や思考過程を丸ごと保存することは目指さない。

次の正しい行動に必要な state を保存し、取り戻せるようにすることを目指す。

### No unnecessary additions

memory layer は GitHub artifact の意味を変えるような推測や装飾を足さない。

### No loss of required information

memory layer は別 agent や別 session が安全に続きを行うために必要な制約、判断、現在地を落とさない。

### Human-visible memory

source of truth は引き続き人間が読める GitHub artifact にある。retrieval はその上に載る index であり、置き換えではない。

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

worker は HTTP 上で MCP tools を公開する。

Responsibilities:

- 認証済み MCP request を受ける
- semantic retrieval と structured retrieval の tool を公開する
- downstream agent がそのまま使える形式で state を返す

### 2. Webhook Receiver

webhook receiver は GitHub event を near real time で取り込む。

対象 event family:

- `issues`
- `pull_request`
- `release`
- `push`

Responsibilities:

- `GITHUB_WEBHOOK_SECRET` で署名検証する
- GitHub source IP を検証する
- event を embedding pipeline に渡す
- semantic store と structured store の両方を更新する

`push` はリポジトリ内の全 `.md` ファイルの変更検出に使う。同じ `push` event から per-commit diff も index する（1 commit × N files → N vector、各 vector は commit message + file path + patch を embedding input にする）。これにより削除済みファイルや非 `.md` 拡張子の判断履歴も semantic 検索可能になる。

### 3. Cron Poller

cron poller は fallback path である。

Responsibilities:

- webhook 取りこぼしを補償する
- 新しい repository の backfill を行う
- issue、pull request、release、docs、issue/PR comments、commit diff の変更を再取得する
- 一時障害後も store を収束させる

現在の deployment では hourly で 3 つの cron trigger に分けて実行する。各 upsert が Store DO + Vectorize + D1 FTS + AI embed と最大 4 internal fetch を生むため、heavy 同居 (comments + diffs) でも per-Worker subrequest 上限を超える。surface 単独単位で 15 分ずつずらして発火させる:

- **`0 * * * *` (light)** — issues / pull requests / releases / docs
- **`15 * * * *` (comments)** — issue/PR comments のみ
- **`30 * * * *` (diffs)** — commit diffs のみ

各 invocation は独立した subrequest 予算を持つ。dispatch は `controller.cron` で `handleScheduled` 内で行う。未知の cron 表現は no-op log で silent regression を防止する。

commit diff poller は 2-phase 構成:

- **forward phase** — `since=lastPolledAt` で直近 commit を再取得する（webhook 取りこぼし時の redundancy）。watermark namespace は `diffs:${repo}`。
- **backward phase** — `until=oldestUnprocessedDate` で履歴を徐々に遡行する（新規 deployment や webhook 起動前の commit を backfill する経路）。watermark namespace は `diffs_backfill:${repo}`。

1 run あたり上限は forward / backward それぞれ 10 commits。`processAndUpsertCommitDiff` の upsert は `(repo, commit_sha, file_path)` で idempotent なので、webhook / 両 phase 間で overlap しても副作用はない。

### 4. Embedding Pipeline

embedding model:

- `@cf/baai/bge-m3`

現行実装:

- 1024 dimensions
- cosine similarity
- issue / release は body hash で変更検出する
- documentation は blob SHA で変更検出する
- commit diff は append-only。一度 index した (commit_sha, file_path) は再計算しない

Responsibilities:

- title + body または path + content から embedding input を作る
- 安全な場合は unchanged record を skip する
- vector と metadata を Vectorize に upsert する
- 同じ content を D1 FTS5 の `search_docs` table にも upsert する（sparse 側同期、tokenizer_kind は type に応じて `nat` / `code` を自動選択）
- embedding 失敗時も次回 retry できる状態を保つ
- D1 FTS5 upsert 失敗は Vectorize upsert を無効化しない（次回 reindex で reconcile）
- commit diff は 1 commit 分の file リストを batch embed（Workers AI の `text: string[]` 対応を利用）し、1 回の Vectorize upsert で N vector を書き込む
- batch size は `MAX_EMBEDDING_BATCH_SIZE`（既定 20）で上限。これを超える commit は複数 batch call に分割する

### 5. Vector Store (Dense)

Vectorize は hybrid retrieval の dense 側を担う。次の metadata を伴う semantic embedding を保持する。

- repository
- item type（`issue` / `pull_request` / `release` / `doc` / `diff`）
- state
- labels（個別スロット label_0..3 + CSV フォールバック）
- milestone
- assignees（個別スロット assignee_0..1 + CSV フォールバック）
- update timestamp
- release tag name
- documentation path
- commit SHA / file path / file status / commit date / commit author / blob SHA（diff only）

Metadata index（10/10 枠使用）:

- Pre-filter 対応: repo, type, state, milestone
- 将来の pre-filter 用に格納: label_0, label_1, label_2, label_3, assignee_0, assignee_1

Vectorize の metadata filter はフィールド間で AND のみサポートし、OR は非対応。`label_0 = "bug" OR label_1 = "bug"` のようなクエリは表現できない。そのため labels / assignees は overfetch + post-filter で recall を改善している。Vectorize が OR または `$in`-across-fields をサポートした時点で、個別フィールドは即座に pre-filter 化可能。

vector store は semantic retrieval layer であり、canonical state store ではない。

### 6. Full-Text Index (Sparse, D1 FTS5 / BM25)

D1 の FTS5 virtual table は hybrid retrieval の sparse 側を担う。

採用理由:

- dense-only retrieval はコード識別子、固有名詞、SHA、exact term などの sparse 情報で recall を落とす構造弱点が既知
- 2026 時点の業界標準では hybrid search が production baseline (reranker は併用例もある別階層)
- Cloudflare D1 は SQLite FTS5 pre-compiled、BM25 ranking 内蔵、Workers から virtual table として利用可能

Schema 概要:

- `search_docs` — external content table（source of truth、vector_id を primary key）
- `search_docs_nat_fts` — porter + unicode61 tokenizer の FTS5 virtual table（自然言語: issue / PR / release / doc）
- `search_docs_code_fts` — trigram tokenizer の FTS5 virtual table（コード / SHA / identifier: diff）

tokenizer 選択:

- `porter` — 自然言語の stem matching に適する
- `trigram` — SHA prefix、CamelCase、file path などの部分一致に適する
- tokenizer_kind 列で row をどちらの virtual table に振り分けるか決定
- content-owner table (`content=search_docs`) + trigger による自動 sync で、delete の fan-out は DELETE FROM search_docs 一発で両 virtual table に伝搬する

vector_id は Vectorize 側と同一（deterministic SHA-256 ベース）で、RRF 合成時に dense hit と sparse hit を追加 round-trip なしで join できる。

Vectorize metadata filter と同じく、`repo` / `type` / `state` / `milestone` は SQL WHERE 句で pre-filter する。

BM25 ranking 関数 `bm25(<fts_table>)` で score を取得する。値が小さいほど good match。RRF 合成では rank に変換する。

### 7. Structured State Store

Durable Object + SQLite は次の structured record を保持する。

- issue / pull request
- release
- documentation file state
- commit diff file state（1 row = 1 file-in-commit）
- polling watermark

この store は次を支える。

- `get_issue_context`
- `list_recent_activity`
- semantic search hit の enrichment

## Retrieval Model

retrieval layer は hybrid search（dense + sparse）+ cross-encoder rerank + structured filter を 3 段で支える（2026 production baseline）。

### 3-tier Hybrid Retrieval (default)

想定フロー:

1. query の embedding を Workers AI BGE-M3 で生成
2. structured params から Vectorize filter（dense 側）と D1 SQL WHERE（sparse 側）を同時構築（repo, state, type, milestone は pre-filter）
3. labels / assignee フィルタ指定時、または reranker 有効時は内部 topK をオーバーフェッチ（requestedTopK × 5, max 50）。reranker は最大 50 件まで処理
4. dense (Vectorize.query) と sparse (D1 FTS5 MATCH + BM25) を並列実行
5. 両 ranker の結果を Reciprocal Rank Fusion（RRF、k=60）で合成
6. 合成後の rank 順に、labels（AND ロジック、個別フィールド + CSV フォールバック）と assignee を post-filter
7. reranker 有効時（default ON）は post-filter 後の候補を `@cf/baai/bge-reranker-base` で re-score し、reranker score 降順に並び替え
8. requestedTopK にトリムして structured context と共に返す

#### Reciprocal Rank Fusion (RRF)

RRF 公式:

```
score(d) = sum_over_rankers ( 1 / (k + rank_r(d)) )
```

- k = 60（Cormack et al. 2009 の canonical 値、Elasticsearch / Vespa / Milvus などの production default）
- rank_r(d) は ranker r における document d の 1-based rank（その ranker にヒットしていない場合は contribution 0）
- dense と sparse で score の scale が非互換でも、rank に正規化することで合成可能
- 片側にしかヒットしない document も部分点を得られる（recall boost）

### Cross-encoder Reranker

3 段目の reranker は `@cf/baai/bge-reranker-base`（Workers AI）を使用する。

採用理由:

- 2026 業界標準で reranker は production baseline の必須層（hybrid + reranker）。Cloudflare AI Search 公式 (2026-04-16) も `@cf/baai/bge-reranker-base` を rerank primitive として組み込み済
- bi-encoder（BGE-M3）と sparse BM25 は recall 向上には強いが、precision@k では cross-encoder に劣る。RRF で fuse した上位候補を cross-encoder で re-rank することで precision を底上げできる
- 既存 BGE-M3 embedding と同じ `env.AI` primitive で呼び出せるため追加 binding 不要

実装制約と既知の限界:

- bge-reranker-base は context window 512 tokens（BAAI 元仕様）。`(query, candidate content)` pair が超過しないよう char-budget ベースで truncate（query 200 chars 上限、pair 合計 1700 chars 上限）
- Workers AI は `contexts[].text` に length >= 1 を要求（エラー 5006: "Length of '/contexts/N/text' must be >= 1 not met"）。sparse hit が無い dense-only 候補は content が空文字になるため、rerank 入力から事前に除外する（除外件数が 0 / 1 の場合は AI 呼び出しをスキップして passthrough）
- reranker は最大 50 件 / 1 検索（Workers AI Free tier 10,000 neurons/day と業界中央値の整合点）
- bge-reranker-base は英語ベース・多言語非対応。日本語 issue/PR では精度低下リスクあり（runtime 観察対象、将来的に bge-reranker-v2-m3 提供開始時または外部 reranker への切替を別 issue で検討）
- reranker 呼び出し失敗・想定外レスポンス時は graceful fallback（fusion 順を維持、`rerank_applied: false` で通知）

呼び出しコスト試算:

- Workers AI 公式単価: bge-reranker-base = 283 neurons/M tokens
- 1 検索あたり試算: 約 7.5 neurons (query 30 tokens + 候補 50 件 × 平均 500 tokens, embedding 含む)
- Free tier 10,000 neurons/day で約 1,300 検索/day 上限
- neuron 実測値はレスポンスに `usage` フィールドが含まれる場合に取得し、理論試算と照合する（公式未文書化のため存在しない場合は黙ってスキップ）

### 切替オプション

`search_issues` の `fusion` パラメータで retrieval mode を切り替え可能:

- `rrf` (default) — dense + sparse を RRF で合成
- `dense_only` — Vectorize のみ（debug、semantic 特化クエリ）
- `sparse_only` — D1 FTS5 BM25 のみ（debug、exact term / identifier クエリ）

`rerank` パラメータで cross-encoder rerank を切り替え可能:

- `true` (default) — RRF 合成後に bge-reranker-base で re-score
- `false` — rerank skip（faster、Workers AI rerank cost なし。短い識別子クエリで lexical match が決定的な場合や debug に推奨）

この retrieval layer の目的は keyword match ではなく working state の復元である。3 段化の意図は、BGE-M3 の semantic 表現が弱い短い識別子・SHA prefix・固有名詞で sparse がカバーし、RRF で recall を確保しつつ、cross-encoder で precision を底上げすることにある。

## MCP Tools

### `search_issues`

Purpose:

- issue / pull request / release / documentation / commit diff を **3-tier hybrid search**（dense + sparse BM25 → RRF 合成 → cross-encoder rerank）で引く
- `type: "diff"` 指定で判断履歴（削除済みファイル・非 .md 拡張子を含む）を引ける

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

- repository、type、state、labels、milestone、assignees、URL、RRF fused score を含む ranked match
- 追加 debug フィールド: `dense_score`、`sparse_score`、`dense_rank`、`sparse_rank`、`rerank_score`（rerank 無効時または fallback 時は null）
- top-level metadata: `fusion`、`dense_candidates`、`sparse_candidates`、`rerank_requested`、`rerank_applied`

### `get_issue_context`

Purpose:

- 単一 issue または pull request の周辺 state を集約する

Returns:

- issue / PR details
- linked PRs
- branch information
- CI status
- sub-issues
- 推定可能な related releases

### `list_recent_activity`

Purpose:

- tracked repository 群の recent activity feed を返す

Returns:

- created / updated / closed issue / PR activity
- release publication activity
- documentation update activity
- commit diff indexing activity

## Authentication

認証は GitHub App + OAuth 2.1 を使う。

Requirements:

- MCP client user を認証する
- installation 済み repository に access する
- GitHub API read に token を使う

## Storage Rules

### Canonical memory surfaces

canonical project memory は引き続き GitHub artifact 側にある。

- issue body と label
- pull request と review state
- repository docs
- releases
- commit history（diff）

retrieval system はそれらを index する。source of truth を置き換えない。

### Update behavior

- webhook update はできるだけ早く反映する
- cron は drift を解消する
- embedding failure は次回 retry 可能でなければならない
- delete された issue / PR / release / doc は semantic index（Vectorize）と sparse index（D1 FTS5）の両方から削除する
- commit diff は append-only なので delete 経路対象外

## Current Deployment Assumptions

- TypeScript codebase
- Cloudflare Workers runtime
- Vectorize for dense semantic search（hybrid retrieval の dense 側）
- Cloudflare D1 for FTS5 BM25 sparse search（hybrid retrieval の sparse 側、migration 経由でスキーマ管理）
- Workers AI for embedding generation
- Durable Object / SQLite for structured state
- `POLL_REPOS` により 1 deployment で複数 repository を追跡できる

## Operational Constraints

### Worker invocation pressure

1 invocation あたりの Workers AI 呼び出しには制限があるため、embedding work は保守的に batch する必要がある。

### Cron CPU pressure

大きな initial sync は CPU limit を超えうるため、pagination と resumable watermark が必要である。

### Durable Object resets

deployment により Durable Object state が reset されることがあるため、webhook と cron の両経路から GitHub を再読して回復できる必要がある。

### Free-tier hard stop（D1 / Vectorize / Workers AI）

Workers AI Free（10,000 Neurons/day）、D1 Free、Vectorize Free はいずれも daily / monthly limit 超過で `operations will fail with an error` の hard stop 規約。overage billing は Paid plan 契約時のみ発生する。AI Search（managed）採用しないため AI Search 固有の hard stop 不確実性はスコープ外。

### Retry safety

embedding が失敗した record は incomplete と分かる形で残し、次回 run で retry できるようにする。

## Future Scope

- ranking と filtering の改善
- multi-agent handoff retrieval の改善
- cross-repository state recovery の改善

# github-rag-mcp 要求仕様

言語: [English](0-requirements.md) | 日本語

## Overview

`github-rag-mcp` は GitHub 上の project state を AI agent が検索・取得できるようにする MCP サーバーです。

対象にする artifact:

- issue
- pull request
- release
- repository documentation

このシステムの目標は transcript memory ではなく recoverable project state です。

本プロジェクトは GitHub を shared working memory として扱います。

- issue は要件、未解決事項、タスク状態を保持する
- pull request は実装、review、CI 状態を保持する
- docs は固定化された理解を保持する
- release は出荷済みの節目を保持する

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
            |
            +--> Vectorize
            +--> Durable Object / SQLite
            +--> Workers AI BGE-M3
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

`push` は `docs/**/*.md` や `README.md` の変更検出に使う。

### 3. Cron Poller

cron poller は fallback path である。

Responsibilities:

- webhook 取りこぼしを補償する
- 新しい repository の backfill を行う
- issue、pull request、release、docs の変更を再取得する
- 一時障害後も store を収束させる

現在の deployment では hourly で実行する。

### 4. Embedding Pipeline

embedding model:

- `@cf/baai/bge-m3`

現行実装:

- 1024 dimensions
- cosine similarity
- issue / release は body hash で変更検出する
- documentation は blob SHA で変更検出する

Responsibilities:

- title + body または path + content から embedding input を作る
- 安全な場合は unchanged record を skip する
- vector と metadata を Vectorize に upsert する
- embedding 失敗時も次回 retry できる状態を保つ

### 5. Vector Store

Vectorize は次の metadata を伴う semantic embedding を保持する。

- repository
- item type
- state
- labels
- milestone
- assignees
- update timestamp
- release tag name
- documentation path

vector store は semantic retrieval layer であり、canonical state store ではない。

### 6. Structured State Store

Durable Object + SQLite は次の structured record を保持する。

- issue / pull request
- release
- documentation file state
- polling watermark

この store は次を支える。

- `get_issue_context`
- `list_recent_activity`
- semantic search hit の enrichment

## Retrieval Model

retrieval layer は semantic search と structured filter の両方を支える必要がある。

想定フロー:

1. query の embedding を作る
2. repository や coarse metadata filter を伴って Vectorize を引く
3. 追加 filter と enrichment を行う
4. 次の作業に必要な structured context を返す

この retrieval layer の目的は keyword match ではなく working state の復元である。

## MCP Tools

### `search_issues`

Purpose:

- issue / pull request / release / documentation を semantic search する

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

- repository、type、state、labels、milestone、assignees、URL、score を含む ranked match

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

retrieval system はそれらを index する。source of truth を置き換えない。

### Update behavior

- webhook update はできるだけ早く反映する
- cron は drift を解消する
- embedding failure は次回 retry 可能でなければならない
- delete された release や doc は semantic index から削除できなければならない

## Current Deployment Assumptions

- TypeScript codebase
- Cloudflare Workers runtime
- Vectorize for semantic search
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

### Retry safety

embedding が失敗した record は incomplete と分かる形で残し、次回 run で retry できるようにする。

## Future Scope

- ranking と filtering の改善
- multi-agent handoff retrieval の改善
- cross-repository state recovery の改善

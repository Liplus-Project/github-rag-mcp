# github-rag-mcp Requirements Specification

## Overview

GitHub issue/PR structured search MCP server.
Provides AI with ambient context about GitHub issue/PR state via semantic and structured search.

Counterpart to github-webhook-mcp (push-based notifications).
Together they give AI a complete view of GitHub project state.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Workers                                          │
│                                                              │
│  ┌───────────┐  ┌──────────────────┐  ┌───────────────┐     │
│  │ MCP Server│  │ Webhook Receiver │  │ OAuth Provider│     │
│  │ (tools)   │  │ (real-time)      │  │ (GitHub App)  │     │
│  └─────┬─────┘  └────────┬─────────┘  └───────────────┘     │
│        │                 │                                    │
│        │        ┌────────▼─────────┐  ┌────────────┐        │
│        │        │ Embedding        │  │ Cron Poller│        │
│        │        │ Pipeline         │  │ (hourly    │        │
│        │        │                  │  │  fallback) │        │
│        │        └────────┬─────────┘  └─────┬──────┘        │
│        │                 │                  │                │
│  ┌─────▼─────────────────▼──────────────────▼──────┐        │
│  │              Durable Object                     │        │
│  │           (issue/PR state store)                │        │
│  └─────┬──────────────┬───────────────────────────┘        │
│        │              │                                      │
│  ┌─────▼─────┐  ┌────▼──────┐                              │
│  │ Vectorize │  │Workers AI │                              │
│  │ (search)  │  │ (BGE-M3)  │                              │
│  └───────────┘  └───────────┘                              │
└──────────────────────────────────────────────────────────────┘
         ▲               ▲                    ▲
         │ MCP protocol  │ Webhook POST       │ GitHub API
         │               │                    │
    Claude Code /   GitHub webhook       GitHub App
    liplus-desktop  delivery             Installation
```

## Components

### 1. Webhook Receiver

GitHub webhook イベントをリアルタイムで受信し、インデックスを即座に更新する。

対応イベント:
- `issues` — issue の作成・更新・クローズ
- `pull_request` — PR の作成・更新・マージ
- `release` — リリースの公開・更新
- `push` — ドキュメントファイルの変更検出

セキュリティ:
- GitHub IP アドレスレンジの検証（`/meta` API エンドポイントから取得）
- `GITHUB_WEBHOOK_SECRET` による HMAC-SHA256 署名検証

処理フロー:
1. リクエスト元 IP を GitHub の公開 IP レンジと照合
2. `X-Hub-Signature-256` ヘッダーで署名を検証
3. イベントタイプに応じて Embedding Pipeline を呼び出し
4. Vectorize + Durable Object を更新

### 1a. Cron Poller (Hourly Fallback)

1 時間ごとに Cloudflare Cron Triggers で実行されるフォールバック。Webhook 配信漏れや一時障害時のデータ整合性を保証する。

Responsibilities:
- GitHub API から前回ポーリング以降の issue/PR 更新を取得
- 新規・更新・クローズされた issue/PR を検出
- Embedding Pipeline を通じてエンベディングを生成
- Vectorize にベクトルを upsert
- Durable Object の構造化状態を更新

Polling strategy:
- GitHub Issues API の `since` パラメータで変更分のみ取得
- リポジトリごとに `updated_at` の watermark を追跡
- 初回フルシンクではページネーションを処理
- 1 ページ目で ETag 条件付きリクエスト（`If-None-Match`）を使用し、変更なしの場合は処理をスキップ
  - 304 Not Modified で watermark 更新と後続処理をすべてスキップ
  - アイドル時のポーリングを 3 サブリクエスト（GET watermark + GET API + POST watermark）から 2（GET watermark + GET API with 304）に削減
  - Cloudflare キャッシュ層をバイパスするため fetch() に `cache: "no-store"` を指定
  - ETag は Durable Object に watermark と共に格納

### 1b. Release Poller

Runs as part of the cron poller, after issue/PR polling for each repository.

Responsibilities:
- Fetch release updates from GitHub Releases API
- Detect new and updated releases
- Generate embeddings for release name + body (release notes)
- Upsert vectors into Vectorize with release-specific metadata
- Store structured release data in Durable Object (releases table)

Polling strategy:
- Use ETag conditional requests (`If-None-Match`) to skip processing when no changes
  - Same pattern as issue/PR polling (#38)
  - 304 Not Modified skips all downstream processing
- Separate watermark namespace: `releases:{repo}` in watermarks table
- Vector ID format: `{repo}#release-{tag_name}` (no collision with `{repo}#{number}`)

### 1c. Documentation Poller

Runs as part of the cron poller, after release polling for each repository.

Responsibilities:
- Fetch repository documentation files (`docs/**/*.md` + `README.md`) and index for semantic search
- Detect new, updated, and deleted documentation files
- Generate embeddings for file content (path as title, content as body)
- Upsert vectors into Vectorize with doc-specific metadata
- Store individual file blob SHAs in Durable Object (docs table) for per-file change detection
- Remove vectors for deleted files

Change detection strategy:
- Use Git Trees API (`/repos/{owner}/{repo}/git/trees/{ref}?recursive=1`) to get full file list with blob SHAs in 1 request
- ETag conditional requests on Trees API (304 Not Modified skips all processing)
- Compare blob SHAs against stored values to detect per-file changes (Git guarantees SHA = content identity)
- Fetch changed files via Contents API (`/repos/{owner}/{repo}/contents/{path}`, base64-encoded)
- Separate watermark namespace: `docs:{repo}` in watermarks table
- Vector ID format: `{repo}#doc-{path}` (e.g., `owner/repo#doc-docs/0-requirements.md`)

### 2. Embedding Pipeline

Model: `@cf/baai/bge-m3` (Workers AI)
- Output: 1024 dimensions (fixed, not configurable)
- Distance metric: cosine similarity
- Input: concatenation of issue title + body (truncated to model context limit)

Embedding triggers:
- New issue/PR created
- Existing issue/PR body or title updated
- Skip re-embedding if title+body unchanged (hash comparison)

Vector metadata (stored alongside embedding in Vectorize):
- `repo` (string) — repository full name (owner/repo)
- `number` (number) — issue/PR number (0 for releases and docs)
- `type` (string) — "issue", "pull_request", "release", or "doc"
- `state` (string) — "open" or "closed" (releases: "published", docs: "active")
- `labels` (string) — comma-separated label names (releases/docs: empty)
- `milestone` (string) — milestone title or empty (releases/docs: empty)
- `assignees` (string) — comma-separated login names (releases/docs: empty)
- `updated_at` (string) — ISO 8601 timestamp
- `tag_name` (string) — release tag name (releases only, empty for others)
- `doc_path` (string) — file path relative to repo root (docs only, empty for others)

### 3. MCP Server

Protocol: MCP (Model Context Protocol)
Authentication: OAuth 2.1 via GitHub App (same pattern as github-webhook-mcp)

#### Tool: `search_issues`

Semantic search combined with structured filters.

Parameters:
- `query` (string, required) — natural language search query
- `repo` (string, optional) — filter by repository (owner/repo)
- `state` (string, optional) — "open" | "closed" | "all" (default: "all")
- `labels` (string[], optional) — filter by label names (AND logic)
- `milestone` (string, optional) — filter by milestone title
- `assignee` (string, optional) — filter by assignee login
- `type` (string, optional) — "issue" | "pull_request" | "release" | "doc" | "all" (default: "all")
- `top_k` (number, optional) — max results (default: 10, max: 50)

Returns:
- Array of matched issues/PRs/releases/docs with: number, title, state, labels, milestone, assignee, score, url, updated_at
- Releases include: tag_name, prerelease flag
- Docs include: doc_path

Flow:
1. Generate embedding for `query` via Workers AI
2. Build Vectorize metadata filter from structured params
3. Query Vectorize with embedding + filter
4. Return ranked results

#### Tool: `get_issue_context`

Aggregated view of a single issue with related context.

Parameters:
- `repo` (string, required) — repository (owner/repo)
- `number` (number, required) — issue/PR number

Returns:
- Issue/PR details (title, body, state, labels, milestone, assignees)
- Linked PRs (number, title, state, branch)
- Branch status (name, ahead/behind)
- Latest CI status (workflow name, conclusion, url)
- Sub-issues (if parent issue)
- Related releases (releases published after issue was closed, linking issue to release)

Flow:
1. Read issue state from Durable Object cache
2. Fetch related PRs, branch, CI via GitHub API (with caching)
3. Aggregate and return

#### Tool: `list_recent_activity`

Recent changes across tracked repositories.

Parameters:
- `repo` (string, optional) — filter by repository
- `since` (string, optional) — ISO 8601 timestamp (default: last 24 hours)
- `limit` (number, optional) — max results (default: 20, max: 100)

Returns:
- Array of activity items: type (created/updated/closed), number, title, actor, timestamp, url
- Includes release activity (type: "release", activity_type: "created")
- Includes documentation updates (type: "doc", activity_type: "updated")

Flow:
1. Query Durable Object for issues/PRs with `updated_at >= since`
2. Sort by updated_at descending
3. Return with activity type classification

### 4. Admin API

認証なし公開エンドポイントではなく、`GITHUB_TOKEN` ヘッダーによる認証付き管理用エンドポイント。

#### `POST /admin/reset-hashes?repo=owner/repo`

指定リポジトリの全データを re-embedding 対象にリセットする。次回 cron 実行時に全件が再取得・再 embedding される。

リセット対象:
- `issues` テーブルの `body_hash` を空文字にリセット（ポーラーがハッシュ不一致を検出して再 embedding）
- `releases` テーブルの `body_hash` を空文字にリセット（同上）
- `docs` テーブルの全行を削除（ポーラーが全ファイルを再取得・再 embedding）
- `watermarks` テーブルから当該リポジトリの全エントリを削除（issues 用 `{repo}`、releases 用 `releases:{repo}`、docs 用 `docs:{repo}`）
  - watermark 削除により、ETag / `since` パラメータによるスキップが無効化され、ポーラーが全件を再取得する

認証: `GITHUB_TOKEN` ヘッダーの値が Worker の `GITHUB_TOKEN` シークレットと一致すること。

用途: Vectorize メタデータインデックス作成後の既存ベクトル再 upsert トリガー。

レスポンス:
```json
{
  "repo": "owner/repo",
  "issueHashesReset": N,
  "releaseHashesReset": M,
  "docsDeleted": K,
  "watermarksDeleted": W
}
```

### 5. Authentication

GitHub App (same pattern as github-webhook-mcp):
- OAuth 2.1 for user authentication
- Installation ID for repository access
- Reference: Liplus-Project/github-webhook-mcp implementation

### 6. Storage

#### Vectorize Index

- Name: `github-rag-issues`
- Dimensions: 1024
- Metric: cosine
- Metadata indexes: repo, type, state, labels, milestone, assignees

**前提条件: メタデータインデックスの事前作成が必須**

Vectorize のメタデータフィルタリング（`$eq` など）は、ベクトル挿入前にメタデータインデックスを作成しておく必要がある。
インデックスなしで upsert されたベクトルはフィルタ対象外となり、構造化フィルタが常に0件を返す。

インデックス作成コマンド（Workers コードからは不可、CLI のみ）:

```sh
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name repo
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name type
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name state
wrangler vectorize create-metadata-index github-rag-issues --type string --property-name milestone
```

インデックス作成後、既存ベクトルを再 upsert する必要がある。
admin エンドポイント（`POST /admin/reset-hashes?repo=owner/repo`、`GITHUB_TOKEN` ヘッダー認証）で bodyHash・watermark をリセットすると、次回 cron 実行時に全件が再取得・再 embedding される。

参照: https://developers.cloudflare.com/vectorize/reference/metadata-filtering/

#### Durable Object (Issue State Store)

SQLite-backed structured storage:
- Issue/PR metadata (number, title, state, labels, milestone, assignees, body hash, timestamps)
- Release metadata (tag_name, name, prerelease, body hash, timestamps)
- Documentation metadata (path, blob SHA, timestamps) — per-file change detection via blob SHA comparison
- Polling watermarks (last polled timestamp per repo; releases use `releases:{repo}` key, docs use `docs:{repo}` key)
- Used for `get_issue_context`, `list_recent_activity`, and release/doc queries without hitting Vectorize

## Constraints

- TypeScript (consistent with webhook-mcp stack)
- Single repository per deployment in v0.1.0
- Issue scale: hundreds per repository (Vectorize free tier sufficient)
- No dependency on github-webhook-mcp

## Platform Limits (Verified)

| Resource | Free Tier Limit | Expected Usage |
|---|---|---|
| Vectorize stored dims | 5,000,000 | ~500 issues x 1024 = 512,000 |
| Vectorize queried dims/mo | 30,000,000 | ~1000 queries x 1024 x 10 = 10,240,000 |
| Vectorize metadata filter | $eq, $in, range | Sufficient for all structured filters |
| Workers AI BGE-M3 | 1,500 req/min, 10K neurons/day | Webhook: on-demand, Poller: ~100 embeddings/day at hourly interval |
| Cron Triggers | 5/account, min 1min interval | 1 trigger at hourly interval (fallback) |
| Durable Object SQLite | 10GB/DO | Hundreds of issues = negligible |

### Runtime Constraints

Free Tier デプロイで発見された運用制約。有料プランへ移行後も設計パターンとして有用。

#### 1. Worker 実行あたりの Workers AI 呼び出し制限

1回の Worker 実行で大量の `ai.run()` を呼ぶと `Too many API requests by single Worker invocation` エラーが発生する。

対策: `MAX_EMBEDDINGS_PER_RUN = 50` でバッチ制限（`src/poller.ts`）。制限超過分は空 bodyHash で保存し、次回 cron でリトライ。

#### 2. Cron Trigger の CPU 時間制限

900+ issue の初回同期で GitHub API 全件取得 + IssueStore upsert だけで CPU 制限超過が発生する。

対策: `MAX_PAGES_PER_RUN = 2`（`PER_PAGE=100` x 2 = 最大200件/回）でページネーション制限（`src/poller.ts`）。制限到達時は最後に取得した issue の `updated_at` を watermark に設定し、次回 cron で続行。

#### 3. デプロイ時の Durable Object リセット

Workers Builds デプロイで DO がリセットされ、watermark（ポーリング進捗）が消失する。結果として初回同期に戻り、上記 1・2 の制限に再度引っかかる。

対策: バッチ制限により数回の cron 実行で自然回復する設計。明示的なリカバリ処理は不要。

#### 4. エンベディング失敗時のリトライ設計

失敗時に bodyHash を保存すると、次回 cron でハッシュ一致により永久にリトライされない構造バグが存在した。

対策: エンベディング失敗時は空文字列の bodyHash を保存し、次回 cron でハッシュ不一致を検出してリトライ（`src/poller.ts`）。

## Future Scope

- Multi-repository cross-search

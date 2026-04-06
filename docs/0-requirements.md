# github-rag-mcp Requirements Specification

## Overview

GitHub issue/PR structured search MCP server.
Provides AI with ambient context about GitHub issue/PR state via semantic and structured search.

Counterpart to github-webhook-mcp (push-based notifications).
Together they give AI a complete view of GitHub project state.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Workers                                 │
│                                                     │
│  ┌───────────┐  ┌────────────┐  ┌───────────────┐  │
│  │ MCP Server│  │ Cron Poller│  │ OAuth Provider│  │
│  │ (tools)   │  │ (5min)     │  │ (GitHub App)  │  │
│  └─────┬─────┘  └─────┬──────┘  └───────────────┘  │
│        │              │                              │
│  ┌─────▼──────────────▼──────┐                      │
│  │     Durable Object        │                      │
│  │  (issue/PR state store)   │                      │
│  └─────┬──────────────┬──────┘                      │
│        │              │                              │
│  ┌─────▼─────┐  ┌────▼──────┐                      │
│  │ Vectorize │  │Workers AI │                      │
│  │ (search)  │  │ (BGE-M3)  │                      │
│  └───────────┘  └───────────┘                      │
└─────────────────────────────────────────────────────┘
         ▲                    ▲
         │ MCP protocol       │ GitHub API
         │                    │
    Claude Code /        GitHub App
    liplus-desktop       Installation
```

## Components

### 1. Cron Poller

Runs every 5 minutes via Cloudflare Cron Triggers.

Responsibilities:
- Fetch issue/PR updates from GitHub API since last poll
- Detect new, updated, and closed issues/PRs
- Generate embeddings via Workers AI (BGE-M3)
- Upsert vectors into Vectorize with metadata
- Update structured state in Durable Object

Polling strategy:
- Use `since` parameter on GitHub Issues API to get only changed items
- Track `updated_at` watermark per repository
- Handle pagination for initial full sync
- Use ETag conditional requests (`If-None-Match`) on page 1 to skip processing when no changes
  - 304 Not Modified skips watermark update and all downstream processing
  - Reduces idle polling from 3 subrequests (GET watermark + GET API + POST watermark) to 2 (GET watermark + GET API with 304)
  - `cache: "no-store"` on fetch() to bypass Cloudflare cache layer
  - ETag stored alongside watermark in Durable Object

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
- `number` (number) — issue/PR number (0 for releases)
- `type` (string) — "issue", "pull_request", or "release"
- `state` (string) — "open" or "closed" (releases: always "published")
- `labels` (string) — comma-separated label names (releases: empty)
- `milestone` (string) — milestone title or empty (releases: empty)
- `assignees` (string) — comma-separated login names (releases: empty)
- `updated_at` (string) — ISO 8601 timestamp
- `tag_name` (string) — release tag name (releases only, empty for issues/PRs)

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
- `type` (string, optional) — "issue" | "pull_request" | "release" | "all" (default: "all")
- `top_k` (number, optional) — max results (default: 10, max: 50)

Returns:
- Array of matched issues/PRs/releases with: number, title, state, labels, milestone, assignee, score, url, updated_at
- Releases include: tag_name, prerelease flag

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

Flow:
1. Query Durable Object for issues/PRs with `updated_at >= since`
2. Sort by updated_at descending
3. Return with activity type classification

### 4. Authentication

GitHub App (same pattern as github-webhook-mcp):
- OAuth 2.1 for user authentication
- Installation ID for repository access
- Reference: Liplus-Project/github-webhook-mcp implementation

### 5. Storage

#### Vectorize Index

- Name: `github-rag-issues`
- Dimensions: 1024
- Metric: cosine
- Metadata indexes: repo, type, state, labels, milestone, assignees

#### Durable Object (Issue State Store)

SQLite-backed structured storage:
- Issue/PR metadata (number, title, state, labels, milestone, assignees, body hash, timestamps)
- Release metadata (tag_name, name, prerelease, body hash, timestamps)
- Polling watermarks (last polled timestamp per repo; releases use `releases:{repo}` key)
- Used for `get_issue_context`, `list_recent_activity`, and release queries without hitting Vectorize

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
| Workers AI BGE-M3 | 1,500 req/min, 10K neurons/day | ~100 embeddings/day at 5min interval |
| Cron Triggers | 5/account, min 1min interval | 1 trigger at 5min interval |
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

- Real-time index update via github-webhook-mcp event forwarding
- Multi-repository cross-search

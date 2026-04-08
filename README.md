# github-rag-mcp

GitHub issue/PR semantic search MCP server on Cloudflare Workers + Vectorize.

Counterpart to [github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) (push-based notifications). Together they give AI a complete view of GitHub project state.

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

- **Webhook Receiver** は GitHub からの webhook イベントをリアルタイムで受信し、即座にエンベディングパイプラインを通じてインデックスを更新する。GitHub IP アドレス検証によりリクエストの正当性を担保する。
- **Cron Poller** は 1 時間ごとのフォールバックとして動作し、webhook 配信漏れや一時障害時のデータ整合性を保証する。
- **MCP Server** は MCP プロトコル上でセマンティック検索と構造化クエリを OAuth 2.1 認証付きで提供する。
- **Durable Object** は issue/PR メタデータを SQLite に格納し、高速な構造化検索を実現する。

## Prerequisites

| Component | Required |
|-----------|----------|
| **Node.js 18+** | Build and deploy |
| **Cloudflare account** | Worker deployment (Free plan sufficient) |
| **GitHub App** | OAuth authentication and API access |
| **wrangler CLI** | Cloudflare Workers deployment |

## Getting Started

See the [Installation guide](docs/installation.md) for the full setup, including:

- Cloning and installing dependencies
- Creating Cloudflare resources (Vectorize index, KV namespace)
- Registering a GitHub App
- Deploying the Worker
- Configuring secrets

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_issues` | Semantic search for issues and PRs combined with structured filters (repo, state, labels, milestone, assignee, type) |
| `get_issue_context` | Aggregated context for a single issue/PR including linked PRs, branch status, and CI status |
| `list_recent_activity` | Recent issue/PR activity across tracked repositories, classified as created, updated, or closed |

## Repository Structure

```
src/
  index.ts        — Worker entrypoint (routing, cron, webhook, OAuth)
  mcp.ts          — MCP server and tool definitions
  oauth.ts        — OAuth 2.1 provider setup
  webhook.ts      — Webhook event handler (real-time ingest)
  pipeline.ts     — Embedding pipeline (shared by webhook and poller)
  github-ip.ts    — GitHub IP address validation for webhook verification
  poller.ts       — Cron-triggered GitHub API poller (hourly fallback)
  store.ts        — Durable Object issue state store
  types.ts        — Shared type definitions
docs/
  0-requirements.md — Requirements specification
  installation.md   — Deployment and setup guide
mcp-server/       — .mcpb client package for Claude Desktop
wrangler.toml     — Cloudflare Workers configuration
```

## Related

- [Liplus-Project/github-webhook-mcp](https://github.com/Liplus-Project/github-webhook-mcp) — Real-time GitHub webhook notifications
- [Liplus-Project/liplus-language](https://github.com/Liplus-Project/liplus-language) — Li+ language specification
- Requirements: [docs/0-requirements.md](docs/0-requirements.md)
